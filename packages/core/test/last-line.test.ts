import { describe, expect, it } from 'vitest';
import { INTRODUCE_YOURSELF, SessionStore } from '../src/index.js';

describe('the last line a thread shows on Home', () => {
  it('skips the nudge that asks a new agent to introduce itself', () => {
    const store = new SessionStore(':memory:');
    const thread = store.create({ title: 'with Otter', provider: 'openai', model: 'gpt-5', cwd: '/tmp' });
    store.append(thread.id, { role: 'user', content: [{ type: 'text', text: 'Earlier, from a person.' }] }, 'person:alex');
    store.append(thread.id, { role: 'user', content: [{ type: 'text', text: INTRODUCE_YOURSELF }] });
    // Polyphemus wrote the nudge, not a person: until the agent answers, the line is what came before.
    expect(store.lastLine(thread.id)?.text).toBe('Earlier, from a person.');
    store.append(thread.id, { role: 'assistant', content: [{ type: 'text', text: 'Hi, I’m Otter.' }] }, 'agent:otter');
    expect(store.lastLine(thread.id)?.text).toBe('Hi, I’m Otter.');
  });
});
