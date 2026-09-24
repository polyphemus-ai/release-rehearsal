import { readFileSync } from 'node:fs';
import {
  createAgent,
  createFromTemplate,
  defaultMark,
  draftingModel,
  draftPersona,
  FOLLOW_DEFAULT,
  PolyphemusError,
  libraryAgentsDir,
  loadAgents,
  MARK_COLORS,
  MARK_SHAPES,
  offList,
  projectAgentsDir,
  resolveModel,
  templates,
  updateAgent,
  type Agent,
  type Polyphemus,
  type Mark,
  type MarkColor,
  type MarkShape,
} from '@polyphemus/core';
import { printJson } from './output.js';
import { bold, cyan, dim, green, yellow } from './render.js';

// `poly agents …`: an expert for a particular kind of work. An agent is a folder — agent.toml,
// persona.md, instructions.md — in your library (~/.polyphemus/agents) or a project's .polyphemus/agents.

/** The agent `--agent` names, or an error saying what there is. */
export function resolveAgent(polyphemus: Polyphemus, name: string, cwd: string): Agent {
  const project = polyphemus.store.projectFor(cwd);
  const { agents } = loadAgents(polyphemus.home, project?.path, project?.slug);
  const agent = agents.find((candidate) => candidate.name === name);
  if (agent) return agent;
  const known = agents.map((candidate) => candidate.name).join(', ');
  throw new PolyphemusError(
    known ? `There's no agent called "${name}". You have: ${known}.` : `There's no agent called "${name}", and you don't have any yet.`,
    'NOT_FOUND',
    known ? 'poly agents' : 'poly agents new <name> "what it’s for"',
  );
}

