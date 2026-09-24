import { afterEach, describe, expect, it, vi } from 'vitest';

// Only these paths exist, whatever the machine running the test has.
const present = new Set<string>();
vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs')>()), existsSync: (path: string) => present.has(path) }));
const { findOnPath, inWsl, toolDirs } = await import('../src/platform.js');
const { homedir } = await import('node:os');

const saved = { PATH: process.env.PATH, WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME };
afterEach(() => {
  present.clear();
  process.env.PATH = saved.PATH;
  if (saved.WSL_DISTRO_NAME === undefined) delete process.env.WSL_DISTRO_NAME;
  else process.env.WSL_DISTRO_NAME = saved.WSL_DISTRO_NAME;
});

describe('findOnPath', () => {
  it('inside WSL, doesn’t take a Windows build on the PATH WSL appends for a Linux one', () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    process.env.PATH = '/usr/local/bin:/usr/bin:/mnt/c/Users/Alex/AppData/Roaming/npm';
    present.add('/mnt/c/Users/Alex/AppData/Roaming/npm/codex');
    expect(inWsl()).toBe(true);
    expect(findOnPath('codex')).toBeUndefined();
    // Asked for on purpose — Windows's own Tailscale — it's found.
    expect(findOnPath('codex', { windows: true })).toBe('/mnt/c/Users/Alex/AppData/Roaming/npm/codex');
    // A Linux one is the one found.
    present.add('/usr/local/bin/codex');
    expect(findOnPath('codex')).toBe('/usr/local/bin/codex');
  });

  it('outside WSL, a folder under /mnt is an ordinary folder', () => {
    delete process.env.WSL_DISTRO_NAME;
    process.env.PATH = '/usr/bin:/mnt/c/tools';
    present.add('/mnt/c/tools/codex');
    expect(inWsl()).toBe(false);
    expect(findOnPath('codex')).toBe('/mnt/c/tools/codex');
  });

  it('finds a CLI where its vendor’s installer put it, though that folder isn’t on PATH', () => {
    delete process.env.WSL_DISTRO_NAME;
    process.env.PATH = '/usr/bin';
    present.add(`${homedir()}/.grok/bin/grok`);
    expect(toolDirs()).toContain(`${homedir()}/.grok/bin`);
    expect(findOnPath('grok')).toBe(`${homedir()}/.grok/bin/grok`);
    // PATH still comes first.
    present.add('/usr/bin/grok');
    expect(findOnPath('grok')).toBe('/usr/bin/grok');
  });
});
