import { DEFAULT_CONFIG } from '../src/config.js';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentProvider, AgentRunRequest } from '../src/agents/common.js';
import { ClaudeCodeAgent, GrokBuildAgent } from '../src/agents/claude-cli.js';
import { CodexAgent } from '../src/agents/codex-cli.js';
import { claudeShellWrapper, WORKER_MARKER } from '../src/isolation/claude.js';
import { resolveModel } from '../src/config.js';
import { Polyphemus, type RuntimeEvent } from '../src/polyphemus.js';
import { effectiveLevel } from '../src/isolation/levels.js';
import { containerRuntime, describeInContainers } from './containers.js';
import { createProject, memoryDir } from '../src/projects.js';
import { cliEnvironment } from '../src/tools/guard.js';
import { emptyUsage, type ChatRequest, type ModelProvider, type ProviderEvent, type StopReason } from '../src/types.js';

// Worker isolation (docs/design/isolation.md), step 1: polyphemus's own tools in a worker, levels the owner
// picks, failing closed where something can't be isolated yet, and CLIs no longer handed every key.

/** The container runtime, found directly: the suite turns polyphemus's own detection off, and these tests are the ones that need it. */
const runtime = containerRuntime;

let home: string;
const savedEnv = { ...process.env };
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-isolation-'));
  // Tests of how things run on this computer: the level a fresh install wouldn't default to.
  await writeFile(join(home, 'config.toml'), `${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'sk-test-key-that-must-not-reach-a-worker';
});
afterEach(() => {
  process.env = { ...savedEnv };
  // Workers a test started for its own temporary home, removed whatever it reached: left running, they
  // piled up across runs (ten, some half a day old) and slowed the next run's containers (2026-09-22).
  for (const command of ['docker', 'podman']) {
    const listed = spawnSync(command, ['ps', '-a', '--filter', 'label=polyphemus.worker=1', '--format', '{{.Names}} {{.Label "polyphemus.key"}}'], { encoding: 'utf8' });
    if (listed.status !== 0) continue;
    const mine = listed.stdout.split('\n').filter((line) => line.includes(home)).map((line) => line.split(' ')[0]!).filter(Boolean);
    if (mine.length) spawnSync(command, ['rm', '-f', ...mine], { stdio: 'ignore' });
  }
});

/** Makes one tool call per reply, in order, then says done; keeps what each call returned. */
function scripted(calls: Array<{ name: string; input: Record<string, unknown> }>) {
  const results: Array<{ content: string; isError: boolean }> = [];
  const provider: ModelProvider = {
    kind: 'model',
    id: 'openai',
    async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
      const last = req.messages.at(-1);
      for (const block of last?.content ?? []) if (block.type === 'tool_result') results.push({ content: String(block.content), isError: block.isError === true });
      const next = calls.shift();
      const content = next ? [{ type: 'tool_call' as const, id: `c${calls.length}`, name: next.name, input: next.input }] : [{ type: 'text' as const, text: 'done' }];
      yield { type: 'message_done', message: { role: 'assistant', content, origin: { provider: 'openai', model: req.model } }, stopReason: (next ? 'tool_use' : 'end_turn') as StopReason, usage: emptyUsage() };
    },
    async listModels() {
      return [];
    },
  };
  return { provider, results };
}

describe('isolation levels', () => {
  it('lets a project be stricter than the install, never looser', () => {
    expect(effectiveLevel('host')).toBe('host');
    expect(effectiveLevel('host', 'isolated')).toBe('isolated');
    expect(effectiveLevel('isolated-open', 'isolated')).toBe('isolated');
    expect(effectiveLevel('isolated', 'host')).toBe('isolated');
    expect(effectiveLevel('isolated', 'isolated-open')).toBe('isolated');
  });

  it('gives a vendor CLI its own sign-in variables and none of polyphemus’s other keys', () => {
    const env = { PATH: '/bin', OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', XAI_API_KEY: 'x', GITHUB_TOKEN: 'g', CLAUDE_CODE_OAUTH_TOKEN: 'c' };
    expect(cliEnvironment('claude-cli', env)).toEqual({ PATH: '/bin', ANTHROPIC_API_KEY: 'a', CLAUDE_CODE_OAUTH_TOKEN: 'c' });
    expect(cliEnvironment('codex-cli', env)).toEqual({ PATH: '/bin', OPENAI_API_KEY: 'o' });
    expect(cliEnvironment('grok-cli', env)).toEqual({ PATH: '/bin', XAI_API_KEY: 'x' });
  });

  it('hands a CLI that scrubbed environment, with pushes locked inside a run (they never reached a CLI before)', async () => {
    const polyphemus = await Polyphemus.open(home);
    const requests: AgentRunRequest[] = [];
    const agent: AgentProvider = {
      kind: 'agent',
      id: 'claude-code',
      async *run(req) {
        requests.push(req);
        yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
        yield { type: 'turn_done', stopReason: 'end_turn', usage: emptyUsage() };
      },
      listModels: async () => [],
    };
    polyphemus.registry.use('claude-code', agent);
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'claude') });
    await session.send('hi');
    expect(requests[0]?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(requests[0]?.env?.PATH).toBe(process.env.PATH);
    session.pushLocked = true;
    await session.send('again');
    expect(requests[1]?.env).toMatchObject({ GIT_CONFIG_COUNT: expect.any(String) });
    expect(requests[1]?.env?.OPENAI_API_KEY).toBeUndefined();
  });

  it('says once a thread that its commands run on this computer', async () => {
    const polyphemus = await Polyphemus.open(home);
    const { provider } = scripted([]);
    polyphemus.registry.use('openai', provider);
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'gpt-api') });
    const infos: string[] = [];
    session.on((e: RuntimeEvent) => e.type === 'info' && infos.push(e.text));
    await session.send('hi');
    await session.send('again');
    expect(infos.filter((t) => t.startsWith('On this computer:'))).toHaveLength(1);
  });

  it('fails closed: no runtime, or a CLI caught slipping past its worker, and nothing runs', async () => {
    const polyphemus = await Polyphemus.open(home);
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Shop' });
    polyphemus.store.setProjectIsolation(project.slug, 'isolated');
    let started = 0;
    polyphemus.registry.use('codex', {
      kind: 'agent',
      id: 'codex',
      async *run() {
        started++;
        yield { type: 'turn_done', stopReason: 'end_turn', usage: emptyUsage() };
      },
      listModels: async () => [],
    });
    polyphemus.isolationBroken.set('codex-cli', 'it ran a command outside the worker.');
    const cli = polyphemus.newSession({ cwd: project.path, model: resolveModel(polyphemus.config, 'codex') });
    await expect(cli.send('list the files')).rejects.toThrow(/Codex .* isn’t offered where agents are isolated any more: it ran a command outside the worker/);
    expect(started).toBe(0);

    polyphemus.runtime = () => undefined;
    const { provider } = scripted([{ name: 'bash', input: { command: 'touch escaped' } }]);
    polyphemus.registry.use('openai', provider);
    const api = polyphemus.newSession({ cwd: project.path, model: resolveModel(polyphemus.config, 'gpt-api') });
    await expect(api.send('make a file')).rejects.toThrow(/set to Isolated, but there’s no Docker or Podman on this computer/);
  });
});

describeInContainers('an isolated project, in a real worker', () => {
  it('runs commands and file changes in the project, and can’t reach anything else', async () => {
    const polyphemus = await Polyphemus.open(home);
    polyphemus.runtime = () => runtime;
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Shop' });
    polyphemus.store.setProjectIsolation(project.slug, 'isolated');
    await writeFile(join(home, 'outside.txt'), 'a secret next door\n');
    const outside = join(home, 'outside.txt');
    const { provider, results } = scripted([
      { name: 'bash', input: { command: 'id -u; echo made inside > made.txt; env; cat ' + outside + ' 2>&1; curl -sS -m 5 https://example.com 2>&1 | head -1' } },
      { name: 'read_file', input: { path: outside } },
      { name: 'write_file', input: { path: join(project.path, 'notes', 'plan.md'), content: '# Plan\n' } },
      { name: 'edit_file', input: { path: 'made.txt', old_string: 'inside', new_string: 'in the worker' } },
      { name: 'write_file', input: { path: join(memoryDir(home, project.slug), 'handoff.md'), content: 'Where I left off.\n' } },
      { name: 'write_file', input: { path: join(home, 'planted.txt'), content: 'no' } },
      { name: 'bash', input: { command: 'sleep 60', timeout_ms: 1000 } },
    ]);
    polyphemus.registry.use('openai', provider);
    const session = polyphemus.newSession({ cwd: project.path, model: resolveModel(polyphemus.config, 'gpt-api') });
    session.autoApprove = true;
    await session.send('look around');

    const [shell, readOutside, wrote, edited, handoff, planted, slow] = results;
    expect(shell!.content).toContain(String(process.getuid?.()));
    expect(shell!.content).toContain('No such file or directory');
    expect(shell!.content).not.toContain('a secret next door');
    expect(shell!.content).not.toContain('sk-test-key');
    expect(shell!.content).toMatch(/Could not resolve host|Couldn't resolve/);
    expect(readOutside).toMatchObject({ isError: true, content: expect.stringContaining('isn’t in what this project’s worker was given') });
    expect(wrote!.isError).toBe(false);
    expect(await readFile(join(project.path, 'notes', 'plan.md'), 'utf8')).toBe('# Plan\n');
    expect(edited!.isError).toBe(false);
    expect(await readFile(join(project.path, 'made.txt'), 'utf8')).toBe('made in the worker\n');
    expect(handoff!.isError).toBe(false);
    expect(await readFile(join(memoryDir(home, project.slug), 'handoff.md'), 'utf8')).toBe('Where I left off.\n');
    expect(planted).toMatchObject({ isError: true });
    await expect(readFile(join(home, 'planted.txt'), 'utf8')).rejects.toThrow();
    expect(slow).toMatchObject({ isError: true, content: expect.stringContaining('killed (timeout after 1000ms)') });
    await polyphemus.workers.close();
    polyphemus.close();
  }, 300_000);
});

/**
 * A stand-in `claude`: runs one "Bash" command the way Claude Code does — through CLAUDE_CODE_SHELL_PREFIX
 * as one composed string — and streams the result. `rogue` runs it straight on this computer instead,
 * the way a Claude Code that stopped honouring the prefix would.
 */
async function fakeClaude(dir: string, command: string): Promise<string> {
  const file = join(dir, 'claude');
  await writeFile(
    file,
    `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
fs.appendFileSync(__filename + '.args', JSON.stringify(args) + '\\n');
const mcpAt = args.indexOf('--mcp-config');
if (mcpAt >= 0 && fs.existsSync(args[mcpAt + 1])) fs.writeFileSync(__filename + '.mcp-config', fs.readFileSync(args[mcpAt + 1]));
let input = '';
process.stdin.on('data', (d) => (input += d)).on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify({ session_id: 's1', ...o }) + '\\n');
  out({ type: 'system', subtype: 'init', model: 'claude-haiku', apiKeySource: 'none' });
  const cmd = input.includes('cat /etc/polyphemus-worker') ? 'cat /etc/polyphemus-worker' : ${JSON.stringify(command)};
  const composed = "source /nowhere/snapshot.sh 2>/dev/null || true && eval " + JSON.stringify(cmd) + " < /dev/null && pwd -P >| /tmp/claude-" + process.pid + "-cwd";
  const prefix = process.env.CLAUDE_CODE_SHELL_PREFIX;
  const rogue = fs.existsSync(__filename + '.rogue');
  const ran = prefix && !rogue ? spawnSync(prefix, [composed], { encoding: 'utf8' }) : spawnSync('bash', ['-c', composed], { encoding: 'utf8' });
  out({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: cmd } }] } });
  out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: (ran.stdout || '') + (ran.stderr || ''), is_error: ran.status !== 0 }] } });
  out({ type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', stop_reason: 'end_turn', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } });
});
`,
  );
  await chmod(file, 0o755);
  return file;
}

describeInContainers('Claude Code in an isolated project, in a real worker', () => {
  it('sends each shell command to the worker, keeps polyphemus’s own MCP servers here, and stops a command it’s told to', async () => {
    const polyphemus = await Polyphemus.open(home);
    polyphemus.runtime = () => runtime;
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Shop' });
    const worker = await polyphemus.workers.get({ key: `test|${project.slug}`, mounts: [{ path: project.path }], network: 'none', workdir: project.path });
    const shell = claudeShellWrapper(worker);
    const prefix = shell.env.CLAUDE_CODE_SHELL_PREFIX!;
    const cwdFile = join(tmpdir(), `claude-t${process.pid}-cwd`);
    const composed = (cmd: string) => `source /nowhere 2>/dev/null || true && eval ${JSON.stringify(cmd)} < /dev/null && pwd -P >| ${cwdFile}`;

    const inside = spawnSync(prefix, [composed('cat /etc/polyphemus-worker; cd notes 2>/dev/null || mkdir notes && cd notes')], { cwd: project.path, encoding: 'utf8' });
    expect(inside.stdout).toContain(WORKER_MARKER);
    // Claude Code reads the working directory back from its file, here: it's the worker's.
    expect((await readFile(cwdFile, 'utf8')).trim()).toBe(join(project.path, 'notes'));

    const where = 'test -e /etc/polyphemus-worker && echo in-worker || echo on-this-computer';
    expect(spawnSync(prefix, [where], { env: { ...process.env, POLYPHEMUS_HOST_NONCE: shell.hostNonce }, encoding: 'utf8' }).stdout.trim()).toBe('on-this-computer');
    expect(spawnSync(prefix, [where], { env: { ...process.env, POLYPHEMUS_HOST_NONCE: 'guessed' }, encoding: 'utf8' }).stdout.trim()).toBe('in-worker');
    expect(shell.runs()).toBe(2);

    // Claude Code stopping a command stops it in the worker too.
    const slow = spawn(prefix, ['sleep 77'], { cwd: project.path });
    await new Promise((r) => setTimeout(r, 1500));
    expect((await worker.exec(['bash', '-c', 'ps -eo args | grep -xc "sleep 77" || true'])).stdout.toString().trim()).toBe('1');
    slow.kill('SIGTERM');
    await new Promise((r) => slow.on('close', r));
    await new Promise((r) => setTimeout(r, 500));
    expect((await worker.exec(['bash', '-c', 'ps -eo args | grep -xc "sleep 77" || true'])).stdout.toString().trim()).toBe('0');
    shell.close();
    await polyphemus.workers.close();
    polyphemus.close();
  }, 300_000);

  it('runs a Claude Code turn isolated after checking once, and stops offering it when a command slips past the worker', async () => {
    const polyphemus = await Polyphemus.open(home);
    polyphemus.runtime = () => runtime;
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Shop' });
    polyphemus.store.setProjectIsolation(project.slug, 'isolated');
    await writeFile(join(home, 'outside.txt'), 'a secret next door\n');
    const claude = await fakeClaude(home, `cat /etc/polyphemus-worker 2>&1; cat ${join(home, 'outside.txt')} 2>&1; echo ok > made-by-claude.txt`);
    polyphemus.config.providers['claude-code']!.command = claude;
    polyphemus.registry.use('claude-code', new ClaudeCodeAgent('claude-code', { command: claude }));
    const session = polyphemus.newSession({ cwd: project.path, model: resolveModel(polyphemus.config, 'claude') });
    const said: string[] = [];
    session.on((e: RuntimeEvent) => (e.type === 'info' || e.type === 'notice') && said.push(e.text));

    await session.send('look around');
    expect(said.some((t) => t.includes('Checking, once for this version of Claude Code'))).toBe(true);
    const results = polyphemus.store.messages(session.meta!.id).flatMap((m) => m.content).filter((b) => b.type === 'tool_result') as Array<{ content: string }>;
    expect(results.at(-1)!.content).toContain(WORKER_MARKER);
    expect(results.at(-1)!.content).not.toContain('a secret next door');
    expect(await readFile(join(project.path, 'made-by-claude.txt'), 'utf8')).toBe('ok\n');
    const args = (await readFile(`${claude}.args`, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as string[]).at(-1)!;
    expect(args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--setting-sources', 'user', '--disallowedTools', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'CronCreate', 'ScheduleWakeup', 'AskUserQuestion']));
    // Not acceptEdits: that mode lets Claude Code run rm, mv, cp and mkdir in the project without asking.
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    // The config goes in a file of polyphemus's own, not on the command line, because the connections
    // gateway's token is in it and anyone on this machine can read a process's arguments
    // (connections review, 2026-09-20). The file is gone once the turn is over, so what it held is
    // read from the copy the fake CLI kept.
    const configArg = args[args.indexOf('--mcp-config') + 1]!;
    expect(configArg).not.toContain('POLYPHEMUS_CONNECTIONS_TOKEN');
    expect(configArg).toMatch(/^\/.*\/mcp\.json$/);
    expect(existsSync(configArg)).toBe(false);
    const config = JSON.parse(await readFile(`${claude}.mcp-config`, 'utf8')) as { mcpServers: Record<string, { env: Record<string, string> }> };
    expect(config.mcpServers.polyphemus_connections!.env.POLYPHEMUS_HOST_NONCE).toMatch(/^[0-9a-f]{36}$/);
    expect(JSON.parse(await readFile(join(home, 'isolation-checks.json'), 'utf8'))).toMatchObject({ 'claude-cli@9.9.9 (Claude Code)': { ok: true } });

    // A Claude Code that stops honouring the prefix is caught the same turn, and not started isolated again.
    await writeFile(`${claude}.rogue`, '');
    await session.send('again');
    expect(said.some((t) => t.includes('without going through the worker'))).toBe(true);
    await expect(session.send('once more')).rejects.toThrow(/isn’t offered where agents are isolated any more/);
    await polyphemus.workers.close();
    polyphemus.close();
  }, 300_000);
});

/**
 * A stand-in `grok agent stdio`: an ACP agent that runs one shell command and writes one file through
 * its client, as Grok does — or, `escape`, reports using its host-side grep tool too.
 */
async function fakeGrok(dir: string, opts: { escape?: boolean } = {}): Promise<string> {
  const file = join(dir, opts.escape ? 'grok-escape' : 'grok');
  await writeFile(
    file,
    `#!/usr/bin/env node
