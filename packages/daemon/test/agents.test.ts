import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, emptyUsage, Polyphemus, libraryAgentsDir, librarySkillsDir, saveSkillIndex, type ChatRequest, type ModelProvider, type ProviderEvent, defaultMark } from '@polyphemus/core';
import { createServer, connect, type Socket } from 'node:net';
import WebSocket from 'ws';
import { startDaemon, type Daemon } from '../src/server.js';

class RecordingProvider implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'openai';
  readonly requests: ChatRequest[] = [];
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    // Setting up an agent asks for two tagged sections; anything else is an ordinary turn.
    const asksForAPersona = JSON.stringify(req.messages).includes('<persona>');
    const text = asksForAPersona
      ? '<persona>\nYou chase things down.\n</persona>\n<instructions>\nYou own the pipeline, and nothing goes out until someone has looked.\n</instructions>'
      : 'Looked at it.';
    yield { type: 'text_delta', text };
    yield {
      type: 'message_done',
      message: { role: 'assistant', content: [{ type: 'text', text }], origin: { provider: this.id, model: req.model } },
      stopReason: 'end_turn',
      usage: emptyUsage(),
    };
  }
  async listModels() {
    return [];
  }
}

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let base: string;
let cookie: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-daemon-agents-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\n${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  mkdirSync(join(libraryAgentsDir(home), 'reviewer'), { recursive: true });
  writeFileSync(join(libraryAgentsDir(home), 'reviewer', 'agent.toml'), 'description = "reviewing changes before they ship"\ntitle = "Reviewer"\nmodel = "gpt-api"\n');
  writeFileSync(join(libraryAgentsDir(home), 'reviewer', 'persona.md'), 'You are blunt and specific.');

  polyphemus = await Polyphemus.open(home);
  polyphemus.registry.use('openai', new RecordingProvider());
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

const call = async (path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, any> };
};

