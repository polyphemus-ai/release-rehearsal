import { PolyphemusError } from '../types.js';
import type { Vault } from '../secrets/vault.js';
import type { McpServerDefinition } from './mcp-client.js';
import type { OAuthServer } from './oauth.js';
import { assetPath } from '../assets.js';

// X (formerly Twitter). X has no hosted MCP server that lets apps sign themselves in, so, like Google,
// the person makes an app of their own at developer.x.com once, and polyphemus runs a small MCP server of
// its own: posting, replying, deleting a post, and reading its own posts and mentions — no DMs, follows
// or likes. The server is handed a two-hour access token when it starts, never the refresh token or the
// client secret, and restarted with a fresh one.

/** Your X app's OAuth 2.0 client, in the vault. */
export const X_CLIENT_SECRET = 'x/client';

/** Reading and posting as you; offline.access so polyphemus can refresh without asking you again. */
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];

const SERVER_SCRIPT = assetPath('core', 'bin/x-mcp.mjs');

export function xServer(): McpServerDefinition {
  // POLYPHEMUS_X_API only when polyphemus itself was pointed elsewhere (tests); otherwise the server uses X's.
  const api = process.env.POLYPHEMUS_X_API;
  return { kind: 'stdio', command: process.execPath, args: [SERVER_SCRIPT], auth: 'oauth', x: true, ...(api && { env: { X_API: api } }) };
}

export function xClient(vault: Vault): { clientId: string; clientSecret?: string } | undefined {
  const raw = vault.get(X_CLIENT_SECRET, 'x sign-in');
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { clientId?: string; clientSecret?: string };
    return parsed.clientId ? { clientId: parsed.clientId, ...(parsed.clientSecret && { clientSecret: parsed.clientSecret }) } : undefined;
  } catch {
    return undefined;
  }
}

/** A Native App has only a client ID; a Web App has a secret too. Either works. */
export function setXClient(vault: Vault, clientId: string, clientSecret?: string): void {
  const id = clientId.trim();
  const secret = clientSecret?.trim();
  if (!/^[\w-]{10,}$/.test(id)) throw new PolyphemusError('That isn’t an X OAuth 2.0 client ID: copy it from your app’s Keys and tokens page, under OAuth 2.0 Client ID and Client Secret.', 'USAGE');
  vault.set(X_CLIENT_SECRET, JSON.stringify({ clientId: id, ...(secret && { clientSecret: secret }) }), { kind: 'token', note: 'Your X app’s OAuth 2.0 client, for the X connection' });
}

/** X's sign-in, with your app. */
export function xSignIn(vault: Vault): OAuthServer {
  const client = xClient(vault);
  if (!client) throw new PolyphemusError('Set up your X app first: Setup → Connections → Connect a service → X.', 'USAGE');
  return {
    issuer: 'https://x.com',
    authorizationEndpoint: process.env.POLYPHEMUS_X_AUTH ?? 'https://x.com/i/oauth2/authorize',
    tokenEndpoint: process.env.POLYPHEMUS_X_TOKEN ?? 'https://api.x.com/2/oauth2/token',
    scopes: X_SCOPES,
    // A Web App (a confidential client) sends its secret as Basic auth; a Native App has none.
    client: { ...client, basic: true },
  };
}
