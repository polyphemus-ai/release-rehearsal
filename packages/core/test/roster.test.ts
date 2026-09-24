import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentModel,
  agentPrompt,
  createAgent,
  defaultMark,
  DEFAULT_CONFIG,
  libraryAgentsDir,
  loadAgents,
  MARK_COLORS,
  MARK_SHAPES,
  parseConfig,
  parseDraft,
  projectAgentsDir,
  SessionStore,
  updateAgent,
  spokenTo,
  type Agent,
  type ResolvedModel,
} from '../src/index.js';

const agentFile = (dir: string, name: string, toml: string, files: Record<string, string> = {}) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'agent.toml'), toml);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, name, file), content);
};

const sessionModel: ResolvedModel = { label: 'claude', provider: 'claude-code', model: 'default' };

describe('agents', () => {
  it('are folders, found in your library and in the project, and the project wins', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-agents-'));
    const project = mkdtempSync(join(tmpdir(), 'polyphemus-proj-'));
    agentFile(libraryAgentsDir(home), 'reviewer', 'description = "reviewing changes before they ship"\nmodel = "codex"\n', {
      'persona.md': 'You are blunt and specific.',
      'instructions.md': 'Read the diff. Say what would break.',
    });
    agentFile(projectAgentsDir(project), 'reviewer', 'description = "reviewing this project, which ships on Fridays"\n');

    const { agents, problems } = loadAgents(home, project);
    expect(problems).toEqual([]);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ name: 'reviewer', scope: 'project', description: 'reviewing this project, which ships on Fridays', title: 'reviewer' });

    const library = loadAgents(home).agents[0]!;
    expect(library).toMatchObject({ model: 'codex', persona: 'You are blunt and specific.' });
    const prompt = agentPrompt(library);
    expect(prompt).toContain('You are reviewer, an agent in polyphemus. You are for: reviewing changes before they ship');
    expect(prompt).toContain('You are blunt and specific.');
    expect(prompt).toContain('Read the diff. Say what would break.');
  });

  it('run on their own model route, and fall back to the session’s', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-agents-'));
    agentFile(libraryAgentsDir(home), 'builder', 'description = "building things"\nmodel = "codex"\nfallback = ["claude"]\neffort = "high"\n');
    agentFile(libraryAgentsDir(home), 'helper', 'description = "whatever is going"\n');
    agentFile(libraryAgentsDir(home), 'broken', 'description = "points at nothing"\nmodel = "no-such-model"\n');
    const config = parseConfig(DEFAULT_CONFIG);
    const { agents } = loadAgents(home);
    const byName = Object.fromEntries(agents.map((agent) => [agent.name, agent]));

    expect(agentModel(config, byName.builder!, sessionModel)).toMatchObject({ label: 'codex', provider: 'codex', fallback: ['claude'], effort: 'high' });
    // No model of its own: it uses whatever the session was going to use.
    expect(agentModel(config, byName.helper!, sessionModel)).toEqual(sessionModel);
    expect(() => agentModel(config, byName.broken!, sessionModel)).toThrow("broken's model \"no-such-model\" isn't set up");
  });

  it('keeps the model an agent was made with, unless it says to follow the default', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-agents-'));
    agentFile(libraryAgentsDir(home), 'follower', 'description = "goes where the default goes"\nmodel = "default"\n');
    agentFile(libraryAgentsDir(home), 'keeper', 'description = "stays put"\nmodel = "codex"\n');
    const follower = loadAgents(home).agents.find((a) => a.name === 'follower')!;
    const keeper = loadAgents(home).agents.find((a) => a.name === 'keeper')!;
    const withDefault = (ref: string) => parseConfig(DEFAULT_CONFIG.replace('# default_model = "claude"', `default_model = "${ref}"`));
    expect(agentModel(withDefault('grok'), follower, sessionModel)).toMatchObject({ provider: 'grok-build' });
    expect(agentModel(withDefault('claude-api'), follower, sessionModel)).toMatchObject({ provider: 'anthropic' });
    expect(agentModel(withDefault('claude-api'), keeper, sessionModel)).toMatchObject({ provider: 'codex' });
    // No default yet: following it means using what the session would.
    expect(agentModel(parseConfig(DEFAULT_CONFIG), follower, sessionModel)).toEqual(sessionModel);
  });

  it('say what is wrong instead of loading a broken one', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-agents-'));
    const dir = libraryAgentsDir(home);
    agentFile(dir, 'no-description', 'model = "codex"\n');
    agentFile(dir, 'not-toml', 'description = "unclosed\n');
    agentFile(dir, 'unknown-setting', 'description = "x"\ncolour = "blue"\n');
    agentFile(dir, 'bad-effort', 'description = "x"\neffort = "extreme"\n');
    mkdirSync(join(dir, 'empty-folder'), { recursive: true });
    agentFile(dir, 'good', 'description = "this one is fine"\n');

    const { agents, problems } = loadAgents(home);
    expect(agents.map((agent) => agent.name)).toEqual(['good']);
    expect(problems.map((problem) => problem.message)).toEqual([
      expect.stringContaining('effort must be one of'),
      expect.stringContaining('has no agent.toml'),
      expect.stringContaining('needs a description'),
      expect.stringContaining("isn't valid TOML"),
      expect.stringContaining('unknown setting "colour"'),
    ]);
  });

  it('are scaffolded ready to use, and a session remembers which one it ran as', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-agents-'));
    const file = createAgent(libraryAgentsDir(home), 'release-manager', { description: 'shipping a release end to end' });
    expect(file).toBe(join(libraryAgentsDir(home), 'release-manager', 'agent.toml'));

    const { agents, problems } = loadAgents(home);
    expect(problems).toEqual([]);
    expect(agents[0]).toMatchObject({ name: 'release-manager', title: 'Release Manager', description: 'shipping a release end to end' });

    expect(() => createAgent(libraryAgentsDir(home), 'Release Manager', { description: 'x' })).toThrow("isn't an agent name");
    expect(() => createAgent(libraryAgentsDir(home), 'release-manager', { description: 'x' })).toThrow('already exists');

    const store = new SessionStore(':memory:');
    const meta = store.create({ title: 'a release', provider: 'codex', model: 'default', cwd: home, agent: 'release-manager' });
    expect(meta.agent).toBe('release-manager');
    expect(store.get(meta.id)?.agent).toBe('release-manager');
    // Sessions that aren't an agent's stay as they were.
    expect(store.create({ title: 'plain', provider: 'codex', model: 'default', cwd: home }).agent).toBe('');
    store.close();
  });
});

