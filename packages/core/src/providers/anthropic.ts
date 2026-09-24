import Anthropic from '@anthropic-ai/sdk';
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

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;
type BetaTool = Anthropic.Beta.BetaTool;

const MAX_TOKENS = 64_000;

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_MODELS = /^claude-(opus-5|fable-5-1)(?!\d)/;
/** Models that predate adaptive thinking; they run without thinking. */
const PRE_ADAPTIVE_MODELS = /^claude-(3|haiku-4-5|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0|opus-4-2)/;

export class AnthropicProvider implements ModelProvider {
  readonly kind = 'model' as const;
  private client: Anthropic;

  constructor(
    readonly id: string,
    opts: { apiKey: string; baseUrl?: string; fetch?: typeof globalThis.fetch },
  ) {
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl, fetch: opts.fetch });
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
      // If the API rejects replayed thinking (e.g. a signature from another org's key), retry once
      // from the canonical history instead of leaving the session stuck.
      if (!replaysNative || started || !(err instanceof Anthropic.BadRequestError)) throw err;
      yield* this.attempt(req, false);
    }
  }

  private async *attempt(req: ChatRequest, replayNative: boolean): AsyncIterable<ProviderEvent> {
    const stream = this.client.beta.messages.stream(
      {
        model: req.model,
        max_tokens: MAX_TOKENS,
        system: req.system,
        messages: toAnthropicMessages(req.messages, this.id, req.model, { replayNative }),
        tools: req.tools.map(toAnthropicTool),
        // Automatic caching: the breakpoint moves to the end of the history each request.
        cache_control: { type: 'ephemeral' },
        ...(!PRE_ADAPTIVE_MODELS.test(req.model) && { thinking: { type: 'adaptive', display: 'summarized' } }),
        ...(req.effort && { output_config: { effort: req.effort } }),
        ...(FALLBACK_MODELS.test(req.model) && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
      },
      { signal: req.signal },
    );

    for await (const event of stream) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        yield { type: 'tool_call_start', id: event.content_block.id, name: event.content_block.name };
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') yield { type: 'text_delta', text: event.delta.text };
        else if (event.delta.type === 'thinking_delta') yield { type: 'thinking_delta', text: event.delta.thinking };
      }
    }

    const final = await stream.finalMessage();
    yield {
      type: 'message_done',
      message: {
        role: 'assistant',
        content: fromAnthropicContent(final.content),
        // final.model is the model that actually answered (it differs after a fallback).
        origin: { provider: this.id, model: final.model },
        native: final.content,
      },
      stopReason: toStopReason(final.stop_reason),
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
      },
      detail: final.stop_reason === 'refusal' ? (final.stop_details?.explanation ?? undefined) : undefined,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    // The Models API returns limits and capabilities per model, not just ids.
    for await (const model of this.client.models.list()) {
      const raw = model as { id: string; display_name?: string; max_input_tokens?: number; max_tokens?: number };
      models.push({
        id: raw.id,
        ...(raw.display_name ? { name: raw.display_name } : {}),
        ...(typeof raw.max_input_tokens === 'number' ? { contextWindow: raw.max_input_tokens } : {}),
        ...(typeof raw.max_tokens === 'number' ? { maxOutput: raw.max_tokens } : {}),
      });
    }
    return models;
  }
}

export function toAnthropicTool(spec: ToolSpec): BetaTool {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.inputSchema as BetaTool['input_schema'],
  };
}

export function toAnthropicMessages(
  messages: Message[],
  providerId: string,
  model: string,
  opts: { replayNative?: boolean } = {},
): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && opts.replayNative !== false && canReplayNative(message, providerId, model)) {
      out.push({ role: 'assistant', content: message.native as BetaContentBlockParam[] });
      continue;
    }
    const content = message.content.flatMap((block): BetaContentBlockParam[] => {
      switch (block.type) {
        case 'text':
          return block.text ? [{ type: 'text', text: block.text }] : [];
        case 'tool_call':
          return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }];
        case 'tool_result': {
          if (!block.images?.length) return [{ type: 'tool_result', tool_use_id: block.callId, content: block.content, is_error: block.isError ?? false }];
          // Pictures go inside the result they came with.
          const parts = [
            { type: 'text' as const, text: block.content || '(no text)' },
            ...block.images.map((image) => {
              const data = imageBase64(image);
              return data ? { type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType as 'image/png', data } } : { type: 'text' as const, text: '[a picture that is no longer available]' };
            }),
          ];
          return [{ type: 'tool_result', tool_use_id: block.callId, content: parts, is_error: block.isError ?? false }];
        }
        case 'image': {
          const data = imageBase64(block);
          return data
            ? [{ type: 'image', source: { type: 'base64', media_type: block.mediaType as 'image/png', data } }]
            : [{ type: 'text', text: '[an attached image that is no longer available]' }];
        }
        case 'thinking':
          // Thinking is bound to the model that produced it; other models can't use it.
          return [];
      }
    });
    // A message that was only thinking has nothing to send; consecutive user turns are merged by the API.
    if (content.length > 0) out.push({ role: message.role, content });
  }
  return out;
}

export function fromAnthropicContent(content: BetaContentBlock[]): Block[] {
  return content.flatMap((block): Block[] => {
    switch (block.type) {
      case 'text':
        return [{ type: 'text', text: block.text }];
      case 'thinking':
        return block.thinking ? [{ type: 'thinking', text: block.thinking }] : [];
      case 'tool_use':
        return [{ type: 'tool_call', id: block.id, name: block.name, input: block.input as Record<string, unknown> }];
      default:
        return [];
    }
  });
}

function toStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause';
    default:
      return 'other';
  }
}
