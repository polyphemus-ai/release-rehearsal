import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, emptyUsage, Polyphemus, type Block, type ChatRequest, type Message, type ModelProvider, type ProviderEvent, type StopReason } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';
import { fakeGitHub, makeIdentity } from './fake-github.js';

// Intake (roadmap: it does the work, 4): feedback, ideas and findings land as threads waiting on a
// person; making work of one has an agent shape it into pieces, you keep the ones you want, and
// they're filed — GitHub issues by the Planner, or work items in a project with no repository.

type Reply = { content: Block[]; stopReason: StopReason };
const say = (text: string): Reply => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' });
const call = (name: string, input: Record<string, unknown>): Reply => ({ content: [{ type: 'tool_call', id: `c${Math.random().toString(36).slice(2)}`, name, input }], stopReason: 'tool_use' });

class Sessions implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'openai';
  prompts: string[] = [];
  /** What each turn was told about itself: the system prompt, for checking what an agent remembers. */
  systems: string[] = [];
  constructor(public plan: (prompt: string) => Reply[]) {}
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    const users = req.messages.filter((m: Message) => m.role === 'user');
    const prompt = users.map((m) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')).join('\n');
    const answered = req.messages.filter((m: Message) => m.role === 'assistant').length;
    if (answered === 0) this.prompts.push(prompt);
    this.systems.push(req.system ?? '');
    const reply = this.plan(prompt)[answered] ?? say('ok');
    yield { type: 'message_done', message: { role: 'assistant', content: reply.content, origin: { provider: 'openai', model: req.model } }, stopReason: reply.stopReason, usage: emptyUsage() };
  }
  async listModels() {
    return [];
  }
}

