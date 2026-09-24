import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addProject,
  createProject,
  DEFAULT_CONFIG,
  inboxItems,
  memoryDir,
  needsOrientation,
  orientationPrompt,
  parseConfig,
  projectBriefing,
  resolveInboxItem,
  SessionStore,
  slugify,
} from '../src/index.js';

let dir: string;
let home: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'polyphemus-projects-'));
  home = join(dir, 'home');
  store = new SessionStore(':memory:');
});

describe('projects', () => {
  it('makes slugs from names', () => {
    expect(slugify('Game Night!')).toBe('game-night');
    expect(slugify('  Café -- Menu  ')).toBe('cafe-menu');
    expect(slugify('!!!')).toBe('');
  });

  it('starts a new project with orientation files and private memory, and no repo nobody asked for', async () => {
    const { project, created } = await createProject(store, home, join(dir, 'projects'), { name: 'Side Quest', about: 'A tiny game.' });
    const path = join(dir, 'projects', 'side-quest');
    expect(project).toMatchObject({ slug: 'side-quest', name: 'Side Quest', path, status: 'active', description: 'A tiny game.' });
    // A project is a folder of work, not always code: git is offered, never assumed.
    expect(existsSync(join(path, '.git'))).toBe(false);
    expect(readFileSync(join(path, 'AGENTS.md'), 'utf8')).toContain('# Side Quest\n\nA tiny game.');
    expect(existsSync(join(path, 'CLAUDE.md'))).toBe(false); // Claude Code outside polyphemus stays unaffected
    expect(readFileSync(join(path, '.polyphemus', 'project.toml'), 'utf8')).toContain('name = "Side Quest"');
    expect(existsSync(join(home, 'memory', '.git'))).toBe(true);
    expect(created).toContain(join(home, 'memory', 'projects', 'side-quest', 'handoff.md'));

    expect(store.projectFor(join(path, 'src', 'game'))?.slug).toBe('side-quest');
    expect(store.projectFor(join(dir, 'projects', 'side-quest-2'))).toBeUndefined();
    await expect(createProject(store, home, join(dir, 'projects'), { name: 'side quest' })).rejects.toThrow('already a project');
  });

  it('makes a repo when asked, and writes the code-shaped rules into it', async () => {
    const { project } = await createProject(store, home, join(dir, 'projects'), { name: 'Side Quest', git: true });
    expect(existsSync(join(project.path, '.git'))).toBe(true);
    expect(readFileSync(join(project.path, 'AGENTS.md'), 'utf8')).toContain('## Commands');
  });

  it('asks a folder of documents how the work is done, not which commands to run', async () => {
    const { project } = await createProject(store, home, join(dir, 'projects'), { name: 'Acme Finance', about: 'Month-end close.' });
    const rules = readFileSync(join(project.path, 'AGENTS.md'), 'utf8');
    expect(rules).toContain('## How the work is done');
    expect(rules).not.toContain('## Commands');
    // Empty, there's nothing to read: no orientation offered yet.
    expect(needsOrientation(project)).toBe(false);
    // With work in it and the rules still the untouched template, it's offered one.
    writeFileSync(join(project.path, 'close-checklist.md'), 'Reconcile the bank feeds.\n');
    expect(needsOrientation(project)).toBe(true);
    expect(orientationPrompt(home, project)).toContain('Explore the folder');
    expect(orientationPrompt(home, project)).not.toContain('package manifests');
  });

  it('reads an added repo as code, whatever it was created as', () => {
    const folder = join(dir, 'code');
    mkdirSync(folder);
    writeFileSync(join(folder, 'package.json'), '{}\n');
    const { project } = addProject(store, home, folder, { name: 'Real Code' });
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toContain('## Commands');
    expect(orientationPrompt(home, project)).toContain('Explore the repository');
  });

  it('adds an existing folder without touching what’s there', () => {
    const folder = join(dir, 'existing');
    mkdirSync(folder);
    writeFileSync(join(folder, 'AGENTS.md'), 'my rules\n');
    const { project, created } = addProject(store, home, folder, { name: 'Game Night' });
    expect(project.slug).toBe('game-night');
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toBe('my rules\n');
    expect(created).not.toContain(join(folder, 'AGENTS.md'));
    expect(created).toContain(join(folder, '.polyphemus', 'project.toml'));
    expect(() => addProject(store, home, folder, { name: 'Again' })).toThrow('already the project');
  });

  it('clones a repo as a new project', async () => {
    const source = join(dir, 'source');
    execFileSync('git', ['init', '--quiet', source]);
    execFileSync('git', ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'init']);
    const { project } = await createProject(store, home, join(dir, 'projects'), { name: 'Cloned', from: source });
    expect(existsSync(join(project.path, '.git'))).toBe(true);
    await expect(createProject(store, home, join(dir, 'projects'), { name: 'Bad', from: 'not a url' })).rejects.toThrow('git URL');
  });

  it('parks projects out of the active list', async () => {
    await createProject(store, home, join(dir, 'projects'), { name: 'Old Thing' });
    expect(store.setProjectStatus('old-thing', 'parked')).toBe(true);
    expect(store.projects(['active'])).toEqual([]);
    expect(store.setProjectStatus('nope', 'parked')).toBe(false);
  });

  it('briefs sessions with the handoff and notes index, and knows when a project needs orienting', async () => {
    const { project } = await createProject(store, home, join(dir, 'projects'), { name: 'Side Quest', about: 'A tiny game.' });
    writeFileSync(join(project.path, 'main.js'), 'start();\n');
    expect(needsOrientation(project)).toBe(true);
    const memory = memoryDir(home, 'side-quest');
    writeFileSync(join(memory, 'handoff.md'), 'Shipped level 1. Next: sound.\n');
    writeFileSync(join(memory, 'notes', 'stack.md'), '---\ndescription: Which engine and versions the game uses\n---\n\nPhaser 4.\n');
    writeFileSync(join(memory, 'notes', 'plain.md'), '# Deploys go through Fly\n\nDetails.\n');

    const briefing = projectBriefing(home, project);
    expect(briefing).toContain('You\'re working in the project "Side Quest": A tiny game.');
    expect(briefing).toContain('Shipped level 1. Next: sound.');
    expect(briefing).toContain(`${join(memory, 'notes', 'stack.md')}: Which engine and versions the game uses`);
    expect(briefing).toContain(`${join(memory, 'notes', 'plain.md')}: Deploys go through Fly`);
    expect(orientationPrompt(home, project)).toContain(join(memory, 'inbox', 'AGENTS.md'));

    writeFileSync(join(project.path, 'AGENTS.md'), '# Side Quest\n\nnpm test runs everything.\n');
    expect(needsOrientation(project)).toBe(false);
  });

  it('keeps or discards what agents propose, and never takes a path for a name', async () => {
    const { project } = await createProject(store, home, join(dir, 'projects'), { name: 'Side Quest' });
    const inbox = join(memoryDir(home, 'side-quest'), 'inbox');
    writeFileSync(join(inbox, 'AGENTS.md'), '# Side Quest\n\nReal rules.\n');
    writeFileSync(join(inbox, 'stack.md'), '---\ndescription: The stack\n---\n');
    writeFileSync(join(inbox, 'wrong.md'), 'nope');
    expect(inboxItems(home, project).map((i) => [i.name, i.kind])).toEqual([
      ['AGENTS.md', 'rules'],
      ['stack.md', 'note'],
      ['wrong.md', 'note'],
    ]);

    expect(resolveInboxItem(home, project, 'AGENTS.md', 'accept')).toBe(join(project.path, 'AGENTS.md'));
    expect(readFileSync(join(project.path, 'AGENTS.md'), 'utf8')).toContain('Real rules.');
    expect(resolveInboxItem(home, project, 'stack.md', 'accept')).toBe(join(memoryDir(home, 'side-quest'), 'notes', 'stack.md'));
    expect(resolveInboxItem(home, project, 'wrong.md', 'discard')).toBeUndefined();
    expect(inboxItems(home, project)).toEqual([]);
    expect(projectBriefing(home, project)).toContain('stack.md: The stack');

    expect(() => resolveInboxItem(home, project, '../handoff.md', 'discard')).toThrow("isn't an inbox item");
    expect(() => resolveInboxItem(home, project, 'stack.md', 'accept')).toThrow('already handled');
  });

  it('reads projects_root from config, defaulting to ~/projects', () => {
    expect(parseConfig(DEFAULT_CONFIG).projectsRoot).toBe('~/projects');
    expect(parseConfig(`projects_root = "/srv/code"\n${DEFAULT_CONFIG}`).projectsRoot).toBe('/srv/code');
    expect(() => parseConfig(`projects_root = 5\n${DEFAULT_CONFIG}`)).toThrow('projects_root');
  });
});
