import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { PolyphemusError } from '../types.js';
import { runtimeRun, runtimeSpawn } from '../isolation/runtime.js';
import type { Worker } from '../isolation/workers.js';
import { EGRESS_PORT } from '../isolation/egress-proxy.js';
import { openTab, type Tab, type TabOptions } from './tab.js';

// A browser polyphemus drives itself, to look at what a workflow built (computer-use.md, browser first).
// It's the Chrome already on the machine, headless, with a throwaway profile — none of your cookies
// or logins — spoken to over its DevTools pipe, so there's no port for anything else to reach and
// no library to install. It only opens pages and takes pictures: no model drives it.

const CANDIDATES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

/** Where Chrome is on this machine, if it's there: POLYPHEMUS_CHROME, then the usual names. */
export function findChrome(): string | undefined {
  const given = process.env.POLYPHEMUS_CHROME;
  if (given) return existsSync(given) ? given : undefined;
  for (const name of CANDIDATES) {
    if (name.startsWith('/')) {
      if (existsSync(name)) return name;
    } else if (spawnSync('which', [name], { stdio: 'ignore' }).status === 0) return name;
  }
  return undefined;
}

export interface PageLook {
  url: string;
  width: number;
  scheme: 'light' | 'dark';
  /** The page's own HTTP status, when it answered. */
  status?: number;
  title: string;
  /** Why it didn't load, or what went wrong on it: failed navigation, uncaught errors, console errors. */
  problems: string[];
  /** A PNG of the whole page, as tall as it is (up to a cap). */
  png?: Buffer;
}

type Message = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };

export class Pipe {
  private next = 1;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(m: Message) => void>();
  private buffer = '';

  constructor(
    private readonly out: Writable,
    input: Readable,
  ) {
    input.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let end: number;
      while ((end = this.buffer.indexOf('\0')) >= 0) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        let message: Message;
        try {
          message = JSON.parse(raw) as Message;
        } catch {
          continue;
        }
        if (message.id !== undefined && this.waiting.has(message.id)) {
          const pending = this.waiting.get(message.id)!;
          this.waiting.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result ?? {});
        } else for (const listener of this.listeners) listener(message);
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) })}\0`);
    });
  }

  on(listener: (m: Message) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  failAll(error: Error): void {
    for (const pending of this.waiting.values()) pending.reject(error);
    this.waiting.clear();
  }
}

export const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`)), ms).unref())]);

export interface Browser {
  look(url: string, opts: { width: number; height?: number; scheme?: 'light' | 'dark'; timeoutMs?: number }): Promise<PageLook>;
  /** A tab of its own, in a browser context of its own: no cookies or storage shared with any other. */
  tab(opts?: TabOptions): Promise<Tab>;
  /** False once Chrome has stopped. */
  alive(): boolean;
  close(): Promise<void>;
}

/**
 * Inside a worker, Chromium is started by this relay, which passes the DevTools pipe (Chrome's fds 3
 * and 4) over its own stdin and stdout — the only streams a container exec carries. Chrome stops when
 * polyphemus's end goes away.
 */
const RELAY = `const { spawn } = require('node:child_process');
const child = spawn('chromium', JSON.parse(process.argv[1]), { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write(d));
process.stdin.pipe(child.stdio[3]);
child.stdio[4].pipe(process.stdout);
process.stdin.on('end', () => child.kill('SIGKILL'));
child.on('exit', (code) => process.exit(code ?? 0));`;

/**
 * Starts headless Chrome. Close it when done: it's a process of its own. With a worker, it's the
 * worker's Chromium, reaching the web only through polyphemus's proxy (and the worker's own loopback, where
 * a preview runs); without one, the Chrome on this computer.
 */
/**
 * A person signing in by hand gets a real window on their own screen, when there's a screen to put it
 * on: headless Chrome says so in its own user agent, and a site's "verify you are human" check refuses
 * it however the person clicks (2026-09-22, Cloudflare on Garmin's sign-in). With no screen, or if the
 * window won't open, it's headless as before — the check may then be unanswerable, which is the site's
 * call, not something polyphemus works around.
 */
export async function openBrowser(opts: { chrome?: string; worker?: Worker; headful?: boolean } = {}): Promise<Browser> {
  const wantsWindow = opts.headful === true && !opts.worker && Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY);
  if (!wantsWindow) return startBrowser(opts, false);
  return startBrowser(opts, true).catch(() => startBrowser(opts, false));
}

