import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { attachImageFile, expandHome, type ImageBlock } from '@polyphemus/core';

// Images in the terminal: dragging a file into most terminals pastes its path (quoted, or with
// escaped spaces), so an image path typed in a message becomes an attachment.

const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;
const TOKEN = /'([^']+)'|"([^"]+)"|((?:\\ |\S)+)/g;

/** Takes the image files named in a message (full or ~ paths only) out of its text, and attaches them. */
export function pickOutImages(text: string, home: string): { text: string; images: ImageBlock[] } {
  const images: ImageBlock[] = [];
  const rest = text.replace(TOKEN, (whole: string, single?: string, double?: string, bare?: string) => {
    const path = expandHome(single ?? double ?? (bare ?? '').replace(/\\ /g, ' '));
    if (!IMAGE_FILE.test(path) || !isAbsolute(path) || !existsSync(path)) return whole;
    images.push(attachImageFile(home, path));
    return '';
  });
  return { text: images.length > 0 ? rest.replace(/[ \t]{2,}/g, ' ').trim() : text, images };
}

/** A path given to /image: quotes and escaped spaces are fine, and ~ is your home folder. */
export function imagePathArg(arg: string): string {
  const unquoted = /^(['"])(.*)\1$/.exec(arg.trim())?.[2] ?? arg.trim().replace(/\\ /g, ' ');
  return expandHome(unquoted);
}
