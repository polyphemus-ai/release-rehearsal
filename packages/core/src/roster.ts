import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml, stringify } from 'smol-toml';
import { resolveModel, type Config, type ResolvedModel, projectStateDir } from './config.js';
import { EFFORTS, PolyphemusError, type Effort } from './types.js';
import { createInside, listInside, moveOutInside, readInside, readPlainFile, replaceInside } from './contained.js';

// Agents: an expert for a particular kind of work (docs/design/agents.md). An agent is a folder
// you can read, edit, diff, and share — not a row in a database — so "save as template" and a
// store are possible later without moving anything.
//
//   <scope>/agents/<name>/
//     agent.toml       what it is, its model route, its skills
//     persona.md       who it is and how it works
//     instructions.md  what it does here
//
// Two scopes, like skills: your library (~/.polyphemus/agents) everywhere, and a project's
// (.polyphemus/agents, safe to commit), which wins on a shared name. Channels, DMs, and a roster
// of several agents working together come with multiplayer.

export type AgentScope = 'library' | 'project';

/**
 * An agent's mark: a shape and a colour, the way you tell twenty agents apart in a list
 * (docs/design/agents.md). Names, not hex, so the file stays readable and the app decides how a
 * colour is actually painted. Pickable, with one derived from the name as the default — nobody
 * has to choose before they can start.
 */
export const MARK_SHAPES = ['circle', 'square', 'pill', 'diamond', 'hex', 'tri', 'cloud', 'drop'] as const;
export const MARK_COLORS = ['slate', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'violet', 'pink'] as const;
export type MarkShape = (typeof MARK_SHAPES)[number];
export type MarkColor = (typeof MARK_COLORS)[number];
export interface Mark {
  shape: MarkShape;
  color: MarkColor;
}

/** The mark a name gets when nobody picked one: stable, so it never changes under you. */
export function defaultMark(name: string): Mark {
  // Two different sums, so shape and colour don't move together across similar names.
  let shapeSum = 0;
  let colorSum = 0;
  for (let i = 0; i < name.length; i++) {
    shapeSum += name.charCodeAt(i);
    colorSum += name.charCodeAt(i) * (i + 1);
  }
  return { shape: MARK_SHAPES[shapeSum % MARK_SHAPES.length]!, color: MARK_COLORS[colorSum % MARK_COLORS.length]! };
}

/** TOML for a mark, as an inline table: mark = { shape = "hex", color = "violet" }. */
export const markToml = (mark: Mark): string => `{ shape = ${JSON.stringify(mark.shape)}, color = ${JSON.stringify(mark.color)} }`;

export interface Agent {
  /** A project's agent: the project's folder, which its files are read and written from, through no link. */
  root?: string;
  /**
   * The folder this agent's files are written from, through no link: its project, or — for one in
   * your library — polyphemus's own home. Reading a library agent still follows a link, because those
   * folders are yours to arrange; writing doesn't, so a link left there is replaced rather than
   * written through (fourth review, 2026-09-20).
   */
  writeRoot?: string;
  /**
   * Stable and scope-aware: a library agent's id is its name; a project's agent is `slug/name`,
   * so two projects can each have a `reviewer` without one answering for the other. This is what
   * threads, members and native CLI sessions store.
   */
  id: string;
  name: string;
  /** What it's for, in one line. */
  description: string;
  /** What to call it ("Builder"); defaults to its name. */
  title: string;
  /** How it's shown everywhere: the one it picked, or the one its name gets. */
  mark: Mark;
  /**
   * A model alias or provider:model: the model it was made with, kept when the default changes.
   * `"default"` means it follows polyphemus's default model on purpose (FOLLOW_DEFAULT). Unset — only
   * agents made before there was a default — means whatever the session would have used.
   */
  model?: string;
  /** Models to try, in order, when its own can't take a turn. */
  fallback?: string[];
  effort?: Effort;
  /** The skills it uses. Unset means every skill in scope. */
  skills?: string[];
  /** Who it is and how it works. */
  persona: string;
  /** What it does in this project. */
  instructions: string;
  scope: AgentScope;
  dir: string;
  file: string;
}

export interface AgentProblem {
  file: string;
  message: string;
}

export const AGENT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const SETTINGS = ['name', 'title', 'description', 'mark', 'model', 'fallback', 'effort', 'skills'];

/** What an agent is shown as when it hasn't said: "release-manager" → "Release Manager". */
export const titleFor = (name: string): string => name.replace(/(^|-)([a-z])/g, (_, dash: string, letter: string) => (dash ? ' ' : '') + letter.toUpperCase());

