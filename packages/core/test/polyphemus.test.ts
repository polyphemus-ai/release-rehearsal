import { DEFAULT_CONFIG } from '../src/config.js';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveModel } from '../src/config.js';
import { Polyphemus, type RuntimeEvent } from '../src/polyphemus.js';
import { createProject, memoryDir } from '../src/projects.js';
import { agentModel } from '../src/roster.js';
import { setUpDefaultAgent } from '../src/default-agent.js';
import type { AgentProvider, AgentRunRequest } from '../src/agents/common.js';
import { emptyUsage, ProviderError, type ChatRequest, type ModelProvider, type ProviderEvent, type StopReason } from '../src/types.js';

/** A model provider that answers from a script, or fails with a quota error. */
class FakeProvider implements ModelProvider {
  readonly kind = 'model' as const;
  requests: ChatRequest[] = [];

  constructor(
    readonly id: string,
    private reply: string | ProviderError,
  ) {}

  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    this.requests.push({ ...req, messages: [...req.messages] });
    if (this.reply instanceof ProviderError) throw this.reply;
    yield { type: 'text_delta', text: this.reply };
    yield {
      type: 'message_done',
      message: { role: 'assistant', content: [{ type: 'text', text: this.reply }], origin: { provider: this.id, model: req.model } },
      stopReason: 'end_turn' as StopReason,
      usage: emptyUsage(),
    };
  }

  async listModels() {
    return [];
  }
}

