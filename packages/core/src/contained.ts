import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

// Files an agent can write — a project's folder, a thread's folder, a project's memory, its
// computer's home — are read and written by polyphemus on this computer too: AGENTS.md goes into
// prompts, notes and skills are listed, attachments are put there. An agent can make any file or
// folder in them a link to somewhere of the user's it can't see, and polyphemus, following it, would
// carry that into a prompt or write there (independent review, 2026-09-19).
//
// So every operation here names a *trusted* root — a folder the person chose, or the mount point a
// worker was given, which an agent can't replace — and a path inside it. The path is walked one
// folder at a time from the root, never following a link, and the file is then used through the
// folder it's really in. On Linux that folder is held open and reached as /proc/self/fd/N, so a link
// swapped in while this runs can't redirect anything: the kernel resolves each name inside the
// folder that was opened. Elsewhere (macOS) each step is checked with lstat instead: a link that's
// already there is refused, but one swapped in between the check and the use isn't caught.

const HELD = existsSync('/proc/self/fd');

/** A folder, walked to without following links: a path to reach things in it by, and a way to let it go. */
interface Held {
  path: string;
  close(): void;
}

/** The names from `root` down to `path`, or undefined if `path` isn't inside it. */
function partsOf(root: string, path: string): string[] | undefined {
  const rel = relative(root, path);
  if (rel === '') return [];
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return undefined;
  const parts = rel.split(sep);
  return parts.every((part) => part && part !== '.' && part !== '..') ? parts : undefined;
}

class LinkError extends Error {
  readonly code = 'ELINK';
}

const lstatExists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

function holdFolder(root: string, parts: string[], create: boolean): Held {
  if (HELD) {
    let fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      for (const part of parts) {
        const next = `/proc/self/fd/${fd}/${part}`;
        let inner: number;
        try {
          inner = openSync(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' && create) {
            mkdirSync(next);
            inner = openSync(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          } else if (code === 'ELOOP' || code === 'ENOTDIR') {
            throw new LinkError(`${join(root, ...parts)} goes through a link or a file, so polyphemus doesn’t use it.`);
          } else throw err;
        }
        closeSync(fd);
        fd = inner;
      }
    } catch (err) {
      closeSync(fd);
      throw err;
    }
    const held = fd;
    return { path: `/proc/self/fd/${held}`, close: () => closeSync(held) };
  }
  let at = realpathSync(root);
  for (const part of parts) {
    at = join(at, part);
    if (!lstatExists(at)) {
      if (!create) throw Object.assign(new Error(`${at} isn’t there.`), { code: 'ENOENT' });
      mkdirSync(at);
    }
    const stat = lstatSync(at);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new LinkError(`${at} is a link or a file, so polyphemus doesn’t use it.`);
  }
  return { path: at, close: () => undefined };
}

/** Runs `use` with the folder `file` is in, held, and the file's own name. */
function inFolderOf<T>(root: string, file: string, create: boolean, use: (folder: string, name: string) => T): T {
  const parts = partsOf(root, file);
  if (!parts || parts.length === 0) throw new LinkError(`${file} isn’t inside ${root}.`);
  const held = holdFolder(root, parts.slice(0, -1), create);
  try {
    return use(held.path, parts.at(-1)!);
  } finally {
    held.close();
  }
}

const write = (fd: number, bytes: Uint8Array) => {
  for (let written = 0; written < bytes.length; ) written += writeSync(fd, bytes, written);
};

/**
 * A file's bytes, only if it really is inside `root`: never through a link, at any step. Undefined
 * when it's missing, isn't a plain file, goes through a link, or is bigger than `max`.
 */
