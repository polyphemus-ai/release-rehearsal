import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, emptyUsage, findChrome, Polyphemus, openBrowser, type Block, type ChatRequest, type ModelProvider, type Person, type ProviderEvent, type StopReason } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

// Settled brief §5 at the API: journey 4 (a grant cannot widen), journey 5 (a ceiling nobody checked
// says so), and a failing connection landing in Waiting on you for the person who can fix it.

const FIXTURE = fileURLToPath(new URL('../../core/test/fixtures/mcp-contacts.mjs', import.meta.url));
const TOKEN = 'contacts-token-that-must-never-leave-the-vault';

class Scripted implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'openai';
  constructor(private steps: Array<{ content: Block[]; stopReason: StopReason }>) {}
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    const step = this.steps.shift() ?? { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' as StopReason };
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
const savedEnv = { ...process.env };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-connections-api-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\ndefault_model = "gpt-api"\n${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  mkdirSync(join(home, 'agents', 'builder'), { recursive: true });
  writeFileSync(join(home, 'agents', 'builder', 'agent.toml'), 'description = "Builds"\ntitle = "Builder"\nmodel = "gpt-api"\n');
  polyphemus = await Polyphemus.open(home);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;
});
afterEach(async () => {
  await daemon.close();
  polyphemus.close();
  process.env = { ...savedEnv };
});

type Call = (path: string, body?: unknown) => Promise<{ status: number; data: Record<string, any>; raw: string }>;
async function device(person?: Person): Promise<Call> {
  const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode(undefined, person?.id)}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
  return async (path, body) => {
    const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await res.text();
    return { status: res.status, data: (raw ? JSON.parse(raw) : {}) as Record<string, any>, raw };
  };
}

async function setUp() {
  const owner = await device();
  const shop = (await owner('/api/projects', { name: 'Shop' })).data.project;
  const other = (await owner('/api/projects', { name: 'Other' })).data.project;
  const sam = polyphemus.store.addPerson('Sam');
  polyphemus.store.setProjectRole(shop.slug, sam.id, 'member');
  const added = await owner('/api/connections', { name: 'Contacts', kind: 'stdio', command: process.execPath, args: [FIXTURE], secrets: { CONTACTS_TOKEN: TOKEN }, owner: sam.id });
  expect(added.status).toBe(201);
  return { owner, sam, samDevice: await device(sam), shop, other, connection: added.data.connection };
}

