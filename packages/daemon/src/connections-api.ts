import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { GITHUB_ROLES, appManifest, convertManifest, githubServer, githubWeb, installUrl, newAppUrl, type GitHubRole, CONNECTION_CATALOGUE, connectionCatalogueEntry, googleClient, googleServer, setGoogleClient, xClient, xServer, setXClient, plaidApp, savePlaidApp, setPlaidApp, startPlaidLink, startPlaidConsent, finishPlaidLink, plaidItemProducts, plaidAccounts, plaidRemoveItem, PLAID_ALSO, claimSimplefin, saveSimplefinAccess, simplefinAccess, ceilingTools, discoverOAuth, GrantRefused, oauthSecretName, type Connection, type Grant, type Polyphemus, type McpServerDefinition, type BrowserSignIn, TabError, TAB_KEYS } from '@polyphemus/core';
import type { Access } from './access.js';
import { HttpError } from './http-error.js';

// Connections, ceilings and grants over HTTP (settled brief §5). The rules live in core — a grant
// that would widen is refused there — and this file decides who may ask, and what each person is shown.

interface AgentRef {
  id: string;
  title: string;
  project: string | null;
}

export interface ConnectionDeps {
  polyphemus: Polyphemus;
  agentNamed(ref: string, project?: string): AgentRef | undefined;
  /** Agents usable in a project: the library's, and the project's own. */
  agentsIn(project: string): AgentRef[];
  titleOf(sessionId: string): string;
  canSeeSession(access: Access, sessionId: string): boolean;
  changed(connection: string): void;
  /** This daemon's address as the person's browser reaches it: https over the tailnet whenever it can be. */
  publicOrigin(req: IncomingMessage): string;
  log?(line: string): void;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = (at: number | undefined) => (at ? `${new Date(at).getDate()} ${MONTHS[new Date(at).getMonth()]}` : '');
/** How long a sign-in started from a thread still returns there. Matches an OAuth state's own life. */
const SIGN_IN_RETURN_MS = 10 * 60 * 1000;

/**
 * The same site, whatever host it ended on: a card asking for account.withings.com is answered by a
 * sign-in kept at app.withings.com, where the site sent the person (2026-09-22). Two labels, so
 * withings.com covers its subdomains and nothing wider.
 */
export function sameSite(a = '', b = ''): boolean {
  if (!a || !b) return false;
  const base = (host: string) => host.toLowerCase().split('.').slice(-2).join('.');
  return a.toLowerCase() === b.toLowerCase() || base(a) === base(b);
}

const UNKNOWN_CEILING = 'Unknown — polyphemus will hold itself to what you grant, but can’t confirm the key is limited.';

export function connectionRoutes(deps: ConnectionDeps) {
  const { polyphemus } = deps;
  const connections = polyphemus.connections;
  const personName = (id: string | undefined) => (id ? (polyphemus.store.person(id)?.name ?? 'someone who’s gone') : 'someone');
  /** A sign-in this person started from a thread's card: the callback returns there, not to Connections. */
  const signInReturn = new Map<string, { question: string; at: number }>();

  /**
   * An open sign-in question this person can answer, for this connection. A browser question also has
   * to be for the site they actually kept. Nothing here is a token or a cookie.
   */
  function waitingSignIn(access: Access, questionId: string, connectionId: string, how: 'oauth' | 'browser', site?: string) {
    const question = polyphemus.store.question(questionId);
    const meta = question ? polyphemus.store.get(question.sessionId) : undefined;
    if (!question || question.status !== 'open' || question.kind !== 'signin' || question.detail.how !== how || question.detail.connection !== connectionId) return undefined;
    if (how === 'browser' && !sameSite(String(question.detail.site ?? ''), site)) return undefined;
    if (!meta || !access.canWorkInSession(meta)) return undefined;
    return question;
  }

  /** Any card still waiting for a sign-in to this site, whoever opened the view: keeping one answers it. */
  function waitingForSite(access: Access, connectionId: string, site: string) {
    return polyphemus.store
      .openQuestions()
      .filter((q) => q.kind === 'signin' && q.detail.connection === connectionId && q.detail.how === 'browser' && sameSite(String(q.detail.site ?? ''), site))
      .find((q) => {
        const meta = polyphemus.store.get(q.sessionId);
        return meta !== undefined && access.canWorkInSession(meta);
      });
  }

  /** The ceiling in words, never implying the credential is limited when nobody checked (brief §5). */
  function ceilingSays(c: Connection): string {
    const allowed = ceilingTools(c.tools, c.ceiling);
    if (c.ceiling.provenance === 'checked') {
      const scopes = c.ceiling.scopes?.length ? `: ${c.ceiling.scopes.join(', ')}` : '';
      return `Checked with ${c.name} when it was signed in to · ${day(c.ceiling.at)}${scopes}`;
    }
    if (c.ceiling.provenance === 'declared') {
      const reads = allowed.length > 0 && allowed.every((name) => c.tools.find((t) => t.name === name)?.reads);
      const what = reads ? 'Read-only' : allowed.length === c.tools.length ? 'Everything it offers' : `${allowed.length} of ${c.tools.length} tools`;
      return `${what}, declared by ${personName(c.ceiling.by)} · ${day(c.ceiling.at)}. Nobody checked with ${c.name}; polyphemus holds itself to it.`;
    }
    return UNKNOWN_CEILING;
  }

  const visibleProjects = (access: Access) => polyphemus.store.projects().filter((p) => access.canSeeProject(p.slug));

  function canSee(access: Access, c: Connection): boolean {
    return access.canManageConnection(c) || polyphemus.store.connections.grants(c.id).some((g) => access.canSeeProject(g.project));
  }

  function grantView(g: Grant) {
    const agent = g.agent ? deps.agentNamed(g.agent, g.project || undefined) : undefined;
    return {
      project: g.project,
      // A grant an agent carries has no project: it goes with the agent, threads with no project included.
      projectName: g.project ? (polyphemus.store.project(g.project)?.name ?? g.project) : 'anywhere it works',
      agent: g.agent || null,
      agentTitle: g.agent ? (agent?.title ?? g.agent) : null,
      tools: g.tools,
      by: personName(g.by),
      at: g.at,
    };
  }

  function view(c: Connection, access: Access) {
    const manage = access.canManageConnection(c);
    const server = c.server;
    const secrets = Object.entries(server.kind === 'stdio' ? (server.env ?? {}) : server.kind === 'http' ? (server.headers ?? {}) : {})
      .filter(([, v]) => v.includes('secret:'))
      .map(([k]) => k);
    const oauth = server.auth === 'oauth';
    return {
      id: c.id,
      name: c.name,
      owner: { id: c.owner, name: personName(c.owner), you: c.owner === access.person.id },
      kind: server.kind,
      // How it signs in: OAuth (and whether that's been done), a saved key or token, or nothing.
      auth: oauth ? 'oauth' : secrets.length ? 'token' : 'none',
      signedIn: oauth ? polyphemus.vault.has(oauthSecretName(c.id)) : null,
      // A GitHub App identity: which role, which app on GitHub, and whether it's installed anywhere yet.
      github: server.kind === 'stdio' && server.github && manage ? githubView(c.id, server.github) : null,
      // How it's reached, for the people who look after it. Secret values never leave the vault.
      where: manage ? (server.kind === 'builtin' && server.builtin === 'finance' ? (plaidApp(polyphemus.vault) ? `Built into polyphemus: it asks Plaid itself (${plaidApp(polyphemus.vault)?.environment}), and the banks you link stay in your vault` : 'Built into polyphemus: it asks SimpleFIN itself, and your access token stays in your vault') : server.kind === 'builtin' && server.builtin === 'computer' ? 'Built into polyphemus: each agent’s own computer, a desktop in a container of its own' : server.kind === 'builtin' ? (polyphemus.runtime() ? 'Built into polyphemus: Chromium in a container of its own, reaching public sites only through polyphemus’s proxy' : 'Built into polyphemus: Chrome on this computer, headless') : server.kind === 'stdio' ? (server.google ? `polyphemus’s own ${server.google === 'drive' ? 'Google Drive' : 'Gmail'} server, on this computer` : server.x ? 'polyphemus’s own X server, on this computer' : [server.command, ...(server.args ?? [])].join(' ')) : server.url) : null,
      secrets: manage ? secrets : [],
      // What disconnecting would take with it, so the question says it before it's answered.
      alsoForgets: manage ? connections.alsoForgets(c.id) : [],
      tools: c.tools.map(({ name, description, reads }) => ({ name, description: description ?? null, reads })),
      toolsListedAt: c.toolsListedAt ?? null,
      ceiling: {
        provenance: c.ceiling.provenance,
        tools: ceilingTools(c.tools, c.ceiling),
        by: c.ceiling.by ? personName(c.ceiling.by) : null,
        at: c.ceiling.at ?? null,
        scopes: c.ceiling.scopes ?? null,
        says: ceilingSays(c),
      },
      health: c.health,
      healthAt: c.healthAt ?? null,
      // What went wrong can quote what the call was about: only for someone who can see where it happened.
      error: c.error === undefined ? null : !c.errorSession || access.owner || deps.canSeeSession(access, c.errorSession) ? c.error : 'It failed in a thread you can’t see. The owner of this install can see why.',
      errorKind: c.errorKind ?? null,
      errorSession: c.errorSession && deps.canSeeSession(access, c.errorSession) ? { id: c.errorSession, title: deps.titleOf(c.errorSession) } : null,
      grants: polyphemus.store.connections.grants(c.id).filter((g) => (g.project ? access.canSeeProject(g.project) : true)).map(grantView),
      // The browser's kept sign-ins: your own, and — for the install owner — everyone's, never their cookies.
      signIns: server.kind === 'builtin' && server.builtin === 'browser' ? connections.signIns(c.id).filter((s) => s.owner === access.person.id || access.owner).map((s) => signInView(s, access)) : null,
      // Finance: the banks linked through Plaid, for the people who look after this connection.
      banks: server.kind === 'builtin' && server.builtin === 'finance' && manage && plaidApp(polyphemus.vault) ? (plaidApp(polyphemus.vault)?.items ?? []).map(bankView) : null,
      // Which way Finance is set up, so its page says what to do next.
      finance: server.kind === 'builtin' && server.builtin === 'finance' && manage ? (plaidApp(polyphemus.vault) ? 'plaid' : simplefinAccess(polyphemus.vault) ? 'simplefin' : null) : null,
      // Sandbox is Plaid's fake banks: the page says so where you'd otherwise find out at the bank picker.
      financeEnvironment: server.kind === 'builtin' && server.builtin === 'finance' && manage ? (plaidApp(polyphemus.vault)?.environment ?? null) : null,
      // Where you could use a sign-in of yours: projects the browser is granted to that you work in.
      signInProjects: server.kind === 'builtin' && server.builtin === 'browser' ? signInProjects(c, access) : null,
      canManage: manage,
      canGrant: access.canGrant,
    };
  }

  /** One linked bank: what it's called, when it was linked, and what it's consented to answer for. */
  function bankView(item: { itemId: string; institution: string; addedAt: number; products?: string[] }) {
    const products = item.products ?? [];
    return {
      id: item.itemId,
      name: item.institution,
      at: item.addedAt,
      products,
      // Only what Plaid actually told us can be missing: a bank linked before polyphemus asked reports nothing.
      missing: products.length ? PLAID_ALSO.filter((p) => !products.includes(p)) : [],
      unknown: products.length === 0,
    };
  }

  function signInProjects(c: Connection, access: Access) {
    const granted = new Set(polyphemus.store.connections.grants(c.id).filter((g) => g.agent === '').map((g) => g.project));
    return polyphemus.store.projects().filter((p) => granted.has(p.slug) && access.canWorkInProject(p.slug)).map((p) => ({ slug: p.slug, name: p.name }));
  }

  function signInView(s: BrowserSignIn, access: Access) {
    return {
      id: s.id,
      site: s.site,
      owner: { name: personName(s.owner), you: s.owner === access.person.id },
      projects: s.projects.filter((p) => access.canSeeProject(p)).map((p) => ({ slug: p, name: polyphemus.store.project(p)?.name ?? p, heldBack: connections.signInHeldBack(s, p) ?? null })),
      updatedAt: s.updatedAt,
      usedAt: s.usedAt ?? null,
    };
  }

  function githubView(id: string, role: GitHubRole) {
    const record = connections.githubApp(id);
    const org = record && record.owner ? record.owner : null;
    return {
      role,
      roleTitle: GITHUB_ROLES[role].title,
      does: GITHUB_ROLES[role].does,
      app: record ? { name: record.name, slug: record.slug, owner: record.owner, url: record.htmlUrl ?? `${githubWeb()}/apps/${record.slug}` } : null,
      installed: Boolean(record?.installationId),
      manageUrl: record?.installationId ? `${githubWeb()}/${org ? `organizations/${org}/` : ''}settings/installations/${record.installationId}` : null,
    };
  }

  // GitHub App identities being made: GitHub's manifest flow comes back with these, and nothing else counts.
  const creating = new Map<string, { role: GitHubRole; org?: string; owner: string; createdBy: string; at: number }>();
  const installing = new Map<string, { connection: string; at: number }>();
  const fresh = <T extends { at: number }>(map: Map<string, T>, key: string): T | undefined => {
    for (const [k, v] of map) if (Date.now() - v.at > 30 * 60_000) map.delete(k);
    const value = map.get(key);
    map.delete(key);
    return value;
  };

  /** Back from GitHub: the app was created (then off to install it), or installed (then home to its page). */
  async function githubCallback(url: URL, access: Access): Promise<string> {
    if (!access.owner) throw new HttpError(403, 'Only the owner of this install can add a GitHub identity.');
    if (url.pathname === '/github/app-created') {
      const pending = fresh(creating, url.searchParams.get('state') ?? '');
      const code = url.searchParams.get('code') ?? '';
      if (!pending || !code) throw new HttpError(400, 'That isn’t a GitHub App polyphemus started making, or it took too long. Start again from Connections.');
      const record = await convertManifest(code, pending.role).catch((err: Error) => {
        deps.log?.(`GitHub App wasn’t created: ${err.message}`);
        throw new HttpError(502, err.message);
      });
      const name = `GitHub ${GITHUB_ROLES[pending.role].title}${pending.org ? ` · ${pending.org}` : ''}`;
      const added = await connections.add({ name, owner: pending.owner, server: githubServer(pending.role), createdBy: pending.createdBy });
      connections.saveGitHubApp(added.id, record);
      deps.log?.(`Created GitHub App ${record.name} (${record.slug}) as ${added.id}; installing it next`);
      deps.changed(added.id);
      const state = randomBytes(18).toString('base64url');
      installing.set(state, { connection: added.id, at: Date.now() });
      return installUrl(record, state);
    }
    if (url.pathname === '/github/app-installed') {
      const installationId = Number(url.searchParams.get('installation_id'));
      if (!Number.isInteger(installationId) || installationId <= 0) throw new HttpError(400, 'GitHub didn’t say which installation.');
      // Straight after creating it, the state says which identity; a later change of repositories on GitHub has none.
      const pending = fresh(installing, url.searchParams.get('state') ?? '');
      const id = pending?.connection ?? connections.list().find((c) => c.server.kind === 'stdio' && c.server.github && connections.githubApp(c.id)?.installationId === installationId)?.id;
      if (!id) throw new HttpError(400, 'That installation isn’t one of polyphemus’s GitHub identities.');
      const after = await connections.setGitHubInstallation(id, installationId);
      deps.log?.(`GitHub identity ${after.name} installed (${installationId}): ${after.health}`);
      deps.changed(id);
      return `/#/connections/${encodeURIComponent(id)}`;
    }
    throw new HttpError(404, 'Not found.');
  }

  function activityView(c: Connection, access: Access) {
    return polyphemus.store.connections.activity(c.id, 50).map((a) => {
      // A call made in a thread this person can't see is still a call; it just doesn't say where.
      const visible = a.sessionId !== undefined && deps.canSeeSession(access, a.sessionId);
      // Its detail (an error can quote a record) and who made it are for those who can see the thread,
      // and the owner; everyone else sees that a call happened (independent review, 2026-09-19).
      const open = visible || access.owner || a.sessionId === undefined;
      return {
        at: a.at,
        tool: a.tool,
        outcome: a.outcome,
        detail: open ? (a.detail ?? null) : null,
        session: visible ? { id: a.sessionId!, title: deps.titleOf(a.sessionId!) } : null,
        agent: open && a.agent ? (deps.agentNamed(a.agent)?.title ?? a.agent) : null,
        by: !open ? null : a.actor?.startsWith('person:') ? personName(a.actor.slice(7)) : a.actor?.startsWith('routine:') ? 'a routine' : null,
      };
    });
  }

  /** "What can this agent reach here, and why?" — per connection: the tools, and the grant and who made it. */
  function reachFor(project: string, agent: AgentRef | undefined) {
    return connections.reach(project || undefined, agent?.id).map((r) => {
      const grant = grantView(r.from);
      const why = r.carried
        ? `Granted to ${agent?.title ?? 'it'} itself by ${grant.by} · ${day(grant.at)}: it carries this wherever it works`
        : r.inherited || !agent
          ? `Granted to ${grant.projectName} by ${grant.by} · ${day(grant.at)}${agent ? `; ${agent.title} has no grant of its own, so it inherits the project’s` : ''}`
          : `Granted to ${agent.title} in ${grant.projectName} by ${grant.by} · ${day(grant.at)}, narrowing the project’s grant`;
      const c = connections.get(r.connection)!;
      return {
        connection: r.connection,
        name: r.name,
        health: c.health,
        tools: r.toolDefs.map(({ name, reads }) => ({ name, reads })),
        inherited: r.inherited,
        carried: r.carried,
        why,
        ceiling: { provenance: c.ceiling.provenance, says: ceilingSays(c) },
      };
    });
  }

  function serverFrom(body: Record<string, unknown>): McpServerDefinition {
    if (body.kind === 'http') return { kind: 'http', url: String(body.url ?? ''), ...(body.auth === 'oauth' && { auth: 'oauth' as const }) };
    const args = Array.isArray(body.args) ? body.args.map(String) : typeof body.args === 'string' ? body.args.split(/\s+/).filter(Boolean) : [];
    return { kind: 'stdio', command: String(body.command ?? ''), args };
  }

  const secretsFrom = (value: unknown): Record<string, string> => {
    if (!value || typeof value !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) throw new HttpError(400, `"${k}" isn't a name a secret can go by: letters, digits and _ only.`);
      if (typeof v === 'string' && v) out[k] = v;
    }
    return out;
  };

