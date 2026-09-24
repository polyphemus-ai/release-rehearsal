import { createHash } from 'node:crypto';
import { projectStateDir } from './config.js';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { Cron } from 'croner';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { expandHome } from './projects.js';
import type { ProjectMeta, SessionStore } from './session/store.js';
import { PolyphemusError } from './types.js';
import { listInside, readInside } from './contained.js';

// Routines: prompts that run on a schedule (docs/design/scheduling.md). A routine is a markdown
// file with settings at the top, in a project's .polyphemus/routines/ or in ~/.polyphemus/routines/.
// Each firing runs as a fresh thread; successful runs stay quiet.

export type Trigger = { kind: 'cron'; expr: string; tz?: string } | { kind: 'every'; ms: number; text: string } | { kind: 'once'; at: number };

export interface Routine {
  /** "<project>/<name>", or "~/<name>" for a routine in ~/.polyphemus/routines/. */
  id: string;
  name: string;
  file: string;
  project?: string;
  cwd: string;
  /** A model alias or provider:model; unset means the default model (or the agent's). */
  model?: string;
  /** The agent that does it, by id; unset means a bare model. */
  agent?: string;
  prompt: string;
  triggers: Trigger[];
  /** read-only: never asks; anything that would change something is declined. Best for briefs and reports. */
  mode: 'ask' | 'yolo' | 'read-only';
  /** When it's time to run but the last run is still going. */
  overlap: 'skip' | 'allow';
  /** After polyphemus was off: run the latest missed time once, or skip what was missed. */
  catchup: 'latest' | 'skip';
  maxRunsPerDay?: number;
  notify: Array<'failure' | 'finish'>;
  enabled: boolean;
  /** A digest of the file as read: what a person accepts, so a changed file waits for them again. */
  digest?: string;
  /** The file as it was read, which is what its digest is of. */
  source?: string;
}

export interface RoutineProblem {
  file: string;
  message: string;
}

export interface Firing {
  trigger: Trigger;
  slot: number;
}

const SETTINGS = ['name', 'description', 'agent', 'model', 'triggers', 'mode', 'overlap', 'catchup', 'max_runs_per_day', 'notify', 'enabled', 'project', 'folder'];
const TRIGGER_KEYS = ['cron', 'tz', 'every', 'once'];
const MIN_INTERVAL_MS = 60_000;
/** A firing this close to now runs even with catchup: skip. */
const GRACE_MS = 2 * 60_000;
/** catchup: latest runs a missed time only if it's at most this old. */
const CATCHUP_WINDOW_MS = 6 * 60 * 60_000;

function parseDuration(text: string): number | undefined {
  const match = /^(\d+)\s*(s|m|h|d)$/.exec(text.trim());
  if (!match) return undefined;
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as 's' | 'm' | 'h' | 'd'];
}

function parseTrigger(value: unknown, fail: (message: string) => never): Trigger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('write it as { cron: "30 8 * * 1-5" }, { every: 30m }, or { once: "2026-09-12 08:00" }.');
  const t = value as Record<string, unknown>;
  for (const key of Object.keys(t)) if (!TRIGGER_KEYS.includes(key)) fail(`unknown key "${key}" (use cron, tz, every, or once).`);
  if (t.cron !== undefined) {
    const expr = String(t.cron);
    const tz = t.tz === undefined ? undefined : String(t.tz);
    try {
      new Cron(expr, { timezone: tz, paused: true }).nextRun();
    } catch (err) {
      fail(`cron "${expr}"${tz ? ` in ${tz}` : ''}: ${(err as Error).message}`);
    }
    return { kind: 'cron', expr, ...(tz && { tz }) };
  }
  if (t.every !== undefined) {
    const text = String(t.every);
    const ms = parseDuration(text);
    if (ms === undefined) fail(`every: "${text}" should look like 30m, 2h, or 1d.`);
    if (ms! < MIN_INTERVAL_MS) fail('every must be at least 1m.');
    return { kind: 'every', ms: ms!, text };
  }
  if (t.once !== undefined) {
    const at = t.once instanceof Date ? t.once.getTime() : Date.parse(String(t.once).trim().replace(' ', 'T'));
    if (Number.isNaN(at)) fail(`once: "${String(t.once)}" isn't a date and time, like "2026-09-12 08:00".`);
    return { kind: 'once', at };
  }
  return fail('each trigger needs cron, every, or once.');
}