describe('connections at the API', () => {
  it('refuses a grant that would widen, whoever asks (journey 4)', async () => {
    const { owner, samDevice, shop } = await setUp();
    expect((await owner('/api/connections/contacts/grant', { project: shop.slug, tools: ['read_contacts'] })).status).toBe(200);

    const wider = await owner('/api/connections/contacts/grant', { project: shop.slug, agent: 'builder', tools: ['read_contacts', 'write_contacts'] });
    expect(wider).toMatchObject({ status: 403, data: { error: expect.stringContaining('write_contacts isn’t in shop’s grant') } });
    expect((await owner('/api/connections/contacts/grant', { project: shop.slug, tools: ['read_contacts', 'not_a_tool'] })).status).toBe(403);
    // Granting is the install owner's, even for the person who owns the account.
    expect((await samDevice('/api/connections/contacts/grant', { project: shop.slug, tools: ['read_contacts', 'write_contacts'] })).status).toBe(403);
    const { connection } = (await owner('/api/connections/contacts')).data;
    expect(connection.grants).toEqual([expect.objectContaining({ project: shop.slug, agent: null, tools: ['read_contacts'] })]);

    // The narrower one is fine, and the agent's reach says where it came from.
    expect((await owner('/api/connections/contacts/grant', { project: shop.slug, agent: 'builder', tools: ['read_contacts'] })).status).toBe(200);
    const reach = (await samDevice('/api/agents/builder/reach')).data;
    expect(reach.projects).toEqual([
      expect.objectContaining({ project: shop.slug, reach: [expect.objectContaining({ name: 'Contacts', inherited: false, tools: [{ name: 'read_contacts', reads: true }], why: expect.stringMatching(/^Granted to Builder in Shop by .+, narrowing the project’s grant$/) })] }),
    ]);
  });

  it('grants a connection to an agent itself, with no project behind it', async () => {
    const { owner, samDevice, shop } = await setUp();
    // No project in the body: the agent carries it, so a direct thread with it can use it too.
    expect((await owner('/api/connections/contacts/grant', { agent: 'builder', tools: ['read_contacts'] })).status).toBe(200);
    const { connection } = (await owner('/api/connections/contacts')).data;
    expect(connection.grants).toEqual([expect.objectContaining({ project: '', projectName: 'anywhere it works', agent: 'builder', tools: ['read_contacts'] })]);

    const reach = (await samDevice('/api/agents/builder/reach')).data;
    expect(reach.projects[0]).toMatchObject({
      project: '',
      name: 'Wherever it works, direct threads included',
      reach: [expect.objectContaining({ carried: true, why: expect.stringMatching(/^Granted to Builder itself by .+: it carries this wherever it works$/) })],
    });
    // It's the agent's, not the project's: the project reaches nothing until it's granted too.
    expect((await samDevice(`/api/projects/${shop.slug}/reach`)).data.reach).toEqual([]);
    // Granting needs a project or an agent, and taking it back leaves nothing.
    expect((await owner('/api/connections/contacts/grant', { tools: ['read_contacts'] })).status).toBe(400);
    expect((await owner('/api/connections/contacts/revoke', { agent: 'builder' })).status).toBe(200);
    expect((await owner('/api/connections/contacts')).data.connection.grants).toEqual([]);
  });

  it('says a ceiling nobody checked is unknown or declared, and by whom (journey 5)', async () => {
    const { owner, samDevice, shop } = await setUp();
    let { connection } = (await samDevice('/api/connections/contacts')).data;
    expect(connection.ceiling).toMatchObject({ provenance: 'unknown', says: 'Unknown — polyphemus will hold itself to what you grant, but can’t confirm the key is limited.' });

    // Sam owns the account, so Sam says what the key can do.
    connection = (await samDevice('/api/connections/contacts/ceiling', { tools: ['read_contacts'] })).data.connection;
    expect(connection.ceiling).toMatchObject({ provenance: 'declared', by: 'Sam', tools: ['read_contacts'], says: expect.stringMatching(/^Read-only, declared by Sam · \d+ \w+\. Nobody checked with Contacts; polyphemus holds itself to it\.$/) });
    expect(connection.ceiling.says).not.toMatch(/^Checked/);
    expect((await owner('/api/connections/contacts/grant', { project: shop.slug, tools: ['write_contacts'] })).data.error).toContain('outside this connection’s ceiling');

    // No secret value in anything anyone is sent.
    const everything = [await owner('/api/connections'), await owner('/api/connections/contacts'), await samDevice('/api/connections'), await owner('/api/state')];
    for (const response of everything) expect(response.raw).not.toContain(TOKEN);
    expect((await owner('/api/connections/contacts')).data.connection).toMatchObject({ where: expect.stringContaining('mcp-contacts.mjs'), secrets: ['CONTACTS_TOKEN'] });
  });

  it('shows a connection only to people it concerns', async () => {
    const { owner, sam, other, shop } = await setUp();
    const val = polyphemus.store.addPerson('Val');
    polyphemus.store.setProjectRole(other.slug, val.id, 'member');
    const valDevice = await device(val);
    await owner('/api/connections/contacts/grant', { project: shop.slug, tools: ['read_contacts'] });

    expect((await valDevice('/api/connections')).data.connections).toEqual([]);
    expect((await valDevice('/api/connections/contacts')).status).toBe(404);
    expect((await valDevice(`/api/projects/${shop.slug}/reach`)).status).toBe(404);
    expect((await valDevice('/api/connections', { name: 'Mine', kind: 'stdio', command: 'x' })).status).toBe(403);

    // A member of the project it's granted to sees it, but not how it's reached.
    polyphemus.store.setProjectRole(shop.slug, val.id, 'viewer');
    const seen = (await valDevice('/api/connections')).data.connections;
    expect(seen).toEqual([expect.objectContaining({ id: 'contacts', where: null, secrets: [], canManage: false })]);
    expect((await valDevice('/api/connections/contacts/test', {})).status).toBe(403);
    expect((await valDevice(`/api/projects/${shop.slug}/reach`)).data.reach).toEqual([expect.objectContaining({ name: 'Contacts', why: expect.stringContaining('Granted to Shop by') })]);
    void sam;
  });

  it('keeps what a call in one project said out of another project’s view', async () => {
    // A connection shared by two projects: a failure quoting one's records was shown to the other's
    // viewers (independent review, 2026-09-19).
    const { owner, other, shop } = await setUp();
    await owner('/api/connections/contacts/grant', { project: shop.slug, tools: ['read_contacts'] });
    await owner('/api/connections/contacts/grant', { project: other.slug, tools: ['read_contacts'] });
    const val = polyphemus.store.addPerson('Val');
    polyphemus.store.setProjectRole(other.slug, val.id, 'viewer');
    const valDevice = await device(val);
    const shopThread = polyphemus.store.create({ title: 'Payroll', provider: 'openai', model: 'gpt-5', cwd: shop.path });
    const sam = polyphemus.store.addPerson('Riley');
    polyphemus.store.connections.record({ connection: 'contacts', tool: 'read_contacts', outcome: 'failed', detail: 'no contact named Jordan Salary 120000', sessionId: shopThread.id, agent: 'builder', actor: `person:${sam.id}` });
    polyphemus.store.connections.setHealth('contacts', 'failing', { error: 'refused: record Jordan Salary 120000', kind: 'protocol', sessionId: shopThread.id });

    const seen = (await valDevice('/api/connections/contacts')).data;
    expect(JSON.stringify(seen)).not.toContain('Jordan');
    expect(seen.activity[0]).toMatchObject({ tool: 'read_contacts', outcome: 'failed', detail: null, session: null, agent: null, by: null });
    expect(JSON.stringify(seen)).not.toContain('Riley');
    expect(seen.connection.error).toContain('can’t see');
    // The owner sees all of it.
    expect(JSON.stringify((await owner('/api/connections/contacts')).data)).toContain('Jordan');
  });

  it('puts a failing connection in Waiting on you for its owner, with the actual error and the thread (journey 8)', async () => {
    const { owner, samDevice, shop } = await setUp();
    await owner('/api/connections/contacts/grant', { project: shop.slug, tools: ['read_contacts'] });
    expect((await samDevice('/api/connections/contacts/reconnect', { secrets: { CONTACTS_TOKEN: 'expired' } })).data.connection).toMatchObject({ health: 'failing', errorKind: 'auth' });

    polyphemus.registry.use('openai', new Scripted([{ content: [{ type: 'tool_call', id: 'c1', name: 'contacts__read_contacts', input: {} }], stopReason: 'tool_use' }]));
    const thread = (await samDevice('/api/sessions', { text: 'pull the contacts', project: shop.slug })).data;
    for (let i = 0; i < 100 && (await samDevice(`/api/sessions/${thread.id}`)).data.running; i++) await new Promise((r) => setTimeout(r, 30));

    const result = polyphemus.store.messages(thread.id).flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('401 Unauthorized') });
    expect((await samDevice('/api/state')).data.connectionIssues).toEqual([
      expect.objectContaining({ id: 'contacts', errorKind: 'auth', error: expect.stringContaining('401'), session: { id: thread.id, title: 'pull the contacts' } }),
    ]);
    // Addressed to Sam, who owns the account — not to everyone who can see it.
    expect((await owner('/api/state')).data.connectionIssues).toEqual([]);
    const { activity } = (await samDevice('/api/connections/contacts')).data;
    expect(activity[0]).toMatchObject({ tool: 'read_contacts', outcome: 'failed', session: { id: thread.id }, by: 'Sam' });

    // Dismissing puts it out of Sam's sight — until it fails some other way.
    expect((await samDevice('/api/connections/contacts/dismiss', {})).status).toBe(200);
    expect((await samDevice('/api/state')).data.connectionIssues).toEqual([]);
    polyphemus.store.connections.setHealth('contacts', 'failing', { error: 'The server stopped (exit 1)', kind: 'unavailable' });
    expect((await samDevice('/api/state')).data.connectionIssues).toEqual([expect.objectContaining({ id: 'contacts', errorKind: 'unavailable' })]);

    // Reconnecting clears it.
    await samDevice('/api/connections/contacts/reconnect', { secrets: { CONTACTS_TOKEN: TOKEN } });
    expect((await samDevice('/api/state')).data.connectionIssues).toEqual([]);
  });
});

