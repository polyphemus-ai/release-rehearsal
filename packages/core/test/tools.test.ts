import { mkdtemp, readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { bash } from '../src/tools/bash.js';
import { editFile, readFile, writeFile } from '../src/tools/files.js';
import { truncate } from '../src/tools/tool.js';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'polyphemus-tools-'));
});

describe('bash', () => {
  it('returns output and exit status', async () => {
    const ok = await bash.run({ command: 'echo hello' }, { cwd });
    expect(ok).toEqual({ content: 'hello\n[exit code 0]', isError: false });
    const failed = await bash.run({ command: 'echo oops >&2; exit 3' }, { cwd });
    expect(failed).toEqual({ content: 'oops\n[exit code 3]', isError: true });
  });

  it('runs in the working directory', async () => {
    expect((await bash.run({ command: 'pwd' }, { cwd })).content).toContain(cwd);
  });
});

describe('file tools', () => {
  it('writes, reads with line numbers, and pages', async () => {
    await writeFile.run({ path: 'dir/a.txt', content: 'one\ntwo\nthree' }, { cwd });
    expect((await readFile.run({ path: 'dir/a.txt' }, { cwd })).content).toBe('1\tone\n2\ttwo\n3\tthree');
    expect((await readFile.run({ path: 'dir/a.txt', offset: 2, limit: 1 }, { cwd })).content).toBe(
      '2\ttwo\n\n(1 more lines; continue with offset 3)',
    );
  });

  it('reads an image as a picture, not as text', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await fsWriteFile(join(cwd, 'shot.png'), png);
    const result = await readFile.run({ path: 'shot.png' }, { cwd });
    expect(result.content).toMatch(/shot\.png is an image \(image\/png, 0 KB\): here it is\.$/);
    expect(result.images).toEqual([{ bytes: png }]);
  });

  it('edits a unique match and refuses ambiguous or missing ones', async () => {
    const file = join(cwd, 'b.txt');
    await fsWriteFile(file, 'a = 1\nb = 1\n');

    expect(await editFile.run({ path: file, old_string: '= 1', new_string: '= 2' }, { cwd })).toMatchObject({ isError: true });
    expect(await editFile.run({ path: file, old_string: 'zzz', new_string: 'y' }, { cwd })).toMatchObject({ isError: true });

    await editFile.run({ path: file, old_string: 'a = 1', new_string: 'a = $&2' }, { cwd });
    expect(await fsReadFile(file, 'utf8')).toBe('a = $&2\nb = 1\n');

    await editFile.run({ path: file, old_string: '1', new_string: '3', replace_all: true }, { cwd });
    expect(await fsReadFile(file, 'utf8')).toBe('a = $&2\nb = 3\n');
  });

  it('rejects missing parameters', async () => {
    await expect(readFile.run({}, { cwd })).rejects.toThrow('"path"');
  });
});

describe('truncate', () => {
  it('keeps head and tail', () => {
    const text = `${'a'.repeat(50)}${'b'.repeat(50)}`;
    const out = truncate(text, 20);
    expect(out.startsWith('a'.repeat(10))).toBe(true);
    expect(out.endsWith('b'.repeat(10))).toBe(true);
    expect(out).toContain('80 characters truncated');
  });
});
