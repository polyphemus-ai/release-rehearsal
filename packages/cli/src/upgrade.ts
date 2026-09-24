import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assetPath, compareVersions, currentVersion, isVersion, loadAgents, loadRoutines, Polyphemus, PolyphemusError, publishedName } from '@polyphemus/core';
import { dim, green, yellow } from './render.js';
import type { ServiceManager } from './service-manager.js';

// Updating polyphemus without ever leaving it broken (docs/design/upgrades.md). The version that runs
// an update is the old one, so everything here has to be right before it's needed:
//
//   1. the new version is installed beside the running one, never over it;
//   2. it checks itself against a copy of this computer's data (`poly self-check`), changing nothing;
//   3. the data is backed up;
//   4. `current` is switched to it in one step, and the service restarted;
//   5. if the service doesn't come up and stay up, the old version and the backup go back on their own.
//
// A failure at 1–3 changes nothing at all. `poly rollback` goes back later, by hand.

/** Versions kept beside the running one, for going back. */
const KEEP_VERSIONS = 3;
/** Backups kept, newest first. */
const KEEP_BACKUPS = 3;
/** What an update backs up and a rollback puts back (sessions.db is copied as a consistent snapshot). */
const DATA_FILES = ['config.toml', 'vault.json', 'vault.key'];

/**
 * Where this copy is installed, and so how it's updated:
 * - `versions`: the installer's layout, `<prefix>/versions/<version>/` with `<prefix>/current` pointing
 *   at the running one. Updated beside itself, and switched.
 * - `npm`: a plain `npm install -g`. npm replaces it in place, so going back reinstalls the old version.
 */
export type Place = { kind: 'versions'; prefix: string } | { kind: 'npm'; prefix: string };

export function installPlace(here = assetPath('cli', ''), name = publishedName()): Place | undefined {
  const sep = '[\\\\/]';
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const versioned = new RegExp(`^(.*)${sep}versions${sep}[^\\\\/]+${sep}lib${sep}node_modules${sep}${escaped}${sep}`).exec(here);
  if (versioned) return { kind: 'versions', prefix: versioned[1]! };
  const npm = new RegExp(`^(.*)${sep}lib${sep}node_modules${sep}${escaped}${sep}`).exec(here);
  if (npm) return { kind: 'npm', prefix: npm[1]! };
  return undefined;
}

/** The launcher inside an npm prefix. */
export const launcherIn = (prefix: string, name = publishedName()): string => join(prefix, 'lib', 'node_modules', name, 'bin', 'polyphemus.mjs');

/** The launcher the service and the `poly` wrappers run: through `current`, so a switch moves them all. */
export function stableLauncher(place: Place | undefined = installPlace()): string {
  if (place?.kind === 'versions') return launcherIn(join(place.prefix, 'current'));
  return assetPath('cli', 'bin/polyphemus.mjs');
}

// —— self-check ——————————————————————————————————————————————————————————————————————————————

export interface CheckResult {
  name: string;
  ok: boolean;
  why?: string;
}

/**
 * This version, run against a copy of `home`'s data: its database changes applied to the copy, the
 * config read, the vault opened and a secret decrypted (never shown), agents, routines and projects
 * loaded. Nothing that acts is started — no turns, routines, runs or connections. The copy lives
 * inside `home` (it holds the vault's key) and is removed afterwards.
 */
