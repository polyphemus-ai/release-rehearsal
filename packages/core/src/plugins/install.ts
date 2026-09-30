import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { discoverOAuth } from '../connections/oauth.js';
import type { McpServerDefinition } from '../connections/mcp-client.js';
import type { Polyphemus } from '../polyphemus.js';
import { memoryDir } from '../projects.js';
import { createAgent, findAgent, libraryAgentsDir, projectAgentsDir, updateAgent } from '../roster.js';
import { ORIGIN_FILE } from '../skills-catalogue.js';
import { librarySkillsDir, projectSkillsDir } from '../skills.js';
import { PolyphemusError } from '../types.js';
import type { Plugin, PluginServer } from './read.js';

// Installing a plugin (docs/design/plugins.md): its skills as skills, its agents as agents, its rules
// as proposals in a project's Review, its MCP servers as connections — nothing granted until someone
// ticks the tools — and its hooks and commands never run. The plan comes first and says everything;
// the install does exactly the plan, and is recorded so removing takes back exactly what it added.

type Host = Pick<Polyphemus, 'home' | 'store' | 'config' | 'connections'>;

/** The library (everywhere), or one project. */
export type PluginTarget = { kind: 'library' } | { kind: 'project'; slug: string };

export interface PluginOrigin {
  /** `cursor/advisor`, or the address it came from. */
  id: string;
  url: string;
  path: string;
  commit: string;
}

export interface PlannedPart {
  name: string;
  /** add: it goes in; skip: it doesn't, and `why` says why. */
  action: 'add' | 'skip';
  why?: string;
}

export interface PlannedServer extends PlannedPart {
  kind: 'http' | 'stdio';
  /** Where it is: the address, or the command it runs. */
  what: string;
  /** It runs a program on this computer. */
  runsCode: boolean;
  signIn: 'oauth' | 'key' | 'none';
}

export interface InstallPlan {
  plugin: { name: string; displayName: string; version?: string; description: string; license?: string; format: Plugin['format'] };
  target: PluginTarget;
  skills: PlannedPart[];
  agents: Array<PlannedPart & { model?: string; note?: string }>;
  rules: PlannedPart[];
  servers: PlannedServer[];
  /** Settings to ask for before installing: a secret goes to the vault. */
  settings: Plugin['settings'];
  unused: string[];
  problems: string[];
}

export interface InstalledPlugin {
  name: string;
  displayName: string;
  version?: string;
  target: PluginTarget;
  origin: PluginOrigin;
  license?: string;
  installedAt: number;
  by: string;
  skills: Array<{ name: string; dir: string; hash: string }>;
  agents: Array<{ id: string; dir: string; hash: string }>;
  proposals: Array<{ project: string; file: string }>;
  connections: string[];
  /** A copy of the plugin a server runs from, when one does. */
  files?: string;
}

const record = (home: string) => join(home, 'plugins', 'installed.json');
const targetKey = (t: PluginTarget) => (t.kind === 'library' ? 'library' : `project:${t.slug}`);
const safeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'plugin';

export function installedPlugins(home: string): InstalledPlugin[] {
  try {
    return JSON.parse(readFileSync(record(home), 'utf8')) as InstalledPlugin[];
  } catch {
    return [];
  }
}

function saveInstalled(home: string, all: InstalledPlugin[]): void {
  mkdirSync(join(home, 'plugins'), { recursive: true });
  writeFileSync(record(home), `${JSON.stringify(all, null, 2)}\n`);
}

/** Where a target's skills and agents go, and the folder nothing is written outside of. */
function folders(host: Host, target: PluginTarget) {
  if (target.kind === 'library') return { root: host.home, skills: librarySkillsDir(host.home), agents: libraryAgentsDir(host.home), project: undefined };
  const project = host.store.project(target.slug);
  if (!project) throw new PolyphemusError(`There's no project called ${target.slug}.`, 'NOT_FOUND');
  return { root: project.path, skills: projectSkillsDir(project.path), agents: projectAgentsDir(project.path), project };
}

/** A model this install has for what a plugin's agent asks for, or none (it follows the default). */
function modelFor(host: Host, asked: string | undefined): string | undefined {
  if (!asked || asked === 'inherit') return undefined;
  const bare = asked.replace(/\[.*\]$/, '').trim();
  if (host.config.models[bare]) return bare;
  if (host.config.selected.includes(bare)) return bare;
  // Claude Code's short names, where Claude Code is here.
  if (/^(opus|sonnet|haiku)$/.test(bare) && host.config.providers['claude-code']) return `claude-code:${bare}`;
  const chosen = host.config.selected.find((m) => m.endsWith(`:${bare}`));
  return chosen;
}

