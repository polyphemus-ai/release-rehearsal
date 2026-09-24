import { mkdtemp } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, emptyUsage, Polyphemus, type Block, type ChatRequest, type ModelProvider, type Person, type ProviderEvent, type StopReason } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

// Settled brief journeys 1 and 2: Waiting on you is the daemon's. A question is answered once, for
// everyone; claimed softly; and survives a disconnect — and a restart, where it says why it's gone.

class AlwaysAsks implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'openai';
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    const answered = req.messages.at(-1)?.content.some((b) => b.type === 'tool_result');
    const command = req.messages.some((m) => m.content.some((b) => b.type === 'text' && b.text.includes('in my home'))) ? `touch ${homedir()}/notes.txt` : 'touch x';
    const content: Block[] = answered ? [{ type: 'text', text: 'done' }] : [{ type: 'tool_call', id: `c${Date.now()}`, name: 'bash', input: { command } }];
    yield { type: 'message_done', message: { role: 'assistant', content, origin: { provider: 'openai', model: req.model } }, stopReason: (answered ? 'end_turn' : 'tool_use') as StopReason, usage: emptyUsage() };
  }
  async listModels() {
    return [];
  }
}

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let base: string;
const savedEnv = { ...process.env };

async function start() {
  polyphemus = await Polyphemus.open(home);
  polyphemus.registry.use('openai', new AlwaysAsks());
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;
}
async function stop() {
  await daemon.close();
  polyphemus.close();
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-waiting-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\ndefault_model = "gpt-api"\n${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  await start();
});
afterEach(async () => {
  await stop().catch(() => {});
  process.env = { ...savedEnv };
});

type Call = (path: string, body?: unknown) => Promise<{ status: number; data: Record<string, any> }>;
async function device(person?: Person): Promise<Call> {
  const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode(undefined, person?.id)}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
  return async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
}
async function until<T>(check: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('timed out');
}