const SHAPED = call('submit', {
  summary: 'CSV exports break on commas.',
  items: [
    { title: 'Quote fields with commas in exports', body: 'Fields holding commas split the row.', acceptance: ['A field with a comma round-trips'], size: 'small' },
    { title: 'Rewrite the exporter', body: 'Not asked for.', size: 'large' },
    { title: 'Add an export test with real data', body: 'Use the March file.', acceptance: ['The test fails on the old exporter'] },
  ],
});

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let base: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-intake-'));
  Object.assign(process.env, { CODEX_HOME: join(home, 'no-codex'), OPENAI_API_KEY: 'test-key', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\ndefault_model = "gpt-api"\n${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
});
afterEach(async () => {
  await daemon?.close().catch(() => {});
  polyphemus?.close();
  process.env = { ...savedEnv };
});

async function start(provider: ModelProvider) {
  polyphemus = await Polyphemus.open(home);
  polyphemus.registry.use('openai', provider);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;
  const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
  const me = async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
  return { me, cookie };
}

async function until<T>(check: () => Promise<T | undefined | false>, what: string, tries = 500): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Me = Awaited<ReturnType<typeof start>>['me'];
const questions = async (me: Me, kind: string) => (await me('/api/state')).data.questions.filter((q: { kind: string }) => q.kind === kind);
const runOf = async (me: Me, id: string) => (await me(`/api/sessions/${id}`)).data.work?.runs?.[0];

describe('intake', () => {
  it('lands a request waiting on a person, and making work of it keeps only the pieces you pick, as work items', async () => {
    const provider = new Sessions((prompt) => (prompt.includes('came in for this project') ? [SHAPED, say('Submitted.')] : []));
    const { me } = await start(provider);
    const project = (await me('/api/projects', { name: 'Exports' })).data.project;

    const landed = await me(`/api/projects/${project.slug}/incoming`, { kind: 'feedback', text: 'The CSV export breaks when a name has a comma in it.' });
    expect(landed.status).toBe(201);
    // Nothing runs yet: a thread holding the words, and a card on Home.
    const [card] = await questions(me, 'incoming');
    expect(card).toMatchObject({ sessionId: landed.data.id, kindTitle: 'Feedback', text: expect.stringContaining('comma'), fromName: expect.any(String) });
    const row = (await me('/api/state')).data.sessions.find((s: { id: string }) => s.id === landed.data.id);
    expect(row).toMatchObject({ title: expect.stringMatching(/^Feedback: The CSV export/), project: project.slug, waiting: true, work: null });
    expect(provider.prompts).toEqual([]);

    await me(`/api/questions/${card.id}`, { answer: 'work' });
    const gate = await until(async () => (await questions(me, 'gate'))[0], 'the pick gate');
    expect(gate.options.map((o: { label: string }) => o.label)).toEqual(['Quote fields with commas in exports', 'Rewrite the exporter', 'Add an export test with real data']);
    expect(gate.asks).toContain('made into work items in this project');
    // The agent read the request as someone's words, not instructions.
    expect(provider.prompts[0]).toContain('<request kind="feedback"');

    // Keeping none isn't allowing it.
    expect((await me(`/api/questions/${gate.id}`, { answer: 'approve', picked: [] })).status).toBe(400);
    expect((await me(`/api/questions/${gate.id}`, { answer: 'approve', picked: ['0', '2', 'made-up'] })).status).toBe(200);
    const run = await until(async () => {
      const r = await runOf(me, landed.data.id);
      return r?.status === 'done' ? r : undefined;
    }, 'the run to finish');
    expect(run.steps.map((s: { title: string; status: string; reason?: string }) => [s.title, s.status, s.reason ?? null])).toEqual([
      ['Where it goes', 'done', 'Work items in this project.'],
      ['Shape it', 'done', null],
      ['Which to keep?', 'done', expect.stringMatching(/kept 2 of 3\.$/)],
      ['File them', 'done', 'Made 2 work items in this project.'],
    ]);

    // Two work items, each its own thread with an outcome, in the project, not started.
    const sessions = (await me('/api/state')).data.sessions;
    const items = sessions.filter((s: { spunFrom?: string }) => s.spunFrom === landed.data.id);
    expect(items.map((s: { title: string }) => s.title).sort()).toEqual(['Add an export test with real data', 'Quote fields with commas in exports']);
    for (const item of items) {
      expect(item).toMatchObject({ project: project.slug, work: { outcome: item.title, status: null } });
      const detail = (await me(`/api/sessions/${item.id}`)).data;
      expect(JSON.stringify(detail.messages)).toContain('Done when:');
    }
  });

  it('dismissing puts the thread away without spending anything', async () => {
    const provider = new Sessions(() => [SHAPED]);
    const { me } = await start(provider);
    const project = (await me('/api/projects', { name: 'Ideas' })).data.project;
    const landed = await me(`/api/projects/${project.slug}/incoming`, { kind: 'idea', text: 'Dark mode for the export page' });
    const [card] = await questions(me, 'incoming');
    expect((await me(`/api/questions/${card.id}`, { answer: 'dismiss' })).status).toBe(200);
    expect(await questions(me, 'incoming')).toEqual([]);
    expect((await me('/api/state')).data.sessions.some((s: { id: string }) => s.id === landed.data.id)).toBe(false);
    expect(polyphemus.store.get(landed.data.id)?.archivedAt).toBeTruthy();
    expect(provider.prompts).toEqual([]);
    expect((await me(`/api/projects/${project.slug}/incoming`, { text: '  ' })).status).toBe(400);
  });

  it('files the picked pieces as GitHub issues by the Planner when the project has a repository', async () => {
    const gh = fakeGitHub(home);
    const web = await gh.start();
    Object.assign(process.env, { POLYPHEMUS_GITHUB_API: web, POLYPHEMUS_GITHUB_WEB: web });
    try {
      const { me, cookie } = await start(new Sessions((prompt) => (prompt.includes('came in for this project') ? [SHAPED, say('Submitted.')] : [])));
      const project = (await me('/api/projects', { name: 'Ledger', from: gh.bare })).data.project;
      gh.git('-C', project.path, 'remote', 'set-url', 'origin', 'git@github.com:acme/site.git');
      const planner = await makeIdentity(base, cookie, 'planner', 66);
      const tools = (await me(`/api/connections/${planner}`)).data.connection.tools.map((t: { name: string }) => t.name);
      await me(`/api/connections/${planner}/grant`, { project: project.slug, tools });
      // Filed already, by hand or an earlier attempt: not filed twice.
      gh.seen.issues.push({ number: 99, title: 'Add an export test with real data', body: '', by: 'alex' });

      const landed = await me(`/api/projects/${project.slug}/incoming`, { kind: 'finding', text: 'Exports split rows on commas.' });
      const [card] = await questions(me, 'incoming');
      await me(`/api/questions/${card.id}`, { answer: 'work' });
      const gate = await until(async () => (await questions(me, 'gate'))[0], 'the pick gate');
      expect(gate.asks).toContain('filed as GitHub issues in acme/site by the Planner');
      await me(`/api/questions/${gate.id}`, { answer: 'approve', picked: ['0', '2'] });
      const run = await until(async () => {
        const r = await runOf(me, landed.data.id);
        return ['done', 'failed'].includes(r?.status) ? r : undefined;
      }, 'the run to finish');
      expect(run.status).toBe('done');
      expect(gh.seen.issues.map((i) => [i.number, i.title, i.by])).toEqual([
        [99, 'Add an export test with real data', 'alex'],
        [101, 'Quote fields with commas in exports', 'polyphemus-app-1[bot]'],
      ]);
      expect(gh.seen.issues[1]!.body).toContain('- [ ] A field with a comma round-trips');
      expect(run.steps.at(-1).reason).toBe('Filed #101, #99 in acme/site, as polyphemus App 1.');
      // What was filed comes with the step, so each issue is one tap from shipping.
      expect(run.steps.at(-1).filedIssues).toEqual({ repo: 'acme/site', numbers: [101, 99] });
    } finally {
      await gh.stop();
    }
  });

  it('sending the choice back ends the run with nothing filed', async () => {
    const { me } = await start(new Sessions((prompt) => (prompt.includes('came in for this project') ? [SHAPED, say('Submitted.')] : [])));
    const project = (await me('/api/projects', { name: 'Back' })).data.project;
    const landed = await me(`/api/projects/${project.slug}/incoming`, { text: 'Something vague' });
    await me(`/api/questions/${(await questions(me, 'incoming'))[0].id}`, { answer: 'work' });
    const gate = await until(async () => (await questions(me, 'gate'))[0], 'the pick gate');
    await me(`/api/questions/${gate.id}`, { answer: 'decline', note: 'Too vague to act on' });
    const run = await until(async () => {
      const r = await runOf(me, landed.data.id);
      return r?.status === 'failed' ? r : undefined;
    }, 'the run to end');
    expect(run.reason).toContain('Too vague to act on');
    expect((await me('/api/state')).data.sessions.filter((s: { spunFrom?: string }) => s.spunFrom === landed.data.id)).toEqual([]);
  });

  it('lets an agent working in a project propose what it found, which waits on a person', async () => {
    const provider = new Sessions((prompt) => (prompt.includes('Audit the exporter') ? [call('propose_work', { kind: 'finding', text: 'The exporter never escapes quotes.' }), say('Found one thing; proposed it.')] : []));
    const { me } = await start(provider);
    const project = (await me('/api/projects', { name: 'Audit' })).data.project;
    const thread = (await me('/api/sessions', { text: 'Audit the exporter', project: project.slug })).data;
    const card = await until(async () => (await questions(me, 'incoming'))[0], 'the proposal');
    expect(card).toMatchObject({ kindTitle: 'Finding', text: 'The exporter never escapes quotes.' });
    expect(polyphemus.store.get(card.sessionId)).toMatchObject({ spunFrom: thread.id, cwd: project.path });
  });

  it('keeps what an agent learns where it was learned: with you alone, in the project, or anywhere', async () => {
    const provider = new Sessions((prompt) =>
      prompt.includes('What did you learn')
        ? [
            call('remember', { name: 'What Alex worries about', description: 'Before drafting anything public.', text: 'They’re nervous the launch slips.', scope: 'private' }),
            call('remember', { name: 'What gets replies', description: 'Before writing a post.', text: 'Posts ending in a question get replies.', scope: 'craft' }),
            say('Proposed.'),
          ]
        : [],
    );
    const { me } = await start(provider);
    expect((await me('/api/agents', { name: 'bd', description: 'the pipeline', model: 'gpt-api' })).status).toBe(201);
    const project = (await me('/api/projects', { name: 'Launch' })).data.project;
    const thread = (await me('/api/sessions', { text: 'What did you learn', project: project.slug, agent: 'bd' })).data;
    await until(async () => (await questions(me, 'note')).length === 2 && !(await me(`/api/sessions/${thread.id}`)).data.running, 'both proposals');
    const [own, craft] = await questions(me, 'note');
    // Alone with it in a project: all three are on offer, with what it proposed first.
    expect(own).toMatchObject({ agent: 'bd', name: 'What Alex worries about', scope: 'private', scopes: ['private', 'project', 'craft'] });
    expect(craft).toMatchObject({ name: 'What gets replies', scope: 'craft' });
    const person = polyphemus.store.installOwner().id;
    const notes = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
    const privateDir = join(home, 'memory', 'agents', 'bd', 'people', person);
    const craftDir = join(home, 'memory', 'agents', 'bd', 'craft');
    expect(notes(privateDir)).toEqual([]);

    expect((await me(`/api/questions/${own.id}`, { answer: 'private' })).status).toBe(200);
    expect((await me(`/api/questions/${craft.id}`, { answer: 'craft' })).status).toBe(200);
    expect(notes(privateDir)).toEqual(['what-alex-worries-about.md']);
    expect(notes(craftDir)).toEqual(['what-gets-replies.md']);
    expect(readFileSync(join(craftDir, 'what-gets-replies.md'), 'utf8')).toContain('description: Before writing a post.');

    // Alone with it again: it's told both.
    provider.systems = [];
    const again = (await me('/api/sessions', { text: 'anything else', project: project.slug, agent: 'bd' })).data;
    await until(async () => (provider.systems.length ? true : undefined), 'the next turn');
    expect(provider.systems[0]).toContain('what-alex-worries-about.md');
    expect(provider.systems[0]).toContain('what-gets-replies.md');
    expect(polyphemus.store.get(again.id)).toBeDefined();

    // Someone else in the room — another agent — and what you told it privately isn't there at all.
    expect((await me('/api/agents', { name: 'pal', description: 'another one', model: 'gpt-api' })).status).toBe(201);
    provider.systems = [];
    await me('/api/sessions', { text: 'anything else', project: project.slug, agent: 'bd', with: ['pal'] });
    await until(async () => (provider.systems.length ? true : undefined), 'the group turn');
    expect(provider.systems.join('\n')).not.toContain('what-alex-worries-about.md');
    expect(provider.systems.join('\n')).toContain('what-gets-replies.md');
  });

  it('lets an agent propose a change to its own profile, which a person accepts before it takes effect', async () => {
    const provider = new Sessions((prompt) =>
      prompt.includes('Rewrite yourself')
        ? [
            call('propose_profile', { why: 'Nothing to change.', description: 'the pipeline' }),
            call('propose_profile', { why: 'I post now; my profile says I don’t.', persona: 'You are BD, and you post.', description: 'posts as the account' }),
            call('propose_profile', { why: 'Again.', persona: 'Once more.' }),
            say('Proposed.'),
          ]
        : [],
    );
    const { me } = await start(provider);
    const project = (await me('/api/projects', { name: 'Voice' })).data.project;
    expect((await me('/api/agents', { name: 'bd', description: 'the pipeline', model: 'gpt-api' })).status).toBe(201);
    const before = (await me('/api/agents/bd')).data.agent;
    const thread = (await me('/api/sessions', { text: 'Rewrite yourself', project: project.slug, agent: 'bd' })).data;
    const card = await until(async () => (await questions(me, 'profile'))[0], 'the proposal');
    await until(async () => !(await me(`/api/sessions/${thread.id}`)).data.running, 'the turn to end');
    const results = polyphemus.store.messages(thread.id).flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => String((b as { content: unknown }).content));
    expect(results[0]).toContain('what your profile says already');
    expect(results[2]).toContain('already proposed');
    expect(card).toMatchObject({ agent: 'bd', agentTitle: before.title, why: 'I post now; my profile says I don’t.' });
    expect(card.fields.map((f: { field: string }) => f.field)).toEqual(['persona', 'description']);
    expect(card.fields[0]).toMatchObject({ before: before.persona, after: 'You are BD, and you post.' });
    // Nothing changes until it's accepted.
    expect((await me('/api/agents/bd')).data.agent).toMatchObject({ persona: before.persona, description: before.description });

    expect((await me(`/api/questions/${card.id}`, { answer: 'accept' })).status).toBe(200);
    expect((await me('/api/agents/bd')).data.agent).toMatchObject({ persona: 'You are BD, and you post.', description: 'posts as the account' });
  });

  it('lets an agent propose a routine, which only exists once a person accepts it — never one that runs without asking', async () => {
    const schedule = { name: 'Daily post', description: 'Three posts a day.', prompt: 'Draft today’s post and log it in post-log.md.', cron: '17 9,14,19 * * *', tz: 'America/Chicago' };
    const provider = new Sessions((prompt) =>
      prompt.includes('Schedule the posts')
        ? [
            call('propose_routine', { name: 'Daily post', prompt: 'Post.' }),
            call('propose_routine', { ...schedule, cron: 'not a cron' }),
            call('propose_routine', { ...schedule, mode: 'yolo' }),
            call('propose_routine', schedule),
            say('Proposed.'),
          ]
        : [],
    );
    const { me } = await start(provider);
    const project = (await me('/api/projects', { name: 'Riley' })).data.project;
    const thread = (await me('/api/sessions', { text: 'Schedule the posts', project: project.slug })).data;
    const card = await until(async () => (await questions(me, 'routine'))[0], 'the proposal');
    await until(async () => !(await me(`/api/sessions/${thread.id}`)).data.running, 'the turn to end');
    const results = polyphemus.store.messages(thread.id).flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => String((b as { content: unknown }).content));
    expect(results[0]).toContain('exactly one schedule');
    expect(results[1]).toContain('isn’t valid');
    // Asked for yolo: proposed as ask anyway.
    expect(results[2]).toContain('Proposed daily-post');
    expect(results[3]).toContain('already proposed');
    expect(card).toMatchObject({ name: 'daily-post', project: project.slug, mode: 'ask', schedule: 'cron "17 9,14,19 * * *" (America/Chicago)', prompt: 'Draft today’s post and log it in post-log.md.' });
    expect((await me('/api/state')).data.routines).toEqual([]);
    const file = join(project.path, '.polyphemus', 'routines', 'daily-post.md');
    expect(existsSync(file)).toBe(false);

    expect((await me(`/api/questions/${card.id}`, { answer: 'accept' })).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toMatch(/mode: ask/);
    expect(readFileSync(file, 'utf8')).not.toMatch(/yolo/);
    const routine = (await me('/api/state')).data.routines.find((r: { id: string }) => r.id === `${project.slug}/daily-post`);
    expect(routine).toMatchObject({ name: 'daily-post', project: project.slug, agent: polyphemus.store.get(thread.id)?.agent || null });
    expect((await me(`/api/questions/${card.id}`, { answer: 'accept' })).status).toBe(409);
  });

  it('lets a person say what a routine asks before doing, without editing its file', async () => {
    // An agent proposed a routine for 7am and then had to ask the owner to hand-edit YAML to make
    // it run unattended, because nothing on the screen said it (2026-09-20).
    const { me } = await start(new Sessions(() => []));
    const project = (await me('/api/projects', { name: 'Riley' })).data.project;
    const file = join(project.path, '.polyphemus', 'routines', 'check.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '---\ndescription: a check\nmode: ask\ntriggers: [{ cron: "0 7 * * 1,4", tz: America/Chicago }]\nnotify: [failure]\n---\nPull the numbers and say what needs me.\n');
    const id = `${project.slug}/check`;
    await until(async () => ((await me('/api/state')).data.routines.some((r: { id: string }) => r.id === id) ? true : undefined), 'the routine to load');

    // Telling you when it finishes: anyone who works here.
    expect((await me(`/api/routines/${encodeURIComponent(id)}/settings`, { notify: true })).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toMatch(/notify:\n\s+- finish\n\s+- failure/);
    // The prompt below the settings is left exactly as it was.
    expect(readFileSync(file, 'utf8')).toContain('Pull the numbers and say what needs me.');

    // Running without asking is the owner's.
    const sam = polyphemus.store.addPerson('Sam');
    polyphemus.store.setProjectRole(project.slug, sam.id, 'member');
    const samCookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode(undefined, sam.id)}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const asSam = await fetch(`${base}/api/routines/${encodeURIComponent(id)}/settings`, { method: 'POST', headers: { cookie: samCookie, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'yolo' }) });
    expect(asSam.status).toBe(403);
    expect((await me(`/api/routines/${encodeURIComponent(id)}/settings`, { mode: 'yolo' })).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toMatch(/mode: yolo/);

    // Changed by a person is accepted by them: it doesn't sit waiting for their own edit.
    const after = (await me('/api/state')).data.routines.find((r: { id: string }) => r.id === id);
    expect(after).toMatchObject({ waiting: false });

    // Paused on purpose isn't waiting on anyone: the app shows no card for it (2026-09-22).
    expect((await me(`/api/routines/${encodeURIComponent(id)}/pause`, { paused: true })).status).toBe(200);
    expect((await me('/api/state')).data.routines.find((r: { id: string }) => r.id === id)).toMatchObject({ paused: true, pausedOnPurpose: true });
    expect((await me(`/api/routines/${encodeURIComponent(id)}/pause`, { paused: false })).status).toBe(200);
    expect((await me('/api/state')).data.routines.find((r: { id: string }) => r.id === id)).toMatchObject({ paused: false, pausedOnPurpose: false });
  });

  it('lets an agent make a routine personal from a project, change one, and stop one', async () => {
    // From the website thread: a check of every agent's usage was written into the website project,
    // so each run was website work; and an agent that couldn't change or remove a routine proposed
    // a second one on the same schedule (2026-09-20/21).
    const check = { name: 'Model headroom', description: 'Twice a day.', prompt: 'Check every agent’s usage and say which will run out.', cron: '15 7,19 * * *', tz: 'America/Chicago' };
    const provider = new Sessions((prompt) =>
      prompt.includes('Make the check')
        ? [call('propose_routine', { ...check, scope: 'personal' }), say('Proposed.')]
        : prompt.includes('Change the check')
          ? [call('propose_routine', { ...check, scope: 'personal', prompt: 'Check usage, and only speak up when one runs out before its reset.' }), say('Proposed a change.')]
          : prompt.includes('Stop the check')
            ? [call('propose_routine', { name: 'Model headroom', scope: 'personal', stop: true, description: 'Not needed any more.' }), say('Proposed stopping it.')]
            : [],
    );
    const { me } = await start(provider);
    const project = (await me('/api/projects', { name: 'Website' })).data.project;
    const propose = async (text: string) => {
      const thread = (await me('/api/sessions', { text, project: project.slug })).data;
      await until(async () => !(await me(`/api/sessions/${thread.id}`)).data.running, 'the turn to end');
      return until(async () => (await questions(me, 'routine'))[0], 'the proposal');
    };

    // Personal: the person's own, run outside the project, with none of its rules.
    const first = await propose('Make the check');
    expect(first).toMatchObject({ name: 'model-headroom', project: '', projectName: '' });
    expect((await me(`/api/questions/${first.id}`, { answer: 'accept' })).status).toBe(200);
    const file = join(home, 'routines', 'model-headroom.md');
    expect(readFileSync(file, 'utf8')).not.toContain(project.path);
    expect(existsSync(join(project.path, '.polyphemus', 'routines', 'model-headroom.md'))).toBe(false);

    // The same name again is a change to it: accepting puts the new one in its place.
    const change = await propose('Change the check');
    expect(change).toMatchObject({ name: 'model-headroom', replaces: true });
    expect((await me(`/api/questions/${change.id}`, { answer: 'accept' })).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toContain('only speak up when one runs out');

    // Stopping it: gone once accepted, kept aside in the trash.
    const stop = await propose('Stop the check');
    expect(stop).toMatchObject({ name: 'model-headroom', stop: true });
    expect(existsSync(file)).toBe(true);
    expect((await me(`/api/questions/${stop.id}`, { answer: 'accept' })).status).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(join(home, 'trash', 'routines')).filter((f) => f.startsWith('~--model-headroom-'))).toHaveLength(2);
  }, 20_000);

  it('lets an agent in a thread outside every project propose one for the install', async () => {
    // An agent working in Direct had no way to ask for a routine at all: the tool wasn't offered, and
    // it told the owner to run a CLI command that doesn't exist (2026-09-20).
    const provider = new Sessions((prompt) =>
      prompt.includes('Check the accounts')
        ? [call('propose_routine', { name: 'Check-in', description: 'Twice a week.', prompt: 'Pull two weeks of transactions and say what needs me.', cron: '0 7 * * 1,4', tz: 'America/Chicago' }), say('Proposed.')]
        : [],
    );
    const { me } = await start(provider);
    const thread = (await me('/api/sessions', { text: 'Check the accounts' })).data;
    await until(async () => !(await me(`/api/sessions/${thread.id}`)).data.running, 'the turn to end');
    const card = await until(async () => (await questions(me, 'routine'))[0], 'the proposal');
    expect(card).toMatchObject({ name: 'check-in', project: '', projectName: '', mode: 'ask' });
    const said = polyphemus.store.messages(thread.id).flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => String((b as { content: unknown }).content));
    expect(said[0]).toContain('outside every project');

    // It belongs to the install, so it's the owner's to allow — and someone else can't even see the
    // thread it was proposed in, so they're told nothing about it.
    const sam = polyphemus.store.addPerson('Sam');
    const samCookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode(undefined, sam.id)}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const refused = await fetch(`${base}/api/questions/${card.id}`, { method: 'POST', headers: { cookie: samCookie, 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'accept' }) });
    expect(refused.status).toBe(404);

    const file = join(home, 'routines', 'check-in.md');
    expect(existsSync(file)).toBe(false);
    expect((await me(`/api/questions/${card.id}`, { answer: 'accept' })).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toMatch(/mode: ask/);
    expect((await me('/api/state')).data.routines.find((r: { id: string }) => r.id === '~/check-in')).toMatchObject({ name: 'check-in' });
  });
});
