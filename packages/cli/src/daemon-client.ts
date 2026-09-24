import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PolyphemusError, type Asker, type Effort, type ImageBlock, type Message, type ResolvedModel, type RuntimeEvent, type SessionMeta, type StopReason } from '@polyphemus/core';

// The terminal as a client of the daemon on this computer: when the daemon is running, sessions
// started in the terminal run there, so the terminal and your phone share one live session.

/** What the terminal needs from a session, whether it runs in this process or in the daemon. */
export interface ReplSession {
  model: ResolvedModel;
  autoApprove: boolean;
  effort?: Effort;
  meta: SessionMeta | null;
  history: Message[];
  readonly alwaysAllow: Set<string>;
  asker?: Asker;
  on(listener: (event: RuntimeEvent) => void): () => void;
  /** `images` are already saved in ~/.polyphemus/uploads (attachImageFile). */
  send(input: string, signal?: AbortSignal, images?: ImageBlock[]): Promise<StopReason>;
  switchModel(model: ResolvedModel): void | Promise<void>;
  statusRows(): Array<[string, string]> | Promise<Array<[string, string]>>;
  rename(title: string): void | Promise<void>;
  close(): void;
}

/** What comes down the daemon's event stream, plus our own connection notices. */
type DaemonEvent = { type?: string; sessionId?: string; event?: RuntimeEvent; id?: string; [key: string]: unknown };

/** The status block polyphemus adds to a message. */
const STATUS_LINE = /<polyphemus_status>[\s\S]*?<\/polyphemus_status>\s*/g;

export class DaemonClient {
  private readonly listeners = new Set<(data: DaemonEvent) => void>();
  private readonly stream = new AbortController();

  private constructor(
    readonly base: string,
    private readonly token: string,
  ) {}

  /** The daemon on this computer, if it's running and has left us its key; otherwise undefined. */
  static async connect(home: string, port: number): Promise<DaemonClient | undefined> {
    const file = join(home, 'daemon-token');
    if (!existsSync(file)) return undefined;
    const client = new DaemonClient(`http://127.0.0.1:${port}`, readFileSync(file, 'utf8').trim());
    try {
      await client.request('GET', '/api/state');
      await client.listen();
    } catch {
      client.close();
      return undefined;
    }
    return client;
  }

  async request<T = Record<string, any>>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(method === 'POST' && { 'content-type': 'application/json' }) },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new PolyphemusError(`Couldn’t reach the polyphemus daemon (${(err as Error).message}).`, 'FAILED', 'poly service status');
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new PolyphemusError(data.error ?? `The daemon answered ${res.status}.`, res.status === 404 ? 'NOT_FOUND' : res.status === 409 ? 'CONFLICT' : 'FAILED');
    return data as T;
  }

  on(listener: (data: DaemonEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.stream.abort();
    this.listeners.clear();
  }

  private emit(data: DaemonEvent): void {
    for (const listener of this.listeners) listener(data);
  }

  /** Opens the daemon's event stream and keeps it open (reconnecting) while the terminal runs. Resolves once it's open. */
  private listen(): Promise<void> {
    return new Promise((opened, failed) => {
      let first = true;
      void (async () => {
        let delay = 500;
        while (!this.stream.signal.aborted) {
          try {
            const res = await fetch(`${this.base}/api/events`, { headers: { authorization: `Bearer ${this.token}` }, signal: this.stream.signal });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            if (first) opened();
            else this.emit({ type: 'reconnected' });
            first = false;
            delay = 500;
            const decoder = new TextDecoder();
            let buffer = '';
            for await (const chunk of res.body) {
              buffer += decoder.decode(chunk, { stream: true });
              for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const data = frame
                  .split('\n')
                  .filter((line) => line.startsWith('data: '))
                  .map((line) => line.slice(6))
                  .join('\n');
                if (data) this.emit(JSON.parse(data) as DaemonEvent);
              }
            }
          } catch (err) {
            if (first) return failed(err);
          }
          if (this.stream.signal.aborted) return;
          this.emit({ type: 'disconnected' });
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 10_000);
        }
      })();
    });
  }
}

