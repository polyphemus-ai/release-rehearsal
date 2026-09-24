import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { noPushEnv, pushBranch } from '../src/workflows/git.js';

// Inside a run's worktree, an agent's shell can't push — not with an SSH key, a credential helper, or
// a token in a URL — so a run's changes leave only through polyphemus's own push, as its identity.

describe('the no-push environment', () => {
  it('lets git fetch and commit, and turns every push into an address that goes nowhere', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polyphemus-nopush-'));
    const plain = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = plain) => spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
    const remote = join(root, 'remote.git');
    const work = join(root, 'work');
    execFileSync('git', ['init', '--quiet', '--bare', remote], { env: plain });
    execFileSync('git', ['init', '--quiet', work], { env: plain });
    git(work, ['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '--quiet', '--allow-empty', '-m', 'one']);

    // Without it, a push to a local remote just works.
    expect(git(work, ['push', '--quiet', remote, 'HEAD:refs/heads/main']).status).toBe(0);

    const locked = noPushEnv(plain);
    git(work, ['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '--quiet', '--allow-empty', '-m', 'two'], locked);
    for (const target of [remote, `file://${remote}`, 'https://x-access-token:secret@github.com/acme/site.git', 'git@github.com:acme/site.git', 'ssh://git@github.com/acme/site.git']) {
      const pushed = git(work, ['push', target, 'HEAD:refs/heads/main'], locked);
      expect(pushed.status, target).not.toBe(0);
      expect(pushed.stderr, target).toContain('polyphemus-pushes-for-this-run');
    }
    // Reading still works.
    expect(git(work, ['fetch', '--quiet', remote, 'main'], locked).status).toBe(0);
    expect(git(remote, ['log', '--oneline', 'main'], plain).stdout.trim().split('\n')).toHaveLength(1);
  });
});

describe('pushing a run’s branch', () => {
  it('refuses before pushing anything when the folder isn’t at the commit that was checked', async () => {
    // It compared after the push, so an unchecked commit had already left (independent review, 2026-09-19).
    const dir = await mkdtemp(join(tmpdir(), 'polyphemus-push-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=A', '-c', 'user.email=a@example.com', ...args], { encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('commit', '--quiet', '--allow-empty', '-m', 'one');
    const checked = git('rev-parse', 'HEAD');
    git('commit', '--quiet', '--allow-empty', '-m', 'two, never checked');
    // The remote doesn't exist: getting as far as pushing would fail differently.
    await expect(pushBranch(dir, 'acme/nowhere', 'polyphemus/x', 'token', undefined, checked)).rejects.toThrow(/not .*which was checked/);
  });
});
