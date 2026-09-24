import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** Set when the process couldn't be started at all (e.g. the CLI isn't installed). */
  spawnError?: Error;
}

export interface NdjsonOptions {
  cwd: string;
  /** Written to stdin, which is then closed. Omit to leave stdin closed. */
  input?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

const MAX_STDERR_CHARS = 64_000;
/** How long an interrupted CLI gets to wind down after SIGINT before it's terminated. */
const INTERRUPT_GRACE_MS = 3_000;

/**
 * Runs a CLI and yields each stdout line that parses as a JSON object. Returns
 * how the process exited. Aborting sends SIGINT first, since agent CLIs treat it
 * as "end the turn cleanly", and SIGTERM if the process is still running after a
 * grace period.
 */
export async function* ndjson(
  command: string,
  args: string[],
  opts: NdjsonOptions,
): AsyncGenerator<Record<string, unknown>, ProcessExit> {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    // Its own session, with no controlling terminal. An agent CLI (or a shell it starts) must
    // never read keystrokes from, or change the mode of, the terminal polyphemus is using.
    detached: process.platform !== 'win32',
  });

  const signalAll = (signal: NodeJS.Signals) => {
    try {
      // A negative pid targets the whole process group, so shells and tools the CLI started go too.
      if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // Already gone.
    }
  };

  // stdout and stderr are always piped (see stdio above), so they exist.
  const stdout = child.stdout!;
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString('utf8');
  });
  const exited = new Promise<ProcessExit>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stderr }));
    child.on('error', (spawnError) => resolve({ code: null, signal: null, stderr, spawnError }));
  });

  if (opts.input !== undefined) child.stdin?.end(opts.input);

  const interrupt = () => {
    signalAll('SIGINT');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) signalAll('SIGTERM');
    }, INTERRUPT_GRACE_MS).unref();
  };
  opts.signal?.addEventListener('abort', interrupt, { once: true });

  try {
    for await (const line of createInterface({ input: stdout, crlfDelay: Infinity })) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) yield parsed as Record<string, unknown>;
    }
    return await exited;
  } finally {
    opts.signal?.removeEventListener('abort', interrupt);
    // Don't leave the CLI, or anything it started, running after the turn.
    signalAll('SIGTERM');
  }
}

/** A short, readable reason for a failed CLI run. */
export function describeExit(command: string, exit: ProcessExit): string {
  if (exit.spawnError) {
    const notFound = (exit.spawnError as NodeJS.ErrnoException).code === 'ENOENT';
    return notFound ? `\`${command}\` isn't installed or isn't on PATH` : `couldn't start \`${command}\`: ${exit.spawnError.message}`;
  }
  const tail = exit.stderr.trim().split('\n').slice(-5).join('\n');
  const status = exit.signal ? `was killed by ${exit.signal}` : `exited with code ${exit.code}`;
  return `\`${command}\` ${status}${tail ? `:\n${tail}` : ''}`;
}