/**
 * A session that runs in the daemon, driven from the terminal. Events stream in from the daemon
 * (whoever started the turn), questions are asked here while this terminal has a turn going, and
 * whichever device answers first wins.
 */
export class RemoteSession implements ReplSession {
  meta: SessionMeta | null;
  history: Message[];
  model: ResolvedModel;
  readonly alwaysAllow = new Set<string>();
  asker?: Asker;

  private yolo: boolean;
  private level?: Effort;
  /** The agent this session runs as, sent when the daemon creates it. */
  private readonly agentName?: string;
  private disconnected = false;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly unsubscribe: () => void;
  /** This terminal's turn in progress: resolves when the daemon says it's over. */
  private turn?: { done: (stop: StopReason) => void; stop: StopReason };
  /** Questions being asked here, so an answer from another device can cancel them. */
  private readonly asking = new Map<string, AbortController>();

  constructor(
    private readonly client: DaemonClient,
    private readonly cwd: string,
    init: { model: ResolvedModel; meta?: SessionMeta; history?: Message[]; autoApprove?: boolean; effort?: Effort; agent?: string },
  ) {
    this.agentName = init.agent;
    this.model = init.model;
    this.meta = init.meta ?? null;
    this.history = init.history ?? [];
    this.yolo = init.autoApprove ?? false;
    this.level = init.effort;
    this.unsubscribe = client.on((data) => this.onDaemonEvent(data));
  }

  /** A stored session, opened in the daemon. */
  static async open(client: DaemonClient, meta: SessionMeta, cwd: string): Promise<RemoteSession> {
    const detail = await client.request<{ meta: SessionMeta; model: ResolvedModel; messages: Message[]; autoApprove: boolean }>('GET', `/api/sessions/${meta.id}`);
    return new RemoteSession(client, cwd, { meta: detail.meta, model: detail.model, history: detail.messages, autoApprove: detail.autoApprove });
  }

  get autoApprove(): boolean {
    return this.yolo;
  }

  set autoApprove(on: boolean) {
    this.yolo = on;
    if (this.meta) this.tell(`/api/sessions/${this.meta.id}/yolo`, { on }, 'change YOLO');
  }

  get effort(): Effort | undefined {
    return this.level;
  }

  set effort(effort: Effort | undefined) {
    this.level = effort;
    if (this.meta) this.tell(`/api/sessions/${this.meta.id}/effort`, { effort: effort ?? null }, 'change the effort');
  }

