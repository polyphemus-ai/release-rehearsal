import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { toolEnvironment } from '../tools/guard.js';
import type { Worker } from '../isolation/workers.js';
import { SAFE_GIT } from './git.js';
import type { CheckResult } from './define.js';

// A check node's commands: objective pass or fail from the exit code, run with the secret-free
// environment polyphemus gives every tool — or in the run's worker, where agents are isolated — and
// recorded against the commit they ran on, so a result can't be mistaken for one about different code.

const TAIL = 4000;

export async function runCheck(command: string, cwd: string, opts: { timeoutMs?: number; signal?: AbortSignal; worker?: Worker } = {}): Promise<CheckResult> {
  if (opts.worker) {
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    const ran = await opts.worker.exec(['bash', '-lc', command], { cwd, combine: true, timeoutMs, ...(opts.signal && { signal: opts.signal }) });
    const output = ran.stdout.toString('utf8').slice(-TAIL * 2) + (ran.stopped === 'timeout' ? `\n[stopped after ${Math.round(timeoutMs / 1000)}s]` : '') + (ran.code === null && ran.stderr ? `\n${ran.stderr}` : '');
    const code = ran.stopped ? null : ran.code;
    return { command, exitCode: code, ok: code === 0, output: output.slice(-TAIL).trim() };
  }
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd, env: toolEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-TAIL * 2);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      output += `\n[stopped after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s]`;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 10 * 60_000);
    opts.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ command, exitCode: null, ok: false, output: `Couldn’t run it: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ command, exitCode: code, ok: code === 0, output: output.slice(-TAIL).trim() });
    });
  });
}

/** The commit a folder is at, if it's a repository. */
export async function headCommit(cwd: string, worker?: Worker): Promise<string | undefined> {
  if (worker) {
    const ran = await worker.exec(['git', '-C', cwd, 'rev-parse', 'HEAD'], { timeoutMs: 60_000 });
    const head = ran.stdout.toString('utf8').trim();
    return ran.code === 0 && /^[0-9a-f]{40,64}$/.test(head) ? head : undefined;
  }
  return promisify(execFile)('git', [...SAFE_GIT, '-C', cwd, 'rev-parse', 'HEAD']).then((r) => r.stdout.trim(), () => undefined);
}

/**
 * What a failure was, reduced to what would be the same if nothing changed: which commands failed,
 * and their output with numbers and timings taken out. Two rounds with the same signature made no progress.
 */
export function failureSignature(results: readonly CheckResult[]): string {
  const failed = results.filter((r) => !r.ok).map((r) => `${r.command}\n${r.output.replace(/\d+(\.\d+)?\s*(ms|s|m)\b/g, '').replace(/0x[0-9a-f]+/gi, '').replace(/\s+/g, ' ')}`);
  return createHash('sha256').update(failed.join('\n')).digest('hex').slice(0, 16);
}

/**
 * What the work in a folder looks like right now, reduced to a hash: in a repository, its commit and
 * uncommitted changes; otherwise the names, sizes and times of its files. A round that failed the
 * same way but changed this made progress; one that changed nothing didn't.
 */
export async function workingTreeFingerprint(cwd: string, worker?: Worker): Promise<string> {
  const hash = createHash('sha256');
  // In a worker, git there reads the folder: its config and filters are the run's own business, not this computer's.
  if (worker) {
    const script = 'if git rev-parse HEAD 2>/dev/null; then git status --porcelain; git diff --no-ext-diff HEAD; else find . -path ./node_modules -prune -o -path ./.git -prune -o -type f -printf "%p %s %T@\\n" | sort | head -5000; fi';
    const ran = await worker.exec(['bash', '-c', script], { cwd, maxBytes: 32 * 1024 * 1024, timeoutMs: 120_000 });
    return hash.update(ran.stdout).digest('hex').slice(0, 16);
  }
  // On this computer: polyphemus's safe settings, and no external diff program the repository names.
  const git = (args: string[]) => promisify(execFile)('git', [...SAFE_GIT, '-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024 }).then((r) => r.stdout, () => undefined);
  const head = await git(['rev-parse', 'HEAD']);
  if (head !== undefined) {
    hash.update(head).update((await git(['status', '--porcelain'])) ?? '').update((await git(['diff', '--no-ext-diff', '--no-textconv', 'HEAD'])) ?? '');
    return hash.digest('hex').slice(0, 16);
  }
  let seen = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (seen > 5000 || entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const stat = statSync(path);
        hash.update(`${path}\0${stat.size}\0${stat.mtimeMs}\n`);
        seen += 1;
      }
    }
  };
  try {
    walk(cwd);
  } catch {
    // unreadable: the fingerprint is what could be read
  }
  return hash.digest('hex').slice(0, 16);
}
