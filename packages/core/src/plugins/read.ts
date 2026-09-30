import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PolyphemusError } from '../types.js';

// Reading a plugin — Cursor's (.cursor-plugin/plugin.json) or Claude Code's (.claude-plugin/plugin.json,
// or a marketplace entry standing in for one) — into one shape (docs/design/plugins.md). Reading runs
// nothing: it lists what the plugin holds, and says which parts polyphemus will use and which it won't.
// Every path a manifest names is resolved inside the plugin's folder, never outside it.

export type PluginFormat = 'cursor' | 'claude';

export interface PluginSkill {
  name: string;
  /** The skill's folder, inside the plugin. */
  dir: string;
}

export interface PluginAgent {
  name: string;
  description: string;
  /** The model the plugin asks for, as it wrote it (`sonnet`, `grok-4.6[effort=xhigh]`). */
  model?: string;
  readOnly: boolean;
  /** Its instructions: the file's text after the frontmatter. */
  body: string;
  file: string;
}

export interface PluginRule {
  name: string;
  description: string;
  alwaysApply: boolean;
  globs?: string;
  body: string;
  file: string;
}

export interface PluginServer {
  name: string;
  kind: 'http' | 'stdio';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** The settings it needs filled in, from ${NAME} in its address, headers, arguments and environment. */
  needs: string[];
}

export interface PluginSetting {
  name: string;
  description: string;
  secret: boolean;
  required: boolean;
}

export interface Plugin {
  name: string;
  displayName: string;
  version?: string;
  description: string;
  author?: string;
  homepage?: string;
  license?: string;
  format: PluginFormat;
  /** The plugin's folder on this computer. */
  root: string;
  skills: PluginSkill[];
  agents: PluginAgent[];
  rules: PluginRule[];
  servers: PluginServer[];
  settings: PluginSetting[];
  /** Parts polyphemus doesn't use (hooks, commands…), by what they're called in the manifest. */
  unused: string[];
  /** What couldn't be read, file by file: a plugin with a bad agent file still has its skills. */
  problems: string[];
}

/** What a marketplace entry says, for a Claude Code plugin that has no plugin.json of its own. */
export interface EntryHints {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  skills?: unknown;
}

