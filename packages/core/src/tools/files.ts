import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { imageType } from '../images.js';
import { blockedMessage, credentialPathFor } from './guard.js';
import { notGranted, optionalInt, requireString, resolvePath, truncate, type Tool, type ToolContext } from './tool.js';

/** A file's bytes: from the worker when isolated, where only what was granted is there to read. */
async function readBytes(file: string, ctx: ToolContext): Promise<Buffer> {
  if (!ctx.worker) return fsReadFile(file);
  if (!ctx.worker.allows(file)) throw new Error(notGranted(file));
  const r = await ctx.worker.exec(['cat', '--', file], { signal: ctx.signal, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().replace(/^cat: /, '') || `Couldn’t read ${file}`);
  return r.stdout;
}

async function writeText(file: string, content: string, ctx: ToolContext): Promise<void> {
  if (!ctx.worker) {
    await mkdir(dirname(file), { recursive: true });
    await fsWriteFile(file, content);
    return;
  }
  if (!ctx.worker.allows(file, true)) throw new Error(notGranted(file));
  const r = await ctx.worker.exec(['bash', '-c', 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', 'write', file], { stdin: content, signal: ctx.signal, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `Couldn’t write ${file}`);
}

const DEFAULT_LINE_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;

const pathProperty = { type: 'string', description: 'File path, absolute or relative to the working directory' };

export const readFile: Tool = {
  spec: {
    name: 'read_file',
    description:
      'Read a text file. Returns lines prefixed with their line numbers and a tab. ' +
      'Use offset and limit to page through large files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathProperty,
        offset: { type: 'integer', description: '1-based line number to start from (default 1)' },
        limit: { type: 'integer', description: `Maximum number of lines to return (default ${DEFAULT_LINE_LIMIT})` },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  mutates: false,
  describe: (input) => String(input.path ?? ''),
  async run(input, ctx) {
    const file = resolvePath(ctx.cwd, requireString(input, 'path'));
    const blocked = credentialPathFor(file);
    if (blocked) return { content: blockedMessage(blocked), isError: true };
    // A picture is looked at, not read as text: a model that can see gets the image.
    const raw = await readBytes(file, ctx);
    const picture = imageType(raw);
    if (picture) return { content: `${file} is an image (${picture}, ${Math.round(raw.length / 1024)} KB): here it is.`, images: [{ bytes: raw }] };
    const lines = raw.toString('utf8').split('\n');
    const offset = Math.max(1, optionalInt(input.offset) ?? 1);
    const limit = Math.max(1, optionalInt(input.limit) ?? DEFAULT_LINE_LIMIT);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    if (slice.length === 0) {
      return { content: `(no lines at offset ${offset}; the file has ${lines.length} lines)` };
    }
    const body = slice
      .map((line, i) => `${offset + i}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}`)
      .join('\n');
    const remaining = lines.length - (offset - 1 + slice.length);
    const footer = remaining > 0 ? `\n\n(${remaining} more lines; continue with offset ${offset + slice.length})` : '';
    return { content: truncate(body + footer) };
  },
};

export const writeFile: Tool = {
  spec: {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content. Parent directories are created as needed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathProperty,
        content: { type: 'string', description: 'The full file content' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  mutates: true,
  describe: (input) => String(input.path ?? ''),
  async run(input, ctx) {
    const file = resolvePath(ctx.cwd, requireString(input, 'path'));
    const blocked = credentialPathFor(file);
    if (blocked) return { content: blockedMessage(blocked), isError: true };
    const content = requireString(input, 'content', { allowEmpty: true });
    await writeText(file, content, ctx);
    return { content: `Wrote ${Buffer.byteLength(content)} bytes to ${file}` };
  },
};

export const editFile: Tool = {
  spec: {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must match the file exactly (including whitespace) and be unique, ' +
      'unless replace_all is set. Read the file first so you have the exact text.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathProperty,
        old_string: { type: 'string', description: 'The exact text to replace' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  mutates: true,
  describe: (input) => String(input.path ?? ''),
  async run(input, ctx) {
    const file = resolvePath(ctx.cwd, requireString(input, 'path'));
    const blocked = credentialPathFor(file);
    if (blocked) return { content: blockedMessage(blocked), isError: true };
    const oldString = requireString(input, 'old_string');
    const newString = requireString(input, 'new_string', { allowEmpty: true });
    const replaceAll = input.replace_all === true;
    if (oldString === newString) return { content: 'old_string and new_string are identical.', isError: true };

    const text = (await readBytes(file, ctx)).toString('utf8');
    const count = text.split(oldString).length - 1;
    if (count === 0) {
      return { content: `old_string was not found in ${file}. Read the file to get the exact text.`, isError: true };
    }
    if (count > 1 && !replaceAll) {
      return {
        content: `old_string matches ${count} places in ${file}. Include more surrounding context to make it unique, or set replace_all.`,
        isError: true,
      };
    }
    const updated = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
    await writeText(file, updated, ctx);
    const replaced = replaceAll ? count : 1;
    return { content: `Edited ${file} (${replaced} replacement${replaced === 1 ? '' : 's'})` };
  },
};
