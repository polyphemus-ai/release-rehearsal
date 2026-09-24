import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  emptyUsage,
  Polyphemus,
  resolveModel,
  type Block,
  type ChatRequest,
  type ModelProvider,
  type ProviderEvent,
  type RuntimeEvent,
  type StopReason,
} from '@polyphemus/core';
import { startDaemon, type Daemon } from '@polyphemus/daemon';
import { DaemonClient, RemoteSession } from '../src/daemon-client.js';

/** Plays back one assistant message per request. */
class ScriptedProvider implements ModelProvider {
  readonly kind = 'model' as const;
  constructor(
    readonly id: string,
    private steps: Array<{ content: Block[]; stopReason: StopReason }>,
  ) {}
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    const step = this.steps.shift() ?? { content: [{ type: 'text', text: '(script ran out)' }], stopReason: 'end_turn' as StopReason };
    yield { type: 'message_done', message: { role: 'assistant', content: step.content, origin: { provider: this.id, model: req.model } }, stopReason: step.stopReason, usage: emptyUsage() };
  }
  async listModels() {
    return [];
  }
}

const toolThenText: Array<{ content: Block[]; stopReason: StopReason }> = [
  { content: [{ type: 'tool_call', id: 'c1', name: 'bash', input: { command: 'touch made-by-the-terminal' } }], stopReason: 'tool_use' },
  { content: [{ type: 'text', text: 'all done' }], stopReason: 'end_turn' },
];

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let port: number;
const savedEnv = { ...process.env };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-remote-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';
  // How a session runs on this computer, the level a fresh install wouldn't default to.
  await writeFile(join(home, 'config.toml'), `${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  polyphemus = await Polyphemus.open(home);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  port = Number(new URL(daemon.urls[0]!).port);
});
afterEach(async () => {
  await daemon.close();
  polyphemus.close();
  process.env = { ...savedEnv };
});

describe('the terminal as a daemon client', () => {
  it('runs a terminal session in the daemon: events stream back, and approvals are asked in the terminal', async () => {
    polyphemus.registry.use('openai', new ScriptedProvider('openai', [...toolThenText]));
    const client = (await DaemonClient.connect(home, port))!;
    expect(client).toBeDefined();
    const session = new RemoteSession(client, home, { model: resolveModel(polyphemus.config, 'gpt-api') });
    const asked: string[] = [];
    session.asker = {
      approve: async (q) => {
        asked.push(q.summary);
        return 'deny';
      },
      chooseFallback: async () => undefined,
    };
    const events: RuntimeEvent[] = [];
    session.on((event) => events.push(event));

    expect(await session.send('make a file')).toBe('end_turn');
    expect(asked).toEqual(['touch made-by-the-terminal']);
    expect(session.meta).toMatchObject({ title: 'make a file', cwd: home });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['session', 'message', 'turn_done']));
    // It ran in the daemon, so it's stored like any other session (and the phone sees it).
    expect(polyphemus.store.messages(session.meta!.id)).toHaveLength(4);
    expect((await session.statusRows()).at(-1)?.[0]).toBe('Runs in');
    session.close();
    client.close();
  });

  it('stops asking in the terminal when another device answers first', async () => {
    polyphemus.registry.use('openai', new ScriptedProvider('openai', [...toolThenText]));
    const client = (await DaemonClient.connect(home, port))!;
    const session = new RemoteSession(client, home, { model: resolveModel(polyphemus.config, 'gpt-api') });
    // A terminal prompt that waits until something cancels it.
    session.asker = {
      approve: (_q, signal) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')))),
      chooseFallback: async () => undefined,
    };
    const infos: string[] = [];
    session.on((event) => event.type === 'info' && infos.push(event.text));

    const turn = session.send('make a file');
    let question: { id: string } | undefined;
    for (let i = 0; i < 100 && !question; i++) {
      question = (await client.request<{ questions: Array<{ id: string }> }>('GET', '/api/state')).questions[0];
      if (!question) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await client.request('POST', `/api/questions/${question!.id}`, { answer: 'allow' }); // "the phone" answers
    expect(await turn).toBe('end_turn');
    expect(infos).toContain('Answered on another device.');
    session.close();
    client.close();
  });

  it('falls back to running here when no daemon is up', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'polyphemus-nodaemon-'));
    expect(await DaemonClient.connect(empty, port)).toBeUndefined();
  });
});
