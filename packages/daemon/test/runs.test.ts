import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, emptyUsage, Polyphemus, type Block, type ChatRequest, type Message, type ModelProvider, type Person, type ProviderEvent, type StopReason } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

// Settled brief §3–4 and journeys 7–10: a chat becomes work and back; a run fails on an expired
// connection and run 2 keeps run 1; a claimed status isn't a real one; evidence survives a restart.

const FIXTURE = fileURLToPath(new URL('../../core/test/fixtures/mcp-contacts.mjs', import.meta.url));

type Reply = { content: Block[]; stopReason: StopReason };
const say = (text: string): Reply => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' });
const call = (name: string, input: Record<string, unknown> = {}): Reply => ({ content: [{ type: 'tool_call', id: `c${Math.random().toString(36).slice(2)}`, name, input }], stopReason: 'tool_use' });

/**
 * A model that answers by what it's been asked: the last thing a person (or polyphemus) said, and how
 * many tool results have come back since. `script` maps a phrase in that message to its replies.
 */
class Driven implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'openai';
  hang?: (signal?: AbortSignal) => Promise<void>;
  constructor(public script: Array<[RegExp, Reply[]]>) {}
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    const lastAsk = [...req.messages].reverse().findIndex((m: Message) => m.role === 'user' && m.content.some((b) => b.type === 'text'));
    const asked = req.messages[req.messages.length - 1 - lastAsk]!;
    const text = asked.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const replies = this.script.find(([pattern]) => pattern.test(text))?.[1] ?? [say('ok')];
    const answered = lastAsk; // assistant + tool-result pairs since the ask
    const reply = replies[Math.floor(answered / 2)] ?? say('done');
    if (this.hang && /step 1 of/.test(text) && answered >= 2) await this.hang(req.signal);
    yield { type: 'message_done', message: { role: 'assistant', content: reply.content, origin: { provider: 'openai', model: req.model } }, stopReason: reply.stopReason, usage: emptyUsage() };
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

