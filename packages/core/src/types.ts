/**
 * Canonical, provider-neutral types. The loop, session store, and clients only
 * ever see these; provider adapters translate to and from each API's format.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Which provider and model produced an assistant message. */
export interface Origin {
  provider: string;
  model: string;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  text: string;
}

export interface ToolCall {
  type: 'tool_call';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  type: 'tool_result';
  callId: string;
  content: string;
  isError?: boolean;
  /** Pictures the tool returned — a page it looked at, an image file it read — for a model that can see. */
  images?: ImageBlock[];
}

/** An image you attached. The picture itself is a file in ~/.polyphemus/uploads (see images.ts). */
export interface ImageBlock {
  type: 'image';
  mediaType: string;
  path: string;
  /** The original file name, when there was one. */
  name?: string;
}

export type Block = TextBlock | ThinkingBlock | ToolCall | ToolResult | ImageBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: Block[];
  origin?: Origin;
  /**
   * The provider's own representation of this message (e.g. Anthropic content
   * blocks with thinking signatures, OpenAI output items with encrypted
   * reasoning). Adapters replay it verbatim when the next request goes to the
   * same provider and model, and rebuild from `content` otherwise.
   */
  native?: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'refusal'
  /** The provider paused mid-turn and expects the request to be re-sent. */
  | 'pause'
  | 'aborted'
  | 'other';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  effort?: Effort;
  /** Stable per-session key; providers that support it use it for cache routing. */
  cacheKey?: string;
  signal?: AbortSignal;
}

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'message_done'; message: Message; stopReason: StopReason; usage: Usage; detail?: string };

/**
 * One model a provider offers. Only `id` is certain: providers differ wildly in what they'll say
 * about their own models — Anthropic's list endpoint returns limits and capabilities, OpenAI's
 * returns barely more than ids, and xAI documents no list endpoint at all. Whatever comes back is
 * kept; nothing is filled in from a table, because a stale context window fails a request that
 * polyphemus said would fit.
 */
export interface ModelInfo {
  id: string;
  /** What the provider calls it, when it says. */
  name?: string;
  /** Input limit, in tokens. */
  contextWindow?: number;
  /** Most it will write in one reply, in tokens. */
  maxOutput?: number;
}

/** A model API that polyphemus drives with its own loop and tools. (Agent CLIs are `AgentProvider`s.) */
export interface ModelProvider {
  readonly kind: 'model';
  readonly id: string;
  /** Streams deltas, then exactly one `message_done`. */
  stream(req: ChatRequest): AsyncIterable<ProviderEvent>;
  listModels(): Promise<ModelInfo[]>;
}

/** An error whose message is meant for the user as-is (bad config, missing key). */
/**
 * Stable error codes that callers (agents, scripts) can branch on. The CLI maps them to exit
 * codes (docs/design/cli-for-agents.md §5).
 */
export type ErrorCode = 'FAILED' | 'USAGE' | 'NOT_FOUND' | 'CONFLICT';

export class PolyphemusError extends Error {
  override name = 'PolyphemusError';
  constructor(
    message: string,
    readonly code: ErrorCode = 'FAILED',
    /** The command that fixes it, when there is one. */
    readonly fix?: string,
  ) {
    super(message);
  }
}

/** What kind of failure an error is. Routing decides retry and fallback from this (docs/design/routing.md). */
export type ErrorClass = 'rate_limited' | 'quota_exhausted' | 'overloaded' | 'context_exceeded' | 'auth' | 'invalid_request' | 'unknown';

export class ProviderError extends PolyphemusError {
  override name = 'ProviderError';

  constructor(
    message: string,
    readonly errorClass: ErrorClass,
    readonly provider: string,
    /** When the provider said it can take work again, if it said. */
    readonly resetsAt?: Date,
  ) {
    super(message);
  }
}

/** One usage window a provider reported, e.g. Claude's 5-hour window at 22%. */
export interface CapacityReading {
  /** "5h", "7d", … or "quota" for a provider that reported it's out. */
  window: string;
  usedPct?: number;
  resetsAt?: Date;
  /** When this was reported (set by the store). */
  observedAt?: Date;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(total: Usage, more: Usage): void {
  total.inputTokens += more.inputTokens;
  total.outputTokens += more.outputTokens;
  total.cacheReadTokens += more.cacheReadTokens;
  total.cacheWriteTokens += more.cacheWriteTokens;
}

/** True when `message.native` can be replayed verbatim to this provider and model. */
export function canReplayNative(message: Message, provider: string, model: string): boolean {
  return message.native !== undefined && message.origin?.provider === provider && message.origin.model === model;
}
