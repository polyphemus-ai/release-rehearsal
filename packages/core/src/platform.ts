import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

// Where Polyphemus is running, as far as finding programs goes. Inside WSL it's Linux, with Windows
// around it: WSL appends Windows's own PATH (its folders under /mnt/c and the like), so a program
// installed on Windows turns up on Linux's PATH too.

/** Inside WSL on Windows. */
export const inWsl = (): boolean => Boolean(process.env.WSL_DISTRO_NAME) || existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');

/** A folder of Windows's own, as WSL mounts it: /mnt/c/… */
const windowsFolder = (dir: string): boolean => /^\/mnt\/[a-z](\/|$)/i.test(dir);

/** Where Polyphemus installs a vendor CLI that comes from npm: a folder of its own, never the system's. */
export const toolsPrefix = (): string => join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'polyphemus', 'tools');

/**
 * Where the vendors' own installers put their CLIs (Claude Code in ~/.local/bin, Grok in ~/.grok/bin),
 * and where Polyphemus puts the ones from npm. Looked in after PATH: a background service's PATH was
 * fixed when it was installed, and a CLI installed since — or by an installer that only edits a
 * shell's startup files — is still found (2026-09-23).
 */
export const toolDirs = (): string[] => [join(homedir(), '.local', 'bin'), join(homedir(), '.grok', 'bin'), join(toolsPrefix(), 'bin')];

/** PATH with the tool folders after it, each once. */
export function pathWithTools(path = process.env.PATH ?? ''): string {
  const have = new Set(path.split(delimiter));
  return [path, ...toolDirs().filter((dir) => !have.has(dir))].filter(Boolean).join(delimiter);
}

/**
 * Where a command is on PATH, if it is. Inside WSL, Windows's folders don't count: a Windows build of
 * Claude Code or Codex found there looked like a Linux one and can't work on Linux paths (2026-09-23).
 */
export function findOnPath(command: string, opts: { windows?: boolean } = {}): string | undefined {
  if (command.includes('/')) return existsSync(command) ? command : undefined;
  const skipWindows = !opts.windows && inWsl();
  for (const dir of pathWithTools().split(delimiter)) {
    if (!dir || (skipWindows && windowsFolder(dir))) continue;
    const path = join(dir, command);
    if (existsSync(path)) return path;
  }
  return undefined;
}