async function startBrowser(opts: { chrome?: string; worker?: Worker }, headful: boolean): Promise<Browser> {
  const worker = opts.worker;
  const chrome = worker ? 'chromium' : (opts.chrome ?? findChrome());
  if (!chrome) throw new PolyphemusError('There’s no Chrome or Chromium on this machine to look at pages with. Install one, or set POLYPHEMUS_CHROME to where it is.', 'USAGE');
  const profile = worker ? `/tmp/polyphemus-browser-${Math.random().toString(36).slice(2)}` : mkdtempSync(join(tmpdir(), 'polyphemus-browser-'));
  const args = [
    ...(headful ? ['--window-size=1280,900'] : ['--headless=new']),
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--mute-audio',
    '--hide-scrollbars',
    // Chrome's own sandbox needs privileges a service or a container often doesn't have; the page is
    // the project's own site, in a throwaway profile.
    '--no-sandbox',
    ...(worker
      ? [
          // A container's /dev/shm is small, and there's no GPU or crash reporter to talk to.
          '--disable-dev-shm-usage', '--disable-gpu', '--disable-crash-reporter',
          // Its only way out; loopback (a preview in the same worker) is reached directly.
          ...(worker.spec.network !== 'none' ? [`--proxy-server=http://127.0.0.1:${EGRESS_PORT}`] : []),
        ]
      : []),
    'about:blank',
  ];
  const child: ChildProcess = worker
    ? runtimeSpawn(worker.runtime, ['exec', '-i', worker.name, 'node', '-e', RELAY, JSON.stringify(args)])
    : spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => (stderr = (stderr + c.toString('utf8')).slice(-2000)));
  const pipe = worker ? new Pipe(child.stdin as Writable, child.stdout as Readable) : new Pipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
  const removeProfile = () => (worker ? void runtimeRun(worker.runtime, ['exec', worker.name, 'rm', '-rf', profile], { timeoutMs: 30_000 }) : rmSync(profile, { recursive: true, force: true }));
  let running = true;
  const gone = new Promise<void>((resolve) => child.once('exit', () => ((running = false), resolve())));
  void gone.then(() => pipe.failAll(new Error(`Chrome stopped${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`)));
  child.once('error', (err) => pipe.failAll(err));
  try {
    // A first start in a fresh profile on a busy two-core computer took over 20s (CI, 2026-09-23); a
    // longer wait costs nothing when Chrome is quick, and only delays the failure when it isn't.
    await within(pipe.send('Browser.getVersion'), 60_000, 'Starting Chrome');
  } catch (err) {
    child.kill('SIGKILL');
    removeProfile();
    throw new PolyphemusError(`Chrome didn’t start: ${(err as Error).message}`, 'FAILED');
  }

  async function look(url: string, o: { width: number; height?: number; scheme?: 'light' | 'dark'; timeoutMs?: number }): Promise<PageLook> {
    const scheme = o.scheme ?? 'light';
    const height = o.height ?? (o.width < 600 ? 860 : 900);
    const result: PageLook = { url, width: o.width, scheme, title: '', problems: [] };
    const { targetId } = await pipe.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await pipe.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method: string, params: Record<string, unknown> = {}) => pipe.send(method, params, sessionId);
    let inflight = 0;
    let lastActivity = Date.now();
    let loaded!: () => void;
    const loadFired = new Promise<void>((resolve) => (loaded = resolve));
    let documentRequest: string | undefined;
    const off = pipe.on((m) => {
      if (m.sessionId !== sessionId) return;
      const p = m.params ?? {};
      switch (m.method) {
        case 'Page.loadEventFired':
          loaded();
          break;
        case 'Network.requestWillBeSent':
          inflight += 1;
          lastActivity = Date.now();
          if (p.type === 'Document' && !documentRequest) documentRequest = p.requestId;
          break;
        case 'Network.responseReceived':
          if (p.requestId === documentRequest) result.status = p.response?.status;
          // A site without a favicon isn't broken.
          else if (p.response?.status >= 400 && !/\/favicon\.ico(\?|$)/.test(p.response.url)) result.problems.push(`${p.response.status} for ${p.response.url}`);
          break;
        case 'Network.loadingFinished':
          inflight = Math.max(0, inflight - 1);
          lastActivity = Date.now();
          break;
        case 'Network.loadingFailed':
          inflight = Math.max(0, inflight - 1);
          lastActivity = Date.now();
          if (!p.canceled && p.requestId !== documentRequest) result.problems.push(`Couldn’t load a ${String(p.type ?? 'resource').toLowerCase()}: ${p.errorText}`);
          break;
        case 'Runtime.exceptionThrown': {
          const d = p.exceptionDetails ?? {};
          result.problems.push(`Uncaught: ${d.exception?.description?.split('\n')[0] ?? d.text ?? 'an error'}`);
          break;
        }
        case 'Runtime.consoleAPICalled':
          if (p.type === 'error') result.problems.push(`Console error: ${(p.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
          break;
      }
    });
    try {
      await Promise.all([send('Page.enable'), send('Runtime.enable'), send('Network.enable')]);
      await send('Emulation.setDeviceMetricsOverride', { width: o.width, height, deviceScaleFactor: 1, mobile: o.width < 600 });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      const timeoutMs = o.timeoutMs ?? 30_000;
      const nav = await send('Page.navigate', { url });
      // An error page still draws, so it's still worth a picture; a page that never answered doesn't.
      if (nav.errorText && result.status === undefined) {
        result.problems.unshift(`It didn’t load: ${nav.errorText}`);
        return result;
      }
      try {
        await within(loadFired, timeoutMs, 'Loading the page');
      } catch (err) {
        result.problems.push((err as Error).message);
      }
      // Settled: nothing loading for half a second, or five seconds, whichever comes first.
      const settleBy = Date.now() + 5000;
      while (Date.now() < settleBy && (inflight > 0 || Date.now() - lastActivity < 500)) await new Promise((r) => setTimeout(r, 100));
      if (result.status !== undefined && result.status >= 400) result.problems.unshift(`The page answered ${result.status}.`);
      result.title = String((await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result?.value ?? '');
      const metrics = await send('Page.getLayoutMetrics');
      const full = Math.ceil(metrics.cssContentSize?.height ?? metrics.contentSize?.height ?? height);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: o.width, height: Math.min(Math.max(full, height), 12_000), scale: 1 } });
      result.png = Buffer.from(String(shot.data), 'base64');
      return result;
    } finally {
      off();
      result.problems = [...new Set(result.problems)].slice(0, 20);
      await pipe.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
  }

  return {
    look,
    tab: (o) => openTab(pipe, o),
    alive: () => running,
    async close() {
      await within(pipe.send('Browser.close'), 5000, 'Closing Chrome').catch(() => child.kill('SIGKILL'));
      await within(gone, 5000, 'Chrome exiting').catch(() => child.kill('SIGKILL'));
      removeProfile();
    },
  };
}