function hashDir(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === ORIGIN_FILE || name === PROVENANCE) continue;
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) hash.update(relative(dir, full)).update('\0').update(readFileSync(full)).update('\0');
    }
  };
  if (existsSync(dir)) walk(dir);
  return hash.digest('hex');
}

/** What a plugin's agent keeps about where it came from: agent.toml takes no other keys. */
const PROVENANCE = '.polyphemus-plugin.json';

function serverPlan(server: PluginServer, settings: Plugin['settings']): Omit<PlannedServer, 'signIn'> & { signIn?: PlannedServer['signIn'] } {
  const secret = new Set(settings.filter((s) => s.secret).map((s) => s.name));
  const inPlain = [server.url, ...(server.args ?? [])].join(' ');
  const leaks = server.needs.filter((n) => secret.has(n) && inPlain.includes(`\${${n}`));
  const what = server.kind === 'http' ? server.url! : [server.command, ...(server.args ?? [])].join(' ');
  if (leaks.length) return { name: server.name, kind: server.kind, what, runsCode: server.kind === 'stdio', action: 'skip', why: `it wants ${leaks.join(', ')} in its ${server.kind === 'http' ? 'address' : 'command line'}, where polyphemus won’t put a key` };
  return { name: server.name, kind: server.kind, what, runsCode: server.kind === 'stdio', action: 'add' };
}

/** What installing would do, changing nothing. */
export async function planInstall(host: Host, plugin: Plugin, target: PluginTarget): Promise<InstallPlan> {
  const where = folders(host, target);
  const mine = installedPlugins(host.home).find((p) => p.name === plugin.name && targetKey(p.target) === targetKey(target));
  const ours = new Set([...(mine?.skills.map((s) => s.name) ?? []), ...(mine?.agents.map((a) => a.id) ?? [])]);
  const skills = plugin.skills.map((s): PlannedPart => (existsSync(join(where.skills, s.name)) && !ours.has(s.name) ? { name: s.name, action: 'skip', why: 'there’s already a skill with this name' } : { name: s.name, action: 'add' }));
  const agents = plugin.agents.map((a) => {
    const name = safeName(a.name);
    const model = modelFor(host, a.model);
    const note = [a.model && !model ? `asks for ${a.model}, which isn’t here: it follows your default model` : undefined, a.readOnly ? 'meant to only read: Polyphemus asks before anything it would change, as for every agent' : undefined].filter(Boolean).join('; ') || undefined;
    const taken = existsSync(join(where.agents, name, 'agent.toml')) && !ours.has(target.kind === 'library' ? name : `${target.slug}/${name}`);
    return taken ? { name, action: 'skip' as const, why: 'there’s already an agent with this name' } : { name, action: 'add' as const, ...(model && { model }), ...(note && { note }) };
  });
  const rules = plugin.rules.map((r): PlannedPart => (target.kind === 'library' ? { name: r.name, action: 'skip', why: 'rules belong to a project: install it into one to propose them' } : { name: r.name, action: 'add' }));
  const servers: PlannedServer[] = [];
  for (const server of plugin.servers) {
    const planned = serverPlan(server, plugin.settings);
    let signIn: PlannedServer['signIn'] = server.needs.length ? 'key' : 'none';
    if (planned.action === 'add' && server.kind === 'http' && !server.needs.length) signIn = (await discoverOAuth(fill(server.url!, {})).catch(() => undefined)) ? 'oauth' : 'none';
    servers.push({ ...planned, signIn });
  }
  return {
    plugin: { name: plugin.name, displayName: plugin.displayName, ...(plugin.version && { version: plugin.version }), description: plugin.description, ...(plugin.license && { license: plugin.license }), format: plugin.format },
    target,
    skills,
    agents,
    rules,
    servers,
    settings: plugin.settings.filter((s) => plugin.servers.some((sv) => sv.needs.includes(s.name)) || s.required),
    unused: plugin.unused,
    problems: plugin.problems,
  };
}

/** `${NAME}` and `${NAME:-default}` filled with what's known; a secret is left for the vault to fill. */
function fill(text: string, values: Record<string, string>, keep: Set<string> = new Set()): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name: string, fallback?: string) => (keep.has(name) ? whole : values[name] ?? fallback ?? ''));
}

/**
 * Installs what `planInstall` said, for `by`. `settings` are the values asked for; secrets among them
 * go to the vault under the connection that uses them. Connections are added but granted to nothing.
 */
