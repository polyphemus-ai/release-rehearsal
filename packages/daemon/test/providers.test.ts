import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgent, DEFAULT_CONFIG, emptyUsage, Polyphemus, libraryAgentsDir, type ChatRequest, type ModelProvider, type ProviderEvent } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

// Getting a model was terminal-only until now: `poly models add` and `poly login` had no
// endpoint behind them, so the app could show you what you had and never change it.

class FakeOpenAI implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'openai';
  constructor(private readonly onList: () => string[]) {}
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    if (req.model === 'gpt-6-astra') throw new Error('403 model_not_available: this model isn’t on your plan');
    yield { type: 'message_done', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, stopReason: 'end_turn', usage: emptyUsage() };
  }
  async listModels() {
    return this.onList().map((id) => ({ id }));
  }
}

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let base: string;
let cookie: string;
let listModels: () => string[];
const savedEnv = { ...process.env };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-providers-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  delete process.env.OPENAI_API_KEY;
  mkdirSync(join(home, 'projects'), { recursive: true });
  // No default_model: a fresh install, which is the case that matters most here.
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\n${DEFAULT_CONFIG}`);
  polyphemus = await Polyphemus.open(home);
  listModels = () => ['gpt-5', 'gpt-5-mini'];
  polyphemus.registry.use('openai', new FakeOpenAI(() => listModels()));
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

const call = async (path: string, body?: unknown, method?: string) => {
  const res = await fetch(`${base}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { cookie, 'Content-Type': 'application/json', Origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, any> };
};