/** Reads one routine file. Throws a PolyphemusError that says exactly what to fix. */
export function parseRoutine(text: string, file: string, where: { project?: ProjectMeta; findProject?: (slug: string) => ProjectMeta | undefined }): Routine {
  const fail = (message: string): never => {
    throw new PolyphemusError(`${file}: ${message}`, 'USAGE');
  };
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return fail('start with a --- block of settings (triggers, and optionally model, mode, …), then the prompt below it.');
  let front: unknown;
  try {
    front = parseYaml(match[1]!);
  } catch (err) {
    return fail(`the settings aren’t valid YAML: ${(err as Error).message.split('\n')[0]}`);
  }
  if (!front || typeof front !== 'object' || Array.isArray(front)) return fail('the settings block must be key: value lines.');
  const f = front as Record<string, unknown>;
  for (const key of Object.keys(f)) if (!SETTINGS.includes(key)) fail(`unknown setting "${key}". Known settings: ${SETTINGS.join(', ')}.`);

  const name = f.name === undefined ? basename(file, '.md') : String(f.name);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) fail(`name "${name}" should be lowercase letters, numbers, and dashes.`);
  const prompt = match[2]!.trim();
  if (!prompt) fail('write what the routine should do below the settings block.');
  if (!Array.isArray(f.triggers) || f.triggers.length === 0) fail('add at least one trigger, e.g. triggers: [{ every: 30m }] or [{ cron: "30 8 * * 1-5" }].');
  const triggers = (f.triggers as unknown[]).map((t, i) => parseTrigger(t, (message) => fail(`trigger ${i + 1}: ${message}`)));

  const oneOf = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = f[key] ?? fallback;
    if (!allowed.includes(value as T)) fail(`${key} must be ${allowed.join(' or ')}.`);
    return value as T;
  };
  const mode = oneOf('mode', ['ask', 'yolo', 'read-only'] as const, 'ask');
  const overlap = oneOf('overlap', ['skip', 'allow'] as const, 'skip');
  const catchup = oneOf('catchup', ['latest', 'skip'] as const, 'latest');
  const notify = f.notify === undefined ? ['failure' as const] : f.notify;
  if (!Array.isArray(notify) || !notify.every((n) => n === 'failure' || n === 'finish')) fail('notify must be a list of failure and/or finish, e.g. [failure].');
  const max = f.max_runs_per_day;
  if (max !== undefined && !(Number.isInteger(max) && (max as number) > 0)) fail('max_runs_per_day must be a whole number above 0.');
  if (f.enabled !== undefined && typeof f.enabled !== 'boolean') fail('enabled must be true or false.');
  if (f.model !== undefined && typeof f.model !== 'string') fail('model must be a model name, like claude or codex.');
  if (f.agent !== undefined && (typeof f.agent !== 'string' || !f.agent)) fail('agent must be an agent’s name, like builder.');

  // Where it runs: its project, or (for ~/.polyphemus/routines) the project or folder it names.
  let project = where.project;
  let cwd = project?.path;
  if (project && (f.project !== undefined || f.folder !== undefined)) fail('this routine lives in a project already: remove project/folder.');
  if (!project) {
    if (typeof f.project === 'string') {
      project = where.findProject?.(f.project);
      if (!project) fail(`there's no project called "${f.project}" (see: poly projects).`);
      cwd = project!.path;
    } else if (typeof f.folder === 'string') {
      cwd = resolve(expandHome(f.folder));
      if (!isAbsolute(cwd)) fail('folder must be a full path, like ~/code/thing.');
    } else {
      fail('say where it runs: project: <name>, or folder: ~/path.');
    }
  }

  return {
    id: `${where.project?.slug ?? '~'}/${name}`,
    name,
    file,
    ...(project && { project: project.slug }),
    cwd: cwd!,
    ...(typeof f.model === 'string' && { model: f.model }),
    ...(typeof f.agent === 'string' && { agent: f.agent }),
    prompt,
    triggers,
    mode,
    overlap,
    catchup,
    ...(max !== undefined && { maxRunsPerDay: max as number }),
    notify: notify as Routine['notify'],
    enabled: f.enabled !== false,
  };
}

