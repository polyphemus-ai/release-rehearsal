import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Polyphemus, oauthSecretName } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

// Connecting a remote MCP server that signs in with OAuth, the way the MCP authorization spec says:
// discovery, registration, PKCE, tokens kept in the vault and refreshed — never shown to anyone.

/** A service like Ledger: protected-resource metadata, an authorization server, and an MCP endpoint behind it. */
function fakeService() {
  const state = { challenge: '', tokens: new Set<string>(), refreshed: 0, registered: 0, echo: false };
  let base = '';
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/.well-known/oauth-protected-resource') return json(200, { resource: `${base}/api/mcp`, authorization_servers: [base] });
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json(200, { issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`, code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp', 'projects:read'] });
    }
    if (url.pathname === '/oauth/register') {
      state.registered += 1;
      return json(201, { client_id: 'polyphemus-client' });
    }
    if (url.pathname === '/oauth/authorize') {
      // The person signs in here; the service sends them back with a code.
      state.challenge = url.searchParams.get('code_challenge') ?? '';
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'the-code');
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/oauth/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        const verified = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === state.challenge;
        if (!verified || form.get('code') !== 'the-code') return json(400, { error: 'invalid_grant' });
        state.tokens.add('access-one-token');
        return json(200, { access_token: 'access-one-token', refresh_token: 'refresh-one-token', expires_in: 3600, scope: 'mcp projects:read' });
      }
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'refresh-one-token') {
        state.refreshed += 1;
        state.tokens.add('access-two-token');
        return json(200, { access_token: 'access-two-token', expires_in: 3600 });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/api/mcp') {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token || !state.tokens.has(token)) return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
      const message = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
      if (message.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      const result =
        message.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ledger', version: '1' } }
        : message.method === 'tools/list' ? { tools: [{ name: 'list_projects', description: 'Projects', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] }
        : { content: [{ type: 'text', text: state.echo ? `debug: called with ${token}` : `3 projects (token ${token === 'access-two-token' ? 'refreshed' : 'first'})` }] };
      return json(200, { jsonrpc: '2.0', id: message.id, result });
    }
    json(404, {});
  });
  return {
    state,
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve((base = `http://127.0.0.1:${(server.address() as { port: number }).port}`)))),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let base: string;
let service: ReturnType<typeof fakeService>;
let serviceBase: string;
const savedEnv = { ...process.env };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-oauth-'));
  process.env.CODEX_HOME = join(home, 'no-codex');
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\n${DEFAULT_CONFIG}`);
  polyphemus = await Polyphemus.open(home);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;
  service = fakeService();
  serviceBase = await service.start();
});
afterEach(async () => {
  await daemon.close();
  polyphemus.close();
  await service.stop();
  process.env = { ...savedEnv };
});

describe('connecting with OAuth', () => {
  it('discovers, registers, signs in with PKCE, keeps the tokens out of sight, and refreshes them', async () => {
    const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const raw = await res.text();
      return { status: res.status, raw, data: JSON.parse(raw || '{}') as Record<string, any> };
    };

    // Just the site: polyphemus finds how it signs in, and where its MCP server is.
    const discovered = (await call(`/api/connections/discover?url=${encodeURIComponent(serviceBase)}`)).data;
    expect(discovered).toEqual({ oauth: true, url: `${serviceBase}/api/mcp`, host: new URL(serviceBase).host, scopes: ['mcp', 'projects:read'] });

    const added = (await call('/api/connections', { name: 'Ledger', kind: 'http', url: discovered.url, auth: 'oauth' })).data;
    expect(added.connection).toMatchObject({ id: 'ledger', auth: 'oauth', signedIn: false, health: 'untested' });
    const authorize = new URL(added.authorizeUrl);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${base}/oauth/callback`);
    expect(service.state.registered).toBe(1);

    // A browser may send no Origin at all (no-referrer); the address still comes from how the request arrived.
    const viaTailnet = await fetch(`${base}/api/connections/ledger/signin`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: '{}' });
    expect(new URL(((await viaTailnet.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get('redirect_uri')).toBe(`https://${new URL(base).host}/oauth/callback`);

    // The person signs in at the service, which sends their browser back to polyphemus.
    const back = (await fetch(added.authorizeUrl, { redirect: 'manual' })).headers.get('location')!;
    const landed = await fetch(back, { headers: { cookie }, redirect: 'manual' });
    expect(landed.status).toBe(302);
    expect(landed.headers.get('location')).toBe('/#/connections/ledger');

    const { connection } = (await call('/api/connections/ledger')).data;
    expect(connection).toMatchObject({ health: 'ok', signedIn: true, tools: [{ name: 'list_projects', reads: true }], ceiling: { provenance: 'checked', scopes: ['mcp', 'projects:read'] } });
    for (const response of [await call('/api/connections/ledger'), await call('/api/connections'), await call('/api/state')]) {
      expect(response.raw).not.toContain('access-one-token');
      expect(response.raw).not.toContain('refresh-one-token');
    }

    // The same sign-in link can't be used twice.
    const replay = await fetch(back, { headers: { cookie }, redirect: 'manual' });
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain('expired or was already used');

    // When the token is about to run out, polyphemus refreshes it before connecting.
    const shop = (await call('/api/projects', { name: 'Shop' })).data.project;
    await call('/api/connections/ledger/grant', { project: shop.slug, tools: ['list_projects'] });
    const record = JSON.parse(polyphemus.vault.get(oauthSecretName('ledger'))!);
    polyphemus.vault.set(oauthSecretName('ledger'), JSON.stringify({ ...record, expiresAt: Date.now() + 1000 }));
    service.state.tokens.delete('access-one-token');
    await call('/api/connections/ledger/test', {});
    const result = await polyphemus.connections.call('ledger', 'list_projects', {}, { project: shop.slug });
    expect(result).toEqual({ isError: false, content: '3 projects (token refreshed)' });
    expect(service.state.refreshed).toBe(1);

    // Refreshed during the call itself — no 401 first — and echoed back: masked all the same
    // (re-review, 2026-09-19). The refresh happens as the client is made, so none is kept.
    polyphemus.vault.set(oauthSecretName('ledger'), JSON.stringify({ ...JSON.parse(polyphemus.vault.get(oauthSecretName('ledger'))!), accessToken: 'access-one-token', refreshToken: 'refresh-one-token', expiresAt: Date.now() + 1000 }));
    (polyphemus.connections as unknown as { drop(id: string): void }).drop('ledger');
    service.state.echo = true;
    const echoed = await polyphemus.connections.call('ledger', 'list_projects', {}, { project: shop.slug });
    expect(service.state.refreshed).toBe(2);
    expect(echoed.content).toContain('debug: called with');
    expect(echoed.content).not.toContain('access-two-token');
  });

  it('returns to the thread whose card started the sign-in, and not to another one', async () => {
    const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const raw = await res.text();
      return { status: res.status, raw, data: JSON.parse(raw || '{}') as Record<string, any> };
    };
    const added = await call('/api/connections', { name: 'Ledger', kind: 'http', url: `${serviceBase}/api/mcp`, auth: 'oauth' });
    expect(added.status).toBe(201);
    const thread = polyphemus.store.create({ title: 'the books', provider: 'openai', model: 'gpt-5', cwd: home });
    const other = polyphemus.store.create({ title: 'somewhere else', provider: 'openai', model: 'gpt-5', cwd: home });
    const asked = polyphemus.store.askQuestion({ id: 'sign1234', sessionId: thread.id, kind: 'signin', detail: { connection: 'ledger', name: 'Ledger', how: 'oauth', where: 'Ledger', purpose: 'read the books' } });
    polyphemus.store.askQuestion({ id: 'sign5678', sessionId: other.id, kind: 'signin', detail: { connection: 'ledger', name: 'Ledger', how: 'oauth', where: 'Ledger', purpose: 'the other one' } });
    polyphemus.store.askQuestion({ id: 'sign9999', sessionId: thread.id, kind: 'signin', detail: { connection: 'other', name: 'Other', how: 'oauth', where: 'Other', purpose: 'not this one' } });

    // A question that isn't this connection's open sign-in isn't a place to return to.
    const wrong = await call('/api/connections/ledger/signin', { question: 'sign9999' });
    expect(wrong.status).toBe(400);
    expect(wrong.raw).not.toContain('access-one-token');

    // Signing in from Connections, while a card is open, still lands on the connection.
    const plain = await call('/api/connections/ledger/signin', {});
    const plainBack = (await fetch(plain.data.authorizeUrl as string, { redirect: 'manual' })).headers.get('location')!;
    const plainLanded = await fetch(plainBack, { headers: { cookie }, redirect: 'manual' });
    expect(plainLanded.status).toBe(302);
    expect(plainLanded.headers.get('location')).toBe('/#/connections/ledger');

    // From the card: back to that thread. The other thread that asked for Ledger stays where it is.
    const fromCard = await call('/api/connections/ledger/signin', { question: asked.id });
    const cardBack = (await fetch(fromCard.data.authorizeUrl as string, { redirect: 'manual' })).headers.get('location')!;
    const cardLanded = await fetch(cardBack, { headers: { cookie }, redirect: 'manual' });
    expect(cardLanded.status).toBe(302);
    expect(cardLanded.headers.get('location')).toBe(`/#/s/${thread.id}`);
    expect(polyphemus.store.question('sign5678')?.status).toBe('open');
    for (const raw of [plain.raw, fromCard.raw, await cardLanded.text()]) expect(raw).not.toContain('access-one-token');
  });

  it('says so when a service doesn’t sign in with OAuth', async () => {
    const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const res = await fetch(`${base}/api/connections/discover?url=${encodeURIComponent(`${base}/nothing-here`)}`, { headers: { cookie } });
    expect(await res.json()).toEqual({ oauth: false });
  });
});
