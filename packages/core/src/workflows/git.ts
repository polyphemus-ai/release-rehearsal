import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { folderInside, kindInside, listInside, readInside, removeFolderInside, renameInside, replaceInside } from '../contained.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { githubWeb } from '../connections/github.js';
import { toolEnvironment } from '../tools/guard.js';
import { PolyphemusError } from '../types.js';
import { assetPath } from '../assets.js';

// Git for workflows that ship: a folder of its own per run (a clone, still called its worktree), and
// fetches and pushes made as one of polyphemus's GitHub identities. polyphemus runs those itself — an agent commits in the worktree and never pushes,
// so it never holds the token, and never pushes with yours.

const exec = promisify(execFile);
const ASKPASS = assetPath('core', 'bin/git-askpass.sh');

/** Where a project's runs have their own folders: inside it, so the run's threads still belong to the project. */
export const RUNS = '.polyphemus-runs';

/** How long the folder an earlier run worked in is kept, so a retry can be compared with what it replaced. */
const SET_ASIDE_DAYS = 7;

/**
 * Clears out folders earlier runs worked in. One is kept for each branch, so a retry can be compared
 * with what it replaced, until it's a week old; the rest go. Nothing did this before, so a repository
 * that retried often kept every clone for ever (review of parallel agents, 2026-09-20).
 */
export function sweepSetAside(top: string, now = Date.now()): string[] {
  const aside = listInside(top, join(top, RUNS)).flatMap((name) => {
    const match = /^\.(.+)\.set-aside-(\d+)$/.exec(name);
    return match ? [{ name, branch: match[1]!, at: Number(match[2]) }] : [];
  });
  const newest = new Map<string, number>();
  for (const one of aside) newest.set(one.branch, Math.max(newest.get(one.branch) ?? 0, one.at));
  const gone: string[] = [];
  for (const one of aside) {
    if (one.at === newest.get(one.branch) && now - one.at < SET_ASIDE_DAYS * 24 * 60 * 60_000) continue;
    try {
      if (removeFolderInside(top, join(top, RUNS, one.name))) gone.push(one.name);
    } catch {
      // Something in the way — a link, or a file being written: left where it is, and tried again next run.
    }
  }
  return gone;
}

/**
 * Settings every git command polyphemus runs itself carries, outranking the repository's own config: no
 * hooks, no fsmonitor command, no transport that runs a program, and none of your own git settings
 * through an attributes file. The repository is one agents write to, and polyphemus's git runs on this
 * computer — some of it with an identity's token in its environment.
 *
 * What this does *not* cover, said plainly: a `filter.<name>.clean` named by a `.gitattributes` in
 * the repository still runs when git compares the working tree, because git has no switch to turn
 * filters off and `.git/info/attributes` is the run's own to rewrite (fourth review, 2026-09-20). On
 * this computer that program runs as you; where agents are isolated it runs in the worker, which is
 * the answer to it — this list isn't.
 */
export const SAFE_GIT = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.attributesFile=/dev/null',
  // Only the transports polyphemus uses: a repository's own config can otherwise turn on ext::, which runs
  // a program, and point a URL rewrite at it (workflow review, 2026-09-19).
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.http.allow=always',
  '-c', 'protocol.file.allow=always',
];

export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await exec('git', [...SAFE_GIT, '-C', cwd, ...args], { env: env ?? toolEnvironment(), maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60_000 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new PolyphemusError(`git ${args.find((a) => !a.startsWith('-')) ?? ''} failed: ${(e.stderr || e.message).trim().split('\n').slice(-3).join(' ')}`, 'FAILED');
  }
}

/**
 * The environment for one git command acting as an identity: the token only reaches git through the
 * askpass script, and your own git settings — credential helpers, URL rewrites to SSH — are left out,
 * so it can't quietly become a push as you.
 */
export function identityGitEnv(token: string): NodeJS.ProcessEnv {
  // The host the token may be given to: a URL rewrite in the repository's config can't send it elsewhere.
  return { ...toolEnvironment(), GIT_ASKPASS: ASKPASS, POLYPHEMUS_GIT_TOKEN: token, POLYPHEMUS_GIT_HOST: new URL(githubWeb()).host, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SSH_ASKPASS: '' };
}