export const libraryAgentsDir = (home: string): string => join(home, 'agents');
export const projectAgentsDir = (projectRoot: string): string => join(projectStateDir(projectRoot), 'agents');

/** Every agent in play here, with any that couldn't be read. A project's agent wins on name. */
export function loadAgents(home: string, projectRoot?: string, projectSlug?: string): { agents: Agent[]; problems: AgentProblem[] } {
  const problems: AgentProblem[] = [];
  const found = new Map<string, Agent>();
  for (const [scope, dir] of [
    ['library', libraryAgentsDir(home)],
    ...(projectRoot ? [['project', projectAgentsDir(projectRoot)] as const] : []),
  ] as Array<[AgentScope, string]>) {
    for (const agent of readScope(scope, dir, problems, projectSlug, scope === 'project' ? projectRoot : undefined, home)) found.set(agent.name, agent);
  }
  return { agents: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

/** An agent's id from where it lives (see Agent.id). */
export const agentId = (name: string, projectSlug?: string): string => (projectSlug ? `${projectSlug}/${name}` : name);

/**
 * One agent by id, or by bare name as older threads stored it. `slug/name` is that project's
 * agent; a bare name is the project's own agent of that name when there is one (it wins in scope,
 * as it always did), else the library's.
 */
export function findAgent(home: string, projectRoot: string | undefined, ref: string | undefined, projectSlug?: string): Agent | undefined {
  if (!ref) return undefined;
  const { agents } = loadAgents(home, projectRoot, projectSlug);
  return agents.find((agent) => agent.id === ref) ?? agents.find((agent) => agent.name === ref);
}

function readScope(scope: AgentScope, dir: string, problems: AgentProblem[], projectSlug: string | undefined, root: string | undefined, home: string): Agent[] {
  // A project's agents are files its agents can write: listed and read from the project's folder,
  // through no link at any step (independent review, 2026-09-19).
  const entries = root ? listInside(root, dir) : existsSync(dir) ? readdirSync(dir) : [];
  const agents: Agent[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue;
    const folder = join(dir, entry);
    const file = join(folder, 'agent.toml');
    let text: string | undefined;
    if (root) {
      text = readInside(root, file);
      if (text === undefined) {
        if (listInside(root, folder).length) problems.push({ file: folder, message: 'has no agent.toml you can use (it’s missing, or a link), so it was skipped.' });
        continue;
      }
    } else {
      if (!statSync(folder).isDirectory()) continue;
      if (!existsSync(file)) {
        problems.push({ file: folder, message: 'has no agent.toml, so it was skipped.' });
        continue;
      }
      text = readPlainFile(file);
      if (text === undefined) {
        problems.push({ file, message: 'isn’t a plain file polyphemus can read, so it was skipped.' });
        continue;
      }
    }
    const agent = parseAgent(text, { name: entry, scope, dir: folder, file, projectSlug: scope === 'project' ? projectSlug : undefined, ...(root && { root }), writeRoot: root ?? home }, problems);
    if (agent) agents.push(agent);
  }
  return agents;
}

function parseAgent(text: string, where: { name: string; scope: AgentScope; dir: string; file: string; projectSlug?: string; root?: string; writeRoot?: string }, problems: AgentProblem[]): Agent | undefined {
  const fail = (message: string) => {
    problems.push({ file: where.file, message });
    return undefined;
  };
  let raw: Record<string, unknown>;
  try {
    raw = parseToml(text) as Record<string, unknown>;
  } catch (err) {
    return fail(`isn't valid TOML: ${(err as Error).message}`);
  }
  for (const key of Object.keys(raw)) if (!SETTINGS.includes(key)) return fail(`unknown setting "${key}" (use ${SETTINGS.join(', ')}).`);

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : where.name;
  if (!AGENT_NAME.test(name)) return fail(`"${name}" isn't an agent name: use lowercase letters, numbers, and dashes.`);
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description) return fail('needs a description: one line saying what this agent is for.');
  if (raw.effort !== undefined && !EFFORTS.includes(raw.effort as Effort)) return fail(`effort must be one of: ${EFFORTS.join(', ')}.`);
  const list = (value: unknown, key: string): string[] | undefined | null => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
      problems.push({ file: where.file, message: `${key} must be a list of names.` });
      return null;
    }
    return value as string[];
  };
  const fallback = list(raw.fallback, 'fallback');
  const skills = list(raw.skills, 'skills');
  if (fallback === null || skills === null) return undefined;

  let mark = defaultMark(name);
  if (raw.mark !== undefined) {
    const picked = raw.mark as Partial<Mark>;
    if (typeof picked !== 'object' || picked === null || Array.isArray(picked)) return fail('mark must be like: mark = { shape = "hex", color = "violet" }.');
    if (picked.shape !== undefined && !MARK_SHAPES.includes(picked.shape)) return fail(`mark shape must be one of: ${MARK_SHAPES.join(', ')}.`);
    if (picked.color !== undefined && !MARK_COLORS.includes(picked.color)) return fail(`mark colour must be one of: ${MARK_COLORS.join(', ')}.`);
    // Half a mark is allowed: pick a colour and keep the shape your name got.
    mark = { shape: picked.shape ?? mark.shape, color: picked.color ?? mark.color };
  }

  const read = (file: string) => (where.root ? readInside(where.root, join(where.dir, file)) ?? '' : existsSync(join(where.dir, file)) ? readFileSync(join(where.dir, file), 'utf8') : '').trim();
  return {
    ...(where.root && { root: where.root }),
    ...(where.writeRoot && { writeRoot: where.writeRoot }),
    id: agentId(name, where.projectSlug),
    name,
    description,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : name,
    mark,
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
    ...(fallback?.length ? { fallback } : {}),
    ...(raw.effort !== undefined ? { effort: raw.effort as Effort } : {}),
    ...(skills ? { skills } : {}),
    persona: read('persona.md'),
    instructions: read('instructions.md'),
    scope: where.scope,
    dir: where.dir,
    file: where.file,
  };
}

