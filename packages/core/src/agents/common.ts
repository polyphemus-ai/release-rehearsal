import { classifyError } from '../errors.js';
import type { Worker } from '../isolation/workers.js';
import type { GrokIsolationStats } from '../isolation/grok.js';
import type { PolyphemusEvent } from '../events.js';
import { emptyUsage, ProviderError, type Block, type CapacityReading, type ImageBlock, type Message, type ModelInfo, type Origin } from '../types.js';
import { describeExit, ndjson, type NdjsonOptions, type ProcessExit } from './process.js';

export interface AgentRunRequest {
  /** The user's message, already including any context the CLI missed. */
  prompt: string;
  /** Images attached to the message. */
  images?: ImageBlock[];
  /** Model id or alias; "default" leaves the choice to the CLI. */
  model: string;
  cwd: string;
  /** The CLI's own session id, to continue that conversation. */
  resume?: string;
  /** Run tools without asking (maps to each CLI's bypass mode). */
  autoApprove: boolean;
  /** Only read: Claude and Grok ask about every change (and polyphemus declines), Codex gets its read-only sandbox. */
  readOnly?: boolean;
  /** Extra instructions from polyphemus (e.g. what it's running on), added to the CLI's system prompt. */
  systemAppend?: string;
  /** Folders outside `cwd` the CLI may write to (Claude Code and Codex: --add-dir). */
  extraDirs?: string[];
  /** Asks the person (or polyphemus's rules) whether a tool may run, for a CLI that asks its client (Grok, isolated). Unset: nothing to ask, so nothing runs that needs asking. */
  approve?: (tool: string, input: unknown) => Promise<{ allow: boolean; message?: string }>;
  /** Route the CLI's permission prompts to polyphemus (Claude Code only, for now). */
  permissionPrompt?: { mcpConfig: string; toolName: string };
  /** The gateway to poly connections, as an MCP server for the CLI to run (Claude Code and Codex). */
  connections?: ConnectionServer;
  /** The environment the CLI (and every shell it starts) runs in; unset, polyphemus's own. */
  env?: NodeJS.ProcessEnv;
  /**
   * Isolated (docs/design/isolation.md): the CLI's commands go to a worker. `env` is added to the CLI's,
   * polyphemus's own MCP servers get `hostNonce` so they still start here, and tools that reach this
   * computer directly are turned off.
   */
  isolation?: {
    env: Record<string, string>;
    hostNonce: string;
    blockedTools: string[];
    /** Grok: the worker its ACP client requests run in, and what it did there, when the turn ends. */
    worker?: Worker;
    report?: (stats: GrokIsolationStats) => void;
  };
  signal?: AbortSignal;
}

/** A stdio MCP server for a CLI to start: polyphemus's connections gateway. */
export interface ConnectionServer {
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * A vendor CLI that runs its own agent loop and tools on the user's
 * subscription (Claude Code, Codex, Grok). Polyphemus drives it headlessly and
 * turns its event stream into polyphemus events.
 */
export interface AgentProvider {
  readonly kind: 'agent';
  readonly id: string;
  run(req: AgentRunRequest): AsyncIterable<PolyphemusEvent>;
  listModels(): Promise<ModelInfo[]>;
}

/** Which native session an agent CLI keeps for a polyphemus session, and how much history it has seen. */
export interface AgentSessionState {
  nativeId: string;
  /**
   * How many of the thread's stored messages the native session already knows about. A thread's own
   * order never changes, so this still means the same thing after a restart, and when another agent
   * has been working in the thread alongside (review of parallel agents, 2026-09-20).
   */
  seenSeq?: number;
  /**
   * The same count, in the array one runtime had read — what polyphemus stored before `seenSeq`. Kept
   * for sessions saved then, and used only when there's no `seenSeq`.
   */
  seen: number;
  /**
   * The running total the CLI last reported for this native session. Claude Code's
   * `total_cost_usd` is the whole session's cost so far, not the turn's, so what a turn cost is the
   * difference from here — without it, a resumed session's total was counted again every turn
   * (2026-09-20). Proven against the CLI: a second turn of six tokens reported the first turn's
   * total plus its own.
   */
  costTotal?: number;
  /**
   * A hash of who the CLI was told it is when the native session began. A CLI only takes polyphemus's
   * instructions when a session starts (Codex prepends them to the first prompt), so a session begun
   * as Builder, reused for Reviewer or after Builder's instructions changed, would keep acting on the
   * old ones. A different fingerprint means a fresh native session.
   */
  fingerprint?: string;
}

export interface CliAgentOptions {
  /** Override the executable (default: claude / codex / grok on PATH). */
  command?: string;
  /** Permission mode (Claude, Grok) or sandbox (Codex) when not auto-approving. */
  permissionMode?: string;
}

export type Json = Record<string, unknown>;

export const obj = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
export const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export interface StreamContext {
  providerId: string;
  model: string;
  /** Codex only: read rate limits from its session log once the turn ends. */
  readLimits?: (nativeId: string) => Promise<CapacityReading[]>;
}

/** Turns a CLI's NDJSON lines into polyphemus events. Returns false if the stream ended without a result. */
export type StreamParser = (lines: AsyncIterable<Json>, ctx: StreamContext) => AsyncGenerator<PolyphemusEvent, boolean>;

/**
 * Groups a CLI's blocks into alternating assistant / tool-result messages as
 * they arrive, so the stored history is valid for any provider.
 */
export class MessageAssembler {
  private assistant: Block[] = [];
  private results: Block[] = [];

