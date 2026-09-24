import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { PolyphemusError } from '../types.js';
import type { EgressProxy } from './egress.js';
import { EGRESS_PORT } from './egress-proxy.js';
import { runtimeRun, shortHash, type ContainerRuntime } from './runtime.js';

// An agent's computer (docs/design/desktop.md): a Linux desktop in a container of its own — one per
// agent, and only one — that the agent works in and a person watches or takes over. Its home folder
// is on this computer, so what it keeps (sign-ins, downloads, settings) is there tomorrow. Like a
// worker it has no network of its own: the only way out is polyphemus's proxy, public addresses only.
// The screen comes out as VNC on a socket in a folder polyphemus shares with it, never a port.

export const DESKTOP_DOCKERFILE = `FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update \\
 && apt-get install -y --no-install-recommends \\
      xvfb x11vnc dbus-x11 xfce4 xfce4-terminal thunar mousepad xfce4-screenshooter \\
      chromium xdotool scrot xclip procps ca-certificates curl git bash nodejs \\
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji adwaita-icon-theme \\
 && apt-get purge -y light-locker xfce4-power-manager xscreensaver 2>/dev/null; \\
    rm -rf /var/lib/apt/lists/*
# Chromium goes out through polyphemus's proxy: public addresses only, like everything else here. Its own
# sandbox needs kernel features a locked-down container (and many hosts) don't allow; the container
# is the boundary — no privileges, no network but the proxy, nothing mounted but the agent's own.
# --test-type keeps the "unsupported flag" bar off the top of every window.
RUN sed -i 's#^Exec=/usr/bin/chromium#Exec=/usr/bin/chromium --proxy-server=http://127.0.0.1:${EGRESS_PORT} --no-first-run --password-store=basic --no-sandbox --test-type#' /usr/share/applications/chromium.desktop \\
 && printf '#!/bin/bash\\nexec /usr/bin/chromium --proxy-server=http://127.0.0.1:${EGRESS_PORT} --no-first-run --password-store=basic --no-sandbox --test-type "$@"\\n' > /usr/local/bin/x-www-browser \\
 && chmod +x /usr/local/bin/x-www-browser
# …and it's the desktop's web browser: without a default set, the dock's browser button fails.
RUN printf '%s\\n' '[Desktop Entry]' 'Version=1.0' 'Icon=chromium' 'Type=X-XFCE-Helper' 'Name=Chromium' 'X-XFCE-Category=WebBrowser' \\
      'X-XFCE-Commands=/usr/local/bin/x-www-browser;' 'X-XFCE-CommandsWithParameter=/usr/local/bin/x-www-browser "%s";' \\
      > /usr/share/xfce4/helpers/polyphemus-browser.desktop \\
 && mkdir -p /etc/xdg/xfce4 && printf 'WebBrowser=polyphemus-browser\\n' > /etc/xdg/xfce4/helpers.rc
RUN printf '%s\\n' \\
      '#!/bin/bash' \\
      '# The desktop: a screen in memory, XFCE on it, and VNC on the shared socket.' \\
      'export DISPLAY=:1 HOME=/home/agent XDG_RUNTIME_DIR=/tmp/runtime' \\
      'whoami >/dev/null 2>&1 || { echo "agent:x:$(id -u):$(id -g):agent:/home/agent:/bin/bash" >> /etc/passwd; echo "agent:x:$(id -g):" >> /etc/group; }' \\
      'mkdir -p "$HOME" "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"' \\
      'rm -f /tmp/.X1-lock /polyphemus-desktop/vnc.sock' \\
      'Xvfb :1 -screen 0 1280x800x24 -nolisten tcp &' \\
      'for i in $(seq 50); do [ -e /tmp/.X11-unix/X1 ] && break; sleep 0.1; done' \\
      'xset -display :1 s off -dpms 2>/dev/null' \\
      'dbus-launch --exit-with-session startxfce4 >/tmp/xfce.log 2>&1 &' \\
      'exec x11vnc -display :1 -forever -shared -nopw -quiet -rfbport 0 -unixsock /polyphemus-desktop/vnc.sock -noxdamage' \\
      > /usr/local/bin/polyphemus-desktop
# It runs as whoever owns polyphemus on this computer, whose id the image can't know: the start script
# names it, which D-Bus and XFCE need. Nothing here can raise privileges, so this gives nothing away.
RUN chmod +x /usr/local/bin/polyphemus-desktop && chmod 666 /etc/passwd /etc/group && echo "polyphemus-desktop: an agent's own computer" > /etc/polyphemus-desktop
CMD ["/usr/local/bin/polyphemus-desktop"]
`;

