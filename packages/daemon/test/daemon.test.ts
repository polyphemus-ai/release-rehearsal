import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject, DEFAULT_CONFIG, emptyUsage, Polyphemus, type Block, type ChatRequest, type ModelProvider, type ProviderEvent, type StopReason } from '@polyphemus/core';
import type { PushPayload, PushSender } from '../src/push.js';
import { startDaemon, type Daemon } from '../src/server.js';

/** Plays back one assistant message per request. */
class ScriptedProvider implements ModelProvider {
  readonly kind = 'model' as const;
  constructor(
    readonly id: string,
    private steps: Array<{ content: Block[]; stopReason: StopReason }>,
  ) {}
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    const step = this.steps.shift() ?? { content: [{ type: 'text', text: '(script ran out)' }], stopReason: 'end_turn' as StopReason };
    yield { type: 'message_done', message: { role: 'assistant', content: step.content, origin: { provider: this.id, model: req.model } }, stopReason: step.stopReason, usage: emptyUsage() };
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

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-daemon-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';
  // New projects go in the test folder, never the real ~/projects.
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\n${DEFAULT_CONFIG.replace('accepted = []', '')}\n[isolation]\nlevel = "host"\n`);
  polyphemus = await Polyphemus.open(home);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home, revocationCheckMs: 50 });
  base = daemon.urls[0]!;
});
afterEach(async () => {
  await daemon.close();
  polyphemus.close();
  process.env = { ...savedEnv };
});

async function pairedCookie(): Promise<string> {
  const code = polyphemus.store.createPairingCode();
  const res = await fetch(`${base}/pair?code=${code}`, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 15) Mobile' } });
  expect(res.status).toBe(303);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

function client(cookie: string) {
  return async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, any> };
  };
}

async function until<T>(check: () => Promise<T | undefined>): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('timed out');
}

describe('daemon', () => {
  it('only lets paired devices in, and each pairing code works once', async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(401);
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/pair?code=wrong`, { redirect: 'manual' })).status).toBe(403);

    const code = polyphemus.store.createPairingCode();
    expect((await fetch(`${base}/pair?code=${code}`, { redirect: 'manual' })).status).toBe(303);
    expect((await fetch(`${base}/pair?code=${code}`, { redirect: 'manual' })).status).toBe(403);
    expect(polyphemus.store.listDevices()).toHaveLength(1);
  });

  it('pairs with a typed code however it’s typed, and refuses posts from other sites', async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain('name="code"'); // the unpaired page has a code box
    const code = polyphemus.store.createPairingCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
    const typed = ` ${code.toLowerCase().replaceAll('-', ' ')} `;
    const res = await fetch(`${base}/pair?code=${encodeURIComponent(typed)}`, { redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toContain('SameSite=Lax');
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;

    const post = (origin: string) => fetch(`${base}/api/push/test`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: '{}' });
    expect((await post('https://evil.example')).status).toBe(403);
    expect((await post(base)).status).toBe(200);
  });

  it('stops pairing after too many wrong codes', async () => {
    for (let i = 0; i < 20; i++) expect((await fetch(`${base}/pair?code=WRONG-${i}`, { redirect: 'manual' })).status).toBe(403);
    const code = polyphemus.store.createPairingCode();
    expect((await fetch(`${base}/pair?code=${code}`, { redirect: 'manual' })).status).toBe(429);
  });

  it('refuses revoked devices and non-JSON posts', async () => {
    const cookie = await pairedCookie();
    const call = client(cookie);
    expect((await call('/api/state')).status).toBe(200);
    const notJson = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { cookie, 'content-type': 'text/plain' }, body: '{}' });
    expect(notJson.status).toBe(415);

    const [device] = polyphemus.store.listDevices();
    expect(device?.name).toBe('Android phone');
    polyphemus.store.revokeDevice(device!.id);
    expect((await call('/api/state')).status).toBe(401);
  });

  it('cuts off a revoked device’s open event stream, not just its next request', async () => {
    const cookie = await pairedCookie();
    const stream = await fetch(`${base}/api/events`, { headers: { cookie } });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    await reader.read(); // ": connected"
    // Revoked the way `poly devices revoke` does it: straight in the database, from outside the daemon.
    polyphemus.store.revokeDevice(polyphemus.store.listDevices()[0]!.id);
    const ended = await Promise.race([
      (async () => {
        for (;;) if ((await reader.read()).done) return true;
      })(),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    expect(ended).toBe(true);
  });

  it('signs out another device from the app, but not the one you’re on', async () => {
    const mine = await pairedCookie();
    const other = await pairedCookie();
    const devices = polyphemus.store.listDevices();
    const [me, them] = [devices.at(-2)!, devices.at(-1)!];
    const post = (cookie: string, id: string) => fetch(`${base}/api/devices/${id}/revoke`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    expect((await post(mine, me.id)).status).toBe(400);
    expect((await post(mine, them.id)).status).toBe(200);
    expect((await fetch(`${base}/api/state`, { headers: { cookie: other } })).status).toBe(401);
    expect((await post(mine, 'nosuchdevice')).status).toBe(404);
  });

  it('marks the pairing cookie Secure when the page came over HTTPS', async () => {
    const plain = await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' });
    expect(plain.headers.get('set-cookie')).not.toContain('Secure');
    const proxied = await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual', headers: { 'x-forwarded-proto': 'https' } });
    expect(proxied.headers.get('set-cookie')).toContain('; Secure');
  });

  it('runs a session started from the phone', async () => {
    polyphemus.registry.use('openai', new ScriptedProvider('openai', [{ content: [{ type: 'text', text: 'hi from the daemon' }], stopReason: 'end_turn' }]));
    const call = client(await pairedCookie());

    const created = await call('/api/sessions', { text: 'hello', model: 'gpt-api', cwd: home });
    expect(created.status).toBe(201);
    const detail = await until(async () => {
      const { data } = await call(`/api/sessions/${created.data.id}`);
      return !data.running && data.messages.length === 2 ? data : undefined;
    });
    expect(detail.messages[1].content[0].text).toBe('hi from the daemon');
    expect(detail.turns).toEqual([expect.objectContaining({ endSeq: 2, stopReason: 'end_turn' })]);
    // When each message was written, for the times and date dividers in the conversation.
    expect(detail.times).toHaveLength(2);
    expect(detail.times[1]).toBeGreaterThanOrEqual(detail.times[0]);
    expect((await call('/api/state')).data.sessions[0].title).toBe('hello');
    // A real turn that worked is what makes a model "verified" on the Models screen.
    expect(polyphemus.store.modelResults().get(`openai:${detail.model.model}`)).toMatchObject({ lastOkAt: expect.any(Number) });
  });

  it('renames, archives, finds, and deletes threads, and won’t pull one out from under a running turn', async () => {
    polyphemus.registry.use(
      'openai',
      new ScriptedProvider('openai', [
        { content: [{ type: 'text', text: 'the invoice total is wrong' }], stopReason: 'end_turn' },
        { content: [{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'touch nope' } }], stopReason: 'tool_use' },
        { content: [{ type: 'text', text: 'skipped' }], stopReason: 'end_turn' },
      ]),
    );
    const cookie = await pairedCookie();
    const call = client(cookie);
    const { data: first } = await call('/api/sessions', { text: 'check the books', model: 'gpt-api', cwd: home });
    await until(async () => ((await call(`/api/sessions/${first.id}`)).data.messages.length === 2 ? true : undefined));
    // A thread goes compressed to a browser that takes it, and a light refresh leaves the conversation
    // out: megabytes re-fetched to see who's in it failed mid-conversation on a phone (2026-09-22).
    const whole = await fetch(`${base}/api/sessions/${first.id}`, { headers: { cookie, 'accept-encoding': 'gzip' } });
    expect(whole.headers.get('content-encoding')).toBe('gzip');
    expect(((await whole.json()) as { messages: unknown[] }).messages).toHaveLength(2);
    const light = (await call(`/api/sessions/${first.id}?light=1`)).data;
    expect(light.messages).toBeUndefined();
    expect(light.times).toBeUndefined();
    expect(light).toMatchObject({ meta: { id: first.id }, members: expect.any(Array), queued: [] });

    expect((await call(`/api/sessions/${first.id}/title`, { text: 'Invoices' })).data.title).toBe('Invoices');
    expect((await call('/api/sessions?q=invoice')).data.sessions).toMatchObject([{ id: first.id, title: 'Invoices', snippet: 'the invoice total is wrong' }]);

    expect((await call(`/api/sessions/${first.id}/archive`, { on: true })).status).toBe(200);
    const state = (await call('/api/state')).data;
    expect(state.sessions).toEqual([]);
    expect(state.archivedCount).toBe(1);
    expect((await call('/api/sessions?archived=1')).data.sessions).toMatchObject([{ id: first.id }]);
    expect((await call('/api/sessions?q=invoice')).data.sessions).toHaveLength(1); // search still finds it
    await call(`/api/sessions/${first.id}/archive`, { on: false });
    expect((await call('/api/state')).data.sessions).toMatchObject([{ id: first.id }]);

    // One that's waiting on you is mid-turn: refused, and nothing is lost.
    const { data: second } = await call('/api/sessions', { text: 'make a file', model: 'gpt-api', cwd: home });
    const question = await until(async () => (await call('/api/state')).data.questions[0]);
    expect((await call(`/api/sessions/${second.id}/delete`, {})).status).toBe(409);
    expect((await call(`/api/sessions/${second.id}/archive`, {})).status).toBe(409);
    await call(`/api/questions/${question.id}`, { answer: 'deny' });
    await until(async () => (!(await call(`/api/sessions/${second.id}`)).data.running ? true : undefined));

    expect((await call(`/api/sessions/${second.id}/delete`, {})).data).toEqual({ deleted: true });
    expect((await call(`/api/sessions/${second.id}`)).status).toBe(404);
    expect((await call(`/api/sessions/${second.id}/delete`, {})).status).toBe(404);
    expect((await call('/api/state')).data.sessions.map((s: { id: string }) => s.id)).toEqual([first.id]);
  });

  it('remembers who started a thread, who wrote each message, and who answered', async () => {
    polyphemus.registry.use(
      'openai',
      new ScriptedProvider('openai', [
        { content: [{ type: 'text', text: 'hello' }], stopReason: 'end_turn' },
        { content: [{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'touch nope' } }], stopReason: 'tool_use' },
        { content: [{ type: 'text', text: 'skipped it' }], stopReason: 'end_turn' },
      ]),
    );
    const owner = polyphemus.store.installOwner();
    const mine = client(await pairedCookie());
    const sam = polyphemus.store.addPerson('Sam');
    const samsCode = polyphemus.store.createPairingCode(undefined, sam.id);
    const samsCookie = (await fetch(`${base}/pair?code=${samsCode}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const sams = client(samsCookie);

    const project = (await mine('/api/projects', { name: 'Shop' })).data.project;
    polyphemus.store.setProjectRole(project.slug, sam.id, 'member');
    const { data } = await mine('/api/sessions', { text: 'hi', model: 'gpt-api', project: project.slug });
    await until(async () => ((await mine(`/api/sessions/${data.id}`)).data.messages.length === 2 ? true : undefined));
    await sams(`/api/sessions/${data.id}/messages`, { text: 'make a file' });
    const question = await until(async () => (await mine('/api/state')).data.questions[0]);
    await sams(`/api/questions/${question.id}`, { answer: 'deny' });
    const detail = await until(async () => {
      const { data: d } = await mine(`/api/sessions/${data.id}`);
      return !d.running && d.messages.length === 6 ? d : undefined;
    });

    expect(detail.meta.startedBy).toBe(`person:${owner.id}`);
    const byPerson = detail.messages.map((m: { role: string }, i: number) => [m.role, detail.actors[i]]);
    expect(byPerson[0]).toEqual(['user', `person:${owner.id}`]);
    expect(byPerson[2]).toEqual(['user', `person:${sam.id}`]);
    expect(detail.actors[4]).toBeNull(); // a tool result: nobody typed it
    expect(detail.answers).toMatchObject([{ kind: 'approval', summary: 'bash: touch nope', answer: 'deny', by: `person:${sam.id}` }]);
    expect(detail.people.map((p: { name: string }) => p.name)).toEqual([owner.name, 'Sam']);
  });

  it('asks the phone before a risky command and waits for the answer', async () => {
    polyphemus.registry.use(
      'openai',
      new ScriptedProvider('openai', [
        { content: [{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'touch should-not-exist' } }], stopReason: 'tool_use' },
        { content: [{ type: 'text', text: 'ok, skipped it' }], stopReason: 'end_turn' },
      ]),
    );
    const call = client(await pairedCookie());
    const { data } = await call('/api/sessions', { text: 'make a file', model: 'gpt-api', cwd: home });

    const question = await until(async () => (await call('/api/state')).data.questions[0]);
    expect(question).toMatchObject({ kind: 'approval', tool: 'bash', summary: 'touch should-not-exist', sessionId: data.id });
    // A session waiting on you counts as running, so `poly service update` won't restart under it.
    const daemonStatus = () => JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { pid: number; running: number };
    expect(daemonStatus()).toMatchObject({ pid: process.pid, running: 1 });
    expect((await call(`/api/questions/${question.id}`, { answer: 'deny' })).status).toBe(200);

    const detail = await until(async () => {
      const { data: d } = await call(`/api/sessions/${data.id}`);
      return !d.running && d.messages.length === 4 ? d : undefined;
    });
    expect(detail.messages[2].content[0]).toMatchObject({ type: 'tool_result', isError: true, content: 'The user declined this tool call.' });
    const again = await call(`/api/questions/${question.id}`, { answer: 'allow' });
    expect(again.status).toBe(409); // answered once, for everyone, and it says so
    expect(again.data.error).toBe('Already answered by you.');
    expect(daemonStatus().running).toBe(0);
  });

  it('asks for a secret in the thread and keeps the value out of everything the agent can see', async () => {
    const value = 'vault-only-value';
    mkdirSync(join(home, 'agents', 'helper'), { recursive: true });
    writeFileSync(join(home, 'agents', 'helper', 'agent.toml'), 'description = "helps"\ntitle = "Helper"\nmodel = "gpt-api"\n');
    polyphemus.registry.use(
      'openai',
      new ScriptedProvider('openai', [
        { content: [{ type: 'tool_call', id: 'c1', name: 'request_secret', input: { name: 'aws/site', purpose: 'deploy the site' } }], stopReason: 'tool_use' },
        { content: [{ type: 'text', text: 'carrying on' }], stopReason: 'end_turn' },
      ]),
    );
    const call = client(await pairedCookie());
    const project = (await call('/api/projects', { name: 'Site' })).data.project;
    const { data } = await call('/api/sessions', { text: 'deploy', model: 'gpt-api', project: project.slug, agent: 'helper' });

    const question = await until(async () => (await call('/api/state')).data.questions.find((q: { kind: string }) => q.kind === 'secret'));
    expect(question).toMatchObject({ name: 'aws/site', purpose: 'deploy the site', agentTitle: 'Helper', line: 'Helper asks for a secret: aws/site', scopes: ['agent', 'project'] });
    expect(JSON.stringify(question)).not.toContain(value);

    // Sending the value as the answer, the way every other question works, must not keep it.
    const asAnswer = await call(`/api/questions/${question.id}`, { answer: value });
    expect(asAnswer.status).toBe(400);
    expect(polyphemus.vault.has('aws/site')).toBe(false);
    expect(JSON.stringify(polyphemus.store.question(question.id))).not.toContain(value);

    const saved = await call(`/api/questions/${question.id}`, { value, who: 'agent' });
    expect(saved.status).toBe(200);
    expect(saved.data).toEqual({ ok: true, ref: 'secret:aws/site' });
    expect(JSON.stringify(saved.data)).not.toContain(value);

    const detail = await until(async () => {
      const { data: d } = await call(`/api/sessions/${data.id}`);
      const kept = d.messages.some((m: { content: Array<{ type?: string; content?: string }> }) => m.content.some((b) => b.type === 'tool_result' && String(b.content).includes('secret:aws/site')));
      return !d.running && kept ? d : undefined;
    });
    expect(JSON.stringify(detail)).not.toContain(value);
    expect(detail.answers).toEqual([expect.objectContaining({ kind: 'secret', answer: 'saved', summary: 'aws/site: deploy the site' })]);
    expect(polyphemus.vault.get('aws/site')).toBe(value);
    expect(readFileSync(polyphemus.vault.file, 'utf8')).not.toContain(value);
    expect(polyphemus.vault.list()).toEqual([expect.objectContaining({ name: 'aws/site', note: 'deploy the site', use: { who: 'agent', agent: 'helper', project: project.slug } })]);
  });

  it('asks for a site sign-in in the thread and never shows the cookies', async () => {
    polyphemus.registry.use(
      'openai',
      new ScriptedProvider('openai', [
        { content: [{ type: 'tool_call', id: 'c0', name: 'request_sign_in', input: { connection: 'Nope', purpose: 'no such thing' } }], stopReason: 'tool_use' },
        { content: [{ type: 'tool_call', id: 'c1', name: 'request_sign_in', input: { connection: 'Browser', url: 'https://example.com/login', purpose: 'read the dashboard' } }], stopReason: 'tool_use' },
        { content: [{ type: 'text', text: 'carrying on' }], stopReason: 'end_turn' },
      ]),
    );
    const call = client(await pairedCookie());
    const project = (await call('/api/projects', { name: 'Shop' })).data.project;
    const added = await call('/api/connections', { catalogue: 'browser' });
    expect(added.status).toBe(201);
    const browser = added.data.connection.id as string;
    expect((await call(`/api/connections/${browser}/grant`, { project: project.slug, tools: ['open_page'] })).status).toBe(200);
    const { data } = await call('/api/sessions', { text: 'check the site', model: 'gpt-api', project: project.slug });

    const question = await until(async () => (await call('/api/state')).data.questions.find((q: { kind: string }) => q.kind === 'signin'));
    expect(question).toMatchObject({ how: 'browser', site: 'example.com', where: 'example.com', purpose: 'read the dashboard', connection: browser, line: 'An agent asks you to sign in to example.com' });
    expect(JSON.stringify(question)).not.toContain('vault-cookie');

    const early = await call(`/api/questions/${question.id}`, { answer: 'done' });
    expect(early.status).toBe(400);
    expect((await call('/api/state')).data.questions.some((q: { id: string }) => q.id === question.id)).toBe(true);

    const owner = polyphemus.store.installOwner().id;
    const signIn = polyphemus.connections.store.signIns.add({ connection: browser, site: 'example.com', owner, projects: [] });
    polyphemus.vault.set(`connection/${browser}/sign-in/${signIn.id}`, JSON.stringify([{ name: 'session', value: 'vault-cookie', domain: 'example.com' }]), { kind: 'token' });
    const done = await call(`/api/questions/${question.id}`, { answer: 'done' });
    expect(done.status).toBe(200);
    expect(JSON.stringify(done.data)).not.toContain('vault-cookie');
    expect(polyphemus.connections.signIns(browser).find((s) => s.id === signIn.id)?.projects).toEqual([project.slug]);

    const detail = await until(async () => {
      const { data: d } = await call(`/api/sessions/${data.id}`);
      const said = d.messages.some((m: { content: Array<{ type?: string; content?: string }> }) => m.content.some((b) => b.type === 'tool_result' && String(b.content).includes('Signed in to example.com')));
      return !d.running && said ? d : undefined;
    });
    expect(JSON.stringify(detail)).not.toContain('vault-cookie');
    expect(detail.messages.flatMap((m: { content: Array<{ content?: string }> }) => m.content.map((b) => b.content ?? '')).join('\n')).toContain('No connection called "Nope"');
  });

  it('tells the agent when a site sign-in is held back because other people are in the project', async () => {
    polyphemus.registry.use(
      'openai',
      new ScriptedProvider('openai', [
        { content: [{ type: 'tool_call', id: 'c1', name: 'request_sign_in', input: { connection: 'Browser', url: 'https://example.com/login', purpose: 'read the dashboard' } }], stopReason: 'tool_use' },
        { content: [{ type: 'text', text: 'carrying on' }], stopReason: 'end_turn' },
      ]),
    );
    const call = client(await pairedCookie());
    const project = (await call('/api/projects', { name: 'Shop' })).data.project;
    const sam = polyphemus.store.addPerson('Sam');
    expect((await call(`/api/projects/${project.slug}/people`, { person: sam.id, role: 'member' })).status).toBe(200);
    const added = await call('/api/connections', { catalogue: 'browser' });
    const browser = added.data.connection.id as string;
    expect((await call(`/api/connections/${browser}/grant`, { project: project.slug, tools: ['open_page'] })).status).toBe(200);
    const { data } = await call('/api/sessions', { text: 'check the site', model: 'gpt-api', project: project.slug });

    const question = await until(async () => (await call('/api/state')).data.questions.find((q: { kind: string }) => q.kind === 'signin'));
    const owner = polyphemus.store.installOwner().id;
    const signIn = polyphemus.connections.store.signIns.add({ connection: browser, site: 'example.com', owner, projects: [] });
    polyphemus.vault.set(`connection/${browser}/sign-in/${signIn.id}`, JSON.stringify([{ name: 'session', value: 'vault-cookie', domain: 'example.com' }]), { kind: 'token' });
    const done = await call(`/api/questions/${question.id}`, { answer: 'done' });
    expect(done.status).toBe(200);
    expect(done.data.heldBack).toContain('other people');
    expect(JSON.stringify(done.data)).not.toContain('vault-cookie');

    const detail = await until(async () => {
      const { data: d } = await call(`/api/sessions/${data.id}`);
      const said = d.messages.some((m: { content: Array<{ type?: string; content?: string }> }) => m.content.some((b) => b.type === 'tool_result' && String(b.content).includes('held back')));
      return !d.running && said ? d : undefined;
    });
    expect(JSON.stringify(detail)).not.toContain('vault-cookie');
    expect(detail.messages.flatMap((m: { content: Array<{ content?: string }> }) => m.content.map((b) => b.content ?? '')).join('\n')).toContain('You can’t use it from this thread');
  });

  it('creates a project from the phone and starts sessions in it', async () => {
    const call = client(await pairedCookie());
    const created = await call('/api/projects', { name: 'Side Quest', about: 'A tiny game.' });
    expect(created.status).toBe(201);
    const path = join(home, 'projects', 'side-quest');
    expect(created.data.project).toMatchObject({ slug: 'side-quest', path });
    expect(existsSync(join(path, 'AGENTS.md'))).toBe(true);
    expect((await call('/api/projects', { name: 'Side Quest' })).status).toBe(400);
    expect((await call('/api/sessions', { text: 'hi', model: 'gpt-api', project: 'nope' })).status).toBe(404);

    polyphemus.registry.use('openai', new ScriptedProvider('openai', [{ content: [{ type: 'text', text: 'hi' }], stopReason: 'end_turn' }]));
    const { data } = await call('/api/sessions', { text: 'hello', model: 'gpt-api', project: 'side-quest' });
    const listed = await until(async () => {
      const { data: state } = await call('/api/state');
      const session = state.sessions.find((s: { id: string }) => s.id === data.id);
      return session && !session.running ? { session, state } : undefined;
    });
    expect(listed.session).toMatchObject({ project: 'side-quest', cwd: path });
    expect(listed.state.projects.map((p: { slug: string }) => p.slug)).toEqual(['side-quest']);
    // A new, empty project has nothing to read, so it isn't offered an orientation until it has work in it.
    expect(listed.state.projects[0]).toMatchObject({ needsOrientation: false, inbox: 0 });
    writeFileSync(join(path, 'level-1.md'), 'Jump, then collect.\n');
    expect((await call('/api/state')).data.projects[0]).toMatchObject({ needsOrientation: true });
  });

  it('renames a project without changing its address or its folder', async () => {
    const call = client(await pairedCookie());
    const created = await call('/api/projects', { name: 'Side Quest' });
    const slug = created.data.project.slug as string;
    const path = created.data.project.path as string;
    const renamed = await call(`/api/projects/${slug}/name`, { name: 'Night Game' });
    expect(renamed.status).toBe(200);
    expect(renamed.data).toEqual({ name: 'Night Game', slug });
    expect(polyphemus.store.project(slug)).toMatchObject({ name: 'Night Game', path });
    expect((await call('/api/state')).data.projects.find((p: { slug: string }) => p.slug === slug).name).toBe('Night Game');
    expect((await call(`/api/projects/${slug}/name`, { name: '   ' })).status).toBe(400);
    expect(polyphemus.store.project(slug)?.name).toBe('Night Game');
  });

  it('orients a project and reviews what the agent proposed', async () => {
    const call = client(await pairedCookie());
    await call('/api/projects', { name: 'Side Quest' });
    const inbox = join(home, 'memory', 'projects', 'side-quest', 'inbox');
    // The scripted "agent" proposes an AGENTS.md, the way a real one would with its file tools.
    polyphemus.registry.use(
      'openai',
      new ScriptedProvider('openai', [
        { content: [{ type: 'tool_call', id: 'c1', name: 'write_file', input: { path: join(inbox, 'AGENTS.md'), content: '# Side Quest\n\nRun npm test.\n' } }], stopReason: 'tool_use' },
        { content: [{ type: 'text', text: 'Proposed AGENTS.md.' }], stopReason: 'end_turn' },
      ]),
    );
    const { status, data } = await call('/api/projects/side-quest/orient', { model: 'gpt-api' });
    expect(status).toBe(201);
    const question = await until(async () => (await call('/api/state')).data.questions[0]);
    await call(`/api/questions/${question.id}`, { answer: 'allow' });
    await until(async () => ((await call(`/api/sessions/${data.id}`)).data.running ? undefined : true));

    const detail = await call(`/api/sessions/${data.id}`);
    expect(detail.data.meta.title).toBe('Orientation: Side Quest');
    expect((await call('/api/state')).data.projects[0]).toMatchObject({ inbox: 1 });
    const { data: review } = await call('/api/projects/side-quest/inbox');
    expect(review.items).toEqual([{ name: 'AGENTS.md', kind: 'rules', content: '# Side Quest\n\nRun npm test.\n' }]);
    // Another device, a phone say, is listening: it hears that the review changed, so its card clears.
    const phone = await fetch(`${base}/api/events`, { headers: { cookie: await pairedCookie() } });
    const reader = phone.body!.getReader();
    await reader.read(); // ": connected"
    const heard = (async () => {
      let text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return false;
        text += new TextDecoder().decode(value);
        if (text.includes('"project_changed"') && text.includes('"side-quest"')) return true;
      }
    })();
    expect((await call('/api/projects/side-quest/inbox/AGENTS.md', { action: 'accept' })).status).toBe(200);
    expect(await Promise.race([heard, new Promise((resolve) => setTimeout(() => resolve(false), 2000))])).toBe(true);
    await reader.cancel();
    expect((await call('/api/state')).data.projects[0]).toMatchObject({ needsOrientation: false, inbox: 0 });
    expect((await call('/api/projects/nope/inbox')).status).toBe(404);
  });

  it('lets the terminal on this computer in with its key, and only it picks any folder', async () => {
    const tokenFile = join(home, 'daemon-token');
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const token = readFileSync(tokenFile, 'utf8').trim();
    const terminal = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: (await res.json()) as Record<string, any> };
    };
    expect((await fetch(`${base}/api/state`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);

    const folder = join(home, 'somewhere');
    mkdirSync(folder);
    const created = await terminal('/api/sessions', { start: false, title: 'From the terminal', cwd: folder, model: 'gpt-api' });
    expect(created.status).toBe(201);
    expect(created.data.meta).toMatchObject({ title: 'From the terminal', cwd: folder });
    const id = created.data.id as string;
    expect(polyphemus.store.messages(id)).toEqual([]); // created, but no turn started
    expect((await terminal(`/api/sessions/${id}/title`, { text: 'Renamed' })).data.title).toBe('Renamed');
    expect((await terminal(`/api/sessions/${id}/effort`, { effort: 'high' })).data.effort).toBe('high');
    expect((await terminal(`/api/sessions/${id}/effort`, { effort: 'ludicrous' })).status).toBe(400);
    const rows = (await terminal(`/api/sessions/${id}/status`)).data.rows as Array<[string, string]>;
    expect(rows.find(([label]) => label === 'Folder')?.[1]).toBe(folder);
    expect((await terminal('/api/sessions', { start: false, cwd: '/no/such/folder', model: 'gpt-api' })).status).toBe(400);

    // A paired phone picks a project, not an arbitrary folder: with none, the folder for threads
    // outside every project, never wherever the daemon happens to run.
    const phone = client(await pairedCookie());
    const { data } = await phone('/api/sessions', { start: false, title: 'x', cwd: folder, model: 'gpt-api' });
    expect(polyphemus.store.get(data.id)?.cwd).toBe(join(home, 'projects', '.polyphemus-direct'));

    await daemon.close();
    expect(existsSync(tokenFile)).toBe(false); // gone with the daemon, so a stale key never lingers
    daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
    base = daemon.urls[0]!;
  });

  it('gives the app usage meters, devices, and reply previews, and serves its fonts', async () => {
    polyphemus.registry.use('openai', new ScriptedProvider('openai', [{ content: [{ type: 'text', text: 'Short answer.\nSecond line.' }], stopReason: 'end_turn' }]));
    polyphemus.recordUsage('codex', [{ window: '7d', usedPct: 98 }]);
    const call = client(await pairedCookie());
    const { data } = await call('/api/sessions', { text: 'hi', model: 'gpt-api' });
    const state = await until(async () => {
      const { data: s } = await call('/api/state');
      const one = s.sessions.find((x: { id: string }) => x.id === data.id);
      return one && !one.running ? s : undefined;
    });
    expect(state.sessions.find((x: { id: string }) => x.id === data.id).preview).toBe('Short answer. Second line.');
    expect(state.capacity).toContainEqual(expect.objectContaining({ provider: 'codex', readings: [expect.objectContaining({ window: '7d', usedPct: 98 })] }));
    expect(state.devices).toEqual([expect.objectContaining({ name: 'Android phone', current: true })]);

    const font = await fetch(`${base}/fonts/figtree.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');
  });

  it('runs routines on schedule, records every firing, and pauses after three failures', async () => {
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Side Quest' });
    mkdirSync(join(project.path, '.polyphemus', 'routines'), { recursive: true });
    writeFileSync(join(project.path, '.polyphemus', 'routines', 'brief.md'), '---\nmodel: gpt-api\ntriggers: [{ every: 1m }]\n---\nWrite the brief.\n');
    writeFileSync(join(project.path, '.polyphemus', 'routines', 'broken.md'), '---\nmodel: claude-api\ntriggers: [{ every: 1m }]\n---\nNeeds an Anthropic key.\n');
    polyphemus.registry.use('openai', new ScriptedProvider('openai', [{ content: [{ type: 'text', text: 'Brief written.' }], stopReason: 'end_turn' }]));
    const scheduler = daemon.routines;
    // Written into the project's folder, they wait for a person's yes (the next test is about that).
    const owner = client(await pairedCookie());
    for (const id of ['side-quest/brief', 'side-quest/broken']) {
      const { digest } = (await owner(`/api/routines/${encodeURIComponent(id)}`)).data.routine;
      expect((await owner(`/api/routines/${encodeURIComponent(id)}/accept`, { digest })).status).toBe(200);
    }

    const t0 = Date.now();
    scheduler.tick(t0); // first sight: start from now, no backfill
    expect(polyphemus.store.fires('side-quest/brief')).toEqual([]);
    const slot = (Math.floor(t0 / 60_000) + 1) * 60_000;
    scheduler.tick(slot + 5_000);
    const [started] = polyphemus.store.fires('side-quest/brief');
    expect(started).toMatchObject({ status: 'started', trigger: 'every 1m' });
    await until(async () => (polyphemus.store.fires('side-quest/brief')[0]?.outcome ? true : undefined));
    expect(polyphemus.store.fires('side-quest/brief')[0]).toMatchObject({ outcome: 'succeeded' });
    expect(polyphemus.store.messages(started!.sessionId!).at(-1)?.content[0]).toMatchObject({ text: 'Brief written.' });
    scheduler.tick(slot + 6_000); // the same time again: nothing new
    expect(polyphemus.store.fires('side-quest/brief')).toHaveLength(1);

    // The broken one was already rejected at its scheduled time (before anything started); two more
    // tries make three failures in a row, and it pauses itself.
    for (let i = 0; i < 2; i++) scheduler.runNow('side-quest/broken');
    const fires = polyphemus.store.fires('side-quest/broken');
    expect(fires.map((f) => f.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(fires[0]!.reason).toContain("anthropic isn't set up");
    expect(polyphemus.store.routineState('side-quest/broken')).toMatchObject({ paused: true, failures: 3 });

    // The app sees them, with the next run and the last result.
    const call = client(await pairedCookie());
    const { data } = await call('/api/state');
    expect(data.routines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'side-quest/brief', project: 'side-quest', schedule: 'every 1m', paused: false, last: expect.objectContaining({ outcome: 'succeeded' }) }),
        expect.objectContaining({ id: 'side-quest/broken', paused: true, next: null }),
      ]),
    );
    expect((await call(`/api/routines/${encodeURIComponent('side-quest/nope')}/run`, {})).status).toBe(404);

    // Opened from the app: its file to read, edited (checked first), paused and resumed, and removed.
    const path = `/api/routines/${encodeURIComponent('side-quest/brief')}`;
    const file = join(project.path, '.polyphemus', 'routines', 'brief.md');
    const opened = (await call(path)).data.routine;
    expect(opened).toMatchObject({ name: 'brief', mode: 'ask', prompt: 'Write the brief.', canChange: true, text: readFileSync(file, 'utf8') });
    const bad = await call(path, { text: '---\ntriggers: [{ every: 5s }]\n---\nToo often.\n' });
    expect(bad.status).toBe(400);
    expect(readFileSync(file, 'utf8')).toContain('Write the brief.');
    expect((await call(path, { text: '---\nname: renamed\nmodel: gpt-api\ntriggers: [{ every: 5m }]\n---\nOther.\n' })).status).toBe(400);
    expect((await call(path, { text: '---\nmodel: gpt-api\ntriggers: [{ every: 5m }]\n---\nWrite a shorter brief.\n' })).status).toBe(200);
    expect((await call('/api/state')).data.routines.find((r: { id: string }) => r.id === 'side-quest/brief')).toMatchObject({ schedule: 'every 5m' });
    expect((await call(`${path}/pause`, { paused: true })).data).toEqual({ paused: true });
    expect((await call('/api/state')).data.routines.find((r: { id: string }) => r.id === 'side-quest/brief')).toMatchObject({ paused: true, next: null });
    expect((await call(`${path}/pause`, { paused: false })).data).toEqual({ paused: false });
    expect((await call(`${path}/remove`, {})).data).toEqual({ removed: 'side-quest/brief' });
    expect(existsSync(file)).toBe(false);
    expect((await call('/api/state')).data.routines.some((r: { id: string }) => r.id === 'side-quest/brief')).toBe(false);
    expect((await call(path)).status).toBe(404);
  });

  it('runs a project’s routine only as a person accepted it, and yolo only with the owner’s yes', async () => {
    // Its folder is where agents write: a routine an agent put there ran on schedule, without asking,
    // and nobody had said yes to it (independent review, 2026-09-19).
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Side Quest' });
    const folder = join(project.path, '.polyphemus', 'routines');
    mkdirSync(folder, { recursive: true });
    const file = join(folder, 'sneaky.md');
    writeFileSync(file, '---\nmodel: gpt-api\nmode: yolo\ntriggers: [{ every: 1m }]\n---\nDo whatever.\n');
    polyphemus.registry.use('openai', new ScriptedProvider('openai', [{ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }]));
    const id = 'side-quest/sneaky';
    const owner = client(await pairedCookie());
    expect((await owner('/api/state')).data.routines.find((r: { id: string }) => r.id === id)).toMatchObject({ waiting: true });
    expect(daemon.routines.runNow(id)).toMatchObject({ status: 'skipped', reason: expect.stringContaining('accepted') });

    // Accept names the version that was read: one changed while the sheet was open is refused.
    const opened = (await owner(`/api/routines/${encodeURIComponent(id)}`)).data.routine;
    expect(opened).toMatchObject({ waiting: true, text: expect.stringContaining('Do whatever.'), digest: expect.any(String) });
    writeFileSync(file, '---\nmodel: gpt-api\nmode: yolo\ntriggers: [{ every: 1m }]\n---\nDo something worse.\n');
    expect((await owner(`/api/routines/${encodeURIComponent(id)}/accept`, { digest: opened.digest })).status).toBe(409);
    expect((await owner(`/api/routines/${encodeURIComponent(id)}/accept`, {})).status).toBe(409);
    writeFileSync(file, '---\nmodel: gpt-api\nmode: yolo\ntriggers: [{ every: 1m }]\n---\nDo whatever.\n');

    // A member can't say yes to one that runs without asking; the owner can.
    const sam = polyphemus.store.addPerson('Sam');
    polyphemus.store.setProjectRole(project.slug, sam.id, 'member');
    const code = polyphemus.store.createPairingCode(undefined, sam.id);
    const member = client((await fetch(`${base}/pair?code=${code}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!);
    expect((await member(`/api/routines/${encodeURIComponent(id)}/accept`, { digest: opened.digest })).status).toBe(403);
    expect((await owner(`/api/routines/${encodeURIComponent(id)}/accept`, { digest: opened.digest })).status).toBe(200);
    expect(daemon.routines.runNow(id)).toMatchObject({ status: 'started' });

    // Changed afterwards, by anyone who can write the folder: it waits again.
    writeFileSync(file, '---\nmodel: gpt-api\nmode: yolo\ntriggers: [{ every: 1m }]\n---\nDo something else.\n');
    expect(daemon.routines.runNow(id)).toMatchObject({ status: 'skipped' });
  });

  it('says since when a thread has been working, so opening it midway doesn’t start the clock again', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    polyphemus.registry.use('openai', {
      kind: 'model',
      id: 'openai',
      async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
        await held;
        yield { type: 'message_done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], origin: { provider: 'openai', model: req.model } }, stopReason: 'end_turn', usage: emptyUsage() };
      },
      async listModels() {
        return [];
      },
    } as ModelProvider);
    const call = client(await pairedCookie());
    const before = Date.now();
    const { id } = (await call('/api/sessions', { text: 'take your time', model: 'gpt-api' })).data;
    const first = (await call(`/api/sessions/${id}`)).data;
    expect(first.running).toBe(true);
    expect(first.workingSince).toBeGreaterThanOrEqual(before);
    await new Promise((r) => setTimeout(r, 30));
    // Opened again later: the same start, not now.
    expect((await call(`/api/sessions/${id}`)).data.workingSince).toBe(first.workingSince);
    release();
    await until(async () => ((await call(`/api/sessions/${id}`)).data.running ? undefined : true));
    expect((await call(`/api/sessions/${id}`)).data.workingSince).toBeNull();
  });

  it('says how a thread flowed: who worked when, who handed on to whom, and what it cost', async () => {
    mkdirSync(join(home, 'agents', 'bd'), { recursive: true });
    writeFileSync(join(home, 'agents', 'bd', 'agent.toml'), 'description = "the pipeline"\ntitle = "BD"\nmodel = "gpt-api"\n');
    polyphemus.registry.use('openai', new ScriptedProvider('openai', [{ content: [{ type: 'text', text: 'Looked at it.' }], stopReason: 'end_turn' }]));
    const call = client(await pairedCookie());
    const { id } = (await call('/api/sessions', { text: 'take a look', agent: 'bd' })).data;
    await until(async () => ((await call(`/api/sessions/${id}`)).data.running ? undefined : true));

    const flow = (await call(`/api/sessions/${id}/flow`)).data;
    expect(flow.actors.map((a: { id: string; name: string }) => [a.id, a.name])).toEqual(expect.arrayContaining([[expect.stringMatching(/^person:/), 'Alex'], ['agent:bd', 'BD']]));
    // The turn says whose it was and who it answered, which is what the hand-off arrows are drawn from.
    expect(flow.turns).toHaveLength(1);
    expect(flow.turns[0]).toMatchObject({ speaker: 'bd', sender: expect.stringMatching(/^person:/), stopReason: 'end_turn', model: 'openai:gpt-6-astra' });
    expect(flow.turns[0].until).toBeGreaterThanOrEqual(flow.turns[0].at);
    // What was said, without polyphemus's own status block.
    expect(flow.says.map((m: { preview: string }) => m.preview)).toEqual(['take a look', 'Looked at it.']);
    expect(JSON.stringify(flow.says)).not.toContain('polyphemus_status');
  });

  it('holds messages sent while a thread works, and sends them together when it stops', async () => {
    // Only the first turn waits to be let go; the ones after answer straight away.
    const asked: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    polyphemus.registry.use('openai', {
      kind: 'model',
      id: 'openai',
      async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
        asked.push(JSON.stringify(req.messages.at(-1)?.content ?? ''));
        // The first turn waits to be let go — or until it's stopped, as a real provider would.
        if (asked.length === 1) {
          await Promise.race([held, new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve()))]);
          if (req.signal?.aborted) return;
        }
        yield { type: 'message_done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], origin: { provider: 'openai', model: req.model } }, stopReason: 'end_turn', usage: emptyUsage() };
      },
      async listModels() {
        return [];
      },
    } as ModelProvider);
    const call = client(await pairedCookie());
    const { id } = (await call('/api/sessions', { text: 'first', model: 'gpt-api' })).data;
    await until(async () => (asked.length ? true : undefined));

    // Sent while it works: held, not refused, and shown in the thread as yours.
    expect((await call(`/api/sessions/${id}/messages`, { text: 'also this' })).data.queued).toBeTruthy();
    const second = (await call(`/api/sessions/${id}/messages`, { text: 'and this' })).data.queued;
    expect((await call(`/api/sessions/${id}`)).data.queued.map((q: { text: string; mine: boolean }) => [q.text, q.mine])).toEqual([['also this', true], ['and this', true]]);
    // Taken back, it goes no further.
    expect((await call(`/api/sessions/${id}/unqueue`, { id: second })).status).toBe(200);
    expect((await call(`/api/sessions/${id}/messages`, { text: 'one more' })).data.queued).toBeTruthy();

    // Sent now: what's working is stopped, and that message goes next (2026-09-19).
    const urgent = (await call(`/api/sessions/${id}/messages`, { text: 'stop — check this first' })).data.queued;
    expect((await call(`/api/sessions/${id}/send-now`, { id: urgent })).data).toMatchObject({ stopped: true });
    await until(async () => (asked.length >= 2 ? true : undefined));
    // On its own: the others are still waiting.
    expect(asked[1]).toContain('stop — check this first');
    expect(asked[1]).not.toContain('also this');
    // The first turn finishes; what's held goes as one message, and the queue empties.
    release();
    await until(async () => (asked.length >= 3 ? true : undefined));
    expect(asked[2]).toContain('also this');
    expect(asked[2]).toContain('one more');
    expect(asked[2]).not.toContain('and this');
    await until(async () => ((await call(`/api/sessions/${id}`)).data.queued.length === 0 ? true : undefined));
    expect(asked).toHaveLength(3);
  });

  it('stops a thread’s queue growing without end', async () => {
    // Held messages were kept with no cap: a phone could fill the database, and nobody could catch
    // up with the thread (review of parallel agents, 2026-09-20).
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    polyphemus.registry.use('openai', {
      kind: 'model',
      id: 'openai',
      async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
        await Promise.race([held, new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve()))]);
        yield { type: 'message_done', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], origin: { provider: 'openai', model: req.model } }, stopReason: 'end_turn', usage: emptyUsage() };
      },
      async listModels() {
        return [];
      },
    } as ModelProvider);
    const call = client(await pairedCookie());
    const { id } = (await call('/api/sessions', { text: 'first', model: 'gpt-api' })).data;
    await until(async () => ((await call(`/api/sessions/${id}`)).data.running ? true : undefined));

    for (let i = 0; i < 20; i++) expect((await call(`/api/sessions/${id}/messages`, { text: `held ${i}` })).data.queued).toBeTruthy();
    const refused = await call(`/api/sessions/${id}/messages`, { text: 'one too many' });
    expect(refused.status).toBe(429);
    expect(refused.data.error).toContain('waiting here');
    // Nothing was kept, and the thread can still be caught up with.
    expect((await call(`/api/sessions/${id}`)).data.queued).toHaveLength(20);
    release();
  });

  it('draws a thread’s flow again without reading everything said in it again', async () => {
    polyphemus.registry.use('openai', new ScriptedProvider('openai', [{ content: [{ type: 'text', text: 'Looked at it.' }], stopReason: 'end_turn' }, { content: [{ type: 'text', text: 'And again.' }], stopReason: 'end_turn' }]));
    const call = client(await pairedCookie());
    const { id } = (await call('/api/sessions', { text: 'take a look', model: 'gpt-api' })).data;
    await until(async () => ((await call(`/api/sessions/${id}`)).data.running ? undefined : true));

    let reads = 0;
    const store = polyphemus.store as unknown as { messages: (id: string, from?: number) => unknown };
    const real = store.messages.bind(polyphemus.store);
    store.messages = (session: string, from?: number) => {
      reads += 1;
      return real(session, from);
    };
    const first = (await call(`/api/sessions/${id}/flow`)).data;
    const readOnce = reads;
    const again = (await call(`/api/sessions/${id}/flow`)).data;
    expect(reads).toBe(readOnce);
    expect(again).toEqual(first);

    // Something new said in it, and it's drawn from the thread afresh.
    await call(`/api/sessions/${id}/messages`, { text: 'and this' });
    await until(async () => ((await call(`/api/sessions/${id}`)).data.running ? undefined : true));
    const third = (await call(`/api/sessions/${id}/flow`)).data;
    expect(reads).toBeGreaterThan(readOnce);
    expect(third.says.map((m: { preview: string }) => m.preview)).toContain('and this');
    store.messages = real;
  });

  it('says a routine that runs as a Codex agent doesn’t ask, whatever the default model is', async () => {
    // Third review (2026-09-19): the label followed the default model, not what actually runs.
    mkdirSync(join(home, 'agents', 'coder'), { recursive: true });
    writeFileSync(join(home, 'agents', 'coder', 'agent.toml'), 'description = "codes"\nmodel = "codex:gpt-5"\n');
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Side Quest' });
    mkdirSync(join(project.path, '.polyphemus', 'routines'), { recursive: true });
    writeFileSync(join(project.path, '.polyphemus', 'routines', 'fix.md'), '---\nagent: coder\ntriggers: [{ every: 1h }]\n---\nFix things.\n');
    writeFileSync(join(project.path, '.polyphemus', 'routines', 'plain.md'), '---\nmodel: gpt-api\ntriggers: [{ every: 1h }]\n---\nWrite.\n');
    polyphemus.config.defaultModel = 'gpt-api'; // an API model by default: the agent is what brings Codex
    const call = client(await pairedCookie());
    expect((await call(`/api/routines/${encodeURIComponent('side-quest/fix')}`)).data.routine.asks).toBe(false);
    expect((await call(`/api/routines/${encodeURIComponent('side-quest/plain')}`)).data.routine.asks).toBe(true);
  });

  it('keeps running the routines an install already had, from before acceptance existed', async () => {
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Side Quest' });
    mkdirSync(join(project.path, '.polyphemus', 'routines'), { recursive: true });
    writeFileSync(join(project.path, '.polyphemus', 'routines', 'brief.md'), '---\nmodel: gpt-api\ntriggers: [{ every: 1m }]\n---\nWrite the brief.\n');
    // Make the database one from before: no accepted versions at all.
    await daemon.close();
    polyphemus.close();
    const db = new DatabaseSync(join(home, 'sessions.db'));
    db.exec('ALTER TABLE routine_state DROP COLUMN accepted_digest');
    db.close();
    polyphemus = await Polyphemus.open(home);
    polyphemus.registry.use('openai', new ScriptedProvider('openai', [{ content: [{ type: 'text', text: 'Brief written.' }], stopReason: 'end_turn' }]));
    daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
    base = daemon.urls[0]!;
    expect(daemon.routines.runNow('side-quest/brief')).toMatchObject({ status: 'started' });
    // Only once: a routine added after the upgrade waits like any other.
    writeFileSync(join(project.path, '.polyphemus', 'routines', 'later.md'), '---\nmodel: gpt-api\ntriggers: [{ every: 1m }]\n---\nLater.\n');
    expect(daemon.routines.runNow('side-quest/later')).toMatchObject({ status: 'skipped' });
  });

  it('runs a read-only routine without asking, declining anything that would change something', async () => {
    const sent: PushPayload[] = [];
    await daemon.close();
    daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home, push: { publicKey: 'k', send: async (_s, p) => (sent.push(p), 'ok') } });
    base = daemon.urls[0]!;
    const call = client(await pairedCookie());
    await call('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/phone', keys: { p256dh: 'p', auth: 'a' } } });
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Side Quest' });
    mkdirSync(join(project.path, '.polyphemus', 'routines'), { recursive: true });
    writeFileSync(join(project.path, '.polyphemus', 'routines', 'brief.md'), '---\nmodel: gpt-api\nmode: read-only\nnotify: [failure, finish]\ntriggers: [{ every: 1h }]\n---\nWrite the brief.\n');
    await call(`/api/routines/${encodeURIComponent('side-quest/brief')}/accept`, { digest: (await call(`/api/routines/${encodeURIComponent('side-quest/brief')}`)).data.routine.digest });
    polyphemus.registry.use(
      'openai',
      new ScriptedProvider('openai', [
        { content: [{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'touch should-not-exist' } }], stopReason: 'tool_use' },
        { content: [{ type: 'text', text: 'Brief: all quiet. I would have created a file.' }], stopReason: 'end_turn' },
      ]),
    );

    const fired = daemon.routines.runNow('side-quest/brief');
    await until(async () => (polyphemus.store.fires('side-quest/brief')[0]?.outcome ? true : undefined));
    expect(polyphemus.store.fires('side-quest/brief')[0]).toMatchObject({ outcome: 'succeeded' });
    expect(existsSync(join(project.path, 'should-not-exist'))).toBe(false);
    expect((await call('/api/state')).data.questions).toEqual([]); // nobody was asked
    const result = polyphemus.store.messages(fired!.sessionId!).find((m) => m.content.some((b) => b.type === 'tool_result'));
    expect(result?.content[0]).toMatchObject({ type: 'tool_result', isError: true });
    // The "finished" notification carries the brief itself.
    expect(sent.find((p) => p.title === 'brief finished')?.body).toBe('Brief: all quiet. I would have created a file.');
  });

  it('runs a YOLO session without asking', async () => {
    polyphemus.registry.use(
      'openai',
      new ScriptedProvider('openai', [
        { content: [{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'touch yolo-made-this' } }], stopReason: 'tool_use' },
        { content: [{ type: 'text', text: 'made it' }], stopReason: 'end_turn' },
      ]),
    );
    const call = client(await pairedCookie());
    const { data } = await call('/api/sessions', { text: 'make a file', model: 'gpt-api', cwd: home, yolo: true });
    const detail = await until(async () => {
      const { data: d } = await call(`/api/sessions/${data.id}`);
      return !d.running && d.messages.length === 4 ? d : undefined;
    });
    expect(detail.autoApprove).toBe(true);
    expect(detail.messages[2].content[0]).toMatchObject({ type: 'tool_result', isError: false });
    expect(existsSync(join(home, 'projects', '.polyphemus-direct', 'yolo-made-this'))).toBe(true);
    expect((await call(`/api/sessions/${data.id}/yolo`, { on: false })).data.autoApprove).toBe(false);

    // YOLO belongs to the thread: polyphemus restarting (an update, a reboot) leaves it as you set it.
    expect((await call(`/api/sessions/${data.id}/yolo`, { on: true })).data.autoApprove).toBe(true);
    await daemon.close();
    polyphemus.close();
    polyphemus = await Polyphemus.open(home);
    polyphemus.registry.use('openai', new ScriptedProvider('openai', [{ content: [{ type: 'text', text: 'still here' }], stopReason: 'end_turn' }]));
    daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
    base = daemon.urls[0]!;
    const after = client(await pairedCookie());
    expect((await after(`/api/sessions/${data.id}`)).data.autoApprove).toBe(true);
    expect((await after(`/api/sessions/${data.id}/yolo`, { on: false })).data.autoApprove).toBe(false);
    await daemon.close();
    polyphemus.close();
    polyphemus = await Polyphemus.open(home);
    daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
    base = daemon.urls[0]!;
    expect((await client(await pairedCookie())(`/api/sessions/${data.id}`)).data.autoApprove).toBe(false);
  });

  it('notifies devices that turned notifications on, and forgets subscriptions the browser dropped', async () => {
    await daemon.close();
    const sent: Array<{ endpoint: string; payload: PushPayload }> = [];
    const push: PushSender = {
      publicKey: 'test-public-key',
      send: async (subscription, payload) => {
        sent.push({ endpoint: subscription.endpoint, payload });
        return subscription.endpoint.endsWith('/gone') ? 'gone' : 'ok';
      },
    };
    daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home, push });
    base = daemon.urls[0]!;
    polyphemus.registry.use(
      'openai',
      new ScriptedProvider('openai', [
        { content: [{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'touch should-not-exist' } }], stopReason: 'tool_use' },
        { content: [{ type: 'text', text: 'All done.\nNothing was created.' }], stopReason: 'end_turn' },
      ]),
    );
    const call = client(await pairedCookie());
    expect((await call('/api/state')).data.push.publicKey).toBe('test-public-key');

    const keys = { p256dh: 'p', auth: 'a' };
    expect((await call('/api/push/subscribe', { subscription: { endpoint: 'http://not-https.example/x', keys } })).status).toBe(400);
    expect((await call('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/phone', keys } })).status).toBe(200);
    expect((await call('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/gone', keys } })).status).toBe(200);

    const { data } = await call('/api/sessions', { text: 'make a file', model: 'gpt-api', cwd: home });
    const question = await until(async () => (await call('/api/state')).data.questions[0]);
    expect(sent.find((s) => s.endpoint.endsWith('/phone'))?.payload).toMatchObject({
      title: 'make a file',
      body: 'Waiting for your OK to run bash: touch should-not-exist',
      url: `/#/s/${data.id}`,
    });
    await call(`/api/questions/${question.id}`, { answer: 'deny' });

    const finished = await until(async () => sent.find((s) => s.payload.tag === `turn-${data.id}`));
    expect(finished).toMatchObject({ endpoint: 'https://push.example/phone', payload: { title: 'make a file', body: 'Done: All done. Nothing was created.' } });
    expect(polyphemus.store.pushSubscriptions().map((s) => s.subscription.endpoint)).toEqual(['https://push.example/phone']);
    await until(async () => ((await call(`/api/sessions/${data.id}`)).data.running ? undefined : true));

    // Questions only: a finished turn stays quiet.
    expect((await call('/api/push/settings', { kinds: ['questions', 'bogus'] })).data.kinds).toEqual(['questions']);
    expect((await call('/api/state')).data.push.kinds).toEqual(['questions']);
    const before = sent.length;
    expect((await call(`/api/sessions/${data.id}/messages`, { text: 'again' })).status).toBe(202);
    await until(async () => {
      const { data: d } = await call(`/api/sessions/${data.id}`);
      return !d.running && d.messages.length === 6 ? d : undefined;
    });
    expect(sent.length).toBe(before);

    // An alert about polyphemus itself (like losing its address) reaches every device that wants questions.
    const alertsBefore = sent.length;
    daemon.alert('polyphemus lost its address', 'Something replaced the route.');
    expect(sent.slice(alertsBefore)).toEqual([expect.objectContaining({ payload: expect.objectContaining({ title: 'polyphemus lost its address', tag: 'polyphemus-alert' }) })]);

    // Turned off from the phone.
    expect((await call('/api/push/unsubscribe', {})).status).toBe(200);
    expect(polyphemus.store.pushSubscriptions()).toEqual([]);
    expect((await call('/api/state')).data.push.kinds).toBeNull();

    // A revoked device stops getting them.
    await call('/api/push/subscribe', { subscription: { endpoint: 'https://push.example/phone', keys } });
    polyphemus.store.revokeDevice(polyphemus.store.listDevices()[0]!.id);
    expect(polyphemus.store.pushSubscriptions()).toEqual([]);
  });

  it('serves the service worker and manifest without pairing, since browsers fetch them on their own', async () => {
    expect((await fetch(`${base}/sw.js`)).status).toBe(200);
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json');
    expect((await fetch(`${base}/app.js`)).status).toBe(401);
  });
});