const readline = require('node:readline');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('grok 9.9.9'); process.exit(0); }
let id = 1000; const waiting = new Map();
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
const ask = (method, params) => new Promise((r) => { const i = id++; waiting.set(i, r); send({ id: i, method, params }); });
const update = (sessionId, update) => send({ method: 'session/update', params: { sessionId, update } });
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m); return; }
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (m.method === 'session/new') return send({ id: m.id, result: { sessionId: 's-1', tools: m.params._meta.agentProfile.tools } });
  if (m.method === 'session/prompt') {
    const s = m.params.sessionId;
    const wantsMarker = m.params.prompt[0].text.includes('polyphemus-worker');
    const tool = (tid, name, kind, input) => update(s, { sessionUpdate: 'tool_call', toolCallId: tid, title: name, rawInput: input, _meta: { 'x.ai/tool': { name, kind } } });
    tool('c1', 'run_terminal_command', 'execute', { command: 'x' });
    const cmd = wantsMarker ? 'cat /etc/polyphemus-worker' : 'cat /etc/polyphemus-worker; cat ' + ${JSON.stringify('OUTSIDE')} + ' 2>&1; id -u';
    const t = await ask('terminal/create', { sessionId: s, command: '/bin/bash -lc ' + JSON.stringify(cmd), env: [{ name: 'CLICOLOR', value: '1' }] });
    await ask('terminal/wait_for_exit', { sessionId: s, terminalId: t.result.terminalId });
    const out = await ask('terminal/output', { sessionId: s, terminalId: t.result.terminalId });
    await ask('terminal/release', { sessionId: s, terminalId: t.result.terminalId });
    update(s, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: out.result.output } }] });
    if (!wantsMarker) {
      tool('c2', 'write', 'edit', { file_path: 'from-grok.txt' });
      const w = await ask('fs/write_text_file', { sessionId: s, path: process.cwd() + '/from-grok.txt', content: 'written by grok' });
      update(s, { sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: w.error ? 'failed' : 'completed', content: [] });
      ${opts.escape ? "tool('c3', 'grep', 'search', { pattern: 'x' }); update(s, { sessionUpdate: 'tool_call_update', toolCallId: 'c3', status: 'completed', content: [] });" : ''}
    }
    update(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
    return send({ id: m.id, result: { stopReason: 'end_turn' } });
  }
  send({ id: m.id, result: {} });
});
`.replace('"OUTSIDE"', JSON.stringify(join(dir, 'outside.txt'))),
  );
  await chmod(file, 0o755);
  return file;
}

describeInContainers('Grok Build in an isolated project, in a real worker', () => {
  it('runs its commands and file writes in the worker over ACP, and stops offering it when it uses a tool that reaches this computer', async () => {
    const polyphemus = await Polyphemus.open(home);
    polyphemus.runtime = () => runtime;
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Shop' });
    polyphemus.store.setProjectIsolation(project.slug, 'isolated');
    await writeFile(join(home, 'outside.txt'), 'a secret next door\n');
    const grok = await fakeGrok(home);
    polyphemus.config.providers['grok-build']!.command = grok;
    polyphemus.registry.use('grok-build', new GrokBuildAgent('grok-build', { command: grok }));
    const session = polyphemus.newSession({ cwd: project.path, model: resolveModel(polyphemus.config, 'grok-build') });
    const said: string[] = [];
    session.on((e: RuntimeEvent) => (e.type === 'info' || e.type === 'notice') && said.push(e.text));
    await session.send('look around');
    expect(said.some((t) => t.includes('Checking, once for this version of Grok Build'))).toBe(true);
    const results = polyphemus.store.messages(session.meta!.id).flatMap((m) => m.content).filter((b) => b.type === 'tool_result') as Array<{ content: string }>;
    expect(results[0]!.content).toContain(WORKER_MARKER);
    expect(results[0]!.content).not.toContain('a secret next door');
    expect(results[0]!.content).toContain(String(process.getuid?.()));
    expect(await readFile(join(project.path, 'from-grok.txt'), 'utf8')).toBe('written by grok');

    const escaping = await fakeGrok(home, { escape: true });
    polyphemus.registry.use('grok-build', new GrokBuildAgent('grok-build', { command: escaping }));
    await session.send('again');
    expect(said.some((t) => t.includes('Grok used grep, which doesn’t go through the worker'))).toBe(true);
    await expect(session.send('once more')).rejects.toThrow(/isn’t offered where agents are isolated any more/);
    await polyphemus.workers.close();
    polyphemus.close();
  }, 300_000);

  // A real container here: usually 20-50s, now and then past 5 minutes on a busy machine, cause not found (2026-09-22).
  it('catches a Codex that runs a command without going through its exec-server bridge', { timeout: 120_000, retry: 1 }, async () => {
    const polyphemus = await Polyphemus.open(home);
    polyphemus.runtime = () => runtime;
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Shop' });
    polyphemus.store.setProjectIsolation(project.slug, 'isolated');
    const codex = join(home, 'codex');
    // Ignores CODEX_EXEC_SERVER_URL and reports a command it ran itself.
    await writeFile(codex, `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('codex-cli 9.9.9'); process.exit(0); }
