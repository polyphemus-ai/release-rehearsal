import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assetPath } from '../src/assets.js';
import { git } from '../src/workflows/git.js';

// Polyphemus's own git runs on this computer in repositories agents write to, some of it with an identity's
// token in its environment: nothing the repository says may run a command, or send the token elsewhere.

describe('polyphemus’s own git', () => {
  it('runs no hooks and no fsmonitor command, whatever the repository’s config says', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'polyphemus-git-safety-'));
    execFileSync('git', ['init', '-q', repo]);
    const hooks = join(repo, '.husky');
    mkdirSync(hooks);
    const marker = join(repo, 'hook-ran');
    for (const hook of ['pre-commit', 'post-commit', 'reference-transaction']) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\necho "$POLYPHEMUS_GIT_TOKEN" >> ${JSON.stringify(marker)}\n`);
      chmodSync(join(hooks, hook), 0o755);
    }
    execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '.husky']);
    const monitor = join(repo, 'monitor.sh');
    writeFileSync(monitor, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(monitor, 0o755);
    execFileSync('git', ['-C', repo, 'config', 'core.fsmonitor', monitor]);
    await git(repo, ['-c', 'user.name=Sam', '-c', 'user.email=sam@example.com', 'commit', '-q', '--allow-empty', '-m', 'x'], { ...process.env, POLYPHEMUS_GIT_TOKEN: 'ghs_secret' });
    await git(repo, ['status', '--porcelain']);
    expect(existsSync(marker)).toBe(false);
    // The same commit by plain git does run the hook: the repository really was set up to.
    execFileSync('git', ['-C', repo, '-c', 'user.name=Sam', '-c', 'user.email=sam@example.com', 'commit', '-q', '--allow-empty', '-m', 'y']);
    expect(existsSync(marker)).toBe(true);
  });

  it('gives the token only to the host it was meant for', () => {
    const askpass = assetPath('core', 'bin/git-askpass.sh');
    const ask = (prompt: string) => spawnSync(askpass, [prompt], { encoding: 'utf8', env: { PATH: process.env.PATH, POLYPHEMUS_GIT_TOKEN: 'ghs_secret', POLYPHEMUS_GIT_HOST: 'github.com' } });
    expect(ask("Username for 'https://github.com': ").stdout).toBe('x-access-token\n');
    expect(ask("Password for 'https://x-access-token@github.com': ").stdout).toBe('ghs_secret\n');
    for (const elsewhere of ["Password for 'https://x-access-token@github.com.example.net': ", "Password for 'https://evil.example/github.com': ", "Password for 'https://x-access-token@example.com': "]) {
      const answer = ask(elsewhere);
      expect(answer.stdout).toBe('');
      expect(answer.status).not.toBe(0);
    }
  });
});
