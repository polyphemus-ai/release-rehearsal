import { describe, expect, it } from 'vitest';
import { parseConfig, type Message, type ProviderEvent } from '../src/index.js';
import { OpenAIChatProvider, toChatMessages } from '../src/providers/openai-chat.js';

/** A fake server that streams the chunks given, and records what it was sent. */
function chatServer(chunks: unknown[]) {
  const bodies: Array<Record<string, any>> = [];
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, any>);
    const sse = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { bodies, fetch: fetch as typeof globalThis.fetch };
}

const chunk = (delta: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'c1',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'llama3.1',
  choices: [{ index: 0, delta, finish_reason: null, ...extra }],
});

describe('any OpenAI-compatible server (bring your own models)', () => {
  it('streams text, reasoning, and tool calls, and reports what it used', async () => {
    const { bodies, fetch } = chatServer([
      chunk({ role: 'assistant', content: '' }),
      chunk({ reasoning_content: 'let me look' }), // how DeepSeek and Ollama stream thinking
      chunk({ content: 'Listing' }),
      chunk({ content: ' files.' }),
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command"' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: ': "ls"}' } }] }),
      { ...chunk({}, { finish_reason: 'tool_calls' }), usage: { prompt_tokens: 30, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 10 } } },
    ]);
    const provider = new OpenAIChatProvider('ollama', { apiKey: 'no-key-needed', baseUrl: 'http://127.0.0.1:11434/v1', fetch });

    const events: ProviderEvent[] = [];
    for await (const event of provider.stream({
      model: 'llama3.1',
      system: 'You are polyphemus.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'list files' }] }],
      tools: [{ name: 'bash', description: 'run a command', inputSchema: { type: 'object' } }],
    })) {
      events.push(event);
    }

    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e.type === 'text_delta' ? e.text : ''))).toEqual(['Listing', ' files.']);
    expect(events.find((e) => e.type === 'thinking_delta')).toMatchObject({ text: 'let me look' });
    expect(events.find((e) => e.type === 'tool_call_start')).toMatchObject({ id: 'call_1', name: 'bash' });

    const done = events.at(-1);
    expect(done).toMatchObject({
      type: 'message_done',
      stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 7, cacheReadTokens: 10 },
    });
    if (done?.type !== 'message_done') throw new Error('no message_done');
    expect(done.message.content).toEqual([
      { type: 'thinking', text: 'let me look' },
      { type: 'text', text: 'Listing files.' },
      { type: 'tool_call', id: 'call_1', name: 'bash', input: { command: 'ls' } },
    ]);
    expect(done.message.native).toBeUndefined(); // nothing to replay: it's rebuilt every time
    expect(bodies[0]).toMatchObject({ model: 'llama3.1', stream: true, stream_options: { include_usage: true } });
    expect(bodies[0]!.messages[0]).toEqual({ role: 'system', content: 'You are polyphemus.' });
  });

  it('rebuilds a conversation from any other model, results and all', () => {
    const history: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'list files' }] },
      {
        role: 'assistant',
        origin: { provider: 'anthropic', model: 'claude-opus-5' },
        content: [
          { type: 'thinking', text: 'bound to Claude' },
          { type: 'tool_call', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', callId: 'toolu_1', content: 'nope', isError: true }] },
    ];
    expect(toChatMessages('rules', history)).toEqual([
      { role: 'system', content: 'rules' },
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'Error: nope' },
    ]);
  });

  it('is configured like any other provider, and a local one needs no key', () => {
    const config = parseConfig(`
[providers.ollama]
adapter = "openai-chat"
base_url = "http://127.0.0.1:11434/v1"
auth = { type = "none" }

[models.llama]
provider = "ollama"
model = "llama3.1"
`);
    expect(config.providers.ollama).toMatchObject({ adapter: 'openai-chat', baseUrl: 'http://127.0.0.1:11434/v1', auth: { type: 'none' } });
    expect(config.models.llama).toMatchObject({ provider: 'ollama', model: 'llama3.1' });
    expect(() => parseConfig('[providers.x]\nadapter = "openai-chat"\nauth = { type = "oauth" }')).toThrow('"api_key", or "none"');
  });
});