describe('providers and models from the app', () => {
  it('is a list of companies, each with its ways in', async () => {
    const { data } = await call('/api/providers');
    // A provider is who makes the models. claude-code isn't one of those; it's a way in to Anthropic.
    expect(data.providers.map((v: any) => v.id)).toEqual(['anthropic', 'openai', 'xai']);

    const openai = data.providers.find((v: any) => v.id === 'openai');
    expect(openai.name).toBe('OpenAI');
    expect(openai.connections.map((c: any) => c.label).sort()).toEqual(['API key', 'Codex CLI']);
    const codex = openai.connections.find((c: any) => c.id === 'codex');
    expect(codex).toMatchObject({ how: 'your ChatGPT plan', signIn: 'cli', command: 'codex login' });
    expect(openai.connections.find((c: any) => c.id === 'openai')).toMatchObject({ how: 'billed per token', signIn: 'key', hasKey: false });

    expect(JSON.stringify(data)).not.toContain('sk-');
  });

  it('says Codex doesn’t ask, where every other model asks first', async () => {
    await call('/api/selected', { selected: ['codex:gpt-5', 'openai:gpt-5'] });
    const models = (await call('/api/state')).data.models;
    expect(models.find((m: any) => m.label === 'codex:gpt-5').asks).toBe(false);
    expect(models.find((m: any) => m.label === 'openai:gpt-5').asks).toBe(true);
  });

  it('offers the providers it ships with, and uses one only once you say so', async () => {
    // 2026-09-18: a fresh install declares six providers but uses none of them until accepted.
    process.env.OPENAI_API_KEY = 'sk-from-env';
    const before = (await call('/api/providers')).data.providers.flatMap((v: any) => v.connections);
    expect(before.every((c: any) => c.offered && !c.ready)).toBe(true);
    // A key in the environment isn't a yes: nothing runs on it yet.
    expect(before.find((c: any) => c.id === 'openai').note).toContain('offered');

    const accepted = await call('/api/providers/openai/accept', {});
    expect(accepted.status).toBe(200);
    const openai = accepted.data.providers.find((v: any) => v.id === 'openai').connections.find((c: any) => c.id === 'openai');
    expect(openai).toMatchObject({ offered: false, ready: true });
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toMatch(/^accepted = \["openai"\]$/m);

    // Choosing a model on one is saying yes to it too; the others stay offers.
    await call('/api/selected', { selected: ['anthropic:claude-test'] });
    const after = (await call('/api/providers')).data.providers.flatMap((v: any) => v.connections);
    expect(after.filter((c: any) => !c.offered).map((c: any) => c.id).sort()).toEqual(['anthropic', 'openai']);
    expect((await call('/api/providers/nope/accept', {})).status).toBe(404);
  });

  it('calls a provider ready when any way in works, and leads with that one', async () => {
    await call('/api/providers/openai/key', { key: 'sk-good' });
    const { data } = await call('/api/providers');
    const openai = data.providers.find((v: any) => v.id === 'openai');
    expect(openai.ready).toBe(true);
    // A way in that works leads, whichever it is. (Which CLIs are on PATH isn't ours to assume:
    // asserting "openai first" passes or fails depending on whether `codex` is installed.)
    expect(openai.connections[0].ready).toBe(true);
    expect(openai.connections.map((c: any) => c.ready)).toEqual([...openai.connections.map((c: any) => c.ready)].sort((a, b) => Number(b) - Number(a)));
  });

  it('saves a key that works, and refuses to keep one that is rejected', async () => {
    const { status, data } = await call('/api/providers/openai/key', { key: 'sk-good' });
    expect(status).toBe(200);
    // Models come back as objects now: whatever the provider says about each one is kept.
    expect(data.models).toEqual([{ id: 'gpt-5' }, { id: 'gpt-5-mini' }]);
    const signedIn = data.providers.find((v: any) => v.id === 'openai').connections.find((c: any) => c.id === 'openai');
    expect(signedIn).toMatchObject({ hasKey: true, ready: true });

    // A rejected key would make the provider look ready, which is worse than having none.
    listModels = () => {
      throw new Error('401 invalid_api_key');
    };
    const bad = await call('/api/providers/openai/key', { key: 'sk-bad' });
    expect(bad.status).toBe(400);
    expect(String(bad.data.error)).toContain("wasn't saved");
    const after = await call('/api/providers');
    expect(after.data.providers.find((v: any) => v.id === 'openai').connections.find((c: any) => c.id === 'openai').hasKey).toBe(false);
  });

  it('names a model, makes the first one the default, and takes it back', async () => {
    expect((await call('/api/state')).data.defaultModel).toBe(null);

    const added = await call('/api/models', { label: 'gpt', provider: 'openai', model: 'gpt-5' });
    expect(added.status).toBe(201);
    // Nobody should end up with a roster and nothing to run it on.
    expect(added.data.defaultModel).toBe('gpt');
    expect((await call('/api/state')).data.models.some((m: any) => m.label === 'gpt')).toBe(true);

    // The default can't be removed out from under everything that inherits it.
    const refused = await call('/api/models/gpt', undefined, 'DELETE');
    expect(refused.status).toBe(400);
    expect(String(refused.data.error)).toContain('default');

    await call('/api/models', { label: 'mini', provider: 'openai', model: 'gpt-5-mini' });
    await call('/api/models/mini', { default: true });
    expect((await call('/api/state')).data.defaultModel).toBe('mini');
    expect((await call('/api/models/gpt', undefined, 'DELETE')).status).toBe(200);
  });

  it('keeps what a provider says about a model, and invents nothing', async () => {
    listModels = () => ['gpt-5'];
    const { data } = await call('/api/providers/openai/models');
    // A provider that only gives ids gives only ids — no context window from a table somewhere.
    expect(data.models).toEqual([{ id: 'gpt-5' }]);
  });

  it('reports being signed out as an answer, not a crash', async () => {
    listModels = () => {
      throw new Error('no API key');
    };
    const { status, data } = await call('/api/providers/openai/models');
    expect(status).toBe(200);
    expect(data.models).toEqual([]);
    expect(data.problem).toContain('no API key');
  });

  it('refuses a key for a provider that signs in through its own CLI', async () => {
    const { status, data } = await call('/api/providers/claude-code/key', { key: 'sk-nope' });
    expect(status).toBe(400);
    expect(String(data.error)).toContain('own CLI');
  });

  it('points a named model at a different one', async () => {
    await call('/api/models', { label: 'gpt', provider: 'openai', model: 'gpt-5' });
    const changed = await call('/api/models/gpt', { model: 'gpt-5-mini' });
    expect(changed.status).toBe(200);
    const listed = (await call('/api/state')).data.models.find((m: any) => m.label === 'gpt');
    expect(listed).toMatchObject({ target: 'openai:gpt-5-mini', modelId: 'gpt-5-mini', provider: 'OpenAI', how: 'API key' });
  });

  it('says whichever it picks only when the model really is default', async () => {
    // A vendor CLI takes a model id; "default" means letting it choose, which is one option.
    await call('/api/models', { label: 'cc', provider: 'claude-code', model: 'default' });
    const asDefault = (await call('/api/state')).data.models.find((m: any) => m.label === 'cc');
    expect(asDefault).toMatchObject({ provider: 'Anthropic', how: 'Claude Code CLI', modelId: null });

    await call('/api/models/cc', { model: 'claude-opus-5' });
    const pinned = (await call('/api/state')).data.models.find((m: any) => m.label === 'cc');
    expect(pinned.modelId).toBe('claude-opus-5');
  });

  it('keeps as many models per provider as you pick', async () => {
    // Alex: "for each provider, I should be able to select multiple models... not just one".
    const one = await call('/api/selected', { selected: ['openai:gpt-5'] });
    expect(one.data.selected).toEqual(['openai:gpt-5']);
    // The first one chosen becomes the default, and choosing more doesn't disturb that.
    expect(one.data.defaultModel).toBe('openai:gpt-5');

    const more = await call('/api/selected', { selected: ['openai:gpt-5', 'openai:gpt-5-mini', 'anthropic:claude-opus-5'] });
    expect(more.data.selected).toEqual(['openai:gpt-5', 'openai:gpt-5-mini', 'anthropic:claude-opus-5']);
    expect(more.data.defaultModel).toBe('openai:gpt-5');

    const state = (await call('/api/state')).data;
    expect(state.selected).toHaveLength(3);
    expect(state.models.filter((m: any) => m.chosen && m.connection === 'openai')).toHaveLength(2);

    // And unticking one leaves the rest alone.
    const fewer = await call('/api/selected', { selected: ['openai:gpt-5', 'anthropic:claude-opus-5'] });
    expect(fewer.data.selected).toEqual(['openai:gpt-5', 'anthropic:claude-opus-5']);
  });

  it('adds a provider from the catalogue by writing its config block', async () => {
    const { data: before } = await call('/api/catalogue');
    expect(before.catalogue.find((e: any) => e.id === 'anthropic').configured).toBe(true);
    expect(before.catalogue.find((e: any) => e.id === 'groq').configured).toBe(false);
    // What's left of OpenClaw's directory is a named list, not an offer.
    expect(before.more.length).toBeGreaterThan(10);
    expect(before.catalogue.length).toBeGreaterThan(45);

    const added = await call('/api/providers', { id: 'groq' });
    expect(added.status).toBe(201);
    const groq = added.data.providers.find((v: any) => v.id === 'groq');
    // Named from the catalogue, not left as the raw connection id.
    expect(groq.name).toBe('Groq');
    expect(groq.connections[0]).toMatchObject({ signIn: 'key', hasKey: false });
    // It went into config.toml, so the terminal sees it too — and under the key the parser
    // actually reads, which is base_url rather than baseUrl.
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toContain('base_url = "https://api.groq.com/openai/v1"');
    expect(groq.connections[0].id).toBe('groq');

    expect((await call('/api/providers', { id: 'groq' })).status).toBe(409);
  });

  it('asks for a server URL when it has no reliable one, and checks it', async () => {
    // LiteLLM is your own gateway, so there's no base URL to suggest: a wrong one that looks
    // official is worse than an empty box.
    const missing = await call('/api/providers', { id: 'litellm' });
    expect(missing.status).toBe(400);
    expect(String(missing.data.error)).toContain('server URL');

    expect((await call('/api/providers', { id: 'litellm', baseUrl: 'not-a-url' })).status).toBe(400);
    expect((await call('/api/providers', { id: 'litellm', baseUrl: 'https://llm.example.com/v1' })).status).toBe(201);
  });

  it('refuses to set up something it does not know', async () => {
    const { status, data } = await call('/api/providers', { id: 'madeup' });
    expect(status).toBe(400);
    expect(String(data.error)).toContain("doesn't know how to set up");
  });

  it('removes a provider once nothing is named on it', async () => {
    await call('/api/providers', { id: 'groq' });
    await call('/api/models', { label: 'fast', provider: 'groq', model: 'llama-3.3-70b' });
    const blocked = await call('/api/providers/groq', undefined, 'DELETE');
    expect(blocked.status).toBe(400);
    expect(String(blocked.data.error)).toContain('fast');

    await call('/api/models', { label: 'other', provider: 'openai', model: 'gpt-5' });
    await call('/api/models/other', { default: true });
    await call('/api/models/fast', undefined, 'DELETE');
    const gone = await call('/api/providers/groq', undefined, 'DELETE');
    expect(gone.status).toBe(200);
    expect(gone.data.providers.some((v: any) => v.id === 'groq')).toBe(false);
    // Only the live setting goes. config.toml also ships a commented-out groq example, so the
    // check has to ignore comments rather than match the string anywhere in the file.
    const live = readFileSync(join(home, 'config.toml'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(live).not.toContain('api.groq.com');
  });

  it('tests a model for real when asked, says what it cost, and remembers how it went', async () => {
    await call('/api/selected', { selected: ['openai:gpt-5', 'openai:gpt-6-astra'] });
    const before = (await call('/api/state')).data.models.find((m: any) => m.label === 'openai:gpt-5');
    expect(before).toMatchObject({ result: null, metered: true, testCost: expect.stringContaining('billed per token') });

    const ok = await call('/api/models/test', { ref: 'openai:gpt-5' });
    expect(ok.data.test).toMatchObject({ ok: true, said: 'hi' });
    const bad = await call('/api/models/test', { ref: 'openai:gpt-6-astra' });
    expect(bad.data.test).toMatchObject({ ok: false, said: expect.stringContaining('model_not_available') });

    const models = (await call('/api/state')).data.models;
    expect(models.find((m: any) => m.label === 'openai:gpt-5').result).toMatchObject({ lastOkAt: expect.any(Number) });
    expect(models.find((m: any) => m.label === 'openai:gpt-6-astra').result).toMatchObject({ lastErrorAt: expect.any(Number), lastError: expect.stringContaining('403') });

    // A connection test picks a model you chose on it.
    const connection = await call('/api/providers/openai/test', {});
    expect(connection.data).toMatchObject({ model: 'gpt-5', test: { ok: true } });
  });

  it('moves a model to another way in everywhere it’s named, agents included, and undoes in one step', async () => {
    await call('/api/selected', { selected: ['codex:gpt-5', 'openai:gpt-5-mini'] });
    await call('/api/routing', { defaultModel: 'codex:gpt-5', fallback: ['openai:gpt-5-mini', 'codex:gpt-5'] });
    createAgent(libraryAgentsDir(home), 'reviewer', { description: 'reviews', model: 'codex:gpt-5' });

    const state = (await call('/api/state')).data;
    expect(state.models.find((m: any) => m.label === 'codex:gpt-5').usedBy).toEqual({ agents: ['Reviewer'], threads: 0, backup: 2 });
    expect(state.agentModels).toEqual([]);

    // An agent made on a model that isn't on your list still runs on it; it's listed apart, not as missing.
    createAgent(libraryAgentsDir(home), 'coach', { description: 'coaches', model: 'codex:gpt-6-astra' });
    const withCoach = (await call('/api/state')).data;
    expect(withCoach.models.some((m: any) => m.label === 'codex:gpt-6-astra')).toBe(false);
    expect(withCoach.agentModels).toEqual([expect.objectContaining({ label: 'codex:gpt-6-astra', agentOnly: true, modelId: 'gpt-6-astra', usedBy: expect.objectContaining({ agents: ['Coach'] }) })]);
    rmSync(join(libraryAgentsDir(home), 'coach'), { recursive: true });

    const moved = await call('/api/models/move', { ref: 'codex:gpt-5', connection: 'openai' });
    expect(moved.data).toEqual({ to: 'openai:gpt-5', changed: ['your models', 'the default', 'the backup list', 'Reviewer'] });
    const after = (await call('/api/state')).data;
    expect(after.selected).toEqual(['openai:gpt-5', 'openai:gpt-5-mini']);
    expect(after.defaultModel).toBe('openai:gpt-5');
    expect(after.routing.fallback).toEqual(['openai:gpt-5-mini', 'openai:gpt-5']);
    expect(readFileSync(join(libraryAgentsDir(home), 'reviewer', 'agent.toml'), 'utf8')).toContain('model = "openai:gpt-5"');
    expect(polyphemus.store.configRevisions(1)[0]?.action).toBe('moved codex:gpt-5 to openai:gpt-5');
  });

  it('removes a model from the backups too, refuses the default, and lets a fallback onto a bill be allowed', async () => {
    await call('/api/selected', { selected: ['codex:gpt-5', 'openai:gpt-5-mini'] });
    await call('/api/routing', { defaultModel: 'codex:gpt-5', fallback: ['openai:gpt-5-mini'] });

    const refused = await call('/api/models/remove', { ref: 'codex:gpt-5' });
    expect(refused.status).toBe(409);
    expect(String(refused.data.error)).toContain('default');

    expect((await call('/api/models/remove', { ref: 'openai:gpt-5-mini' })).status).toBe(200);
    const state = (await call('/api/state')).data;
    expect(state.selected).toEqual(['codex:gpt-5']);
    expect(state.routing).toMatchObject({ fallback: [], allowMetered: false });

    expect((await call('/api/routing', { allowMetered: true })).data.allowMetered).toBe(true);
    expect(polyphemus.config.routing.allowMetered).toBe(true);
  });

  it('lets the owner say how long a quota error keeps a provider out', async () => {
    expect((await call('/api/state')).data.routing.quotaRetryMinutes).toBe(60);
    expect((await call('/api/routing', { quotaRetryMinutes: 2 })).status).toBe(400);
    expect((await call('/api/routing', { quotaRetryMinutes: 15 })).data.quotaRetryMinutes).toBe(15);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toMatch(/quota_retry_minutes = 15/);
    // It takes effect straight away: a quota error 20 minutes ago no longer keeps it out.
    const { outReading } = await import('@polyphemus/core');
    expect(outReading([{ window: 'quota', usedPct: 100, observedAt: new Date(Date.now() - 20 * 60_000) }])).toBeUndefined();
    await call('/api/routing', { quotaRetryMinutes: 60 });
    expect(outReading([{ window: 'quota', usedPct: 100, observedAt: new Date(Date.now() - 20 * 60_000) }])).toMatchObject({ window: 'quota' });
  });

  it('lets the owner choose where agents run, and a project only stricter', async () => {
    const state = (await call('/api/state')).data;
    // A fresh install is Isolated until someone chooses otherwise.
    expect(state.isolation).toMatchObject({ level: 'isolated', levels: [{ id: 'isolated' }, { id: 'isolated-open' }, { id: 'host' }] });
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).not.toMatch(/^level = /m);
    expect((await call('/api/isolation', { level: 'nowhere' })).status).toBe(400);
    expect((await call('/api/isolation', { level: 'isolated-open' })).data.isolation.level).toBe('isolated-open');
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toMatch(/level = "isolated-open"/);
    expect(polyphemus.config.isolation.level).toBe('isolated-open');

    const project = (await call('/api/projects', { name: 'Shop' })).data.project;
    expect((await call(`/api/projects/${project.slug}/isolation`, { level: 'host' })).status).toBe(400);
    expect((await call(`/api/projects/${project.slug}/isolation`, { level: 'isolated' })).data).toEqual({ own: 'isolated', applies: 'isolated' });
    expect((await call('/api/state')).data.projects.find((p: { slug: string }) => p.slug === project.slug).isolation).toEqual({ own: 'isolated', applies: 'isolated' });
    // The install loosening doesn't loosen a project that asked for more.
    await call('/api/isolation', { level: 'host' });
    expect((await call('/api/state')).data.projects.find((p: { slug: string }) => p.slug === project.slug).isolation).toEqual({ own: 'isolated', applies: 'isolated' });
    expect((await call(`/api/projects/${project.slug}/isolation`, { level: null })).data).toEqual({ own: null, applies: 'host' });
  });

  it('lets the owner grant a project’s agents hosts on the network, checked as they’re typed', async () => {
    const project = (await call('/api/projects', { name: 'Grants' })).data.project;
    const network = async () => (await call('/api/state')).data.projects.find((p: { slug: string }) => p.slug === project.slug).network;
    expect(await network()).toEqual({ presets: [], hosts: [], refused: [] });
    expect((await call('/api/state')).data.isolation.presets.map((p: { id: string }) => p.id)).toEqual(['packages', 'github']);
    expect((await call(`/api/projects/${project.slug}/network`, { presets: ['everything'], hosts: [] })).status).toBe(400);
    const privateHost = await call(`/api/projects/${project.slug}/network`, { presets: [], hosts: ['192.168.1.20'] });
    expect(privateHost.status).toBe(400);
    expect(privateHost.data.error).toContain('by name');
    const saved = await call(`/api/projects/${project.slug}/network`, { presets: ['packages'], hosts: ['https://API.example.com/v1', 'api.example.com'] });
    expect(saved.data).toEqual({ presets: ['packages'], hosts: ['api.example.com'] });
    // Refused lately: offered to grant, newest first, and not once it's granted.
    polyphemus.refusedHosts.set(project.slug, new Map([['cdn.example.net', 1], ['api.example.com', 2], ['files.example.org', 3]]));
    expect(await network()).toEqual({ presets: ['packages'], hosts: ['api.example.com'], refused: [{ host: 'files.example.org', at: 3 }, { host: 'cdn.example.net', at: 1 }] });
    await call(`/api/projects/${project.slug}/network`, { presets: [], hosts: [] });
    expect(polyphemus.store.project(project.slug)?.network).toBeUndefined();
  });

  it('keeps an install that was in use before Isolated was the default running agents where it did', async () => {
    polyphemus.store.create({ title: 'An old thread', provider: 'openai', model: 'gpt-5', cwd: home });
    const reopened = await Polyphemus.open(home);
    try {
      expect(reopened.config.isolation).toEqual({ level: 'host', chosen: true });
      expect(reopened.keptOnThisComputer).toBe(true);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toMatch(/level = "host"/);
    } finally {
      reopened.close();
    }
    // Once written, it's a choice like any other: opening again leaves it alone.
    const again = await Polyphemus.open(home);
    expect(again.keptOnThisComputer).toBe(false);
    again.close();
  });

  it('keeps a new install Isolated once it has threads', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'polyphemus-fresh-'));
    try {
      const first = await Polyphemus.open(fresh);
      first.store.create({ title: 'Its first thread', provider: 'openai', model: 'gpt-5', cwd: fresh });
      first.close();
      const second = await Polyphemus.open(fresh);
      expect(second.config.isolation).toEqual({ level: 'isolated', chosen: true });
      expect(second.keptOnThisComputer).toBe(false);
      second.close();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('says before a thread starts when a model can’t run where agents are isolated', async () => {
    await call('/api/selected', { selected: ['codex:gpt-5', 'openai:gpt-5-mini'] });
    const models = async () => (await call('/api/state')).data.models as Array<{ label: string; notIsolated: string | null }>;
    expect((await models()).every((m) => m.notIsolated === null)).toBe(true);
    polyphemus.isolationBroken.set('codex-cli', 'it ran a command outside the worker.');
    try {
      const listed = await models();
      expect(listed.find((m) => m.label === 'codex:gpt-5')?.notIsolated).toBe('Codex isn’t offered where agents are isolated: it ran a command outside the worker.');
      // An API model runs polyphemus's own tools, which are always in the worker.
      expect(listed.find((m) => m.label === 'openai:gpt-5-mini')?.notIsolated).toBeNull();
    } finally {
      polyphemus.isolationBroken.delete('codex-cli');
    }
  });

  it('turns Codex’s sandbox off only when the owner asks, for Codex only, and back on by removing the setting', async () => {
    const codex = () => polyphemus.config.providers.codex!;
    expect(codex().sandbox).toBeUndefined();
    const vendors = (await call('/api/providers')).data.providers as Array<{ connections: Array<{ id: string; sandboxOff: boolean | null }> }>;
    const card = (id: string, list = vendors) => list.flatMap((v) => v.connections).find((c) => c.id === id);
    expect(card('codex')?.sandboxOff).toBe(false);
    expect(card('claude-code')?.sandboxOff).toBeNull();

    expect((await call('/api/providers/claude-code/sandbox', { on: false })).status).toBe(400);
    const off = await call('/api/providers/codex/sandbox', { on: false });
    expect(off.data.sandbox).toBe(false);
    expect(card('codex', off.data.providers)?.sandboxOff).toBe(true);
    expect(codex().sandbox).toBe(false);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toMatch(/sandbox = false/);

    await call('/api/providers/codex/sandbox', { on: true });
    expect(codex().sandbox).toBeUndefined();
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).not.toMatch(/sandbox = /);
  });
});
