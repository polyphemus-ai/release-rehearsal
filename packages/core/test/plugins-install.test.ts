import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { installedPlugins, installPlugin, planInstall, removePlugin } from '../src/plugins/install.js';
import { readPlugin } from '../src/plugins/read.js';
import { Polyphemus } from '../src/polyphemus.js';
import { createProject } from '../src/projects.js';
import { findAgent } from '../src/roster.js';

// Installing a plugin (docs/design/plugins.md): each part where it belongs, keys in the vault and
// nowhere else, nothing granted, and removing takes back exactly what it added.
const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-contacts.mjs', import.meta.url));

describe('installing a plugin', () => {
  let home: string;
  let polyphemus: Polyphemus;
  const dirs: string[] = [];
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'polyphemus-plugins-'));
    writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\n${DEFAULT_CONFIG}`);
    polyphemus = await Polyphemus.open(home);
  });
  afterEach(() => {
    polyphemus.close();
    for (const d of [home, ...dirs.splice(0)]) rmSync(d, { recursive: true, force: true });
  });

  const plugin = () => {
    const root = mkdtempSync(join(tmpdir(), 'polyphemus-plugin-src-'));
    dirs.push(root);
    const files: Record<string, string> = {
      '.cursor-plugin/plugin.json': JSON.stringify({
        name: 'shop-kit',
        displayName: 'Shop Kit',
        version: '2.0.0',
        description: 'Everything for the shop.',
        license: 'MIT',
        variables: { type: 'object', properties: { SHOP_TOKEN: { type: 'string', description: 'Your shop token', secret: true } }, required: ['SHOP_TOKEN'] },
        mcpServers: {
          contacts: { command: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'], env: { CONTACTS_TOKEN: '${SHOP_TOKEN}' } },
          leaky: { command: process.execPath, args: ['server.mjs', '--token', '${SHOP_TOKEN}'] },
          remote: { url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer ${SHOP_TOKEN}' } },
        },
        hooks: './hooks.json',
      }),
      'skills/stock-check/SKILL.md': '---\nname: stock-check\ndescription: Check stock levels.\n---\nCount it.',
      'skills/notes/SKILL.md': '---\nname: notes\ndescription: Take notes.\n---\nWrite it down.',
      'agents/stocker.md': '---\nname: stocker\ndescription: Keeps the shelves full.\nmodel: grok-9000\nreadonly: true\n---\nCheck the shelves every morning.',
      'rules/prices.mdc': '---\ndescription: Prices include tax.\nalwaysApply: true\n---\nAlways show prices with tax.',
      'server.mjs': readFileSync(FIXTURE, 'utf8'),
      'hooks.json': '{}',
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return readPlugin(root);
  };
  const origin = { id: 'test/shop-kit', url: 'https://github.com/acme/shop-kit.git', path: '', commit: 'a'.repeat(40) };

  it('plans first, and says what won’t be used and why', async () => {
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Shop' });
    const plan = await planInstall(polyphemus, plugin(), { kind: 'project', slug: project.slug });
    expect(plan.skills.map((s) => [s.name, s.action])).toEqual([['notes', 'add'], ['stock-check', 'add']]);
    expect(plan.agents).toEqual([{ name: 'stocker', action: 'add', note: 'asks for grok-9000, which isn’t here: it follows your default model; meant to only read: Polyphemus asks before anything it would change, as for every agent' }]);
    expect(plan.rules).toEqual([{ name: 'prices', action: 'add' }]);
    // A key on a command line is visible to anything on this computer that lists processes: not placed there.
    expect(plan.servers.map((s) => [s.name, s.action, s.runsCode, s.why])).toEqual([
      ['contacts', 'add', true, undefined],
      ['leaky', 'skip', true, 'it wants SHOP_TOKEN in its command line, where polyphemus won’t put a key'],
      ['remote', 'add', false, undefined],
    ]);
    expect(plan.settings).toEqual([{ name: 'SHOP_TOKEN', description: 'Your shop token', secret: true, required: true }]);
    expect(plan.unused).toEqual(['hooks']);
    // Into the library, a project's rules have nowhere to go.
    expect((await planInstall(polyphemus, plugin(), { kind: 'library' })).rules).toEqual([{ name: 'prices', action: 'skip', why: 'rules belong to a project: install it into one to propose them' }]);
  });

  it('installs each part where it belongs, with the key in the vault only, and grants nothing', async () => {
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Shop' });
    const target = { kind: 'project' as const, slug: project.slug };
    await expect(installPlugin(polyphemus, plugin(), target, { by: 'person:alex', origin })).rejects.toThrow('Shop Kit needs SHOP_TOKEN to install.');
    const { installed } = await installPlugin(polyphemus, plugin(), target, { by: 'person:alex', origin, settings: { SHOP_TOKEN: 'shop-secret-123' } });

    const skill = join(project.path, '.polyphemus', 'skills', 'stock-check');
    expect(readFileSync(join(skill, 'SKILL.md'), 'utf8')).toContain('Count it.');
    expect(JSON.parse(readFileSync(join(skill, '.polyphemus-source.json'), 'utf8'))).toMatchObject({ id: 'plugin:shop-kit/stock-check', repo: origin.url, license: 'MIT', by: 'person:alex' });
    const agent = findAgent(home, project.path, `${project.slug}/stocker`, project.slug)!;
    expect(agent).toMatchObject({ description: 'Keeps the shelves full.', instructions: 'Check the shelves every morning.' });
    expect(agent.model).toBeUndefined();
    const proposal = readFileSync(join(home, 'memory', 'projects', project.slug, 'inbox', 'shop-kit-prices.md'), 'utf8');
    expect(proposal).toBe('---\ndescription: Prices include tax.\n---\n\nFrom the Shop Kit plugin.\n\nAlways show prices with tax.\n');

    expect(installed.connections).toEqual(['shop-kit-contacts', 'shop-kit-remote']);
    const local = polyphemus.connections.get('shop-kit-contacts')!;
    expect(local.server).toMatchObject({ kind: 'stdio', command: process.execPath, args: [join(installed.files!, 'server.mjs')], env: { CONTACTS_TOKEN: expect.stringMatching(/^secret:connection\/shop-kit-contacts\//) } });
    expect(polyphemus.connections.get('shop-kit-remote')!.server).toMatchObject({ kind: 'http', headers: { Authorization: expect.stringMatching(/^Bearer \{secret:connection\/shop-kit-remote\//) } });
    // The key is used — the local server runs with it — but granted to nothing yet.
    expect((await polyphemus.connections.test('shop-kit-contacts')).tools.map((t) => t.name)).toContain('read_contacts');
    expect(polyphemus.connections.reach(project.slug, undefined)).toEqual([]);
    for (const file of [join(home, 'plugins', 'installed.json'), join(home, 'sessions.db')]) expect(readFileSync(file).toString('latin1')).not.toContain('shop-secret-123');
  });

  it('leaves alone what’s already yours, and takes back only what it added and nobody changed', async () => {
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Shop' });
    const target = { kind: 'project' as const, slug: project.slug };
    const mine = join(project.path, '.polyphemus', 'skills', 'notes');
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'SKILL.md'), '---\nname: notes\ndescription: Mine.\n---\nMy own.');
    const { plan } = await installPlugin(polyphemus, plugin(), target, { by: 'person:alex', origin, settings: { SHOP_TOKEN: 'shop-secret-123' } });
    expect(plan.skills).toEqual([{ name: 'notes', action: 'skip', why: 'there’s already a skill with this name' }, { name: 'stock-check', action: 'add' }]);
    expect(readFileSync(join(mine, 'SKILL.md'), 'utf8')).toContain('My own.');

    // Someone changes the agent it added; the skill stays as it was.
    writeFileSync(join(project.path, '.polyphemus', 'agents', 'stocker', 'instructions.md'), 'Check the shelves twice a day.');
    const out = await removePlugin(polyphemus, 'shop-kit', target);
    expect(out.removed).toEqual(['skill stock-check', 'proposal shop-kit-prices.md']);
    expect(out.kept).toEqual([`agent ${project.slug}/stocker (changed since it was installed)`, 'connection shop-kit-contacts', 'connection shop-kit-remote']);
    expect(existsSync(join(project.path, '.polyphemus', 'skills', 'stock-check'))).toBe(false);
    expect(readFileSync(join(mine, 'SKILL.md'), 'utf8')).toContain('My own.');
    expect(existsSync(join(project.path, '.polyphemus', 'agents', 'stocker', 'instructions.md'))).toBe(true);
    expect(installedPlugins(home)).toEqual([]);
  });

  it('sends no header at all for an optional key that wasn’t given', async () => {
    const root = mkdtempSync(join(tmpdir(), 'polyphemus-plugin-src-'));
    dirs.push(root);
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: '${DOCS_API_KEY:-}' } } } }));
    const docs = readPlugin(root, { name: 'docs' });
    await installPlugin(polyphemus, docs, { kind: 'library' }, { by: 'person:alex', origin });
    const server = polyphemus.connections.get('docs')!.server as { url: string; headers?: Record<string, string> };
    expect(server.url).toBe('http://127.0.0.1:9/mcp');
    expect(server.headers ?? {}).toEqual({});
  });

  it('removes its connections only when asked', async () => {
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Shop' });
    const target = { kind: 'project' as const, slug: project.slug };
    await installPlugin(polyphemus, plugin(), target, { by: 'person:alex', origin, settings: { SHOP_TOKEN: 'shop-secret-123' } });
    const out = await removePlugin(polyphemus, 'shop-kit', target, { connections: true });
    expect(out.removed).toEqual(expect.arrayContaining(['connection shop-kit-contacts', 'connection shop-kit-remote']));
    expect(polyphemus.connections.get('shop-kit-contacts')).toBeUndefined();
  });
});