/** What a person accepts of a routine: its file exactly as it is. */
export const routineDigest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** Every routine polyphemus can see: each active project's .polyphemus/routines/, then ~/.polyphemus/routines/. */
export function loadRoutines(home: string, store: SessionStore): { routines: Routine[]; problems: RoutineProblem[] } {
  const routines: Routine[] = [];
  const problems: RoutineProblem[] = [];
  // A project's routines are listed and read from the project's folder, through no link at any step:
  // its .polyphemus/routines is the agents' to write. ~/.polyphemus/routines is polyphemus's own.
  const read = (dir: string, project?: ProjectMeta) => {
    const entries = project ? listInside(project.path, dir) : existsSync(dir) ? readdirSync(dir) : [];
    for (const entry of entries.filter((name) => name.endsWith('.md')).sort()) {
      const file = join(dir, entry);
      try {
        const text = project ? readInside(project.path, file) : readFileSync(file, 'utf8');
        if (text === undefined) throw new Error(`${file} is a link, so it was skipped.`);
        // What was read is what's shown and accepted: never read again.
        const routine = { ...parseRoutine(text, file, { project, findProject: (slug) => store.project(slug) }), digest: routineDigest(text), source: text };
        if (routines.some((r) => r.id === routine.id)) problems.push({ file, message: `${file}: another routine here is already named "${routine.name}".` });
        else routines.push(routine);
      } catch (err) {
        problems.push({ file, message: (err as Error).message });
      }
    }
  };
  for (const project of store.projects(['active'])) read(join(projectStateDir(project.path), 'routines'), project);
  read(join(home, 'routines'));
  return { routines, problems };
}

/** The next time a trigger fires after `after`, if it ever does again. */
export function nextFire(trigger: Trigger, after: number): number | undefined {
  switch (trigger.kind) {
    case 'cron':
      return new Cron(trigger.expr, { timezone: trigger.tz, paused: true }).nextRun(new Date(after))?.getTime();
    case 'every':
      // Slots line up with the clock (every 30m: :00 and :30), so the same slot is the same slot everywhere.
      return (Math.floor(after / trigger.ms) + 1) * trigger.ms;
    case 'once':
      return trigger.at > after ? trigger.at : undefined;
  }
}

/** The routine's next run after `after`, across all its triggers. */
export function nextRoutineFire(routine: Routine, after: number): number | undefined {
  const times = routine.triggers.map((t) => nextFire(t, after)).filter((t): t is number => t !== undefined);
  return times.length ? Math.min(...times) : undefined;
}

/** The next `count` runs, for "when will it run?" */
export function upcomingFires(routine: Routine, after: number, count: number): number[] {
  const out: number[] = [];
  for (let at = after; out.length < count; ) {
    const next = nextRoutineFire(routine, at);
    if (next === undefined) break;
    out.push(next);
    at = next;
  }
  return out;
}

function slotsBetween(trigger: Trigger, from: number, to: number, limit = 1000): number[] {
  const slots: number[] = [];
  for (let next = nextFire(trigger, from); next !== undefined && next <= to && slots.length < limit; next = nextFire(trigger, next)) slots.push(next);
  return slots;
}

/**
 * What to do with the schedule between `since` and `now`: at most one run (the latest time that's
 * due), and how many times were missed, e.g. while polyphemus was off.
 */
export function dueFiring(routine: Routine, since: number, now: number): { run?: Firing; missed: number } {
  const due = routine.triggers.flatMap((trigger) => slotsBetween(trigger, since, now).map((slot) => ({ trigger, slot }))).sort((a, b) => a.slot - b.slot);
  const latest = due.at(-1);
  if (!latest) return { missed: 0 };
  const age = now - latest.slot;
  const run = age <= GRACE_MS || (routine.catchup === 'latest' && age <= CATCHUP_WINDOW_MS) ? latest : undefined;
  return { run, missed: due.length - (run ? 1 : 0) };
}