  const toolsFrom = (value: unknown): string[] => {
    if (!Array.isArray(value)) throw new HttpError(400, 'Say which tools.');
    return value.map(String);
  };

  /** Where the service sends the person back to: this daemon, at the address their browser is using. */
  function callbackFor(req: IncomingMessage): string {
    // Not the Origin header: with no-referrer set, browsers send "null" for the app's own requests,
    // and falling back to http gave services like Notion a return address they rightly refuse.
    return `${deps.publicOrigin(req)}/oauth/callback`;
  }

  /** Back from signing in at the service. Returns where to send the browser, or throws with what went wrong. */
  async function oauthCallback(url: URL, access: Access): Promise<{ redirect: string; connection: string }> {
    const error = url.searchParams.get('error');
    if (error) {
      deps.log?.(`Sign-in came back with an error: ${error}${url.searchParams.get('error_description') ? ` — ${url.searchParams.get('error_description')}` : ''}`);
      throw new HttpError(400, `The service didn’t sign you in: ${url.searchParams.get('error_description') ?? error}.`);
    }
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    if (!state || !code) throw new HttpError(400, 'That isn’t a sign-in polyphemus started.');
    const connection = await connections.finishSignIn(state, code).catch((err: Error) => {
      deps.log?.(`Sign-in didn’t finish: ${err.message}`);
      throw err;
    });
    if (!access.canManageConnection(connection)) throw new HttpError(403, 'Signed in, but this connection isn’t yours to look after.');
    deps.log?.(`Signed in to ${connection.name}: ${connection.health}${connection.ceiling.scopes?.length ? ` (${connection.ceiling.scopes.join(', ')})` : ''}`);
    deps.changed(connection.id);
    // Only the card this person started from. Another thread asking for the same service stays waiting.
    const key = `${access.person.id}:${connection.id}`;
    const remembered = signInReturn.get(key);
    signInReturn.delete(key);
    const waiting = remembered && Date.now() - remembered.at < SIGN_IN_RETURN_MS ? waitingSignIn(access, remembered.question, connection.id, 'oauth') : undefined;
    const redirect = waiting ? `/#/s/${waiting.sessionId}` : `/#/connections/${encodeURIComponent(connection.id)}`;
    return { redirect, connection: connection.id };
  }

