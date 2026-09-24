import { spawn } from 'node:child_process';
import { blockedMessage, credentialReferenceIn, mightReachCredentials, toolEnvironment } from './guard.js';
import { isReadOnlyCommand } from './readonly.js';
import { optionalInt, requireString, truncate, type Tool } from './tool.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Stop buffering past this; truncate() trims further before it reaches the model. */
const MAX_BUFFER_CHARS = 1_000_000;

export const bash: Tool = {
  spec: {
    name: 'bash',
    description:
      'Run a command with bash in the working directory. Returns combined stdout and stderr, followed by the exit status. ' +
      'Commands time out after timeout_ms (default 120000). There is no stdin, so avoid interactive commands.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run' },
        timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 120000, max 600000)' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  mutates: true,
  isReadOnly: (input) => typeof input.command === 'string' && isReadOnlyCommand(input.command) && !mightReachCredentials(input.command),
  describe: (input) => String(input.command ?? ''),
  run(input, ctx) {
    const command = requireString(input, 'command');
    const blocked = credentialReferenceIn(command);
    if (blocked) return Promise.resolve({ content: blockedMessage(blocked), isError: true });
    const timeout = Math.min(optionalInt(input.timeout_ms) ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    if (ctx.worker) {
      // Isolated: the command runs in the project's worker, with an empty environment.
      return ctx.worker.exec(['bash', '-c', command], { cwd: ctx.cwd, timeoutMs: timeout, signal: ctx.signal, combine: true, maxBytes: MAX_BUFFER_CHARS }).then((r) => {
        const status = r.stopped === 'aborted' ? 'interrupted by the user' : r.stopped === 'timeout' ? `killed (timeout after ${timeout}ms)` : `exit code ${r.code}`;
        const text = r.stdout.toString('utf8') + (r.code !== 0 && r.stderr && !r.stdout.length ? r.stderr : '');
        return { content: `${truncate(text.trimEnd())}\n[${status}]`.trimStart(), isError: r.code !== 0 };
      });
    }
    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', command], {
        cwd: ctx.cwd,
        env: ctx.env ?? toolEnvironment(),
        signal: ctx.signal,
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const collect = (chunk: Buffer) => {
        if (output.length < MAX_BUFFER_CHARS) output += chunk.toString('utf8');
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', (err) => {
        if (err.name !== 'AbortError') resolve({ content: `Failed to run command: ${err.message}`, isError: true });
      });
      child.on('close', (code, signal) => {
        const status = ctx.signal?.aborted
          ? 'interrupted by the user'
          : signal
            ? `killed by ${signal}${signal === 'SIGTERM' ? ` (timeout after ${timeout}ms?)` : ''}`
            : `exit code ${code}`;
        resolve({ content: `${truncate(output.trimEnd())}\n[${status}]`.trimStart(), isError: code !== 0 });
      });
    });
  },
};
