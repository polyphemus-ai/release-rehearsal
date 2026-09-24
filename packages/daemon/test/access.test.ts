import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, emptyUsage, Polyphemus, type Block, type ChatRequest, type ModelProvider, type Person, type ProviderEvent, type StopReason } from '@polyphemus/core';
import type { PushPayload, PushSender } from '../src/push.js';
import { startDaemon, type Daemon } from '../src/server.js';

// Settled brief journey 3: someone who belongs to one project sees nothing of another — not on Home,
// not in search, not in a notification — checked at the API, not in the interface.

const PNG = readFileSync(fileURLToPath(new URL('../web/icon-192.png', import.meta.url)));

class ScriptedProvider implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'openai';
  readonly requests: ChatRequest[] = [];
  constructor(private steps: Array<{ content: Block[]; stopReason: StopReason }>) {}
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    const step = this.steps.shift() ?? { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' as StopReason };
    yield { type: 'message_done', message: { role: 'assistant', content: step.content, origin: { provider: 'openai', model: req.model } }, stopReason: step.stopReason, usage: emptyUsage() };
  }
  async listModels() {
    return [];
  }
}

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let base: string;
const sent: Array<{ endpoint: string; payload: PushPayload }> = [];
const savedEnv = { ...process.env };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-access-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\ndefault_model = "gpt-api"\n${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  polyphemus = await Polyphemus.open(home);
  sent.length = 0;
  const push: PushSender = { publicKey: 'k', send: async (subscription, payload) => (sent.push({ endpoint: subscription.endpoint, payload }), 'ok') };
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home, push, revocationCheckMs: 50 });
  base = daemon.urls[0]!;
});
afterEach(async () => {
  await daemon.close();
  polyphemus.close();
  process.env = { ...savedEnv };
});

type Call = (path: string, body?: unknown) => Promise<{ status: number; data: Record<string, any> }>;