/** A trigger in words: 'cron "30 8 * * 1-5" (America/Chicago)', 'every 30m', 'once at …'. */
export function describeTrigger(trigger: Trigger): string {
  if (trigger.kind === 'cron') return `cron "${trigger.expr}"${trigger.tz ? ` (${trigger.tz})` : ''}`;
  if (trigger.kind === 'every') return `every ${trigger.text}`;
  return `once at ${new Date(trigger.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

/** What an agent proposes: a routine for its project, run by an agent, asking first or only reading. */
export interface RoutineProposal {
  name: string;
  description?: string;
  agent?: string;
  schedule: { cron?: string; tz?: string; every?: string; once?: string };
  prompt: string;
  mode: 'ask' | 'read-only';
  /** Whose it is: the project's (the default in one), or the person's own, outside every project. */
  scope?: 'project' | 'personal';
  /** Stop the routine with this name, rather than make or change one. */
  stop?: boolean;
}

/** A proposal's name as a file name: lowercase words joined by dashes. */
export const routineSlug = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Where a project's routine of that name lives. */
export const projectRoutineFile = (project: ProjectMeta, name: string) => join(projectStateDir(project.path), 'routines', `${routineSlug(name)}.md`);

/**
 * A routine's file with some of its settings changed, leaving the rest of the file — the prompt, the
 * comments, the order of what's already there — alone. What it asks before doing, and whether a
 * clean run says so, are things a person decides, and deciding them shouldn't mean editing YAML
 * (2026-09-20).
 */
export function withRoutineSettings(text: string, changes: { mode?: Routine['mode']; notify?: Routine['notify'] }): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new PolyphemusError('That routine’s file doesn’t start with a --- block of settings.', 'USAGE');
  const front = (parseYaml(match[1]!) ?? {}) as Record<string, unknown>;
  if (changes.mode !== undefined) front.mode = changes.mode;
  if (changes.notify !== undefined) front.notify = changes.notify;
  return `---\n${stringifyYaml(front).trimEnd()}\n---\n${match[2]!.replace(/^\n+/, '')}`;
}

/** Where a routine that belongs to no project lives: polyphemus's own folder, beside the projects'. */
export const homeRoutineFile = (home: string, name: string) => join(home, 'routines', `${routineSlug(name)}.md`);

/**
 * A proposal written out as the routine file a person would write, and checked the same way. Never
 * `yolo`: a routine that runs without asking is a person's choice to make in the file themselves.
 * With no project it belongs to the install, which is where a thread outside every project puts it.
 */
export function routineFromProposal(where: { project?: ProjectMeta; home: string; cwd?: string }, proposal: RoutineProposal): { text: string; file: string; routine: Routine } {
  const name = routineSlug(proposal.name);
  if (!name) throw new PolyphemusError('Give the routine a name.', 'USAGE');
  if (!proposal.prompt.trim()) throw new PolyphemusError('Say what the routine should do each time it runs.', 'USAGE');
  const trigger = Object.fromEntries(Object.entries(proposal.schedule).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, String(v).trim()]));
  const front: Record<string, unknown> = {
    ...(proposal.description?.trim() && { description: proposal.description.trim() }),
    ...(proposal.agent && { agent: proposal.agent }),
    // With no project it still has to run somewhere, and that's the folder the thread proposing it
    // works in — polyphemus's to say, not the model's.
    ...(!where.project && { folder: where.cwd ?? where.home }),
    mode: proposal.mode === 'read-only' ? 'read-only' : 'ask',
    triggers: [trigger],
    notify: ['failure'],
  };
  const text = `---\n${stringifyYaml(front).trimEnd()}\n---\n${proposal.prompt.trim()}\n`;
  const file = where.project ? projectRoutineFile(where.project, name) : homeRoutineFile(where.home, name);
  return { text, file, routine: parseRoutine(text, file, where.project ? { project: where.project } : {}) };
}
