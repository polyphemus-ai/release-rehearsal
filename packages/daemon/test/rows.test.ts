import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, emptyUsage, Polyphemus, ProviderError, type ChatRequest, type ModelProvider, type ProviderEvent } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

// Settled brief §2–3: a thread's row is the same wherever it's listed, and says three things — who,
// one state, and whether it's on a person — with everything else as the second line in words.

class Replies implements ModelProvider {
  readonly kind = 'model' as const;
  constructor(
    readonly id: string,
    private text: string | ProviderError,
  ) {}
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    if (this.text instanceof ProviderError) throw this.text;
    yield { type: 'message_done', message: { role: 'assistant', content: [{ type: 'text', text: this.text }], origin: { provider: this.id, model: req.model } }, stopReason: 'end_turn', usage: emptyUsage() };
  }
  async listModels() {
    return [];
  }
}

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let call: (path: string, body?: unknown) => Promise<{ status: number; data: Record<string, any> }>;
const savedEnv = { ...process.env };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-rows-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\ndefault_model = "gpt-api"\n${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  mkdirSync(join(home, 'agents', 'builder'), { recursive: true });
  writeFileSync(join(home, 'agents', 'builder', 'agent.toml'), 'description = "builds"\ntitle = "Builder"\nmodel = "gpt-api"\n');
  mkdirSync(join(home, 'agents', 'reviewer'), { recursive: true });
  writeFileSync(join(home, 'agents', 'reviewer', 'agent.toml'), 'description = "reviews"\ntitle = "Reviewer"\nmodel = "gpt-api"\n');
  mkdirSync(join(home, 'agents', 'scribe'), { recursive: true });
  writeFileSync(join(home, 'agents', 'scribe', 'agent.toml'), 'description = "writes it down"\ntitle = "Scribe"\nmodel = "gpt-api"\n');
  polyphemus = await Polyphemus.open(home);
  polyphemus.registry.use('openai', new Replies('openai', 'Two findings, both small.'));
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  const base = daemon.urls[0]!;
  const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
  call = async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
});
afterEach(async () => {
  await daemon.close();
  polyphemus.close();
  process.env = { ...savedEnv };
});

const idle = async (id: string) => {
  for (let i = 0; i < 100; i++) {
    if (!(await call(`/api/sessions/${id}`)).data.running) return;
    await new Promise((r) => setTimeout(r, 30));
  }
};

describe('a thread’s row', () => {
  it('reads the same on Home, in its project, with its agent, and in search', async () => {
    const project = (await call('/api/projects', { name: 'Shop' })).data.project;
    const thread = (await call('/api/sessions', { text: 'review the checkout', project: project.slug, agent: 'builder' })).data;
    await idle(thread.id);
    await call(`/api/sessions/${thread.id}/members`, { agent: 'reviewer' });
    await call(`/api/sessions/${thread.id}/messages`, { text: '@reviewer have a look' });
    await idle(thread.id);

    const onHome = (await call('/api/state')).data.sessions.find((s: { id: string }) => s.id === thread.id);
    const inProject = (await call(`/api/sessions?project=${project.slug}`)).data.sessions.find((s: { id: string }) => s.id === thread.id);
    const withAgent = (await call('/api/sessions?agent=builder')).data.sessions.find((s: { id: string }) => s.id === thread.id);
    const { snippet: _snippet, ...inSearch } = (await call('/api/sessions?q=checkout')).data.sessions.find((s: { id: string }) => s.id === thread.id);
    expect(inProject).toEqual(onHome);
    expect(withAgent).toEqual(onHome);
    expect(inSearch).toEqual(onHome);

    // Two agents: a composed mark, and the second line names who spoke last.
    expect(onHome.members.map((m: { id: string }) => m.id)).toEqual(['builder', 'reviewer']);
    expect(onHome.lastLine).toEqual({ actor: 'agent:reviewer', speaker: 'Reviewer', text: 'Two findings, both small.' });
  });

  it('has one state: kept, finished, paused, or started by a routine', async () => {
    const thread = (await call('/api/sessions', { text: 'plan the milestone', model: 'gpt-api' })).data;
    await idle(thread.id);
    const row = async () => (await call('/api/state')).data.sessions.find((s: { id: string }) => s.id === thread.id);
    expect((await row()).state).toBeNull();

    await call(`/api/sessions/${thread.id}/keep`, {});
    expect((await row()).state).toBe('kept');
    await call(`/api/sessions/${thread.id}/finish`, {});
    expect((await row())).toMatchObject({ state: 'finished', finishedAt: expect.any(Number) });
    // Picking it back up un-finishes it.
    await call(`/api/sessions/${thread.id}/messages`, { text: 'one more thing' });
    await idle(thread.id);
    expect((await row()).state).toBe('kept');

    // A model that can't run with nothing to switch to: it stopped on its own, and says why.
    polyphemus.registry.use('openai', new Replies('openai', new ProviderError('usage limit reached', 'quota_exhausted', 'openai')));
    await call(`/api/sessions/${thread.id}/messages`, { text: 'and again' });
    await idle(thread.id);
    expect(await row()).toMatchObject({ state: 'paused', pausedWhy: expect.stringContaining('usage limit') });
  });
});

describe('starting something', () => {
  it('brings a second agent in from the start, and makes nothing when one of them doesn’t exist', async () => {
    const project = (await call('/api/projects', { name: 'Polyphemus' })).data.project;
    const before = polyphemus.store.list(100).length;
    expect((await call('/api/sessions', { text: '@builder hi', agent: 'builder', project: project.slug, with: ['nobody'] })).status).toBe(400);
    expect(polyphemus.store.list(100)).toHaveLength(before);

    const made = (await call('/api/sessions', { text: '@builder the login test is flaky', agent: 'builder', project: project.slug, with: ['reviewer'] })).data;
    await idle(made.id);
    expect((await call(`/api/sessions/${made.id}`)).data.members.map((m: { id: string }) => m.id)).toEqual(['builder', 'reviewer']);
  });

  it('starts a thread with no project in a folder of its own, not wherever the daemon runs', async () => {
    const made = (await call('/api/sessions', { text: 'just us', agent: 'builder' })).data;
    const meta = polyphemus.store.get(made.id)!;
    expect(meta.cwd).toBe(join(home, 'projects', '.polyphemus-direct'));
    expect(polyphemus.store.projectFor(meta.cwd)).toBeUndefined();
    expect((await call(`/api/sessions/${made.id}`)).data.project).toBeNull();
  });

  it('brings in as many agents as were picked, not just two', async () => {
    const project = (await call('/api/projects', { name: 'Polyphemus' })).data.project;
    const made = (await call('/api/sessions', { text: '@builder plan it', agent: 'builder', project: project.slug, with: ['reviewer', 'scribe'] })).data;
    await idle(made.id);
    expect((await call(`/api/sessions/${made.id}`)).data.members.map((m: { id: string }) => m.id)).toEqual(['builder', 'reviewer', 'scribe']);
  });
});
