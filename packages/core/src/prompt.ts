import { existsSync, readFileSync } from 'node:fs';
import { platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadSkills, skillsIndex, type Skill } from './skills.js';
import { readInside } from './contained.js';

const BASE_PROMPT = `You are a capable assistant running inside Polyphemus, a personal AI agent harness on the user's own machine. You can run shell commands and read, write, and edit files with your tools, and the user sees each tool call you make.

When a task depends on the state of the system, use your tools to find out rather than guessing. Before destructive or hard-to-reverse actions, such as deleting files, force-pushing, or overwriting work you didn't create, check with the user first. The user reads your replies in a terminal, so keep them concise.`;

/**
 * Builds the system prompt: the base prompt, environment facts, and any
 * AGENTS.md in the polyphemus home and the working directory. It only changes
 * when those do, so it stays cache-friendly across a session.
 */
export function buildSystemPrompt(opts: { cwd: string; home: string; projectRoot?: string; now?: Date; skills?: readonly Skill[] }): string {
  const date = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const parts = [
    BASE_PROMPT,
    `Environment:\n- Working directory: ${opts.cwd}\n- Platform: ${platform()} ${release()}\n- Date: ${date}`,
  ];
  // The project's AGENTS.md too, when the session starts in one of its subfolders.
  const project = opts.projectRoot ? [resolve(opts.projectRoot, 'AGENTS.md')] : [];
  const files = [...new Set([join(opts.home, 'AGENTS.md'), ...project, resolve(opts.cwd, 'AGENTS.md')])];
  for (const file of files) {
    // Never through a link, at any step from a folder the agent can't replace: the project's, when
    // the file is inside it, else the folder the person chose (independent review, 2026-09-19).
    const root = opts.projectRoot && file.startsWith(`${opts.projectRoot}/`) ? opts.projectRoot : dirname(file);
    const text = readInside(root, file);
    if (text !== undefined) parts.push(`Instructions from ${file}:\n\n${text.trim()}`);
  }
  // Only names and descriptions: the model opens a skill itself when one applies.
  const skills = skillsIndex(opts.skills ?? loadSkills(opts.home, opts.projectRoot).skills);
  if (skills) parts.push(skills);
  return parts.join('\n\n');
}
