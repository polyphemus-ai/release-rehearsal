import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { artifactFile, DEFAULT_CONFIG, emptyUsage, Polyphemus, type ChatRequest, type ModelProvider, type ProviderEvent } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

// Who can do what, for every route the app talks to (roadmap: release tests for access). Each route
// names the people allowed to use it; everyone else must be refused — 401, 403 or 404, never an answer,
// and never a 400 that means the check came after the work. A route the server has that this table
// doesn't list fails the last test, so a new one can't arrive unchecked.
//
// The people: the owner; a member and a viewer of Shop; someone with no role anywhere; a person who
// was removed; a device that was signed out; and no device at all. Lab is a project only the owner is in.

const FIXTURE = fileURLToPath(new URL('../../core/test/fixtures/mcp-contacts.mjs', import.meta.url));
const SERVER = readFileSync(fileURLToPath(new URL('../src/server.ts', import.meta.url)), 'utf8');
const CONNECTIONS = readFileSync(fileURLToPath(new URL('../src/connections-api.ts', import.meta.url)), 'utf8');

class Quiet implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'openai';
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    yield { type: 'message_done', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], origin: { provider: 'openai', model: req.model } }, stopReason: 'end_turn', usage: emptyUsage() };
  }
  async listModels() {
    return [];
  }
}

type Role = 'owner' | 'member' | 'viewer' | 'outsider' | 'removed' | 'revoked' | 'anon';
const LIVE: Role[] = ['owner', 'member', 'viewer', 'outsider'];
const ALL: Role[] = [...LIVE, 'removed', 'revoked', 'anon'];

interface Route {
  method: 'GET' | 'POST' | 'DELETE';
  /** With the fixture's ids filled in: {shop} {lab} {st} {lt} {dt} {conn} {agent} {labAgent} {rt} {lrt} {img} {art} {q} {dev} {sam} */
  path: string;
  body?: Record<string, unknown>;
  /** Who may use it. Everyone else is refused. */
  allow: Role[];
  /** Safe to call as an allowed person too (it reads, or changes nothing that matters here). */
  safe?: boolean;
}

const OWNER: Role[] = ['owner'];
const SHOP_READ: Role[] = ['owner', 'member', 'viewer'];
const SHOP_WORK: Role[] = ['owner', 'member'];
const ANY_ROLE: Role[] = ['owner', 'member', 'viewer'];

