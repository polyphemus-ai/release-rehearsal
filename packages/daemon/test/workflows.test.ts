import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, emptyUsage, Polyphemus, registerWorkflow, defineWorkflow, type Block, type ChatRequest, type Message, type ModelProvider, type ProviderEvent, type StopReason } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';
import { containerRuntime, itInContainers } from '../../core/test/containers.js';

// The workflow engine (docs/design/workflows.md; roadmap "it does the work", 1–2): orchestration is
// code. Nodes are done when the engine sees it — a submitted artifact that fits, a command's exit
// code, a person's answer — and a run carries on from its last finished node after a restart.

type Reply = { content: Block[]; stopReason: StopReason };
const say = (text: string): Reply => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' });
const call = (name: string, input: Record<string, unknown>): Reply => ({ content: [{ type: 'tool_call', id: `c${Math.random().toString(36).slice(2)}`, name, input }], stopReason: 'tool_use' });

/** Answers each fresh session from its first prompt; `plan(prompt)` gives that session's replies. */
class Sessions implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'openai';
  prompts: string[] = [];
  hang?: (prompt: string) => Promise<void> | undefined;
  constructor(public plan: (prompt: string) => Reply[]) {}
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    const first = req.messages.find((m: Message) => m.role === 'user')!;
    const prompt = first.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const answered = req.messages.filter((m: Message) => m.role === 'assistant').length;
    if (answered === 0) this.prompts.push(prompt);
    const waiting = this.hang?.(prompt);
    if (waiting && answered === 1) await Promise.race([waiting, new Promise((resolve) => req.signal?.addEventListener('abort', resolve, { once: true }))]);
    const reply = this.plan(prompt)[answered] ?? say('ok');
    yield { type: 'message_done', message: { role: 'assistant', content: reply.content, origin: { provider: 'openai', model: req.model } }, stopReason: reply.stopReason, usage: emptyUsage() };
  }
  async listModels() {
    return [];
  }
}

/** The container runtime, found directly: the suite turns polyphemus's own detection off. */
const runtime = containerRuntime;

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let base: string;
const savedEnv = { ...process.env };

async function start(provider: ModelProvider) {
  polyphemus = await Polyphemus.open(home);
  polyphemus.registry.use('openai', provider);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-workflows-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\ndefault_model = "gpt-api"\n${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
});
afterEach(async () => {
  await daemon?.close().catch(() => {});
  polyphemus?.close();
  process.env = { ...savedEnv };
});

async function device() {
  const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
  return async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
  };
}
async function until<T>(check: () => Promise<T | undefined | false>, what: string, tries = 400): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const runOf = async (me: Awaited<ReturnType<typeof device>>, id: string) => (await me(`/api/sessions/${id}`)).data.work.runs[0];
const ended = (me: Awaited<ReturnType<typeof device>>, id: string) => until(async () => {
  const run = await runOf(me, id);
  return run && ['done', 'failed', 'waiting', 'interrupted'].includes(run.status) ? run : undefined;
}, 'the run to stop');