  /**
   * Signing in to a site by hand, for the browser to keep: a live view only the person who opened it can
   * see or drive, and the sign-ins they kept. Cookies never leave polyphemus: the view is a picture.
   */
  async function signInRoute(req: IncomingMessage, res: ServerResponse, c: Connection, parts: string[], body: Record<string, unknown>, access: Access, send: (res: ServerResponse, status: number, data: unknown) => void): Promise<boolean> {
    const post = req.method === 'POST';
    if (c.server.kind !== 'builtin' || c.server.builtin !== 'browser') throw new HttpError(404, 'That connection doesn’t keep sign-ins.');
    const person = access.person.id;
    const handsOn = async <T>(doing: () => Promise<T>): Promise<T> => {
      try {
        return await doing();
      } catch (err) {
        if (err instanceof TabError) throw new HttpError(400, err.message);
        throw err;
      }
    };

    // Start signing in: a site to open, and the size of the screen it's shown on.
    if (post && parts[3] === 'sign-ins' && parts.length === 4) {
      if (!access.owner && signInProjects(c, access).length === 0) throw new HttpError(403, `${c.name} isn’t granted to a project you work in, so there’s nowhere a sign-in of yours could be used.`);
      const url = normalAddress(String(body.url ?? ''));
      const signIn = typeof body.signIn === 'string' && body.signIn ? body.signIn : undefined;
      const live = await connections.startSignIn({ connection: c.id, person, url, width: Number(body.width) || 390, height: Number(body.height) || 700, ...(signIn && { signIn }) });
      deps.log?.(`${access.person.name} is signing in to ${new URL(url).host} in a live view`);
      send(res, 201, { live });
      return true;
    }

    if (parts[3] === 'live' && parts[4]) {
      const live = decodeURIComponent(parts[4]);
      // A picture of the page, and where it is.
      if (req.method === 'GET' && parts.length === 5) {
        const view = await handsOn(() => connections.live.with(live, person, (tab) => tab.hands.view()));
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Page': encodeURIComponent(JSON.stringify({ url: view.url, title: view.title, secret: view.secret })) });
        res.end(view.jpeg);
        return true;
      }
      if (!post || parts.length !== 6) return false;
      switch (parts[5]) {
        case 'input': {
          const kind = String(body.kind ?? '');
          await handsOn(() =>
            connections.live.with(live, person, async (tab) => {
              if (kind === 'tap') return tab.hands.tapAt(Number(body.x), Number(body.y));
              // The person's own pointer and keyboard, for the checkboxes, menus and small targets a
              // tap and four keys couldn't manage (2026-09-22).
              if (kind === 'move' || kind === 'down' || kind === 'up' || kind === 'double') return tab.hands.pointer(kind, Number(body.x), Number(body.y));
              if (kind === 'text') return tab.hands.insert(String(body.text ?? '').slice(0, 2000));
              if (kind === 'key') {
                if (!TAB_KEYS.includes(String(body.key))) throw new HttpError(400, `polyphemus can press ${TAB_KEYS.join(', ')}.`);
                return tab.hands.key(String(body.key));
              }
              if (kind === 'press') return tab.hands.typeKey(String(body.key ?? ''), Number(body.modifiers) || 0);
              if (kind === 'scroll') return tab.hands.wheel(Number(body.dy) || 0, Number(body.x), Number(body.y));
              if (kind === 'open') return tab.hands.go(normalAddress(String(body.url ?? '')));
              if (kind === 'back') return tab.hands.back();
              throw new HttpError(400, 'Move, press or release the pointer, type, press a key, scroll, open an address or go back.');
            }),
          );
          send(res, 200, { ok: true });
          return true;
        }
        case 'size': {
          const size = await handsOn(() => connections.live.with(live, person, (tab) => tab.hands.resize(Number(body.width) || 390, Number(body.height) || 700)));
          send(res, 200, size);
          return true;
        }
        case 'keep': {
          const kept = await handsOn(() => connections.keepSignIn(live, person));
          const asked = typeof body.question === 'string' ? body.question : '';
          // The card that opened this view, or any other still waiting for this site: a sign-in kept
          // any other way used to leave its card open with no way to clear it (2026-09-22).
          const waiting = (asked ? waitingSignIn(access, asked, c.id, 'browser', kept.site) : undefined) ?? waitingForSite(access, c.id, kept.site);
          if (waiting && typeof waiting.detail.project === 'string' && waiting.detail.project && !kept.projects.includes(waiting.detail.project)) {
            try {
              connections.setSignInProjects(kept.id, [...kept.projects, waiting.detail.project]);
            } catch {
              // The browser isn't granted there. Keeping the sign-in still succeeded.
            }
          }
          const fresh = connections.signIns(c.id).find((s) => s.id === kept.id) ?? kept;
          deps.log?.(`${access.person.name} kept a sign-in to ${fresh.site}`);
          deps.changed(c.id);
          send(res, 200, { signIn: signInView(fresh, access), ...(waiting && { question: waiting.id, thread: waiting.sessionId }) });
          return true;
        }
        case 'cancel':
          await connections.live.cancel(live, person);
          send(res, 200, { cancelled: true });
          return true;
      }
      return false;
    }

    if (post && parts[3] === 'sign-ins' && parts[4] && parts.length === 6) {
      const signIn = polyphemus.store.connections.signIns.get(decodeURIComponent(parts[4]));
      if (!signIn || signIn.connection !== c.id || !(signIn.owner === person || access.owner)) throw new HttpError(404, 'No such sign-in.');
      switch (parts[5]) {
        case 'projects': {
          // Only its owner says where it's used — not even the install owner decides that for them.
          if (signIn.owner !== person) throw new HttpError(403, `This sign-in is ${personName(signIn.owner)}’s: only they choose where it’s used.`);
          const projects = Array.isArray(body.projects) ? body.projects.map(String) : [];
          const allowed = new Set(signInProjects(c, access).map((p) => p.slug));
          const refused = projects.filter((p) => !allowed.has(p));
          if (refused.length) throw new HttpError(403, `You can’t use a sign-in in ${refused.join(', ')}: the browser has to be granted there, and you have to work there.`);
          // Projects this person can't see keep whatever was set before; they can't change what they can't see.
          const kept = signIn.projects.filter((p) => !access.canSeeProject(p));
          const after = connections.setSignInProjects(signIn.id, [...kept, ...projects]);
          deps.log?.(`${access.person.name}’s sign-in to ${signIn.site} is used in: ${after.projects.join(', ') || 'nowhere'}`);
          deps.changed(c.id);
          send(res, 200, { signIn: signInView(after, access) });
          return true;
        }
        case 'remove':
          connections.removeSignIn(signIn.id);
          deps.log?.(`${access.person.name} removed the sign-in to ${signIn.site}${signIn.owner === person ? '' : ` kept by ${personName(signIn.owner)}`}`);
          deps.changed(c.id);
          send(res, 200, { removed: true });
          return true;
      }
    }
    return false;
  }