/**
 * The environment an agent's shell gets inside a run's worktree: git can read, and fetch, but every
 * push is rewritten to an address that goes nowhere, whatever credentials this computer holds — so a
 * run's changes leave only through polyphemus's own push, as its identity, never as you. Set as git
 * command-line config through the environment, which outranks every config file.
 */
export function noPushEnv(base: NodeJS.ProcessEnv = toolEnvironment()): NodeJS.ProcessEnv {
  const rules: Array<[string, string]> = [
    ['url.polyphemus-pushes-for-this-run://.pushInsteadOf', 'https://'],
    ['url.polyphemus-pushes-for-this-run://.pushInsteadOf', 'http://'],
    ['url.polyphemus-pushes-for-this-run://.pushInsteadOf', 'ssh://'],
    ['url.polyphemus-pushes-for-this-run://.pushInsteadOf', 'git@'],
    ['url.polyphemus-pushes-for-this-run://.pushInsteadOf', 'file://'],
    ['url.polyphemus-pushes-for-this-run://.pushInsteadOf', '/'],
    // And no stored credentials to reach for.
    ['credential.helper', ''],
  ];
  const env: NodeJS.ProcessEnv = { ...base, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: String(rules.length) };
  rules.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

export const repoRemote = (repo: string) => `${githubWeb()}/${repo}.git`;

/** owner/name from a GitHub remote address, https or SSH. */
export function parseGitHubRemote(url: string): string | undefined {
  const hosts = ['github\\.com', new URL(githubWeb()).host.replace(/[.]/g, '\\.')];
  const match = new RegExp(`(?:${hosts.join('|')})[:/]([\\w.-]+)/([\\w.-]+?)(?:\\.git)?/?$`).exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export async function originRepo(cwd: string): Promise<string | undefined> {
  return git(cwd, ['remote', 'get-url', 'origin']).then(parseGitHubRemote, () => undefined);
}

export interface Worktree {
  path: string;
  branch: string;
  base: string;
  baseSha: string;
}

/**
 * A git repository of polyphemus's own, in a temporary folder, for one fetch or push as an identity. Its
 * config is polyphemus's, so nothing an agent wrote into a run's clone (a proxy, a URL rewrite, turning off
 * certificate checks, alternates pointing at other repositories) applies to a command holding the token.
 * `borrow` lends it a freshly made clone's objects, read-only, so a first fetch doesn't download them all.
 */
async function pristine<T>(act: (dir: string) => Promise<T>, borrow?: string): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'polyphemus-git-'));
  try {
    await git(dir, ['init', '--quiet', '--bare']);
    if (borrow) writeFileSync(join(dir, 'objects', 'info', 'alternates'), `${borrow}\n`);
    return await act(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A folder of its own for one run: a clone of the project (a full copy, not sharing its .git or its files
 * on disk), on a branch from the base as GitHub has it now, fetched as the identity. A run's worker is
 * given only this folder. Commits made in it are signed with the identity's name, and `git push` from
 * inside it goes nowhere: the run pushes. Making it again finds the one already there.
 */
export async function prepareWorktree(opts: { repoDir: string; repo: string; base: string; branch: string; token: string; author: { name: string; email: string } }): Promise<Worktree> {
  if (!/^polyphemus\/[\w./-]+$/.test(opts.branch)) throw new PolyphemusError(`A run's branch starts polyphemus/: ${opts.branch}`, 'USAGE');
  // The project's folder is the root: its .git and .polyphemus-runs are its agents' to write, links
  // included, so nothing below asks the project's own git where things are or follows a link there
  // (workflow review, 2026-09-19).
  const top = opts.repoDir;
  if (kindInside(top, join(top, '.git')) !== 'folder') throw new PolyphemusError(`${top} isn’t a git repository of its own (its .git is missing, a file or a link), so polyphemus won’t make a run's folder from it.`, 'USAGE');
  const safe = opts.branch.replace(/[^\w.-]+/g, '-');
  const path = join(top, RUNS, safe);
  // Out of the project's own git status.
  const exclude = join(top, '.git', 'info', 'exclude');
  const excluded = readInside(top, exclude) ?? '';
  if (!excluded.split('\n').includes(`/${RUNS}/`)) replaceInside(top, exclude, Buffer.from(`${excluded}${excluded && !excluded.endsWith('\n') ? '\n' : ''}/${RUNS}/\n`));

  folderInside(top, join(top, RUNS));
  // A folder an earlier run worked in isn't trusted — its .git is that run's agent's — so it's set aside
  // and this run gets a fresh clone, whose config is polyphemus's.
  if (kindInside(top, path)) renameInside(top, path, join(top, RUNS, `.${safe}.set-aside-${Date.now()}`));
  sweepSetAside(top);
  // Cloned from outside the project, so the project's own config (a URL rewrite, a transport) isn't this command's.
  // Not a local copy: a local clone copies objects/info/alternates as it stands, and a project's .git is
  // its agents' to write — so an alternate pointing at another repository on this computer would make
  // that repository's objects readable in the run, committable, and pushed out under polyphemus's own
  // identity. Going through git's own transport sends only what's reachable here, and hard-links
  // nothing, so a worker writing to an object file isn't writing to the project's (fourth review,
  // 2026-09-20).
  await git(tmpdir(), ['clone', '--quiet', '--no-checkout', '--no-local', join(top, '.git'), path]);
  await git(path, ['remote', 'set-url', 'origin', repoRemote(opts.repo)]);
  for (const [key, value] of [
    ['user.name', opts.author.name],
    ['user.email', opts.author.email],
    ['remote.origin.pushurl', 'polyphemus-pushes-this-branch://'],
  ] as const) {
    await git(path, ['config', key, value]);
  }
  const baseRef = `refs/polyphemus/base/${safe}`;
  await pristine(async (dir) => {
    await git(dir, ['-c', 'credential.helper=', 'fetch', '--no-tags', repoRemote(opts.repo), `+refs/heads/${opts.base}:refs/base`], identityGitEnv(opts.token));
    // Into the clone from polyphemus's repository: a local fetch, with no token anywhere near it.
    await git(path, ['fetch', '--no-tags', '--quiet', dir, `+refs/base:${baseRef}`]);
    // The clone polyphemus just made lends its objects, so the fetch doesn't download them all.
  }, join(path, '.git', 'objects'));
  const baseSha = await git(path, ['rev-parse', baseRef]);
  await git(path, ['checkout', '--quiet', '-B', opts.branch, baseSha]);
  return { path, branch: opts.branch, base: opts.base, baseSha };
}

const lstatExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Pushes the run folder's commit to the run's branch on GitHub, as the identity. Returns the commit.
 * The commits come out of the folder as a bundle made where the run's commands run (`bundle`: its
 * worker), streamed to polyphemus, so polyphemus never reads the folder's .git itself — whatever an agent did
 * to it can only change what's in the bundle, which is the run's work anyway.
 */
export async function pushBranch(cwd: string, repo: string, branch: string, token: string, bundle?: (file: string) => Promise<void>, expected?: string): Promise<string> {
  if (!branch.startsWith('polyphemus/')) throw new PolyphemusError(`polyphemus only pushes its own branches: ${branch}`, 'USAGE');
  return pristine(async (dir) => {
    const file = join(dir, 'run.bundle');
    if (bundle) await bundle(file);
    else await git(cwd, ['bundle', 'create', '--quiet', file, 'HEAD']);
    await git(dir, ['fetch', '--no-tags', '--quiet', file, 'HEAD']);
    const head = await git(dir, ['rev-parse', 'FETCH_HEAD']);
    // Only what was checked leaves: compared before anything is pushed, not after (independent review, 2026-09-19).
    if (expected !== undefined && head !== expected) throw new PolyphemusError(`Not pushing: the folder was at ${head.slice(0, 7)} when it was bundled, not ${expected.slice(0, 7)}, which was checked.`, 'FAILED');
    // Forced: the branch belongs to this run, and a later round replaces what an earlier one pushed.
    await git(dir, ['-c', 'credential.helper=', 'push', '--force', repoRemote(repo), `${head}:refs/heads/${branch}`], identityGitEnv(token));
    return head;
  });
}

export async function removeWorktree(path: string): Promise<boolean> {
  if (!existsSync(path) && !lstatExists(path)) return false;
  // A link standing for a run's folder is removed itself, never what it points at.
  if (lstatSync(path).isSymbolicLink()) {
    rmSync(path);
    return true;
  }
  // A run's own clone is just a folder; one from before runs had clones is a worktree of the project.
  if (existsSync(join(path, '.git')) && statSync(join(path, '.git')).isDirectory()) {
    rmSync(path, { recursive: true, force: true });
    return true;
  }
  const top = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  await git(resolve(top, '..'), ['worktree', 'remove', '--force', path]);
  return true;
}