describe('the loop workflow', () => {
  itInContainers('runs where agents are isolated: its agents and its checks in workers, not on this computer', async () => {
    const provider = new Sessions((prompt) => {
      const round = Number(/This is round (\d+)/.exec(prompt)?.[1]);
      return [call('write_file', { path: 'count.txt', content: String(round) }), call('submit', { changed: `wrote ${round}` }), say('Submitted.')];
    });
    await start(provider);
    const me = await device();
    const project = (await me('/api/projects', { name: 'Counter' })).data.project;
    polyphemus.runtime = () => runtime;
    polyphemus.store.setProjectIsolation(project.slug, 'isolated');
    try {
      // /etc/polyphemus-worker only exists in a worker: on this computer the check could never pass.
      const started = await me('/api/workflows/loop/start', { project: project.slug, input: { goal: 'Count to two', until: 'grep -q polyphemus-worker /etc/polyphemus-worker && test "$(cat count.txt)" -ge 2', max: 4 }, yolo: true });
      const run = await until(async () => {
        const r = await runOf(me, started.data.id);
        return r && ['done', 'failed'].includes(r.status) ? r : undefined;
      }, 'the run to stop', 6000);
      expect(run.steps.map((s: { title: string; status: string }) => `${s.title}: ${s.status}`)).toEqual(['Round 1 · Work on it: done', 'Round 1 · Check: failed', 'Round 2 · Work on it: done', 'Round 2 · Check: done']);
      expect(run.status).toBe('done');
    } finally {
      await polyphemus.workers.close();
    }
  }, 600_000);

  it('works round by round in fresh sessions until the command passes', async () => {
    // Each round writes the next number; the check passes at 2.
    const provider = new Sessions((prompt) => {
      const round = Number(/This is round (\d+)/.exec(prompt)?.[1]);
      return [call('write_file', { path: 'count.txt', content: String(round) }), call('submit', { changed: `wrote ${round}` }), say('Submitted.')];
    });
    await start(provider);
    const me = await device();
    const project = (await me('/api/projects', { name: 'Counter' })).data.project;
    const started = await me('/api/workflows/loop/start', { project: project.slug, input: { goal: 'Count to two', until: 'test "$(cat count.txt)" -ge 2', max: 4 }, yolo: true });
    expect(started.status).toBe(201);
    const run = await ended(me, started.data.id);

    expect(run).toMatchObject({ status: 'done', workflow: 'loop', generation: 1 });
    expect(run.steps.map((s: { title: string; status: string }) => `${s.title}: ${s.status}`)).toEqual(['Round 1 · Work on it: done', 'Round 1 · Check: failed', 'Round 2 · Work on it: done', 'Round 2 · Check: done']);
    expect(readFileSync(join(project.path, 'count.txt'), 'utf8')).toBe('2');
    // The check's exit code is the evidence, not what the agent said.
    expect(run.steps[1].evidence).toEqual([expect.objectContaining({ kind: 'check', label: 'test "$(cat count.txt)" -ge 2', ok: false, detail: expect.stringContaining('exit 1') })]);
    // A fresh session per round, told how the last one went; its thread belongs to the run, not to Home.
    expect(new Set(run.steps.filter((s: { kind: string }) => s.kind === 'work').map((s: { sessionId: string }) => s.sessionId)).size).toBe(2);
    expect(provider.prompts[1]).toContain('Last round it failed (exit 1)');
    const home_ = (await me('/api/state')).data.sessions.map((s: { id: string }) => s.id);
    expect(home_).toEqual([started.data.id]);
    expect((await me(`/api/sessions/${run.steps[0].sessionId}`)).data.meta).toMatchObject({ spunFrom: started.data.id, startedBy: `run:${run.id}` });
  });

  it('doesn’t call a silent check stuck while the work is changing', async () => {
    // The check prints nothing, so every failure reads the same — but each round changes the file.
    await start(new Sessions((prompt) => {
      const round = Number(/This is round (\d+)/.exec(prompt)?.[1]);
      return [call('write_file', { path: 'count.txt', content: String(round) }), call('submit', { changed: `wrote ${round}` }), say('Submitted.')];
    }));
    const me = await device();
    const project = (await me('/api/projects', { name: 'Silent' })).data.project;
    const { data } = await me('/api/workflows/loop/start', { project: project.slug, input: { goal: 'Count to four', until: 'test "$(cat count.txt)" -ge 4', max: 6 }, yolo: true });
    const run = await ended(me, data.id);
    expect(run.status).toBe('done');
    expect(run.steps.filter((s: { kind: string }) => s.kind === 'gate')).toEqual([]);
    expect(run.steps.at(-1)).toMatchObject({ title: 'Round 4 · Check', status: 'done' });
  });

  it('fails a node that never submits, after its attempts, instead of calling it done', async () => {
    await start(new Sessions(() => [say('All done, the tests pass now!')]));
    const me = await device();
    const project = (await me('/api/projects', { name: 'Claims' })).data.project;
    const { data } = await me('/api/workflows/loop/start', { project: project.slug, input: { goal: 'Fix it', until: 'true' } });
    const run = await ended(me, data.id);
    expect(run).toMatchObject({ status: 'failed', reason: expect.stringContaining('didn’t finish after 3 attempts: It ended without submitting') });
    expect(run.steps.map((s: { status: string }) => s.status)).toEqual(['failed', 'failed', 'failed']);
    expect((await me('/api/workflows/loop/start', { project: project.slug, input: { goal: 'no command' } })).status).toBe(400);
  });

  it('stops to ask when a round fails the same way as the last, and a second no ends it', async () => {
    await start(new Sessions(() => [call('submit', { changed: 'tried again' }), say('Submitted.')]));
    const me = await device();
    const project = (await me('/api/projects', { name: 'Stuck' })).data.project;
    const { data } = await me('/api/workflows/loop/start', { project: project.slug, input: { goal: 'Make it pass', until: 'echo "3 tests failed in 12ms"; exit 1', max: 5 } });
    let run = await ended(me, data.id);
    expect(run.status).toBe('waiting');
    expect(run.steps.at(-1)).toMatchObject({ title: 'Round 2 · Stuck', kind: 'gate', status: 'waiting', asks: expect.stringContaining('failed the same way two rounds running') });

    const gate = (await me('/api/state')).data.questions.find((q: { kind: string }) => q.kind === 'gate');
    await me(`/api/questions/${gate.id}`, { answer: 'approve' });
    run = await until(async () => {
      const r = await runOf(me, data.id);
      return r.steps.some((s: { title: string }) => s.title === 'Round 3 · Stuck') && r.status === 'waiting' ? r : undefined;
    }, 'round 3 to get stuck too');
    const again = (await me('/api/state')).data.questions.find((q: { kind: string }) => q.kind === 'gate');
    await me(`/api/questions/${again.id}`, { answer: 'decline', note: 'Needs a real fix' });
    run = await until(async () => {
      const r = await runOf(me, data.id);
      return r.status === 'failed' ? r : undefined;
    }, 'the run to end');
    expect(run.reason).toContain('Needs a real fix');
  });

  it('carries on from the last finished node after a restart, as a new generation', async () => {
    let hanging = true;
    const provider = new Sessions((prompt) => {
      const round = Number(/This is round (\d+)/.exec(prompt)?.[1]);
      return [call('write_file', { path: 'count.txt', content: String(round) }), call('submit', { changed: `wrote ${round}` }), say('Submitted.')];
    });
    provider.hang = (prompt) => (hanging && /This is round 2/.test(prompt) ? new Promise<void>(() => {}) : undefined);
    await start(provider);
    const me = await device();
    const project = (await me('/api/projects', { name: 'Restart' })).data.project;
    const { data } = await me('/api/workflows/loop/start', { project: project.slug, input: { goal: 'Count to two', until: 'test "$(cat count.txt)" -ge 2' }, yolo: true });
    await until(async () => (await runOf(me, data.id)).steps.some((s: { title: string; status: string }) => s.title === 'Round 2 · Work on it' && s.status === 'running'), 'round 2 to be under way');

    await daemon.close();
    polyphemus.close();
    hanging = false;
    const fresh = new Sessions(provider.plan);
    await start(fresh);
    const again = await device();
    const run = await until(async () => {
      // YOLO isn't kept across a restart, so the resumed round asks before writing: allow it, as you would.
      for (const q of (await again('/api/state')).data.questions.filter((x: { kind: string }) => x.kind === 'approval')) await again(`/api/questions/${q.id}`, { answer: 'allow' });
      const r = await runOf(again, data.id);
      return r.status === 'done' ? r : undefined;
    }, 'the resumed run to finish');
    expect(run.generation).toBe(2);
    expect(run.steps.map((s: { title: string; status: string }) => `${s.title}: ${s.status}`)).toEqual([
      'Round 1 · Work on it: done',
      'Round 1 · Check: failed',
      'Round 2 · Work on it: interrupted',
      'Round 2 · Work on it: done',
      'Round 2 · Check: done',
    ]);
  }, 20_000);
});

