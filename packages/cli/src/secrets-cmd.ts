import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PolyphemusError, secretRef, type Polyphemus, type SecretKind } from '@polyphemus/core';
import { callerName } from './config-cmd.js';
import { iso, printJson } from './output.js';
import { bold, dim, green, red, yellow } from './render.js';

// `poly secrets …`: the vault, from the terminal (docs/design/secrets.md). Values go in and
// are used; they don't come back out except with `show --reveal`, which needs a terminal.

const KINDS: SecretKind[] = ['api-key', 'token', 'password', 'other'];

/** A secret typed at the prompt, or piped in (`echo … | poly secrets set x`). */
async function readValue(name: string, readSecret: (prompt: string) => Promise<string>): Promise<string> {
  if (process.stdin.isTTY) return readSecret(`Value for ${name} (input hidden, Esc to cancel): `);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

export async function secretsCommand(
  polyphemus: Polyphemus,
  args: string[],
  values: { note?: string; kind?: string; reveal?: boolean; last?: string; machine?: boolean },
  json: boolean,
  readSecret: (prompt: string) => Promise<string>,
): Promise<void> {
  const { vault } = polyphemus;
  const [action = 'ls', name] = args;
  switch (action) {
    case 'ls': {
      const secrets = vault.list();
      if (json) return printJson({ secrets: secrets.map((s) => ({ ...s, ref: secretRef(s.name), createdAt: iso(s.createdAt), updatedAt: iso(s.updatedAt) })) });
      if (secrets.length === 0) return console.log(dim('The vault is empty. Add one: poly secrets set <name>'));
      const width = Math.max(...secrets.map((s) => s.name.length));
      for (const s of secrets) console.log(`${bold(s.name.padEnd(width))}  ${dim(s.kind.padEnd(8))} ${dim(`set ${new Date(s.updatedAt).toLocaleDateString()}`)}${s.note ? ` · ${s.note}` : ''}`);
      return console.log(dim(`\nUse one anywhere a value is asked for: ${secretRef(secrets[0]!.name)}`));
    }
    case 'set': {
      if (!name) throw new PolyphemusError('Usage: poly secrets set <name> [--kind api-key] [--note "what it’s for"]', 'USAGE');
      if (values.kind && !KINDS.includes(values.kind as SecretKind)) throw new PolyphemusError(`Kind must be one of: ${KINDS.join(', ')}.`, 'USAGE');
      const value = await readValue(name, readSecret);
      if (!value) throw new PolyphemusError('Nothing was typed, so nothing was saved.', 'USAGE');
      const existed = vault.has(name);
      vault.set(name, value, { kind: (values.kind as SecretKind) ?? undefined, note: values.note });
      if (json) return printJson({ name, ref: secretRef(name), replaced: existed });
      console.log(`${green('✓')} ${existed ? 'Replaced' : 'Saved'} ${name}. Refer to it as ${secretRef(name)}.`);
      return;
    }
    case 'rm': {
      if (!name) throw new PolyphemusError('Usage: poly secrets rm <name>', 'USAGE');
      if (!vault.remove(name)) throw new PolyphemusError(`There's no secret called "${name}".`, 'NOT_FOUND', 'poly secrets ls');
      return json ? printJson({ removed: name }) : console.log(`${green('✓')} Removed ${name}.`);
    }
    case 'show': {
      if (!name) throw new PolyphemusError('Usage: poly secrets show <name> --reveal', 'USAGE');
      if (!vault.has(name)) throw new PolyphemusError(`There's no secret called "${name}".`, 'NOT_FOUND', 'poly secrets ls');
      if (!values.reveal) throw new PolyphemusError(`${name} is in the vault. Polyphemus doesn't print secrets by default.`, 'USAGE', `poly secrets show ${name} --reveal`);
      if (!process.stdout.isTTY) throw new PolyphemusError('A secret is only shown on a terminal, never into a pipe or a file.', 'USAGE');
      console.log(vault.get(name, callerName()));
      return;
    }
    case 'migrate': {
      const moved = polyphemus.credentials.migrate();
      if (json) return printJson({ moved });
      if (moved.length === 0) return console.log(dim('Nothing to move: no plain-text keys left in credentials.json.'));
      console.log(`${green('✓')} Moved into the vault: ${moved.join(', ')}. They're no longer in plain text.`);
      return;
    }
    case 'audit': {
      const last = values.last ? Number(values.last) : 30;
      if (!Number.isInteger(last) || last < 1) throw new PolyphemusError('--last takes a whole number.', 'USAGE');
      const reads = polyphemus.store.secretReads(last);
      if (json) return printJson({ reads: reads.map((r) => ({ ...r, at: iso(r.at) })) });
      if (reads.length === 0) return console.log(dim('No secret has been used yet.'));
      for (const r of reads) console.log(`${dim(new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}  ${bold(r.name)}  ${dim(`· ${r.by}`)}`);
      return;
    }
    case 'doctor':
      return doctor(polyphemus, json, values.machine === true);
    default:
      throw new PolyphemusError(`Unknown secrets command "${action}". Try: ls, set, rm, show, migrate, audit, doctor.`, 'USAGE', 'poly help secrets set');
  }
}

interface Finding {
  level: 'problem' | 'note';
  text: string;
  fix?: string;
}

/**
 * Polyphemus's own house: the vault's files, keys still in plain text, and variables that override
 * the vault. Any of those is a problem (exit 1).
 *
 * `--machine` additionally says whether well-known credential files and variables exist on this
 * computer (existence only: polyphemus never reads them, and its tools are blocked from those paths
 * anyway). That's for phase 6, when each bot gets its own identity and inheriting them matters.
 * It stays opt-in: the rest of your machine isn't polyphemus's business.
 */
function doctor(polyphemus: Polyphemus, json: boolean, machine: boolean): void {
  const home = homedir();
  const findings: Finding[] = [];
  const problem = (text: string, fix?: string) => findings.push({ level: 'problem', text, fix });
  const note = (text: string, fix?: string) => findings.push({ level: 'note', text, fix });

  for (const text of polyphemus.vault.problems()) problem(text);

  const legacy = polyphemus.credentials.legacyProviders();
  if (legacy.length > 0) problem(`API keys are still in plain text in ${polyphemus.credentials.file}: ${legacy.join(', ')}.`, 'poly secrets migrate');

  const envKeys = Object.entries(polyphemus.config.providers)
    .flatMap(([id, p]) => (p.auth.type === 'api_key' && p.auth.env && process.env[p.auth.env] ? [`${p.auth.env} (${id})`] : []));
  if (envKeys.length > 0) note(`Set in this shell, and used before the vault: ${envKeys.join(', ')}.`);

  if (machine) {
    const ambientEnv = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'GH_TOKEN', 'GITHUB_TOKEN'].filter((name) => process.env[name]);
    if (ambientEnv.length > 0) note(`Credentials in this shell's environment: ${ambientEnv.join(', ')}. Polyphemus strips these from the environment its tools run in.`);

    const files: Array<[string, string]> = [
      ['.aws/credentials', 'long-lived AWS keys'],
      ['.config/gh/hosts.yml', 'a global gh login'],
      ['.secrets', 'a shared secrets folder'],
      ['.netrc', 'saved logins'],
    ];
    for (const [path, what] of files) {
      // Existence only: polyphemus never opens these, and its tools are blocked from them.
      if (existsSync(join(home, path))) note(`~/${path} exists (${what}). Polyphemus tools refuse to read it; phase 6 gives each bot its own identity instead.`);
    }
  }

  const problems = findings.filter((f) => f.level === 'problem');
  if (json) return printJson({ ok: problems.length === 0, findings });
  for (const f of findings) {
    console.log(`${f.level === 'problem' ? red('✗') : yellow('•')} ${f.text}${f.fix ? dim(`  → ${f.fix}`) : ''}`);
  }
  if (problems.length === 0) console.log(`${green('✓')} The vault is in order${machine && findings.length > 0 ? ', and the rest is this computer’s own credentials, which polyphemus tools can’t read' : ''}.`);
  else process.exitCode = 1;
  if (!machine) console.log(dim('Checked polyphemus’s own secrets only. To also check this computer for credentials a bot could inherit: poly secrets doctor --machine'));
}
