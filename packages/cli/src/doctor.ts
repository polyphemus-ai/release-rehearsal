import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cliState, detectRuntime, envSetting, findChrome, isCliAdapter, ISOLATION_WORDS, providerStatus, type CliState, type ContainerRuntime, type Polyphemus } from '@polyphemus/core';
import { detectHttps, detectTailscale } from '@polyphemus/daemon';
import { bold, dim, green, red, yellow } from './render.js';
import { inWsl } from './service-manager.js';

// Everything Polyphemus needs from this computer, in one place, with what to do about each gap.
// It reads and never changes anything: the detection is what the app's setup already uses
// (discover.ts, codex-sandbox.ts, runtime.ts, tailscale.ts), with a command in front of it for a
// terminal, a server over ssh, or an agent (--json). Until now that detection was only in the app,
// which a new install couldn't reach until it had been set up (2026-09-22).

export interface Finding {
  area: 'This computer' | 'Polyphemus' | 'Models' | 'Where agents run' | 'Phones' | 'Browser';
  /** ok: fine. warn: it works, with something missing. fail: it stops Polyphemus doing its job. */
  state: 'ok' | 'warn' | 'fail';
  what: string;
  /** What to do, a step to a line. */
  fix?: string[];
}

/** What doctor asks the computer, replaceable so a test can be any computer. */
export interface DoctorDeps {
  cli(adapter: string): Promise<CliState | undefined>;
  runtime(): ContainerRuntime | undefined;
  tailscale(): Promise<{ dnsName?: string; ip: string; local: boolean } | undefined>;
  https(port: number): Promise<string | undefined>;
  chrome(): string | undefined;
  daemon(port: number): Promise<boolean>;
  git(): boolean;
  /** Inside WSL: whether systemd runs there. Undefined anywhere else. */
  wsl(): { systemd: boolean } | undefined;
}

const realDeps = (answers: (port: number) => Promise<boolean>): DoctorDeps => ({
  cli: (adapter) => cliState(adapter),
  runtime: () => detectRuntime(),
  tailscale: () => (envSetting('TAILSCALE') === 'off' ? Promise.resolve(undefined) : detectTailscale()),
  https: (port) => (envSetting('TAILSCALE') === 'off' ? Promise.resolve(undefined) : detectHttps(port)),
  chrome: () => findChrome(),
  daemon: answers,
  git: () => spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0,
  wsl: () => (inWsl() ? { systemd: existsSync('/run/systemd/system') } : undefined),
});

const CLI_NAMES: Record<string, string> = { 'claude-cli': 'Claude Code', 'codex-cli': 'Codex', 'grok-cli': 'Grok Build' };

