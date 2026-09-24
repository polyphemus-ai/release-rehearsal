import OpenAI from 'openai';
import {
  canReplayNative,
  type Block,
  type ChatRequest,
  type Message,
  type ModelProvider,
  type ProviderEvent,
  type StopReason,
  type ToolSpec,
  type ModelInfo,
} from '../types.js';
import { imageBase64 } from '../images.js';

type InputItem = OpenAI.Responses.ResponseInputItem;
type OutputItem = OpenAI.Responses.ResponseOutputItem;
type FunctionTool = OpenAI.Responses.FunctionTool;
type Response = OpenAI.Responses.Response;

export interface OpenAIResponsesOptions {
  apiKey: string;
  baseUrl?: string;
  reasoningSummary?: boolean;
  promptCacheKey?: boolean;
  /** Custom fetch, for tests. */
  fetch?: typeof globalThis.fetch;
}

/** OpenAI's Responses API. Also serves xAI (Grok), which implements the same API. */
export class OpenAIResponsesProvider implements ModelProvider {
  readonly kind = 'model' as const;
  private client: OpenAI;
  private reasoningSummary: boolean;
  private promptCacheKey: boolean;

  constructor(
    readonly id: string,
    opts: OpenAIResponsesOptions,
  ) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl, fetch: opts.fetch });
    this.reasoningSummary = opts.reasoningSummary ?? true;
    this.promptCacheKey = opts.promptCacheKey ?? true;
  }

  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    const replaysNative = req.messages.some((m) => canReplayNative(m, this.id, req.model));
    let started = false;
    try {
      for await (const event of this.attempt(req, replaysNative)) {
        started = true;
        yield event;
      }
    } catch (err) {
      // Providers sometimes reject their own replayed reasoning (e.g. encrypted_content that no
      // longer decrypts). Retry once from the canonical history instead of leaving the session stuck.
      if (!replaysNative || started || !(err instanceof OpenAI.BadRequestError)) throw err;
      yield* this.attempt(req, false);
    }
  }

  private async *attempt(req: ChatRequest, replayNative: boolean): AsyncIterable<ProviderEvent> {
    const reasoning = {
      ...(this.reasoningSummary && { summary: 'auto' as const }),
      ...(req.effort && { effort: req.effort }),
    };
    const stream = await this.client.responses.create(
      {
        model: req.model,
        instructions: req.system,
        input: toResponsesInput(req.messages, this.id, req.model, { replayNative }),
        tools: req.tools.map(toFunctionTool),
        // Nothing is stored server-side; encrypted reasoning comes back so it can be replayed.
        store: false,
        include: ['reasoning.encrypted_content'],
        ...(Object.keys(reasoning).length > 0 && { reasoning }),
        ...(this.promptCacheKey && req.cacheKey && { prompt_cache_key: req.cacheKey }),
        stream: true,
      },
      { signal: req.signal },
    );

    let final: Response | undefined;
    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta':
          yield { type: 'text_delta', text: event.delta };
          break;
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta':
          yield { type: 'thinking_delta', text: event.delta };
          break;
        case 'response.output_item.added':
          if (event.item.type === 'function_call') yield { type: 'tool_call_start', id: event.item.call_id, name: event.item.name };
          break;
        case 'response.completed':
        case 'response.incomplete':
          final = event.response;
          break;
        case 'response.failed':
          throw new Error(event.response.error?.message ?? 'The response failed');
        case 'error':
          throw new Error(event.message);
      }
    }
    if (!final) throw new Error('The response stream ended without a completed response');

    const content = fromResponseOutput(final.output);
    const usage = final.usage;
    yield {
      type: 'message_done',
      message: { role: 'assistant', content, origin: { provider: this.id, model: req.model }, native: final.output },
      stopReason: toStopReason(final, content),
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cacheReadTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      },
      detail: final.incomplete_details?.reason ?? undefined,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    // OpenAI-compatible list endpoints return little beyond the id, so that's what polyphemus keeps.
    const ids: string[] = [];
    for await (const model of this.client.models.list()) ids.push(model.id);
    return ids.sort().map((id) => ({ id }));
  }
}

export function toFunctionTool(spec: ToolSpec): FunctionTool {
  return { type: 'function', name: spec.name, description: spec.description, parameters: spec.inputSchema, strict: false };
}

export function toResponsesInput(
  messages: Message[],
  providerId: string,
  model: string,
  opts: { replayNative?: boolean } = {},
): InputItem[] {
  const items: InputItem[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && opts.replayNative !== false && canReplayNative(message, providerId, model)) {
      items.push(...(message.native as InputItem[]));
      continue;
    }
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text) items.push({ role: message.role, content: block.text });
          break;
        case 'tool_call':
          items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
          break;
        case 'tool_result':
          items.push({
            type: 'function_call_output',
            call_id: block.callId,
            output: block.images?.length
              ? [
                  { type: 'input_text', text: block.isError ? `Error: ${block.content}` : block.content || '(no text)' },
                  ...block.images.map((image) => {
                    const data = imageBase64(image);
                    return data ? { type: 'input_image' as const, image_url: `data:${image.mediaType};base64,${data}`, detail: 'auto' as const } : { type: 'input_text' as const, text: '[a picture that is no longer available]' };
                  }),
                ]
              : block.isError
                ? `Error: ${block.content}`
                : block.content,
          });
          break;
        case 'image': {
          const data = imageBase64(block);
          items.push(
            data
              ? { role: 'user', content: [{ type: 'input_image', image_url: `data:${block.mediaType};base64,${data}`, detail: 'auto' }] }
              : { role: message.role, content: '[an attached image that is no longer available]' },
          );
          break;
        }
        case 'thinking':
          // Reasoning is bound to the model that produced it; other models can't use it.
          break;
      }
    }
  }
  return items;
}

export function fromResponseOutput(output: OutputItem[]): Block[] {
  return output.flatMap((item): Block[] => {
    switch (item.type) {
      case 'reasoning': {
        const text = [...item.summary.map((s) => s.text), ...(item.content ?? []).map((c) => c.text)].join('\n\n');
        return text ? [{ type: 'thinking', text }] : [];
      }
      case 'message':
        return item.content.map((part): Block => ({ type: 'text', text: part.type === 'output_text' ? part.text : part.refusal }));
      case 'function_call':
        return [{ type: 'tool_call', id: item.call_id, name: item.name, input: parseArguments(item.arguments) }];
      default:
        return [];
    }
  });
}

function parseArguments(args: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(args || '{}');
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Leave it to the tool to report the missing parameters.
    return {};
  }
}

function toStopReason(response: Response, content: Block[]): StopReason {
  if (response.output.some((item) => item.type === 'message' && item.content.some((c) => c.type === 'refusal'))) return 'refusal';
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason;
    return reason === 'max_output_tokens' ? 'max_tokens' : reason === 'content_filter' ? 'refusal' : 'other';
  }
  return content.some((b) => b.type === 'tool_call') ? 'tool_use' : 'end_turn';
}
