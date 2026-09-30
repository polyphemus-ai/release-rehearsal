import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPlugin } from '../src/plugins/read.js';
import { checkGitUrl, marketplaceEntries } from '../src/plugins/sources.js';

// Reading Cursor's and Claude Code's plugins into one shape (docs/design/plugins.md): what each part
// is, which parts polyphemus won't use, and nothing read from outside the plugin's folder.
describe('reading a plugin', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  const plugin = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'polyphemus-plugin-'));
    dirs.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };

  it('reads a Cursor plugin: skills, a read-only agent, rules, servers, and what it won’t use', () => {
    const root = plugin({
      '.cursor-plugin/plugin.json': JSON.stringify({ name: 'advisor', displayName: 'Advisor', version: '1.0.0', description: 'A second opinion.', author: { name: 'Acme' }, license: 'MIT', skills: './skills/', agents: './agents/', rules: 'rules/*.mdc', hooks: './hooks/hooks.json', mcpServers: { docs: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${EXAMPLE_API_KEY}' } } } }),
      'skills/advisor/SKILL.md': '---\nname: advisor\ndescription: Ask for a second opinion.\n---\nDo it.',
      'agents/advisor-subagent.md': '---\nname: advisor-subagent\ndescription: Reviews before you decide.\nmodel: grok-4.6[effort=xhigh]\nreadonly: true\n---\n\n# Advisor\n\nRead, then advise.',
      'rules/no-inline-imports.mdc': '---\ndescription: Imports at the top.\nalwaysApply: true\n---\nNo inline imports.',
      'hooks/hooks.json': '{}',
    });
    const p = readPlugin(root);
    expect(p).toMatchObject({ name: 'advisor', displayName: 'Advisor', version: '1.0.0', format: 'cursor', author: 'Acme', license: 'MIT', unused: ['hooks'], problems: [] });
    expect(p.skills).toEqual([{ name: 'advisor', dir: join(p.root, 'skills', 'advisor') }]);
    expect(p.agents).toEqual([{ name: 'advisor-subagent', description: 'Reviews before you decide.', model: 'grok-4.6[effort=xhigh]', readOnly: true, body: '# Advisor\n\nRead, then advise.', file: 'agents/advisor-subagent.md' }]);
    expect(p.rules).toEqual([{ name: 'no-inline-imports', description: 'Imports at the top.', alwaysApply: true, body: 'No inline imports.', file: 'rules/no-inline-imports.mdc' }]);
    expect(p.servers).toEqual([{ name: 'docs', kind: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${EXAMPLE_API_KEY}' }, needs: ['EXAMPLE_API_KEY'] }]);
    expect(p.settings).toEqual([{ name: 'EXAMPLE_API_KEY', description: 'Used by docs', secret: true, required: false }]);
  });

  it('reads a Claude Code plugin by its default folders and its .mcp.json, even with no plugin.json', () => {
    const root = plugin({
      'agents/verifier.md': '---\nname: verifier\ndescription: Use this when: the app changed. Examples: after an edit.\nmodel: sonnet\n---\nVerify it.',
      'skills/check/SKILL.md': '---\nname: check\ndescription: Checks.\n---\n',
      'commands/new-app.md': 'Make an app.',
      '.mcp.json': JSON.stringify({ local: { command: 'npx', args: ['-y', 'some-mcp@latest', '--root', '${CLAUDE_PLUGIN_ROOT}'], env: { TOKEN: '${SOME_TOKEN:-}' } } }),
      LICENSE: 'MIT License\n\nCopyright (c) 2026 Acme',
    });
    const p = readPlugin(root, { name: 'agent-kit', description: 'From the marketplace entry.' });
    expect(p).toMatchObject({ name: 'agent-kit', description: 'From the marketplace entry.', format: 'claude', license: 'MIT', unused: ['commands'], problems: [] });
    // Not YAML (a bare colon in the description), but plainly key: value, as Claude Code reads it.
    expect(p.agents).toEqual([expect.objectContaining({ name: 'verifier', description: 'Use this when: the app changed. Examples: after an edit.', model: 'sonnet', readOnly: false })]);
    expect(p.skills.map((s) => s.name)).toEqual(['check']);
    // The plugin's own folder comes from polyphemus, not from a person: only the token is asked for.
    expect(p.servers).toEqual([{ name: 'local', kind: 'stdio', command: 'npx', args: ['-y', 'some-mcp@latest', '--root', '${CLAUDE_PLUGIN_ROOT}'], env: { TOKEN: '${SOME_TOKEN:-}' }, needs: ['SOME_TOKEN'] }]);
  });

  it('reads nothing from outside its folder: not by a path, and not through a link', () => {
    const outside = plugin({ 'secret/SKILL.md': '---\nname: secret\ndescription: Not the plugin’s.\n---\n', 'servers.json': JSON.stringify({ evil: { url: 'https://evil.example.com' } }) });
    const root = plugin({
      '.cursor-plugin/plugin.json': JSON.stringify({ name: 'sneaky', skills: ['../secret/', '/etc/'], mcpServers: '../servers.json' }),
      'skills/ok/SKILL.md': '---\nname: ok\ndescription: Fine.\n---\n',
    });
    mkdirSync(join(root, 'skills', 'linked'));
    symlinkSync(join(outside, 'secret', 'SKILL.md'), join(root, 'skills', 'linked', 'SKILL.md'));
    const p = readPlugin(root);
    expect(p.skills).toEqual([]);
    expect(p.servers).toEqual([]);
    expect(p.problems).toEqual(['../secret/ points outside the plugin, so it was left out.', '/etc/ points outside the plugin, so it was left out.', '../servers.json: no such file in the plugin.']);
    const byDefault = readPlugin(plugin({ '.cursor-plugin/plugin.json': JSON.stringify({ name: 'plain' }), 'skills/ok/SKILL.md': '---\nname: ok\ndescription: Fine.\n---\n' }));
    expect(byDefault.skills.map((s) => s.name)).toEqual(['ok']);
    // The link inside a plugin that points out of it isn't read.
    const linked = plugin({ '.cursor-plugin/plugin.json': JSON.stringify({ name: 'linked' }) });
    mkdirSync(join(linked, 'skills', 'secret'), { recursive: true });
    symlinkSync(join(outside, 'secret', 'SKILL.md'), join(linked, 'skills', 'secret', 'SKILL.md'));
    expect(readPlugin(linked).skills).toEqual([]);
  });

  it('isn’t a plugin without a manifest or a marketplace entry', () => {
    expect(() => readPlugin(plugin({ 'README.md': 'hi' }))).toThrow(/isn't a plugin polyphemus can read/);
  });
});

describe('marketplaces', () => {
  const market = { id: 'claude', name: 'Claude Code', url: 'https://github.com/anthropics/claude-plugins-official.git' };
  const commit = 'a'.repeat(40);

  it('find each plugin: in the marketplace, a folder of another repository, or a whole one, pinned where it says', () => {
    const entries = marketplaceEntries(market, commit, {
      plugins: [
        { name: 'here', description: 'In the marketplace.', source: './plugins/here' },
        { name: 'there', source: { source: 'git-subdir', url: 'https://github.com/acme/plugins.git', path: 'plugins/there', ref: 'v1.2.0', sha: 'b'.repeat(40) } },
        { name: 'whole', source: { source: 'url', url: 'https://github.com/acme/whole.git', sha: 'c'.repeat(40) } },
        { name: 'gh', source: { source: 'github', repo: 'acme/gh' } },
        // Refused: a way out of the marketplace, and addresses that aren't https.
        { name: 'escape', source: '../../elsewhere' },
        { name: 'ssh', source: { source: 'url', url: 'git@github.com:acme/x.git' } },
        { name: 'plain', source: { source: 'url', url: 'http://example.com/x.git' } },
        { name: 'bad name!', source: './plugins/x' },
      ],
    });
    expect(entries.map((e) => [e.id, e.source])).toEqual([
      ['claude/here', { url: market.url, path: 'plugins/here', ref: commit }],
      ['claude/there', { url: 'https://github.com/acme/plugins.git', path: 'plugins/there', ref: 'b'.repeat(40) }],
      ['claude/whole', { url: 'https://github.com/acme/whole.git', path: '', ref: 'c'.repeat(40) }],
      ['claude/gh', { url: 'https://github.com/acme/gh.git', path: '', ref: 'HEAD' }],
    ]);
  });

  it('fetch over https only, with no sign-in in the address', () => {
    expect(() => checkGitUrl('https://github.com/cursor/plugins.git')).not.toThrow();
    for (const bad of ['http://github.com/x.git', 'git@github.com:x/y.git', 'file:///etc', 'ext::sh -c touch% /tmp/pwned', 'https://user:pass@github.com/x.git', 'ssh://github.com/x']) expect(() => checkGitUrl(bad)).toThrow();
  });
});
