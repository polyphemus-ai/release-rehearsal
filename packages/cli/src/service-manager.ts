import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { inWsl, PolyphemusError } from '@polyphemus/core';

// What keeps `poly serve` running in the background, per platform: a systemd user unit on Linux,
// a launchd agent on macOS. The service code above this only asks it to write, start, restart, stop.

export { inWsl } from '@polyphemus/core';

/** systemd is what started this system: the check systemd's own tools use. */
const systemdRunning = (): boolean => existsSync('/run/systemd/system');

export interface UnitOptions {
  node: string;
  launcher: string;
  /** Where sessions started from the phone run, unless you pick a project. */
  cwd: string;
  /** Your PATH, so the daemon finds the claude, codex, and grok CLIs. */
  path: string;
  port?: string;
}

export interface ServiceManager {
  /** Its name, for messages: "systemd", "launchd". */
  kind: string;
  /** The file that describes the service. */
  file: string;
  /** Writes the description and registers it, so it starts with this computer. */
  register(o: UnitOptions): void;
  start(): void;
  /** Stops it for now, without unregistering: an update stops it to put data back safely. */
  stop(): void;
  restart(): void;
  isActive(): boolean;
  /** Stops it, unregisters it, and removes the file. */
  unregister(): void;
  /** Prints its status. */
  status(): void;
  /** Follows its log. */
  logs(): void;
  /** A one-line note when it won't start before you log in, if that's knowable. */
  bootNote(): string | undefined;
}

/** The systemd user unit that keeps `poly serve` running. */
export function serviceUnit(o: UnitOptions): string {
  const esc = (value: string) => value.replace(/%/g, '%%'); // systemd expands % specifiers
  return `[Unit]
Description=polyphemus daemon (your sessions, reachable from your tailnet)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${esc(o.cwd)}
Environment="PATH=${esc(o.path)}"
${o.port ? `Environment=POLYPHEMUS_PORT=${esc(o.port)}\n` : ''}ExecStart="${esc(o.node)}" "${esc(o.launcher)}" serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export const LAUNCHD_LABEL = 'polyphemus.daemon';

/** The launchd agent (a property list) that keeps `poly serve` running on macOS. */
export function launchdPlist(o: UnitOptions & { log: string }): string {
  const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const env = [['PATH', o.path], ...(o.port ? [['POLYPHEMUS_PORT', o.port]] : [])];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(o.node)}</string>
    <string>${xml(o.launcher)}</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(o.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env.map(([k, v]) => `    <key>${k}</key>\n    <string>${xml(v!)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(o.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.log)}</string>
</dict>
</plist>
`;
}

function systemd(): ServiceManager {
  const UNIT = 'polyphemus.service';
  const dir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user');
  const systemctl = (...args: string[]) => {
    try {
      execFileSync('systemctl', ['--user', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      // WSL runs without systemd unless it's turned on, and systemctl's own complaint doesn't say so.
      if (inWsl() && !systemdRunning()) {
        throw new PolyphemusError('WSL isn’t running systemd, which poly service needs. Turn it on: put these two lines in /etc/wsl.conf (sudo nano /etc/wsl.conf) — [boot] and systemd=true — then run wsl --shutdown in Windows and open your Linux terminal again. Or run poly serve in a terminal instead.');
      }
      const stderr = String((err as { stderr?: Buffer }).stderr ?? '').trim();
      throw new PolyphemusError(`systemctl --user ${args.join(' ')} failed${stderr ? `: ${stderr}` : '.'}`);
    }
  };
  const active = (unit: string) => spawnSync('systemctl', ['--user', 'is-active', '--quiet', unit]).status === 0;
  const file = join(dir, UNIT);
  return {
    kind: 'systemd',
    file,
    register(o) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, serviceUnit(o));
      systemctl('daemon-reload');
      systemctl('enable', UNIT);
    },
    start: () => systemctl('start', UNIT),
    stop: () => systemctl('stop', UNIT),
    restart: () => systemctl('restart', UNIT),
    isActive: () => active(UNIT),
    unregister() {
      systemctl('disable', '--now', UNIT);
      rmSync(file, { force: true });
      systemctl('daemon-reload');
    },
    status: () => void spawnSync('systemctl', ['--user', 'status', UNIT, '--no-pager'], { stdio: 'inherit' }),
    logs: () => void spawnSync('journalctl', ['--user', '-u', UNIT, '-n', '100', '-f', '--output=cat'], { stdio: 'inherit' }),
    bootNote() {
      try {
        const lingering = execFileSync('loginctl', ['show-user', userInfo().username, '-p', 'Linger'], { encoding: 'utf8' }).includes('Linger=yes');
        return lingering ? undefined : `It starts when you log in. To start at boot even before you log in, run once: sudo loginctl enable-linger ${userInfo().username}`;
      } catch {
        return undefined; // can't tell; don't nag
      }
    },
  };
}

function launchd(): ServiceManager {
  const file = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const log = join(homedir(), 'Library', 'Logs', 'polyphemus', 'daemon.log');
  const domain = `gui/${userInfo().uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const launchctl = (...args: string[]) => {
    try {
      execFileSync('launchctl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      const stderr = String((err as { stderr?: Buffer }).stderr ?? '').trim();
      throw new PolyphemusError(`launchctl ${args.join(' ')} failed${stderr ? `: ${stderr}` : '.'}`);
    }
  };
  const loaded = () => spawnSync('launchctl', ['print', target], { stdio: 'ignore' }).status === 0;
  return {
    kind: 'launchd',
    file,
    register(o) {
      mkdirSync(dirname(file), { recursive: true });
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(file, launchdPlist({ ...o, log }));
      // Reloading picks up a changed plist; a fresh bootstrap starts it (RunAtLoad).
      if (loaded()) spawnSync('launchctl', ['bootout', target], { stdio: 'ignore' });
      launchctl('bootstrap', domain, file);
    },
    // Stopped by booting it out (KeepAlive would bring back one that was only killed), so starting
    // may have to bootstrap it again first.
    start: () => {
      if (!loaded()) launchctl('bootstrap', domain, file);
      launchctl('kickstart', target);
    },
    stop: () => void (loaded() && spawnSync('launchctl', ['bootout', target], { stdio: 'ignore' })),
    restart: () => launchctl('kickstart', '-k', target),
    isActive: () => (spawnSync('launchctl', ['print', target], { encoding: 'utf8' }).stdout ?? '').includes('state = running'),
    unregister() {
      if (loaded()) spawnSync('launchctl', ['bootout', target], { stdio: 'ignore' });
      rmSync(file, { force: true });
    },
    status: () => void spawnSync('launchctl', ['print', target], { stdio: 'inherit' }),
    logs: () => void spawnSync('tail', ['-n', '100', '-f', log], { stdio: 'inherit' }),
    bootNote: () => undefined, // a launch agent starts when you log in; that's the macOS way
  };
}

/** The service manager for this computer, or a clear refusal where there isn't one yet. */
export function serviceManager(platform: NodeJS.Platform = process.platform): ServiceManager {
  if (platform === 'linux') return systemd();
  if (platform === 'darwin') return launchd();
  throw new PolyphemusError('poly service runs on Linux (systemd) and macOS (launchd). On Windows, run polyphemus inside WSL2, or run poly serve in a terminal.');
}
