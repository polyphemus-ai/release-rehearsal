import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findChecks } from '../src/workflows/find-checks.js';

// Shipping an issue uses the checks a repository already declares, so nobody has to know them.

async function repo(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'polyphemus-checks-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe('finding a repository’s checks', () => {
  it('reads package.json scripts, with the package manager its lockfile says', async () => {
    const pnpm = await repo({ 'package.json': JSON.stringify({ scripts: { dev: 'next dev', typecheck: 'tsc --noEmit', lint: 'tsc --noEmit', build: 'next build' }, dependencies: { next: '16' } }), 'pnpm-lock.yaml': '' });
    // lint is the same command as typecheck here, so it isn't run twice.
    expect(findChecks(pnpm)).toEqual({ commands: ['pnpm install --frozen-lockfile', 'pnpm typecheck', 'pnpm build'], from: 'package.json (pnpm)' });
    const npm = await repo({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run', lint: 'eslint .' }, devDependencies: { vitest: '5' } }), 'package-lock.json': '{}' });
    expect(findChecks(npm)).toEqual({ commands: ['npm ci', 'npm run lint', 'npm run test'], from: 'package.json (npm)' });
  });

  it('skips npm’s placeholder test script, and installs nothing when there’s nothing to install', async () => {
    const dir = await repo({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: 'node build.js' } }) });
    expect(findChecks(dir)).toEqual({ commands: ['npm run build'], from: 'package.json (npm)' });
  });

  it('knows Cargo, Go and a Makefile’s test target, and says when there are none', async () => {
    expect(findChecks(await repo({ 'Cargo.toml': '[package]' })).commands).toEqual(['cargo build', 'cargo test']);
    expect(findChecks(await repo({ 'go.mod': 'module x' })).commands).toEqual(['go build ./...', 'go test ./...']);
    expect(findChecks(await repo({ Makefile: 'build:\n\tcc x.c\ntest:\n\t./x\n' })).commands).toEqual(['make test']);
    expect(findChecks(await repo({ 'README.md': '# Just words' }))).toEqual({ commands: [] });
  });
});
