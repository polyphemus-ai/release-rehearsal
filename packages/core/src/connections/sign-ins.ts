import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PolyphemusError } from '../types.js';
import type { Browser } from '../browser/chrome.js';
import type { Cookie, OriginStorage, Tab } from '../browser/tab.js';

// Sign-ins the Browser connection keeps (computer-use.md, credentials). A person signs in to a site
// once, by hand, in a live view of a browser polyphemus runs; polyphemus keeps the cookies that site set, in
// the vault, and the browsers agents use in the projects that person picks start out signed in. The
// password goes from the person's keyboard to the page and nowhere else: no model sees it, and none
// sees the cookies either.
//
// A sign-in is its owner's, like any credential (secrets.md, multiplayer): only they choose where it's
// used, and it's used only in a project nobody else can see into — otherwise anyone there could ask an
// agent to read what it reaches, and the sign-in would be shared by proxy.

export interface BrowserSignIn {
  id: string;
  connection: string;
  /** The site it's for, like github.com: cookies for it and its subdomains are kept. */
  site: string;
  /** The person who signed in. */
  owner: string;
  /** Where agents' browsers may use it, chosen by the owner. */
  projects: string[];
  createdAt: number;
  /** When its cookies last changed: signed in again, or refreshed by the site as an agent used it. */
  updatedAt: number;
  usedAt?: number;
}

export const SIGN_IN_SCHEMA = `
-- Sign-ins the Browser connection keeps. The cookies are in the vault, under connection/<id>/sign-in/<sign-in>.
CREATE TABLE IF NOT EXISTS browser_sign_ins (
  id         TEXT PRIMARY KEY,
  connection TEXT NOT NULL,
  site       TEXT NOT NULL,
  owner      TEXT NOT NULL,               -- person id
  projects   TEXT NOT NULL DEFAULT '[]',  -- JSON array of project slugs
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  used_at    INTEGER
);
`;

interface SignInRow {
  id: string;
  connection: string;
  site: string;
  owner: string;
  projects: string;
  created_at: number;
  updated_at: number;
  used_at: number | null;
}

const toSignIn = (r: SignInRow): BrowserSignIn => ({
  id: r.id,
  connection: r.connection,
  site: r.site,
  owner: r.owner,
  projects: JSON.parse(r.projects),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.used_at !== null && { usedAt: r.used_at }),
});

export class SignInStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SIGN_IN_SCHEMA);
  }

  list(connection?: string): BrowserSignIn[] {
    const rows = connection
      ? this.db.prepare('SELECT * FROM browser_sign_ins WHERE connection = ? ORDER BY site, created_at').all(connection)
      : this.db.prepare('SELECT * FROM browser_sign_ins ORDER BY site, created_at').all();
    return (rows as unknown as SignInRow[]).map(toSignIn);
  }

  get(id: string): BrowserSignIn | undefined {
    const row = this.db.prepare('SELECT * FROM browser_sign_ins WHERE id = ?').get(id) as SignInRow | undefined;
    return row && toSignIn(row);
  }

  add(s: Pick<BrowserSignIn, 'connection' | 'site' | 'owner' | 'projects'>, at = Date.now()): BrowserSignIn {
    const id = randomUUID().replaceAll('-', '').slice(0, 10);
    this.db.prepare('INSERT INTO browser_sign_ins (id, connection, site, owner, projects, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, s.connection, s.site, s.owner, JSON.stringify(s.projects), at, at);
    return this.get(id)!;
  }

  setProjects(id: string, projects: string[]): void {
    this.db.prepare('UPDATE browser_sign_ins SET projects = ? WHERE id = ?').run(JSON.stringify([...new Set(projects)]), id);
  }

  touch(id: string, what: 'updated' | 'used', at = Date.now()): void {
    this.db.prepare(`UPDATE browser_sign_ins SET ${what === 'updated' ? 'updated_at' : 'used_at'} = ? WHERE id = ?`).run(at, id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM browser_sign_ins WHERE id = ?').run(id);
  }

  removeAll(connection: string): string[] {
    const ids = this.list(connection).map((s) => s.id);
    this.db.prepare('DELETE FROM browser_sign_ins WHERE connection = ?').run(connection);
    return ids;
  }
}

export const signInSecretName = (connection: string, id: string) => `connection/${connection}/sign-in/${id}`;

/** The site a page is on, as a sign-in names it: its host without a leading www. */
export function siteOf(url: string): string | undefined {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return undefined;
    return hostname.toLowerCase().replace(/^www\./, '') || undefined;
  } catch {
    return undefined;
  }
}

/** Whether a cookie belongs to a site: set for it, one of its subdomains, or a domain above it. */
export function cookieForSite(cookie: Pick<Cookie, 'domain'>, site: string): boolean {
  const domain = cookie.domain.toLowerCase().replace(/^\./, '');
  return domain === site || domain.endsWith(`.${site}`) || site.endsWith(`.${domain}`) || domain === `www.${site}`;
}

/** Cookies in the same order whatever order Chrome lists them in, so a change is a real change. */
export function sameCookies(a: Cookie[], b: Cookie[]): boolean {
  const key = (list: Cookie[]) => JSON.stringify(list.map((c) => [c.domain, c.path, c.name, c.value, c.expires ?? 0]).sort());
  return key(a) === key(b);
}

/** Whether an origin's stored session belongs to a site: the same host, or one under it. */
export function storageForSite(origin: string, site: string): boolean {
  const host = siteOf(origin);
  return host !== undefined && (host === site || host.endsWith(`.${site}`) || site.endsWith(`.${host}`));
}