/**
 * What polyphemus says to an agent when a thread with it is first opened, so the agent speaks first
 * rather than leaving you looking at an empty box. The app knows this text and doesn't draw it:
 * it's polyphemus introducing you, not you saying something.
 */
export const INTRODUCE_YOURSELF_OPENING = "You've just been added to polyphemus and this is the first thing";
export const INTRODUCE_YOURSELF =
  `${INTRODUCE_YOURSELF_OPENING} anyone will see from you. Introduce yourself in one or two sentences — who you are and what you're for, in your own voice — then ask what they'd like to start with. No headings, no lists, no preamble about being an AI.`;

/**
 * The model an agent works on: its own, else whatever the session would have used, carrying its
 * fallbacks and effort. Routing, breakers, and capacity then treat it like any other model.
 */
export function agentModel(config: Config, agent: Agent, sessionModel: ResolvedModel): ResolvedModel {
  let base = sessionModel;
  if (agent.model === FOLLOW_DEFAULT) {
    if (config.defaultModel) base = resolveModel(config, config.defaultModel);
  } else if (agent.model) {
    try {
      base = resolveModel(config, agent.model);
    } catch (err) {
      throw new PolyphemusError(`${agent.name}'s model "${agent.model}" isn't set up: ${(err as Error).message}`, 'USAGE', `Fix model = in ${agent.file}`);
    }
  }
  return { ...base, ...(agent.fallback?.length ? { fallback: agent.fallback } : {}), ...(agent.effort ? { effort: agent.effort } : {}) };
}

/**
 * What an agent's `model` says when it follows the default rather than keeping its own. An agent
 * keeps the model it was made with (docs/design/roadmap.md): changing the default doesn't move it,
 * unless it says this.
 */
export const FOLLOW_DEFAULT = 'default';

