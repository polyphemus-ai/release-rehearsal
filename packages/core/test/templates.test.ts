import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFromTemplate, libraryAgentsDir, librarySkillsDir, loadAgents, loadSkills, templates, titleFor } from '../src/index.js';

describe('what ships with polyphemus', () => {
  it('offers agents and skills to start from', () => {
    // A roster you can actually pick from, not a sample of three.
    expect(templates('agents').map((t) => t.name)).toEqual(['analyst', 'assistant', 'builder', 'ops', 'planner', 'researcher', 'reviewer', 'writer']);
    expect(templates('skills').map((t) => t.name)).toEqual(['debug-failing-test', 'review-pr']);
    // Every one says what it's for: that line is what a person picks by, and what a model judges from.
    for (const kind of ['agents', 'skills'] as const) {
      for (const template of templates(kind)) expect(template.description.length).toBeGreaterThan(10);
    }
    // Agents are shown by their title, so the card you pick reads like the agent you'll get.
    expect(templates('agents').map((t) => t.title)).toEqual(['Analyst', 'Assistant', 'Builder', 'Ops', 'Planner', 'Researcher', 'Reviewer', 'Writer']);
    expect(templates('skills').map((t) => t.title)).toEqual(['debug-failing-test', 'review-pr']);
  });

  it('copies every shipped agent in cleanly, under the name you chose', () => {
    for (const template of templates('agents')) {
      const home = mkdtempSync(join(tmpdir(), 'polyphemus-templates-'));
      const file = createFromTemplate('agents', template.name, libraryAgentsDir(home), 'mine');
      expect(file).toBe(join(libraryAgentsDir(home), 'mine', 'agent.toml'));
      // Renamed throughout: it's yours now, not a second copy of the template.
      expect(readFileSync(file, 'utf8')).toContain('name = "mine"');
      expect(readFileSync(file, 'utf8')).toContain('title = "Mine"');
      expect(readFileSync(file, 'utf8')).not.toContain(`title = "${titleFor(template.name)}"`);

      // The real test: what shipped loads with nothing wrong with it.
      const { agents, problems } = loadAgents(home);
      expect(problems).toEqual([]);
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({ name: 'mine', title: 'Mine', description: template.description });
      expect(agents[0]!.persona.length).toBeGreaterThan(50);
      expect(agents[0]!.instructions.length).toBeGreaterThan(50);
      // It introduces itself as what you called it — those headings are part of the prompt.
      expect(agents[0]!.persona.split('\n')[0]).toBe('# Mine');
      expect(agents[0]!.instructions.split('\n')[0]).toContain('Mine');
      for (const prose of [agents[0]!.persona, agents[0]!.instructions]) {
        const headings = prose.split('\n').filter((line) => line.startsWith('#'));
        expect(headings.some((line) => line.includes(titleFor(template.name)))).toBe(false);
      }
    }
  });

  it('copies every shipped skill in cleanly, under the name you chose', () => {
    for (const template of templates('skills')) {
      const home = mkdtempSync(join(tmpdir(), 'polyphemus-templates-'));
      const file = createFromTemplate('skills', template.name, librarySkillsDir(home), 'mine');
      const text = readFileSync(file, 'utf8');
      expect(text).toContain('name: mine');
      // The heading follows the name; the steps below it are the template's own words.
      expect(text).toContain('# mine');
      expect(text.split('\n').filter((line) => line.startsWith('#')).some((line) => line.includes(template.name))).toBe(false);

      const { skills, problems } = loadSkills(home);
      expect(problems).toEqual([]);
      expect(skills).toEqual([expect.objectContaining({ name: 'mine', description: template.description, scope: 'library' })]);
    }
  });

  it('says what there is when you ask for one that isn’t', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-templates-'));
    expect(() => createFromTemplate('agents', 'nope', libraryAgentsDir(home), 'mine')).toThrow('no agent template called "nope"');
    createFromTemplate('agents', 'reviewer', libraryAgentsDir(home), 'mine');
    expect(() => createFromTemplate('agents', 'reviewer', libraryAgentsDir(home), 'mine')).toThrow('already exists');
  });
});
