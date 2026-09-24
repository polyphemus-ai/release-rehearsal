import { createHash, randomBytes } from 'node:crypto';
import { PolyphemusError } from '../types.js';
import type { Vault } from '../secrets/vault.js';

// Signing in to a remote MCP server the way the MCP authorization spec describes: find the server's
// authorization server, register polyphemus with it, send the person to sign in with PKCE, and keep the
// tokens in the vault — refreshing them before they run out. No model or agent ever sees a token.

export interface OAuthServer {
  /** The MCP endpoint the tokens are for, when the service takes one (RFC 8707). */
  resource?: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes?: string[];
  /** A client registered by hand (Google), for services that don't let apps register themselves. */
  client?: { clientId: string; clientSecret?: string; /** Send the secret as HTTP Basic auth rather than in the form (X). */ basic?: boolean };
  /** Anything else the service's sign-in page needs (Google: offline access, so there's a refresh token). */
  extraParams?: Record<string, string>;
}

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  /** ms since epoch. */
  expiresAt?: number;
  scope?: string;
  clientId: string;
  clientSecret?: string;
  basic?: boolean;
  tokenEndpoint: string;
  resource?: string;
}

interface Pending {
  connection: string;
  verifier: string;
  clientId: string;
  clientSecret?: string;
  basic?: boolean;
  tokenEndpoint: string;
  redirectUri: string;
  resource?: string;
  at: number;
}

const TEN_MINUTES = 10 * 60_000;
const b64url = (buf: Buffer) => buf.toString('base64url');
export const oauthSecretName = (connection: string) => `connection/${connection}/oauth`;

async function getJson(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return undefined;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Whether a remote server signs in with OAuth, and where. Given the server's address — or just its
 * site — this follows the server's protected-resource metadata to its authorization server.
 */
export async function discoverOAuth(address: string): Promise<OAuthServer | undefined> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  // The server may say where its metadata is in a 401; otherwise it's at a well-known path.
  let metadataUrl: string | undefined;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}', signal: AbortSignal.timeout(10_000) });
    metadataUrl = /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate') ?? '')?.[1];
  } catch {
    // unreachable here; the well-known paths may still answer
  }
  const path = url.pathname.replace(/\/$/, '');
  const candidates = [metadataUrl, path ? `${url.origin}/.well-known/oauth-protected-resource${path}` : undefined, `${url.origin}/.well-known/oauth-protected-resource`].filter(Boolean) as string[];
  let resourceMeta: Record<string, unknown> | undefined;
  for (const candidate of candidates) if ((resourceMeta = await getJson(candidate))) break;
  let issuer = Array.isArray(resourceMeta?.authorization_servers) ? String(resourceMeta!.authorization_servers[0]) : undefined;
  // The spec before this one (MCP 2025-03-26) had no resource metadata: the server's own origin is
  // its authorization server. Intercom and Atlassian's first server still sign in that way.
  const legacy = !resourceMeta || !issuer;
  if (legacy) {
    resourceMeta = {};
    issuer = url.origin;
  }
  const issuerUrl = new URL(issuer!);
  const suffix = issuerUrl.pathname.replace(/\/$/, '');
  const authMeta =
    (await getJson(`${issuerUrl.origin}/.well-known/oauth-authorization-server${suffix}`)) ?? (await getJson(`${issuerUrl.origin}/.well-known/openid-configuration${suffix}`));
  if (!authMeta?.authorization_endpoint || !authMeta.token_endpoint) return undefined;
  const methods = Array.isArray(authMeta.code_challenge_methods_supported) ? authMeta.code_challenge_methods_supported : ['S256'];
  if (!methods.includes('S256')) return undefined; // PKCE with S256, or not at all
  return {
    // That older spec had no resource parameter to send, and a server built to it may refuse one.
    ...(!legacy && { resource: typeof resourceMeta!.resource === 'string' ? resourceMeta!.resource : url.toString() }),
    issuer: issuer!,
    authorizationEndpoint: String(authMeta.authorization_endpoint),
    tokenEndpoint: String(authMeta.token_endpoint),
    ...(typeof authMeta.registration_endpoint === 'string' && { registrationEndpoint: authMeta.registration_endpoint }),
    ...(Array.isArray(authMeta.scopes_supported) && { scopes: authMeta.scopes_supported.map(String) }),
  };
}

