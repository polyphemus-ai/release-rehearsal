import { PolyphemusError } from '../types.js';
import { makeRedactor } from '../tools/redact.js';
import { isSecretRef, secretRef, type Vault } from '../secrets/vault.js';
import { connectMcp, McpError, type ConnectOptions, type McpCallContext, type McpClient, type McpServerDefinition } from './mcp-client.js';
import { discoverOAuth, OAuthSignIns, oauthSecretName } from './oauth.js';
import { googleServer, googleSignIn, GOOGLE_CLIENT_SECRET } from './google.js';
import { xServer, xSignIn, X_CLIENT_SECRET } from './x.js';
import { plaidApp, plaidClient, plaidRemoveItem, savePlaidApp, PLAID_SCOPES, PLAID_SECRET } from './plaid.js';
import { simplefinAccess, simplefinClient, SIMPLEFIN_SCOPES, SIMPLEFIN_SECRET } from './simplefin.js';
import { BROWSER_SCOPES, browserRefuse } from './browser.js';
import { COMPUTER_SCOPES } from './computer.js';
import { findChrome, openBrowser, type Browser } from '../browser/chrome.js';
import type { Cookie } from '../browser/tab.js';
import { cookieForSite, keptSomething, LiveSignIns, parseKept, signInSecretName, siteOf, storageForSite, type BrowserSignIn, type KeptSignIn, type SignInForTab } from './sign-ins.js';
import { githubAppSecretName, githubServer, installationToken, type GitHubAppRecord, type GitHubRole } from './github.js';
import { ceilingTools, checkGrant, GrantRefused, reachOf, readsOnly, type ConnectionTool, type Grant, type Reach } from './scope.js';
import type { Connection, ConnectionStore } from './store.js';

// The one place polyphemus talks to outside services. Every call — from polyphemus's own tool loop or from
// an agent CLI through the gateway — comes here, is checked against the grant at that moment, is
// recorded with the work it was part of, and a failure is recorded on the connection for its owner.

/** What a call is part of: the grant is looked up from project and agent, the rest is for the record. */
export interface CallContext {
  project?: string;
  agent?: string;
  sessionId?: string;
  /** The thread's folder, for connections that move files in or out of it (an agent's computer). */
  cwd?: string;
  /** The folder above cwd that its agents can't replace (the project's, or cwd itself): where file moves are rooted. */
  root?: string;
  actor?: string;
  /** The run step it was made in: the call becomes that step's evidence. */
  step?: { runId: string; stepId: string };
}

/** A call as it happened, for whoever records it elsewhere (a run's evidence). */
export interface CallRecord {
  connection: string;
  name: string;
  tool: string;
  outcome: 'ok' | 'refused' | 'failed';
  detail?: string;
  ctx: CallContext;
}

export interface CallResult {
  content: string;
  isError: boolean;
  /** Pictures the service returned, as base64. */
  images?: Array<{ mediaType: string; data: string }>;
}

/** A connection reachable here, with the tools it may call and the grant that says so. */
export interface ReachableConnection extends Reach {
  name: string;
  toolDefs: ConnectionTool[];
}

const SLUG = /[^a-z0-9]+/g;
const TEMPLATE = /\{(secret:[a-z0-9][a-z0-9._/-]*)\}/g;

