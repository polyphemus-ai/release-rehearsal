import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs';
import { basename, extname, join, relative, isAbsolute } from 'node:path';
import { MAX_RESOURCE_BYTES, type McpFile } from './mcp-client.js';

// Files a connection hands back (download_file on Google Drive), saved where the calling thread works
// so its agent can open them with its own file tools. The server that sent the bytes never picks the
// path: it suggests a name, which is cleaned, and the file goes in <cwd>/attachments, checked to stay
// under the folder the agent can't replace, never over anything already there.

export const ATTACHMENTS = 'attachments';

/**
 * A name safe to create in one folder: the last part of whatever was sent (no folders, no `..`), with
 * control characters and leading dots gone, and short enough for any filesystem.
 */
export function safeFileName(name: string): string {
  const last = String(name).split(/[\\/]/).pop() ?? '';
  let clean = last
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim();
  if (!clean) clean = 'download';
  if (clean.length > 180) {
    const ext = extname(clean).slice(0, 20);
    clean = `${clean.slice(0, 180 - ext.length)}${ext}`;
  }
  return clean;
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Saves one file in `<cwd>/attachments`: its path, or why it wasn't saved. `root` is the folder the
 * agent can't replace (the project's), and nothing is written outside it — not through a link, and not
 * through a name.
 */
export function saveAttachment(file: McpFile, where: { cwd?: string; root?: string }): { path: string } | { why: string } {
  if (!where.cwd) return { why: 'this thread has no folder to save it in' };
  if (file.data.length > MAX_RESOURCE_BYTES) return { why: `it’s more than ${MAX_RESOURCE_BYTES / (1024 * 1024)} MB` };
  let root: string;
  let cwd: string;
  try {
    root = realpathSync(where.root ?? where.cwd);
    cwd = realpathSync(where.cwd);
  } catch {
    return { why: 'the thread’s folder isn’t there' };
  }
  if (!inside(cwd, root)) return { why: 'the thread’s folder isn’t inside its project' };
  const dir = join(cwd, ATTACHMENTS);
  if (existsSync(dir) || lstatExists(dir)) {
    // A link here could point anywhere: the folder has to be a real one, inside the project.
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) return { why: `${ATTACHMENTS} in the thread’s folder isn’t a plain folder` };
  } else mkdirSync(dir);
  if (!inside(realpathSync(dir), root)) return { why: `${ATTACHMENTS} isn’t inside the project` };
  const name = safeFileName(file.name);
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; n < 1000; n++) {
    const path = join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    let fd: number;
    try {
      // Created, never opened: an existing file — or a link someone left with this name — is skipped.
      fd = openSync(path, 'wx', 0o644);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return { why: (err as Error).message };
    }
    try {
      writeSync(fd, file.data);
    } finally {
      closeSync(fd);
    }
    // Checked and written by its real path, but named by the folder the thread knows: on macOS the
    // temporary folders are behind a link (/var → /private/var), and the agent should recognise it.
    return { path: join(where.cwd, ATTACHMENTS, basename(path)) };
  }
  return { why: `there are already 999 files called ${name} in ${ATTACHMENTS}` };
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
