#!/usr/bin/env node
// A release's notes, from every workspace package's changelog: `node scripts/release-notes.mjs 0.2.0`.
//
// The three packages share one version, but changesets writes each change only into the changelog of
// the package it names, and fills the others with "Updated dependencies" lines. Notes taken from the
// CLI's changelog alone were 112 lines of those out of 134, and missed most real changes — found in a
// dry run of the first release (2026-09-23). So: every package's section for this version, real
// entries only, each once, without the commit hash, grouped as changesets groups them.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PACKAGES = ['cli', 'core', 'daemon'];
const KINDS = ['Major Changes', 'Minor Changes', 'Patch Changes'];

/** The entries of one changelog's section for `version`, by kind: each a paragraph, hash removed. */
export function entries(changelog, version) {
  const found = Object.fromEntries(KINDS.map((k) => [k, []]));
  let inVersion = false;
  let kind;
  let current;
  const finish = () => {
    if (current && kind && !/^Updated dependencies\b/.test(current)) found[kind]?.push(current.trim());
    current = undefined;
  };
  for (const line of changelog.split('\n')) {
    if (line.startsWith('## ')) {
      finish();
      if (inVersion) break;
      inVersion = line.slice(3).trim() === version;
      continue;
    }
    if (!inVersion) continue;
    if (line.startsWith('### ')) {
      finish();
      kind = line.slice(4).trim();
      continue;
    }
    if (line.startsWith('- ')) {
      finish();
      current = line.slice(2).replace(/^[0-9a-f]{7,40}: /, '');
    } else if (current !== undefined && line.startsWith('  ') && !/^\s+- @polyphemus\//.test(line)) {
      current += `\n${line.trim()}`;
    } else if (current !== undefined && line.trim() === '') {
      current += '\n';
    }
  }
  finish();
  return found;
}

/** Every package's entries for `version`, each once, as markdown. */
export function releaseNotes(changelogs, version) {
  const seen = new Set();
  const sections = [];
  for (const kind of KINDS) {
    const items = [];
    for (const changelog of changelogs) {
      for (const entry of entries(changelog, version)[kind]) {
        const key = entry.replace(/\s+/g, ' ');
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(`- ${entry.replace(/\n\n+/g, '\n\n').replace(/\n(?!\n)/g, '\n  ')}`);
      }
    }
    if (items.length) sections.push(`### ${kind}\n\n${items.join('\n')}`);
  }
  return sections.join('\n\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: node scripts/release-notes.mjs <version>');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const changelogs = PACKAGES.map((p) => `${root}packages/${p}/CHANGELOG.md`).filter(existsSync).map((f) => readFileSync(f, 'utf8'));
  process.stdout.write(`${releaseNotes(changelogs, version)}\n`);
}