describe('agents from the app', () => {
  it('lists the roster and starts a thread as one, on the agent’s own model', async () => {
    const { data: state } = await call('/api/state');
    // The mark comes with it: the app draws the roster from this, and never guesses.
    expect(state.agents).toEqual([
      { id: 'reviewer', name: 'reviewer', title: 'Reviewer', description: 'reviewing changes before they ship', scope: 'library', project: null, model: 'gpt-api', fallback: [], mark: defaultMark('reviewer') },
    ]);

    const { status, data } = await call('/api/sessions', { text: 'have a look', agent: 'reviewer' });
    expect(status).toBe(201);
    expect(data.meta.agent).toBe('reviewer');
    // The agent's model, not the default the session would have used.
    expect(data.meta.provider).toBe('openai');

    const detail = await (async () => {
      for (let i = 0; i < 100; i++) {
        const { data: d } = await call(`/api/sessions/${data.id}`);
        if (!d.running && d.messages.length >= 2) return d;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error('timed out');
    })();
    expect(detail.meta.agent).toBe('reviewer');

    // The session in the list carries its agent, so the app can show it.
    const { data: after } = await call('/api/state');
    expect(after.sessions.find((s: { id: string }) => s.id === data.id).agent).toBe('reviewer');
  });

  it('has a default agent, named and voiced at setup, that new threads are with when nobody picked one', async () => {
    // A thread from before there was one stays with no one: it never ran as the default agent.
    const before = await call('/api/sessions', { text: 'an old question', model: 'gpt-api' });
    expect(before.data.meta.agent).toBe('');

    const made = await call('/api/default-agent', { title: 'Helm', personality: 'plain' });
    expect(made).toMatchObject({ status: 200, data: { id: 'helm', title: 'Helm' } });
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toMatch(/^default_agent = "helm"$/m);
    const dir = join(libraryAgentsDir(home), 'helm');
    expect(readFileSync(join(dir, 'persona.md'), 'utf8')).toContain('Plain and direct');
    // It follows each thread's model instead of keeping one of its own.
    expect(readFileSync(join(dir, 'agent.toml'), 'utf8')).not.toMatch(/^model\s*=/m);
    expect((await call('/api/state')).data).toMatchObject({ defaultAgent: 'helm' });

    const provider = polyphemus.registry.get('openai') as unknown as RecordingProvider;
    const fresh = await call('/api/sessions', { text: 'who am I talking to?', model: 'gpt-api' });
    expect(fresh.data.meta).toMatchObject({ agent: 'helm', provider: 'openai' });
    for (let i = 0; i < 100 && !provider.requests.some((r) => JSON.stringify(r).includes('who am I talking to')); i++) await new Promise((r) => setTimeout(r, 30));
    const asked = JSON.stringify(provider.requests.find((r) => JSON.stringify(r).includes('who am I talking to')));
    expect(asked).toContain("You're Helm");
    expect((await call(`/api/sessions/${before.data.id}`)).data.meta.agent).toBe('');

    // Re-voiced, not duplicated; another agent's name isn't taken over; and it can't be deleted.
    expect((await call('/api/default-agent', { title: 'Helm', personality: 'warm' })).status).toBe(200);
    expect(readFileSync(join(dir, 'persona.md'), 'utf8')).toContain('Warm and encouraging');
    expect((await call('/api/default-agent', { title: 'Reviewer', personality: 'plain' })).status).toBe(409);
    expect((await call('/api/default-agent', { title: 'Helm', personality: 'own', words: '' })).status).toBe(400);
    expect((await call('/api/agents/helm/delete', {})).status).toBe(409);
    expect(existsSync(dir)).toBe(true);
  });

  it('keeps two projects’ agents of the same name apart', async () => {
    const shop = (await call('/api/projects', { name: 'Shop' })).data.project;
    const blog = (await call('/api/projects', { name: 'Blog' })).data.project;
    for (const [project, persona] of [[shop, 'You review the shop.'], [blog, 'You review the blog.']] as const) {
      const dir = join(project.path, '.polyphemus', 'agents', 'critic');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'agent.toml'), 'description = "reviews"\nmodel = "gpt-api"\n');
      writeFileSync(join(dir, 'persona.md'), persona);
    }
    const ids = (await call('/api/state')).data.agents.map((a: { id: string }) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['shop/critic', 'blog/critic', 'reviewer']));
    expect((await call('/api/agents/shop%2Fcritic')).data.agent.persona).toBe('You review the shop.');
    expect((await call('/api/agents/blog%2Fcritic')).data.agent.persona).toBe('You review the blog.');
    // A bare name that two projects share finds nothing, rather than the wrong one…
    expect((await call('/api/agents/critic')).status).toBe(404);
    // …but inside a thread in one of them, the bare name means that project's agent.
    const thread = await call('/api/sessions', { project: 'blog', text: 'hi', model: 'gpt-api', start: false });
    const joined = await call(`/api/sessions/${thread.data.id}/members`, { agent: 'critic' });
    expect(joined.data.members).toMatchObject([{ id: 'blog/critic' }]);
  });

  it('gives a new agent today’s default to keep, and lets one follow the default on purpose', async () => {
    await call('/api/routing', { defaultModel: 'gpt-api' });
    await call('/api/agents', { name: 'scout', description: 'looking around' });
    await call('/api/agents', { name: 'copy', from: 'reviewer' });
    expect((await call('/api/agents/scout')).data.agent.model).toBe('gpt-api');
    expect((await call('/api/agents/copy')).data.agent.model).toBe('gpt-api');

    // Changing the default doesn't move it…
    await call('/api/routing', { defaultModel: 'claude-api' });
    expect((await call('/api/agents/scout')).data.agent.model).toBe('gpt-api');
    // …unless it's told to follow.
    expect((await call('/api/agents/scout', { model: 'default' })).data.agent.model).toBe('default');
    expect((await call('/api/agents/scout', { model: 'no-such-model' })).status).toBe(400);
  });

  it('makes one from a template, and edits it, without touching a terminal', async () => {
    const { data: before } = await call('/api/state');
    expect(before.agentTemplates.map((t: { name: string }) => t.name)).toEqual(['analyst', 'assistant', 'builder', 'ops', 'planner', 'researcher', 'reviewer', 'writer']);

    const created = await call('/api/agents', { name: 'critic', from: 'reviewer' });
    expect(created.status).toBe(201);

    const { data: state } = await call('/api/state');
    // Renamed as it was copied, so it's its own agent from the start.
    expect(state.agents.find((a: { name: string }) => a.name === 'critic')).toMatchObject({ title: 'Critic', scope: 'library' });

    const { data: got } = await call('/api/agents/critic');
    expect(got.agent.persona).toContain('3am');

    const { data: saved } = await call('/api/agents/critic', { description: 'checking my work before I ship it', persona: 'You are kind but exacting.', model: 'gpt-api' });
    expect(saved.agent).toMatchObject({ description: 'checking my work before I ship it', persona: 'You are kind but exacting.', model: 'gpt-api' });
    // The file keeps its shape: comments survive an edit made from a phone.
    expect((await call('/api/agents/critic')).data.agent.instructions).toContain('Read the change first');

    // And a thread can be started as it, from the app, on the model it was just given.
    const thread = await call('/api/sessions', { text: 'have a look', agent: 'critic' });
    expect(thread.status).toBe(201);
    expect(thread.data.meta.agent).toBe('critic');

    // Clearing the model puts it back on whatever the session would have used. With no default
    // model in this config either, there's then nothing to run on, and polyphemus says so rather
    // than picking for you.
    const { data: cleared } = await call('/api/agents/critic', { model: '' });
    expect(cleared.agent.model).toBeUndefined();
    expect((await call('/api/sessions', { text: 'again', agent: 'critic' })).data.error).toBe('Pick a model.');
  });

  it('says what’s wrong with a name it can’t use', async () => {
    expect((await call('/api/agents', { name: 'Not Valid' })).status).toBe(400);
    // "reviewer" is already in this home (beforeEach), so a fresh name proves creation works…
    expect((await call('/api/agents', { name: 'second-opinion', from: 'reviewer' })).status).toBe(201);
    // …and the same name twice is refused rather than overwriting what's there.
    expect((await call('/api/agents', { name: 'second-opinion', from: 'reviewer' })).status).toBe(409);
    expect((await call('/api/agents', { name: 'reviewer', from: 'reviewer' })).status).toBe(409);
    expect((await call('/api/agents/nope')).status).toBe(404);
  });

  it('refuses an agent that isn’t there', async () => {
    const { status, data } = await call('/api/sessions', { text: 'hi', agent: 'nope' });
    expect(status).toBe(400);
    expect(data.error).toContain('No agent called "nope"');
  });

  it('makes an agent from a name, a mark and a sentence, and writes its persona afterwards', async () => {
    const { status, data } = await call('/api/agents', {
      name: 'bd',
      description: 'chasing the pipeline and keeping the CRM honest',
      model: 'gpt-api',
      mark: { shape: 'drop', color: 'amber' },
    });
    expect(status).toBe(201);
    // It exists now. The words are still being written.
    expect(data.drafting).toBe(true);
    expect(readFileSync(join(libraryAgentsDir(home), 'bd', 'agent.toml'), 'utf8')).toContain('mark = { shape = "drop", color = "amber" }');

    const persona = join(libraryAgentsDir(home), 'bd', 'persona.md');
    for (let i = 0; i < 50 && !readFileSync(persona, 'utf8').includes('chase'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(readFileSync(persona, 'utf8')).toContain('You chase things down.');
    expect(readFileSync(join(libraryAgentsDir(home), 'bd', 'instructions.md'), 'utf8')).toContain('nothing goes out until someone has looked');

    const { data: agent } = await call('/api/agents/bd');
    expect(agent.agent.mark).toEqual({ shape: 'drop', color: 'amber' });
  });

  it('still makes the agent when there is nothing to write its persona with', async () => {
    // No model on the agent, none named "cheap", and no default: nothing to draft on.
    const { status, data } = await call('/api/agents', { name: 'quiet', description: 'watching the logs' });
    expect(status).toBe(201);
    expect(data.drafting).toBe(false);
    const { data: agent } = await call('/api/agents/quiet');
    expect(agent.agent.description).toBe('watching the logs');
    expect(agent.agent.mark).toEqual(defaultMark('quiet'));
  });

  it('resets a mark to the one its name gets', async () => {
    await call('/api/agents', { name: 'ops', description: 'the servers', mark: { shape: 'cloud', color: 'pink' } });
    const { data: picked } = await call('/api/agents/ops', { mark: { shape: 'tri', color: 'slate' } });
    expect(picked.agent.mark).toEqual({ shape: 'tri', color: 'slate' });
    const { data: reset } = await call('/api/agents/ops', { mark: null });
    expect(reset.agent.mark).toEqual(defaultMark('ops'));
  });

  it('refuses a mark it can’t draw', async () => {
    const { status, data } = await call('/api/agents', { name: 'nope', description: 'x', mark: { shape: 'octagon', color: 'amber' } });
    expect(status).toBe(400);
    expect(String(data.error)).toContain("shape must be one of");
  });

  it('renames what an agent is called without renaming its folder', async () => {
    await call('/api/agents', { name: 'bd', description: 'the pipeline' });
    // "bd" becomes "Bd", which is right for a word and wrong for an acronym.
    const { data: made } = await call('/api/agents/bd');
    expect(made.agent.title).toBe('Bd');

    const { data: renamed } = await call('/api/agents/bd', { title: 'BD' });
    expect(renamed.agent.title).toBe('BD');
    expect(renamed.agent.name).toBe('bd');
    expect(readFileSync(join(libraryAgentsDir(home), 'bd', 'agent.toml'), 'utf8')).toContain('title = "BD"');

    // Emptied, it goes back to the one its name gets rather than to nothing.
    const { data: reset } = await call('/api/agents/bd', { title: '' });
    expect(reset.agent.title).toBe('Bd');
  });

  it('keeps a fallback or two, and clears them', async () => {
    await call('/api/agents', { name: 'bd', description: 'the pipeline', model: 'gpt-api' });
    const { data } = await call('/api/agents/bd', { fallback: ['gpt-api', 'openai:gpt-6-astra'] });
    expect(data.agent.fallback).toEqual(['gpt-api', 'openai:gpt-6-astra']);
    expect(readFileSync(join(libraryAgentsDir(home), 'bd', 'agent.toml'), 'utf8')).toContain('fallback = ["gpt-api", "openai:gpt-6-astra"]');
    // A name that isn't any model is refused rather than kept to fail later.
    expect((await call('/api/agents/bd', { fallback: ['no-such-model'] })).status).toBe(400);

    const cleared = await call('/api/agents/bd', { fallback: [] });
    expect(cleared.data.agent.fallback).toEqual([]);
    expect(readFileSync(join(libraryAgentsDir(home), 'bd', 'agent.toml'), 'utf8')).not.toContain('fallback =');
  });

  it('holds agents and threads to your list of models, however the model got set', async () => {
    await call('/api/selected', { selected: ['openai:gpt-5'] });
    const refused = 'openai:gpt-9-pricey isn’t on your models list';
    // Made or changed from the app: refused before anything is saved.
    const made = await call('/api/agents', { name: 'coach', description: 'coaching', model: 'openai:gpt-9-pricey' });
    expect(made.status).toBe(400);
    expect(made.data.error).toContain(refused);
    expect((await call('/api/agents/reviewer', { model: 'openai:gpt-9-pricey' })).data.error).toContain(refused);
    expect((await call('/api/agents/reviewer', { fallback: ['openai:gpt-9-pricey'] })).data.error).toContain(refused);
    expect((await call('/api/sessions', { text: 'hi', model: 'openai:gpt-9-pricey' })).data.error).toContain(refused);
  });

  it('lists skills by where they live, searches the library, and lets only the owner change them', async () => {
    const write = (dir: string, name: string, description: string) => {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'SKILL.md'), `---\ndescription: ${description}\n---\n\nSteps.\n`);
    };
    write(librarySkillsDir(home), 'deploy', 'shipping things');
    write(join(libraryAgentsDir(home), 'reviewer', 'skills'), 'nitpick', 'finding the small things');
    const installed = (await call('/api/skills')).data;
    expect(installed.library).toEqual([{ name: 'deploy', description: 'shipping things', from: null }]);
    expect(installed.agents.find((a: any) => a.id === 'reviewer').skills).toEqual([{ name: 'nitpick', description: 'finding the small things', from: null }]);

    saveSkillIndex(home, { builtAt: Date.now(), withheld: 4, problems: [], skills: [
      { id: 'anthropic/frontend-design', name: 'frontend-design', description: 'distinctive UI', source: 'anthropic', sourceName: 'Anthropic', repo: 'anthropics/skills', path: 'skills/frontend-design', license: 'Apache-2.0', licenseFile: 'skills/frontend-design/LICENSE.txt' },
      { id: 'superpowers/brainstorming', name: 'brainstorming', description: 'before creative work', source: 'superpowers', sourceName: 'Superpowers (obra)', repo: 'obra/superpowers', path: 'skills/brainstorming', license: 'MIT', licenseFile: 'LICENSE' },
    ] });
    const lib = (await call('/api/skills/library?q=creative')).data;
    expect(lib).toMatchObject({ total: 2, withheld: 4, building: null });
    expect(lib.skills.map((k: any) => k.id)).toEqual(['superpowers/brainstorming']);
    expect((await call('/api/skills/install', { id: 'nope/nothing', to: 'library' })).status).toBe(404);
    expect((await call('/api/skills/install', { id: 'superpowers/brainstorming', to: 'agent:nobody' })).status).toBe(400);

    // Removing moves it aside, and it's gone from the list.
    expect((await call('/api/skills/remove', { name: 'nitpick', from: 'agent:reviewer' })).status).toBe(200);
    expect((await call('/api/skills')).data.agents.find((a: any) => a.id === 'reviewer').skills).toEqual([]);
    expect(existsSync(join(libraryAgentsDir(home), 'reviewer', 'skills', 'nitpick'))).toBe(false);
  });

  it('offers an agent a computer of its own, and serves the viewer only to a paired device', async () => {
    const state = (await call('/api/agents/reviewer/computer')).data;
    expect(state).toMatchObject({ state: 'asleep', canUse: true });
    expect((await call('/api/agents/nobody/computer')).status).toBe(404);
    // The viewer's own files: to a paired device, and nothing outside noVNC's code.
    const viewer = await fetch(`${base}/vendor/novnc/core/rfb.js`, { headers: { cookie } });
    expect(viewer.status).toBe(200);
    expect(viewer.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/vendor/novnc/core/rfb.js`)).status).toBe(401);
    expect((await fetch(`${base}/vendor/novnc/../package.json`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/vendor/novnc/LICENSE.txt`, { headers: { cookie } })).status).toBe(404);
    // The screen is a WebSocket for the owner, from this app's own pages: a plain request isn't one.
    expect((await fetch(`${base}/api/agents/reviewer/computer/screen`, { headers: { cookie } })).status).toBe(404);
  });

  it('refuses a malformed computer view without going down, and closes a view when its device is signed out', async () => {
    const opened = (path: string, withCookie: string) =>
      new Promise<{ ws: WebSocket; open: boolean; closed: Promise<void> }>((resolve) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}${path}`, 'binary', { headers: { cookie: withCookie, origin: base } });
        const closed = new Promise<void>((done) => ws.on('close', () => done()));
        ws.on('open', () => resolve({ ws, open: true, closed }));
        ws.on('error', () => resolve({ ws, open: false, closed }));
      });
    // "%" alone isn't a valid escape: refused, and the daemon still answers.
    expect((await opened('/api/agents/%/computer/screen', cookie)).open).toBe(false);
    expect((await call('/api/agents/reviewer/computer')).status).toBe(200);

    // A stand-in for the computer's screen, so no container is needed.
    const vnc = createServer((socket: Socket) => socket.write('RFB 003.008\n'));
    await new Promise<void>((r) => vnc.listen(0, '127.0.0.1', r));
    const port = (vnc.address() as { port: number }).port;
    polyphemus.desktops.screen = async () => connect(port, '127.0.0.1');

    // A second device of the owner's opens it; the first signs that one out.
    const res = await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' });
    const phone = res.headers.get('set-cookie')!.split(';')[0]!;
    const view = await opened('/api/agents/reviewer/computer/screen', phone);
    expect(view.open).toBe(true);
    const phoneId = polyphemus.store.listDevices().filter((d) => !d.revokedAt).at(-1)!.id;
    expect((await call(`/api/devices/${phoneId}/revoke`, {})).status).toBe(200);
    await view.closed;
    expect(view.ws.readyState).toBe(WebSocket.CLOSED);
    vnc.close();
  });

  it('lets an agent use its own computer when the owner says so, and holds its hands while someone has it', async () => {
    expect((await call('/api/agents/reviewer/computer')).data.allowed).toBe(false);
    const allowedNow = await call('/api/agents/reviewer/computer', { action: 'allow', on: true });
    expect(allowedNow.data).toMatchObject({ allowed: true });
    const computer = polyphemus.connections.list().find((c) => c.server.kind === 'builtin' && c.server.builtin === 'computer')!;
    expect(computer.tools.map((t) => t.name)).toEqual(['look', 'click', 'type', 'key', 'scroll', 'drag', 'open', 'take_attachment', 'give_file', 'run']);
    // It's the agent's to carry, and only that agent's.
    expect(polyphemus.connections.reach(undefined, 'reviewer').find((r) => r.connection === computer.id)?.tools).toContain('click');
    expect(polyphemus.connections.reach(undefined, 'bd')).toEqual([]);

    // Someone takes it over: the agent's hands wait, and say why.
    expect((await call('/api/agents/reviewer/computer', { action: 'take' })).data.heldBy).toBe('Alex');
    const held = await polyphemus.connections.call(computer.id, 'click', { x: 10, y: 10 }, { agent: 'reviewer' });
    expect(held).toMatchObject({ isError: true, content: expect.stringContaining('Alex has taken over your computer') });
    expect((await call('/api/agents/reviewer/computer', { action: 'give' })).data.heldBy).toBeNull();
    // A thread speaking as nobody has no computer to use.
    expect((await polyphemus.connections.call(computer.id, 'look', {}, {})).isError).toBe(true);

    expect((await call('/api/agents/reviewer/computer', { action: 'allow', on: false })).data.allowed).toBe(false);
  });

  it('moves files in and out of an agent’s computer, and never outside its folders', async () => {
    // From the app: send one in, see it listed, take it back out.
    const sent = await fetch(`${base}/api/agents/reviewer/computer/files`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('Budget.csv') }, body: 'rent,1500\n' });
    expect(await sent.json()).toEqual({ name: 'Budget.csv', in: 'Downloads' });
    const listed = (await call('/api/agents/reviewer/computer/files')).data.files;
    expect(listed).toEqual([expect.objectContaining({ name: 'Budget.csv', in: 'Downloads', bytes: 10 })]);
    const back = await fetch(`${base}/api/agents/reviewer/computer/files/download?in=Downloads&name=Budget.csv`, { headers: { cookie } });
    expect(await back.text()).toBe('rent,1500\n');
    expect((await fetch(`${base}/api/agents/reviewer/computer/files/download?in=Downloads&name=${encodeURIComponent('../../agent.toml')}`, { headers: { cookie } })).status).toBe(400);

    // The agent: an attachment onto its computer, and a file of its own back into the thread.
    expect((await call('/api/agents/reviewer/computer', { action: 'allow', on: true })).status).toBe(200);
    const computer = polyphemus.connections.list().find((c) => c.server.kind === 'builtin' && c.server.builtin === 'computer')!;
    const thread = await mkdtemp(join(tmpdir(), 'polyphemus-thread-'));
    mkdirSync(join(thread, 'attachments'));
    writeFileSync(join(thread, 'attachments', 'June.pdf'), '%PDF-june');
    const taken = await polyphemus.connections.call(computer.id, 'take_attachment', { path: 'attachments/June.pdf' }, { agent: 'reviewer', cwd: thread });
    expect(taken.content).toContain('~/Downloads/June.pdf');
    expect((await polyphemus.connections.call(computer.id, 'take_attachment', { path: '../../etc/passwd' }, { agent: 'reviewer', cwd: thread })).isError).toBe(true);
    const given = await polyphemus.connections.call(computer.id, 'give_file', { path: '~/Downloads/Budget.csv' }, { agent: 'reviewer', cwd: thread });
    expect(given.content).toContain('attachments/Budget.csv');
    expect(readFileSync(join(thread, 'attachments', 'Budget.csv'), 'utf8')).toBe('rent,1500\n');
    expect((await polyphemus.connections.call(computer.id, 'give_file', { path: '../../config.toml' }, { agent: 'reviewer', cwd: thread })).isError).toBe(true);

    // A link in either folder is refused, whatever it points at: the agent made it.
    const secret = join(home, 'config.toml');
    symlinkSync(secret, join(thread, 'attachments', 'innocent.pdf'));
    const linked = await polyphemus.connections.call(computer.id, 'take_attachment', { path: 'attachments/innocent.pdf' }, { agent: 'reviewer', cwd: thread });
    expect(linked.isError).toBe(true);
    const desktopHome = polyphemus.desktops.homeDir('reviewer');
    symlinkSync(secret, join(desktopHome, 'Downloads', 'notes.txt'));
    expect((await polyphemus.connections.call(computer.id, 'give_file', { path: '~/Downloads/notes.txt' }, { agent: 'reviewer', cwd: thread })).isError).toBe(true);
    expect((await fetch(`${base}/api/agents/reviewer/computer/files/download?in=Downloads&name=notes.txt`, { headers: { cookie } })).status).toBe(404);

    // Downloads itself swapped for a link to a folder of yours: not listed, not downloaded (re-review, 2026-09-19).
    const yours = join(home, 'yours');
    mkdirSync(yours);
    writeFileSync(join(yours, 'tax.pdf'), 'private');
    rmSync(join(desktopHome, 'Downloads'), { recursive: true });
    symlinkSync(yours, join(desktopHome, 'Downloads'));
    expect((await call('/api/agents/reviewer/computer/files')).data.files.map((f: { name: string }) => f.name)).not.toContain('tax.pdf');
    expect((await fetch(`${base}/api/agents/reviewer/computer/files/download?in=Downloads&name=tax.pdf`, { headers: { cookie } })).status).toBe(404);
  });

  it('records a person doing a task on an agent’s computer, and hands it to the agent to learn', async () => {
    const provider = new RecordingProvider();
    polyphemus.registry.use('openai', provider);
    const rec = (body: Record<string, unknown>) => call('/api/agents/reviewer/computer', { action: 'record', ...body });
    expect((await rec({ phase: 'step', step: { kind: 'type', text: 'x' } })).status).toBe(409);
    await rec({ phase: 'start' });
    for (const ch of 'bank') await rec({ phase: 'step', step: { kind: 'type', text: ch } });
    await rec({ phase: 'step', step: { kind: 'key', keys: 'Return' } });
    await rec({ phase: 'step', step: { kind: 'click', x: 400, y: 220, button: 'left' } });
    await rec({ phase: 'step', step: { kind: 'scroll', direction: 'down' } });
    await rec({ phase: 'step', step: { kind: 'scroll', direction: 'down' } });
    const stopped = (await rec({ phase: 'stop' })).data;
    // Typing is one step, and two notches the same way are one scroll.
    expect(stopped.steps).toBe(4);

    const taught = (await rec({ phase: 'teach', recording: stopped.recording, about: 'checking the balance' })).data;
    const thread = (await call(`/api/sessions/${taught.session}`)).data;
    expect(thread.meta).toMatchObject({ agent: 'reviewer', title: 'Learning: checking the balance' });
    const said = JSON.stringify(thread.messages[0]);
    expect(said).toContain('1. Typed “bank”');
    expect(said).toContain('2. Pressed Return');
    expect(said).toContain('3. Clicked at 400,220');
    expect(said).toContain('4. Scrolled down 2 notches');
    expect(said).toContain('propose_skill');
    // Another agent's recording isn't this one's to learn from.
    expect((await call('/api/agents/bd/computer', { action: 'record', phase: 'teach', recording: stopped.recording })).status).toBeGreaterThanOrEqual(400);
  });

  it('is a thread with several agents: @name says who answers, a message naming nobody gets no answer, and who came and went is kept', async () => {
    await call('/api/agents', { name: 'bd', description: 'the pipeline', model: 'openai:gpt-6-astra' });
    const { data: made } = await call('/api/sessions', { text: 'hello', agent: 'reviewer' });
    const id = made.meta.id;

    // The agent it was made with is its first member.
    expect((await call(`/api/sessions/${id}`)).data.members.map((m: any) => m.name)).toEqual(['reviewer']);

    const { data: joined } = await call(`/api/sessions/${id}/members`, { agent: 'bd' });
    expect(joined.members.map((m: any) => m.name)).toEqual(['reviewer', 'bd']);

    // With more than one agent in the thread, a message that names nobody is nobody's to answer.
    const idle = async () => {
      for (let i = 0; i < 100 && (await call(`/api/sessions/${id}`)).data.running; i++) await new Promise((r) => setTimeout(r, 30));
    };
    await idle();
    const before = (await call(`/api/sessions/${id}`)).data.messages.length;
    const unnamed = await call(`/api/sessions/${id}/messages`, { text: 'can someone look at this' });
    expect(unnamed.status).toBe(202);
    expect(unnamed.data.answering).toBeNull();
    await idle();
    expect((await call(`/api/sessions/${id}`)).data.messages.length).toBe(before + 1);

    // Quoting a name to type isn't naming them: "send `@bd`" goes nowhere.
    const quoted = await call(`/api/sessions/${id}/messages`, { text: 'tell them to send `@bd` first' });
    expect(quoted.data.answering).toBeNull();
    await idle();

    const addressed = await call(`/api/sessions/${id}/messages`, { text: '@bd take a look' });
    expect(addressed.status).toBe(202);
    expect(addressed.data.answering).toBe('bd');
    await idle();

    // A thread set to have agents answer everything gives the rest to the lead.
    await call(`/api/sessions/${id}/answer-all`, { on: true });
    const toLead = await call(`/api/sessions/${id}/messages`, { text: 'anyone?' });
    expect(toLead.data.answering).toBe('reviewer');
    await idle();

    // And they can be sent out again; the thread's own agent moves to whoever is left.
    const { data: left } = await call(`/api/sessions/${id}/members`, { agent: 'reviewer', remove: true });
    expect(left.members.map((m: any) => m.name)).toEqual(['bd']);
    const detail = (await call(`/api/sessions/${id}`)).data;
    expect(detail.meta.agent).toBe('bd');

    // Who came and went stays on the thread after they've gone, with who did it.
    const owner = polyphemus.store.installOwner().id;
    expect(detail.attendance.map((a: any) => `${a.change} ${a.who}${a.by ? ` by ${a.by}` : ''}`)).toEqual([
      `joined Reviewer by person:${owner}`,
      `joined Bd by person:${owner}`,
      `left Reviewer by person:${owner}`,
    ]);

    // And a single-agent thread with only you in it is a chat: it answers without being named.
    const unnamedSolo = await call(`/api/sessions/${id}/messages`, { text: 'and now?' });
    expect(unnamedSolo.data.answering).toBe('bd');
  });

  it('says which project an agent lives in, so a message to it needn’t ask', async () => {
    const { data: made } = await call('/api/projects', { name: 'Acme BD' });
    expect(made.project.slug).toBe('acme-bd');
    await call('/api/agents', { name: 'bd', description: 'the pipeline', project: 'acme-bd' });

    const { data: state } = await call('/api/state');
    const bd = (state.agents as Array<Record<string, unknown>>).find((a) => a.name === 'bd');
    expect(bd).toMatchObject({ scope: 'project', project: 'acme-bd' });
    // One in your library belongs to no project, and says so rather than guessing.
    expect((state.agents as Array<Record<string, unknown>>).find((a) => a.name === 'reviewer')).toMatchObject({ scope: 'library', project: null });
  });
});

describe('deleting an agent', () => {
  it('names its threads and routines first, keeps the threads without it, and stops the routines (journey 14)', async () => {
    const { data: made } = await call('/api/projects', { name: 'Shop' });
    const project = made.project;
    await call('/api/agents', { name: 'bd', description: 'the pipeline', model: 'openai:gpt-6-astra' });
    const thread = (await call('/api/sessions', { text: 'pull the list', agent: 'bd', project: project.slug })).data.meta;
    for (let i = 0; i < 100 && (await call(`/api/sessions/${thread.id}`)).data.running; i++) await new Promise((r) => setTimeout(r, 30));
    mkdirSync(join(project.path, '.polyphemus', 'routines'), { recursive: true });
    writeFileSync(join(project.path, '.polyphemus', 'routines', 'weekly-outreach.md'), '---\nagent: bd\ntriggers: [{ every: 7d }]\n---\nPull this week’s outreach list.\n');

    const dependents = (await call('/api/agents/bd/dependents')).data;
    expect(dependents.threads).toEqual([{ id: thread.id, title: 'pull the list' }]);
    expect(dependents.routines).toEqual([expect.objectContaining({ name: 'weekly-outreach' })]);

    const deleted = await call('/api/agents/bd/delete', {});
    expect(deleted).toMatchObject({ status: 200, data: { deleted: true, threads: 1, routines: 1 } });
    expect(existsSync(join(home, 'agents', 'bd'))).toBe(false);
    expect(existsSync(deleted.data.trash)).toBe(true);

    // The thread still opens, without it; the routine stopped and says why.
    const after = await call(`/api/sessions/${thread.id}`);
    expect(after.status).toBe(200);
    expect(after.data.meta.agent).toBe('');
    expect(after.data.members).toEqual([]);
    const routine = (await call('/api/state')).data.routines.find((r: { name: string }) => r.name === 'weekly-outreach');
    expect(routine).toMatchObject({ paused: true, pausedReason: expect.stringContaining('was deleted') });
  });
});