export async function agentsCommand(
  polyphemus: Polyphemus,
  args: string[],
  flags: { project?: boolean; model?: string; from?: string; mark?: string; blank?: boolean; title?: string; description?: string; fallback?: string; persona?: string; instructions?: string; dryRun?: boolean },
  json: boolean,
  cwd: string,
): Promise<void> {
  const project = polyphemus.store.projectFor(cwd);
  const [action = 'ls', name, ...rest] = args;
  const target = () => {
    if (!flags.project) return libraryAgentsDir(polyphemus.home);
    if (!project) throw new PolyphemusError('You’re not in a project, so there’s nowhere to put a project agent.', 'USAGE', 'poly projects add .');
    return projectAgentsDir(project.path);
  };

  switch (action) {
    case 'ls': {
      const { agents, problems } = loadAgents(polyphemus.home, project?.path, project?.slug);
      if (json) return printJson({ agents, problems, library: libraryAgentsDir(polyphemus.home), project: project ? projectAgentsDir(project.path) : null });
      if (agents.length === 0) {
        console.log(dim('No agents yet. Make one: poly agents new <name> "what it’s for"'));
      } else {
        const width = Math.max(...agents.map((agent) => agent.name.length));
        for (const agent of agents) {
          const runs = agent.model === FOLLOW_DEFAULT ? dim(`the default (${polyphemus.config.defaultModel ?? 'none set'})`) : (agent.model ?? dim('the session’s model'));
          console.log(`${bold(agent.name.padEnd(width))}  ${dim(agent.scope.padEnd(7))} ${agent.description}  ${dim('·')} ${runs}`);
        }
        console.log(dim(`\nStart a session with one: polyphemus -a ${agents[0]!.name}`));
      }
      for (const problem of problems) console.log(`${yellow('•')} ${problem.file}: ${problem.message}`);
      return;
    }
    case 'templates': {
      const shipped = templates('agents');
      if (json) return printJson({ templates: shipped.map(({ kind: _kind, dir: _dir, ...t }) => t) });
      const width = Math.max(...shipped.map((t) => t.name.length));
      for (const t of shipped) console.log(`${bold(t.name.padEnd(width))}  ${t.description}`);
      console.log(dim(`\nMake one yours: poly agents new <name> --from ${shipped[0]?.name ?? '<template>'}`));
      return;
    }
    case 'new': {
      if (!name) {
        throw new PolyphemusError('Usage: poly agents new <name> [what it’s for…] [--from <template>] [--model <model>] [--mark <shape/colour>] [--project]', 'USAGE');
      }
      const description = rest.join(' ').trim();
      const mark = flags.mark ? parseMark(flags.mark, name) : undefined;
      // Only onto a model on your list: an agent made on another would run up a bill nobody chose.
      if (flags.model && flags.model !== FOLLOW_DEFAULT) {
        const why = offList(polyphemus.config, resolveModel(polyphemus.config, flags.model));
        if (why) throw new PolyphemusError(why, 'USAGE');
      }
      // From a template: a copy that's yours from then on, renamed to what you called it.
      const file = flags.from
        ? createFromTemplate('agents', flags.from, target(), name)
        : createAgent(target(), name, { description, model: flags.model ?? polyphemus.config.defaultModel, ...(mark ? { mark } : {}) });
      // A copy of a template keeps a model too: the one asked for, else today's default.
      const kept = flags.model ?? polyphemus.config.defaultModel;
      if (flags.from && kept) {
        const copied = loadAgents(polyphemus.home, project?.path, project?.slug).agents.find((a) => a.name === name);
        if (copied) updateAgent(copied, { model: kept });
      }
      // A template brings its own persona; a sentence is what needs writing up. It's the
      // sentence, not a blank page, that the agent starts from — but the agent exists either way.
      const canDraft = !flags.from && !flags.blank && description.length > 0 && draftingModel(polyphemus, flags.model) !== undefined;
      const agent = canDraft ? loadAgents(polyphemus.home, project?.path, project?.slug).agents.find((a) => a.name === name) : undefined;
      if (!json && agent) process.stderr.write(dim(`Writing ${name}’s persona from what you said…`));
      const draft = agent ? await draftPersona(polyphemus, agent) : undefined;
      if (!json && agent) process.stderr.write(`\r${' '.repeat(48)}\r`);
      if (json) return printJson({ name, file, from: flags.from ?? null, drafted: draft !== undefined });
      console.log(`${green('✓')} ${file}`);
      console.log(
        flags.from ? dim(`Copied from the ${flags.from} template. Edit it to suit you, then: polyphemus -a ${name}`)
        : draft ? dim(`Its persona and instructions are written from what you said — read them with poly agents show ${name}, then: polyphemus -a ${name}`)
        : dim(`Fill in persona.md (who it is) and instructions.md (what it does here), then: polyphemus -a ${name}`),
      );
      return;
    }
    case 'show': {
      if (!name) throw new PolyphemusError('Usage: poly agents show <name>', 'USAGE');
      const agent = resolveAgent(polyphemus, name, cwd);
      if (json) return printJson({ ...agent, settings: readFileSync(agent.file, 'utf8') });
      console.log(`${cyan(agent.dir)}  ${dim(agent.scope)}\n`);
      console.log(readFileSync(agent.file, 'utf8').trim());
      if (agent.persona) console.log(`\n${dim('── persona')}\n${agent.persona}`);
      if (agent.instructions) console.log(`\n${dim('── instructions')}\n${agent.instructions}`);
      return;
    }
    case 'edit': {
      // Changing an agent without hand-editing its files: each value is checked (a model has to be
      // on your list), and only what's named changes. Text comes from a file, or "-" for stdin.
      if (!name) throw new PolyphemusError('Usage: poly agents edit <name> [--title …] [--description …] [--model …] [--fallback a,b] [--mark shape/colour] [--persona file|-] [--instructions file|-] [--dry-run]', 'USAGE', 'poly help agents edit');
      const agent = resolveAgent(polyphemus, name, cwd);
      const listed = (ref: string) => {
        if (ref === FOLLOW_DEFAULT) return ref;
        const why = offList(polyphemus.config, resolveModel(polyphemus.config, ref));
        if (why) throw new PolyphemusError(why, 'USAGE');
        return ref;
      };
      const text = (value: string) => (value === '-' ? readFileSync(0, 'utf8') : readFileSync(value, 'utf8'));
      const fields: Parameters<typeof updateAgent>[1] = {
        ...(flags.title !== undefined && { title: flags.title }),
        ...(flags.description !== undefined && { description: flags.description }),
        ...(flags.model !== undefined && { model: flags.model ? listed(flags.model) : null }),
        ...(flags.fallback !== undefined && { fallback: flags.fallback ? flags.fallback.split(',').map((ref) => listed(ref.trim())).filter(Boolean) : null }),
        ...(flags.mark !== undefined && { mark: parseMark(flags.mark, agent.name) }),
        ...(flags.persona !== undefined && { persona: text(flags.persona) }),
        ...(flags.instructions !== undefined && { instructions: text(flags.instructions) }),
      };
      const changed = Object.keys(fields);
      if (!changed.length) throw new PolyphemusError('Say what to change: --title, --description, --model, --fallback, --mark, --persona or --instructions.', 'USAGE', 'poly help agents edit');
      if (!flags.dryRun) updateAgent(agent, fields);
      if (json) return printJson({ name: agent.name, changed, dryRun: flags.dryRun === true });
      console.log(`${flags.dryRun ? dim('Would change') : green('✓ Changed')} ${agent.title}: ${changed.join(', ')}`);
      return;
    }
    default:
      throw new PolyphemusError(`Unknown agents command "${action}". Try: ls, new, show, edit, templates.`, 'USAGE', 'poly help agents new');
  }
}

/** `--mark hex/violet`, or just one of the two: the other half stays whatever the name gets. */
function parseMark(value: string, name: string): Mark {
  const parts = value.split(/[/,\s]+/).filter(Boolean).map((part) => part.toLowerCase());
  const base = defaultMark(name);
  let { shape, color } = base;
  for (const part of parts) {
    if (MARK_SHAPES.includes(part as MarkShape)) shape = part as MarkShape;
    else if (MARK_COLORS.includes(part as MarkColor)) color = part as MarkColor;
    else {
      throw new PolyphemusError(
        `"${part}" isn't a shape or a colour. Shapes: ${MARK_SHAPES.join(', ')}. Colours: ${MARK_COLORS.join(', ')}.`,
        'USAGE',
      );
    }
  }
  return { shape, color };
}