/** Who the model is being, for its prompt. */
export function agentPrompt(agent: Agent): string {
  return [
    `<agent name="${agent.name}">`,
    `You are ${agent.title}${agent.title === agent.name ? '' : ` ("${agent.name}")`}, an agent in polyphemus. You are for: ${agent.description}`,
    agent.persona,
    agent.instructions ? `What you do here:\n${agent.instructions}` : '',
    'Stay in this role. If the work belongs to a different agent, say so rather than doing it yourself.',
    '</agent>',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Who a message is addressed to. In a thread with several agents, `@name` decides — polyphemus never
 * guesses, because guessing means the wrong agent answers in front of the others
 * (docs/design/agents.md: "who speaks when is explicit, never every agent answers everything").
 *
 * Matches an agent's name or its title, case-insensitively, so `@BD` and `@bd` both work.
 */
/**
 * The agent a reply plainly speaks to without an @: greeting them or putting something to them by
 * name ("Hey Riley —", "Riley, can you…", "Thanks, Riley!"), or handing over ("over to Riley", "your turn,
 * Riley"). Only when exactly one agent is spoken to that way, and never in code or quotes — talking
 * about someone ("Riley said…") isn't talking to them.
 */
export function spokenTo(text: string, members: readonly Agent[]): Agent | undefined {
  const spoken = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/["“][^"”\n]*["”]/g, ' ');
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = members.filter((agent) => {
    const names = [...new Set([agent.title, agent.name])].map(escape).join('|');
    const greeting = new RegExp(`(^|[\\n.!?]\\s*)(?:(?:hey|hi|hello|thanks|thank you|ok|okay|so|yes|yeah|right|great|good)[,!]?\\s+)?(?:${names})\\s*[,—–:!?]`, 'i');
    const handing = new RegExp(`\\b(?:over to|your turn,?|back to you,?|handing (?:it |this )?(?:over )?to|passing (?:it |this )?to)\\s+(?:${names})\\b`, 'i');
    const closing = new RegExp(`[,—–]\\s*(?:${names})\\s*[.!?]\\s*$`, 'im');
    return greeting.test(spoken) || handing.test(spoken) || closing.test(spoken);
  });
  return found.length === 1 ? found[0] : undefined;
}

export function addressedTo(text: string, members: readonly Agent[]): Agent[] {
  // Only a mention in the words themselves: "send `@Helm`" or a quote tells someone what to type,
  // it doesn't hand the turn to Helm.
  const spoken = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/["“]\s*@[\w-]+[^"”\n]*["”]/g, ' ');
  const mentions = [...spoken.matchAll(/(?:^|[^\w@])@([\w-]+)/g)].map((m) => m[1]!.toLowerCase());
  if (mentions.length === 0) return [];
  const found: Agent[] = [];
  for (const mention of mentions) {
    const agent = members.find((a) => a.name.toLowerCase() === mention || a.title.toLowerCase() === mention);
    if (agent && !found.includes(agent)) found.push(agent);
  }
  return found;
}

/**
 * Saves changes to an agent: persona and instructions whole, description and model line by line,
 * so the file keeps its comments and shape when it's edited from the app.
 */
export function updateAgent(
  agent: Agent,
  fields: { description?: string; title?: string; model?: string | null; fallback?: string[] | null; persona?: string; instructions?: string; mark?: Mark | null },
): void {
  // A project's agent lives where the project's agents write, and a library one in polyphemus's own
  // home: either way a link standing there is replaced, never written through.
  const from = agent.writeRoot ?? agent.root;
  const put = (file: string, text: string) => {
    if (!from) return writeFileSync(file, text);
    try {
      replaceInside(from, file, Buffer.from(text));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ELINK') throw err;
      throw new PolyphemusError(`${file} goes through a link, so polyphemus won’t write it there. Move the agent’s folder in, or edit the file yourself.`, 'CONFLICT');
    }
  };
  if (fields.persona !== undefined) put(join(agent.dir, 'persona.md'), `${fields.persona.trim()}\n`);
  if (fields.instructions !== undefined) put(join(agent.dir, 'instructions.md'), `${fields.instructions.trim()}\n`);
  if (fields.description === undefined && fields.title === undefined && fields.model === undefined && fields.fallback === undefined && fields.mark === undefined) return;
  const current = agent.root ? readInside(agent.root, agent.file) : readPlainFile(agent.file);
  if (current === undefined) throw new PolyphemusError(`${agent.file} is a link, so polyphemus won’t change it.`, 'CONFLICT');
  let text = current;
  if (fields.description !== undefined) {
    const description = fields.description.trim();
    if (!description) throw new PolyphemusError('An agent needs a description: one line saying what it’s for.', 'USAGE');
    text = setSetting(text, 'description', description);
  }
  // Empty puts it back to the one made from its name ("release-manager" → "Release Manager"),
  // which is what you want for a word and not for an acronym.
  if (fields.title !== undefined) {
    const title = fields.title.trim();
    text = title ? setSetting(text, 'title', title) : setSetting(text, 'title', titleFor(agent.name));
  }
  // null clears it: back to whatever model the session would have used.
  if (fields.model !== undefined) text = fields.model ? setSetting(text, 'model', fields.model) : clearSetting(text, 'model');
  // What to try when its own model can't take a turn (docs/design/routing.md). Empty clears it.
  if (fields.fallback !== undefined) {
    const list = (fields.fallback ?? []).map((ref) => ref.trim()).filter(Boolean);
    text = list.length ? setSetting(text, 'fallback', `[${list.map((ref) => JSON.stringify(ref)).join(', ')}]`, { raw: true }) : clearSetting(text, 'fallback');
  }
  // null here is "reset to default": the mark its name gets, with nothing left in the file.
  if (fields.mark !== undefined) {
    if (fields.mark && !MARK_SHAPES.includes(fields.mark.shape)) throw new PolyphemusError(`A mark's shape must be one of: ${MARK_SHAPES.join(', ')}.`, 'USAGE');
    if (fields.mark && !MARK_COLORS.includes(fields.mark.color)) throw new PolyphemusError(`A mark's colour must be one of: ${MARK_COLORS.join(', ')}.`, 'USAGE');
    text = fields.mark ? setSetting(text, 'mark', markToml(fields.mark), { raw: true }) : clearSetting(text, 'mark');
  }
  put(agent.file, text);
}

/**
 * Replaces the setting's line, or turns its commented-out example into the real thing.
 * `raw` means the value is already TOML (an inline table, say) rather than a string to quote.
 */
function setSetting(text: string, key: string, value: string, opts: { raw?: boolean } = {}): string {
  const line = `${key} = ${opts.raw ? value : JSON.stringify(value)}`;
  const existing = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'm');
  if (existing.test(text)) return text.replace(existing, line);
  const commented = new RegExp(`^[ \\t]*#[ \\t]*${key}[ \\t]*=.*$`, 'm');
  if (commented.test(text)) return text.replace(commented, line);
  return `${text.replace(/\n*$/, '\n')}${line}\n`;
}

const clearSetting = (text: string, key: string): string => text.replace(new RegExp(`^[ \\t]*${key}[ \\t]*=.*\\n`, 'm'), '');

/** Writes a new agent folder. Returns its agent.toml. */
export function createAgent(dir: string, name: string, opts: { description?: string; title?: string; model?: string; mark?: Mark } = {}, root = dir): string {
  if (!AGENT_NAME.test(name)) throw new PolyphemusError(`"${name}" isn't an agent name: use lowercase letters, numbers, and dashes, like reviewer.`, 'USAGE');
  const folder = join(dir, name);
  const file = join(folder, 'agent.toml');
  if (existsSync(file)) throw new PolyphemusError(`${file} already exists.`, 'CONFLICT');
  // Every file made new, from `root`, through no link: a project's agents folder is its agents' to
  // prepare, links and all (third review, 2026-09-19).
  const writeFileSync = (path: string, text: string) => {
    try {
      createInside(root, path, Buffer.from(text));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ELINK') throw new PolyphemusError(`${folder} already has something in it, or goes through a link: pick another name.`, 'CONFLICT');
      throw err;
    }
  };
  const settings = {
    name,
    title: opts.title ?? titleFor(name),
    description: opts.description || 'One line saying what this agent is for.',
    ...(opts.model ? { model: opts.model } : {}),
  };
  // The mark is only written when it was picked; without it, the name's own mark is used, and
  // stays right if the file is copied somewhere else or renamed.
  const mark = opts.mark ? `mark = ${markToml(opts.mark)}\n` : '';
  writeFileSync(
    file,
    `# What this agent is, and what it runs on. Safe to commit: no secrets go here.\n${stringify(settings)}\n${mark}\n# model = "default"         # follow polyphemus's default model instead of keeping this one\n# fallback = ["codex"]      # what to try when that one can't take a turn\n# skills = ["review-pr"]    # only these skills; leave it out for every skill in scope\n`,
  );
  writeFileSync(join(folder, 'persona.md'), `# ${settings.title}\n\n<!-- Who this agent is and how it works: its voice, what it insists on, what it refuses. -->\n`);
  writeFileSync(join(folder, 'instructions.md'), `# What ${settings.title} does here\n\n<!-- The work it takes on, how to do it, and where to stop. -->\n`);
  return file;
}

/**
 * Deletes an agent: its folder moves to polyphemus's trash (~/.polyphemus/trash/agents), so a mistake can be
 * put back by hand, and nothing else refers to it once the caller has detached it from threads.
 */
export function deleteAgent(home: string, agent: Agent): string {
  const trash = join(home, 'trash', 'agents');
  mkdirSync(trash, { recursive: true });
  const to = join(trash, `${agent.id.replaceAll('/', '--')}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  // A project's agent is moved from the project's folder, through no link: never a folder the link pointed at.
  if (agent.root) {
    moveOutInside(agent.root, agent.dir, to);
    return to;
  }
  try {
    renameSync(agent.dir, to);
  } catch {
    // A project on another disk: copy, then remove.
    cpSync(agent.dir, to, { recursive: true });
    rmSync(agent.dir, { recursive: true, force: true });
  }
  return to;
}
