import { DEFAULT_CONFIG } from '../src/config.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyUsage, findAgent, Polyphemus, librarySkillsDir, libraryAgentsDir, resolveModel, type AgentProvider, type AgentRunRequest, type ChatRequest, type ModelProvider, type ProviderEvent } from '../src/index.js';

/** Answers anything, and keeps the request so the prompt can be inspected. */
class FakeProvider implements ModelProvider {
  readonly kind = 'model' as const;
  readonly id = 'openai';
  readonly requests: ChatRequest[] = [];
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    yield {
      type: 'message_done',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Looked at it.' }], origin: { provider: this.id, model: req.model } },
      stopReason: 'end_turn',
      usage: emptyUsage(),
    };
  }
  async listModels() {
    return [];
  }
}

let home: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'polyphemus-agent-session-'));
  // Tests of how things run on this computer: the level a fresh install wouldn't default to.
  writeFileSync(join(home, 'config.toml'), `${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  process.env.CODEX_HOME = join(home, 'no-codex');
  process.env.OPENAI_API_KEY = 'test-key';

  const agents = libraryAgentsDir(home);
  mkdirSync(join(agents, 'reviewer'), { recursive: true });
  writeFileSync(join(agents, 'reviewer', 'agent.toml'), 'description = "reviewing changes before they ship"\ntitle = "Reviewer"\nskills = ["review-pr"]\n');
  writeFileSync(join(agents, 'reviewer', 'persona.md'), 'You are blunt and specific, and you never rewrite the code yourself.');
  writeFileSync(join(agents, 'reviewer', 'instructions.md'), 'Read the diff, then say what would break.');

  const skills = librarySkillsDir(home);
  for (const [name, description] of [
    ['review-pr', 'reviewing a pull request before merge'],
    ['deploy', 'shipping a release'],
  ]) {
    mkdirSync(join(skills, name!), { recursive: true });
    writeFileSync(join(skills, name!, 'SKILL.md'), `---\ndescription: ${description}\n---\n\nSteps.\n`);
  }
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('a session run as an agent', () => {
  it('is that agent: its persona, its instructions, and only its skills', async () => {
    const polyphemus = await Polyphemus.open(home);
    const provider = new FakeProvider();
    polyphemus.registry.use('openai', provider);
    const agent = findAgent(home, undefined, 'reviewer');
    expect(agent).toBeDefined();

    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'gpt-api'), agent });
    expect(await session.send('have a look')).toBe('end_turn');

    const system = provider.requests[0]!.system;
    expect(system).toContain('You are Reviewer ("reviewer"), an agent in polyphemus. You are for: reviewing changes before they ship');
    expect(system).toContain('You are blunt and specific');
    expect(system).toContain('Read the diff, then say what would break.');
    // Its own skills only: the agent listed review-pr, so deploy isn't offered.
    expect(system).toContain('- review-pr: reviewing a pull request before merge');
    expect(system).not.toContain('deploy');

    // The session records who it ran as.
    expect(session.meta?.agent).toBe('reviewer');
    expect(polyphemus.store.get(session.meta!.id)?.agent).toBe('reviewer');
    polyphemus.close();
  });

  it('stays in character when it is resumed later', async () => {
    const first = await Polyphemus.open(home);
    first.registry.use('openai', new FakeProvider());
    const session = first.newSession({ cwd: home, model: resolveModel(first.config, 'gpt-api'), agent: findAgent(home, undefined, 'reviewer') });
    await session.send('have a look');
    const id = session.meta!.id;
    first.close();

    // A new process opens the stored session, with no agent passed in.
    const later = await Polyphemus.open(home);
    const provider = new FakeProvider();
    later.registry.use('openai', provider);
    const meta = later.store.get(id)!;
    const resumed = later.openSession(meta, { cwd: home });
    expect(resumed.agent?.name).toBe('reviewer');
    await resumed.send('and now?');
    expect(provider.requests[0]!.system).toContain('You are Reviewer');
    later.close();
  });

  it('gives each agent its own CLI session, and a fresh one when its instructions change', async () => {
    const agents = libraryAgentsDir(home);
    mkdirSync(join(agents, 'builder'), { recursive: true });
    writeFileSync(join(agents, 'builder', 'agent.toml'), 'description = "building"\ntitle = "Builder"\n');
    writeFileSync(join(agents, 'builder', 'persona.md'), 'You build things.');
    const runs: AgentRunRequest[] = [];
    let next = 0;
    // Like Codex: polyphemus's instructions only count when a native session starts.
    const cli: AgentProvider = {
      kind: 'agent',
      id: 'codex',
      async *run(req) {
        runs.push(req);
        yield { type: 'agent_session', provider: 'codex', id: req.resume ?? `native-${++next}` };
        yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], origin: { provider: 'codex', model: req.model } } };
        yield { type: 'turn_done', stopReason: 'end_turn', usage: emptyUsage() };
      },
      async listModels() {
        return [];
      },
    };
    const polyphemus = await Polyphemus.open(home);
    polyphemus.registry.use('codex', cli);
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'codex'), agent: findAgent(home, undefined, 'builder') });

    await session.send('build it');
    session.speakAs(findAgent(home, undefined, 'reviewer'));
    await session.send('now review it');
    session.speakAs(findAgent(home, undefined, 'builder'));
    await session.send('fix what it found');

    expect(runs.map((r) => r.resume)).toEqual([undefined, undefined, 'native-1']);
    // Reviewer got a session of its own, started with its own instructions — not Builder's reused.
    expect(runs[1]!.systemAppend).toContain('You are Reviewer');

    // Builder's instructions change: its old native session doesn't know, so it isn't resumed.
    writeFileSync(join(agents, 'builder', 'instructions.md'), 'Always write the test first.');
    const reopened = polyphemus.openSession(polyphemus.store.get(session.meta!.id)!, { cwd: home });
    reopened.speakAs(findAgent(home, undefined, 'builder'));
    await reopened.send('and the next one');
    expect(runs[3]!.resume).toBeUndefined();
    expect(runs[3]!.systemAppend).toContain('Always write the test first.');
    polyphemus.close();
  });

  it('lets a CLI that asks as polyphemus’s client, like Grok, reach the person with its question', async () => {
    // Grok asks polyphemus before a command. The answer was set on the turn and never passed on to
    // Grok, so every question was refused as "no one to ask" though someone was in the thread
    // (2026-09-23). This goes the way a real thread does, not straight to Grok's runner.
    const said: Array<{ allow: boolean; message?: string } | 'no one to ask'> = [];
    const grok: AgentProvider = {
      kind: 'agent',
      id: 'grok-build',
      async *run(req) {
        said.push(req.approve ? await req.approve('run_terminal_command', { command: 'rm -rf build' }) : 'no one to ask');
        yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], origin: { provider: 'grok-build', model: req.model } } };
        yield { type: 'turn_done', stopReason: 'end_turn', usage: emptyUsage() };
      },
      async listModels() {
        return [];
      },
    };
    const polyphemus = await Polyphemus.open(home);
    polyphemus.registry.use('grok-build', grok);
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'grok-build:default') });
    const asked: string[] = [];
    session.asker = {
      approve: async (question) => (asked.push(`${question.tool}: ${question.summary}`), 'allow'),
      chooseFallback: async () => undefined,
    };
    await session.send('clean the build');
    expect(asked).toEqual(['run_terminal_command: rm -rf build']);
    expect(said).toEqual([{ allow: true }]);
    polyphemus.close();
  });

  it('passes on what another agent said while it was working, counting the thread and not its own copy', async () => {
    // Two agents work in one thread (docs/design/parallel-agents.md), each with a runtime of its own.
    // What a CLI has seen was counted in its own runtime's array, so anything written alongside it
    // was skipped for ever (review of parallel agents, 2026-09-20).
    const polyphemus = await Polyphemus.open(home);
    const runs: AgentRunRequest[] = [];
    let alongside: (() => void) | undefined;
    const cli: AgentProvider = {
      kind: 'agent',
      id: 'codex',
      async *run(req) {
        runs.push(req);
        yield { type: 'agent_session', provider: 'codex', id: req.resume ?? 'native-1' };
        alongside?.(); // another agent answers in the thread while this turn is still going
        yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], origin: { provider: 'codex', model: req.model } } };
        yield { type: 'turn_done', stopReason: 'end_turn', usage: emptyUsage() };
      },
      async listModels() {
        return [];
      },
    };
    polyphemus.registry.use('codex', cli);
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'codex') });
    alongside = () => void polyphemus.store.append(session.meta!.id, { role: 'assistant', content: [{ type: 'text', text: 'Helm here: the logs say the port was taken.' }] }, 'agent:helm');

    await session.send('start it');
    alongside = undefined;
    await session.send('and now?');

    // Its own session continues, and it's told what it missed — including what landed mid-turn.
    expect(runs[1]!.resume).toBe('native-1');
    expect(runs[1]!.prompt).toContain('the port was taken');
    polyphemus.close();
  });

  it('records what a turn cost, not what the CLI’s whole session has cost so far', async () => {
    // Claude Code's total_cost_usd is the running total for the native session — checked against
    // the CLI itself: a second turn of six tokens reported the first turn's total plus its own. Kept
    // as it came, a resumed session's cost landed again every turn and a thread's total read many
    // times what it was (2026-09-20).
    const totals = [2, 6, 12, 5];
    let turn = 0;
    const cli: AgentProvider = {
      kind: 'agent',
      id: 'codex',
      async *run(req) {
        // The fourth turn is a session that started afresh rather than resuming.
        yield { type: 'agent_session', provider: 'codex', id: turn === 3 ? 'native-fresh' : (req.resume ?? 'native-1') };
        yield { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], origin: { provider: 'codex', model: req.model } } };
        yield { type: 'turn_done', stopReason: 'end_turn', usage: emptyUsage(), costUsd: totals[turn++] ?? 0 };
      },
      async listModels() {
        return [];
      },
    };
    const polyphemus = await Polyphemus.open(home);
    polyphemus.registry.use('codex', cli);
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'codex') });
    await session.send('one');
    await session.send('two');
    await session.send('three');

    const costs = polyphemus.store.turns(session.meta!.id).map((t) => t.costUsd);
    expect(costs).toEqual([2, 4, 6]);
    expect(costs.reduce((sum: number, c) => sum + (c ?? 0), 0)).toBe(12);

    // A session that started afresh counts from zero: its total is what this turn cost, and the
    // total the old session had reached isn't subtracted from it.
    await session.send('four');
    expect(polyphemus.store.turns(session.meta!.id).at(-1)!.costUsd).toBe(5);
    polyphemus.close();
  });

  it('is an ordinary session when no agent is given', async () => {
    const polyphemus = await Polyphemus.open(home);
    const provider = new FakeProvider();
    polyphemus.registry.use('openai', provider);
    const session = polyphemus.newSession({ cwd: home, model: resolveModel(polyphemus.config, 'gpt-api') });
    await session.send('hi');

    expect(provider.requests[0]!.system).not.toContain('<agent');
    // Every skill is in scope when nothing narrows them.
    expect(provider.requests[0]!.system).toContain('- deploy: shipping a release');
    expect(session.meta?.agent).toBe('');
    polyphemus.close();
  });
});
