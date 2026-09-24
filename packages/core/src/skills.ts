import { projectStateDir } from './config.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PolyphemusError } from './types.js';
import { createInside, listInside, readInside, readPlainFile } from './contained.js';

// Skills: instructions a model loads only when a task calls for them (docs/design/agents.md).
// A skill is a folder with a SKILL.md — the same Agent Skills format Claude Code and Codex read,
// so a skill written here works outside polyphemus too, and one written elsewhere works here.
//
// Three scopes: your library (~/.polyphemus/skills), shared by every agent everywhere; a project's
// (.polyphemus/skills, safe to commit), in that project; and an agent's own (skills/ in its folder),
// which go wherever the agent goes — its craft travels with it, the way a person's does. An
// agent's own skill wins over a shared one of the same name, and a project's over the library's.
//
// Only each skill's name and one-line description go in the prompt. The body is read by the
// model, with its own tools, when it decides the skill applies — so twenty skills cost a few
// hundred tokens, not twenty files.

export type SkillScope = 'library' | 'project' | 'agent';

export interface Skill {
  name: string;
  /** When this skill is useful: the one line the model sees, and judges from. */
  description: string;
  scope: SkillScope;
  /** The folder; its SKILL.md is `file`. */
  dir: string;
  file: string;
}

export interface SkillProblem {
  file: string;
  message: string;
}

/** Kept small on purpose: the index is in every prompt. */
const INDEX_LIMIT = 60;
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export const librarySkillsDir = (home: string): string => join(home, 'skills');
export const projectSkillsDir = (projectRoot: string): string => join(projectStateDir(projectRoot), 'skills');
/** An agent's own skills: in its folder, so they move and are deleted with it. */
export const agentSkillsDir = (agentDir: string): string => join(agentDir, 'skills');

/**
 * Every skill in play for a session, with any that couldn't be read. On a name, an agent's own wins,
 * then a project's, then the library's.
 */
export function loadSkills(home: string, projectRoot?: string, agentDir?: string): { skills: Skill[]; problems: SkillProblem[] } {
  const problems: SkillProblem[] = [];
  const found = new Map<string, Skill>();
  // Anything inside a project is its agents' to write, a project agent's own skills included: read from
  // the project's folder, through no link. The library and library agents are polyphemus's home.
  const inProject = (dir: string) => (projectRoot && (dir === projectRoot || dir.startsWith(`${projectRoot}/`)) ? projectRoot : undefined);
  // Widest first, so a narrower scope's version of a name replaces it.
  for (const [scope, dir] of [
    ['library', librarySkillsDir(home)],
    ...(projectRoot ? [['project', projectSkillsDir(projectRoot)] as const] : []),
    ...(agentDir ? [['agent', agentSkillsDir(agentDir)] as const] : []),
  ] as Array<[SkillScope, string]>) {
    for (const skill of readScope(scope, dir, problems, inProject(dir))) found.set(skill.name, skill);
  }
  return { skills: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

function readScope(scope: SkillScope, dir: string, problems: SkillProblem[], root?: string): Skill[] {
  if (root) return readContainedScope(scope, dir, problems, root);
  if (!existsSync(dir)) return [];
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith('.')) continue;
    const folder = join(dir, entry);
    if (!statSync(folder).isDirectory()) continue;
    const file = join(folder, 'SKILL.md');
    if (!existsSync(file)) {
      problems.push({ file: folder, message: 'has no SKILL.md, so it was skipped.' });
      continue;
    }
    const text = readPlainFile(file);
    if (text === undefined) {
      problems.push({ file, message: 'isn’t a plain file polyphemus can read, so it was skipped.' });
      continue;
    }
    const skill = parseSkill(text, { name: entry, scope, dir: folder, file }, problems);
    if (skill) skills.push(skill);
  }
  return skills;
}

/** A scope inside a project: listed and read from the project's folder, through no link at any step. */
function readContainedScope(scope: SkillScope, dir: string, problems: SkillProblem[], root: string): Skill[] {
  const skills: Skill[] = [];
  for (const entry of listInside(root, dir).sort()) {
    if (entry.startsWith('.')) continue;
    const folder = join(dir, entry);
    const file = join(folder, 'SKILL.md');
    const text = readInside(root, file);
    if (text === undefined) {
      // A folder without one says so; a link or a stray file is simply not a skill.
      if (listInside(root, folder).length) problems.push({ file: folder, message: 'has no SKILL.md you can use (it’s missing, or a link), so it was skipped.' });
      continue;
    }
    const skill = parseSkill(text, { name: entry, scope, dir: folder, file }, problems);
    if (skill) skills.push(skill);
  }
  return skills;
}

