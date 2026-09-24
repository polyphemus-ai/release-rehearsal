import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunRequest } from '../src/agents/common.js';
import { explainGrokCancellation, runGrokAsked } from '../src/isolation/grok.js';
import type { PolyphemusEvent } from '../src/events.js';

// A Grok that asks before web_fetch, then either runs it or reports the headless "User cancelled".
const grok = (dir: string) => {
  const file = join(dir, 'grok');
  return writeFile(
    file,
    `#!/usr/bin/env node
const readline = require('node:readline');
if (process.env.GROK_ARGV) require('node:fs').writeFileSync(process.env.GROK_ARGV, JSON.stringify(process.argv.slice(2)));
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
let promptId;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) {
    const picked = m.result?.outcome?.optionId ?? m.result?.outcome?.outcome;
    const text = picked === 'yes' ? 'fetched the page' : 'User cancelled the execution for tool \`web_fetch\`';
    send({ method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'web_fetch', rawInput: { url: 'https://docs.example' }, _meta: { 'x.ai/tool': { name: 'web_fetch' } } } } });
    send({ method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: picked === 'yes' ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text } }] } } });
    send({ method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } } } });
    return send({ id: promptId, result: { stopReason: picked === 'yes' ? 'end_turn' : 'cancelled' } });
  }
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1 } });
  if (m.method === 'session/new') {
    if (process.env.GROK_SEEN) require('node:fs').writeFileSync(process.env.GROK_SEEN, JSON.stringify(m.params.mcpServers));
    return send({ id: m.id, result: { sessionId: 's-1' } });
  }
  // Loading a session replays it, the way Grok does, before answering.
  if (m.method === 'session/load') {
    send({ method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD REPLY from an earlier turn' } } } });
    return send({ id: m.id, result: {} });
  }
  if (m.method === 'session/prompt') {
    promptId = m.id;
    if (m.params.prompt[0].text.includes('hello')) {
      send({ method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NEW REPLY' } } } });
      return send({ id: m.id, result: { stopReason: 'end_turn' } });
    }
    if (m.params.prompt[0].text.includes('no-ask')) {
      send({ method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c9', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'User cancelled the execution for tool \`run_terminal_command\`' } }] } } });
      return send({ id: m.id, result: { stopReason: 'cancelled' } });
    }
    return send({ id: 99, method: 'session/request_permission', params: { sessionId: 's-1', toolCall: { toolCallId: 'c1', kind: 'other', title: 'web_fetch', rawInput: { url: 'https://docs.example' } },
      options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] } });
  }
  send({ id: m.id, result: {} });
});
`,
  ).then(() => chmod(file, 0o755)).then(() => file);
};

const resultsOf = (events: PolyphemusEvent[]) =>
  events.flatMap((e) => (e.type === 'message' && e.message.role === 'user' ? e.message.content : [])).flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));

