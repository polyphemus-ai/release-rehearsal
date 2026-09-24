import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  it('knows the installer’s layout from a plain npm install', () => {
    expect(installPlace('/home/alex/.local/share/polyphemus/versions/1.2.3/lib/node_modules/polyphemus/', 'polyphemus')).toEqual({ kind: 'versions', prefix: '/home/alex/.local/share/polyphemus' });
    expect(installPlace('/usr/local/lib/node_modules/polyphemus/', 'polyphemus')).toEqual({ kind: 'npm', prefix: '/usr/local' });
    expect(installPlace('/home/alex/projects/polyphemus/packages/cli/', 'polyphemus')).toBeUndefined();
  });
});
