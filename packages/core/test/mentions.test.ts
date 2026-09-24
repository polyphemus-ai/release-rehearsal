import { describe, expect, it } from 'vitest';
import { addressedTo, type Agent } from '../src/index.js';

const agent = (name: string, title: string): Agent =>
  ({ name, title, description: 'x', persona: '', instructions: '', mark: { shape: 'circle', color: 'blue' }, scope: 'library', dir: '', file: '' }) as Agent;
const members = [agent('bd', 'BD'), agent('reviewer', 'Reviewer'), agent('rowan', 'Rowan')];

describe('who a message is addressed to', () => {
  it('takes @name and @Title, in order, without repeats', () => {
    expect(addressedTo('@bd can you look, then @Reviewer check it', members).map((a) => a.name)).toEqual(['bd', 'reviewer']);
    expect(addressedTo('@BD @bd @bd', members).map((a) => a.name)).toEqual(['bd']);
  });

  it('is empty when nobody was named', () => {
    // Polyphemus never guesses who a message is for: the wrong agent answering in front of the
    // others is worse than asking.
    expect(addressedTo('can someone look at this', members)).toEqual([]);
    expect(addressedTo('email me at alex@example.com', members)).toEqual([]);
  });

  it('doesn’t count a name quoted as something to type (2026-09-16: an agent’s “send `@Helm`” handed Helm the turn)', () => {
    expect(addressedTo('First send `@bd`, then pick the model.', members)).toEqual([]);
    expect(addressedTo('Type this:\n```\n@bd /model\n```', members)).toEqual([]);
    expect(addressedTo('> @bd said it was fine\nI agree', members)).toEqual([]);
    expect(addressedTo('Send “@bd take it” and it goes to them.', members)).toEqual([]);
    // Said outright, it still counts, even beside a quoted one.
    expect(addressedTo('@Reviewer tell them to send `@bd`', members).map((a) => a.name)).toEqual(['reviewer']);
  });

  it('ignores names that aren’t in the thread', () => {
    expect(addressedTo('@nobody @bd', members).map((a) => a.name)).toEqual(['bd']);
  });
});
