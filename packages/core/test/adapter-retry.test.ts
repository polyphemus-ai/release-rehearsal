import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAIResponsesProvider } from '../src/providers/openai-responses.js';
import type { Message, ModelProvider, ProviderEvent } from '../src/types.js';

/** Fetch stub: the first request gets a 400, later ones get the given SSE stream. Records request bodies. */
function rejectThenStream(errorBody: unknown, events: Array<{ event: string; data: unknown }>) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) {
      return new Response(JSON.stringify(errorBody), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const sse = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { bodies, fetch: fetch as typeof globalThis.fetch };
}

async function drain(provider: ModelProvider, model: string, messages: Message[]): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream({ model, system: 'sys', messages, tools: [] })) events.push(event);
  return events;
}

const userTurn: Message = { role: 'user', content: [{ type: 'text', text: 'hello' }] };
const followUp: Message = { role: 'user', content: [{ type: 'text', text: 'and again' }] };

describe('rejected native replay', () => {
  it('openai-responses retries without replayed reasoning', async () => {
    const assistant: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      origin: { provider: 'xai', model: 'grok-4.6' },
      native: [
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'stale' },
        { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi', annotations: [] }] },
      ],
    };
    const response = {
      id: 'resp_2',
      object: 'response',
      status: 'completed',
      error: null,
      incomplete_details: null,
      output: [{ type: 'message', id: 'msg_2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'again', annotations: [] }] }],
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    };
    const { bodies, fetch } = rejectThenStream(
      { error: { message: 'Could not decrypt encrypted_content', type: 'invalid_request_error' } },
      [
        { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'again', item_id: 'msg_2', output_index: 0, content_index: 0, sequence_number: 1, logprobs: [] } },
        { event: 'response.completed', data: { type: 'response.completed', sequence_number: 2, response } },
      ],
    );

    const provider = new OpenAIResponsesProvider('xai', { apiKey: 'test', fetch });
    const events = await drain(provider, 'grok-4.6', [userTurn, assistant, followUp]);

    const inputTypes = (body: Record<string, unknown>) => (body.input as Array<{ type?: string }>).map((i) => i.type ?? 'message');
    expect(bodies).toHaveLength(2);
    expect(inputTypes(bodies[0]!)).toContain('reasoning');
    expect(inputTypes(bodies[1]!)).not.toContain('reasoning');
    expect(events.at(-1)).toMatchObject({ type: 'message_done', stopReason: 'end_turn', message: { content: [{ type: 'text', text: 'again' }] } });
  });

  it('anthropic retries without replayed thinking', async () => {
    const assistant: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      origin: { provider: 'anthropic', model: 'claude-opus-5' },
      native: [
        { type: 'thinking', thinking: 'hmm', signature: 'bad-signature' },
        { type: 'text', text: 'hi' },
      ],
    };
    const { bodies, fetch } = rejectThenStream(
      { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid signature in thinking block' } },
      [
        {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } },
          },
        },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'again' } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ],
    );

    const provider = new AnthropicProvider('anthropic', { apiKey: 'test', fetch });
    const events = await drain(provider, 'claude-opus-5', [userTurn, assistant, followUp]);

    const assistantContent = (body: Record<string, unknown>) =>
      (body.messages as Array<{ role: string; content: Array<{ type: string }> }>)[1]!.content.map((b) => b.type);
    expect(bodies).toHaveLength(2);
    expect(assistantContent(bodies[0]!)).toEqual(['thinking', 'text']);
    expect(assistantContent(bodies[1]!)).toEqual(['text']);
    expect(events.at(-1)).toMatchObject({ type: 'message_done', stopReason: 'end_turn', message: { content: [{ type: 'text', text: 'again' }] } });
  });

  it('does not retry when nothing native was replayed', async () => {
    const { bodies, fetch } = rejectThenStream({ error: { message: 'bad request', type: 'invalid_request_error' } }, []);
    const provider = new OpenAIResponsesProvider('openai', { apiKey: 'test', fetch });
    await expect(drain(provider, 'gpt-6-astra', [userTurn])).rejects.toThrow('bad request');
    expect(bodies).toHaveLength(1);
  });
});
