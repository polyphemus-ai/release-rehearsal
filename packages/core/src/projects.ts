import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'smol-toml';
import type { ProjectMeta, SessionStore } from './session/store.js';
import { PolyphemusError } from './types.js';
import { createInside, existsInside, fileInside, folderInside, listInside, readBytesInside, readInside, removeInside, replaceInside } from './contained.js';

// A project is a folder polyphemus knows about, plus the context agents need to work in it.
// What's safe to commit lives in the folder (AGENTS.md, .polyphemus/); memory stays private in
// ~/.polyphemus/memory/projects/<slug>/. See docs/design/projects.md.

const run = promisify(execFile);

export interface ProjectSetup {
  project: ProjectMeta;
  /** Files polyphemus wrote. Anything already there is left alone. */
  created: string[];
}

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * Starts a project in `root`: a plain folder, a git repo (`git`), or a clone of `from`.
 * A project isn't only code (docs/design/projects.md), so a repo nobody asked for isn't made.
 * `home` is the polyphemus home, where the project's memory goes.
 */
export async function createProject(
  store: SessionStore,
  home: string,
  root: string,
  spec: { name: string; about?: string; from?: string; git?: boolean; clone?: { url: string; env: NodeJS.ProcessEnv } },
): Promise<ProjectSetup> {
  const name = spec.name.trim();
  const slug = checkSlug(store, name);
  const path = join(resolve(expandHome(root)), slug);
  if (existsSync(path)) throw new PolyphemusError(`${path} already exists. To use that folder, add it instead: poly projects add ${path}`);
  if (spec.from) {
    const githubWeb = process.env.POLYPHEMUS_GITHUB_WEB;
    if (!/^(https:\/\/|ssh:\/\/|git@|file:\/\/|\/)/.test(spec.from) && !(githubWeb && spec.from.startsWith(githubWeb))) throw new PolyphemusError('Clone from a git URL, like https://github.com/you/repo.');
    mkdirSync(dirname(path), { recursive: true });
    try {
      // Cloned as one of polyphemus's GitHub identities when one can read it: its token only reaches that
      // git process, and the copy's origin is the address you gave, with nothing secret in it.
      if (spec.clone) {
        await run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', 'clone', '--quiet', spec.clone.url, path], { timeout: 10 * 60_000, env: spec.clone.env });
        await run('git', ['-C', path, 'remote', 'set-url', 'origin', spec.from]);
      } else await run('git', ['clone', '--quiet', spec.from, path], { timeout: 10 * 60_000 });
    } catch (err) {
      throw new PolyphemusError(`Couldn’t clone ${spec.from}: ${gitError(err)}`);
    }
  } else {
    mkdirSync(path, { recursive: true });
    if (spec.git) await run('git', ['init', '--quiet', '--initial-branch=main', path]);
  }
  return register(store, home, { slug, name, path, description: spec.about?.trim() ?? '' });
}

/** Adds a folder that already exists, wherever it is, leaving everything already in it alone. */
export function addProject(store: SessionStore, home: string, folder: string, opts: { name?: string; about?: string } = {}): ProjectSetup {
  const path = resolve(expandHome(folder));
  if (!existsSync(path)) throw new PolyphemusError(`${path} doesn’t exist.`);
  const existing = store.projects().find((project) => project.path === path);
  if (existing) throw new PolyphemusError(`${path} is already the project "${existing.slug}".`);
  const name = opts.name?.trim() || basename(path);
  return register(store, home, { slug: checkSlug(store, name), name, path, description: opts.about?.trim() ?? '' });
}

function checkSlug(store: SessionStore, name: string): string {
  const slug = slugify(name);
  if (!slug) throw new PolyphemusError('Give the project a name with some letters or numbers in it.');
  if (store.project(slug)) throw new PolyphemusError(`There’s already a project called "${slug}".`);
  return slug;
}

function register(store: SessionStore, home: string, project: Omit<ProjectMeta, 'status' | 'createdAt'>): ProjectSetup {
  const created = [...scaffold(project.path, project.name, project.description), ...memoryFolder(home, project.slug, project.name)];
  return { project: store.addProject(project), created };
}

