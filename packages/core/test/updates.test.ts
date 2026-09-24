import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, knownUpdate, newestOn } from '../src/updates.js';

// Update checks: an installed polyphemus asks npm at most once a day, sends nothing about the install,
// can be turned off, and never asks when it's a checkout of the repository.

const saved = process.env.POLYPHEMUS_NPM_REGISTRY;
afterEach(() => {
  if (saved === undefined) delete process.env.POLYPHEMUS_NPM_REGISTRY;
  else process.env.POLYPHEMUS_NPM_REGISTRY = saved;
});

async function fakeNpm(tags: Record<string, string>) {
  const asked: Array<{ url: string; headers: Record<string, unknown> }> = [];
  const server = createServer((req, res) => {
    asked.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(tags));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.POLYPHEMUS_NPM_REGISTRY = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { asked, close: () => new Promise((r) => server.close(r)) };
}

describe('update checks', () => {
  it('compares versions the way npm does, prereleases before their release', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('asks npm once a day, remembers the answer, and says when there is a newer one', async () => {
    const home = await mkdtemp(join(tmpdir(), 'polyphemus-updates-'));
    const npm = await fakeNpm({ latest: '0.3.0' });
    try {
      const now = Date.parse('2026-09-13T12:00:00Z');
      const first = await checkForUpdate(home, { enabled: true, now, current: '0.2.0', installedFrom: 'npm' });
      expect(first).toMatchObject({ current: '0.2.0', latest: '0.3.0', newer: true, checkedAt: now });
      expect(npm.asked).toHaveLength(1);
      expect(npm.asked[0]!.url).toBe('/-/package/polyphemus/dist-tags');
      // Nothing about the install goes with it: no cookie, no identifying headers of polyphemus's own.
      expect(Object.keys(npm.asked[0]!.headers).filter((h) => /cookie|authorization|x-polyphemus/i.test(h))).toEqual([]);
      // Within the day: the remembered answer, no second request.
      await checkForUpdate(home, { enabled: true, now: now + 60_000, current: '0.2.0', installedFrom: 'npm' });
      expect(npm.asked).toHaveLength(1);
      expect(knownUpdate(home, { current: '0.2.0', installedFrom: 'npm' })).toMatchObject({ latest: '0.3.0', newer: true });
      // A day later it asks again.
      await checkForUpdate(home, { enabled: true, now: now + 25 * 60 * 60_000, current: '0.2.0', installedFrom: 'npm' });
      expect(npm.asked).toHaveLength(2);
      expect(knownUpdate(home, { current: '0.3.0', installedFrom: 'npm' }).newer).toBe(false);
    } finally {
      await npm.close();
    }
  });

  it('follows a channel: stable takes latest, beta takes next unless a stable release is newer', async () => {
    expect(newestOn('stable', { latest: '0.4.0', next: '0.5.0-beta.2' })).toBe('0.4.0');
    expect(newestOn('beta', { latest: '0.4.0', next: '0.5.0-beta.2' })).toBe('0.5.0-beta.2');
    // The beta became a release: a beta install takes the release rather than stay behind.
    expect(newestOn('beta', { latest: '0.5.0', next: '0.5.0-beta.2' })).toBe('0.5.0');
    expect(newestOn('beta', { latest: '0.4.0' })).toBe('0.4.0');
    expect(newestOn('stable', { next: '0.5.0-beta.1' })).toBeUndefined();

    const home = await mkdtemp(join(tmpdir(), 'polyphemus-updates-'));
    const npm = await fakeNpm({ latest: '0.4.0', next: '0.5.0-beta.2' });
    try {
      const now = Date.parse('2026-09-13T12:00:00Z');
      expect(await checkForUpdate(home, { enabled: true, now, current: '0.4.0', installedFrom: 'npm' })).toMatchObject({ channel: 'stable', latest: '0.4.0', newer: false });
      // Switching channels doesn't reuse the other channel's answer: it asks again, the same day.
      expect(knownUpdate(home, { current: '0.4.0', installedFrom: 'npm', channel: 'beta' }).latest).toBeNull();
      expect(await checkForUpdate(home, { enabled: true, now: now + 60_000, current: '0.4.0', installedFrom: 'npm', channel: 'beta' })).toMatchObject({ channel: 'beta', latest: '0.5.0-beta.2', newer: true });
      expect(npm.asked).toHaveLength(2);
    } finally {
      await npm.close();
    }
  });

  it('never asks when checking is off, or when it runs from a checkout', async () => {
    const home = await mkdtemp(join(tmpdir(), 'polyphemus-updates-'));
    const npm = await fakeNpm({ latest: '9.9.9' });
    try {
      expect(await checkForUpdate(home, { enabled: false, current: '0.2.0', installedFrom: 'npm' })).toMatchObject({ latest: null, why: expect.stringContaining('updates.check = false') });
      expect(await checkForUpdate(home, { enabled: true, current: '0.2.0', installedFrom: 'checkout' })).toMatchObject({ latest: null, why: expect.stringContaining('checkout') });
      expect(npm.asked).toEqual([]);
    } finally {
      await npm.close();
    }
  });
});
