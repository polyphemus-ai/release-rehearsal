import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rename, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EGRESS_PROXY_SOURCE } from '../src/isolation/egress-proxy.js';
import { grantedHosts, normalizeHost, parseNetwork } from '../src/isolation/network.js';
import { containerRuntime, describeInContainers } from './containers.js';
import { Polyphemus, type RuntimeEvent } from '../src/polyphemus.js';
import { resolveModel } from '../src/config.js';
import { createProject } from '../src/projects.js';
import { emptyUsage, type ChatRequest, type ModelProvider, type ProviderEvent, type StopReason } from '../src/types.js';

// Network grants (docs/design/isolation.md, build step 3): what a person may grant, and the proxy that
// holds workers to it — run here as the real source, and then in a real worker where there's a runtime.

/** The container runtime, found directly: the suite turns polyphemus's own detection off. */
const runtime = containerRuntime;

describe('granting hosts', () => {
  it('takes a host however it’s typed, and refuses what can never be reached', () => {
    expect(normalizeHost('Registry.NPMjs.org')).toEqual({ host: 'registry.npmjs.org' });
    expect(normalizeHost('https://api.example.com/v1/things?x=1')).toEqual({ host: 'api.example.com' });
    expect(normalizeHost('https://example.com:8443/')).toEqual({ host: 'example.com:8443' });
    expect(normalizeHost('*.githubusercontent.com')).toEqual({ host: '*.githubusercontent.com' });
    expect(normalizeHost('example.com.')).toEqual({ host: 'example.com' });
    expect(normalizeHost('*')).toMatchObject({ error: expect.stringContaining('open network') });
    expect(normalizeHost('192.168.1.10')).toMatchObject({ error: expect.stringContaining('by name') });
    expect(normalizeHost('[fd00::1]:443')).toMatchObject({ error: expect.stringContaining('by name') });
    expect(normalizeHost('cafe.be')).toEqual({ host: 'cafe.be' });
    expect(normalizeHost('nas')).toMatchObject({ error: expect.stringContaining('your own network') });
    expect(normalizeHost('exa mple.com')).toMatchObject({ error: expect.any(String) });
    expect(normalizeHost('example.com:99999')).toMatchObject({ error: expect.any(String) });
  });

  it('adds up presets and hosts, and drops what it doesn’t recognise from storage', () => {
    expect(grantedHosts({ presets: ['github'], hosts: ['api.example.com'] })).toEqual(['*.githubusercontent.com', 'api.example.com', 'api.github.com', 'codeload.github.com', 'github.com']);
    expect(grantedHosts(undefined)).toEqual([]);
    expect(parseNetwork(JSON.stringify({ presets: ['github', 'everything'], hosts: ['example.com', '10.0.0.1'] }))).toEqual({ presets: ['github'], hosts: ['example.com'] });
    expect(parseNetwork(JSON.stringify({ presets: [], hosts: [] }))).toBeUndefined();
    expect(parseNetwork('not json')).toBeUndefined();
  });
});

