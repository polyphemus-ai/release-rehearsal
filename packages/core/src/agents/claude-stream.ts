import { classifyError, statusIn } from '../errors.js';
import { ProviderError, type CapacityReading, type StopReason, type ToolCall, type Usage } from '../types.js';
import { arr, asMessages, MessageAssembler, num, obj, str, summarizeToolInput, toolResultText, type Json, type StreamParser } from './common.js';

const WINDOW_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d opus' };

/**
 * Parses the Agent SDK message stream: Claude Code's `--output-format stream-json`,
 * and Grok's `--output-format streaming-messages-json`, which uses the same
 * shapes. Only the top-level conversation is surfaced; subagent traffic
 * (`parent_tool_use_id` set) is skipped.
 */
export const fromClaudeStream: StreamParser = async function* (lines, ctx) {
  const assembler = new MessageAssembler({ provider: ctx.providerId, model: ctx.model });
  const calls = new Map<string, ToolCall>();
  // Whether the current API message's text/thinking already streamed as deltas.
  const streamed = { text: false, thinking: false };
  let result: Json | undefined;
  // Claude Code's own "API Error: 529 Overloaded…" banner, which it writes as if the model said it.
  let apiError: { message: string; status?: number } | undefined;
  // How the CLI is authenticated: "none" (Claude) or "oauth" (Grok) means a subscription login.
  let billing: 'plan' | 'metered' | undefined;

  for await (const line of lines) {
    if (line.parent_tool_use_id !== null && line.parent_tool_use_id !== undefined) continue;
    switch (line.type) {
      case 'system':
        if (line.subtype === 'init') {
          const model = str(line.model);
          if (model) assembler.setModel(model);
          const keySource = str(line.apiKeySource);
          if (keySource) billing = keySource === 'none' || keySource === 'oauth' ? 'plan' : 'metered';
          const id = str(line.session_id);
          if (id) yield { type: 'agent_session', provider: ctx.providerId, id };
        } else if (line.subtype === 'api_retry') {
          const attempt = `${num(line.attempt) ?? '?'} of ${num(line.max_retries) ?? '?'}`;
          yield { type: 'notice', text: `retrying after ${str(line.error) ?? 'an API error'} (attempt ${attempt})` };
        }
        break;

      case 'stream_event': {
        const event = obj(line.event);
        if (event.type === 'message_start') {
          streamed.text = false;
          streamed.thinking = false;
        }
        if (event.type !== 'content_block_delta') break;
        const delta = obj(event.delta);
        const text = str(delta.text);
        const thinking = str(delta.thinking);
        if (delta.type === 'text_delta' && text) {
          streamed.text = true;
          yield { type: 'text_delta', text };
        } else if (delta.type === 'thinking_delta' && thinking) {
          streamed.thinking = true;
          yield { type: 'thinking_delta', text: thinking };
        }
        break;
      }

      case 'assistant':
        // A message Claude Code made up to report a failed API call: an error, not the agent's words.
        // Kept out of the thread, and raised as the error it is, so fallback takes over (2026-09-21).
        if (line.isApiErrorMessage === true || obj(line.message).model === '<synthetic>') {
          const said = arr(obj(line.message).content).map(obj).map((b) => str(b.text) ?? '').join('').trim();
          if (/^API Error\b/i.test(said)) {
            apiError = { message: said, status: num(line.apiErrorStatus) ?? statusIn(said) };
            break;
          }
        }
        for (const block of arr(obj(line.message).content).map(obj)) {
          const text = str(block.text);
          const thinking = str(block.thinking);
          if (block.type === 'text' && text) {
            if (!streamed.text) yield { type: 'text_delta', text };
            yield* asMessages(assembler.addAssistant({ type: 'text', text }));
          } else if (block.type === 'thinking' && thinking) {
            if (!streamed.thinking) yield { type: 'thinking_delta', text: thinking };
            yield* asMessages(assembler.addAssistant({ type: 'thinking', text: thinking }));
          } else if (block.type === 'tool_use') {
            const call: ToolCall = {
              type: 'tool_call',
              id: str(block.id) ?? `call_${calls.size}`,
              name: str(block.name) ?? 'tool',
              input: obj(block.input),
            };
            calls.set(call.id, call);
            yield* asMessages(assembler.addAssistant(call));
            yield { type: 'tool_start', call, summary: summarizeToolInput(call.input) };
          }
        }
        break;

      case 'user':
        for (const block of arr(obj(line.message).content).map(obj)) {
          if (block.type !== 'tool_result') continue;
          const callId = str(block.tool_use_id) ?? '';
          const output = { content: toolResultText(block.content), isError: block.is_error === true };
          yield* asMessages(assembler.addResult({ type: 'tool_result', callId, ...output }));
          const call = calls.get(callId);
          if (call) yield { type: 'tool_end', call, result: output };
        }
        break;

      case 'rate_limit_event': {
        const readings = rateLimitReadings(obj(line.rate_limit_info));
        if (readings.length > 0) yield { type: 'capacity', provider: ctx.providerId, readings };
        break;
      }

      case 'result':
        result = line;
        break;
    }
  }
  yield* asMessages(assembler.flush());
  if (!result) return false;

  if (result.is_error === true || apiError) {
    const { message, status } = result.is_error === true ? resultError(result) : apiError!;
    throw new ProviderError(message, classifyError(message, status), ctx.providerId);
  }
  const denials = arr(result.permission_denials).map(obj);
  if (denials.length > 0) {
    const names = [...new Set(denials.map((d) => str(d.tool_name) ?? 'tool'))].join(', ');
    // Either the permission mode or the user (through the approval bridge) said no; the stream doesn't say which.
    yield { type: 'notice', text: `${denials.length} tool call${denials.length === 1 ? " wasn't" : "s weren't"} allowed (${names})` };
  }
  const maxTurns = result.subtype === 'error_max_turns';
  yield {
    type: 'turn_done',
    stopReason: maxTurns ? 'other' : stopReason(str(result.stop_reason)),
    usage: usageFrom(obj(result.usage)),
    costUsd: num(result.total_cost_usd),
    billing,
    detail: maxTurns ? 'hit the max-turns limit' : undefined,
  };
  return true;
};

