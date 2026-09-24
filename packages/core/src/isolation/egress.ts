import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PolyphemusError } from '../types.js';
import { EGRESS_FORWARDER_SOURCE, EGRESS_MOUNT, EGRESS_PORT, EGRESS_PROXY_SOURCE } from './egress-proxy.js';
import { ensureWorkerImage, WORKER_IMAGE } from './image.js';
import { runtimeRun, runtimeSpawn, shortHash, type ContainerRuntime } from './runtime.js';

// Granted network for workers (docs/design/isolation.md): a worker has no network at all — not the
// internet, not this computer, not DNS, not other workers. Its one way out is a Unix socket to polyphemus's
// proxy, in a folder of a shared volume only it is given; a small forwarder inside it listens where
// HTTP(S)_PROXY points. The proxy lets each worker through to the hosts its project was granted.


interface PolicyEntry {
  hosts: string[];
  project: string | null;
}

export interface Refusal {
  worker: string;
  project: string | null;
  host: string;
  port: number;
  why: string;
  at: number;
}

export class EgressProxy {
  private readonly dir: string;
  /** Names polyphemus's containers for this install only: a second install (or a test) never touches this one's. */
  readonly scope: string;
  private readonly name: string;
  private readonly network: string;
  private readonly volume: string;
  private starting: Promise<void> | undefined;
  private logs: ChildProcess | undefined;
  private readonly listeners = new Set<(refusal: Refusal) => void>();

  constructor(home: string) {
    this.dir = join(home, 'isolation', 'egress');
    this.scope = shortHash(home).slice(0, 8);
    this.name = `polyphemus-egress-${this.scope}`;
    this.network = `polyphemus-egress-${this.scope}`;
    this.volume = `polyphemus-egress-${this.scope}`;
  }

  /** What a worker may reach from now on: takes effect on its next connection, with no restart. */
  allow(worker: string, hosts: string[], project: string | null): void {
    const all = this.read();
    const next: PolicyEntry = { hosts: [...new Set(hosts)].sort(), project };
    if (JSON.stringify(all[worker]) === JSON.stringify(next)) return;
    all[worker] = next;
    this.write(all);
  }

