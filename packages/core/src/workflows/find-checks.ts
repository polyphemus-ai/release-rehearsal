import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readBytesInside } from '../contained.js';

// The checks a repository already has, so shipping an issue doesn't ask you to know them. Read from
// what the project itself declares — package.json scripts, Cargo, Go, a Makefile's test target — never
// guessed from its code. Whatever is found is shown to you before it runs.

export interface FoundChecks {
  commands: string[];
  /** Where they came from, in words: "package.json (pnpm)". */
  from?: string;
}

const NO_TEST = /no test specified/;

/** Bigger than any real package.json or Makefile; anything past it isn't read. */
const MAX_MANIFEST = 2 * 1024 * 1024;

export function findChecks(dir: string): FoundChecks {
  const has = (file: string) => existsSync(join(dir, file));
  if (has('package.json')) {
    let scripts: Record<string, string> = {};
    let dependencies = 0;
    try {
      // A run's folder is its agents': read through no link and no more than a package file could be (workflow review, 2026-09-19).
      const pkg = JSON.parse(readBytesInside(dir, join(dir, 'package.json'), MAX_MANIFEST)?.toString('utf8') ?? '') as { scripts?: Record<string, string>; dependencies?: object; devDependencies?: object };
      scripts = pkg.scripts ?? {};
      dependencies = Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
    } catch {
      return { commands: [] };
    }
    const manager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const install = { pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', bun: 'bun install --frozen-lockfile', npm: has('package-lock.json') ? 'npm ci' : 'npm install' }[manager];
    const run = (script: string) => (manager === 'npm' ? `npm run ${script}` : `${manager} ${script}`);
    // Lint only when it isn't the same command as typecheck; a test script that just fails isn't a check.
    const wanted = ['typecheck', 'lint', 'test', 'build'].filter((name) => scripts[name] && !(name === 'test' && NO_TEST.test(scripts[name]!)) && !(name === 'lint' && scripts.lint === scripts.typecheck));
    if (!wanted.length) return { commands: [] };
    return { commands: [...(dependencies ? [install] : []), ...wanted.map(run)], from: `package.json (${manager})` };
  }
  if (has('Cargo.toml')) return { commands: ['cargo build', 'cargo test'], from: 'Cargo.toml' };
  if (has('go.mod')) return { commands: ['go build ./...', 'go test ./...'], from: 'go.mod' };
  if (has('Makefile')) {
    const makefile = readBytesInside(dir, join(dir, 'Makefile'), MAX_MANIFEST)?.toString('utf8') ?? '';
    if (/^test:/m.test(makefile)) return { commands: ['make test'], from: 'the Makefile' };
  }
  return { commands: [] };
}
