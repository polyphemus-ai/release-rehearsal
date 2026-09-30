import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentVersion } from '@polyphemus/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceManager } from '../src/service-manager.js';
import { currentOf, installPlace, rollback, updateHistory, upgrade } from '../src/upgrade.js';

// The service half of an update, with a stand-in service (scripts/upgrade-check.mjs does the rest for
// real, with npm and the installer): the new version goes live, and if the daemon doesn't come up,
// the old version and the data from just before go back without anyone having to do anything.
describe('updating with the service running', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  const from = currentVersion();
  const target = '99.0.0';

  /** A versions layout with `from` live and `target` already installed beside it, and some data. */
  function setUp(opts: { selfCheck?: 'ok' | 'fails' } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'polyphemus-upgrade-test-'));
    dirs.push(dir);
    const prefix = join(dir, 'prefix');
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.toml'), 'what = "before"\n');
    for (const version of [from, target]) {
      const pkg = join(prefix, 'versions', version, 'lib', 'node_modules', 'polyphemus');
      mkdirSync(join(pkg, 'bin'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'polyphemus', version, engines: { node: '>=22.13.0' } }));
      // A launcher that answers --version and self-check the way a real one does.
      writeFileSync(join(pkg, 'bin', 'polyphemus.mjs'), `if (process.argv[2] === '--version') console.log(${JSON.stringify(version)}); else if (process.argv[2] === 'self-check') process.exit(${opts.selfCheck === 'fails' ? 1 : 0});`);
    }
    // Installed already, as an update that was stopped partway leaves it: not fetched again.
    writeFileSync(join(prefix, 'versions', target, '.polyphemus-ready'), '');
    symlinkSync(join('versions', from), join(prefix, 'current'));
    return { prefix, home };
  }

  /** A service that, restarted onto the new version, has it change the data — and then answers or doesn't. */
  function service(home: string, calls: string[]): ServiceManager {
    const noop = () => {};
    return {
      kind: 'test',
      file: '',
      register: noop,
      start: () => calls.push('start'),
      stop: () => calls.push('stop'),
      restart: () => {
        calls.push('restart');
        writeFileSync(join(home, 'config.toml'), 'what = "changed by the new version"\n');
      },
      isActive: () => true,
      unregister: noop,
      status: noop,
      logs: noop,
      bootNote: () => undefined,
    };
  }

  it('goes live when the daemon comes up, keeping the old version to go back to', async () => {
    const { prefix, home } = setUp();
    const calls: string[] = [];
    const result = await upgrade(target, { home, place: { kind: 'versions', prefix }, service: service(home, calls), unhealthy: async () => undefined, waitForIdle: async () => true, log: () => {} });
    expect(result).toMatchObject({ ok: true, to: target });
    expect(currentOf(prefix)).toBe(target);
    expect(existsSync(join(prefix, 'versions', from))).toBe(true);
    expect(calls).toEqual(['restart']);
    expect(updateHistory(home).at(-1)).toMatchObject({ from, to: target, outcome: 'live' });
  });

  it('puts the old version and the data back on its own when the daemon doesn’t come up', async () => {
    const { prefix, home } = setUp();
    const calls: string[] = [];
    const result = await upgrade(target, { home, place: { kind: 'versions', prefix }, service: service(home, calls), unhealthy: async () => 'it never answered', waitForIdle: async () => true, log: () => {} });
    expect(result).toMatchObject({ ok: false, changed: true, wentBack: true });
    expect(currentOf(prefix)).toBe(from);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('what = "before"\n');
    // Stopped before the data went back, started after: never a database replaced under a running daemon.
    expect(calls).toEqual(['restart', 'stop', 'start']);
    expect(updateHistory(home).at(-1)).toMatchObject({ outcome: 'went-back' });
  });

  it('changes nothing when the new version’s self-check fails', async () => {
    const { prefix, home } = setUp({ selfCheck: 'fails' });
    const calls: string[] = [];
    const result = await upgrade(target, { home, place: { kind: 'versions', prefix }, service: service(home, calls), unhealthy: async () => undefined, waitForIdle: async () => true, log: () => {} });
    expect(result).toMatchObject({ ok: false, changed: false });
    expect(currentOf(prefix)).toBe(from);
    expect(calls).toEqual([]);
    expect(existsSync(join(home, 'backups'))).toBe(false);
  });

  it('waits for work in progress, and changes nothing if it doesn’t finish', async () => {
    const { prefix, home } = setUp();
    const calls: string[] = [];
    const result = await upgrade(target, { home, place: { kind: 'versions', prefix }, service: service(home, calls), unhealthy: async () => undefined, waitForIdle: async () => false, log: () => {} });
    expect(result).toMatchObject({ ok: false, changed: false });
    expect(currentOf(prefix)).toBe(from);
    expect(calls).toEqual([]);
  });

  it('rolls back by hand, keeping the data unless asked to restore it', async () => {
    const { prefix, home } = setUp();
    const calls: string[] = [];
    const deps = { home, place: { kind: 'versions' as const, prefix }, service: service(home, calls), unhealthy: async () => undefined, waitForIdle: async () => true, log: () => {} };
    await upgrade(target, deps);
    // What rollback goes back from is the version running — here, still the test's own.
    const history = JSON.parse(readFileSync(join(home, 'updates.json'), 'utf8')) as Array<{ to: string }>;
    history.at(-1)!.to = from;
    writeFileSync(join(home, 'updates.json'), JSON.stringify(history));
    const back = await rollback({ ...deps, restoreData: true });
    expect(back.ok).toBe(true);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('what = "before"\n');
    expect(calls.slice(-2)).toEqual(['stop', 'start']);
  });

  it('goes back when restarting the service fails outright, and says so', async () => {
    // It used to skip the health check and going back, and leave nothing on record (Codex review, 2026-09-24).
    const { prefix, home } = setUp();
    const calls: string[] = [];
    const failing = { ...service(home, calls), restart: () => { calls.push('restart'); throw new Error('systemctl --user restart failed'); } };
    const result = await upgrade(target, { home, place: { kind: 'versions', prefix }, service: failing, unhealthy: async () => undefined, waitForIdle: async () => true, log: () => {} });
    expect(result).toMatchObject({ ok: false, changed: true, wentBack: true, why: expect.stringContaining('restarting it failed') });
    expect(currentOf(prefix)).toBe(from);
    expect(calls).toEqual(['restart', 'stop', 'start']);
    expect(updateHistory(home).at(-1)).toMatchObject({ outcome: 'went-back' });
  });

  it('records the update before switching, so an updater stopped partway can still be rolled back', async () => {
    const { prefix, home } = setUp();
    // As an updater killed between the switch and settling it leaves things: current on the new one.
    await upgrade(target, { home, place: { kind: 'versions', prefix }, unhealthy: async () => undefined, waitForIdle: async () => true, log: () => {} });
    const history = JSON.parse(readFileSync(join(home, 'updates.json'), 'utf8')) as Array<{ to: string; from: string; outcome: string }>;
    Object.assign(history.at(-1)!, { outcome: 'switching', from: target, to: from });
    writeFileSync(join(home, 'updates.json'), JSON.stringify(history));
    const back = await rollback({ home, place: { kind: 'versions', prefix }, unhealthy: async () => undefined, waitForIdle: async () => true, log: () => {} });
    expect(back.ok).toBe(true);
    expect(currentOf(prefix)).toBe(target);
  });

  it('puts the data back after rolling back by hand, when asked', async () => {
    // B → A by hand, then A with --restore: it refused, finding no update to A on record (Codex review).
    const { prefix, home } = setUp();
    const deps = { home, place: { kind: 'versions' as const, prefix }, unhealthy: async () => undefined, waitForIdle: async () => true, log: () => {} };
    await upgrade(target, deps);
    writeFileSync(join(home, 'config.toml'), 'what = "written by the new version"\n');
    // As `poly rollback` records it, run by the new version: back from it to the one this test runs as.
    const history = JSON.parse(readFileSync(join(home, 'updates.json'), 'utf8')) as Array<Record<string, unknown>>;
    history.push({ ...history.at(-1)!, from: target, to: from, outcome: 'rolled-back' });
    writeFileSync(join(home, 'updates.json'), JSON.stringify(history));
    const restored = await rollback({ ...deps, restoreData: true });
    expect(restored).toMatchObject({ ok: true, why: expect.stringContaining('is back') });
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('what = "before"\n');
    expect(updateHistory(home).at(-1)).toMatchObject({ outcome: 'restored' });
  });

  it('keeps update and rollback working when the data is too new to open', () => {
    // The commands that recover from it stopped at the same refusal (Codex review, 2026-09-24).
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-newer-data-'));
    dirs.push(home);
    const db = new DatabaseSync(join(home, 'sessions.db'));
    db.exec('PRAGMA user_version = 999');
    db.close();
    const launcher = fileURLToPath(new URL('../bin/polyphemus.mjs', import.meta.url));
    const env = { ...process.env, POLYPHEMUS_HOME: home, POLYPHEMUS_TAILSCALE: 'off', POLYPHEMUS_NPM_REGISTRY: 'http://127.0.0.1:9', NO_COLOR: '1' };
    for (const args of [['rollback', '--restore'], ['update']]) {
      const run = spawnSync(process.execPath, [launcher, ...args], { env, encoding: 'utf8', timeout: 60_000 });
      const said = `${run.stdout}${run.stderr}`;
      expect(said).not.toContain('newer version of polyphemus changed');
      // Run from this checkout, each gets as far as saying how a checkout is updated: past the data.
      expect(said).toMatch(args[0] === 'rollback' ? /no update to .* on record|runs from a checkout/ : /checkout of its repository|Couldn’t find out the newest version/);
    }
    // Anything else still refuses the data it can't read.
    expect(`${spawnSync(process.execPath, [launcher, 'projects'], { env, encoding: 'utf8', timeout: 60_000 }).stderr}`).toContain('newer version of polyphemus changed');
  });

  it('won’t put data back under a daemon running in a terminal', async () => {
    const { prefix, home } = setUp();
    const deps = { home, place: { kind: 'versions' as const, prefix }, unhealthy: async () => undefined, waitForIdle: async () => true, log: () => {} };
    await upgrade(target, deps);
    const history = JSON.parse(readFileSync(join(home, 'updates.json'), 'utf8')) as Array<{ to: string }>;
    history.at(-1)!.to = from;
    writeFileSync(join(home, 'updates.json'), JSON.stringify(history));
    writeFileSync(join(home, 'config.toml'), 'what = "since the update"\n');
    const back = await rollback({ ...deps, restoreData: true, daemonOutsideService: () => true });
    expect(back).toMatchObject({ ok: false, why: expect.stringContaining('Stop it first') });
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('what = "since the update"\n');
    expect(currentOf(prefix)).toBe(target);
  });

  it('refuses a version that isn’t one before touching any folder', async () => {
    const { prefix, home } = setUp();
    const victim = join(prefix, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'x');
    const result = await upgrade('99.0.0/../../victim', { home, place: { kind: 'versions', prefix }, unhealthy: async () => undefined, waitForIdle: async () => true, log: () => {}, npmInstall: () => ({ ok: false, why: 'not reached' }) });
    expect(result).toMatchObject({ ok: false, changed: false });
    expect(existsSync(join(victim, 'keep.txt'))).toBe(true);
  });

  it('knows the installer’s layout from a plain npm install', () => {
    expect(installPlace('/home/alex/.local/share/polyphemus/versions/1.2.3/lib/node_modules/polyphemus/', 'polyphemus')).toEqual({ kind: 'versions', prefix: '/home/alex/.local/share/polyphemus' });
    expect(installPlace('/usr/local/lib/node_modules/polyphemus/', 'polyphemus')).toEqual({ kind: 'npm', prefix: '/usr/local' });
    expect(installPlace('/home/alex/projects/polyphemus/packages/cli/', 'polyphemus')).toBeUndefined();
  });
});
