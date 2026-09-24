import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assetPath, bundled } from '../src/assets.js';

// polyphemus's own files are found the same way from the repository as from the published package; the
// build copies each of these beside the bundle (scripts/build.mjs), so every one has to exist here.
describe('polyphemus’s own files', () => {
  it('are all where the code looks for them', () => {
    expect(bundled).toBe(false);
    for (const [pkg, rel] of [
      ['core', 'bin/approval-mcp.mjs'],
      ['core', 'bin/connections-mcp.mjs'],
      ['core', 'bin/github-mcp.mjs'],
      ['core', 'bin/google-mcp.mjs'],
      ['core', 'bin/git-askpass.sh'],
      ['core', 'templates/'],
      ['daemon', 'web/index.html'],
      ['daemon', 'security-headers.json'],
      ['cli', 'bin/polyphemus.mjs'],
      ['cli', 'package.json'],
    ] as const) {
      expect(existsSync(assetPath(pkg, rel)), `${pkg}/${rel}`).toBe(true);
    }
  });
});
