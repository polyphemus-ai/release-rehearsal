#!/usr/bin/env node
// The logos of the services in the connections catalogue, for the app: taken from Simple Icons
// (simpleicons.org, CC0 — the marks themselves are their owners', used only to say which service is
// which) into one small file the app loads, so the whole collection isn't shipped. A service it
// doesn't have keeps a letter on its brand colour. Run it after adding services to the catalogue:
//
//   node scripts/brand-icons.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';

const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const { tsImport } = await import(require.resolve('tsx/esm/api'));
const { CONNECTION_CATALOGUE } = await tsImport('../packages/core/src/connections/catalogue.ts', import.meta.url);
const icons = await import('simple-icons');
const bySlug = new Map(Object.values(icons).filter((i) => i && typeof i === 'object' && 'slug' in i).map((i) => [i.slug, i]));
// Where Simple Icons calls a service something else.
const ALSO = { 'cal-com': 'caldotcom', 'google-drive': 'googledrive', x: 'x' };
const out = {};
for (const entry of CONNECTION_CATALOGUE) {
  const slugs = [ALSO[entry.id], entry.id.replace(/-/g, ''), entry.name.toLowerCase().replace(/[^a-z0-9]/g, ''), entry.id.split('-')[0]].filter(Boolean);
  const icon = slugs.map((s) => bySlug.get(s)).find(Boolean);
  if (icon) out[entry.id] = { path: icon.path, hex: `#${icon.hex}`, title: icon.title };
}
const file = new URL('../packages/daemon/web/brand-icons.json', import.meta.url);
const before = (() => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
})();
const text = `${JSON.stringify(out)}\n`;
if (text !== before) writeFileSync(file, text);
console.log(`${Object.keys(out).length} of ${CONNECTION_CATALOGUE.length} services have a logo.`);