async function start(provider?: ModelProvider) {
  polyphemus = await Polyphemus.open(home);
  if (provider) polyphemus.registry.use('openai', provider);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-runs-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\ndefault_model = "gpt-api"\n${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  mkdirSync(join(home, 'agents', 'bd'), { recursive: true });
  writeFileSync(join(home, 'agents', 'bd', 'agent.toml'), 'description = "Business development"\ntitle = "BD"\nmodel = "gpt-api"\n');
});
afterEach(async () => {
  await daemon?.close().catch(() => {});
  polyphemus?.close();
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

async function until<T>(check: () => Promise<T | undefined | false>, what = 'it'): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const work = async (me: Call, id: string) => (await me(`/api/sessions/${id}`)).data.work;
const settled = (me: Call, id: string) => until(async () => {
  const w = await work(me, id);
  return w.runs[0] && !w.active && !(await me(`/api/sessions/${id}`)).data.running ? w : undefined;
}, 'the run to end');

describe('outcomes', () => {
  it('turns a chat into work and back without moving it (journey 7)', async () => {
    await start(new Driven([[/./, [say('Sure.')]]]));
    const me = await device();
    const shop = (await me('/api/projects', { name: 'Shop' })).data.project;
    const older = (await me('/api/sessions', { text: 'first chat', project: shop.slug })).data;
    await until(async () => !(await me(`/api/sessions/${older.id}`)).data.running && true);
    const chat = (await me('/api/sessions', { text: 'the import keeps dropping people', project: shop.slug })).data;
    await until(async () => !(await me(`/api/sessions/${chat.id}`)).data.running && true);
    const order = async () => (await me('/api/state')).data.sessions.map((s: { id: string }) => s.id);
    const before = await order();
    expect((await me('/api/state')).data.sessions.find((s: { id: string }) => s.id === chat.id).work).toBeNull();

    await me(`/api/sessions/${chat.id}/outcome`, { text: 'Fix the CRM data import' });
    expect(await order()).toEqual(before);
    const row = (await me('/api/state')).data.sessions.find((s: { id: string }) => s.id === chat.id);
    expect(row).toMatchObject({ id: chat.id, work: { outcome: 'Fix the CRM data import', run: null } });

    // Dropping it is a chat again; runs made meanwhile stay.
    polyphemus.store.runs.startRun(chat.id, polyphemus.store.runs.outcome(chat.id)!.id, 'person:x');
    polyphemus.store.runs.setRunStatus(polyphemus.store.runs.latestRun(chat.id)!.id, 'failed', 'test');
    await me(`/api/sessions/${chat.id}/outcome`, { drop: true });
    expect(await order()).toEqual(before);
    expect((await me('/api/state')).data.sessions.find((s: { id: string }) => s.id === chat.id).work).toBeNull();
    expect((await work(me, chat.id)).runs).toHaveLength(1);
  });

  it('lets an agent offer, and only someone who can work there accept', async () => {
    await start(new Driven([[/fix it properly/, [call('propose_outcome', { outcome: 'Fix the CRM data import', why: 'It takes several steps and a write.' }), say('I can track this as work if you like.')]]]));
    const me = await device();
    const shop = (await me('/api/projects', { name: 'Shop' })).data.project;
    const val = polyphemus.store.addPerson('Val');
    polyphemus.store.setProjectRole(shop.slug, val.id, 'viewer');
    const viewer = await device(val);
    const thread = (await me('/api/sessions', { text: 'can you fix it properly?', project: shop.slug, agent: 'bd' })).data;
    const offer = await until(async () => (await me('/api/state')).data.questions.find((q: { kind: string }) => q.kind === 'outcome'), 'the offer');
    expect(offer).toMatchObject({ text: 'Fix the CRM data import', agentTitle: 'BD', sessionId: thread.id });
    expect((await viewer(`/api/questions/${offer.id}`, { answer: 'track' })).status).toBe(403);
    expect((await me(`/api/questions/${offer.id}`, { answer: 'track' })).status).toBe(200);
    expect((await work(me, thread.id)).outcome).toMatchObject({ text: 'Fix the CRM data import', setBy: 'agent:bd', proposedBy: 'agent:bd' });
  });
});

describe('runs', () => {
  it('plans, gathers evidence polyphemus checked, stops at a gate, and is done only when it’s all confirmed', async () => {
    const provider = new Driven([
      [/starting run 1/, [call('plan_run', { steps: [{ title: 'Write the report', kind: 'work' }, { title: 'Check the report', kind: 'verify', verifies: 1 }, { title: 'Send it', kind: 'gate', asks: 'Email the report to the team' }] }), say('Planned.')]],
      [/step 1 of 3/, [call('write_file', { path: 'report.md', content: '# Q3\n52 contacts\n' }), call('record_evidence', { path: 'report.md' }), say('Wrote it.')]],
      [/step 2 of 3/, [call('record_evidence', { path: 'report.md' }), call('record_check', { passed: true, what: 'report.md exists and lists 52 contacts' }), say('Checked.')]],
    ]);
    await start(provider);
    const me = await device();
    const shop = (await me('/api/projects', { name: 'Shop' })).data.project;
    const thread = (await me('/api/sessions', { text: 'write the Q3 report', project: shop.slug, agent: 'bd', yolo: true })).data;
    await until(async () => !(await me(`/api/sessions/${thread.id}`)).data.running && true);
    await me(`/api/sessions/${thread.id}/outcome`, { text: 'Q3 report sent' });
    expect((await me(`/api/sessions/${thread.id}/run`, {})).status).toBe(200);

    const gate = await until(async () => (await me('/api/state')).data.questions.find((q: { kind: string }) => q.kind === 'gate'), 'the gate');
    expect(gate).toMatchObject({ asks: 'Email the report to the team', step: 3, of: 3, run: 1 });
    let w = await work(me, thread.id);
    expect(w.runs[0]).toMatchObject({ n: 1, status: 'waiting' });
    expect(w.runs[0].steps.map((s: { status: string }) => s.status)).toEqual(['done', 'done', 'waiting']);
    expect(w.runs[0].steps[0].evidence).toEqual([expect.objectContaining({ kind: 'file', label: 'report.md', ok: true })]);
    expect(w.runs[0].steps[0].evidence[0].receipt).toBeUndefined(); // a file only this computer vouches for is local
    expect(w.runs[0].steps[1]).toMatchObject({ check: { passed: true, what: 'report.md exists and lists 52 contacts' } });
    expect((await me('/api/state')).data.sessions.find((s: { id: string }) => s.id === thread.id).work).toMatchObject({ status: 'waiting', run: 1, step: 3, steps: 3, gate: true });

    expect((await me(`/api/questions/${gate.id}`, { answer: 'approve' })).status).toBe(200);
    w = await settled(me, thread.id);
    expect(w.runs[0]).toMatchObject({ status: 'done' });
    expect(w.runs[0].steps[2]).toMatchObject({ status: 'done', reason: expect.stringMatching(/^Allowed by /), answeredByName: expect.any(String) });
  });

  it('calls a step that ended with nothing to check unknown, not done', async () => {
    await start(new Driven([
      [/starting run 1/, [call('plan_run', { steps: [{ title: 'Update HubSpot', kind: 'work' }] }), say('Planned.')]],
      [/step 1 of 1/, [say('Updated 52 records in HubSpot.')]],
    ]));
    const me = await device();
    const shop = (await me('/api/projects', { name: 'Shop' })).data.project;
    const thread = (await me('/api/sessions', { text: 'hi', project: shop.slug })).data;
    await until(async () => !(await me(`/api/sessions/${thread.id}`)).data.running && true);
    await me(`/api/sessions/${thread.id}/outcome`, { text: 'HubSpot updated' });
    await me(`/api/sessions/${thread.id}/run`, {});
    const w = await settled(me, thread.id);
    expect(w.runs[0].steps[0]).toMatchObject({ status: 'unknown', reason: expect.stringContaining('without anything polyphemus could check') });
    expect(w.runs[0].status).toBe('unknown');
  });

  it('fails a step on the real 401 whatever the agent claims, catches it in verify, and keeps run 1 when run 2 starts (journeys 8 and 9)', async () => {
    const provider = new Driven([
      [/starting run \d/, [call('plan_run', { steps: [{ title: 'Write 52 contacts to HubSpot', kind: 'work' }, { title: 'Read them back', kind: 'verify', verifies: 1 }] }), say('Planned.')]],
      [/step 1 of 2/, [call('hubspot__write_contacts', { count: 52 }), say('I wrote all 52 records to HubSpot.')]],
      [/step 2 of 2/, [call('hubspot__read_contacts'), call('record_check', { passed: true, what: 'all 52 are there' }), say('Verified.')]],
    ]);
    await start(provider);
    const me = await device();
    const shop = (await me('/api/projects', { name: 'Shop' })).data.project;
    await me('/api/connections', { name: 'HubSpot', kind: 'stdio', command: process.execPath, args: [FIXTURE], secrets: { CONTACTS_TOKEN: 'expired-token' } });
    // Listed while the token worked, then it expired.
    await me('/api/connections/hubspot/reconnect', { secrets: { CONTACTS_TOKEN: 'good' } });
    await me('/api/connections/hubspot/grant', { project: shop.slug, tools: ['read_contacts', 'write_contacts'] });
    await me('/api/connections/hubspot/reconnect', { secrets: { CONTACTS_TOKEN: 'expired-again' } });

    const thread = (await me('/api/sessions', { text: 'hi', project: shop.slug, agent: 'bd', yolo: true })).data;
    await until(async () => !(await me(`/api/sessions/${thread.id}`)).data.running && true);
    await me(`/api/sessions/${thread.id}/outcome`, { text: 'Contacts written to HubSpot' });
    await me(`/api/sessions/${thread.id}/run`, {});
    let w = await settled(me, thread.id);

    const [write, verify] = w.runs[0].steps;
    expect(write).toMatchObject({ status: 'failed', reason: expect.stringContaining('401') });
    expect(write.evidence).toEqual([expect.objectContaining({ kind: 'call', label: 'HubSpot write_contacts', ok: false, detail: expect.stringContaining('401') })]);
    expect(verify).toMatchObject({ status: 'failed', reason: expect.stringContaining('Step 1 isn’t done') });
    expect(w.runs[0]).toMatchObject({ n: 1, status: 'failed' });
    // What the agent said is still in the thread; it just isn't the status.
    expect(JSON.stringify((await me(`/api/sessions/${thread.id}`)).data.messages)).toContain('I wrote all 52 records');
    expect((await me('/api/state')).data.connectionIssues).toEqual([expect.objectContaining({ id: 'hubspot', errorKind: 'auth' })]);

    // Signed in again, run 2 goes through — and run 1 is still there, as it was.
    await me('/api/connections/hubspot/reconnect', { secrets: { CONTACTS_TOKEN: 'good' } });
    await me(`/api/sessions/${thread.id}/run`, {});
    w = await until(async () => {
      const x = await work(me, thread.id);
      return x.runs.length === 2 && !x.active ? x : undefined;
    }, 'run 2');
    expect(w.runs.map((r: { n: number; status: string }) => [r.n, r.status])).toEqual([[2, 'done'], [1, 'failed']]);
    expect(w.runs[0].steps[0].evidence[0]).toMatchObject({ ok: true, receipt: 'HubSpot answered' });
    expect(w.runs[1].steps[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('401') });
  });

  it('comes back from a restart with its evidence intact and the step interrupted, never running (journey 10)', async () => {
    const provider = new Driven([
      [/starting run 1/, [call('plan_run', { steps: [{ title: 'Export and upload', kind: 'work' }] }), say('Planned.')]],
      [/step 1 of 1/, [call('record_evidence', { path: 'export.csv' }), say('Uploading…')]],
    ]);
    let hanging = false;
    provider.hang = (signal) => new Promise((resolve) => {
      hanging = true;
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    await start(provider);
    const me = await device();
    const shop = (await me('/api/projects', { name: 'Shop' })).data.project;
    writeFileSync(join(shop.path, 'export.csv'), 'a,b\n1,2\n');
    const thread = (await me('/api/sessions', { text: 'hi', project: shop.slug })).data;
    await until(async () => !(await me(`/api/sessions/${thread.id}`)).data.running && true);
    await me(`/api/sessions/${thread.id}/outcome`, { text: 'Export uploaded' });
    await me(`/api/sessions/${thread.id}/run`, {});
    await until(async () => hanging, 'the step to be mid-way');
    expect((await work(me, thread.id)).runs[0].steps[0]).toMatchObject({ status: 'running', evidence: [expect.objectContaining({ label: 'export.csv' })] });

    // The daemon goes away mid-step, and comes back.
    await daemon.close();
    polyphemus.close();
    await start(new Driven([]));
    const again = await device();
    const w = await work(again, thread.id);
    expect(w.active).toBeNull();
    expect(w.runs[0]).toMatchObject({ status: 'interrupted', reason: 'polyphemus restarted while it was running.' });
    expect(w.runs[0].steps[0]).toMatchObject({ status: 'interrupted', evidence: [expect.objectContaining({ kind: 'file', label: 'export.csv', ok: true })] });
    expect((await again('/api/state')).data.sessions.find((s: { id: string }) => s.id === thread.id).work).toMatchObject({ status: 'interrupted' });
  });
});