  on(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send(input: string, signal?: AbortSignal, images: ImageBlock[] = []): Promise<StopReason> {
    if (!this.meta) {
      const { meta } = await this.client.request<{ meta: SessionMeta }>('POST', '/api/sessions', {
        start: false,
        title: input || (images.length > 0 ? 'Image' : ''),
        cwd: this.cwd,
        model: this.model.label,
        yolo: this.yolo,
        ...(this.agentName && { agent: this.agentName }),
      });
      this.meta = meta;
      if (this.level) await this.client.request('POST', `/api/sessions/${meta.id}/effort`, { effort: this.level });
      this.emit({ type: 'session', session: meta });
    }
    const id = this.meta.id;
    const finished = new Promise<StopReason>((resolve) => (this.turn = { done: resolve, stop: 'other' }));
    const interrupt = () => void this.client.request('POST', `/api/sessions/${id}/interrupt`).catch(() => {});
    signal?.addEventListener('abort', interrupt, { once: true });
    try {
      // The daemon shares this computer's ~/.polyphemus, so a saved image is already in its uploads.
      await this.client.request('POST', `/api/sessions/${id}/messages`, {
        text: input,
        images: images.map((image) => ({ id: basename(image.path), name: image.name })),
      });
      return await finished;
    } finally {
      this.turn = undefined;
      signal?.removeEventListener('abort', interrupt);
    }
  }

  async switchModel(model: ResolvedModel): Promise<void> {
    if (!this.meta) {
      this.model = model;
      this.emit({ type: 'info', text: `Using ${model.label} for this session.` });
      return;
    }
    // The daemon reports the switch (and remembers it for new sessions) through the event stream.
    const { model: now } = await this.client.request<{ model: ResolvedModel }>('POST', `/api/sessions/${this.meta.id}/model`, { model: model.label });
    this.model = now;
  }

  async statusRows(): Promise<Array<[string, string]>> {
    const rows: Array<[string, string]> = this.meta
      ? (await this.client.request<{ rows: Array<[string, string]> }>('GET', `/api/sessions/${this.meta.id}/status`)).rows
      : [
          ['Model', this.model.label],
          ['Session', 'new (saved when you send your first message)'],
          ['Folder', this.cwd],
        ];
    return [...rows, ['Runs in', `the polyphemus daemon (${this.client.base}), so your phone sees this session live`]];
  }

  async rename(title: string): Promise<void> {
    if (!this.meta) throw new PolyphemusError('Nothing to rename yet: send a message first.');
    await this.client.request('POST', `/api/sessions/${this.meta.id}/title`, { text: title });
    this.meta.title = title;
  }

  close(): void {
    this.unsubscribe();
    for (const controller of this.asking.values()) controller.abort();
    this.listeners.clear();
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** A setting change sent to the daemon in the background; a failure shows up as a notice. */
  private tell(path: string, body: unknown, what: string): void {
    this.client.request('POST', path, body).catch((err: Error) => this.emit({ type: 'notice', text: `Couldn’t ${what} in the daemon: ${err.message}` }));
  }

  private onDaemonEvent(data: DaemonEvent): void {
    if (data.type === 'disconnected') {
      if (!this.disconnected) this.emit({ type: 'notice', text: 'Lost the connection to the polyphemus daemon. Reconnecting…' });
      this.disconnected = true;
      return;
    }
    if (data.type === 'reconnected') {
      this.disconnected = false;
      return this.emit({ type: 'info', text: 'Reconnected to the daemon.' });
    }
    if (!this.meta || data.sessionId !== this.meta.id) return;
    if (data.type === 'question') return void this.answer(data);
    if (data.type === 'question_resolved') {
      this.asking.get(String(data.id))?.abort();
      return;
    }
    if (data.type === 'turn_state') {
      if (data.running === false && this.turn) this.turn.done(this.turn.stop);
      return;
    }
    const event = data.event;
    if (!event) return;
    if (event.type === 'message') {
      this.history.push(event.message);
      // A message typed on another device (the phone) while this terminal wasn't the one sending.
      if (event.message.role === 'user' && !this.turn) {
        const text = event.message.content.flatMap((block) => (block.type === 'text' ? [block.text.replace(STATUS_LINE, '').trim()] : [])).join(' ');
        if (text) this.emit({ type: 'info', text: `From another device: ${text}` });
      }
    }
    if (event.type === 'model') this.model = event.model;
    if (event.type === 'turn_done' && this.turn) this.turn.stop = event.stopReason;
    this.emit(event);
  }

  /** Asks here only while this terminal has a turn going (otherwise the prompt would collide with typing); any device can answer. */
  private async answer(question: DaemonEvent): Promise<void> {
    const id = String(question.id);
    if (!this.asker || !this.turn) {
      const what = question.kind === 'approval' ? `your OK to run ${String(question.tool)}: ${String(question.summary)}` : 'you to pick a model';
      return this.emit({ type: 'notice', text: `This session is waiting for ${what}. Answer on your phone.` });
    }
    const controller = new AbortController();
    this.asking.set(id, controller);
    try {
      let answer: string;
      if (question.kind === 'approval') {
        answer = await this.asker.approve({ tool: String(question.tool), summary: String(question.summary), source: String(question.source) }, controller.signal);
      } else {
        const candidates = (question.candidates as Array<{ label: string; target: string }>).map(({ label, target }) => {
          const [provider = '', ...model] = target.split(':');
          return { label, provider, model: model.join(':') };
        });
        const picked = await this.asker.chooseFallback({ reason: String(question.reason), retry: question.retry === true, candidates }, controller.signal);
        answer = picked?.label ?? '';
      }
      if (!controller.signal.aborted) await this.client.request('POST', `/api/questions/${id}`, { answer });
    } catch {
      if (controller.signal.aborted) this.emit({ type: 'info', text: 'Answered on another device.' });
    } finally {
      this.asking.delete(id);
    }
  }
}
