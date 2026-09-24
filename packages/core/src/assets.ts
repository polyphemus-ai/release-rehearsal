import { fileURLToPath } from 'node:url';

// Where polyphemus's own files are — the web app, the servers it starts, templates — in either shape it
// runs in. From the repository, each package keeps its own (packages/core/bin/…). Published, the
// build puts one bundle in lib/ and each package's files beside it (core/bin/…, daemon/web/…), with
// the command's own (bin/, package.json) at the top. The build defines POLYPHEMUS_BUNDLED.

declare const POLYPHEMUS_BUNDLED: boolean | undefined;
export const bundled = typeof POLYPHEMUS_BUNDLED !== 'undefined' && POLYPHEMUS_BUNDLED === true;

export type AssetPackage = 'core' | 'daemon' | 'cli';

/** The absolute path of one of polyphemus's own files. `rel` ends in `/` for a folder. */
export function assetPath(pkg: AssetPackage, rel: string): string {
  if (bundled) return fileURLToPath(new URL(pkg === 'cli' ? `../${rel}` : `../${pkg}/${rel}`, import.meta.url));
  return fileURLToPath(new URL(`../../${pkg}/${rel}`, import.meta.url));
}
