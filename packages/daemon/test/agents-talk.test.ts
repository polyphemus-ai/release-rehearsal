import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, emptyUsage, Polyphemus, type ChatRequest, type ModelProvider, type ProviderEvent } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

// Agents talking to agents (docs/design/agents.md), and journeys 12–13 at the API: a hand-off by
// @mention, the lead answering when nobody's named, and the guard pausing a loop where it happened.

/** Builder and Researcher keep asking each other, forever, unless `quietAfter` replies have been given. */
class Chatty implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'openai';
  replies = 0;
  quietAfter = Infinity;
  asked: string[] = [];
  systems: string[] = [];
  /** What Builder says instead, when set. */
  builderSays?: string;
  /** Replies say they came from this model instead of the one asked: a fallback standing in. */
  standIn?: string;
  /** Everything each turn was sent, as one string. */
  conversations: string[] = [];
  /** When set, the next turn waits here, so a person can answer while it is still going. */
  hold?: Promise<void>;
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    if (this.hold) {
      const waiting = this.hold;
      this.hold = undefined;
      await waiting;
    }
    this.conversations.push(JSON.stringify(req.messages));
    this.systems.push(req.system);
    const last = req.messages.at(-1);
    this.asked.push((last?.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n'));
    const speaker = req.system.includes('RESEARCHER-PERSONA') ? 'Researcher' : req.system.includes('REVIEWER-PERSONA') ? 'Reviewer' : 'Builder';
    this.replies += 1;
    const text = this.replies > this.quietAfter ? `${speaker}: that's everything from me.` : speaker === 'Builder' ? (this.builderSays ?? '@Researcher does anyone refresh the token on read?') : speaker === 'Researcher' ? '@Builder two of three do, with a mutex. Anything else?' : `${speaker} here, looking.`;
    yield { type: 'message_done', message: { role: 'assistant', content: [{ type: 'text', text }], origin: { provider: 'openai', model: this.standIn ?? req.model } }, stopReason: 'end_turn', usage: { ...emptyUsage(), inputTokens: 1000, outputTokens: 200 } };
  }
  async listModels() {
    return [];
  }
}

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let provider: Chatty;
let call: (path: string, body?: unknown) => Promise<{ status: number; data: Record<string, any> }>;
const savedEnv = { ...process.env };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-talk-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\ndefault_model = "gpt-api"\n${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  for (const [name, title] of [['builder', 'Builder'], ['researcher', 'Researcher'], ['reviewer', 'Reviewer']] as const) {
    mkdirSync(join(home, 'agents', name), { recursive: true });
    writeFileSync(join(home, 'agents', name, 'agent.toml'), `description = "${title}"\ntitle = "${title}"\nmodel = "gpt-api"\n`);
    writeFileSync(join(home, 'agents', name, 'persona.md'), `${title.toUpperCase()}-PERSONA\n`);
  }
  polyphemus = await Polyphemus.open(home);
  provider = new Chatty();
  polyphemus.registry.use('openai', provider);
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

async function until<T>(check: () => Promise<T | undefined | false>, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const speakers = async (id: string) => {
  const d = (await call(`/api/sessions/${id}`)).data;
  return d.messages.map((m: { role: string }, i: number) => (m.role === 'assistant' ? d.actors[i] : null)).filter(Boolean);
};

async function groupThread(project: string, text = 'hello') {
  const thread = (await call('/api/sessions', { text, project, agent: 'builder', with: ['researcher'] })).data;
  return thread.id as string;
}

describe('agents talking to agents', () => {
  it('hands off by @mention, and the guard pauses the loop where it happened (journey 13)', async () => {
    const project = (await call('/api/projects', { name: 'Polyphemus' })).data.project.slug;
    const id = (await call('/api/sessions', { text: 'Take ticket 412', project, agent: 'builder', with: ['researcher'] })).data.id;
    const guard = await until(async () => (await call('/api/state')).data.questions.find((q: { sessionId: string; kind: string }) => q.sessionId === id && q.kind === 'guard'), 'the guard');

    // Builder answered the person, then six hand-offs between them, then it stopped and asked.
    expect(guard).toMatchObject({ kind: 'guard', from: 'Builder', to: 'Researcher', count: 6, limit: 6, between: ['Builder', 'Researcher'] });
    expect(guard.tokens).toBeGreaterThan(0);
    expect(await speakers(id)).toEqual(['agent:builder', 'agent:researcher', 'agent:builder', 'agent:researcher', 'agent:builder', 'agent:researcher', 'agent:builder']);
    const row = (await call('/api/state')).data.sessions.find((s: { id: string }) => s.id === id);
    expect(row).toMatchObject({ state: 'paused', pausedWhy: 'Paused — 6 messages between agents' });
    // Every agent was told who's here and that an @mention hands them the next turn.
    expect(provider.asked[0]).toContain('Agents in this thread: @Builder (you, lead, on gpt-api), @Researcher (on gpt-api)');
    expect(provider.asked[1]).toContain('@Researcher (you, on gpt-api)');
    expect(provider.asked[1]).toContain('the person never relays messages');
    expect((await call(`/api/sessions/${id}`)).data.running).toBe(false);

    // "Continue and stop asking here" changes this thread only.
    const other = (await call('/api/sessions', { text: 'Unrelated', project, agent: 'reviewer' })).data.id;
    provider.quietAfter = provider.replies + 3;
    expect((await call(`/api/questions/${guard.id}`, { answer: 'always' })).status).toBe(200);
    await until(async () => (await call(`/api/sessions/${id}`)).data.messages.some((m: { content: Array<{ text?: string }> }) => m.content.some((b) => b.text?.includes('everything from me'))), 'the loop to wind down');
    expect((await call(`/api/sessions/${id}`)).data.guard).toEqual({ limit: 0, default: 6 });
    expect((await call(`/api/sessions/${other}`)).data.guard).toEqual({ limit: null, default: 6 });
    expect((await call('/api/state')).data.questions.filter((q: { sessionId: string }) => q.sessionId === id)).toEqual([]);
  }, 20_000);

  it('knows its teammates, and naming one who isn’t here asks the person to bring them in', async () => {
    const project = (await call('/api/projects', { name: 'Polyphemus' })).data.project.slug;
    const id = (await call('/api/sessions', { text: 'Take ticket 412', project, agent: 'builder' })).data.id;
    // Builder, alone with the person, names Researcher: that's a question for the person, not a hand-off.
    const invite = await until(async () => (await call('/api/state')).data.questions.find((q: { sessionId: string; kind: string }) => q.sessionId === id && q.kind === 'invite'), 'the invitation');
    expect(invite).toMatchObject({ from: 'Builder', agent: 'Researcher', about: 'Researcher' });
    expect(provider.asked[0]).toContain('Teammates not in this thread: @Researcher (Researcher), @Reviewer (Reviewer)');
    expect(provider.asked[0]).toContain('that agent joins and picks up from your mention');
    expect(await speakers(id)).toEqual(['agent:builder']);
    expect((await call(`/api/sessions/${id}`)).data.members.map((m: { id: string }) => m.id)).toEqual(['builder']);

    // Yes: Researcher joins and picks up from the mention.
    provider.quietAfter = provider.replies + 1;
    expect((await call(`/api/questions/${invite.id}`, { answer: 'bring' })).status).toBe(200);
    await until(async () => (await speakers(id)).includes('agent:researcher') && !(await call(`/api/sessions/${id}`)).data.running, 'Researcher to answer');
    expect((await call(`/api/sessions/${id}`)).data.members.map((m: { id: string }) => m.id)).toEqual(['builder', 'researcher']);
    expect(provider.asked.some((text) => text.includes('Builder mentioned you'))).toBe(true);

    // The person naming someone who isn't here brings them in outright, and they answer.
    provider.quietAfter = 0;
    expect((await call(`/api/sessions/${id}/messages`, { text: '@Reviewer have a look too' })).data.answering).toBe('reviewer');
    await until(async () => (await speakers(id)).includes('agent:reviewer'), 'Reviewer to answer');
    expect((await call(`/api/sessions/${id}`)).data.members.map((m: { id: string }) => m.id)).toEqual(['builder', 'researcher', 'reviewer']);
  }, 20_000);

  it('starts a new thread when a DM asks to bring someone in, and leaves the DM as it was', async () => {
    provider.builderSays = '@Researcher, you know the stack. Have a look?';
    const id = (await call('/api/sessions', { text: 'just us', agent: 'builder' })).data.id;
    const invite = await until(async () => (await call('/api/state')).data.questions.find((q: { sessionId: string; kind: string }) => q.sessionId === id && q.kind === 'invite'), 'the invitation');
    expect(invite).toMatchObject({ from: 'Builder', agent: 'Researcher', newThread: true, line: 'Builder wants to start a thread with Researcher' });
    expect(provider.asked[0]).toContain('start a new thread with them');
    expect(provider.asked[0]).toContain('This conversation stays just you and the person');

    provider.quietAfter = provider.replies;
    const yes = await call(`/api/questions/${invite.id}`, { answer: 'bring' });
    expect(yes.status).toBe(200);
    const child = yes.data.thread as string;
    expect(child).toBeTruthy();
    expect(child).not.toBe(id);
    await until(async () => (await speakers(child)).includes('agent:researcher') && !(await call(`/api/sessions/${child}`)).data.running, 'Researcher to answer in the new thread');

    const parent = (await call(`/api/sessions/${id}`)).data;
    expect(parent.members.map((m: { id: string }) => m.id)).toEqual(['builder']);
    expect(parent.spinOuts.map((s: { id: string }) => s.id)).toEqual([child]);
    const group = (await call(`/api/sessions/${child}`)).data;
    expect(group.members.map((m: { id: string }) => m.id).sort()).toEqual(['builder', 'researcher']);
    expect(group.spunFrom.id).toBe(id);
    expect(group.project ?? null).toBeNull();
    expect(provider.asked.some((text) => text.includes('That conversation stays as it was') && text.includes('you know the stack'))).toBe(true);
  }, 20_000);

  it('tells an agent which teammate can make agents, skills and routines', async () => {
    (polyphemus.config as { defaultAgent?: string }).defaultAgent = 'reviewer';
    provider.quietAfter = 0;
    const project = (await call('/api/projects', { name: 'Polyphemus' })).data.project.slug;
    const id = (await call('/api/sessions', { text: 'We need a video editor on this team', project, agent: 'builder' })).data.id;
    await until(async () => (provider.conversations.length ? true : undefined), 'Builder to be asked');
    const told = provider.conversations.at(-1)! + provider.systems.at(-1)!;
    expect(told).toContain("@Reviewer is polyphemus's own agent");
    await until(async () => ((await call(`/api/sessions/${id}`)).data.running ? undefined : true), 'the turn to end');
  });

  it('asks about every teammate a reply names who isn’t here, not only the first', async () => {
    const project = (await call('/api/projects', { name: 'Polyphemus' })).data.project.slug;
    provider.builderSays = '@Researcher, find what exists. @Reviewer, check it once there’s a draft.';
    const id = (await call('/api/sessions', { text: 'Set up the site', project, agent: 'builder' })).data.id;
    const invites = async () => (await call('/api/state')).data.questions.filter((q: { sessionId: string; kind: string }) => q.sessionId === id && q.kind === 'invite');
    await until(async () => ((await invites()).length === 2 ? true : undefined), 'two invitations');
    expect((await invites()).map((q: { agent: string }) => q.agent).sort()).toEqual(['Researcher', 'Reviewer']);
    // Yes to both: both join.
    provider.quietAfter = provider.replies;
    for (const invite of await invites()) expect((await call(`/api/questions/${invite.id}`, { answer: 'bring' })).status).toBe(200);
    await until(async () => ((await call(`/api/sessions/${id}`)).data.members.length === 3 ? true : undefined), 'both to join');
    expect((await call(`/api/sessions/${id}`)).data.members.map((m: { id: string }) => m.id).sort()).toEqual(['builder', 'researcher', 'reviewer']);
  }, 20_000);

  it('starts an agent you said yes to while the thread was still working', async () => {
    const project = (await call('/api/projects', { name: 'Polyphemus' })).data.project.slug;
    provider.builderSays = '@Researcher have a look';
    const id = (await call('/api/sessions', { text: 'Set up the site', project, agent: 'builder' })).data.id;
    const invite = await until(async () => (await call('/api/state')).data.questions.find((q: { sessionId: string; kind: string }) => q.sessionId === id && q.kind === 'invite'), 'the invitation');
    let release: () => void = () => {};
    provider.hold = new Promise((resolve) => {
      release = resolve;
    });
    provider.quietAfter = 0;
    await call(`/api/sessions/${id}/messages`, { text: 'one moment' });
    await until(async () => ((await call(`/api/sessions/${id}`)).data.running ? true : undefined), 'the turn to be going');
    expect((await call(`/api/questions/${invite.id}`, { answer: 'bring' })).status).toBe(200);
    expect((await call(`/api/sessions/${id}`)).data.members.map((m: { id: string }) => m.id)).toEqual(['builder', 'researcher']);
    expect(await speakers(id)).not.toContain('agent:researcher');
    release();
    await until(async () => ((await speakers(id)).includes('agent:researcher') ? true : undefined), 'Researcher to answer after the turn');
  }, 20_000);

  it('lets the lead take a message that names nobody, in a thread where agents answer everything', async () => {
    const project = (await call('/api/projects', { name: 'Polyphemus' })).data.project.slug;
    provider.quietAfter = 0;
    const id = await groupThread(project, 'kick off');
    await until(async () => !(await call(`/api/sessions/${id}`)).data.running && (await speakers(id)).length === 1, 'the first reply');
    expect((await call(`/api/sessions/${id}`)).data.lead).toBe('builder');

    expect((await call(`/api/sessions/${id}/lead`, { agent: 'researcher' })).status).toBe(200);
    // Without it, a message naming nobody gets no answer.
    expect((await call(`/api/sessions/${id}/messages`, { text: 'hm' })).data.answering).toBeNull();
    await call(`/api/sessions/${id}/answer-all`, { on: true });
    await call(`/api/sessions/${id}/messages`, { text: 'what did we find?' });
    await until(async () => !(await call(`/api/sessions/${id}`)).data.running && (await speakers(id)).length === 2, 'the lead to answer');
    expect((await speakers(id)).at(-1)).toBe('agent:researcher');
    expect((await call(`/api/sessions/${id}/lead`, { agent: 'reviewer' })).status).toBe(400);
  });

  it('tells agents who came and went, what each really ran on, and how polyphemus works — not commands that don’t exist', async () => {
    const project = (await call('/api/projects', { name: 'Polyphemus' })).data.project.slug;
    provider.quietAfter = 0;
    provider.standIn = 'gpt-stand-in';
    const id = await groupThread(project, 'kick off');
    await until(async () => !(await call(`/api/sessions/${id}`)).data.running && (await speakers(id)).length === 1, 'the first reply');
    await call(`/api/sessions/${id}/members`, { agent: 'reviewer' });
    await call(`/api/sessions/${id}/members`, { agent: 'reviewer', remove: true });
    const owner = polyphemus.store.installOwner().name;

    const asked = provider.asked.length;
    await call(`/api/sessions/${id}/messages`, { text: '@Researcher anything new?' });
    await until(async () => !(await call(`/api/sessions/${id}`)).data.running && provider.asked.length > asked, 'the answer');
    const status = provider.asked.at(-1)!;
    expect(status).toMatch(new RegExp(`Who came and went in this thread: \\w{3} \\d+:\\d\\d [AP]M: ${owner} added Reviewer; \\w{3} \\d+:\\d\\d [AP]M: ${owner} removed Reviewer\\.`));
    // Builder's reply came from another model than it's set to, and the others are told so.
    expect(status).toContain('@Builder (lead, on openai:gpt-stand-in on its last turn, standing in for gpt-api)');
    expect(status).toContain('a message that names no agent gets no answer from any of you');
    const system = provider.systems.at(-1)!;
    expect(system).toContain('There are no other commands in a thread');
    expect(system).not.toContain('The user switches models with /model');
  });

  it('spins a thread out, linked both ways, with the same agents', async () => {
    const project = (await call('/api/projects', { name: 'Polyphemus' })).data.project.slug;
    provider.quietAfter = 0;
    const id = await groupThread(project);
    await until(async () => !(await call(`/api/sessions/${id}`)).data.running, 'the reply');
    const child = (await call(`/api/sessions/${id}/spinout`, { text: 'The token refresh race' })).data.id;
    const detail = (await call(`/api/sessions/${child}`)).data;
    expect(detail.meta).toMatchObject({ title: 'The token refresh race', spunFrom: id });
    expect(detail.spunFrom).toMatchObject({ id, visible: true });
    expect(detail.members.map((m: { id: string }) => m.id)).toEqual(['builder', 'researcher']);
    expect((await call(`/api/sessions/${id}`)).data.spinOuts).toEqual([expect.objectContaining({ id: child, title: 'The token refresh race' })]);
  });
});

describe('threads with several people in them', () => {
  it('lets people talk without an agent answering every line, until one is named or the thread says otherwise', async () => {
    const project = (await call('/api/projects', { name: 'Shared' })).data.project.slug;
    const sam = polyphemus.store.addPerson('Sam');
    polyphemus.store.setProjectRole(project, sam.id, 'member');
    const base = daemon.urls[0]!;
    const samCookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode(undefined, sam.id)}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const asSam = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: samCookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    const messages = async (id: string) => (await call(`/api/sessions/${id}`)).data.messages.length as number;

    // Just you and one agent: it answers everything, as before.
    const id = (await call('/api/sessions', { text: 'Can you look at the export?', project, agent: 'reviewer' })).data.id;
    await until(async () => (await messages(id)) === 2, 'the first answer');
    const repliesBefore = provider.replies;

    // Sam joins the conversation: now two people, so an unnamed line is for the people.
    expect((await asSam(`/api/sessions/${id}/messages`, { text: 'Morning — I think it’s the commas.' })).data).toEqual({ ok: true, answering: null });
    await until(async () => (await messages(id)) === 3, 'Sam’s line');
    await new Promise((r) => setTimeout(r, 150));
    expect(provider.replies).toBe(repliesBefore);
    const detail = (await call(`/api/sessions/${id}`)).data;
    expect(detail.actors.at(-1)).toBe(`person:${sam.id}`);

    // Naming the agent gets an answer, and it read what Sam said.
    expect((await asSam(`/api/sessions/${id}/messages`, { text: '@Reviewer is it the commas?' })).data.answering).toBe('reviewer');
    await until(async () => provider.replies === repliesBefore + 1 && !(await call(`/api/sessions/${id}`)).data.running, 'the named answer');
    expect(provider.conversations.at(-1)).toContain('I think it’s the commas');

    // Turned on for this thread: agents answer everything again.
    expect((await call(`/api/sessions/${id}/answer-all`, { on: true })).data).toEqual({ agentsAnswerAll: true });
    expect((await call(`/api/sessions/${id}`)).data.agentsAnswerAll).toBe(true);
    expect((await asSam(`/api/sessions/${id}/messages`, { text: 'One more thing.' })).data.answering).toBe('reviewer');
    await until(async () => provider.replies === repliesBefore + 2, 'the answer to everything');

    // People coming and going from the project show on its threads from then on, with who did it.
    const owner = polyphemus.store.installOwner();
    polyphemus.store.setProjectRole(project, sam.id, 'viewer', Date.now(), `person:${owner.id}`);
    polyphemus.store.setProjectRole(project, sam.id, 'viewer', Date.now(), `person:${owner.id}`); // no change, nothing new
    polyphemus.store.setProjectRole(project, sam.id, null, Date.now(), `person:${owner.id}`);
    const attendance = (await call(`/api/sessions/${id}`)).data.attendance.filter((a: { kind: string }) => a.kind === 'person');
    expect(attendance.map((a: any) => `${a.byName} ${a.change} ${a.who}${a.role ? ` ${a.role}` : ''}`)).toEqual([`${owner.name} role Sam viewer`, `${owner.name} left Sam`]);
  });
});


describe('more than one agent working at once', () => {
  it('brings in an agent you name while another is working, without stopping the one at work', async () => {
    // From a real thread (2026-09-19): "@Lantern welcome" arrived while Parable was mid-turn, and
    // Parable's revision never landed.
    const gates = new Map<string, () => void>();
    const slow: ModelProvider = {
      kind: 'model',
      id: 'openai',
      async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
        const who = req.system.includes('REVIEWER-PERSONA') ? 'Reviewer' : 'Builder';
        if (who === 'Builder') {
          await new Promise<void>((resolve) => {
            gates.set('builder', resolve);
            req.signal?.addEventListener('abort', () => resolve());
          });
          if (req.signal?.aborted) return;
        }
        yield { type: 'message_done', message: { role: 'assistant', content: [{ type: 'text', text: `${who}: done.` }], origin: { provider: 'openai', model: req.model } }, stopReason: 'end_turn', usage: emptyUsage() };
      },
      async listModels() {
        return [];
      },
    };
    polyphemus.registry.use('openai', slow);
    const project = (await call('/api/projects', { name: 'Polyphemus' })).data.project.slug;
    const { id } = (await call('/api/sessions', { text: 'revise the script', project, agent: 'builder' })).data;
    await until(async () => (gates.has('builder') ? true : undefined), 'Builder to start');

    // Reviewer isn't in the thread: naming them brings them in, and they answer now.
    await call(`/api/sessions/${id}/messages`, { text: '@Reviewer welcome, see what they need' });
    await until(async () => (polyphemus.store.messages(id).some((m) => JSON.stringify(m.content).includes('Reviewer: done.')) ? true : undefined), 'Reviewer to answer');
    expect((await call(`/api/sessions/${id}`)).data.members.map((m: { id: string }) => m.id)).toContain('reviewer');
    // Builder was never stopped: let go now, it finishes its own turn.
    gates.get('builder')!();
    await until(async () => (polyphemus.store.messages(id).some((m) => JSON.stringify(m.content).includes('Builder: done.')) ? true : undefined), 'Builder to finish');
  }, 20_000);

  it('lets you talk to another agent in the thread while one is working, and stop either', async () => {
    // A thread used to take one turn at a time, so a message to anyone else waited (2026-09-19).
    const gates = new Map<string, () => void>();
    const slow: ModelProvider = {
      kind: 'model',
      id: 'openai',
      async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
        const who = req.system.includes('RESEARCHER-PERSONA') ? 'Researcher' : 'Builder';
        // Builder waits to be let go; Researcher answers straight away.
        if (who === 'Builder') {
          await new Promise<void>((resolve) => {
            gates.set('builder', resolve);
            req.signal?.addEventListener('abort', () => resolve());
          });
          if (req.signal?.aborted) return;
        }
        yield { type: 'message_done', message: { role: 'assistant', content: [{ type: 'text', text: `${who}: done.` }], origin: { provider: 'openai', model: req.model } }, stopReason: 'end_turn', usage: emptyUsage() };
      },
      async listModels() {
        return [];
      },
    };
    polyphemus.registry.use('openai', slow);
    const { id } = (await call('/api/sessions', { text: 'start please', agent: 'builder', with: ['researcher'] })).data;
    await until(async () => ((await call(`/api/sessions/${id}`)).data.running ? true : undefined), 'Builder to start');

    // Builder is working; Researcher answers now, not later.
    const sent = await call(`/api/sessions/${id}/messages`, { text: '@Researcher quick one while they work' });
    expect(sent.data).toMatchObject({ alongside: true, answering: 'researcher' });
    expect((await call(`/api/sessions/${id}`)).data.queued).toEqual([]);
    await until(async () => (polyphemus.store.messages(id).some((m) => JSON.stringify(m.content).includes('Researcher: done.')) ? true : undefined), 'Researcher to answer');
    // Builder is still working, and the thread says both were.
    expect((await call(`/api/sessions/${id}`)).data.running).toBe(true);

    // A second message to the same agent while it works is held, as before.
    const again = await call(`/api/sessions/${id}/messages`, { text: '@Builder and this?' });
    expect(again.data.queued).toBeTruthy();

    // Sending that held one now goes to Researcher alongside — Builder isn't stopped for it.
    const held = (await call(`/api/sessions/${id}/messages`, { text: '@Researcher one more for you' })).data.queued;
    expect(held).toBeTruthy();
    expect((await call(`/api/sessions/${id}/send-now`, { id: held })).data).toMatchObject({ stopped: false, alongside: true });
    expect((await call(`/api/sessions/${id}`)).data.running).toBe(true);

    // What the other agent said is part of the thread for everyone: the detail shows it while the
    // first agent is still working, and the first agent's next turn is sent it (review, 2026-09-20).
    const detail = (await call(`/api/sessions/${id}`)).data;
    expect(JSON.stringify(detail.messages)).toContain('Researcher: done.');

    // Taken back, so nothing follows it; then Builder's own turn is stopped on its own.
    expect((await call(`/api/sessions/${id}/unqueue`, { id: again.data.queued })).status).toBe(200);
    expect((await call(`/api/sessions/${id}/interrupt`, { agent: 'builder' })).status).toBe(200);
    await until(async () => ((await call(`/api/sessions/${id}`)).data.running ? undefined : true), 'Builder to stop');
    // Only agents working here can be stopped.
    expect((await call(`/api/sessions/${id}/interrupt`, { agent: 'nobody' })).status).toBe(404);

    // And Builder's next turn is sent it: the thread they share, not its own copy from before.
    provider.quietAfter = 0;
    polyphemus.registry.use('openai', provider);
    expect((await call(`/api/sessions/${id}/messages`, { text: '@Builder what now?' })).status).toBe(202);
    await until(async () => ((await call(`/api/sessions/${id}`)).data.running ? undefined : true), 'Builder to answer');
    expect(provider.conversations.at(-1)).toContain('Researcher: done.');
  }, 30_000);
});