describe('Grok on this computer', () => {
  let home: string;
  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it('says what a cancelled tool actually was', () => {
    expect(explainGrokCancellation('User cancelled the execution for tool `web_fetch`')).toMatch(/didn’t run web_fetch/);
    expect(explainGrokCancellation('User cancelled the execution for tool `web_fetch`')).not.toContain('User cancelled the execution');
    expect(explainGrokCancellation('User rejected the execution for tool `run_terminal_command`')).toMatch(/didn’t run run_terminal_command/);
    expect(explainGrokCancellation('User rejected the execution for tool `run_terminal_command`')).not.toContain('User rejected the execution');
    expect(explainGrokCancellation('User cancelled the execution for tool `write`', 'You said no to write.')).toBe('You said no to write.');
    expect(explainGrokCancellation('the file says cancel-in-progress: true')).toBe('the file says cancel-in-progress: true');
  });

  it('keeps a resumed session’s replayed history out of this turn', async () => {
    // Grok's session/load sends the conversation so far again; stored, every turn repeated the last.
    home = await mkdtemp(join(tmpdir(), 'grok-ask-'));
    const command = await grok(home);
    const events: PolyphemusEvent[] = [];
    const req = { prompt: 'hello', model: 'default', cwd: home, autoApprove: false, resume: 's-1' } as AgentRunRequest;
    for await (const e of runGrokAsked(command, req)) events.push(e);
    const said = events.flatMap((e) => (e.type === 'message' && e.message.role === 'assistant' ? e.message.content : [])).map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(said).toBe('NEW REPLY');
  });

  it('hands Grok polyphemus’s own tools, as Claude Code and Codex have them', async () => {
    // Without them a Grok agent could only give the person a file's path, not show it (2026-09-21).
    home = await mkdtemp(join(tmpdir(), 'grok-ask-'));
    const command = await grok(home);
    const seen = join(home, 'seen.json');
    const connections = { serverName: 'polyphemus_connections', command: '/usr/bin/node', args: ['/x/connections-mcp.mjs'], env: { POLYPHEMUS_GATEWAY: '/tmp/g.sock' }, close: () => {} };
    const req = { prompt: 'hello', model: 'default', cwd: home, autoApprove: false, connections, env: { ...process.env, GROK_SEEN: seen } } as AgentRunRequest;
    for await (const _ of runGrokAsked(command, req)) void _;
    expect(JSON.parse(await readFile(seen, 'utf8'))).toEqual([{ name: 'polyphemus_connections', command: '/usr/bin/node', args: ['/x/connections-mcp.mjs'], env: [{ name: 'POLYPHEMUS_GATEWAY', value: '/tmp/g.sock' }] }]);
  });

  it('always asks Grok to ask, unless the thread runs without asking', async () => {
    // Left out, the mode came from the person's own Grok settings, which may never ask (2026-09-24).
    home = await mkdtemp(join(tmpdir(), 'grok-ask-'));
    const command = await grok(home);
    const argv = join(home, 'argv.json');
    for (const autoApprove of [false, true]) {
      const req = { prompt: 'hello', model: 'default', cwd: home, autoApprove, env: { ...process.env, GROK_ARGV: argv } } as AgentRunRequest;
      for await (const _ of runGrokAsked(command, req)) void _;
      const args = JSON.parse(await readFile(argv, 'utf8')) as string[];
      if (autoApprove) {
        expect(args).toContain('--always-approve');
        expect(args).not.toContain('--permission-mode');
      } else expect(args.slice(0, 2)).toEqual(['--permission-mode', 'default']);
    }
  });

  it('asks before a page, and runs it when you say yes', async () => {
    home = await mkdtemp(join(tmpdir(), 'grok-ask-'));
    const command = await grok(home);
    const asked: string[] = [];
    const events: PolyphemusEvent[] = [];
    const req = { prompt: 'look', model: 'default', cwd: home, autoApprove: false, approve: async (tool: string) => (asked.push(tool), { allow: true }) } as AgentRunRequest;
    for await (const e of runGrokAsked(command, req)) events.push(e);
    expect(asked).toEqual(['web_fetch']);
    expect(resultsOf(events)).toEqual(['fetched the page']);
    expect(events.some((e) => e.type === 'turn_done' && e.stopReason === 'end_turn')).toBe(true);
  });

  it('says you said no, instead of saying you cancelled', async () => {
    home = await mkdtemp(join(tmpdir(), 'grok-ask-'));
    const command = await grok(home);
    const events: PolyphemusEvent[] = [];
    const req = { prompt: 'look', model: 'default', cwd: home, autoApprove: false, approve: async () => ({ allow: false, message: 'You said no to web_fetch.' }) } as AgentRunRequest;
    for await (const e of runGrokAsked(command, req)) events.push(e);
    expect(resultsOf(events)).toEqual(['You said no to web_fetch.']);
  });

  it('says a tool never reached you, when Grok cancels it without asking', async () => {
    home = await mkdtemp(join(tmpdir(), 'grok-ask-'));
    const command = await grok(home);
    const events: PolyphemusEvent[] = [];
    const req = { prompt: 'no-ask', model: 'default', cwd: home, autoApprove: false, approve: async () => ({ allow: true }) } as AgentRunRequest;
    for await (const e of runGrokAsked(command, req)) events.push(e);
    expect(resultsOf(events)[0]).toMatch(/didn’t run run_terminal_command/);
    expect(resultsOf(events)[0]).toMatch(/not you rejecting/);
  });
});
