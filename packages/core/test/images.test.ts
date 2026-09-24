import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { imageType, renderTranscript, saveImage, uploadedImage, type Message } from '../src/index.js';
import { toAnthropicMessages } from '../src/providers/anthropic.js';
import { toResponsesInput } from '../src/providers/openai-responses.js';

const PNG = readFileSync(fileURLToPath(new URL('../../daemon/web/icon-192.png', import.meta.url)));

describe('attached images', () => {
  it('are saved once, by content, and only if they really are images', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-images-'));
    const first = saveImage(home, PNG, '/somewhere/logo.png');
    expect(first).toMatchObject({ type: 'image', mediaType: 'image/png', name: 'logo.png' });
    expect(saveImage(home, PNG).path).toBe(first.path);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);
    expect(imageType(Buffer.from('not an image'))).toBeUndefined();
    expect(() => saveImage(home, Buffer.from('<svg/>'))).toThrow('PNG, JPEG, GIF, or WebP');
    expect(() => saveImage(home, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]))).toThrow('up to 5 MB');

    // Uploads are named by the server; nothing else resolves.
    expect(uploadedImage(home, first.path.split('/').at(-1)!).path).toBe(first.path);
    expect(() => uploadedImage(home, '../credentials.json')).toThrow('isn’t an uploaded image');
  });

  it('reach each kind of model', () => {
    const home = mkdtempSync(join(tmpdir(), 'polyphemus-images-'));
    const image = saveImage(home, PNG, 'logo.png');
    const message: Message = { role: 'user', content: [{ type: 'text', text: 'What is this?' }, image] };

    const anthropic = toAnthropicMessages([message], 'anthropic', 'claude-opus-5');
    expect(anthropic[0]!.content).toContainEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });

    const openai = toResponsesInput([message], 'openai', 'gpt-5');
    expect(openai).toContainEqual({ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${PNG.toString('base64')}`, detail: 'auto' }] });

    // An agent CLI joining later is pointed at the saved file.
    expect(renderTranscript([message])).toContain(`[attached image logo.png, saved at ${image.path}]`);

    // A file that has gone is mentioned, not sent broken.
    const gone = { ...image, path: join(home, 'missing.png') };
    expect(toAnthropicMessages([{ role: 'user', content: [gone] }], 'anthropic', 'x')[0]!.content).toEqual([
      { type: 'text', text: '[an attached image that is no longer available]' },
    ]);
  });
});
