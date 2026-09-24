import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bash } from '../src/tools/bash.js';
import { readFile } from '../src/tools/files.js';
import { credentialPathFor, credentialReferenceIn, mightReachCredentials, toolEnvironment } from '../src/tools/guard.js';
import { makeRedactor } from '../src/tools/redact.js';

const home = '/home/tester';

describe('credential guard', () => {
  it('recognizes credential stores by path', () => {
    expect(credentialPathFor('/home/tester/.claude/.credentials.json', home)).toBe('/home/tester/.claude/.credentials.json');
    expect(credentialPathFor('/home/tester/.ssh/id_ed25519', home)).toBe('/home/tester/.ssh');
    expect(credentialPathFor('/home/tester/.sshconfig', home)).toBeUndefined();
    expect(credentialPathFor('/home/tester/project/README.md', home)).toBeUndefined();
    // Ordinary stores on a developer's machine (connections review, 2026-09-20).
    for (const path of ['.git-credentials', '.config/gcloud/application_default_credentials.json', '.kube/config', '.npmrc', '.gnupg/secring.gpg', '.pypirc'])
      expect(credentialPathFor(`/home/tester/${path}`, home), path).toBeTruthy();
  });

  it('spots credential stores mentioned in shell commands, however they are spelled', () => {
    expect(credentialReferenceIn('cat ~/.codex/auth.json', home)).toBe('/home/tester/.codex/auth.json');
    expect(credentialReferenceIn(`python3 -c "open('$HOME/.claude/.credentials.json')"`, home)).toBe('/home/tester/.claude/.credentials.json');
    expect(credentialReferenceIn('cat ${HOME}/.aws/credentials', home)).toBe('/home/tester/.aws/credentials');
    expect(credentialReferenceIn('cat /proc/1234/environ', home)).toBe('/proc/<pid>/environ');
    expect(credentialReferenceIn('ls -la && cat README.md', home)).toBeUndefined();
    // Spelled around the check (assessment, 2026-09-12): ./, ../, doubled slashes, relative from home.
    expect(credentialReferenceIn('cat ~/.codex/./auth.json', home)).toBe('/home/tester/.codex/auth.json');
    expect(credentialReferenceIn('cat /home/tester/projects/../.codex//auth.json', home)).toBe('/home/tester/.codex/auth.json');
    expect(credentialReferenceIn('cd ~ && cat .codex/auth.json', home)).toBe('/home/tester/.codex/auth.json');
    expect(credentialReferenceIn('head -1 .ssh/id_ed25519', home)).toBe('/home/tester/.ssh');
    // A project's .env holds its keys; the committed example doesn't.
    expect(credentialReferenceIn('cat .env', home)).toBe('.env');
    expect(credentialReferenceIn('cat apps/web/.env.local', home)).toBe('apps/web/.env.local');
    expect(credentialReferenceIn('cat .env.example', home)).toBeUndefined();
  });

  it('never lets a glob or variable into a hidden home folder skip approval', () => {
    expect(mightReachCredentials('cat ~/.cod*/auth.json', home)).toBe(true);
    expect(mightReachCredentials('cat $HOME/.$X/auth.json', home)).toBe(true);
    expect(mightReachCredentials('ls ./*.ts && find . -name "*.md"', home)).toBe(false);
  });

  it('guards the vault when polyphemus’s home is reached through a link, as macOS’s temporary folders are', async () => {
    // A link to the vault resolves to where the vault really is; the guard compared that against the
    // home as written, so a home through a link (/var → /private/var on macOS, or a ~/.polyphemus
    // that's a link to another disk) let it through. Found when CI first ran on macOS (2026-09-23).
    const dir = await mkdtemp(join(tmpdir(), 'guard-linked-'));
    const saved = process.env.POLYPHEMUS_HOME;
    mkdirSync(join(dir, 'real', 'hh'), { recursive: true });
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    process.env.POLYPHEMUS_HOME = join(dir, 'link', 'hh');
    try {
      writeFileSync(join(dir, 'real', 'hh', 'vault.key'), 'k');
      symlinkSync(join(dir, 'link', 'hh', 'vault.key'), join(dir, 'innocent.txt'));
      expect(credentialPathFor(join(dir, 'innocent.txt'), home)).toBe(join(dir, 'link', 'hh', 'vault.key'));
      // And reached by its real path, not through the link at all.
      expect(credentialPathFor(join(dir, 'real', 'hh', 'vault.key'), home)).toBe(join(dir, 'link', 'hh', 'vault.key'));
    } finally {
      if (saved === undefined) delete process.env.POLYPHEMUS_HOME;
      else process.env.POLYPHEMUS_HOME = saved;
    }
  });

  it('guards polyphemus’s own secrets wherever POLYPHEMUS_HOME is, and follows symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guard-'));
    const saved = process.env.POLYPHEMUS_HOME;
    process.env.POLYPHEMUS_HOME = join(dir, 'hh');
    try {
      expect(credentialPathFor(join(dir, 'hh', 'vault.key'), home)).toBe(join(dir, 'hh', 'vault.key'));
      mkdirSync(join(dir, 'hh'));
      writeFileSync(join(dir, 'hh', 'vault.key'), 'k');
      symlinkSync(join(dir, 'hh', 'vault.key'), join(dir, 'innocent.txt'));
      expect(credentialPathFor(join(dir, 'innocent.txt'), home)).toBe(join(dir, 'hh', 'vault.key'));
      expect(credentialPathFor(join(dir, 'project', '.env'), home)).toBe(join(dir, 'project', '.env'));
    } finally {
      if (saved === undefined) delete process.env.POLYPHEMUS_HOME;
      else process.env.POLYPHEMUS_HOME = saved;
    }
  });

  it('makes the real tools refuse', async () => {
    const read = await readFile.run({ path: join(homedir(), '.codex/auth.json') }, { cwd: '/tmp' });
    expect(read).toMatchObject({ isError: true, content: expect.stringContaining('holds credentials') });
    const shell = await bash.run({ command: 'cat ~/.grok/auth.json' }, { cwd: '/tmp' });
    expect(shell).toMatchObject({ isError: true, content: expect.stringContaining('holds credentials') });
  });

  it('keeps secret-looking variables out of the tool environment', () => {
    const env = toolEnvironment({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'x', GH_TOKEN: 'y', AWS_SECRET_ACCESS_KEY: 'z', DB_PASSWORD: 'p' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('runs bash without them', async () => {
    const env = toolEnvironment({ ...process.env, ANTHROPIC_API_KEY: 'sk-ant-should-not-appear' });
    const result = await bash.run({ command: 'echo "[$ANTHROPIC_API_KEY]"' }, { cwd: '/tmp', env });
    expect(result.content).toContain('[]');
  });
});

describe('redaction', () => {
  it('masks known values and common credential formats', () => {
    const redact = makeRedactor(['my-very-secret-value-123']);
    const out = redact(
      'key=my-very-secret-value-123 anthropic=sk-ant-api03-abcdefghijklmnopqrstuvwxyz ' +
        'gh=ghp_abcdefghijklmnopqrstuvwxyz0123456789 aws_secret_access_key = abcdefghijklmnopqrstuvwxyzABCDEFGHIJ1234',
    );
    expect(out).not.toMatch(/my-very-secret|sk-ant-api03|ghp_abc|abcdefghijklmnopqrstuvwxyzABCDEFGHIJ1234/);
    expect(out).toContain('aws_secret_access_key = «redacted secret»');
  });

  it('leaves ordinary text alone', () => {
    expect(makeRedactor()('pnpm test passed: 52 tests')).toBe('pnpm test passed: 52 tests');
  });
});
