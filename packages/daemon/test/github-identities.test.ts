import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, Polyphemus } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';

// polyphemus's own GitHub identities (roadmap: it does the work, 3): GitHub Apps made with GitHub's
// manifest flow, installed on chosen repositories, reached with hour-long installation tokens made
// from a key only polyphemus holds — and an agent's own identity standing in for the project's.

function fakeGitHub() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const seen = { conversions: 0, tokens: [] as string[], pulls: [] as Record<string, unknown>[], reviews: [] as Record<string, unknown>[] };
  let base = '';
  let apps = 0;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const conversion = /^\/app-manifests\/([\w-]+)\/conversions$/.exec(url.pathname);
    if (conversion && req.method === 'POST') {
      seen.conversions += 1;
      apps += 1;
      return json(201, { id: 1000 + apps, slug: `polyphemus-app-${apps}`, name: `polyphemus App ${apps}`, pem, owner: { login: 'alex' }, html_url: `https://github.example/apps/polyphemus-app-${apps}` });
    }
    const install = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (install) {
      // Only a JWT signed with the app's key, naming the app, gets a token.
      const [head, payload, signature] = (req.headers.authorization ?? '').replace('Bearer ', '').split('.');
      const valid = createVerify('RSA-SHA256').update(`${head}.${payload}`).verify(publicKey, Buffer.from(signature ?? '', 'base64url'));
      const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8') || '{}');
      if (!valid || !String(claims.iss).startsWith('100')) return json(401, { message: 'Bad credentials' });
      const token = `ghs_installation_${install[1]}`;
      return json(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: install[1] === '77' ? { contents: 'read', pull_requests: 'write' } : { contents: 'write', pull_requests: 'write', issues: 'write' } });
    }
    const bearer = (req.headers.authorization ?? '').replace('Bearer ', '');
    seen.tokens.push(bearer);
    if (!bearer.startsWith('ghs_installation_')) return json(401, { message: 'Bad credentials' });
    if (url.pathname === '/installation/repositories') return json(200, { repositories: [{ full_name: 'acme/site', default_branch: 'main', private: true }] });
    if (url.pathname === '/repos/acme/site/issues') return json(200, [{ number: 12, title: 'Spec the notification engine', state: 'open', labels: [{ name: 'spec' }], user: { login: 'alex' } }]);
    if (url.pathname === '/repos/acme/site/pulls' && req.method === 'POST') {
      seen.pulls.push(body);
      return json(201, { number: 31, html_url: 'https://github.example/acme/site/pull/31', head: { sha: 'abc1234def' } });
    }
    if (url.pathname === '/repos/acme/site/pulls/31') return json(200, { number: 31, head: { sha: 'abc1234def', ref: 'spec/notifications' }, base: { ref: 'main' } });
    if (url.pathname === '/repos/acme/site/pulls/31/reviews' && req.method === 'POST') {
      seen.reviews.push(body);
      return json(200, { state: body.event === 'APPROVE' ? 'APPROVED' : body.event, html_url: 'https://github.example/review/1' });
    }
    json(404, { message: 'Not Found' });
  });
  return {
    pem,
    seen,
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve((base = `http://127.0.0.1:${(server.address() as { port: number }).port}`)))),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

let home: string;
let polyphemus: Polyphemus;
let daemon: Daemon;
let base: string;
let gh: ReturnType<typeof fakeGitHub>;
const savedEnv = { ...process.env };