export const DESKTOP_IMAGE = `polyphemus-desktop:${shortHash(DESKTOP_DOCKERFILE)}`;

/** The rules (decided 2026-09-18): 2 GB each, and at most two awake across every agent. */
export const DESKTOP_LIMITS = { memory: '2g', cpus: '2', awake: 2, idleMs: 15 * 60_000 };

export type DesktopState = 'asleep' | 'waking' | 'awake';

interface Known {
  state: DesktopState;
  /** Who has taken it over, when someone has: the agent's hands wait until they give it back. */
  heldBy?: string;
  /** Last time someone watched it, or it did something: what "idle" is measured from. */
  used: number;
  viewers: number;
  waking?: Promise<void>;
}

export class Desktops {
  private readonly known = new Map<string, Known>();
  private building: Promise<void> | undefined;
  private readonly sweep: NodeJS.Timeout;

  constructor(
    private readonly home: string,
    private readonly runtime: () => ContainerRuntime | undefined,
    private readonly egress: EgressProxy,
  ) {
    this.sweep = setInterval(() => void this.sleepIdle(), 60_000);
    this.sweep.unref();
  }

  /** The container's name: this install's, this agent's. */
  private name(agent: string): string {
    return `polyphemus-d-${shortHash(`${this.egress.scope}|${agent}`)}`;
  }

  /**
   * On this computer: the agent's home (kept), and the folder the screen's socket appears in — short
   * and private to this user, since a socket's path can't be over 108 characters wherever polyphemus lives.
   */
  private dirs(agent: string): { home: string; share: string } {
    const key = shortHash(`${this.egress.scope}|${agent}`);
    return { home: join(this.home, 'desktops', shortHash(agent), 'home'), share: join('/tmp', `polyphemus-${process.getuid?.() ?? 'u'}`, `d-${key}`) };
  }

  private entry(agent: string): Known {
    let known = this.known.get(agent);
    if (!known) this.known.set(agent, (known = { state: 'asleep', used: 0, viewers: 0 }));
    return known;
  }

  /** Whether it's awake, asked of the runtime itself (the daemon may have restarted since). */
  async state(agent: string): Promise<DesktopState> {
    const known = this.entry(agent);
    if (known.waking) return 'waking';
    const runtime = this.runtime();
    if (!runtime) return 'asleep';
    const running = await runtimeRun(runtime, ['inspect', '--format', '{{.State.Running}}', this.name(agent)], { timeoutMs: 30_000 });
    known.state = running.code === 0 && running.stdout.trim() === 'true' ? 'awake' : 'asleep';
    return known.state;
  }

  /** Whether the image is built: the first wake downloads and builds it, which takes minutes. */
  async imageReady(): Promise<boolean> {
    const runtime = this.runtime();
    if (!runtime) return false;
    return (await runtimeRun(runtime, ['image', 'inspect', DESKTOP_IMAGE], { timeoutMs: 30_000 })).code === 0;
  }

  /** Wakes it (building the image the first time), putting the longest-idle one to sleep past the limit. */
  wake(agent: string): Promise<void> {
    const known = this.entry(agent);
    known.used = Date.now();
    if (known.waking) return known.waking;
    known.waking = this.start(agent).finally(() => (known.waking = undefined));
    return known.waking;
  }

