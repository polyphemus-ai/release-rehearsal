import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliCommand } from '../src/polyphemus-guide.js';

describe('the command agents are given for the CLI', () => {
  it('goes by releases/current, which outlives the release it was written under', () => {
    const releases = join(mkdtempSync(join(tmpdir(), 'cli-command-')), 'releases');
    const bin = join(releases, 'abc1234567', 'packages', 'cli', 'bin', 'polyphemus.mjs');
    mkdirSync(join(bin, '..'), { recursive: true });
    writeFileSync(bin, '');
    // Without the link it's the release itself; with it, the link.
    expect(cliCommand(bin)).toBe(`node ${bin}`);
    symlinkSync(join(releases, 'abc1234567'), join(releases, 'current'));
    expect(cliCommand(bin)).toBe(`node ${join(releases, 'current', 'packages', 'cli', 'bin', 'polyphemus.mjs')}`);
  });

  it('is the checkout’s own launcher when polyphemus runs from source', () => {
    const repo = mkdtempSync(join(tmpdir(), 'cli-source-'));
    const bin = join(repo, 'packages', 'cli', 'bin', 'polyphemus.mjs');
    mkdirSync(join(bin, '..'), { recursive: true });
    writeFileSync(bin, '');
    expect(cliCommand(bin)).toBe(`node ${bin}`);
    expect(cliCommand(join(repo, 'nowhere.mjs'))).toBe('polyphemus');
  });
});
