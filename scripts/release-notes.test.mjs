import { describe, expect, it } from 'vitest';
import { releaseNotes } from './release-notes.mjs';

// Changelogs as changesets writes them for a fixed group of packages: each change in the changelog of
// the package it names, and "Updated dependencies" everywhere else.
const cli = `# @polyphemus/cli

## 0.2.0

### Minor Changes

- 1a2b3c4: A new command for people using the terminal.

### Patch Changes

- Updated dependencies [5d6e7f8]
- Updated dependencies [9a0b1c2]
  - @polyphemus/core@0.2.0
  - @polyphemus/daemon@0.2.0

## 0.1.0

### Minor Changes

- 0000000: Something from an earlier release.
`;
const core = `# @polyphemus/core

## 0.2.0

### Patch Changes

- 5d6e7f8: A fix in the core, said over
  two lines.
- 3d4e5f6: One change named against two packages.
- Updated dependencies [1a2b3c4]
  - @polyphemus/cli@0.2.0
`;
const daemon = `# @polyphemus/daemon

## 0.2.0

### Minor Changes

- 9a0b1c2: Something the app does now.

### Patch Changes

- 3d4e5f6: One change named against two packages.
`;

describe('release notes', () => {
  it('gather every package’s changes for the version, each once, without the filler or the hashes', () => {
    expect(releaseNotes([cli, core, daemon], '0.2.0')).toBe(
      [
        '### Minor Changes',
        '',
        '- A new command for people using the terminal.',
        '- Something the app does now.',
        '',
        '### Patch Changes',
        '',
        '- A fix in the core, said over',
        '  two lines.',
        '- One change named against two packages.',
      ].join('\n'),
    );
  });

  it('say nothing for a version with no changes, and nothing from another version', () => {
    expect(releaseNotes([cli, core, daemon], '0.3.0')).toBe('');
    expect(releaseNotes([cli], '0.1.0')).toBe('### Minor Changes\n\n- Something from an earlier release.');
  });
});