/** The files any agent (polyphemus, Codex, Claude Code, Grok, Cursor) reads to orient. Never overwrites. */
function scaffold(path: string, name: string, about: string): string[] {
  const created: string[] = [];
  // Made new from the project's folder, through no link: a cloned or existing folder can hold a
  // dangling link where AGENTS.md would go (third review, 2026-09-19). Anything there is left alone.
  const write = (file: string, content: string) => {
    const full = join(path, file);
    try {
      createInside(path, full, Buffer.from(content));
      created.push(full);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ELINK') throw err;
    }
  };
  write('AGENTS.md', agentsTemplate(name, about, looksLikeCode(path)));
  // No CLAUDE.md: polyphemus hands AGENTS.md to Claude Code itself, so Claude Code run outside
  // polyphemus (say, the one building polyphemus) isn't changed by a project's setup.
  write(
    '.polyphemus/project.toml',
    `# polyphemus settings for this project. Safe to commit: no secrets go here.\n${stringify({ name, ...(about && { description: about }) })}\n`,
  );
  return created;
}

/** Left in the template until a person or an orientation session writes the real thing. */
const TEMPLATE_MARKER = '<!-- polyphemus wrote this file when the project was set up.';
/** The marker before projects stopped being only code; still recognised on older projects. */
const LEGACY_TEMPLATE_MARKER = '<!-- Exact commands to install, build, test, run, and deploy.';

/**
 * A project isn't only code, so neither is its AGENTS.md: a folder of documents gets asked how
 * the work is done, not which scripts to run. Only the heading differs — everything reads this
 * file the same way.
 */
function agentsTemplate(name: string, about: string, code: boolean): string {
  return `# ${name}

${about || '_What this project is and who it’s for, in a sentence or two._'}

${
  code
    ? `## Commands

<!-- Exact commands to install, build, test, run, and deploy. Agents run these as written. -->`
    : `## How the work is done

<!-- The steps, tools and services this work runs through, in order. -->`
}

## Layout

<!-- Where the important things live. -->

## Rules

<!-- Conventions to follow, and things never to do. -->

${TEMPLATE_MARKER} Replace it, or have an agent
     draft it for you: poly projects orient.
     Keep it short: every session in this project loads it (polyphemus, and the Codex, Grok, and
     Claude Code sessions it runs; Codex and Cursor read it on their own too). Facts that change
     over time belong in polyphemus memory, not here. -->
`;
}

/**
 * Whether a folder is code, which decides how it's described to agents. Checked when it matters
 * rather than stored, so a folder that becomes a repo later is read correctly without migrating.
 */
export function looksLikeCode(path: string): boolean {
  const markers = [
    '.git', 'package.json', 'tsconfig.json', 'deno.json', 'pyproject.toml', 'requirements.txt', 'setup.py',
    'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json',
    'Makefile', 'CMakeLists.txt', 'mix.exs', 'pubspec.yaml', 'Package.swift', 'src',
  ];
  if (markers.some((marker) => existsSync(join(path, marker)))) return true;
  try {
    return readdirSync(path).some((file) => /\.(csproj|sln|xcodeproj)$/.test(file));
  } catch {
    return false;
  }
}

/**
 * Where a thread that's in no project works: beside your projects, not inside one, so it has no
 * project's rules or memory — and an isolated worker is given only this folder. A connection reaches
 * here only when an agent carries one of its own.
 */
const DIRECT_README = `# Threads outside every project

polyphemus works here when a thread belongs to no project: an agent writes a chart, a page or a table
here to show you. Nothing in it is a project — no project rules, no project memory, and no project's
connections. An agent reaches a connection here only when one was granted to the agent itself.
`;

export function directFolder(projectsRoot: string): string {
  const folder = join(resolve(expandHome(projectsRoot)), '.polyphemus-direct');
  const readme = join(folder, 'README.md');
  mkdirSync(folder, { recursive: true });
  // Kept current: what's true here changed when agents could carry a connection of their own.
  // The folder is what direct threads' workers mount, so it's theirs to fill with links: its README is
  // replaced, never written through one (third review, 2026-09-19).
  if (readInside(folder, readme) !== DIRECT_README) replaceInside(folder, readme, Buffer.from(DIRECT_README));
  return folder;
}

/** Where a project's private memory lives. */
export function memoryDir(home: string, slug: string): string {
  return join(home, 'memory', 'projects', slug);
}

/** The project's private memory: notes, decisions, the handoff between sessions, and an inbox for proposals. */
function memoryFolder(home: string, slug: string, name: string): string[] {
  const memory = join(home, 'memory');
  if (!existsSync(join(memory, '.git'))) {
    mkdirSync(memory, { recursive: true });
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', memory]);
  }
  const folder = memoryDir(home, slug);
  // From polyphemus's memory folder, through no link: a project added again may have memory an agent has had.
  folderInside(memory, join(folder, 'notes'));
  folderInside(memory, join(folder, 'inbox'));
  const handoff = join(folder, 'handoff.md');
  if (existsInside(memory, handoff)) return [];
  createInside(memory, handoff, Buffer.from(`# Handoff: ${name}\n\nNo sessions yet. Where things stand, what’s next, and what’s blocked go here.\n`));
  return [handoff];
}