describe('an agent in your library', () => {
  // ~/.polyphemus is polyphemus's own, and nothing it offers lets an agent write there — but the file
  // tools stop only at credentials, so a link planted there was written straight through, and a
  // pipe left there stopped polyphemus reading its agents at all (fourth review, 2026-09-20).
  it('is written from polyphemus’s home, so a link left in its folder is replaced, not followed', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-lib-agent-'));
    const outside = mkdtempSync(join(tmpdir(), 'polyphemus-outside-'));
    writeFileSync(join(outside, 'notes.md'), 'MINE');
    agentFile(libraryAgentsDir(home), 'scout', 'description = "scouting"\n');
    symlinkSync(join(outside, 'notes.md'), join(libraryAgentsDir(home), 'scout', 'persona.md'));

    const agent = loadAgents(home).agents.find((a) => a.name === 'scout')!;
    updateAgent(agent, { persona: 'You are careful.' });

    expect(readFileSync(join(outside, 'notes.md'), 'utf8')).toBe('MINE');
    expect(readFileSync(join(libraryAgentsDir(home), 'scout', 'persona.md'), 'utf8')).toContain('You are careful.');
  });

  it.skipIf(process.platform === 'win32')('is skipped when its agent.toml isn’t a plain file, instead of waiting on it for ever', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-lib-fifo-'));
    agentFile(libraryAgentsDir(home), 'real', 'description = "one that reads"\n');
    mkdirSync(join(libraryAgentsDir(home), 'pipe'), { recursive: true });
    execFileSync('mkfifo', [join(libraryAgentsDir(home), 'pipe', 'agent.toml')]);

    const { agents, problems } = loadAgents(home);

    expect(agents.map((a) => a.name)).toEqual(['real']);
    expect(problems.map((p) => p.message)).toEqual(['isn’t a plain file polyphemus can read, so it was skipped.']);
  }, 5000);
});

