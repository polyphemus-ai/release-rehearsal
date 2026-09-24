import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PolyphemusError, type ImageBlock } from './types.js';

// Images you attach to a message. Each is saved once in ~/.polyphemus/uploads, named by its content,
// and messages point to the file, so the session database never fills up with pictures.

/** The largest image any provider takes (Anthropic's per-image limit). The app shrinks photos before sending. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/** An uploaded image's file name: its hash and type, nothing a caller could steer elsewhere. */
export const UPLOAD_NAME = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;

export const uploadsDir = (home: string) => join(home, 'uploads');

/** What an image really is, from its first bytes (never from its name or what the sender claims). */
export function imageType(bytes: Uint8Array): string | undefined {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return undefined;
}

/** Saves an image (the same picture twice is stored once) and returns the block a message holds. */
export function saveImage(home: string, bytes: Uint8Array, name?: string): ImageBlock {
  const mediaType = imageType(bytes);
  if (!mediaType) throw new PolyphemusError('That isn’t an image polyphemus can send: use PNG, JPEG, GIF, or WebP.', 'USAGE');
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new PolyphemusError(`That image is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; models take up to 5 MB.`, 'USAGE', 'Shrink it first (a screenshot or a smaller export works).');
  }
  const dir = uploadsDir(home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${EXTENSIONS[mediaType]}`);
  if (!existsSync(file)) writeFileSync(file, bytes, { mode: 0o600 });
  return { type: 'image', mediaType, path: file, ...(name && { name: basename(name) }) };
}

/** An image file on this computer (a path typed or dragged into the terminal), saved like an upload. */
export function attachImageFile(home: string, path: string): ImageBlock {
  if (!existsSync(path) || !statSync(path).isFile()) throw new PolyphemusError(`No such image: ${path}`, 'NOT_FOUND');
  return saveImage(home, readFileSync(path), path);
}

/** An uploaded image by its id (its file name in uploads), as a message block. `name` is what it was called on your device. */
export function uploadedImage(home: string, id: string, name?: string): ImageBlock {
  if (!UPLOAD_NAME.test(id)) throw new PolyphemusError('That isn’t an uploaded image.', 'USAGE');
  const file = join(uploadsDir(home), id);
  if (!existsSync(file)) throw new PolyphemusError('That image isn’t here anymore: attach it again.', 'NOT_FOUND');
  return saveImage(home, readFileSync(file), name);
}

/** The image's bytes as base64, or undefined if the file has gone (the model is told instead). */
export function imageBase64(block: ImageBlock): string | undefined {
  try {
    return readFileSync(block.path).toString('base64');
  } catch {
    return undefined;
  }
}

export const imageLabel = (block: ImageBlock) => `[image${block.name ? `: ${block.name}` : ''}]`;