describe('Waiting on you', () => {
  async function sharedApproval() {
    const me = await device();
    const project = (await me('/api/projects', { name: 'Shop' })).data.project;
    const sam = polyphemus.store.addPerson('Sam');
    polyphemus.store.setProjectRole(project.slug, sam.id, 'member');
    const sams = await device(sam);
    const thread = (await me('/api/sessions', { text: 'make a file', project: project.slug })).data;
    const question = await until(async () => (await me('/api/state')).data.questions[0]);
    return { me, sams, sam, thread, question };
  }

  it('says where an approval runs, and shows a path from ~ rather than the account’s folder', async () => {
    const me = await device();
    await me('/api/sessions', { text: 'make a file in my home' });
    const question = await until(async () => (await me('/api/state')).data.questions[0]);
    // This install runs agents on this computer (the test's config), and the card says so.
    expect(question).toMatchObject({ kind: 'approval', where: 'host', summary: expect.stringContaining('~/notes.txt') });
    expect(question.summary).not.toContain(homedir());
  });

  it('is answered once, for everyone, and the second answer is told who got there first', async () => {
    const { me, sams, question } = await sharedApproval();
    const [a, b] = await Promise.all([me(`/api/questions/${question.id}`, { answer: 'allow' }), sams(`/api/questions/${question.id}`, { answer: 'deny' })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.data.error).toMatch(/^Already answered by (you|Sam|.+)\.$/);
    // Both devices reconcile to the same thing: nothing waiting.
    expect((await me('/api/state')).data.questions).toEqual([]);
    expect((await sams('/api/state')).data.questions).toEqual([]);
  });

  it('can be claimed, is protected while claimed, and taking it over is deliberate and recorded', async () => {
    const { me, sams, sam, question } = await sharedApproval();
    expect((await sams(`/api/questions/${question.id}/claim`, {})).data.claimedBy).toBe(`person:${sam.id}`);
    // Everyone sees who has it.
    expect((await me('/api/state')).data.questions[0]).toMatchObject({ claimedBy: `person:${sam.id}`, claimedAt: expect.any(Number) });

    const blocked = await me(`/api/questions/${question.id}`, { answer: 'allow' });
    expect(blocked.status).toBe(409);
    expect(blocked.data.error).toContain('Sam is handling this');
    expect((await me(`/api/questions/${question.id}/claim`, {})).status).toBe(409); // not by accident

    const owner = polyphemus.store.installOwner();
    expect((await me(`/api/questions/${question.id}/claim`, { takeOver: true })).data).toEqual({ claimedBy: `person:${owner.id}`, tookOverFrom: `person:${sam.id}` });
    expect(polyphemus.store.question(question.id)?.claims).toMatchObject([{ by: `person:${sam.id}` }, { by: `person:${owner.id}`, tookOverFrom: `person:${sam.id}` }]);
    expect((await me(`/api/questions/${question.id}`, { answer: 'deny' })).status).toBe(200);
    expect(polyphemus.store.question(question.id)).toMatchObject({ status: 'answered', answer: 'deny', answeredBy: `person:${owner.id}` });
  });

  it('survives a restart as a question that says why it can’t be answered, rather than vanishing', async () => {
    const { me, question } = await sharedApproval();
    await stop();
    await start();
    const again = await device();
    expect((await again('/api/state')).data.questions).toEqual([]);
    expect(polyphemus.store.question(question.id)).toMatchObject({ status: 'expired', expiredWhy: expect.stringContaining('restarted') });
    const late = await again(`/api/questions/${question.id}`, { answer: 'allow' });
    expect(late.status).toBe(409);
    expect(late.data.error).toContain('restarted');
    void me;
  });

  it('lets a sign-in card be cleared once the turn that asked has stopped', async () => {
    // A rejected request_sign_in left its card in the thread with nothing that would close it, while
    // the person had signed in and it worked (2026-09-22).
    const me = await device();
    const thread = polyphemus.store.create({ title: 'the scale', provider: 'openai', model: 'gpt-5', cwd: home });
    const card = polyphemus.store.askQuestion({ id: 'sgn12345', sessionId: thread.id, kind: 'signin', detail: { connection: 'browser', name: 'Browser', how: 'browser', where: 'account.withings.com', site: 'account.withings.com', url: 'https://account.withings.com', purpose: 'read your weights' } });
    const answered = await me(`/api/questions/${card.id}`, { answer: 'done' });
    expect(answered.status).toBe(200);
    expect(answered.data).toMatchObject({ dismissed: true });
    expect(polyphemus.store.question(card.id)?.status).toBe('expired');
    expect((await me('/api/state')).data.questions).toEqual([]);
  });

  it('keeps an invitation and a proposal open across a restart: nothing was waiting on them', async () => {
    mkdirSync(join(home, 'agents', 'robin'), { recursive: true });
    writeFileSync(join(home, 'agents', 'robin', 'agent.toml'), 'description = "builds sites"\ntitle = "Robin"\nmodel = "gpt-api"\n');
    const thread = polyphemus.store.create({ title: 'the site', provider: 'openai', model: 'gpt-5', cwd: home });
    const invite = polyphemus.store.askQuestion({ id: 'inv12345', sessionId: thread.id, kind: 'invite', detail: { from: 'Morgan', fromId: 'morgan', agent: 'Robin', agentId: 'robin', about: 'builds sites', said: '@Robin, you build it.' } });
    const note = polyphemus.store.askQuestion({ id: 'note1234', sessionId: thread.id, kind: 'note', detail: { agentTitle: 'Robin', name: 'stack', description: 'Astro' } });
    // A deploy restarts polyphemus the moment the turn that asked ends.
    await stop();
    await start();
    expect(polyphemus.store.question(invite.id)).toMatchObject({ status: 'open' });
    expect(polyphemus.store.question(note.id)).toMatchObject({ status: 'open' });
    const me = await device();
    expect((await me(`/api/questions/${invite.id}`, { answer: 'bring' })).status).toBe(200);
    expect((await me(`/api/sessions/${thread.id}`)).data.members.map((m: { id: string }) => m.id)).toContain('robin');
  });
});
