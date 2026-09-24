import OpenAI from 'openai';
import { imageBase64 } from '../images.js';
import type { Block, ChatRequest, Message, ModelInfo, ModelProvider, ProviderEvent, StopReason, ToolSpec } from '../types.js';

// The OpenAI Chat Completions API: the one shape nearly every other server speaks. This is how
// polyphemus brings your own models — Ollama, LM Studio, llama.cpp and vLLM on your own machine,
// and OpenRouter, Groq, DeepSeek, Together, Mistral or Gemini's compatibility endpoint over the
// network — without an adapter each. (OpenAI and xAI have their own richer Responses adapter.)

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;
type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;
/** Servers that stream reasoning do it under their own name; neither is in the official types. */
type ReasoningDelta = { reasoning_content?: string; reasoning?: string };

export interface OpenAIChatOptions {
  apiKey: string;
  baseUrl?: string;
  /** Custom fetch, for tests. */
  fetch?: typeof globalThis.fetch;
}

export class OpenAIChatProvider implements ModelProvider {
  readonly kind = 'model' as const;
  private client: OpenAI;

  constructor(
    readonly id: string,
    opts: OpenAIChatOptions,
  ) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl, fetch: opts.fetch });
  }

  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    const stream = await this.client.chat.completions.create(
      {
        model: req.model,
        messages: toChatMessages(req.system, req.messages),
        ...(req.tools.length > 0 && { tools: req.tools.map(toChatTool) }),
        stream: true,
        // Chat Completions leaves usage out of a stream unless you ask for it.
        stream_options: { include_usage: true },
      },
      { signal: req.signal },
    );

    let text = '';
    let thinking = '';
    /** Tool calls arrive in fragments, keyed by position in the message. */
    const calls = new Map<number, { id: string; name: string; args: string }>();
    const announced = new Set<number>();
    let finish: string | null = null;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta as (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & ReasoningDelta) | undefined;
      if (delta?.content) {
        text += delta.content;
        yield { type: 'text_delta', text: delta.content };
      }
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoning) {
        thinking += reasoning;
        yield { type: 'thinking_delta', text: reasoning };
      }
      for (const fragment of delta?.tool_calls ?? []) {
        const call = calls.get(fragment.index) ?? { id: '', name: '', args: '' };
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.name += fragment.function.name;
        if (fragment.function?.arguments) call.args += fragment.function.arguments;
        calls.set(fragment.index, call);
        if (call.name && !announced.has(fragment.index)) {
          announced.add(fragment.index);
          yield { type: 'tool_call_start', id: call.id || `call_${fragment.index}`, name: call.name };
        }
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (chunk.usage) {
        usage.inputTokens = chunk.usage.prompt_tokens ?? 0;
        usage.outputTokens = chunk.usage.completion_tokens ?? 0;
        usage.cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        // What the server counted as cached was still sent, so it isn't also new input.
        usage.inputTokens = Math.max(0, usage.inputTokens - usage.cacheReadTokens);
      }
    }

    const content: Block[] = [
      ...(thinking ? [{ type: 'thinking' as const, text: thinking }] : []),
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...[...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]): Block => ({ type: 'tool_call', id: call.id || `call_${index}`, name: call.name, input: parseArguments(call.args) })),
    ];
    yield {
      type: 'message_done',
      // No `native`: this API has nothing to replay (reasoning here is plain text), so every
      // request is rebuilt from the canonical history.
      message: { role: 'assistant', content, origin: { provider: this.id, model: req.model } },
      stopReason: toStopReason(finish, content),
      usage,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    // OpenAI-compatible list endpoints return little beyond the id, so that's what polyphemus keeps.
    const ids: string[] = [];
    for await (const model of this.client.models.list()) ids.push(model.id);
    return ids.sort().map((id) => ({ id }));
  }
}

/** A model that answers with broken JSON shouldn't kill the turn; the tool reports the problem instead. */
function parseArguments(args: string): Record<string, unknown> {
  if (!args.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { _unparsed: args };
  }
}

export function toChatTool(spec: ToolSpec): ChatTool {
  return { type: 'function', function: { name: spec.name, description: spec.description, parameters: spec.inputSchema } };
}

export function toChatMessages(system: string, messages: readonly Message[]): ChatMessage[] {
  const out: ChatMessage[] = system ? [{ role: 'system', content: system }] : [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
      const toolCalls = message.content.flatMap((block) =>
        block.type === 'tool_call' ? [{ id: block.id, type: 'function' as const, function: { name: block.name, arguments: JSON.stringify(block.input) } }] : [],
      );
      // Thinking is bound to the model that produced it, and this API has no way to replay it.
      if (text || toolCalls.length > 0) out.push({ role: 'assistant', content: text || null, ...(toolCalls.length > 0 && { tool_calls: toolCalls }) });
      continue;
    }
    // Results answer a specific call, so each is its own message.
    for (const block of message.content) {
      if (block.type === 'tool_result') out.push({ role: 'tool', tool_call_id: block.callId, content: block.isError ? `Error: ${block.content}` : block.content });
    }
    const parts: ContentPart[] = [];
    // A tool message is text only here, so a result's pictures follow it as the next user message.
    for (const block of message.content) {
      if (block.type !== 'tool_result' || !block.images?.length) continue;
      parts.push({ type: 'text', text: `The pictures from that ${block.images.length === 1 ? 'call' : 'call, in order'}:` });
      for (const image of block.images) {
        const data = imageBase64(image);
        parts.push(data ? { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${data}` } } : { type: 'text', text: '[a picture that is no longer available]' });
      }
    }
    for (const block of message.content) {
      if (block.type === 'text' && block.text) parts.push({ type: 'text', text: block.text });
      if (block.type === 'image') {
        const data = imageBase64(block);
        parts.push(data ? { type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${data}` } } : { type: 'text', text: '[an attached image that is no longer available]' });
      }
    }
    // Plain text goes as a string: the oldest compatible servers accept nothing else.
    if (parts.length > 0) out.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') : parts });
  }
  return out;
}

function toStopReason(finish: string | null, content: Block[]): StopReason {
  if (content.some((block) => block.type === 'tool_call')) return 'tool_use';
  switch (finish) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return finish === null ? 'other' : 'end_turn';
  }
}