describe('the proxy', () => {
  let proxy: ChildProcess | undefined;
  afterEach(() => proxy?.kill());

  async function startProxy(workers: Record<string, { hosts: string[]; project: string | null }>) {
    const dir = await mkdtemp(join(tmpdir(), 'polyphemus-egress-'));
    const policy = join(dir, 'policy.json');
    const sockets = join(dir, 'sockets');
    await mkdir(sockets);
    await writeFile(join(dir, 'proxy.mjs'), EGRESS_PROXY_SOURCE);
    const writePolicy = async (next: typeof workers) => {
      await writeFile(`${policy}.tmp`, JSON.stringify({ workers: next }));
      await rename(`${policy}.tmp`, policy);
    };
    await writePolicy(workers);
    const lines: Array<Record<string, unknown>> = [];
    proxy = spawn(process.execPath, [join(dir, 'proxy.mjs')], { env: { ...process.env, POLYPHEMUS_EGRESS_POLICY: policy, POLYPHEMUS_EGRESS_SOCKETS: sockets }, stdio: ['ignore', 'pipe', 'inherit'] });
    proxy.stdout!.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) lines.push(JSON.parse(line) as Record<string, unknown>);
    });
    const socket = (worker: string) => join(sockets, worker, 'proxy.sock');
    for (let i = 0; i < 50 && !Object.keys(workers).every((w) => existsSync(socket(w))); i++) await new Promise((r) => setTimeout(r, 100));
    /** A CONNECT through a worker's socket, and what came back within a moment. */
    const tunnel = (worker: string, target: string) =>
      new Promise<string>((resolve) => {
        const client = connect(socket(worker));
        let got = '';
        client.on('data', (c: Buffer) => (got += c.toString('utf8')));
        client.on('error', (err) => resolve(`error: ${err.message}`));
        client.on('close', () => resolve(got));
        client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
        setTimeout(() => (client.destroy(), resolve(got)), 1000);
      });
    return { tunnel, lines, socket, writePolicy };
  }

  it('lets a worker reach only what its project was granted, never a private address, and says what it refused', async () => {
    const { tunnel, lines } = await startProxy({
      'polyphemus-w-shop': { hosts: ['example.com', 'localhost', '1.1.1.1'], project: 'shop' },
      'polyphemus-w-blog': { hosts: [], project: 'blog' },
    });
    const notGranted = await tunnel('polyphemus-w-shop', 'www.example.org:443');
    expect(notGranted).toMatch(/^HTTP\/1\.1 403/);
    expect(notGranted).toContain('www.example.org isn’t granted to agents in this project');
    expect(await tunnel('polyphemus-w-shop', 'example.com:22')).toMatch(/^HTTP\/1\.1 403/);
    // Granted by name, but it's this computer: refused on where it points.
    expect(await tunnel('polyphemus-w-shop', 'localhost:443')).toContain('points at this computer or a private network');
    expect(await tunnel('polyphemus-w-shop', '127.0.0.1:443')).toMatch(/^HTTP\/1\.1 403/);
    expect(await tunnel('polyphemus-w-shop', '[::ffff:127.0.0.1]:443')).toMatch(/^HTTP\/1\.1 403/);
    // A public address isn't mistaken for a private one (Node's BlockList matches IPv4 against IPv4-mapped rules).
    expect(await tunnel('polyphemus-w-shop', '1.1.1.1:443')).not.toMatch(/^HTTP\/1\.1 403/);
    // Another worker's grant is its own.
    expect(await tunnel('polyphemus-w-blog', 'example.com:443')).toMatch(/^HTTP\/1\.1 403/);
    const refused = lines.filter((l) => l.refused);
    expect(refused).toContainEqual(expect.objectContaining({ worker: 'polyphemus-w-shop', project: 'shop', host: 'www.example.org', port: 443, refused: 'not granted' }));
    expect(refused).toContainEqual(expect.objectContaining({ worker: 'polyphemus-w-blog', project: 'blog', host: 'example.com', refused: 'not granted' }));
    expect(refused.some((l) => l.host === '1.1.1.1')).toBe(false);
  }, 30_000);

  it('opens a socket for a worker when it’s granted, and closes it when the worker’s gone', async () => {
    const { socket, writePolicy } = await startProxy({ 'polyphemus-w-shop': { hosts: ['example.com'], project: 'shop' } });
    expect(existsSync(socket('polyphemus-w-shop'))).toBe(true);
    await writePolicy({ 'polyphemus-w-docs': { hosts: [], project: 'docs' } });
    for (let i = 0; i < 30 && (existsSync(socket('polyphemus-w-shop')) || !existsSync(socket('polyphemus-w-docs'))); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(socket('polyphemus-w-shop'))).toBe(false);
    expect(existsSync(socket('polyphemus-w-docs'))).toBe(true);
  }, 30_000);
});