const LIMITS = { files: 3000, fileBytes: 1024 * 1024 };
/** Settings a plugin gets from its host rather than from a person. */
const PROVIDED = new Set(['CLAUDE_PLUGIN_ROOT', 'CURSOR_PLUGIN_ROOT', 'PLUGIN_ROOT', 'HOME', 'PATH']);
const SECRET_NAME = /key|token|secret|password|credential|auth/i;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Reads the plugin in `dir`. */
export function readPlugin(dir: string, hints: EntryHints = {}): Plugin {
  const root = realpathSync(dir);
  const files = listFiles(root);
  const cursorManifest = join(root, '.cursor-plugin', 'plugin.json');
  const claudeManifest = join(root, '.claude-plugin', 'plugin.json');
  const format: PluginFormat = existsSync(cursorManifest) ? 'cursor' : 'claude';
  const manifestFile = format === 'cursor' ? cursorManifest : claudeManifest;
  const problems: string[] = [];
  let manifest: Record<string, unknown> = {};
  if (existsSync(manifestFile)) {
    try {
      manifest = JSON.parse(readSmall(manifestFile)) as Record<string, unknown>;
    } catch (err) {
      throw new PolyphemusError(`${basename(root)}'s plugin.json isn't valid JSON: ${(err as Error).message}`, 'USAGE');
    }
  } else if (!hints.name) {
    throw new PolyphemusError(`${basename(root)} has no .cursor-plugin/plugin.json or .claude-plugin/plugin.json, so it isn't a plugin polyphemus can read.`, 'USAGE');
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const name = str(manifest.name) ?? hints.name ?? basename(root);
  if (!NAME.test(name)) throw new PolyphemusError(`"${name}" isn't a name polyphemus can use for a plugin.`, 'USAGE');
  const author = typeof manifest.author === 'object' && manifest.author ? str((manifest.author as { name?: unknown }).name) : str(manifest.author) ?? hints.author;

  // Where each part is: what the manifest says, or the defaults both formats share.
  const where = (key: string, fallback: string) => {
    const said = manifest[key] ?? (key === 'skills' ? hints.skills : undefined);
    const paths = typeof said === 'string' ? [said] : Array.isArray(said) ? said.filter((p): p is string => typeof p === 'string') : [fallback];
    return matching(root, files, paths, problems);
  };

  const skills = uniqueBy(
    where('skills', 'skills/')
      .filter((file) => basename(file) === 'SKILL.md')
      .map((file) => ({ name: basename(join(file, '..')), dir: join(root, file, '..') })),
    (s) => s.name,
  );
  const agents = where('agents', 'agents/')
    .filter((file) => file.endsWith('.md'))
    .flatMap((file) => {
      const doc = frontmatter(join(root, file), problems);
      if (!doc) return [];
      const agentName = str(doc.front.name) ?? basename(file, '.md');
      return [{ name: agentName, description: str(doc.front.description) ?? '', model: str(doc.front.model), readOnly: doc.front.readonly === true || doc.front.readOnly === true, body: doc.body, file }];
    });
  const rules = format === 'cursor'
    ? where('rules', 'rules/')
        .filter((file) => /\.mdc?$/.test(file))
        .flatMap((file) => {
          const doc = frontmatter(join(root, file), problems);
          if (!doc) return [];
          return [{ name: basename(file).replace(/\.mdc?$/, ''), description: str(doc.front.description) ?? '', alwaysApply: doc.front.alwaysApply === true, globs: str(doc.front.globs), body: doc.body, file }];
        })
    : [];
  const servers = readServers(root, files, format === 'cursor' ? manifest.mcpServers : (manifest.mcpServers ?? (files.includes('.mcp.json') ? '.mcp.json' : undefined)), problems);
  const settings = readSettings(format === 'cursor' ? manifest.variables : manifest.userConfig, servers);
  const unused = ['hooks', 'commands', 'lspServers', 'outputStyles'].filter(
    (key) => manifest[key] !== undefined || (key === 'commands' && files.some((f) => f.startsWith('commands/'))) || (key === 'hooks' && files.includes('hooks/hooks.json')),
  );
  return {
    name,
    displayName: str(manifest.displayName) ?? name,
    version: str(manifest.version) ?? hints.version,
    description: str(manifest.description) ?? hints.description ?? '',
    ...(author && { author }),
    ...(str(manifest.homepage) && { homepage: str(manifest.homepage) }),
    license: str(manifest.license) ?? licenseName(root, files),
    format,
    root,
    skills,
    agents,
    rules,
    servers,
    settings,
    unused,
    problems,
  };
}

/** Every file in the plugin, as paths inside it: links are never followed out of it. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // A link inside the plugin is read only if it stays inside it.
        let target: string;
        try {
          target = realpathSync(full);
        } catch {
          continue;
        }
        if (!inside(target, root)) continue;
        if (statSync(target).isFile()) out.push(relative(root, full));
        continue;
      }
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(relative(root, full));
      if (out.length > LIMITS.files) throw new PolyphemusError(`The plugin has more than ${LIMITS.files} files, more than polyphemus reads.`, 'USAGE');
    }
  };
  walk(root);
  return out.map((f) => f.split(sep).join('/')).sort();
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The files a manifest's paths or globs name — a folder means everything in it — never outside the plugin. */
function matching(root: string, files: string[], paths: string[], problems: string[]): string[] {
  const found = new Set<string>();
  for (const raw of paths) {
    const path = raw.replace(/^\.\//, '').replace(/\/+$/, '');
    if (isAbsolute(raw) || path.split('/').includes('..')) {
      problems.push(`${raw} points outside the plugin, so it was left out.`);
      continue;
    }
    if (/[*?[]/.test(path)) {
      const pattern = new RegExp(`^${path.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
      for (const f of files) if (pattern.test(f)) found.add(f);
      continue;
    }
    if (files.includes(path)) found.add(path);
    else for (const f of files) if (path === '' || f.startsWith(`${path}/`)) found.add(f);
  }
  void root;
  return [...found].sort();
}

function readSmall(file: string): string {
  if (lstatSync(file).size > LIMITS.fileBytes) throw new PolyphemusError(`${basename(file)} is bigger than polyphemus reads from a plugin.`, 'USAGE');
  return readFileSync(file, 'utf8');
}

function frontmatter(file: string, problems: string[]): { front: Record<string, unknown>; body: string } | undefined {
  let text: string;
  try {
    text = readSmall(file);
  } catch (err) {
    problems.push(`${basename(file)}: ${(err as Error).message}`);
    return undefined;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { front: {}, body: text.trim() };
  try {
    return { front: (parseYaml(match[1]!) ?? {}) as Record<string, unknown>, body: match[2]!.trim() };
  } catch {
    // Many agent files write `description: Use this when: …` — not YAML, but plainly `key: value`
    // lines, which is how Claude Code itself reads them.
    const front: Record<string, unknown> = {};
    for (const line of match[1]!.split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      const value = kv[2]!.trim();
      front[kv[1]!] = value === 'true' ? true : value === 'false' ? false : value.replace(/^(['"])(.*)\1$/, '$2');
    }
    if (!Object.keys(front).length) problems.push(`${basename(file)}: its frontmatter couldn't be read.`);
    return { front, body: match[2]!.trim() };
  }
}

/** MCP servers: a path to a JSON file, an object of them (with or without an mcpServers wrapper), or a list of either. */
function readServers(root: string, files: string[], said: unknown, problems: string[]): PluginServer[] {
  const out: PluginServer[] = [];
  const take = (value: unknown) => {
    if (typeof value === 'string') {
      const path = value.replace(/^\.\//, '');
      if (isAbsolute(value) || path.split('/').includes('..') || !files.includes(path)) return void problems.push(`${value}: no such file in the plugin.`);
      try {
        return take(JSON.parse(readSmall(join(root, path))));
      } catch (err) {
        return void problems.push(`${value} isn't valid JSON: ${(err as Error).message}`);
      }
    }
    if (Array.isArray(value)) return value.forEach(take);
    if (!value || typeof value !== 'object') return;
    const map = (value as { mcpServers?: unknown }).mcpServers ?? value;
    for (const [name, def] of Object.entries(map as Record<string, unknown>)) {
      if (!def || typeof def !== 'object') continue;
      const d = def as Record<string, unknown>;
      const strings = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string> : undefined);
      const url = typeof d.url === 'string' ? d.url : undefined;
      const command = typeof d.command === 'string' ? d.command : undefined;
      if (!url && !command) continue;
      const server: PluginServer = {
        name,
        kind: url ? 'http' : 'stdio',
        ...(url && { url }),
        ...(strings(d.headers) && { headers: strings(d.headers) }),
        ...(command && { command }),
        ...(Array.isArray(d.args) && { args: d.args.filter((a): a is string => typeof a === 'string') }),
        ...(strings(d.env) && { env: strings(d.env) }),
        needs: [],
      };
      server.needs = needsOf(server);
      out.push(server);
    }
  };
  take(said);
  return uniqueBy(out, (s) => s.name);
}

/** The settings a server's definition refers to, as ${NAME} or ${NAME:-default}, bar what the host provides. */
function needsOf(server: PluginServer): string[] {
  const text = JSON.stringify([server.url, server.headers, server.args, server.env]);
  const names = [...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)].map((m) => m[1]!);
  return [...new Set(names)].filter((n) => !PROVIDED.has(n));
}

/** Settings a plugin asks for: Cursor's `variables` (a JSON schema), Claude Code's `userConfig`, and whatever its servers refer to. */
function readSettings(said: unknown, servers: PluginServer[]): PluginSetting[] {
  const out = new Map<string, PluginSetting>();
  const obj = said && typeof said === 'object' ? (said as Record<string, unknown>) : undefined;
  const properties = obj && typeof obj.properties === 'object' ? (obj.properties as Record<string, Record<string, unknown>>) : (obj as Record<string, Record<string, unknown>> | undefined);
  const required = new Set(Array.isArray(obj?.required) ? (obj!.required as string[]) : []);
  for (const [name, spec] of Object.entries(properties ?? {})) {
    if (!spec || typeof spec !== 'object' || name === 'type') continue;
    out.set(name, {
      name,
      description: String(spec.description ?? spec.title ?? ''),
      secret: spec.secret === true || spec.sensitive === true || SECRET_NAME.test(name),
      required: required.has(name) || spec.required === true,
    });
  }
  for (const server of servers) for (const name of server.needs) if (!out.has(name)) out.set(name, { name, description: `Used by ${server.name}`, secret: SECRET_NAME.test(name), required: false });
  return [...out.values()];
}

function licenseName(root: string, files: string[]): string | undefined {
  const file = files.find((f) => /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i.test(f));
  if (!file) return undefined;
  const head = readFileSync(join(root, file), 'utf8').slice(0, 400);
  if (/MIT License/i.test(head)) return 'MIT';
  if (/Apache License/i.test(head)) return 'Apache-2.0';
  if (/BSD/i.test(head)) return 'BSD';
  if (/GNU GENERAL PUBLIC/i.test(head)) return 'GPL';
  if (/Mozilla Public License/i.test(head)) return 'MPL-2.0';
  return 'see its licence file';
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(key(item)) ? false : (seen.add(key(item)), true)));
}
