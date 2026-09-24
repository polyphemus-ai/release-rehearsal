import type { PolyphemusEvent } from '../events.js';
import type { ImageBlock, Message } from '../types.js';
import type { AgentProvider, AgentRunRequest, AgentSessionState, ConnectionServer } from './common.js';
import { withMissedContext } from './transcript.js';

export interface AgentTurnOptions {
  provider: AgentProvider;
  model: string;
  /** Conversation so far. Not modified; new messages arrive as `message` events. */
  history: readonly Message[];
  /** The user's new message. Omit to continue from history, e.g. retrying a turn on another model. */
  input?: string;
  /** Images attached to the new message. */
  images?: ImageBlock[];
  cwd: string;
  autoApprove: boolean;
  /** Only reads: the CLI runs in its strictest mode, and anything else is declined. */
  readOnly?: boolean;
  /** The CLI's native session for this conversation, if it has taken part before. */
  state?: AgentSessionState;
  /**
   * What the CLI's own session hasn't been told about, worked out from the thread as it's stored.
   * Without it, what it missed is taken from `history` and `state.seen`, which only lines up when
   * this runtime is the only one that has written to the thread.
   */
  missed?: readonly Message[];
  /** Extra instructions from polyphemus for the CLI's system prompt. */
  systemAppend?: string;
  /** Folders outside `cwd` the CLI may write to (the project's memory). */
  extraDirs?: string[];
  /** Route the CLI's permission prompts to polyphemus. */
  permissionPrompt?: { mcpConfig: string; toolName: string };
  /**
   * Answers a permission question the CLI asks as polyphemus's client (Grok). It was set by the
   * caller but not passed on, so every one was refused as "no one to ask" (2026-09-23).
   */
  approve?: AgentRunRequest['approve'];
  /** The gateway to the connections this turn may reach. */
  connections?: ConnectionServer;
  /** The CLI's environment: without polyphemus's other secrets, and with pushes locked inside a run. */
  env?: NodeJS.ProcessEnv;
  isolation?: AgentRunRequest['isolation'];
  signal?: AbortSignal;
}

/**
 * Runs one user turn on an agent CLI. The CLI continues its own native session;
 * anything it hasn't seen (turns taken by other models) is passed along first,
 * so switching providers mid-conversation keeps everyone up to date.
 */
export async function* runAgentTurn(opts: AgentTurnOptions): AsyncGenerator<PolyphemusEvent> {
  if (opts.input !== undefined) {
    yield { type: 'message', message: { role: 'user', content: [{ type: 'text', text: opts.input }, ...(opts.images ?? [])] } };
  }
  const missed = opts.missed ?? opts.history.slice(opts.state?.seen ?? 0);
  const prompt = opts.input ?? 'The previous model could not finish this turn. Please respond to the latest user message in the conversation above.';
  yield* opts.provider.run({
    prompt: withMissedContext(prompt, missed, opts.state !== undefined),
    images: opts.input === undefined ? undefined : opts.images,
    model: opts.model,
    cwd: opts.cwd,
    resume: opts.state?.nativeId,
    autoApprove: opts.autoApprove,
    readOnly: opts.readOnly,
    systemAppend: opts.systemAppend,
    extraDirs: opts.extraDirs,
    permissionPrompt: opts.permissionPrompt,
    ...(opts.approve && { approve: opts.approve }),
    connections: opts.connections,
    ...(opts.env && { env: opts.env }),
    ...(opts.isolation && { isolation: opts.isolation }),
    signal: opts.signal,
  });
}
