import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The open MCP Registry (registry.modelcontextprotocol.io): thousands of MCP servers, each named by a
// domain its publisher proved they control (com.example/...). Polyphemus reads it into a local copy,
// a day at a time, and offers the ones with an address it can reach — beside its own catalogue,
// which it checks itself. Whether one lets polyphemus sign in is found out when someone connects it.

const REGISTRY = (process.env.POLYPHEMUS_MCP_REGISTRY ?? 'https://registry.modelcontextprotocol.io').replace(/\/$/, '');
const DAY = 24 * 60 * 60 * 1000;
const MAX_PAGES = 1000;

export interface RegistryServer {
  /** The registry's name: a reversed domain and a path, `com.example/tasks`. */
  name: string;
  title: string;
  description: string;
  url: string;
  /** Who published it, from the domain in its name: `example.com`, or `github.com/someone`. */
  publisher: string;
  /** Headers it needs, a key among them, as the registry describes them. */
  keys: Array<{ name: string; description: string; secret: boolean; required: boolean }>;
  website?: string;
}

export interface RegistryIndex {
  builtAt: number;
  servers: RegistryServer[];
  /** Why it stopped short of the end, when it did: what it read is kept. */
  partial?: string;
}

const file = (home: string) => join(home, 'cache', 'mcp-registry.json');

/** Who published a server, from the domain its name proves: com.notion/x → notion.com; io.github.alex/x → github.com/alex. */
export function publisherOf(name: string): string {
  const [domain = '', ...rest] = name.split('/');
  const parts = domain.split('.').filter(Boolean);
  if (parts[0] === 'io' && parts[1] === 'github' && parts[2]) return `github.com/${parts[2]}`;
  return parts.length > 1 ? parts.reverse().join('.') : name || rest.join('/');
}

/** The servers the registry lists, latest versions only, that polyphemus can reach over streamable HTTP. */
export function registryServers(items: unknown[]): RegistryServer[] {
  const out: RegistryServer[] = [];
  for (const item of items) {
    const s = (item as { server?: Record<string, unknown> })?.server;
    if (!s || typeof s.name !== 'string') continue;
    const remotes = Array.isArray(s.remotes) ? (s.remotes as Array<Record<string, unknown>>) : [];
    // Streamable HTTP is what polyphemus's client speaks; the older SSE transport isn't offered.
    const remote = remotes.find((r) => r.type === 'streamable-http' && typeof r.url === 'string' && /^https:\/\//.test(r.url));
    if (!remote) continue;
    // A templated address ({workspace}.example.com) needs values polyphemus doesn't ask for yet.
    if (/[{}]/.test(String(remote.url))) continue;
    const headers = Array.isArray(remote.headers) ? (remote.headers as Array<Record<string, unknown>>) : [];
    out.push({
      name: s.name,
      title: typeof s.title === 'string' && s.title.trim() ? s.title.trim() : s.name.split('/').pop()!,
      description: typeof s.description === 'string' ? s.description.trim().slice(0, 300) : '',
      url: String(remote.url),
      publisher: publisherOf(s.name),
      keys: headers
        .filter((h) => typeof h.name === 'string' && h.value === undefined)
        .map((h) => ({ name: String(h.name), description: typeof h.description === 'string' ? h.description : '', secret: h.isSecret === true, required: h.isRequired === true })),
      ...(typeof s.websiteUrl === 'string' && { website: s.websiteUrl }),
    });
  }
  return out;
}

/** Reads the whole registry, a page at a time. A page that fails ends it early; what was read is kept. */
export async function buildRegistryIndex(onProgress?: (pages: number) => void): Promise<RegistryIndex> {
  const servers = new Map<string, RegistryServer>();
  let cursor: string | undefined;
  let partial: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${REGISTRY}/v0/servers?limit=100&version=latest${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    let body: { servers?: unknown[]; metadata?: { nextCursor?: string } } | undefined;
    // A page can fail on its own (a slow answer, a 500): it's asked for once more before stopping.
    for (let attempt = 0; attempt < 2 && !body; attempt++) {
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`the registry answered ${res.status}`);
        body = (await res.json()) as typeof body;
      } catch (err) {
        if (attempt === 1) partial = `stopped after ${page} pages: ${(err as Error).message}`;
      }
    }
    if (!body) break;
    for (const server of registryServers(body.servers ?? [])) servers.set(server.name, server);
    onProgress?.(page + 1);
    cursor = body.metadata?.nextCursor;
    if (!cursor) break;
  }
  return { builtAt: Date.now(), servers: [...servers.values()].sort((a, b) => a.title.localeCompare(b.title)), ...(partial && { partial }) };
}

// The copy is several megabytes and searched as someone types: read once, again only when it changes.
let memo: { path: string; mtimeMs: number; index: RegistryIndex } | undefined;

export function cachedRegistry(home: string, opts: { fresh?: boolean } = {}): RegistryIndex | undefined {
  try {
    const path = file(home);
    const { mtimeMs } = statSync(path);
    if (memo?.path !== path || memo.mtimeMs !== mtimeMs) memo = { path, mtimeMs, index: JSON.parse(readFileSync(path, 'utf8')) as RegistryIndex };
    if (opts.fresh && Date.now() - memo.index.builtAt > DAY) return undefined;
    return memo.index;
  } catch {
    return undefined;
  }
}

export function saveRegistry(home: string, index: RegistryIndex): void {
  mkdirSync(join(home, 'cache'), { recursive: true });
  const temp = `${file(home)}.${process.pid}`;
  writeFileSync(temp, JSON.stringify(index));
  renameSync(temp, file(home));
}

/** Servers matching some words, the closest first: a title that starts with them, then one that has them. */
export function searchRegistry(index: RegistryIndex, query: string, skip: (server: RegistryServer) => boolean = () => false): RegistryServer[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<[number, RegistryServer]> = [];
  for (const server of index.servers) {
    if (skip(server)) continue;
    const title = server.title.toLowerCase();
    const hay = `${title} ${server.name.toLowerCase()} ${server.publisher} ${server.description.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    // A publisher that proved a domain of its own comes before an account's GitHub namespace.
    const score = (words.length === 0 ? 3 : title.startsWith(words[0]!) ? 0 : title.includes(words[0]!) ? 1 : 2) * 2 + (server.publisher.startsWith('github.com/') ? 1 : 0);
    scored.push([score, server]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].title.localeCompare(b[1].title)).map(([, s]) => s);
}