function stopReason(reason: string | undefined): StopReason {
  if (reason === 'max_tokens' || reason === 'refusal') return reason;
  return 'end_turn';
}

function usageFrom(usage: Json): Usage {
  return {
    inputTokens: num(usage.input_tokens) ?? 0,
    outputTokens: num(usage.output_tokens) ?? 0,
    cacheReadTokens: num(usage.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: num(usage.cache_creation_input_tokens) ?? 0,
  };
}

/** Pulls the useful part out of a failed result, e.g. Grok's nested `"message": "API error (status 402 …)"`. */
function resultError(result: Json): { message: string; status?: number } {
  const raw =
    arr(result.errors)
      .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
      .join('\n') ||
    str(result.result) ||
    `the run failed (${str(result.subtype) ?? 'unknown error'})`;
  const inner = /"message"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
  return { message: inner ?? raw, status: num(result.api_error_status) ?? statusIn(raw) };
}

function rateLimitReadings(info: Json): CapacityReading[] {
  const reading = (name: string, window: Json): CapacityReading => {
    const utilization = num(window.utilization);
    const resetsAt = num(window.resetsAt);
    return {
      window: WINDOW_LABELS[name] ?? name,
      usedPct: utilization === undefined ? undefined : Math.round(utilization * 100),
      resetsAt: resetsAt === undefined ? undefined : new Date(resetsAt * 1000),
    };
  };
  const windows = Object.entries(obj(info.unifiedWindows)).map(([name, window]) => reading(name, obj(window)));
  const limited = str(info.rateLimitType);
  if (windows.length === 0 && limited) windows.push(reading(limited, info));
  // "rejected" means the window is used up, whatever utilization says.
  if (info.status === 'rejected') {
    const label = limited ? (WINDOW_LABELS[limited] ?? limited) : 'quota';
    const hit = windows.find((w) => w.window === label);
    if (hit) hit.usedPct = 100;
    else windows.push({ ...reading(limited ?? 'quota', info), window: label, usedPct: 100 });
  }
  return windows.filter((w) => w.usedPct !== undefined || w.resetsAt !== undefined);
}