/**
 * Where the project stands, as its last session left it. Agents rewrite `handoff.md` at the end of a
 * turn and every session starts from it — it's the closest thing the project has to a running
 * summary, and until now only models ever read it. Read from the memory folder through no link, and
 * no bigger than a handoff could sensibly be.
 */
export function projectHandoff(home: string, slug: string): { text: string; at: number } | undefined {
  const folder = memoryDir(home, slug);
  const file = join(folder, 'handoff.md');
  const text = readBytesInside(folder, file, 64 * 1024)?.toString('utf8').trim();
  if (!text) return undefined;
  return { text, at: fileInside(folder, file)?.at ?? 0 };
}

// ── Orientation: what every session in a project starts with ─────────────

const HANDOFF_BUDGET = 4000;
const NOTES_BUDGET = 40;

/**
 * The fixed-budget packet a session in a project starts with (docs/design/memory.md §4):
 * which project this is, the last handoff, the notes index, and how to leave things for the
 * next session. The project's AGENTS.md is loaded separately (the CLIs read it themselves).
 */
export function projectBriefing(home: string, project: ProjectMeta): string {
  const folder = memoryDir(home, project.slug);
  const handoffFile = join(folder, 'handoff.md');
  const handoff = readInside(folder, handoffFile)?.trim() ?? '';
  const notes = noteIndex(folder);
  return [
    `<project name="${project.name}" slug="${project.slug}">`,
    `You're working in the project "${project.name}"${project.description ? `: ${project.description}` : ''}.`,
    `Its files are in ${project.path}, and the AGENTS.md there holds its rules. Its memory is in ${folder}: private to the user, outside the project folder. Stay within this project: don't pull in files or context from other projects unless the user asks.`,
    '',
    `Handoff from the last session (${handoffFile}):`,
    clipText(handoff || '(empty)', HANDOFF_BUDGET),
    '',
    notes.length > 0 ? `Notes (open one when it's relevant):\n${notes.join('\n')}` : 'Notes: none yet.',
    '',
    `Before you finish, rewrite ${handoffFile}: where things stand, what's next, and what's blocked. Overwrite it rather than appending, and keep it under 40 lines. When you learn a lasting fact or decision (with the why), write it as a new markdown file in ${join(folder, 'inbox')}/ whose front matter has a "description:" line saying when it's useful. The user reviews those before they become notes.`,
    '</project>',
  ].join('\n');
}

/** One line per note: its file and description. */
function noteIndex(folder: string): string[] {
  // The memory folder is the worker's mount point, so it's the root; notes/ inside it is the agent's to replace.
  const notes = join(folder, 'notes');
  const lines = listInside(folder, notes)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .flatMap((file) => {
      const text = readInside(folder, join(notes, file));
      return text === undefined ? [] : [`- ${join(notes, file)}: ${describeNote(text)}`];
    });
  return lines.length > NOTES_BUDGET ? [...lines.slice(0, NOTES_BUDGET), `- …and ${lines.length - NOTES_BUDGET} more in ${notes}`] : lines;
}

