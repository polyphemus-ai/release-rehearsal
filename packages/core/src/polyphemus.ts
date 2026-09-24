import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { startApprovalBridge, type ApprovalBridge } from './agents/approvals.js';
import { readClaudeUsage } from './agents/claude-cli.js';
import { readGrokUsage, type GrokUsage } from './agents/grok-usage.js';
import { CodexAgent, readLatestCodexRateLimits } from './agents/codex-cli.js';
import { codexSandbox, sandboxNotice, type SandboxCheck } from './agents/codex-sandbox.js';
import { summarizeToolInput, type AgentSessionState } from './agents/common.js';
import { runAgentTurn } from './agents/loop.js';
import { Credentials } from './auth/credentials.js';
import { startConnectionGateway, type ConnectionGateway, type GatewayTool } from './connections/gateway.js';
import { connectionToolName, Connections, type CallContext, type CallResult } from './connections/manager.js';
import { runTools, type WorkContext } from './runs/tools.js';
import { ARTIFACT_EXTENSIONS, keepArtifact, type Artifact } from './artifacts.js';
import { resolvePath, type ToolOutput } from './tools/tool.js';
import { siteOf } from './connections/sign-ins.js';
import type { Connection } from './connections/store.js';
import { SECRET_NAME, secretRef, Vault } from './secrets/vault.js';
import { librarySkillsDir, loadSkills, skillsIndex, type Skill } from './skills.js';
import { agentModel, agentPrompt, findAgent, type Agent } from './roster.js';
import { configFile, polyphemusHome, isOffered, loadConfig, modelFor, offList, setDefaultModel, type Config, type ResolvedModel } from './config.js';
import type { PolyphemusEvent } from './events.js';
import { describeLeft, describeModel, describeQuota, formatUsage, staleNote, usageSummary } from './format.js';
import { readingExpired, resetFromMessage, setQuotaRetryMinutes } from './quota.js';
import { clip, stitchHistory } from './history.js';
import { runTurn, type Approver } from './loop.js';
import { buildSystemPrompt } from './prompt.js';
import { noPushEnv } from './workflows/git.js';
import { memoryDir, projectBriefing } from './projects.js';
import { checkScope, memoryBriefing, MEMORY_SCOPE_WORDS, scopesHere, type MemoryScope } from './memory.js';
import type { ProjectMeta } from './session/store.js';
import { ProviderRegistry, providerStatus, type ProviderStatus } from './providers/registry.js';
import { Breakers } from './breakers.js';
import { ConfigHistory } from './config-edit.js';
import type { ImageBlock } from './types.js';
import { imageType, saveImage } from './images.js';
import { describeForecast, forecast, type Forecast } from './forecast.js';
import { canFallBack, fallbackCandidates, outReading } from './routing.js';
import { pinAgentsToTheirModel } from './model-admin.js';
import { pathWithTools } from './platform.js';
import { SessionStore, type SessionMeta } from './session/store.js';
import { cliEnvironment, mightReachCredentials } from './tools/guard.js';
import { effectiveLevel, ISOLATION_WORDS, type IsolationLevel } from './isolation/levels.js';
import { detectRuntime } from './isolation/runtime.js';
import { WorkerPool, type Worker, type WorkerSpec } from './isolation/workers.js';
import { EgressProxy } from './isolation/egress.js';
import { Desktops } from './isolation/desktop.js';
import { computerClient } from './connections/computer.js';
import type { RoutineProposal } from './routines.js';
import { findChrome, openBrowser, type Browser } from './browser/chrome.js';
import { grantedHosts } from './isolation/network.js';
import { CLAUDE_HOST_TOOLS, CLAUDE_ISOLATED_NOTE, claudeShellWrapper, type ShellWrapper } from './isolation/claude.js';
import { checkClaudeIsolation, checkCodexIsolation, checkGrokIsolation, cliVersion } from './isolation/checks.js';
import { GROK_ISOLATED_NOTE, type GrokIsolationStats } from './isolation/grok.js';
import { CODEX_ISOLATED_NOTE, codexBinary, startCodexBridge, type CodexBridge } from './isolation/codex.js';
import type { AgentProvider } from './agents/common.js';
import { editFile, readFile as readFileTool, writeFile as writeFileTool } from './tools/files.js';
import { builtinTools, type Tool } from './tools/index.js';
import { notGranted } from './tools/tool.js';
import { isReadOnlyCommand } from './tools/readonly.js';
import { makeRedactor } from './tools/redact.js';
import { polyphemusGuide } from './polyphemus-guide.js';
import { PolyphemusError, ProviderError, type CapacityReading, type Effort, type Message, type StopReason } from './types.js';
import { kindInside, readInside } from './contained.js';

/**
 * Polyphemus's folder holds every conversation, the config, keys and the vault, so only you can read
 * it: the folder is 0700 and its state files 0600, whatever the umask made them. Checked on every
 * start, because a folder created before this (or by a copy command) can be wide open — the first
 * one found was group-writable, with sessions.db readable by anyone on the machine.
 */
function keepPrivate(home: string, files: readonly string[] = []): void {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    for (const name of files) if (existsSync(join(home, name))) chmodSync(join(home, name), 0o600);
  } catch {
    // Not ours to change (a shared or read-only mount): carry on rather than refuse to start.
  }
}

/** Warn before a turn when a provider's usage window is at least this full. */
const NEARLY_OUT_PCT = 95;
const CLI_NAMES: Record<string, string> = { 'claude-cli': 'Claude Code (`claude`)', 'codex-cli': 'Codex (`codex`)', 'grok-cli': 'Grok Build (`grok`)' };
// Claude Code in `default`, not `acceptEdits`: that mode now also runs rm, mv, cp and mkdir inside the
// project without asking, so `rm -r build` never reached the approval bridge (2026-09-21, reproduced).
const DEFAULT_PERMISSION_MODE: Record<string, string> = { 'claude-cli': 'default', 'grok-cli': 'acceptEdits', 'codex-cli': 'workspace-write sandbox' };

/** Everything a client sees from a session: turn events, plus session-level changes. */
export type RuntimeEvent =
  | PolyphemusEvent
  /** Neutral information ("Switched to codex."). */
  | { type: 'info'; text: string }
  /** The session's model changed. */
  | { type: 'model'; model: ResolvedModel }
  /** The session was created (on its first message). */
  | { type: 'session'; session: SessionMeta }
  /** An agent showed something it made, in the thread. */
  | { type: 'artifact'; artifact: Artifact };

export type ApprovalAnswer = 'allow' | 'deny' | 'always';

export interface ApprovalQuestion {
  tool: string;
  summary: string;
  /** Who is asking: "polyphemus" for polyphemus's own tools, or the agent CLI's provider id. */
  source: string;
}

export interface FallbackQuestion {
  reason: string;
  candidates: ResolvedModel[];
  /** The turn already failed once (as opposed to being held back before sending). */
  retry: boolean;
}

/**
 * How a client answers the questions a session needs a person for. The
 * terminal answers with prompts; the phone will answer with buttons. With no
 * Asker, nothing is asked: risky tool calls are declined and fallback only
 * happens if the config says to switch without asking.
 */
export interface Asker {
  approve(question: ApprovalQuestion, signal?: AbortSignal): Promise<ApprovalAnswer>;
  chooseFallback(question: FallbackQuestion, signal?: AbortSignal): Promise<ResolvedModel | undefined>;
}

export interface SessionOptions {
  cwd: string;
  model: ResolvedModel;
  /** Run as this agent: its persona, instructions, and skills (docs/design/agents.md). */
  agent?: Agent;
  autoApprove?: boolean;
  /** Tools (or provider:tool for agent CLIs) that run without asking. */
  alwaysAllow?: Iterable<string>;
  /** Who is sending: `person:<id>` or `routine:<id>`. Defaults to the install owner. */
  sender?: string;
}

/**
 * What every client shares: config, stored sessions, providers, credentials,
 * and usage. Clients open sessions from it (the terminal one at a time; the
 * daemon many).
 */
export class Polyphemus {
  readonly registry: ProviderRegistry;
  private readings: Map<string, CapacityReading[]>;
  /** Providers that keep failing get a rest (docs/design/routing.md §3). */
  readonly breakers = new Breakers();
  /** Accounts at outside services, and what each project and agent was granted (settled brief §5). */
  readonly connections: Connections;
  /** SuperGrok's plan usage from xAI (grok-usage.ts); replaceable so tests don't reach xAI. */
  grokUsage: () => Promise<GrokUsage> = () => readGrokUsage();
  /** Why Grok's usage is unknown, when the last look couldn't say. */
  grokUsageUnknown: string | undefined;
  /** Whether Codex's sandbox can run here; replaceable so tests needn't depend on the machine. */
  sandboxCheck: (command: string) => Promise<SandboxCheck | undefined> = codexSandbox;
  /** Threads already told that Codex's sandbox can't run here. */
  readonly sandboxNoted = new Set<string>();
  /** True when this start kept an older install on "On this computer" rather than the new default: said once, where it's shown. */
  keptOnThisComputer = false;
  /** The proxy isolated workers' network goes through, to granted hosts only. */
  readonly egress: EgressProxy;
  /** Agents' own computers (docs/design/desktop.md): one each, woken on demand. */
  readonly desktops: Desktops;
  /** Workers agents' commands run in when isolated (docs/design/isolation.md). */
  readonly workers: WorkerPool;
  /** Hosts each project's agents were refused lately, newest last: offered to grant on its Setup tab. */
  readonly refusedHosts = new Map<string, Map<string, number>>();
  /** The container runtime; replaceable so tests can say there's none. */
  runtime: () => ReturnType<typeof detectRuntime> = () => detectRuntime();
  /** Threads already told their commands run on this computer. */
  readonly hostNoted = new Set<string>();
  /**
   * CLIs caught running a command outside their worker, and what happened: they aren't offered at an
   * isolated level again until polyphemus restarts with a version that behaves (fail closed).
   */
  readonly isolationBroken = new Map<string, string>();

  private constructor(
    readonly home: string,
    readonly config: Config,
    readonly store: SessionStore,
    readonly credentials: Credentials,
    readonly vault: Vault,
  ) {
    this.egress = new EgressProxy(home);
    this.workers = new WorkerPool(() => this.runtime(), this.egress);
    this.desktops = new Desktops(home, () => this.runtime(), this.egress);
    this.egress.onRefused((refusal) => {
      if (!refusal.project || refusal.why !== 'not granted') return;
      const hosts = this.refusedHosts.get(refusal.project) ?? new Map<string, number>();
      hosts.delete(refusal.host);
      hosts.set(refusal.host, refusal.at);
      while (hosts.size > 10) hosts.delete(hosts.keys().next().value!);
      this.refusedHosts.set(refusal.project, hosts);
    });
    this.registry = new ProviderRegistry(config, credentials);
    this.readings = store.capacity();
    this.connections = new Connections(store.connections, vault);
    this.connections.computerClient = () => computerClient(() => this.desktops);
    this.connections.openBrowser = (opts) => this.openBrowser(opts);
    // In a worker, the browser is the worker's Chromium: this computer needn't have a Chrome of its own.
    this.connections.hasBrowser = () => Boolean(this.runtime()) || Boolean(findChrome());
    this.connections.people = {
      inProject: (project) => store.projectMembers(project).map((m) => m.person.id),
      name: (id) => store.person(id)?.name ?? 'someone who’s gone',
    };
    // A call made during a run's step is that step's evidence: a service's answer is a receipt, and a
    // failure is why the step failed — recorded here, not taken from what the agent says about it.
    this.connections.onCall((call) => {
      if (!call.ctx.step) return;
      store.runs.addEvidence({
        runId: call.ctx.step.runId,
        stepId: call.ctx.step.stepId,
        kind: 'call',
        label: `${call.name} ${call.tool}`,
        ok: call.outcome === 'ok',
        ...(call.outcome === 'ok' ? { receipt: `${call.name} answered` } : { detail: call.detail ?? call.outcome }),
      });
    });
  }

  static async open(home = polyphemusHome()): Promise<Polyphemus> {
    keepPrivate(home);
    // Vendor CLIs are run by name, so the folders their installers use go on the end of PATH here,
    // once, for everything that starts them (platform.ts says why).
    process.env.PATH = pathWithTools();
    const store = new SessionStore(join(home, 'sessions.db'));
    // Every use of a secret is recorded (which secret, who asked, when: never the value).
    const vault = new Vault(home, { audit: (name, by) => store.recordSecretRead(name, by) });
    const config = loadConfig(home);
    setQuotaRetryMinutes(config.routing.quotaRetryMinutes);
    const polyphemus = new Polyphemus(home, config, store, new Credentials(join(home, 'credentials.json'), vault), vault);
    // An install that was already in use before Isolated became the default keeps running agents where it
    // did, written down so it's a setting it can see and change, not a surprise.
    if (!config.isolation.chosen && store.list(1).length > 0) {
      const history = new ConfigHistory(home, store, 'polyphemus');
      history.apply(history.plan('isolation.level', 'host').after, 'kept isolation.level = host: set before Isolated was the default');
      polyphemus.reloadConfig();
      polyphemus.keptOnThisComputer = true;
    }
    keepPrivate(home, ['sessions.db', 'sessions.db-wal', 'sessions.db-shm', 'config.toml', 'daemon.json']);
    pinAgentsToTheirModel(polyphemus);
    await polyphemus.refreshCliUsage();
    return polyphemus;
  }

