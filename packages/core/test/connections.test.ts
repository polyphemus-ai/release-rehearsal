import { DEFAULT_CONFIG } from '../src/config.js';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentProvider, AgentRunRequest, ConnectionServer } from '../src/agents/common.js';
import { codexMcpServer } from '../src/agents/codex-cli.js';
import { resolveModel } from '../src/config.js';
import { connectMcp, McpError } from '../src/connections/mcp-client.js';
import { GrantRefused } from '../src/connections/scope.js';
import { Polyphemus } from '../src/polyphemus.js';
import { createProject } from '../src/projects.js';
import { findAgent } from '../src/roster.js';
import { emptyUsage, type Block, type ChatRequest, type ModelProvider, type ProviderEvent, type StopReason } from '../src/types.js';

// Settled brief journeys 4 and 5: a grant cannot widen, and with nothing checked about a key, polyphemus
// still refuses calls outside the grant — from its own tool loop and from an agent CLI alike.

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-contacts.mjs', import.meta.url));
const contacts = () => ({ kind: 'stdio' as const, command: process.execPath, args: [FIXTURE] });

class ScriptedProvider implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'openai';
  requests: ChatRequest[] = [];
  constructor(private steps: Array<{ content: Block[]; stopReason: StopReason }>) {}
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    const step = this.steps.shift() ?? { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' as StopReason };
    yield { type: 'message_done', message: { role: 'assistant', content: step.content, origin: { provider: 'openai', model: req.model } }, stopReason: step.stopReason, usage: emptyUsage() };
  }
  async listModels() {
    return [];
  }
}

