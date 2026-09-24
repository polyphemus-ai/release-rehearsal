#!/usr/bin/env node
// Installs a git pre-commit hook that runs the leak check, so nothing private reaches a commit in the
// first place — every commit to polyphemus is public. With your denylist at
// ~/.config/polyphemus-dev/leak-denylist.txt (or POLYPHEMUS_LEAK_DENYLIST), it checks for your own names,
// hosts and paths too. Run once per clone: node scripts/install-hooks.mjs
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const hooks = join(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(), 'hooks');
mkdirSync(hooks, { recursive: true });
const hook = join(hooks, 'pre-commit');
writeFileSync(hook, `#!/bin/sh\n# Installed by scripts/install-hooks.mjs: nothing private in a public commit.\nexec node scripts/leak-check.mjs\n`);
chmodSync(hook, 0o755);
console.log(`✓ Installed ${hook}: every commit runs the leak check first.`);