export async function selfCheck(home: string): Promise<CheckResult[]> {
  // Its own folder, which the credential guard covers: the copy holds the vault and its key.
  const copies = join(home, 'self-check');
  mkdirSync(copies, { recursive: true, mode: 0o700 });
  chmodSync(copies, 0o700);
  // One left by a check that was killed (an update's timeout, a closed terminal) goes now.
  for (const old of readdirSync(copies)) if (Date.now() - statSync(join(copies, old)).mtimeMs > 10 * 60_000) rmSync(join(copies, old), { recursive: true, force: true });
  const copy = join(copies, `${process.pid}-${Date.now()}`);
  // Stopped partway, it removes the copy first: `finally` doesn't run when a signal ends the process.
  const cleanUp = () => {
    rmSync(copy, { recursive: true, force: true });
    process.exit(143);
  };
  process.once('SIGTERM', cleanUp);
  process.once('SIGHUP', cleanUp);
  const results: CheckResult[] = [];
  const check = async (name: string, fn: () => unknown) => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, why: (err as Error).message.split('\n')[0] });
    }
  };
  mkdirSync(copy, { recursive: true, mode: 0o700 });
  let polyphemus: Polyphemus | undefined;
  try {
    await check('copy this computer’s data', () => copyData(home, copy, { withFolders: true }));
    await check('open it', async () => {
      polyphemus = await Polyphemus.open(copy);
    });
    if (polyphemus) {
      const p = polyphemus;
      await check('read threads, projects and people', () => {
        p.store.list(50);
        p.store.projects();
        p.store.people();
      });
      await check('open the vault', () => {
        const [first] = p.vault.names();
        if (first !== undefined && p.vault.get(first, 'self-check') === undefined) throw new Error('a secret it lists couldn’t be read');
      });
      await check('load agents', () => {
        const { problems } = loadAgents(copy);
        if (problems.length) throw new Error(problems.map((problem) => JSON.stringify(problem)).join('; '));
      });
      await check('load routines', () => loadRoutines(copy, p.store));
    }
  } finally {
    try {
      polyphemus?.close();
    } catch {
      // the copy goes either way
    }
    rmSync(copy, { recursive: true, force: true });
    process.off('SIGTERM', cleanUp);
    process.off('SIGHUP', cleanUp);
  }
  return results;
}

/** A consistent copy of the data: the database as a snapshot (safe while it's in use), and the files beside it. */
function copyData(home: string, to: string, opts: { withFolders?: boolean } = {}): void {
  const db = join(home, 'sessions.db');
  if (existsSync(db)) {
    const source = new DatabaseSync(db, { readOnly: true });
    try {
      source.exec(`VACUUM INTO '${join(to, 'sessions.db').replace(/'/g, "''")}'`);
    } finally {
      source.close();
    }
  }
  for (const file of DATA_FILES) if (existsSync(join(home, file))) cpSync(join(home, file), join(to, file), { preserveTimestamps: true });
  // What's read when polyphemus opens: agents and routines. Uploads, artifacts and the like aren't.
  if (opts.withFolders) for (const folder of ['agents', 'routines']) if (existsSync(join(home, folder))) cpSync(join(home, folder), join(to, folder), { recursive: true });
}

// —— backups ——————————————————————————————————————————————————————————————————————————————————

export const backupsDir = (home: string): string => join(home, 'backups');

