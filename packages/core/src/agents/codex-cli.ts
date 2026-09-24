import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyError } from '../errors.js';
import type { PolyphemusEvent } from '../events.js';
import type { ToolOutput } from '../tools/tool.js';
import { ProviderError, type CapacityReading, type ModelInfo, type ToolCall } from '../types.js';
import {
  arr,
  asMessages,
  MessageAssembler,
  num,
  obj,
  runCli,
  str,
  summarizeToolInput,
  toolResultText,
  type AgentProvider,
  type AgentRunRequest,
  type CliAgentOptions,
  type ConnectionServer,
  type Json,
  type StreamParser,
} from './common.js';

/** Codex (`codex exec --json`) on the user's ChatGPT plan. */
export class CodexAgent implements AgentProvider {
  readonly kind = 'agent' as const;

  constructor(
    readonly id: string,
    private opts: CliAgentOptions & { codexHome?: string; sandbox?: boolean } = {},
  ) {}

  /** The binary this runs, for checking its sandbox (codex-sandbox.ts). */
  get command(): string {
    return this.opts.command ?? 'codex';
  }

  /** False when the owner turned Codex's sandbox off for this computer. */
  get sandboxed(): boolean {
    return this.opts.sandbox !== false;
  }

  run(req: AgentRunRequest): AsyncIterable<PolyphemusEvent> {
    const command = this.command;
    // `exec --image` takes several files, so it goes before the next flag; `resume --image` takes one each.
    const images = (req.images ?? []).flatMap((image) => ['--image', image.path]);
    const args = ['exec', ...(req.resume ? [] : images), '--json', '--skip-git-repo-check', '-C', req.cwd];
    // Isolated, the worker is the boundary: Codex's own sandbox can't start inside it, and isn't needed.
    if (req.autoApprove || req.isolation) args.push('--dangerously-bypass-approvals-and-sandbox');
    // Read-only work keeps its sandbox whatever: without it, nothing would make it read-only.
    else if (req.readOnly) args.push('--sandbox', 'read-only');
    else args.push('--sandbox', this.opts.sandbox === false ? 'danger-full-access' : (this.opts.permissionMode ?? 'workspace-write'));
    if (req.model !== 'default') args.push('--model', req.model);
    for (const dir of req.extraDirs ?? []) args.push('--add-dir', dir);
    // The gateway token stays in a file this user can read, not on the command line: on Linux anyone
    // on the machine can read a process's arguments (connections review, 2026-09-20). Claude already
    // does this with its mcp config; Codex only takes `-c`, so a small wrapper holds the environment.
    const mcp = req.connections && !req.isolation ? codexMcpServer(req.connections) : undefined;
    if (mcp) args.push(...mcp.args);
    if (req.resume) args.push('resume', req.resume, ...images);
    args.push('-'); // prompt from stdin
    // Codex has no flag for extra instructions, so a new session gets them at the top of its first prompt.
    const prompt = req.systemAppend && !req.resume ? `<polyphemus_context>\n${req.systemAppend}\n</polyphemus_context>\n\n${req.prompt}` : req.prompt;
    const env = req.isolation ? { ...(req.env ?? process.env), ...req.isolation.env } : req.env;
    const events = runCli(command, args, { cwd: req.cwd, input: prompt, signal: req.signal, ...(env && { env }) }, fromCodexStream, {
      providerId: this.id,
      model: req.model,
      readLimits: (threadId) => readCodexRateLimits(threadId, this.opts.codexHome),
    });
    if (!mcp) return events;
    const gone = mcp.dir;
    return (async function* () {
      try {
        yield* events;
      } finally {
        rmSync(gone, { recursive: true, force: true });
      }
    })();
  }

