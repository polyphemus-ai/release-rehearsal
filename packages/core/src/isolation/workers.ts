import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { PolyphemusError } from '../types.js';
import type { EgressProxy } from './egress.js';
import { ensureWorkerImage, WORKER_IMAGE } from './image.js';
import { runtimeRun, runtimeSpawn, shortHash, type ContainerRuntime } from './runtime.js';

// A worker: a container an agent's commands and file operations run in, with only what was granted
// mounted (docs/design/isolation.md). Folders are mounted at the same path they have on this computer,
// so paths in commands, output and messages mean the same thing on both sides.

export interface Mount {
  path: string;
  readOnly?: boolean;
}

/**
 * none: no network at all. granted: only the hosts in `hosts`, through polyphemus's proxy. open: any public
 * host through the same proxy — never this computer or the local network.
 */
export type WorkerNetwork = 'none' | 'granted' | 'open';

export interface WorkerSpec {
  /** What it's for (project, agent, run): the same key and settings reuse the same container. */
  key: string;
  mounts: Mount[];
  network: WorkerNetwork;
  /** What `granted` may reach: exact hosts, `*.example.com`, and `host:port` for ports other than 80 and 443. Changed without restarting the worker. */
  hosts?: string[];
  /** The project it works in, for saying where a refused connection came from. */
  project?: string | null;
  /** Where commands start when nothing else is said. */
  workdir: string;
}

export interface ExecOptions {
  cwd?: string;
  stdin?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /** stderr into stdout, in order, as a terminal would show it. */
  combine?: boolean;
  /** Stop collecting past this many bytes. */
  maxBytes?: number;
}

export interface ExecResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** Why it stopped early, when it did. */
  stopped?: 'timeout' | 'aborted';
}

/** A command left running in a worker (a preview's server): its output as it comes, and a way to stop it. */
export interface Started {
  onOutput(listener: (chunk: string) => void): void;
  /** Resolves with its exit code when it stops. */
  readonly exited: Promise<number | null>;
  stop(): Promise<void>;
}

export interface Worker {
  readonly name: string;
  readonly runtime: ContainerRuntime;
  readonly spec: WorkerSpec;
  exec(argv: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** Starts a command and leaves it running: stopping it stops everything it started. */
  start(argv: string[], opts?: { cwd?: string; env?: Record<string, string> }): Started;
  /** Whether a path is inside what this worker was granted (for writing: granted to write). */
  allows(path: string, write?: boolean): boolean;
  /** The mount a path is under — a folder the worker can't replace, so a root to read it from on this computer. */
  rootFor(path: string): string | undefined;
}

const LIMITS = ['--pids-limit', '1024', '--memory', '4g', '--cpus', '2'];

export class WorkerPool {
  private readonly workers = new Map<string, { worker: Promise<Worker>; used: number }>();
  private readonly sweep: NodeJS.Timeout;
  private swept: Promise<void> | undefined;

  constructor(
    private readonly runtime: () => ContainerRuntime | undefined,
    private readonly egress?: EgressProxy,
    private readonly idleMs = 30 * 60_000,
  ) {
    this.sweep = setInterval(() => void this.removeIdle(), 5 * 60_000);
    this.sweep.unref();
  }

  /** The worker for this spec: the running one when its settings match, otherwise a fresh one. */
  get(spec: WorkerSpec): Promise<Worker> {
    const runtime = this.runtime();
    if (!runtime) throw new PolyphemusError('There’s no container runtime on this computer (Docker or Podman), so nothing can run isolated.', 'FAILED');
    const name = `polyphemus-w-${shortHash(this.egress ? `${this.egress.scope}|${spec.key}` : spec.key)}`;
    // Any network goes through the proxy, on a socket of the worker's own; which hosts it may reach is
    // read on each connection, so a grant changing doesn't restart anything.
    const proxied = spec.network !== 'none';
    if (proxied) {
      if (!this.egress) throw new PolyphemusError('This worker needs network, and there’s no proxy for it to go through.', 'FAILED');
      this.egress.allow(name, spec.network === 'open' ? ['*'] : (spec.hosts ?? []), spec.project ?? null);
    }
    const hash = shortHash(JSON.stringify({ image: WORKER_IMAGE, mounts: spec.mounts, proxied, workdir: spec.workdir, uid: uid(), limits: LIMITS }));
    const id = `${name}:${hash}`;
    const known = this.workers.get(id);
    if (known) {
      known.used = Date.now();
      return known.worker;
    }
    const egress = this.egress;
    const scope = this.egress?.scope ?? '';
    this.swept ??= removeLeftovers(runtime);
    const swept = this.swept;
    const worker = (async () => {
      await swept;
      if (!proxied || !egress) return startWorker(runtime, name, hash, spec, undefined, scope);
      await egress.ensure(runtime);
      await egress.ready(runtime, name);
      return startWorker(runtime, name, hash, spec, egress, scope);
    })();
    worker.catch(() => this.workers.delete(id));
    this.workers.set(id, { worker, used: Date.now() });
    return worker;
  }

