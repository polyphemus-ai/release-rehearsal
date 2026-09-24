import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// macOS's /bin/sh is an old bash, which reads the bytes of a character like "…" straight after a
// variable as part of its name: `say "Installing $WHAT…"` stopped the one-line install on macOS with
// "WHAT…: unbound variable". Linux's sh doesn't, so only the first macOS CI run found it (2026-09-23).
// Braces end a name in every shell: ${WHAT}…
describe('shell scripts', () => {
  it('never run a variable straight into a character outside ASCII', () => {
    const scripts = execFileSync('git', ['ls-files', '*.sh'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    expect(scripts.length).toBeGreaterThan(0);
    const found = scripts.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line) ? `${file}:${i + 1}: ${line.trim()}` : null))
        .filter(Boolean),
    );
    expect(found).toEqual([]);
  });
});