export async function installPlugin(host: Host, plugin: Plugin, target: PluginTarget, opts: { by: string; origin: PluginOrigin; settings?: Record<string, string> }): Promise<{ installed: InstalledPlugin; plan: InstallPlan; authorize: Array<{ connection: string; name: string }> }> {
  const plan = await planInstall(host, plugin, target);
  const where = folders(host, target);
  const settings = opts.settings ?? {};
  const missing = plan.settings.filter((s) => s.required && !settings[s.name]);
  if (missing.length) throw new PolyphemusError(`${plugin.displayName} needs ${missing.map((s) => s.name).join(', ')} to install.`, 'USAGE');
  const all = installedPlugins(host.home);
  const before = all.find((p) => p.name === plugin.name && targetKey(p.target) === targetKey(target));
  const installed: InstalledPlugin = { name: plugin.name, displayName: plugin.displayName, ...(plugin.version && { version: plugin.version }), target, origin: opts.origin, ...(plugin.license && { license: plugin.license }), installedAt: Date.now(), by: opts.by, skills: [], agents: [], proposals: [], connections: before?.connections ?? [] };

  // Skills: copied as they are, with where they came from beside them.
  for (const part of plan.skills.filter((s) => s.action === 'add')) {
    const skill = plugin.skills.find((s) => s.name === part.name)!;
    const dest = join(where.skills, skill.name);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(where.skills, { recursive: true });
    // Links aren't copied: one could point anywhere on this computer.
    cpSync(skill.dir, dest, { recursive: true, dereference: false, filter: (src) => !lstatSync(src).isSymbolicLink() });
    writeFileSync(join(dest, ORIGIN_FILE), `${JSON.stringify({ id: `plugin:${plugin.name}/${skill.name}`, repo: opts.origin.url, path: relative(plugin.root, skill.dir), license: plugin.license ?? 'unknown', installedAt: installed.installedAt, by: opts.by }, null, 2)}\n`);
    installed.skills.push({ name: skill.name, dir: dest, hash: hashDir(dest) });
  }

  // Agents: its instructions are the plugin's, the model is one this install has or the default.
  for (const part of plan.agents.filter((a) => a.action === 'add')) {
    const agent = plugin.agents.find((a) => safeName(a.name) === part.name)!;
    const dir = join(where.agents, part.name);
    rmSync(dir, { recursive: true, force: true });
    createAgent(where.agents, part.name, { description: agent.description || `From the ${plugin.displayName} plugin.`, ...(part.model && { model: part.model }) }, where.root);
    const found = findAgent(host.home, where.project?.path, target.kind === 'library' ? part.name : `${target.slug}/${part.name}`, where.project?.slug) ?? findAgent(host.home, where.project?.path, part.name, where.project?.slug);
    if (found) updateAgent(found, { instructions: agent.body, persona: '' });
    writeFileSync(join(dir, PROVENANCE), `${JSON.stringify({ plugin: plugin.name, file: agent.file, origin: opts.origin, readOnly: agent.readOnly }, null, 2)}\n`);
    installed.agents.push({ id: target.kind === 'library' ? part.name : `${target.slug}/${part.name}`, dir, hash: hashDir(dir) });
  }

  // Rules: proposals in the project's Review, never written into the project.
  if (target.kind === 'project') {
    const inbox = join(memoryDir(host.home, target.slug), 'inbox');
    mkdirSync(inbox, { recursive: true });
    for (const part of plan.rules.filter((r) => r.action === 'add')) {
      const rule = plugin.rules.find((r) => r.name === part.name)!;
      const file = `${safeName(`${plugin.name}-${rule.name}`)}.md`;
      const description = rule.description || `A rule from the ${plugin.displayName} plugin`;
      writeFileSync(join(inbox, file), `---\ndescription: ${description.replace(/\n/g, ' ')}\n---\n\nFrom the ${plugin.displayName} plugin${rule.alwaysApply ? '' : rule.globs ? `, for ${rule.globs}` : ''}.\n\n${rule.body}\n`);
      installed.proposals.push({ project: target.slug, file });
    }
  }

  // Servers: connections owned by whoever installs it, granted to nothing yet.
  const authorize: Array<{ connection: string; name: string }> = [];
  const serversToAdd = plan.servers.filter((s) => s.action === 'add');
  if (serversToAdd.some((s) => s.runsCode)) {
    // A server that runs from the plugin's own files needs them kept where they won't be cleaned up.
    const files = join(host.home, 'plugins', 'files', `${safeName(plugin.name)}-${opts.origin.commit.slice(0, 12)}`);
    if (!existsSync(files)) cpSync(plugin.root, files, { recursive: true, dereference: false, filter: (src) => !/[\\/]\.git([\\/]|$)/.test(src) && !lstatSync(src).isSymbolicLink() });
    installed.files = files;
  }
  const owner = host.store.installOwner().id;
  for (const planned of serversToAdd) {
    if (before) continue; // kept from the last install: a reinstall doesn't add them twice
    const server = plugin.servers.find((s) => s.name === planned.name)!;
    const secretNames = new Set(plugin.settings.filter((s) => s.secret).map((s) => s.name));
    const values = { ...Object.fromEntries(Object.entries(settings).filter(([k]) => !secretNames.has(k))), CLAUDE_PLUGIN_ROOT: installed.files ?? plugin.root, CURSOR_PLUGIN_ROOT: installed.files ?? plugin.root, PLUGIN_ROOT: installed.files ?? plugin.root };
    const secrets = Object.fromEntries(server.needs.filter((n) => secretNames.has(n) && settings[n]).map((n) => [n, settings[n]!]));
    // A secret that was given stays a placeholder for the vault; one that wasn't (an optional key) takes
    // its default, and a header or variable left empty isn't sent at all.
    const given = new Set(Object.keys(secrets));
    const each = (record?: Record<string, string>) => {
      if (!record) return undefined;
      const filled = Object.entries(record).map(([k, v]) => [k, fill(v, values, given)] as const).filter(([, v]) => v.replace(/^Bearer\s*$/i, '').trim() !== '');
      return filled.length ? Object.fromEntries(filled) : undefined;
    };
    const def: McpServerDefinition =
      server.kind === 'http'
        ? { kind: 'http', url: fill(server.url!, values), ...(each(server.headers) && { headers: each(server.headers) }), ...(planned.signIn === 'oauth' && { auth: 'oauth' as const }) }
        : { kind: 'stdio', command: server.command!, args: (server.args ?? []).map((a) => fill(a, values)), ...(each(server.env) && { env: each(server.env) }), ...(installed.files && { cwd: installed.files }) };
    const connection = await host.connections.add({ name: plugin.servers.length === 1 ? plugin.displayName : `${plugin.displayName} ${server.name}`, owner, server: def, secrets, createdBy: opts.by });
    installed.connections.push(connection.id);
    if (planned.signIn === 'oauth') authorize.push({ connection: connection.id, name: connection.name });
  }

  saveInstalled(host.home, [...all.filter((p) => p !== before), installed]);
  return { installed, plan, authorize };
}

