import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetPath, bundled, polyphemusHome, PolyphemusError } from '@polyphemus/core';
import { cyan, dim, green, yellow } from './render.js';
import { serviceManager, type ServiceManager } from './service-manager.js';
import { stableLauncher } from './upgrade.js';

/** The checkout this command runs from: where the service's copies come from. */
const SOURCE = fileURLToPath(new URL('../../../', import.meta.url));
const USAGE = 'Usage: poly service install | update [--now] | rollback | status | logs | restart | uninstall';
/** How long a restarted daemon has to answer before polyphemus puts the copy it came from back. */
const HEALTHY_MS = 90_000;
/** How long a deploy waits for running sessions before giving up and leaving the copy ready. */
const IDLE_WAIT_MS = 60 * 60_000;
/** Where a deploy that finishes on its own says what it did. */
const deployLog = () => join(releasesDir(), 'deploy.log');
/** Copies kept (the running one and the ones before it), for going back. */
const KEEP_RELEASES = 3;

// The service runs its own copy of polyphemus, never the working copy being edited, so a restart can't
// put half-finished work live. Each copy is one commit, installed and tested before it's used:
// ~/.polyphemus/releases/<commit>/, with `current` pointing at the running one. They're disposable
// copies polyphemus makes of itself, so they live in ~/.polyphemus (unlike your projects).
const releasesDir = () => join(polyphemusHome(), 'releases');
const currentLink = () => join(releasesDir(), 'current');

export { serviceUnit, type UnitOptions } from './service-manager.js';

