import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Credentials } from '../src/auth/credentials.js';
import { DEFAULT_CONFIG, isOffered, modelFor, parseConfig, resolveModel, setDefaultModel } from '../src/config.js';
import { providerStatus } from '../src/providers/registry.js';
import { QUOTA_RETRY_MS } from '../src/quota.js';
import { SessionStore } from '../src/session/store.js';
import type { Message } from '../src/types.js';

describe('SessionStore', () => {
  it('round-trips sessions and messages', () => {
    const store = new SessionStore(':memory:');
    const session = store.create({ title: 'first', provider: 'anthropic', model: 'claude-opus-5', cwd: '/w' });
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        origin: { provider: 'anthropic', model: 'claude-opus-5' },
        native: [{ type: 'text', text: 'hello' }],
      },
    ];
    for (const m of messages) store.append(session.id, m);

    expect(store.messages(session.id)).toEqual(messages);
    expect(store.resolve(session.id.slice(0, 4))?.id).toBe(session.id);
    expect(store.latest('/w')?.id).toBe(session.id);

    store.setModel(session.id, 'xai', 'grok-4.6');
    store.setTitle(session.id, 'renamed');
    expect(store.list()).toMatchObject([{ id: session.id, title: 'renamed', provider: 'xai', model: 'grok-4.6' }]);
  });

  it('renames without reordering, archives off the lists, and brings a thread back when it’s used', async () => {
    const store = new SessionStore(':memory:');
    const older = store.create({ title: 'older', provider: 'anthropic', model: 'm', cwd: '/w' });
    const newer = store.create({ title: 'newer', provider: 'anthropic', model: 'm', cwd: '/w' });
    store.append(older.id, { role: 'user', content: [{ type: 'text', text: 'first' }] });
    await new Promise((resolve) => setTimeout(resolve, 5)); // so the two aren't the same millisecond
    store.append(newer.id, { role: 'user', content: [{ type: 'text', text: 'second' }] });

    store.setTitle(older.id, 'renamed');
    expect(store.list().map((s) => s.title)).toEqual(['newer', 'renamed']);

    store.setArchived(newer.id, true);
    expect(store.list().map((s) => s.id)).toEqual([older.id]);
    expect(store.list(20, { archived: true })).toMatchObject([{ id: newer.id, archivedAt: expect.any(Number) }]);
    expect(store.archivedCount()).toBe(1);
    // Continuing "the latest session here" doesn't pick up one you put away.
    expect(store.latest('/w')?.id).toBe(older.id);

    store.append(newer.id, { role: 'user', content: [{ type: 'text', text: 'actually, one more thing' }] });
    expect(store.get(newer.id)?.archivedAt).toBeUndefined();
    expect(store.archivedCount()).toBe(0);
  });

  it('counts archived threads and open threads only for the person who can see them', () => {
    const store = new SessionStore(':memory:');
    const owner = store.installOwner();
    const sam = store.addPerson('Sam');
    store.addProject({ slug: 'shop', name: 'Shop', path: '/work/shop', description: '' });
    store.addProject({ slug: 'lab', name: 'Lab', path: '/work/shop/lab', description: '' });
    store.addProject({ slug: 'shopping', name: 'Shopping', path: '/work/shopping', description: '' });
    store.setProjectRole('shop', sam.id, 'viewer');
    const shop = store.create({ provider: 'openai', model: 'gpt', cwd: '/work/shop', startedBy: `person:${owner.id}` });
    const lab = store.create({ provider: 'openai', model: 'gpt', cwd: '/work/shop/lab/notes', startedBy: `person:${owner.id}` });
    const shopping = store.create({ provider: 'openai', model: 'gpt', cwd: '/work/shopping', startedBy: `person:${owner.id}` });
    const own = store.create({ provider: 'openai', model: 'other', cwd: '/tmp/notes', startedBy: `person:${sam.id}` });
    const invited = store.create({ provider: 'openai', model: 'other', cwd: '/tmp/shared', startedBy: `person:${owner.id}` });
    store.addThreadPerson(invited.id, sam.id);
    store.setArchived(shop.id, true);
    store.setArchived(lab.id, true);

    // The owner sees every archived thread. Sam sees Shop's, not the lab inside it, and not Shopping.
    expect(store.archivedCount()).toBe(2);
    expect(store.archivedCount(sam.id)).toBe(1);
    // Open threads: Sam's own, the one they were invited to, and not Lab or Shopping.
    expect(store.threadCounts(sam.id).get('openai:other')).toBe(2);
    expect(store.threadCounts(sam.id).has('openai:gpt')).toBe(false);
    expect(store.threadCounts().get('openai:gpt')).toBe(1); // Shopping is still open; Shop and Lab are archived
    expect([shop.id, lab.id, shopping.id, own.id, invited.id]).toHaveLength(5);
  });

  it('lists an agent’s threads, including ones it joined', () => {
    const store = new SessionStore(':memory:');
    const own = store.create({ provider: 'anthropic', model: 'm', cwd: '/w', agent: 'bd' });
    const joined = store.create({ provider: 'anthropic', model: 'm', cwd: '/w', agent: 'reviewer' });
    store.create({ provider: 'anthropic', model: 'm', cwd: '/w' });
    store.addMember(joined.id, 'bd');
    expect(store.list(20, { agent: 'bd' }).map((s) => s.id).sort()).toEqual([own.id, joined.id].sort());
  });

  it('deletes a thread with everything in it', () => {
    const store = new SessionStore(':memory:');
    const session = store.create({ provider: 'anthropic', model: 'm', cwd: '/w', agent: 'bd' });
    store.append(session.id, { role: 'user', content: [{ type: 'text', text: 'hi' }] });
    store.recordTurn(session.id, { endSeq: 1, provider: 'anthropic', model: 'm', startedAt: 1, endedAt: 2, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    expect(store.delete(session.id)).toBe(true);
    expect(store.get(session.id)).toBeUndefined();
    expect(store.messages(session.id)).toEqual([]);
    expect(store.turns(session.id)).toEqual([]);
    expect(store.members(session.id)).toEqual([]);
    expect(store.delete(session.id)).toBe(false);
  });

  it('searches titles and what was said, not what tools printed', () => {
    const store = new SessionStore(':memory:');
    const byTitle = store.create({ title: 'Flaky login test', provider: 'anthropic', model: 'm', cwd: '/w' });
    const bySaid = store.create({ title: 'Tuesday', provider: 'anthropic', model: 'm', cwd: '/w' });
    const byTool = store.create({ title: 'Other', provider: 'anthropic', model: 'm', cwd: '/w' });
    store.append(bySaid.id, { role: 'assistant', content: [{ type: 'text', text: `${'Lots of context here. '.repeat(10)}The LOGIN page redirects twice, which is why it looks flaky.` }] });
    store.append(byTool.id, { role: 'user', content: [{ type: 'tool_result', callId: 'c1', content: 'login.ts: 40 lines' }] });
    store.setArchived(bySaid.id, true);

    const found = store.search('login');
    expect(found.map((m) => m.meta.id).sort()).toEqual([byTitle.id, bySaid.id].sort());
    const said = found.find((m) => m.meta.id === bySaid.id)!;
    expect(said.snippet).toMatch(/^….*LOGIN page redirects twice/);
    expect(found.find((m) => m.meta.id === byTitle.id)?.snippet).toBeUndefined();
    // LIKE's wildcards are just characters here.
    expect(store.search('%')).toEqual([]);
    expect(store.search('   ')).toEqual([]);
  });

  it('knows whose computer this is, who else uses it, and which devices are whose', () => {
    const store = new SessionStore(':memory:');
    const owner = store.installOwner();
    expect(store.installOwner().id).toBe(owner.id); // made once
    expect(owner.owner).toBe(true);

    // A device paired before people existed, or with a plain code, is the owner's.
    const mine = store.redeemPairingCode(store.createPairingCode(), 'Pixel')!;
    expect(store.personForDevice(mine.device)?.id).toBe(owner.id);

    const sam = store.addPerson('Sam');
    const samsPhone = store.redeemPairingCode(store.createPairingCode(undefined, sam.id), 'iPhone')!;
    expect(store.personForDevice(store.deviceForToken(samsPhone.token)!)?.name).toBe('Sam');
    expect(store.resolvePerson('sam')?.id).toBe(sam.id);

    store.setProjectRole('shop', sam.id, 'member');
    store.setProjectRole('blog', sam.id, 'viewer');
    store.setProjectRole('shop', sam.id, 'viewer'); // changing a role replaces it
    expect(Object.fromEntries(store.projectRoles(sam.id))).toEqual({ shop: 'viewer', blog: 'viewer' });
    expect(store.projectMembers('shop')).toMatchObject([{ person: { name: 'Sam' }, role: 'viewer' }]);

    // Leaving cuts off their devices and roles; the owner can't be removed.
    store.removePerson(sam.id);
    expect(store.deviceForToken(samsPhone.token)).toBeUndefined();
    expect(store.projectRoles(sam.id).size).toBe(0);
    store.removePerson(owner.id);
    expect(store.people().map((p) => p.name)).toEqual([owner.name]);
    expect(owner.name).not.toBe('You'); // others see this name on what the owner did
    store.renamePerson(owner.id, 'Jay');
    expect(store.installOwner().name).toBe('Jay');
  });

  it('remembers each agent CLI session per provider', () => {
    const store = new SessionStore(':memory:');
    const session = store.create({ provider: 'claude-code', model: 'default', cwd: '/w' });
    expect(store.agentState(session.id, 'claude-code')).toBeUndefined();

    store.setAgentState(session.id, 'claude-code', { nativeId: 'abc', seen: 3 });
    store.setAgentState(session.id, 'codex', { nativeId: 'th_1', seen: 5 });
    expect(store.agentState(session.id, 'claude-code')).toEqual({ nativeId: 'abc', seen: 3 });
    expect(store.agentState(session.id, 'codex')).toEqual({ nativeId: 'th_1', seen: 5 });
  });

  it('keeps the latest usage per provider and drops windows that have reset', () => {
    const store = new SessionStore(':memory:');
    const inAnHour = new Date(Date.now() + 3600_000);
    const anHourAgo = Date.now() - 3600_000;
    store.recordCapacity('codex', [{ window: '7d', usedPct: 97, resetsAt: inAnHour }], anHourAgo);
    store.recordCapacity('codex', [{ window: '7d', usedPct: 90 }], anHourAgo - 60_000); // an older reading doesn't overwrite a newer one
    store.recordCapacity('grok-build', [{ window: 'quota', usedPct: 100 }]);
    store.recordCapacity('claude-code', [{ window: '5h', usedPct: 50, resetsAt: new Date(Date.now() - 1000) }]); // already reset
    // A reading older than its own window is certainly from an earlier one, whatever it claimed.
    store.recordCapacity('xai', [{ window: '5h', usedPct: 80, resetsAt: inAnHour }], Date.now() - 6 * 3600_000);

    const capacity = store.capacity();
    expect(capacity.get('codex')).toMatchObject([{ window: '7d', usedPct: 97, resetsAt: inAnHour }]);
    expect(capacity.get('grok-build')).toMatchObject([{ window: 'quota', usedPct: 100 }]);
    expect(capacity.has('claude-code')).toBe(false);
    expect(capacity.has('xai')).toBe(false);

    store.clearCapacity('grok-build', 'quota');
    expect(store.capacity().has('grok-build')).toBe(false);
  });

  it('stops reporting a quota error with no reset time an hour after it, without anyone clearing it', () => {
    const store = new SessionStore(':memory:');
    // What an older polyphemus left behind: out of quota, no reset, three days ago.
    store.recordCapacity('grok-build', [{ window: 'quota', usedPct: 100 }], Date.now() - 3 * 86_400_000);
    store.recordCapacity('xai', [{ window: 'quota', usedPct: 100 }], Date.now() - 10 * 60_000);
    store.recordCapacity('openai', [{ window: 'quota', usedPct: 100, resetsAt: new Date(Date.now() + 86_400_000) }], Date.now() - 2 * 86_400_000);
    const capacity = store.capacity();
    expect(capacity.has('grok-build')).toBe(false);
    expect(capacity.get('xai')).toMatchObject([{ window: 'quota' }]);
    expect(capacity.get('openai')).toMatchObject([{ window: 'quota' }]); // it said when: that stands
    expect(store.capacity(Date.now() + QUOTA_RETRY_MS).has('xai')).toBe(false);
  });

  it('pairs devices with one-time, expiring codes and stores only hashes', () => {
    const store = new SessionStore(':memory:');
    const code = store.createPairingCode();
    const paired = store.redeemPairingCode(code, 'Android phone');
    expect(paired?.device.name).toBe('Android phone');
    expect(store.redeemPairingCode(code, 'again')).toBeUndefined(); // one use
    expect(store.redeemPairingCode(store.createPairingCode(-1), 'late')).toBeUndefined(); // expired

    expect(store.deviceForToken(paired!.token)?.id).toBe(paired!.device.id);
    expect(store.deviceForToken('not-a-token')).toBeUndefined();
    expect(store.revokeDevice(paired!.device.id.slice(0, 4))).toBe(true);
    expect(store.deviceForToken(paired!.token)).toBeUndefined();
    expect(store.listDevices()[0]?.revokedAt).toBeTypeOf('number');
  });

  it('upgrades a database created before agent sessions existed', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'polyphemus-db-')), 'sessions.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL,
      model TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO sessions VALUES ('old1', 'kept', 'anthropic', 'claude-opus-5', '/w', 1, 1);`);
    old.close();

    const store = new SessionStore(file);
    expect(store.get('old1')?.title).toBe('kept');
    store.setAgentState('old1', 'codex', { nativeId: 'th_2', seen: 0 });
    expect(store.agentState('old1', 'codex')).toEqual({ nativeId: 'th_2', seen: 0 });
    store.close();
  });
});

describe('config', () => {
  const config = parseConfig(DEFAULT_CONFIG);

  it('parses the default config', () => {
    expect(config.defaultModel).toBeUndefined(); // no provider is assumed; polyphemus asks on first run
    expect(config.providers.xai).toMatchObject({ adapter: 'openai-responses', baseUrl: 'https://api.x.ai/v1', reasoningSummary: false });
    expect(config.providers.openai?.reasoningSummary).toBe(true);
  });

  it('defaults to subscription agents, with API models under -api aliases', () => {
    expect(resolveModel(config, 'claude')).toEqual({ label: 'claude', provider: 'claude-code', model: 'default' });
    expect(config.providers['claude-code']).toMatchObject({ adapter: 'claude-cli', auth: { type: 'cli' } });
    expect(resolveModel(config, 'grok-api')).toEqual({ label: 'grok-api', provider: 'xai', model: 'grok-4.6' });
    expect(modelFor(config, 'openai', 'gpt-6-astra').label).toBe('gpt-api');
  });

  it('resolves a bare provider name', () => {
    expect(resolveModel(config, 'grok-build')).toEqual({ label: 'grok', provider: 'grok-build', model: 'default' });
    const apiOnly = parseConfig('[providers.anthropic]\nadapter = "anthropic"\nauth = { type = "api_key" }');
    expect(() => resolveModel(apiOnly, 'anthropic')).toThrow('needs a model');
  });

  it('saves the default model into the config file, keeping comments', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'polyphemus-config-')), 'config.toml');
    writeFileSync(file, DEFAULT_CONFIG);

    setDefaultModel(file, 'codex');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('default_model = "codex"');
    expect(text).toContain('# Model for new sessions');
    expect(parseConfig(text).defaultModel).toBe('codex');

    expect(() => setDefaultModel(file, 'nope')).toThrow('Unknown model');
    expect(parseConfig(readFileSync(file, 'utf8')).defaultModel).toBe('codex'); // unchanged after a bad value
  });

  it('resolves provider:model references', () => {
    expect(resolveModel(config, 'anthropic:claude-sonnet-5')).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(() => resolveModel(config, 'nope:model')).toThrow('Unknown provider');
    expect(() => resolveModel(config, 'nope')).toThrow('Unknown model');
  });

  it('says which providers are ready and how to set up the rest', () => {
    const credentials = new Credentials(join(tmpdir(), `polyphemus-no-creds-${process.pid}.json`));
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(providerStatus('anthropic', config.providers.anthropic!, credentials)).toEqual({
        ready: false,
        note: 'needs an API key: set ANTHROPIC_API_KEY or run `poly login anthropic`',
      });
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      expect(providerStatus('anthropic', config.providers.anthropic!, credentials)).toMatchObject({ ready: true });
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
    const cli = config.providers['claude-code']!;
    expect(providerStatus('claude-code', { ...cli, command: 'node' }, credentials)).toMatchObject({ ready: true });
    expect(providerStatus('claude-code', { ...cli, command: 'not-a-real-cli-xyz' }, credentials)).toMatchObject({ ready: false });
  });

  it('reports bad config clearly', () => {
    expect(() => parseConfig('default_model = "x"\n[providers.a]\nadapter = "bogus"')).toThrow('providers.a.adapter');
    expect(() => parseConfig('default_model = "missing"')).toThrow('default_model');
    expect(() => parseConfig('default_model = "x:y"\n[providers.x]\nadapter = "codex-cli"\nauth = { type = "api_key" }')).toThrow(
      'must be "cli"',
    );
  });
});

describe('providers on offer', () => {
  it('offers every shipped provider on a fresh install, and keeps an older install as it was', () => {
    const fresh = parseConfig(DEFAULT_CONFIG);
    expect(fresh.accepted).toEqual([]);
    expect(Object.keys(fresh.providers).every((id) => isOffered(fresh, id))).toBe(true);
    // An install from before offers has no accepted list: everything it declared is still in use.
    const older = parseConfig(DEFAULT_CONFIG.replace('accepted = []', ''));
    expect(Object.keys(older.providers).some((id) => isOffered(older, id))).toBe(false);
    // A provider removed since is dropped from the list rather than failing the whole file.
    expect(parseConfig(DEFAULT_CONFIG.replace('accepted = []', 'accepted = ["codex", "gone"]')).accepted).toEqual(['codex']);
  });
});
