import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInside, readInside, replaceInside } from './contained.js';
import { join } from 'node:path';
import { titleFor } from './roster.js';
import { PolyphemusError } from './types.js';
import { assetPath } from './assets.js';

// Agents and skills that ship with polyphemus, so a fresh install isn't an empty list
// (docs/design/agents.md). These are templates you create from, never installed behind your
// back: `poly agents new mine --from reviewer` copies one into your library, and it's yours
// to edit from then on. Nothing here updates on its own.

export type TemplateKind = 'agents' | 'skills';

export interface Template {
  kind: TemplateKind;
  name: string;
  /** What it's shown as: an agent's title, or a skill's name. */
  title: string;
  /** The description from its own agent.toml or SKILL.md: what it's for. */
  description: string;
  dir: string;
}

/** Where the shipped templates live, relative to this file rather than the user's folders. */
const templatesRoot = (): string => assetPath('core', 'templates/');

const DESCRIPTION = {
  agents: /^\s*description\s*=\s*["'](.+?)["']\s*$/m,
  skills: /^description:\s*(.+)$/m,
} as const;
const FILE = { agents: 'agent.toml', skills: 'SKILL.md' } as const;

/** Every template of one kind, in name order. */
export function templates(kind: TemplateKind): Template[] {
  const root = join(templatesRoot(), kind);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .filter((name) => statSync(join(root, name)).isDirectory())
    .map((name) => {
      const dir = join(root, name);
      const text = readFileSync(join(dir, FILE[kind]), 'utf8');
      return { kind, name, title: (kind === 'agents' ? titleOf(text) : undefined) ?? name, description: DESCRIPTION[kind].exec(text)?.[1]?.trim() ?? '', dir };
    });
}

export function findTemplate(kind: TemplateKind, name: string): Template | undefined {
  return templates(kind).find((template) => template.name === name);
}

/**
 * Copies a template into `destDir` as `name`, renaming it inside so it's immediately its own
 * thing rather than a second copy of the template. Returns the file that defines it.
 */
export function createFromTemplate(kind: TemplateKind, templateName: string, destDir: string, name: string, root = destDir): string {
  const template = findTemplate(kind, templateName);
  if (!template) {
    const known = templates(kind).map((t) => t.name).join(', ');
    const what = kind === 'agents' ? 'agent' : 'skill';
    throw new PolyphemusError(
      known ? `There's no ${what} template called "${templateName}". There is: ${known}.` : `There's no ${what} template called "${templateName}".`,
      'NOT_FOUND',
      `polyphemus ${kind} templates`,
    );
  }
  const folder = join(destDir, name);
  const file = join(folder, FILE[kind]);
  if (existsSync(file)) throw new PolyphemusError(`${file} already exists.`, 'CONFLICT');
  // Copied file by file, each made new from `root`, through no link: the destination may be a
  // project's, which its agents can prepare (third review, 2026-09-19).
  const copy = (from: string, to: string) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) copy(join(from, entry.name), join(to, entry.name));
      else if (entry.isFile()) {
        try {
          createInside(root, join(to, entry.name), readFileSync(join(from, entry.name)));
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EEXIST' || code === 'ELINK') throw new PolyphemusError(`${folder} already has something in it, or goes through a link: pick another name.`, 'CONFLICT');
          throw err;
        }
      }
    }
  };
  copy(template.dir, folder);
  const original = readInside(root, file) ?? '';
  replaceInside(root, file, Buffer.from(rename(original, kind, template.name, name)));
  // Its own name in its own words too: a copy of Reviewer called "critic" shouldn't open with
  // "# Reviewer", because that heading is part of what the model is told it is.
  const fromTitle = kind === 'agents' ? (titleOf(original) ?? template.name) : template.name;
  const toTitle = kind === 'agents' ? titleFor(name) : name;
  for (const prose of kind === 'agents' ? ['persona.md', 'instructions.md'] : ['SKILL.md']) {
    renameHeadings(root, join(folder, prose), fromTitle, toTitle, template.name, name);
  }
  return file;
}

const TITLE = /^\s*title\s*=\s*["'](.+?)["']\s*$/m;
const titleOf = (text: string): string | undefined => TITLE.exec(text)?.[1]?.trim();

/** Only heading lines: sentences in the body are the template's writing, and stay as they are. */
function renameHeadings(root: string, path: string, fromTitle: string, toTitle: string, fromName: string, toName: string): void {
  const before = fromTitle === toTitle && fromName === toName ? undefined : readInside(root, path);
  if (before === undefined) return;
  replaceInside(root, path, Buffer.from(before.replace(/^#.*$/gm, (line) => line.split(fromTitle).join(toTitle).split(fromName).join(toName))));
}

/** The copy is called what you called it — in its name and in what it's shown as. */
function rename(text: string, kind: TemplateKind, from: string, to: string): string {
  if (from === to) return text;
  if (kind === 'skills') return text.replace(/^(name:\s*).*$/m, `$1${to}`);
  return text
    .replace(/^(\s*name\s*=\s*)["'].*?["']/m, `$1${JSON.stringify(to)}`)
    .replace(/^(\s*title\s*=\s*)["'].*?["']/m, `$1${JSON.stringify(titleFor(to))}`);
}
