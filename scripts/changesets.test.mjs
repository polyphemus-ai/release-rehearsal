import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A changeset naming a package that isn't in the workspace crashes the release's first step: twelve
// named the published `polyphemus`, found only at release time (2026-09-23). `changeset status` in CI
// caught it, but needs main's history, which a pull request's checkout doesn't have — so it's a test.
describe('changesets', () => {
  it('name only packages in the workspace', () => {
    const packages = new Set(['cli', 'core', 'daemon'].map((p) => JSON.parse(readFileSync(`packages/${p}/package.json`, 'utf8')).name));
    const named = readdirSync('.changeset')
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .flatMap((f) => {
        const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(`.changeset/${f}`, 'utf8'))?.[1] ?? '';
        return [...front.matchAll(/^['"]?([^'":]+)['"]?\s*:/gm)].map((m) => `${f}: ${m[1]}`);
      });
    expect(named.filter((n) => !packages.has(n.split(': ')[1]))).toEqual([]);
  });
});