describe('marks', () => {
  it('gives every name one without being asked, and keeps it the same', () => {
    const mark = defaultMark('bd');
    expect(MARK_SHAPES).toContain(mark.shape);
    expect(MARK_COLORS).toContain(mark.color);
    expect(defaultMark('bd')).toEqual(mark);
    // Two names that differ by one letter shouldn't come out looking the same.
    expect(defaultMark('bd')).not.toEqual(defaultMark('be'));
  });

  it('is picked in agent.toml, and half a pick keeps the other half', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-marks-'));
    agentFile(libraryAgentsDir(home), 'bd', 'description = "the pipeline"\nmark = { shape = "drop", color = "amber" }\n');
    agentFile(libraryAgentsDir(home), 'ops', 'description = "the servers"\nmark = { color = "teal" }\n');
    const { agents } = loadAgents(home);
    expect(agents.find((a) => a.name === 'bd')!.mark).toEqual({ shape: 'drop', color: 'amber' });
    expect(agents.find((a) => a.name === 'ops')!.mark).toEqual({ shape: defaultMark('ops').shape, color: 'teal' });
  });

  it('says what is wrong with a mark rather than drawing something else', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-marks-bad-'));
    agentFile(libraryAgentsDir(home), 'bd', 'description = "the pipeline"\nmark = { shape = "octagon", color = "amber" }\n');
    const { agents, problems } = loadAgents(home);
    expect(agents).toEqual([]);
    expect(problems[0]!.message).toContain('mark shape must be one of');
  });

  it('is written and reset from the app without disturbing the rest of the file', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-marks-edit-'));
    createAgent(libraryAgentsDir(home), 'bd', { description: 'the pipeline' });
    const load = () => loadAgents(home).agents[0]!;
    expect(load().mark).toEqual(defaultMark('bd'));

    updateAgent(load(), { mark: { shape: 'cloud', color: 'pink' } });
    expect(load().mark).toEqual({ shape: 'cloud', color: 'pink' });
    // The comments that came with the file are still there.
    expect(readFileSync(load().file, 'utf8')).toContain('# fallback = ["codex"]');

    updateAgent(load(), { mark: null });
    expect(load().mark).toEqual(defaultMark('bd'));
    expect(readFileSync(load().file, 'utf8')).not.toContain('mark =');
  });
});

describe('writing a persona from a sentence', () => {
  it('takes both halves or neither', () => {
    const reply = '<persona>\nYou chase things down.\n</persona>\n<instructions>\nYou own the pipeline.\n</instructions>';
    expect(parseDraft(reply)).toEqual({ persona: 'You chase things down.', instructions: 'You own the pipeline.' });
    // Half a draft is worse than the blank file it would replace.
    expect(parseDraft('<persona>You chase things down.</persona>')).toBeUndefined();
    expect(parseDraft('Sure! Here is a persona for you.')).toBeUndefined();
  });
});

describe('speaking to another agent without an @', () => {
  const agent = (name: string, title: string) => ({ id: name, name, title }) as Agent;
  const riley = agent('riley', 'Riley');
  const morgan = agent('morgan', 'Morgan');
  const team = [riley, morgan];

  it('counts greeting them, putting something to them, or handing over, by name', () => {
    for (const reply of [
      'Hey Riley — good to meet you too.\n\n143 real followers is a solid goal.',
      'Riley, can you take the captions?',
      'I did the outline. Over to Riley for the captions.',
      'That works for me. Thanks, Riley!',
      'Draft is in the doc — your turn, Riley.',
      'Nice to meet you, Riley.',
    ]) expect(spokenTo(reply, [riley]), reply).toBe(riley);
  });

  it('doesn’t count talking about them, quoting, or speaking to more than one', () => {
    for (const reply of [
      'Riley said he likes it.',
      'I talked to Riley about it yesterday.',
      'Type “Riley, go” to start it.',
      '`Riley, run this`',
      'Riley, you take captions. Morgan, you take the outline.',
    ]) expect(spokenTo(reply, team), reply).toBeUndefined();
  });
});

