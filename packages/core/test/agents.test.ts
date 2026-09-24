import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromClaudeStream } from '../src/agents/claude-stream.js';
import { fromCodexStream, readCodexRateLimits, readLatestCodexRateLimits } from '../src/agents/codex-cli.js';
import type { AgentProvider, AgentRunRequest, AgentSessionState, Json } from '../src/agents/common.js';
import { runAgentTurn } from '../src/agents/loop.js';
import { renderTranscript } from '../src/agents/transcript.js';
import { classifyError } from '../src/errors.js';
import type { PolyphemusEvent } from '../src/events.js';
import { fitHistoryToTools } from '../src/history.js';
import { emptyUsage, type Message } from '../src/types.js';

async function* stream(items: Json[]): AsyncGenerator<Json> {
  for (const item of items) yield item;
}

async function fixture(name: string): Promise<Json[]> {
  const text = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Json);
}

async function collect(run: AsyncGenerator<PolyphemusEvent, boolean>): Promise<{ events: PolyphemusEvent[]; completed: boolean }> {
  const events: PolyphemusEvent[] = [];
  for (let next = await run.next(); ; next = await run.next()) {
    if (next.done) return { events, completed: next.value };
    events.push(next.value);
  }
}

const ofType = <T extends PolyphemusEvent['type']>(events: PolyphemusEvent[], type: T) =>
  events.filter((event): event is Extract<PolyphemusEvent, { type: T }> => event.type === type);

describe('Claude Code’s own API-error banner', () => {
  it('is an error that falls back, not a reply from the agent', async () => {
    // The shape Claude Code writes when the API fails after its retries (seen 2026-09-21, 529).
    const lines: Json[] = [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5', apiKeySource: 'none' },
      { type: 'assistant', isApiErrorMessage: true, apiErrorStatus: 529, message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary.' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'API Error: 529 Overloaded.' },
    ];
    const events: PolyphemusEvent[] = [];
    let thrown: unknown;
    try {
      for await (const e of fromClaudeStream(stream(lines), { providerId: 'claude-code', model: 'opus' })) events.push(e as PolyphemusEvent);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ errorClass: 'overloaded' });
    expect(ofType(events, 'message')).toEqual([]);
    expect(ofType(events, 'text_delta')).toEqual([]);
  });
});

describe('Claude Code stream (recorded from a real run)', () => {
  it('turns a tool-using run into events, messages, usage, and capacity', async () => {
    const { events, completed } = await collect(
      fromClaudeStream(stream(await fixture('claude-stream.jsonl')), { providerId: 'claude-code', model: 'haiku' }),
    );
    expect(completed).toBe(true);
    expect(ofType(events, 'agent_session')).toEqual([
      { type: 'agent_session', provider: 'claude-code', id: '77ab348e-da1b-41d5-855c-627633cd508c' },
    ]);
    expect(ofType(events, 'tool_start')[0]).toMatchObject({ call: { name: 'Bash' }, summary: 'echo polyphemus-fixture' });
    expect(ofType(events, 'tool_end')[0]?.result).toEqual({ content: 'polyphemus-fixture', isError: false });
    expect(ofType(events, 'text_delta').map((e) => e.text).join('')).toBe('done');

    const messages = ofType(events, 'message').map((e) => e.message);
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(messages[0]?.origin).toEqual({ provider: 'claude-code', model: 'claude-haiku-4-5-20251001' });
    expect(messages[1]?.content[0]).toMatchObject({ type: 'tool_result', content: 'polyphemus-fixture' });

    expect(ofType(events, 'capacity')[0]?.readings.map((r) => [r.window, r.usedPct])).toEqual([
      ['5h', 22],
      ['7d', 19],
    ]);
    const done = ofType(events, 'turn_done')[0];
    expect(done).toMatchObject({
      stopReason: 'end_turn',
      usage: { inputTokens: 18, outputTokens: 168, cacheReadTokens: 34369, cacheWriteTokens: 7339 },
    });
    expect(done?.costUsd).toBeCloseTo(0.0199, 3);
    expect(done?.billing).toBe('plan'); // apiKeySource "none": a subscription login, so the cost is only an estimate
  });

  it('classifies Grok’s exhausted balance (recorded) as quota_exhausted', async () => {
    const run = collect(fromClaudeStream(stream(await fixture('grok-quota-error.jsonl')), { providerId: 'grok-build', model: 'default' }));
    await expect(run).rejects.toMatchObject({
      name: 'ProviderError',
      errorClass: 'quota_exhausted',
      provider: 'grok-build',
      message: 'API error (status 402 Payment Required): Grok Build usage balance exhausted',
    });
  });
});

