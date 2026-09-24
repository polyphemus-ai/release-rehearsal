import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createInside, folderInside, readInside, replaceInside } from '../src/contained.js';
import { keepArtifact } from '../src/artifacts.js';
import { writeMemoryNote, memoryNotes } from '../src/memory.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { loadSkills, writeSkill } from '../src/skills.js';
import { directFolder, inboxItems, projectBriefing, resolveInboxItem } from '../src/projects.js';
import { createAgent } from '../src/roster.js';
import { keepIn, placeFile, saveUploadedFile } from '../src/files.js';

// An agent in a worker can make any file it can write a link to one of the user's that it can't
// see. polyphemus, reading or writing on this computer, must never follow one out (independent review,
// 2026-09-19): into a prompt, or into a folder the agent can then read.

let root: string;
let project: string;
let secret: string;
let elsewhere: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'polyphemus-contained-'));
  project = join(root, 'project');
  elsewhere = join(root, 'private');
  mkdirSync(project);
  mkdirSync(elsewhere);
  secret = join(elsewhere, 'id_ed25519');
  writeFileSync(secret, 'PRIVATE KEY MATERIAL');
});

describe('reading and writing where an agent can', () => {
  it('reads a plain file inside, and nothing through a link out', () => {
    writeFileSync(join(project, 'notes.md'), 'fine');
    expect(readInside(project, join(project, 'notes.md'))).toBe('fine');
    symlinkSync(secret, join(project, 'AGENTS.md'));
    expect(readInside(project, join(project, 'AGENTS.md'))).toBeUndefined();
    // A linked folder on the way is refused too, not just a linked file.
    symlinkSync(elsewhere, join(project, 'docs'));
    expect(readInside(project, join(project, 'docs', 'id_ed25519'))).toBeUndefined();
  });

  it('never puts a linked AGENTS.md into a prompt', () => {
    symlinkSync(secret, join(project, 'AGENTS.md'));
    const prompt = buildSystemPrompt({ cwd: project, home: join(root, 'home'), projectRoot: project });
    expect(prompt).not.toContain('PRIVATE KEY MATERIAL');
  });

  it('skips a project skill that links out', () => {
    const skills = join(project, '.polyphemus', 'skills');
    mkdirSync(join(skills, 'steal'), { recursive: true });
    symlinkSync(secret, join(skills, 'steal', 'SKILL.md'));
    const { skills: found, problems } = loadSkills(join(root, 'home'), project);
    expect(found.map((s) => s.name)).not.toContain('steal');
    expect(problems.some((p) => p.message.includes('a link'))).toBe(true);
  });

  it('writes an attachment only inside, never through a linked folder', () => {
    expect(keepIn(project, join(project, 'attachments'), 'a.txt', Buffer.from('hi'))).toBe('a.txt');
    const other = join(root, 'other-project');
    mkdirSync(other);
    symlinkSync(elsewhere, join(other, 'attachments'));
    expect(() => keepIn(other, join(other, 'attachments'), 'dropped.txt', Buffer.from('x'))).toThrow(/link/);
    expect(existsSync(join(elsewhere, 'dropped.txt'))).toBe(false);
    // Nor through a file that's a link: nothing is replaced, and nothing is created out there.
    mkdirSync(join(project, 'inbox'));
    symlinkSync(join(elsewhere, 'new.txt'), join(project, 'inbox', 'new.txt'));
    expect(() => createInside(project, join(project, 'inbox', 'new.txt'), Buffer.from('x'))).toThrow();
    expect(existsSync(join(elsewhere, 'new.txt'))).toBe(false);
  });

  it('keeps memory notes inside the memory folder, and lists none that link out', () => {
    const memory = join(root, 'memory');
    const notes = join(memory, 'projects', 'demo', 'notes');
    mkdirSync(join(memory, 'projects', 'demo'), { recursive: true });
    symlinkSync(elsewhere, notes);
    expect(() => writeMemoryNote(notes, 'plan', 'when planning', 'text', memory)).toThrow(/link/);
    expect(readdirSync(elsewhere)).toEqual(['id_ed25519']);

    const real = join(memory, 'agents', 'coach', 'craft');
    writeMemoryNote(real, 'plan', 'when planning', 'text', memory);
    symlinkSync(secret, join(real, 'stolen.md'));
    expect(memoryNotes(real).map((n) => n.name)).toEqual(['plan']);
  });

  it('refuses a folder path that leaves the root', () => {
    expect(() => folderInside(project, join(root, 'private'))).toThrow(/isn’t inside/);
  });

  // The re-review (2026-09-19): a folder the agent can replace was trusted as the root.
  it('never takes a linked inbox or notes folder as its own: nothing listed, read or removed through it', () => {
    const home = join(root, 'home');
    const memory = (slug: string) => join(home, 'memory', 'projects', slug);
    mkdirSync(join(memory('b'), 'notes'), { recursive: true });
    writeFileSync(join(memory('b'), 'notes', 'pricing.md'), '---\ndescription: B’s private pricing\n---\nsecret numbers');
    mkdirSync(memory('a'), { recursive: true });
    // A's agent swaps its inbox and notes for links to B's notes.
    symlinkSync(join(memory('b'), 'notes'), join(memory('a'), 'inbox'));
    symlinkSync(join(memory('b'), 'notes'), join(memory('a'), 'notes'));
    const a = { slug: 'a', name: 'A', path: project, description: '', status: 'active' } as never;
    expect(inboxItems(home, a)).toEqual([]);
    expect(projectBriefing(home, a)).not.toContain('pricing');
    expect(() => resolveInboxItem(home, a, 'pricing.md', 'discard')).toThrow(/already handled/);
    expect(() => resolveInboxItem(home, a, 'pricing.md', 'accept')).toThrow();
    expect(readdirSync(join(memory('b'), 'notes'))).toEqual(['pricing.md']);
  });

  it('accepts a skill only as a new file inside, never through a link standing where it goes', () => {
    const skills = join(project, '.polyphemus', 'skills');
    // A dangling link where SKILL.md will go, pointing at a file that doesn't exist yet.
    mkdirSync(join(skills, 'plant'), { recursive: true });
    symlinkSync(join(elsewhere, 'planted.md'), join(skills, 'plant', 'SKILL.md'));
    expect(() => writeSkill(skills, 'plant', 'd', 'body', project)).toThrow(/already a skill/);
    // And a linked folder where the skill's folder goes.
    symlinkSync(elsewhere, join(skills, 'folder'));
    expect(() => writeSkill(skills, 'folder', 'd', 'body', project)).toThrow(/link/);
    expect(readdirSync(elsewhere)).toEqual(['id_ed25519']);
    expect(writeSkill(skills, 'fine', 'd', 'body', project)).toBe(join(skills, 'fine', 'SKILL.md'));
  });

  it('replaces a linked file with a real one, leaving what it pointed at alone', () => {
    symlinkSync(secret, join(project, 'AGENTS.md'));
    replaceInside(project, join(project, 'AGENTS.md'), Buffer.from('rules'));
    expect(readInside(project, join(project, 'AGENTS.md'))).toBe('rules');
    expect(readInside(elsewhere, secret)).toBe('PRIVATE KEY MATERIAL');
  });

  it('shows a file from a worker’s folder only if it really is there', () => {
    // show_artifact read through a link to another project's notes (third review, 2026-09-19).
    writeFileSync(join(elsewhere, 'pricing.md'), 'another project’s numbers');
    symlinkSync(join(elsewhere, 'pricing.md'), join(project, 'report.md'));
    const home = join(root, 'home');
    expect(() => keepArtifact(home, join(project, 'report.md'), { sessionId: 's1', seq: 1, within: project })).toThrow(/link/);
    writeFileSync(join(project, 'chart.md'), '# Chart');
    expect(keepArtifact(home, join(project, 'chart.md'), { sessionId: 's1', seq: 1, within: project })).toMatchObject({ name: 'chart.md', bytes: 7 });
  });

  // Third review (2026-09-19).
  it('makes a project agent new, never over a link an agent left where its files go', () => {
    const agents = join(project, '.polyphemus', 'agents');
    mkdirSync(join(agents, 'sam'), { recursive: true });
    writeFileSync(join(elsewhere, 'persona-target'), 'ORIGINAL');
    symlinkSync(join(elsewhere, 'persona-target'), join(agents, 'sam', 'persona.md'));
    expect(() => createAgent(agents, 'sam', {}, project)).toThrow(/pick another name/);
    expect(readInside(elsewhere, join(elsewhere, 'persona-target'))).toBe('ORIGINAL');
  });

  it('puts a file in a thread’s subfolder from the project’s folder, so a swapped subfolder leads nowhere', () => {
    const home = join(root, 'home');
    const { id } = saveUploadedFile(home, Buffer.from('statement'), 'June.pdf');
    mkdirSync(join(project, 'sub'));
    expect(placeFile(home, id, 'June.pdf', join(project, 'sub'), project)).toBe('attachments/June.pdf');
    // The agent swaps the thread's folder for a link out.
    const moved = join(project, 'moved');
    renameSync(join(project, 'sub'), moved);
    symlinkSync(elsewhere, join(project, 'sub'));
    expect(() => placeFile(home, id, 'June.pdf', join(project, 'sub'), project)).toThrow(/link/);
    expect(readdirSync(elsewhere)).toEqual(['id_ed25519']);
  });

  it('keeps the direct threads’ README current without writing through a link', () => {
    const projects = join(root, 'projects');
    const folder = directFolder(projects);
    const readme = join(folder, 'README.md');
    rmSync(readme);
    writeFileSync(join(elsewhere, 'bashrc'), 'mine');
    symlinkSync(join(elsewhere, 'bashrc'), readme);
    directFolder(projects);
    expect(readInside(elsewhere, join(elsewhere, 'bashrc'))).toBe('mine');
    expect(readInside(folder, readme)).toContain('polyphemus');
  });
});