  /**
   * The models this CLI can be pointed at. Codex keeps its own cache of what the account may
   * use, so polyphemus reads that rather than hardcoding a list that goes stale — "default" stays
   * first, because letting the CLI choose is still a reasonable thing to want.
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      const file = join(codexHomeDir(this.opts.codexHome), 'models_cache.json');
      const cached = JSON.parse(await readFile(file, 'utf8')) as { models?: Array<{ slug?: unknown; display_name?: unknown }> };
      const models = (cached.models ?? [])
        .filter((m): m is { slug: string; display_name?: string } => typeof m.slug === 'string' && m.slug.length > 0)
        .map((m) => ({ id: m.slug, ...(typeof m.display_name === 'string' && m.display_name ? { name: m.display_name } : {}) }));
      return [{ id: 'default' }, ...models];
    } catch {
      // No cache yet (a fresh install, or a codex that has never run): the CLI still chooses.
      return [{ id: 'default' }];
    }
  }
}

/** A shell single quote. The value is data, never parsed as shell. */
const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The connections gateway as `-c` overrides. Codex has no file flag for one server, and putting the
 * gateway token in `-c env` would place it on the command line, which on Linux anyone on the machine
 * can read. The token goes in a file only this user can read, and Codex is told to run a wrapper that
 * loads it. The wrapper's directory lives as long as the turn (`run` deletes it).
 */
export function codexMcpServer(server: ConnectionServer): { args: string[]; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'polyphemus-codex-mcp-'));
  const envFile = join(dir, 'env');
  writeFileSync(envFile, Object.entries(server.env).map(([key, value]) => `${key}=${shQuote(value)}`).join('\n') + '\n', { mode: 0o600 });
  const wrapper = join(dir, 'run');
  writeFileSync(wrapper, `#!/bin/sh\nset -a\n. ${shQuote(envFile)}\nset +a\nexec ${shQuote(server.command)} ${server.args.map(shQuote).join(' ')} "$@"\n`, { mode: 0o700 });
  const key = `mcp_servers.${server.serverName}`;
  // Codex asks before any MCP call, and headless there's nobody to ask, so it declines them all.
  // Polyphemus checks the grant and asks about anything that isn't a read itself, so Codex needn't.
  return {
    dir,
    args: ['-c', `${key}.command=${JSON.stringify(wrapper)}`, '-c', `${key}.args=[]`, '-c', `${key}.default_tools_approval_mode="approve"`],
  };
}

/** Parses `codex exec --json`: thread / turn / item events. */
export const fromCodexStream: StreamParser = async function* (lines, ctx) {
  const assembler = new MessageAssembler({ provider: ctx.providerId, model: ctx.model });
  const calls = new Map<string, ToolCall>();
  let threadId: string | undefined;
  let replies = 0;

  for await (const line of lines) {
    switch (line.type) {
      case 'thread.started':
        threadId = str(line.thread_id);
        if (threadId) yield { type: 'agent_session', provider: ctx.providerId, id: threadId };
        break;

      case 'item.started': {
        const call = toolCall(obj(line.item));
        if (call && !calls.has(call.id)) {
          calls.set(call.id, call);
          yield* asMessages(assembler.addAssistant(call));
          yield { type: 'tool_start', call, summary: summarizeToolInput(call.input) };
        }
        break;
      }

      case 'item.completed': {
        const item = obj(line.item);
        const text = str(item.text);
        if (item.type === 'agent_message' && text) {
          yield { type: 'text_delta', text: replies++ > 0 ? `\n\n${text}` : text };
          yield* asMessages(assembler.addAssistant({ type: 'text', text }));
        } else if (item.type === 'reasoning' && text) {
          yield { type: 'thinking_delta', text };
          yield* asMessages(assembler.addAssistant({ type: 'thinking', text }));
        } else if (item.type === 'error') {
          yield { type: 'notice', text: str(item.message) ?? 'Codex reported an error' };
        } else {
          const started = calls.get(str(item.id) ?? '');
          const call = started ?? toolCall(item);
          if (!call) break;
          if (!started) {
            calls.set(call.id, call);
            yield* asMessages(assembler.addAssistant(call));
            yield { type: 'tool_start', call, summary: summarizeToolInput(call.input) };
          }
          const result = toolResult(item);
          yield* asMessages(assembler.addResult({ type: 'tool_result', callId: call.id, content: result.content, isError: result.isError }));
          yield { type: 'tool_end', call, result };
        }
        break;
      }

      case 'turn.completed': {
        yield* asMessages(assembler.flush());
        if (threadId && ctx.readLimits) {
          const readings = await ctx.readLimits(threadId).catch(() => []);
          if (readings.length > 0) yield { type: 'capacity', provider: ctx.providerId, readings };
        }
        const usage = obj(line.usage);
        const cached = num(usage.cached_input_tokens) ?? 0;
        yield {
          type: 'turn_done',
          stopReason: 'end_turn',
          usage: {
            inputTokens: Math.max(0, (num(usage.input_tokens) ?? 0) - cached),
            outputTokens: num(usage.output_tokens) ?? 0,
            cacheReadTokens: cached,
            cacheWriteTokens: 0,
          },
        };
        return true;
      }

      case 'turn.failed': {
        const message = str(obj(line.error).message) ?? 'the Codex turn failed';
        throw new ProviderError(message, classifyError(message), ctx.providerId);
      }

      case 'error':
        // Codex also reports transient problems (reconnects) this way; turn.failed is the real failure.
        yield { type: 'notice', text: str(line.message) ?? 'Codex reported an error' };
        break;
    }
  }
  yield* asMessages(assembler.flush());
  return false;
};