  /** Handles the request if it's one of these routes; returns false otherwise. */
  /** Link sessions being waited on: the token, and when to give up. */
  const watching = new Map<string, NodeJS.Timeout>();

  /**
   * Asks Plaid every few seconds whether that link session finished, for a quarter of an hour, and keeps
   * whatever came back. The person finishes at Plaid, in a tab of their own; nothing here depends on
   * them returning to the one they started in.
   */
  function watchPlaidLink(connectionId: string, linkToken: string): void {
    if (watching.has(linkToken)) return;
    const until = Date.now() + 15 * 60_000;
    const timer = setInterval(() => {
      void (async () => {
        const app = plaidApp(polyphemus.vault);
        if (!app || Date.now() > until) {
          clearInterval(timer);
          watching.delete(linkToken);
          return;
        }
        let found: Awaited<ReturnType<typeof finishPlaidLink>> = [];
        try {
          found = await finishPlaidLink(app, linkToken);
        } catch {
          return; // not finished yet, or a blip: ask again in a moment
        }
        const fresh = found.filter((item) => !app.items.some((had) => had.itemId === item.itemId));
        if (!fresh.length) return;
        clearInterval(timer);
        watching.delete(linkToken);
        savePlaidApp(polyphemus.vault, { ...app, items: [...app.items, ...fresh] });
        await connections.test(connectionId).catch(() => undefined);
        deps.log?.(`Linked ${fresh.map((item) => item.institution).join(', ')} to Finance`);
        deps.changed(connectionId);
      })();
    }, 4000);
    timer.unref?.();
    watching.set(linkToken, timer);
  }

