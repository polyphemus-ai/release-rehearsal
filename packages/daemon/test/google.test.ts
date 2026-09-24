import { writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Polyphemus, oauthSecretName } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

// Google Drive and Gmail (roadmap: show and connect, 3): your own sign-in client, Google's sign-in
// with offline access, and polyphemus's own MCP server, handed only a short-lived access token.

function fakeGoogle() {
  const seen = { bearers: [] as string[], tokenForms: [] as Record<string, string>[], revoked: false };
  const valid = new Set<string>();
  let base = '';
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/auth') {
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', 'google-code');
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token') {
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      seen.tokenForms.push(form);
      if (form.client_secret !== 'the-secret') return json(401, { error: 'invalid_client' });
      if (form.grant_type === 'authorization_code') {
        valid.add('access-g1');
        return json(200, { access_token: 'access-g1', refresh_token: 'refresh-g', expires_in: 3599, scope: 'https://www.googleapis.com/auth/drive.readonly' });
      }
      if (seen.revoked || form.refresh_token !== 'refresh-g') return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      valid.add('access-g2');
      return json(200, { access_token: 'access-g2', expires_in: 3599 });
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    seen.bearers.push(bearer);
    if (!valid.has(bearer)) return json(401, { error: { message: 'Invalid Credentials' } });
    if (url.pathname === '/drive/v3/files') return json(200, { files: [{ id: 'doc1', name: 'Q3 plan', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-09-10T10:00:00Z' }] });
    if (url.pathname === '/drive/v3/files/doc1') return json(200, { id: 'doc1', name: 'Q3 plan', mimeType: 'application/vnd.google-apps.document' });
    if (url.pathname === '/drive/v3/files/doc1/export') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('Ship the import fix by Friday.');
    }
    if (url.pathname === '/gmail/v1/users/me/messages') return json(200, { messages: [{ id: 'm1' }] });
    if (url.pathname === '/gmail/v1/users/me/messages/m1') {
      return json(200, { id: 'm1', threadId: 't1', snippet: 'The export is ready', payload: { headers: [{ name: 'From', value: 'Sam <sam@example.com>' }, { name: 'Subject', value: 'Export' }] } });
    }
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
let google: ReturnType<typeof fakeGoogle>;
const savedEnv = { ...process.env };

beforeEach(async () => {
  google = fakeGoogle();
  const g = await google.start();
  Object.assign(process.env, { POLYPHEMUS_GOOGLE_AUTH: `${g}/auth`, POLYPHEMUS_GOOGLE_TOKEN: `${g}/token`, POLYPHEMUS_GOOGLE_API: g, CODEX_HOME: '/nonexistent' });
  home = await mkdtemp(join(tmpdir(), 'polyphemus-google-'));
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\n${DEFAULT_CONFIG}`);
  polyphemus = await Polyphemus.open(home);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;
});
afterEach(async () => {
  await daemon.close();
  polyphemus.close();
  await google.stop();
  process.env = { ...savedEnv };
});

describe('Google', () => {
  it('signs in with your own client, reads Drive through polyphemus’s own server, and refreshes by restarting it', async () => {
    const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const raw = await res.text();
      return { status: res.status, raw, data: JSON.parse(raw || '{}') as Record<string, any> };
    };

    expect((await call('/api/connections/catalogue')).data.google).toEqual({ client: false, callback: `${base}/oauth/callback` });
    expect((await call('/api/connections', { catalogue: 'google-drive' })).status).toBe(400);
    expect((await call('/api/connections/google-client', { clientId: 'nope', clientSecret: 'the-secret' })).status).toBe(400);
    expect((await call('/api/connections/google-client', { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'the-secret' })).status).toBe(200);

    const added = (await call('/api/connections', { catalogue: 'google-drive' })).data;
    expect(added.connection).toMatchObject({ id: 'google-drive', auth: 'oauth', signedIn: false, where: 'polyphemus’s own Google Drive server, on this computer' });
    const authorize = new URL(added.authorizeUrl);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({ client_id: '123-abc.apps.googleusercontent.com', access_type: 'offline', prompt: 'consent', scope: 'https://www.googleapis.com/auth/drive.readonly', code_challenge_method: 'S256' });
    expect(authorize.searchParams.has('resource')).toBe(false);

    const back = (await fetch(added.authorizeUrl, { redirect: 'manual' })).headers.get('location')!;
    expect((await fetch(back, { headers: { cookie }, redirect: 'manual' })).status).toBe(302);
    expect(google.seen.tokenForms[0]).toMatchObject({ grant_type: 'authorization_code', client_secret: 'the-secret', code: 'google-code' });

    const { connection } = (await call('/api/connections/google-drive')).data;
    expect(connection).toMatchObject({ health: 'ok', signedIn: true, ceiling: { provenance: 'checked', scopes: ['https://www.googleapis.com/auth/drive.readonly'] } });
    expect(connection.tools.map((t: { name: string; reads: boolean }) => [t.name, t.reads])).toEqual([['search_files', true], ['recent_files', true], ['read_file', true]]);
    for (const secret of ['the-secret', 'refresh-g', 'access-g1']) expect((await call('/api/connections/google-drive')).raw).not.toContain(secret);

    const project = (await call('/api/projects', { name: 'Plans' })).data.project;
    await call('/api/connections/google-drive/grant', { project: project.slug, tools: ['search_files', 'read_file'] });
    expect(await polyphemus.connections.call('google-drive', 'read_file', { id: 'doc1' }, { project: project.slug })).toEqual({ isError: false, content: '# Q3 plan\n\nShip the import fix by Friday.' });
    expect(google.seen.bearers.every((b) => b === 'access-g1')).toBe(true);

    // Google stops taking the token: polyphemus refreshes it and restarts the server with the new one.
    google.valid.delete('access-g1');
    const found = await polyphemus.connections.call('google-drive', 'search_files', { text: 'plan' }, { project: project.slug });
    expect(found.content).not.toContain('401');
    expect(found.isError).toBe(false);
    expect(JSON.parse(found.content)).toEqual([expect.objectContaining({ id: 'doc1', name: 'Q3 plan' })]);
    expect(google.seen.bearers.at(-1)).toBe('access-g2');
    expect(google.seen.tokenForms.at(-1)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-g', client_secret: 'the-secret' });
  });

  it('reads Gmail, and a refused token is the connection’s problem, not the model’s', async () => {
    polyphemus.vault.set('google/client', JSON.stringify({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'the-secret' }));
    const owner = polyphemus.store.installOwner().id;
    const gmail = await polyphemus.connections.add({ name: 'Gmail', owner, server: (await import('@polyphemus/core')).googleServer('gmail'), createdBy: owner });
    polyphemus.vault.set(oauthSecretName(gmail.id), JSON.stringify({ accessToken: 'access-g1', refreshToken: 'refresh-g', expiresAt: Date.now() + 3_600_000, clientId: 'x', clientSecret: 'the-secret', tokenEndpoint: process.env.POLYPHEMUS_GOOGLE_TOKEN }));
    google.valid.add('access-g1');
    await polyphemus.connections.test(gmail.id);
    polyphemus.store.connections.setGrant({ connection: gmail.id, project: 'mail', agent: '', tools: ['search_messages'], by: owner, at: Date.now() });
    const found = await polyphemus.connections.call(gmail.id, 'search_messages', { query: 'newer_than:7d' }, { project: 'mail' });
    // No project called mail exists in the store, but the grant is what the call layer checks.
    expect(JSON.parse(found.content)).toEqual([expect.objectContaining({ id: 'm1', from: 'Sam <sam@example.com>', subject: 'Export' })]);

    // Access revoked at Google: the refresh fails too, and it's the connection that's failing.
    google.valid.delete('access-g1');
    google.seen.revoked = true;
    const refused = await polyphemus.connections.call(gmail.id, 'search_messages', {}, { project: 'mail' });
    expect(refused).toMatchObject({ isError: true, content: expect.stringContaining('401') });
    expect(polyphemus.connections.get(gmail.id)).toMatchObject({ health: 'failing', errorKind: 'auth' });
  });
});