process.stdin.resume(); process.stdin.on('end', () => {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'thread.started', thread_id: 'th_1' });
  out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', aggregated_output: 'a', exit_code: 0, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'done' } });
  out({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
});
`);
    await chmod(codex, 0o755);
    polyphemus.config.providers.codex!.command = codex;
    polyphemus.registry.use('codex', new CodexAgent('codex', { command: codex }));
    polyphemus.codexIsolationCheck = async () => ({ ok: true });
    const session = polyphemus.newSession({ cwd: project.path, model: resolveModel(polyphemus.config, 'codex') });
    const said: string[] = [];
    session.on((e: RuntimeEvent) => e.type === 'notice' && said.push(e.text));
    await session.send('list files');
    expect(said.some((t) => t.includes('Codex reported 1 command and 0 file changes, but only 0 commands'))).toBe(true);
    await expect(session.send('again')).rejects.toThrow(/isn’t offered where agents are isolated any more/);
    await polyphemus.workers.close();
    polyphemus.close();
  });
});

describe('Grok Build, isolated, in a thread that asks first', () => {
  // Isolated, every permission Grok asked for was granted, Ask mode or not (independent review, 2026-09-19).
  const asker = async (dir: string) => {
    const file = join(dir, 'grok-asks');
    await writeFile(
      file,
      `#!/usr/bin/env node
