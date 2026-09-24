import { writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Polyphemus } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

// X: your own app, X's OAuth 2.0 sign-in (its secret as Basic auth, refresh tokens that change each
// time), and polyphemus's own MCP server, handed only a short-lived access token.

function fakeX() {
  const seen = { bearers: [] as string[], tokenForms: [] as Record<string, string>[], basic: [] as string[], posts: [] as Array<Record<string, unknown>> };
  const valid = new Set<string>();
  let refresh = 'refresh-x1';
  let base = '';
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'x-code');
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/2/oauth2/token') {
      const form = Object.fromEntries(new URLSearchParams(raw));
      seen.tokenForms.push(form);
      seen.basic.push(req.headers.authorization ?? '');
      if (req.headers.authorization !== `Basic ${Buffer.from('x-client-123:x-secret').toString('base64')}`) return json(401, { error: 'unauthorized_client' });
      if (form.grant_type === 'authorization_code') {
        valid.add('access-x1');
        return json(200, { token_type: 'bearer', access_token: 'access-x1', refresh_token: refresh, expires_in: 7200, scope: 'tweet.read tweet.write users.read offline.access' });
      }
      // X hands out a new refresh token each time, and the old one stops working.
      if (form.refresh_token !== refresh) return json(400, { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' });
      refresh = 'refresh-x2';
      valid.add('access-x2');
      return json(200, { token_type: 'bearer', access_token: 'access-x2', refresh_token: refresh, expires_in: 7200 });
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    seen.bearers.push(bearer);
    if (!valid.has(bearer)) return json(401, { title: 'Unauthorized', detail: 'Unauthorized' });
    if (url.pathname === '/2/users/me') return json(200, { data: { id: '42', username: 'acme', name: 'Acme' } });
    // Someone else's post.
    if (url.pathname === '/2/tweets/777') return json(200, { data: { id: '777', text: 'Not ours.', author_id: '99', created_at: '2026-09-20T10:00:00Z' } });
    if (url.pathname === '/2/tweets' && req.method === 'POST') {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.posts.push(body);
      return json(201, { data: { id: String(1000 + seen.posts.length), text: body.text } });
    }
    if (url.pathname === '/2/users/42/mentions') return json(403, { title: 'Client Forbidden', detail: 'When authenticating requests to the Twitter API v2 endpoints, you must use keys and tokens from a Twitter developer App that is attached to a Project.' });
    json(404, {});
  });
  return {
    seen,
    valid,
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve((base = `http://127.0.0.1:${(server.address() as { port: number }).port}`)))),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let base: string;
let x: ReturnType<typeof fakeX>;
const savedEnv = { ...process.env };

