import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SKILL_NAME } from './skills.js';
import { PolyphemusError } from './types.js';
import { createInside, existsInside, moveOutInside, readInside, renameInside } from './contained.js';

// The skill library (2026-09-18): skills published in the open by the people who make the tools,
// browsed and installed from inside polyphemus. Nothing is copied into polyphemus itself — licences differ
// skill by skill — so the library is read live from each source, cached for a week, and a skill is
// fetched when someone installs it, its licence kept beside it and where it came from recorded.
// Only openly licensed skills are offered: Anthropic's document skills (docx, pdf, pptx, xlsx) are
// "all rights reserved", and a collection with no licence at all isn't offered either.

export interface SkillSource {
  id: string;
  /** Who publishes it, as people know them. */
  name: string;
  repo: string;
  branch: string;
}

export const SKILL_SOURCES: readonly SkillSource[] = [
  { id: 'anthropic', name: 'Anthropic', repo: 'anthropics/skills', branch: 'main' },
  { id: 'openai', name: 'OpenAI', repo: 'openai/skills', branch: 'main' },
  { id: 'superpowers', name: 'Superpowers (obra)', repo: 'obra/superpowers', branch: 'main' },
  { id: 'huggingface', name: 'Hugging Face', repo: 'huggingface/skills', branch: 'main' },
  { id: 'cloudflare', name: 'Cloudflare', repo: 'cloudflare/skills', branch: 'main' },
  { id: 'supabase', name: 'Supabase', repo: 'supabase/agent-skills', branch: 'main' },
  { id: 'stripe', name: 'Stripe', repo: 'stripe/ai', branch: 'main' },
  { id: 'microsoft', name: 'Microsoft', repo: 'microsoft/skills', branch: 'main' },
  { id: 'github', name: 'GitHub (awesome-copilot)', repo: 'github/awesome-copilot', branch: 'main' },
  { id: 'trailofbits', name: 'Trail of Bits', repo: 'trailofbits/skills', branch: 'main' },
];

export interface CatalogueSkill {
  /** `source/name`: unique across sources. */
  id: string;
  name: string;
  description: string;
  source: string;
  sourceName: string;
  repo: string;
  /** The skill's folder in the repo. */
  path: string;
  /** Its licence, in a word or two, and where the text is. */
  license: string;
  licenseFile: string;
}

export interface SkillIndex {
  builtAt: number;
  skills: CatalogueSkill[];
  /** Sources that couldn't be read this time, and why: the rest is still there. */
  problems: Array<{ source: string; message: string }>;
  /** Skipped for their licence, so the list is honest about what isn't offered. */
  withheld: number;
}

const WEEK = 7 * 86_400_000;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_SKILL = 20 * 1024 * 1024;
const indexFile = (home: string) => join(home, 'cache', 'skill-library.json');
const raw = (repo: string, branch: string, path: string) => `https://raw.githubusercontent.com/${repo}/${branch}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** A licence's text, as a short name — or undefined when it isn't one that lets polyphemus offer it. */
export function openLicense(text: string): string | undefined {
  const head = text.slice(0, 3000);
  if (/all rights reserved/i.test(head) && !/permission is hereby granted|licensed under/i.test(head)) return undefined;
  if (/Apache License/i.test(head)) return 'Apache-2.0';
  if (/MIT License|Permission is hereby granted, free of charge/i.test(head)) return 'MIT';
  if (/BSD/i.test(head) && /Redistribution and use/i.test(head)) return 'BSD';
  if (/Attribution-ShareAlike 4\.0|CC-BY-SA-4\.0/i.test(head)) return 'CC-BY-SA-4.0';
  if (/Attribution 4\.0|CC-BY-4\.0/i.test(head)) return 'CC-BY-4.0';
  if (/ISC License/i.test(head)) return 'ISC';
  return undefined;
}

async function fetchText(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'polyphemus' } });
    return res.ok ? await res.text() : undefined;
  } catch {
    return undefined;
  }
}

async function tree(source: SkillSource): Promise<string[]> {
  const res = await fetch(`https://api.github.com/repos/${source.repo}/git/trees/${source.branch}?recursive=1`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'polyphemus', ...(process.env.GITHUB_TOKEN && { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { tree?: Array<{ path: string; type: string }>; message?: string };
  if (!res.ok || !body.tree) throw new Error(body.message ?? `GitHub said ${res.status}`);
  return body.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path);
}

/** Runs `work` over items a few at a time: hundreds of small fetches without opening hundreds at once. */
async function pool<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  }));
  return out;
}

function frontMatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  try {
    const front = (parseYaml(match[1]!) ?? {}) as Record<string, unknown>;
    return { name: typeof front.name === 'string' ? front.name.trim() : undefined, description: typeof front.description === 'string' ? front.description.trim() : undefined };
  } catch {
    return {};
  }
}

/** Reads every source: its skills, each one's nearest licence, and what its SKILL.md says it's for. */
export async function buildSkillIndex(onProgress?: (done: number, of: number) => void): Promise<SkillIndex> {
  const problems: SkillIndex['problems'] = [];
  const found: Array<{ source: SkillSource; files: string[]; skillDir: string }> = [];
  for (const source of SKILL_SOURCES) {
    try {
      const files = await tree(source);
      for (const file of files) if (file.endsWith('/SKILL.md')) found.push({ source, files, skillDir: dirname(file) });
    } catch (err) {
      problems.push({ source: source.name, message: (err as Error).message });
    }
  }
  // The licence nearest each skill: its own folder's, else the closest folder above it that has one.
  const licenseTexts = new Map<string, Promise<string | undefined>>();
  const nearestLicense = (source: SkillSource, files: string[], dir: string): string | undefined => {
    for (let at = dir; ; at = dirname(at)) {
      const prefix = at === '.' ? '' : `${at}/`;
      const hit = files.find((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/') && /^(LICENSE|LICENCE|COPYING)(\.(md|txt))?$/i.test(file.slice(prefix.length)));
      if (hit) return hit;
      if (at === '.' || at === '') return undefined;
    }
  };
  let done = 0;
  let withheld = 0;
  const skills = await pool(found, 12, async ({ source, files, skillDir }) => {
    const licenseFile = nearestLicense(source, files, skillDir);
    const key = `${source.repo}:${licenseFile}`;
    if (licenseFile && !licenseTexts.has(key)) licenseTexts.set(key, fetchText(raw(source.repo, source.branch, licenseFile)));
    const [licenseText, skillText] = await Promise.all([licenseFile ? licenseTexts.get(key)! : Promise.resolve(undefined), fetchText(raw(source.repo, source.branch, `${skillDir}/SKILL.md`))]);
    onProgress?.(++done, found.length);
    const license = licenseText ? openLicense(licenseText) : undefined;
    if (!license || !licenseFile) {
      withheld += 1;
      return undefined;
    }
    const front = skillText ? frontMatter(skillText) : {};
    const name = (front.name && SKILL_NAME.test(front.name) ? front.name : skillDir.split('/').pop()!).toLowerCase();
    if (!SKILL_NAME.test(name) || !front.description) return undefined;
    const entry: CatalogueSkill = { id: `${source.id}/${name}`, name, description: front.description.replace(/\s+/g, ' ').slice(0, 600), source: source.id, sourceName: source.name, repo: source.repo, path: skillDir, license, licenseFile };
    return entry;
  });
  // One entry per id: a collection that ships the same skill twice lists it once.
  const unique = new Map<string, CatalogueSkill>();
  for (const skill of skills) if (skill && !unique.has(skill.id)) unique.set(skill.id, skill);
  return { builtAt: Date.now(), skills: [...unique.values()].sort((a, b) => a.name.localeCompare(b.name)), problems, withheld };
}

/** The library as last read, or undefined if it never has been (or it's over a week old, with `fresh`). */
export function cachedSkillIndex(home: string, opts: { fresh?: boolean } = {}): SkillIndex | undefined {
  try {
    const index = JSON.parse(readFileSync(indexFile(home), 'utf8')) as SkillIndex;
    if (opts.fresh && Date.now() - index.builtAt > WEEK) return undefined;
    return index;
  } catch {
    return undefined;
  }
}

export function saveSkillIndex(home: string, index: SkillIndex): void {
  const file = indexFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(index));
  renameSync(`${file}.tmp`, file);
}

/** What a search for `query` finds: every word has to appear in the name, description or source. */
export function searchSkills(index: SkillIndex, query: string, source?: string): CatalogueSkill[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return index.skills.filter((skill) => (!source || skill.source === source) && words.every((word) => `${skill.name} ${skill.description} ${skill.sourceName}`.toLowerCase().includes(word)));
}

/** Where an installed skill came from: kept beside it, so it can be updated or credited. */
export interface SkillOrigin {
  id: string;
  repo: string;
  path: string;
  license: string;
  installedAt: number;
  by: string;
}
export const ORIGIN_FILE = '.polyphemus-source.json';

export function skillOrigin(skillDir: string, root?: string): SkillOrigin | undefined {
  try {
    const text = root ? readInside(root, join(skillDir, ORIGIN_FILE)) : readFileSync(join(skillDir, ORIGIN_FILE), 'utf8');
    return text === undefined ? undefined : (JSON.parse(text) as SkillOrigin);
  } catch {
    return undefined;
  }
}

/**
 * Fetches a skill from its source into `targetDir/<name>`: every file in its folder, and its licence
 * beside it when the licence lives further up. A skill already there by that name is refused unless
 * `replace` — and one that came from somewhere else is never silently overwritten.
 */
/** A response's body, or undefined as soon as it's over `max` bytes (it's cancelled, not read). */
async function capped(res: Response, max: number): Promise<Buffer | undefined> {
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > max) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function installSkill(skill: CatalogueSkill, targetDir: string, opts: { by: string; replace?: boolean; root?: string; aside?: string }): Promise<string> {
  const source = SKILL_SOURCES.find((s) => s.id === skill.source);
  if (!source) throw new PolyphemusError(`${skill.source} isn't a skill source polyphemus knows.`, 'USAGE');
  // Written from `root` (a project's folder, when it's a project's skill), through no link at any
  // step: the skills folder is its agents' to prepare (third review, 2026-09-19).
  const root = opts.root ?? targetDir;
  const dest = join(targetDir, skill.name);
  const there = existsInside(root, dest);
  if (there) {
    const origin = skillOrigin(dest, root);
    if (!opts.replace) throw new PolyphemusError(`There's already a skill called ${skill.name} there${origin ? `, from ${origin.id}` : ' that you wrote'}.`, 'CONFLICT', 'Install it with --replace to swap it for this one.');
    if (!origin) throw new PolyphemusError(`${skill.name} there is one you wrote, not one from the library: polyphemus won't replace it.`, 'CONFLICT');
  }
  const files = (await tree(source)).filter((file) => file.startsWith(`${skill.path}/`));
  if (!files.includes(`${skill.path}/SKILL.md`)) throw new PolyphemusError(`${skill.id} isn't at ${source.repo} anymore.`, 'NOT_FOUND');
  // Everything is fetched before anything is written: at most MAX_SKILL, held in memory.
  const fetched = new Map<string, Buffer>();
  let total = 0;
  await pool(files, 8, async (file) => {
    const res = await fetch(raw(source.repo, source.branch, file), { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'polyphemus' } });
    if (!res.ok) throw new PolyphemusError(`Couldn't fetch ${file} from ${source.repo}: ${res.status}`, 'FAILED');
    // Read no more than a file may be: a big asset isn't what makes a skill work, and nothing is held
    // in memory past the limit (independent review, 2026-09-19).
    const bytes = await capped(res, MAX_FILE);
    if (!bytes) return;
    total += bytes.length;
    if (total > MAX_SKILL) throw new PolyphemusError(`${skill.id} is over ${MAX_SKILL / 1024 / 1024} MB, so it wasn't installed.`, 'USAGE');
    const rel = file.slice(skill.path.length + 1);
    if (rel.split('/').some((part) => !part || part === '.' || part === '..')) return;
    fetched.set(rel, bytes);
  });
  // Its licence goes with it, whoever's folder it lands in.
  if (![...fetched.keys()].some((rel) => /^(LICENSE|LICENCE|COPYING)/i.test(rel))) {
    const text = await fetchText(raw(source.repo, source.branch, skill.licenseFile));
    // Its licence is what makes it yours to use: without it, it isn't installed.
    if (!text) throw new PolyphemusError(`${skill.id}’s licence couldn’t be fetched from ${source.repo}, so it wasn’t installed. Try again in a moment.`, 'FAILED');
    fetched.set('LICENSE.txt', Buffer.from(text));
  }
  const origin: SkillOrigin = { id: skill.id, repo: skill.repo, path: skill.path, license: skill.license, installedAt: Date.now(), by: opts.by };
  fetched.set(ORIGIN_FILE, Buffer.from(`${JSON.stringify(origin, null, 2)}\n`));
  // Written beside where it goes under a hidden name, then renamed into place, so a half-written skill is never loaded.
  const staging = join(targetDir, `.${skill.name}.installing-${Date.now()}`);
  for (const [rel, bytes] of fetched) createInside(root, join(staging, rel), bytes);
  if (there) moveOutInside(root, dest, opts.aside ?? join(targetDir, `.${skill.name}.replaced-${Date.now()}`));
  renameInside(root, staging, dest);
  return dest;
}
