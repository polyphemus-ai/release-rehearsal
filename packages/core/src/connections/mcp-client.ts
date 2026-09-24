import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { browserClient } from './browser.js';
import type { Browser } from '../browser/chrome.js';
import type { KeptSignIn, SignInForTab } from './sign-ins.js';

// A small MCP client: enough of the protocol to list a server's tools and call them, over a local
// process (stdio) or a remote URL (streamable HTTP). Polyphemus is always the client — agents never
// reach a connection's server themselves — so this is the one place every call passes through.

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpCallResult {
  isError: boolean;
  text: string;
  /** Pictures it returned, as base64, with their type. */
  images?: Array<{ mediaType: string; data: string }>;
}

export type McpServerDefinition =
  | {
      kind: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      /**
       * oauth: signed in with OAuth. github-app: a GitHub App identity. Either way polyphemus hands the
       * server a short-lived ACCESS_TOKEN — never a refresh token, client secret or private key.
       */
      auth?: 'oauth' | 'github-app';
      /** One of polyphemus's own Google servers, signing in with your Google client. */
      google?: 'drive' | 'gmail';
      /** polyphemus's own X server, signing in with your X app. */
      x?: true;
      /** polyphemus's own GitHub server, as one of its GitHub App identities. */
      github?: 'planner' | 'builder' | 'reviewer';
    }
  | { kind: 'http'; url: string; headers?: Record<string, string>; /** Signs in with OAuth; the token is added when connecting. */ auth?: 'oauth' }
  /** Built into polyphemus and run inside it: no process, no address, no credential. */
  | { kind: 'builtin'; builtin: 'browser' | 'finance' | 'computer'; auth?: undefined };

/** An error from the server or the way to it, classified for the person who can fix it. */
export class McpError extends Error {
  constructor(
    message: string,
    /** auth: the credential was refused or has expired — reconnecting is the fix. */
    readonly kind: 'auth' | 'unavailable' | 'protocol' | 'tool',
  ) {
    super(message);
  }
}

const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 60_000;

/**
 * A credential problem, as opposed to one action the credential isn't allowed to take.
 * A 401, or a message that says the token is missing, expired or refused, is the sign-in.
 * A 403 that only says this call isn't allowed ("you may not delete this contact") is that call
 * (connections review, 2026-09-20). The HTTP status of reaching the server itself is separate:
 * a 403 there means the credential was refused before any call.
 */
const looksLikeAuth = (text: string) => /\b401\b|unauthori[sz]ed|expired|invalid (api )?(key|token)|authenticat/i.test(text);

/** What one answer from a server may be: enough for any real service, bounded for one that isn't. */
const MAX_RESULT_CHARS = 256 * 1024;
const MAX_TOOLS = 500;
const MAX_TOOL_PAGES = 20;

export interface McpClient {
  listTools(): Promise<McpTool[]>;
  /** The thread it's for, when a server keeps something per thread (the browser's tab). */
  callTool(name: string, args: Record<string, unknown>, ctx?: McpCallContext): Promise<McpCallResult>;
  close(): void;
  /** OAuth scopes the service reported for this credential, when it does (GitHub's X-OAuth-Scopes). */
  readonly scopes?: string[];
}

/** What a call is for, as far as a server needs to know. */
export interface McpCallContext {
  /** The thread it's for, when a server keeps something per thread (the browser's tab). */
  sessionId?: string;
  /** The agent calling: the computer is always its own. */
  agent?: string;
  /** The folder the calling thread works in: where files go in and out of a computer. */
  cwd?: string;
  /** Above cwd, a folder the agent can't replace: file moves are rooted there, never at cwd itself. */
  root?: string;
  /** The browser only: sign-ins this thread's browser starts with, and ones held back and why. */
  signIns?: SignInForTab[];
  heldBack?: Array<{ site: string; why: string }>;
}

export interface ConnectOptions {
  /** The browser only: a kept sign-in's cookies changed as it was used (the site refreshed them). */
  saveSignIn?(id: string, kept: KeptSignIn): void;
  /** The browser only: where its Chrome runs — a worker when this computer can make one. */
  openBrowser?(): Promise<Browser>;
  /** The browser only: whether there's one to use — Chromium in a worker, or a Chrome on this computer. */
  hasBrowser?(): boolean;
  /** Finance only: it runs inside polyphemus, so the manager hands it the vault rather than an environment. */
  financeClient?(): McpClient;
  /** The computer only: agents' own computers, which polyphemus runs. */
  computerClient?(): McpClient;
}

export async function connectMcp(def: McpServerDefinition, opts: ConnectOptions = {}): Promise<McpClient> {
  if (def.kind === 'builtin') return def.builtin === 'finance' ? opts.financeClient!() : def.builtin === 'computer' ? opts.computerClient!() : browserClient(opts);
  const client = def.kind === 'stdio' ? new StdioClient(def) : new HttpClient(def);
  await client.initialize();
  return client;
}

abstract class JsonRpcClient implements McpClient {
  protected nextId = 1;
  abstract request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  abstract notify(method: string, params?: Record<string, unknown>): Promise<void>;
  abstract close(): void;