  /**
   * Waits for the proxy to open this worker's socket (it looks at the policy twice a second): a worker
   * mounts its folder, which has to exist first.
   */
  async ready(runtime: ContainerRuntime, worker: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const found = await runtimeRun(runtime, ['exec', this.name, 'test', '-S', `/sockets/${worker}/proxy.sock`], { timeoutMs: 15_000 });
      if (found.code === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new PolyphemusError('Polyphemus’s network proxy didn’t open a connection for this worker, so it wasn’t started with network.', 'FAILED');
  }

  /**
   * Waits for a new worker's forwarder to listen: the container runs before node inside it has started,
   * and a first `curl` in that gap failed with "Couldn't connect to server" (seen in CI, 2026-09-23).
   */
  async forwarding(runtime: ContainerRuntime, worker: string): Promise<void> {
    const check = `const net=require('node:net');const end=Date.now()+15000;(function t(){net.connect(${EGRESS_PORT},'127.0.0.1').on('connect',function(){this.destroy();process.exit(0)}).on('error',()=>Date.now()<end?setTimeout(t,100):process.exit(1))})()`;
    const found = await runtimeRun(runtime, ['exec', worker, 'node', '-e', check], { timeoutMs: 30_000 });
    if (found.code !== 0) throw new PolyphemusError('This worker’s connection to Polyphemus’s network proxy didn’t come up, so it wasn’t started with network.', 'FAILED');
  }

  /** How a worker is started to use the proxy: its own socket folder, and where its tools find the proxy. */
  workerArgs(runtime: ContainerRuntime, worker: string): { args: string[]; command: string[] } {
    const url = `http://127.0.0.1:${EGRESS_PORT}`;
    // Docker and Podman spell a volume's subfolder differently.
    const subpath = runtime.name === 'Podman' ? 'subpath' : 'volume-subpath';
    const env = { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1', NODE_USE_ENV_PROXY: '1', npm_config_proxy: url, npm_config_https_proxy: url };
    return {
      args: ['--mount', `type=volume,src=${this.volume},dst=${EGRESS_MOUNT},${subpath}=${worker}`, ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`])],
      // The forwarder, kept running beside the worker's usual idle process: if it's stopped, it comes back.
      command: ['bash', '-c', 'while :; do node -e "$POLYPHEMUS_FORWARDER" >/dev/null 2>&1; sleep 1; done & exec sleep infinity'],
    };
  }

  /** The forwarder's source, passed in the environment rather than a file: the worker's filesystem is read-only. */
  forwarderEnv(): string[] {
    return ['--env', `POLYPHEMUS_FORWARDER=${EGRESS_FORWARDER_SOURCE}`];
  }

  forget(worker: string): void {
    const all = this.read();
    if (!(worker in all)) return;
    delete all[worker];
    this.write(all);
  }

  /** Called with each connection the proxy refused. */
  onRefused(listener: (refusal: Refusal) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The networks and the proxy container exist and are current. */
  async ensure(runtime: ContainerRuntime): Promise<void> {
    this.starting ??= this.start(runtime).catch((err: unknown) => {
      this.starting = undefined;
      throw err;
    });
    await this.starting;
    // Following the logs stops if the proxy restarts: picked up again the next time a worker needs it.
    if (!this.logs) this.follow(runtime);
  }

  close(): void {
    this.logs?.kill();
    this.logs = undefined;
  }

  /** The proxy, its network and its sockets, gone: for a test's install, or one being removed. */
  async remove(runtime: ContainerRuntime): Promise<void> {
    this.close();
    this.starting = undefined;
    await runtimeRun(runtime, ['rm', '-f', this.name], { timeoutMs: 30_000 });
    await runtimeRun(runtime, ['network', 'rm', this.network], { timeoutMs: 30_000 });
    await runtimeRun(runtime, ['volume', 'rm', '-f', this.volume], { timeoutMs: 30_000 });
  }

  private async start(runtime: ContainerRuntime): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const script = join(this.dir, 'proxy.mjs');
    if (!existsSync(script) || readFileSync(script, 'utf8') !== EGRESS_PROXY_SOURCE) writeFileSync(script, EGRESS_PROXY_SOURCE, { mode: 0o600 });
    if (!existsSync(join(this.dir, 'policy.json'))) this.write({});
    await ensureWorkerImage(runtime);
    const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
    // Its own network, so nothing else of yours shares one with it.
    if ((await runtimeRun(runtime, ['network', 'inspect', this.network], { timeoutMs: 30_000 })).code !== 0) {
      const made = await runtimeRun(runtime, ['network', 'create', '--label', 'polyphemus.egress=1', this.network], { timeoutMs: 30_000 });
      if (made.code !== 0) throw new PolyphemusError(`Couldn’t create polyphemus’s proxy network with ${runtime.name}: ${made.stderr.trim().split('\n').at(-1)}`, 'FAILED');
    }
    // The sockets' volume, owned by you, so the proxy (running as you, with no capabilities) can use it.
    if ((await runtimeRun(runtime, ['volume', 'inspect', this.volume], { timeoutMs: 30_000 })).code !== 0) {
      await runtimeRun(runtime, ['volume', 'create', '--label', 'polyphemus.egress=1', this.volume], { timeoutMs: 30_000 });
      const owned = await runtimeRun(runtime, ['run', '--rm', '--network', 'none', '--volume', `${this.volume}:/sockets`, WORKER_IMAGE, 'chown', uid, '/sockets'], { timeoutMs: 60_000 });
      if (owned.code !== 0) {
        await runtimeRun(runtime, ['volume', 'rm', this.volume], { timeoutMs: 30_000 });
        throw new PolyphemusError(`Couldn’t prepare polyphemus’s proxy sockets with ${runtime.name}: ${owned.stderr.trim().split('\n').at(-1)}`, 'FAILED');
      }
    }
    const hash = shortHash(JSON.stringify({ image: WORKER_IMAGE, source: EGRESS_PROXY_SOURCE, dir: this.dir, uid }));
    const running = await runtimeRun(runtime, ['inspect', '--format', '{{.State.Running}} {{index .Config.Labels "polyphemus.hash"}}', this.name], { timeoutMs: 30_000 });
    if (running.stdout.trim() !== `true ${hash}`) {
      await runtimeRun(runtime, ['rm', '-f', this.name], { timeoutMs: 30_000 });
      const created = await runtimeRun(runtime, [
        'run', '-d', '--name', this.name, '--init', '--restart', 'unless-stopped',
        '--label', 'polyphemus.egress=1', '--label', `polyphemus.hash=${hash}`,
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', uid,
        '--pids-limit', '512', '--memory', '256m', '--cpus', '1',
        '--log-opt', 'max-size=5m',
        '--network', this.network,
        '--volume', `${this.dir}:/egress:ro`,
        '--volume', `${this.volume}:/sockets`,
        WORKER_IMAGE, 'node', '/egress/proxy.mjs',
      ], { timeoutMs: 60_000 });
      if (created.code !== 0) throw new PolyphemusError(`Couldn’t start polyphemus’s network proxy with ${runtime.name}: ${created.stderr.trim().split('\n').at(-1)}`, 'FAILED');
    }
  }

  /** Reads the proxy's refusals as they happen. */
  private follow(runtime: ContainerRuntime): void {
    this.logs?.kill();
    const child = runtimeSpawn(runtime, ['logs', '--follow', '--since', '1s', this.name]);
    child.stdin?.end();
    child.unref();
    this.logs = child;
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let entry: { at?: number; worker?: string; project?: string | null; host?: string; port?: number; refused?: string };
      try {
        entry = JSON.parse(line) as typeof entry;
      } catch {
        return;
      }
      if (!entry.refused || !entry.worker || !entry.host) return;
      const refusal: Refusal = { worker: entry.worker, project: entry.project ?? null, host: entry.host, port: entry.port ?? 0, why: entry.refused, at: entry.at ?? Date.now() };
      for (const listener of this.listeners) listener(refusal);
    });
    child.on('close', () => {
      if (this.logs === child) this.logs = undefined;
    });
  }

  private read(): Record<string, PolicyEntry> {
    try {
      return (JSON.parse(readFileSync(join(this.dir, 'policy.json'), 'utf8')) as { workers?: Record<string, PolicyEntry> }).workers ?? {};
    } catch {
      return {};
    }
  }

  private write(workers: Record<string, PolicyEntry>): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, 'policy.json');
    // Written whole and renamed into place: the proxy never reads half a policy.
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ workers }, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
}