/** How a connection's tool is named to a model: `hubspot__read_contacts`, within the 64 characters providers allow. */
export function connectionToolName(connection: string, tool: string): string {
  return `${connection.replaceAll('-', '_')}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export class Connections {
  private readonly clients = new Map<string, Promise<McpClient>>();
  /** When a client's access token runs out: it's restarted with a fresh one before then. */
  private readonly expiries = new Map<string, number>();
  /** Installation tokens made from GitHub App keys, until they're nearly out. */
  private readonly appTokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly listeners = new Set<(connection: Connection) => void>();
  private readonly callListeners = new Set<(call: CallRecord) => void>();

  /** OAuth sign-ins for remote servers, in progress and done. */
  readonly oauth: OAuthSignIns;
  /** People signing in to sites by hand, for the Browser connection to keep. */
  // Signing in by hand: a window on the person's own screen where there is one (chrome.ts says why).
  readonly live = new LiveSignIns(() => this.openBrowser({ headful: true }), browserRefuse);
  /** Where the Browser connection's Chrome runs: set by polyphemus to a worker where it can make one. */
  openBrowser: (opts?: { headful?: boolean }) => Promise<Browser> = (opts) => openBrowser(opts);
  /** Whether openBrowser has a browser to open: by default, a Chrome on this computer. */
  hasBrowser: () => boolean = () => Boolean(findChrome());
  /** The Computer connection's client: set by polyphemus, which owns agents' computers. */
  computerClient?: () => McpClient;
  /** Who has a role in a project, and what people are called: set by whoever knows about people. */
  people?: { inProject(project: string): string[]; name(id: string): string };

  constructor(
    readonly store: ConnectionStore,
    private readonly vault: Vault,
    private readonly connect: (def: McpServerDefinition, opts?: ConnectOptions) => Promise<McpClient> = connectMcp,
  ) {
    this.oauth = new OAuthSignIns(vault);
  }

  /** Told whenever a connection's health changes, so people who can fix it hear about it. */
  on(listener: (connection: Connection) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Told about every call made or refused. */
  onCall(listener: (call: CallRecord) => void): () => void {
    this.callListeners.add(listener);
    return () => this.callListeners.delete(listener);
  }

  list(): Connection[] {
    return this.store.list();
  }

  /** An OAuth connection has a token in the vault. Nothing here is the token. */
  signedIn(id: string): boolean {
    const connection = this.get(id);
    if (!connection || connection.server.kind === 'builtin' || connection.server.auth !== 'oauth') return false;
    return this.vault.has(oauthSecretName(id));
  }

  get(id: string): Connection | undefined {
    return this.store.get(id);
  }

  /**
   * Adds a connection and tests it. Secret values go to the vault and the definition keeps only
   * references to them; a failing first test still adds it, failing, so it can be reconnected.
   */
  async add(opts: { name: string; owner: string; server: McpServerDefinition; secrets?: Record<string, string>; createdBy: string }): Promise<Connection> {
    const name = opts.name.trim();
    if (!name) throw new PolyphemusError('A connection needs a name.', 'USAGE');
    const base = name.toLowerCase().replace(SLUG, '-').replace(/^-|-$/g, '') || 'connection';
    let id = base;
    for (let n = 2; this.store.get(id); n++) id = `${base}-${n}`;
    const server = this.withSecrets(id, validServer(opts.server), opts.secrets ?? {});
    this.store.add({ id, name, owner: opts.owner, server, ceiling: { provenance: 'unknown' }, createdBy: opts.createdBy });
    // One that signs in with OAuth is tested once the person has signed in, not before.
    if (!server.auth) await this.test(id);
    return this.store.get(id)!;
  }

  /** Where to send the person to sign in to a connection's service. */
  async beginSignIn(id: string, redirectUri: string): Promise<string> {
    const connection = this.require(id);
    if (connection.server.auth !== 'oauth') throw new PolyphemusError(`${connection.name} doesn’t sign in with OAuth.`, 'USAGE');
    if (connection.server.kind === 'stdio') {
      if (connection.server.x) return this.oauth.begin(id, xSignIn(this.vault), redirectUri);
      if (!connection.server.google) throw new PolyphemusError(`${connection.name} doesn’t say where to sign in.`, 'USAGE');
      return this.oauth.begin(id, googleSignIn(this.vault, connection.server.google), redirectUri);
    }
    const server = await discoverOAuth(connection.server.url);
    if (!server) throw new PolyphemusError(`${new URL(connection.server.url).host} didn’t say how to sign in to it. Use an API key or token instead.`, 'FAILED');
    return this.oauth.begin(id, server, redirectUri);
  }

  /** Back from signing in: keep the tokens, record the scopes the service granted, and test it. */
  async finishSignIn(state: string, code: string): Promise<Connection> {
    const { connection, scopes } = await this.oauth.finish(state, code);
    const current = this.require(connection);
    this.store.setCeiling(connection, { provenance: 'checked', scopes, at: Date.now() });
    return this.test(connection);
  }

  /** Connects afresh and lists what the server offers. Never throws for the server's sake: a failure is recorded. */
  async test(id: string): Promise<Connection> {
    const connection = this.require(id);
    this.drop(id);
    // Not signed in yet isn't a failure to tell anyone about: it's a sign-in someone hasn't finished.
    if (connection.server.auth === 'github-app' && !this.githubApp(id)?.installationId) {
      this.store.setHealth(id, 'untested');
      return this.store.get(id)!;
    }
    if (connection.server.auth === 'oauth' && !this.vault.has(oauthSecretName(id))) {
      this.store.setHealth(id, 'untested');
      return this.store.get(id)!;
    }
    try {
      if (connection.server.auth === 'github-app') {
        // GitHub says what this installation can do, and where: that's the ceiling, checked.
        const issued = await this.githubToken(id);
        this.store.setCeiling(id, { provenance: 'checked', scopes: [...Object.entries(issued.permissions).map(([k, v]) => `${k}: ${v}`), ...issued.repositories.map((r) => `repo ${r}`)], at: Date.now() });
      }
      // What polyphemus builds in can do exactly what its code does: that's checked, not declared.
      if (connection.server.kind === 'builtin') {
        const scopes = connection.server.builtin === 'computer' ? COMPUTER_SCOPES : connection.server.builtin !== 'finance' ? BROWSER_SCOPES : simplefinAccess(this.vault) && !plaidApp(this.vault) ? SIMPLEFIN_SCOPES : PLAID_SCOPES;
        this.store.setCeiling(id, { provenance: 'checked', scopes, at: Date.now() });
      }
      const client = await this.client(connection);
      const tools = (await client.listTools()).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, reads: readsOnly(t) }));
      this.store.setTools(id, tools);
      if (client.scopes) this.store.setCeiling(id, { provenance: 'checked', scopes: client.scopes, at: Date.now() });
      this.healthy(connection);
    } catch (err) {
      this.failed(connection, err);
    }
    return this.store.get(id)!;
  }

  /** New credentials, then a test. Reconnecting re-checks the ceiling where the service can say. */
  async reconnect(id: string, secrets: Record<string, string>): Promise<Connection> {
    const connection = this.require(id);
    this.store.setServer(id, this.withSecrets(id, connection.server, secrets));
    return this.test(id);
  }

  /** Stops using it, forgets its secrets and grants. Its activity stays, so what it did is still answerable. */
  /**
   * Stops using it and forgets everything only it used: its own vault records, and the set-up-once
   * credentials behind it once nothing else needs them — your Google or X app, your Plaid app and the
   * banks linked with it (ended at Plaid too), your SimpleFIN address. What it did stays in its activity.
   */
  async disconnect(id: string): Promise<{ alsoForgot: string[] }> {
    const connection = this.require(id);
    this.drop(id);
    for (const name of this.vault.names()) if (name.startsWith(`connection/${id}/`)) this.vault.remove(name);
    this.store.remove(id);
    const alsoForgot: string[] = [];
    const others = this.store.list();
    const server = connection.server;
    if (server.kind === 'builtin' && server.builtin === 'finance' && !others.some((c) => c.server.kind === 'builtin' && c.server.builtin === 'finance')) {
      const app = plaidApp(this.vault);
      for (const item of app?.items ?? []) {
        // Ended where it was made, not just forgotten here.
        await plaidRemoveItem(app!, item.accessToken).catch(() => undefined);
      }
      if (app) alsoForgot.push(app.items.length ? `your Plaid app and ${app.items.length} linked bank${app.items.length === 1 ? '' : 's'} (ended at Plaid too)` : 'your Plaid app');
      if (simplefinAccess(this.vault)) alsoForgot.push('your SimpleFIN address');
      this.vault.remove(PLAID_SECRET);
      this.vault.remove(SIMPLEFIN_SECRET);
    }
    if (server.kind === 'stdio' && server.google && !others.some((c) => c.server.kind === 'stdio' && c.server.google) && this.vault.has(GOOGLE_CLIENT_SECRET)) {
      this.vault.remove(GOOGLE_CLIENT_SECRET);
      alsoForgot.push('your Google sign-in client');
    }
    if (server.kind === 'stdio' && server.x && !others.some((c) => c.server.kind === 'stdio' && c.server.x) && this.vault.has(X_CLIENT_SECRET)) {
      this.vault.remove(X_CLIENT_SECRET);
      alsoForgot.push('your X app');
    }
    return { alsoForgot };
  }

  /** What disconnecting would also forget, so the question can say it before it's answered. */
  alsoForgets(id: string): string[] {
    const connection = this.store.get(id);
    if (!connection) return [];
    const others = this.store.list().filter((c) => c.id !== id);
    const server = connection.server;
    if (server.kind === 'builtin' && server.builtin === 'finance' && !others.some((c) => c.server.kind === 'builtin' && c.server.builtin === 'finance')) {
      const app = plaidApp(this.vault);
      return [
        ...(app ? [app.items.length ? `your Plaid app and ${app.items.length} linked bank${app.items.length === 1 ? '' : 's'}, which are unlinked at Plaid too` : 'your Plaid app'] : []),
        ...(simplefinAccess(this.vault) ? ['your SimpleFIN address'] : []),
      ];
    }
    if (server.kind === 'stdio' && server.google && !others.some((c) => c.server.kind === 'stdio' && c.server.google) && this.vault.has(GOOGLE_CLIENT_SECRET)) return ['your Google sign-in client'];
    if (server.kind === 'stdio' && server.x && !others.some((c) => c.server.kind === 'stdio' && c.server.x) && this.vault.has(X_CLIENT_SECRET)) return ['your X app'];
    return [];
  }

  /** The Browser connection's kept sign-ins. */
  signIns(connection: string): BrowserSignIn[] {
    return this.store.signIns.list(connection);
  }

  /**
   * Whether a sign-in may be used in a project right now, and why not. It's used only where nobody but
   * its owner has a role: anyone else there could ask an agent to read what it reaches (secrets.md,
   * multiplayer). The install owner isn't counted — they can read the vault on their own computer anyway.
   */
  signInHeldBack(signIn: BrowserSignIn, project: string): string | undefined {
    if (!signIn.projects.includes(project)) return 'it isn’t kept for this project';
    const others = (this.people?.inProject(project) ?? []).filter((person) => person !== signIn.owner);
    if (others.length === 0) return undefined;
    return `other people in ${project} could see what it reaches (${others.length === 1 ? '1 person' : `${others.length} people`} besides ${this.people?.name(signIn.owner) ?? 'its owner'}), so it’s used only where it’s ${this.people?.name(signIn.owner) ?? 'its owner'}’s alone`;
  }

  /** Opens a live view for a person to sign in to a site by hand: afresh, or again for a sign-in they kept. */
  async startSignIn(opts: { connection: string; person: string; url: string; width: number; height: number; signIn?: string }): Promise<string> {
    const connection = this.require(opts.connection);
    if (connection.server.kind !== 'builtin') throw new PolyphemusError(`${connection.name} isn’t a browser.`, 'USAGE');
    let had: KeptSignIn | undefined;
    if (opts.signIn) {
      const kept = this.store.signIns.get(opts.signIn);
      if (!kept || kept.connection !== connection.id || kept.owner !== opts.person) throw new PolyphemusError('No such sign-in.', 'NOT_FOUND');
      had = this.signInKept(kept);
    }
    return this.live.start({ connection: connection.id, person: opts.person, url: opts.url, width: opts.width, height: opts.height, ...(had?.cookies.length && { cookies: had.cookies }), ...(had?.storage && { storage: had.storage }), ...(opts.signIn && { signIn: opts.signIn }) });
  }

  /**
   * Keeps what a person signed in to in a live view: the cookies for the site the page is on now,
   * and what that page holds in `localStorage` for sites that keep their session there rather than
   * in cookies. Signing in again replaces what was kept for the same origin and leaves the rest; a
   * new sign-in starts used nowhere.
   */
  async keepSignIn(liveId: string, person: string): Promise<BrowserSignIn> {
    const live = this.live.get(liveId, person);
    const { url, all, stored } = await this.live.with(liveId, person, async (tab) => ({ url: (await tab.hands.view()).url, all: await tab.cookies(), stored: await tab.storage() }));
    const existing = live.signIn ? this.store.signIns.get(live.signIn) : undefined;
    const site = existing?.site ?? siteOf(url);
    if (!site) throw new PolyphemusError('Open the site you signed in to first: there’s no site on this page to keep a sign-in for.', 'USAGE');
    const cookies = all.filter((c) => cookieForSite(c, site));
    const mine = stored && Object.keys(stored.local).length > 0 && storageForSite(stored.origin, site) ? stored : undefined;
    const before = existing ? this.signInKept(existing).storage ?? [] : [];
    const storage = [...before.filter((s) => s.origin !== mine?.origin), ...(mine ? [mine] : [])];
    const kept: KeptSignIn = { cookies, ...(storage.length && { storage }) };
    if (!keptSomething(kept)) throw new PolyphemusError(`${site} hasn’t set anything to keep yet. Sign in first, then keep it.`, 'USAGE');
    const signIn = existing ?? this.store.signIns.add({ connection: live.connection, site, owner: person, projects: [] });
    this.saveSignIn(signIn.id, kept);
    await this.live.cancel(liveId, person);
    return this.store.signIns.get(signIn.id)!;
  }

  /** Where a sign-in may be used: only projects that have the Browser connection. */
  setSignInProjects(id: string, projects: string[]): BrowserSignIn {
    const signIn = this.store.signIns.get(id);
    if (!signIn) throw new PolyphemusError('No such sign-in.', 'NOT_FOUND');
    const granted = new Set(this.store.grants(signIn.connection).filter((g) => g.agent === '').map((g) => g.project));
    const missing = projects.filter((p) => !granted.has(p));
    if (missing.length) throw new PolyphemusError(`The browser isn’t granted to ${missing.join(', ')}, so a sign-in can’t be used there.`, 'USAGE');
    this.store.signIns.setProjects(id, projects);
    return this.store.signIns.get(id)!;
  }

  /** Forgets a sign-in: its cookies go from the vault. Browsers already signed in with it get a fresh one on their next call. */
  removeSignIn(id: string): void {
    const signIn = this.store.signIns.get(id);
    if (!signIn) return;
    this.vault.remove(signInSecretName(signIn.connection, id));
    this.store.signIns.remove(id);
  }

  private signInKept(signIn: BrowserSignIn): KeptSignIn {
    return parseKept(this.vault.get(signInSecretName(signIn.connection, signIn.id), `connection ${signIn.connection}`));
  }

  private saveSignIn(id: string, kept: KeptSignIn): void {
    const signIn = this.store.signIns.get(id);
    // Removed while a browser still had it: what the site refreshed isn't brought back.
    if (!signIn) return;
    const note = kept.storage?.length ? `Browser cookies and stored session for ${signIn.site}` : `Browser cookies for ${signIn.site}`;
    this.vault.set(signInSecretName(signIn.connection, id), JSON.stringify(kept), { kind: 'token', note });
    this.store.signIns.touch(id, 'updated');
  }

  /** The sign-ins a browser call in a project starts with, and the ones held back from it. */
  private browserContext(connection: Connection, ctx: CallContext): McpCallContext {
    const base: McpCallContext = { ...(ctx.sessionId && { sessionId: ctx.sessionId }), ...(ctx.agent && { agent: ctx.agent }), ...(ctx.cwd && { cwd: ctx.cwd }), ...(ctx.root && { root: ctx.root }) };
    if (connection.server.kind !== 'builtin' || !ctx.project) return base;
    const signIns: SignInForTab[] = [];
    const heldBack: Array<{ site: string; why: string }> = [];
    for (const signIn of this.store.signIns.list(connection.id)) {
      if (!signIn.projects.includes(ctx.project)) continue;
      const why = this.signInHeldBack(signIn, ctx.project);
      if (why) heldBack.push({ site: signIn.site, why });
      else {
        const kept = this.signInKept(signIn);
        signIns.push({ id: signIn.id, site: signIn.site, ownerName: this.people?.name(signIn.owner) ?? 'someone', cookies: kept.cookies, ...(kept.storage && { storage: kept.storage }) });
      }
    }
    for (const s of signIns) this.store.signIns.touch(s.id, 'used');
    return { ...base, ...(signIns.length && { signIns }), ...(heldBack.length && { heldBack }) };
  }

  /**
   * The owner says what they made the credential able to do: these tools, or (undefined) back to
   * unknown. Declaring can only name tools the server offers, and grants are trimmed to fit.
   */
  declareCeiling(id: string, tools: string[] | undefined, by: string): Connection {
    const connection = this.require(id);
    // What the service told us isn't overwritten by what someone says: grants narrow a checked ceiling.
    if (connection.ceiling.provenance === 'checked') throw new PolyphemusError(`${connection.name} already said what its credential can do, so there’s nothing to declare. To use less, grant fewer tools.`, 'USAGE');
    if (tools === undefined) {
      this.store.setCeiling(id, { provenance: 'unknown' });
      return this.store.get(id)!;
    }
    const offered = connection.tools.map((t) => t.name);
    const unknown = tools.filter((tool) => !offered.includes(tool));
    if (unknown.length > 0) throw new PolyphemusError(`${connection.name} doesn’t offer ${unknown.join(', ')}.`, 'USAGE');
    this.store.setCeiling(id, { provenance: 'declared', tools, by, at: Date.now() });
    return this.store.get(id)!;
  }

  /**
   * Grants (or regrants) tools to a project, to an agent within one, or — with no project — to an
   * agent itself, which then carries it wherever it works. Refuses anything wider than what it narrows.
   */
  grant(request: { connection: string; project?: string; agent?: string; tools: string[]; by: string }): Grant {
    const connection = this.require(request.connection);
    const agent = request.agent ?? '';
    const project = request.project ?? '';
    const tools = [...new Set(request.tools)];
    const projectGrant = project ? this.store.grants(connection.id).find((g) => g.project === project && g.agent === '') : undefined;
    checkGrant({ tools, agent, project }, ceilingTools(connection.tools, connection.ceiling), projectGrant);
    const grant: Grant = { connection: connection.id, project, agent, tools, by: request.by, at: Date.now() };
    this.store.setGrant(grant);
    return grant;
  }

  revoke(connection: string, project: string, agent = ''): boolean {
    this.require(connection);
    // With no project and no agent there's nothing to take away, and the store would read that as
    // "every grant an agent carries".
    if (!project && !agent) throw new PolyphemusError('Say which project, or which agent, to take it from.', 'USAGE');
    const gone = this.store.revokeGrant(connection, project, agent);
    // Nobody may call it any more, so nothing of it stays running: the server polyphemus started for it
    // is holding the credential and a connection to the service (connections review, 2026-09-20).
    if (gone && !this.store.grants(connection).length) this.drop(connection);
    return gone;
  }

  /**
   * What a thread's speaker may call here, connection by connection, and which grant says so. With no
   * project there's still what the agent carries — that's what a DM with an agent can reach.
   */
  reach(project: string | undefined, agent: string | undefined): ReachableConnection[] {
    if (!project && !agent) return [];
    const grants = this.store.grants();
    const connections = this.store.list();
    const found = connections.flatMap((connection) => {
      const reach = reachOf(connection.tools, connection.ceiling, grants.filter((g) => g.connection === connection.id), project, agent);
      if (!reach || reach.tools.length === 0) return [];
      return [{ ...reach, name: connection.name, toolDefs: connection.tools.filter((t) => reach.tools.includes(t.name)), service: serviceOf(connection) }];
    });
    // An agent's own identity for a service replaces the project's: the Reviewer granted its own
    // GitHub identity doesn't also act as the project's Builder.
    const own = new Set(found.filter((r) => !r.inherited && r.from.agent).map((r) => r.service));
    return found.filter((r) => !(r.inherited && own.has(r.service))).map(({ service: _service, ...r }) => r);
  }

  /** Saves a GitHub App identity's key and details, from GitHub's manifest flow. */
  saveGitHubApp(id: string, record: GitHubAppRecord): void {
    this.vault.set(githubAppSecretName(id), JSON.stringify(record), { kind: 'token', note: `The private key of the GitHub App ${record.name}` });
  }

  /** The app was installed on repositories: record where, and test it. */
  async setGitHubInstallation(id: string, installationId: number): Promise<Connection> {
    const record = this.githubApp(id);
    if (!record) throw new PolyphemusError('That GitHub identity has no app behind it.', 'NOT_FOUND');
    this.saveGitHubApp(id, { ...record, installationId });
    this.appTokens.delete(id);
    return this.test(id);
  }

  /**
   * Makes one call, if the grant allows it right now. A refusal is a result the model reads, not an
   * exception: it should carry on with what it can do and say what it couldn't.
   */
  async call(connectionId: string, tool: string, args: Record<string, unknown>, ctx: CallContext): Promise<CallResult> {
    const connection = this.store.get(connectionId);
    const record = (outcome: 'ok' | 'refused' | 'failed', detail?: string) => {
      this.store.record({ connection: connectionId, tool, outcome, detail, sessionId: ctx.sessionId, agent: ctx.agent, actor: ctx.actor });
      for (const listener of this.callListeners) listener({ connection: connectionId, name: connection?.name ?? connectionId, tool, outcome, detail, ctx });
    };
    const allowed = connection && this.reach(ctx.project, ctx.agent).find((r) => r.connection === connectionId)?.tools.includes(tool);
    if (!connection || !allowed) {
      const who = ctx.agent ? ctx.agent : 'this thread';
      const why = ctx.project
        ? `isn’t granted to ${who} in ${ctx.project}`
        : ctx.agent
          ? `isn’t granted to ${who} itself, and this thread is in no project`
          : 'can’t be used by a thread with no project and no agent';
      const detail = `${tool} ${why}`;
      if (connection) record('refused', detail);
      return { content: `Polyphemus refused this call: ${tool} on ${connection?.name ?? connectionId} ${why}. Carry on without it, and say what you couldn’t do.`, isError: true };
    }
    // The secrets as they were before the call, and as they are after it: getting a client can refresh
    // a token that's about to expire, with no 401 first (re-review, 2026-09-19), and a service may echo
    // either one. Masked with both, whatever happened in between.
    const before = this.redactor(connection);
    const redact = (text: string) => this.redactor(connection)(before(text));
    try {
      let result;
      try {
        result = await (await this.client(connection)).callTool(tool, args, this.browserContext(connection, ctx));
      } catch (err) {
        // A signed-in token refused before its time: refresh it once, restart the server, try again.
        if (!(err instanceof McpError && err.kind === 'auth' && connection.server.auth)) throw err;
        this.drop(connection.id);
        const refreshed = connection.server.auth === 'github-app' ? (this.appTokens.delete(connection.id), true) : await this.oauth.refresh(connection.id).catch(() => false);
        if (!refreshed) throw err;
        result = await (await this.client(connection)).callTool(tool, args, this.browserContext(connection, ctx));
      }
      const content = redact(result.text);
      record(result.isError ? 'failed' : 'ok', result.isError ? clipLine(content) : undefined);
      if (!result.isError) this.healthy(connection);
      return { content, isError: result.isError, ...(result.images?.length && { images: result.images }) };
    } catch (err) {
      const message = redact((err as Error).message);
      record('failed', clipLine(message));
      // A refused credential or a server that's gone is the owner's to fix; a bad argument is the model's.
      if (!(err instanceof McpError) || err.kind === 'auth' || err.kind === 'unavailable') this.failed(connection, err, ctx.sessionId, message);
      return { content: `${connection.name} failed: ${message}`, isError: true };
    }
  }

  close(): void {
    for (const id of [...this.clients.keys()]) this.drop(id);
    this.live.close();
  }

  private require(id: string): Connection {
    const connection = this.store.get(id);
    if (!connection) throw new PolyphemusError(`There's no connection called "${id}".`, 'NOT_FOUND');
    return connection;
  }

  private client(connection: Connection): Promise<McpClient> {
    let client = this.clients.get(connection.id);
    // A server holding an access token that's about to run out is restarted with a fresh one.
    const expiry = this.expiries.get(connection.id);
    if (client && expiry !== undefined && Date.now() > expiry - 60_000) {
      this.drop(connection.id);
      client = undefined;
    }
    if (!client) {
      client = this.resolve(connection).then((def) => this.connect(def, { saveSignIn: (signIn, kept) => this.saveSignIn(signIn, kept), openBrowser: () => this.openBrowser(), hasBrowser: () => this.hasBrowser(), financeClient: () => (plaidApp(this.vault) ? plaidClient(() => plaidApp(this.vault), (app) => savePlaidApp(this.vault, app)) : simplefinClient(() => simplefinAccess(this.vault))), computerClient: () => this.computerClient!() }));
      client.catch(() => this.clients.delete(connection.id));
      this.clients.set(connection.id, client);
    }
    return client;
  }

  private drop(id: string): void {
    const client = this.clients.get(id);
    this.clients.delete(id);
    this.expiries.delete(id);
    client?.then((c) => c.close()).catch(() => {});
  }

  private healthy(connection: Connection): void {
    if (this.store.setHealth(connection.id, 'ok')) this.emit(connection.id);
  }

  private failed(connection: Connection, err: unknown, sessionId?: string, message = (err as Error).message): void {
    const kind = err instanceof McpError && err.kind !== 'tool' ? err.kind : 'unavailable';
    this.drop(connection.id);
    if (this.store.setHealth(connection.id, 'failing', { error: this.redactor(connection)(message), kind, sessionId })) this.emit(connection.id);
  }

  private emit(id: string): void {
    const connection = this.store.get(id);
    if (connection) for (const listener of this.listeners) listener(connection);
  }

  /** Secret values are stored in the vault under the connection; the definition keeps references. */
  private withSecrets(id: string, server: McpServerDefinition, secrets: Record<string, string>): McpServerDefinition {
    const refs: Record<string, string> = {};
    for (const [key, value] of Object.entries(secrets)) {
      if (!value) continue;
      const name = `connection/${id}/${key.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;
      this.vault.set(name, value, { kind: 'token', note: `${key} for the ${id} connection` });
      refs[key] = secretRef(name);
    }
    if (server.kind === 'builtin') return server;
    if (server.kind === 'stdio') return { ...server, env: { ...server.env, ...refs } };
    // For a remote server, a secret is a bearer token unless it names a header.
    const headers = { ...server.headers };
    for (const [key, ref] of Object.entries(refs)) {
      if (/^(token|bearer|api[-_]?key)$/i.test(key)) headers.Authorization = `Bearer {${ref}}`;
      else headers[key] = ref;
    }
    return { ...server, headers };
  }

  /** A GitHub App identity's record, from the vault. */
  githubApp(id: string): GitHubAppRecord | undefined {
    const raw = this.vault.get(githubAppSecretName(id), `connection ${id}`);
    return raw ? (JSON.parse(raw) as GitHubAppRecord) : undefined;
  }

  /**
   * The installed GitHub identity for a role that's granted in a project, for a workflow to act as.
   * Any grant in the project counts — the project's own, or one of its agents'.
   */
  githubIdentity(project: string, role: GitHubRole): { connection: string; record: GitHubAppRecord } | undefined {
    const granted = new Set(this.store.grants().filter((g) => g.project === project).map((g) => g.connection));
    for (const connection of this.store.list()) {
      if (connection.server.kind !== 'stdio' || connection.server.github !== role || !granted.has(connection.id)) continue;
      const record = this.githubApp(connection.id);
      if (record?.installationId) return { connection: connection.id, record };
    }
    return undefined;
  }

  /** An installed GitHub identity that GitHub said can reach this repository, whichever role — for reading it. */
  githubIdentityForRepo(repo: string): { connection: string; record: GitHubAppRecord } | undefined {
    const wanted = `repo ${repo}`.toLowerCase();
    for (const connection of this.store.list()) {
      if (connection.server.kind !== 'stdio' || !connection.server.github) continue;
      if (!(connection.ceiling.scopes ?? []).some((scope) => scope.toLowerCase() === wanted)) continue;
      const record = this.githubApp(connection.id);
      if (record?.installationId) return { connection: connection.id, record };
    }
    return undefined;
  }

  /** An installation token for a GitHub App identity: made from its key, kept until it's nearly out. */
  async githubToken(id: string): Promise<{ token: string; expiresAt: number; permissions: Record<string, string>; repositories: string[] }> {
    const record = this.githubApp(id);
    if (!record) throw new McpError('This GitHub identity has no app behind it.', 'auth');
    const fresh = await installationToken(record).catch((err: Error) => {
      throw new McpError(err.message, /\b40[13]\b/.test(err.message) ? 'auth' : 'unavailable');
    });
    this.appTokens.set(id, { token: fresh.token, expiresAt: fresh.expiresAt });
    return fresh;
  }

  /** The definition with its secrets filled in — only ever handed to the MCP client, never to a model. */
  private async resolve(connection: Connection): Promise<McpServerDefinition> {
    connection = { ...connection, server: ownServer(connection.server) };
    if (connection.server.auth === 'github-app' && connection.server.kind === 'stdio') {
      let cached = this.appTokens.get(connection.id);
      if (!cached || cached.expiresAt - Date.now() < 5 * 60_000) cached = await this.githubToken(connection.id);
      this.expiries.set(connection.id, cached.expiresAt);
      return { ...connection.server, env: { ...connection.server.env, ACCESS_TOKEN: cached.token } };
    }
    if (connection.server.auth === 'oauth') {
      const token = await this.oauth.accessToken(connection.id).catch((err: Error) => {
        throw new McpError(`Signing in again didn’t work: ${err.message}`, 'auth');
      });
      if (!token) throw new McpError(`Not signed in to ${connection.name} yet.`, 'auth');
      const expiresAt = this.oauth.expiresAt(connection.id);
      if (expiresAt !== undefined) this.expiries.set(connection.id, expiresAt);
      // A local server gets the access token and nothing else: no refresh token, no client secret.
      if (connection.server.kind === 'stdio') return { ...connection.server, env: { ...connection.server.env, ACCESS_TOKEN: token } };
      return { ...connection.server, headers: { ...connection.server.headers, Authorization: `Bearer ${token}` } };
    }
    const by = `connection ${connection.id}`;
    const fill = (value: string) => (isSecretRef(value) ? this.vault.resolve(value, by) : value.replace(TEMPLATE, (_, ref: string) => this.vault.resolve(ref, by)));
    const each = (record: Record<string, string> | undefined) => record && Object.fromEntries(Object.entries(record).map(([k, v]) => [k, fill(v)]));
    const server = connection.server;
    if (server.kind === 'builtin') return server;
    return server.kind === 'stdio' ? { ...server, env: each(server.env) } : { ...server, headers: each(server.headers) };
  }

  private redactor(connection: Connection): (text: string) => string {
    // Every value the vault holds, not only this connection's: masking isn't a use, so it isn't audited.
    // An OAuth sign-in is kept as one record: its tokens are masked one by one, not only as a whole.
    const tokens = this.vault.names().filter((name) => name === oauthSecretName(connection.id)).flatMap((name) => {
      const record = JSON.parse(this.vault.get(name, `connection ${connection.id}`) ?? '{}') as { accessToken?: string; refreshToken?: string };
      return [record.accessToken, record.refreshToken].filter((t): t is string => Boolean(t));
    });
    // So is a kept sign-in: a page that prints a session cookie — or a token the site left in
    // localStorage — doesn't hand it to the model.
    const kept = connection.server.kind === 'builtin'
      ? this.store.signIns.list(connection.id).flatMap((s) => {
          const it = this.signInKept(s);
          return [...it.cookies.map((c) => c.value), ...(it.storage ?? []).flatMap((o) => Object.values(o.local))];
        })
      : [];
    return makeRedactor([...this.vault.values(), ...tokens, ...kept]);
  }
}

function validServer(server: McpServerDefinition): McpServerDefinition {
  if (server?.kind === 'builtin') {
    if (server.builtin !== 'browser' && server.builtin !== 'finance' && server.builtin !== 'computer') throw new PolyphemusError('polyphemus has no built-in connection called that.', 'USAGE');
    return { kind: 'builtin', builtin: server.builtin };
  }
  if (server?.kind === 'stdio') {
    if (typeof server.command !== 'string' || !server.command.trim()) throw new PolyphemusError('A local server needs a command to run.', 'USAGE');
    return {
      kind: 'stdio',
      command: server.command.trim(),
      args: (server.args ?? []).map(String),
      ...(server.env && { env: server.env }),
      ...(server.auth && { auth: server.auth }),
      ...(server.google && { google: server.google }),
      ...(server.x && { x: true as const }),
      ...(server.github && { github: server.github }),
    };
  }
  if (server?.kind === 'http') {
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      throw new PolyphemusError('A remote server needs its URL, like https://mcp.example.com/mcp.', 'USAGE');
    }
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new PolyphemusError('A remote server has to be https, so its credential isn’t sent in the clear.', 'USAGE');
    }
    return { kind: 'http', url: url.toString(), ...(server.headers && { headers: server.headers }), ...(server.auth === 'oauth' && { auth: 'oauth' as const }) };
  }
  throw new PolyphemusError('A connection is a local server (a command) or a remote one (a URL).', 'USAGE');
}

const clipLine = (text: string) => (text.length > 240 ? `${text.slice(0, 239)}…` : text).split('\n')[0];

export { GrantRefused };

/**
 * polyphemus's own servers (a GitHub identity, Google Drive or Gmail) are found where this copy of
 * polyphemus keeps them, each time one starts. The path saved when the connection was made points into
 * the release that made it, and deploys remove old releases (2026-09-13: every identity broke).
 */
export function ownServer(server: McpServerDefinition): McpServerDefinition {
  if (server.kind !== 'stdio') return server;
  const fresh = server.github ? githubServer(server.github) : server.google ? googleServer(server.google) : server.x ? xServer() : undefined;
  if (!fresh || fresh.kind !== 'stdio') return server;
  return { ...server, command: fresh.command, args: fresh.args, env: { ...server.env, ...fresh.env } };
}

/** What a connection is an account at, so one identity per service can stand in for another. */
export function serviceOf(connection: Connection): string {
  const server = connection.server;
  if (server.kind === 'builtin') return server.builtin;
  if (server.kind === 'stdio') return server.github ? 'github' : server.google ? `google-${server.google}` : server.x ? 'x' : `connection:${connection.id}`;
  try {
    const host = new URL(server.url).host;
    return host === 'api.githubcopilot.com' ? 'github' : host;
  } catch {
    return `connection:${connection.id}`;
  }
}
