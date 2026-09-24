import { execFileSync, spawn } from 'node:child_process';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

// A GitHub for tests: the API calls polyphemus's identities and workflows make, and real git over HTTP
// (git's own http-backend) that only lets an installation token with write access push.

export interface FakeReview {
  user: { login: string };
  state: string;
  commit_id: string;
  body: string;
}

export function fakeGitHub(root: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const repos = join(root, 'remote');
  const bare = join(repos, 'acme', 'site.git');
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  const seen = {
    gitAuth: [] as Array<{ user: string; token: string; push: boolean }>,
    apiTokens: [] as string[],
    merges: [] as Array<{ number: number; sha: string }>,
    reviews: [] as FakeReview[],
    issues: [] as Array<{ number: number; title: string; body: string; by: string }>,
    /** Answer the commit status lookup with a 500, as GitHub sometimes does. */
    statusDown: false,
  };
  /** Installation id → the app it belongs to and what it may do. */
  const installations = new Map<string, { appId: number; write: boolean }>();
  const pulls: Array<{ number: number; head: string; base: string; title: string; body: string; author: string; state: string; merged: boolean }> = [];
  let base = '';
  let apps = 0;

  // The remote, with one commit on main.
  mkdirSync(join(repos, 'acme'), { recursive: true });
  git('init', '--quiet', '--bare', '--initial-branch=main', bare);
  git('-C', bare, 'config', 'http.receivepack', 'true');
  const seed = join(root, 'seed');
  git('init', '--quiet', '--initial-branch=main', seed);
  execFileSync('bash', ['-c', `cd ${seed} && echo "# Ledger" > README.md && mkdir -p docs/specs && echo "# Specs" > docs/specs/README.md && printf '{ \"scripts\": { \"test\": \"test -f feature.txt\" } }\\n' > package.json`]);
  git('-C', seed, 'add', '-A');
  git('-C', seed, '-c', 'user.name=Alex', '-c', 'user.email=j@example.com', 'commit', '--quiet', '-m', 'Start');
  git('-C', seed, 'push', '--quiet', bare, 'main');

  const loginFor = (token: string) => {
    const id = /^ghs_installation_(\d+)$/.exec(token)?.[1];
    const install = id ? installations.get(id) : undefined;
    return install ? `polyphemus-app-${install.appId - 1000}[bot]` : undefined;
  };
  const headOf = (branch: string) => {
    try {
      return git('-C', bare, 'rev-parse', `refs/heads/${branch}`);
    } catch {
      return '';
    }
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    // Git over HTTP: basic auth as x-access-token with an installation token; pushing needs write.
    if (url.pathname.startsWith('/acme/site.git/')) {
      const [user, token] = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString('utf8').split(':');
      const push = url.searchParams.get('service') === 'git-receive-pack' || url.pathname.endsWith('/git-receive-pack');
      const id = /^ghs_installation_(\d+)$/.exec(token ?? '')?.[1];
      const install = id ? installations.get(id) : undefined;
      if (!user) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' });
        return res.end();
      }
      seen.gitAuth.push({ user, token: token ?? '', push });
      if (user !== 'x-access-token' || !install || (push && !install.write)) {
        res.writeHead(403);
        return res.end('Permission denied');
      }
      const cgi = spawn('git', ['http-backend'], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: repos,
          GIT_HTTP_EXPORT_ALL: '1',
          REMOTE_USER: user,
          REQUEST_METHOD: req.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          CONTENT_LENGTH: String(raw.length),
          ...(req.headers['content-encoding'] && { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] }),
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        },
      });
      cgi.stdin.end(raw);
      const out: Buffer[] = [];
      cgi.stdout.on('data', (c: Buffer) => out.push(c));
      await new Promise((resolve) => cgi.on('close', resolve));
      const all = Buffer.concat(out);
      const split = all.indexOf('\r\n\r\n');
      const headers = all.subarray(0, split).toString('utf8').split('\r\n');
      let status = 200;
      const h: Record<string, string> = {};
      for (const line of headers) {
        const [k, ...v] = line.split(':');
        if (k!.toLowerCase() === 'status') status = Number.parseInt(v.join(':').trim(), 10);
        else if (k) h[k] = v.join(':').trim();
      }
      res.writeHead(status, h);
      return res.end(all.subarray(split + 4));
    }

    const body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
    const conversion = /^\/app-manifests\/([\w-]+)\/conversions$/.exec(url.pathname);
    if (conversion && req.method === 'POST') {
      apps += 1;
      return json(201, { id: 1000 + apps, slug: `polyphemus-app-${apps}`, name: `polyphemus App ${apps}`, pem, owner: { login: 'alex' }, html_url: `${base}/apps/polyphemus-app-${apps}` });
    }
    const install = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname);
    if (install) {
      const [head, payload, signature] = (req.headers.authorization ?? '').replace('Bearer ', '').split('.');
      const valid = createVerify('RSA-SHA256').update(`${head}.${payload}`).verify(publicKey, Buffer.from(signature ?? '', 'base64url'));
      const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8') || '{}');
      if (!valid) return json(401, { message: 'Bad credentials' });
      const appId = Number(claims.iss);
      // The reviewer's installation (77) reads code; the others write.
      const write = install[1] !== '77';
      installations.set(install[1]!, { appId, write });
      return json(201, { token: `ghs_installation_${install[1]}`, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: write ? { contents: 'write', pull_requests: 'write', issues: 'write' } : { contents: 'read', pull_requests: 'write' } });
    }

    const token = (req.headers.authorization ?? '').replace('Bearer ', '');
    seen.apiTokens.push(token);
    const login = loginFor(token);
    if (!login) return json(401, { message: 'Bad credentials' });
    const path = url.pathname;
    if (path === '/installation/repositories') return json(200, { repositories: [{ full_name: 'acme/site', default_branch: 'main', private: true }] });
    if (path === '/repos/acme/site') return json(200, { full_name: 'acme/site', default_branch: 'main' });
    if (path === '/repos/acme/site/issues/12') return json(200, { number: 12, title: 'Say it shipped', body: 'Add feature.txt saying "shipped".', state: 'open', html_url: `${base}/acme/site/issues/12` });
    if (path === '/repos/acme/site/issues/13') return json(200, { number: 13, title: 'Say what’s next', body: 'Add next.txt.', state: 'open', html_url: `${base}/acme/site/issues/13` });
    if (path === '/repos/acme/site/issues' && req.method === 'POST') {
      const issue = { number: 100 + seen.issues.length, title: String(body.title), body: String(body.body), by: login };
      seen.issues.push(issue);
      return json(201, { number: issue.number, title: issue.title, html_url: `${base}/acme/site/issues/${issue.number}` });
    }
    if (path === '/repos/acme/site/issues') return json(200, seen.issues.map((i) => ({ number: i.number, title: i.title })));
    if (path === '/repos/acme/site/pulls' && req.method === 'POST') {
      const head = headOf(String(body.head));
      if (!head) return json(422, { message: 'Validation Failed: head branch not found' });
      const pr = { number: 31 + pulls.length, head: String(body.head), base: String(body.base), title: String(body.title), body: String(body.body ?? ''), author: login, state: 'open', merged: false };
      pulls.push(pr);
      return json(201, { number: pr.number, html_url: `${base}/acme/site/pull/${pr.number}`, head: { sha: head } });
    }
    if (path === '/repos/acme/site/pulls') {
      const wanted = url.searchParams.get('head')?.split(':')[1];
      return json(200, pulls.filter((p) => p.state === 'open' && (!wanted || p.head === wanted)).map((p) => ({ number: p.number, html_url: `${base}/acme/site/pull/${p.number}` })));
    }
    const pull = /^\/repos\/acme\/site\/pulls\/(\d+)(\/reviews|\/merge)?$/.exec(path);
    if (pull) {
      const pr = pulls.find((p) => p.number === Number(pull[1]));
      if (!pr) return json(404, { message: 'Not Found' });
      const sha = headOf(pr.head);
      if (pull[2] === '/reviews' && req.method === 'POST') {
        if (login === pr.author && body.event === 'APPROVE') return json(422, { message: 'Can not approve your own pull request' });
        const review = { user: { login }, state: body.event === 'APPROVE' ? 'APPROVED' : body.event === 'REQUEST_CHANGES' ? 'CHANGES_REQUESTED' : 'COMMENTED', commit_id: String(body.commit_id), body: String(body.body ?? '') };
        seen.reviews.push(review);
        return json(200, { ...review, html_url: `${base}/review` });
      }
      if (pull[2] === '/reviews') {
        // Paged as GitHub does: per_page (at most 100) at a time.
        const per = Math.min(Number(url.searchParams.get('per_page') ?? 30), 100);
        const page = Number(url.searchParams.get('page') ?? 1);
        return json(200, seen.reviews.slice((page - 1) * per, page * per));
      }
      if (pull[2] === '/merge' && req.method === 'PUT') {
        if (body.sha !== sha) return json(409, { message: 'Head branch was modified. Review and try the merge again.' });
        git('-C', bare, 'update-ref', `refs/heads/${pr.base}`, sha);
        pr.merged = true;
        pr.state = 'closed';
        seen.merges.push({ number: pr.number, sha });
        return json(200, { merged: true, sha });
      }
      return json(200, { number: pr.number, state: pr.state, merged: pr.merged, merge_commit_sha: pr.merged ? sha : null, user: { login: pr.author }, head: { sha, ref: pr.head }, base: { ref: pr.base }, title: pr.title });
    }
    if (/^\/repos\/acme\/site\/commits\/\w+\/check-runs$/.test(path)) return json(200, { check_runs: [] });
    if (/^\/repos\/acme\/site\/commits\/\w+\/status$/.test(path)) return seen.statusDown ? json(500, { message: 'Server Error' }) : json(200, { state: 'pending', statuses: [] });
    json(404, { message: 'Not Found' });
  });

  return {
    seen,
    bare,
    git,
    pulls,
    headOf,
    get base() {
      return base;
    },
    start: () => new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve((base = `http://127.0.0.1:${(server.address() as { port: number }).port}`)))),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Makes an identity through polyphemus's own manifest flow, as a person would. Returns its connection id. */
export async function makeIdentity(base: string, cookie: string, role: string, installationId: number): Promise<string> {
  const started = (await (await fetch(`${base}/api/connections/github-app`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ role }) })).json()) as { action: string };
  const state = new URL(started.action).searchParams.get('state')!;
  const created = await fetch(`${base}/github/app-created?code=one-time-${role}&state=${state}`, { headers: { cookie }, redirect: 'manual' });
  const toInstall = new URL(created.headers.get('location')!);
  const installed = await fetch(`${base}/github/app-installed?installation_id=${installationId}&setup_action=install&state=${toInstall.searchParams.get('state')}`, { headers: { cookie }, redirect: 'manual' });
  return installed.headers.get('location')!.replace('/#/connections/', '');
}