describe('actions', () => {
  it('act once per key, and not at all with a permit from an older generation', async () => {
    let calls = 0;
    registerWorkflow(
      defineWorkflow({
        id: 'test-actions',
        name: 'Actions',
        about: 'test',
        input: { type: 'object', properties: {} },
        outcome: () => 'Actions',
        nodes: [
          { kind: 'action', id: 'label', title: 'Add a label', key: () => 'label', run: async () => ({ calls: ++calls }) },
          { kind: 'action', id: 'label-again', title: 'Add the same label', key: () => 'label', run: async () => ({ calls: ++calls }) },
          {
            kind: 'action',
            id: 'taken-over',
            title: 'Merge',
            key: () => 'merge',
            // Ownership changes while it's acting, as a restart or a takeover would.
            run: async (_ctx, permit) => {
              polyphemus.store.runs.bumpGeneration(permit.runId);
              calls += 1;
              return { merged: true };
            },
          },
        ],
      }),
    );
    await start(new Sessions(() => []));
    const me = await device();
    const project = (await me('/api/projects', { name: 'Acts' })).data.project;
    const { data } = await me('/api/workflows/test-actions/start', { project: project.slug, input: {} });
    const run = await until(async () => {
      const r = await runOf(me, data.id);
      return r.steps.length === 3 && r.steps[2].status !== 'running' ? r : undefined;
    }, 'the actions');
    expect(run.steps.map((s: { status: string; reason?: string }) => [s.status, s.reason ?? null])).toEqual([
      ['done', null],
      ['done', 'Already done earlier in this run.'],
      ['unknown', expect.stringContaining('changed hands')],
    ]);
    expect(calls).toBe(2);
    expect(polyphemus.store.runs.action(`${run.id}:merge`)).toBeUndefined();
  });
});
