#!/usr/bin/env node
// Launcher. Installed from npm, it runs the built bundle beside it (lib/main.mjs). From the
// repository there's no build: it runs the TypeScript entrypoint through tsx. Either way it hides the
// ExperimentalWarning that node:sqlite prints on Node 22.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const built = fileURLToPath(new URL('../lib/main.mjs', import.meta.url));
const args = existsSync(built)
  ? ['--disable-warning=ExperimentalWarning', built]
  : ['--disable-warning=ExperimentalWarning', '--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/main.ts', import.meta.url))];

const child = spawn(process.execPath, [...args, ...process.argv.slice(2)], { stdio: 'inherit' });

// Ctrl+C belongs to the child (it interrupts the current turn), not the launcher.
process.on('SIGINT', () => {});
// Anything else that stops the launcher (kill, a service manager, a closed terminal) stops polyphemus
// too, instead of leaving it running on its own.
for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  // Said, not only returned: a service log that reads "exit 1" says nothing about what happened.
  if (signal) console.error(`polyphemus was stopped by ${signal} before it had finished`);
  process.exit(code ?? (signal ? 1 : 0));
});