  status(provider: string): ProviderStatus {
    const providerConfig = this.config.providers[provider];
    if (!providerConfig) return { ready: false, note: 'unknown provider' };
    if (isOffered(this.config, provider)) return { ready: false, offered: true, note: 'offered, not in use: accept it to use it' };
    return providerStatus(provider, providerConfig, this.credentials);
  }

  /** Says yes to a provider polyphemus offers, so it can run and its models can be picked. Recorded like any config change. */
  accept(provider: string, by: string): boolean {
    if (!this.config.providers[provider]) throw new PolyphemusError(`There's no provider called "${provider}".`, 'NOT_FOUND');
    if (!isOffered(this.config, provider)) return false;
    const history = new ConfigHistory(this.home, this.store, by);
    history.apply(history.plan('accepted', [...(this.config.accepted ?? []), provider]).after, `accepted provider ${provider}`);
    this.reloadConfig();
    return true;
  }

  /**
   * Latest usage readings per provider. Kept in memory, but read again once one of them has reached
   * its reset or retry time: the daemon lives for weeks, and a remembered "out of quota" must not
   * outlast what it said.
   */
  get capacity(): Map<string, CapacityReading[]> {
    const now = Date.now();
    if ([...this.readings.values()].some((readings) => readings.some((r) => readingExpired(r, now)))) this.readings = this.store.capacity(now);
    return this.readings;
  }

  /** The reading that says this provider can't take work right now, if any. */
  outReading(provider: string): CapacityReading | undefined {
    return outReading(this.capacity.get(provider));
  }

  /**
   * Why a provider can't take a turn right now ("is out (…)", "is paused: …"), or undefined when
   * it can. Out of usage, or its circuit breaker is open.
   */
  unavailable(provider: string): string | undefined {
    const out = this.outReading(provider);
    if (out) return out.window === 'quota' ? describeQuota(out) : `is out (${formatUsage(out)})`;
    return this.breakers.blocked(provider);
  }

  /** Will each usage window last until it resets? Read fresh, so usage from other processes counts too. */
  forecasts(provider?: string, now = Date.now()): Forecast[] {
    const out: Forecast[] = [];
    for (const [p, readings] of this.store.capacity(now)) {
      if (provider && p !== provider) continue;
      for (const r of readings) {
        if (r.window === 'quota' || r.usedPct === undefined) continue;
        out.push(forecast(p, r, this.store.capacitySamples(p, r.window, now - 60 * 60_000), now));
      }
    }
    return out;
  }

  recordUsage(provider: string, readings: readonly CapacityReading[], observedAt?: number): void {
    this.store.recordCapacity(provider, readings, observedAt);
    this.readings = this.store.capacity();
  }

  clearQuota(provider: string): void {
    this.store.clearCapacity(provider, 'quota');
    this.readings = this.store.capacity();
  }

  usageSummary(): string {
    return usageSummary(this.capacity);
  }

  /**
   * Re-reads config.toml after something edited it. The daemon lives for weeks, so a model added
   * from the app has to be visible without a restart. Fields are copied onto the existing object
   * rather than replaced, because the provider registry holds a reference to it.
   */
  reloadConfig(): void {
    const fresh = loadConfig(this.home);
    // An optional setting taken out of the file mustn't linger from before.
    if (fresh.accepted === undefined) delete this.config.accepted;
    Object.assign(this.config, fresh);
    setQuotaRetryMinutes(this.config.routing.quotaRetryMinutes);
  }

  /** Makes `model` what new sessions start with. */
  rememberDefault(model: ResolvedModel): void {
    if (this.config.defaultModel === model.label) return;
    setDefaultModel(configFile(this.home), model.label);
    this.config.defaultModel = model.label;
    // Recorded like any other change, so it shows in config history and can be undone.
    new ConfigHistory(this.home, this.store, 'polyphemus').recordCurrent(`set default_model = "${model.label}"`);
  }

  newSession(opts: SessionOptions): SessionRuntime {
    return new SessionRuntime(this, null, [], opts);
  }

  /** Reopens a stored session. Its own model is used unless `model` is given (then the session switches to it). */
  openSession(meta: SessionMeta, opts: Omit<SessionOptions, 'model'> & { model?: ResolvedModel }): SessionRuntime {
    const model = opts.model ?? modelFor(this.config, meta.provider, meta.model);
    if (opts.model) this.store.setModel(meta.id, model.provider, model.model);
    // More than one agent may have been working here, so their turns interleave in the thread: a
    // model needs each tool call answered by its own result (docs/design/parallel-agents.md).
    return new SessionRuntime(this, meta, stitchHistory(this.store.messages(meta.id)), { ...opts, model });
  }

  /** Masks the API keys polyphemus holds, plus common secret formats, in tool output. */
  redactor(): (text: string) => string {
    const envKeys = Object.values(this.config.providers).flatMap((p) =>
      p.auth.type === 'api_key' && p.auth.env && process.env[p.auth.env] ? [process.env[p.auth.env]!] : [],
    );
    return makeRedactor([...this.credentials.allApiKeys(), ...envKeys]);
  }

  close(): void {
    this.connections.close();
    void this.workers.close();
    this.egress.close();
    this.desktops.close();
    this.store.close();
  }

  /** Claude Code's once-per-version isolation check; replaceable so tests can script it. */
  async claudeIsolationCheck(provider: AgentProvider, worker: Worker, signal: AbortSignal, starting: () => void): Promise<{ ok: boolean; detail?: string }> {
    const command = this.config.providers[provider.id]?.command ?? 'claude';
    const key = `claude-cli@${cliVersion(command)}`;
    const known = this.isolationChecked.get(key);
    if (known) return known;
    starting();
    const result = await checkClaudeIsolation({ home: this.home, provider, command, worker, signal });
    this.isolationChecked.set(key, result);
    return result;
  }
  private readonly isolationChecked = new Map<string, { ok: boolean; detail?: string }>();

  /** Grok Build's once-per-version isolation check. */
  async grokIsolationCheck(provider: AgentProvider, worker: Worker, model: string, signal: AbortSignal, starting: () => void): Promise<{ ok: boolean; detail?: string }> {
    const command = this.config.providers[provider.id]?.command ?? 'grok';
    const key = `grok-cli@${cliVersion(command)}`;
    const known = this.isolationChecked.get(key);
    if (known) return known;
    starting();
    const result = await checkGrokIsolation({ home: this.home, provider, command, worker, model, signal });
    this.isolationChecked.set(key, result);
    return result;
  }

  /** Codex's once-per-version isolation check. */
  async codexIsolationCheck(provider: AgentProvider, worker: Worker, binary: string, model: string, signal: AbortSignal, starting: () => void): Promise<{ ok: boolean; detail?: string }> {
    const command = this.config.providers[provider.id]?.command ?? 'codex';
    const key = `codex-cli@${cliVersion(command)}`;
    const known = this.isolationChecked.get(key);
    if (known) return known;
    starting();
    const result = await checkCodexIsolation({ home: this.home, provider, command, worker, binary, model, signal });
    this.isolationChecked.set(key, result);
    return result;
  }

  /**
   * A browser for the Browser connection and live sign-ins: Chromium in a worker of its own — no
   * folders, and the web through polyphemus's proxy (public hosts only) — where this computer can make one;
   * otherwise the Chrome on this computer, held back only by the browser's address check.
   */
  async openBrowser(opts: { headful?: boolean } = {}): Promise<Browser> {
    const runtime = this.runtime();
    // A person signing in by hand needs a window on their own screen, and a worker's Chromium has no
    // screen to put one on: that sign-in runs in the Chrome on this computer, in a throwaway profile
    // of its own, which is where the person's own browsing belongs anyway (2026-09-22). Agents' own
    // browsing stays in the worker, whatever this says.
    const window = opts.headful === true && Boolean(process.env.DISPLAY ?? process.env.WAYLAND_DISPLAY);
    if (!runtime || window) return openBrowser(opts);
    const worker = await this.workers.get({ key: 'browser', mounts: [], network: 'open', project: null, workdir: '/tmp' });
    return openBrowser({ worker });
  }

  /**
   * The worker a workflow run's own commands run in — its checks, its preview, a look at its pages — for
   * a folder: only that folder, with its project's network grant. Undefined where agents run on this computer.
   */
  async runWorker(cwd: string): Promise<Worker | undefined> {
    const project = this.store.projectFor(cwd);
    const level = this.isolationFor(project);
    if (level === 'host') return undefined;
    if (!this.runtime()) throw new PolyphemusError(`${project ? `${project.name} is` : 'This install is'} set to ${ISOLATION_WORDS[level].title}, but there’s no Docker or Podman on this computer to isolate it in, so nothing was run.`, 'USAGE');
    // A run's folder sits inside its project, where the project's agents can swap it for a link. Docker
    // would follow one when mounting, so the folder is resolved here and must still be inside the
    // project: a run never gets a folder of yours outside it (workflow review, 2026-09-19).
    const within = (inner: string, outer: string) => inner === outer || inner.startsWith(`${outer}/`);
    if (project && cwd !== project.path && (!within(cwd, project.path) || kindInside(project.path, cwd) !== 'folder' || !within(realpathSync(cwd), realpathSync(project.path)))) {
      throw new PolyphemusError(`${cwd} goes through a link or leads outside ${project.name}, so no run works in it.`, 'USAGE');
    }
    return this.workers.get({ key: `${project?.slug ?? `folder:${cwd}`}|run|${cwd}`, mounts: [{ path: cwd }], ...this.workerNetwork(project, level), project: project?.slug ?? null, workdir: cwd });
  }

  /** What a worker in a project may reach: nothing, its granted hosts, or any public host. */
  workerNetwork(project: ProjectMeta | undefined, level: IsolationLevel): Pick<WorkerSpec, 'network' | 'hosts'> {
    if (level === 'isolated-open') return { network: 'open' };
    const hosts = grantedHosts(project?.network);
    return hosts.length ? { network: 'granted', hosts } : { network: 'none' };
  }

  /** Where agents' commands and file changes run in a project (or a folder outside one). */
  isolationFor(project?: { isolation?: IsolationLevel }): IsolationLevel {
    return effectiveLevel(this.config.isolation.level, project?.isolation);
  }

  /** Why a connection's model can't run where agents are isolated, or null when it can: said before a thread starts. */
  isolationBlocker(providerId: string): string | null {
    const adapter = this.config.providers[providerId]?.adapter;
    if (!adapter || !(adapter in CLI_NAMES)) return null;
    const name = CLI_NAMES[adapter]!.replace(/ \(`.*`\)$/, '');
    const broken = this.isolationBroken.get(adapter);
    return broken ? `${name} isn’t offered where agents are isolated: ${broken}` : null;
  }

  /**
   * Refreshes usage for the providers that can be asked without spending anything, so a reading
   * doesn't sit frozen from the last turn. Codex writes its limits to its own rollout logs (a file
   * read), and Claude Code's `/usage` is a local command — `--output-format json` comes back with
   * `num_turns: 0` and no tokens. Both also pick up work done outside polyphemus.
   *
   * API providers are not here on purpose: their limits arrive only in response headers, so
   * polling one means a real request against the thing being measured.
   *
   * `ask` allows running a CLI to find out, which is the Claude Code path. Opening a Polyphemus
   * doesn't: starting up shouldn't wait on someone else's process, and a test shouldn't shell out
   * to a real CLI just by constructing one. The daemon's timer asks.
   */
  async refreshCliUsage(opts: { ask?: boolean } = {}): Promise<void> {
    // Only providers a chosen model actually uses. Measuring one nobody has picked from is the
    // instrument before the work, and on a fresh install it charted usage for things the person
    // had never touched.
    const inUse = new Set([
      ...this.config.selected.map((ref) => ref.slice(0, ref.indexOf(':'))),
      ...Object.values(this.config.models).map((m) => m.provider),
    ]);
    const byAdapter = (adapter: string) =>
      Object.entries(this.config.providers)
        .filter(([id, p]) => p.adapter === adapter && inUse.has(id))
        .map(([id]) => id);
    const record = (ids: string[], found: { readings: CapacityReading[]; observedAt?: Date }) => {
      if (found.readings.length === 0 || !found.observedAt) return;
      for (const id of ids) this.store.recordCapacity(id, found.readings, found.observedAt.getTime());
    };
    const codexIds = byAdapter('codex-cli');
    const claudeIds = byAdapter('claude-cli');
    const grokIds = byAdapter('grok-cli');
    const [codex, claude, grok] = await Promise.all([
      codexIds.length ? readLatestCodexRateLimits().catch(() => ({ readings: [] as CapacityReading[], observedAt: undefined })) : undefined,
      opts.ask && claudeIds.length && this.status(claudeIds[0]!).ready
        ? readClaudeUsage().catch(() => ({ readings: [] as CapacityReading[], observedAt: undefined }))
        : undefined,
      opts.ask && grokIds.length && this.status(grokIds[0]!).ready ? this.grokUsage().catch((): GrokUsage => ({ readings: [], unknown: 'the lookup failed' })) : undefined,
    ]);
    if (codex) record(codexIds, codex);
    if (claude) record(claudeIds, claude);
    if (grok) {
      this.grokUsageUnknown = grok.unknown;
      record(grokIds, grok);
      // xAI says there's room: an earlier quota error is over, whatever its retry time said.
      if (grok.readings.some((r) => (r.usedPct ?? 0) < 100)) for (const id of grokIds) this.store.clearCapacity(id, 'quota');
    }
    this.readings = this.store.capacity();
  }
}

/**
 * One conversation: runs turns with fallback (docs/design/routing.md),
 * approvals, usage tracking, and the status line, and reports everything as
 * RuntimeEvents to whoever is listening.
 */
