import { createSign, randomBytes } from 'node:crypto';
import { PolyphemusError } from '../types.js';
import type { McpServerDefinition } from './mcp-client.js';
import { assetPath } from '../assets.js';

// GitHub identities of polyphemus's own (roadmap: it does the work, 3). Each is a GitHub App, made with
// GitHub's manifest flow: polyphemus describes the app — its role's permissions, where to come back to —
// the person clicks Create on GitHub and picks repositories, and polyphemus keeps the app's private key
// in the vault. From the key it makes installation tokens that last an hour and reach only those
// repositories. On GitHub the identity is its own bot, so what an agent did is never mistaken for you.
//
// No identity merges work only it has approved: GitHub won't let an author approve their own pull
// request, a branch rule requires an approval, and polyphemus checks the approval's commit before merging.

export type GitHubRole = 'planner' | 'builder' | 'reviewer';

export const GITHUB_ROLES: Record<GitHubRole, { title: string; does: string; permissions: Record<string, 'read' | 'write'> }> = {
  planner: {
    title: 'Planner',
    does: 'Writes specs on a branch, opens spec pull requests, creates and labels issues. Merges its spec PRs once another identity approves them.',
    permissions: { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write', checks: 'read', statuses: 'read' },
  },
  builder: {
    title: 'Builder',
    does: 'Pushes code branches, opens and updates pull requests, comments on issues. Can’t approve its own work.',
    permissions: { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write', checks: 'read', statuses: 'read' },
  },
  reviewer: {
    title: 'Reviewer',
    does: 'Reads code, reviews and approves pull requests. polyphemus gives it no way to push.',
    // Write, not read: a branch rule that requires an approval only counts reviewers with write access
    // (found on the first real run, 2026-09-13). polyphemus's server offers the Reviewer no tool that
    // pushes, and its token never reaches a model or a shell.
    permissions: { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'read', checks: 'read', statuses: 'read' },
  },
};

export const githubApi = () => (process.env.POLYPHEMUS_GITHUB_API ?? 'https://api.github.com').replace(/\/$/, '');
export const githubWeb = () => (process.env.POLYPHEMUS_GITHUB_WEB ?? 'https://github.com').replace(/\/$/, '');

/** Where the app's key and installation live: one vault record per connection. */
export const githubAppSecretName = (connection: string) => `connection/${connection}/github-app`;

export interface GitHubAppRecord {
  appId: number;
  slug: string;
  name: string;
  pem: string;
  owner: string;
  role: GitHubRole;
  htmlUrl?: string;
  installationId?: number;
}

/** GitHub's form for creating an app from a manifest, on your account or an organisation's. */
export function newAppUrl(org: string | undefined, state: string): string {
  const where = org ? `/organizations/${encodeURIComponent(org)}/settings/apps/new` : '/settings/apps/new';
  return `${githubWeb()}${where}?state=${encodeURIComponent(state)}`;
}

/** The app, described: its role's permissions, no webhooks, and polyphemus as where to come back to. */
export function appManifest(role: GitHubRole, origin: string): Record<string, unknown> {
  const suffix = randomBytes(3).toString('hex');
  return {
    // App names are unique across GitHub and at most 34 characters.
    name: `polyphemus ${GITHUB_ROLES[role].title} ${suffix}`,
    url: origin,
    description: `polyphemus’s ${GITHUB_ROLES[role].title}: ${GITHUB_ROLES[role].does}`,
    redirect_url: `${origin}/github/app-created`,
    setup_url: `${origin}/github/app-installed`,
    setup_on_update: true,
    public: false,
    hook_attributes: { url: `${origin}/github/no-webhooks`, active: false },
    default_permissions: GITHUB_ROLES[role].permissions,
    default_events: [],
  };
}

/** A GitHub REST call, as an app (its JWT) or an identity (an installation token). */
export async function githubRequest(path: string, init: Omit<RequestInit, 'body'> & { token?: string; body?: unknown } = {}): Promise<any> {
  const { token, body: payload, ...rest } = init;
  const res = await fetch(`${githubApi()}${path}`, {
    ...rest,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token && { authorization: `Bearer ${token}` }), ...(payload !== undefined && { 'content-type': 'application/json' }) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  }).catch((err: Error) => {
    throw new PolyphemusError(`Couldn’t reach GitHub: ${err.message}`, 'FAILED');
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new PolyphemusError(`GitHub answered ${res.status}${body.message ? `: ${body.message}` : ''}`, 'FAILED');
  return body;
}

/** Back from GitHub after Create: trade the one-time code for the app — its id, slug and private key. */
export async function convertManifest(code: string, role: GitHubRole): Promise<GitHubAppRecord> {
  const app = await githubRequest(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' });
  if (!app.id || !app.pem || !app.slug) throw new PolyphemusError('GitHub didn’t hand back the app it made.', 'FAILED');
  return { appId: Number(app.id), slug: String(app.slug), name: String(app.name ?? app.slug), pem: String(app.pem), owner: String(app.owner?.login ?? ''), role, ...(app.html_url && { htmlUrl: String(app.html_url) }) };
}

/** Where to install the app on repositories; GitHub comes back to the setup URL with the installation. */
export const installUrl = (record: Pick<GitHubAppRecord, 'slug'>, state: string) => `${githubWeb()}/apps/${record.slug}/installations/new?state=${encodeURIComponent(state)}`;

/** A short-lived JWT that proves polyphemus holds the app's key: only good for asking for installation tokens. */
export function appJwt(record: Pick<GitHubAppRecord, 'appId' | 'pem'>, now = Date.now()): string {
  const enc = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(now / 1000) - 60;
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat, exp: iat + 540, iss: String(record.appId) })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(record.pem).toString('base64url');
  return `${unsigned}.${signature}`;
}

/** An installation token: an hour, the app's permissions, only the repositories it's installed on. */
export async function installationToken(record: GitHubAppRecord): Promise<{ token: string; expiresAt: number; permissions: Record<string, string>; repositories: string[] }> {
  if (!record.installationId) throw new PolyphemusError(`${record.name} isn’t installed on any repositories yet.`, 'USAGE');
  const issued = await githubRequest(`/app/installations/${record.installationId}/access_tokens`, { method: 'POST', token: appJwt(record) });
  const repos = await githubRequest('/installation/repositories?per_page=100', { token: String(issued.token) }).catch(() => ({ repositories: [] }));
  return {
    token: String(issued.token),
    expiresAt: Date.parse(String(issued.expires_at)) || Date.now() + 55 * 60_000,
    permissions: (issued.permissions ?? {}) as Record<string, string>,
    repositories: ((repos.repositories ?? []) as Array<{ full_name: string }>).map((r) => r.full_name),
  };
}

const SERVER_SCRIPT = assetPath('core', 'bin/github-mcp.mjs');

/** polyphemus's own GitHub server for an identity: handed an hour's installation token, never the key. */
export function githubServer(role: GitHubRole): McpServerDefinition {
  const api = process.env.POLYPHEMUS_GITHUB_API;
  return { kind: 'stdio', command: process.execPath, args: [SERVER_SCRIPT, role], auth: 'github-app', github: role, ...(api && { env: { GITHUB_API: api } }) };
}