function toolCall(item: Json): ToolCall | undefined {
  const id = str(item.id);
  if (!id) return undefined;
  switch (item.type) {
    case 'command_execution':
      return { type: 'tool_call', id, name: 'shell', input: { command: str(item.command) ?? '' } };
    case 'file_change':
      return { type: 'tool_call', id, name: 'apply_patch', input: { changes: changeList(item) } };
    case 'mcp_tool_call':
      return { type: 'tool_call', id, name: `${str(item.server) ?? 'mcp'}.${str(item.tool) ?? 'tool'}`, input: obj(item.arguments) };
    case 'web_search':
      return { type: 'tool_call', id, name: 'web_search', input: { query: str(item.query) ?? '' } };
    default:
      return undefined;
  }
}

function toolResult(item: Json): ToolOutput {
  const failed = item.status === 'failed';
  switch (item.type) {
    case 'command_execution': {
      const exitCode = num(item.exit_code);
      const output = (str(item.aggregated_output) ?? '').trimEnd();
      const status = exitCode === undefined ? '' : `\n[exit code ${exitCode}]`;
      return { content: `${output}${status}`.trimStart(), isError: failed || (exitCode !== undefined && exitCode !== 0) };
    }
    case 'file_change':
      return { content: `${failed ? 'failed to apply' : 'applied'}: ${changeList(item).join(', ')}`, isError: failed };
    case 'mcp_tool_call':
      return item.error ? { content: JSON.stringify(item.error), isError: true } : { content: toolResultText(item.result), isError: failed };
    default:
      return { content: failed ? 'failed' : 'done', isError: failed };
  }
}

function changeList(item: Json): string[] {
  return arr(item.changes)
    .map(obj)
    .map((change) => `${str(change.kind) ?? 'update'} ${str(change.path) ?? ''}`.trim());
}

/** How far back (in days of session folders) to look for a thread's log. */
const ROLLOUT_SEARCH_DAYS = 7;
const TAIL_BYTES = 512_000;

/**
 * Codex writes rate limits into its session log (`token_count` events), not
 * into `exec --json`. Reads the latest reading for a thread.
 */
export async function readCodexRateLimits(threadId: string, codexHome?: string): Promise<CapacityReading[]> {
  const file = await findRollout(join(codexHomeDir(codexHome), 'sessions'), (name) => name.endsWith(`${threadId}.jsonl`));
  return file ? limitsFromRollout(file) : [];
}

/**
 * The most recent rate limits Codex wrote to any session log, and when. Gives
 * polyphemus Codex's usage at startup, before a Codex turn has run.
 */
export async function readLatestCodexRateLimits(codexHome?: string): Promise<{ readings: CapacityReading[]; observedAt?: Date }> {
  const file = await findRollout(join(codexHomeDir(codexHome), 'sessions'), (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'));
  if (!file) return { readings: [] };
  const [readings, info] = await Promise.all([limitsFromRollout(file), stat(file)]);
  return { readings, observedAt: info.mtime };
}

const codexHomeDir = (codexHome?: string) => codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');

async function limitsFromRollout(file: string): Promise<CapacityReading[]> {
  const handle = await open(file);
  let text: string;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    text = buffer.toString('utf8');
  } finally {
    await handle.close();
  }

  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: Json;
    try {
      entry = obj(JSON.parse(lines[i] ?? ''));
    } catch {
      continue; // the first line of the tail is usually cut off
    }
    const payload = obj(entry.payload);
    if (payload.type !== 'token_count') continue;
    const limits = obj(payload.rate_limits);
    return ['primary', 'secondary'].flatMap((key): CapacityReading[] => {
      const window = obj(limits[key]);
      const usedPct = num(window.used_percent);
      if (usedPct === undefined) return [];
      const resetsAt = num(window.resets_at);
      return [
        {
          window: windowLabel(num(window.window_minutes)),
          usedPct,
          resetsAt: resetsAt === undefined ? undefined : new Date(resetsAt > 1e12 ? resetsAt : resetsAt * 1000),
        },
      ];
    });
  }
  return [];
}

/** The newest session log (by folder date, then name) that matches, within the last week of folders. */
async function findRollout(root: string, matches: (name: string) => boolean): Promise<string | undefined> {
  const newest = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort().reverse();
  let searched = 0;
  for (const year of await newest(root)) {
    for (const month of await newest(join(root, year))) {
      for (const day of await newest(join(root, year, month))) {
        const dir = join(root, year, month, day);
        const match = (await newest(dir)).find(matches);
        if (match) return join(dir, match);
        if (++searched >= ROLLOUT_SEARCH_DAYS) return undefined;
      }
    }
  }
  return undefined;
}

function windowLabel(minutes: number | undefined): string {
  if (minutes === undefined) return 'window';
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