const ROUTES: Route[] = [
  // Everyone who's paired.
  { method: 'GET', path: '/api/state', allow: LIVE, safe: true },
  { method: 'GET', path: '/api/emoji', allow: LIVE, safe: true },
  { method: 'GET', path: '/api/sessions', allow: LIVE, safe: true },
  { method: 'GET', path: '/api/workflows', allow: LIVE, safe: true },
  { method: 'GET', path: '/api/skills', allow: LIVE, safe: true },
  { method: 'GET', path: '/api/skills/library', allow: LIVE, safe: true },
  { method: 'GET', path: '/api/connections', allow: LIVE, safe: true },
  { method: 'GET', path: '/api/events', allow: LIVE, safe: true },
  { method: 'POST', path: '/api/push/subscribe', body: { subscription: { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } } }, allow: LIVE },
  // Uploads are for someone who can send something somewhere: not a viewer, not someone with no role.
  { method: 'POST', path: '/api/images', allow: SHOP_WORK },
  { method: 'POST', path: '/api/files', allow: SHOP_WORK },
  { method: 'POST', path: '/api/push/settings', body: { kinds: ['questions'] }, allow: LIVE, safe: true },
  { method: 'POST', path: '/api/push/problem', body: { problem: 'x' }, allow: LIVE },
  { method: 'POST', path: '/api/push/test', body: {}, allow: LIVE },
  { method: 'POST', path: '/api/push/unsubscribe', body: {}, allow: LIVE },

  // The install: the owner's.
  { method: 'GET', path: '/api/providers', allow: OWNER, safe: true },
  { method: 'POST', path: '/api/providers', body: { id: 'groq' }, allow: OWNER },
  { method: 'GET', path: '/api/catalogue', allow: OWNER, safe: true },
  { method: 'POST', path: '/api/providers/openai/signin', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/providers/openai/install', body: {}, allow: OWNER },
  { method: 'DELETE', path: '/api/providers/openai/signin', allow: OWNER },
  { method: 'POST', path: '/api/providers/openai/test', body: {}, allow: OWNER },
  { method: 'GET', path: '/api/providers/openai/models', allow: OWNER, safe: true },
  { method: 'POST', path: '/api/providers/openai/key', body: { key: 'sk-x' }, allow: OWNER },
  { method: 'DELETE', path: '/api/providers/openai/key', allow: OWNER },
  { method: 'POST', path: '/api/providers/openai/accept', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/providers/codex/sandbox', body: { on: true }, allow: OWNER },
  { method: 'DELETE', path: '/api/providers/groq', allow: OWNER },
  { method: 'POST', path: '/api/selected', body: { selected: ['openai:gpt-5'] }, allow: OWNER },
  { method: 'POST', path: '/api/models', body: { label: 'x', provider: 'openai', model: 'y' }, allow: OWNER },
  { method: 'POST', path: '/api/models/test', body: { ref: 'gpt-api' }, allow: OWNER },
  { method: 'POST', path: '/api/models/move', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/models/remove', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/models/gpt-api', body: { default: true }, allow: OWNER },
  { method: 'DELETE', path: '/api/models/gpt-api', allow: OWNER },
  { method: 'POST', path: '/api/routing', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/isolation', body: { level: 'host' }, allow: OWNER },
  { method: 'POST', path: '/api/default-agent', body: { title: 'Helm' }, allow: OWNER },
  { method: 'POST', path: '/api/projects', body: { name: 'New one' }, allow: OWNER },
  { method: 'POST', path: '/api/people', body: { name: 'Someone' }, allow: OWNER },
  { method: 'POST', path: '/api/people/{sam}/pair', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/people/{sam}/remove', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/devices/{dev}/revoke', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/skills/install', body: { id: 'nope/nothing', to: 'library' }, allow: OWNER },
  { method: 'POST', path: '/api/skills/remove', body: { name: 'nothing', from: 'library' }, allow: OWNER },
  { method: 'POST', path: '/api/agents', body: { name: 'newbie' }, allow: OWNER },
  { method: 'POST', path: '/api/agents/{agent}', body: { description: 'changed' }, allow: OWNER },
  { method: 'GET', path: '/api/agents/{agent}/dependents', allow: OWNER, safe: true },
  { method: 'POST', path: '/api/agents/{agent}/delete', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/agents/{agent}/computer', body: { action: 'wake' }, allow: OWNER },
  { method: 'GET', path: '/api/agents/{agent}/computer/files', allow: OWNER, safe: true },
  { method: 'POST', path: '/api/connections', body: { name: 'X', kind: 'stdio', command: 'x' }, allow: OWNER },
  { method: 'GET', path: '/api/connections/catalogue', allow: OWNER, safe: true },
  { method: 'GET', path: '/api/connections/discover?url=https%3A%2F%2Fexample.com', allow: OWNER },
  { method: 'POST', path: '/api/connections/github-app', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/connections/google-client', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/connections/x-client', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/connections/plaid-app', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/connections/simplefin', body: {}, allow: OWNER },

  // An agent anyone with a role can see, and a project's own agent only its people can.
  { method: 'GET', path: '/api/agents/{agent}', allow: ANY_ROLE, safe: true },
  { method: 'GET', path: '/api/agents/{agent}/computer', allow: ANY_ROLE, safe: true },
  { method: 'GET', path: '/api/agents/{agent}/reach', allow: ANY_ROLE, safe: true },
  { method: 'GET', path: '/api/agents/{labAgent}', allow: OWNER, safe: true },
  { method: 'GET', path: '/api/agents/{labAgent}/reach', allow: OWNER, safe: true },

  // Shop: its people read, its members work. Lab: the owner's alone.
  { method: 'GET', path: '/api/projects/{shop}/artifacts', allow: SHOP_READ, safe: true },
  { method: 'GET', path: '/api/projects/{shop}/handoff', allow: SHOP_READ, safe: true },
  { method: 'GET', path: '/api/projects/{shop}/inbox', allow: SHOP_READ, safe: true },
  { method: 'GET', path: '/api/projects/{shop}/reach', allow: SHOP_READ, safe: true },
  { method: 'POST', path: '/api/projects/{shop}/orient', body: {}, allow: SHOP_WORK },
  { method: 'POST', path: '/api/projects/{shop}/incoming', body: { text: 'a bug', kind: 'bug' }, allow: SHOP_WORK },
  { method: 'POST', path: '/api/projects/{shop}/inbox/nothing.md', body: { action: 'discard' }, allow: SHOP_WORK },
  { method: 'POST', path: '/api/projects/{shop}/name', body: { name: 'The shop' }, allow: OWNER },
  { method: 'POST', path: '/api/projects/{shop}/isolation', body: { level: 'isolated' }, allow: OWNER },
  { method: 'POST', path: '/api/projects/{shop}/people', body: { person: '{sam}', role: 'member' }, allow: OWNER },
  { method: 'POST', path: '/api/projects/{shop}/network', body: { presets: [] }, allow: OWNER },
  { method: 'GET', path: '/api/projects/{lab}/artifacts', allow: OWNER, safe: true },
  { method: 'GET', path: '/api/projects/{lab}/handoff', allow: OWNER, safe: true },
  { method: 'GET', path: '/api/projects/{lab}/inbox', allow: OWNER, safe: true },
  { method: 'GET', path: '/api/projects/{lab}/reach', allow: OWNER, safe: true },
  { method: 'POST', path: '/api/projects/{lab}/orient', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/projects/{lab}/incoming', body: { text: 'x', kind: 'bug' }, allow: OWNER },
  { method: 'POST', path: '/api/workflows/loop/start', body: { project: '{shop}', input: { outcome: 'x' } }, allow: SHOP_WORK },
  { method: 'POST', path: '/api/workflows/loop/start', body: { project: '{lab}', input: { outcome: 'x' } }, allow: OWNER },

  // Routines: Shop's for its people, Lab's for the owner.
  { method: 'GET', path: '/api/routines/{rt}', allow: SHOP_READ, safe: true },
  { method: 'POST', path: '/api/routines/{rt}/settings', body: { notify: true }, allow: SHOP_WORK },
  { method: 'POST', path: '/api/routines/{rt}/pause', body: { paused: false }, allow: SHOP_WORK, safe: true },
  { method: 'POST', path: '/api/routines/{rt}/accept', body: { digest: 'stale' }, allow: SHOP_WORK },
  { method: 'POST', path: '/api/routines/{rt}/run', body: {}, allow: SHOP_WORK },
  { method: 'POST', path: '/api/routines/{rt}', body: { text: 'x' }, allow: SHOP_WORK },
  { method: 'POST', path: '/api/routines/{rt}/remove', body: {}, allow: SHOP_WORK },
  { method: 'GET', path: '/api/routines/{lrt}', allow: OWNER, safe: true },
  { method: 'POST', path: '/api/routines/{lrt}/pause', body: { paused: false }, allow: OWNER },
  { method: 'POST', path: '/api/routines/{lrt}/run', body: {}, allow: OWNER },

  // Threads: starting one, reading one, and every action on one.
  { method: 'POST', path: '/api/sessions', body: { text: 'hi', project: '{shop}', start: false }, allow: SHOP_WORK },
  { method: 'POST', path: '/api/sessions', body: { text: 'hi', project: '{lab}', start: false }, allow: OWNER },
  { method: 'POST', path: '/api/sessions', body: { text: 'hi', start: false }, allow: OWNER },
  { method: 'GET', path: '/api/sessions/{st}', allow: SHOP_READ, safe: true },
  { method: 'GET', path: '/api/sessions/{st}/flow', allow: SHOP_READ, safe: true },
  { method: 'GET', path: '/api/sessions/{lt}/flow', allow: OWNER, safe: true },
  { method: 'GET', path: '/api/sessions/{lt}', allow: OWNER, safe: true },
  { method: 'GET', path: '/api/sessions/{dt}', allow: OWNER, safe: true },
  ...['messages', 'title', 'model', 'effort', 'yolo', 'interrupt', 'keep', 'finish', 'outcome', 'run', 'lead', 'answer-all', 'guard', 'spinout', 'people', 'members', 'react', 'unqueue', 'send-now', 'archive', 'delete'].flatMap(
    (action): Route[] => [
      { method: 'POST', path: `/api/sessions/{st}/${action}`, body: { text: 'x', title: 'x' }, allow: SHOP_WORK },
      { method: 'POST', path: `/api/sessions/{lt}/${action}`, body: { text: 'x', title: 'x' }, allow: OWNER },
      { method: 'POST', path: `/api/sessions/{dt}/${action}`, body: { text: 'x', title: 'x' }, allow: OWNER },
    ],
  ),
  // A question in Lab's thread, and claiming it.
  { method: 'POST', path: '/api/questions/{q}', body: { answer: 'decline' }, allow: OWNER },
  { method: 'POST', path: '/api/questions/{q}/claim', body: {}, allow: OWNER },
  // A secret pasted into Shop's thread. The value in this body is a fixture; a refusal must not keep it.
  { method: 'POST', path: '/api/secrets', body: { session: '{st}', name: 'shop/token', value: 'not-a-real-secret', purpose: 'test', who: 'project' }, allow: SHOP_WORK },

  // A connection granted only to Lab: its page, and everything done to it.
  { method: 'GET', path: '/api/connections/{conn}', allow: OWNER, safe: true },
  ...['test', 'reconnect', 'disconnect', 'ceiling', 'signin', 'grant', 'revoke', 'dismiss'].map((action): Route => ({ method: 'POST', path: `/api/connections/{conn}/${action}`, body: { project: '{lab}', tools: [] }, allow: OWNER })),
  { method: 'POST', path: '/api/connections/{conn}/github-install', body: {}, allow: OWNER },
  ...['link', 'finish', 'consent', 'accounts'].map((step): Route => ({ method: 'POST', path: `/api/connections/{conn}/plaid/${step}`, body: {}, allow: OWNER })),
  { method: 'POST', path: '/api/connections/{conn}/sign-ins', body: {}, allow: OWNER },
  { method: 'GET', path: '/api/connections/{conn}/live/x', allow: OWNER },
  { method: 'POST', path: '/api/connections/{conn}/live/x/input', body: {}, allow: OWNER },
  { method: 'POST', path: '/api/connections/{conn}/live/x/size', body: { width: 1280, height: 800 }, allow: OWNER },
  { method: 'POST', path: '/api/connections/{conn}/live/x/cancel', body: {}, allow: OWNER },

  // Files: an image and an artifact from Lab's thread; uploads for anyone who can send something.
  { method: 'GET', path: '/api/images/{img}', allow: OWNER, safe: true },
  { method: 'GET', path: '/artifacts/{art}/file', allow: OWNER, safe: true },
  { method: 'GET', path: '/artifacts/{art}/download', allow: OWNER, safe: true },
];

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let base: string;
const cookies = new Map<Role, string>();
const ids: Record<string, string> = {};
const id = (key: string) => ids[key]!;
const savedEnv = { ...process.env };

const fill = (text: string) => text.replace(/\{(\w+)\}/g, (_, key: string) => ids[key] ?? `{${key}}`);
const fillBody = (body: Record<string, unknown> | undefined) => (body === undefined ? undefined : JSON.parse(fill(JSON.stringify(body))));

async function pairAs(personId?: string): Promise<string> {
  const res = await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode(undefined, personId)}`, { redirect: 'manual' });
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

async function call(role: Role, route: Route): Promise<number> {
  const headers: Record<string, string> = { origin: base, 'content-type': 'application/json' };
  const cookie = cookies.get(role);
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${base}${fill(route.path)}`, { method: route.method, headers, body: route.method === 'GET' || route.method === 'DELETE' ? undefined : JSON.stringify(fillBody(route.body) ?? {}), redirect: 'manual' });
  // The event stream stays open: its status is the answer.
  if (route.path === '/api/events') await res.body?.cancel().catch(() => undefined);
  else await res.arrayBuffer().catch(() => undefined);
  return res.status;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-access-matrix-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\ndefault_model = "gpt-api"\n${DEFAULT_CONFIG.replace('accepted = []', '')}\n[isolation]\nlevel = "host"\n`);
  mkdirSync(join(home, 'agents', 'helper'), { recursive: true });
  writeFileSync(join(home, 'agents', 'helper', 'agent.toml'), 'description = "helps"\nmodel = "gpt-api"\n');
  polyphemus = await Polyphemus.open(home);
  polyphemus.registry.use('openai', new Quiet());
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;

  cookies.set('owner', await pairAs());
  const owner = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: cookies.get('owner')!, origin: base, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as Promise<Record<string, any>>);
  const shop = (await owner('/api/projects', { name: 'Shop' })).project;
  const lab = (await owner('/api/projects', { name: 'Lab' })).project;
  ids.shop = shop.slug;
  ids.lab = lab.slug;

  const person = (name: string) => polyphemus.store.addPerson(name);
  const sam = person('Sam');
  const val = person('Val');
  const kim = person('Kim');
  const rae = person('Rae');
  ids.sam = sam.id;
  polyphemus.store.setProjectRole(shop.slug, sam.id, 'member');
  polyphemus.store.setProjectRole(shop.slug, val.id, 'viewer');
  polyphemus.store.setProjectRole(shop.slug, rae.id, 'member');
  cookies.set('member', await pairAs(sam.id));
  cookies.set('viewer', await pairAs(val.id));
  cookies.set('outsider', await pairAs(kim.id));
  cookies.set('removed', await pairAs(rae.id));
  cookies.set('revoked', await pairAs());
  polyphemus.store.removePerson(rae.id);
  const revoked = polyphemus.store.listDevices().filter((d) => !d.revokedAt).at(-1)!;
  polyphemus.store.revokeDevice(revoked.id);
  // A device of the owner's to try signing out.
  await pairAs();
  ids.dev = polyphemus.store.listDevices().filter((d) => !d.revokedAt).at(-1)!.id;

  // Threads: one in Shop, one in Lab, and one of the owner's outside every project.
  ids.st = (await owner('/api/sessions', { text: 'shop work', project: shop.slug, start: false })).id;
  ids.lt = (await owner('/api/sessions', { text: 'lab secret', project: lab.slug, start: false })).id;
  ids.dt = (await owner('/api/sessions', { text: 'just mine', start: false })).id;
  ids.agent = 'helper';
  const labAgent = join(lab.path, '.polyphemus', 'agents', 'secret');
  mkdirSync(labAgent, { recursive: true });
  writeFileSync(join(labAgent, 'agent.toml'), 'description = "the lab’s own"\nmodel = "gpt-api"\n');
  ids.labAgent = encodeURIComponent(`${lab.slug}/secret`);

  // Routines, accepted, in each project.
  for (const [project, name] of [[shop, 'daily'], [lab, 'nightly']] as const) {
    mkdirSync(join(project.path, '.polyphemus', 'routines'), { recursive: true });
    writeFileSync(join(project.path, '.polyphemus', 'routines', `${name}.md`), '---\nmodel: gpt-api\ntriggers: [{ every: 1h }]\n---\nCheck.\n');
  }
  ids.rt = encodeURIComponent(`${shop.slug}/daily`);
  ids.lrt = encodeURIComponent(`${lab.slug}/nightly`);

  // A question, an image and an artifact, all in Lab's thread.
  ids.q = polyphemus.store.askQuestion({ id: 'q1abc234', sessionId: id('lt'), kind: 'note', detail: { name: 'x', description: 'x', text: 'x', agent: 'helper', scopes: ['project'] } }).id;
  const png = readFileSync(fileURLToPath(new URL('../web/icon-192.png', import.meta.url)));
  const up = await fetch(`${base}/api/images`, { method: 'POST', headers: { cookie: cookies.get('owner')!, origin: base, 'content-type': 'application/octet-stream' }, body: png });
  ids.img = ((await up.json()) as { id: string }).id;
  await owner(`/api/sessions/${ids.lt}/messages`, { text: 'look', images: [ids.img] });
  const artifact = { id: '0123456789abcdef', sessionId: id('lt'), seq: 1, title: 'Lab chart', kind: 'markdown' as const, mediaType: 'text/markdown', name: 'chart.md', bytes: 7, createdAt: Date.now() };
  mkdirSync(join(home, 'artifacts', id('lt')), { recursive: true });
  writeFileSync(artifactFile(home, artifact), '# Chart');
  polyphemus.store.recordArtifact(artifact);
  ids.art = artifact.id;

  // A connection granted only to Lab.
  const added = await owner('/api/connections', { name: 'Contacts', kind: 'stdio', command: process.execPath, args: [FIXTURE], secrets: { CONTACTS_TOKEN: 'contacts-token-that-must-never-leave' } });
  ids.conn = added.connection?.id ?? added.id;
  await owner(`/api/connections/${ids.conn}/grant`, { project: lab.slug, tools: ['read_contacts'] });
}, 60_000);

afterAll(async () => {
  await daemon.close();
  polyphemus.close();
  process.env = { ...savedEnv };
});

const REFUSED = [401, 403, 404];

describe('who can do what, route by route', () => {
  it('refuses everyone a route doesn’t name — before doing anything — and lets in whoever it does', async () => {
    const wrong: string[] = [];
    // Refusals first: they change nothing, so the fixture is intact for the rest.
    for (const route of ROUTES) {
      for (const role of ALL.filter((r) => !route.allow.includes(r))) {
        const status = await call(role, route);
        if (!REFUSED.includes(status)) wrong.push(`${role} ${route.method} ${fill(route.path)} → ${status}, should be refused`);
      }
    }
    for (const route of ROUTES.filter((r) => r.safe)) {
      for (const role of route.allow) {
        const status = await call(role, route);
        if (REFUSED.includes(status) || status >= 500) wrong.push(`${role} ${route.method} ${fill(route.path)} → ${status}, should be let in`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it('lists every route the server has', () => {
    // Every name the router matches on — a path, a path segment, a thread's action, a connection's —
    // must be in some route above.
    const listed = ROUTES.map((r) => r.path.split('?')[0]!);
    const segments = new Set(listed.flatMap((p) => p.split('/')));
    const names = new Set<string>();
    for (const source of [SERVER, CONNECTIONS]) {
      for (const [, path] of source.matchAll(/path === '(\/api\/[^']+)'/g)) names.add(path!);
      for (const [, part] of source.matchAll(/parts\[\d\] === '([a-z-]+)'/g)) names.add(part!);
      for (const [, action] of source.matchAll(/^ {8}case '([a-z-]+)':/gm)) names.add(action!);
    }
    for (const [, list] of CONNECTIONS.matchAll(/\[('[a-z-]+'(?:, '[a-z-]+')+)\]\.includes\(action/g)) for (const [, a] of list!.matchAll(/'([a-z-]+)'/g)) names.add(a!);
    const missing = [...names].filter((name) => (name.startsWith('/api/') ? !listed.includes(name) : !segments.has(name)));
    expect(missing).toEqual([]);
  });
});