export function readBytesInside(root: string, file: string, max = Infinity): Buffer | undefined {
  try {
    return inFolderOf(root, file, false, (folder, name) => {
      const fd = openSync(`${folder}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > max) return undefined;
        return readFileSync(fd);
      } finally {
        closeSync(fd);
      }
    });
  } catch {
    return undefined;
  }
}

/**
 * A file's text from a folder that's polyphemus's own — its home, which no feature lets an agent write
 * — where a link is the person's to make and is followed. What isn't followed is a pipe or a device:
 * `readFileSync` on a fifo never returns, and reading agents and skills happens when a thread starts,
 * so one would stop polyphemus rather than one request (fourth review, 2026-09-20).
 */
export function readPlainFile(file: string, max = Infinity): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) return undefined;
    return readFileSync(fd, 'utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A text file's contents, only if it really is inside `root` (see readBytesInside). */
export const readInside = (root: string, file: string): string | undefined => readBytesInside(root, file)?.toString('utf8');

/** The names in a folder inside `root`, reached without following links. Empty if it isn't there or goes through one. */
export function listInside(root: string, folder: string): string[] {
  const parts = partsOf(root, folder);
  if (!parts) return [];
  try {
    const held = holdFolder(root, parts, false);
    try {
      return readdirSync(held.path);
    } finally {
      held.close();
    }
  } catch {
    return [];
  }
}

/** Makes a folder inside `root`, and any on the way, refusing if any of them is a link. */
export function folderInside(root: string, folder: string): void {
  const parts = partsOf(root, folder);
  if (!parts) throw new LinkError(`${folder} isn’t inside ${root}.`);
  mkdirSync(root, { recursive: true });
  holdFolder(root, parts, true).close();
}

/**
 * Creates a new file inside `root` with these bytes, making the folders on the way. It must not exist
 * yet — nothing is replaced, and a link standing there counts as existing (EEXIST).
 */
export function createInside(root: string, file: string, bytes: Uint8Array): void {
  mkdirSync(root, { recursive: true });
  inFolderOf(root, file, true, (folder, name) => {
    const fd = openSync(`${folder}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      write(fd, bytes);
    } finally {
      closeSync(fd);
    }
  });
}

/**
 * Replaces a file inside `root` with these bytes: written beside it, then moved over it, in the same
 * held folder — so a link standing where the file was is replaced rather than followed.
 */
export function replaceInside(root: string, file: string, bytes: Uint8Array): void {
  mkdirSync(root, { recursive: true });
  inFolderOf(root, file, true, (folder, name) => {
    const draft = `.${name}.${process.pid}.${Date.now()}`;
    const fd = openSync(`${folder}/${draft}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try {
      write(fd, bytes);
    } finally {
      closeSync(fd);
    }
    renameSync(`${folder}/${draft}`, `${folder}/${name}`);
  });
}

/** Removes a file (or a link — never what it points at) inside `root`. False if it wasn't there. */
export function removeInside(root: string, file: string): boolean {
  try {
    inFolderOf(root, file, false, (folder, name) => unlinkSync(`${folder}/${name}`));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Whether a name inside `root` is taken — by anything, a link included — reached without following links. */
export function existsInside(root: string, file: string): boolean {
  try {
    return inFolderOf(root, file, false, (folder, name) => lstatExists(`${folder}/${name}`));
  } catch {
    return false;
  }
}

/** A plain file's size and time inside `root`, reached without following links; undefined for anything else. */
export function fileInside(root: string, file: string): { bytes: number; at: number } | undefined {
  try {
    return inFolderOf(root, file, false, (folder, name) => {
      const stat = lstatSync(`${folder}/${name}`);
      return stat.isFile() ? { bytes: stat.size, at: stat.mtimeMs } : undefined;
    });
  } catch {
    return undefined;
  }
}

/** Renames something inside `root` to another name in the same folder, reached without following links. */
export function renameInside(root: string, from: string, to: string): void {
  const a = partsOf(root, from);
  const b = partsOf(root, to);
  if (!a?.length || !b?.length || a.slice(0, -1).join(sep) !== b.slice(0, -1).join(sep)) throw new LinkError(`${from} and ${to} aren’t side by side inside ${root}.`);
  const held = holdFolder(root, a.slice(0, -1), false);
  try {
    renameSync(`${held.path}/${a.at(-1)}`, `${held.path}/${b.at(-1)}`);
  } finally {
    held.close();
  }
}

/**
 * Moves something inside `root` out to `to` — polyphemus's own trash, say — reached without following
 * links (a link itself is what moves, never what it points at). Where `to` is on another disk, it's
 * set aside beside itself instead, under a hidden name.
 */
export function moveOutInside(root: string, path: string, to: string): void {
  const parts = partsOf(root, path);
  if (!parts?.length) throw new LinkError(`${path} isn’t inside ${root}.`);
  const held = holdFolder(root, parts.slice(0, -1), false);
  const name = parts.at(-1)!;
  try {
    try {
      renameSync(`${held.path}/${name}`, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      renameSync(`${held.path}/${name}`, `${held.path}/.${name}.removed-${Date.now()}`);
    }
  } finally {
    held.close();
  }
}

/**
 * Removes a folder and everything in it inside `root`, reached without following links: a link
 * standing where the folder was is removed itself, never what it points at, and nothing below is
 * followed out of the folder (a link inside it is unlinked, not walked). False if it wasn't there.
 */
export function removeFolderInside(root: string, folder: string): boolean {
  const parts = partsOf(root, folder);
  if (!parts?.length) throw new LinkError(`${folder} isn’t inside ${root}.`);
  const held = holdFolder(root, parts.slice(0, -1), false);
  const name = parts.at(-1)!;
  try {
    const at = `${held.path}/${name}`;
    if (!lstatExists(at)) return false;
    if (lstatSync(at).isSymbolicLink()) {
      unlinkSync(at);
      return true;
    }
    rmSync(at, { recursive: true, force: true });
    return true;
  } finally {
    held.close();
  }
}

/** What a name inside `root` is — a file, a folder, a link, something else — reached without following links; undefined if nothing's there. */
export function kindInside(root: string, path: string): 'file' | 'folder' | 'link' | 'other' | undefined {
  try {
    return inFolderOf(root, path, false, (folder, name) => {
      const stat = lstatSync(`${folder}/${name}`);
      return stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : stat.isDirectory() ? 'folder' : 'other';
    });
  } catch {
    return undefined;
  }
}