describe('the connections catalogue', () => {
  it('lists what polyphemus knows how to connect, and fills in an entry rather than trusting the request', async () => {
    const owner = await device();
    const { catalogue } = (await owner('/api/connections/catalogue')).data;
    const ids = catalogue.map((e: { id: string }) => e.id);
    for (const id of ['notion', 'github', 'google-drive', 'gmail', 'x', 'finance', 'browser', 'linear', 'stripe', 'deepwiki']) expect(ids).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(80);
    // Every one says where it's listed, and one signing in the MCP way is an address, not a command.
    expect(catalogue.every((e: { category?: string }) => e.category)).toBe(true);
    expect(catalogue.filter((e: { signIn: string }) => e.signIn === 'oauth').every((e: { url?: string }) => e.url?.startsWith('https://'))).toBe(true);
    expect(catalogue[1]).toMatchObject({ signIn: 'token', url: 'https://api.githubcopilot.com/mcp/', connected: [] });
    expect((await owner('/api/connections', { catalogue: 'github' })).data.error).toContain('needs a token');
    expect((await owner('/api/connections', { catalogue: 'nope' })).status).toBe(400);
    const sam = polyphemus.store.addPerson('Sam');
    expect((await (await device(sam))('/api/connections/catalogue')).status).toBe(403);
  });
});