/** `poly service …`: runs the daemon in the background with systemd, started at boot. */
export async function service(action: string | undefined, cwd: string, port: number, opts: { now?: boolean } = {}): Promise<void> {
  const manager = serviceManager();
  const { file } = manager;
  // Installed from npm there's no checkout to make copies from: the service runs the installed
  // package, and `poly update` moves it to a newer version.
  if (bundled && (action === 'install' || action === 'update' || action === 'status')) return installedService(manager, action, cwd, port, opts);
  switch (action) {
    case 'install': {
      const busy = await portInUse(port);
      const wasActive = manager.isActive();
      const release = prepare();
      manager.register({
        node: process.execPath,
        launcher: join(currentLink(), 'packages', 'cli', 'bin', 'polyphemus.mjs'),
        cwd,
        path: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        port: process.env.POLYPHEMUS_PORT,
      });
      if (wasActive) await waitForIdle(opts.now);
      activate(release.dir);
      if (wasActive) manager.restart();
      else manager.start();
      console.log(`${green('✓')} polyphemus runs in the background on its own copy (${release.commit}: ${release.subject}), and starts when this computer does.`);
      console.log(dim(`  ${manager.kind}: ${file}`));
      console.log(dim(`  Edits you make don't go live until you commit and run: poly service update`));
      console.log(dim(`  Phone sessions outside a project start in ${cwd}.`));
      if (busy && !wasActive) console.log(yellow(`Something is already using port ${port}, probably poly serve in a terminal. Stop it (Ctrl+C) and the service takes over within a few seconds.`));
      const note = manager.bootNote();
      if (note) console.log(yellow(note));
      console.log(dim(`Check on it: ${cyan('poly service status')} · ${cyan('poly service logs')}`));
      return;
    }
    case 'update': {
      if (!existsSync(file)) throw new PolyphemusError('The service isn’t installed yet: poly service install');
      if (!readFileSync(file, 'utf8').includes(currentLink())) throw new PolyphemusError('The service still runs from your working copy. Run poly service install once to give it its own.');
      const before = currentCommit();
      const release = prepare();
      if (release.commit === before) return console.log(`Already running ${release.commit}: ${release.subject}`);
      if (uncommitted()) console.log(dim('Uncommitted changes in your working copy were left out.'));
      const busyWith = opts.now ? 0 : (daemonStatus()?.running ?? 0);
      if (busyWith > 0) {
        // Something is mid-turn — often the very session that asked for this. Restarting now would cut
        // it off, and waiting here would wait for itself, so the deploy finishes on its own afterwards.
        handOff(release.dir, port);
        return console.log(
          `${green('✓')} Ready: ${release.commit} (${release.subject}).\n` +
            dim(`  ${busyWith} session${busyWith === 1 ? ' is' : 's are'} working, so polyphemus restarts into it when they finish, and goes back to ${before ?? 'the copy it came from'} if it doesn’t come up.\n  What happened: ${deployLog()}`),
        );
      }
      await waitForIdle(opts.now);
      const wentLive = await goLive(release.dir, manager, port);
      return console.log(
        wentLive.ok
          ? `${green('✓')} Updated ${before ?? 'the service'} → ${release.commit}: ${release.subject}`
          : `${yellow('✗')} ${release.commit} didn’t come up (${wentLive.why}), so polyphemus put ${wentLive.wentBackTo ?? 'the copy it came from'} back.`,
      );
    }
    case 'rollback': {
      const back = previousRelease();
      if (!back) throw new PolyphemusError('There’s no earlier copy to go back to.');
      const from = currentCommit();
      const wentLive = await goLive(back, manager, port, { rollback: false });
      return console.log(
        wentLive.ok
          ? `${green('✓')} Went back to ${basename(back)}${from ? ` from ${from}` : ''}. Deploy again with: poly service update`
          : `${yellow('✗')} ${basename(back)} didn’t come up either (${wentLive.why}). Look at: poly service logs`,
      );
    }
    // Finishes a deploy the sessions were too busy for: waits for them, then goes live (with the
    // rollback). Started detached by `update`, so it outlives the session that asked and the restart.
    case 'finish': {
      const dir = process.env.POLYPHEMUS_DEPLOY_DIR ?? '';
      const say = (line: string) => {
        try {
          writeFileSync(deployLog(), `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
        } catch {
          // best effort: the log is for you, not for the deploy
        }
      };
      if (!dir || !existsSync(join(dir, '.polyphemus-ready'))) return say(`${basename(dir) || 'that copy'}: not ready, nothing done.`);
      const waited = await waitForIdle(false, IDLE_WAIT_MS);
      if (!waited) return say(`${basename(dir)}: sessions were still working an hour later, so it wasn’t put live. Deploy again when they’re done.`);
      const wentLive = await goLive(dir, manager, port);
      return say(wentLive.ok ? `${basename(dir)} is live.` : `${basename(dir)} didn’t come up (${wentLive.why}); put ${wentLive.wentBackTo ?? 'the copy it came from'} back.`);
    }
    case 'status': {
      const running = currentCommit();
      const latest = git(SOURCE, ['rev-parse', '--short=10', 'HEAD']);
      if (!running) console.log(yellow('The service runs from your working copy: run poly service install to give it its own.'));
      else if (running === latest) console.log(`Running ${running}, your latest commit.`);
      else console.log(`Running ${running}. ${yellow(`Your latest commit is ${latest}: deploy it with poly service update.`)}`);
      return manager.status();
    }
    case 'logs':
      return manager.logs();
    case 'restart':
      await waitForIdle(opts.now);
      manager.restart();
      return console.log('Restarted.');
    case 'uninstall':
      if (!existsSync(file)) return console.log(dim('The service isn’t installed.'));
      manager.unregister();
      if (!bundled) rmSync(releasesDir(), { recursive: true, force: true });
      return console.log('Removed. Run poly serve in a terminal when you want the daemon.');
    default:
      throw new PolyphemusError(USAGE);
  }
}

/** The service for an installed package: it runs this package's launcher, wherever npm put it. */
async function installedService(manager: ServiceManager, action: 'install' | 'update' | 'status', cwd: string, port: number, opts: { now?: boolean }): Promise<void> {
  const version = (JSON.parse(readFileSync(assetPath('cli', 'package.json'), 'utf8')) as { version: string }).version;
  if (action === 'status') {
    console.log(`Running polyphemus ${version} from ${assetPath('cli', '')}.`);
    return manager.status();
  }
  if (action === 'update') throw new PolyphemusError('Installed from npm, poly updates with: poly update');
  const busy = await portInUse(port);
  const wasActive = manager.isActive();
  if (wasActive) await waitForIdle(opts.now);
  // Through `current` in the installer's layout, so an update's switch moves the service with it.
  manager.register({ node: process.execPath, launcher: stableLauncher(), cwd, path: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', port: process.env.POLYPHEMUS_PORT });
  if (wasActive) manager.restart();
  else manager.start();
  console.log(`${green('✓')} polyphemus ${version} runs in the background, and starts when this computer does.`);
  console.log(dim(`  ${manager.kind}: ${manager.file}`));
  if (busy && !wasActive) console.log(yellow(`Something is already using port ${port}, probably poly serve in a terminal. Stop it (Ctrl+C) and the service takes over within a few seconds.`));
  const note = manager.bootNote();
  if (note) console.log(yellow(note));
}

/**
 * A clean, installed, tested copy of the latest commit, ready to run. If its tests fail it's
 * thrown away and nothing changes.
 */
function prepare(): { commit: string; subject: string; dir: string } {
  const commit = git(SOURCE, ['rev-parse', '--short=10', 'HEAD']);
  const subject = git(SOURCE, ['log', '-1', '--format=%s', commit]);
  const dir = join(releasesDir(), commit);
  if (existsSync(join(dir, '.polyphemus-ready'))) return { commit, subject, dir };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(releasesDir(), { recursive: true });
  console.log(dim(`Preparing ${commit} (${subject}): a clean copy, its dependencies, then typecheck, tests and the app smoke check…`));
  execFileSync('git', ['clone', '--quiet', SOURCE, dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  git(dir, ['checkout', '--quiet', '--detach', commit]);
  execFileSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--silent'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  // Every check AGENTS.md asks for before calling something done, as gates rather than advice: types,
  // tests, and every screen of the app opened in a real browser. The smoke check needs Chrome; on a
  // machine without it, that one is skipped out loud rather than blocking every deploy.
  const gates: Array<[string, string, string[]]> = [
    ['typecheck', 'pnpm', ['typecheck']],
    ['tests', 'pnpm', ['test']],
    ...(hasChrome() ? [['app smoke check', 'node', ['scripts/smoke.mjs']] as [string, string, string[]]] : []),
  ];
  if (!hasChrome()) console.log(yellow('! No Chrome on this machine: skipping the app smoke check.'));
  for (const [name, command, args] of gates) {
    const run = spawnSync(command, args, { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (run.status !== 0) {
      rmSync(dir, { recursive: true, force: true });
      const tail = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n');
      throw new PolyphemusError(`The ${name} failed on ${commit}, so the service stays as it is.\n${tail}`);
    }
  }
  writeFileSync(join(dir, '.polyphemus-ready'), `${new Date().toISOString()}\n`);
  return { commit, subject, dir };
}

function hasChrome(): boolean {
  return ['google-chrome', 'chromium', 'chromium-browser'].some((name) => spawnSync('which', [name], { stdio: 'ignore' }).status === 0);
}

/** Points `current` at a copy (atomically), and clears out old copies. */
function activate(dir: string): void {
  const link = currentLink();
  const temp = `${link}.next`;
  rmSync(temp, { force: true });
  symlinkSync(dir, temp);
  renameSync(temp, link);
  const copies = readdirSync(releasesDir())
    .filter((name) => /^[0-9a-f]{7,40}$/.test(name))
    .map((name) => join(releasesDir(), name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const old of copies.filter((copy) => copy !== dir).slice(KEEP_RELEASES - 1)) rmSync(old, { recursive: true, force: true });
}

function currentCommit(): string | undefined {
  try {
    return basename(realpathSync(currentLink()));
  } catch {
    return undefined;
  }
}

/**
 * Waits until no session is mid-turn (the daemon keeps ~/.polyphemus/daemon.json current), unless `now`.
 * False if they were still working when the time ran out — it never waits for ever, and a session that
 * asked for this would otherwise be waiting for itself.
 */
export async function waitForIdle(now = false, timeoutMs = IDLE_WAIT_MS): Promise<boolean> {
  let announced = false;
  const until = Date.now() + timeoutMs;
  for (;;) {
    const status = daemonStatus();
    // Workflow runs as well as turns: a run between two steps isn't mid-turn, but a restart still cuts it.
    const busy = (status?.running ?? 0) + (status ? activeRuns() : 0);
    if (now || busy === 0) return true;
    if (Date.now() > until) return false;
    if (!announced) {
      console.log(yellow(`Waiting for ${busy} running session${busy === 1 ? '' : 's'} and run${busy === 1 ? '' : 's'} to finish before restarting. Ctrl+C to cancel, or --now to restart anyway.`));
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * Puts a copy live and makes sure it answers: if it doesn't, the copy it came from goes back, so a
 * release that can't start doesn't leave you with a daemon crash-looping and no way in.
 */
async function goLive(dir: string, manager: ServiceManager, port: number, opts: { rollback?: boolean } = {}): Promise<{ ok: boolean; why?: string; wentBackTo?: string }> {
  const from = realpathSync(currentLink());
  activate(dir);
  manager.restart();
  const why = await unhealthy(port);
  if (!why) return { ok: true };
  if (opts.rollback === false || from === dir || !existsSync(join(from, '.polyphemus-ready'))) return { ok: false, why };
  activate(from);
  manager.restart();
  await unhealthy(port);
  return { ok: false, why, wentBackTo: basename(from) };
}

/** Workflow runs going or about to go (not ones waiting on a person: a restart asks their gate again). */
function activeRuns(): number {
  try {
    const db = new DatabaseSync(join(polyphemusHome(), 'sessions.db'), { readOnly: true });
    try {
      return (db.prepare("SELECT count(*) AS n FROM runs WHERE status IN ('queued', 'running', 'retrying')").get() as { n: number }).n;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/**
 * Why a restarted daemon isn't healthy, or nothing: it has to answer, and still be answering a few
 * seconds later — one that starts and then falls over would otherwise pass.
 */
export async function unhealthy(port: number, timeoutMs = HEALTHY_MS): Promise<string | undefined> {
  const first = await answers(port, timeoutMs);
  if (first) return first;
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const again = await answers(port, 10_000);
  return again ? `it answered, then stopped (${again})` : undefined;
}

/** Why the daemon isn't answering on its port, or nothing once it is. */
async function answers(port: number, timeoutMs: number): Promise<string | undefined> {
  const until = Date.now() + timeoutMs;
  let last = 'it never answered';
  for (;;) {
    try {
      // Any answer means it started and is serving: an unpaired device gets 401 from a healthy daemon.
      // Only 5xx is the daemon itself failing.
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return undefined;
      last = `it answered ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    if (Date.now() > until) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** The copy live before this one, if it's still there. */
function previousRelease(): string | undefined {
  const current = (() => {
    try {
      return realpathSync(currentLink());
    } catch {
      return undefined;
    }
  })();
  return readdirSync(releasesDir())
    .filter((name) => /^[0-9a-f]{7,40}$/.test(name))
    .map((name) => join(releasesDir(), name))
    .filter((dir) => dir !== current && existsSync(join(dir, '.polyphemus-ready')))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** Leaves the rest of the deploy to a process of its own, which outlives this session and the restart. */
function handOff(dir: string, port: number): void {
  const child = spawn(process.execPath, [join(dir, 'packages', 'cli', 'bin', 'polyphemus.mjs'), 'service', 'finish'], {
    cwd: dir,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, POLYPHEMUS_PORT: String(port), POLYPHEMUS_DEPLOY_DIR: dir },
  });
  child.unref();
}

function daemonStatus(): { pid: number; running: number } | undefined {
  try {
    const status = JSON.parse(readFileSync(join(polyphemusHome(), 'daemon.json'), 'utf8')) as { pid: number; running: number };
    process.kill(status.pid, 0); // still alive?
    return status;
  } catch {
    return undefined;
  }
}


function uncommitted(): boolean {
  return git(SOURCE, ['status', '--porcelain', '--untracked-files=no']) !== '';
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}



/** Whether your services keep running (and start at boot) without you logged in. */

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}
