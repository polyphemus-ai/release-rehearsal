import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { safeFileName, saveAttachment } from '../src/connections/attachments.js';
import { MAX_RESOURCE_BYTES } from '../src/connections/mcp-client.js';

// A file a connection hands back is saved in <cwd>/attachments, under a name polyphemus cleans, never
// outside the project and never over anything already there — whatever the server said it's called.
describe('files a connection hands back', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), 'polyphemus-attachments-'));
    dirs.push(dir);
    const root = join(dir, 'shop');
    mkdirSync(root);
    return { dir, root };
  };
  const file = (name: string, text = 'PK\u0003\u0004 a zip') => ({ name, mimeType: 'application/zip', data: Buffer.from(text, 'latin1') });

  it('keep only a plain name: no folders, no way up, no control characters, no hidden files', () => {
    expect(safeFileName('Health Connect.zip')).toBe('Health Connect.zip');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..\\..\\Windows\\evil.zip')).toBe('evil.zip');
    expect(safeFileName('/etc/cron.d/job')).toBe('job');
    expect(safeFileName('..')).toBe('download');
    expect(safeFileName('../')).toBe('download');
    expect(safeFileName('.bashrc')).toBe('bashrc');
    expect(safeFileName('evil\u0000\n\u001b[31m.zip')).toBe('evil[31m.zip');
    expect(safeFileName('a<b>c:d|e?f*.zip')).toBe('a_b_c_d_e_f_.zip');
    expect(safeFileName('x'.repeat(400) + '.zip')).toMatch(/^x+\.zip$/);
    expect(safeFileName('x'.repeat(400) + '.zip').length).toBe(180);
  });

  it('saves under the thread’s folder, byte for byte, and never over what’s there', () => {
    const { root } = project();
    const first = saveAttachment(file('Health Connect.zip', 'first'), { cwd: root, root });
    const second = saveAttachment(file('Health Connect.zip', 'second'), { cwd: root, root });
    expect(first).toEqual({ path: join(root, 'attachments', 'Health Connect.zip') });
    expect(second).toEqual({ path: join(root, 'attachments', 'Health Connect (2).zip') });
    expect(readFileSync(join(root, 'attachments', 'Health Connect.zip'), 'latin1')).toBe('first');
    expect(readFileSync(join(root, 'attachments', 'Health Connect (2).zip'), 'latin1')).toBe('second');
  });

  it('names the file by the folder the thread knows, when that folder is reached through a link', () => {
    // macOS: temporary folders are under /var, a link to /private/var.
    const { dir, root } = project();
    const linked = join(dir, 'linked');
    symlinkSync(root, linked);
    expect(saveAttachment(file('a.zip', 'x'), { cwd: linked, root: linked })).toEqual({ path: join(linked, 'attachments', 'a.zip') });
    expect(readFileSync(join(root, 'attachments', 'a.zip'), 'latin1')).toBe('x');
  });

  it('can’t be sent anywhere else by its name', () => {
    const { dir, root } = project();
    for (const name of ['../../outside.zip', '/tmp/outside.zip', '..\\outside.zip', '..']) {
      const saved = saveAttachment(file(name), { cwd: root, root });
      expect('path' in saved && saved.path.startsWith(join(root, 'attachments') + '/')).toBe(true);
    }
    expect(readdirSync(dir)).toEqual(['shop']);
  });

  it('won’t follow a link: not an attachments folder that is one, nor one left where the file would go', () => {
    const { dir, root } = project();
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, 'attachments'));
    expect(saveAttachment(file('a.zip'), { cwd: root, root })).toEqual({ why: 'attachments in the thread’s folder isn’t a plain folder' });
    expect(readdirSync(elsewhere)).toEqual([]);

    rmSync(join(root, 'attachments'));
    mkdirSync(join(root, 'attachments'));
    const target = join(elsewhere, 'victim.txt');
    writeFileSync(target, 'untouched');
    symlinkSync(target, join(root, 'attachments', 'a.zip'));
    expect(saveAttachment(file('a.zip'), { cwd: root, root })).toEqual({ path: join(root, 'attachments', 'a (2).zip') });
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });

  it('refuses a folder outside the project, a thread with no folder, and a file over the limit', () => {
    const { dir, root } = project();
    expect(saveAttachment(file('a.zip'), { cwd: dir, root })).toEqual({ why: 'the thread’s folder isn’t inside its project' });
    expect(saveAttachment(file('a.zip'), {})).toEqual({ why: 'this thread has no folder to save it in' });
    const big = { name: 'big.zip', mimeType: 'application/zip', data: Buffer.alloc(MAX_RESOURCE_BYTES + 1) };
    expect(saveAttachment(big, { cwd: root, root })).toMatchObject({ why: expect.stringContaining('MB') });
  });
});
