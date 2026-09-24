import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Polyphemus } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

// Chrome cancels a request in flight whenever the computer's network changes — a Docker container
// starting is enough — so the app retries, and an action retried must not be done twice (2026-09-23).

let polyphemus: Polyphemus;
let daemon: Daemon;
let base: string;

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'polyphemus-retried-'));
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\n${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  mkdirSync(join(home, 'projects'), { recursive: true });
  polyphemus = await Polyphemus.open(home);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;
});
afterEach(async () => {
  await daemon.close();
  polyphemus.close();
});

async function device() {
  const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
  return (body: unknown, key?: string) =>
    fetch(`${base}/api/projects`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', ...(key && { 'idempotency-key': key }) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, text: await r.text() }));
}

describe('an action the app retries', () => {
  it('is done once, and the retry gets the first answer', async () => {
    const send = await device();
    const first = await send({ name: 'Shop' }, 'k1');
    const retry = await send({ name: 'Shop' }, 'k1');
    expect(first.status).toBe(201);
    expect(retry).toEqual(first);
    expect(polyphemus.store.projects().map((p) => p.name)).toEqual(['Shop']);
  });

  it('is done again when it’s a new action, or another device’s', async () => {
    const send = await device();
    await send({ name: 'Shop' }, 'k1');
    // Without a key, or with a new one, it's a new action.
    expect((await send({ name: 'Lab' })).status).toBe(201);
    expect((await send({ name: 'Den' }, 'k2')).status).toBe(201);
    // Another device's key is its own, even the same string.
    const other = await device();
    expect((await other({ name: 'Yard' }, 'k1')).status).toBe(201);
    expect(polyphemus.store.projects().map((p) => p.name).sort()).toEqual(['Den', 'Lab', 'Shop', 'Yard']);
  });
});