  async removeIdle(now = Date.now()): Promise<void> {
    const runtime = this.runtime();
    for (const [id, entry] of this.workers) {
      if (now - entry.used < this.idleMs) continue;
      this.workers.delete(id);
      const worker = await entry.worker.catch(() => undefined);
      if (worker && runtime && ![...this.workers.keys()].some((other) => other.startsWith(`${worker.name}:`))) {
        await runtimeRun(runtime, ['rm', '-f', worker.name], { timeoutMs: 30_000 });
        this.egress?.forget(worker.name);
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.sweep);
    const runtime = this.runtime();
    const all = [...this.workers.values()];
    this.workers.clear();
    if (!runtime) return;
    for (const entry of all) {
      const worker = await entry.worker.catch(() => undefined);
      if (worker) await runtimeRun(runtime, ['rm', '-f', worker.name], { timeoutMs: 30_000 });
    }
  }
}

const uid = () => `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;

/**
 * Workers from before they were named per install: nothing can use them again, and they'd never be
 * removed otherwise. This install's own are left alone — a terminal session and the daemon share them —
 * and one that matches is reused.
 */
async function removeLeftovers(runtime: ContainerRuntime): Promise<void> {
  const listed = await runtimeRun(runtime, ['ps', '-a', '--filter', 'label=polyphemus.worker=1', '--format', '{{.Names}} {{.Label "polyphemus.scope"}}'], { timeoutMs: 30_000 });
  if (listed.code !== 0) return;
  const stale = listed.stdout.split('\n').map((line) => line.trim().split(' ')).filter(([name, owner]) => name && (owner === undefined || owner === '' || owner === '<no')).map(([name]) => name!);
  if (stale.length) await runtimeRun(runtime, ['rm', '-f', ...stale], { timeoutMs: 60_000 });
}

async function startWorker(runtime: ContainerRuntime, name: string, hash: string, spec: WorkerSpec, egress: EgressProxy | undefined, scope: string): Promise<Worker> {
  const running = await runtimeRun(runtime, ['inspect', '--format', '{{.State.Running}} {{index .Config.Labels "polyphemus.hash"}}', name], { timeoutMs: 30_000 });
  const [isRunning, hasHash] = running.stdout.trim().split(' ');
  if (!(running.code === 0 && isRunning === 'true' && hasHash === hash)) {
    await ensureWorkerImage(runtime);
    await runtimeRun(runtime, ['rm', '-f', name], { timeoutMs: 30_000 });
    const proxy = egress?.workerArgs(runtime, name);
    const mounts = spec.mounts.filter((m) => isAbsolute(m.path) && existsSync(m.path));
    const args = [
      'run', '-d', '--name', name, '--init',
      '--label', 'polyphemus.worker=1', '--label', `polyphemus.hash=${hash}`, '--label', `polyphemus.scope=${scope}`, '--label', `polyphemus.key=${spec.key.slice(0, 200)}`,
      // Nothing it can raise itself to: no capabilities, no setuid, no writing outside its mounts and /tmp.
      '--read-only', '--tmpfs', '/tmp:exec,mode=1777', '--tmpfs', '/run',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', uid(), '--env', 'HOME=/tmp/home', '--env', 'LANG=C.UTF-8',
      // No network, ever: with a grant, its only way out is its socket to polyphemus's proxy.
      '--network', 'none',
      ...(proxy ? proxy.args : []),
      ...(proxy ? egress!.forwarderEnv() : []),
      ...LIMITS,
      ...mounts.flatMap((m) => ['--volume', `${m.path}:${m.path}${m.readOnly ? ':ro' : ''}`]),
      '--workdir', spec.workdir,
      WORKER_IMAGE, ...(proxy ? proxy.command : ['sleep', 'infinity']),
    ];
    const created = await runtimeRun(runtime, args, { timeoutMs: 120_000 });
    if (created.code !== 0) throw new PolyphemusError(`Couldn’t start a worker with ${runtime.name}: ${created.stderr.trim().split('\n').at(-1)}`, 'FAILED');
    await runtimeRun(runtime, ['exec', name, 'mkdir', '-p', '/tmp/home'], { timeoutMs: 30_000 });
  }
  return makeWorker(runtime, name, spec);
}

function makeWorker(runtime: ContainerRuntime, name: string, spec: WorkerSpec): Worker {
  return {
    name,
    runtime,
    spec,
    rootFor(path) {
      const under = spec.mounts.filter((m) => {
        const inside = relative(m.path, path);
        return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside));
      });
      return under.sort((a, b) => b.path.length - a.path.length)[0]?.path;
    },
    allows(path, write = false) {
      return spec.mounts.some((m) => {
        const inside = relative(m.path, path);
        return (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) && (!write || !m.readOnly);
      });
    },
    start(argv, opts = {}) {
      const id = randomUUID().replaceAll('-', '');
      const pidFile = `/tmp/.polyphemus-exec-${id}`;
      const child = runtimeSpawn(runtime, [
        'exec', '-i',
        '--workdir', opts.cwd ?? spec.workdir,
        ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
        name, 'setsid', '--wait', 'bash', '-c', 'echo $$ > "$0"; exec "$@" 2>&1', pidFile, ...argv,
      ]);
      child.stdin!.end();
      const listeners = new Set<(chunk: string) => void>();
      child.stdout!.on('data', (c: Buffer) => listeners.forEach((l) => l(c.toString('utf8'))));
      child.stderr!.on('data', (c: Buffer) => listeners.forEach((l) => l(c.toString('utf8'))));
      const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
      return {
        onOutput: (listener) => void listeners.add(listener),
        exited,
        async stop() {
          await runtimeRun(runtime, ['exec', name, 'bash', '-c', `kill -TERM -- -"$(cat ${pidFile})" 2>/dev/null; sleep 2; kill -KILL -- -"$(cat ${pidFile})" 2>/dev/null; rm -f ${pidFile}`], { timeoutMs: 30_000 });
          child.kill('SIGKILL');
          await exited;
        },
      };
    },
    exec(argv, opts = {}) {
      const id = randomUUID().replaceAll('-', '');
      const pidFile = `/tmp/.polyphemus-exec-${id}`;
      // Its own process group, remembered, so a timeout or a stop ends everything it started — killing
      // the runtime's client alone would leave the command running in the container.
      const inner = opts.combine ? 'echo $$ > "$0"; exec "$@" 2>&1' : 'echo $$ > "$0"; exec "$@"';
      const args = [
        'exec', '-i',
        '--workdir', opts.cwd ?? spec.workdir,
        ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
        name, 'setsid', '--wait', 'bash', '-c', inner, pidFile, ...argv,
      ];
      return new Promise<ExecResult>((resolve) => {
        const child = runtimeSpawn(runtime, args);
        const chunks: Buffer[] = [];
        let size = 0;
        let stderr = '';
        let stopped: ExecResult['stopped'];
        const max = opts.maxBytes ?? 8 * 1024 * 1024;
        child.stdout!.on('data', (c: Buffer) => {
          if (size < max) chunks.push(c);
          size += c.length;
        });
        child.stderr!.on('data', (c: Buffer) => {
          if (stderr.length < 64_000) stderr += c.toString('utf8');
        });
        const stop = (why: 'timeout' | 'aborted') => {
          stopped ??= why;
          void runtimeRun(runtime, ['exec', name, 'bash', '-c', `kill -KILL -- -"$(cat ${pidFile})" 2>/dev/null; rm -f ${pidFile}`], { timeoutMs: 15_000 }).finally(() => child.kill('SIGKILL'));
        };
        const timer = opts.timeoutMs ? setTimeout(() => stop('timeout'), opts.timeoutMs) : undefined;
        const onAbort = () => stop('aborted');
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        child.on('error', (err) => {
          stderr += err.message;
        });
        child.on('close', (code) => {
          if (timer) clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
          void runtimeRun(runtime, ['exec', name, 'rm', '-f', pidFile], { timeoutMs: 15_000 });
          resolve({ code, stdout: Buffer.concat(chunks), stderr, ...(stopped && { stopped }) });
        });
        child.stdin!.end(opts.stdin ?? '');
      });
    },
  };
}
