import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from './workers.js';

// Claude Code, isolated (docs/design/isolation.md): the CLI and its sign-in stay on this computer, and
// every shell command it runs goes to the project's worker. Claude Code hands each command to
// CLAUDE_CODE_SHELL_PREFIX as one string; the prefix is this wrapper. It also starts MCP servers
// through the prefix — polyphemus's own (approvals, the gateway) must run here, so they carry a nonce only
// polyphemus knows, in their environment, which no command the model writes can set before the wrapper
// decides. Its built-in file tools read this computer directly, so they're turned off and polyphemus's
// worker-backed ones are offered instead.

/** Claude Code's tools that touch this computer's files or network directly, not through the shell. */
export const CLAUDE_HOST_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'LS', 'WebFetch'];

export interface ShellWrapper {
  /** Environment for the CLI: the prefix. */
  env: Record<string, string>;
  /** Put in the environment of polyphemus's own MCP servers, so they start here, not in the worker. */
  hostNonce: string;
  /** How many commands went to the worker this turn. */
  runs(): number;
  close(): void;
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

export function claudeShellWrapper(worker: Worker): ShellWrapper {
  const dir = mkdtempSync(join(tmpdir(), 'polyphemus-claude-shell-')); // 0700
  const script = join(dir, 'shell.sh');
  const log = join(dir, 'runs.log');
  const nonce = randomBytes(18).toString('hex');
  const rt = quote(worker.runtime.command);
  const name = quote(worker.name);
  writeFileSync(
    script,
    `#!/bin/bash
# polyphemus: Claude Code's shell commands run in the project's worker (${worker.name}).
if [ "\${POLYPHEMUS_HOST_NONCE:-}" = ${quote(nonce)} ]; then exec /bin/bash -c "$1"; fi
cmd=$1
echo run >> ${quote(log)}
pidfile=/tmp/.polyphemus-cc-$$-$RANDOM
# Claude Code tracks the working directory in a file it reads back here: copy the worker's over.
cwdfile=$(printf '%s' "$cmd" | grep -oE '>\\| /tmp/claude-[A-Za-z0-9]+-cwd$' | sed 's/^>| //')
${rt} exec ${name} setsid --wait bash -c 'echo $$ > "$0"; cd "$1" 2>/dev/null || cd "$2"; eval "$3"' "$pidfile" "$PWD" ${quote(worker.spec.workdir)} "$cmd" &
child=$!
stop() { ${rt} exec ${name} bash -c 'kill -KILL -- -"$(cat "$0")" 2>/dev/null' "$pidfile"; kill "$child" 2>/dev/null; exit 143; }
trap stop TERM INT HUP
wait "$child"
code=$?
if [ -n "$cwdfile" ]; then ${rt} exec ${name} cat "$cwdfile" > "$cwdfile" 2>/dev/null; fi
${rt} exec ${name} rm -f "$pidfile" >/dev/null 2>&1
exit $code
`,
  );
  chmodSync(script, 0o700);
  return {
    env: { CLAUDE_CODE_SHELL_PREFIX: script },
    hostNonce: nonce,
    runs: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0),
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** What Claude Code is told, so it uses the tools that work and knows where it is. */
export const CLAUDE_ISOLATED_NOTE =
  'You are isolated: your Bash commands run in a container that has only this project’s folder and its memory — no home folder, no credentials, no other projects' +
  '. Your built-in Read, Write, Edit, Glob, Grep and WebFetch tools are turned off; use the read_file, write_file and edit_file tools from the polyphemus_connections server for files, and Bash (rg, find, cat) to search.';

export const WORKER_MARKER = 'polyphemus-worker: commands here run isolated';
