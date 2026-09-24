import { describe, expect, it } from 'vitest';
import { cliLoginCommand, isCliAdapter, readStatus } from '../src/discover.js';

// The real output of each CLI, captured 2026-09-12. OpenClaw's Model Setup says "login status
// unverified" for these; each one will actually tell you, so polyphemus asks.
const CLAUDE = `{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "alex@example.com"
}`;
const CODEX = 'Logged in using ChatGPT';

describe('what is already on this computer', () => {
  it('reads Claude Code’s JSON, including who', () => {
    expect(readStatus(CLAUDE)).toEqual({ signedIn: true, account: 'alex@example.com' });
    expect(readStatus('{ "loggedIn": false }')).toEqual({ signedIn: false });
    // Grok, from `grok models`: it says which, and exits 0 either way.
    expect(readStatus('You are logged in with grok.com.\n\nDefault model: grok-4.7\n')).toEqual({ signedIn: true, account: 'grok.com' });
    expect(readStatus('You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n')).toEqual({ signedIn: false });
  });

  it('reads Codex’s prose', () => {
    expect(readStatus(CODEX)).toEqual({ signedIn: true, account: 'ChatGPT' });
    expect(readStatus('Not logged in. Run `codex login`.')).toEqual({ signedIn: false });
  });

  it('says nothing rather than guessing', () => {
    // Silence, or wording nobody anticipated, is "don't know" — not "signed out".
    expect(readStatus('')).toEqual({});
    expect(readStatus('some future wording')).toEqual({});
  });

  it('knows which adapters are CLIs, and how each signs in', () => {
    expect(isCliAdapter('claude-cli')).toBe(true);
    expect(isCliAdapter('anthropic')).toBe(false);
    expect(cliLoginCommand('codex-cli')).toBe('codex login');
    expect(cliLoginCommand('anthropic')).toBeUndefined();
  });
});
