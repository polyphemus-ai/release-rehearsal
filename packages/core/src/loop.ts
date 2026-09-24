import type { PolyphemusEvent } from './events.js';
import { fitHistoryToTools } from './history.js';
import { toolEnvironment } from './tools/guard.js';
import type { Worker } from './isolation/workers.js';
import { makeRedactor } from './tools/redact.js';
import type { Tool, ToolOutput } from './tools/tool.js';
import {
  addUsage,
  emptyUsage,
  type Block,
  type Effort,
  type ImageBlock,
  type Message,
  type ModelProvider,
  type ProviderEvent,
  type ToolCall,
} from './types.js';

export type { PolyphemusEvent } from './events.js';

const defaultRedact = makeRedactor();

/** Asked before running a tool that mutates. Return false to decline. */
export type Approver = (call: ToolCall, tool: Tool, summary: string) => Promise<boolean>;

export interface TurnOptions {
  provider: ModelProvider;
  model: string;
  effort?: Effort;
  system: string;
  /** Conversation so far. Not modified; new messages arrive as `message` events. */
  history: readonly Message[];
  tools: readonly Tool[];
  /** The user's new message. Omit to continue from history, e.g. retrying a turn on another model. */
  input?: string | Block[];
  cwd: string;
  signal?: AbortSignal;
  approve?: Approver;
  cacheKey?: string;
  /** Model requests per turn before giving up (default 100). */
  maxSteps?: number;
  /** Masks secrets in tool output before the model or the user sees it (default: common formats). */
  redact?: (text: string) => string;
  /** Environment for tool commands (default: the current one without secret-looking variables). */
  toolEnv?: NodeJS.ProcessEnv;
  /** Isolated: where the tools' commands and file operations run. */
  worker?: Worker;
  /** Keeps a picture a tool returned, as a message's image block (default: the pictures are left out, and the model is told). */
  keepImage?: (bytes: Uint8Array) => ImageBlock;
  /** A tool the model named that wasn't offered, if the caller knows it (a connection's, refused and recorded there). */
  unofferedTool?: (name: string) => Tool | undefined;
}

/**
 * Runs one user turn: model call, tool calls, model call, ... until the model
 * stops asking for tools. Whatever happens, the conversation it leaves behind
 * is valid to continue: every tool call gets a result.
 */
export async function* runTurn(opts: TurnOptions): AsyncGenerator<PolyphemusEvent> {
  const messages = [...opts.history];
  const append = (message: Message): PolyphemusEvent => {
    messages.push(message);
    return { type: 'message', message };
  };
  const toolsByName = new Map(opts.tools.map((tool) => [tool.spec.name, tool]));
  const toolNames = new Set(toolsByName.keys());
  const usage = emptyUsage();
  const aborted = () => opts.signal?.aborted === true;

  if (opts.input !== undefined) {
    yield append({
      role: 'user',
      content: typeof opts.input === 'string' ? [{ type: 'text', text: opts.input }] : opts.input,
    });
  }

  const maxSteps = opts.maxSteps ?? 100;
  for (let step = 0; step < maxSteps; step++) {
    let done: Extract<ProviderEvent, { type: 'message_done' }> | undefined;
    try {
      const stream = opts.provider.stream({
        model: opts.model,
        system: opts.system,
        // Turns run by agent CLIs used tools this loop doesn't have; those become text.
        messages: fitHistoryToTools(messages, toolNames),
        tools: opts.tools.map((tool) => tool.spec),
        effort: opts.effort,
        cacheKey: opts.cacheKey,
        signal: opts.signal,
      });
      for await (const event of stream) {
        if (event.type === 'message_done') done = event;
        else yield event;
      }
    } catch (err) {
      if (aborted()) {
        yield { type: 'turn_done', stopReason: 'aborted', usage };
        return;
      }
      throw err;
    }
    if (!done) throw new Error(`Provider "${opts.provider.id}" ended its stream without a final message`);

    addUsage(usage, done.usage);
    yield append(done.message);
    if (done.stopReason === 'pause') continue;

    const calls = done.message.content.filter((block): block is ToolCall => block.type === 'tool_call');
    if (calls.length === 0) {
      yield { type: 'turn_done', stopReason: done.stopReason, usage, detail: done.detail };
      return;
    }

    const results: Block[] = [];
    for (const call of calls) {
      const result: ToolOutput = yield* runToolCall(call, toolsByName.get(call.name) ?? opts.unofferedTool?.(call.name), opts);
      const images = (result.images ?? []).flatMap((image) => {
        try {
          return opts.keepImage ? [opts.keepImage(image.bytes)] : [];
        } catch {
          return []; // too big or not an image: the text still goes
        }
      });
      const dropped = (result.images?.length ?? 0) - images.length;
      const content = dropped > 0 ? `${result.content}\n[${dropped === 1 ? 'A picture' : `${dropped} pictures`} couldn’t be passed on.]` : result.content;
      results.push({ type: 'tool_result', callId: call.id, content, isError: result.isError, ...(images.length && { images }) });
    }
    yield append({ role: 'user', content: results });

    if (aborted()) {
      yield { type: 'turn_done', stopReason: 'aborted', usage };
      return;
    }
  }
  yield { type: 'turn_done', stopReason: 'other', usage, detail: `Stopped after ${maxSteps} model requests` };
}

async function* runToolCall(call: ToolCall, tool: Tool | undefined, opts: TurnOptions): AsyncGenerator<PolyphemusEvent, ToolOutput> {
  if (!tool) return { content: `Unknown tool "${call.name}"`, isError: true };
  if (opts.signal?.aborted) return { content: 'Cancelled: the user interrupted the turn.', isError: true };

  let summary: string;
  try {
    summary = tool.describe(call.input);
  } catch {
    summary = JSON.stringify(call.input);
  }

  if (tool.mutates && !tool.isReadOnly?.(call.input) && opts.approve) {
    let allowed = false;
    try {
      allowed = await opts.approve(call, tool, summary);
    } catch {
      // An interrupted approval prompt counts as a no.
    }
    if (!allowed) {
      const content = opts.signal?.aborted ? 'Cancelled: the user interrupted the turn.' : 'The user declined this tool call.';
      const result = { content, isError: true };
      yield { type: 'tool_end', call, result };
      return result;
    }
  }

  yield { type: 'tool_start', call, summary };
  let result: ToolOutput;
  try {
    result = await tool.run(call.input, { cwd: opts.cwd, signal: opts.signal, env: opts.toolEnv ?? toolEnvironment(), ...(opts.worker && { worker: opts.worker }) });
  } catch (err) {
    result = { content: `Error: ${(err as Error).message}`, isError: true };
  }
  result = { ...result, content: (opts.redact ?? defaultRedact)(result.content) };
  yield { type: 'tool_end', call, result };
  return result;
}