  private async start(agent: string): Promise<void> {
    const runtime = this.runtime();
    if (!runtime) throw new PolyphemusError('There’s no Docker or Podman on this computer, so an agent can’t have a computer of its own here.', 'FAILED');
    if ((await this.state(agent)) === 'awake') return;
    await this.makeRoom(runtime, agent);
    await this.ensureImage(runtime);
    const name = this.name(agent);
    const { home, share } = this.dirs(agent);
    mkdirSync(home, { recursive: true });
    mkdirSync(dirname(share), { recursive: true, mode: 0o700 });
    chmodSync(dirname(share), 0o700);
    mkdirSync(share, { recursive: true, mode: 0o700 });
    // Public addresses only, through the proxy, like the Browser: its own policy entry.
    this.egress.allow(name, ['*'], null);
    await this.egress.ensure(runtime);
    await this.egress.ready(runtime, name);
    const proxy = this.egress.workerArgs(runtime, name);
    await runtimeRun(runtime, ['rm', '-f', name], { timeoutMs: 30_000 });
    const created = await runtimeRun(runtime, [
      'run', '-d', '--name', name, '--init',
      '--label', 'polyphemus.desktop=1', '--label', `polyphemus.scope=${this.egress.scope}`, '--label', `polyphemus.agent=${agent.slice(0, 200)}`,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      '--network', 'none',
      ...proxy.args,
      ...this.egress.forwarderEnv(),
      '--memory', DESKTOP_LIMITS.memory, '--cpus', DESKTOP_LIMITS.cpus, '--pids-limit', '2048', '--shm-size', '512m',
      '--tmpfs', '/tmp:exec,mode=1777',
      '--volume', `${home}:/home/agent`,
      '--volume', `${share}:/polyphemus-desktop`,
      '--env', 'HOME=/home/agent',
      DESKTOP_IMAGE,
      'bash', '-c', 'while :; do node -e "$POLYPHEMUS_FORWARDER" >/dev/null 2>&1; sleep 1; done & exec /usr/local/bin/polyphemus-desktop',
    ], { timeoutMs: 120_000 });
    if (created.code !== 0) throw new PolyphemusError(`Couldn’t start the computer with ${runtime.name}: ${created.stderr.trim().split('\n').at(-1)}`, 'FAILED');
    // Up when its screen is: the socket appears once VNC is listening.
    const socket = join(share, 'vnc.sock');
    for (let i = 0; i < 150 && !existsSync(socket); i++) await new Promise((resolve) => setTimeout(resolve, 200));
    if (!existsSync(socket)) throw new PolyphemusError('The computer started but its screen didn’t come up.', 'FAILED');
    this.entry(agent).state = 'awake';
  }

  /** Past the limit, the one idle longest goes to sleep — never one someone is watching. */
  private async makeRoom(runtime: ContainerRuntime, waking: string): Promise<void> {
    const listed = await runtimeRun(runtime, ['ps', '--filter', 'label=polyphemus.desktop=1', '--filter', `label=polyphemus.scope=${this.egress.scope}`, '--format', '{{.Label "polyphemus.agent"}}'], { timeoutMs: 30_000 });
    const awake = listed.stdout.split('\n').map((line) => line.trim()).filter((agent) => agent && agent !== waking);
    const over = awake.length - (DESKTOP_LIMITS.awake - 1);
    if (over <= 0) return;
    const byIdle = awake.filter((agent) => this.entry(agent).viewers === 0).sort((a, b) => this.entry(a).used - this.entry(b).used);
    if (byIdle.length < over) throw new PolyphemusError(`${DESKTOP_LIMITS.awake} computers are awake and being watched. Close one first.`, 'CONFLICT');
    for (const agent of byIdle.slice(0, over)) await this.sleep(agent);
  }

  private ensureImage(runtime: ContainerRuntime): Promise<void> {
    this.building ??= (async () => {
      if (await this.imageReady()) return;
      const built = await runtimeRun(runtime, ['build', '-t', DESKTOP_IMAGE, '-'], { stdin: DESKTOP_DOCKERFILE, timeoutMs: 30 * 60_000 });
      if (built.code !== 0) throw new PolyphemusError(`Couldn’t build the computer’s image with ${runtime.name}: ${built.stderr.trim().split('\n').slice(-3).join(' ')}`, 'FAILED');
      // Earlier versions are a gigabyte each; one a computer still runs on stays.
      const listed = await runtimeRun(runtime, ['images', '--format', '{{.Repository}}:{{.Tag}}', 'polyphemus-desktop'], { timeoutMs: 30_000 });
      for (const old of listed.stdout.split('\n').map((line) => line.trim()).filter((name) => name.startsWith('polyphemus-desktop:') && name !== DESKTOP_IMAGE)) {
        await runtimeRun(runtime, ['image', 'rm', old], { timeoutMs: 60_000 });
      }
    })().catch((err) => {
      this.building = undefined;
      throw err;
    });
    return this.building;
  }

