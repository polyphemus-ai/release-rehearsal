import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PolyphemusError } from '../types.js';
import type { EntryHints, PluginFormat } from './read.js';

// Where plugins come from (docs/design/plugins.md): marketplaces — Cursor's and Claude Code's — and
// any git address. Everything is fetched with git, only the folder that's needed, at a pinned commit
// where the marketplace pins one, into polyphemus's cache. Nothing fetched is run.

const run = promisify(execFile);

export interface Marketplace {
  id: string;
  name: string;
  url: string;
}

export const MARKETPLACES: readonly Marketplace[] = [
  { id: 'cursor', name: 'Cursor', url: 'https://github.com/cursor/plugins.git' },
  { id: 'claude', name: 'Claude Code', url: 'https://github.com/anthropics/claude-plugins-official.git' },
];

/** Where a plugin's files are: a folder in a git repository, at a commit or a branch. */
export interface PluginSource {
  url: string;
  path: string;
  /** A commit when the marketplace pins one; otherwise a branch or tag. */
  ref: string;
}

export interface MarketplaceEntry {
  /** `<marketplace>/<name>`: unique across marketplaces. */
  id: string;
  name: string;
  marketplace: string;
  description: string;
  version?: string;
  category?: string;
  source: PluginSource;
  hints: EntryHints;
}

export interface MarketplaceListing {
  marketplace: string;
  commit: string;
  fetchedAt: number;
  entries: MarketplaceEntry[];
}

const DAY = 24 * 60 * 60 * 1000;
const MAX_BYTES = 60 * 1024 * 1024;

/** Only https: no ssh, no git://, no file://, and none of git's stranger transports. */
export function checkGitUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PolyphemusError(`"${url}" isn't a web address polyphemus can fetch a plugin from.`, 'USAGE');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new PolyphemusError(`Plugins are fetched over https only, with no sign-in in the address: "${url}" isn't one.`, 'USAGE');
}

async function git(args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await run(
      'git',
      // Nothing it fetches may ask for a password or reach for a stored one, and only https is allowed.
      ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd, timeout: 180_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' } },
    );
    return stdout.trim();
  } catch (err) {
    const said = String((err as { stderr?: string }).stderr ?? (err as Error).message).trim().split('\n').slice(-2).join(' ');
    throw new PolyphemusError(`git couldn’t fetch it: ${said}`, 'FAILED');
  }
}

/** The commit a branch (or HEAD) points at now. */
export async function remoteCommit(url: string, ref = 'HEAD'): Promise<string> {
  checkGitUrl(url);
  const out = await git(['ls-remote', url, ref]);
  const sha = out.split(/\s+/)[0];
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new PolyphemusError(`${url} has no ${ref}.`, 'NOT_FOUND');
  return sha;
}

/**
 * The folders of a repository at a commit, fetched into the cache once: only those folders, and no
 * more than a plugin should ever be. Returns the checkout's root.
 */
