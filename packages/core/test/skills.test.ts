import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentSkillsDir, buildSystemPrompt, createSkill, librarySkillsDir, loadSkills, openLicense, projectSkillsDir, skillsIndex } from '../src/index.js';

const skill = (dir: string, name: string, front: string, body = 'Do the thing.') => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\n${front}\n---\n\n${body}\n`);
};

describe('skills', () => {
  // A pipe where a file should be never answers, and reading skills happens when a thread starts —
  // so one in your library would stop polyphemus, not one request (fourth review, 2026-09-20).
  it.skipIf(process.platform === 'win32')('skips what isn’t a plain file, instead of waiting on it for ever', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-skills-fifo-'));
    skill(librarySkillsDir(home), 'real', 'description: one that reads');
    mkdirSync(join(librarySkillsDir(home), 'pipe'), { recursive: true });
    execFileSync('mkfifo', [join(librarySkillsDir(home), 'pipe', 'SKILL.md')]);

    const { skills, problems } = loadSkills(home);

    expect(skills.map((s) => s.name)).toEqual(['real']);
    expect(problems.map((p) => p.message)).toEqual(['isn’t a plain file polyphemus can read, so it was skipped.']);
  }, 5000);

  it('finds them in your library and in the project, and the project wins on a shared name', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-skills-'));
    const project = mkdtempSync(join(tmpdir(), 'polyphemus-proj-'));
    skill(librarySkillsDir(home), 'review-pr', 'description: reviewing a pull request before merge');
    skill(librarySkillsDir(home), 'deploy', 'description: the generic one');
    skill(projectSkillsDir(project), 'deploy', 'description: shipping this project, which has its own steps');

    const { skills, problems } = loadSkills(home, project);
    expect(problems).toEqual([]);
    expect(skills.map((s) => `${s.name}:${s.scope}`)).toEqual(['deploy:project', 'review-pr:library']);
    expect(skills[0]!.description).toBe('shipping this project, which has its own steps');

    // Only names and descriptions reach the prompt; the body is opened on demand.
    const index = skillsIndex(skills);
    expect(index).toContain('- review-pr: reviewing a pull request before merge');
    expect(index).toContain(join(projectSkillsDir(project), 'deploy', 'SKILL.md'));
    expect(index).not.toContain('Do the thing.');

    // And it reaches the model through the system prompt.
    expect(buildSystemPrompt({ cwd: project, home, projectRoot: project })).toContain('<skills>');
  });

  it('gives an agent skills of its own, which win over shared ones and go wherever it goes', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-skills-'));
    const project = mkdtempSync(join(tmpdir(), 'polyphemus-proj-'));
    const agentDir = mkdtempSync(join(tmpdir(), 'polyphemus-agent-'));
    skill(librarySkillsDir(home), 'budget', 'description: the shared way');
    skill(projectSkillsDir(project), 'budget', 'description: this project’s way');
    skill(agentSkillsDir(agentDir), 'budget', 'description: the snowball way, smallest debt first');
    skill(agentSkillsDir(agentDir), 'baby-steps', 'description: the seven steps, in order');
    const here = loadSkills(home, project, agentDir).skills;
    expect(here.map((s) => `${s.name}:${s.scope}`)).toEqual(['baby-steps:agent', 'budget:agent']);
    // Outside the project, still its own.
    expect(loadSkills(home, undefined, agentDir).skills.find((s) => s.name === 'budget')!.description).toBe('the snowball way, smallest debt first');
    // Another agent sees only what's shared.
    expect(loadSkills(home, project).skills.map((s) => `${s.name}:${s.scope}`)).toEqual(['budget:project']);
  });

  it('offers only openly licensed skills from the library', () => {
    expect(openLicense('                                 Apache License\n                           Version 2.0, January 2004')).toBe('Apache-2.0');
    expect(openLicense('MIT License\n\nCopyright (c) 2025 Jesse Vincent\n\nPermission is hereby granted, free of charge')).toBe('MIT');
    expect(openLicense('Attribution-ShareAlike 4.0 International')).toBe('CC-BY-SA-4.0');
    // Anthropic's document skills: all rights reserved, and no copies outside their services.
    expect(openLicense('© 2025 Anthropic, PBC. All rights reserved.\n\nLICENSE: Use of these materials is governed by your agreement with Anthropic')).toBeUndefined();
    expect(openLicense('Some words, not a licence')).toBeUndefined();
  });

  it('says what is wrong instead of loading a broken skill', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-skills-'));
    const library = librarySkillsDir(home);
    skill(library, 'no-description', 'name: no-description');
    skill(library, 'not-yaml', 'description: "unclosed');
    mkdirSync(join(library, 'empty-folder'), { recursive: true });
    writeFileSync(join(library, 'loose-note.md'), 'not a skill'); // a stray file is ignored
    skill(library, 'good', 'description: this one is fine');

    const { skills, problems } = loadSkills(home);
    expect(skills.map((s) => s.name)).toEqual(['good']);
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringContaining('has no SKILL.md'),
      expect.stringContaining('needs a description'),
      expect.stringContaining("aren't valid YAML"),
    ]);
  });

  it('scaffolds one that is immediately usable, and refuses a bad name', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-skills-'));
    const file = createSkill(librarySkillsDir(home), 'ship-it', 'shipping a change end to end');
    expect(file).toBe(join(librarySkillsDir(home), 'ship-it', 'SKILL.md'));

    const { skills, problems } = loadSkills(home);
    expect(problems).toEqual([]);
    expect(skills[0]).toMatchObject({ name: 'ship-it', description: 'shipping a change end to end', scope: 'library' });

    expect(() => createSkill(librarySkillsDir(home), 'Ship It', 'x')).toThrow("isn't a skill name");
    expect(() => createSkill(librarySkillsDir(home), 'ship-it', 'x')).toThrow('already exists');
  });

  it('costs nothing when you have none', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-skills-'));
    expect(loadSkills(home).skills).toEqual([]);
    expect(skillsIndex([])).toBe('');
    expect(buildSystemPrompt({ cwd: home, home })).not.toContain('<skills>');
  });
});