/**
 * Takes back what an install added: its skills and agents that nobody has changed since (a changed
 * one stays, and is said), its proposals still waiting in Review, and — only if asked — its connections.
 */
export async function removePlugin(host: Host, name: string, target: PluginTarget, opts: { connections?: boolean } = {}): Promise<{ removed: string[]; kept: string[] }> {
  const all = installedPlugins(host.home);
  const it = all.find((p) => p.name === name && targetKey(p.target) === targetKey(target));
  if (!it) throw new PolyphemusError(`${name} isn’t installed ${target.kind === 'library' ? 'in the library' : `in ${target.slug}`}.`, 'NOT_FOUND');
  const trash = join(host.home, 'trash', 'plugins', `${safeName(name)}-${Date.now()}`);
  const removed: string[] = [];
  const kept: string[] = [];
  const takeBack = (label: string, dir: string, hash: string) => {
    if (!existsSync(dir)) return;
    if (hashDir(dir) !== hash) return void kept.push(`${label} (changed since it was installed)`);
    mkdirSync(trash, { recursive: true });
    cpSync(dir, join(trash, label.replace(/[^a-z0-9._-]+/gi, '-')), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    removed.push(label);
  };
  for (const s of it.skills) takeBack(`skill ${s.name}`, s.dir, s.hash);
  for (const a of it.agents) takeBack(`agent ${a.id}`, a.dir, a.hash);
  for (const p of it.proposals) {
    const file = join(memoryDir(host.home, p.project), 'inbox', p.file);
    if (existsSync(file)) {
      rmSync(file);
      removed.push(`proposal ${p.file}`);
    }
  }
  if (opts.connections) {
    for (const id of it.connections) {
      if (!host.connections.get(id)) continue;
      await host.connections.disconnect(id);
      removed.push(`connection ${id}`);
    }
  } else for (const id of it.connections) if (host.connections.get(id)) kept.push(`connection ${id}`);
  saveInstalled(host.home, all.filter((p) => p !== it));
  return { removed, kept };
}
