import { PolyphemusError } from '../types.js';
import type { Vault } from '../secrets/vault.js';
import type { McpServerDefinition } from './mcp-client.js';
import type { OAuthServer } from './oauth.js';
import { assetPath } from '../assets.js';

// Google Drive and Gmail (roadmap: show and connect, 3). Google has no hosted MCP server that lets
// apps sign themselves in, so the person makes a sign-in client of their own once, and polyphemus runs a
// small MCP server of its own for each service. That server is handed a one-hour access token when it
// starts — never the refresh token or the client secret — and restarted with a fresh one.

export type GoogleService = 'drive' | 'gmail';

/** Your Google Cloud OAuth client, in the vault: shared by every Google connection. */
export const GOOGLE_CLIENT_SECRET = 'google/client';

/** Read-only first. Sending mail and changing files come later, behind a gate. */
export const GOOGLE_SCOPES: Record<GoogleService, string[]> = {
  drive: ['https://www.googleapis.com/auth/drive.readonly'],
  gmail: ['https://www.googleapis.com/auth/gmail.readonly'],
};

const SERVER_SCRIPT = assetPath('core', 'bin/google-mcp.mjs');

export function googleServer(service: GoogleService): McpServerDefinition {
  // GOOGLE_API only when polyphemus itself was pointed elsewhere (tests); otherwise the server uses Google's.
  const api = process.env.POLYPHEMUS_GOOGLE_API;
  return { kind: 'stdio', command: process.execPath, args: [SERVER_SCRIPT, service], auth: 'oauth', google: service, ...(api && { env: { GOOGLE_API: api } }) };
}

export function googleClient(vault: Vault): { clientId: string; clientSecret: string } | undefined {
  const raw = vault.get(GOOGLE_CLIENT_SECRET, 'google sign-in');
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { clientId?: string; clientSecret?: string };
    return parsed.clientId && parsed.clientSecret ? { clientId: parsed.clientId, clientSecret: parsed.clientSecret } : undefined;
  } catch {
    return undefined;
  }
}

export function setGoogleClient(vault: Vault, clientId: string, clientSecret: string): void {
  const id = clientId.trim();
  const secret = clientSecret.trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) throw new PolyphemusError('That isn’t a Google OAuth client ID: it ends in .apps.googleusercontent.com.', 'USAGE');
  if (secret.length < 10) throw new PolyphemusError('Paste the client secret too.', 'USAGE');
  vault.set(GOOGLE_CLIENT_SECRET, JSON.stringify({ clientId: id, clientSecret: secret }), { kind: 'token', note: 'Your Google Cloud OAuth client, for Google Drive and Gmail' });
}

/** Google's sign-in, with your client: offline access so there's a refresh token, and consent asked for it. */
export function googleSignIn(vault: Vault, service: GoogleService): OAuthServer {
  const client = googleClient(vault);
  if (!client) throw new PolyphemusError('Set up your Google sign-in client first: Setup → Connections → Google Drive or Gmail.', 'USAGE');
  return {
    issuer: 'https://accounts.google.com',
    authorizationEndpoint: process.env.POLYPHEMUS_GOOGLE_AUTH ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: process.env.POLYPHEMUS_GOOGLE_TOKEN ?? 'https://oauth2.googleapis.com/token',
    scopes: GOOGLE_SCOPES[service],
    client,
    extraParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  };
}