  constructor(private origin: Origin) {}

  setModel(model: string): void {
    this.origin = { ...this.origin, model };
  }

  addAssistant(block: Block): Message[] {
    const flushed = this.flushResults();
    this.assistant.push(block);
    return flushed;
  }

  addResult(block: Block): Message[] {
    const flushed = this.flushAssistant();
    this.results.push(block);
    return flushed;
  }

  flush(): Message[] {
    return [...this.flushAssistant(), ...this.flushResults()];
  }

  private flushAssistant(): Message[] {
    if (this.assistant.length === 0) return [];
    const message: Message = { role: 'assistant', content: this.assistant, origin: this.origin };
    this.assistant = [];
    return [message];
  }

  private flushResults(): Message[] {
    if (this.results.length === 0) return [];
    const message: Message = { role: 'user', content: this.results };
    this.results = [];
    return [message];
  }
}

export function* asMessages(messages: Message[]): Generator<PolyphemusEvent> {
  for (const message of messages) yield { type: 'message', message };
}

const SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt'];

/** A one-line description of a CLI tool call, for display. */
export function summarizeToolInput(input: Json): string {
  for (const key of SUMMARY_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value) return value;
  }
  if (Array.isArray(input.changes)) return input.changes.join(', ');
  const json = JSON.stringify(input);
  return json === '{}' ? '' : json;
}

/** Flattens a tool_result's content (a string or content blocks) to text. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(obj)
      .map((block) => (block.type === 'text' ? (str(block.text) ?? '') : block.type === 'image' ? '[image]' : JSON.stringify(block)))
      .join('\n');
  }
  return content === undefined || content === null ? '' : JSON.stringify(content);
}

async function* capture<T, R>(generator: AsyncGenerator<T, R>, box: { value?: R }): AsyncGenerator<T> {
  box.value = yield* generator;
}

/** Runs an agent CLI, parses its stream, and turns a missing result into a classified error. */
export async function* runCli(
  command: string,
  args: string[],
  processOptions: NdjsonOptions,
  parse: StreamParser,
  ctx: StreamContext,
): AsyncGenerator<PolyphemusEvent> {
  const exit: { value?: ProcessExit } = {};
  let completed: boolean;
  try {
    completed = yield* parse(capture(ndjson(command, args, processOptions), exit), ctx);
  } catch (err) {
    // An interrupted CLI often reports the interruption as a failure; to the user it's just a stop.
    if (!processOptions.signal?.aborted) throw err;
    completed = false;
  }
  if (completed) return;
  if (processOptions.signal?.aborted) {
    yield { type: 'turn_done', stopReason: 'aborted', usage: emptyUsage() };
    return;
  }
  const detail = exit.value ? describeExit(command, exit.value) : `\`${command}\` ended without a result`;
  throw new ProviderError(detail, classifyError(detail), ctx.providerId);
}
