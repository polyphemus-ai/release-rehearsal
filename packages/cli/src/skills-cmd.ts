import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentSkillsDir, buildSkillIndex, cachedSkillIndex, createFromTemplate, createSkill, PolyphemusError, installSkill, librarySkillsDir, loadSkills, projectSkillsDir, saveSkillIndex, searchSkills, templates, type Polyphemus, type SkillIndex } from '@polyphemus/core';
import { resolveAgent } from './agents-cmd.js';
import { printJson } from './output.js';
import { bold, cyan, dim, green, yellow } from './render.js';

// `poly skills …`: instructions a model opens only when a task calls for them. A skill is a
// folder with a SKILL.md, in your library (~/.polyphemus/skills), a project's .polyphemus/skills, or an
// agent's own (--agent: skills/ in its folder, which go wherever it goes).

/** The library, read again when it's over a week old (or never was). */
async function library(polyphemus: Polyphemus, json: boolean): Promise<SkillIndex> {
  const fresh = cachedSkillIndex(polyphemus.home, { fresh: true });
  if (fresh) return fresh;
  if (!json) process.stderr.write(dim('Reading the skill library…'));
  const index = await buildSkillIndex();
  if (!json) process.stderr.write(`\r${' '.repeat(30)}\r`);
  saveSkillIndex(polyphemus.home, index);
  return index;
}

export async function skillsCommand(polyphemus: Polyphemus, args: string[], flags: { project?: boolean; from?: string; agent?: string; replace?: boolean }, json: boolean, cwd: string): Promise<void> {
  const project = polyphemus.store.projectFor(cwd);
  const [action = 'ls', name, ...rest] = args;
  const agent = flags.agent ? resolveAgent(polyphemus, flags.agent, cwd) : undefined;
  /** Where a new skill goes: an agent's own with --agent, the project you're in with --project, otherwise your library. */
  const target = () => {
    if (agent) return agentSkillsDir(agent.dir);
    if (!flags.project) return librarySkillsDir(polyphemus.home);
    if (!project) throw new PolyphemusError('You’re not in a project, so there’s nowhere to put a project skill.', 'USAGE', 'poly projects add .');
    return projectSkillsDir(project.path);
  };
  /** The folder above the target that agents can't replace: what a project's (or project agent's) skill is written from. */
  const rootOf = () => (agent ? (agent.root ?? polyphemus.home) : flags.project && project ? project.path : polyphemus.home);

  switch (action) {
    case 'ls': {
      const { skills, problems } = loadSkills(polyphemus.home, project?.path, agent?.dir);
      if (json) return printJson({ skills, problems, library: librarySkillsDir(polyphemus.home), project: project ? projectSkillsDir(project.path) : null, agent: agent ? agentSkillsDir(agent.dir) : null });
      if (skills.length === 0) {
        console.log(dim('No skills yet. Write one: poly skills new <name>'));
      } else {
        const width = Math.max(...skills.map((skill) => skill.name.length));
        for (const skill of skills) console.log(`${bold(skill.name.padEnd(width))}  ${dim(skill.scope.padEnd(7))} ${skill.description}`);
        console.log(dim(`\nEvery session here sees these names; a model opens one when it applies.`));
      }
      for (const problem of problems) console.log(`${yellow('•')} ${problem.file}: ${problem.message}`);
      return;
    }
    case 'templates': {
      const shipped = templates('skills');
      if (json) return printJson({ templates: shipped.map(({ kind: _kind, dir: _dir, ...t }) => t) });
      const width = Math.max(...shipped.map((t) => t.name.length));
      for (const t of shipped) console.log(`${bold(t.name.padEnd(width))}  ${t.description}`);
      console.log(dim(`\nMake one yours: poly skills new <name> --from ${shipped[0]?.name ?? '<template>'}`));
      return;
    }
    case 'new': {
      if (!name) throw new PolyphemusError('Usage: poly skills new <name> [description…] [--from <template>] [--project | --agent <agent>]', 'USAGE');
      const file = flags.from ? createFromTemplate('skills', flags.from, target(), name, rootOf()) : createSkill(target(), name, rest.join(' '), rootOf());
      if (json) return printJson({ name, file, from: flags.from ?? null });
      console.log(`${green('✓')} ${file}`);
      console.log(
        flags.from
          ? dim(`Copied from the ${flags.from} template. Edit it to suit you.`)
          : dim('Fill in when to use it and the steps. The description line is what a model reads first.'),
      );
      return;
    }
    case 'show': {
      if (!name) throw new PolyphemusError('Usage: poly skills show <name>', 'USAGE');
      const skill = loadSkills(polyphemus.home, project?.path, agent?.dir).skills.find((s) => s.name === name);
      if (!skill) throw new PolyphemusError(`There's no skill called "${name}".`, 'NOT_FOUND', 'poly skills');
      if (json) return printJson({ ...skill, content: readFileSync(skill.file, 'utf8') });
      console.log(`${cyan(skill.file)}  ${dim(skill.scope)}\n`);
      console.log(readFileSync(skill.file, 'utf8').trim());
      return;
    }
    case 'path': {
      const library = librarySkillsDir(polyphemus.home);
      const projectDir = project ? projectSkillsDir(project.path) : null;
      if (json) return printJson({ library, project: projectDir });
      console.log(library);
      if (projectDir) console.log(projectDir);
      return;
    }
    case 'browse': {
      // The open library: skills published by Anthropic, OpenAI, GitHub, Microsoft and others.
      const index = await library(polyphemus, json);
      const found = searchSkills(index, [name, ...rest].filter(Boolean).join(' '));
      if (json) return printJson({ total: index.skills.length, found: found.length, skills: found.slice(0, 100) });
      for (const skill of found.slice(0, 40)) console.log(`${bold(skill.id)}  ${dim(skill.license)}\n  ${skill.description.slice(0, 160)}`);
      console.log(dim(`\n${found.length} of ${index.skills.length} skills. Install one: poly skills install <source/name> [--agent <agent> | --project]`));
      return;
    }
    case 'install': {
      if (!name) throw new PolyphemusError('Usage: poly skills install <source/name> [--agent <agent> | --project] [--replace]', 'USAGE', 'poly skills browse <words>');
      const index = await library(polyphemus, json);
      const skill = index.skills.find((k) => k.id === name) ?? (index.skills.filter((k) => k.name === name).length === 1 ? index.skills.find((k) => k.name === name) : undefined);
      if (!skill) {
        const same = index.skills.filter((k) => k.name === name).map((k) => k.id);
        throw new PolyphemusError(same.length ? `More than one source has ${name}: ${same.join(', ')}. Say which.` : `There's no ${name} in the library.`, same.length ? 'USAGE' : 'NOT_FOUND', 'poly skills browse <words>');
      }
      const aside = join(polyphemus.home, 'trash', 'skills', `${skill.name}-${Date.now()}`);
      mkdirSync(dirname(aside), { recursive: true });
      const dir = await installSkill(skill, target(), { by: process.env.POLYPHEMUS_CALLER ?? 'you (terminal)', replace: flags.replace === true, root: rootOf(), aside });
      if (json) return printJson({ id: skill.id, name: skill.name, dir, license: skill.license });
      console.log(`${green('✓')} ${skill.id} → ${dir}  ${dim(skill.license)}`);
      return;
    }
    default:
      throw new PolyphemusError(`Unknown skills command "${action}". Try: ls, new, show, browse, install, path, templates.`, 'USAGE', 'poly help skills new');
  }
}