let home: string;
const savedEnv = { ...process.env };
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-runtime-'));
  // Tests of how things run on this computer: the level a fresh install wouldn't default to.
  await writeFile(join(home, 'config.toml'), `${DEFAULT_CONFIG.replace('accepted = []', '')}\n[isolation]\nlevel = "host"\n`);
  process.env.CODEX_HOME = join(home, 'no-codex'); // don't read the real Codex logs
  process.env.OPENAI_API_KEY = 'test-key'; // makes gpt-api "ready" (the provider itself is faked)
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('SessionRuntime', () => {
  it('tells the default agent how polyphemus works under the hood, and no other agent', async () => {
    const polyphemus = await Polyphemus.open(home);
    const provider = new FakeProvider('openai', 'ok');
    polyphemus.registry.use('openai', provider);
    const helm = setUpDefaultAgent(polyphemus, { title: 'Helm', personality: 'plain', by: 'test' });
    await polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'gpt-api'), agent: helm }).send('hi');
    const system = provider.requests[0]!.system;
    expect(system).toContain('<polyphemus_itself>');
    expect(system).toMatch(/POLYPHEMUS_CALLER="Helm" node \S+packages\/cli\/bin\/polyphemus\.mjs/);
    expect(system).toContain('Never edit config.toml by hand');
    // polyphemus's own source is the default agent's to read, never to change (2026-09-20, after it edited it).
    expect(system).toContain('polyphemus’s own source code is not yours to change');
    const other = { ...helm, id: 'coach', name: 'coach', title: 'Coach' };
    await polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'gpt-api'), agent: other }).send('hi');
    expect(provider.requests[1]!.system).not.toContain('<polyphemus_itself>');
  });

  it('runs nothing on a model that isn’t on your list, however it was set', async () => {
    await writeFile(join(home, 'config.toml'), `${DEFAULT_CONFIG.replace('accepted = []', '').replace('selected = []', 'selected = ["openai:gpt-5"]')}\n[isolation]\nlevel = "host"\n`);
    const polyphemus = await Polyphemus.open(home);
    const provider = new FakeProvider('openai', 'hello there');
    polyphemus.registry.use('openai', provider);
    // An agent's file set to a pricier model than any you chose — by hand, or by another agent.
    const agent = { id: 'coach', name: 'coach', title: 'Coach', description: '', scope: 'library' as const, file: join(home, 'agent.toml'), dir: home, model: 'openai:gpt-9-pricey', mark: { shape: 'circle' as const, color: 'pink' as const }, persona: '', instructions: '' };
    const session = polyphemus.newSession({ cwd: home, model: agentModel(polyphemus.config, agent, resolveModel(polyphemus.config, 'openai:gpt-5')), agent });
    await expect(session.send('hi')).rejects.toThrow('Coach is set to run on openai:gpt-9-pricey, which isn’t on your models list');
    expect(provider.requests).toHaveLength(0);
    // The same thread, on one that is, runs.
    const plain = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'openai:gpt-5') });
    expect(await plain.send('hi')).toBe('end_turn');
  });

  it('runs a turn, creates and stores the session, and adds the status line', async () => {
    const polyphemus = await Polyphemus.open(home);
    const provider = new FakeProvider('openai', 'hello there');
    polyphemus.registry.use('openai', provider);
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'gpt-api') });
    const events: RuntimeEvent[] = [];
    session.on((event) => events.push(event));

    expect(await session.send('hi')).toBe('end_turn');

    expect(events.some((e) => e.type === 'session')).toBe(true);
    const stored = polyphemus.store.messages(session.meta!.id);
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(stored[0]?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('<polyphemus_status>') });
    expect(provider.requests[0]?.system).toContain('You are running inside Polyphemus');
    // Each finished turn is kept, so the app can show how long it took and what it used.
    const [turn] = polyphemus.store.turns(session.meta!.id);
    expect(turn).toMatchObject({ endSeq: 2, provider: 'openai', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } });
    expect(turn!.endedAt).toBeGreaterThanOrEqual(turn!.startedAt);
  });

  it('starts a session in a project with its rules, handoff, and notes, even from a subfolder', async () => {
    const polyphemus = await Polyphemus.open(home);
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Side Quest' });
    await writeFile(join(project.path, 'AGENTS.md'), '# Side Quest\n\nAlways run npm test.\n');
    await writeFile(join(memoryDir(home, 'side-quest'), 'handoff.md'), 'Level 2 is half done.\n');
    await mkdir(join(project.path, 'src'));
    const provider = new FakeProvider('openai', 'ok');
    polyphemus.registry.use('openai', provider);

    const session = polyphemus.newSession({ cwd: join(project.path, 'src'), model: resolveModel(polyphemus.config, 'gpt-api') });
    expect(session.project?.slug).toBe('side-quest');
    await session.send('hi');
    const system = provider.requests[0]?.system ?? '';
    expect(system).toContain('Always run npm test.');
    expect(system).toContain('Level 2 is half done.');
    expect(system).toContain('<project name="Side Quest"');
  });

  it('hands Claude Code the project’s AGENTS.md itself, since the repo has no CLAUDE.md', async () => {
    const polyphemus = await Polyphemus.open(home);
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Side Quest' });
    await writeFile(join(project.path, 'AGENTS.md'), '# Side Quest\n\nAlways run npm test.\n');
    const requests: AgentRunRequest[] = [];
    const agent: AgentProvider = {
      kind: 'agent',
      id: 'claude-code',
      async *run(req) {
        requests.push(req);
        yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
        yield { type: 'turn_done', stopReason: 'end_turn', usage: emptyUsage() };
      },
      listModels: async () => [],
    };
    polyphemus.registry.use('claude-code', agent);

    const session = polyphemus.newSession({ cwd: project.path, model: resolveModel(polyphemus.config, 'claude') });
    await session.send('hi');
    expect(requests[0]?.systemAppend).toContain('Always run npm test.');
    expect(requests[0]?.systemAppend).toContain('<project name="Side Quest"');
    expect(requests[0]?.extraDirs).toEqual([memoryDir(home, 'side-quest')]);
  });

  it('hands Codex the project’s rules in a worktree that doesn’t have them, and not where it reads them itself', async () => {
    const polyphemus = await Polyphemus.open(home);
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Site' });
    await writeFile(join(project.path, 'AGENTS.md'), '# Site\n\nKeep it static.\n');
    const tree = join(project.path, '.polyphemus-runs', 'polyphemus-issue-1');
    await mkdir(tree, { recursive: true });
    const requests: AgentRunRequest[] = [];
    const agent: AgentProvider = {
      kind: 'agent',
      id: 'codex',
      async *run(req) {
        requests.push(req);
        yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } };
        yield { type: 'turn_done', stopReason: 'end_turn', usage: emptyUsage() };
      },
      listModels: async () => [],
    };
    polyphemus.registry.use('codex', agent);
    await polyphemus.newSession({ cwd: tree, model: resolveModel(polyphemus.config, 'codex') }).send('review it');
    await polyphemus.newSession({ cwd: project.path, model: resolveModel(polyphemus.config, 'codex') }).send('hi');
    expect(requests[0]?.systemAppend).toContain('Keep it static.');
    expect(requests[1]?.systemAppend ?? '').not.toContain('Keep it static.');
  });

  it('tells the model, and you, when its plan won’t last until the reset', async () => {
    const polyphemus = await Polyphemus.open(home);
    polyphemus.registry.use('openai', new FakeProvider('openai', 'ok'));
    // A day into a weekly window with 28% used: it runs out in about 2.6 days, well before the reset.
    polyphemus.recordUsage('openai', [{ window: '7d', usedPct: 28, resetsAt: new Date(Date.now() + 6 * 86_400_000) }]);
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'gpt-api') });
    const notices: string[] = [];
    session.on((event) => event.type === 'notice' && notices.push(event.text));

    expect(session.statusBlock()).toContain('at this pace it runs out');
    await session.send('hi');
    await session.send('again');
    expect(notices.filter((n) => n.includes("openai's 7d window: at this pace it runs out"))).toHaveLength(1); // once, not every turn
    expect(polyphemus.forecasts('openai')[0]).toMatchObject({ status: 'short', window: '7d' });
  });

  it('stops sending turns to a provider that keeps failing, and says when it will try again', async () => {
    const polyphemus = await Polyphemus.open(home);
    const failing = new FakeProvider('openai', new ProviderError('upstream overloaded', 'overloaded', 'openai'));
    polyphemus.registry.use('openai', failing);
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'gpt-api') });
    const notices: string[] = [];
    session.on((event) => event.type === 'notice' && notices.push(event.text));

    for (let i = 0; i < 3; i++) await session.send(`try ${i}`);
    expect(failing.requests).toHaveLength(3);
    expect(notices.some((n) => n.startsWith('openai is paused: 3 failures in a minute'))).toBe(true);

    await session.send('once more');
    expect(failing.requests).toHaveLength(3); // not sent: the breaker is open
    expect(polyphemus.unavailable('openai')).toContain('3 failures in a minute');

    session.switchModel(resolveModel(polyphemus.config, 'gpt-api')); // choosing it yourself tries it again
    expect(polyphemus.unavailable('openai')).toBeUndefined();
  });

  it('falls back when a provider is out, retrying without repeating the message', async () => {
    const polyphemus = await Polyphemus.open(home);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    polyphemus.registry.use('anthropic', new FakeProvider('anthropic', new ProviderError('usage limit reached', 'quota_exhausted', 'anthropic')));
    const backup = new FakeProvider('openai', 'picked up');
    polyphemus.registry.use('openai', backup);

    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'claude-api') });
    const offered: string[][] = [];
    session.asker = {
      approve: async () => 'deny',
      chooseFallback: async ({ candidates }) => {
        offered.push(candidates.map((c) => c.label));
        return candidates.find((c) => c.label === 'gpt-api');
      },
    };

    expect(await session.send('build the thing')).toBe('end_turn');
    expect(offered[0]).toContain('gpt-api');
    expect(session.model.label).toBe('gpt-api');
    // The retry carried the original message; it wasn't sent twice.
    const userTurns = session.history.filter((m) => m.role === 'user');
    expect(userTurns).toHaveLength(1);
    expect(backup.requests[0]?.messages.at(-1)?.role).toBe('user');
    // The quota was recorded, so the next turn won't even try anthropic.
    expect(polyphemus.outReading('anthropic')).toMatchObject({ window: 'quota' });
    // A fallback doesn't change the default.
    expect(polyphemus.config.defaultModel).toBeUndefined();
  });

  it('tries a provider again an hour after a quota error that gave no reset time', async () => {
    const polyphemus = await Polyphemus.open(home);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    polyphemus.registry.use('anthropic', new FakeProvider('anthropic', new ProviderError('API error (status 402): usage balance exhausted', 'quota_exhausted', 'anthropic')));
    polyphemus.registry.use('openai', new FakeProvider('openai', 'picked up'));
    const toGpt = { approve: async () => 'deny' as const, chooseFallback: async ({ candidates }: { candidates: Array<{ label: string }> }) => candidates.find((c) => c.label === 'gpt-api') };
    const first = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'claude-api') });
    first.asker = toGpt as never;
    expect(await first.send('hi')).toBe('end_turn');

    // Out for now, saying when it happened and when it's tried again, wherever that's read.
    expect(polyphemus.outReading('anthropic')?.resetsAt).toBeUndefined();
    expect(polyphemus.unavailable('anthropic')).toMatch(/^said it was out of quota at \S+.*; polyphemus tries it again after \S+/);
    const second = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'claude-api') });
    second.asker = toGpt as never;
    const notices: string[] = [];
    second.on((event) => event.type === 'notice' && notices.push(event.text));
    await second.send('again');
    expect(notices[0]).toMatch(/^anthropic said it was out of quota at \d{1,2}:\d\d.*; polyphemus tries it again after \d{1,2}:\d\d/);
    expect(second.statusBlock()).toMatch(/anthropic \(not in use\): said it was out of quota at .+; polyphemus tries it again after/);

    // An hour later (the reading moved back, not the clock), the next real turn goes to it again.
    polyphemus.store.clearCapacity('anthropic', 'quota');
    polyphemus.recordUsage('anthropic', [{ window: 'quota', usedPct: 100 }], Date.now() - 61 * 60_000);
    expect(polyphemus.unavailable('anthropic')).toBeUndefined();
    const recovered = new FakeProvider('anthropic', 'back again');
    polyphemus.registry.use('anthropic', recovered);
    const third = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'claude-api') });
    expect(await third.send('try it')).toBe('end_turn');
    expect(recovered.requests).toHaveLength(1);
    expect(third.model.label).toBe('claude-api');
  });

  it('clears a quota error when a turn on that provider works', async () => {
    const polyphemus = await Polyphemus.open(home);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    // The error lands while a turn is already running on it (another thread, or a Test press).
    class OutMidTurn extends FakeProvider {
      override async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
        polyphemus.recordUsage('anthropic', [{ window: 'quota', usedPct: 100 }]);
        yield* super.stream(req);
      }
    }
    polyphemus.registry.use('anthropic', new OutMidTurn('anthropic', 'fine after all'));
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'claude-api') });
    expect(await session.send('hi')).toBe('end_turn');
    expect(polyphemus.outReading('anthropic')).toBeUndefined();
    expect(polyphemus.store.capacity().has('anthropic')).toBe(false);
  });

  it('uses the reset time a quota error gives, and what it holds in memory ends with it', async () => {
    const polyphemus = await Polyphemus.open(home);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    polyphemus.registry.use('anthropic', new FakeProvider('anthropic', new ProviderError("You've hit your usage limit. Try again in 3 hours.", 'quota_exhausted', 'anthropic')));
    polyphemus.registry.use('openai', new FakeProvider('openai', 'picked up'));
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'claude-api') });
    session.asker = { approve: async () => 'deny', chooseFallback: async ({ candidates }) => candidates.find((c) => c.label === 'gpt-api') };
    await session.send('hi');
    expect(polyphemus.outReading('anthropic')?.resetsAt?.getTime()).toBeGreaterThan(Date.now() + 2.9 * 3_600_000);
    expect(polyphemus.unavailable('anthropic')).toMatch(/^is out of quota until /);

    // A daemon runs for weeks: a reading it keeps in memory mustn't outlast the reset it carries.
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 3 * 3_600_000 + 1000;
      expect(polyphemus.unavailable('anthropic')).toBeUndefined();
      expect(polyphemus.capacity.has('anthropic')).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it("with nobody to ask, declines instead of switching (unless the config says continue)", async () => {
    const polyphemus = await Polyphemus.open(home);
    process.env.ANTHROPIC_API_KEY = 'test-key';
    polyphemus.registry.use('anthropic', new FakeProvider('anthropic', new ProviderError('rate limited', 'rate_limited', 'anthropic')));
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'claude-api') });
    const notices: string[] = [];
    session.on((event) => event.type === 'notice' && notices.push(event.text));

    expect(await session.send('hi')).toBe('other');
    expect(session.model.label).toBe('claude-api');
    expect(notices.at(-1)).toContain('Not switching without asking');
  });

  it('pins agents that followed the default to it, once, and says exactly who and to what', async () => {
    const libraryDir = join(home, 'agents');
    const projectDir = join(home, 'projects', 'shop');
    await mkdir(join(libraryDir, 'builder'), { recursive: true });
    await writeFile(join(libraryDir, 'builder', 'agent.toml'), 'description = "builds"\n');
    await mkdir(join(libraryDir, 'reviewer'), { recursive: true });
    await writeFile(join(libraryDir, 'reviewer', 'agent.toml'), 'description = "reviews"\nmodel = "codex"\n');
    await mkdir(join(libraryDir, 'scout'), { recursive: true });
    await writeFile(join(libraryDir, 'scout', 'agent.toml'), 'description = "follows on purpose"\nmodel = "default"\n');

    // No default yet: nothing to pin to, so it waits and agents keep following.
    const first = await Polyphemus.open(home);
    expect(await readFile(join(libraryDir, 'builder', 'agent.toml'), 'utf8')).not.toContain('model =');
    first.rememberDefault(resolveModel(first.config, 'gpt-api'));
    await createProject(first.store, home, join(home, 'projects'), { name: 'Shop' });
    await mkdir(join(projectDir, '.polyphemus', 'agents', 'bd'), { recursive: true });
    await writeFile(join(projectDir, '.polyphemus', 'agents', 'bd', 'agent.toml'), 'description = "sells"\n');
    first.close();

    const second = await Polyphemus.open(home);
    expect(await readFile(join(libraryDir, 'builder', 'agent.toml'), 'utf8')).toContain('model = "gpt-api"');
    expect(await readFile(join(projectDir, '.polyphemus', 'agents', 'bd', 'agent.toml'), 'utf8')).toContain('model = "gpt-api"');
    expect(await readFile(join(libraryDir, 'reviewer', 'agent.toml'), 'utf8')).toContain('model = "codex"'); // had its own
    expect(await readFile(join(libraryDir, 'scout', 'agent.toml'), 'utf8')).toContain('model = "default"'); // follows on purpose
    const note = second.store.configRevisions(1)[0]!.action;
    expect(note).toContain('pinned 2 agents to gpt-api');
    expect(note).toMatch(/builder \(.*agents\/builder\/agent\.toml\)/);
    expect(note).toMatch(/bd \(.*shop\/\.polyphemus\/agents\/bd\/agent\.toml\)/);
    expect(note).toContain('set model = "default" in its agent.toml');
    second.close();

    // Once: an agent made to follow the default later isn't pinned again.
    await writeFile(join(libraryDir, 'builder', 'agent.toml'), 'description = "builds"\n');
    const third = await Polyphemus.open(home);
    expect(await readFile(join(libraryDir, 'builder', 'agent.toml'), 'utf8')).not.toContain('model =');
    third.close();
  });

  it('keeps its folder and state files readable only by you', async () => {
    await chmod(home, 0o775);
    const polyphemus = await Polyphemus.open(home);
    expect((await stat(home)).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, 'sessions.db'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, 'config.toml'))).mode & 0o777).toBe(0o600);
    polyphemus.close();
  });

  it('“Always” covers that exact command for the session, not every command the tool could run', async () => {
    const polyphemus = await Polyphemus.open(home);
    const steps: string[] = ['touch a', 'touch b', 'touch a'];
    // Asks for one bash call per turn, then says done once its result is back.
    const provider: ModelProvider = {
      kind: 'model',
      id: 'openai',
      async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
        const last = req.messages.at(-1);
        const answered = last?.content.some((b) => b.type === 'tool_result');
        const content = answered
          ? [{ type: 'text' as const, text: 'done' }]
          : [{ type: 'tool_call' as const, id: `c${steps.length}`, name: 'bash', input: { command: steps.shift()! } }];
        yield { type: 'message_done', message: { role: 'assistant', content, origin: { provider: 'openai', model: req.model } }, stopReason: (answered ? 'end_turn' : 'tool_use') as StopReason, usage: emptyUsage() };
      },
      async listModels() {
        return [];
      },
    };
    polyphemus.registry.use('openai', provider);
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'gpt-api') });
    const asked: string[] = [];
    session.asker = {
      approve: async ({ summary }) => {
        asked.push(summary);
        return 'always';
      },
      chooseFallback: async () => undefined,
    };
    await session.send('first');
    await session.send('second');
    await session.send('third');
    expect(asked).toEqual(['touch a', 'touch b']);
  });

  it('remembers a model picked with switchModel, but not one that is not set up', async () => {
    const polyphemus = await Polyphemus.open(home);
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'gpt-api') });

    session.switchModel(resolveModel(polyphemus.config, 'gpt-api'));
    expect(await readFile(join(home, 'config.toml'), 'utf8')).toContain('default_model = "gpt-api"');

    delete process.env.XAI_API_KEY;
    session.switchModel(resolveModel(polyphemus.config, 'grok-api'));
    expect(session.model.label).toBe('grok-api');
    expect(polyphemus.config.defaultModel).toBe('gpt-api');
  });
});
