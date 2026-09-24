import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';

// The container runtime workers run in (docs/design/isolation.md). Polyphemus speaks the Docker CLI's
// language, so Docker and Podman both work; which one, and whether it's rootless, is said to the owner.

export interface ContainerRuntime {
  /** docker or podman: the command polyphemus runs. */
  command: string;
  name: 'Docker' | 'Podman';
  version: string;
  /** Rootless: the runtime can't hand out more than the owner has. Rootful Docker's socket is root. */
  rootless: boolean;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

let detected: { at: number; runtime: ContainerRuntime | undefined } | undefined;

/** The runtime on this computer, if one is installed and answering. Checked again every few minutes. */
export function detectRuntime(opts: { refresh?: boolean; candidates?: string[] } = {}): ContainerRuntime | undefined {
  // "off": never use one, even where it's installed — for a test suite, or an install that mustn't.
  if (!opts.candidates && process.env.POLYPHEMUS_CONTAINER_RUNTIME === 'off') return undefined;
  if (!opts.refresh && !opts.candidates && detected && Date.now() - detected.at < 5 * 60_000) return detected.runtime;
  let found: ContainerRuntime | undefined;
  for (const command of opts.candidates ?? [process.env.POLYPHEMUS_CONTAINER_RUNTIME ?? '', 'docker', 'podman'].filter(Boolean)) {
    const version = spawnSync(command, ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 10_000 });
    if (version.status !== 0 || !version.stdout.trim()) continue;
    const info = spawnSync(command, ['info', '--format', '{{json .SecurityOptions}}'], { encoding: 'utf8', timeout: 10_000 });
    const podman = command.endsWith('podman') || /podman/i.test(spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 }).stdout ?? '');
    const rootless = /rootless/.test(info.stdout ?? '') || (podman && process.getuid?.() !== 0);
    found = { command, name: podman ? 'Podman' : 'Docker', version: version.stdout.trim(), rootless };
    break;
  }
  if (!opts.candidates) detected = { at: Date.now(), runtime: found };
  return found;
}

/** Runs the runtime's CLI to completion. */
export function runtimeRun(runtime: ContainerRuntime, args: string[], opts: { stdin?: string | Buffer; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(runtime.command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: runtimeEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined;
    child.on('error', (err) => resolve({ code: null, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    // A command that's done before its input is closed (docker ps) would raise EPIPE, unhandled.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin ?? '');
  });
}

/** Starts the runtime's CLI and hands back the process, for output that streams. */
export function runtimeSpawn(runtime: ContainerRuntime, args: string[]): ChildProcess {
  return spawn(runtime.command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: runtimeEnv() });
}

/** Only what the runtime's own CLI needs to find its daemon: nothing of polyphemus's. */
function runtimeEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR', 'CONTAINER_HOST', 'LANG'];
  return Object.fromEntries(keep.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));
}

export const shortHash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
