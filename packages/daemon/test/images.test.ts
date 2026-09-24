import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, emptyUsage, Polyphemus, type ChatRequest, type ModelProvider, type ProviderEvent } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

const PNG = readFileSync(fileURLToPath(new URL('../web/icon-192.png', import.meta.url)));

/** Answers every request, and keeps what it was sent. */
class RecordingProvider implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'openai';
  readonly requests: ChatRequest[] = [];
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    yield { type: 'message_done', message: { role: 'assistant', content: [{ type: 'text', text: 'A blue h.' }], origin: { provider: this.id, model: req.model } }, stopReason: 'end_turn', usage: emptyUsage() };
  }
  async listModels() {
    return [];
  }
}

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let base: string;
let cookie: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-images-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\n${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  polyphemus = await Polyphemus.open(home);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;
  const res = await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' });
  cookie = res.headers.get('set-cookie')!.split(';')[0]!;
});
afterEach(async () => {
  await daemon.close();
  polyphemus.close();
  process.env = { ...savedEnv };
});

const upload = (bytes: Uint8Array, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/images`, { method: 'POST', headers: { cookie, 'content-type': 'image/png', 'x-file-name': 'logo.png', ...headers }, body: bytes });
const call = async (path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, any> };
};

describe('images in conversations', () => {
  it('uploads, serves back, and refuses anything that isn’t an image', async () => {
    const res = await upload(PNG);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f]{32}\.png$/);

    const served = await fetch(`${base}/api/images/${id}`, { headers: { cookie } });
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);

    expect((await upload(Buffer.from('#!/bin/sh\necho hi'))).status).toBe(400);
    expect((await fetch(`${base}/api/images/%2E%2E%2Fsessions.db`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/images/${id}`)).status).toBe(401); // unpaired
    expect((await upload(PNG, { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('sends a picture-only message to the model and keeps it in the conversation', async () => {
    const provider = new RecordingProvider();
    polyphemus.registry.use('openai', provider);
    const { id: image } = (await (await upload(PNG)).json()) as { id: string };

    const { status, data } = await call('/api/sessions', { text: '', images: [{ id: image, name: 'logo.png' }], model: 'openai:gpt-5' });
    expect(status).toBe(201);
    expect(data.meta.title).toBe('Image');
    const detail = await (async () => {
      for (let i = 0; i < 100; i++) {
        const { data: d } = await call(`/api/sessions/${data.id}`);
        if (!d.running && d.messages.length === 2) return d;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error('timed out');
    })();
    expect(detail.messages[0].content).toContainEqual(expect.objectContaining({ type: 'image', mediaType: 'image/png', name: 'logo.png' }));
    expect(provider.requests[0]!.messages[0]!.content).toContainEqual(expect.objectContaining({ type: 'image', mediaType: 'image/png' }));

    expect((await call(`/api/sessions/${data.id}/messages`, { text: 'and this?', images: ['nope.png'] })).status).toBe(400);
    expect((await call(`/api/sessions/${data.id}/messages`, { text: '', images: [] })).status).toBe(400);
  });

  it('puts any other file in the thread’s folder, where the agent opens it, and says where', async () => {
    const provider = new RecordingProvider();
    polyphemus.registry.use('openai', provider);
    const csv = Buffer.from('date,amount\n2026-09-01,42.00\n');
    const sendFile = async (bytes: Uint8Array, name: string) =>
      (await (await fetch(`${base}/api/files`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) }, body: bytes })).json()) as { id: string; name: string };
    const statement = await sendFile(csv, '../../June statement.csv');
    expect(statement.name).toBe('June statement.csv'); // no path in a name

    const { status, data } = await call('/api/sessions', { text: '', files: [statement], model: 'openai:gpt-5' });
    expect(status).toBe(201);
    expect(data.meta.title).toBe('June statement.csv');
    const placed = join(data.meta.cwd, 'attachments', 'June statement.csv');
    expect(readFileSync(placed, 'utf8')).toBe(csv.toString());
    for (let i = 0; i < 100 && !provider.requests.length; i++) await new Promise((resolve) => setTimeout(resolve, 30));
    expect(JSON.stringify(provider.requests[0]!.messages[0]!.content)).toContain('attachments/June statement.csv');

    // A different file by the same name doesn't replace it; the same one sent again isn't copied twice.
    const other = await sendFile(Buffer.from('date,amount\n2026-10-01,7.00\n'), 'June statement.csv');
    await until(() => call(`/api/sessions/${data.id}`).then((r) => !r.data.running));
    expect((await call(`/api/sessions/${data.id}/messages`, { text: 'and these', files: [other, statement] })).status).toBe(202);
    expect(existsSync(join(data.meta.cwd, 'attachments', 'June statement (2).csv'))).toBe(true);
    expect(existsSync(join(data.meta.cwd, 'attachments', 'June statement (3).csv'))).toBe(false);

    // Only your own uploads: knowing a file's id isn't having sent it.
    await until(() => call(`/api/sessions/${data.id}`).then((r) => !r.data.running));
    expect((await call(`/api/sessions/${data.id}/messages`, { text: 'x', files: [{ id: 'f'.repeat(32), name: 'x.csv' }] })).status).toBe(404);
    expect((await call(`/api/sessions/${data.id}/messages`, { text: 'x', files: [{ id: '../../etc', name: 'x' }] })).status).toBe(400);
  });
});

describe('emoji and reactions', () => {
  it('serves every emoji, and keeps one reaction of each per person per message', async () => {
    const res = await fetch(`${base}/api/emoji`, { headers: { cookie } });
    const emoji = (await res.json()) as Array<[string, string, number, string]>;
    expect(emoji.length).toBeGreaterThan(1500);
    expect(emoji.find((e) => e[0].replace(/\uFE0F/g, '') === '👍')?.[1]).toBe('thumbs up');
    expect(emoji.some((e) => e[2] === 2)).toBe(false); // no bare skin tones

    polyphemus.registry.use('openai', new RecordingProvider());
    const { data } = await call('/api/sessions', { text: 'hello', model: 'openai:gpt-5' });
    await until(() => call(`/api/sessions/${data.id}`).then((r) => !r.data.running && r.data.messages.length === 2));
    const on = await call(`/api/sessions/${data.id}/react`, { seq: 1, emoji: '👍' });
    expect(on.data).toMatchObject({ on: true, reactions: [expect.objectContaining({ seq: 1, emoji: '👍\uFE0F' })] });
    expect((await call(`/api/sessions/${data.id}`)).data.reactions).toHaveLength(1);
    // The same again takes it back.
    // The same again takes it back — typed with the invisible emoji mark or without, it's one reaction.
    expect((await call(`/api/sessions/${data.id}/react`, { seq: 1, emoji: '👍\uFE0F' })).data).toMatchObject({ on: false, reactions: [] });
    expect((await call(`/api/sessions/${data.id}/react`, { seq: 1, emoji: 'lol' })).status).toBe(400);
    expect((await call(`/api/sessions/${data.id}/react`, { seq: 99, emoji: '👍' })).status).toBe(400);
  });
});

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('timed out');
}