  /**
   * The same for widening a bank's consent, which brings back no new item: polyphemus asks Plaid what
   * that bank is consented for until it covers more, then keeps it. Whoever is looking sees it appear.
   */
  function watchPlaidConsent(connectionId: string, itemId: string): void {
    const key = `consent:${itemId}`;
    if (watching.has(key)) return;
    const until = Date.now() + 15 * 60_000;
    const stop = () => {
      clearInterval(timer);
      watching.delete(key);
    };
    const check = async () => {
      const app = plaidApp(polyphemus.vault);
      const item = app?.items.find((one) => one.itemId === itemId);
      if (!app || !item || Date.now() > until) return stop();
      const products = await plaidItemProducts(app, item).catch(() => undefined);
      if (!products || !PLAID_ALSO.some((p) => products.includes(p) && !(item.products ?? []).includes(p))) return;
      stop();
      savePlaidApp(polyphemus.vault, { ...app, items: app.items.map((one) => (one.itemId === itemId ? { ...one, products } : one)) });
      deps.log?.(`${item.institution} now answers for ${products.join(', ')}`);
      deps.changed(connectionId);
    };
    const timer = setInterval(() => void check(), 4000);
    timer.unref?.();
    watching.set(key, timer);
    // Asked once straight away: someone who approves quickly doesn't wait on the next tick.
    void check();
  }

  /**
   * Banks linked before polyphemus asked Plaid what they cover have nothing recorded, and nothing
   * recorded reads as "can't tell" — so there's no way to offer widening it. Asked once, quietly,
   * the next time someone looks at Finance.
   */
  const learned = new Set<string>();
  function learnBankProducts(connectionId: string): void {
    const app = plaidApp(polyphemus.vault);
    const unknown = (app?.items ?? []).filter((item) => !item.products?.length && !learned.has(item.itemId));
    if (!app || !unknown.length) return;
    for (const item of unknown) learned.add(item.itemId);
    void (async () => {
      const found = new Map<string, string[]>();
      for (const item of unknown) {
        const products = await plaidItemProducts(app, item).catch(() => undefined);
        if (products?.length) found.set(item.itemId, products);
      }
      if (!found.size) return;
      const now = plaidApp(polyphemus.vault);
      if (!now) return;
      savePlaidApp(polyphemus.vault, { ...now, items: now.items.map((one) => (found.has(one.itemId) ? { ...one, products: found.get(one.itemId)! } : one)) });
      deps.changed(connectionId);
    })();
  }