describe.skipIf(!findChrome())('the Browser connection', () => {
  it('is granted like any connection: agents open public pages through it, each thread in its own browser, and nothing private or ungranted', async () => {
    const site = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const headers = { 'content-type': 'text/html; charset=utf-8', ...(path === '/login' && { 'set-cookie': 'session=signed-in; Path=/' }) };
      res.writeHead(200, headers);
      res.end(path === '/me' ? `<title>Me</title><p>Cookie: ${req.headers.cookie ?? 'none'}</p>` : `<title>Lamps</title><h1>Lamps</h1><a href="/me">Account</a>`);
    });
    await new Promise<void>((ok) => site.listen(0, '127.0.0.1', ok));
    const origin = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    // The test site is on this computer, which the browser otherwise refuses.
    process.env.POLYPHEMUS_BROWSER_ALLOW = origin;
    // The test site is on this computer, which a worker's Chrome can never reach: this computer's Chrome it is.
    polyphemus.connections.openBrowser = () => openBrowser();
    try {
      const owner = await device();
      const shop = (await owner('/api/projects', { name: 'Shop' })).data.project;
      const { catalogue } = (await owner('/api/connections/catalogue')).data;
      expect(catalogue.find((e: { id: string }) => e.id === 'browser')).toMatchObject({ signIn: 'none', builtin: 'browser', connected: [] });
      const added = await owner('/api/connections', { catalogue: 'browser' });
      expect(added.status).toBe(201);
      expect(added.data.connection).toMatchObject({ name: 'Browser', kind: 'builtin', health: 'ok', auth: 'none', where: expect.stringContaining('Built into polyphemus'), ceiling: { provenance: 'checked' } });
      expect(added.data.connection.tools.map((t: { name: string; reads: boolean }) => `${t.name}${t.reads ? '' : ' (acts)'}`)).toEqual(['open_page', 'read_page', 'click (acts)', 'type_text (acts)', 'press_key (acts)', 'scroll_page', 'go_back', 'take_screenshot']);
      // Reading only: clicking and typing aren't granted.
      expect((await owner('/api/connections/browser/grant', { project: shop.slug, tools: ['open_page', 'read_page', 'take_screenshot'] })).status).toBe(200);

      const call = (id: string, name: string, input: Record<string, unknown>) => ({ content: [{ type: 'tool_call' as const, id, name, input }], stopReason: 'tool_use' as StopReason });
      polyphemus.registry.use(
        'openai',
        new Scripted([
          call('c1', 'browser__open_page', { url: `${origin}/login` }),
          call('c2', 'browser__open_page', { url: `${origin}/me` }),
          call('c2b', 'browser__take_screenshot', {}),
          call('c3', 'browser__open_page', { url: 'http://127.0.0.1:3900/api/state' }),
          call('c4', 'browser__click', { ref: 1 }),
          { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
          call('c5', 'browser__open_page', { url: `${origin}/me` }),
        ]),
      );
      const settle = async (id: string) => {
        for (let i = 0; i < 300 && (await owner(`/api/sessions/${id}`)).data.running; i++) await new Promise((r) => setTimeout(r, 30));
      };
      const results = (id: string) => polyphemus.store.messages(id).flatMap((m) => m.content).filter((b) => b.type === 'tool_result') as Array<{ content: string; isError: boolean }>;
      const first = (await owner('/api/sessions', { text: 'check my account page', project: shop.slug })).data;
      await settle(first.id);
      const [login, me, shot, local, click] = results(first.id);
      // The model is handed the picture itself, kept like an attached image.
      expect(shot).toMatchObject({ isError: false, content: expect.stringContaining('Here’s the page as it fits the window'), images: [{ type: 'image', mediaType: 'image/png', path: expect.stringContaining(join(home, 'uploads')) }] });
      expect(login).toMatchObject({ isError: false, content: expect.stringContaining('heading 1: Lamps') });
      expect(me!.content).toContain('Cookie: session=signed-in');
      expect(local).toMatchObject({ isError: true, content: expect.stringContaining('polyphemus didn’t open http://127.0.0.1:3900/api/state: 127.0.0.1 is on this computer or a private network') });
      expect(click).toMatchObject({ isError: true, content: expect.stringContaining('Polyphemus refused this call: click on Browser isn’t granted') });

      // Another thread has a browser of its own: not signed in.
      const second = (await owner('/api/sessions', { text: 'and again', project: shop.slug })).data;
      await settle(second.id);
      expect(results(second.id)[0]!.content).toContain('Cookie: none');
      // Every call is on the connection's record.
      const { activity } = (await owner('/api/connections/browser')).data;
      expect(activity.map((a: { tool: string; outcome: string }) => `${a.tool} ${a.outcome}`)).toEqual(expect.arrayContaining(['open_page ok', 'open_page failed', 'click refused']));
    } finally {
      site.close();
    }
  }, 60_000);
});

