#!/usr/bin/env node
// Makes the public copy of polyphemus: the last commit's files, minus what stays private, checked for
// leaks against the denylist (which must be there), in a fresh folder — never this repository's
// history. With --commit it becomes a new git repository with one commit, ready to push.
//
//   node scripts/export-public.mjs <folder> [--commit --author "Name <email>"]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// One list, so what the leak check skips here is exactly what never leaves this repository.
import { PRIVATE } from './private-files.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const dest = args[0] && !args[0].startsWith('--') ? resolve(args[0]) : undefined;
const commit = args.includes('--commit');
const author = args.includes('--author') ? args[args.indexOf('--author') + 1] : undefined;
if (!dest) {
  console.error('Usage: node scripts/export-public.mjs <folder> [--commit --author "Name <email>"]');
  process.exit(2);
}
if (commit && !/^[^<>]+ <[^<>@\s]+@[^<>\s]+>$/.test(author ?? '')) {
  console.error('--commit needs --author "Name <email>": the public repository’s first commit is signed by whoever publishes it, not by this one’s history.');
  process.exit(2);
}
if (existsSync(dest) && readdirSync(dest).length) {
  console.error(`${dest} isn’t empty. Export into a new folder.`);
  process.exit(2);
}


mkdirSync(dest, { recursive: true });
// The committed files only: nothing uncommitted, nothing ignored, no history.
execFileSync('sh', ['-c', `git -C "${root}" archive --format=tar HEAD | tar -x -C "${dest}"`]);
for (const path of PRIVATE) rmSync(join(dest, path), { recursive: true, force: true });

try {
  execFileSync(process.execPath, [join(root, 'scripts', 'leak-check.mjs'), dest, '--require-denylist'], { stdio: 'inherit' });
} catch {
  rmSync(dest, { recursive: true, force: true });
  console.error('✗ Not exported: fix what the leak check found, commit, and run this again.');
  process.exit(1);
}

if (commit) {
  const [, name, email] = /^([^<>]+) <([^<>]+)>$/.exec(author);
  const git = (...a) => execFileSync('git', ['-C', dest, ...a], { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, GIT_AUTHOR_NAME: name.trim(), GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name.trim(), GIT_COMMITTER_EMAIL: email } });
  git('init', '--quiet', '--initial-branch=main');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'polyphemus: the first public commit');
  console.log(`✓ ${dest} is a new repository with one commit, by ${author}. Add a remote and push when you’re ready.`);
} else {
  console.log(`✓ Exported to ${dest}. Nothing is committed: run again with --commit --author "Name <email>" to make it a repository.`);
}