describeInContainers('a granted project, in a real worker', () => {
  it('reaches the proxy and nothing else, tells the agent what it has, and says in the thread what was refused', async () => {
    const home = await mkdtemp(join(tmpdir(), 'polyphemus-egress-home-'));
    const polyphemus = await Polyphemus.open(home);
    polyphemus.runtime = () => runtime;
    const { project } = await createProject(polyphemus.store, home, join(home, 'projects'), { name: 'Shop' });
    polyphemus.store.setProjectIsolation(project.slug, 'isolated');
    polyphemus.store.setProjectNetwork(project.slug, { presets: [], hosts: ['example.com'] });
    const results: string[] = [];
    let system = '';
    const calls = [{ name: 'bash', input: { command: 'echo "proxy=$HTTPS_PROXY"; getent hosts example.com || echo no-dns; curl -sS -m 10 https://www.example.org 2>&1 | head -2; curl -sS -m 5 --noproxy "*" https://example.com 2>&1 | head -1' } }];
    const provider: ModelProvider = {
      kind: 'model',
      id: 'openai',
      async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
        system = req.system ?? '';
        for (const block of req.messages.at(-1)?.content ?? []) if (block.type === 'tool_result') results.push(String(block.content));
        const next = calls.shift();
        const content = next ? [{ type: 'tool_call' as const, id: 'c1', name: next.name, input: next.input }] : [{ type: 'text' as const, text: 'done' }];
        yield { type: 'message_done', message: { role: 'assistant', content, origin: { provider: 'openai', model: req.model } }, stopReason: (next ? 'tool_use' : 'end_turn') as StopReason, usage: emptyUsage() };
      },
      listModels: async () => [],
    };
    polyphemus.registry.use('openai', provider);
    const session = polyphemus.newSession({ cwd: project.path, model: resolveModel(polyphemus.config, 'gpt-api') });
    session.autoApprove = true;
    const notices: string[] = [];
    session.on((event: RuntimeEvent) => event.type === 'notice' && notices.push(event.text));
    try {
      await session.send('fetch something');
      expect(system).toContain('Granted: example.com');
      expect(results[0]).toContain('proxy=http://127.0.0.1:3128');
      expect(results[0]).toContain('no-dns');
      expect(results[0]).toMatch(/CONNECT tunnel failed, response 403/);
      expect(results[0]).toMatch(/Could not resolve host|Couldn't resolve/);
      // The refusal reaches the thread as the proxy logs it.
      for (let i = 0; i < 30 && !notices.some((n) => n.includes('www.example.org')); i++) await new Promise((r) => setTimeout(r, 100));
      expect(notices).toContainEqual(expect.stringContaining('Blocked a connection to www.example.org: agents here aren’t granted it'));
      expect([...(polyphemus.refusedHosts.get(project.slug)?.keys() ?? [])]).toEqual(['www.example.org']);
    } finally {
      await polyphemus.workers.close();
      await polyphemus.egress.remove(runtime!);
      polyphemus.close();
    }
  }, 300_000);
});


describeInContainers('the Browser connection’s Chrome, in a worker', () => {
  it('starts in a worker with no folders, over the relay, and draws a page', async () => {
    const home = await mkdtemp(join(tmpdir(), 'polyphemus-browser-worker-'));
    const polyphemus = await Polyphemus.open(home);
    polyphemus.runtime = () => runtime;
    try {
      const browser = await polyphemus.openBrowser();
      const look = await browser.look('data:text/html,<title>Hello from a worker</title><h1>Hi</h1>', { width: 400 });
      expect(look.title).toBe('Hello from a worker');
      expect(look.png?.length).toBeGreaterThan(1000);
      const worker = await polyphemus.workers.get({ key: 'browser', mounts: [], network: 'open', project: null, workdir: '/tmp' });
      expect((await worker.exec(['bash', '-c', 'ls /home 2>&1; pgrep -c chromium'])).stdout.toString()).toMatch(/^\d+\n$/);
      await browser.close();
    } finally {
      await polyphemus.workers.close();
      await polyphemus.egress.remove(runtime!);
      polyphemus.close();
    }
  }, 900_000);
});