let home: string;
let polyphemus: Polyphemus;
const savedEnv = { ...process.env };
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-connections-'));
  // Tests of how things run on this computer: the level a fresh install wouldn't default to.
  await writeFile(join(home, 'config.toml'), `${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';
  await mkdir(join(home, 'agents', 'builder'), { recursive: true });
  await writeFile(join(home, 'agents', 'builder', 'agent.toml'), 'description = "Builds"\nmodel = "gpt-api"\n');
  polyphemus = await Polyphemus.open(home);
});
afterEach(() => {
  polyphemus.close();
  process.env = { ...savedEnv };
});

async function shopWithContacts() {
  const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Shop' });
  const owner = polyphemus.store.installOwner().id;
  const connection = await polyphemus.connections.add({ name: 'Contacts', owner, server: contacts(), secrets: { CONTACTS_TOKEN: 'good' }, createdBy: owner });
  return { project, owner, connection };
}

describe('the MCP client', () => {
  it('lists a server’s tools and tells a refused credential from a missing server', async () => {
    const client = await connectMcp({ ...contacts(), env: { CONTACTS_TOKEN: 'good' } });
    expect((await client.listTools()).map((t) => t.name)).toEqual(['read_contacts', 'write_contacts', 'delete_contacts']);
    expect(await client.callTool('read_contacts', {})).toEqual({ isError: false, text: 'read_contacts ok {}' });
    client.close();

    const expired = await connectMcp({ ...contacts(), env: { CONTACTS_TOKEN: 'old' } });
    await expect(expired.listTools()).rejects.toMatchObject({ kind: 'auth' });
    expired.close();
    await expect(connectMcp({ kind: 'stdio', command: join(home, 'no-such-server') })).rejects.toBeInstanceOf(McpError);
  });
});

describe('connections and grants', () => {
  it('keeps the secret in the vault, and knows what the server offers and what reads', async () => {
    const { connection } = await shopWithContacts();
    expect(connection.health).toBe('ok');
    expect(connection.tools.map((t) => [t.name, t.reads])).toEqual([
      ['read_contacts', true],
      ['write_contacts', false],
      ['delete_contacts', false],
    ]);
    expect(JSON.stringify(connection.server)).not.toContain('good');
    expect(connection.server).toMatchObject({ env: { CONTACTS_TOKEN: 'secret:connection/contacts/contacts_token' } });
    expect(connection.ceiling).toEqual({ provenance: 'unknown' });
  });

  it('refuses a grant wider than what it narrows (journey 4)', async () => {
    const { project, owner } = await shopWithContacts();
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, tools: ['read_contacts'], by: owner });

    // An agent can't be given write on a project that only has read.
    expect(() => polyphemus.connections.grant({ connection: 'contacts', project: project.slug, agent: 'builder', tools: ['read_contacts', 'write_contacts'], by: owner })).toThrow(GrantRefused);
    expect(() => polyphemus.connections.grant({ connection: 'contacts', project: 'elsewhere', agent: 'builder', tools: ['read_contacts'], by: owner })).toThrow(/isn’t granted to elsewhere/);
    expect(polyphemus.store.connections.grants('contacts').filter((g) => g.agent)).toEqual([]);

    // A declared ceiling bounds project grants, and trims the ones already made.
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, tools: ['read_contacts', 'write_contacts'], by: owner });
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, agent: 'builder', tools: ['write_contacts'], by: owner });
    polyphemus.connections.declareCeiling('contacts', ['read_contacts'], owner);
    expect(polyphemus.connections.get('contacts')!.ceiling).toMatchObject({ provenance: 'declared', by: owner, tools: ['read_contacts'] });
    expect(polyphemus.store.connections.grants('contacts')).toEqual([expect.objectContaining({ agent: '', tools: ['read_contacts'] })]);
    expect(() => polyphemus.connections.grant({ connection: 'contacts', project: project.slug, tools: ['delete_contacts'], by: owner })).toThrow(/outside this connection’s ceiling/);

    // Revoking the project's grant takes its agents' with it.
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, agent: 'builder', tools: ['read_contacts'], by: owner });
    polyphemus.connections.revoke('contacts', project.slug);
    expect(polyphemus.store.connections.grants('contacts')).toEqual([]);
  });

  it('stops the server it started once nobody may call it', async () => {
    // Revoking refuses the next call, but the server polyphemus started is a process holding the
    // credential and a connection to the service (connections review, 2026-09-20).
    const { project, owner } = await shopWithContacts();
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, tools: ['read_contacts'], by: owner });
    await polyphemus.connections.call('contacts', 'read_contacts', {}, { project: project.slug, sessionId: 'thread-revoke' });
    // Only the ones this test started: other test files run beside it, and the bracket keeps the
    // search from matching the shell that runs it.
    const running = () => execFileSync('bash', ['-c', `pgrep -P ${process.pid} -f '[m]cp-contacts.mjs' || true`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
    expect(running()).toBe(1);

    polyphemus.connections.revoke('contacts', project.slug);

    for (let i = 0; i < 50 && running() > 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(running()).toBe(0);
  });

  it('says where an agent’s reach comes from', async () => {
    const { project, owner } = await shopWithContacts();
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, tools: ['read_contacts', 'write_contacts'], by: owner });
    expect(polyphemus.connections.reach(project.slug, 'builder')).toEqual([expect.objectContaining({ tools: ['read_contacts', 'write_contacts'], inherited: true })]);
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, agent: 'builder', tools: ['read_contacts'], by: owner });
    expect(polyphemus.connections.reach(project.slug, 'builder')).toEqual([expect.objectContaining({ tools: ['read_contacts'], inherited: false, from: expect.objectContaining({ agent: 'builder' }) })]);
    expect(polyphemus.connections.reach(undefined, 'builder')).toEqual([]);
    expect(polyphemus.connections.reach('elsewhere', 'builder')).toEqual([]);
  });

  it('lets an agent carry a connection with no project, direct threads included', async () => {
    const { project, owner } = await shopWithContacts();
    // No project: the grant goes with the agent. Nothing else picks it up.
    polyphemus.connections.grant({ connection: 'contacts', agent: 'builder', tools: ['read_contacts', 'write_contacts'], by: owner });
    expect(polyphemus.connections.reach(undefined, 'builder')).toEqual([
      expect.objectContaining({ tools: ['read_contacts', 'write_contacts'], carried: true, inherited: false }),
    ]);
    expect(polyphemus.connections.reach(undefined, 'someone-else')).toEqual([]);
    expect(polyphemus.connections.reach(undefined, undefined)).toEqual([]);

    // In a project it has what the project grants and what it carries; another agent there has only the project's.
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, tools: ['read_contacts'], by: owner });
    expect(polyphemus.connections.reach(project.slug, 'builder')[0]).toMatchObject({ tools: ['read_contacts', 'write_contacts'], carried: true });
    expect(polyphemus.connections.reach(project.slug, 'other')[0]).toMatchObject({ tools: ['read_contacts'], carried: false });

    // The ceiling still bounds it, and trims what was already carried.
    polyphemus.connections.declareCeiling('contacts', ['read_contacts'], owner);
    expect(polyphemus.connections.reach(undefined, 'builder')[0]).toMatchObject({ tools: ['read_contacts'] });
    expect(() => polyphemus.connections.grant({ connection: 'contacts', agent: 'builder', tools: ['delete_contacts'], by: owner })).toThrow(/outside this connection’s ceiling/);

    // And it can be taken back on its own, leaving the project's grant alone.
    polyphemus.connections.revoke('contacts', '', 'builder');
    expect(polyphemus.connections.reach(undefined, 'builder')).toEqual([]);
    expect(polyphemus.connections.reach(project.slug, 'builder')[0]).toMatchObject({ tools: ['read_contacts'] });
  });

  it('calls what it carries in a thread outside every project, and nothing else', async () => {
    const { owner } = await shopWithContacts();
    polyphemus.connections.grant({ connection: 'contacts', agent: 'builder', tools: ['read_contacts'], by: owner });
    const provider = new ScriptedProvider([
      { content: [{ type: 'tool_call', id: 'c1', name: 'contacts__read_contacts', input: {} }], stopReason: 'tool_use' },
      { content: [{ type: 'tool_call', id: 'c2', name: 'contacts__write_contacts', input: {} }], stopReason: 'tool_use' },
    ]);
    polyphemus.registry.use('openai', provider);
    // A DM with the agent: home, no project at all.
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'gpt-api'), agent: findAgent(home, home, 'builder', undefined), autoApprove: true });
    await session.send('who do we have?');
    expect(provider.requests[0]!.tools!.map((t) => t.name).filter((n) => n.startsWith('contacts__'))).toEqual(['contacts__read_contacts']);
    const results = polyphemus.store.messages(session.meta!.id).flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(results).toEqual([
      expect.objectContaining({ content: 'read_contacts ok {}' }),
      expect.objectContaining({ content: expect.stringContaining('isn’t granted to builder itself, and this thread is in no project'), isError: true }),
    ]);
  });
});

describe('calls', () => {
  it('offers only granted tools, and refuses a call outside the grant anyway (journey 5)', async () => {
    const { project, owner } = await shopWithContacts();
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, tools: ['read_contacts', 'write_contacts'], by: owner });
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, agent: 'builder', tools: ['read_contacts'], by: owner });
    const provider = new ScriptedProvider([
      { content: [{ type: 'tool_call', id: 'c1', name: 'contacts__read_contacts', input: {} }], stopReason: 'tool_use' },
      // Not offered, but a model can name any tool it likes.
      { content: [{ type: 'tool_call', id: 'c2', name: 'contacts__write_contacts', input: { count: 52 } }], stopReason: 'tool_use' },
    ]);
    polyphemus.registry.use('openai', provider);
    const session = polyphemus.newSession({ cwd: project.path, model: resolveModel(polyphemus.config, 'gpt-api'), agent: findAgent(home, project.path, 'builder', project.slug), autoApprove: true });
    await session.send('pull the contacts');

    expect(provider.requests[0]!.tools!.map((t) => t.name).filter((n) => n.startsWith('contacts__'))).toEqual(['contacts__read_contacts']);
    const results = polyphemus.store.messages(session.meta!.id).flatMap((m) => m.content).filter((b) => b.type === 'tool_result');
    expect(results).toEqual([
      expect.objectContaining({ content: 'read_contacts ok {}' }),
      expect.objectContaining({ content: expect.stringContaining('Polyphemus refused this call: write_contacts on Contacts isn’t granted to builder in shop'), isError: true }),
    ]);

    // And at the call layer itself, however the call arrives: YOLO doesn't widen a grant.
    const refused = await polyphemus.connections.call('contacts', 'write_contacts', { count: 52 }, { project: project.slug, agent: 'builder', sessionId: session.meta!.id });
    expect(refused).toMatchObject({ isError: true, content: expect.stringContaining('Polyphemus refused this call: write_contacts on Contacts isn’t granted to builder in shop') });
    expect(polyphemus.store.connections.activity('contacts').map((a) => [a.tool, a.outcome, a.sessionId, a.agent])).toEqual([
      ['write_contacts', 'refused', session.meta!.id, 'builder'],
      ['write_contacts', 'refused', session.meta!.id, 'builder'],
      ['read_contacts', 'ok', session.meta!.id, 'builder'],
    ]);
  });

  it('records the actual 401 on the connection, for its owner, and recovers on reconnect', async () => {
    const { project, owner } = await shopWithContacts();
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, tools: ['read_contacts'], by: owner });
    const heard: string[] = [];
    polyphemus.connections.on((c) => heard.push(`${c.id}:${c.health}`));
    await polyphemus.connections.reconnect('contacts', { CONTACTS_TOKEN: 'expired-token-value' });
    expect(polyphemus.connections.get('contacts')).toMatchObject({ health: 'failing', errorKind: 'auth', error: expect.stringContaining('401') });

    const result = await polyphemus.connections.call('contacts', 'read_contacts', {}, { project: project.slug, sessionId: 'thread-1' });
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('401 Unauthorized') });
    expect(polyphemus.connections.get('contacts')).toMatchObject({ health: 'failing', errorSession: 'thread-1' });
    expect(polyphemus.store.connections.activity('contacts')[0]).toMatchObject({ outcome: 'failed', detail: expect.stringContaining('401') });

    await polyphemus.connections.reconnect('contacts', { CONTACTS_TOKEN: 'good' });
    expect(polyphemus.connections.get('contacts')).toMatchObject({ health: 'ok' });
    expect(heard).toEqual(['contacts:failing', 'contacts:failing', 'contacts:ok']);
  });

  it('treats a 403 about one action as that call failing, not a broken sign-in', async () => {
    const { project, owner } = await shopWithContacts();
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, tools: ['read_contacts'], by: owner });
    await polyphemus.connections.reconnect('contacts', { CONTACTS_TOKEN: 'narrow' });
    expect(polyphemus.connections.get('contacts')).toMatchObject({ health: 'ok' });
    const result = await polyphemus.connections.call('contacts', 'read_contacts', {}, { project: project.slug, sessionId: 'thread-1' });
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('403 Forbidden: you may not delete this contact') });
    expect(polyphemus.connections.get('contacts')).toMatchObject({ health: 'ok' });
    expect(polyphemus.connections.get('contacts')?.errorKind).toBeUndefined();
    expect(polyphemus.store.connections.activity('contacts')[0]).toMatchObject({ outcome: 'failed' });
  });

  it('reaches an agent CLI through the gateway, with the same check (journey 5, Claude Code and Codex)', async () => {
    const { project, owner } = await shopWithContacts();
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, tools: ['read_contacts', 'write_contacts'], by: owner });
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, agent: 'builder', tools: ['read_contacts'], by: owner });
    let seen: { tools: string[]; read: string; write: string } | undefined;
    const cli: AgentProvider = {
      kind: 'agent',
      id: 'claude-code',
      listModels: async () => [],
      async *run(req: AgentRunRequest) {
        // What the CLI would do: start the MCP server it was handed, list, and call.
        const mcp = await speak(req.connections!);
        const tools = ((await mcp.ask('tools/list')).tools as Array<{ name: string }>).map((t) => t.name);
        const text = (r: Record<string, any>) => r.content[0].text as string;
        seen = { tools, read: text(await mcp.ask('tools/call', { name: 'contacts__read_contacts', arguments: {} })), write: text(await mcp.ask('tools/call', { name: 'contacts__write_contacts', arguments: {} })) };
        mcp.close();
        yield { type: 'turn_done', stopReason: 'end_turn', usage: emptyUsage() };
      },
    };
    polyphemus.registry.use('claude-code', cli);
    const session = polyphemus.newSession({ cwd: project.path, model: resolveModel(polyphemus.config, 'claude'), agent: findAgent(home, project.path, 'builder', project.slug), autoApprove: true });
    await session.send('pull the contacts');
    session.close();

    // Granted connection tools, and show_artifact, which every agent has; never the ungranted write.
    expect(seen).toEqual({ tools: ['contacts__read_contacts', 'show_artifact'], read: 'read_contacts ok {}', write: expect.stringContaining('Polyphemus refused this call') });
    // The gateway process holds a socket and a token, never the credential.
    expect(JSON.stringify(cli)).not.toContain('good');
  });

  it('hands a service’s pictures to the model with the result, and to an agent CLI through the gateway', async () => {
    const { project, owner } = await shopWithContacts();
    polyphemus.connections.grant({ connection: 'contacts', project: project.slug, tools: ['read_contacts'], by: owner });
    const provider = new ScriptedProvider([{ content: [{ type: 'tool_call', id: 'c1', name: 'contacts__read_contacts', input: { photo: true } }], stopReason: 'tool_use' }]);
    polyphemus.registry.use('openai', provider);
    const session = polyphemus.newSession({ cwd: project.path, model: resolveModel(polyphemus.config, 'gpt-api'), autoApprove: true });
    await session.send('who is Alex?');
    const result = polyphemus.store.messages(session.meta!.id).flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    // Kept like an attached image: a file in uploads, not bytes in the database.
    expect(result).toMatchObject({ content: 'Alex, with a photo', images: [{ type: 'image', mediaType: 'image/png', path: expect.stringContaining(join(home, 'uploads')) }] });
    expect(provider.requests[1]!.messages.at(-1)!.content[0]).toMatchObject({ type: 'tool_result', images: [{ mediaType: 'image/png' }] });
    session.close();

    let seen: Array<{ type: string; mimeType?: string }> = [];
    const cli: AgentProvider = {
      kind: 'agent',
      id: 'claude-code',
      listModels: async () => [],
      async *run(req: AgentRunRequest) {
        const mcp = await speak(req.connections!);
        seen = (await mcp.ask('tools/call', { name: 'contacts__read_contacts', arguments: { photo: true } })).content;
        mcp.close();
        yield { type: 'turn_done', stopReason: 'end_turn', usage: emptyUsage() };
      },
    };
    polyphemus.registry.use('claude-code', cli);
    const viaCli = polyphemus.newSession({ cwd: project.path, model: resolveModel(polyphemus.config, 'claude'), autoApprove: true });
    await viaCli.send('who is Alex?');
    viaCli.close();
    expect(seen.map((c) => [c.type, c.mimeType])).toEqual([
      ['text', undefined],
      ['image', 'image/png'],
    ]);
  });

  it('hands Codex the gateway without putting its token on the command line', () => {
    const server: ConnectionServer = {
      serverName: 'polyphemus_connections',
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.POLYPHEMUS_CONNECTIONS_TOKEN || "")'],
      env: { POLYPHEMUS_CONNECTIONS_SOCKET: '/tmp/s', POLYPHEMUS_CONNECTIONS_TOKEN: "t'oken" },
    };
    const { args, dir } = codexMcpServer(server);
    try {
      expect(args.join('\n')).not.toContain('POLYPHEMUS_CONNECTIONS_TOKEN');
      expect(args.join('\n')).not.toContain("t'oken");
      expect(args).toEqual([
        '-c',
        expect.stringMatching(/^mcp_servers\.polyphemus_connections\.command="\/.*\/run"$/),
        '-c',
        'mcp_servers.polyphemus_connections.args=[]',
        '-c',
        'mcp_servers.polyphemus_connections.default_tools_approval_mode="approve"',
      ]);
      expect(statSync(join(dir, 'env')).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(dir, 'env'), 'utf8')).toContain("POLYPHEMUS_CONNECTIONS_TOKEN='t'\\''oken'");
      const command = JSON.parse(args[1]!.slice(args[1]!.indexOf('=') + 1)) as string;
      const ran = spawnSync(command, [], { encoding: 'utf8' });
      expect(ran.stdout).toBe("t'oken");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Starts an MCP server the way a CLI would, and talks JSON-RPC to it. */
async function speak(server: ConnectionServer) {
  const child = spawn(server.command, server.args, { env: { PATH: process.env.PATH, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map<number, (result: Record<string, any>) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message.result);
  });
  let id = 0;
  const ask = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, any>>((resolve) => {
      waiting.set(++id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  await ask('initialize');
  return { ask, close: () => child.kill() };
}