async function signIn(person?: Person): Promise<{ call: Call; cookie: string }> {
  const code = polyphemus.store.createPairingCode(undefined, person?.id);
  const cookie = (await fetch(`${base}/pair?code=${code}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
  const call: Call = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  return { call, cookie };
}

async function until<T>(check: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('timed out');
}

/** Collects what an event stream receives. */
async function listen(cookie: string): Promise<{ frames: string[]; stop(): void }> {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: controller.signal });
  const frames: string[] = [];
  const reader = res.body!.getReader();
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        frames.push(new TextDecoder().decode(value));
      }
    } catch {
      // stopped
    }
  })();
  return { frames, stop: () => controller.abort() };
}

describe('who sees what', () => {
  it('lets the owner invite someone and set their role from the app, and nobody else', async () => {
    const owner = await signIn();
    const project = (await owner.call('/api/projects', { name: 'Shop' })).data.project;
    const made = await owner.call('/api/people', { name: 'Sam' });
    expect(made.status).toBe(201);
    expect(made.data.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect((await owner.call('/api/people', { name: 'sam' })).status).toBe(409);
    const sam = made.data.person;

    // The code pairs their device, and until they're given a role they see nothing.
    const paired = await fetch(`${base}/pair?code=${made.data.code}`, { redirect: 'manual' });
    const samCookie = paired.headers.get('set-cookie')!.split(';')[0]!;
    const samDevice: Call = async (path, body) => {
      const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: samCookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    expect((await samDevice('/api/state')).data.me).toMatchObject({ name: 'Sam', owner: false });
    expect((await samDevice('/api/state')).data.projects).toEqual([]);

    expect((await owner.call(`/api/projects/${project.slug}/people`, { person: sam.id, role: 'viewer' })).data.people).toEqual([{ id: sam.id, name: 'Sam', role: 'viewer' }]);
    expect((await samDevice('/api/state')).data.projects.map((p: { slug: string }) => p.slug)).toEqual([project.slug]);
    // A viewer can't invite anyone, or change their own role.
    expect((await samDevice('/api/people', { name: 'Someone' })).status).toBe(403);
    expect((await samDevice(`/api/projects/${project.slug}/people`, { person: sam.id, role: 'member' })).status).toBe(403);

    expect((await owner.call(`/api/projects/${project.slug}/people`, { person: sam.id, role: null })).data.people).toEqual([]);
    expect((await samDevice('/api/state')).data.projects).toEqual([]);
    expect((await owner.call(`/api/people/${sam.id}/remove`, {})).data).toEqual({ removed: sam.id });
    expect((await samDevice('/api/state')).status).toBe(401);
  });


  it('keeps this computer’s folders out of what someone who doesn’t work here is told', async () => {
    // The access matrix says who may call a route; it never looked at what comes back. Everyone
    // paired was given the folder projects are kept in, and anyone who could see a project got its
    // path on disk and its threads' (app review, 2026-09-20).
    const owner = await signIn();
    const project = (await owner.call('/api/projects', { name: 'Shop' })).data.project;
    const { id } = (await owner.call('/api/sessions', { text: 'have a look', project: project.slug })).data;
    const made = await owner.call('/api/people', { name: 'Sam' });
    const paired = await fetch(`${base}/pair?code=${made.data.code}`, { redirect: 'manual' });
    const samCookie = paired.headers.get('set-cookie')!.split(';')[0]!;
    const sam: Call = async (path, body) => {
      const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: samCookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    const host = project.path.replace(/\/[^/]+$/, ''); // where this install keeps its projects

    // With no role at all: nothing about this computer.
    const nobody = await sam('/api/state');
    expect(nobody.data.projectsRoot).toBeNull();
    expect(JSON.stringify(nobody.data)).not.toContain(host);

    // A viewer sees the project and its threads, and still not where they are.
    await owner.call(`/api/projects/${project.slug}/people`, { person: made.data.person.id, role: 'viewer' });
    const asViewer = await sam('/api/state');
    expect(asViewer.data.projects.map((p: { slug: string }) => p.slug)).toEqual([project.slug]);
    expect(asViewer.data.projects[0].path).toBeUndefined();
    expect(JSON.stringify(asViewer.data)).not.toContain(host);
    const thread = await sam(`/api/sessions/${id}`);
    expect(thread.status).toBe(200);
    expect(thread.data.meta.cwd).toBe('');

    // A member works here, so they're told where that is.
    await owner.call(`/api/projects/${project.slug}/people`, { person: made.data.person.id, role: 'member' });
    expect((await sam('/api/state')).data.projects[0].path).toBe(project.path);
    expect((await sam(`/api/sessions/${id}`)).data.meta.cwd).toBe(project.path);
    // And the owner, who makes them, is still told where they go.
    expect((await owner.call('/api/state')).data.projectsRoot).toBe(host);
  });

  it('shows a viewer where the project stands, and tells nobody else', async () => {
    // The handoff is what every session starts from and what agents rewrite when they finish. It
    // was written for models and never shown to a person (2026-09-20).
    const owner = await signIn();
    const project = (await owner.call('/api/projects', { name: 'Shop' })).data.project;
    const made = await owner.call('/api/people', { name: 'Sam' });
    const paired = await fetch(`${base}/pair?code=${made.data.code}`, { redirect: 'manual' });
    const samCookie = paired.headers.get('set-cookie')!.split(';')[0]!;
    const sam = async (path: string) => {
      const res = await fetch(`${base}${path}`, { headers: { cookie: samCookie } });
      return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
    };

    expect((await sam(`/api/projects/${project.slug}/handoff`)).status).toBe(404);
    await owner.call(`/api/projects/${project.slug}/people`, { person: made.data.person.id, role: 'viewer' });
    const seen = await sam(`/api/projects/${project.slug}/handoff`);
    expect(seen.status).toBe(200);
    expect(seen.data.text).toContain('Where things stand');
  });

  it('does not name agents or count threads a person cannot see, and counts only their archived threads', async () => {
    const owner = await signIn();
    const shop = (await owner.call('/api/projects', { name: 'Shop' })).data.project;
    const lab = (await owner.call('/api/projects', { name: 'Lab' })).data.project;
    mkdirSync(join(home, 'agents', 'helper'), { recursive: true });
    writeFileSync(join(home, 'agents', 'helper', 'agent.toml'), 'description = "helps"\ntitle = "Helper"\nmodel = "gpt-api"\n');
    mkdirSync(join(lab.path, '.polyphemus', 'agents', 'secret'), { recursive: true });
    writeFileSync(join(lab.path, '.polyphemus', 'agents', 'secret', 'agent.toml'), 'description = "the lab’s own"\ntitle = "Secret"\nmodel = "gpt-api"\n');
    const sam = polyphemus.store.addPerson('Sam');
    polyphemus.store.setProjectRole(shop.slug, sam.id, 'viewer');
    const samDevice = await signIn(sam);
    polyphemus.registry.use('openai', new ScriptedProvider([{ content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }]));
    const shopThread = (await owner.call('/api/sessions', { text: 'stock count', project: shop.slug })).data;
    const labThread = (await owner.call('/api/sessions', { text: 'the formula', project: lab.slug })).data;
    await until(async () => ((await owner.call(`/api/sessions/${labThread.id}`)).data.running ? undefined : true));
    expect((await owner.call(`/api/sessions/${labThread.id}/archive`, {})).status).toBe(200);
    await until(async () => ((await owner.call(`/api/sessions/${shopThread.id}`)).data.running ? undefined : true));
    const openLab = (await owner.call('/api/sessions', { text: 'still going', project: lab.slug })).data;
    await until(async () => ((await owner.call(`/api/sessions/${openLab.id}`)).data.running ? undefined : true));

    const row = (data: { models?: Array<{ label: string; usedBy: { agents: string[]; threads: number } }> }) => data.models!.find((m) => m.label === 'gpt-api')!;
    const samState = (await samDevice.call('/api/state')).data;
    const ownerState = (await owner.call('/api/state')).data;
    expect(row(samState).usedBy.agents).toContain('Helper');
    expect(row(samState).usedBy.agents).not.toContain('Secret');
    expect(row(ownerState).usedBy.agents).toEqual(expect.arrayContaining(['Helper', 'Secret']));
    expect(row(samState).usedBy.threads).toBe(1);
    expect(row(ownerState).usedBy.threads).toBe(2);
    expect(samState.archivedCount).toBe(0);
    expect(ownerState.archivedCount).toBe(1);
  });

  it('signs out a device whose person is gone instead of treating them as the owner', async () => {
    const owner = await signIn();
    const sam = polyphemus.store.addPerson('Sam');
    const samDevice = await signIn(sam);
    expect((await samDevice.call('/api/state')).data.me).toMatchObject({ name: 'Sam', owner: false });
    const db = new DatabaseSync(join(home, 'sessions.db'));
    db.prepare('UPDATE people SET removed_at = ? WHERE id = ?').run(Date.now(), sam.id);
    db.close();
    const gone = await samDevice.call('/api/state');
    expect(gone.status).toBe(401);
    expect((await owner.call('/api/state')).data.me.owner).toBe(true);
  });

  it('keeps a project’s own agent out of every other project’s threads', async () => {
    // A member of one project could bring another project's private agent into their thread by its
    // id, and it answered there with its own persona, skills and grants (independent review, 2026-09-19).
    const owner = await signIn();
    const shop = (await owner.call('/api/projects', { name: 'Shop' })).data.project;
    const lab = (await owner.call('/api/projects', { name: 'Lab' })).data.project;
    const dir = join(lab.path, '.polyphemus', 'agents', 'secret');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.toml'), 'description = "the lab’s own"\ntitle = "Secret"\n');
    const sam = polyphemus.store.addPerson('Sam');
    await owner.call(`/api/projects/${shop.slug}/people`, { person: sam.id, role: 'member' });
    const samDevice = await signIn(sam);
    polyphemus.registry.use('openai', new ScriptedProvider([]));
    const thread = (await samDevice.call('/api/sessions', { text: 'stock count', project: shop.slug })).data;

    const detail = (await samDevice.call(`/api/sessions/${thread.id}`)).data;
    expect(detail.roster.map((a: { id: string }) => a.id)).not.toContain(`${lab.slug}/secret`);
    expect((await samDevice.call(`/api/sessions/${thread.id}/members`, { agent: `${lab.slug}/secret` })).status).toBe(400);
    // Not the owner either: it belongs to its project, whoever asks.
    expect((await owner.call(`/api/sessions/${thread.id}/members`, { agent: `${lab.slug}/secret` })).status).toBe(400);
    // Stored anyway (an older version, or by hand), it still isn't in the thread.
    polyphemus.store.addMember(thread.id, `${lab.slug}/secret`, Date.now(), 'owner');
    expect((await samDevice.call(`/api/sessions/${thread.id}`)).data.members.map((a: { id: string }) => a.id)).not.toContain(`${lab.slug}/secret`);
  });

  it('shows an image only to its uploader and whoever can see a thread that carries it', async () => {
    // Knowing an image's name got it: attached to your own message, or typed into one you can see
    // (independent review, 2026-09-19).
    const owner = await signIn();
    const shop = (await owner.call('/api/projects', { name: 'Shop' })).data.project;
    const lab = (await owner.call('/api/projects', { name: 'Lab' })).data.project;
    const sam = polyphemus.store.addPerson('Sam');
    const val = polyphemus.store.addPerson('Val');
    polyphemus.store.setProjectRole(shop.slug, sam.id, 'member');
    polyphemus.store.setProjectRole(lab.slug, val.id, 'member');
    const samDevice = await signIn(sam);
    const valDevice = await signIn(val);
    polyphemus.registry.use('openai', new ScriptedProvider([]));
    const up = await fetch(`${base}/api/images`, { method: 'POST', headers: { cookie: samDevice.cookie, 'content-type': 'application/octet-stream', origin: base }, body: PNG });
    const { id } = (await up.json()) as { id: string };
    const image = (cookie: string) => fetch(`${base}/api/images/${id}`, { headers: { cookie } }).then((r) => r.status);
    expect(await image(valDevice.cookie)).toBe(404);
    // Val can't attach it, or make it hers by writing its name in her own thread.
    expect((await valDevice.call('/api/sessions', { text: 'look', project: lab.slug, images: [id] })).status).toBe(400);
    const hers = (await valDevice.call('/api/sessions', { text: `see uploads/${id}`, project: lab.slug })).data;
    expect(hers.id).toBeTruthy();
    expect(await image(valDevice.cookie)).toBe(404);
    // Nor by getting a model to name its path in a tool call in her own thread (re-review, 2026-09-19).
    polyphemus.store.append(hers.id, { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'read', input: { path: `/tmp/${id}` } }] });
    expect(await image(valDevice.cookie)).toBe(404);
    // Sent in a Shop thread, it's there for Shop's people, and still not for Val.
    const kim = polyphemus.store.addPerson('Kim');
    polyphemus.store.setProjectRole(shop.slug, kim.id, 'viewer');
    const kimDevice = await signIn(kim);
    expect(await image(kimDevice.cookie)).toBe(404);
    expect((await samDevice.call('/api/sessions', { text: 'the shelf', project: shop.slug, images: [id] })).status).toBe(201);
    expect(await image(kimDevice.cookie)).toBe(200);
    expect(await image(valDevice.cookie)).toBe(404);
  });

  it('keeps bringing an agent into a conversation outside every project the owner’s', async () => {
    // A viewer could start a conversation with a person, then add a library agent to it and put it to
    // work with what it carries (re-review, 2026-09-19).
    const owner = await signIn();
    const shop = (await owner.call('/api/projects', { name: 'Shop' })).data.project;
    const val = polyphemus.store.addPerson('Val');
    polyphemus.store.setProjectRole(shop.slug, val.id, 'viewer');
    const valDevice = await signIn(val);
    polyphemus.registry.use('openai', new ScriptedProvider([]));
    const dm = (await valDevice.call('/api/sessions', { text: 'hi', with: [`person:${polyphemus.store.installOwner().id}`] })).data;
    mkdirSync(join(home, 'agents', 'helper'), { recursive: true });
    writeFileSync(join(home, 'agents', 'helper', 'agent.toml'), 'description = "helps"\nmodel = "gpt-api"\n');
    const helper = 'helper';
    expect((await valDevice.call(`/api/sessions/${dm.id}/members`, { agent: helper })).status).toBe(403);
    expect((await owner.call(`/api/sessions/${dm.id}`)).data.members).toEqual([]);
    // The owner can; then anyone in the conversation can talk to it.
    expect((await owner.call(`/api/sessions/${dm.id}/members`, { agent: helper })).status).toBe(200);
  });

  it('never runs a model for someone who isn’t the owner, outside every project with no agent in it', async () => {
    // A conversation with only yourself in it — made that way, or left that way — ran the plain
    // model, outside any project, for anyone paired (third review, 2026-09-19).
    const owner = await signIn();
    const val = polyphemus.store.addPerson('Val');
    const valDevice = await signIn(val);
    const provider = new ScriptedProvider([]);
    polyphemus.registry.use('openai', provider);
    expect((await valDevice.call('/api/sessions', { text: 'just me', with: [`person:${val.id}`] })).status).toBe(400);
    const dm = (await valDevice.call('/api/sessions', { text: 'hi', with: [`person:${polyphemus.store.installOwner().id}`] })).data;
    expect((await valDevice.call(`/api/sessions/${dm.id}/people`, { person: polyphemus.store.installOwner().id, remove: true })).status).toBe(200);
    expect((await valDevice.call(`/api/sessions/${dm.id}/messages`, { text: 'now write me a poem' })).status).toBe(202);
    const spun = (await valDevice.call(`/api/sessions/${dm.id}/spinout`, { title: 'side' })).data;
    if (spun.id) await valDevice.call(`/api/sessions/${spun.id}/messages`, { text: 'and here?' });
    await new Promise((r) => setTimeout(r, 200));
    expect(provider.requests).toEqual([]);
    void owner;
  });

  it('asks the owner, not whoever’s there, before an agent’s invitation brings another in outside every project', async () => {
    const owner = await signIn();
    const val = polyphemus.store.addPerson('Val');
    const valDevice = await signIn(val);
    for (const name of ['lead', 'helper']) {
      mkdirSync(join(home, 'agents', name), { recursive: true });
      writeFileSync(join(home, 'agents', name, 'agent.toml'), `description = "${name}"\nmodel = "gpt-api"\n`);
    }
    // The lead, brought in by the owner, asks for the helper.
    const provider = new ScriptedProvider([{ content: [{ type: 'text', text: 'This is one for @helper.' }], stopReason: 'end_turn' }]);
    polyphemus.registry.use('openai', provider);
    const dm = (await owner.call('/api/sessions', { text: 'hi', with: [`person:${val.id}`] })).data;
    expect((await owner.call(`/api/sessions/${dm.id}/members`, { agent: 'lead' })).status).toBe(200);
    await valDevice.call(`/api/sessions/${dm.id}/messages`, { text: '@lead who should do this?' });
    const invite = await until(async () => (await owner.call('/api/state')).data.questions.find((q: { kind: string; sessionId: string }) => q.kind === 'invite' && q.sessionId === dm.id));
    expect((await valDevice.call(`/api/questions/${invite.id}`, { answer: 'bring' })).status).toBe(403);
    expect((await owner.call(`/api/sessions/${dm.id}`)).data.members.map((m: { id: string }) => m.id)).toEqual(['lead']);
    expect((await owner.call(`/api/questions/${invite.id}`, { answer: 'bring' })).status).toBe(200);
  });

  it('lets two people have a conversation of their own, outside every project', async () => {
    const owner = await signIn();
    const sam = polyphemus.store.addPerson('Sam');
    const samDevice = await signIn(sam);
    polyphemus.registry.use('openai', new ScriptedProvider([{ content: [{ type: 'text', text: 'hello both' }], stopReason: 'end_turn' }]));
    const mine = (await owner.call('/api/sessions', { text: 'just me' })).data;
    const ours = (await owner.call('/api/sessions', { text: 'hi Sam', with: [`person:${sam.id}`] })).data;
    await until(async () => ((await owner.call(`/api/sessions/${ours.id}`)).data.running ? undefined : true));

    // Sam sees the one he's in, and nothing else of the owner's.
    expect((await samDevice.call('/api/state')).data.sessions.map((s: { id: string }) => s.id)).toEqual([ours.id]);
    expect((await samDevice.call(`/api/sessions/${mine.id}`)).status).toBe(404);
    expect((await samDevice.call(`/api/sessions/${ours.id}`)).data.people.map((p: { name: string }) => p.name).sort()).toEqual(['Alex', 'Sam']);
    expect((await samDevice.call(`/api/sessions/${ours.id}/messages`, { text: 'hi back' })).status).toBe(202);
    await until(async () => ((await owner.call(`/api/sessions/${ours.id}`)).data.running ? undefined : true));
    // Between people, a message is delivered, not answered: no model says anything.
    expect((await owner.call(`/api/sessions/${ours.id}`)).data.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'user']);

    // Sam can start one with the owner too — but not a thread with an agent outside every project.
    const his = await samDevice.call('/api/sessions', { text: 'Hey brutha!', with: [`person:${polyphemus.store.installOwner().id}`] });
    expect(his.status).toBe(201);
    expect((await owner.call(`/api/sessions/${his.data.id}`)).data.messages.map((m: { role: string }) => m.role)).toEqual(['user']);
    expect((await samDevice.call('/api/sessions', { text: 'hi' })).status).toBe(403);
    expect((await samDevice.call(`/api/sessions/${his.data.id}/messages`, { text: '@helm help' })).status).toBe(202);
    expect((await owner.call(`/api/sessions/${his.data.id}`)).data.members).toEqual([]);

    // Taken out again, it's gone from his list; whoever started it stays in it.
    expect((await samDevice.call(`/api/sessions/${ours.id}/people`, { person: sam.id, remove: true })).status).toBe(200);
    expect((await samDevice.call('/api/state')).data.sessions.map((s: { id: string }) => s.id)).not.toContain(ours.id);
    expect((await samDevice.call(`/api/sessions/${ours.id}`)).status).toBe(404);
    // A project's threads belong to the project's people: nobody is brought into one by hand.
    const project = (await owner.call('/api/projects', { name: 'Shop' })).data.project;
    const inProject = (await owner.call('/api/sessions', { text: 'stock', project: project.slug })).data;
    expect((await owner.call(`/api/sessions/${inProject.id}/people`, { person: sam.id })).status).toBe(400);
    expect((await owner.call('/api/sessions', { text: 'nope', project: project.slug, with: [`person:${sam.id}`] })).status).toBe(400);
  });


  it('alone with an agent, the owner is still told apart by name, and the agent’s @mention reaches them', async () => {
    const owner = await signIn();
    await owner.call('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/alex', keys: { p256dh: 'p', auth: 'a' } } });
    mkdirSync(join(home, 'agents', 'robin'), { recursive: true });
    writeFileSync(join(home, 'agents', 'robin', 'agent.toml'), 'description = "writes things"\ntitle = "Robin"\nmodel = "gpt-api"\n');
    const provider = new ScriptedProvider([{ content: [{ type: 'text', text: 'The outline is ready. @Alex, which of the two headlines?' }], stopReason: 'end_turn' }]);
    polyphemus.registry.use('openai', provider);

    const thread = (await owner.call('/api/sessions', { text: 'draft the outline', agent: 'robin' })).data;
    await until(async () => sent.find((s) => s.endpoint.endsWith('/alex') && s.payload.body?.startsWith('Robin: The outline is ready')));
    // One person, and the agent is still told who they are and to @mention them when it needs them.
    const told = JSON.stringify(provider.requests.at(-1)?.messages);
    expect(told).toContain('The person in this thread is @Alex.');
    expect(told).toContain('hands finished work back to them, @mention them');
    await until(async () => ((await owner.call(`/api/sessions/${thread.id}`)).data.running ? undefined : true));
  });

  it('tells people in a conversation about each other’s messages, and an agent brought in reaches them by @mention', async () => {
    const owner = await signIn();
    const sam = polyphemus.store.addPerson('Sam');
    const samDevice = await signIn(sam);
    await samDevice.call('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/sam', keys: { p256dh: 'p', auth: 'a' } } });
    mkdirSync(join(home, 'agents', 'morgan'), { recursive: true });
    writeFileSync(join(home, 'agents', 'morgan', 'agent.toml'), 'description = "a buddy"\ntitle = "Morgan"\nmodel = "gpt-api"\n');
    const provider = new ScriptedProvider([{ content: [{ type: 'text', text: 'Hey @Sam, Morgan here!' }], stopReason: 'end_turn' }]);
    polyphemus.registry.use('openai', provider);

    const ours = (await owner.call('/api/sessions', { text: 'hey Sam', with: [`person:${sam.id}`] })).data;
    // Sam hears about it: the message, from whom.
    await until(async () => sent.find((s) => s.endpoint.endsWith('/sam') && s.payload.body === 'hey Sam'));
    expect(sent.find((s) => s.endpoint.endsWith('/sam'))!.payload.title).toBe('Alex');

    // The owner brings Morgan in; Morgan is told who's here, and his @Sam reaches Sam.
    expect((await owner.call(`/api/sessions/${ours.id}/messages`, { text: '@morgan say hi to Sam' })).data.answering).toBe('morgan');
    await until(async () => sent.find((s) => s.endpoint.endsWith('/sam') && s.payload.body?.startsWith('Morgan: Hey @Sam')));
    expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain('People in this thread: @Alex, @Sam');
    expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain('hands finished work back to them, @mention them');
    await until(async () => ((await owner.call(`/api/sessions/${ours.id}`)).data.running ? undefined : true));

    // Brought in by the owner, Morgan answers Sam too — though Sam couldn't have brought him in.
    expect((await samDevice.call(`/api/sessions/${ours.id}/messages`, { text: '@morgan what’s up?' })).data.answering).toBe('morgan');
    await until(async () => ((await owner.call(`/api/sessions/${ours.id}`)).data.running ? undefined : true));
    expect(provider.requests.length).toBe(2);
    // And the two of them talking past Morgan still hear from each other.
    const before = sent.filter((s) => s.endpoint.endsWith('/sam')).length;
    expect((await owner.call(`/api/sessions/${ours.id}/messages`, { text: 'lunch?' })).data.answering).toBeNull();
    await until(async () => (sent.filter((s) => s.endpoint.endsWith('/sam')).length > before ? true : undefined));
    expect(provider.requests.length).toBe(2);
  });

  it('keeps an agent out of what people say to each other: a person @mentioned, or a project with people in it', async () => {
    const owner = await signIn();
    mkdirSync(join(home, 'agents', 'artist'), { recursive: true });
    writeFileSync(join(home, 'agents', 'artist', 'agent.toml'), 'description = "design"\ntitle = "Artist"\nmodel = "gpt-api"\n');
    const provider = new ScriptedProvider([]);
    polyphemus.registry.use('openai', provider);
    const project = (await owner.call('/api/projects', { name: 'Site' })).data.project;
    const thread = (await owner.call('/api/sessions', { text: 'look at the header', project: project.slug, agent: 'artist' })).data;
    await until(async () => ((await owner.call(`/api/sessions/${thread.id}`)).data.running ? undefined : true));
    expect(provider.requests.length).toBe(1);

    // Just the owner and one agent: a chat, so a message naming nobody is answered…
    expect((await owner.call(`/api/sessions/${thread.id}/messages`, { text: 'and the footer?' })).data.answering).toBe('artist');
    await until(async () => ((await owner.call(`/api/sessions/${thread.id}`)).data.running ? undefined : true));
    // …but one @mentioning a person is for that person, even before they're in the project.
    const sam = polyphemus.store.addPerson('Sam');
    expect((await owner.call(`/api/sessions/${thread.id}/messages`, { text: '@Sam can you help?' })).data.answering).toBeNull();

    // Sam given the project reads along: now agents answer only when named, as the message box says.
    polyphemus.store.setProjectRole(project.slug, sam.id, 'member');
    expect((await owner.call(`/api/sessions/${thread.id}/messages`, { text: 'is everyone going to respond?' })).data.answering).toBeNull();
    expect((await owner.call(`/api/sessions/${thread.id}/messages`, { text: '@artist you, though' })).data.answering).toBe('artist');
    await until(async () => ((await owner.call(`/api/sessions/${thread.id}`)).data.running ? undefined : true));
    expect(provider.requests.length).toBe(3);
  });

  it('keeps a project agent’s skill in the library when that’s where the owner says', async () => {
    // Broken by the second pass: the library was written from the project's folder, and refused (third review, 2026-09-19).
    const owner = await signIn();
    const shop = (await owner.call('/api/projects', { name: 'Shop' })).data.project;
    const dir = join(shop.path, '.polyphemus', 'agents', 'critic');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.toml'), 'description = "critiques"\ntitle = "Critic"\nmodel = "gpt-api"\n');
    const draft = { name: 'shelf-check', description: 'checking a shelf', body: '# Shelf check\n\n1. Count.', why: 'Useful everywhere.', where: 'library' };
    polyphemus.registry.use('openai', new ScriptedProvider([{ content: [{ type: 'tool_call' as const, id: 'k1', name: 'propose_skill', input: draft }], stopReason: 'tool_use' as StopReason }, { content: [{ type: 'text', text: 'Proposed.' }], stopReason: 'end_turn' }]));
    await owner.call('/api/sessions', { text: 'remember this', project: shop.slug, agent: `${shop.slug}/critic` });
    const question = await until(async () => (await owner.call('/api/state')).data.questions.find((q: { kind: string }) => q.kind === 'skill'));
    expect((await owner.call(`/api/questions/${question.id}`, { answer: 'library' })).status).toBe(200);
    expect(existsSync(join(home, 'skills', 'shelf-check', 'SKILL.md'))).toBe(true);
  });

  it('keeps a skill an agent drafts only when a person says so, and where they say', async () => {
    const owner = await signIn();
    mkdirSync(join(home, 'agents', 'coach'), { recursive: true });
    writeFileSync(join(home, 'agents', 'coach', 'agent.toml'), 'description = "money coaching"\ntitle = "Coach"\nmodel = "gpt-api"\n');
    const draft = { name: 'debt-snowball', description: 'ordering debts to pay off, smallest balance first', body: '# Debt snowball\n\n1. List every debt but the house.\n2. Smallest balance first.', why: 'We worked this out for Alex today.', where: 'agent' };
    const propose = { content: [{ type: 'tool_call' as const, id: 'k1', name: 'propose_skill', input: draft }], stopReason: 'tool_use' as StopReason };
    const revised = { content: [{ type: 'tool_call' as const, id: 'k2', name: 'propose_skill', input: { ...draft, body: `${draft.body}\n3. Celebrate each one paid off.` } }], stopReason: 'tool_use' as StopReason };
    polyphemus.registry.use('openai', new ScriptedProvider([propose, { content: [{ type: 'text', text: 'Proposed it.' }], stopReason: 'end_turn' }, revised, { content: [{ type: 'text', text: 'Again.' }], stopReason: 'end_turn' }]));

    const thread = (await owner.call('/api/sessions', { text: 'remember how we did that', agent: 'coach' })).data;
    const question = await until(async () => (await owner.call('/api/state')).data.questions.find((q: { kind: string }) => q.kind === 'skill'));
    expect(question).toMatchObject({ agentTitle: 'Coach', name: 'debt-snowball', where: 'agent', places: ['agent', 'library'] });
    // Nothing is written until it's kept.
    const file = join(home, 'agents', 'coach', 'skills', 'debt-snowball', 'SKILL.md');
    expect(existsSync(file)).toBe(false);
    expect((await owner.call(`/api/questions/${question.id}`, { answer: 'agent' })).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toContain('description: "ordering debts to pay off, smallest balance first"');
    expect(readFileSync(file, 'utf8')).toContain('2. Smallest balance first.');

    // A revision under the same name isn't written over the one there unless the person says replace.
    await until(async () => ((await owner.call(`/api/sessions/${thread.id}`)).data.running ? undefined : true));
    await owner.call(`/api/sessions/${thread.id}/messages`, { text: 'and again' });
    const again = await until(async () => (await owner.call('/api/state')).data.questions.find((q: { kind: string; id: string }) => q.kind === 'skill' && q.id !== question.id));
    expect((await owner.call(`/api/questions/${again.id}`, { answer: 'agent' })).status).toBe(409);
    expect(readFileSync(file, 'utf8')).not.toContain('Celebrate');
    expect((await owner.call(`/api/questions/${again.id}`, { answer: 'agent', replace: true })).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toContain('3. Celebrate each one paid off.');
    // The one it replaced is kept aside, not deleted.
    expect(readdirSync(join(home, 'trash', 'skills')).some((d) => d.startsWith('debt-snowball-'))).toBe(true);
  });

  it('shows a member of one project nothing of another, at the API', async () => {
    const owner = await signIn();
    const polyphemusProject = (await owner.call('/api/projects', { name: 'Polyphemus' })).data.project;
    const shop = (await owner.call('/api/projects', { name: 'Shop' })).data.project;
    const sam = polyphemus.store.addPerson('Sam');
    polyphemus.store.setProjectRole(shop.slug, sam.id, 'member');
    const samDevice = await signIn(sam);
    const samsStream = await listen(samDevice.cookie);
    await samDevice.call('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/sam', keys: { p256dh: 'p', auth: 'a' } } });
    await owner.call('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/owner', keys: { p256dh: 'p', auth: 'a' } } });

    polyphemus.registry.use(
      'openai',
      new ScriptedProvider([
        { content: [{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'touch secret-plan' } }], stopReason: 'tool_use' },
        { content: [{ type: 'text', text: 'the secret plan' }], stopReason: 'end_turn' },
      ]),
    );
    const secret = (await owner.call('/api/sessions', { text: 'the secret plan for polyphemus', project: polyphemusProject.slug })).data;
    const question = await until(async () => (await owner.call('/api/state')).data.questions[0]);
    await until(async () => sent.find((s) => s.endpoint.endsWith('/owner')));
    await owner.call(`/api/questions/${question.id}`, { answer: 'deny' });
    await until(async () => ((await owner.call(`/api/sessions/${secret.id}`)).data.running ? undefined : true));
    const shared = (await owner.call('/api/sessions', { text: 'restock the shop', project: shop.slug })).data;
    await until(async () => ((await owner.call(`/api/sessions/${shared.id}`)).data.running ? undefined : true));

    // Home, projects, search, lists: only Shop.
    const state = (await samDevice.call('/api/state')).data;
    expect(state.sessions.map((s: { id: string }) => s.id)).toEqual([shared.id]);
    expect(state.projects.map((p: { slug: string }) => p.slug)).toEqual([shop.slug]);
    expect(state.me).toMatchObject({ name: 'Sam', owner: false });
    expect(state.capacity).toEqual([]);
    expect((await samDevice.call('/api/sessions?q=secret')).data.sessions).toEqual([]);
    expect((await samDevice.call(`/api/sessions?project=${polyphemusProject.slug}`)).status).toBe(404);
    expect((await owner.call('/api/sessions?q=secret')).data.sessions).toHaveLength(1);

    // The thread itself, and anything done to it, is as if it didn't exist.
    expect((await samDevice.call(`/api/sessions/${secret.id}`)).status).toBe(404);
    expect((await samDevice.call(`/api/sessions/${secret.id}/messages`, { text: 'hello?' })).status).toBe(404);
    expect((await samDevice.call(`/api/sessions/${secret.id}/delete`, {})).status).toBe(404);
    expect((await samDevice.call(`/api/projects/${polyphemusProject.slug}/inbox`)).status).toBe(404);
    expect((await samDevice.call(`/api/sessions/${shared.id}`)).status).toBe(200);

    // Nothing reached Sam's phone or stream about the polyphemus thread; Shop's did.
    expect(sent.filter((s) => s.endpoint.endsWith('/sam')).map((s) => s.payload.url)).not.toContain(`/#/s/${secret.id}`);
    expect(sent.some((s) => s.endpoint.endsWith('/owner') && s.payload.url === `/#/s/${secret.id}`)).toBe(true);
    const heard = samsStream.frames.join('');
    expect(heard).not.toContain(secret.id);
    expect(heard).not.toContain('secret');
    expect(heard).toContain(shared.id);
    samsStream.stop();

    // Setup is the owner's, and a thread needs one of Sam's projects.
    expect((await samDevice.call('/api/providers')).status).toBe(403);
    expect((await samDevice.call('/api/routing', { allowMetered: true })).status).toBe(403);
    expect((await samDevice.call('/api/providers/codex/sandbox', { on: false })).status).toBe(403);
    expect((await samDevice.call('/api/isolation', { level: 'host' })).status).toBe(403);
    expect((await samDevice.call(`/api/projects/${shop.slug}/isolation`, { level: 'isolated' })).status).toBe(403);
    expect((await samDevice.call(`/api/projects/${shop.slug}/network`, { presets: ['packages'], hosts: [] })).status).toBe(403);
    expect((await samDevice.call('/api/models/remove', { ref: 'x' })).status).toBe(403);
    expect((await samDevice.call('/api/projects', { name: 'Mine' })).status).toBe(403);
    expect((await samDevice.call('/api/sessions', { text: 'hi' })).status).toBe(403);
    expect((await samDevice.call('/api/sessions', { text: 'hi', project: polyphemusProject.slug })).status).toBe(404);
    expect((await samDevice.call('/api/sessions', { text: 'hi', project: shop.slug })).status).toBe(201);
  });

  it('saves a pasted secret for someone who can work there, and never hands the value back', async () => {
    const owner = await signIn();
    const shop = (await owner.call('/api/projects', { name: 'Shop' })).data.project;
    const lab = (await owner.call('/api/projects', { name: 'Lab' })).data.project;
    const sam = polyphemus.store.addPerson('Sam');
    const val = polyphemus.store.addPerson('Val');
    polyphemus.store.setProjectRole(shop.slug, sam.id, 'member');
    polyphemus.store.setProjectRole(shop.slug, val.id, 'viewer');
    const member = await signIn(sam);
    const viewer = await signIn(val);
    const thread = (await owner.call('/api/sessions', { text: 'hi', project: shop.slug, start: false })).data;
    const labThread = (await owner.call('/api/sessions', { text: 'quiet', project: lab.slug, start: false })).data;
    const value = 'vault-pasted-value';
    expect((await viewer.call('/api/secrets', { session: thread.id, name: 'shop/token', value, who: 'project' })).status).toBe(403);
    expect((await member.call('/api/secrets', { session: labThread.id, name: 'shop/token', value, who: 'project' })).status).toBe(404);
    expect(polyphemus.vault.has('shop/token')).toBe(false);
    const saved = await member.call('/api/secrets', { session: thread.id, name: 'shop/token', value, purpose: 'the shop', who: 'project' });
    expect(saved.status).toBe(201);
    expect(saved.data).toEqual({ ref: 'secret:shop/token', name: 'shop/token' });
    expect(JSON.stringify(saved.data)).not.toContain(value);
    expect(polyphemus.vault.get('shop/token')).toBe(value);
    expect(readFileSync(join(home, 'vault.json'), 'utf8')).not.toContain(value);
    expect(polyphemus.vault.list()[0]).toMatchObject({ use: { who: 'project', project: shop.slug } });
  });

  it('lets a viewer read, and nothing more', async () => {
    const owner = await signIn();
    const shop = (await owner.call('/api/projects', { name: 'Shop' })).data.project;
    const val = polyphemus.store.addPerson('Val');
    polyphemus.store.setProjectRole(shop.slug, val.id, 'viewer');
    const viewer = (await signIn(val)).call;
    polyphemus.registry.use('openai', new ScriptedProvider([{ content: [{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'touch x' } }], stopReason: 'tool_use' }]));
    const thread = (await owner.call('/api/sessions', { text: 'make a file', project: shop.slug })).data;
    const question = await until(async () => (await owner.call('/api/state')).data.questions[0]);

    expect((await viewer(`/api/sessions/${thread.id}`)).data).toMatchObject({ canAct: false });
    const waiting = (await viewer('/api/state')).data.questions;
    expect(waiting).toHaveLength(1); // they see it's waiting…
    expect(waiting[0].line).toMatch(/^Waiting for an OK to run /); // and why, the same line as the thread
    expect((await viewer(`/api/questions/${question.id}`, { answer: 'allow' })).status).toBe(403); // …but can't answer it
    expect((await viewer(`/api/sessions/${thread.id}/messages`, { text: 'go on' })).status).toBe(403);
    expect((await viewer(`/api/sessions/${thread.id}/archive`, {})).status).toBe(403);
    expect((await viewer('/api/sessions', { text: 'hi', project: shop.slug })).status).toBe(403);
    expect((await fetch(`${base}/api/images`, { method: 'POST', headers: { cookie: (await signIn(val)).cookie, 'content-type': 'image/png' }, body: PNG })).status).toBe(403);
    await owner.call(`/api/questions/${question.id}`, { answer: 'deny' });
  });

  it('shows an image only to its uploader and people who can see a thread it’s in', async () => {
    const owner = await signIn();
    const secretProject = (await owner.call('/api/projects', { name: 'Secret' })).data.project;
    const shop = (await owner.call('/api/projects', { name: 'Shop' })).data.project;
    const sam = polyphemus.store.addPerson('Sam');
    polyphemus.store.setProjectRole(shop.slug, sam.id, 'member');
    const samDevice = await signIn(sam);
    const upload = async (cookie: string) =>
      ((await (await fetch(`${base}/api/images`, { method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: PNG })).json()) as { id: string }).id;
    const see = async (cookie: string, id: string) => (await fetch(`${base}/api/images/${id}`, { headers: { cookie } })).status;

    const id = await upload(owner.cookie);
    await owner.call('/api/sessions', { text: 'diagram', images: [id], project: secretProject.slug });
    expect(await see(samDevice.cookie, id)).toBe(404);

    // Once it's in a thread Sam can see, Sam can see it; and anything Sam uploads is Sam's.
    await owner.call('/api/sessions', { text: 'same diagram, for the shop', images: [id], project: shop.slug });
    expect(await see(samDevice.cookie, id)).toBe(200);
    mkdirSync(join(home, 'x'), { recursive: true });
    const samsOwn = await upload(samDevice.cookie);
    expect(await see(samDevice.cookie, samsOwn)).toBe(200);
  });
});