/** Backs up the data before an update, and keeps the last few. */
export function backUp(home: string, label: string): string {
  const dir = join(backupsDir(home), `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(backupsDir(home), 0o700);
  copyData(home, dir);
  writeFileSync(join(dir, '.complete'), `${Date.now()}\n`);
  const all = readdirSync(backupsDir(home))
    .map((name) => join(backupsDir(home), name))
    .filter((path) => existsSync(join(path, '.complete')))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const old of all.slice(KEEP_BACKUPS)) rmSync(old, { recursive: true, force: true });
  return dir;
}

/** Puts a backup back. Only with the daemon stopped: it replaces the database under it. */
export function restore(home: string, backup: string): void {
  if (!existsSync(join(backup, '.complete'))) throw new PolyphemusError(`${backup} isn’t a complete backup, so nothing was put back.`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(join(home, `sessions.db${suffix}`), { force: true });
  if (existsSync(join(backup, 'sessions.db'))) cpSync(join(backup, 'sessions.db'), join(home, 'sessions.db'));
  for (const file of DATA_FILES) if (existsSync(join(backup, file))) cpSync(join(backup, file), join(home, file), { preserveTimestamps: true });
}

// —— history ————————————————————————————————————————————————————————————————————————————————

export interface UpdateRecord {
  from: string;
  to: string;
  at: number;
  backup: string;
  /** What happened: the update went live, or went back on its own. */
  outcome: 'live' | 'went-back' | 'rolled-back';
}

const historyFile = (home: string) => join(home, 'updates.json');

export function updateHistory(home: string): UpdateRecord[] {
  try {
    return JSON.parse(readFileSync(historyFile(home), 'utf8')) as UpdateRecord[];
  } catch {
    return [];
  }
}

function record(home: string, entry: UpdateRecord): void {
  writeFileSync(historyFile(home), `${JSON.stringify([...updateHistory(home), entry].slice(-20), null, 2)}\n`, { mode: 0o600 });
}

// —— switching ————————————————————————————————————————————————————————————————————————————————

/** The version `current` points at, in the versions layout. */
export function currentOf(prefix: string): string | undefined {
  try {
    return readlinkSync(join(prefix, 'current')).split(/[\\/]/).pop();
  } catch {
    return undefined;
  }
}

/** Points `current` at a version in one step (relative, so the folder can move), and clears out old ones. */
export function switchTo(prefix: string, version: string, keep: string[] = []): void {
  const link = join(prefix, 'current');
  const temp = `${link}.next`;
  rmSync(temp, { force: true });
  symlinkSync(join('versions', version), temp);
  renameSync(temp, link);
  const versions = join(prefix, 'versions');
  const kept = new Set([version, ...keep]);
  const others = readdirSync(versions)
    .filter((name) => !kept.has(name) && !name.startsWith('.'))
    .sort((a, b) => compareVersions(b, a));
  for (const old of others.slice(Math.max(0, KEEP_VERSIONS - kept.size))) rmSync(join(versions, old), { recursive: true, force: true });
}

// —— the update ——————————————————————————————————————————————————————————————————————————————

export interface UpgradeDeps {
  home: string;
  place: Place;
  /** The service, when it's installed and should be restarted onto the new version. */
  service?: ServiceManager;
  /** Why the daemon isn't healthy, or nothing when it answers and stays up. */
  unhealthy(): Promise<string | undefined>;
  /** Waits for running turns and runs to finish; false if they didn't in time. */
  waitForIdle(): Promise<boolean>;
  log(line: string): void;
  /** Whether a daemon is running that `service` can't stop (`poly serve` in a terminal). */
  daemonOutsideService?(): boolean;
  /** Installs `spec` into an npm prefix; the default runs npm. */
  npmInstall?(prefix: string, spec: string): { ok: boolean; why?: string };
}

export type UpgradeResult = { ok: true; to: string; backup: string } | { ok: false; changed: false; why: string } | { ok: false; changed: true; why: string; wentBack: boolean };

function npmInstall(prefix: string, spec: string): { ok: boolean; why?: string } {
  const registry = process.env.POLYPHEMUS_NPM_REGISTRY;
  const run = spawnSync('npm', ['install', '-g', '--prefix', prefix, '--no-fund', '--no-audit', '--no-update-notifier', '--loglevel=error', ...(registry ? ['--registry', registry] : []), spec], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const why = `${run.stderr ?? ''}${run.stdout ?? ''}`.trim().split('\n').filter(Boolean).slice(-3).join(' ');
  return run.status === 0 ? { ok: true } : { ok: false, why: why || `npm exited ${run.status}` };
}

/** Whether this Node satisfies a package's `engines.node` (the `>=x.y.z` form polyphemus uses). */
function nodeSatisfies(range: string | undefined, version = process.versions.node): boolean {
  const min = /^>=\s*(\d+\.\d+\.\d+)/.exec(range ?? '')?.[1];
  return !min || compareVersions(version, min) >= 0;
}

/** Runs a staged version's own launcher. */
function runStaged(launcher: string, args: string[], home: string): { status: number | null; out: string } {
  const run = spawnSync(process.execPath, [launcher, ...args], {
    encoding: 'utf8',
    env: { ...process.env, POLYPHEMUS_HOME: home, POLYPHEMUS_TAILSCALE: 'off', NO_COLOR: '1' },
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() };
}

/**
 * Updates to `target`. Each step that can fail before the switch leaves everything as it was; after
 * the switch, a service that doesn't come up and stay up has the old version and the backup put back.
 */
export async function upgrade(target: string, deps: UpgradeDeps): Promise<UpgradeResult> {
  const { home, place, log } = deps;
  if (!isVersion(target)) return { ok: false, changed: false, why: `“${target.replace(/[^\x20-\x7e]/g, '?')}” isn’t a version, so nothing was changed.` };
  const install = deps.npmInstall ?? npmInstall;
  const from = currentVersion();
  const name = publishedName();
  const spec = `${name}@${target}`;

  // 1. Beside the running one: the versions layout keeps it; a plain npm install gets a staging copy.
  const staged = place.kind === 'versions' ? join(place.prefix, 'versions', target) : join(home, 'cache', `update-${target}`);
  const ready = join(staged, '.polyphemus-ready');
  if (!existsSync(ready)) {
    rmSync(staged, { recursive: true, force: true });
    log(dim(`Installing ${name} ${target} beside ${from}…`));
    mkdirSync(staged, { recursive: true });
    const installed = install(staged, spec);
    if (!installed.ok) {
      rmSync(staged, { recursive: true, force: true });
      return { ok: false, changed: false, why: `npm couldn’t install ${spec}: ${installed.why}` };
    }
  }
  const discard = () => {
    if (place.kind === 'npm' || !existsSync(ready)) rmSync(staged, { recursive: true, force: true });
  };
  const launcher = launcherIn(staged, name);
  const pkg = JSON.parse(readFileSync(join(dirname(dirname(launcher)), 'package.json'), 'utf8')) as { version: string; engines?: { node?: string } };
  if (!nodeSatisfies(pkg.engines?.node)) {
    discard();
    return { ok: false, changed: false, why: `${target} needs Node.js ${pkg.engines?.node}, and this computer runs ${process.versions.node}. Install a newer Node.js, then update again.` };
  }

  // 2. It runs, and it can read this computer's data (a copy of it).
  const version = runStaged(launcher, ['--version'], home);
  if (version.status !== 0 || version.out.split('\n').pop() !== target) {
    discard();
    return { ok: false, changed: false, why: `${target} didn’t start: ${version.out.split('\n').slice(-2).join(' ') || `exit ${version.status}`}` };
  }
  log(dim(`Checking ${target} against a copy of your data…`));
  const checked = runStaged(launcher, ['self-check'], home);
  if (checked.status !== 0) {
    discard();
    return { ok: false, changed: false, why: `${target} couldn’t work with your data, so nothing was changed:\n${checked.out.split('\n').slice(-8).join('\n')}` };
  }
  writeFileSync(ready, `${new Date().toISOString()}\n`);

  // 3. Nothing mid-turn, then a backup.
  if (!(await deps.waitForIdle())) return { ok: false, changed: false, why: 'Sessions were still working, so nothing was changed. Update again when they’ve finished, or with --now.' };
  const backup = backUp(home, `before-${target}`);

  // 4. The switch.
  const goBack = (): boolean => {
    deps.service?.stop();
    restore(home, backup);
    let back = true;
    if (place.kind === 'versions') switchTo(place.prefix, from, [target]);
    else back = install(place.prefix, `${name}@${from}`).ok;
    deps.service?.start();
    return back;
  };
  if (place.kind === 'versions') switchTo(place.prefix, target, [from]);
  else {
    const inPlace = install(place.prefix, spec);
    if (!inPlace.ok) {
      const back = install(place.prefix, `${name}@${from}`).ok;
      rmSync(staged, { recursive: true, force: true });
      return { ok: false, changed: true, wentBack: back, why: `npm couldn’t install ${spec} in place (${inPlace.why})${back ? `, so ${from} was put back` : `, and putting ${from} back failed too: npm install -g ${name}@${from}`}.` };
    }
    rmSync(staged, { recursive: true, force: true });
  }

  // 5. The service onto it, and watched.
  if (deps.service) {
    deps.service.restart();
    const why = await deps.unhealthy();
    if (why) {
      const back = goBack();
      record(home, { from, to: target, at: Date.now(), backup, outcome: 'went-back' });
      return { ok: false, changed: true, wentBack: back, why: `${target} didn’t come up (${why}), so ${from} and your data from just before were put back.` };
    }
  }
  record(home, { from, to: target, at: Date.now(), backup, outcome: 'live' });
  return { ok: true, to: target, backup };
}

/**
 * Goes back to the version before the last update. The data stays as it is — newer data only ever
 * adds to older — unless `restoreData`, which puts back the backup from before that update (and loses
 * what's happened since).
 */
export async function rollback(deps: Omit<UpgradeDeps, 'waitForIdle'> & { waitForIdle(): Promise<boolean>; restoreData?: boolean }): Promise<{ ok: boolean; why: string }> {
  const { home, place } = deps;
  const last = [...updateHistory(home)].reverse().find((entry) => entry.outcome === 'live');
  const now = currentVersion();
  if (!last || last.to !== now) return { ok: false, why: `There’s no update to ${now} on record to go back from.` };
  if (!isVersion(last.from)) return { ok: false, why: 'The update record doesn’t name a version to go back to.' };
  // Putting data back replaces the database: a daemon nothing here can stop would keep writing to
  // the old one, and everything after would be lost (security review, 2026-09-24).
  if (deps.restoreData && !deps.service && deps.daemonOutsideService?.()) {
    return { ok: false, why: 'polyphemus is running in a terminal (poly serve). Stop it first, then run this again, so your data isn’t replaced under it.' };
  }
  if (!(await deps.waitForIdle())) return { ok: false, why: 'Sessions were still working, so nothing was changed. Try again when they’ve finished, or with --now.' };
  const name = publishedName();
  if (place.kind === 'versions' && !existsSync(join(place.prefix, 'versions', last.from, '.polyphemus-ready')) && !existsSync(launcherIn(join(place.prefix, 'versions', last.from), name))) {
    return { ok: false, why: `${last.from} isn’t kept on this computer any more. Install it with: POLYPHEMUS_VERSION=${last.from} and the one-line installer.` };
  }
  deps.service?.stop();
  if (deps.restoreData) restore(home, last.backup);
  if (place.kind === 'versions') switchTo(place.prefix, last.from, [last.to]);
  else {
    const back = (deps.npmInstall ?? npmInstall)(place.prefix, `${name}@${last.from}`);
    if (!back.ok) {
      deps.service?.start();
      return { ok: false, why: `npm couldn’t install ${name}@${last.from}: ${back.why}` };
    }
  }
  deps.service?.start();
  const why = deps.service ? await deps.unhealthy() : undefined;
  record(home, { from: last.to, to: last.from, at: Date.now(), backup: last.backup, outcome: 'rolled-back' });
  if (why) return { ok: false, why: `${last.from} is back, but the service didn’t come up (${why}).${deps.restoreData ? '' : ' If it says the data is newer, try: poly rollback --restore'}` };
  return { ok: true, why: `Back on ${last.from}${deps.restoreData ? `, with your data from ${new Date(last.at).toLocaleString()}` : ''}.` };
}

/** How a result reads in the terminal. */
export function sayResult(result: UpgradeResult, log: (line: string) => void): void {
  if (result.ok) {
    log(green(`✓ polyphemus ${result.to} is installed.`));
    log(dim(`  Your data from just before is kept in ${result.backup}. To go back: poly rollback`));
  } else log(yellow(`✗ ${result.why}`));
}
