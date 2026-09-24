#!/usr/bin/env node
// Refuses to let anything private into polyphemus's public repository. Scans every text file in a
// folder (default: the files git tracks here) for two things:
//  - secrets anyone could recognise: private keys, and live-looking provider tokens;
//  - the building install's own names, hosts and paths, from a denylist kept OUTSIDE the repository
//    (POLYPHEMUS_LEAK_DENYLIST, default ~/.config/polyphemus-dev/leak-denylist.txt) — the list is itself
//    exactly what mustn't leak.
// Exits 1 with every hit. `node scripts/leak-check.mjs [folder] [--require-denylist]`
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
// The files this repository keeps but never publishes: checked where they're published from, not here.
import { inPrivate } from './private-files.mjs';

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
const requireDenylist = args.includes('--require-denylist');
const root = folder ?? process.cwd();

const files = folder
  ? (function walk(dir) {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === '.git' || e.name === 'node_modules' ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    })(root)
  : execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f && !inPrivate(f))
      .map((f) => join(root, f));

// Recognisable secrets. Test fixtures use obviously fake values, which these don't match.
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bsk-ant-api0\d-[A-Za-z0-9_-]{80,}/, 'an Anthropic API key'],
  [/\bsk-(proj-)?[A-Za-z0-9_-]{40,}/, 'an OpenAI API key'],
  [/\bxai-[A-Za-z0-9]{60,}/, 'an xAI API key'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}/, 'a GitHub token'],
  [/\bgh[pousr]_(?!abcdefghijklmnopqrstuvwxyz)[A-Za-z0-9]{36}\b/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/\bxox[abpr]-[A-Za-z0-9-]{20,}/, 'a Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'a Google API key'],
];

// Any email address that isn't an example one: a real person's address is exactly what mustn't leak,
// and no denylist can list everyone's. Git's own protocol users (git@github.com) aren't people.
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
const exampleEmail = (address) => /@(([a-z0-9-]+\.)*example\.(com|org|net)|github\.com|users\.noreply\.github\.com|anthropic\.com)$/i.test(address);
// Addresses Polyphemus publishes on purpose, by name: where vulnerabilities are reported. Only these —
// any other address at the domain is still refused.
const PUBLISHED = new Set(['security@polyphemus.ai']);

const denylistFile = process.env.POLYPHEMUS_LEAK_DENYLIST ?? join(homedir(), '.config', 'polyphemus-dev', 'leak-denylist.txt');
const denied = existsSync(denylistFile)
  ? readFileSync(denylistFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => (line.startsWith('(?-i)') ? new RegExp(line.slice(5)) : new RegExp(line, 'i')))
  : [];
if (!denied.length && requireDenylist) {
  console.error(`✗ No denylist at ${denylistFile}: refusing to call this clean without it.`);
  process.exit(1);
}

let hits = 0;
for (const file of files) {
  let text;
  try {
    if (statSync(file).size > 5 * 1024 * 1024) continue;
    const buffer = readFileSync(file);
    if (buffer.includes(0)) continue; // binary
    text = buffer.toString('utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [pattern, what] of SECRETS) {
      if (pattern.test(line)) {
        hits += 1;
        console.log(`${relative(root, file)}:${i + 1}: ${what}`);
      }
    }
    for (const [address] of line.matchAll(EMAIL)) {
      if (exampleEmail(address) || PUBLISHED.has(address.toLowerCase())) continue;
      hits += 1;
      console.log(`${relative(root, file)}:${i + 1}: an email address that isn’t an example one`);
    }
    for (const pattern of denied) {
      const found = pattern.exec(line);
      if (found) {
        hits += 1;
        // Says which rule, not the line: this output may be shown somewhere public.
        console.log(`${relative(root, file)}:${i + 1}: denylisted (${pattern.source.slice(0, 24)})`);
      }
    }
  });
}
if (!denied.length) console.log(`! No denylist at ${denylistFile}: checked for secrets only.`);
if (hits) {
  console.error(`✗ ${hits} thing${hits === 1 ? '' : 's'} that mustn't be public.`);
  process.exit(1);
}
console.log(`✓ Nothing private in ${files.length} files.`);