  const handle = async function handle(req: IncomingMessage, res: ServerResponse, parts: string[], body: Record<string, unknown>, access: Access, send: (res: ServerResponse, status: number, data: unknown) => void): Promise<boolean> {
    const post = req.method === 'POST';
    const get = req.method === 'GET';

    // Services polyphemus knows how to connect, and which are connected already.
    if (get && parts[1] === 'connections' && parts[2] === 'catalogue' && parts.length === 3) {
      if (!access.owner) throw new HttpError(403, 'Only the owner of this install can connect a service.');
      const existing = connections.list();
      const same = (entry: (typeof CONNECTION_CATALOGUE)[number], c: Connection) => (entry.builtin ? c.server.kind === 'builtin' && c.server.builtin === entry.builtin : entry.google ? c.server.kind === 'stdio' && c.server.google === entry.google : entry.signIn === 'x' ? c.server.kind === 'stdio' && c.server.x === true : c.server.kind === 'http' && c.server.url === entry.url);
      send(res, 200, {
        catalogue: CONNECTION_CATALOGUE.map((entry) => ({ ...entry, connected: existing.filter((c) => same(entry, c)).map((c) => c.id) })),
        // Google needs a sign-in client of your own, and the return address to register with it.
        google: { client: googleClient(polyphemus.vault) !== undefined, callback: callbackFor(req) },
        // X too: an app of your own, and the same return address.
        x: { client: xClient(polyphemus.vault) !== undefined, callback: callbackFor(req) },
        // Finance: your own Plaid app, which environment it's in, and the banks linked so far.
        plaid: (() => {
          const app = plaidApp(polyphemus.vault);
          return { client: app !== undefined, environment: app?.environment ?? null, banks: (app?.items ?? []).map(bankView) };
        })(),
        // Or the other way in: one token from SimpleFIN, and no developer account at all.
        simplefin: { linked: simplefinAccess(polyphemus.vault) !== undefined },
      });
      return true;
    }

    // A GitHub App identity: polyphemus describes it, the person's browser takes it to GitHub to create.
    if (post && parts[1] === 'connections' && parts[2] === 'github-app' && parts.length === 3) {
      if (!access.owner) throw new HttpError(403, 'Only the owner of this install can add a GitHub identity.');
      const role = String(body.role ?? '') as GitHubRole;
      if (!GITHUB_ROLES[role]) throw new HttpError(400, 'Pick a role: planner, builder or reviewer.');
      const org = typeof body.org === 'string' && body.org.trim() ? body.org.trim() : undefined;
      if (org && !/^[a-zA-Z0-9-]{1,39}$/.test(org)) throw new HttpError(400, 'That isn’t a GitHub organization name.');
      const owner = typeof body.owner === 'string' && body.owner ? body.owner : access.person.id;
      const state = randomBytes(18).toString('base64url');
      creating.set(state, { role, ...(org && { org }), owner, createdBy: access.person.id, at: Date.now() });
      const origin = deps.publicOrigin(req);
      send(res, 200, { action: newAppUrl(org, state), manifest: JSON.stringify(appManifest(role, origin)) });
      return true;
    }
    if (post && parts[1] === 'connections' && parts[2] && parts[3] === 'github-install' && parts.length === 4) {
      const c = connections.get(decodeURIComponent(parts[2]));
      if (!c || !access.canManageConnection(c)) throw new HttpError(404, 'No such connection.');
      const record = connections.githubApp(c.id);
      if (!record) throw new HttpError(400, 'That isn’t a GitHub App identity.');
      const state = randomBytes(18).toString('base64url');
      installing.set(state, { connection: c.id, at: Date.now() });
      send(res, 200, { url: installUrl(record, state) });
      return true;
    }

    // Your Google Cloud OAuth client, once, for every Google connection.
    if (post && parts[1] === 'connections' && parts[2] === 'google-client' && parts.length === 3) {
      if (!access.owner) throw new HttpError(403, 'Only the owner of this install can set up Google sign-in.');
      setGoogleClient(polyphemus.vault, String(body.clientId ?? ''), String(body.clientSecret ?? ''));
      deps.log?.('Saved the Google sign-in client');
      send(res, 200, { client: true });
      return true;
    }

    // Your X app's OAuth 2.0 client, once.
    if (post && parts[1] === 'connections' && parts[2] === 'x-client' && parts.length === 3) {
      if (!access.owner) throw new HttpError(403, 'Only the owner of this install can set up X sign-in.');
      setXClient(polyphemus.vault, String(body.clientId ?? ''), typeof body.clientSecret === 'string' ? body.clientSecret : undefined);
      deps.log?.('Saved the X sign-in client');
      send(res, 200, { client: true });
      return true;
    }

    // Your Plaid app: its client id, the secret for the environment you picked, once.
    if (post && parts[1] === 'connections' && parts[2] === 'plaid-app' && parts.length === 3) {
      if (!access.owner) throw new HttpError(403, 'Only the owner of this install can set up Finance.');
      const environment = body.environment === 'production' ? 'production' : 'sandbox';
      setPlaidApp(polyphemus.vault, String(body.clientId ?? ''), String(body.secret ?? ''), environment);
      deps.log?.(`Saved the Plaid app (${environment})`);
      send(res, 200, { client: true, environment });
      return true;
    }

    // SimpleFIN: one setup token, claimed once, and what comes back is what polyphemus keeps.
    // (watchPlaidLink is defined below, beside the rest of the Plaid plumbing.)
    if (post && parts[1] === 'connections' && parts[2] === 'simplefin' && parts.length === 3) {
      if (!access.owner) throw new HttpError(403, 'Only the owner of this install can set up Finance.');
      const accessUrl = await claimSimplefin(String(body.token ?? ''));
      saveSimplefinAccess(polyphemus.vault, accessUrl);
      deps.log?.('Claimed a SimpleFIN token for Finance');
      const existing = connections.list().find((c) => c.server.kind === 'builtin' && c.server.builtin === 'finance');
      if (existing) {
        await connections.test(existing.id);
        deps.changed(existing.id);
      }
      send(res, 200, { linked: true });
      return true;
    }

    // Linking a bank: polyphemus sends you to Plaid's own page, and never sees the bank's credentials.
    if (post && parts[1] === 'connections' && parts[2] && parts[3] === 'plaid' && (parts[4] === 'link' || parts[4] === 'finish' || parts[4] === 'consent' || parts[4] === 'accounts' || parts[4] === 'remove') && parts.length === 5) {
      const c = connections.get(decodeURIComponent(parts[2]));
      if (!c || !access.canManageConnection(c)) throw new HttpError(404, 'No such connection.');
      const app = plaidApp(polyphemus.vault);
      if (!app) throw new HttpError(400, 'Set up your Plaid app first.');
      if (parts[4] === 'link') {
        const started = await startPlaidLink(app, { person: access.person.id, back: deps.publicOrigin(req) });
        // Polyphemus watches for the result itself: finishing happens in another tab, and waiting for
        // someone to come back and say so lost banks that were already linked.
        watchPlaidLink(c.id, started.linkToken);
        send(res, 200, started);
        return true;
      }
      if (parts[4] === 'consent') {
        const item = app.items.find((one) => one.itemId === String(body.bank ?? ''));
        if (!item) throw new HttpError(404, 'That bank isn’t linked.');
        const started = await startPlaidConsent(app, item, { person: access.person.id, back: deps.publicOrigin(req) });
        watchPlaidConsent(c.id, item.itemId);
        send(res, 200, started);
        return true;
      }
      // What's at one bank: its accounts, their kind and balance, for the page to show under it.
      if (parts[4] === 'accounts') {
        const item = app.items.find((one) => one.itemId === String(body.bank ?? ''));
        if (!item) throw new HttpError(404, 'That bank isn’t linked.');
        try {
          send(res, 200, { accounts: await plaidAccounts(app, item) });
        } catch (err) {
          const message = (err as Error).message;
          // Said in words the page can show as they are, not as a failure of the page.
          send(res, 200, { accounts: [], problem: /ITEM_LOGIN_REQUIRED/i.test(message) ? `${item.institution} wants you to sign in again at Plaid before it answers.` : /PRODUCT_NOT_READY/i.test(message) ? `Plaid is still fetching ${item.institution}. Look again in a few minutes.` : `Plaid didn’t answer for ${item.institution}: ${message.replace(/^Plaid refused \/accounts\/get: /, '')}` });
        }
        return true;
      }
      if (parts[4] === 'finish') {
        const linkToken = String(body.linkToken ?? '');
        if (!linkToken) throw new HttpError(400, 'Which link was it?');
        const found = await finishPlaidLink(app, linkToken);
        const fresh = found.filter((item) => !app.items.some((had) => had.itemId === item.itemId));
        if (fresh.length) savePlaidApp(polyphemus.vault, { ...app, items: [...app.items, ...fresh] });
        if (fresh.length) await connections.test(c.id);
        deps.log?.(fresh.length ? `Linked ${fresh.map((item) => item.institution).join(', ')} to Finance` : 'No new bank came back from Plaid');
        deps.changed(c.id);
        send(res, 200, { linked: fresh.map((item) => ({ id: item.itemId, name: item.institution })), banks: [...app.items, ...fresh].map(bankView) });
        return true;
      }
      const itemId = String(body.bank ?? '');
      const item = app.items.find((one) => one.itemId === itemId);
      if (!item) throw new HttpError(404, 'That bank isn’t linked.');
      // Removed at Plaid too, so the link really ends rather than just being forgotten here.
      await plaidRemoveItem(app, item.accessToken).catch(() => undefined);
      savePlaidApp(polyphemus.vault, { ...app, items: app.items.filter((one) => one.itemId !== itemId) });
      deps.log?.(`Unlinked ${item.institution} from Finance`);
      deps.changed(c.id);
      send(res, 200, { banks: app.items.filter((one) => one.itemId !== itemId).map(bankView) });
      return true;
    }

    // Before connecting: does this address sign in with OAuth, and what's its MCP endpoint?
    if (get && parts[1] === 'connections' && parts[2] === 'discover' && parts.length === 3) {
      if (!access.owner) throw new HttpError(403, 'Only the owner of this install can connect a service.');
      const address = new URL(req.url ?? '/', 'http://polyphemus').searchParams.get('url') ?? '';
      const found = await discoverOAuth(address);
      send(res, 200, found ? { oauth: true, url: found.resource, host: new URL(found.issuer).host, scopes: found.scopes ?? [] } : { oauth: false });
      return true;
    }

    if (parts[1] === 'connections' && parts.length === 2) {
      if (get) {
        const people = access.owner ? polyphemus.store.people().map(({ id, name, owner }) => ({ id, name, owner })) : [];
        send(res, 200, { connections: connections.list().filter((c) => canSee(access, c)).map((c) => view(c, access)), people, canAdd: access.owner });
        return true;
      }
      if (post) {
        if (!access.owner) throw new HttpError(403, 'Only the owner of this install can connect a service: it’s their computer that runs it.');
        // From the catalogue: its address and how it signs in come from the entry, not the request.
        const entry = typeof body.catalogue === 'string' ? connectionCatalogueEntry(body.catalogue) : undefined;
        if (body.catalogue !== undefined && !entry) throw new HttpError(400, 'That isn’t in the catalogue.');
        if (entry) {
          Object.assign(body, { kind: 'http', url: entry.url ?? '', name: typeof body.name === 'string' && body.name.trim() ? body.name : entry.name, ...(entry.signIn === 'oauth' ? { auth: 'oauth' } : {}) });
          if (entry.signIn === 'token' && !(body.secrets && typeof body.secrets === 'object' && (body.secrets as Record<string, unknown>).TOKEN)) throw new HttpError(400, `${entry.name} needs a token: paste the one you made.`);
        }
        const owner = typeof body.owner === 'string' && body.owner ? body.owner : access.person.id;
        if (!polyphemus.store.person(owner)) throw new HttpError(400, 'No such person.');
        const server = entry?.builtin ? { kind: 'builtin' as const, builtin: entry.builtin } : entry?.google ? googleServer(entry.google) : entry?.signIn === 'x' ? xServer() : serverFrom(body);
        if (entry?.signIn === 'plaid' && !plaidApp(polyphemus.vault) && !simplefinAccess(polyphemus.vault)) throw new HttpError(400, 'Set up Finance first: a Plaid app of your own, or a SimpleFIN token.');
        if (entry?.google && !googleClient(polyphemus.vault)) throw new HttpError(400, 'Set up your Google sign-in client first.');
        if (entry?.signIn === 'x' && !xClient(polyphemus.vault)) throw new HttpError(400, 'Set up your X app first.');
        const added = await connections.add({ name: String(body.name ?? ''), owner, server, secrets: secretsFrom(body.secrets), createdBy: access.person.id });
        deps.log?.(`Connected ${added.name} (${added.id}): ${added.health}`);
        deps.changed(added.id);
        // Signing in happens at the service: the app sends the browser there, and it comes back here.
        let authorizeUrl: string | null = null;
        let problem: string | null = null;
        if (added.server.auth === 'oauth') {
          try {
            authorizeUrl = await connections.beginSignIn(added.id, callbackFor(req));
          } catch (err) {
            problem = (err as Error).message;
            deps.log?.(`Couldn’t start signing in to ${added.name}: ${problem}`);
          }
        }
        if (authorizeUrl) deps.log?.(`Signing in to ${added.name}: sent to ${new URL(authorizeUrl).host}, back to ${callbackFor(req)}`);
        send(res, 201, { connection: view(added, access), authorizeUrl, problem });
        return true;
      }
    }

    if (parts[1] === 'connections' && parts[2]) {
      const c = connections.get(decodeURIComponent(parts[2]));
      if (!c || !canSee(access, c)) throw new HttpError(404, 'No such connection.');
      const action = parts[3];
      if (get && !action) {
        // A bank linked before polyphemus recorded what it covers: ask Plaid once, in the background.
        if (access.canManageConnection(c)) learnBankProducts(c.id);
        send(res, 200, { connection: view(c, access), activity: activityView(c, access) });
        return true;
      }
      if (action === 'live' || action === 'sign-ins') return signInRoute(req, res, c, parts, body, access, send);
      if (!post || parts.length !== 4) return false;
      if (action === 'dismiss') {
        // Out of this person's Waiting on you, until it fails some other way.
        polyphemus.store.dismiss(access.person.id, `connection:${c.id}`, `${c.errorKind}:${c.error}`);
        send(res, 200, { dismissed: true });
        return true;
      }
      if (['test', 'reconnect', 'disconnect', 'ceiling', 'signin'].includes(action!) && !access.canManageConnection(c)) {
        throw new HttpError(403, `${personName(c.owner)} looks after ${c.name}: ask them, or the owner of this install.`);
      }
      if (['grant', 'revoke'].includes(action!) && !access.canGrant) throw new HttpError(403, 'Only the owner of this install can grant access to a connection.');
      switch (action) {
        case 'signin': {
          // From a thread's card: remember which one, so the callback returns there and nowhere else.
          const asked = typeof body.question === 'string' ? body.question : '';
          const waiting = asked ? waitingSignIn(access, asked, c.id, 'oauth') : undefined;
          if (asked && !waiting) throw new HttpError(400, 'That sign-in isn’t waiting in a thread you can work in.');
          try {
            const authorizeUrl = await connections.beginSignIn(c.id, callbackFor(req));
            const key = `${access.person.id}:${c.id}`;
            if (waiting) signInReturn.set(key, { question: waiting.id, at: Date.now() });
            else signInReturn.delete(key);
            deps.log?.(`Signing in to ${c.name}: sent to ${new URL(authorizeUrl).host}, back to ${callbackFor(req)}`);
            send(res, 200, { authorizeUrl });
          } catch (err) {
            deps.log?.(`Couldn’t start signing in to ${c.name}: ${(err as Error).message}`);
            throw err;
          }
          return true;
        }
        case 'test':
        case 'reconnect': {
          const after = action === 'test' ? await connections.test(c.id) : await connections.reconnect(c.id, secretsFrom(body.secrets));
          deps.log?.(`${action === 'test' ? 'Tested' : 'Reconnected'} ${c.name}: ${after.health}${after.error ? ` (${after.error})` : ''}`);
          deps.changed(c.id);
          send(res, 200, { connection: view(after, access), activity: activityView(after, access) });
          return true;
        }
        case 'disconnect': {
          const { alsoForgot } = await connections.disconnect(c.id);
          deps.log?.(`Disconnected ${c.name}${alsoForgot.length ? `, and forgot ${alsoForgot.join(' and ')}` : ''}`);
          deps.changed(c.id);
          send(res, 200, { disconnected: true, alsoForgot });
          return true;
        }
        case 'ceiling': {
          const after = connections.declareCeiling(c.id, body.tools === null ? undefined : toolsFrom(body.tools), access.person.id);
          deps.changed(c.id);
          send(res, 200, { connection: view(after, access) });
          return true;
        }
        case 'grant':
        case 'revoke': {
          // No project, with an agent: the grant is the agent's own, carried wherever it works —
          // including a thread in no project at all.
          const asked = typeof body.project === 'string' ? body.project : '';
          const project = asked ? polyphemus.store.project(asked) : undefined;
          if (asked && (!project || !access.canSeeProject(project.slug))) throw new HttpError(400, 'No such project.');
          let agent: AgentRef | undefined;
          if (typeof body.agent === 'string' && body.agent) {
            agent = deps.agentNamed(body.agent, project?.slug);
            // A project's own agent works only there; a library agent anywhere.
            if (!agent || (project && agent.project !== null && agent.project !== project.slug)) throw new HttpError(400, `No agent called "${body.agent}"${project ? ` in ${project.name}` : ''}.`);
            if (!access.canSeeAgent(agent)) throw new HttpError(404, `No agent called "${body.agent}".`);
          }
          if (!project && !agent) throw new HttpError(400, 'Say which project, or which agent, this is for.');
          const where = project ? `${agent ? `${agent.id} in ` : ''}${project.slug}` : `${agent!.id} itself`;
          if (action === 'revoke') {
            connections.revoke(c.id, project?.slug ?? '', agent?.id);
            deps.log?.(`Revoked ${c.name} from ${where}`);
          } else {
            try {
              connections.grant({ connection: c.id, project: project?.slug, agent: agent?.id, tools: toolsFrom(body.tools), by: access.person.id });
            } catch (err) {
              if (err instanceof GrantRefused) throw new HttpError(403, err.message);
              throw err;
            }
            deps.log?.(`Granted ${c.name} to ${where}: ${toolsFrom(body.tools).join(', ')}`);
          }
          deps.changed(c.id);
          send(res, 200, { connection: view(connections.get(c.id)!, access) });
          return true;
        }
      }
      return false;
    }

    // What a project can reach, and each of its agents — for anyone who can see the project.
    if (get && parts[1] === 'projects' && parts[2] && parts[3] === 'reach' && parts.length === 4) {
      const project = polyphemus.store.project(decodeURIComponent(parts[2]));
      if (!project || !access.canSeeProject(project.slug)) throw new HttpError(404, 'No such project.');
      const agents = deps.agentsIn(project.slug).map((agent) => ({ id: agent.id, title: agent.title, reach: reachFor(project.slug, agent) }));
      send(res, 200, { project: project.slug, reach: reachFor(project.slug, undefined), agents });
      return true;
    }

    // What an agent can reach, in each project it works in that this person can see, and why.
    if (get && parts[1] === 'agents' && parts[2] && parts[3] === 'reach' && parts.length === 4) {
      const agent = deps.agentNamed(decodeURIComponent(parts[2]));
      // What an agent carries is for someone who could work with it (access matrix, 2026-09-19).
      if (!agent || !access.canSeeAgent(agent)) throw new HttpError(404, 'No such agent.');
      const projects = visibleProjects(access).filter((p) => agent.project === null || agent.project === p.slug);
      if (agent.project !== null && projects.length === 0) throw new HttpError(404, 'No such agent.');
      // What it carries comes first: that's what it can reach in a thread with no project — a DM with it.
      const carried = { project: '', name: 'Wherever it works, direct threads included', reach: reachFor('', agent) };
      send(res, 200, {
        agent: agent.id,
        projects: [carried, ...projects.map((p) => ({ project: p.slug, name: p.name, reach: reachFor(p.slug, agent) }))].filter((p) => p.reach.length > 0),
      });
      return true;
    }
    return false;
  };
  return { handle, oauthCallback, githubCallback };
}

/** An address as someone types it: example.com means https://example.com. */
function normalAddress(raw: string): string {
  const text = raw.trim();
  if (!text) throw new HttpError(400, 'Give the address of the site to sign in to.');
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    throw new HttpError(400, `“${text}” isn’t a web address.`);
  }
}

export { UNKNOWN_CEILING };