  async initialize(): Promise<void> {
    await this.request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'polyphemus', version: '0.1.0' } });
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...((result.tools as McpTool[] | undefined) ?? []));
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : undefined;
      // A server that keeps handing out another page, or a list nobody could grant from, is one
      // polyphemus stops reading rather than following for ever (connections review, 2026-09-20).
      if (++pages >= MAX_TOOL_PAGES || tools.length >= MAX_TOOLS) break;
    } while (cursor);
    return tools.slice(0, MAX_TOOLS);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args });
    const content = (result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }> | undefined) ?? [];
    const whole = content.filter((block) => block.type !== 'image').map((block) => (block.type === 'text' ? (block.text ?? '') : `[${block.type}]`)).join('\n');
    // What comes back is the service's, not polyphemus's: kept to what a model could read anyway, so a
    // huge answer doesn't have to be held, masked and stored whole.
    const text = whole.length > MAX_RESULT_CHARS ? `${whole.slice(0, MAX_RESULT_CHARS)}\n[${name} returned ${Math.round(whole.length / 1024)} KB; polyphemus kept the first ${Math.round(MAX_RESULT_CHARS / 1024)} KB]` : whole;
    const images = content.filter((block) => block.type === 'image' && typeof block.data === 'string').map((block) => ({ mediaType: String(block.mimeType ?? 'image/png'), data: block.data! }));
    return { isError: result.isError === true, text, ...(images.length && { images }) };
  }

  protected fail(error: { message?: string; code?: number } | undefined, method?: string): never {
    const message = error?.message ?? 'The server returned an error.';
    // A stale credential shows up as a 401 from the tool call that used it, so that's read as the
    // connection's problem and put in Waiting on you for its owner. A 403 about one action is not:
    // that call fails, and the sign-in stays as it was (connections review, 2026-09-20).
    void method;
    throw new McpError(message, looksLikeAuth(message) ? 'auth' : 'protocol');
  }
}

class StdioClient extends JsonRpcClient {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { method: string; resolve(value: Record<string, unknown>): void; reject(err: Error): void }>();
  private stderr = '';

  constructor(def: Extract<McpServerDefinition, { kind: 'stdio' }>) {
    super();
    // The server gets the credentials it was given and a plain PATH — not everything polyphemus can see.
    this.child = spawn(def.command, def.args ?? [], {
      cwd: def.cwd,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...def.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (chunk: Buffer) => (this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2000)));
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        return; // servers sometimes log to stdout; ignore what isn't JSON-RPC
      }
      if (typeof message.id !== 'number') return;
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) {
        try {
          this.fail(message.error, waiting.method);
        } catch (err) {
          waiting.reject(err as Error);
        }
      } else waiting.resolve(message.result ?? {});
    });
    const dead = (why: string) => {
      const detail = this.stderr.trim().split('\n').slice(-3).join(' ');
      for (const waiting of this.pending.values()) waiting.reject(new McpError(`${why}${detail ? `: ${detail}` : ''}`, looksLikeAuth(detail) ? 'auth' : 'unavailable'));
      this.pending.clear();
    };
    this.child.on('error', (err) => dead(`Couldn’t start ${def.command} (${err.message})`));
    this.child.on('exit', (code) => dead(`The server stopped (exit ${code})`));
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`No answer to ${method} within ${TIMEOUT_MS / 1000}s.`, 'unavailable'));
      }, TIMEOUT_MS);
      this.pending.set(id, {
        method,
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (err) => (clearTimeout(timer), reject(err)),
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close(): void {
    this.child.kill();
  }
}

class HttpClient extends JsonRpcClient {
  private session?: string;
  scopes?: string[];

  constructor(private readonly def: Extract<McpServerDefinition, { kind: 'http' }>) {
    super();
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.def.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': PROTOCOL_VERSION,
          ...(this.session && { 'mcp-session-id': this.session }),
          ...this.def.headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new McpError(`Couldn’t reach ${new URL(this.def.url).host}: ${(err as Error).message}`, 'unavailable');
    }
    if (res.status === 401 || res.status === 403) throw new McpError(`${new URL(this.def.url).host} refused the credential (${res.status}).`, 'auth');
    if (!res.ok && res.status !== 202) throw new McpError(`${new URL(this.def.url).host} answered ${res.status}.`, 'unavailable');
    this.session = res.headers.get('mcp-session-id') ?? this.session;
    const scopes = res.headers.get('x-oauth-scopes');
    if (scopes !== null) this.scopes = scopes.split(',').map((s) => s.trim()).filter(Boolean);
    return res;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params });
    const type = res.headers.get('content-type') ?? '';
    const messages: Array<{ id?: number; result?: Record<string, unknown>; error?: { message?: string } }> = [];
    if (type.includes('text/event-stream')) {
      // A stream of events: read until the one that answers this request.
      for (const chunk of (await res.text()).split(/\n\n/)) {
        const data = chunk.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
        if (data) messages.push(JSON.parse(data));
      }
    } else {
      const parsed = await res.json();
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
    const answer = messages.find((m) => m.id === id);
    if (!answer) throw new McpError(`No answer to ${method}.`, 'protocol');
    if (answer.error) this.fail(answer.error, method);
    return answer.result ?? {};
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    // Stateless over HTTP from our side; the server times its session out.
  }
}
