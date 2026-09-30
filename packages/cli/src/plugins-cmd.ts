import { createInterface } from 'node:readline/promises';
import { installedPlugins, installPlugin, listMarketplace, loadPlugin, MARKETPLACES, planInstall, PolyphemusError, removePlugin, type InstallPlan, type Polyphemus, type PluginTarget } from '@polyphemus/core';
import { printJson } from './output.js';
import { readHidden } from './picker.js';
import { bold, cyan, dim, green, red, yellow } from './render.js';

// `poly plugins …`: Cursor's and Claude Code's plugins (docs/design/plugins.md). Installing shows what
// it would add first, asks for any keys its servers need (into the vault), and adds nothing until you
// say yes. Hooks and commands are listed and never run.

export async function pluginsCommand(polyphemus: Polyphemus, args: string[], flags: { project?: boolean; yes?: boolean; connections?: boolean; from?: string }, json: boolean, cwd: string): Promise<void> {
  const [action = 'ls', ...rest] = args;
  const project = polyphemus.store.projectFor(cwd);
  const target = (): PluginTarget => {
    if (!flags.project) return { kind: 'library' };
    if (!project) throw new PolyphemusError('You’re not in a project, so there’s nowhere to put a project’s plugin.', 'USAGE', 'poly projects add .');
    return { kind: 'project', slug: project.slug };
  };
  const by = process.env.POLYPHEMUS_CALLER ?? 'you (terminal)';

  switch (action) {
    case 'ls': {
      const all = installedPlugins(polyphemus.home);
      if (json) return printJson({ plugins: all });
      if (!all.length) return console.log(dim('No plugins yet. See what there is: poly plugins browse'));
      for (const p of all) console.log(`${bold(p.displayName)} ${dim(`${p.version ?? ''} · ${p.target.kind === 'library' ? 'library' : p.target.slug} · from ${p.origin.id}`)}\n  ${dim([count(p.skills.length, 'skill'), count(p.agents.length, 'agent'), count(p.connections.length, 'connection'), p.proposals.length ? count(p.proposals.length, 'proposal') : ''].filter(Boolean).join(' · '))}`);
      return;
    }
    case 'browse': {
      const words = rest.join(' ').toLowerCase();
      const markets = MARKETPLACES.filter((m) => !flags.from || m.id === flags.from);
      const found = [];
      for (const m of markets) {
        const listing = await listMarketplace(polyphemus.home, m);
        found.push(...listing.entries.filter((e) => !words || `${e.name} ${e.description} ${e.category ?? ''}`.toLowerCase().includes(words)));
      }
      if (json) return printJson({ plugins: found.map(({ hints: _h, ...e }) => e) });
      if (!found.length) return console.log(dim('None match.'));
      const width = Math.min(40, Math.max(...found.map((e) => e.id.length)));
      for (const e of found.slice(0, 200)) console.log(`${bold(e.id.padEnd(width))}  ${e.description.slice(0, 100)}`);
      if (found.length > 200) console.log(dim(`…and ${found.length - 200} more: narrow it with words.`));
      console.log(dim(`\nWhat one would add: poly plugins show <id> · install it: poly plugins install <id> [--project]`));
      return;
    }
    case 'show':
    case 'install': {
      const ref = rest[0];
      if (!ref) throw new PolyphemusError(`Usage: poly plugins ${action} <marketplace/name | git address[#folder] | folder> [--project]`, 'USAGE', 'poly plugins browse');
      if (!json) process.stderr.write(dim(`Fetching ${ref}…`));
      const { plugin, origin } = await loadPlugin(polyphemus.home, ref);
      if (!json) process.stderr.write(`\r${' '.repeat(60)}\r`);
      const where = target();
      const plan = await planInstall(polyphemus, plugin, where);
      if (action === 'show') return json ? printJson({ plan, origin }) : sayPlan(plan, origin.id);
      if (!json) sayPlan(plan, origin.id);
      // Keys and settings its servers need: asked for here, a secret without echo, never on the command line.
      const settings: Record<string, string> = {};
      for (const s of plan.settings) {
        if (!process.stdin.isTTY) throw new PolyphemusError(`${plugin.displayName} needs ${s.name}; install it at a terminal, or from the app.`, 'USAGE');
        const value = s.secret ? await readHidden(`${s.name}${s.description ? ` (${s.description})` : ''}: `) : await ask(`${s.name}${s.description ? ` (${s.description})` : ''}: `);
        if (value) settings[s.name] = value;
      }
      if (!flags.yes) {
        if (!process.stdin.isTTY) throw new PolyphemusError('Installing asks for a yes: run it at a terminal, or add --yes.', 'USAGE');
        if (!/^y/i.test((await ask(`Install ${plugin.displayName} ${where.kind === 'library' ? 'into your library' : `into ${where.slug}`}? [y/N] `)).trim())) return console.log('Nothing was installed.');
      }
      const { installed, authorize } = await installPlugin(polyphemus, plugin, where, { by, origin, settings });
      if (json) return printJson({ installed, authorize });
      console.log(green(`✓ ${plugin.displayName} is installed: ${count(installed.skills.length, 'skill')}, ${count(installed.agents.length, 'agent')}${installed.proposals.length ? `, ${count(installed.proposals.length, 'rule')} proposed in Review` : ''}${installed.connections.length ? `, ${count(installed.connections.length, 'connection')}` : ''}.`));
      if (installed.connections.length) console.log(dim('  Its connections aren’t granted to anything yet: grant their tools to a project in the app, under Connections.'));
      for (const a of authorize) console.log(dim(`  ${a.name} needs you to sign in: open it under Connections in the app.`));
      return;
    }
    case 'remove': {
      const name = rest[0];
      if (!name) throw new PolyphemusError('Usage: poly plugins remove <name> [--project] [--connections]', 'USAGE', 'poly plugins');
      const out = await removePlugin(polyphemus, name, target(), { connections: flags.connections === true });
      if (json) return printJson(out);
      for (const r of out.removed) console.log(`${green('✓')} removed ${r}`);
      for (const k of out.kept) console.log(`${yellow('•')} kept ${k}`);
      if (out.kept.some((k) => k.startsWith('connection')) && !flags.connections) console.log(dim('  Its connections are kept. Remove them too: add --connections.'));
      return;
    }
    default:
      throw new PolyphemusError(`poly plugins has no "${action}".`, 'USAGE', 'poly help plugins');
  }
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** What installing would do, in words: added, skipped and why, not used, and what runs code here. */
function sayPlan(plan: InstallPlan, from: string): void {
  const p = plan.plugin;
  console.log(`${bold(p.displayName)} ${dim(`${p.version ?? ''} · ${p.format === 'cursor' ? 'a Cursor plugin' : 'a Claude Code plugin'} · ${p.license ?? 'no licence given'} · from ${from}`)}`);
  if (p.description) console.log(`  ${p.description}`);
  const list = (label: string, parts: Array<{ name: string; action: string; why?: string; note?: string }>) => {
    if (!parts.length) return;
    console.log(`\n${label}`);
    for (const part of parts) console.log(part.action === 'add' ? `  ${green('+')} ${part.name}${part.note ? dim(` — ${part.note}`) : ''}` : `  ${dim('–')} ${part.name} ${dim(`(not added: ${part.why})`)}`);
  };
  list('Skills', plan.skills);
  list('Agents', plan.agents);
  list('Rules, proposed in the project’s Review', plan.rules);
  if (plan.servers.length) {
    console.log('\nConnections (granted to nothing until you grant them)');
    for (const s of plan.servers) {
      if (s.action !== 'add') console.log(`  ${dim('–')} ${s.name} ${dim(`(not added: ${s.why})`)}`);
      else console.log(`  ${green('+')} ${s.name} ${dim(s.what)}${s.signIn === 'oauth' ? dim(' · you sign in') : s.signIn === 'key' ? dim(' · takes a key') : ''}${s.runsCode ? `\n    ${red('runs a program on this computer, as you:')} ${s.what}` : ''}`);
    }
  }
  if (plan.unused.length) console.log(`\n${dim(`Not used here (never run): ${plan.unused.join(', ')}.`)}`);
  for (const problem of plan.problems) console.log(`${yellow('•')} ${problem}`);
  console.log(cyan(''));
}
