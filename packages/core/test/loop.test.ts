import { describe, expect, it } from 'vitest';
import { runTurn, type PolyphemusEvent, type TurnOptions } from '../src/loop.js';
import type { Tool } from '../src/tools/tool.js';
import { emptyUsage, type Block, type ChatRequest, type Message, type ModelProvider, type ProviderEvent, type StopReason } from '../src/types.js';

interface Step {
  content: Block[];
  stopReason: StopReason;
}

/** Replays scripted assistant messages and records every request it receives. */
class ScriptedProvider implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'fake';
  requests: ChatRequest[] = [];

  constructor(private steps: Step[]) {}

  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    this.requests.push({ ...req, messages: [...req.messages] });
    const step = this.steps.shift();
    if (!step) throw new Error('script exhausted');
    for (const block of step.content) if (block.type === 'text') yield { type: 'text_delta', text: block.text };
    yield {
      type: 'message_done',
      message: { role: 'assistant', content: step.content, origin: { provider: this.id, model: req.model } },
      stopReason: step.stopReason,
      usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 5 },
    };
  }

  async listModels() {
    return [{ id: 'fake-model' }];
  }
}

function echoTool(overrides: Partial<Tool> = {}): Tool & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    spec: { name: 'echo', description: 'echo', inputSchema: { type: 'object' } },
    mutates: false,
    describe: (input) => String(input.text),
    run: async (input) => {
      calls.push(input);
      return { content: `echo: ${String(input.text)}` };
    },
    ...overrides,
    calls,
  };
}

async function collect(opts: TurnOptions): Promise<PolyphemusEvent[]> {
  const events: PolyphemusEvent[] = [];
  for await (const event of runTurn(opts)) events.push(event);
  return events;
}

const baseOptions = (provider: ModelProvider, tools: Tool[], extra: Partial<TurnOptions> = {}): TurnOptions => ({
  provider,
  model: 'fake-model',
  system: 'sys',
  history: [],
  tools,
  input: 'hello',
  cwd: '/tmp',
  ...extra,
});

const messagesOf = (events: PolyphemusEvent[]): Message[] =>
  events.flatMap((e) => (e.type === 'message' ? [e.message] : []));