describe('Codex stream', () => {
  it('maps items to tool calls and replies, and reads limits at the end', async () => {
    const lines: Json[] = [
      { type: 'thread.started', thread_id: 'th_1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', aggregated_output: 'a.txt\n', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'a.txt', kind: 'update' }], status: 'completed' } },
      { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'Updated a.txt.' } },
      { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } },
    ];
    const { events, completed } = await collect(
      fromCodexStream(stream(lines), {
        providerId: 'codex',
        model: 'default',
        readLimits: async (id) => (id === 'th_1' ? [{ window: '7d', usedPct: 97 }] : []),
      }),
    );
    expect(completed).toBe(true);
    expect(ofType(events, 'agent_session')[0]).toMatchObject({ id: 'th_1' });
    expect(ofType(events, 'tool_start').map((e) => [e.call.name, e.summary])).toEqual([
      ['shell', 'ls'],
      ['apply_patch', 'update a.txt'],
    ]);
    expect(ofType(events, 'tool_end')[0]?.result).toEqual({ content: 'a.txt\n[exit code 0]', isError: false });
    expect(ofType(events, 'message').map((e) => e.message.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(ofType(events, 'capacity')[0]?.readings).toEqual([{ window: '7d', usedPct: 97 }]);
    expect(ofType(events, 'turn_done')[0]?.usage).toEqual({ inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 });
  });

  it('throws a classified error when the turn fails', async () => {
    const lines: Json[] = [{ type: 'thread.started', thread_id: 'th_2' }, { type: 'turn.failed', error: { message: "You've hit your usage limit." } }];
    await expect(collect(fromCodexStream(stream(lines), { providerId: 'codex', model: 'default' }))).rejects.toMatchObject({
      errorClass: 'quota_exhausted',
    });
  });

  it('reads the latest rate limits from the session log', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codex-home-'));
    const dir = join(home, 'sessions', '2026', '09', '10');
    await mkdir(dir, { recursive: true });
    const entries = [
      { type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: 1789099800 } } } },
      { type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 97, window_minutes: 10080, resets_at: 1789430400 } } } },
    ];
    await writeFile(join(dir, 'rollout-2026-09-10T17-46-23-th_9.jsonl'), `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);

    expect(await readCodexRateLimits('th_9', home)).toEqual([{ window: '7d', usedPct: 97, resetsAt: new Date(1789430400 * 1000) }]);
    expect(await readCodexRateLimits('missing', home)).toEqual([]);

    // At startup, before any Codex turn: the latest log of any session.
    const latest = await readLatestCodexRateLimits(home);
    expect(latest.readings).toEqual([{ window: '7d', usedPct: 97, resetsAt: new Date(1789430400 * 1000) }]);
    expect(latest.observedAt).toBeInstanceOf(Date);
  });
});

describe('switching between agent CLIs and APIs', () => {
  const history: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'list files' }] },
    { role: 'assistant', origin: { provider: 'claude-code', model: 'opus' }, content: [{ type: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', callId: 't1', content: 'a.txt' }] },
    { role: 'assistant', origin: { provider: 'claude-code', model: 'opus' }, content: [{ type: 'text', text: 'There is a.txt.' }] },
  ];

  it('renders history as a transcript for a CLI joining late', () => {
    expect(renderTranscript(history)).toBe(
      'User: list files\n\nAssistant (claude-code:opus): [called Bash {"command":"ls"}]\n\nTool results: [result: a.txt]\n\nAssistant (claude-code:opus): There is a.txt.',
    );
  });

  it('rewrites tool calls an API model does not have as text', () => {
    const fitted = fitHistoryToTools(history, new Set(['bash', 'read_file']));
    expect(fitted[1]?.content).toEqual([{ type: 'text', text: '[called Bash {"command":"ls"}]' }]);
    expect(fitted[2]?.content).toEqual([{ type: 'text', text: '[Bash result: a.txt]' }]);
    expect(fitted[0]).toBe(history[0]);
  });

  it('sends an agent CLI only what it missed', async () => {
    const prompts: string[] = [];
    const provider: AgentProvider = {
      kind: 'agent',
      id: 'codex',
      async *run(req: AgentRunRequest) {
        prompts.push(req.prompt);
        yield { type: 'turn_done', stopReason: 'end_turn', usage: emptyUsage() };
      },
      listModels: async () => [],
    };
    const turn = async (state?: AgentSessionState) => {
      for await (const _event of runAgentTurn({ provider, model: 'default', history, input: 'next', cwd: '/tmp', autoApprove: false, state }));
    };

    await turn(); // first time: the whole conversation
    await turn({ nativeId: 'th', seen: 2 }); // resumed: the two messages since
    await turn({ nativeId: 'th', seen: 4 }); // up to date: just the prompt

    expect(prompts[0]).toContain('You are joining a conversation');
    expect(prompts[0]).toContain('User: list files');
    expect(prompts[1]).toContain('While you were away');
    expect(prompts[1]).not.toContain('list files');
    expect(prompts[1]).toContain('There is a.txt.');
    expect(prompts[2]).toBe('next');

    // A retry after another model failed: no new message, just the context and a nudge.
    const events: string[] = [];
    for await (const event of runAgentTurn({ provider, model: 'default', history, cwd: '/tmp', autoApprove: false })) events.push(event.type);
    expect(events).not.toContain('message');
    expect(prompts[3]).toContain('There is a.txt.');
    expect(prompts[3]).toContain('respond to the latest user message');
  });

  it('treats a rejected rate limit as a used-up window', async () => {
    const lines: Json[] = [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5', apiKeySource: 'none' },
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1789099800 } },
      { type: 'result', subtype: 'success', is_error: false, result: '', usage: {}, total_cost_usd: 0 },
    ];
    const { events } = await collect(fromClaudeStream(stream(lines), { providerId: 'claude-code', model: 'default' }));
    expect(ofType(events, 'capacity')[0]?.readings).toEqual([{ window: '5h', usedPct: 100, resetsAt: new Date(1789099800 * 1000) }]);
  });
});

describe('classifyError', () => {
  it.each([
    ['API error (status 402 Payment Required): Grok Build usage balance exhausted', 'quota_exhausted'],
    ["You've hit your usage limit.", 'quota_exhausted'],
    ['429 Too Many Requests: rate limit exceeded', 'rate_limited'],
    ['401 invalid api key', 'auth'],
    ['Overloaded', 'overloaded'],
    ['prompt is too long: 250000 tokens > 200000 maximum', 'context_exceeded'],
    ['400 bad request', 'invalid_request'],
    ['something odd', 'unknown'],
  ])('%s → %s', (message, expected) => {
    expect(classifyError(message)).toBe(expected);
  });
});