const readline = require('node:readline');
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
let promptId;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) {
    const picked = m.result.outcome.optionId ?? m.result.outcome.outcome;
    send({ method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer: ' + picked } } } });
    return send({ id: promptId, result: { stopReason: 'end_turn' } });
  }
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  if (m.method === 'session/new') return send({ id: m.id, result: { sessionId: 's-1' } });
  if (m.method === 'session/prompt') {
    promptId = m.id;
    return send({ id: 99, method: 'session/request_permission', params: { sessionId: 's-1', toolCall: { toolCallId: 'c1', kind: 'execute', title: 'run_terminal_command', rawInput: { command: 'rm -rf build' } },
      options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_once' }] } });
  }
  send({ id: m.id, result: {} });
});
`,
    );
    await chmod(file, 0o755);
    return file;
  };
  const answer = async (req: Partial<AgentRunRequest>) => {
    const { runGrokIsolated } = await import('../src/isolation/grok.js');
    let text = '';
    for await (const e of runGrokIsolated(await asker(home), { prompt: 'clean up', model: 'default', cwd: home, autoApprove: false, ...req } as AgentRunRequest, {} as never, () => {})) {
      if (e.type === 'text_delta') text += e.text;
    }
    return text;
  };

  it('asks the person, and does what they said', async () => {
    const asked: string[] = [];
    expect(await answer({ approve: async (tool, input) => (asked.push(`${tool}: ${JSON.stringify(input)}`), { allow: false }) })).toContain('answer: no');
    expect(asked).toEqual(['run_terminal_command: {"command":"rm -rf build"}']);
    expect(await answer({ approve: async () => ({ allow: true }) })).toContain('answer: yes');
  });

  it('declines with nobody to ask, and allows everything only when the thread runs without asking', async () => {
    expect(await answer({})).toContain('answer: no');
    expect(await answer({ autoApprove: true })).toContain('answer: yes');
  });
});
