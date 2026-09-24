import { copyFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { imagePathArg, pickOutImages } from '../src/attachments.js';

describe('images in the terminal', () => {
  const home = mkdtempSync(join(tmpdir(), 'polyphemus-attach-'));
  const file = join(mkdtempSync(join(tmpdir(), 'polyphemus-shots-')), 'my shot.png');
  copyFileSync(fileURLToPath(new URL('../../daemon/web/icon-192.png', import.meta.url)), file);

  it('attaches image paths pasted or dragged into a message', () => {
    const quoted = pickOutImages(`what is this '${file}' please`, home);
    expect(quoted.text).toBe('what is this please');
    expect(quoted.images).toEqual([expect.objectContaining({ type: 'image', name: 'my shot.png' })]);

    const escaped = pickOutImages(`${file.replaceAll(' ', '\\ ')} ?`, home);
    expect(escaped).toMatchObject({ text: '?', images: [expect.objectContaining({ name: 'my shot.png' })] });
  });

  it('leaves other paths alone', () => {
    for (const text of ['look at /nope/missing.png', 'see logo.png in the repo', 'read /etc/hosts']) {
      expect(pickOutImages(text, home)).toEqual({ text, images: [] });
    }
  });

  it('reads /image paths with quotes, escapes, or ~', () => {
    expect(imagePathArg(` "${file}" `)).toBe(file);
    expect(imagePathArg(file.replaceAll(' ', '\\ '))).toBe(file);
    expect(imagePathArg('~/a.png')).toBe(join(homedir(), 'a.png'));
  });
});
