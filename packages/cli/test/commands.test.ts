import { describe, expect, it } from 'vitest';
import { PolyphemusError, type Message, type SessionMeta } from '@polyphemus/core';
import { COMMANDS, findCommand, usageText } from '../src/commands.js';
import { errorEnvelope, exitCodeFor, wantsJson } from '../src/output.js';
import { transcriptView } from '../src/transcript.js';

describe('the command registry', () => {
  it('declares every command once, with a summary and examples, and the usage text comes from it', () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const usage = usageText();
    for (const command of COMMANDS) {
      expect(command.usage.startsWith('poly')).toBe(true); // 'poly' is what you type; 'polyphemus' also works
      expect(command.summary.length).toBeGreaterThan(0);
      expect(command.examples.length).toBeGreaterThan(0);
      expect(usage).toContain(command.usage);
    }
    expect(findCommand('sessions show')?.id).toBe('sessions.show');
    expect(findCommand('sessions.show')?.id).toBe('sessions.show');
    expect(findCommand('nope')).toBeUndefined();
  });
});

describe('output for agents', () => {
  it('uses JSON when asked, or when nobody is at a terminal, unless told otherwise', () => {
    expect(wantsJson(true, {}, true)).toBe(true);
    expect(wantsJson(undefined, {}, true)).toBe(false);
    expect(wantsJson(undefined, {}, false)).toBe(true);
    expect(wantsJson(undefined, { POLYPHEMUS_OUTPUT: 'json' }, true)).toBe(true);
    expect(wantsJson(undefined, { POLYPHEMUS_OUTPUT: 'text' }, false)).toBe(false);
  });

  it('turns errors into a stable envelope and exit code', () => {
    const err = new PolyphemusError('No session matches "x".', 'NOT_FOUND', 'poly sessions');
    expect(errorEnvelope(err)).toEqual({ ok: false, schemaVersion: 1, error: { code: 'NOT_FOUND', message: 'No session matches "x".', fix: 'poly sessions' } });
    expect(exitCodeFor(err)).toBe(3);
    expect(exitCodeFor(new PolyphemusError('bad flag', 'USAGE'))).toBe(2);
    expect(exitCodeFor(new Error('boom'))).toBe(1);
    expect(errorEnvelope(new Error('boom')).error.code).toBe('FAILED');
  });
});

describe('sessions show', () => {
  const meta: SessionMeta = { id: 'abc12345', title: 'Fix the test', provider: 'claude-code', model: 'default', cwd: '/p/side-quest', agent: '', createdAt: 0, updatedAt: Date.now() };
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: '<polyphemus_status>This session: claude…</polyphemus_status>\n\nfix the failing test' }] },
    {
      role: 'assistant',
      origin: { provider: 'claude-code', model: 'default' },
      content: [{ type: 'tool_call', id: 'c1', name: 'Bash', input: { command: 'pnpm test' } }],
      native: { secret: 'provider payload' },
    } as Message,
    { role: 'user', content: [{ type: 'tool_result', callId: 'c1', content: '1 failed', isError: true }] },
    { role: 'assistant', origin: { provider: 'claude-code', model: 'default' }, content: [{ type: 'text', text: 'Fixed it.' }] },
  ];

  it('hides the status line polyphemus adds', () => {
    const status: Message[] = [{ role: 'user', content: [{ type: 'text', text: '<polyphemus_status>This session: claude…</polyphemus_status>\n\nhello' }] }];
    expect(transcriptView(meta, status, undefined).text).not.toContain('polyphemus_status');
  });

  it('reads like the conversation: who said what, tool calls, results, no status lines', () => {
    const { text } = transcriptView(meta, messages, undefined);
    expect(text).toContain('── you\nfix the failing test');
    expect(text).toContain('── claude-code');
    expect(text).toContain('● Bash  pnpm test');
    expect(text).toContain('↳ error: 1 failed');
    expect(text).toContain('Fixed it.');
    expect(text).not.toContain('polyphemus_status');
    expect(text.match(/── claude-code/g)).toHaveLength(1); // one heading per turn, not per message
  });

  it('gives agents the messages without provider payloads, and can show just the end', () => {
    const { json } = transcriptView(meta, messages, undefined, 2);
    expect(json.session).toMatchObject({ id: 'abc12345', messageCount: 4, project: null });
    expect(json.messages).toHaveLength(2);
    expect(JSON.stringify(json)).not.toContain('provider payload');
    expect(json.messages[1]).toEqual({ role: 'assistant', from: 'claude-code:default', content: [{ type: 'text', text: 'Fixed it.' }] });
  });
});