beforeEach(async () => {
  x = fakeX();
  const api = await x.start();
  Object.assign(process.env, { POLYPHEMUS_X_AUTH: `${api}/authorize`, POLYPHEMUS_X_TOKEN: `${api}/2/oauth2/token`, POLYPHEMUS_X_API: api, CODEX_HOME: '/nonexistent' });
  home = await mkdtemp(join(tmpdir(), 'polyphemus-x-'));
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\n${DEFAULT_CONFIG}\n[isolation]\nlevel = "host"\n`);
  polyphemus = await Polyphemus.open(home);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;
});
afterEach(async () => {
  await daemon.close();
  polyphemus.close();
  await x.stop();
  process.env = { ...savedEnv };
});

describe('X', () => {
  it('signs in with your own app, posts through polyphemus’s own server, and keeps the refresh token X rotates', async () => {
    const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const raw = await res.text();
      return { status: res.status, raw, data: JSON.parse(raw || '{}') as Record<string, any> };
    };

    const catalogue = (await call('/api/connections/catalogue')).data;
    expect(catalogue.catalogue.map((e: { id: string }) => e.id)).toContain('x');
    expect(catalogue.x).toEqual({ client: false, callback: `${base}/oauth/callback` });
    expect((await call('/api/connections', { catalogue: 'x' })).status).toBe(400);
    expect((await call('/api/connections/x-client', { clientId: 'no' })).status).toBe(400);
    expect((await call('/api/connections/x-client', { clientId: 'x-client-123', clientSecret: 'x-secret' })).status).toBe(200);

    const added = (await call('/api/connections', { catalogue: 'x' })).data;
    expect(added.connection).toMatchObject({ id: 'x', auth: 'oauth', signedIn: false, where: 'polyphemus’s own X server, on this computer' });
    const authorize = new URL(added.authorizeUrl);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ client_id: 'x-client-123', scope: 'tweet.read tweet.write users.read offline.access', code_challenge_method: 'S256', response_type: 'code' });

    const back = (await fetch(added.authorizeUrl, { redirect: 'manual' })).headers.get('location')!;
    expect((await fetch(back, { headers: { cookie }, redirect: 'manual' })).status).toBe(302);
    // The secret went as Basic auth, as X wants, and not in the form.
    expect(x.seen.tokenForms[0]).toMatchObject({ grant_type: 'authorization_code', code: 'x-code' });
    expect(x.seen.tokenForms[0]).not.toHaveProperty('client_secret');

    const { connection } = (await call('/api/connections/x')).data;
    expect(connection).toMatchObject({ health: 'ok', signedIn: true });
    expect(connection.tools.map((t: { name: string; reads: boolean }) => [t.name, t.reads])).toEqual([
      ['post', false],
      ['delete_post', false],
      ['my_account', true],
      ['my_recent_posts', true],
      ['read_post', true],
      ['my_mentions', true],
    ]);
    for (const secret of ['x-secret', 'refresh-x1', 'access-x1']) expect((await call('/api/connections/x')).raw).not.toContain(secret);

    const project = (await call('/api/projects', { name: 'Launch' })).data.project;
    await call('/api/connections/x/grant', { project: project.slug, tools: ['post', 'my_mentions', 'read_post'] });
    // Someone else's post links to it, not to a post under the signed-in account's name.
    const read = await polyphemus.connections.call('x', 'read_post', { id: '777' }, { project: project.slug });
    expect(JSON.parse(read.content)).toMatchObject({ id: '777', link: 'https://x.com/i/status/777' });
    expect(await polyphemus.connections.call('x', 'post', { text: 'Hello from polyphemus' }, { project: project.slug })).toEqual({ isError: false, content: 'Posted: https://x.com/acme/status/1001' });
    expect(x.seen.posts).toEqual([{ text: 'Hello from polyphemus' }]);
    // Not granted: refused before X hears of it.
    expect((await polyphemus.connections.call('x', 'delete_post', { id: '1001' }, { project: project.slug })).isError).toBe(true);
    // Too long: said to the model, nothing posted.
    expect(await polyphemus.connections.call('x', 'post', { text: 'a'.repeat(281) }, { project: project.slug })).toMatchObject({ isError: true, content: expect.stringContaining('X allows 280') });
    // A plan without reads: a result the model can explain, not a broken connection.
    expect(await polyphemus.connections.call('x', 'my_mentions', {}, { project: project.slug })).toMatchObject({ isError: true, content: expect.stringContaining('free plan') });
    expect(polyphemus.connections.get('x')).toMatchObject({ health: 'ok' });

    // X stops taking the token: polyphemus refreshes, keeps the new refresh token X handed back, and posts.
    x.valid.delete('access-x1');
    expect(await polyphemus.connections.call('x', 'post', { text: 'Replying', reply_to: '1001' }, { project: project.slug })).toMatchObject({ isError: false });
    expect(x.seen.posts.at(-1)).toEqual({ text: 'Replying', reply: { in_reply_to_tweet_id: '1001' } });
    expect(x.seen.tokenForms.at(-1)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-x1' });
    expect(JSON.parse(polyphemus.vault.get('connection/x/oauth')!)).toMatchObject({ refreshToken: 'refresh-x2', accessToken: 'access-x2' });
  });
});