export async function diagnose(polyphemus: Polyphemus, opts: { port: number; version: string; deps: DoctorDeps }): Promise<Finding[]> {
  const { deps, port } = opts;
  const found: Finding[] = [];
  const add = (f: Finding) => found.push(f);
  const config = polyphemus.config;

  // This computer.
  add({ area: 'This computer', state: 'ok', what: `Node.js ${process.versions.node}` });
  add(deps.git() ? { area: 'This computer', state: 'ok', what: 'git' } : { area: 'This computer', state: 'warn', what: 'git isn’t installed, and projects and workflows need it', fix: ['Install git with your package manager (on Ubuntu: sudo apt install git)'] });
  const wsl = deps.wsl();
  if (wsl) {
    add(
      wsl.systemd
        ? { area: 'This computer', state: 'ok', what: 'WSL, with systemd' }
        : { area: 'This computer', state: 'warn', what: 'WSL without systemd, so poly service can’t keep Polyphemus running', fix: ['sudo nano /etc/wsl.conf and add the lines [boot] and systemd=true', 'In Windows: wsl --shutdown, then open your Linux terminal again'] },
    );
  }

  // Polyphemus itself.
  const running = await deps.daemon(port);
  add(running ? { area: 'Polyphemus', state: 'ok', what: `${opts.version}, running at http://127.0.0.1:${port}` } : { area: 'Polyphemus', state: 'warn', what: `${opts.version}, not running`, fix: ['poly start — runs it in the background and opens setup in your browser'] });

  // Models: what can actually run one.
  let usable = 0;
  const clis = Object.entries(config.providers).filter(([, p]) => p.auth.type === 'cli' && isCliAdapter(p.adapter));
  const states = await Promise.all(clis.map(([, p]) => deps.cli(p.adapter)));
  // None of them here is one fact, not three: most people have one subscription, or none.
  const none = clis.length > 0 && states.every((s) => !s?.installed);
  if (none) add({ area: 'Models', state: 'warn', what: `No ${clis.map(([id, p]) => CLI_NAMES[p.adapter] ?? id).join(', ').replace(/, ([^,]*)$/, ' or $1')} here`, fix: ['If you have one of those subscriptions, install its CLI, then sign in:', ...states.map((s) => `  ${s?.loginCommand}`).filter((l) => l.trim() !== 'undefined')] });
  clis.forEach(([id, p], i) => {
    const state = states[i];
    if (none) return;
    const name = CLI_NAMES[p.adapter] ?? id;
    if (!state?.installed) return add({ area: 'Models', state: 'warn', what: `${name} isn’t installed`, fix: [`To use your ${name} subscription: install it, then ${state?.loginCommand ?? 'sign in'}`] });
    if (state.signedIn === false) return add({ area: 'Models', state: 'warn', what: `${name} is installed but not signed in`, fix: [state.loginCommand ?? 'Sign in with its own login'] });
    if (state.sandbox && !state.sandbox.ok) {
      const why = state.sandbox.explanation;
      const first = why?.fixes[0];
      return add({ area: 'Models', state: 'fail', what: why?.problem ?? `${name} can’t run commands on this computer`, fix: [...(why ? [why.why] : []), ...(first ? [`${first.title}:`, ...first.steps.map((s) => `  ${s}`)] : []), 'The app shows every fix, on Codex’s card in Models & providers'] });
    }
    usable++;
    // An account is an email or a plan ("ChatGPT"), so it's named in brackets rather than as "signed in as".
    add({ area: 'Models', state: 'ok', what: `${name}, ${state.signedIn === undefined ? 'installed (it doesn’t say whether it’s signed in)' : `signed in${state.account ? ` (${state.account})` : ''}`}` });
  });
  for (const [id, p] of Object.entries(config.providers)) {
    if (p.auth.type === 'cli') continue;
    const status = providerStatus(id, p, polyphemus.credentials);
    const chosen = config.selected.some((ref) => ref.startsWith(`${id}:`));
    // Every API provider on the list would be noise; the ones set up, or picked, aren't.
    if (!status.ready && !chosen) continue;
    if (status.ready) usable++;
    add(status.ready ? { area: 'Models', state: 'ok', what: `${id}: ${status.note}` } : { area: 'Models', state: 'fail', what: `${id} is picked but ${status.note}` });
  }
  if (usable === 0) add({ area: 'Models', state: 'fail', what: 'Nothing here can run a model yet', fix: ['Sign in to Claude Code, Codex or Grok Build if you have one of those subscriptions', 'or save an API key: poly login anthropic (or openai, xai)'] });
  add(config.defaultModel ? { area: 'Models', state: 'ok', what: `Default model: ${config.defaultModel}` } : { area: 'Models', state: 'warn', what: 'No default model picked yet', fix: ['poly start opens setup, where you pick one — or run poly in a terminal'] });

  // Where agents' commands run.
  const level = config.isolation.level;
  const runtime = deps.runtime();
  const title = ISOLATION_WORDS[level].title;
  if (level === 'host') {
    add({ area: 'Where agents run', state: 'ok', what: `${title}: agents run as you, and reach what you can${runtime ? ` (${runtime.name} is here, if you want them isolated)` : ''}` });
  } else if (runtime) {
    add({ area: 'Where agents run', state: 'ok', what: `${title}, in ${runtime.name} ${runtime.version}${runtime.rootless ? '' : ' (rootful: anything that can use it is root on this computer, and Polyphemus never gives its socket to an agent)'}` });
  } else {
    add({ area: 'Where agents run', state: 'fail', what: `Set to ${title}, but there’s no Docker or Podman here, so an agent can’t run a single command`, fix: ['Install Docker (docs.docker.com/engine/install) or Podman; on macOS, Docker Desktop, OrbStack or Colima', 'or let agents run on this computer, as you: poly config set isolation.level host'] });
  }

  // Phones.
  const tailscale = await deps.tailscale();
  if (!tailscale) {
    // Inside WSL it's Windows that runs Tailscale: installing it in Linux as well is the wrong advice.
    add(
      wsl
        ? { area: 'Phones', state: 'warn', what: 'Tailscale isn’t running on Windows, so only this computer can reach Polyphemus', fix: ['Install Tailscale on Windows — not inside Linux — and on your phone, and sign in to both with the same account (tailscale.com/download)'] }
        : { area: 'Phones', state: 'warn', what: 'Tailscale isn’t running here, so only this computer can reach Polyphemus', fix: ['Install Tailscale on this computer and your phone, and sign in to both with the same account (tailscale.com/download)'] },
    );
  } else {
    add({ area: 'Phones', state: 'ok', what: `Tailscale is connected${wsl ? ' on Windows' : ''}${tailscale.dnsName ? ` (${tailscale.dnsName.replace(/\.$/, '')})` : ''}` });
    const https = running ? await deps.https(port) : undefined;
    if (running && https) add({ area: 'Phones', state: 'ok', what: `Phones reach it at ${https}` });
    // Without HTTPS a phone still reaches a daemon that listens on the tailnet, without notifications.
    // One inside WSL doesn't listen there at all — the address is Windows's — so HTTPS is the only way in.
    else if (running && !tailscale.local) add({ area: 'Phones', state: 'warn', what: 'No HTTPS address, and from inside WSL that’s the only way a phone gets in', fix: ['Restart Polyphemus (poly service restart), which sets it up', `Or in PowerShell on Windows: tailscale serve --bg --https=443 http://127.0.0.1:${port}`] });
    else if (running) add({ area: 'Phones', state: 'warn', what: 'No HTTPS address, so phones can’t get notifications', fix: ['Restart Polyphemus (poly service restart). If Tailscale won’t let it set one up, run once: sudo tailscale set --operator=$USER'] });
  }
  const paired = polyphemus.store.listDevices().filter((d) => !d.revokedAt).length;
  add(paired ? { area: 'Phones', state: 'ok', what: `${paired} device${paired === 1 ? '' : 's'} paired` } : { area: 'Phones', state: 'warn', what: 'No phone paired yet', fix: ['poly pair'] });

  // The Browser connection: this computer's Chrome, or the one inside a worker.
  const chrome = deps.chrome();
  if (runtime) add({ area: 'Browser', state: 'ok', what: `Agents browse in ${runtime.name}${chrome ? '; sign-ins by hand use the Chrome here' : ''}` });
  else if (chrome) add({ area: 'Browser', state: 'ok', what: `Chrome: ${chrome}` });
  else add({ area: 'Browser', state: 'warn', what: 'No Chrome here, and no Docker or Podman to run one in, so the Browser connection can’t open pages', fix: ['Install Google Chrome or Chromium, or set POLYPHEMUS_CHROME to where it is'] });

  return found;
}

