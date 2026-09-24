import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/index.js';

describe('a project whose files moved', () => {
  it('follows them, and takes its past sessions with it', () => {
    const store = new SessionStore(':memory:');
    store.addProject({ slug: 'polyphemus', name: 'polyphemus', path: '/old/place/polyphemus', description: '' });
    store.addProject({ slug: 'other', name: 'Other', path: '/old/place/polyphemus-notes', description: '' });
    const inside = store.create({ title: 'in the project', provider: 'openai', model: 'gpt-5', cwd: '/old/place/polyphemus' });
    const nested = store.create({ title: 'in a subfolder', provider: 'openai', model: 'gpt-5', cwd: '/old/place/polyphemus/packages/cli' });
    // A sibling whose path merely starts with the same letters must not be dragged along.
    const sibling = store.create({ title: 'next door', provider: 'openai', model: 'gpt-5', cwd: '/old/place/polyphemus-notes' });

    expect(store.moveProject('polyphemus', '/home/alex/code/polyphemus')).toEqual({ from: '/old/place/polyphemus', sessions: 2 });
    expect(store.project('polyphemus')?.path).toBe('/home/alex/code/polyphemus');
    expect(store.get(inside.id)?.cwd).toBe('/home/alex/code/polyphemus');
    expect(store.get(nested.id)?.cwd).toBe('/home/alex/code/polyphemus/packages/cli');
    expect(store.get(sibling.id)?.cwd).toBe('/old/place/polyphemus-notes');
    expect(store.project('other')?.path).toBe('/old/place/polyphemus-notes');

    // Sessions in the new folder belong to the project again.
    expect(store.projectFor('/home/alex/code/polyphemus/packages')?.slug).toBe('polyphemus');
    expect(store.projectFor('/old/place/polyphemus')).toBeUndefined();

    expect(store.moveProject('polyphemus', '/home/alex/code/polyphemus')).toEqual({ from: '/home/alex/code/polyphemus', sessions: 0 });
    expect(store.moveProject('nope', '/somewhere')).toBeUndefined();
    store.close();
  });
});