export async function fetchFolders(home: string, url: string, commit: string, folders: string[]): Promise<string> {
  checkGitUrl(url);
  const key = createHash('sha256').update(`${url}\n${commit}\n${folders.join('\n')}`).digest('hex').slice(0, 16);
  const dir = join(home, 'cache', 'plugins', key);
  if (existsSync(join(dir, '.polyphemus-fetched'))) return dir;
  const temp = `${dir}.fetching-${process.pid}`;
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  try {
    await git(['init', '-q'], temp);
    await git(['remote', 'add', 'origin', url], temp);
    const wanted = folders.map((f) => f.replace(/^\.\//, '').replace(/\/?$/, '/'));
    if (!wanted.includes('/')) {
      await git(['sparse-checkout', 'init', '--no-cone'], temp);
      await git(['sparse-checkout', 'set', '--no-cone', ...wanted.map((f) => `/${f}`)], temp);
    }
    await git(['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', commit], temp);
    await git(['checkout', '-q', 'FETCH_HEAD'], temp);
    if (sizeOf(temp) > MAX_BYTES) throw new PolyphemusError(`It's more than ${MAX_BYTES / (1024 * 1024)} MB, more than a plugin should be, so it wasn't kept.`, 'USAGE');
    writeFileSync(join(temp, '.polyphemus-fetched'), `${url}\n${commit}\n`);
    rmSync(dir, { recursive: true, force: true });
    renameSync(temp, dir);
    return dir;
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    throw err;
  }
}

function sizeOf(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += sizeOf(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

/** A marketplace's plugins: its marketplace.json, read at its current commit, kept for a day. */
export async function listMarketplace(home: string, market: Marketplace, opts: { fresh?: boolean } = {}): Promise<MarketplaceListing> {
  const file = join(home, 'cache', 'plugins', `marketplace-${market.id}.json`);
  if (!opts.fresh && existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as MarketplaceListing;
      if (Date.now() - cached.fetchedAt < DAY) return cached;
    } catch {
      // read it again
    }
  }
  const commit = await remoteCommit(market.url);
  const dir = await fetchFolders(home, market.url, commit, ['.cursor-plugin', '.claude-plugin']);
  const manifest = ['.cursor-plugin/marketplace.json', '.claude-plugin/marketplace.json'].map((f) => join(dir, f)).find(existsSync);
  if (!manifest) throw new PolyphemusError(`${market.name} has no marketplace.json.`, 'NOT_FOUND');
  const listing: MarketplaceListing = { marketplace: market.id, commit, fetchedAt: Date.now(), entries: marketplaceEntries(market, commit, JSON.parse(readFileSync(manifest, 'utf8'))) };
  mkdirSync(join(home, 'cache', 'plugins'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(listing)}\n`);
  return listing;
}

/** A marketplace.json's entries, wherever each plugin's files are. */
export function marketplaceEntries(market: Marketplace, commit: string, manifest: { plugins?: unknown[] }): MarketplaceEntry[] {
  const out: MarketplaceEntry[] = [];
  for (const raw of manifest.plugins ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const name = typeof p.name === 'string' ? p.name : undefined;
    if (!name || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) continue;
    const source = sourceOf(market, commit, p.source);
    if (!source) continue;
    const author = typeof p.author === 'object' && p.author ? String((p.author as { name?: unknown }).name ?? '') : undefined;
    out.push({
      id: `${market.id}/${name}`,
      name,
      marketplace: market.id,
      description: typeof p.description === 'string' ? p.description : '',
      ...(typeof p.version === 'string' && { version: p.version }),
      ...(typeof p.category === 'string' && { category: p.category }),
      source,
      hints: { name, description: typeof p.description === 'string' ? p.description : undefined, version: typeof p.version === 'string' ? p.version : undefined, ...(author && { author }), ...(p.skills !== undefined && { skills: p.skills }) },
    });
  }
  return out;
}

function sourceOf(market: Marketplace, commit: string, source: unknown): PluginSource | undefined {
  const safePath = (path: string) => (path.split('/').includes('..') || path.startsWith('/') ? undefined : path.replace(/^\.\//, '').replace(/\/+$/, ''));
  if (typeof source === 'string') {
    const path = safePath(source);
    return path === undefined ? undefined : { url: market.url, path, ref: commit };
  }
  if (!source || typeof source !== 'object') return undefined;
  const s = source as Record<string, unknown>;
  const pinned = typeof s.sha === 'string' && /^[0-9a-f]{40}$/.test(s.sha) ? s.sha : undefined;
  const ref = pinned ?? (typeof s.ref === 'string' ? s.ref : 'HEAD');
  const url = s.source === 'github' && typeof s.repo === 'string' ? `https://github.com/${s.repo}.git` : typeof s.url === 'string' ? s.url : undefined;
  if (!url) return undefined;
  try {
    checkGitUrl(url);
  } catch {
    return undefined;
  }
  const path = safePath(typeof s.path === 'string' ? s.path : '');
  return path === undefined ? undefined : { url, path, ref };
}

/** Fetches a plugin's folder, at its pinned commit or its branch's current one. */
export async function fetchPlugin(home: string, source: PluginSource): Promise<{ dir: string; commit: string }> {
  const commit = /^[0-9a-f]{40}$/.test(source.ref) ? source.ref : await remoteCommit(source.url, source.ref);
  const root = await fetchFolders(home, source.url, commit, [source.path || '/']);
  const dir = source.path ? join(root, source.path) : root;
  if (!existsSync(dir)) throw new PolyphemusError(`${source.path} isn't in ${source.url} at ${commit.slice(0, 7)}.`, 'NOT_FOUND');
  return { dir, commit };
}

export type { PluginFormat };

/**
 * A plugin by what someone typed: `cursor/advisor` (a marketplace and its plugin), a git address with
 * an optional `#folder`, or a folder on this computer. Read, with where it came from, installing nothing.
 */
export async function loadPlugin(home: string, ref: string): Promise<{ plugin: import('./read.js').Plugin; origin: { id: string; url: string; path: string; commit: string } }> {
  const { readPlugin } = await import('./read.js');
  if (/^https?:\/\//.test(ref)) {
    const [url = '', path = ''] = ref.split('#');
    checkGitUrl(url);
    const source = { url, path: path.replace(/^\/+|\/+$/g, ''), ref: 'HEAD' };
    if (source.path.split('/').includes('..')) throw new PolyphemusError('That folder is outside the repository.', 'USAGE');
    const { dir, commit } = await fetchPlugin(home, source);
    return { plugin: readPlugin(dir), origin: { id: ref, url, path: source.path, commit } };
  }
  if (ref.startsWith('/') || ref.startsWith('.') || ref.startsWith('~')) {
    const dir = ref.replace(/^~(?=\/)/, process.env.HOME ?? '~');
    if (!existsSync(dir)) throw new PolyphemusError(`There's no folder at ${ref}.`, 'NOT_FOUND');
    return { plugin: readPlugin(dir), origin: { id: dir, url: `file:${dir}`, path: '', commit: 'local' } };
  }
  const [marketId, name] = ref.split('/');
  const market = MARKETPLACES.find((m) => m.id === marketId);
  if (!market || !name) throw new PolyphemusError(`"${ref}" isn't a plugin polyphemus knows: give <marketplace>/<name> (${MARKETPLACES.map((m) => m.id).join(', ')}), a git address, or a folder.`, 'USAGE', 'poly plugins browse');
  const listing = await listMarketplace(home, market);
  const entry = listing.entries.find((e) => e.name === name);
  if (!entry) throw new PolyphemusError(`${market.name} has no plugin called ${name}.`, 'NOT_FOUND', 'poly plugins browse');
  const { dir, commit } = await fetchPlugin(home, entry.source);
  return { plugin: readPlugin(dir, entry.hints), origin: { id: entry.id, url: entry.source.url, path: entry.source.path, commit } };
}
