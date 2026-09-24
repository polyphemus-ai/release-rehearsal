import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromAnthropicContent, toAnthropicMessages } from '../src/providers/anthropic.js';
import { fromResponseOutput, toResponsesInput } from '../src/providers/openai-responses.js';
import { toChatMessages } from '../src/providers/openai-chat.js';
import type { Message } from '../src/types.js';

const history: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'list files' }] },
  {
    role: 'assistant',
    origin: { provider: 'anthropic', model: 'claude-opus-5' },
    content: [
      { type: 'thinking', text: 'I should run ls' },
      { type: 'tool_call', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
    ],
    native: [
      { type: 'thinking', thinking: 'I should run ls', signature: 'sig' },
      { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', callId: 'toolu_1', content: 'a.txt', isError: false }] },
];

describe('anthropic adapter', () => {
  it('replays native content to the same provider and model', () => {
    const out = toAnthropicMessages(history, 'anthropic', 'claude-opus-5');
    expect(out[1]?.content).toBe(history[1]?.native);
  });

  it('rebuilds from canonical content and drops thinking for another model', () => {
    const out = toAnthropicMessages(history, 'anthropic', 'claude-sonnet-5');
    expect(out[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'ls' } }],
    });
    expect(out[2]?.content).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt', is_error: false }]);
  });

  it('skips assistant messages that were only thinking', () => {
    const onlyThinking: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'thinking', text: 'hmm' }], origin: { provider: 'xai', model: 'grok-4.6' } },
    ];
    expect(toAnthropicMessages(onlyThinking, 'anthropic', 'claude-opus-5')).toHaveLength(1);
  });

  it('converts response content to canonical blocks', () => {
    const blocks = fromAnthropicContent([
      { type: 'thinking', thinking: 'plan', signature: 's' },
      { type: 'text', text: 'Hello', citations: null },
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'pwd' }, caller: { type: 'direct' } },
    ] as never);
    expect(blocks).toEqual([
      { type: 'thinking', text: 'plan' },
      { type: 'text', text: 'Hello' },
      { type: 'tool_call', id: 't1', name: 'bash', input: { command: 'pwd' } },
    ]);
  });
});

describe('openai-responses adapter', () => {
  it('rebuilds a Claude conversation as Responses input items', () => {
    const items = toResponsesInput(history, 'openai', 'gpt-6-astra');
    expect(items).toEqual([
      { role: 'user', content: 'list files' },
      { type: 'function_call', call_id: 'toolu_1', name: 'bash', arguments: '{"command":"ls"}' },
      { type: 'function_call_output', call_id: 'toolu_1', output: 'a.txt' },
    ]);
  });

  it('replays native output items for the same provider and model', () => {
    const native = [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' },
      { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi', annotations: [] }] },
    ];
    const items = toResponsesInput(
      [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hi' }], origin: { provider: 'xai', model: 'grok-4.6' }, native },
      ],
      'xai',
      'grok-4.6',
    );
    expect(items.slice(1)).toEqual(native);
  });

  it('marks failed tool results in the output text', () => {
    const items = toResponsesInput(
      [{ role: 'user', content: [{ type: 'tool_result', callId: 'c1', content: 'nope', isError: true }] }],
      'openai',
      'gpt-6-astra',
    );
    expect(items).toEqual([{ type: 'function_call_output', call_id: 'c1', output: 'Error: nope' }]);
  });

  it('converts output items to canonical blocks', () => {
    const blocks = fromResponseOutput([
      { type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: 'thinking about it' }] },
      { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Sure.', annotations: [] }] },
      { type: 'function_call', call_id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' },
      { type: 'function_call', call_id: 'call_2', name: 'bash', arguments: '{not json' },
    ] as never);
    expect(blocks).toEqual([
      { type: 'thinking', text: 'thinking about it' },
      { type: 'text', text: 'Sure.' },
      { type: 'tool_call', id: 'call_1', name: 'bash', input: { command: 'ls' } },
      { type: 'tool_call', id: 'call_2', name: 'bash', input: {} },
    ]);
  });
});

describe('pictures in tool results', () => {
  const picture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'polyphemus-adapter-'));
    const path = join(dir, 'page.png');
    writeFileSync(path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    return path;
  };
  const withPicture = (path: string): Message[] => [{ role: 'user', content: [{ type: 'tool_result', callId: 'c1', content: 'Here’s the page.', images: [{ type: 'image', mediaType: 'image/png', path }] }] }];
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('go inside the result for Anthropic and OpenAI Responses', () => {
    const path = picture();
    expect(toAnthropicMessages(withPicture(path), 'anthropic', 'claude-opus-5')).toEqual([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: false, content: [{ type: 'text', text: 'Here’s the page.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] },
    ]);
    expect(toResponsesInput(withPicture(path), 'openai', 'gpt-6-astra')).toEqual([
      { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Here’s the page.' }, { type: 'input_image', image_url: `data:image/png;base64,${data}`, detail: 'auto' }] },
    ]);
  });

  it('follow the tool message for OpenAI-compatible servers, whose tool messages are text only', () => {
    const path = picture();
    expect(toChatMessages('', withPicture(path))).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'Here’s the page.' },
      { role: 'user', content: [{ type: 'text', text: 'The pictures from that call:' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }] },
    ]);
  });

  it('say so when the picture has gone', () => {
    expect(toAnthropicMessages(withPicture('/nowhere/page.png'), 'anthropic', 'claude-opus-5')[0]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', is_error: false, content: [{ type: 'text', text: 'Here’s the page.' }, { type: 'text', text: '[a picture that is no longer available]' }] },
    ]);
  });
});