function describeNote(text: string): string {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim();
  if (description) return description.replace(/^["']|["']$/g, '');
  const body = text.slice(front ? text.indexOf('---', 3) + 3 : 0);
  return clipText(body.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').trim() ?? '(empty)', 120);
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(cut; the full file is longer)` : text;
}

/** Whether AGENTS.md is still missing or the untouched template. */
export function needsOrientation(project: ProjectMeta): boolean {
  // An empty folder has nothing to read, so an orientation would only invent rules. It's offered
  // once there's work in it.
  if (!hasWork(project.path)) return false;
  const file = join(project.path, 'AGENTS.md');
  if (!existsSync(file)) return true;
  const text = readInside(project.path, file) ?? '';
  return text.includes(TEMPLATE_MARKER) || text.includes(LEGACY_TEMPLATE_MARKER);
}

/** Anything in the folder besides polyphemus's own files and version control. */
function hasWork(path: string): boolean {
  try {
    return readdirSync(path).some((name) => !['AGENTS.md', '.git', '.polyphemus', '.DS_Store'].includes(name));
  } catch {
    return false;
  }
}

/** The first message of an orientation session: read what's there, draft the rules and notes for review. */
export function orientationPrompt(home: string, project: ProjectMeta): string {
  const folder = memoryDir(home, project.slug);
  const inbox = join(folder, 'inbox');
  // A folder of documents has no package manifest to read or build script to confirm, so the
  // reading and the rules it produces both change shape. Everything after step 2 is the same.
  const code = looksLikeCode(project.path);
  const explore = code
    ? 'Explore the repository with read-only commands: the README, package manifests, build, test, and deploy scripts, CI config, the main source folders, and any existing AGENTS.md, CLAUDE.md, or docs.'
    : "Explore the folder with read-only commands: what's in it, how it's organised and named, any README or notes, and any existing AGENTS.md or docs. Open what you need to understand the work, and no more — some of it may be personal or confidential.";
  const rules = code
    ? 'the exact commands to install, build, test, run, and deploy (only ones you confirmed exist); where things live'
    : 'how the work is done — the steps, tools and services it runs through (only ones you confirmed); where things live';
  const facts = code
    ? 'stack and versions, where it deploys, key decisions and why'
    : 'who and what it involves, where things come from and go, key decisions and why';
  return `Orient yourself in this project and set it up for the agents who'll work on it after you.

1. ${explore}
2. Write a proposed AGENTS.md to ${join(inbox, 'AGENTS.md')}. Once the user approves it, it replaces ${join(project.path, 'AGENTS.md')}. Every session loads it, so keep it under about 80 lines: what the project is and who it's for; ${rules}; conventions, and things never to do. If the current AGENTS.md has real content, keep what's right and improve it rather than dropping the user's rules.
3. Write 3 to 8 notes for lasting facts an agent would otherwise have to rediscover (${facts}), each its own file in ${inbox}/ with a short name like stack.md, starting with:
   ---
   description: one line saying when this note is useful
   ---
4. Rewrite ${join(folder, 'handoff.md')}: what you found, what looks unfinished, and your open questions for the user.
5. Don't change anything in the project folder itself. Finish with a short summary of what you proposed.`;
}

// ── The inbox: proposals waiting for the user ────────────────────────────

export interface InboxItem {
  name: string;
  /** "rules" replaces the project's AGENTS.md; a "note" joins the project's notes. */
  kind: 'rules' | 'note';
  content: string;
}

export function inboxItems(home: string, project: ProjectMeta): InboxItem[] {
  const folder = memoryDir(home, project.slug);
  const inbox = join(folder, 'inbox');
  return listInside(folder, inbox)
    .filter((file) => file.endsWith('.md'))
    .sort((a, b) => (a === 'AGENTS.md' ? -1 : b === 'AGENTS.md' ? 1 : a.localeCompare(b)))
    .flatMap((name) => {
      const content = readInside(folder, join(inbox, name));
      return content === undefined ? [] : [{ name, kind: name === 'AGENTS.md' ? ('rules' as const) : ('note' as const), content }];
    });
}

/** Accepts (moves into place) or discards one proposal. Returns where an accepted one went. */
export function resolveInboxItem(home: string, project: ProjectMeta, name: string, action: 'accept' | 'discard'): string | undefined {
  if (!/^[\w.-]+\.md$/.test(name) || name.startsWith('.')) throw new PolyphemusError(`"${name}" isn't an inbox item.`);
  const folder = memoryDir(home, project.slug);
  const file = join(folder, 'inbox', name);
  // The memory folder is the root: its inbox and notes are the agents' to write, links included, and
  // nothing here follows one — not to read, not to remove (independent review, 2026-09-19).
  if (!existsInside(folder, file)) throw new PolyphemusError(`${name} was already handled.`);
  if (action === 'discard') {
    removeInside(folder, file);
    return undefined;
  }
  const content = readBytesInside(folder, file);
  if (!content) throw new PolyphemusError(`${name} is a link, not a proposal, so it can’t be kept.`);
  if (name === 'AGENTS.md') {
    // Moved over the rules in the project's own folder, so a link standing in for AGENTS.md is replaced, not followed.
    const target = join(project.path, 'AGENTS.md');
    replaceInside(project.path, target, content);
    removeInside(folder, file);
    return target;
  }
  for (let n = 1; ; n++) {
    const target = join(folder, 'notes', n === 1 ? name : name.replace(/\.md$/, `-${n}.md`));
    try {
      createInside(folder, target, content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    removeInside(folder, file);
    return target;
  }
}


function gitError(err: unknown): string {
  const stderr = String((err as { stderr?: string }).stderr ?? '').trim();
  return stderr.split('\n').pop() || (err as Error).message;
}