const MARK = { ok: green('✓'), warn: yellow('!'), fail: red('✗') };

/** `poly doctor`: exits 1 when something stops Polyphemus doing its job, so a script can ask it. */
export async function doctorCommand(polyphemus: Polyphemus, opts: { port: number; version: string; json: boolean; answers: (port: number) => Promise<boolean>; printJson: (data: unknown) => void }): Promise<void> {
  const findings = await diagnose(polyphemus, { port: opts.port, version: opts.version, deps: realDeps(opts.answers) });
  const failing = findings.filter((f) => f.state === 'fail').length;
  const warnings = findings.filter((f) => f.state === 'warn').length;
  if (failing) process.exitCode = 1;
  if (opts.json) return opts.printJson({ ok: failing === 0, findings });
  let area = '';
  for (const f of findings) {
    if (f.area !== area) console.log(`${area ? '\n' : ''}${bold((area = f.area))}`);
    console.log(`  ${MARK[f.state]} ${f.what}`);
    for (const step of f.fix ?? []) console.log(dim(`      ${step}`));
  }
  console.log('');
  if (failing) console.log(red(`${failing} thing${failing === 1 ? '' : 's'} to fix before Polyphemus can do its job${warnings ? `, and ${warnings} worth a look` : ''}.`));
  else if (warnings) console.log(yellow(`Ready. ${warnings} thing${warnings === 1 ? '' : 's'} worth a look.`));
  else console.log(green('All set.'));
}