/** Stored sessions in the same order whatever order the page lists them in. */
export function sameStorage(a: OriginStorage[], b: OriginStorage[]): boolean {
  const key = (list: OriginStorage[]) => JSON.stringify(list.map((s) => [s.origin, Object.entries(s.local).sort()]).sort());
  return key(a) === key(b);
}

/**
 * What a kept sign-in holds in the vault. Sign-ins kept before storage was kept too (2026-09-22)
 * hold a bare array of cookies, so what's read is whichever of the two shapes is there.
 */
export interface KeptSignIn {
  cookies: Cookie[];
  /** For a site that keeps its session in `localStorage` rather than cookies. */
  storage?: OriginStorage[];
}

export function parseKept(raw: string | undefined): KeptSignIn {
  if (!raw) return { cookies: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { cookies: [] };
  }
  if (Array.isArray(value)) return { cookies: value as Cookie[] };
  const kept = value as Partial<KeptSignIn>;
  return { cookies: kept.cookies ?? [], ...(kept.storage?.length && { storage: kept.storage }) };
}

/** Whether a sign-in has anything in it at all: neither cookies nor a stored session is not signed in. */
export const keptSomething = (kept: KeptSignIn): boolean => kept.cookies.length > 0 || (kept.storage?.length ?? 0) > 0;

/** A sign-in's cookies and stored session, handed to the browser for a call — and nowhere else. */
export interface SignInForTab {
  id: string;
  site: string;
  ownerName: string;
  cookies: Cookie[];
  storage?: OriginStorage[];
}

/** A person signing in by hand. Only they can see it or drive it. */
interface Live {
  id: string;
  connection: string;
  person: string;
  /** Signing in again to a sign-in already kept. */
  signIn?: string;
  tab: Promise<Tab>;
  used: number;
  queue: Promise<unknown>;
}

const LIVE_IDLE_MS = 10 * 60_000;

/**
 * Live views for signing in: a tab of its own in a browser of its own, driven by one person's taps
 * and typing. Nothing here is a tool: no model reaches it.
 */
export class LiveSignIns {
  private readonly lives = new Map<string, Live>();
  private browser?: Promise<Browser>;
  private readonly sweep: NodeJS.Timeout;

  constructor(
    private readonly openBrowser: () => Promise<Browser>,
    private readonly refuse: (url: string) => Promise<string | undefined>,
  ) {
    this.sweep = setInterval(() => {
      for (const live of this.lives.values()) if (Date.now() - live.used > LIVE_IDLE_MS) void this.cancel(live.id, live.person);
    }, 60_000);
    this.sweep.unref();
  }

  async start(opts: { connection: string; person: string; url: string; width: number; height: number; cookies?: Cookie[]; storage?: OriginStorage[]; signIn?: string }): Promise<string> {
    const why = await this.refuse(opts.url);
    if (why) throw new PolyphemusError(`polyphemus can’t open ${opts.url}: ${why}.`, 'USAGE');
    const id = randomUUID().replaceAll('-', '');
    const width = Math.round(Math.max(320, Math.min(1280, opts.width)));
    const height = Math.round(Math.max(480, Math.min(1000, opts.height)));
    // Narrow, not emulating a phone: a phone viewport draws a page with no viewport tag at 980px and
    // scales it down, and taps land in the unscaled page. Responsive sites still show their phone layout.
    const tab = this.chrome().then((b) => b.tab({ refuse: this.refuse, width, height, ...(opts.cookies && { cookies: opts.cookies }), ...(opts.storage && { storage: opts.storage }) }));
    const live: Live = { id, connection: opts.connection, person: opts.person, ...(opts.signIn && { signIn: opts.signIn }), tab, used: Date.now(), queue: Promise.resolve() };
    this.lives.set(id, live);
    try {
      await this.with(id, opts.person, (t) => t.hands.go(opts.url));
    } catch (err) {
      // A page that didn't load is still a live view to try again from; Chrome not starting isn't.
      if (!(await tab.then(() => true).catch(() => false))) {
        this.lives.delete(id);
        throw err;
      }
    }
    return id;
  }

  /** The live view, for the person who started it; anyone else is told there's no such thing. */
  get(id: string, person: string): Live {
    const live = this.lives.get(id);
    if (!live || live.person !== person) throw new PolyphemusError('That sign-in isn’t open any more. Start again.', 'NOT_FOUND');
    return live;
  }

  /** One thing at a time on a live view, in the order it was asked. */
  with<T>(id: string, person: string, act: (tab: Tab) => Promise<T>): Promise<T> {
    const live = this.get(id, person);
    live.used = Date.now();
    const run = live.queue.then(async () => act(await live.tab));
    live.queue = run.catch(() => undefined);
    return run;
  }

  async cancel(id: string, person: string): Promise<void> {
    const live = this.lives.get(id);
    if (!live || live.person !== person) return;
    this.lives.delete(id);
    await live.tab.then((t) => t.close()).catch(() => undefined);
    if (this.lives.size === 0) this.closeBrowser();
  }

  close(): void {
    clearInterval(this.sweep);
    for (const live of this.lives.values()) void live.tab.then((t) => t.close()).catch(() => undefined);
    this.lives.clear();
    this.closeBrowser();
  }

  private async chrome(): Promise<Browser> {
    const current = this.browser && (await this.browser.catch(() => undefined));
    if (current?.alive()) return current;
    this.browser = this.openBrowser();
    this.browser.catch(() => (this.browser = undefined));
    return this.browser;
  }

  private closeBrowser(): void {
    const closing = this.browser;
    this.browser = undefined;
    void closing?.then((b) => b.close()).catch(() => undefined);
  }
}
