import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { classifyError } from '../errors.js';
import type { PolyphemusEvent } from '../events.js';
import { emptyUsage, ProviderError, type Block, type StopReason } from '../types.js';
import type { AgentRunRequest } from '../agents/common.js';
import type { Worker } from './workers.js';

// Grok Build, isolated (docs/design/isolation.md): polyphemus drives `grok agent stdio` as its ACP client.
// Grok stays on this computer with its sign-in, and asks the client to run its shell commands
// (terminal/*) and to read and write files (fs/*) — polyphemus does those in the project's worker. Its
// grep and list_dir tools read this computer directly, so the session's agent profile allows only the
// tools that go through the client. Every tool call is checked against that as it happens.

/** Grok's tools that reach files or commands only through the client, plus its MCP meta-tools. */
export const GROK_ISOLATED_TOOLS = ['run_terminal_command', 'read_file', 'write', 'search_replace'];
const ALWAYS_ON = new Set(['search_tool', 'use_tool']);

export interface GrokIsolationStats {
  commands: number;
  terminals: number;
  /** A tool that could reach this computer directly was used: why, if so. */
  escaped?: string;
}

type Json = Record<string, any>;

/** The same failure, said so a person can tell a refusal from a stop. `why` is the answer already given, when there was one. */
export function explainGrokCancellation(text: string, why?: string): string {
  // Grok uses both words for the same thing: a permission it settled without you.
  return text.replace(/User (?:cancelled|rejected) the execution for tool `([^`]+)`/g, (_all, tool: string) => why ?? `Grok didn’t run ${tool}. It needed a yes, and that question never reached you, so this was not you rejecting it.`);
}

/** Allow or refuse one of Grok's permission questions. Nobody to ask means no. */
async function grokPermission(req: AgentRunRequest, params: Json): Promise<{ reply: Json; callId: string; denied?: string }> {
  const options: Json[] = params.options ?? [];
  const pick = (kind: RegExp) => options.find((o) => kind.test(String(o.kind)));
  const call: Json = params.toolCall ?? {};
  const tool = String(call.kind === 'execute' ? 'run_terminal_command' : (call.title ?? call.kind ?? 'a tool'));
  const answer = req.autoApprove
    ? { allow: true }
    : req.approve
      ? await req.approve(tool, call.rawInput ?? {})
      : { allow: false, message: `Grok didn’t run ${tool}. There’s no one to ask, so it wasn’t run. This was not you cancelling it.` };
  const chosen = answer.allow ? (pick(/^allow_once$/) ?? pick(/^allow/)) : (pick(/^reject_once$/) ?? pick(/^reject/));
  return {
    reply: { outcome: chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' } },
    callId: String(call.toolCallId ?? ''),
    ...(!answer.allow && { denied: answer.message ?? `You said no to ${tool}.` }),
  };
}

export async function* runGrokIsolated(command: string, req: AgentRunRequest, worker: Worker, onDone: (stats: GrokIsolationStats) => void): AsyncGenerator<PolyphemusEvent> {
  const args = ['agent', ...(req.autoApprove ? ['--always-approve'] : []), ...(req.model !== 'default' ? ['--model', req.model] : []), 'stdio'];
  const child = spawn(command, args, { cwd: req.cwd, env: req.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString('utf8')).slice(-4000)));
  const stats: GrokIsolationStats = { commands: 0, terminals: 0 };
  const origin = { provider: 'grok-build', model: req.model };

  // A queue the generator reads from: updates arrive on stdout whenever Grok sends them.
  const queue: PolyphemusEvent[] = [];
  let wake: (() => void) | undefined;
  let finished: { stop: StopReason; error?: string } | undefined;
  /** Past the session's load, and into this turn: updates before that are the replayed history. */
  let live = false;
  const push = (event: PolyphemusEvent) => {
    queue.push(event);
    wake?.();
  };
  const finish = (stop: StopReason, error?: string) => {
    finished ??= { stop, ...(error && { error }) };
    wake?.();
  };

  let nextId = 1;
  const waiting = new Map<number, (m: Json) => void>();
  const send = (message: Json): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const request = (method: string, params: Json) =>
    new Promise<Json>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      send({ id, method, params });
    });

  const terminals = new Map<string, { output: string; done: Promise<{ exitCode: number | null; signal: string | null }>; abort: AbortController }>();
  let text = '';
  let toolCalls: Block[] = [];
  const flushAssistant = () => {
    const content: Block[] = [...(text ? [{ type: 'text' as const, text }] : []), ...toolCalls];
    if (content.length) push({ type: 'message', message: { role: 'assistant', content, origin } });
    text = '';
    toolCalls = [];
  };

  async function answer(m: Json): Promise<void> {
    const p = m.params ?? {};
    const reply = (result: unknown) => send({ id: m.id, result });
    const refuse = (message: string) => send({ id: m.id, error: { code: -32000, message } });
    try {
      switch (m.method) {
        case 'fs/read_text_file': {
          if (!worker.allows(p.path)) return refuse(`${p.path} isn’t in what this project’s worker was given.`);
          const r = await worker.exec(['cat', '--', p.path], { timeoutMs: 60_000 });
          if (r.code !== 0) return refuse(r.stderr.trim() || `Couldn’t read ${p.path}`);
          let content = r.stdout.toString('utf8');
          if (p.line || p.limit) content = content.split('\n').slice(Math.max(0, (p.line ?? 1) - 1), p.limit ? Math.max(0, (p.line ?? 1) - 1) + p.limit : undefined).join('\n');
          return reply({ content });
        }
        case 'fs/write_text_file': {
          if (!worker.allows(p.path, true)) return refuse(`${p.path} isn’t writable in this project’s worker.`);
          const r = await worker.exec(['bash', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'write', p.path], { stdin: String(p.content ?? ''), timeoutMs: 60_000 });
          return r.code === 0 ? reply(null) : refuse(r.stderr.trim() || `Couldn’t write ${p.path}`);
        }
        case 'terminal/create': {
          stats.terminals++;
          const id = `t${stats.terminals}`;
          const abort = new AbortController();
          const entry = { output: '', abort, done: Promise.resolve({ exitCode: null as number | null, signal: null as string | null }) };
          const env = Object.fromEntries((p.env ?? []).filter((e: Json) => typeof e?.name === 'string').map((e: Json) => [e.name, String(e.value ?? '')]));
          const argv = Array.isArray(p.args) && p.args.length ? [String(p.command), ...p.args.map(String)] : ['bash', '-c', String(p.command)];
          entry.done = worker.exec(argv, { cwd: typeof p.cwd === 'string' ? p.cwd : req.cwd, env, combine: true, signal: abort.signal, timeoutMs: 30 * 60_000 }).then((r) => {
            const limit = typeof p.outputByteLimit === 'number' ? p.outputByteLimit : 1_000_000;
            entry.output = r.stdout.toString('utf8').slice(-limit);
            return { exitCode: r.stopped ? null : r.code, signal: r.stopped ? 'SIGKILL' : null };
          });
          terminals.set(id, entry);
          return reply({ terminalId: id });
        }
        case 'terminal/output': {
          const t = terminals.get(p.terminalId);
          if (!t) return refuse('No such terminal.');
          const exit = await Promise.race([t.done, new Promise<undefined>((r) => setTimeout(() => r(undefined), 50))]);
          return reply({ output: t.output, truncated: false, ...(exit && { exitStatus: exit }) });
        }
        case 'terminal/wait_for_exit': {
          const t = terminals.get(p.terminalId);
          return t ? reply(await t.done) : refuse('No such terminal.');
        }
        case 'terminal/kill':
        case 'terminal/release': {
          const t = terminals.get(p.terminalId);
          t?.abort.abort();
          if (m.method === 'terminal/release') terminals.delete(p.terminalId);
          return reply(null);
        }
        case 'session/request_permission': {
          // The worker bounds what a command can reach; whether it runs at all is still the person's
          // call, unless the thread runs without asking. Nobody to ask means no (independent review, 2026-09-19).
          return reply((await grokPermission(req, p)).reply);
        }
        default:
          return send({ id: m.id, error: { code: -32601, message: `polyphemus doesn’t offer ${m.method}` } });
      }
    } catch (err) {
      refuse((err as Error).message);
    }
  }

  createInterface({ input: child.stdout }).on('line', (line) => {
    let m: Json;
    try {
      m = JSON.parse(line) as Json;
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
      return;
    }
    if (m.method && m.id !== undefined) {
      void answer(m);
      return;
    }
    // Loading a session replays the whole conversation so far as updates. That's history the thread
    // already has: only what comes after the new prompt is this turn (2026-09-21, a report stored 5x).
    if (m.method !== 'session/update' || !live) return;
    const u = m.params?.update ?? {};
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text') {
          text += u.content.text;
          push({ type: 'text_delta', text: u.content.text });
        }
        break;
      case 'agent_thought_chunk':
        if (u.content?.type === 'text') push({ type: 'thinking_delta', text: u.content.text });
        break;
      case 'tool_call': {
        const name = String(u._meta?.['x.ai/tool']?.name ?? u.title ?? 'tool');
        if (!GROK_ISOLATED_TOOLS.includes(name) && !ALWAYS_ON.has(name)) stats.escaped ??= `Grok used ${name}, which doesn’t go through the worker`;
        if (u._meta?.['x.ai/tool']?.kind === 'execute') stats.commands++;
        toolCalls.push({ type: 'tool_call', id: String(u.toolCallId), name, input: (u.rawInput ?? {}) as Record<string, unknown> });
        push({ type: 'tool_call_start', id: String(u.toolCallId), name });
        break;
      }
      case 'tool_call_update':
        if (u.status === 'completed' || u.status === 'failed') {
          flushAssistant();
          const result = (u.content ?? []).map((c: Json) => c?.content?.text ?? '').join('\n');
          push({ type: 'message', message: { role: 'user', content: [{ type: 'tool_result', callId: String(u.toolCallId), content: result, isError: u.status === 'failed' }] } });
        }
        break;
    }
  });
  child.on('close', (code) => finish('other', finished ? undefined : `grok agent stopped (exit ${code})${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`));
  req.signal?.addEventListener('abort', () => {
    for (const t of terminals.values()) t.abort.abort();
    child.kill('SIGTERM');
    finish('aborted');
  });

  (async () => {
    const init = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true } });
    if (init.error) return finish('other', `Grok didn’t start: ${init.error.message}`);
    const meta = { agentProfile: { name: 'polyphemus-isolated', description: 'Commands and files in polyphemus’s worker', tools: GROK_ISOLATED_TOOLS }, ...(req.systemAppend && { rules: req.systemAppend }), ...(req.autoApprove && { yoloMode: true }) };
    let sessionId = req.resume;
    if (sessionId) {
      const loaded = await request('session/load', { sessionId, cwd: req.cwd, mcpServers: [], _meta: meta });
      if (loaded.error) sessionId = undefined;
    }
    if (!sessionId) {
      const created = await request('session/new', { cwd: req.cwd, mcpServers: [], _meta: meta });
      if (created.error) return finish('other', `Grok couldn’t start a session: ${created.error.message}`);
      sessionId = String(created.result.sessionId);
    }
    push({ type: 'agent_session', provider: 'grok-build', id: sessionId });
    live = true;
    const answered = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: req.prompt }] });
    flushAssistant();
    if (answered.error) return finish('other', answered.error.message);
    const reason = String(answered.result?.stopReason ?? 'end_turn');
    finish(reason === 'cancelled' ? 'aborted' : reason === 'max_tokens' ? 'max_tokens' : 'end_turn');
  })().catch((err: Error) => finish('other', err.message));

  try {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (finished) break;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
    }
    while (queue.length) yield queue.shift()!;
    if (finished.error && !req.signal?.aborted) throw new ProviderError(finished.error, classifyError(finished.error), 'grok-build');
    yield { type: 'turn_done', stopReason: finished.stop, usage: emptyUsage(), billing: 'plan' };
  } finally {
    for (const t of terminals.values()) t.abort.abort();
    child.kill('SIGTERM');
    onDone(stats);
  }
}

/**
 * Grok on this computer. Its own tools run, and a permission question comes here instead of dying
 * inside a headless prompt — which Grok was reporting as "User cancelled", though nobody pressed stop.
 */
export async function* runGrokAsked(command: string, req: AgentRunRequest): AsyncGenerator<PolyphemusEvent> {
  // No acceptEdits. That mode allows a file edit and rejects every other tool, then says you rejected it.
  // A read-only thread still asks Grok to prompt; we answer. Otherwise Grok asks us when it needs a yes.
  const args = [
    ...(req.readOnly && !req.autoApprove ? ['--permission-mode', 'default'] : []),
    'agent',
    ...(req.autoApprove ? ['--always-approve'] : []),
    ...(req.model !== 'default' ? ['--model', req.model] : []),
    'stdio',
  ];
  const child = spawn(command, args, { cwd: req.cwd, env: req.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => (stderr = (stderr + c.toString('utf8')).slice(-4000)));
  const origin = { provider: 'grok-build', model: req.model };
  const queue: PolyphemusEvent[] = [];
  let wake: (() => void) | undefined;
  let finished: { stop: StopReason; error?: string } | undefined;
  /** Past the session's load, and into this turn: updates before that are the replayed history. */
  let live = false;
  const push = (event: PolyphemusEvent) => {
    queue.push(event);
    wake?.();
  };
  const finish = (stop: StopReason, error?: string) => {
    finished ??= { stop, ...(error && { error }) };
    wake?.();
  };
  let nextId = 1;
  const waiting = new Map<number, (m: Json) => void>();
  const send = (message: Json): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const request = (method: string, params: Json) =>
    new Promise<Json>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      send({ id, method, params });
    });
  const denied = new Map<string, string>();
  let text = '';
  let toolCalls: Block[] = [];
  const flushAssistant = () => {
    const content: Block[] = [...(text ? [{ type: 'text' as const, text }] : []), ...toolCalls];
    if (content.length) push({ type: 'message', message: { role: 'assistant', content, origin } });
    text = '';
    toolCalls = [];
  };

  async function answer(m: Json): Promise<void> {
    const p = m.params ?? {};
    const reply = (result: unknown) => send({ id: m.id, result });
    try {
      switch (m.method) {
        case 'session/request_permission': {
          const decided = await grokPermission(req, p);
          if (decided.denied) denied.set(decided.callId, decided.denied);
          return reply(decided.reply);
        }
        default:
          return send({ id: m.id, error: { code: -32601, message: `polyphemus doesn’t run ${m.method} for Grok on this computer. The question, if it was a permission, is answered separately.` } });
      }
    } catch (err) {
      send({ id: m.id, error: { code: -32000, message: (err as Error).message } });
    }
  }

  createInterface({ input: child.stdout }).on('line', (line) => {
    let m: Json;
    try {
      m = JSON.parse(line) as Json;
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
      return;
    }
    if (m.method && m.id !== undefined) {
      void answer(m);
      return;
    }
    // Loading a session replays the whole conversation so far as updates. That's history the thread
    // already has: only what comes after the new prompt is this turn (2026-09-21, a report stored 5x).
    if (m.method !== 'session/update' || !live) return;
    const u = m.params?.update ?? {};
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text') {
          text += u.content.text;
          push({ type: 'text_delta', text: u.content.text });
        }
        break;
      case 'agent_thought_chunk':
        if (u.content?.type === 'text') push({ type: 'thinking_delta', text: u.content.text });
        break;
      case 'tool_call': {
        const name = String(u._meta?.['x.ai/tool']?.name ?? u.title ?? 'tool');
        toolCalls.push({ type: 'tool_call', id: String(u.toolCallId), name, input: (u.rawInput ?? {}) as Record<string, unknown> });
        push({ type: 'tool_call_start', id: String(u.toolCallId), name });
        break;
      }
      case 'tool_call_update':
        if (u.status === 'completed' || u.status === 'failed') {
          flushAssistant();
          const callId = String(u.toolCallId);
          let result = (u.content ?? []).map((c: Json) => c?.content?.text ?? '').join('\n');
          if (u.status === 'failed') {
            const why = denied.get(callId);
            result = explainGrokCancellation(result, why);
            if (!result && why) result = why;
            denied.delete(callId);
          }
          push({ type: 'message', message: { role: 'user', content: [{ type: 'tool_result', callId, content: result, isError: u.status === 'failed' }] } });
        }
        break;
    }
  });
  child.on('close', (code) => finish('other', finished ? undefined : `grok agent stopped (exit ${code})${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`));
  req.signal?.addEventListener('abort', () => {
    child.kill('SIGTERM');
    finish('aborted');
  });

  (async () => {
    const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    if (init.error) return finish('other', `Grok didn’t start: ${init.error.message}`);
    const meta = { ...(req.systemAppend && { rules: req.systemAppend }), ...(req.autoApprove && { yoloMode: true }) };
    // Polyphemus's own tools (connections, show_artifact, a run's tools) through the gateway, as Claude
    // Code and Codex have them. Without it a Grok agent could only hand the person a file's path.
    const mcpServers = req.connections ? [{ name: req.connections.serverName, command: req.connections.command, args: req.connections.args, env: Object.entries(req.connections.env).map(([name, value]) => ({ name, value })) }] : [];
    let sessionId = req.resume;
    if (sessionId) {
      const loaded = await request('session/load', { sessionId, cwd: req.cwd, mcpServers, _meta: meta });
      if (loaded.error) sessionId = undefined;
    }
    if (!sessionId) {
      const created = await request('session/new', { cwd: req.cwd, mcpServers, _meta: meta });
      if (created.error) return finish('other', `Grok couldn’t start a session: ${created.error.message}`);
      sessionId = String(created.result.sessionId);
    }
    push({ type: 'agent_session', provider: 'grok-build', id: sessionId });
    live = true;
    const answered = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: req.prompt }] });
    flushAssistant();
    if (answered.error) return finish('other', answered.error.message);
    if (req.signal?.aborted) return finish('aborted');
    const reason = String(answered.result?.stopReason ?? 'end_turn');
    // A permission that wasn't granted ends the turn. The tool result says why. It is not a stop the person pressed.
    finish(reason === 'max_tokens' ? 'max_tokens' : 'end_turn');
  })().catch((err: Error) => finish('other', err.message));

  try {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (finished) break;
      await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
    }
    while (queue.length) yield queue.shift()!;
    if (finished.error && !req.signal?.aborted) throw new ProviderError(finished.error, classifyError(finished.error), 'grok-build');
    yield { type: 'turn_done', stopReason: finished.stop, usage: emptyUsage(), billing: 'plan' };
  } finally {
    child.kill('SIGTERM');
  }
}

export const GROK_ISOLATED_NOTE =
  'You are isolated: your shell commands and file reads and writes run in a container that has only this project’s folder and its memory — no home folder, no credentials, no other projects. To search files, use the shell (rg, find).';