export class SessionRuntime {
  model: ResolvedModel;
  /** What the thread runs on when no agent's own route applies. */
  private baseModel: ResolvedModel;
  effort?: Effort;
  autoApprove: boolean;
  /** Never asks: anything that isn't read-only is declined (unattended briefs and reports). */
  readOnly = false;
  readonly alwaysAllow: Set<string>;
  readonly cwd: string;
  /** The project this session's folder belongs to, if any (docs/design/projects.md). */
  readonly project?: ProjectMeta;
  /** Set by the client that can answer questions; undefined means nobody is there to ask. */
  asker?: Asker;

  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private system: string;
  /** The project packet (handoff, notes index), captured once so the prompt stays cache-friendly. */
  private readonly briefing: string;
  /** The project's AGENTS.md, for Claude Code (which reads CLAUDE.md, not AGENTS.md). */
  private readonly projectRules: string;
  /** The agent this session runs as, if any. */
  /** Who is answering. In a thread with several agents this changes per turn. */
  agent?: Agent;
  /** Skills in play for this session: the library's, plus the project's, narrowed to the agent's. */
  private skills: Skill[];
  /** Their names and descriptions, for a CLI's system prompt. */
  private skillsNote: string;
  /** Who the agent is, for a CLI's system prompt. */
  private agentNote: string;
  /**
   * Who is sending this turn's message: `person:<id>`, or `routine:<id>`. The daemon sets it for
   * each request; a session in the terminal is the install owner's. Recorded on the thread when it
   * starts and on every message a person writes.
   */
  sender: string | undefined;
  /**
   * Why the last turn stopped on its own and needs a person — a model that couldn't run with nothing
   * to switch to — or undefined. A thread shows as paused while this is set (settled brief §1).
   */
  pausedBecause: string | undefined;
  /** Usage windows this session already warned about running out early. */
  private readonly forecastWarned = new Set<string>();
  /** The run this turn belongs to, while it does: planning it, or one of its steps. */
  work?: WorkContext;
  /**
   * The other agents in a group thread, set by the client before each turn: who's here, who leads,
   * and how to hand work on. Without it an agent can't know a hand-off is one @mention away.
   */
  team?: {
    members: Array<{ id: string; handle: string; title: string; runsOn: string }>;
    lead?: string;
    guard: number;
    /** Teammates who aren't in this thread, and what each is for: who the agent could suggest bringing in. */
    others?: Array<{ handle: string; title: string; about: string }>;
    /** The people in this thread: who the agent is talking with, and how to reach one. */
    people?: Array<{ handle: string; name: string }>;
    /** Polyphemus's own agent, when it isn't this one: who can make and change agents, skills and routines. */
    keeper?: string;
  };
  /** Who came and went in this thread, in words with when, set by the client before each turn. */
  attendance?: string[];
  /** Set by a client that can ask a person: lets the agent offer to track the thread as work. */
  proposeOutcome?: (text: string, why: string) => string;
  /** The worker this turn's tools run in, when isolated. */
  private worker?: Worker;
  /** An isolated CLI this turn: polyphemus's worker-backed file tools are offered through the gateway. */
  private isolatedFiles = false;
  /** In a run's own worktree: no push leaves this session's shells, whatever credentials the computer has. */
  pushLocked = false;
  /** Set by the daemon: an agent proposes work for its project, which waits on a person. */
  proposeWork?: (kind: 'feedback' | 'idea' | 'finding', text: string) => string;
  /** Set by the daemon: an agent proposes a routine for its project, which a person accepts before it exists. */
  proposeRoutine?: (proposal: RoutineProposal) => string;
  /** Set by the daemon: an agent proposes a change to its own profile, which a person accepts. */
  proposeProfile?: (change: { persona?: string; instructions?: string; description?: string; why: string }) => string;
  /** Set by the daemon: an agent proposes something to remember, and where it may be recalled. */
  proposeNote?: (note: { name: string; description: string; text: string; scope: MemoryScope }) => string;
  /** Set by a client that can ask a person: an agent drafts a skill, and they decide whether and where it's kept. */
  proposeSkill?: (skill: { name: string; description: string; body: string; why: string; where: 'agent' | 'library' | 'project' }) => string;
  /**
   * Set by a client that can ask a person. Resolves to `saved`, `decline`, or undefined if the turn
   * stopped. The value never comes back through here: the app writes the vault, and this hears only
   * which they chose.
   */
  requestSecret?: (name: string, purpose: string, signal?: AbortSignal) => Promise<string | undefined>;
  /**
   * Set by a client that can open a sign-in. Resolves when the person finishes or declines, or
   * undefined if the turn stopped. Never carries a token or a cookie.
   */
  requestSignIn?: (request: { connection: string; name: string; how: 'oauth' | 'browser'; url?: string; site?: string; purpose: string }, signal?: AbortSignal) => Promise<{ status: 'signed-in'; heldBack?: string } | { status: 'decline' } | { status: 'waiting' } | undefined>;
  private bridge?: ApprovalBridge;
  private gateway?: ConnectionGateway;
  /** Connections already mentioned as out of reach on this CLI, so it's said once. */
  private unreachableNoted = false;
  private activeSignal?: AbortSignal;

  constructor(
    readonly polyphemus: Polyphemus,
    public meta: SessionMeta | null,
    public history: Message[],
    opts: SessionOptions,
  ) {
    this.model = opts.model;
    this.effort = opts.model.effort;
    this.autoApprove = opts.autoApprove ?? false;
    this.alwaysAllow = new Set(opts.alwaysAllow ?? []);
    this.cwd = opts.cwd;
    this.project = polyphemus.store.projectFor(opts.cwd);
    this.briefing = this.project ? projectBriefing(polyphemus.home, this.project) : '';
    // Handed to Claude Code here rather than through a CLAUDE.md in the repo, so a project's rules
    // shape the sessions polyphemus runs, not Claude Code you run yourself in that folder.
    const rulesFile = this.project && join(this.project.path, 'AGENTS.md');
    const rules = rulesFile ? readInside(this.project!.path, rulesFile) : undefined;
    this.projectRules = rules !== undefined ? `Project rules from ${rulesFile}:\n\n${rules.trim()}` : '';
    // A resumed session keeps the agent it ran as, so it stays itself across restarts.
    // A new thread with nobody picked is with the default agent; one stored without an agent stays that way.
    this.agent = opts.agent ?? findAgent(polyphemus.home, this.project?.path, meta ? meta.agent : polyphemus.config.defaultAgent, this.project?.slug);
    const inScope = loadSkills(polyphemus.home, this.project?.path, this.agent?.dir).skills;
    // An agent's `skills` list narrows what's shared; its own skills are always its.
    this.skills = this.agent?.skills ? inScope.filter((skill) => skill.scope === 'agent' || this.agent!.skills!.includes(skill.name)) : inScope;
    const base = buildSystemPrompt({ cwd: opts.cwd, home: polyphemus.home, projectRoot: this.project?.path, skills: this.skills });
    const persona = this.agent ? this.personaOf(this.agent) : '';
    this.system = [base, persona, this.briefing].filter(Boolean).join('\n\n');
    // The agent CLIs build their own prompt, so they're handed the same parts separately.
    this.skillsNote = skillsIndex(this.skills);
    this.agentNote = persona;
    this.baseModel = opts.model;
    this.sender = opts.sender ?? `person:${polyphemus.store.installOwner().id}`;
  }

  /**
   * Who answers this turn. A thread can have several agents in it (docs/design/agents.md), and
   * when the speaker changes so does everything that makes them them: their persona, the skills
   * they're allowed, and the model they run on. Called before a turn, not during one.
   */
  speakAs(agent: Agent | undefined): void {
    if (agent?.id === this.agent?.id) return;
    this.agent = agent;
    const inScope = loadSkills(this.polyphemus.home, this.project?.path, agent?.dir).skills;
    this.skills = agent?.skills ? inScope.filter((skill) => skill.scope === 'agent' || agent.skills!.includes(skill.name)) : inScope;
    const base = buildSystemPrompt({ cwd: this.cwd, home: this.polyphemus.home, projectRoot: this.project?.path, skills: this.skills });
    const persona = agent ? this.personaOf(agent) : '';
    this.system = [base, persona, this.briefing].filter(Boolean).join('\n\n');
    this.skillsNote = skillsIndex(this.skills);
    this.agentNote = persona;
    // Its own route, or back to whatever the thread would otherwise have used.
    this.model = agent ? agentModel(this.polyphemus.config, agent, this.baseModel) : this.baseModel;
  }

  /** Who the agent is, for its prompt — and, for the default agent, how polyphemus itself works. */
  private personaOf(agent: Agent): string {
    const own = agentPrompt(agent);
    if (agent.name !== this.polyphemus.config.defaultAgent || agent.scope === 'project') return own;
    return `${own}\n\n${polyphemusGuide({ agentTitle: agent.title, ownerName: this.polyphemus.store.installOwner().name, home: this.polyphemus.home })}`;
  }

  /** Who wrote a message: the sender for what they typed, the agent for its replies, nobody for tool results. */
  private actorFor(message: Message): string | undefined {
    if (message.role === 'assistant') return this.agent ? `agent:${this.agent.id}` : undefined;
    return message.content.some((block) => block.type === 'text' || block.type === 'image') ? this.sender : undefined;
  }

  /**
   * A vendor CLI's own session belongs to one agent in one thread on one provider: Builder and
   * Reviewer in the same thread never share one (assessment, 2026-09-12).
   */
  private nativeKey(provider: string): string {
    return this.agent ? `${provider}#${this.agent.id}` : provider;
  }

  private fingerprint(): string {
    return createHash('sha256').update(this.agentNote).digest('hex').slice(0, 16);
  }

  /** The native session to resume, unless it was started as someone else or with other instructions. */
  private nativeState(sessionId: string, provider: string): AgentSessionState | undefined {
    const state = this.polyphemus.store.agentState(sessionId, this.nativeKey(provider));
    if (!state) return undefined;
    // Threads without an agent, from before fingerprints, have nothing that could have changed.
    if (state.fingerprint === undefined && !this.agent) return state;
    return state.fingerprint === this.fingerprint() ? state : undefined;
  }

  /**
   * What this turn cost, from what the CLI reported. Claude Code's `total_cost_usd` is the running
   * total for the whole native session, so on a resumed one it's the difference from the last turn;
   * on a session that has just started it's the whole thing. Counting the number as it comes made a
   * resumed session's cost land again on every turn, and the thread's total read many times what it
   * was (reported by an agent reading its own transcripts, 2026-09-20).
   */
  private turnCost(reported: number | undefined, state: AgentSessionState | undefined, nativeId: string | undefined): number | undefined {
    if (reported === undefined) return undefined;
    const before = state && nativeId && state.nativeId === nativeId ? (state.costTotal ?? 0) : 0;
    const spent = reported - before;
    // Lower than last time means it isn't the same running total — a fresh session under the same
    // id, or a CLI that reports per turn after all. Either way, what it says is this turn's.
    return spent < 0 ? reported : spent;
  }

  /**
   * What an agent CLI's own session hasn't been told about, so it can be passed along before the new
   * message: everything stored in the thread since that session last finished a turn. Counted in the
   * thread as it's stored, whose order never changes — a runtime's own array holds only what it has
   * read, so with two agents working in one thread (or after a restart) it counts something else
   * (review of parallel agents, 2026-09-20). A CLI joining a thread is given all of it.
   */
  private missedByNative(sessionId: string, state: AgentSessionState | undefined): Message[] {
    if (!state) return this.polyphemus.store.messages(sessionId);
    // Sessions saved before positions were stored: the old count, in this runtime's array.
    if (state.seenSeq === undefined) return this.history.slice(state.seen);
    return this.polyphemus.store.messagesFrom(sessionId, state.seenSeq);
  }

  /**
   * Reads the thread again, so this runtime has everything said in it — its own turns and anyone
   * else's — in a shape a model accepts. The array itself is kept: clients hold on to it.
   */
  syncHistory(): void {
    if (!this.meta) return;
    const fresh = stitchHistory(this.polyphemus.store.messages(this.meta.id));
    if (fresh.length === this.history.length) return;
    this.history.splice(0, this.history.length, ...fresh);
  }