export class OAuthSignIns {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly vault: Vault) {}

  /** Registers polyphemus with the server if needed and returns where to send the person to sign in. */
  async begin(connection: string, server: OAuthServer, redirectUri: string): Promise<string> {
    let clientId: string;
    let clientSecret: string | undefined;
    let basic: boolean | undefined;
    if (server.client) {
      ({ clientId, clientSecret, basic } = server.client);
    } else if (server.registrationEndpoint) {
      const res = await fetch(server.registrationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_name: 'polyphemus', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
        signal: AbortSignal.timeout(10_000),
      }).catch((err: Error) => {
        throw new PolyphemusError(`Couldn’t reach ${new URL(server.registrationEndpoint!).host} to register polyphemus: ${err.message}`, 'FAILED');
      });
      const body = (await res.json().catch(() => ({}))) as { client_id?: string; client_secret?: string; error_description?: string };
      if (!res.ok || !body.client_id) throw new PolyphemusError(`${new URL(server.issuer).host} wouldn’t register polyphemus: ${body.error_description ?? res.status}`, 'FAILED');
      clientId = body.client_id;
      clientSecret = body.client_secret;
    } else {
      throw new PolyphemusError(`${new URL(server.issuer).host} doesn’t let apps register themselves, so polyphemus can’t sign in to it. Use an API key or token instead.`, 'USAGE');
    }
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(24));
    for (const [key, p] of this.pending) if (Date.now() - p.at > TEN_MINUTES) this.pending.delete(key);
    this.pending.set(state, { connection, verifier, clientId, clientSecret, ...(basic && { basic }), tokenEndpoint: server.tokenEndpoint, redirectUri, resource: server.resource, at: Date.now() });
    const url = new URL(server.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      state,
      ...(server.resource && { resource: server.resource }),
      ...(server.scopes?.length && { scope: server.scopes.join(' ') }),
      ...server.extraParams,
    }).toString();
    return url.toString();
  }

  /** The person came back from signing in: trade the code for tokens and keep them. Returns the connection. */
  async finish(state: string, code: string): Promise<{ connection: string; scopes: string[] }> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || Date.now() - p.at > TEN_MINUTES) throw new PolyphemusError('That sign-in link has expired or was already used. Start signing in again.', 'USAGE');
    const tokens = await this.exchange(p.tokenEndpoint, { grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier, ...(p.resource && { resource: p.resource }) }, p);
    this.save(p.connection, { ...tokens, clientId: p.clientId, clientSecret: p.clientSecret, ...(p.basic && { basic: true }), tokenEndpoint: p.tokenEndpoint, resource: p.resource });
    return { connection: p.connection, scopes: tokens.scope?.split(/\s+/).filter(Boolean) ?? [] };
  }

  /** A token that works now, refreshed first if it's about to run out. Undefined if never signed in. */
  async accessToken(connection: string): Promise<string | undefined> {
    const raw = this.vault.get(oauthSecretName(connection), `connection ${connection}`);
    if (!raw) return undefined;
    const stored = JSON.parse(raw) as StoredTokens;
    if (!stored.expiresAt || stored.expiresAt - Date.now() > 60_000 || !stored.refreshToken) return stored.accessToken;
    const fresh = await this.exchange(stored.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: stored.refreshToken, client_id: stored.clientId, ...(stored.resource && { resource: stored.resource }) }, stored);
    this.save(connection, { ...stored, ...fresh, refreshToken: fresh.refreshToken ?? stored.refreshToken });
    return fresh.accessToken;
  }

  /** A new access token now, whatever the old one's expiry said: it was refused. False if there's no refresh token. */
  async refresh(connection: string): Promise<boolean> {
    const raw = this.vault.get(oauthSecretName(connection), `connection ${connection}`);
    if (!raw) return false;
    const stored = JSON.parse(raw) as StoredTokens;
    if (!stored.refreshToken) return false;
    const fresh = await this.exchange(stored.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: stored.refreshToken, client_id: stored.clientId, ...(stored.resource && { resource: stored.resource }) }, stored);
    this.save(connection, { ...stored, ...fresh, refreshToken: fresh.refreshToken ?? stored.refreshToken });
    return true;
  }

  /** When the current access token runs out, if the service said. */
  expiresAt(connection: string): number | undefined {
    const raw = this.vault.get(oauthSecretName(connection), `connection ${connection}`);
    return raw ? (JSON.parse(raw) as StoredTokens).expiresAt : undefined;
  }

  /** The scopes it was last granted, for the ceiling. */
  scopes(connection: string): string[] | undefined {
    const raw = this.vault.get(oauthSecretName(connection), `connection ${connection}`);
    return raw ? (JSON.parse(raw) as StoredTokens).scope?.split(/\s+/).filter(Boolean) : undefined;
  }

  private async exchange(endpoint: string, form: Record<string, string>, client: { clientId: string; clientSecret?: string; basic?: boolean }): Promise<Pick<StoredTokens, 'accessToken' | 'refreshToken' | 'expiresAt' | 'scope'>> {
    // A client secret goes in the form, or as HTTP Basic auth for services that want it there.
    const basic = client.basic && client.clientSecret ? `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}` : undefined;
    if (client.clientSecret && !basic) form = { ...form, client_secret: client.clientSecret };
    const res = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...(basic && { authorization: basic }) }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(15_000) }).catch((err: Error) => {
      throw new PolyphemusError(`Couldn’t reach ${new URL(endpoint).host}: ${err.message}`, 'FAILED');
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new PolyphemusError(`${new URL(endpoint).host} refused the sign-in: ${body.error_description ?? body.error ?? res.status}`, 'FAILED');
    return {
      accessToken: body.access_token,
      ...(body.refresh_token && { refreshToken: body.refresh_token }),
      ...(body.expires_in && { expiresAt: Date.now() + body.expires_in * 1000 }),
      ...(body.scope && { scope: body.scope }),
    };
  }

  private save(connection: string, tokens: StoredTokens): void {
    this.vault.set(oauthSecretName(connection), JSON.stringify(tokens), { kind: 'token', note: `OAuth sign-in for the ${connection} connection` });
  }
}
