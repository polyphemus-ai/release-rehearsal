import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigHistory, DEFAULT_CONFIG, editConfig, getConfigValue, lineDiff, parseConfig, parseValue, SessionStore } from '../src/index.js';

describe('editing config.toml', () => {
  it('changes only the lines it touches, so comments survive', () => {
    let text = editConfig(DEFAULT_CONFIG, 'default_model', 'claude');
    expect(text).toMatch(/^default_model = "claude"$/m); // the commented-out example became the setting
    expect(text).toContain('# Polyphemus configuration.');
    text = editConfig(text, 'routing.on_fallback', 'continue');
    text = editConfig(text, 'routing.fallback', ['codex', 'claude-api']);
    text = editConfig(text, 'models.claude.fallback', ['codex']);
    const config = parseConfig(text);
    expect(config).toMatchObject({ defaultModel: 'claude', routing: { onFallback: 'continue', fallback: ['codex', 'claude-api'] } });
    expect(config.models.claude?.fallback).toEqual(['codex']);
    expect(text).toContain('# If the model you’re using hits a limit'.replace('’', "'"));

    text = editConfig(text, 'models.claude.fallback', undefined);
    expect(parseConfig(text).models.claude?.fallback).toBeUndefined();
    text = editConfig(text, 'models.gemma.provider', 'openai'); // a new section
    expect(getConfigValue(text, 'models.gemma')).toEqual({ provider: 'openai' });
  });

  it('replaces a value that runs over several lines', () => {
    const text = 'x = 1\n\n[routing]\nfallback = [\n  "codex",\n  "claude-api",\n]\non_fallback = "ask"\n';
    const after = editConfig(text, 'routing.fallback', ['grok']);
    expect(after).toBe('x = 1\n\n[routing]\nfallback = ["grok"]\non_fallback = "ask"\n');
  });

  it('says what to do when it can’t', () => {
    expect(() => editConfig(DEFAULT_CONFIG, 'providers.anthropic.auth.env', 'X')).toThrow('written inline');
    expect(() => editConfig(DEFAULT_CONFIG, 'routing.nope', undefined)).toThrow("There's no setting routing.nope");
    expect(() => getConfigValue(DEFAULT_CONFIG, 'routing.nope')).toThrow("There's no setting");
  });

  it('reads values typed on the command line', () => {
    expect(parseValue('true')).toBe(true);
    expect(parseValue('3')).toBe(3);
    expect(parseValue('["a", "b"]')).toEqual(['a', 'b']);
    expect(parseValue('claude')).toBe('claude');
  });

  it('shows changes as a line diff with a little context', () => {
    expect(lineDiff('a\nb\nc\nd\ne', 'a\nB\nc\nd\ne')).toEqual(['  a', '- b', '+ B', '  c', '  …']);
    expect(lineDiff('same', 'same')).toEqual([]);
  });
});

describe('config history', () => {
  it('validates, records, undoes, and notices edits made outside polyphemus', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-config-'));
    const file = join(home, 'config.toml');
    writeFileSync(file, DEFAULT_CONFIG);
    const store = new SessionStore(':memory:');
    const history = new ConfigHistory(home, store, 'test');
    expect(history.drift()).toBeUndefined(); // the first look records the file as it is

    const { after } = history.plan('routing.on_fallback', 'pause');
    history.apply(after, 'set routing.on_fallback');
    expect(parseConfig(readFileSync(file, 'utf8')).routing.onFallback).toBe('pause');

    // An invalid change is refused, and nothing is written.
    expect(() => history.plan('routing.on_fallback', 'sometimes')).toThrow('Nothing was changed');

    history.undo();
    expect(parseConfig(readFileSync(file, 'utf8')).routing.onFallback).toBe('ask');

    // A hand edit: noticed, changes wait, and adopting records it.
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n# a note added by hand\n`);
    expect(history.drift()).toBeDefined();
    expect(() => history.apply(history.plan('routing.on_fallback', 'continue').after, 'set')).toThrow('edited outside polyphemus');
    history.adopt();
    expect(history.drift()).toBeUndefined();

    expect(store.configRevisions(10).map((r) => r.action)).toEqual([
      'adopted an edit made outside polyphemus',
      'undid r2 (set routing.on_fallback)',
      'set routing.on_fallback',
      'recorded as it was',
    ]);
  });

  it('writes a table as its own section rather than beside one', () => {
    // The real bug: config.toml had [models.grok], and setting models.grok appended
    // "[models]\ngrok = { … }", which TOML rejects as redefining an already defined table.
    const text = '[models.claude]\nprovider = "claude-code"\nmodel = "default"\n\n[models.grok]\nprovider = "grok-build"\nmodel = "default"\n';
    const after = editConfig(text, 'models.grok', { provider: 'grok-build', model: 'grok-4.5' });
    expect(after).toContain('[models.grok]\nprovider = "grok-build"\nmodel = "grok-4.5"');
    expect(after).not.toContain('[models]');
    // Still a valid document, and the sibling is untouched.
    const providers = '[providers.claude-code]\nadapter = "claude-cli"\n[providers.grok-build]\nadapter = "grok-cli"\n';
    const parsed = parseConfig(providers + after);
    expect(parsed.models.grok).toMatchObject({ model: 'grok-4.5' });
    expect(parsed.models.claude).toMatchObject({ model: 'default' });

    // A new one gets its own section too, for the same reason.
    const added = editConfig(text, 'models.fast', { provider: 'claude-code', model: 'haiku' });
    expect(added).toContain('[models.fast]');
    expect(added).not.toContain('[models]\n');

    // And removing one takes the whole section.
    const removed = editConfig(text, 'models.grok', undefined);
    expect(removed).not.toContain('[models.grok]');
    expect(removed).toContain('[models.claude]');
  });

  it('keeps the chosen models as a list', () => {
    const after = editConfig('selected = []\n', 'selected', ['anthropic:claude-opus-5', 'xai:grok-4.6']);
    expect(after.trim()).toBe('selected = ["anthropic:claude-opus-5", "xai:grok-4.6"]');
  });
});