  /** Stops it; its home folder stays, so waking it again picks up where it was. */
  async sleep(agent: string): Promise<void> {
    const runtime = this.runtime();
    if (!runtime) return;
    await runtimeRun(runtime, ['stop', '-t', '5', this.name(agent)], { timeoutMs: 60_000 });
    await runtimeRun(runtime, ['rm', '-f', this.name(agent)], { timeoutMs: 30_000 });
    this.egress.forget(this.name(agent));
    this.entry(agent).state = 'asleep';
  }

  /** The screen, as a VNC stream: counted as watched until the socket closes. */
  async screen(agent: string): Promise<Socket> {
    const known = this.entry(agent);
    if ((await this.state(agent)) !== 'awake') throw new PolyphemusError('The computer is asleep: wake it first.', 'USAGE');
    const socket = connect(join(this.dirs(agent).share, 'vnc.sock'));
    known.viewers += 1;
    known.used = Date.now();
    socket.once('close', () => {
      known.viewers = Math.max(0, known.viewers - 1);
      known.used = Date.now();
    });
    return socket;
  }

  /** Something happened on it: an agent's action, a person's key. Keeps it from sleeping. */
  touch(agent: string): void {
    this.entry(agent).used = Date.now();
  }

  /** A person takes the mouse and keyboard (a name), or gives them back (undefined). */
  hold(agent: string, person: string | undefined): void {
    const known = this.entry(agent);
    if (person) known.heldBy = person;
    else delete known.heldBy;
  }

  /** Who has it, if a person does: the agent's actions are refused until they give it back. */
  heldBy(agent: string): string | undefined {
    return this.entry(agent).heldBy;
  }

  /** Its home folder, on this computer: what's in its Downloads and on its Desktop can be handed out. */
  homeDir(agent: string): string {
    return this.dirs(agent).home;
  }

  /** A command on its desktop, as the agent — woken first if it's asleep. */
  async exec(agent: string, argv: string[], opts: { timeoutMs?: number; stdin?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const runtime = this.runtime();
    if (!runtime) throw new PolyphemusError('There’s no Docker or Podman on this computer, so the agent has no computer here.', 'FAILED');
    if ((await this.state(agent)) !== 'awake') await this.wake(agent);
    this.touch(agent);
    return runtimeRun(runtime, ['exec', '-i', '-e', 'DISPLAY=:1', '-e', 'HOME=/home/agent', '-w', '/home/agent', this.name(agent), ...argv], { timeoutMs: opts.timeoutMs ?? 60_000, ...(opts.stdin !== undefined && { stdin: opts.stdin }) });
  }

  /** What's on its screen, as a PNG. */
  async screenshot(agent: string): Promise<Buffer> {
    const shot = await this.exec(agent, ['bash', '-c', 'scrot -o -z /tmp/.polyphemus-shot.png && base64 -w0 /tmp/.polyphemus-shot.png']);
    if (shot.code !== 0 || !shot.stdout) throw new PolyphemusError(`Couldn’t see the screen: ${shot.stderr.trim() || 'no picture came back'}`, 'FAILED');
    return Buffer.from(shot.stdout.trim(), 'base64');
  }

  private async sleepIdle(): Promise<void> {
    for (const [agent, known] of this.known) {
      if (known.state === 'awake' && known.viewers === 0 && Date.now() - known.used > DESKTOP_LIMITS.idleMs) await this.sleep(agent).catch(() => {});
    }
  }

  /**
   * Every computer of this install that's running, put to sleep: when polyphemus stops, and when it
   * starts after one that didn't stop cleanly. A computer that outlived its daemon kept 2 GB each,
   * with nothing left to put it to sleep (2026-09-19). Homes stay, so nothing is lost.
   */
  async sleepAll(): Promise<number> {
    const runtime = this.runtime();
    if (!runtime) return 0;
    const listed = await runtimeRun(runtime, ['ps', '--filter', 'label=polyphemus.desktop=1', '--filter', `label=polyphemus.scope=${this.egress.scope}`, '--format', '{{.Label "polyphemus.agent"}}'], { timeoutMs: 30_000 });
    const agents = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    for (const agent of agents) await this.sleep(agent);
    return agents.length;
  }

  close(): void {
    clearInterval(this.sweep);
  }
}