function parseSkill(text: string, where: { name: string; scope: SkillScope; dir: string; file: string }, problems: SkillProblem[]): Skill | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) {
    problems.push({ file: where.file, message: 'needs settings at the top between --- lines, with a description.' });
    return undefined;
  }
  let front: Record<string, unknown>;
  try {
    front = (parseYaml(match[1]!) ?? {}) as Record<string, unknown>;
  } catch (err) {
    problems.push({ file: where.file, message: `its settings aren't valid YAML: ${(err as Error).message}` });
    return undefined;
  }
  const name = typeof front.name === 'string' && front.name.trim() ? front.name.trim() : where.name;
  const description = typeof front.description === 'string' ? front.description.trim() : '';
  if (!SKILL_NAME.test(name)) {
    problems.push({ file: where.file, message: `"${name}" isn't a skill name: use lowercase letters, numbers, and dashes.` });
    return undefined;
  }
  if (!description) {
    problems.push({ file: where.file, message: 'needs a description: one line saying when the skill is useful, so a model knows when to open it.' });
    return undefined;
  }
  return { name, description, scope: where.scope, dir: where.dir, file: where.file };
}

/**
 * The block that goes in the prompt: what exists, and when to open it. Empty when there are no
 * skills, so nothing is spent on a feature you aren't using.
 */
export function skillsIndex(skills: readonly Skill[]): string {
  if (skills.length === 0) return '';
  const shown = skills.slice(0, INDEX_LIMIT);
  const lines = shown.map((skill) => `- ${skill.name}: ${skill.description} (${skill.file})`);
  if (skills.length > shown.length) lines.push(`- …and ${skills.length - shown.length} more in the skills folders.`);
  return [
    '<skills>',
    'Skills are instructions for specific kinds of work. When one matches what you are about to do, read its SKILL.md with your tools and follow it; otherwise ignore them. Files it mentions are relative to the skill\'s own folder.',
    ...lines,
    '</skills>',
  ].join('\n');
}

const TEMPLATE = (name: string, description: string) => `---
name: ${name}
description: ${description}
---

# ${name}

## When to use this

<!-- The situations this applies to, in a line or two. The description above is what a model
     sees first; this is what it reads after opening the file. -->

## Steps

1. <!-- What to do, in order. Exact commands where there are any. -->

## Rules

<!-- What to be careful about, and what never to do. -->
`;

/** Writes a new skill folder. Returns the SKILL.md path. */
/** A skill an agent wrote and a person accepted: its SKILL.md, whole. Never over one that's there. */
export function writeSkill(dir: string, name: string, description: string, body: string, root = dir): string {
  if (!SKILL_NAME.test(name)) throw new PolyphemusError(`"${name}" isn't a skill name: use lowercase letters, numbers, and dashes, like review-pr.`, 'USAGE');
  const file = join(dir, name, 'SKILL.md');
  const line = description.replace(/\s+/g, ' ').trim();
  // Accepting a skill is accepting its words, not wherever a link an agent left there points: made new,
  // from `root`, through no link (independent review, 2026-09-19).
  try {
    createInside(root, file, Buffer.from(`---\nname: ${name}\ndescription: ${JSON.stringify(line)}\n---\n\n${body.trim()}\n`));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new PolyphemusError(`There's already a skill called ${name} there.`, 'CONFLICT');
    if (code === 'ELINK') throw new PolyphemusError(`The folder for ${name} goes through a link, so polyphemus won’t write it there.`, 'CONFLICT');
    throw err;
  }
  return file;
}

export function createSkill(dir: string, name: string, description: string, root = dir): string {
  if (!SKILL_NAME.test(name)) throw new PolyphemusError(`"${name}" isn't a skill name: use lowercase letters, numbers, and dashes, like review-pr.`, 'USAGE');
  const file = join(dir, name, 'SKILL.md');
  try {
    createInside(root, file, Buffer.from(TEMPLATE(name, description || 'One line saying when this skill is useful.')));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ELINK') throw new PolyphemusError(`${file} already exists, or goes through a link.`, 'CONFLICT');
    throw err;
  }
  return file;
}