  on(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Runs a turn. Never starts on a provider known to be out; on a limit or
   * outage, offers (or, if configured, switches to) the next model and retries
   * without resending the message.
   */
  /**
   * A person's message that no agent answers: people talking to each other in a thread. It's kept in
   * the conversation, so whichever agent is named next reads it — an agent CLI is sent what it missed.
   */
  say(input: string, images: ImageBlock[] = []): void {
    if (!this.meta) throw new PolyphemusError('A thread has to exist before people can talk in it.', 'USAGE');
    const message: Message = { role: 'user', content: [{ type: 'text', text: input }, ...images] };
    this.history.push(message);
    this.polyphemus.store.append(this.meta.id, message, this.sender);
    this.emit({ type: 'message', message, actor: this.sender });
  }

  async send(input: string, signal: AbortSignal = new AbortController().signal, images: ImageBlock[] = []): Promise<StopReason> {
    this.pausedBecause = undefined;
    // Anything said here since this runtime's last turn — another agent answering alongside, a person
    // writing — is part of the conversation it answers (docs/design/parallel-agents.md).
    this.syncHistory();
    const tried = new Set<string>();
    const why = this.polyphemus.unavailable(this.model.provider);
    if (why) {
      tried.add(this.model.provider);
      const next = await this.chooseFallback(`${this.model.provider} ${why}`, tried, false, signal);
      if (!next) return 'other';
      this.useForSession(next);
    }
    let pending: string | undefined = input;
    let attached = images;
    for (;;) {
      try {
        return await this.runOnce(pending, signal, attached);
      } catch (err) {
        if (!canFallBack(err) || signal.aborted) throw err;
        tried.add(err.provider);
        const next = await this.chooseFallback(`${err.provider} can't take this turn: ${err.message}`, tried, true, signal);
        if (!next) return 'other';
        this.useForSession(next);
        // The message is already in the conversation; the next model picks up from there.
        pending = this.history.at(-1)?.role === 'user' ? undefined : 'Continue where the previous model left off.';
        attached = [];
      }
    }
  }

  /**
   * Switches models and remembers the choice for new sessions. A model that
   * isn't set up yet is used for this session but not remembered.
   */
  switchModel(model: ResolvedModel): void {
    // Choosing a model yourself is a deliberate retry, even if it was failing a moment ago.
    this.polyphemus.breakers.clear(model.provider);
    this.setModel(model);
    const status = this.polyphemus.status(model.provider);
    if (!status.ready) {
      this.info(`Switched to ${describeModel(model)} for this session.`);
      const api = this.polyphemus.config.providers[model.provider]?.auth.type === 'api_key';
      this.notice(`${model.provider} isn't set up yet: ${status.note}.${api ? ` Type /login ${model.provider} to add a key now.` : ''}`);
      return;
    }
    this.polyphemus.rememberDefault(model);
    this.info(`Switched to ${describeModel(model)}. New sessions will start with it too.`);
    const out = this.polyphemus.outReading(model.provider);
    if (out) this.notice(`${model.provider} is out right now (${formatUsage(out)}); your next message will offer another model.`);
  }

  /** A switch for this session only (falling back doesn't change the default). */
  useForSession(model: ResolvedModel): void {
    this.setModel(model);
    const keep = this.polyphemus.config.defaultModel ? ` New sessions still start with ${this.polyphemus.config.defaultModel}.` : '';
    this.info(`Using ${describeModel(model)} for this session.${keep}`);
  }

  rename(title: string): void {
    if (!this.meta) throw new Error('Nothing to rename yet: send a message first.');
    this.polyphemus.store.setTitle(this.meta.id, title);
    this.meta.title = title;
  }

  /** What `/status` shows: label and value pairs. */
  statusRows(): Array<[string, string]> {
    const providerConfig = this.polyphemus.config.providers[this.model.provider];
    const status = this.polyphemus.status(this.model.provider);
    const cli = providerConfig?.auth.type === 'cli';
    const approvals = this.autoApprove
      ? 'everything allowed (-y)'
      : cli
        ? `permission mode: ${providerConfig.permissionMode ?? DEFAULT_PERMISSION_MODE[providerConfig.adapter] ?? 'default'}, and anything else is asked`
        : this.alwaysAllow.size > 0
          ? `asks first, except: ${[...this.alwaysAllow].join(', ')}`
          : 'asks before running commands or changing files';
    return [
      ['Model', describeModel(this.model)],
      [
        'Runs on',
        cli
          ? `${status.note} · counts against your plan, not billed per token`
          : `the ${this.model.provider} API · ${status.ready ? status.note : `no key yet (/login ${this.model.provider})`} · billed per token`,
      ],
      ['Tools', cli ? `the CLI's own tools · ${approvals}` : `polyphemus tools (bash, read_file, write_file, edit_file) · ${approvals} · credential files blocked`],
      ['Session', this.meta ? `${this.meta.id} · ${this.history.length} messages · "${clip(this.meta.title, 50)}"` : 'new (saved when you send your first message)'],
      ['Folder', this.cwd],
      ['Project', this.project ? `${this.project.name} (${this.project.slug}) · memory in ${memoryDir(this.polyphemus.home, this.project.slug)}` : 'none (add this folder with poly projects add)'],
      ['Usage', this.polyphemus.usageSummary() || 'nothing reported yet (shows up after a turn)'],
    ];
  }

  /**
   * Tells the model what it's running on. Without this, models guess (sometimes
   * wrongly). Stable per model, so it doesn't disturb the prompt cache.
   */
  runtimeNote(): string {
    const providerConfig = this.polyphemus.config.providers[this.model.provider];
    const cli = providerConfig?.auth.type === 'cli';
    const how = cli
      ? `the user's subscription through the ${CLI_NAMES[providerConfig.adapter] ?? this.model.provider} CLI, so usage counts against their plan rather than being billed per token`
      : `the ${this.model.provider} API with the user's own key, billed per token`;
    return [
      `You are running inside polyphemus, a multi-provider agent polyphemus. Right now you are ${describeModel(this.model)}, on ${how}.`,
      "How people change things in polyphemus: in the app, a thread's model is picked at the top of the thread, an agent's own model is set on its profile under Team, and providers and usage are under Setup, Models & providers; in the terminal, /model and /status. There are no other commands in a thread, and a person can't run one by typing it to you. If you don't know how polyphemus does something, say you don't know rather than guessing at a command or a menu.",
      'Each user message starts with a <polyphemus_status> line giving the current model and how much usage is left on each provider; use it to answer questions about models, logins, billing, or limits instead of investigating files.',
      'Earlier turns in this conversation may have come from other models.',
      'When the status line says your provider will run out before it resets, save your progress before long work (commit, and update the handoff if there is one) so another model can pick up, and mention it to the user.',
      ...(cli ? [] : ["Polyphemus's tools refuse to read or write credential files, and secrets are masked in tool output."]),
    ].join(' ');
  }

  /**
   * One line at the top of each message, so the model can say what it's running
   * on and what's left without ever seeing a secret. In the message rather than
   * the system prompt, so the prompt cache isn't disturbed.
   */
  statusBlock(): string {
    const current = this.model.provider;
    const cli = this.polyphemus.config.providers[current]?.auth.type === 'cli';
    const runsOn = cli ? "the user's subscription for that provider (not billed per token)" : "the user's API key (billed per token)";
    const forecasts = this.polyphemus.forecasts();
    // "7d window 29% used (71% left), resets Mon 7:00 PM, at this pace it runs out Thu 3:10 PM, before it resets …"
    const withForecast = (provider: string, r: CapacityReading) => {
      const f = forecasts.find((x) => x.provider === provider && x.window === r.window);
      return f && f.status !== 'out' ? `${describeLeft(r)}, ${describeForecast(f)}` : describeLeft(r);
    };
    const usage = [...new Set([current, ...this.polyphemus.capacity.keys()])].map((provider) => {
      const readings = this.polyphemus.capacity.get(provider);
      const label = provider === current ? `${provider} (this session)` : `${provider} (not in use)`;
      return `${label}: ${readings?.length ? `${readings.map((r) => withForecast(provider, r)).join('; ')}${staleNote(readings)}` : 'not reported yet'}`;
    });
    const attendance = this.attendance?.length ? ` Who came and went in this thread: ${this.attendance.join('; ')}.` : '';
    return `<polyphemus_status>This session: ${describeModel(this.model)}, on ${runsOn}. Usage by provider: ${usage.join(' · ')}.${this.teamLine()}${attendance}</polyphemus_status>`;
  }

  /** In a thread with several agents: who's here and how to hand the next turn to one of them. */
  private teamLine(): string {
    const team = this.team;
    if (!team) return '';
    return `${this.inThreadLine(team)}${this.peopleLine(team)}${this.teammatesLine(team)}${this.keeperLine(team)}`;
  }

  /**
   * Who looks after polyphemus itself. An agent that needed a new teammate drafted four profiles it
   * had no way to create, and the owner had to go and find the one agent that could (2026-09-19).
   */
  private keeperLine(team: NonNullable<SessionRuntime['team']>): string {
    if (!team.keeper) return '';
    return ` @${team.keeper} is polyphemus's own agent: it can make and change agents, skills, routines and settings, which you can't. When the work needs one of those, @mention @${team.keeper} with what's needed and why, rather than asking the person to do it.`;
  }

  /**
   * Who the people here are, and that an @mention is what reaches them. Alone with an agent too: a
   * reply that needs the owner and doesn't @mention them sits unseen (2026-09-21, a long answer
   * with four questions in it, and no notification).
   */
  private peopleLine(team: NonNullable<SessionRuntime['team']>): string {
    const people = team.people ?? [];
    if (!people.length) return '';
    const who = people.length === 1 ? `The person in this thread is @${people[0]!.handle}.` : `People in this thread: ${people.map((p) => `@${p.handle}`).join(', ')}.`;
    return ` ${who} When your reply needs something from a person — a question, a decision, an approval, something to look at — or hands finished work back to them, @mention them: that's what notifies them. Their name without @ doesn't. Not on a progress note that needs nothing from them.`;
  }

  /**
   * The rest of the team, when there is one: who else could help and with what. Naming one brings a
   * question to the person, not the agent itself — they decide who comes in.
   */
  private teammatesLine(team: NonNullable<SessionRuntime['team']>): string {
    const others = team.others ?? [];
    if (!others.length) return '';
    const who = others.map((o) => `@${o.handle}${o.about ? ` (${o.about})` : ''}`).join(', ');
    // A DM stays the two of you. Agreeing starts a new thread rather than turning this one into a group.
    const agreed = !this.project && team.members.length < 2
      ? 'polyphemus asks the person whether to start a new thread with them. This conversation stays just you and the person. If they agree, the new thread has both of you, and that agent picks up there from your mention.'
      : 'polyphemus asks the person whether to bring them in, and if they agree, that agent joins and picks up from your mention.';
    return ` Teammates not in this thread: ${who}. When one of them is plainly better placed for something here — their specialty, not yours — @mention them in your reply and say why: ${agreed} Only when it would really help; the person can always bring someone in themselves.`;
  }

  private inThreadLine(team: NonNullable<SessionRuntime['team']>): string {
    if (team.members.length < 2) return '';
    const who = team.members.map((m) => `@${m.handle} (${m.id === this.agent?.id ? 'you, ' : ''}${m.id === team.lead ? 'lead, ' : ''}on ${m.runsOn})`).join(', ');
    const guard = team.guard > 0 ? ` After ${team.guard} hand-offs in a row with no person in between, polyphemus pauses and asks the person whether to continue.` : '';
    return ` Agents in this thread: ${who}. You can all read the whole thread, whichever provider you run on. People @mention the agent they want; a message that names no agent gets no answer from any of you, unless the thread is set to have agents answer everything. To hand the next turn to another agent, @mention them in your reply — polyphemus runs their turn next, so the person never relays messages. When another agent spoke to you, asked you something, or you're working on something together, and your reply is for them, @mention them: without it they never get a turn, and the work stops. When you're done and it's back with a person, @mention the person, not an agent. Write a name without @ only when you're talking about someone rather than to them, or quoting what to type.${guard}`;
  }

  private currentProject(): ProjectMeta | undefined {
    return this.project ? (this.polyphemus.store.project(this.project.slug) ?? this.project) : undefined;
  }

  /** What this thread's worker can reach on the network, in words for the agent. */
  private networkNote(): string {
    const spec = this.worker?.spec;
    if (!spec) return '';
    const where = this.project ? `the ${this.project.name} project’s Setup tab` : 'Setup';
    const via = 'through polyphemus’s proxy (HTTP_PROXY and HTTPS_PROXY are set; curl, git, pip and npm use them — Node’s own fetch in the worker doesn’t, so use curl or npm there). DNS lookups inside the worker don’t work; tools that go through the proxy don’t need them.';
    if (spec.network === 'open') return `Network: any public host on ports 80 and 443, ${via} This computer and private networks are never reachable.`;
    if (spec.network === 'granted') return `Network: only these hosts on ports 80 and 443, ${via} Granted: ${(spec.hosts ?? []).join(', ')}. Anything else is refused with a 403 from the proxy; if the work needs another host, say which and why, and the person can grant it on ${where}.`;
    return `Network: none. Nothing in the worker can reach the internet. If the work needs a host (a package registry, an API), say which and why, and the person can grant it on ${where}.`;
  }

  /** A worker for this thread: its project's folder (or its own folder) and memory, and nothing else. */
  private workerSpec(level: IsolationLevel, opts: { binary?: string } = {}): WorkerSpec {
    const home = this.polyphemus.home;
    const mounts: Array<{ path: string; readOnly?: boolean }> = [];
    if (this.project) mounts.push({ path: this.project.path });
    const insideProject = this.project && (this.cwd === this.project.path || this.cwd.startsWith(`${this.project.path}/`));
    // A run's own folder (its clone) is all a run's agent gets of the project: not the main checkout.
    if (this.pushLocked) mounts.length = 0;
    if (!insideProject || this.pushLocked) mounts.push({ path: this.cwd });
    if (this.project) mounts.push({ path: memoryDir(home, this.project.slug) });
    if (this.skills.some((skill) => skill.scope === 'library')) mounts.push({ path: librarySkillsDir(home), readOnly: true });
    // Read-only work gets a worker that can't write anything: nothing else would keep a CLI to reading.
    if (this.readOnly) for (const mount of mounts) mount.readOnly = true;
    if (opts.binary) mounts.push({ path: opts.binary, readOnly: true });
    return {
      key: `${this.project?.slug ?? `folder:${this.cwd}`}|${this.agent?.id ?? ''}|${this.cwd}${this.readOnly ? '|read-only' : ''}${opts.binary ? '|codex' : ''}`,
      mounts,
      ...this.polyphemus.workerNetwork(this.currentProject(), level),
      project: this.project?.slug ?? null,
      workdir: this.cwd,
    };
  }

  close(): void {
    this.bridge?.close();
    this.bridge = undefined;
    this.gateway?.close();
    this.gateway = undefined;
    this.listeners.clear();
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private info(text: string): void {
    this.emit({ type: 'info', text });
  }

  private notice(text: string): void {
    this.emit({ type: 'notice', text });
  }

  private setModel(model: ResolvedModel): void {
    this.model = model;
    this.effort = model.effort;
    if (this.meta) this.polyphemus.store.setModel(this.meta.id, model.provider, model.model);
    this.emit({ type: 'model', model });
  }

  /**
   * Should this tool call run? Asks the client unless yolo or "always" already covers it. "Always"
   * covers that exact call — this command, this file — for the rest of the session, not the whole
   * tool: allowing one `bash` used to allow every bash command after it. A tool name on its own (from
   * permissions.allow in the config) still covers the tool, because that was written on purpose.
   */
  /**
   * The folder file moves in this thread are rooted at: one its agents can't replace. A thread in a
   * project subfolder has that subfolder as its cwd, which the project's agents could swap for a link;
   * the project's folder (or the worker's own mount) is what holds (third review, 2026-09-19).
   */
  fileRoot(): string {
    const mounted = this.worker?.rootFor(this.cwd);
    if (mounted) return mounted;
    const project = this.project?.path;
    return project && (this.cwd === project || this.cwd.startsWith(`${project}/`)) ? project : this.cwd;
  }

  /**
   * A vendor CLI asking to use a tool, in a thread that asks first. The rule polyphemus's own bash tool
   * follows: a command that only reads (and doesn't touch credential files) never needs asking.
   */
  private async approveCliTool(tool: string, toolInput: unknown): Promise<{ allow: boolean; message?: string }> {
    const command = (toolInput as { command?: unknown } | undefined)?.command;
    const readOnly = /^(Bash|run_terminal_command|execute)$/.test(tool) && typeof command === 'string' && isReadOnlyCommand(command) && !mightReachCredentials(command);
    if (readOnly || (await this.decide(`${this.model.provider}:${tool}`, tool, summarizeToolInput((toolInput ?? {}) as Parameters<typeof summarizeToolInput>[0]), this.model.provider))) return { allow: true };
    return {
      allow: false,
      message: this.readOnly
        ? // Said as what it is, not a failure: a read-only routine took "refused" for "the network is down"
          // and reported nothing for a day (2026-09-20).
          `${tool} wasn't run: this thread only reads (it was set to read-only), so files and commands that only read are allowed, and searching or fetching the web, writing, or sending anything isn't. Nothing is broken. Carry on with what you can read, and say what you would have done.`
        : 'The user declined this tool call.',
    };
  }

  private async decide(key: string, tool: string, summary: string, source: string): Promise<boolean> {
    if (this.readOnly) {
      this.notice(`Declined ${tool} (this session is read-only): ${clip(summary, 120)}`);
      return false;
    }
    const exact = `${key} ${summary}`;
    if (this.autoApprove || this.alwaysAllow.has(key) || this.alwaysAllow.has(exact)) return true;
    if (!this.asker) {
      this.notice(`Declined ${tool}: there's no one to ask here (pass -y to allow tools).`);
      return false;
    }
    const answer = await this.asker.approve({ tool, summary, source }, this.activeSignal).catch((): ApprovalAnswer => 'deny');
    if (answer === 'always') this.alwaysAllow.add(exact);
    return answer !== 'deny';
  }

  /** Who a connection call is made for, read at the moment of the call: the speaker can change between turns. */
  private callContext(): CallContext {
    const step = this.work?.step;
    return { project: this.project?.slug, agent: this.agent?.id, sessionId: this.meta?.id, cwd: this.cwd, root: this.fileRoot(), actor: this.sender, ...(step && { step: { runId: step.runId, stepId: step.id } }) };
  }

  /**
   * The connections this turn's speaker may reach, as polyphemus tools. Only granted tools are offered,
   * and each call is checked again when it's made. Anything that isn't a read goes through the same
   * approval as a command: a grant says it may happen, asking is a separate preference.
   */
  private connectionTools(): Tool[] {
    const { connections } = this.polyphemus;
    return connections.reach(this.project?.slug, this.agent?.id).flatMap((reach) =>
      reach.toolDefs.map((def): Tool => ({
        spec: {
          name: connectionToolName(reach.connection, def.name),
          description: `${reach.name} (a connection): ${def.description ?? def.name}`,
          inputSchema: def.inputSchema ?? { type: 'object', properties: {} },
        },
        mutates: !def.reads,
        describe: (input) => `${reach.name} ${def.name}${Object.keys(input).length ? ` ${JSON.stringify(input)}` : ''}`,
        run: async (input) => withPictures(await connections.call(reach.connection, def.name, input, this.callContext())),
      })),
    );
  }

  /**
   * The tools of the work this turn belongs to: planning a run, pointing at evidence, recording a
   * check — or, in a thread with no outcome, offering to track it as one.
   */
  private workTools(): Tool[] {
    return [...this.showTools(), ...this.runAndOfferTools()];
  }

  /**
   * show_artifact: an agent shows what it made, in the thread, instead of telling the person a path.
   * In a run's step it's evidence as well (local: it exists, and nothing outside polyphemus vouches for it).
   */
  private showTools(): Tool[] {
    return [
      {
        spec: {
          name: 'show_artifact',
          description: `Show the person something you made, right in the thread: a chart or page (HTML or SVG), an image (PNG, JPEG, GIF, WebP), a table (CSV) or a document (Markdown). Write the file first, then call this with its path. Supported: ${ARTIFACT_EXTENSIONS.join(', ')}. An HTML page is shown sandboxed — no network and no outside scripts, so inline everything it needs.`,
          inputSchema: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string', description: 'What it is, in a few words.' } }, required: ['path'] },
        },
        mutates: false,
        describe: (input) => String(input.title ?? input.path ?? ''),
        run: async (input) => {
          if (!this.meta) return { content: 'There’s no thread to show it in yet.', isError: true };
          if (typeof input.path !== 'string' || !input.path) return { content: 'Give the path of the file to show.', isError: true };
          try {
            const step = this.work?.step;
            const shown = resolvePath(this.cwd, input.path);
            if (this.worker && !this.worker.allows(shown)) return { content: notGranted(shown), isError: true };
            const artifact = keepArtifact(this.polyphemus.home, shown, {
              sessionId: this.meta.id,
              seq: this.history.length,
              title: typeof input.title === 'string' ? input.title : undefined,
              by: this.agent ? `agent:${this.agent.id}` : undefined,
              stepId: step?.id,
              ...(this.worker && { within: this.worker.rootFor(shown) }),
            });
            this.polyphemus.store.recordArtifact(artifact);
            if (step) this.polyphemus.store.runs.addEvidence({ runId: step.runId, stepId: step.id, kind: 'file', label: artifact.title, detail: `${artifact.name} · shown in the thread`, ok: true });
            this.emit({ type: 'artifact', artifact });
            return { content: `Shown in the thread as “${artifact.title}”. The person can see it now; don’t paste it again.` };
          } catch (err) {
            return { content: (err as Error).message, isError: true };
          }
        },
      },
    ];
  }

  /**
   * The project's rules for an agent CLI. Claude Code reads CLAUDE.md, not AGENTS.md, so it's always
   * handed them. The others read AGENTS.md from where they start — which a run's worktree, fresh from
   * GitHub, may not have — so they're handed them whenever the folder doesn't hold that file itself.
   */
  private rulesFor(adapter: string | undefined): string {
    if (!this.projectRules) return '';
    if (adapter === 'claude-cli') return this.projectRules;
    return this.project && this.cwd !== this.project.path && !existsSync(join(this.cwd, 'AGENTS.md')) ? this.projectRules : '';
  }

  private runAndOfferTools(): Tool[] {
    if (this.work) return runTools(this.polyphemus.store.runs, this.work, this.cwd);
    return [...this.proposeWorkTools(), ...this.proposeRoutineTools(), ...this.proposeProfileTools(), ...this.rememberTools(), ...this.proposeSkillTools(), ...this.requestSecretTools(), ...this.requestSignInTools(), ...this.offerTools()];
  }

  /** Work an agent found — in an audit, a review, a routine — proposed for a person to decide on. */
  private proposeWorkTools(): Tool[] {
    const propose = this.proposeWork;
    if (!propose || !this.project) return [];
    return [
      {
        spec: {
          name: 'propose_work',
          description:
            'Propose something for this project that needs doing but isn’t what you were asked to do now: a problem an audit found, an idea, feedback someone gave. It waits for a person, who makes work of it or dismisses it. One proposal per thing; don’t use it for what you can just answer.',
          inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['finding', 'idea', 'feedback'] }, text: { type: 'string', description: 'What it is and why it matters, with enough detail to act on.' } }, required: ['kind', 'text'] },
        },
        mutates: false,
        describe: (input) => `${String(input.kind ?? '')}: ${String(input.text ?? '').slice(0, 80)}`,
        run: async (input) => {
          const text = typeof input.text === 'string' ? input.text.trim() : '';
          const kind = ['finding', 'idea', 'feedback'].includes(String(input.kind)) ? (input.kind as 'finding' | 'idea' | 'feedback') : 'finding';
          if (!text) return { content: 'Say what it is.', isError: true };
          return { content: propose(kind, text.slice(0, 8000)) };
        },
      },
    ];
  }

  /**
   * Scheduled work is a poly routine, run by polyphemus's own scheduler. A CLI's session schedulers
   * (Claude Code's cron) die with the turn, so they're off; this is how an agent asks for one instead.
   */
  private proposeRoutineTools(): Tool[] {
    const propose = this.proposeRoutine;
    if (!propose) return [];
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    return [
      {
        spec: {
          name: 'propose_routine',
          description:
            'Propose a routine: work polyphemus runs on a schedule, as an agent, whether or not anyone has a thread open. It waits for a person to accept it; nothing is scheduled until they do. Use this for anything recurring or for later — never a session cron or a sleep, which stop when your turn ends. Give exactly one of cron (with tz), every, or once. It belongs to this project if the thread is in one; scope "personal" makes it the person\'s own instead, with none of this project\'s rules or memory — use that for anything that isn\'t this project\'s work. The name of a routine that already exists proposes a change to it; stop: true proposes stopping it. Never write a routine file yourself.',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'A short name, like daily-x-post.' },
              description: { type: 'string', description: 'One line: what it’s for.' },
              prompt: { type: 'string', description: 'What to do each time it runs, written to the agent that will do it: where to look, what to produce, where to record it.' },
              cron: { type: 'string', description: 'A cron expression, like "17 9,14,19 * * *".' },
              tz: { type: 'string', description: 'The time zone for cron, like America/Chicago.' },
              every: { type: 'string', description: 'An interval, like 30m or 6h.' },
              once: { type: 'string', description: 'A single time, like "2026-09-20 08:00".' },
              mode: { type: 'string', enum: ['ask', 'read-only'], description: 'ask (the default): changes and posts wait for a person, and with nobody there they don\'t happen. read-only: it can only read, not search the web or write. If it has to run without asking, say so in your reply: the person can set that on the routine in the app.' },
              scope: { type: 'string', enum: ['project', 'personal'], description: 'project (the default in a project): this project\'s. personal: the person\'s own, outside every project.' },
              stop: { type: 'boolean', description: 'Propose stopping the routine with this name: it\'s removed once a person accepts.' },
            },
            required: ['name'],
          },
        },
        mutates: false,
        describe: (input) => `${text(input.name)}: ${text(input.cron) || text(input.every) || text(input.once)}`,
        run: async (input) => {
          const scope = input.scope === 'personal' ? 'personal' : input.scope === 'project' ? 'project' : undefined;
          if (input.stop === true) return { content: propose({ name: text(input.name), schedule: {}, prompt: '', mode: 'ask', stop: true, ...(scope && { scope }) }) };
          const schedules = [text(input.cron), text(input.every), text(input.once)].filter(Boolean);
          if (schedules.length !== 1) return { content: 'Give exactly one schedule: cron (with tz), every, or once.', isError: true };
          if (!text(input.prompt)) return { content: 'Say what the routine should do each time it runs.', isError: true };
          return {
            content: propose({
              ...(scope && { scope }),
              name: text(input.name),
              description: text(input.description),
              ...(this.agent && { agent: this.agent.id }),
              schedule: { ...(text(input.cron) && { cron: text(input.cron), ...(text(input.tz) && { tz: text(input.tz) }) }), ...(text(input.every) && { every: text(input.every) }), ...(text(input.once) && { once: text(input.once) }) },
              prompt: text(input.prompt).slice(0, 8000),
              mode: input.mode === 'read-only' ? 'read-only' : 'ask',
            }),
          };
        },
      },
    ];
  }

  /**
   * An agent's own profile — who it is, what it does here, its one-line description — is a person's to
   * accept: it's what every later thread with it starts from. This is how it asks for a change.
   */
  private proposeProfileTools(): Tool[] {
    const propose = this.proposeProfile;
    if (!propose || !this.agent) return [];
    const agent = this.agent;
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : undefined);
    return [
      {
        spec: {
          name: 'propose_profile',
          description: `Propose a change to your own profile — persona (who you are and how you work), instructions (what you do here), description (one line) — for ${agent.title}. Send the whole new text of what you're changing, not a patch, and only what's changing. A person accepts or declines it; nothing changes until they do. Don't edit your profile's files yourself.`,
          inputSchema: {
            type: 'object',
            properties: {
              persona: { type: 'string', description: 'The whole new persona.md.' },
              instructions: { type: 'string', description: 'The whole new instructions.md.' },
              description: { type: 'string', description: 'One line: what you’re for.' },
              why: { type: 'string', description: 'Why it should change, in a sentence or two: what happened that the profile doesn’t match.' },
            },
            required: ['why'],
          },
        },
        mutates: false,
        describe: (input) => `${agent.title}: ${['persona', 'instructions', 'description'].filter((f) => text(input[f])).join(', ') || 'nothing'}`,
        run: async (input) => {
          const change = { ...(text(input.persona) !== undefined && { persona: text(input.persona)! }), ...(text(input.instructions) !== undefined && { instructions: text(input.instructions)! }), ...(text(input.description) !== undefined && { description: text(input.description)! }) };
          if (Object.keys(change).length === 0) return { content: 'Send the new persona, instructions or description.', isError: true };
          return { content: propose({ ...change, why: text(input.why) ?? '' }) };
        },
      },
    ];
  }

  /**
   * Who's in this thread, for memory: you're alone with an agent when it's the only agent and you're the
   * only person. Anything else — another person, another agent — is a more open room.
   */
  private aloneWith(): { alone: boolean; person?: string } {
    const person = this.sender?.startsWith('person:') ? this.sender.slice(7) : undefined;
    if (!this.agent || !person) return { alone: false };
    if (!this.meta) return { alone: true, person };
    const agent = this.agent;
    const agents = this.polyphemus.store.members(this.meta.id);
    const people = this.polyphemus.store.peopleIn(this.meta.id);
    const alone = agents.every((id) => id === agent.id || id === agent.name) && people.every((id) => id === person);
    return { alone, ...(alone && { person }) };
  }

  /** What this agent remembers that may be recalled here. */
  private memoryNote(): string {
    if (!this.agent) return '';
    const { alone, person } = this.aloneWith();
    return memoryBriefing(this.polyphemus.home, {
      agent: this.agent.id,
      agentTitle: this.agent.title,
      alone,
      ...(person && { person, personName: this.polyphemus.store.person(person)?.name ?? 'they' }),
    });
  }

  /**
   * A way of doing something, worth doing the same way again — drafted as a skill, never written: a
   * person decides whether it's kept, and whose it is (the agent's own, every agent's, the project's).
   */
  private proposeSkillTools(): Tool[] {
    const propose = this.proposeSkill;
    if (!propose || !this.agent) return [];
    const agent = this.agent;
    const where = ['agent', 'library', ...(this.project ? ['project'] : [])];
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    return [
      {
        spec: {
          name: 'propose_skill',
          description: `When you've worked out how to do something well that will come up again — steps, checks, the order things go in, what to watch for — draft it as a skill: instructions opened when that kind of work comes up, so next time starts from what worked. A person reads it and decides whether it's kept, and whose it is: yours (${agent.title}'s own, going wherever you go), every agent's${this.project ? ', or this project’s' : ''}. How to do something is a skill; a fact or a decision is for remember. Check your skills list first: don't propose one you already have.`,
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Lowercase words with dashes, like reconcile-statements.' },
              description: { type: 'string', description: 'One line: when this skill is worth opening. It’s what decides whether it’s used.' },
              body: { type: 'string', description: 'The skill itself, in markdown: when to use it, the steps, the checks, and what goes wrong.' },
              why: { type: 'string', description: 'What happened that makes this worth keeping, in a sentence or two.' },
              where: { type: 'string', enum: where, description: 'Whose you think it should be; the person decides.' },
            },
            required: ['name', 'description', 'body', 'why'],
          },
        },
        mutates: false,
        describe: (input) => `${agent.title}: ${text(input.name)}`,
        run: async (input) => {
          const name = text(input.name).toLowerCase();
          if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return { content: 'Name it with lowercase letters, numbers and dashes, like reconcile-statements.', isError: true };
          if (!text(input.description) || !text(input.body)) return { content: 'A skill needs a one-line description and its steps.', isError: true };
          const chosen = where.includes(text(input.where)) ? (text(input.where) as 'agent' | 'library' | 'project') : 'agent';
          return { content: propose({ name, description: text(input.description).slice(0, 400), body: text(input.body).slice(0, 20_000), why: text(input.why).slice(0, 800), where: chosen }) };
        },
      },
    ];
  }

  /** A connection granted to this thread, by its name or its id. Failing health still counts: that's when it needs signing in again. */
  private connectionForSignIn(name: string): Connection | undefined {
    const wanted = name.trim().toLowerCase();
    const project = this.project?.slug;
    const agent = this.agent?.id;
    if (!wanted || (!project && !agent)) return undefined;
    const granted = new Set(
      this.polyphemus.connections.store
        .grants()
        .filter((g) => (project !== undefined && g.project === project) || (agent !== undefined && g.agent === agent && g.project === ''))
        .map((g) => g.connection),
    );
    return this.polyphemus.connections.list().find((c) => granted.has(c.id) && (c.id === wanted || c.name.toLowerCase() === wanted));
  }

  /**
   * A sign-in the agent needs and must not see. OAuth opens the service's own page; a site opens the
   * browser on this computer. This hears only whether they finished, and whether the thread can use it.
   */
  private requestSignInTools(): Tool[] {
    const ask = this.requestSignIn;
    if (!ask) return [];
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    return [
      {
        spec: {
          name: 'request_sign_in',
          description:
            'Ask the person to sign in, when a connection this thread can use needs a sign-in. Name the connection. For the browser, also give the site (https://example.com/login). They sign in on Polyphemus’s own page — the service’s sign-in, or a browser on this computer — and you hear that they finished, never a password, token or cookie. If it’s held back because other people are in the project, you’re told that and you can’t use it. A key is request_secret, not this. A GitHub identity or Finance is set up from Connections, not from a thread. Don’t ask twice while one card is open.',
          inputSchema: {
            type: 'object',
            properties: {
              connection: { type: 'string', description: 'The connection’s name, as you were offered it.' },
              url: { type: 'string', description: 'The site to open, for the browser connection only.' },
              purpose: { type: 'string', description: 'What it’s for, in a few words, shown on the card.' },
            },
            required: ['connection', 'purpose'],
          },
        },
        mutates: false,
        describe: (input) => `${text(input.connection)}: ${text(input.purpose).slice(0, 80)}`,
        run: async (input, ctx) => {
          const named = text(input.connection);
          const purpose = text(input.purpose).slice(0, 200);
          if (!named) return { content: 'Name the connection to sign in to.', isError: true };
          if (!purpose) return { content: 'Say what it’s for, in a few words.', isError: true };
          const connection = this.connectionForSignIn(named);
          if (!connection) return { content: `No connection called "${named}" that this thread can use. If it isn’t set up yet, they’ll add it from Connections and grant it here.`, isError: true };
          const server = connection.server;
          if (server.kind === 'builtin' && server.builtin === 'finance') return { content: 'Finance is linked from Connections, not from a thread.', isError: true };
          if (server.kind !== 'builtin' && server.auth === 'github-app') return { content: `${connection.name} is a GitHub identity. The owner sets that up from Connections, not from a thread.`, isError: true };
          if (server.kind === 'builtin' && server.builtin === 'browser') {
            if (!this.project) return { content: 'A site sign-in is kept for a project. This thread isn’t in one.', isError: true };
            let url = text(input.url);
            if (!url) return { content: 'Say the site to open, like https://example.com/login.', isError: true };
            if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
            const site = siteOf(url);
            if (!site) return { content: `"${text(input.url)}" isn’t an address to sign in at.`, isError: true };
            const project = this.project.slug;
            const kept = this.polyphemus.connections.signIns(connection.id).filter((s) => s.site === site && s.projects.includes(project));
            const usable = kept.find((s) => this.polyphemus.connections.signInHeldBack(s, project) === undefined);
            if (usable) return { content: `Already signed in to ${site}. You can use it.` };
            const blocked = kept.map((s) => this.polyphemus.connections.signInHeldBack(s, project)).find((why) => why !== undefined);
            if (blocked) return { content: `A sign-in to ${site} is kept, and held back: ${blocked} You can’t use it from this thread.`, isError: true };
            const result = await ask({ connection: connection.id, name: connection.name, how: 'browser', url, site, purpose }, ctx.signal);
            if (!result || result.status === 'decline') return { content: result ? `They didn’t sign in to ${site}. Carry on without it, and say what you couldn’t do.` : 'The turn stopped before they signed in.', isError: true };
            if (result.status === 'waiting') return { content: `You’ve already asked them to sign in to ${site}. It’s waiting; don’t ask again.` };
            if (result.heldBack) return { content: `They signed in to ${site}, and it’s held back: ${result.heldBack} You can’t use it from this thread.`, isError: true };
            return { content: `Signed in to ${site}. You can use it. You don’t have the cookies.` };
          }
          if (server.kind !== 'builtin' && server.auth === 'oauth') {
            if (this.polyphemus.connections.signedIn(connection.id) && connection.health !== 'failing') return { content: `Already signed in to ${connection.name}. You can use it.` };
            const result = await ask({ connection: connection.id, name: connection.name, how: 'oauth', purpose }, ctx.signal);
            if (!result || result.status === 'decline') return { content: result ? `They didn’t sign in to ${connection.name}. Carry on without it, and say what you couldn’t do.` : 'The turn stopped before they signed in.', isError: true };
            if (result.status === 'waiting') return { content: `You’ve already asked them to sign in to ${connection.name}. It’s waiting; don’t ask again.` };
            return { content: `Signed in to ${connection.name}. You can use it. You don’t have the token.` };
          }
          return { content: `${connection.name} uses a key, not a sign-in. Ask for it with request_secret, and don’t ask them to paste it into the thread.`, isError: true };
        },
      },
    ];
  }

  /**
   * A credential the agent needs and must not see. The person types it into Polyphemus's own card;
   * this hears only whether they saved it. The reference is what later work can name.
   */
  private requestSecretTools(): Tool[] {
    const request = this.requestSecret;
    if (!request) return [];
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    return [
      {
        spec: {
          name: 'request_secret',
          description:
            'Ask the person for a credential you must not see: an API key, a token, a password. Name it (like aws/site) and say what it’s for. They type it into Polyphemus, which keeps it in the vault. You get back secret:that-name and nothing else — never the value, and nothing can put it into a command yet. Prefer a GitHub identity or a deploy role when one of those can do the job. Don’t ask twice for the same name while one card is open, and don’t ask them to paste it into the thread.',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'A vault name: lowercase words separated by / . _ or -, like aws/site.' },
              purpose: { type: 'string', description: 'What it’s for, in a few words, shown on the card.' },
            },
            required: ['name', 'purpose'],
          },
        },
        mutates: false,
        describe: (input) => `${text(input.name)}: ${text(input.purpose).slice(0, 80)}`,
        run: async (input, ctx) => {
          const name = text(input.name);
          const purpose = text(input.purpose).slice(0, 200);
          if (!SECRET_NAME.test(name)) return { content: `"${name}" isn’t a secret name. Use lowercase words separated by / . _ or -, like aws/site.`, isError: true };
          if (!purpose) return { content: 'Say what it’s for, in a few words.', isError: true };
          const result = await request(name, purpose, ctx.signal);
          if (result === 'waiting') return { content: `You’ve already asked for ${secretRef(name)}. It’s waiting on them; don’t ask again.` };
          if (result === 'saved') return { content: `Saved as ${secretRef(name)}. You don’t have the value, and nothing can put it into a command yet. Tell them what you were going to do with it.` };
          if (result === undefined) return { content: 'The turn stopped before it was saved.', isError: true };
          return { content: 'They didn’t save it. Carry on without it, and say what you couldn’t do.', isError: true };
        },
      },
    ];
  }

  /** Something worth keeping past this thread — proposed, never written: a person decides, and decides where. */
  private rememberTools(): Tool[] {
    const propose = this.proposeNote;
    if (!propose || !this.agent) return [];
    const { alone } = this.aloneWith();
    const here = scopesHere({ alone, ...(this.project && { project: this.project.slug }) });
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    return [
      {
        spec: {
          name: 'remember',
          description:
            `Propose something to remember past this thread: a lasting fact, a decision and why, or a lesson about your work. A person accepts it and it's kept then, not before. Where it can come back again is the point: ${here.map((scope) => `${scope} (${MEMORY_SCOPE_WORDS[scope]})`).join('; ')}. Keep people and anything private out of a craft note — it comes back in rooms they aren't in. Don't use it for what belongs in this thread alone.`,
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'A few words naming it, like what-gets-replies.' },
              description: { type: 'string', description: 'One line: when this is worth reading again.' },
              text: { type: 'string', description: 'What to remember, with the why, in a few lines.' },
              scope: { type: 'string', enum: here, description: 'Where it may be recalled.' },
            },
            required: ['name', 'description', 'text', 'scope'],
          },
        },
        mutates: false,
        describe: (input) => `${text(input.scope)}: ${text(input.name)}`,
        run: async (input) => {
          if (!text(input.name) || !text(input.text)) return { content: 'Say what to remember, and name it.', isError: true };
          try {
            const scope = checkScope(text(input.scope), here);
            return { content: propose({ name: text(input.name), description: text(input.description), text: text(input.text).slice(0, 8000), scope }) };
          } catch (err) {
            return { content: (err as Error).message, isError: true };
          }
        },
      },
    ];
  }

  private offerTools(): Tool[] {
    if (!this.proposeOutcome || !this.meta || this.polyphemus.store.runs.outcome(this.meta.id)) return [];
    const propose = this.proposeOutcome;
    return [
      {
        spec: {
          name: 'propose_outcome',
          description:
            'Offer to track this thread as work with an outcome, when the person has asked for something that takes several steps or whose result needs checking. They accept or decline; don’t use it for a question you can simply answer.',
          inputSchema: { type: 'object', properties: { outcome: { type: 'string', description: 'What it’s trying to achieve, in a few words.' }, why: { type: 'string' } }, required: ['outcome', 'why'] },
        },
        mutates: false,
        describe: (input) => String(input.outcome ?? ''),
        run: async (input) => {
          const text = typeof input.outcome === 'string' ? input.outcome.trim() : '';
          if (!text) return { content: 'Say what the outcome is.', isError: true };
          return { content: propose(text.slice(0, 120), typeof input.why === 'string' ? input.why.trim().slice(0, 300) : '') };
        },
      },
    ];
  }

  /**
   * A connection's tool the model named without being offered it. It still goes to the call layer,
   * so the refusal is made there and recorded against the connection — not lost as "unknown tool".
   */
  private unofferedConnectionTool(name: string): Tool | undefined {
    const { connections } = this.polyphemus;
    for (const connection of connections.list()) {
      const def = connection.tools.find((t) => connectionToolName(connection.id, t.name) === name);
      if (!def) continue;
      const describe = (input: Record<string, unknown>) => `${connection.name} ${def.name}${Object.keys(input).length ? ` ${JSON.stringify(input)}` : ''}`;
      return {
        spec: { name, description: def.description ?? def.name, inputSchema: def.inputSchema ?? { type: 'object', properties: {} } },
        // Nobody is asked to approve a call that's about to be refused. If it was granted since the
        // turn began, a call that changes things is asked about here instead.
        mutates: false,
        describe,
        run: async (input) => {
          const context = this.callContext();
          const granted = connections.reach(context.project, context.agent).some((r) => r.connection === connection.id && r.tools.includes(def.name));
          if (granted && !def.reads && !(await this.decide(name, name, describe(input), 'polyphemus'))) return { content: 'The user declined this call.', isError: true };
          return withPictures(await connections.call(connection.id, def.name, input, context));
        },
      };
    }
    return undefined;
  }

  /** The same tools, for an agent CLI through the gateway: listed and checked live, approved the same way. */
  /** Isolated: the CLI's own file tools are off, so these — run in the worker — stand in. */
  private fileToolsForCli(): Tool[] {
    return this.isolatedFiles && this.worker ? [readFileTool, writeFileTool, editFile] : [];
  }

  private gatewayTools(): { list(): GatewayTool[]; call(name: string, args: Record<string, unknown>): Promise<CallResult> } {
    return {
      list: () => [...this.fileToolsForCli(), ...this.connectionTools(), ...this.workTools()].map((tool) => tool.spec),
      call: async (name, args) => {
        const tool = [...this.fileToolsForCli(), ...this.connectionTools(), ...this.workTools()].find((t) => t.spec.name === name);
        if (!tool) {
          // Not granted (any more): polyphemus.connections refuses it, and records that it did.
          const target = this.polyphemus.connections.list().flatMap((c) => c.tools.filter((t) => connectionToolName(c.id, t.name) === name).map((t) => ({ connection: c.id, tool: t.name })))[0];
          return this.polyphemus.connections.call(target?.connection ?? name, target?.tool ?? name, args, this.callContext());
        }
        const summary = tool.describe(args);
        if (tool.mutates && !(await this.decide(name, name, summary, 'polyphemus'))) {
          return { content: this.readOnly ? `${name} wasn't run: this thread only reads (it was set to read-only), so only calls that read are allowed. Nothing is broken.` : 'The user declined this call.', isError: true };
        }
        // The turn's signal, so a card that waits — a secret, a sign-in — expires when the turn stops.
        const result = await tool.run(args, { cwd: this.cwd, ...(this.worker && { worker: this.worker }), ...(this.activeSignal && { signal: this.activeSignal }) });
        // Pictures go on to the CLI as MCP image content: Claude Code and Codex show them to their model.
        const images = (result.images ?? []).flatMap(({ bytes }) => {
          const mediaType = imageType(bytes);
          return mediaType ? [{ mediaType, data: Buffer.from(bytes).toString('base64') }] : [];
        });
        return { content: result.content, isError: result.isError === true, ...(images.length && { images }) };
      },
    };
  }

  private async chooseFallback(reason: string, tried: ReadonlySet<string>, retry: boolean, signal: AbortSignal): Promise<ResolvedModel | undefined> {
    const { candidates, explicit, skippedMetered } = fallbackCandidates(this.polyphemus.config, this.model, {
      isReady: (provider) => this.polyphemus.status(provider).ready,
      isOut: (provider) => this.polyphemus.unavailable(provider) !== undefined,
      knownModel: (provider) => this.polyphemus.store.lastModelOn(provider),
      tried,
    });
    const policy = this.polyphemus.config.routing.onFallback;
    if (skippedMetered.length > 0) {
      this.info(`Not falling back to ${skippedMetered.map((m) => describeModel(m)).join(', ')}: ${skippedMetered.length === 1 ? 'it’s' : 'they’re'} billed per token, and falling back onto per-token billing is off (routing.allow_metered).`);
    }
    if (candidates.length === 0) {
      this.notice(`${reason}. No other model is ready right now: wait for the reset, or set one up in Setup, under Models & providers (in the terminal, /login).`);
      this.pausedBecause = `${reason}, and no other model is ready`;
      return undefined;
    }
    if (policy === 'pause') {
      this.notice(`${reason}. Pausing, as configured (on_fallback = "pause"). Pick another model at the top of the thread when you're ready (in the terminal, /model).`);
      this.pausedBecause = `${reason}. Paused, as your fallback setting says`;
      return undefined;
    }
    if (policy === 'continue' && explicit) {
      this.notice(`${reason}. Switching to ${describeModel(candidates[0]!)}, next in your fallback list.`);
      return candidates[0];
    }
    if (!this.asker) {
      this.notice(`${reason}. Not switching without asking: add a [routing] fallback list with on_fallback = "continue" to switch automatically here.`);
      this.pausedBecause = `${reason}, and there was nobody to ask about switching`;
      return undefined;
    }
    this.notice(reason);
    const picked = await this.asker.chooseFallback({ reason, candidates, retry }, signal).catch(() => undefined);
    if (!picked) {
      this.notice('Staying put. Pick another model at the top of the thread when you want to (in the terminal, /model).');
      this.pausedBecause = `${reason}. You chose to stay on it`;
    }
    return picked;
  }

  private async runOnce(input: string | undefined, signal: AbortSignal, images: ImageBlock[]): Promise<StopReason> {
    const { polyphemus } = this;
    // Your list of models is the limit, whatever set this one — an agent made on another, a thread
    // started with it, a model file edited by hand. Checked here because every turn passes here.
    const offTheList = offList(polyphemus.config, this.model);
    if (offTheList) throw new PolyphemusError(this.agent ? `${this.agent.title} is set to run on ${offTheList.replace(' isn’t', ', which isn’t')}` : offTheList, 'USAGE');
    const provider = polyphemus.registry.get(this.model.provider);
    const nearlyOut = (polyphemus.capacity.get(provider.id) ?? []).filter((r) => (r.usedPct ?? 0) >= NEARLY_OUT_PCT);
    if (nearlyOut.length > 0) {
      this.notice(`${provider.id} is nearly out (${nearlyOut.map(formatUsage).join(', ')}). If this turn fails, switch with /model.`);
    }
    // Warn once per window when the forecast says it won't last until its reset.
    for (const f of polyphemus.forecasts(provider.id)) {
      const key = `${f.provider}:${f.window}:${f.resetsAt ?? ''}`;
      if (f.status !== 'short' || this.forecastWarned.has(key)) continue;
      this.forecastWarned.add(key);
      this.notice(`${provider.id}'s ${f.window} window: ${describeForecast(f)}. Save big work as you go, or switch with /model.`);
    }
    if (!this.meta) {
      this.meta = polyphemus.store.create({ startedBy: this.sender, agent: this.agent?.id, title: clip(input || (images.length > 0 ? 'Image' : ''), 60), provider: this.model.provider, model: this.model.model, cwd: this.cwd });
      this.emit({ type: 'session', session: this.meta });
    }
    const session = this.meta;

    // Claude Code's permission prompts come to the client instead of being denied.
    const relayApprovals =
      provider.kind === 'agent' && polyphemus.config.providers[provider.id]?.adapter === 'claude-cli' && (this.asker !== undefined || this.readOnly) && !this.autoApprove;
    if (relayApprovals) {
      this.bridge ??= await startApprovalBridge(({ tool, input: toolInput }) => this.approveCliTool(tool, toolInput));
    }
    const approve: Approver = (_call, tool, summary) => this.decide(tool.spec.name, tool.spec.name, summary, 'polyphemus');
    let shell: ShellWrapper | undefined;
    let bridge: CodexBridge | undefined;
    let grokWorker: Worker | undefined;
    let grokStats: GrokIsolationStats | undefined;
    const adapter = polyphemus.config.providers[provider.id]?.adapter;

    // Where this turn's commands and file changes run (docs/design/isolation.md). Isolated fails
    // closed: anything that can't run in a worker yet is refused, never quietly run on this computer.
    // Read fresh: a project's level or its network grant may have changed since this thread opened.
    const level = polyphemus.isolationFor(this.currentProject());
    this.worker = undefined;
    if (level === 'host') {
      if (!polyphemus.hostNoted.has(session.id)) {
        polyphemus.hostNoted.add(session.id);
        this.info(`${ISOLATION_WORDS.host.title}: ${ISOLATION_WORDS.host.says}`);
      }
    } else {
      const words = ISOLATION_WORDS[level].title;
      const broken = polyphemus.isolationBroken.get(adapter ?? '');
      if (provider.kind === 'agent' && broken) {
        throw new PolyphemusError(`${CLI_NAMES[adapter ?? ''] ?? provider.id} isn’t offered where agents are isolated any more: ${broken} Pick an API model for this thread, or set the project to On this computer on its Setup tab.`, 'USAGE');
      }
      if (provider.kind === 'agent' && adapter !== 'claude-cli' && adapter !== 'codex-cli' && adapter !== 'grok-cli') {
        throw new PolyphemusError(`${CLI_NAMES[polyphemus.config.providers[provider.id]?.adapter ?? ''] ?? provider.id} can’t run isolated yet, and ${this.project ? `${this.project.name} is` : 'this install is'} set to ${words}, so it wasn’t started. Pick an API model for this thread, or set the project to On this computer on its Setup tab.`, 'USAGE');
      }
      if (!polyphemus.runtime()) {
        throw new PolyphemusError(`${this.project ? `${this.project.name} is` : 'This install is'} set to ${words}, but there’s no Docker or Podman on this computer to isolate it in, so nothing was run. Install one, or choose On this computer in Setup.`, 'USAGE');
      }
      if (adapter === 'codex-cli' && provider.kind === 'agent') {
        // Codex's exec-server runs in the worker from Codex's own binary, mounted read-only.
        const binary = codexBinary((provider as CodexAgent).command);
        if (!binary)
          throw new PolyphemusError(
            process.platform === 'linux'
              ? 'Codex isn’t installed where polyphemus can find its binary, so it can’t run isolated.'
              : 'Codex can’t run isolated on this computer: its worker is Linux, and the Codex installed here has no Linux build to run there. Pick an API model for this thread, or set the project to On this computer on its Setup tab.',
            'USAGE',
          );
        this.worker = await polyphemus.workers.get(this.workerSpec(level, { binary }));
        const check = await polyphemus.codexIsolationCheck(provider, this.worker, binary, this.model.model, signal, () => this.info('Checking, once for this version of Codex, that its commands run in the worker…'));
        if (!check.ok) {
          const why = `polyphemus’s check that its commands run in the worker didn’t pass (${check.detail}).`;
          polyphemus.isolationBroken.set('codex-cli', why);
          throw new PolyphemusError(`Codex isn’t offered where agents are isolated: ${why} Pick an API model for this thread, or set the project to On this computer on its Setup tab.`, 'USAGE');
        }
        bridge = await startCodexBridge(this.worker, binary);
      } else {
        this.worker = await polyphemus.workers.get(this.workerSpec(level));
      }
      if (provider.kind === 'agent' && adapter === 'grok-cli') {
        const check = await polyphemus.grokIsolationCheck(provider, this.worker, this.model.model, signal, () => this.info('Checking, once for this version of Grok Build, that its commands run in the worker…'));
        if (!check.ok) {
          const why = `polyphemus’s check that its commands run in the worker didn’t pass (${check.detail}).`;
          polyphemus.isolationBroken.set('grok-cli', why);
          throw new PolyphemusError(`Grok Build isn’t offered where agents are isolated: ${why} Pick an API model for this thread, or set the project to On this computer on its Setup tab.`, 'USAGE');
        }
        grokWorker = this.worker;
      }
      if (provider.kind === 'agent' && adapter === 'claude-cli') {
        const check = await polyphemus.claudeIsolationCheck(provider, this.worker, signal, () => this.info('Checking, once for this version of Claude Code, that its commands run in the worker…'));
        if (!check.ok) {
          const why = `polyphemus’s check that its commands run in the worker didn’t pass (${check.detail}).`;
          polyphemus.isolationBroken.set('claude-cli', why);
          throw new PolyphemusError(`Claude Code isn’t offered where agents are isolated: ${why} Pick an API model for this thread, or set the project to On this computer on its Setup tab.`, 'USAGE');
        }
        shell = claudeShellWrapper(this.worker);
      }
    }

    // Connections reach an agent CLI through polyphemus's gateway. Claude Code and Codex take MCP servers
    // headlessly, and so does Grok Build on this computer, over ACP (2026-09-22). Isolated Grok doesn't
    // yet, so it's told, once, rather than silently going without.
    const reachable = provider.kind === 'agent' ? polyphemus.connections.reach(this.project?.slug, this.agent?.id) : [];
    const gatewayCli = adapter === 'claude-cli' || adapter === 'codex-cli' || (adapter === 'grok-cli' && !grokWorker);
    // The gateway carries a run's tools too, so a CLI can plan and point at evidence like an API model.
    // Isolated Claude Code gets its file tools from polyphemus, so it always needs the gateway.
    this.isolatedFiles = shell !== undefined;
    // Isolated Codex runs no MCP servers (its exec-server doesn't start them), so it has no gateway: said once.
    const needsGateway = gatewayCli && provider.kind === 'agent' && !bridge && (reachable.length > 0 || this.workTools().length > 0 || this.isolatedFiles);
    if (bridge && reachable.length > 0 && !this.unreachableNoted) {
      this.unreachableNoted = true;
      this.notice(`${reachable.map((r) => r.name).join(', ')} ${reachable.length === 1 ? 'is' : 'are'} granted here, but Codex can’t use connections while it’s isolated. Switch to Claude Code or an API model to use ${reachable.length === 1 ? 'it' : 'them'}.`);
    }
    if (needsGateway) this.gateway ??= await startConnectionGateway(this.gatewayTools());
    if (reachable.length > 0 && !gatewayCli && !this.unreachableNoted) {
      this.unreachableNoted = true;
      this.notice(`${reachable.map((r) => r.name).join(', ')} ${reachable.length === 1 ? 'is' : 'are'} granted here, but ${CLI_NAMES[adapter ?? ''] ?? provider.id} can't use connections yet. Switch to Claude Code, Codex or an API model to use ${reachable.length === 1 ? 'it' : 'them'}.`);
    }

    // Codex's sandbox may not be able to start on this computer at all, and then the agent can only
    // guess at why in chat. Polyphemus checks for itself (codex-sandbox.ts) and says so, once a thread.
    if (provider instanceof CodexAgent && !this.autoApprove && !bridge && !polyphemus.sandboxNoted.has(session.id)) {
      if (!provider.sandboxed && !this.readOnly) {
        // The owner turned it off: said once a thread, so nobody mistakes it for the sandboxed default.
        polyphemus.sandboxNoted.add(session.id);
        this.notice(`${provider.id} runs without its sandbox on this computer, as the owner set in Models & providers: the commands it runs have the owner's full permissions and aren't asked about first.`);
      } else {
        const check = await polyphemus.sandboxCheck(provider.command);
        if (check && !check.ok) {
          polyphemus.sandboxNoted.add(session.id);
          this.notice(sandboxNotice(check, provider.id));
        }
      }
    }

    const startedAt = Date.now();
    const native = provider.kind === 'agent' ? this.nativeState(session.id, provider.id) : undefined;
    // Where this turn starts in the thread, and every place in it this turn writes: what the CLI's
    // own session ends up holding is what it was told at the start, plus what it said itself.
    const from = polyphemus.store.messageCount(session.id);
    const mine = new Set<number>();
    /** What the CLI said this native session has cost so far, as of this turn. */
    let lastCost: number | undefined;
    polyphemus.breakers.attempt(provider.id);
    let stop: StopReason = 'other';
    let nativeId: string | undefined;
    let completed = false;
    this.activeSignal = signal;
    const events =
      provider.kind === 'agent'
        ? runAgentTurn({
            provider,
            model: this.model.model,
            history: this.history,
            input: input === undefined ? undefined : `${this.statusBlock()}\n\n${input}`,
            images,
            cwd: this.cwd,
            autoApprove: this.autoApprove,
            readOnly: this.readOnly,
            state: native,
            // What its own session hasn't been told about, counted in the thread as it's stored —
            // not in this runtime's array, which holds only what this runtime has read.
            missed: this.missedByNative(session.id, native),
            systemAppend: [this.runtimeNote(), shell ? CLAUDE_ISOLATED_NOTE : bridge ? CODEX_ISOLATED_NOTE : grokWorker ? GROK_ISOLATED_NOTE : '', this.networkNote(), this.memoryNote(), this.agentNote, this.rulesFor(polyphemus.config.providers[provider.id]?.adapter), this.briefing, this.skillsNote]
              .filter(Boolean)
              .join('\n\n'),
            // Folders outside the project the CLI may open: its memory (to write the handoff),
            // and your skills library (to read a skill it decides applies).
            extraDirs: [
              ...(this.project ? [memoryDir(polyphemus.home, this.project.slug)] : []),
              ...(this.skills.some((skill) => skill.scope === 'library') ? [librarySkillsDir(polyphemus.home)] : []),
            ],
            permissionPrompt: relayApprovals ? this.bridge : undefined,
            // Grok, isolated, asks polyphemus as its client: the same answer Claude Code gets through the bridge.
            ...(!this.autoApprove && { approve: (tool: string, toolInput: unknown) => this.approveCliTool(tool, toolInput) }),
            connections: needsGateway ? this.gateway : undefined,
            // Only what the CLI needs to sign in, never polyphemus's other keys; no push inside a run's worktree.
            env: this.pushLocked ? noPushEnv(cliEnvironment(adapter)) : cliEnvironment(adapter),
            ...(bridge && { isolation: { env: bridge.env, hostNonce: '', blockedTools: [] } }),
            ...(grokWorker && { isolation: { env: {}, hostNonce: '', blockedTools: [], worker: grokWorker, report: (stats: GrokIsolationStats) => (grokStats = stats) } }),
            ...(shell && {
              isolation: {
                env: shell.env,
                hostNonce: shell.hostNonce,
                // Web search happens at Anthropic, so it's fine where the network is open; nothing else that reaches this computer is.
                blockedTools: level === 'isolated-open' ? CLAUDE_HOST_TOOLS : [...CLAUDE_HOST_TOOLS, 'WebSearch'],
              },
            }),
            signal,
          })
        : runTurn({
            provider,
            model: this.model.model,
            effort: this.effort,
            system: [this.system, this.runtimeNote(), this.networkNote(), this.memoryNote()].filter(Boolean).join('\n\n'),
            redact: polyphemus.redactor(),
            history: this.history,
            tools: [...builtinTools, ...this.connectionTools(), ...this.workTools()],
            unofferedTool: (name) => this.unofferedConnectionTool(name),
            input:
              input === undefined
                ? undefined
                : [
                    { type: 'text', text: this.statusBlock() },
                    { type: 'text', text: input },
                    ...images,
                  ],
            cwd: this.cwd,
            ...(this.pushLocked && { toolEnv: noPushEnv() }),
            ...(this.worker && { worker: this.worker }),
            keepImage: (bytes) => saveImage(polyphemus.home, bytes),
            signal,
            approve,
            cacheKey: session.id,
          });
    let shellCalls = 0;
    // A connection the proxy refused is said in the thread, once a host a turn, with where it's granted.
    const refusedHere = new Set<string>();
    const workerName = this.worker?.name;
    const stopRefusals = workerName
      ? polyphemus.egress.onRefused((refusal) => {
          if (refusal.worker !== workerName || refusedHere.has(refusal.host)) return;
          refusedHere.add(refusal.host);
          const where = this.project ? `on ${this.project.name}’s Setup tab` : 'in Setup';
          this.notice(refusal.why === 'not granted'
            ? `Blocked a connection to ${refusal.host}: agents here aren’t granted it. It can be granted ${where}, under Where agents run.`
            : `Blocked a connection to ${refusal.host}: ${refusal.why}.`);
        })
      : undefined;
    let patchCalls = 0;
    try {
      for await (const event of events) {
        if (event.type === 'message') {
          if (shell && event.message.role === 'assistant') shellCalls += event.message.content.filter((b) => b.type === 'tool_call' && b.name === 'Bash').length;
          if (bridge && event.message.role === 'assistant') {
            shellCalls += event.message.content.filter((b) => b.type === 'tool_call' && b.name === 'shell').length;
            patchCalls += event.message.content.filter((b) => b.type === 'tool_call' && b.name === 'apply_patch').length;
          }
          this.history.push(event.message);
          const actor = this.actorFor(event.message);
          mine.add(polyphemus.store.append(session.id, event.message, actor));
          this.emit(actor ? { ...event, actor } : event);
        } else if (event.type === 'agent_session') {
          nativeId = event.id;
        } else {
          if (event.type === 'capacity') polyphemus.recordUsage(event.provider, event.readings);
          if (event.type === 'turn_done') {
            stop = event.stopReason;
            completed = true;
            if (event.costUsd !== undefined) lastCost = event.costUsd;
            // It answered, so whatever quota error or run of failures it had before is over.
            polyphemus.clearQuota(provider.id);
            polyphemus.breakers.succeeded(provider.id);
            if (event.stopReason !== 'aborted') polyphemus.store.recordModelOk(provider.id, this.model.model);
            // Kept so every client can show how long each reply took and what it used, even later.
            polyphemus.store.recordTurn(session.id, {
              endSeq: this.history.length,
              provider: provider.id,
              model: this.model.model,
              startedAt,
              endedAt: Date.now(),
              stopReason: event.stopReason,
              usage: event.usage,
              costUsd: this.turnCost(event.costUsd, native, nativeId),
              billing: event.billing,
              ...(this.agent && { speaker: this.agent.id }),
              ...(this.sender && { sender: this.sender }),
            });
          }
          this.emit(event);
        }
      }
    } catch (err) {
      if (err instanceof ProviderError && err.errorClass === 'quota_exhausted') {
        // With a reset time it's out until then; without one, for a while (quota.ts), then tried again.
        const resetsAt = err.resetsAt ?? resetFromMessage(err.message);
        polyphemus.recordUsage(err.provider, [{ window: 'quota', usedPct: 100, ...(resetsAt && { resetsAt }) }]);
      }
      if (!signal.aborted) {
        polyphemus.store.recordModelError(provider.id, this.model.model, (err as Error).message, err instanceof ProviderError ? err.errorClass : 'unknown');
        const tripped = polyphemus.breakers.failed(provider.id, err instanceof ProviderError ? err.errorClass : 'unknown', (err as Error).message);
        if (tripped) this.notice(`${provider.id} ${tripped}.`);
      }
      throw err;
    } finally {
      stopRefusals?.();
      this.activeSignal = undefined;
      // Every command Claude Code ran should have come through the worker. One that didn't means the
      // prefix stopped applying (a Claude Code change): it isn't offered isolated again (fail closed).
      if (shell) {
        const ran = shell.runs();
        if (shellCalls > ran) {
          const why = `Claude Code ran ${shellCalls - ran} of ${shellCalls} command${shellCalls === 1 ? '' : 's'} this turn without going through the worker, so it can’t be trusted to stay isolated.`;
          polyphemus.isolationBroken.set('claude-cli', why);
          this.notice(`${why} Polyphemus won’t start it where agents are isolated until it restarts; check what it ran in this thread.`);
        }
        shell.close();
      }
      // Codex: every command it reports should have started in the worker, and a file change needs
      // file operations there. Otherwise it isn't offered isolated again (fail closed).
      if (grokWorker && grokStats) {
        const stats = grokStats as GrokIsolationStats;
        const why = stats.escaped ?? (stats.commands > stats.terminals ? `Grok ran ${stats.commands} command${stats.commands === 1 ? '' : 's'} but only ${stats.terminals} went through the worker` : undefined);
        if (why) {
          polyphemus.isolationBroken.set('grok-cli', `${why}, so it can’t be trusted to stay isolated.`);
          this.notice(`${why}, so it can’t be trusted to stay isolated. Polyphemus won’t start it where agents are isolated until it restarts; check what it did in this thread.`);
        }
      }
      if (bridge) {
        const slipped = shellCalls > bridge.processes() || (patchCalls > 0 && bridge.fsChanges() === 0);
        if (slipped) {
          const why = `Codex reported ${shellCalls} command${shellCalls === 1 ? '' : 's'} and ${patchCalls} file change${patchCalls === 1 ? '' : 's'}, but only ${bridge.processes()} command${bridge.processes() === 1 ? '' : 's'} and ${bridge.fsChanges()} file operation${bridge.fsChanges() === 1 ? '' : 's'} went through the worker, so it can’t be trusted to stay isolated.`;
          polyphemus.isolationBroken.set('codex-cli', why);
          this.notice(`${why} Polyphemus won’t start it where agents are isolated until it restarts; check what it did in this thread.`);
        }
        void bridge.close();
      }
      // Only a finished turn proves the CLI's session holds everything up to here. After a failure
      // the old state stands, so the next attempt resends whatever the CLI may not have kept.
      // How far into the thread the CLI's own session is up to date: from where this turn began,
      // through everything this turn wrote. Anything another agent wrote in between stops the count
      // there, so it's passed along next time rather than counted as seen.
      let upTo = from;
      while (mine.has(upTo)) upTo += 1;
      if (nativeId && completed)
        polyphemus.store.setAgentState(session.id, this.nativeKey(provider.id), {
          nativeId,
          seen: this.history.length,
          seenSeq: upTo,
          fingerprint: this.fingerprint(),
          // What the CLI has said this session cost so far, to take the next turn's cost from.
          ...(lastCost !== undefined && { costTotal: lastCost }),
        });
    }
    return stop;
  }
}

/** A connection's result as a tool's output: its pictures as bytes, for the loop to keep. */
function withPictures(result: CallResult): ToolOutput {
  return { content: result.content, isError: result.isError, ...(result.images?.length && { images: result.images.map((image) => ({ bytes: Buffer.from(image.data, 'base64') })) }) };
}
