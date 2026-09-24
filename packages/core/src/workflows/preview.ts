import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { toolEnvironment } from '../tools/guard.js';
import { PolyphemusError } from '../types.js';
import type { Worker } from '../isolation/workers.js';
import { readBytesInside } from '../contained.js';

// Serving a site from a worktree so polyphemus can look at it. What serves it comes from the repository
// itself — a dev script in package.json — or, for a folder of plain HTML, polyphemus's own small file
// server, which runs none of the project's code. A command from the project is shown to you before
// it first runs, like the checks.

export interface FoundPreview {
  /** A command from the project that serves the site; unset means poly serves the files itself. */
  command?: string;
  /** Where it came from, in words: "package.json (pnpm)", "you", or "the HTML files". */
  from: string;
}

export function findPreview(dir: string): FoundPreview | undefined {
  const has = (file: string) => existsSync(join(dir, file));
  if (has('package.json')) {
    try {
      // A run's folder is its agents': read through no link, and never an endless file (workflow review, 2026-09-19).
      const scripts = (JSON.parse(readBytesInside(dir, join(dir, 'package.json'), 2 * 1024 * 1024)?.toString('utf8') ?? '') as { scripts?: Record<string, string> }).scripts ?? {};
      const manager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
      const script = ['dev', 'start', 'preview', 'serve'].find((name) => scripts[name]);
      if (script) return { command: manager === 'npm' ? `npm run ${script}` : `${manager} ${script}`, from: `package.json (${manager})` };
    } catch {
      // unreadable: fall through to plain files
    }
  }
  if (has('index.html')) return { from: 'the HTML files' };
  return undefined;
}

export interface Preview {
  url: string;
  stop(): Promise<void>;
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json' };

/** A folder's files over HTTP on 127.0.0.1, nothing outside it: /about finds about.html or about/index.html. */
function serveFiles(dir: string): Promise<Preview> {
  const root = realpathSync(dir);
  const server: Server = createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      // A malformed address is a bad request, not a reason for polyphemus to stop.
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('Bad request');
    }
    const base = resolve(root, `.${path}`);
    const found = [base, join(base, 'index.html'), `${base}.html`].find((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
    let real: string | undefined;
    try {
      real = found && realpathSync(found);
    } catch {
      real = undefined;
    }
    if (!real || (real !== root && !real.startsWith(root + sep)) || real.split(sep).includes('.git')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    // Read from the folder it's served from, through no link and only as a plain file: a named pipe would hang it.
    const body = readBytesInside(root, real, 50 * 1024 * 1024);
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}`, stop: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => ok(port));
    });
  });

const answers = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' }).then(
    () => true,
    () => false,
  );

/**
 * Starts what serves the site and resolves once it answers. A project's command gets a free port in
 * PORT, and whatever address it prints (Vite, Astro and Next print theirs) is the one used.
 */
export async function startPreview(opts: { dir: string; command?: string; timeoutMs?: number; worker?: Worker }): Promise<Preview> {
  if (opts.worker) return startPreviewIn(opts.worker, { ...opts, timeoutMs: opts.timeoutMs ?? 120_000 });
  if (!opts.command) return serveFiles(opts.dir);
  const port = await freePort();
  // Its own process group, so stopping it stops whatever it started.
  const child = spawn('bash', ['-lc', opts.command], {
    cwd: opts.dir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...toolEnvironment(), PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  let output = '';
  let printed: string | undefined;
  const hear = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-8000);
    // eslint-disable-next-line no-control-regex
    const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
    printed ??= /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+/.exec(plain)?.[0]?.replace('0.0.0.0', '127.0.0.1');
  };
  // The pictures taken here are evidence a merge is decided on, so the site polyphemus looks at is the
  // one on the port it handed the command — not whatever address the command says to look at, which
  // a run could point at something it didn't build (fourth review, 2026-09-20).
  const elsewhere = () => (printed && !printed.endsWith(`:${port}`) ? ` It said to look at ${printed}, which isn’t the port it was given (PORT=${port}); polyphemus only looks at the port it gave.` : '');
  child.stdout.on('data', hear);
  child.stderr.on('data', hear);
  let exited: number | null | undefined;
  child.on('exit', (code) => (exited = code));
  const stop = async () => {
    if (exited !== undefined) return;
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      return;
    }
    for (let i = 0; i < 30 && exited === undefined; i++) await new Promise((r) => setTimeout(r, 100));
    try {
      if (exited === undefined) process.kill(-child.pid!, 'SIGKILL');
    } catch {
      // already gone
    }
  };
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  const tail = () => output.trim().split('\n').slice(-12).join('\n');
  const url = `http://127.0.0.1:${port}`;
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new PolyphemusError(`\`${opts.command}\` stopped (exit ${exited ?? 'none'}) before the site answered:\n${tail() || '(it printed nothing)'}`, 'FAILED');
    if (await answers(url)) return { url, stop };
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  throw new PolyphemusError(`\`${opts.command}\` didn’t answer on ${url} within ${Math.round((opts.timeoutMs ?? 120_000) / 1000)}s.${elsewhere()}\n${tail() || '(it printed nothing)'}`, 'FAILED');
}

/**
 * The same, in a run's worker: the site is served there and looked at by the worker's own Chromium, over
 * its loopback. Plain HTML is served by Python's file server, which runs none of the project's code.
 */
async function startPreviewIn(worker: Worker, opts: { dir: string; command?: string; timeoutMs: number }): Promise<Preview> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const command = opts.command ?? `exec python3 -m http.server ${port} --bind 127.0.0.1`;
  const started = worker.start(['bash', '-lc', command], { cwd: opts.dir, env: { PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none', NO_COLOR: '1', FORCE_COLOR: '0' } });
  let output = '';
  let printed: string | undefined;
  started.onOutput((chunk) => {
    output = (output + chunk).slice(-8000);
    // eslint-disable-next-line no-control-regex
    const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
    printed ??= /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+/.exec(plain)?.[0]?.replace('0.0.0.0', '127.0.0.1');
  });
  const elsewhere = () => (printed && !printed.endsWith(`:${port}`) ? ` It said to look at ${printed}, which isn’t the port it was given (PORT=${port}); polyphemus only looks at the port it gave.` : '');
  let exited: number | null | undefined;
  void started.exited.then((code) => (exited = code));
  const tail = () => output.trim().split('\n').slice(-12).join('\n');
  const deadline = Date.now() + opts.timeoutMs;
  const shown = opts.command ?? 'polyphemus’s file server';
  const url = `http://127.0.0.1:${port}`;
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new PolyphemusError(`\`${shown}\` stopped (exit ${exited ?? 'none'}) before the site answered:\n${tail() || '(it printed nothing)'}`, 'FAILED');
    const answered = await worker.exec(['curl', '-s', '-o', '/dev/null', '-m', '2', '--noproxy', '*', url], { timeoutMs: 10_000 });
    if (answered.code === 0) return { url, stop: () => started.stop() };
    await new Promise((r) => setTimeout(r, 500));
  }
  await started.stop();
  throw new PolyphemusError(`\`${shown}\` didn’t answer on ${url} within ${Math.round(opts.timeoutMs / 1000)}s.${elsewhere()}\n${tail() || '(it printed nothing)'}`, 'FAILED');
}
