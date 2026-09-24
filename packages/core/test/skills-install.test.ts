import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSkill } from '../src/skills-catalogue.js';

// A skill from the library is fetched file by file from GitHub. A stand-in GitHub here: the tree,
// and each file's bytes.
function github(files: Record<string, string | number>, opts: { licence?: boolean } = {}) {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({ tree: [...Object.keys(files), 'LICENSE'].map((path) => ({ path, type: 'blob' })) }), { status: 200 });
    }
    const path = decodeURIComponent(url.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, ''));
    if (path === 'LICENSE') return opts.licence === false ? new Response('gone', { status: 404 }) : new Response('MIT License\n\nPermission is hereby granted…', { status: 200 });
    const body = files[path];
    if (body === undefined) return new Response('not found', { status: 404 });
    // A number is a file of that many bytes, sent without saying how big it is.
    return new Response(typeof body === 'number' ? new ReadableStream({ pull: (c) => (c.enqueue(new Uint8Array(1024 * 1024)), (body as number) <= 0 ? c.close() : undefined) }) : body, { status: 200 });
  });
}

const skill = { id: 'anthropic/deploy', name: 'deploy', description: 'shipping', source: 'anthropic', sourceName: 'Anthropic', repo: 'anthropics/skills', path: 'skills/deploy', license: 'MIT', licenseFile: 'LICENSE' };

afterEach(() => vi.unstubAllGlobals());

describe('installing a skill from the library', () => {
  it('installs it with its licence, and leaves out a file too big to be part of how it works', async () => {
    github({ 'skills/deploy/SKILL.md': '---\ndescription: shipping\n---\nSteps.', 'skills/deploy/huge.bin': 1 });
    const dir = await mkdtemp(join(tmpdir(), 'polyphemus-skill-'));
    const dest = await installSkill(skill, dir, { by: 'person:alex' });
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('Steps.');
    expect(readFileSync(join(dest, 'LICENSE.txt'), 'utf8')).toContain('MIT');
    expect(existsSync(join(dest, 'huge.bin'))).toBe(false);
  });

  it('doesn’t install one whose licence it can’t fetch', async () => {
    github({ 'skills/deploy/SKILL.md': '---\ndescription: shipping\n---\nSteps.' }, { licence: false });
    const dir = await mkdtemp(join(tmpdir(), 'polyphemus-skill-'));
    await expect(installSkill(skill, dir, { by: 'person:alex' })).rejects.toThrow(/licence couldn’t be fetched/);
    expect(existsSync(join(dir, 'deploy'))).toBe(false);
  });

  it('installs into a project from the project’s folder, never through a link standing for its skills folder', async () => {
    // Third review (2026-09-19): the skills folder is the project's agents' to swap.
    github({ 'skills/deploy/SKILL.md': '---\ndescription: shipping\n---\nSteps.' });
    const base = await mkdtemp(join(tmpdir(), 'polyphemus-skill-'));
    const project = join(base, 'project');
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(join(project, '.polyphemus'), { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(project, '.polyphemus', 'skills'));
    await expect(installSkill(skill, join(project, '.polyphemus', 'skills'), { by: 'person:alex', root: project })).rejects.toThrow(/link/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('replaces a library skill by moving the old one aside', async () => {
    github({ 'skills/deploy/SKILL.md': '---\ndescription: shipping\n---\nSteps.' });
    const dir = await mkdtemp(join(tmpdir(), 'polyphemus-skill-'));
    await installSkill(skill, dir, { by: 'person:alex' });
    github({ 'skills/deploy/SKILL.md': '---\ndescription: shipping\n---\nNewer steps.' });
    const aside = join(dir, '..', `aside-${Date.now()}`);
    await installSkill(skill, dir, { by: 'person:alex', replace: true, aside });
    expect(readFileSync(join(dir, 'deploy', 'SKILL.md'), 'utf8')).toContain('Newer steps.');
    expect(readFileSync(join(aside, 'SKILL.md'), 'utf8')).toContain('Steps.');
  });
});