describe('runTurn', () => {
  it('runs tool calls and feeds results back until the model is done', async () => {
    const provider = new ScriptedProvider([
      { content: [{ type: 'tool_call', id: 'c1', name: 'echo', input: { text: 'hi' } }], stopReason: 'tool_use' },
      { content: [{ type: 'text', text: 'All done.' }], stopReason: 'end_turn' },
    ]);
    const tool = echoTool();
    const events = await collect(baseOptions(provider, [tool]));

    expect(tool.calls).toEqual([{ text: 'hi' }]);
    expect(messagesOf(events).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messagesOf(events)[2]?.content).toEqual([{ type: 'tool_result', callId: 'c1', content: 'echo: hi', isError: undefined }]);

    // The second request carries the tool result.
    expect(provider.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({ type: 'tool_result', callId: 'c1' });

    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'turn_done', stopReason: 'end_turn' });
    expect(done?.type === 'turn_done' && done.usage.inputTokens).toBe(20);
  });

  it('keeps pictures a tool returns with its result, or says they couldn’t be passed on', async () => {
    const picture = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const looker = echoTool({ run: async () => ({ content: 'Here’s the page.', images: [{ bytes: picture }] }) });
    const script = () => [
      { content: [{ type: 'tool_call', id: 'c1', name: 'echo', input: {} }], stopReason: 'tool_use' as StopReason },
      { content: [{ type: 'text', text: 'Looks fine.' }], stopReason: 'end_turn' as StopReason },
    ] as Step[];
    const kept: Uint8Array[] = [];
    const seeing = messagesOf(await collect(baseOptions(new ScriptedProvider(script()), [looker], { keepImage: (bytes) => (kept.push(bytes), { type: 'image', mediaType: 'image/png', path: '/uploads/abc.png' }) })));
    expect(kept).toEqual([picture]);
    expect(seeing[2]!.content).toEqual([{ type: 'tool_result', callId: 'c1', content: 'Here’s the page.', isError: undefined, images: [{ type: 'image', mediaType: 'image/png', path: '/uploads/abc.png' }] }]);
    const blind = messagesOf(await collect(baseOptions(new ScriptedProvider(script()), [looker])));
    expect(blind[2]!.content).toEqual([{ type: 'tool_result', callId: 'c1', content: 'Here’s the page.\n[A picture couldn’t be passed on.]', isError: undefined }]);
  });

  it('masks secrets in tool output before the model sees them', async () => {
    const provider = new ScriptedProvider([
      { content: [{ type: 'tool_call', id: 'c1', name: 'echo', input: { text: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' } }], stopReason: 'tool_use' },
      { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' },
    ]);
    const events = await collect(baseOptions(provider, [echoTool()]));
    expect(messagesOf(events)[2]?.content[0]).toMatchObject({ type: 'tool_result', content: 'echo: «redacted secret»' });
    expect(provider.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({ content: 'echo: «redacted secret»' });
  });

  it('continues from history without a new user message (a retry on another model)', async () => {
    const provider = new ScriptedProvider([{ content: [{ type: 'text', text: 'picked up' }], stopReason: 'end_turn' }]);
    const history: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
    const events = await collect(baseOptions(provider, [], { history, input: undefined }));
    expect(messagesOf(events).map((m) => m.role)).toEqual(['assistant']);
    expect(provider.requests[0]?.messages).toEqual(history);
  });

  it('does not modify the caller history', async () => {
    const provider = new ScriptedProvider([{ content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' }]);
    const history: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'earlier' }] }];
    await collect(baseOptions(provider, [], { history }));
    expect(history).toHaveLength(1);
    expect(provider.requests[0]?.messages).toHaveLength(2);
  });

  it('returns a declined result when approval is refused', async () => {
    const provider = new ScriptedProvider([
      { content: [{ type: 'tool_call', id: 'c1', name: 'echo', input: { text: 'rm' } }], stopReason: 'tool_use' },
      { content: [{ type: 'text', text: 'Okay, skipped.' }], stopReason: 'end_turn' },
    ]);
    const tool = echoTool({ mutates: true });
    const events = await collect(baseOptions(provider, [tool], { approve: async () => false }));

    expect(tool.calls).toEqual([]);
    const result = messagesOf(events)[2]?.content[0];
    expect(result).toMatchObject({ type: 'tool_result', isError: true, content: 'The user declined this tool call.' });
  });

  it('runs read-only calls of a mutating tool without asking', async () => {
    const provider = new ScriptedProvider([
      {
        content: [
          { type: 'tool_call', id: 'c1', name: 'echo', input: { text: 'look' } },
          { type: 'tool_call', id: 'c2', name: 'echo', input: { text: 'change' } },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' },
    ]);
    const asked: unknown[] = [];
    const tool = echoTool({ mutates: true, isReadOnly: (input) => input.text === 'look' });
    await collect(
      baseOptions(provider, [tool], {
        approve: async (call) => {
          asked.push(call.input);
          return true;
        },
      }),
    );
    expect(tool.calls).toEqual([{ text: 'look' }, { text: 'change' }]);
    expect(asked).toEqual([{ text: 'change' }]);
  });

  it('reports unknown tools and thrown errors as error results', async () => {
    const provider = new ScriptedProvider([
      {
        content: [
          { type: 'tool_call', id: 'c1', name: 'nope', input: {} },
          { type: 'tool_call', id: 'c2', name: 'echo', input: {} },
        ],
        stopReason: 'tool_use',
      },
      { content: [{ type: 'text', text: 'hm' }], stopReason: 'end_turn' },
    ]);
    const broken = echoTool({
      run: async () => {
        throw new Error('boom');
      },
    });
    const events = await collect(baseOptions(provider, [broken]));
    expect(messagesOf(events)[2]?.content).toEqual([
      { type: 'tool_result', callId: 'c1', content: 'Unknown tool "nope"', isError: true },
      { type: 'tool_result', callId: 'c2', content: 'Error: boom', isError: true },
    ]);
  });

  it('closes every tool call with a result when interrupted', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([
      {
        content: [
          { type: 'tool_call', id: 'c1', name: 'echo', input: { text: 'first' } },
          { type: 'tool_call', id: 'c2', name: 'echo', input: { text: 'second' } },
        ],
        stopReason: 'tool_use',
      },
    ]);
    const tool = echoTool({
      run: async () => {
        controller.abort();
        return { content: 'partial' };
      },
    });
    const events = await collect(baseOptions(provider, [tool], { signal: controller.signal }));

    const results = messagesOf(events)[2]?.content;
    expect(results).toHaveLength(2);
    expect(results?.[1]).toMatchObject({ callId: 'c2', isError: true });
    expect(events.at(-1)).toMatchObject({ type: 'turn_done', stopReason: 'aborted' });
    expect(provider.requests).toHaveLength(1);
  });
});
