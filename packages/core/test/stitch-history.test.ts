import { describe, expect, it } from 'vitest';
import { stitchHistory } from '../src/history.js';
import type { Message } from '../src/types.js';

// More than one agent works in a thread at once, so their turns interleave in it — which is what a
// person wants to read. A model needs each tool call answered by its own result, one after the
// other (docs/design/parallel-agents.md; found by review, 2026-09-20).

const shape = (messages: readonly Message[]) => messages.map((m) => `${m.role}:${m.content.map((b) => (b.type === 'tool_call' ? `call ${b.id}` : b.type === 'tool_result' ? `result ${b.callId}` : b.type)).join(',')}`);

describe('putting an interleaved thread back in order for a model', () => {
  it('keeps a call and its answer together when someone else spoke in between', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'bash', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: '@other quick question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'other answers' }] },
      { role: 'user', content: [{ type: 'tool_result', callId: 'c1', content: 'done' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'finished' }] },
    ] as Message[];
    expect(shape(stitchHistory(messages))).toEqual([
      'user:text',
      'assistant:call c1',
      'user:result c1',
      'user:text',
      'assistant:text',
      'assistant:text',
    ]);
  });

  it('answers a call nobody answered, so a stopped turn doesn’t break the next one', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c9', name: 'bash', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: 'never mind' }] },
    ] as Message[];
    const out = stitchHistory(messages);
    expect(shape(out)).toEqual(['assistant:call c9', 'user:result c9', 'user:text']);
    expect(JSON.stringify(out)).toContain('stopped before this finished');
  });

  it('leaves an ordinary conversation exactly as it was', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'c1', name: 'bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', callId: 'c1', content: 'ok' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ] as Message[];
    expect(stitchHistory(messages)).toEqual(messages);
  });
});