describe.skipIf(!findChrome())('browser sign-ins', () => {
  const SESSION = 'kept-session-value-0123456789';
  const ROTATED = 'rotated-session-value-9876543210';

  /** A site with a sign-in form: a session cookie once signed in, rotated the next time /me is read after rotate(). */
  async function siteWithSignIn() {
    let rotated = true;
    const site = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const cookie = req.headers.cookie ?? '';
      if (path === '/login' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const form = new URLSearchParams(body);
          const ok = form.get('user') === 'alex' && form.get('pass') === 'correct horse';
          res.writeHead(303, { location: '/me', ...(ok && { 'set-cookie': `session=${SESSION}; Path=/; HttpOnly` }) });
          res.end();
        });
        return;
      }
      if (path === '/me') {
        const signedIn = cookie.includes(SESSION) || cookie.includes(ROTATED);
        const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
        if (signedIn && !rotated) {
          rotated = true;
          headers['set-cookie'] = `session=${ROTATED}; Path=/; HttpOnly`;
        }
        res.writeHead(200, headers);
        res.end(signedIn ? `<title>Me</title><h1>Signed in as alex</h1><p>Your session: ${cookie}</p>` : '<title>Me</title><h1>Not signed in</h1>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<title>Sign in</title><form method="post" action="/login"><input name="user" autofocus><input type="password" name="pass"><button>Sign in</button></form>');
    });
    await new Promise<void>((ok) => site.listen(0, '127.0.0.1', ok));
    return { site, origin: `http://127.0.0.1:${(site.address() as { port: number }).port}`, rotate: () => (rotated = false) };
  }

  it('keeps what a person signs in to by hand, uses it only where they choose and nobody else can see, and never shows it to a model', async () => {
    const { site, origin, rotate } = await siteWithSignIn();
    process.env.POLYPHEMUS_BROWSER_ALLOW = origin;
    // The test site is on this computer, which a worker's Chrome can never reach: this computer's Chrome it is.
    polyphemus.connections.openBrowser = () => openBrowser();
    try {
      const owner = await device();
      const shop = (await owner('/api/projects', { name: 'Shop' })).data.project;
      const other = (await owner('/api/projects', { name: 'Other' })).data.project;
      expect((await owner('/api/connections', { catalogue: 'browser' })).status).toBe(201);
      expect((await owner('/api/connections/browser/grant', { project: shop.slug, tools: ['open_page', 'read_page'] })).status).toBe(200);

      // Signing in by hand: a live view, typed into like a phone would.
      const started = await owner('/api/connections/browser/sign-ins', { url: `${origin}/`, width: 390, height: 700 });
      expect(started.status).toBe(201);
      const live = started.data.live as string;
      const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
      const look = async () => {
        const res = await fetch(`${base}/api/connections/browser/live/${live}`, { headers: { cookie } });
        expect(res.headers.get('content-type')).toBe('image/jpeg');
        expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(500);
        return JSON.parse(decodeURIComponent(res.headers.get('x-page')!)) as { url: string; title: string; secret: boolean };
      };
      expect(await look()).toMatchObject({ title: 'Sign in', secret: false });
      const input = (body: Record<string, unknown>) => owner(`/api/connections/browser/live/${live}/input`, body);
      // The person's own pointer and keyboard reach the page: hover, press where they pressed, release
      // there, and any key with its modifiers (2026-09-22, sign-ins that a tap couldn't manage).
      expect((await input({ kind: 'move', x: 20, y: 20 })).status).toBe(200);
      expect((await input({ kind: 'down', x: 20, y: 20 })).status).toBe(200);
      expect((await input({ kind: 'up', x: 20, y: 20 })).status).toBe(200);
      expect((await input({ kind: 'press', key: 'Escape', modifiers: 0 })).status).toBe(200);
      expect((await input({ kind: 'nonsense' })).status).toBe(400);
      // A desktop-sized page, and back to a phone's, without losing the page.
      expect((await owner(`/api/connections/browser/live/${live}/size`, { width: 1280, height: 800 })).data).toEqual({ width: 1280, height: 800 });
      expect(await look()).toMatchObject({ title: 'Sign in' });
      expect((await owner(`/api/connections/browser/live/${live}/size`, { width: 390, height: 700 })).data).toEqual({ width: 390, height: 700 });
      expect((await input({ kind: 'text', text: 'alex' })).status).toBe(200);
      await input({ kind: 'key', key: 'Tab' });
      // A password field is focused: the app hides what's typed.
      expect(await look()).toMatchObject({ secret: true });
      await input({ kind: 'text', text: 'correct horse' });
      await input({ kind: 'key', key: 'Enter' });
      expect(await look()).toMatchObject({ url: `${origin}/me`, title: 'Me' });

      // Someone else who works with the browser can't see it, drive it, or keep it.
      const sam = polyphemus.store.addPerson('Sam');
      polyphemus.store.setProjectRole(shop.slug, sam.id, 'member');
      const samDevice = await device(sam);
      expect((await samDevice('/api/connections/browser')).status).toBe(200);
      expect((await samDevice(`/api/connections/browser/live/${live}/input`, { kind: 'text', text: 'x' })).status).toBe(404);
      expect((await samDevice(`/api/connections/browser/live/${live}/keep`, {})).status).toBe(404);
      expect((await samDevice(`/api/connections/browser/live/${live}`)).status).toBe(404);
      polyphemus.store.setProjectRole(shop.slug, sam.id, null);
      polyphemus.store.setProjectRole(other.slug, sam.id, 'member');

      const kept = await owner(`/api/connections/browser/live/${live}/keep`, {});
      expect(kept.data.signIn).toMatchObject({ site: '127.0.0.1', owner: { you: true }, projects: [] });
      const id = kept.data.signIn.id as string;
      // The view is gone once kept.
      expect((await input({ kind: 'text', text: 'x' })).status).toBe(404);
      // The cookies are in the vault, and nowhere anyone is sent.
      expect(polyphemus.vault.get(`connection/browser/sign-in/${id}`)).toContain(SESSION);
      for (const response of [await owner('/api/connections/browser'), await owner('/api/connections'), await owner('/api/state')]) expect(response.raw).not.toContain(SESSION);

      // Only projects the browser is granted to.
      expect((await owner(`/api/connections/browser/sign-ins/${id}/projects`, { projects: [other.slug] })).status).toBe(403);
      expect((await owner(`/api/connections/browser/sign-ins/${id}/projects`, { projects: [shop.slug] })).data.signIn.projects).toEqual([{ slug: shop.slug, name: 'Shop', heldBack: null }]);

      const call = (cid: string, url: string) => ({ content: [{ type: 'tool_call' as const, id: cid, name: 'browser__open_page', input: { url } }], stopReason: 'tool_use' as StopReason });
      const done = { content: [{ type: 'text' as const, text: 'done' }], stopReason: 'end_turn' as StopReason };
      polyphemus.registry.use('openai', new Scripted([call('a1', `${origin}/me`), done, call('b1', `${origin}/me`), done, call('c1', `${origin}/me`), done]));
      const settle = async (sid: string) => {
        for (let i = 0; i < 300 && (await owner(`/api/sessions/${sid}`)).data.running; i++) await new Promise((r) => setTimeout(r, 30));
      };
      const results = (sid: string) => polyphemus.store.messages(sid).flatMap((m) => m.content).filter((b) => b.type === 'tool_result') as Array<{ content: string; isError: boolean }>;

      rotate();
      const first = (await owner('/api/sessions', { text: 'check my account', project: shop.slug })).data;
      await settle(first.id);
      const signedIn = results(first.id)[0]!.content;
      expect(signedIn).toContain('This thread’s browser is signed in to 127.0.0.1');
      expect(signedIn).toContain('Signed in as alex');
      // A page printing the session doesn't hand it to the model.
      expect(signedIn).not.toContain(SESSION);
      expect(signedIn).not.toContain('correct horse');
      // The site rotated its session as it was used: the new one is what's kept.
      await new Promise((r) => setTimeout(r, 200));
      expect(polyphemus.vault.get(`connection/browser/sign-in/${id}`)).toContain(ROTATED);

      // Someone else joins the project: the sign-in is held back, and the model is told why.
      polyphemus.store.setProjectRole(shop.slug, sam.id, 'viewer');
      expect((await owner('/api/connections/browser')).data.connection.signIns[0].projects[0].heldBack).toContain('other people in shop could see what it reaches');
      const second = (await owner('/api/sessions', { text: 'check it again', project: shop.slug })).data;
      await settle(second.id);
      const heldBack = results(second.id)[0]!.content;
      expect(heldBack).toContain('Not signed in');
      expect(heldBack).toContain('There’s a sign-in to 127.0.0.1 for this project that this thread’s browser doesn’t have');
      polyphemus.store.setProjectRole(shop.slug, sam.id, null);

      // Sam doesn't see it, can't say where it's used, and can't remove it; the owner of the sign-in can remove it.
      expect((await samDevice('/api/connections/browser')).status).toBe(404);
      polyphemus.store.setProjectRole(shop.slug, sam.id, 'member');
      expect((await samDevice('/api/connections/browser')).data.connection.signIns).toEqual([]);
      expect((await samDevice(`/api/connections/browser/sign-ins/${id}/projects`, { projects: [] })).status).toBe(404);
      expect((await samDevice(`/api/connections/browser/sign-ins/${id}/remove`, {})).status).toBe(404);
      polyphemus.store.setProjectRole(shop.slug, sam.id, null);
      expect((await owner(`/api/connections/browser/sign-ins/${id}/remove`, {})).status).toBe(200);
      expect(polyphemus.vault.has(`connection/browser/sign-in/${id}`)).toBe(false);
      const third = (await owner('/api/sessions', { text: 'once more', project: shop.slug })).data;
      await settle(third.id);
      expect(results(third.id)[0]!.content).toContain('Not signed in');
    } finally {
      site.close();
    }
  }, 90_000);

  const TOKEN = 'stored-token-value-0123456789';
  const NEW_TOKEN = 'stored-token-value-9876543210';

  /**
   * A site that keeps its whole session in localStorage and sets no cookie at all — the shape that
   * used to be refused with "hasn't set anything to keep yet" after a sign-in that plainly worked.
   */
  async function siteWithStoredSession() {
    let rotated = true;
    const page = (body: string) => `<title>Me</title><div id="who">…</div><script>
      var t = localStorage.getItem('u');
      if (t === ${JSON.stringify(NEW_TOKEN)} || t === ${JSON.stringify(TOKEN)}) {
        ${body}
        document.getElementById('who').innerHTML = '<h1>Signed in as alex</h1><p>Welcome back, ' + t + '</p>';
      } else document.getElementById('who').innerHTML = '<h1>Not signed in</h1>';
    </script>`;
    const site = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/login' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const form = new URLSearchParams(body);
          const ok = form.get('user') === 'alex' && form.get('pass') === 'correct horse';
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(ok ? `<title>Me</title><script>localStorage.setItem('u', ${JSON.stringify(TOKEN)}); location.replace('/me')</script>` : '<title>No</title><h1>Not signed in</h1>');
        });
        return;
      }
      if (path === '/me') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        // Rotating the token the way a site refreshes one as it's used.
        res.end(page(rotated ? '' : `localStorage.setItem('u', t = ${JSON.stringify(NEW_TOKEN)}); `));
        if (!rotated) rotated = true;
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<title>Sign in</title><form method="post" action="/login"><input name="user" autofocus><input type="password" name="pass"><button>Sign in</button></form>');
    });
    await new Promise<void>((ok) => site.listen(0, '127.0.0.1', ok));
    return { site, origin: `http://127.0.0.1:${(site.address() as { port: number }).port}`, rotate: () => (rotated = false) };
  }

  it('keeps a sign-in for a site that holds its session in localStorage rather than cookies, and never shows the token to a model', async () => {
    const { site, origin, rotate } = await siteWithStoredSession();
    process.env.POLYPHEMUS_BROWSER_ALLOW = origin;
    polyphemus.connections.openBrowser = () => openBrowser();
    try {
      const owner = await device();
      const shop = (await owner('/api/projects', { name: 'Shop' })).data.project;
      expect((await owner('/api/connections', { catalogue: 'browser' })).status).toBe(201);
      expect((await owner('/api/connections/browser/grant', { project: shop.slug, tools: ['open_page', 'read_page'] })).status).toBe(200);

      const started = await owner('/api/connections/browser/sign-ins', { url: `${origin}/`, width: 390, height: 700 });
      const live = started.data.live as string;
      const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
      const look = async () => {
        const res = await fetch(`${base}/api/connections/browser/live/${live}`, { headers: { cookie } });
        return JSON.parse(decodeURIComponent(res.headers.get('x-page')!)) as { url: string; title: string };
      };
      const input = (body: Record<string, unknown>) => owner(`/api/connections/browser/live/${live}/input`, body);
      await input({ kind: 'text', text: 'alex' });
      await input({ kind: 'key', key: 'Tab' });
      await input({ kind: 'text', text: 'correct horse' });
      await input({ kind: 'key', key: 'Enter' });
      expect(await look()).toMatchObject({ url: `${origin}/me` });

      // Keeping works though the site set no cookie whatsoever.
      const kept = await owner(`/api/connections/browser/live/${live}/keep`, {});
      expect(kept.status).toBe(200);
      const id = kept.data.signIn.id as string;
      const vaulted = polyphemus.vault.get(`connection/browser/sign-in/${id}`)!;
      expect(JSON.parse(vaulted)).toMatchObject({ cookies: [], storage: [{ origin, local: { u: TOKEN } }] });
      for (const response of [await owner('/api/connections/browser'), await owner('/api/state')]) expect(response.raw).not.toContain(TOKEN);
      expect((await owner(`/api/connections/browser/sign-ins/${id}/projects`, { projects: [shop.slug] })).status).toBe(200);

      const call = (cid: string, url: string) => ({ content: [{ type: 'tool_call' as const, id: cid, name: 'browser__open_page', input: { url } }], stopReason: 'tool_use' as StopReason });
      const done = { content: [{ type: 'text' as const, text: 'done' }], stopReason: 'end_turn' as StopReason };
      polyphemus.registry.use('openai', new Scripted([call('a1', `${origin}/me`), done]));
      const settle = async (sid: string) => {
        for (let i = 0; i < 300 && (await owner(`/api/sessions/${sid}`)).data.running; i++) await new Promise((r) => setTimeout(r, 30));
      };
      const results = (sid: string) => polyphemus.store.messages(sid).flatMap((m) => m.content).filter((b) => b.type === 'tool_result') as Array<{ content: string; isError: boolean }>;

      // The agent's browser starts with the stored session put back, so the site knows it.
      rotate();
      const first = (await owner('/api/sessions', { text: 'check my account', project: shop.slug })).data;
      await settle(first.id);
      const signedIn = results(first.id)[0]!.content;
      expect(signedIn).toContain('Signed in as alex');
      // A page printing the token doesn't hand it to the model.
      expect(signedIn).not.toContain(TOKEN);
      expect(signedIn).not.toContain(NEW_TOKEN);
      // The site refreshed the token as it was used: the new one is what's kept.
      await new Promise((r) => setTimeout(r, 200));
      expect(JSON.parse(polyphemus.vault.get(`connection/browser/sign-in/${id}`)!)).toMatchObject({ storage: [{ origin, local: { u: NEW_TOKEN } }] });
    } finally {
      site.close();
    }
  }, 90_000);
});
