import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { Polyphemus } from '../src/polyphemus.js';
import { createProject } from '../src/projects.js';
import { findChecks } from '../src/workflows/find-checks.js';
import { RUNS, prepareWorktree, sweepSetAside } from '../src/workflows/git.js';
import { startPreview } from '../src/workflows/preview.js';

// A run's folder, and the project it sits in, are where agents write. What polyphemus does with them on
// this computer — making a run's folder, mounting it, reading its package.json, serving its pages —
// must not follow a link out or hang on what's there (workflow review, 2026-09-19).

let base: string;
let repo: string;
let elsewhere: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'polyphemus-wf-'));
  repo = join(base, 'project');
  elsewhere = join(base, 'yours');
  mkdirSync(repo);
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'notes.txt'), 'private');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=A', '-c', 'user.email=a@example.com', ...args], { stdio: 'ignore' });
  git('init', '--quiet', '--initial-branch=main');
  git('commit', '--quiet', '--allow-empty', '-m', 'one');
});

const prepare = () => prepareWorktree({ repoDir: repo, repo: 'acme/site', base: 'main', branch: 'polyphemus/issue-1', token: 't', author: { name: 'A', email: 'a@example.com' } });

describe('a run’s folder', () => {
  it('isn’t made through a link standing for the runs folder', async () => {
    symlinkSync(elsewhere, join(repo, RUNS));
    await expect(prepare()).rejects.toThrow(/link/);
    expect(readdirSync(elsewhere)).toEqual(['notes.txt']);
  });

  it('never appends to a file a linked git exclude points at', async () => {
    writeFileSync(join(elsewhere, 'exclude'), 'mine\n');
    execFileSync('rm', ['-f', join(repo, '.git', 'info', 'exclude')]);
    symlinkSync(join(elsewhere, 'exclude'), join(repo, '.git', 'info', 'exclude'));
    await prepare().catch(() => undefined); // the fetch from GitHub fails here; what matters happened before it
    expect(readFileSync(join(elsewhere, 'exclude'), 'utf8')).toBe('mine\n');
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain(`/${RUNS}/`);
  });

  it('sets aside a folder an earlier run worked in, rather than trusting its git config', async () => {
    const earlier = join(repo, RUNS, 'polyphemus-issue-1');
    mkdirSync(join(earlier, '.git'), { recursive: true });
    writeFileSync(join(earlier, '.git', 'config'), '[protocol "ext"]\n\tallow = always\n[url "ext::sh -c touch% /tmp/polyphemus-owned%"]\n\tinsteadOf = /\n');
    await prepare().catch(() => undefined);
    const aside = readdirSync(join(repo, RUNS)).filter((name) => name.startsWith('.polyphemus-issue-1.set-aside-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(repo, RUNS, aside[0]!, '.git', 'config'), 'utf8')).toContain('ext::');
  });

  it('doesn’t borrow another repository’s objects through the project’s alternates', async () => {
    // A project's .git is its agents' to write. A local clone copies objects/info/alternates as it
    // stands, so an alternate pointing anywhere on this computer made that repository's objects part
    // of the run — and a run's commits are pushed out as polyphemus (fourth review, 2026-09-20).
    const secret = join(base, 'private');
    mkdirSync(secret);
    const secretGit = (...args: string[]) => execFileSync('git', ['-C', secret, '-c', 'user.name=A', '-c', 'user.email=a@example.com', ...args], { stdio: 'ignore' });
    secretGit('init', '--quiet', '--initial-branch=main');
    writeFileSync(join(secret, 'pay.txt'), 'PRIVATE-SALARY-DATA\n');
    secretGit('add', '-A');
    secretGit('commit', '--quiet', '-m', 'private');
    const blob = execFileSync('git', ['-C', secret, 'rev-parse', 'HEAD:pay.txt'], { encoding: 'utf8' }).trim();
    writeFileSync(join(repo, '.git', 'objects', 'info', 'alternates'), `${join(secret, '.git', 'objects')}\n`);

    await prepare().catch(() => undefined); // the fetch from GitHub fails; the clone happened before it

    const run = join(repo, RUNS, 'polyphemus-issue-1');
    expect(existsSync(join(run, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    // The private repository's blob isn't reachable from the run's folder.
    expect(() => execFileSync('git', ['-C', run, 'cat-file', '-p', blob], { stdio: 'pipe' })).toThrow();
  });

  it('isn’t mounted for a run when it goes through a link', async () => {
    const home = join(base, 'home');
    mkdirSync(home);
    await writeFile(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(base, 'projects'))}\n${DEFAULT_CONFIG}`);
    const polyphemus = await Polyphemus.open(home);
    const { project } = await createProject(polyphemus.store, home, join(base, 'projects'), { name: 'Shop' });
    polyphemus.store.setProjectIsolation(project.slug, 'isolated');
    polyphemus.runtime = () => ({ name: 'docker', command: 'docker', version: '1', rootless: false }) as never;
    mkdirSync(join(project.path, RUNS), { recursive: true });
    symlinkSync(elsewhere, join(project.path, RUNS, 'polyphemus-issue-2'));
    await expect(polyphemus.runWorker(join(project.path, RUNS, 'polyphemus-issue-2'))).rejects.toThrow(/link or leads outside/);
    polyphemus.close();
  });
});

describe('folders earlier runs worked in', () => {
  const day = 24 * 60 * 60_000;

  it('keeps the newest for each branch for a week, clears the rest, and follows no link out', () => {
    const now = Date.now();
    const runs = join(repo, RUNS);
    const aside = (branch: string, ago: number) => {
      const name = `.${branch}.set-aside-${now - ago}`;
      mkdirSync(join(runs, name, '.git'), { recursive: true });
      writeFileSync(join(runs, name, 'work.txt'), 'what it built');
      return name;
    };
    const kept = aside('polyphemus-issue-1', 3 * day);
    const older = aside('polyphemus-issue-1', 9 * day);
    const stale = aside('polyphemus-issue-2', 30 * day);
    // A folder a run is working in now, and a link standing where a set-aside folder was.
    mkdirSync(join(runs, 'polyphemus-issue-3'), { recursive: true });
    symlinkSync(elsewhere, join(runs, `.polyphemus-issue-4.set-aside-${now - 30 * day}`));

    const gone = sweepSetAside(repo, now);

    expect(gone.sort()).toEqual([older, stale, `.polyphemus-issue-4.set-aside-${now - 30 * day}`].sort());
    expect(readdirSync(runs).sort()).toEqual([kept, 'polyphemus-issue-3'].sort());
    // The link went; what it pointed at didn't.
    expect(readdirSync(elsewhere)).toEqual(['notes.txt']);
  });

  it('is swept when the next run sets one aside, so they don’t pile up for ever', async () => {
    const runs = join(repo, RUNS);
    mkdirSync(join(runs, `.polyphemus-issue-1.set-aside-${Date.now() - 40 * day}`), { recursive: true });
    mkdirSync(join(repo, RUNS, 'polyphemus-issue-1'), { recursive: true });
    await prepare().catch(() => undefined); // the fetch from GitHub fails; setting aside happened before it
    const left = readdirSync(runs).filter((name) => name.startsWith('.polyphemus-issue-1.set-aside-'));
    expect(left).toHaveLength(1);
    expect(Number(left[0]!.split('-').at(-1))).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('what a run’s folder declares', () => {
  it('reads package.json only as a plain file inside it, so a pipe or a link can’t hang or leak', () => {
    execFileSync('mkfifo', [join(repo, 'package.json')]);
    expect(findChecks(repo)).toEqual({ commands: [] });
    execFileSync('rm', [join(repo, 'package.json')]);
    writeFileSync(join(elsewhere, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', build: 'tsc' } }));
    symlinkSync(join(elsewhere, 'package.json'), join(repo, 'package.json'));
    expect(findChecks(repo).commands).toEqual([]);
  });

  it('serves its pages without stopping on a malformed address or a pipe', async () => {
    writeFileSync(join(repo, 'index.html'), '<h1>hi</h1>');
    execFileSync('mkfifo', [join(repo, 'stuck.html')]);
    const preview = await startPreview({ dir: repo });
    try {
      expect((await fetch(`${preview.url}/%`)).status).toBe(400);
      expect((await fetch(`${preview.url}/stuck.html`, { signal: AbortSignal.timeout(3000) })).status).toBe(404);
      expect(await (await fetch(`${preview.url}/`)).text()).toContain('hi');
    } finally {
      await preview.stop();
    }
    expect(existsSync(join(repo, 'index.html'))).toBe(true);
  });

  it('looks at the port it gave the command, not the address the command names', async () => {
    // The pictures taken here are evidence a merge is decided on. A run's own command could point
    // polyphemus at a site it didn't build (fourth review, 2026-09-20).
    const decoy = createServer((_req, res) => res.end('<h1>A PAGE THE RUN DID NOT BUILD</h1>'));
    await new Promise<void>((ok) => decoy.listen(0, '127.0.0.1', () => ok()));
    const decoyPort = (decoy.address() as { port: number }).port;
    try {
      // It binds nothing itself, and says to look at the decoy.
      const command = `echo "Local: http://127.0.0.1:${decoyPort}/"; sleep 30`;
      await expect(startPreview({ dir: repo, command, timeoutMs: 3000 })).rejects.toThrow(/didn’t answer on http:\/\/127\.0\.0\.1:\d+.*isn’t the port it was given/s);
    } finally {
      await new Promise<void>((ok) => decoy.close(() => ok()));
    }
  }, 20_000);
});
