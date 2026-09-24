import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MARK_COLORS, MARK_SHAPES } from '@polyphemus/core';

// The app is plain JavaScript with no build step, so it can't import from core — it keeps its own
// copy of the shape and colour names and maps them to paths and hex. That copy is allowed to
// exist; it is not allowed to drift, because an agent whose colour the app doesn't know would
// quietly come out grey.
const app = readFileSync(join(fileURLToPath(new URL('../web/app.js', import.meta.url))), 'utf8');
const listIn = (name: string): string[] => {
  const match = new RegExp(String.raw`^const ${name} = \[([^\]]*)\];`, 'm').exec(app);
  if (!match) throw new Error(`${name} isn't declared in app.js any more.`);
  return match[1]!.split(',').map((item) => item.trim().replace(/^'|'$/g, '')).filter(Boolean);
};

describe('marks in the app', () => {
  it('knows exactly the shapes and colours core does', () => {
    expect(listIn('MARK_SHAPES')).toEqual([...MARK_SHAPES]);
    expect(listIn('MARK_COLORS')).toEqual([...MARK_COLORS]);
  });

  it('can draw every shape and paint every colour', () => {
    for (const shape of MARK_SHAPES) expect(app).toMatch(new RegExp(`^  ${shape}: '<`, 'm'));
    for (const color of MARK_COLORS) expect(app).toMatch(new RegExp(`^  ${color}: '#`, 'm'));
  });
});