beforeEach(async () => {
  gh = fakeGitHub();
  const api = await gh.start();
  Object.assign(process.env, { POLYPHEMUS_GITHUB_API: api, POLYPHEMUS_GITHUB_WEB: 'https://github.example', CODEX_HOME: '/nonexistent' });
  home = await mkdtemp(join(tmpdir(), 'polyphemus-gh-'));
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\n${DEFAULT_CONFIG}`);
  for (const name of ['reviewer', 'builder']) {
    mkdirSync(join(home, 'agents', name), { recursive: true });
    writeFileSync(join(home, 'agents', name, 'agent.toml'), `description = "${name}"\n`);
  }
  polyphemus = await Polyphemus.open(home);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;
});
afterEach(async () => {
  await daemon.close();
  polyphemus.close();
  await gh.stop();
  process.env = { ...savedEnv };
});

describe('GitHub identities', () => {
  it('makes a GitHub App with GitHub’s manifest flow, installs it, and acts through hour-long tokens only polyphemus can make', async () => {
    const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const raw = await res.text();
      return { status: res.status, raw, data: JSON.parse(raw || '{}') as Record<string, any> };
    };
    const browse = async (url: string) => fetch(url, { headers: { cookie }, redirect: 'manual' });

    async function identity(role: string, installationId: number) {
      const started = (await call('/api/connections/github-app', { role, org: 'acme-org' })).data;
      const manifest = JSON.parse(started.manifest);
      expect(started.action).toMatch(/^https:\/\/github\.example\/organizations\/acme-org\/settings\/apps\/new\?state=/);
      expect(manifest).toMatchObject({ redirect_url: `${base}/github/app-created`, setup_url: `${base}/github/app-installed`, public: false, hook_attributes: { active: false } });
      const state = new URL(started.action).searchParams.get('state')!;
      // GitHub sends the browser back with a one-time code; polyphemus turns it into the app, then sends it to install.
      const created = await browse(`${base}/github/app-created?code=one-time-${role}&state=${state}`);
      expect(created.status).toBe(302);
      const toInstall = new URL(created.headers.get('location')!);
      expect(toInstall.pathname).toMatch(/^\/apps\/polyphemus-app-\d+\/installations\/new$/);
      const installed = await browse(`${base}/github/app-installed?installation_id=${installationId}&setup_action=install&state=${toInstall.searchParams.get('state')}`);
      expect(installed.status).toBe(302);
      return { manifest, id: installed.headers.get('location')!.replace('/#/connections/', '') };
    }

    const builder = await identity('builder', 55);
    expect(builder.manifest.default_permissions).toMatchObject({ contents: 'write', pull_requests: 'write', issues: 'write' });
    const reviewer = await identity('reviewer', 77);
    // Write, so its approval counts under a branch rule; it still has no tool that pushes.
    expect(reviewer.manifest.default_permissions).toMatchObject({ contents: 'write', pull_requests: 'write' });

    const { connection } = (await call(`/api/connections/${builder.id}`)).data;
    expect(connection).toMatchObject({ health: 'ok', github: { role: 'builder', installed: true }, ceiling: { provenance: 'checked', scopes: expect.arrayContaining(['contents: write', 'repo acme/site']) } });
    expect(connection.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['list_issues', 'create_pull_request', 'comment']));
    expect(connection.tools.map((t: { name: string }) => t.name)).not.toContain('review_pull_request');
    expect(connection.tools.map((t: { name: string }) => t.name).some((n: string) => /merge/.test(n))).toBe(false);
    for (const r of [await call(`/api/connections/${builder.id}`), await call('/api/connections'), await call('/api/state')]) {
      expect(r.raw).not.toContain('PRIVATE KEY');
      expect(r.raw).not.toContain('ghs_installation_');
    }

    // What GitHub said can't be overwritten by a declaration, and a check replaces an old one outright.
    expect((await call(`/api/connections/${builder.id}/ceiling`, { tools: ['list_issues'] })).status).toBe(400);
    polyphemus.store.connections.setCeiling(builder.id, { provenance: 'declared', tools: ['list_issues'], by: 'someone', at: 1 });
    expect((await polyphemus.connections.test(builder.id)).ceiling).toEqual({ provenance: 'checked', scopes: expect.arrayContaining(['contents: write']), at: expect.any(Number) });

    // A deploy removes the release that made it: the saved path to polyphemus's own server goes nowhere,
    // and the identity still starts, from where this copy of polyphemus keeps the server.
    const saved = polyphemus.connections.get(builder.id)!.server as { args: string[] };
    polyphemus.store.connections.setServer(builder.id, { ...saved, args: ['/nowhere/releases/gone/packages/core/bin/github-mcp.mjs', 'builder'] } as never);
    expect((await polyphemus.connections.test(builder.id)).health).toBe('ok');

    // The project works as Builder; the Reviewer agent has its own identity, which replaces the project's.
    const project = (await call('/api/projects', { name: 'Ledger' })).data.project;
    const builderTools = connection.tools.map((t: { name: string }) => t.name);
    await call(`/api/connections/${builder.id}/grant`, { project: project.slug, tools: builderTools });
    const reviewerTools = (await call(`/api/connections/${reviewer.id}`)).data.connection.tools.map((t: { name: string }) => t.name);
    await call(`/api/connections/${reviewer.id}/grant`, { project: project.slug, tools: reviewerTools });
    await call(`/api/connections/${reviewer.id}/grant`, { project: project.slug, agent: 'reviewer', tools: reviewerTools });
    expect(polyphemus.connections.reach(project.slug, 'reviewer').map((r) => r.connection)).toEqual([reviewer.id]);
    expect(polyphemus.connections.reach(project.slug, 'builder').map((r) => r.connection).sort()).toEqual([builder.id, reviewer.id].sort());

    const opened = await polyphemus.connections.call(builder.id, 'create_pull_request', { repo: 'acme/site', head: 'spec/notifications', base: 'main', title: 'Spec: notifications' }, { project: project.slug, agent: 'builder' });
    expect(opened.isError).toBe(false);
    expect(gh.seen.pulls[0]).toMatchObject({ head: 'spec/notifications', base: 'main' });
    expect(gh.seen.tokens.filter((t) => t).every((t) => t.startsWith('ghs_installation_'))).toBe(true);

    // An approval is for one commit: a stale one is refused before it reaches GitHub.
    const stale = await polyphemus.connections.call(reviewer.id, 'review_pull_request', { repo: 'acme/site', number: 31, commit: 'old0000', event: 'APPROVE' }, { project: project.slug, agent: 'reviewer' });
    expect(stale).toMatchObject({ isError: true, content: expect.stringContaining('has moved on') });
    const approved = await polyphemus.connections.call(reviewer.id, 'review_pull_request', { repo: 'acme/site', number: 31, commit: 'abc1234def', event: 'APPROVE' }, { project: project.slug, agent: 'reviewer' });
    expect(approved).toMatchObject({ isError: false, content: expect.stringContaining('APPROVED') });
    expect(gh.seen.reviews).toEqual([{ commit_id: 'abc1234def', event: 'APPROVE', body: '' }]);
  });

  it('refuses a return from GitHub that polyphemus didn’t start', async () => {
    const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const forged = await fetch(`${base}/github/app-created?code=whatever&state=not-ours`, { headers: { cookie }, redirect: 'manual' });
    expect(forged.status).toBe(400);
    expect(gh.seen.conversions).toBe(0);
    const stranger = await fetch(`${base}/github/app-installed?installation_id=123&setup_action=install`, { headers: { cookie }, redirect: 'manual' });
    expect(stranger.status).toBe(400);
  });
});
