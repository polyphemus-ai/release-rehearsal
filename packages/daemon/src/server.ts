import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import {
  clip,
  createProject,
  describeForecast,
  craftMemoryDir,
  describeTrigger,
  directFolder,
  memoryDir,
  MEMORY_SCOPES,
  privateMemoryDir,
  scopesHere,
  writeMemoryNote,
  type MemoryScope,
  type Routine,
  parseRoutine,
  projectStateDir,
  homeRoutineFile,
  projectRoutineFile,
  routineSlug,
  routineFromProposal,
  withRoutineSettings,
  EFFORTS,
  formatUsage,
  nextRoutineFire,
  type Effort,
  type StopReason,
  inboxItems,
  projectHandoff,
  needsOrientation,
  orientationPrompt,
  resolveInboxItem,
  PolyphemusError,
  agentModel,
  CATALOGUE,
  addressedTo,
  spokenTo,
  catalogueEntry,
  configFile,
  INTRODUCE_YOURSELF,
  cliInstallCommand,
  cliLoginCommand,
  cliState,
  isCliAdapter,
  startCliInstall,
  startCliLogin,
  type CliState,
  classifyError,
  ConfigHistory,
  MORE_PROVIDERS,
  providerBlock,
  createAgent,
  allWorkflows,
  findWorkflow,
  type Workflow,
  checkForUpdate,
  knownUpdate,
  assetPath,
  defaultAgent,
  setUpDefaultAgent,
  parseGitHubRemote,
  repoRemote,
  identityGitEnv,
  intakeWorkflow,
  INCOMING_KINDS,
  type IncomingKind,
  type ProjectMeta,
  ARTIFACT_ID,
  artifactsDir,
  artifactFile,
  deleteAgent,
  agentId,
  draftPersona,
  FOLLOW_DEFAULT,
  isMetered,
  modelRef,
  moveModel,
  removeModel,
  testCost,
  testModel,
  draftingModel,
  MARK_COLORS,
  MARK_SHAPES,
  type Mark,
  createFromTemplate,
  findAgent,
  libraryAgentsDir,
  loadAgents,
  loadSkills,
  writeSkill,
  librarySkillsDir,
  projectSkillsDir,
  agentSkillsDir,
  buildSkillIndex,
  cachedSkillIndex,
  saveSkillIndex,
  searchSkills,
  installSkill,
  skillOrigin,
  SKILL_SOURCES,
  projectAgentsDir,
  templates,
  updateAgent,
  imageType,
  MAX_IMAGE_BYTES,
  saveImage,
  saveUploadedFile,
  keepIn,
  readBytesInside,
  existsInside,
  moveOutInside,
  removeInside,
  listInside,
  fileInside,
  createInside,
  folderInside,
  replaceInside,
  routineDigest,
  placeFile,
  attachedNote,
  MAX_FILE_BYTES,
  FILE_ID,
  UPLOAD_NAME,
  uploadedImage,
  uploadsDir,
  type ImageBlock,
  modelFor,
  PUSH_KINDS,
  resolveModel,
  offList,
  type PushKind,
  type Asker,
  type DeviceMeta,
  type Person,
  type Polyphemus,
  type ResolvedModel,
  type Agent,
  type SessionMeta,
  type StoredQuestion,
  type SessionRuntime,
  detectRuntime,
  effectiveLevel,
  isIsolationLevel,
  isNetworkPreset,
  NETWORK_PRESETS,
  normalizeHost,
  grantedHosts,
  ISOLATION_LEVELS,
  ISOLATION_WORDS,
  SECRET_NAME,
  secretRef,
  type SecretUse,
} from '@polyphemus/core';
import { Access, NOT_FOUND, OWNER_ONLY, READ_ONLY } from './access.js';
import { connectionRoutes } from './connections-api.js';
import { HttpError } from './http-error.js';
import { RESTARTED, RunError, runExecutor } from './runs.js';
import type { PushPayload, PushSender } from './push.js';
import { startScheduler, type Scheduler } from './scheduler.js';

/** The polyphemus block in the workspace port registry (docs/PORTS.md). */
export const DEFAULT_PORT = 3900;

/** A file's last-modified time, or 0 when it isn't there. */
const statSafe = (file: string): number => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

const WEB_DIR = assetPath('daemon', 'web/');
/**
 * What keeps a device paired. Renamed with everything else on 2026-09-21, which signed every phone
 * out once — the old name was kept through two renames precisely to avoid that, and the owner chose
 * to take it rather than carry the name any longer.
 */
const COOKIE = 'polyphemus_device';
const MAX_BODY_BYTES = 1_000_000;
/** Images one message can carry. */
const MAX_IMAGES = 6;
const MAX_FILES = 10;
const KEEPALIVE_MS = 25_000;
const MAX_PAIR_FAILURES = 20;
const PAIR_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
/** Who the terminal on this computer is, when it signs in with the local key. */
const LOCAL_CLIENT: DeviceMeta = { id: 'local', name: 'terminal on this computer', createdAt: 0 };
/** How soon a revoked device's open event stream is cut off. */
const REVOCATION_CHECK_MS = 5_000;

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Served without pairing: nothing private, and browsers fetch some of them on their own. */
const PUBLIC_FILES = new Set([
  'style.css',
  'theme.js',
  'sw.js',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'badge.png',
  'fonts/figtree.woff2',
  'fonts/bricolage.woff2',
]);

export interface DaemonOptions {
  polyphemus: Polyphemus;
  /** Addresses to listen on, e.g. 127.0.0.1 and the Tailscale IP. Never 0.0.0.0. */
  hosts: string[];
  /** 0 picks a free port (tests). */
  port?: number;
  /** Folder new sessions start in when the phone doesn't pick one. */
  cwd: string;
  log?: (line: string) => void;
  /** Sends notifications to devices that turned them on. */
  push?: PushSender;
  /** The daemon's HTTPS address through Tailscale; phones need it for notifications. */
  httpsUrl?: string;
  /** How often routines' schedules are checked (default 20 s; tests set it high and call tick). */
  routineTickMs?: number;
  /** How often open event streams are checked against revoked devices (default 5 s). */
  revocationCheckMs?: number;
}

export interface Daemon {
  urls: string[];
  /** Starts listening on one more address, e.g. Tailscale's once it comes up. */
  listen(host: string): Promise<void>;
  setHttpsUrl(url: string | undefined): void;
  /** A notification to every device that turned them on, for problems with polyphemus itself. */
  alert(title: string, body: string): void;
  routines: Scheduler;
  close(): Promise<void>;
}

/** Something a session is waiting on a person for: an approval or a fallback choice. */
interface Question {
  id: string;
  sessionId: string;
  kind: 'approval' | 'fallback' | 'gate' | 'outcome' | 'guard' | 'invite' | 'incoming' | 'routine' | 'profile' | 'note' | 'skill' | 'secret' | 'signin';
  [detail: string]: unknown;
}

/** One open event stream. */
interface Stream {
  deviceId: string;
  person: Person;
  access?: Access;
  /** Which threads this stream may hear about, worked out once per check. */
  seen: Map<string, boolean>;
}

interface LiveSession {
  id: string;
  runtime: SessionRuntime;
  running?: AbortController;
  /**
   * When the work now going on began: the turn a person's message started, carried through agents
   * handing it on to each other, so a thread opened midway says how long it's really been going.
   */
  workingSince?: number;
  /** When the last turn ended: a turn starting straight after is the same piece of work. */
  endedAt?: number;
  questions: Map<string, { question: Question; heldBack?: string; answer(value: string | undefined, by?: string): void }>;
  /** Agent-to-agent exchanges since a person last wrote here: what the guard counts. */
  exchanges?: number;
  /**
   * A hand-off someone agreed to while a turn was already going. It starts once that turn, and any
   * hand-off it causes, has finished — saying yes used to add the agent and then forget them.
   */
  afterTurn?: Array<{ from: { id: string; title: string }; to: Parameters<SessionRuntime['speakAs']>[0] & object }>;
  /**
   * Agents answering alongside the thread's own turn: each addressed while another was working, with
   * a runtime of its own (docs/design/parallel-agents.md). Keyed by agent id.
   */
  asides?: Map<string, { agent: { id: string; title: string }; runtime: SessionRuntime; running: AbortController; since: number }>;
}

/** Agent-to-agent exchanges before polyphemus stops and asks a person, unless a thread says otherwise. */
export const DEFAULT_GUARD = 6;


/**
 * The polyphemus daemon: runs sessions without a terminal and serves the phone app.
 * Every request except pairing needs a paired device's cookie; POSTs must be
 * JSON (with SameSite=Strict cookies, that keeps other sites from acting for you).
 */
export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const { polyphemus } = opts;
  const live = new Map<string, LiveSession>();
  /** Set as the daemon closes: runs stop writing, rather than racing the store being closed. */
  let closing = false;
  // Anything still waiting belonged to turns that didn't survive the last restart: say so, not nothing.
  // A run that was going when polyphemus stopped was interrupted, whatever the database last said.
  polyphemus.store.runs.interruptActive(RESTARTED);
  polyphemus.store.expireOpenQuestions('polyphemus restarted while this was waiting, so the turn it belonged to stopped.');
  /** Open event streams: the device and person each signed in as, so revoking one ends it and events are filtered. */
  const clients = new Map<ServerResponse, Stream>();
  let httpsUrl = opts.httpsUrl;

  // The terminal on this computer is a client too: it signs in with this key instead of a paired
  // device's cookie. The key lives in a file only the user can read, and changes every start.
  const localToken = randomBytes(32).toString('base64url');
  const tokenFile = join(polyphemus.home, 'daemon-token');
  writeFileSync(tokenFile, `${localToken}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);

  /**
   * Pushes a notification to the devices that want this kind (or to one device, for a test),
   * and forgets subscriptions the browser gave up.
   */
  /**
   * `sessionId` says what a notification is about, so it only reaches people who can see that
   * thread; without one it's about the install itself, and only the owner's devices get it.
   */
  type PushTarget = { kind: PushKind; sessionId?: string } | { kind: PushKind; person: string } | { device: string };
  function notify(payload: PushPayload, to: PushTarget): void {
    void deliver(payload, to);
  }

  /** Whether a device's person may be told about a thread (or, with none, about the install). */
  function deviceMayHear(deviceId: string, sessionId: string | undefined): boolean {
    const device = polyphemus.store.listDevices().find((d) => d.id === deviceId && !d.revokedAt);
    if (!device) return false;
    const person = personOf(device);
    if (!person) return false;
    const access = new Access(polyphemus.store, person);
    if (sessionId === undefined) return access.owner;
    const meta = polyphemus.store.get(sessionId);
    return meta !== undefined && access.canSeeSession(meta);
  }

  /** Whether a device signs in as this person: for what's addressed to someone, like a connection to fix. */
  function deviceIsPerson(deviceId: string, personId: string): boolean {
    const device = polyphemus.store.listDevices().find((d) => d.id === deviceId && !d.revokedAt);
    return device !== undefined && personOf(device)?.id === personId;
  }

  /** Sends, and resolves to how many devices the push service accepted it for. */
  async function deliver(payload: PushPayload, to: PushTarget): Promise<number> {
    const push = opts.push;
    if (!push) return 0;
    const targets = polyphemus.store
      .pushSubscriptions()
      .filter(({ deviceId, kinds }) =>
        'device' in to ? deviceId === to.device
        : 'person' in to ? kinds.includes(to.kind) && deviceIsPerson(deviceId, to.person)
        : kinds.includes(to.kind) && deviceMayHear(deviceId, to.sessionId),
      );
    const results = await Promise.all(
      targets.map(async ({ subscription }) => {
        const result = await push.send(subscription, payload);
        if (result === 'gone') polyphemus.store.removePushSubscription(subscription.endpoint);
        return result;
      }),
    );
    return results.filter((result) => result === 'ok').length;
  }
  const titleOf = (id: string) => clip(polyphemus.store.get(id)?.title || '(untitled)', 60);

  /**
   * Every event goes only to streams whose person may see it: a thread's events to those who can see
   * the thread, an agent's to those who can see the agent, anything about the install itself (signing
   * in) to the owner. What each stream may see is cached briefly — text arrives token by token — and
   * refreshed with the revocation check, so a role taken away takes effect within seconds.
   */
  const broadcast = (data: Record<string, unknown>) => {
    // A turn can finish after the daemon closed (and its store with it): there's no one left to tell.
    if (closing) return;
    const frame = `data: ${JSON.stringify(data)}\n\n`;
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
    const meta = sessionId ? polyphemus.store.get(sessionId) : undefined;
    for (const [client, stream] of clients) {
      if (streamMayHear(stream, data, sessionId, meta)) client.write(frame);
    }
  };

  function streamMayHear(stream: Stream, data: Record<string, unknown>, sessionId: string | undefined, meta: SessionMeta | undefined): boolean {
    stream.access ??= new Access(polyphemus.store, stream.person);
    if (stream.access.owner) return true;
    if (sessionId) {
      // A thread that was just deleted can't be looked up: tell whoever could see it a moment ago.
      if (!meta) return stream.seen.get(sessionId) === true;
      let ok = stream.seen.get(sessionId);
      if (ok === undefined) {
        ok = stream.access.canSeeSession(meta);
        stream.seen.set(sessionId, ok);
      }
      return ok;
    }
    if (data.type === 'connection_changed' && typeof data.connection === 'string') {
      const connection = polyphemus.connections.get(data.connection);
      return connection !== undefined && (stream.access.canManageConnection(connection) || polyphemus.store.connections.grants(connection.id).some((g) => stream.access!.canSeeProject(g.project)));
    }
    if (data.type === 'agent_changed' && typeof data.name === 'string') {
      const agent = agentNamed(data.name);
      return agent !== undefined && stream.access.canSeeAgent(agent);
    }
    return false;
  }

  /** The running form of a stored session, opened on first use. */
  /**
   * Everything a runtime in a thread needs: asking a person, proposing work, notes, skills and
   * routines, and its lines reaching the app. The thread's own runtime gets this, and so does one
   * for an agent answering alongside it (docs/design/parallel-agents.md).
   */
  function wireRuntime(entry: LiveSession, runtime: SessionRuntime, meta: SessionMeta): void {
    const id = entry.id;
    // Kept with the thread, so an update or a reboot doesn't turn it back to asking.
    runtime.autoApprove = meta.yolo === true;
    runtime.asker = askerFor(entry);
    // The agent can offer to track the thread as work; a person accepts or declines, whenever they like.
    runtime.proposeOutcome = (text, why) => {
      if (polyphemus.store.openQuestions().some((q) => q.sessionId === id && q.kind === 'outcome')) return 'You’ve already offered; they haven’t answered yet. Carry on with what they asked.';
      const question = polyphemus.store.askQuestion({ id: randomUUID().slice(0, 8), sessionId: id, kind: 'outcome', detail: { text, why, agent: runtime.agent?.id ?? null, agentTitle: runtime.agent?.title ?? null } });
      announceQuestion(question);
      return `Offered to track this as work: “${text}”. Carry on with what they asked; they’ll accept or decline.`;
    };
    // An agent working in a project can propose work it found — an audit's findings — into Waiting on you.
    runtime.proposeWork = (kind, text) => {
      const project = polyphemus.store.projectFor(meta.cwd);
      if (!project) return 'This thread isn’t in a project, so there’s nowhere to propose work to.';
      const actor = runtime.agent ? `agent:${runtime.agent.id}` : `session:${id}`;
      landIncoming(project, kind, text, actor, runtime.agent?.title ?? 'An agent', id);
      return `Proposed. It’s waiting for a person to make work of it or dismiss it; carry on.`;
    };
    // Something to remember past this thread. Which scope it's kept in is the person's to decide, and
    // never wider than the room it was learned in (memory.ts).
    runtime.proposeNote = (note) => {
      const agent = runtime.agent;
      if (!agent) return 'This thread isn’t with an agent, so there’s nothing to remember it.';
      const person = runtime.sender?.startsWith('person:') ? runtime.sender.slice(7) : undefined;
      const project = polyphemus.store.projectFor(meta.cwd);
      const question = polyphemus.store.askQuestion({
        id: randomUUID().slice(0, 8),
        sessionId: id,
        kind: 'note',
        detail: {
          agent: agent.id,
          agentTitle: agent.title,
          ...(person && { person }),
          ...(project && { project: project.slug, projectName: project.name }),
          name: note.name,
          description: note.description,
          text: note.text,
          scope: note.scope,
          // What it may be kept as here: the same list the agent was offered.
          scopes: scopesHere({ alone: note.scope === 'private', ...(project && { project: project.slug }) }),
        },
      });
      announceQuestion(question);
      return `Proposed to remember “${note.name}” (${MEMORY_SCOPES[note.scope].title.toLowerCase()}). A person decides whether it's kept, and where; carry on.`;
    };
    // A skill an agent drafted: the person reads it and decides whether it's kept, and whose it is.
    runtime.proposeSkill = (skill) => {
      const agent = runtime.agent;
      if (!agent) return 'This thread isn’t with an agent, so there’s nobody to keep a skill for.';
      const project = polyphemus.store.projectFor(meta.cwd);
      const question = polyphemus.store.askQuestion({
        id: randomUUID().slice(0, 8),
        sessionId: id,
        kind: 'skill',
        detail: {
          agent: agent.id,
          agentTitle: agent.title,
          ...(project && { project: project.slug, projectName: project.name }),
          name: skill.name,
          description: skill.description,
          body: skill.body,
          why: skill.why,
          where: skill.where,
          places: ['agent', 'library', ...(project ? ['project'] : [])],
        },
      });
      announceQuestion(question);
      return `Proposed the skill “${skill.name}”. A person reads it and decides whether it's kept, and whose it is; carry on.`;
    };
    // A credential the agent must not see. The card writes the vault; this promise hears only saved or decline.
    runtime.requestSecret = (name, purpose, signal) =>
      new Promise((resolve) => {
        if (polyphemus.store.openQuestions().some((q) => q.sessionId === id && q.kind === 'secret' && q.detail.name === name)) {
          resolve('waiting');
          return;
        }
        const project = polyphemus.store.projectFor(meta.cwd);
        const agent = runtime.agent;
        const scopes = [...(agent ? ['agent'] : []), ...(project ? ['project'] : [])];
        const stored = polyphemus.store.askQuestion({
          id: randomUUID().slice(0, 8),
          sessionId: id,
          kind: 'secret',
          detail: {
            name,
            purpose,
            agent: agent?.id ?? null,
            agentTitle: agent?.title ?? null,
            project: project?.slug ?? null,
            projectName: project?.name ?? null,
            exists: polyphemus.vault.has(name),
            scopes,
          },
        });
        const question = questionView(stored);
        const finish = (value: string | undefined, by?: string) => {
          if (!entry.questions.has(question.id)) return;
          const recorded = by === undefined ? polyphemus.store.expireQuestion(question.id, 'The turn it belonged to stopped.') : polyphemus.store.answerQuestion(question.id, value, by);
          if (!recorded) return;
          entry.questions.delete(question.id);
          broadcast({ type: 'question_resolved', id: question.id, sessionId: id, by: by ?? null, answer: value ?? null });
          resolve(value);
        };
        entry.questions.set(question.id, { question, answer: finish });
        announceQuestion(stored);
        signal?.addEventListener('abort', () => finish(undefined), { once: true });
      });
    // A sign-in the agent must not see. The card opens the service's page or the browser; this hears only the outcome.
    runtime.requestSignIn = (request, signal) =>
      new Promise((resolve) => {
        const same = (q: StoredQuestion) => q.sessionId === id && q.kind === 'signin' && q.detail.connection === request.connection && (request.how === 'oauth' || q.detail.site === request.site);
        if (polyphemus.store.openQuestions().some(same)) {
          resolve({ status: 'waiting' });
          return;
        }
        const project = polyphemus.store.projectFor(meta.cwd);
        const stored = polyphemus.store.askQuestion({
          id: randomUUID().slice(0, 8),
          sessionId: id,
          kind: 'signin',
          detail: {
            connection: request.connection,
            name: request.name,
            how: request.how,
            where: request.site ?? request.name,
            ...(request.url && { url: request.url }),
            ...(request.site && { site: request.site }),
            purpose: request.purpose,
            project: project?.slug ?? null,
            projectName: project?.name ?? null,
            agentTitle: runtime.agent?.title ?? null,
          },
        });
        const question = questionView(stored);
        const record: { question: Question; heldBack?: string; answer(value: string | undefined, by?: string): void } = {
          question,
          answer(value, by) {
            if (!entry.questions.has(question.id)) return;
            const recorded = by === undefined ? polyphemus.store.expireQuestion(question.id, 'The turn it belonged to stopped.') : polyphemus.store.answerQuestion(question.id, value, by);
            if (!recorded) return;
            entry.questions.delete(question.id);
            broadcast({ type: 'question_resolved', id: question.id, sessionId: id, by: by ?? null, answer: value ?? null });
            resolve(value === 'signed-in' ? { status: 'signed-in', ...(record.heldBack && { heldBack: record.heldBack }) } : value === 'decline' ? { status: 'decline' } : undefined);
          },
        };
        entry.questions.set(question.id, record);
        announceQuestion(stored);
        signal?.addEventListener('abort', () => record.answer(undefined), { once: true });
      });
    // An agent's own profile is a person's to accept: what changes, and what it is now, side by side.
    runtime.proposeProfile = (change) => {
      const agent = runtime.agent ? agentNamed(runtime.agent.id) : undefined;
      if (!agent) return 'This thread isn’t with an agent, so there’s no profile to change.';
      const now: Record<string, string> = { persona: agent.persona, instructions: agent.instructions, description: agent.description };
      const fields = (['persona', 'instructions', 'description'] as const)
        .filter((field) => change[field] !== undefined && change[field]!.trim() !== (now[field] ?? '').trim())
        .map((field) => ({ field, before: now[field] ?? '', after: change[field]! }));
      if (!fields.length) return 'That’s what your profile says already.';
      if (polyphemus.store.openQuestions().some((q) => q.kind === 'profile' && q.detail.agent === agent.id)) return 'You’ve already proposed a change to your profile; it’s waiting for a person.';
      const question = polyphemus.store.askQuestion({
        id: randomUUID().slice(0, 8),
        sessionId: id,
        kind: 'profile',
        detail: { agent: agent.id, agentTitle: agent.title, why: change.why, fields },
      });
      announceQuestion(question);
      return `Proposed: ${fields.map((f) => f.field).join(', ')}. Nothing changes until a person accepts it; carry on.`;
    };
    // A routine an agent wants: checked like the file a person would write, then waiting on a person to accept.
    runtime.proposeRoutine = (proposal) => {
      // In a thread outside every project it belongs to the install, beside the projects' own:
      // polyphemus has always run those, and only proposing one had nowhere to put it (2026-09-20).
      // Personal: the person's own, outside every project, even proposed from a project's thread. A
      // check of every agent's usage made in the website project ran as website work (2026-09-21).
      const inProject = polyphemus.store.projectFor(meta.cwd);
      const project = proposal.scope === 'personal' ? undefined : inProject;
      const where = project ? `in ${project.name}` : 'outside every project';
      const cwd = project ? meta.cwd : inProject ? directFolder(polyphemus.config.projectsRoot) : meta.cwd;
      const name = routineSlug(proposal.name);
      const existing = (project ? projectRoutineFile(project, name) : homeRoutineFile(polyphemus.home, name));
      const exists = existsSync(existing);
      if (polyphemus.store.openQuestions().some((q) => q.kind === 'routine' && q.detail.name === name && String(q.detail.project ?? '') === (project?.slug ?? ''))) return 'You’ve already proposed that one; it’s waiting for a person.';
      if (proposal.stop) {
        if (!exists) return `There’s no routine called ${name} ${where} to stop.`;
        const question = polyphemus.store.askQuestion({
          id: randomUUID().slice(0, 8),
          sessionId: id,
          kind: 'routine',
          detail: { id: `${project?.slug ?? '~'}/${name}`, name, project: project?.slug ?? '', projectName: project?.name ?? '', stop: true, description: proposal.description ?? '', agentTitle: runtime.agent?.title ?? null },
        });
        announceQuestion(question);
        return `Proposed stopping ${name} ${where}. It keeps running until a person accepts; carry on.`;
      }
      let built: ReturnType<typeof routineFromProposal>;
      try {
        built = routineFromProposal({ ...(project && { project }), home: polyphemus.home, cwd }, proposal);
      } catch (err) {
        return `That routine isn’t valid: ${(err as Error).message.replace(/^[^:]*\.md: /, '')} Fix it and propose it again.`;
      }
      const question = polyphemus.store.askQuestion({
        id: randomUUID().slice(0, 8),
        sessionId: id,
        kind: 'routine',
        detail: { id: built.routine.id, name: built.routine.name, project: project?.slug ?? '', projectName: project?.name ?? '', schedule: built.routine.triggers.map(describeTrigger).join(' · '), mode: built.routine.mode, asks: routineAsks(built.routine), prompt: built.routine.prompt, description: proposal.description ?? '', agentTitle: runtime.agent?.title ?? null, text: built.text, ...(exists && { replaces: true }) },
      });
      announceQuestion(question);
      return `Proposed ${exists ? 'a change to ' : ''}${built.routine.name} ${where} (${built.routine.triggers.map(describeTrigger).join(' · ')}). Nothing ${exists ? 'changes' : 'is scheduled'} until a person accepts it; carry on.`;
    };
    // Which agent a line came from, so two answering at once don't land in one bubble.
    runtime.on((event) => broadcast({ sessionId: id, agent: runtime.agent?.id ?? null, event }));
  }

  function liveSession(id: string, model?: ResolvedModel): LiveSession | undefined {
    const existing = live.get(id);
    if (existing) return existing;
    const meta = polyphemus.store.get(id);
    if (!meta) return undefined;
    const runtime = polyphemus.openSession(meta, { cwd: meta.cwd, alwaysAllow: polyphemus.config.permissions.allow, model });
    const entry: LiveSession = { id, runtime, questions: new Map() };
    wireRuntime(entry, runtime, meta);
    live.set(id, entry);
    return entry;
  }

  // ── Agents talking to agents (docs/design/agents.md) ──
  // When an agent's reply @mentions another agent in the thread, that agent goes next. The guard
  // is code, not a model: after a set number of exchanges with no person in between, the thread
  // pauses where it happened and asks whether to carry on.

  /** Two or more people have been in this thread (counting whoever's writing now), and it doesn't ask agents to answer everything. */
  function quietForAgents(id: string, writer: string): boolean {
    const meta = polyphemus.store.get(id);
    if (!meta || meta.agentsAnswerAll) return false;
    // Everyone who can see it counts, not only who's written: a project's people read along, and
    // the message box already says "@name for an answer" once there's more than one.
    return new Set([...peopleWhoSee(meta).map((p) => p.id), writer]).size >= 2;
  }

  /** The people who can see a thread themselves: the owner, whoever started it or was brought in, and its project's people. */
  function peopleWhoSee(meta: SessionMeta) {
    const slug = polyphemus.store.projectFor(meta.cwd)?.slug;
    const invited = new Set(polyphemus.store.threadPeople(meta.id));
    return polyphemus.store.people().filter((p) => p.owner || invited.has(p.id) || `person:${p.id}` === meta.startedBy || (slug !== undefined && polyphemus.store.projectRoles(p.id).has(slug)));
  }

  /** Does this text @mention a person here? Then it's for them, and no agent takes it unless named too. */
  function namesAPerson(text: string): boolean {
    const spoken = text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
    const handles = new Set(polyphemus.store.people().map((p) => p.name.replace(/\s+/g, '').toLowerCase()).filter(Boolean));
    return [...spoken.matchAll(/(^|[^\w@])@([\w-]+)/g)].some((m) => handles.has(m[2]!.toLowerCase()));
  }

  /** "@Sam can you look": Sam gets a notification, if Sam can see the thread. */
  function tellNamedPeople(id: string, text: string, from: { id: string; name: string }): void {
    const meta = polyphemus.store.get(id);
    if (!meta) return;
    for (const person of polyphemus.store.people()) {
      if (person.id === from.id) continue;
      const handle = person.name.replace(/\s+/g, '');
      if (!handle || !new RegExp(`(^|[^\\w@])@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) continue;
      if (!new Access(polyphemus.store, person).canSeeSession(meta)) continue;
      notify({ title: titleOf(id), body: clip(`${from.name}: ${text}`, 200), url: `/#/s/${id}`, tag: `mention-${id}` }, { kind: 'questions', person: person.id });
    }
  }

  /** A message between people: everyone else in the thread hears about it, the way a chat app tells you. */
  function tellPeopleIn(id: string, text: string, from: { id: string; name: string }): void {
    const meta = polyphemus.store.get(id);
    if (!meta) return;
    for (const personId of polyphemus.store.peopleIn(id)) {
      if (personId === from.id) continue;
      const person = polyphemus.store.person(personId);
      if (!person || !new Access(polyphemus.store, person).canSeeSession(meta)) continue;
      notify({ title: from.name, body: clip(text, 200), url: `/#/s/${id}`, tag: `dm-${id}` }, { kind: 'questions', person: person.id });
    }
    broadcast({ type: 'session_changed', sessionId: id });
  }

  /** Who answers a message that names nobody: the thread's lead, else the first agent in. */
  function leadOf(id: string, members = threadMembers(id)) {
    const lead = polyphemus.store.get(id)?.lead;
    return members.find((m) => m.id === lead) ?? members[0];
  }

  const replyText = (runtime: SessionRuntime) => {
    const last = [...runtime.history].reverse().find((message) => message.role === 'assistant');
    return (last?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
  };

  /** How an agent is @mentioned: its title when that's its name spelled out, else its name. */
  const handleOf = (a: { name: string; title: string }) => (a.title.replace(/\s+/g, '').toLowerCase() === a.name.toLowerCase() ? a.title.replace(/\s+/g, '') : a.name);

  /**
   * Who could be brought into a thread and isn't in it: your library's agents, and its project's own.
   * An agent names one of them to suggest bringing them in; a person names one to bring them in.
   */
  function bringable(id: string) {
    const meta = polyphemus.store.get(id);
    const slug = meta ? polyphemus.store.projectFor(meta.cwd)?.slug : undefined;
    const inIt = new Set(threadMembers(id).map((m) => m.id));
    return rosterAgents().filter((a) => (a.project === null || a.project === slug) && !inIt.has(a.id));
  }

  /**
   * Who's around, for the agents in a thread: those in it (handles, who leads, what each runs on,
   * and the guard), and teammates who aren't, with what each is for — so an agent can say which of
   * them to bring in rather than muddle through someone else's specialty.
   */
  function teamFor(entry: LiveSession): SessionRuntime['team'] {
    const members = threadMembers(entry.id);
    if (!members.length) return undefined;
    const meta = polyphemus.store.get(entry.id);
    const base = modelFor(polyphemus.config, meta?.provider ?? entry.runtime.model.provider, meta?.model ?? entry.runtime.model.model);
    return {
      members: members.map((m) => {
        const configured = agentModel(polyphemus.config, m, base);
        // What it actually ran on last, when that wasn't what it's set to: a fallback stood in.
        const last = polyphemus.store.lastOrigin(entry.id, `agent:${m.id}`);
        const standIn = last && (last.provider !== configured.provider || last.model !== configured.model) ? `${last.provider}:${last.model}` : undefined;
        return {
          id: m.id,
          title: m.title,
          handle: handleOf(m),
          runsOn: standIn ? `${standIn} on its last turn, standing in for ${configured.label}` : configured.label,
        };
      }),
      lead: leadOf(entry.id, members)?.id,
      guard: meta?.guardLimit ?? DEFAULT_GUARD,
      others: bringable(entry.id).slice(0, 30).map((a) => ({ handle: handleOf(a), title: a.title, about: clip(a.description ?? '', 90) })),
      // Who can set up agents, skills and routines: agents didn't know, and the owner brokered it.
      keeper: (() => {
        const keeper = defaultAgent(polyphemus, meta?.cwd);
        return keeper && keeper.id !== entry.runtime.agent?.id ? handleOf(keeper) : undefined;
      })(),
      // The people here, by the handle that reaches them: an @mention in a reply notifies them.
      people: polyphemus.store.peopleIn(entry.id).flatMap((personId) => {
        const person = polyphemus.store.person(personId);
        return person ? [{ handle: person.name.replace(/\s+/g, ''), name: person.name }] : [];
      }),
    };
  }

  /** A person's message: the named agent (or the lead) answers, then any hand-offs run under the guard. */
  /**
   * A person's message, said in a thread that's free to take it: who answers (an @mention, the lead, the
   * only agent), or delivered between people. Used as it's sent, and for a message held while the
   * thread was working (see drainQueue).
   */
  /**
   * You naming an agent who isn't here brings them in: you're the one who decides who's in it. Only
   * agents you could start a thread with, and only the first — one answers at a time.
   */
  function bringInNamed(id: string, text: string, access: Access): Agent | undefined {
    const newcomer = addressedTo(text, threadMembers(id)).length ? undefined : addressedTo(text, bringable(id).filter((a) => !cantBringIn(access, a, id)))[0];
    if (newcomer) {
      polyphemus.store.addMember(id, newcomer.id, Date.now(), access.actor);
      broadcast({ type: 'members', sessionId: id, members: threadMembers(id).map((a) => a.id) });
    }
    return newcomer;
  }

  function deliverMessage(id: string, entry: LiveSession, body: Record<string, unknown>, access: Access, device: DeviceMeta): { answering: string | null } {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const images = imagesFrom(body, access);
    const sender = requirePerson(device);
    const outsideProjects = !polyphemus.store.projectFor(polyphemus.store.get(id)?.cwd ?? '');
    bringInNamed(id, text, access);
    const members = threadMembers(id);
    const named = addressedTo(text, members);
    if (named.length > 1) {
      throw new HttpError(400, `One at a time for now — you named ${named.map((a) => a.name).join(' and ')}. The first can hand it on with an @mention.`);
    }
    entry.runtime.sender = `person:${sender.id}`;
    // Checked and in place before anything is said, so a message is never missing its files.
    const said = withFiles(body, text, threadFolder(id), sender.id);
    // People named in it hear about it, whoever answers.
    tellNamedPeople(id, text, sender);
    // An agent answers only when it's named — unless it's the only agent and you're the only
    // person, which is a chat, or the thread says agents answer everything. Otherwise it's people
    // talking to each other, or a message nobody was asked to take.
    const threadMeta = polyphemus.store.get(id);
    // Outside every project, no agent in it and other people are: a conversation between people.
    // Delivered, not answered. (A project's thread with no agent is its plain model, as ever.)
    // Only the owner gets a model's answer outside every project with no agent in it: anyone else's
    // message there is delivered, whoever else is (or isn't) left in it (third review, 2026-09-19).
    if (outsideProjects && !members.length && (!access.owner || polyphemus.store.peopleIn(id).some((p) => p !== sender.id))) {
      entry.runtime.say(said, images);
      tellPeopleIn(id, said, sender);
      return { answering: null };
    }
    const unaddressed = !named.length && members.length > 0 && (namesAPerson(text) || (!threadMeta?.agentsAnswerAll && (members.length > 1 || quietForAgents(id, sender.id))));
    if (unaddressed) {
      for (const q of polyphemus.store.openQuestions().filter((q) => q.sessionId === id && q.kind === 'guard')) {
        polyphemus.store.expireQuestion(q.id, 'Someone wrote in the thread, so the agents stopped waiting on this.');
        broadcast({ type: 'question_resolved', id: q.id, sessionId: id, by: null, answer: null });
      }
      entry.runtime.say(said, images);
      // Between people outside a project, the others hear about it, agents in it or not.
      if (outsideProjects) tellPeopleIn(id, said, sender);
      return { answering: null };
    }
    // @name decides who answers; nobody named in a thread that asks agents to answer everything,
    // the lead takes it and routes it on if it's someone else's. With one agent, it's them.
    if (members.length > 1) entry.runtime.speakAs(named[0] ?? leadOf(id, members));
    else if (members.length === 1) entry.runtime.speakAs(members[0]);
    void converse(entry, said, images);
    return { answering: entry.runtime.agent?.name ?? null };
  }

  /** The last flow drawn for a thread, so reading one again doesn't read every message again. */
  const flowCache = new Map<string, { stamp: string; at: number; flow: unknown }>();

  /** How many messages may wait in one thread at once, and how many of those any one person may have. */
  const QUEUE_LIMIT = 50;
  const QUEUE_LIMIT_EACH = 20;

  /**
   * Sends what was held while a thread worked, once it's free: the oldest first, and together with any
   * that follow from the same person, as one message — the way a chat sends what you typed while it was
   * busy. Each is sent as its sender, if they can still work in the thread; one that can't be sent is
   * dropped and its sender told why.
   */
  function drainQueue(id: string): void {
    // Scheduled as a turn ends, it can come after polyphemus has started shutting down: nothing to send then.
    if (closing) return;
    const entry = liveSession(id);
    if (!entry || entry.running) return;
    const going = runs.activeRun(id);
    if (going && going.status !== 'waiting') return;
    const queue = polyphemus.store.queuedMessages(id);
    const first = queue[0];
    if (!first) return;
    const batch = [first];
    // One sent now goes on its own: it was urgent enough to stop what was working.
    for (const next of first.queuedAt === 0 ? [] : queue.slice(1)) {
      if (next.personId !== first.personId || next.deviceId !== first.deviceId || next.queuedAt === 0) break;
      batch.push(next);
    }
    for (const q of batch) polyphemus.store.unqueueMessage(q.id);
    broadcast({ type: 'queue', sessionId: id });
    const person = polyphemus.store.person(first.personId);
    const device = polyphemus.store.listDevices().find((d) => d.id === first.deviceId && !d.revokedAt);
    const meta = polyphemus.store.get(id);
    const access = person && new Access(polyphemus.store, person);
    const list = (key: string) => batch.flatMap((q) => (Array.isArray(q.body[key]) ? (q.body[key] as unknown[]) : []));
    const merged = { text: batch.map((q) => String(q.body.text ?? '')).filter(Boolean).join('\n\n'), images: list('images'), files: list('files') };
    try {
      // Checked again as it goes: someone removed, or signed out, since they sent it doesn't get it sent.
      if (!access || !device || !meta || !access.canWorkInSession(meta)) throw new HttpError(403, 'You can’t send in this thread any more.');
      deliverMessage(id, entry, merged, access, device);
    } catch (err) {
      opts.log?.(`A held message in thread ${id} wasn't sent: ${(err as Error).message}`);
      broadcast({ type: 'queue_failed', sessionId: id, personId: first.personId, error: (err as Error).message, text: clip(merged.text, 200) });
    }
    // Delivered between people, or refused: nothing's working, so the next can go.
    if (!entry.running) setTimeout(() => drainQueue(id), 0);
  }

  async function converse(entry: LiveSession, text: string, images: ImageBlock[]): Promise<void> {
    entry.exchanges = 0;
    // Writing in the thread answers an open guard question: the person is back in it.
    for (const q of polyphemus.store.openQuestions().filter((q) => q.sessionId === entry.id && q.kind === 'guard')) {
      polyphemus.store.expireQuestion(q.id, 'You wrote in the thread, so the agents stopped waiting on this.');
      broadcast({ type: 'question_resolved', id: q.id, sessionId: entry.id, by: null, answer: null });
    }
    entry.runtime.team = teamFor(entry);
    entry.runtime.attendance = attendanceLines(entry.id);
    const result = await startTurn(entry, text, { images });
    await handOffs(entry, result);
  }

  async function handOffs(entry: LiveSession, result: { stop?: StopReason; error?: string }): Promise<void> {
    try {
      for (;;) {
        if (result.error || result.stop === 'aborted' || entry.runtime.pausedBecause || entry.runtime.work) return;
        const members = threadMembers(entry.id);
        const from = entry.runtime.agent;
        if (!from) return;
        const reply = replyText(entry.runtime);
        // An agent naming a person reaches them, as it would if a person had.
        tellNamedPeople(entry.id, reply, { id: `agent:${from.id}`, name: from.title });
        // An @mention hands the turn on; so does plainly speaking to another agent here ("Hey Riley —",
        // "Riley, can you…", "over to Riley") — forgetting the @ shouldn't leave the work stopped.
        const others = members.filter((m) => m.id !== from.id);
        const next = addressedTo(reply, others)[0] ?? spokenTo(reply, others);
        // Teammates who aren't here: the person decides whether each comes in, one question per agent
        // named, whether or not the reply also hands the turn on. Asked once per agent while it's
        // open. Only the first used to be asked: "@Joiner … @Rigger … @Keel" invited Joiner alone
        // (2026-09-21).
        const invited = new Set(polyphemus.store.openQuestions().filter((q) => q.sessionId === entry.id && q.kind === 'invite').map((q) => q.detail.agentId));
        for (const wanted of addressedTo(reply, bringable(entry.id)).slice(0, 6)) {
          if (!invited.has(wanted.id)) askInvite(entry, from, wanted, reply);
        }
        if (!next) return;
        const limit = polyphemus.store.get(entry.id)?.guardLimit ?? DEFAULT_GUARD;
        if (limit > 0 && (entry.exchanges ?? 0) >= limit) return askGuard(entry, from, next, limit);
        entry.exchanges = (entry.exchanges ?? 0) + 1;
        result = await handOff(entry, from, next);
      }
    } finally {
      settleAfterTurn(entry);
    }
  }

  /** Starts the next agreed hand-off, once nothing else is using the thread. */
  function settleAfterTurn(entry: LiveSession): void {
    if (entry.running || !entry.afterTurn?.length) return;
    const next = entry.afterTurn.shift()!;
    if (!entry.afterTurn.length) entry.afterTurn = undefined;
    entry.exchanges = 1;
    void handOff(entry, next.from, next.to).then((result) => handOffs(entry, result));
  }

  /** Hands the thread to `to` now, or once the turn that's going has finished. */
  function queueHandoff(entry: LiveSession, from: { id: string; title: string }, to: Parameters<SessionRuntime['speakAs']>[0] & object): void {
    if (entry.running) {
      entry.afterTurn ??= [];
      entry.afterTurn.push({ from, to });
      return;
    }
    entry.exchanges = 1;
    void handOff(entry, from, to).then((result) => handOffs(entry, result));
  }

  function handOff(entry: LiveSession, from: { id: string; title: string }, to: Parameters<SessionRuntime['speakAs']>[0] & object) {
    entry.runtime.speakAs(to);
    entry.runtime.sender = `agent:${from.id}`;
    entry.runtime.team = teamFor(entry);
    entry.runtime.attendance = attendanceLines(entry.id);
    opts.log?.(`${from.title} handed thread ${entry.id} to ${to.title}`);
    return startTurn(entry, `<polyphemus_handoff from="${from.title}" to="${to.title}">${from.title} mentioned you in the thread above. Pick it up from what they said. If your reply is for ${from.title} or another agent here — an answer, a question, the next part of the work — @mention them so they get the next turn. When it’s done and back with a person, @mention the person instead.</polyphemus_handoff>`, { quiet: true });
  }

  /** The guard stops it, where it happened, and says what it's cost so far. */
  function askGuard(entry: LiveSession, from: { id: string; title: string }, to: { id: string; title: string }, limit: number): void {
    const actors = polyphemus.store.messageActors(entry.id);
    const since = actors.findLastIndex((actor) => actor?.startsWith('person:') ?? false) + 1;
    const turns = polyphemus.store.turns(entry.id).filter((t) => t.endSeq > since);
    const tokens = turns.reduce((sum, t) => sum + t.usage.inputTokens + t.usage.outputTokens + t.usage.cacheReadTokens + t.usage.cacheWriteTokens, 0);
    const between = [...new Set(actors.slice(since).filter((a): a is string => a?.startsWith('agent:') ?? false).map((a) => agentNamed(a.slice(6))?.title ?? a.slice(6)))];
    const question = polyphemus.store.askQuestion({
      id: randomUUID().slice(0, 8),
      sessionId: entry.id,
      kind: 'guard',
      detail: { count: entry.exchanges ?? limit, limit, from: from.title, fromId: from.id, to: to.title, toId: to.id, between, tokens, models: [...new Set(turns.map((t) => t.model))] },
    });
    announceQuestion(question);
    opts.log?.(`Guard paused thread ${entry.id} after ${entry.exchanges} agent-to-agent exchanges`);
  }

  /** An agent asks to bring a teammate into the thread: the person says yes or no. */
  function askInvite(entry: LiveSession, from: { id: string; title: string }, agent: { id: string; title: string; description?: string }, reply: string): void {
    const question = polyphemus.store.askQuestion({
      id: randomUUID().slice(0, 8),
      sessionId: entry.id,
      kind: 'invite',
      detail: { from: from.title, fromId: from.id, agent: agent.title, agentId: agent.id, about: agent.description ?? '', said: clip(reply, 400), ...(isDirectChat(entry.id) && { newThread: true }) },
    });
    announceQuestion(question);
    opts.log?.(`${from.title} asked to ${isDirectChat(entry.id) ? 'start a thread with' : 'bring in'} ${agent.title} from thread ${entry.id}`);
  }

  /**
   * A DM — one agent, outside every project — stays that way. Saying yes starts a new thread with
   * both agents instead of adding the new one here. The id is the new thread.
   */
  function openGroupBeside(stored: StoredQuestion, agent: Agent, from: Agent, by: string): string | undefined {
    const parent = polyphemus.store.get(stored.sessionId);
    if (!parent) return undefined;
    const child = polyphemus.store.create({
      title: clip(`${from.title} and ${agent.title}`, 60),
      provider: parent.provider,
      model: parent.model,
      cwd: parent.cwd,
      agent: from.id,
      startedBy: by,
      spunFrom: parent.id,
    });
    polyphemus.store.addMember(child.id, agent.id, child.createdAt, by);
    for (const personId of polyphemus.store.peopleIn(parent.id)) {
      if (`person:${personId}` === by) continue;
      polyphemus.store.addThreadPerson(child.id, personId, child.createdAt, by);
    }
    opts.log?.(`${from.title} and the person kept their conversation; ${agent.title} picks up in thread ${child.id}`);
    broadcast({ type: 'session_changed', sessionId: parent.id, spinOut: child.id });
    broadcast({ type: 'session_changed', sessionId: child.id });
    const entry = liveSession(child.id);
    if (!entry) return child.id;
    entry.runtime.speakAs(agent);
    entry.runtime.sender = `agent:${from.id}`;
    entry.runtime.team = teamFor(entry);
    entry.runtime.attendance = attendanceLines(entry.id);
    const said = clip(String(stored.detail.said ?? ''), 400).replaceAll('</polyphemus_handoff>', '');
    void startTurn(
      entry,
      `<polyphemus_handoff from="${from.title}" to="${agent.title}">${from.title} was in a conversation with the person, just the two of them, and asked to bring you in. That conversation stays as it was. This is a new thread with both of you and the person. ${from.title} said: ${said} Pick it up from that. If your reply is for ${from.title} or another agent here — an answer, a question, the next part of the work — @mention them so they get the next turn. When it’s done and back with a person, @mention the person instead.</polyphemus_handoff>`,
    ).then((result) => handOffs(entry, result));
    return child.id;
  }

  /** A person answers an invitation. In a DM, yes starts a new thread; anywhere else, the agent joins this one. */
  function answerInvite(stored: StoredQuestion, answer: 'bring' | 'dismiss', by: string): { ok: true; thread?: string } | { ok: false } {
    const agent = answer === 'bring' ? agentNamed(String(stored.detail.agentId)) : undefined;
    const from = answer === 'bring' ? agentNamed(String(stored.detail.fromId)) : undefined;
    const apart = Boolean(agent && from && isDirectChat(stored.sessionId));
    const recorded = apart ? 'thread' : answer;
    if (!polyphemus.store.answerQuestion(stored.id, recorded, by)) return { ok: false };
    broadcast({ type: 'question_resolved', id: stored.id, sessionId: stored.sessionId, by, answer: recorded });
    if (answer === 'dismiss' || !agent) return { ok: true };
    if (apart && from) {
      const thread = openGroupBeside(stored, agent, from, by);
      return { ok: true, ...(thread && { thread }) };
    }
    polyphemus.store.addMember(stored.sessionId, agent.id, Date.now(), by);
    broadcast({ type: 'members', sessionId: stored.sessionId, members: threadMembers(stored.sessionId).map((a) => a.id) });
    broadcast({ type: 'session_changed', sessionId: stored.sessionId });
    const entry = liveSession(stored.sessionId);
    // A turn already going keeps the thread: they start when it finishes, instead of being added and forgotten.
    if (!entry || !from) return { ok: true };
    queueHandoff(entry, from, agent);
    return { ok: true };
  }

  /** A person answers the guard: carry on (with a fresh allowance), carry on and stop asking in this thread, or stop. */
  function answerGuard(stored: StoredQuestion, answer: string, by: string): boolean {
    if (!polyphemus.store.answerQuestion(stored.id, answer, by)) return false;
    broadcast({ type: 'question_resolved', id: stored.id, sessionId: stored.sessionId, by, answer });
    if (answer === 'stop') return true;
    if (answer === 'always') {
      polyphemus.store.setGuardLimit(stored.sessionId, 0);
      broadcast({ type: 'session_changed', sessionId: stored.sessionId });
    }
    const entry = liveSession(stored.sessionId);
    const to = agentNamed(String(stored.detail.toId));
    const from = agentNamed(String(stored.detail.fromId));
    if (!entry || !to || !from) return true;
    queueHandoff(entry, from, to);
    return true;
  }

  /**
   * Something came in for a project — feedback, an idea, a finding (roadmap: it does the work, 4). It
   * becomes a thread of its own, holding the words as they came, and waits on a person: make work of
   * it, or dismiss it. Nothing is spent on it until someone decides.
   */
  function landIncoming(project: ProjectMeta, kind: IncomingKind, text: string, by: string, fromName: string, fromThread?: string): { id: string; question: string } {
    const ref = polyphemus.config.defaultModel ?? Object.keys(polyphemus.config.models)[0];
    if (!ref) throw new HttpError(400, 'Set up a model first: a request needs one to be made into work.');
    const model = resolveModel(polyphemus.config, ref);
    const words = text.trim().slice(0, 20_000);
    const meta = polyphemus.store.create({ title: clip(`${INCOMING_KINDS[kind]}: ${words.split('\n')[0]}`, 80), provider: model.provider, model: model.model, cwd: project.path, agent: defaultAgent(polyphemus, project.path, project.slug)?.id, startedBy: by, ...(fromThread && { spunFrom: fromThread }) });
    polyphemus.store.append(meta.id, { role: 'user', content: [{ type: 'text', text: `<polyphemus_note title="${INCOMING_KINDS[kind]} from ${fromName.replace(/"/g, "'")}">\n${words}\n</polyphemus_note>` }] }, by);
    broadcast({ type: 'session_changed', sessionId: meta.id });
    const question = polyphemus.store.askQuestion({ id: randomUUID().slice(0, 8), sessionId: meta.id, kind: 'incoming', detail: { kind, kindTitle: INCOMING_KINDS[kind], text: words, fromName, project: project.slug } });
    announceQuestion(question);
    opts.log?.(`${INCOMING_KINDS[kind]} for ${project.name} from ${fromName}: thread ${meta.id}`);
    return { id: meta.id, question: question.id };
  }

  /** A question that isn't held by a turn — a gate, an offer — told to everyone who can answer it. */
  function announceQuestion(stored: StoredQuestion): void {
    const view = questionView(stored);
    broadcast({ type: 'question', ...view, canAnswer: whoCanAnswer(stored.sessionId) });
    notify({ title: titleOf(stored.sessionId), body: clip(questionLine(view), 200), url: `/#/s/${stored.sessionId}`, tag: `question-${stored.id}` }, { kind: 'questions', sessionId: stored.sessionId });
  }

  /** Who did something, as a name: a person, an agent, or a routine. */
  function nameOf(actor: string | undefined): string {
    if (!actor) return 'someone';
    if (actor.startsWith('person:')) return polyphemus.store.person(actor.slice(7))?.name ?? 'someone who’s gone';
    if (actor.startsWith('agent:')) return agentNamed(actor.slice(6))?.title ?? actor.slice(6);
    if (actor.startsWith('routine:')) return 'a routine';
    return 'someone';
  }

  const runs = runExecutor({
    polyphemus,
    liveSession,
    startTurn,
    broadcast,
    announceQuestion,
    notify: (sessionId, body) => notify({ title: titleOf(sessionId), body: clip(body, 200), url: `/#/s/${sessionId}`, tag: `run-${sessionId}` }, { kind: 'finished', sessionId }),
    personName: nameOf,
    closing: () => closing,
    // Each attempt at a workflow's agent node is a fresh session: its own thread, linked to the run's,
    // kept off Home (it's part of the run), with the agent it names or the thread's own.
    startNext: (after, next) => {
      const parent = polyphemus.store.get(after.sessionId)!;
      const project = polyphemus.store.projectFor(parent.cwd);
      const workflow = findWorkflow(next.workflow);
      if (!project || !workflow) throw new Error(project ? `There’s no workflow called ${next.workflow}.` : 'The run’s thread isn’t in a project any more.');
      return startWorkflowThread({ project, workflow, input: next.input, agentRef: parent.agent || undefined, modelRef: `${parent.provider}:${parent.model}`, by: after.startedBy, yolo: live.get(parent.id)?.runtime.autoApprove ?? false, spunFrom: parent.id });
    },
    openNodeSession: (run, agentRef, title, opts) => {
      const parent = polyphemus.store.get(run.sessionId)!;
      const project = polyphemus.store.projectFor(parent.cwd);
      const agent = findAgent(polyphemus.home, project?.path, agentRef ?? parent.agent, project?.slug);
      const base = modelFor(polyphemus.config, parent.provider, parent.model);
      const model = opts.model ?? (agent ? agentModel(polyphemus.config, agent, base) : base);
      const meta = polyphemus.store.create({ title: clip(title, 80), provider: model.provider, model: model.model, cwd: opts.cwd, agent: agent?.id, startedBy: `run:${run.id}`, spunFrom: parent.id });
      const entry = liveSession(meta.id, model)!;
      entry.runtime.sender = run.startedBy;
      entry.runtime.autoApprove = live.get(parent.id)?.runtime.autoApprove ?? false;
      if (entry.runtime.autoApprove) polyphemus.store.setYolo(meta.id, true);
      // A run with a worktree of its own pushes only as its identity: its agents' shells can't push at all.
      entry.runtime.pushLocked = opts.cwd !== parent.cwd;
      return entry;
    },
    otherVendorModel: (provider) => {
      const vendor = (id: string) => connectionOf(id)?.vendor ?? id;
      // The models you picked first, in your order, then any named ones.
      const candidates = [...polyphemus.config.selected.map((ref) => resolveModel(polyphemus.config, ref)), ...Object.entries(polyphemus.config.models).map(([label, alias]) => ({ label, ...alias }))];
      for (const model of candidates) {
        if (vendor(model.provider) === vendor(provider)) continue;
        // Grok Build can't take polyphemus's tools, so it can't submit a review.
        if (polyphemus.config.providers[model.provider]?.adapter === 'grok-cli') continue;
        if (polyphemus.status(model.provider).ready && !polyphemus.unavailable(model.provider)) return model;
      }
      return undefined;
    },
    log: opts.log,
  });


  /**
   * A workflow in a thread of its own: its outcome as the title, its agent (or the default), and its
   * model. Refused before anything is left behind — no thread survives a start that failed.
   */
  function startWorkflowThread(o: { project: ProjectMeta; workflow: Workflow; input: Record<string, unknown>; agentRef?: string; modelRef?: string; by: string; yolo: boolean; spunFrom?: string }): string {
    const agent = o.agentRef ? findAgent(polyphemus.home, o.project.path, o.agentRef, o.project.slug) : defaultAgent(polyphemus, o.project.path, o.project.slug);
    if (o.agentRef && !agent) throw new HttpError(400, `No agent called "${o.agentRef}".`);
    const ref = o.modelRef || agent?.model || polyphemus.config.defaultModel;
    if (!ref) throw new HttpError(400, 'Pick a model.');
    const base = resolveModel(polyphemus.config, ref === FOLLOW_DEFAULT ? polyphemus.config.defaultModel! : ref);
    const model = agent ? agentModel(polyphemus.config, agent, base) : base;
    const meta = polyphemus.store.create({ title: clip(o.workflow.outcome(o.input) || o.workflow.name, 60), provider: model.provider, model: model.model, cwd: o.project.path, agent: agent?.id, startedBy: o.by, ...(o.spunFrom && { spunFrom: o.spunFrom }) });
    const entry = liveSession(meta.id, model)!;
    entry.runtime.sender = o.by;
    entry.runtime.autoApprove = o.yolo;
    if (o.yolo) polyphemus.store.setYolo(meta.id, true);
    try {
      runs.startWorkflow(meta.id, o.workflow, o.input, o.by);
    } catch (err) {
      polyphemus.store.delete(meta.id);
      live.delete(meta.id);
      if (err instanceof RunError) throw new HttpError(err.status, err.message);
      throw err;
    }
    broadcast({ type: 'session_changed', sessionId: meta.id });
    return meta.id;
  }

  /** Who's working in a thread right now: the thread's own turn, and any agent answering alongside it. */
  function workingIn(id: string): Array<{ agent: string | null; title: string | null; since: number | null; alongside: boolean }> {
    const entry = live.get(id);
    if (!entry) return [];
    const now = entry.running ? [{ agent: entry.runtime.agent?.id ?? null, title: entry.runtime.agent?.title ?? null, since: entry.workingSince ?? null, alongside: false }] : [];
    for (const aside of entry.asides?.values() ?? []) now.push({ agent: aside.agent.id, title: aside.agent.title, since: aside.since, alongside: true });
    return now;
  }

  /**
   * An agent answering while another works: its own runtime, opened on the thread as it stands, so it
   * reads everything said so far and adds to it. It answers once; it doesn't hand the thread on.
   */
  function startAside(entry: LiveSession, meta: SessionMeta, agent: Agent, said: string, images: ImageBlock[], sender: string): void {
    const runtime = polyphemus.openSession(meta, { cwd: meta.cwd, alwaysAllow: polyphemus.config.permissions.allow });
    wireRuntime(entry, runtime, meta);
    runtime.speakAs(agent);
    runtime.sender = sender;
    runtime.team = teamFor(entry);
    runtime.attendance = attendanceLines(entry.id);
    const controller = new AbortController();
    const aside = { agent: { id: agent.id, title: agent.title }, runtime, running: controller, since: Date.now() };
    (entry.asides ??= new Map()).set(agent.id, aside);
    broadcast({ type: 'turn_state', sessionId: entry.id, running: true, speaker: agent.id, alongside: true, working: workingIn(entry.id) });
    writeStatus();
    void runtime
      .send(said, controller.signal, images)
      .then(
        (stop) => {
          if (stop !== 'aborted') {
            notify({ title: titleOf(entry.id), body: clip(`${agent.title}: ${lastReply(runtime) ?? 'finished.'}`, 200), url: `/#/s/${entry.id}`, tag: `turn-${entry.id}-${agent.id}` }, { kind: 'finished', sessionId: entry.id });
          }
        },
        (err: unknown) => {
          broadcast({ sessionId: entry.id, agent: agent.id, event: { type: 'notice', text: `✗ ${(err as Error).message}` } });
        },
      )
      .finally(() => {
        entry.asides?.delete(agent.id);
        runtime.close();
        writeStatus();
        broadcast({ type: 'turn_state', sessionId: entry.id, running: Boolean(entry.running), speaker: entry.runtime.agent?.id ?? null, working: workingIn(entry.id) });
      });
  }

  /** Questions go to every connected device; the first answer wins. */
  function askerFor(entry: LiveSession): Asker {
    const ask = (detail: Omit<Question, 'id' | 'sessionId'>, signal?: AbortSignal) =>
      new Promise<string | undefined>((resolve) => {
        const { kind, ...rest } = detail;
        // An approval says where it would run, and shows paths from ~: the card said "on this
        // computer" under Isolated, and put the account's name on screen (2026-09-19).
        if (kind === 'approval') {
          const project = polyphemus.store.projectFor(polyphemus.store.get(entry.id)?.cwd ?? '');
          Object.assign(rest, { where: polyphemus.isolationFor(project) === 'host' ? 'host' : 'worker', ...(typeof rest.summary === 'string' && { summary: rest.summary.split(homedir()).join('~') }) });
        }
        // Kept in the database from the moment it's asked: Waiting on you is the daemon's, and
        // survives a disconnect (settled brief §7). The in-memory entry only holds the turn waiting on it.
        const stored = polyphemus.store.askQuestion({ id: randomUUID().slice(0, 8), sessionId: entry.id, kind: String(kind), detail: rest });
        const question = questionView(stored);
        const answer = (value: string | undefined, by?: string) => {
          // Resolved once, for everyone: if someone else got there first, this does nothing.
          if (!entry.questions.has(question.id)) return;
          const recorded = by === undefined ? polyphemus.store.expireQuestion(question.id, 'The turn it belonged to stopped.') : polyphemus.store.answerQuestion(question.id, value, by);
          if (!recorded) return;
          entry.questions.delete(question.id);
          broadcast({ type: 'question_resolved', id: question.id, sessionId: entry.id, by: by ?? null, answer: value ?? null });
          resolve(value);
        };
        entry.questions.set(question.id, { question, answer });
        broadcast({ type: 'question', ...question, canAnswer: whoCanAnswer(entry.id) });
        // Plain, calm wording: an urgent "Allow X?" from a web address reads like phishing to spam filters (and people).
        notify(
          {
            title: titleOf(entry.id),
            body: clip(detail.kind === 'approval' ? `Waiting for your OK to run ${String(detail.tool)}: ${String(detail.summary)}` : `Waiting for you: ${String(detail.reason)}`, 200),
            url: `/#/s/${entry.id}`,
            tag: `question-${question.id}`,
          },
          { kind: 'questions', sessionId: entry.id },
        );
        opts.log?.(`Waiting on you: ${detail.kind === 'approval' ? `allow ${String(detail.tool)}?` : 'switch models?'}`);
        signal?.addEventListener('abort', () => answer(undefined), { once: true });
      });
    return {
      approve: async (q, signal) => {
        const answer = await ask({ kind: 'approval', tool: q.tool, summary: q.summary, source: q.source }, signal);
        return answer === 'allow' || answer === 'always' ? answer : 'deny';
      },
      chooseFallback: async (q, signal) => {
        const candidates = q.candidates.map((c) => ({ label: c.label, target: `${c.provider}:${c.model}` }));
        const answer = await ask({ kind: 'fallback', reason: q.reason, retry: q.retry, candidates }, signal);
        return q.candidates.find((c) => c.label === answer);
      },
    };
  }

  const statusFile = join(polyphemus.home, 'daemon.json');
  /** Whether anything is mid-turn, for `poly service update` to wait on before restarting. */
  function writeStatus(): void {
    // Everyone working, agents answering alongside included: a deploy waits for all of them.
    const running = [...live.values()].filter((entry) => entry.running || entry.asides?.size).length;
    try {
      writeFileSync(statusFile, `${JSON.stringify({ pid: process.pid, running, updatedAt: Date.now() })}\n`);
    } catch {
      // Best effort: without it, an update just doesn't wait.
    }
  }

  /** Runs a turn in the background. `quiet` skips the "finished" notification (routines decide their own). */
  function startTurn(entry: LiveSession, text: string, opts: { quiet?: boolean; images?: ImageBlock[] } = {}): Promise<{ stop?: StopReason; error?: string }> {
    const controller = new AbortController();
    // A hand-off picks up within moments of the last turn ending: that's still the same work.
    if (!entry.running && !(entry.workingSince && entry.endedAt && Date.now() - entry.endedAt < 5_000)) entry.workingSince = Date.now();
    entry.running = controller;
    // A new turn is a person picking it back up.
    if (polyphemus.store.get(entry.id)?.pausedWhy) polyphemus.store.setPaused(entry.id, null);
    writeStatus();
    // Who's answering, so the thread can show them thinking.
    broadcast({ type: 'turn_state', sessionId: entry.id, running: true, speaker: entry.runtime.agent?.id ?? null, working: workingIn(entry.id) });
    const done = (body: string) => {
      if (!opts.quiet) notify({ title: titleOf(entry.id), body, url: `/#/s/${entry.id}`, tag: `turn-${entry.id}` }, { kind: 'finished', sessionId: entry.id });
    };
    return entry.runtime
      .send(text, controller.signal, opts.images)
      .then(
        (stop) => {
          // It stopped on its own and needs a person: the row says paused, and why, until someone picks it up.
          if (entry.runtime.pausedBecause) {
            polyphemus.store.setPaused(entry.id, entry.runtime.pausedBecause);
            broadcast({ type: 'session_changed', sessionId: entry.id, paused: true });
          }
          // You pressed Stop yourself: nothing to tell you.
          if (stop !== 'aborted') done(clip(`Done: ${lastReply(entry.runtime) ?? 'finished.'}`, 200));
          return { stop };
        },
        (err: unknown) => {
          broadcast({ sessionId: entry.id, event: { type: 'notice', text: `✗ ${(err as Error).message}` } });
          done(clip(`Stopped with an error: ${(err as Error).message}`, 200));
          return { error: (err as Error).message };
        },
      )
      .finally(() => {
        entry.running = undefined;
        entry.endedAt = Date.now();
        // After this tick an agent handing on has already started its turn: only a thread that's really free sends what's held,
        // or starts someone a person said yes to while this turn was going.
        setTimeout(() => {
          drainQueue(entry.id);
          settleAfterTurn(entry);
        }, 0);
        writeStatus();
        broadcast({ type: 'turn_state', sessionId: entry.id, running: false, working: workingIn(entry.id) });
      });
  }

  /** What's waiting on a person, from the database: the same for every device, after any reconnect. */
  const pendingQuestions = (): Question[] => polyphemus.store.openQuestions().map(questionView);

  /**
   * The one line for a question: the thread's second line, the push, and what a viewer reads.
   * One place, so a new kind can't be described on one surface and forgotten on another.
   */
  function questionLine(q: { kind?: string; [key: string]: unknown }): string {
    const text = (key: string) => (q[key] === undefined || q[key] === null ? '' : String(q[key]));
    switch (q.kind) {
      case 'approval':
        return `Waiting for an OK to run ${text('tool')}: ${text('summary')}`;
      case 'gate':
        return `Waiting for an OK: ${text('asks')}`;
      case 'outcome':
        return `Offered to track it as work: ${text('text')}`;
      case 'incoming':
        return `${text('kindTitle')} from ${text('fromName')}, waiting for someone to make work of it`;
      case 'routine':
        return q.stop === true ? `Proposed stopping the routine ${text('name')}` : q.replaces === true ? `Proposed a change to the routine ${text('name')}: ${text('schedule')}` : `Proposed a routine: ${text('name')}, ${text('schedule')}`;
      case 'profile':
        return `${text('agentTitle')} proposed a change to its own profile`;
      case 'note':
        return `${text('agentTitle')} asked to remember: ${text('name')}`;
      case 'guard':
        return `Paused — ${text('count')} messages between agents`;
      case 'invite':
        return isDirectChat(text('sessionId')) ? `${text('from')} wants to start a thread with ${text('agent')}` : `${text('from')} wants to bring in ${text('agent')}`;
      case 'skill':
        return `${text('agentTitle')} proposed a skill`;
      case 'secret':
        return `${text('agentTitle') || 'An agent'} asks for a secret: ${text('name')}`;
      case 'signin':
        return `${text('agentTitle') || 'An agent'} asks you to sign in to ${text('where')}`;
      default:
        return `Waiting for a decision${text('reason') ? `: ${text('reason')}` : ''}`;
    }
  }

  /** A stored question as clients see it. */
  function questionView(q: StoredQuestion): Question {
    const view: Question = { ...q.detail, id: q.id, sessionId: q.sessionId, kind: q.kind as Question['kind'], askedAt: q.askedAt, claimedBy: q.claimedBy ?? null, claimedAt: q.claimedAt ?? null };
    view.line = questionLine(view);
    return view;
  }

  /** A thread as a list shows it: what it is, and whether it's working or waiting on you. */
  /**
   * A thread as every list shows it — Home, a project's, an agent's, search — built here and only here,
   * so the same thread can't read differently in two places (settled brief §2). Three signals: who
   * (members and people, for the mark), one state, and whether it's on a person; everything else is
   * the second line in words.
   */
  function sessionRow(meta: SessionMeta, questions = pendingQuestions(), access?: Access) {
    const waiting = questions.find((q) => q.sessionId === meta.id);
    const members = threadMembers(meta.id).map(({ id, name, title, mark }) => ({ id, name, title, mark }));
    const line = polyphemus.store.lastLine(meta.id);
    // One state, in the order that matters most: needing a person, then ended, then kept, then who started it.
    const stateOf = (): 'paused' | 'finished' | 'kept' | 'routine' | null =>
      waiting || meta.pausedWhy ? 'paused' : meta.finishedAt ? 'finished' : meta.kept ? 'kept' : meta.startedBy?.startsWith('routine:') ? 'routine' : null;
    return {
      ...meta,
      // Its folder is for whoever works here (app review, 2026-09-20).
      ...(access && !access.canWorkInSession(meta) ? { cwd: '' } : {}),
      modelLabel: modelFor(polyphemus.config, meta.provider, meta.model).label,
      running: live.get(meta.id)?.running !== undefined,
      waiting: waiting !== undefined,
      project: polyphemus.store.projectFor(meta.cwd)?.slug ?? null,
      preview: polyphemus.store.lastReply(meta.id) ?? null,
      state: stateOf(),
      members,
      people: polyphemus.store.peopleIn(meta.id),
      lastLine: line ? { actor: line.actor, text: line.text, speaker: speakerName(line.actor, members) } : null,
      // What's on a person, in words, when something is.
      pausedWhy: waiting ? questionLine(waiting) : (meta.pausedWhy ?? null),
      // A work item's status and where its run is; null for a chat.
      work: runs.summary(meta.id),
    };
  }

  /** Who said a line, as a name: an agent's title, a person's name. */
  function speakerName(actor: string | null, members: Array<{ id: string; title: string }>): string | null {
    if (!actor) return null;
    if (actor.startsWith('agent:')) return members.find((m) => m.id === actor.slice(6))?.title ?? agentNamed(actor.slice(6))?.title ?? null;
    if (actor.startsWith('person:')) return polyphemus.store.person(actor.slice(7))?.name ?? null;
    return null;
  }

  function state(device: DeviceMeta) {
    const access = new Access(polyphemus.store, requirePerson(device));
    const everyone = polyphemus.store.people();
    const questions = pendingQuestions()
      .filter((q) => {
        const meta = polyphemus.store.get(q.sessionId);
        return meta !== undefined && access.canSeeSession(meta);
      })
      // Who can answer each one, so a card can say "Sam can approve this too" (settled brief §7).
      .map((q) => ({ ...q, canAnswer: whoCanAnswer(q.sessionId, everyone) }));
    // Fetched wider for someone who sees only part of the install, so they still get a full list.
    const sessions = polyphemus.store
      .list(access.owner ? 50 : 500)
      .filter((meta) => access.canSeeSession(meta) && !meta.startedBy?.startsWith('run:'))
      .slice(0, 50)
      .map((meta: SessionMeta) => sessionRow(meta, questions, access));
    const archivedCount = polyphemus.store.archivedCount(access.owner ? undefined : access.person.id);
    // Provider, model, and how you get in — the three things a person actually wants to know.
    // A connection id ("claude-code:default") is plumbing and never reaches a screen.
    const labels = [...polyphemus.config.selected, ...Object.keys(polyphemus.config.models)];
    // How each model has actually been going, and what leans on it — read once, not per row.
    const results = polyphemus.store.modelResults();
    const threads = polyphemus.store.threadCounts(access.owner ? undefined : access.person.id);
    // Agents this person is allowed to know about. The model list used to name every agent on disk,
    // including ones in projects they can't see (app review, 2026-09-20).
    const visibleAgents = rosterAgents().filter((agent) => access.canSeeAgent(agent));
    const agentsOnFile = visibleAgents;
    // A model an agent was made on isn't limited to your list: any model a connected provider runs
    // works (claude-code:claude-fable-5-1 while your list has only Opus). Those are said, apart, so
    // an agent's page doesn't call a model that runs fine "not set up".
    const agentOnly = [...new Set(agentsOnFile.flatMap((a) => [a.model, ...(a.fallback ?? [])]))].filter((label): label is string => {
      if (!label || label === 'default' || labels.includes(label)) return false;
      try {
        resolveModel(polyphemus.config, label);
        return true;
      } catch {
        return false;
      }
    });
    const modelRow = (label: string) => {
      const model = resolveModel(polyphemus.config, label);
      const status = polyphemus.status(model.provider);
      const unavailable = polyphemus.unavailable(model.provider) ?? null;
      const where = connectionOf(model.provider);
      // "default" means the vendor's CLI picks. Polyphemus can't know which until one has answered,
      // and once one has, every reply records what it came from.
      const picks = model.model === 'default';
      return {
        label,
        target: `${model.provider}:${model.model}`,
        /** True when it's one you chose rather than a short name you defined. */
        chosen: polyphemus.config.selected.includes(label),
        connection: model.provider,
        provider: where?.name ?? model.provider,
        vendor: where?.vendor ?? model.provider,
        how: where?.label ?? model.provider,
        billedAs: where?.how ?? null,
        modelId: picks ? null : model.model,
        // Whether "Asks first" means anything here: Codex, run headless, never asks about an action.
        asks: asksFirst(model.provider),
        lastReplyModel: picks ? (polyphemus.store.lastReplyModelOn(model.provider) ?? null) : null,
        ready: status.ready,
        note: status.note,
        out: unavailable !== null,
        unavailable,
        /** Why it can't run where agents are isolated right now, or null. */
        notIsolated: polyphemus.isolationBlocker(model.provider),
        metered: isMetered(polyphemus.config, model.provider),
        testCost: testCost(polyphemus.config, model.provider).said,
        result: results.get(`${model.provider}:${model.model}`) ?? null,
        usedBy: {
          agents: agentsOnFile.filter((a) => a.model === label || a.fallback?.includes(label)).map((a) => a.title),
          threads: threads.get(`${model.provider}:${model.model}`) ?? 0,
          backup: polyphemus.config.routing.fallback.indexOf(label) + 1 || null,
        },
      };
    };
    const models = labels.map(modelRow);
    const agentModels = agentOnly.map((label) => ({ ...modelRow(label), agentOnly: true }));
    const projects = polyphemus.store
      .projects()
      .filter((p) => access.canSeeProject(p.slug))
      .map((p) => ({
        ...p,
        // Where it is on this computer is for the people who work in it. A viewer reads the work,
        // and the owner's folder layout isn't part of it (app review, 2026-09-20).
        ...(access.canWorkInProject(p.slug) ? {} : { path: undefined }),
        needsOrientation: needsOrientation(p),
        // Where agents' commands run here: its own level (stricter than the install's) and the one that applies.
        isolation: { own: p.isolation ?? null, applies: polyphemus.isolationFor(p) },
        // What its agents may reach while isolated, and what they were refused lately (newest first), to grant.
        network: {
          presets: p.network?.presets ?? [],
          hosts: p.network?.hosts ?? [],
          refused: [...(polyphemus.refusedHosts.get(p.slug) ?? new Map<string, number>())].reverse().filter(([host]) => !grantedHosts(p.network).includes(host)).map(([host, at]) => ({ host, at })),
        },
        inbox: inboxItems(polyphemus.home, p).length,
        role: access.role(p.slug) ?? null,
        // Who's in it: the owner of the install always, and its members and viewers.
        people: polyphemus.store.projectMembers(p.slug).map(({ person, role }) => ({ id: person.id, name: person.name, role })),
      }));
    // Only the owner makes projects, and it's the only screen that says where one would go.
    const projectsRoot = access.owner ? polyphemus.config.projectsRoot : null;
    // Agents that come with polyphemus, so making one on the phone is picking from a list.
    const agentTemplates = templates('agents').map(({ kind: _kind, dir: _dir, ...template }) => template);
    // The roster: who you can start a thread as. Broken agent files are left out here; the
    // terminal (poly agents) is where you're told what's wrong with one.
    const agents = rosterAgents().filter((agent) => access.canSeeAgent(agent)).map((agent) => ({
      id: agent.id,
      name: agent.name,
      title: agent.title,
      description: agent.description,
      scope: agent.scope,
      project: agent.project,
      model: agent.model ?? null,
      fallback: agent.fallback ?? [],
      mark: agent.mark,
    }));
    const routines = scheduler.list().routines.filter((r) => (r.project ? access.canSeeProject(r.project) : access.owner)).map((r) => {
      const routineState = polyphemus.store.routineState(r.id);
      const [last] = polyphemus.store.fires(r.id, 1);
      return {
        id: r.id,
        name: r.name,
        project: r.project ?? null,
        agent: r.agent ? (findAgent(polyphemus.home, r.project ? polyphemus.store.project(r.project)?.path : undefined, r.agent, r.project)?.id ?? r.agent) : null,
        schedule: r.triggers.map(describeTrigger).join(' · '),
        next: routineState.paused || !r.enabled ? null : (nextRoutineFire(r, Date.now()) ?? null),
        paused: routineState.paused,
        pausedReason: routineState.pausedReason ?? null,
        // Paused by a person (in the app, or poly routine pause): a choice, not something waiting on anyone.
        pausedOnPurpose: routineState.paused && /^paused by /i.test(routineState.pausedReason ?? ''),
        // New or changed in the project's folder since a person last accepted it: it doesn't run until then.
        waiting: waitingRoutine(r),
        enabled: r.enabled,
        last: last ?? null,
      };
    });
    // kinds: what this device asked for, or null while its notifications are off.
    const push = { publicKey: opts.push?.publicKey, httpsUrl, kinds: (device && polyphemus.store.pushKinds(device.id)) ?? null };
    // Usage windows per provider, for the meters on the phone.
    const forecasts = polyphemus.forecasts();
    // The owner's plans and how much of them is left are the owner's business.
    const capacity = [...polyphemus.store.capacity().entries()].filter(() => access.owner).map(([provider, readings]) => ({
      provider,
      readings: readings.map((r) => {
        const f = forecasts.find((x) => x.provider === provider && x.window === r.window);
        return {
          window: r.window,
          usedPct: r.usedPct ?? null,
          resetsAt: r.resetsAt ?? null,
          label: formatUsage(r),
          forecast: f ? { status: f.status, text: describeForecast(f), runsOutAt: f.runsOutAt ?? null, pace: f.pace ?? null, stale: f.stale, observedAt: f.observedAt } : null,
        };
      }),
    }));
    const devices = polyphemus.store
      .listDevices()
      .filter((d) => !d.revokedAt && (access.owner || d.personId === access.person.id))
      .map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt ?? null, current: d.id === device?.id }));
    const routing = { fallback: polyphemus.config.routing.fallback, onFallback: polyphemus.config.routing.onFallback, allowMetered: polyphemus.config.routing.allowMetered, quotaRetryMinutes: polyphemus.config.routing.quotaRetryMinutes };
    const selected = polyphemus.config.selected;
    // Who you are, and the people you share something with — the interface shows people only once there are two.
    const me = { id: access.person.id, name: access.person.name, owner: access.owner };
    // Connections that stopped working, for the person who can fix each one (settled brief §5).
    const connectionIssues = polyphemus.connections
      .list()
      .filter((c) => c.health === 'failing' && connectionFixer(c) === access.person.id && !polyphemus.store.isDismissed(access.person.id, `connection:${c.id}`, `${c.errorKind}:${c.error}`))
      .map((c) => ({
        id: c.id,
        name: c.name,
        error: c.error ?? null,
        errorKind: c.errorKind ?? null,
        at: c.healthAt ?? null,
        session: c.errorSession && polyphemus.store.get(c.errorSession) ? { id: c.errorSession, title: titleOf(c.errorSession) } : null,
      }));
    const connectionCount = polyphemus.connections.list().filter((c) => access.canManageConnection(c) || polyphemus.store.connections.grants(c.id).some((g) => access.canSeeProject(g.project))).length;
    const people = polyphemus.store.people().filter((p) => access.owner || p.owner || p.id === access.person.id || [...polyphemus.store.projectRoles(p.id).keys()].some((slug) => access.canSeeProject(slug)));
    return {
      sessions, archivedCount, models, agentModels, selected, agents, agentTemplates, routing, isolation: isolationView(),
      defaultModel: polyphemus.config.defaultModel ?? null, usage: access.owner ? polyphemus.usageSummary() : '',
      projects, projectsRoot, questions, push, capacity, devices, routines, defaultAgent: defaultAgent(polyphemus)?.id ?? null,
      // Is there a newer polyphemus: only the owner updates the install, so only the owner is told.
      update: access.owner ? { ...knownUpdate(polyphemus.home, { channel: polyphemus.config.updates.channel }), checking: polyphemus.config.updates.check } : null,
      me, people: people.map(({ id, name, owner }) => ({ id, name, owner })),
      connectionIssues, connectionCount,
    };
  }

  /** Who is asked to fix a connection: its owner, or the install owner if they've gone. */
  function connectionFixer(connection: { owner: string }): string {
    return polyphemus.store.person(connection.owner)?.id ?? polyphemus.store.installOwner().id;
  }

  /** An agent's model as written: "default", or something that resolves now rather than at the first turn. */
  function checkedAgentModel(model: string): string {
    if (model !== FOLLOW_DEFAULT) listedModel(model);
    return model;
  }

  /** A model named here, resolved — and refused, before anything is saved, if it isn't on your list. */
  function listedModel(ref: string): ResolvedModel {
    const model = resolveModel(polyphemus.config, ref);
    const why = offList(polyphemus.config, model);
    if (why) throw new HttpError(400, why);
    return model;
  }

  /**
   * Every agent a device could use: your library, plus each project's. A phone has no working
   * folder, so scope comes from where the agent lives rather than from where you are.
   */
  function rosterAgents() {
    type Listed = ReturnType<typeof loadAgents>['agents'][number] & { project: string | null };
    const seen = new Map<string, Listed>();
    for (const agent of loadAgents(polyphemus.home).agents) seen.set(agent.id, { ...agent, project: null });
    for (const project of polyphemus.store.projects()) {
      // Which project an agent lives in, not just that it lives in one: it's the project a
      // message to that agent belongs to, so nobody has to be asked.
      for (const agent of loadAgents(polyphemus.home, project.path, project.slug).agents) {
        if (agent.scope === 'project') seen.set(agent.id, { ...agent, project: project.slug });
      }
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The providers, which are the companies whose models you use: Anthropic, OpenAI, xAI. Each has
   * one or more **connections** — ways in. Anthropic has two: its API with a key, and the Claude
   * Code CLI on your subscription. `config.providers` is keyed by connection, not by provider,
   * which is why a flat list of its ids put tools (claude-code, grok-build) next to companies.
   * Anything you added yourself is its own provider, named as you named it.
   * Keys never come back out: only whether one is saved.
   */
  /**
   * What a connection id in `config.providers` actually is. The config is keyed by connection —
   * (company × how you get in) — so `claude-code` and `anthropic` are one company reached two
   * ways. Nothing user-facing should ever print a connection id: it reads as a model or a tool.
   */
  function connectionOf(id: string): { vendor: string; name: string; label: string; how: string } | undefined {
    const known: Record<string, { vendor: string; name: string; label: string; how: string }> = {
      anthropic: { vendor: 'anthropic', name: 'Anthropic', label: 'API key', how: 'billed per token' },
      'claude-code': { vendor: 'anthropic', name: 'Anthropic', label: 'Claude Code CLI', how: 'your Claude subscription' },
      openai: { vendor: 'openai', name: 'OpenAI', label: 'API key', how: 'billed per token' },
      codex: { vendor: 'openai', name: 'OpenAI', label: 'Codex CLI', how: 'your ChatGPT plan' },
      xai: { vendor: 'xai', name: 'xAI', label: 'API key', how: 'billed per token' },
      'grok-build': { vendor: 'xai', name: 'xAI', label: 'Grok CLI', how: 'your SuperGrok plan' },
    };
    const shipped = known[id];
    if (shipped) return shipped;
    const entry = catalogueEntry(id);
    if (entry) {
      return {
        vendor: id,
        name: entry.vendor,
        label: entry.connect === 'cli' ? 'its own CLI' : entry.connect === 'local' ? 'a server you run' : 'API key',
        how: entry.connect === 'local' ? 'no key needed' : entry.connect === 'cli' ? 'its own login' : 'billed per token',
      };
    }
    return undefined;
  }

  /** What each CLI says about itself, cached briefly so a screen render doesn't spawn a process per row. */
  let discovered: { at: number; states: Record<string, CliState | undefined> } = { at: 0, states: {} };
  async function discover(): Promise<void> {
    if (Date.now() - discovered.at < 30_000) return;
    // Every CLI polyphemus knows about, not only those already in the config — on a fresh install
    // there's nothing in the config yet, and "what's already on this computer" is the whole point.
    const adapters = [
      ...new Set([...CATALOGUE.map((entry) => entry.adapter), ...Object.values(polyphemus.config.providers).map((p) => p.adapter)]),
    ].filter(isCliAdapter);
    const states = await Promise.all(adapters.map(async (adapter) => [adapter, await cliState(adapter)] as const));
    discovered = { at: Date.now(), states: Object.fromEntries(states) };
  }

  function vendorList() {
    const command: Record<string, string> = { 'claude-cli': 'claude', 'codex-cli': 'codex login', 'grok-cli': 'grok login' };
    const vendors = new Map<string, { id: string; name: string; ready: boolean; connections: unknown[] }>();

    for (const [id, providerConfig] of Object.entries(polyphemus.config.providers)) {
      const status = polyphemus.status(id);
      const signIn = providerConfig.auth.type === 'api_key' ? 'key' : providerConfig.auth.type === 'cli' ? 'cli' : 'none';
      const where = connectionOf(id) ?? {
        vendor: id,
        name: id,
        label: signIn === 'cli' ? 'its own CLI' : signIn === 'key' ? 'API key' : 'no key needed',
        how: signIn === 'none' ? 'a server you run' : 'billed per token',
      };
      let vendor = vendors.get(where.vendor);
      if (!vendor) {
        vendor = { id: where.vendor, name: where.name, ready: false, connections: [] };
        vendors.set(where.vendor, vendor);
      }
      vendor.ready ||= status.ready;
      // What the CLI itself says, when polyphemus has asked: installed, signed in, and as whom.
      const found = discovered.states[providerConfig.adapter];
      vendor.connections.push({
        id,
        label: where.label,
        ...(found ? { installed: found.installed, signedIn: found.signedIn ?? null, account: found.account ?? null, sandbox: found.sandbox ?? null, onWindows: found.onWindows === true } : {}),
        install: isCliAdapter(providerConfig.adapter) ? (cliInstallCommand(providerConfig.adapter) ?? null) : null,
        // Codex only: the owner turned its sandbox off for this computer.
        sandboxOff: providerConfig.adapter === 'codex-cli' ? providerConfig.sandbox === false : null,
        // Where its plan usage comes from, when that isn't obvious — and why it's unknown, when it is.
        usageFrom: providerConfig.adapter === 'grok-cli' ? { source: 'xAI’s billing endpoint, with the Grok CLI’s sign-in, every 5 minutes. It isn’t a documented API, so it can stop working.', unknown: polyphemus.grokUsageUnknown ?? null } : null,
        how: where.how,
        signIn,
        ready: status.ready,
        note: status.note,
        offered: status.offered === true,
        hasKey: providerConfig.auth.type === 'api_key' && polyphemus.credentials.apiKey(id) !== undefined,
        command: command[providerConfig.adapter] ?? null,
        models: Object.entries(polyphemus.config.models)
          .filter(([, m]) => m.provider === id)
          .map(([label]) => label),
        chosen: polyphemus.config.selected.filter((ref) => ref.startsWith(`${id}:`)),
        metered: providerConfig.auth.type === 'api_key',
      });
    }
    // A connection that works comes first, so a provider leads with the way in you actually have.
    for (const vendor of vendors.values()) {
      (vendor.connections as Array<{ ready: boolean }>).sort((a, b) => Number(b.ready) - Number(a.ready));
    }
    return [...vendors.values()];
  }

  /**
   * config.toml changes from outside the daemon too — `poly config set` in a terminal, an
   * editor, another machine's deploy — and the daemon lives for weeks. Without this it answered
   * from the config it started with: after six models were removed from the file, the app was
   * still offering them. Stat before serving; re-read only when the file has actually moved.
   */
  let configSeenAt = statSafe(configFile(polyphemus.home));
  function noticeConfigChange(): void {
    const now = statSafe(configFile(polyphemus.home));
    if (now === configSeenAt) return;
    configSeenAt = now;
    try {
      polyphemus.reloadConfig();
      opts.log?.('config.toml changed outside polyphemus; re-read it.');
    } catch (err) {
      // A half-written or invalid file: keep the last good config rather than serving nothing.
      opts.log?.(`config.toml changed but wouldn't load, so the last good one stands: ${(err as Error).message}`);
    }
  }

  /** Sign-ins running now, so a second tap doesn't start a second browser flow. */
  const signingIn = new Map<string, { done: Promise<boolean>; cancel: () => void }>();
  const installing = new Map<string, { done: Promise<boolean>; cancel: () => void }>();

  /** A conversation with one agent that belongs to no project: a DM. A second agent doesn't join it. */
  function isDirectChat(sessionId: string): boolean {
    const meta = sessionId ? polyphemus.store.get(sessionId) : undefined;
    if (!meta || polyphemus.store.projectFor(meta.cwd)) return false;
    return threadMembers(sessionId).length === 1;
  }

  /** The agents in a thread, as agents rather than names. */
  const threadMembers = (id: string) => {
    const meta = polyphemus.store.get(id);
    const slug = meta ? polyphemus.store.projectFor(meta.cwd)?.slug : undefined;
    // Only agents that belong here speak here: the library's, and this project's own. Another
    // project's agent stored as a member (by an older version, or by hand) is simply not in it.
    return polyphemus.store.members(id).flatMap((ref) => {
      const agent = agentNamed(ref, slug);
      return agent && fitsThread(agent, slug) ? [agent] : [];
    });
  };

  /**
   * Why this person can't bring this agent into this thread, or undefined if they can. One rule for
   * every way in — by hand, by @mention, by saying yes to an agent's invitation: an agent that can be
   * seen and belongs here, and outside every project only the owner brings one in, since it runs with
   * what it carries. Anyone in a conversation can talk to an agent that's already there.
   */
  const cantBringIn = (access: Access, agent: { project: string | null; title: string }, sessionId: string): string | undefined => {
    const meta = polyphemus.store.get(sessionId);
    const slug = meta ? polyphemus.store.projectFor(meta.cwd)?.slug : undefined;
    if (!access.canSeeAgent(agent) || !fitsThread(agent, slug)) return `${agent.title} can’t be brought in here.`;
    if (!slug && !access.owner) return 'Only the owner of this install can bring an agent into a conversation outside a project.';
    return undefined;
  };

  /** Whether an agent can be in a thread at all: a library agent, or the thread's own project's. */
  const fitsThread = (agent: { project: string | null }, slug: string | undefined) => agent.project === null || agent.project === slug;

  /**
   * An agent by id (`reviewer`, `game-night/bd`), or by bare name as older threads and links
   * stored it: the project's own agent of that name when a project is in play, else a library
   * agent, else the only agent anywhere with that name. Two projects' `reviewer`s never resolve to
   * each other by accident — an ambiguous bare name finds nothing.
   */
  /**
   * Whether a provider can ask before it acts. Codex, run headless, never asks: it works within its
   * sandbox, or the worker when isolated. The app says so instead of promising "Asks first".
   */
  const asksFirst = (provider: string) => polyphemus.config.providers[provider]?.adapter !== 'codex-cli';
  /**
   * Who a routine runs as, and on what: its own model if it names one, else its agent's route. What
   * the app says about it (asks first, or not) comes from here too, so it's what actually runs.
   */
  const routineRoute = (routine: Routine, base: ResolvedModel) => {
    const routineProject = routine.project ? polyphemus.store.project(routine.project) : undefined;
    const agent = routine.agent ? findAgent(polyphemus.home, routineProject?.path, routine.agent, routine.project) : defaultAgent(polyphemus, routineProject?.path, routineProject?.slug);
    return { agent, model: agent && !routine.model ? agentModel(polyphemus.config, agent, base) : base };
  };
  const routineAsks = (routine: Routine) => {
    const ref = routine.model ?? polyphemus.config.defaultModel;
    try {
      return ref ? asksFirst(routineRoute(routine, resolveModel(polyphemus.config, ref)).model.provider) : true;
    } catch {
      return true;
    }
  };

  /** A project's routine that isn't the version a person accepted. */
  const waitingRoutine = (routine: Routine) => routine.project !== undefined && routine.digest !== undefined && polyphemus.store.routineState(routine.id).acceptedDigest !== routine.digest;

  /** Rewrites a routine's file: a project's through no link out of the project. */
  const writeRoutineFile = (routine: Routine, text: string) => {
    const project = routine.project ? polyphemus.store.project(routine.project) : undefined;
    if (project) replaceInside(project.path, routine.file, Buffer.from(text));
    else writeFileSync(routine.file, text);
  };

  const agentNamed = (ref: string, projectSlug?: string) => {
    const roster = rosterAgents();
    const exact = roster.find((agent) => agent.id === ref);
    if (exact) return exact;
    const named = roster.filter((agent) => agent.name === ref);
    return named.find((agent) => agent.project === projectSlug && projectSlug !== undefined) ?? named.find((agent) => agent.project === null) ?? (named.length === 1 ? named[0] : undefined);
  };

  const connectionApi = connectionRoutes({
    polyphemus,
    agentNamed,
    agentsIn: (project) => rosterAgents().filter((agent) => agent.project === null || agent.project === project),
    titleOf,
    canSeeSession: (access, sessionId) => {
      const meta = polyphemus.store.get(sessionId);
      return meta !== undefined && access.canSeeSession(meta);
    },
    changed: (connection) => broadcast({ type: 'connection_changed', connection }),
    publicOrigin: (req) => {
      const origin = typeof req.headers.origin === 'string' && /^https:\/\//.test(req.headers.origin) ? req.headers.origin : undefined;
      if (origin) return origin;
      if (overHttps(req)) return `https://${req.headers.host}`;
      // Reached over plain http (the tailnet IP, localhost): the https address, if there is one, is where sign-in comes back.
      if (httpsUrl) return httpsUrl.replace(/\/$/, '');
      return `http://${req.headers.host}`;
    },
    log: opts.log,
  });
  // A connection that stops working mid-run is news for whoever can fix it, on whatever device they're on.
  const stopHearingConnections = polyphemus.connections.on((connection) => {
    broadcast({ type: 'connection_changed', connection: connection.id });
    if (connection.health !== 'failing') return;
    opts.log?.(`${connection.name} isn't working: ${connection.error ?? 'unknown error'}`);
    notify(
      { title: connection.name, body: clip(`Needs you: ${connection.errorKind === 'auth' ? 'its sign-in was refused. Reconnect it.' : (connection.error ?? 'it stopped working.')}`, 200), url: `/#/connections/${connection.id}`, tag: `connection-${connection.id}` },
      { kind: 'questions', person: connectionFixer(connection) },
    );
  });

  /** A mark from a request body, checked here so a bad one is a 400 rather than a broken file. */
  function markFrom(value: unknown): Mark | undefined {
    if (value === undefined || value === null) return undefined;
    const raw = value as Partial<Mark>;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'A mark is a shape and a colour.');
    if (!MARK_SHAPES.includes(raw.shape!)) throw new HttpError(400, `A mark's shape must be one of: ${MARK_SHAPES.join(', ')}.`);
    if (!MARK_COLORS.includes(raw.color!)) throw new HttpError(400, `A mark's colour must be one of: ${MARK_COLORS.join(', ')}.`);
    return { shape: raw.shape!, color: raw.color! };
  }

  /**
   * Writes an agent's persona from its description, after the response has gone. The app is
   * already on the agent's screen by then, so it's told when the words land rather than waiting.
   */
  async function draftFor(ref: string): Promise<void> {
    const agent = agentNamed(ref);
    if (!agent) return;
    const draft = await draftPersona(polyphemus, agent);
    opts.log?.(draft ? `Wrote ${agent.id}'s persona from its description.` : `Couldn't write ${agent.id}'s persona; its description stands on its own.`);
    broadcast({ type: 'agent_changed', name: agent.id, drafted: draft !== undefined });
  }

  /** The skill library as last read; reading it again runs in the background, once at a time. */
  let skillIndexBuild: { done: number; of: number } | undefined;
  function skillLibrary(refresh = false) {
    const cached = cachedSkillIndex(polyphemus.home);
    const stale = !cachedSkillIndex(polyphemus.home, { fresh: true });
    if ((refresh || stale) && !skillIndexBuild) {
      skillIndexBuild = { done: 0, of: 0 };
      void buildSkillIndex((done, of) => (skillIndexBuild = { done, of }))
        .then((index) => {
          saveSkillIndex(polyphemus.home, index);
          opts.log?.(`Read the skill library: ${index.skills.length} skills${index.problems.length ? `, ${index.problems.length} sources unreadable` : ''}`);
          broadcast({ type: 'skills_changed' });
        })
        .catch((err: Error) => opts.log?.(`Couldn't read the skill library: ${err.message}`))
        .finally(() => (skillIndexBuild = undefined));
    }
    return { index: cached, building: skillIndexBuild };
  }

  /** Where skills live, by scope: the shared library, each project's, and each agent's own. */
  function installedSkills(access: Access) {
    // A project's skills, and a project agent's own, are read from the project's folder, through no link.
    const own = (dir: string, scope: 'library' | 'project' | 'agent', root?: string) =>
      loadSkills(polyphemus.home, scope === 'project' ? dir : root, scope === 'agent' ? dir : undefined)
        .skills.filter((skill) => skill.scope === scope)
        .map((skill) => {
          const origin = skillOrigin(skill.dir, scope === 'project' ? dir : root);
          return { name: skill.name, description: skill.description, from: origin ? { id: origin.id, license: origin.license } : null };
        });
    return {
      library: own(polyphemus.home, 'library'),
      agents: rosterAgents().filter((a) => access.canSeeAgent(a)).map((a) => ({ id: a.id, title: a.title, mark: a.mark, skills: own(a.dir, 'agent', a.root) })),
      projects: polyphemus.store.projects().filter((p) => access.canSeeProject(p.slug)).map((p) => ({ slug: p.slug, name: p.name, skills: own(p.path, 'project') })).filter((p) => p.skills.length),
    };
  }

  /** Where "to" puts a skill: "library", "agent:<id>", or "project:<slug>". */
  /** …and `root`, the folder above it that agents can't replace, which it's written from. */
  function skillTarget(to: string): { dir: string; words: string; root: string } {
    if (to === 'library') return { dir: librarySkillsDir(polyphemus.home), words: 'your shared library', root: polyphemus.home };
    if (to.startsWith('agent:')) {
      const agent = agentNamed(to.slice(6));
      if (!agent) throw new HttpError(400, 'No such agent.');
      return { dir: agentSkillsDir(agent.dir), words: agent.title, root: agent.root ?? polyphemus.home };
    }
    if (to.startsWith('project:')) {
      const project = polyphemus.store.project(to.slice(8));
      if (!project) throw new HttpError(400, 'No such project.');
      return { dir: projectSkillsDir(project.path), words: project.name, root: project.path };
    }
    throw new HttpError(400, 'Say where it goes: library, agent:<id> or project:<slug>.');
  }

  async function skillsApi(req: IncomingMessage, res: ServerResponse, parts: string[], body: Record<string, unknown>, access: Access, device: DeviceMeta): Promise<void> {
    const get = req.method === 'GET';
    if (get && parts.length === 2) return sendJson(res, 200, installedSkills(access));
    if (get && parts[2] === 'library') {
      const params = new URL(req.url ?? '/', 'http://polyphemus').searchParams;
      const { index, building } = skillLibrary(params.get('refresh') === '1' && access.owner);
      const found = index ? searchSkills(index, params.get('q') ?? '', params.get('source') || undefined) : [];
      return sendJson(res, 200, {
        builtAt: index?.builtAt ?? null,
        building: building ?? null,
        total: index?.skills.length ?? 0,
        withheld: index?.withheld ?? 0,
        problems: index?.problems ?? [],
        sources: SKILL_SOURCES.map((s) => ({ id: s.id, name: s.name, repo: s.repo, count: index?.skills.filter((k) => k.source === s.id).length ?? 0 })),
        skills: found.slice(0, 200),
        more: Math.max(0, found.length - 200),
      });
    }
    if (req.method === 'POST' && parts[2] === 'install' && parts.length === 3) {
      if (!access.owner) throw new HttpError(403, OWNER_ONLY);
      const index = cachedSkillIndex(polyphemus.home);
      const skill = index?.skills.find((k) => k.id === String(body.id ?? ''));
      if (!skill) throw new HttpError(404, 'That skill isn’t in the library.');
      const target = skillTarget(String(body.to ?? 'library'));
      const aside = join(polyphemus.home, 'trash', 'skills', `${skill.name}-${Date.now()}`);
      mkdirSync(dirname(aside), { recursive: true });
      const dir = await installSkill(skill, target.dir, { by: `person:${requirePerson(device).id}`, replace: body.replace === true, root: target.root, aside }).catch((err: Error) => {
        throw new HttpError(err instanceof PolyphemusError && err.code === 'CONFLICT' ? 409 : 400, err.message);
      });
      opts.log?.(`Installed ${skill.id} for ${target.words}`);
      broadcast({ type: 'skills_changed' });
      return sendJson(res, 201, { name: skill.name, dir, for: target.words });
    }
    if (req.method === 'POST' && parts[2] === 'remove' && parts.length === 3) {
      if (!access.owner) throw new HttpError(403, OWNER_ONLY);
      const name = String(body.name ?? '');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new HttpError(400, 'Which skill?');
      const target = skillTarget(String(body.from ?? 'library'));
      const dir = join(target.dir, name);
      if (!existsInside(target.root, join(dir, 'SKILL.md'))) throw new HttpError(404, 'That skill isn’t there.');
      // Moved aside rather than deleted, like an agent: a skill someone wrote can be put back by hand.
      // From its root, through no link: the folder it's in may be a project's.
      const trash = join(polyphemus.home, 'trash', 'skills', `${name}-${Date.now()}`);
      mkdirSync(dirname(trash), { recursive: true });
      moveOutInside(target.root, dir, trash);
      opts.log?.(`Removed the skill ${name} from ${target.words}`);
      broadcast({ type: 'skills_changed' });
      return sendJson(res, 200, { removed: name, trash });
    }
    throw new HttpError(404, 'No such skills route.');
  }

  /**
   * Teaching by showing (desktop.md, D4): a person records themselves doing something on an agent's
   * computer — each click with a picture of what was clicked, what was typed, keys and scrolls — and
   * the agent is handed it to turn into a skill (and a routine, if it's for a schedule). The app says
   * what the person did; the pictures are taken here, the moment they press.
   */
  const recordings = new Map<string, { id: string; startedAt: number; steps: Array<Record<string, unknown>>; dir: string }>();
  async function recording(agent: Agent, body: Record<string, unknown>, access: Access): Promise<Record<string, unknown>> {
    const step = (body.step ?? {}) as Record<string, unknown>;
    const now = recordings.get(agent.id);
    switch (body.phase) {
      case 'start': {
        const id = randomUUID().slice(0, 8);
        const dir = join(polyphemus.home, 'recordings', id);
        mkdirSync(dir, { recursive: true });
        recordings.set(agent.id, { id, startedAt: Date.now(), steps: [], dir });
        return { recording: id };
      }
      case 'step': {
        if (!now) throw new HttpError(409, 'Nothing is being recorded.');
        if (now.steps.length >= 400) return { steps: now.steps.length };
        const kind = String(step.kind ?? '');
        const last = now.steps.at(-1);
        if (kind === 'type' && typeof step.text === 'string') {
          // Typing is one step until something else happens.
          if (last?.kind === 'type') last.text = `${String(last.text)}${step.text}`.slice(0, 2000);
          else now.steps.push({ kind: 'type', text: step.text.slice(0, 2000), at: Date.now() });
        } else if (kind === 'scroll') {
          if (last?.kind === 'scroll' && last.direction === step.direction) last.amount = Number(last.amount ?? 1) + 1;
          else now.steps.push({ kind: 'scroll', direction: step.direction === 'up' ? 'up' : 'down', amount: 1, at: Date.now() });
        } else if (kind === 'key') {
          now.steps.push({ kind: 'key', keys: String(step.keys ?? '').slice(0, 40), at: Date.now() });
        } else if (kind === 'click') {
          const n = now.steps.length + 1;
          const shot = `step-${n}.png`;
          const x = Math.round(Number(step.x));
          const y = Math.round(Number(step.y));
          now.steps.push({ kind: 'click', x, y, button: step.button === 'right' ? 'right' : 'left', shot, at: Date.now() });
          // What was there when they pressed: taken now, before the screen changes.
          await polyphemus.desktops.screenshot(agent.id).then((png) => writeFileSync(join(now.dir, shot), png)).catch(() => undefined);
        }
        return { steps: now.steps.length };
      }
      case 'stop': {
        if (!now) throw new HttpError(409, 'Nothing is being recorded.');
        recordings.delete(agent.id);
        writeFileSync(join(now.dir, 'steps.json'), JSON.stringify({ agent: agent.id, by: access.person.id, startedAt: now.startedAt, endedAt: Date.now(), steps: now.steps }, null, 2));
        opts.log?.(`${access.person.name} recorded ${now.steps.length} steps on ${agent.title}’s computer`);
        return { recording: now.id, steps: now.steps.length };
      }
      case 'teach': {
        const id = String(body.recording ?? '');
        if (!/^[0-9a-f]{8}$/.test(id)) throw new HttpError(400, 'Which recording?');
        const dir = join(polyphemus.home, 'recordings', id);
        const saved = (() => {
          try {
            return JSON.parse(readFileSync(join(dir, 'steps.json'), 'utf8')) as { agent: string; steps: Array<Record<string, unknown>> };
          } catch {
            throw new HttpError(404, 'That recording isn’t here anymore.');
          }
        })();
        if (saved.agent !== agent.id) throw new HttpError(400, 'That recording was made on another agent’s computer.');
        const words = (st: Record<string, unknown>, n: number) =>
          st.kind === 'click' ? `${n}. ${st.button === 'right' ? 'Right-clicked' : 'Clicked'} at ${String(st.x)},${String(st.y)}${st.shot ? ` (picture ${String(st.shot)})` : ''}`
          : st.kind === 'type' ? `${n}. Typed “${String(st.text)}”`
          : st.kind === 'key' ? `${n}. Pressed ${String(st.keys)}`
          : `${n}. Scrolled ${String(st.direction)} ${String(st.amount)} notch${Number(st.amount) === 1 ? '' : 'es'}`;
        // Pictures of the clicks, spread across the recording: a model takes a handful at a time.
        const clicks = saved.steps.filter((st) => st.kind === 'click' && st.shot && existsSync(join(dir, String(st.shot))));
        const picked = clicks.length <= MAX_IMAGES ? clicks : Array.from({ length: MAX_IMAGES }, (_, i) => clicks[Math.round((i * (clicks.length - 1)) / (MAX_IMAGES - 1))]!);
        const images = picked.map((st) => saveImage(polyphemus.home, readFileSync(join(dir, String(st.shot))), String(st.shot)));
        const text = [
          `I recorded myself doing something on your computer, so you can learn to do it yourself. The steps, in order (clicks are at screen positions on your 1280×800 desktop${picked.length ? '; the pictures show what was on the screen at the clicks named in them' : ''}):`,
          '',
          ...saved.steps.map((st, i) => words(st, i + 1)),
          '',
          typeof body.about === 'string' && body.about.trim() ? `What it was for: ${body.about.trim()}` : 'Work out what the task was from the steps and pictures, and say it back to me in a sentence.',
          '',
          'Turn it into a skill with propose_skill — what it’s for, the steps in words a person would use (what to click on, not coordinates), and what to check — so you can do it on your own computer. If it’s something to do on a schedule, propose a routine for it too. Ask me about anything the recording doesn’t make clear.',
        ].join('\n');
        const model = agentModel(polyphemus.config, agent, resolveModel(polyphemus.config, polyphemus.config.defaultModel ?? agent.model ?? ''));
        const cwd = directFolder(polyphemus.config.projectsRoot);
        const meta = polyphemus.store.create({ title: `Learning: ${typeof body.about === 'string' && body.about.trim() ? clip(body.about.trim(), 50) : 'a recorded task'}`, provider: model.provider, model: model.model, cwd, agent: agent.id, startedBy: `person:${access.person.id}` });
        const entry = liveSession(meta.id, model)!;
        entry.runtime.sender = `person:${access.person.id}`;
        void converse(entry, text, images);
        broadcast({ type: 'session_changed', sessionId: meta.id });
        return { session: meta.id };
      }
      default:
        return { recording: now?.id ?? null, steps: now?.steps.length ?? 0 };
    }
  }

  /** The folder a thread works in, where its attached files go. */
  function threadFolder(id: string): string {
    const meta = polyphemus.store.get(id);
    if (!meta) throw new HttpError(404, 'No such thread.');
    return meta.cwd;
  }

  /**
   * The files a message carries, put in the folder its thread works in, and the words that say
   * where — appended to what was typed, so the agent and anyone reading the thread both see them.
   * Only your own uploads: an id is a content hash, and knowing one isn't having sent it.
   */
  function withFiles(body: Record<string, unknown>, text: string, cwd: string, person: string): string {
    if (body.files === undefined) return text;
    const entries = body.files;
    if (!Array.isArray(entries) || entries.length > MAX_FILES) throw new HttpError(400, `Attach up to ${MAX_FILES} files to a message.`);
    const placed = entries.map((entry: unknown) => {
      const { id, name } = (entry ?? {}) as { id?: unknown; name?: unknown };
      if (typeof id !== 'string' || !FILE_ID.test(id)) throw new HttpError(400, 'Each file needs the id its upload returned.');
      if (!polyphemus.store.uploadedBy(id, person)) throw new HttpError(404, 'That file isn’t one you attached: attach it again.');
      // Rooted at the project's folder when the thread works in one of its subfolders: that subfolder is its agents' to swap.
      const project = polyphemus.store.projectFor(cwd);
      return placeFile(polyphemus.home, id, typeof name === 'string' ? name : 'file', cwd, project && cwd.startsWith(`${project.path}/`) ? project.path : cwd);
    });
    return [text, attachedNote(placed)].filter(Boolean).join('\n\n');
  }

  /** The images a message carries: uploads, each an id or { id, name }, a few at most. */
  function imagesFrom(body: Record<string, unknown>, access: Access): ImageBlock[] {
    if (body.images === undefined) return [];
    const entries = body.images;
    if (!Array.isArray(entries) || entries.length > MAX_IMAGES) throw new HttpError(400, `Attach up to ${MAX_IMAGES} images to a message.`);
    return entries.map((entry: unknown) => {
      const { id, name } = typeof entry === 'string' ? { id: entry, name: undefined } : ((entry ?? {}) as { id?: unknown; name?: unknown });
      if (typeof id !== 'string') throw new HttpError(400, 'Each image needs the id its upload returned.');
      // Your own upload: knowing another person's image's name isn't having it.
      if (!access.owner && !polyphemus.store.uploadedBy(id, access.person.id)) throw new HttpError(400, 'That image isn’t here anymore: attach it again.');
      return uploadedImage(polyphemus.home, id, typeof name === 'string' && name ? clip(name, 120) : undefined);
    });
  }

  /** An image for a message, sent as its raw bytes. The reply names it for the message that carries it. */
  async function uploadImage(req: IncomingMessage, res: ServerResponse, device: DeviceMeta): Promise<void> {
    const access = new Access(polyphemus.store, requirePerson(device));
    // A viewer can't send anything, so there's nothing for them to attach an image to.
    if (!access.worksAnywhere) throw new HttpError(403, READ_ONLY);
    const bytes = await readBytes(req, MAX_IMAGE_BYTES, 'That image is over 5 MB.');
    const header = req.headers['x-file-name'];
    const name = typeof header === 'string' && header ? decodeURIComponent(header) : undefined;
    const image = saveImage(polyphemus.home, bytes, name);
    polyphemus.store.recordUpload(basename(image.path), access.person.id);
    return sendJson(res, 201, { id: basename(image.path), mediaType: image.mediaType });
  }

  /** Any other file for a message, sent as its raw bytes: kept until the message goes. */
  async function uploadFile(req: IncomingMessage, res: ServerResponse, device: DeviceMeta): Promise<void> {
    const access = new Access(polyphemus.store, requirePerson(device));
    if (!access.worksAnywhere) throw new HttpError(403, READ_ONLY);
    const bytes = await readBytes(req, MAX_FILE_BYTES, `That file is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    const header = req.headers['x-file-name'];
    const saved = saveUploadedFile(polyphemus.home, bytes, typeof header === 'string' && header ? decodeURIComponent(header) : undefined);
    polyphemus.store.recordUpload(saved.id, access.person.id);
    return sendJson(res, 201, saved);
  }

  /** A file into an agent's computer, from a phone or a laptop: it lands in its Downloads. The owner's. */
  async function uploadToComputer(req: IncomingMessage, res: ServerResponse, device: DeviceMeta, ref: string): Promise<void> {
    const access = new Access(polyphemus.store, requirePerson(device));
    const agent = agentNamed(ref);
    if (!agent || !access.owner) throw new HttpError(404, 'No such agent.');
    const bytes = await readBytes(req, MAX_FILE_BYTES, `That file is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
    const header = req.headers['x-file-name'];
    const home = polyphemus.desktops.homeDir(agent.id);
    const name = keepIn(home, join(home, 'Downloads'), typeof header === 'string' && header ? decodeURIComponent(header) : 'file', bytes);
    opts.log?.(`${access.person.name} put ${name} on ${agent.title}’s computer`);
    return sendJson(res, 201, { name, in: 'Downloads' });
  }

  /** An uploaded image. Its name is its content's hash, so it can be cached for good. */
  async function serveUpload(res: ServerResponse, id: string, device: DeviceMeta): Promise<void> {
    if (!UPLOAD_NAME.test(id)) throw new HttpError(404, 'No such image.');
    // Yours, or in a thread you can see. An image's name is its content's hash, so knowing the
    // name isn't the same as being allowed to see it.
    const access = new Access(polyphemus.store, requirePerson(device));
    const allowed = access.owner || polyphemus.store.uploadedBy(id, access.person.id) || polyphemus.store.sessionsWithImage(id).some((meta) => access.canSeeSession(meta));
    if (!allowed) throw new HttpError(404, 'No such image.');
    const content = await readFile(join(uploadsDir(polyphemus.home), id)).catch(() => {
      throw new HttpError(404, 'No such image.');
    });
    res.writeHead(200, { 'Content-Type': imageType(content) ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.end(content);
  }

  /**
   * An artifact, for someone who can see its thread. An HTML one is only ever served as its own
   * sandboxed document (`frame`): scripts may run, but in an opaque origin with no network, no
   * cookies and no way to reach polyphemus or navigate the app — an agent-written page is untrusted code.
   */
  async function serveArtifact(res: ServerResponse, id: string, device: DeviceMeta, how: 'file' | 'frame' | 'download'): Promise<void> {
    const artifact = ARTIFACT_ID.test(id) ? polyphemus.store.artifact(id) : undefined;
    const meta = artifact && polyphemus.store.get(artifact.sessionId);
    if (!artifact || !meta || !new Access(polyphemus.store, requirePerson(device)).canSeeSession(meta)) throw new HttpError(404, 'No such artifact.');
    const content = await readFile(artifactFile(polyphemus.home, artifact)).catch(() => {
      throw new HttpError(404, 'No such artifact.');
    });
    if (how === 'download') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${artifact.name.replace(/[^\w.-]+/g, '_')}"`, 'Cache-Control': 'private, no-store' });
      return void res.end(content);
    }
    if (artifact.kind === 'html') {
      if (how !== 'frame') throw new HttpError(404, 'No such artifact.');
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; frame-ancestors 'self'");
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.writeHead(200, { 'Content-Type': artifact.mediaType, 'Cache-Control': 'private, no-store' });
      return void res.end(content);
    }
    // An SVG is drawn as an image, where it can't run anything; this keeps it that way if opened on its own.
    if (artifact.kind === 'svg') res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    res.writeHead(200, { 'Content-Type': artifact.mediaType, 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.end(content);
  }

  /** The install's level, what each means, and what this computer can isolate with. */
  function isolationView(refresh = false) {
    const runtime = detectRuntime({ refresh });
    return {
      level: polyphemus.config.isolation.level,
      levels: ISOLATION_LEVELS.map((id) => ({ id, ...ISOLATION_WORDS[id] })),
      presets: Object.entries(NETWORK_PRESETS).map(([id, preset]) => ({ id, ...preset })),
      runtime: runtime ? { name: runtime.name, version: runtime.version, rootless: runtime.rootless } : null,
    };
  }

  function subjectName(subject: string): string {
    const [kind, ref = ''] = subject.split(/:(.*)/s);
    if (kind === 'agent') return rosterAgents().find((a) => a.id === ref || a.name === ref)?.title ?? ref;
    return polyphemus.store.personEver(ref)?.name ?? 'someone who’s gone';
  }

  function attendanceView(id: string) {
    return polyphemus.store.attendance(id).map((a) => ({ ...a, who: subjectName(a.subject), kind: a.subject.startsWith('agent:') ? 'agent' : 'person', byName: a.by?.startsWith('person:') ? subjectName(a.by) : null }));
  }

  /** Who came and went, for the agents: said in words, with when. */
  function attendanceLines(id: string): string[] {
    const meta = polyphemus.store.get(id);
    const when = (at: number) => new Date(at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return attendanceView(id)
      // Agents there from the start aren't news.
      .filter((a) => !(a.change === 'joined' && a.kind === 'agent' && a.at === meta?.createdAt))
      .slice(-8)
      .map((a) => `${when(a.at)}: ${attendanceWords(a)}`);
  }

  /**
   * A thread, whole. `light` leaves out the conversation itself (messages, turns, who wrote what):
   * what the app asks for to refresh the queue, the work or who's in it, which re-fetched megabytes
   * each time and failed over a phone's connection mid-conversation (2026-09-22).
   */
  function sessionDetail(id: string, access: Access, light = false) {
    const meta = polyphemus.store.get(id);
    if (!meta) throw new HttpError(404, 'No such session.');
    // Name only the people who can see this thread themselves.
    const slug = polyphemus.store.projectFor(meta.cwd)?.slug;
    const inThread = peopleWhoSee(meta);
    const entry = live.get(id);
    const members = threadMembers(id);
    return {
      // Its folder is for whoever works here; everyone else reads the thread, not the computer.
      meta: access.canWorkInSession(meta) ? meta : { ...meta, cwd: '' },
      project: slug ?? null,
      model: entry?.runtime.model ?? modelFor(polyphemus.config, meta.provider, meta.model),
      // Where its commands and file changes run: its project's level, or the install's.
      isolation: polyphemus.isolationFor(slug ? polyphemus.store.project(slug) : undefined),
      // From the thread itself, not one runtime's copy: more than one agent may have added to it.
      ...(!light && { messages: polyphemus.store.messages(id) }),
      running: entry?.running !== undefined,
      // Since when, on polyphemus's clock: the app counts from here, not from when you opened the thread.
      workingSince: entry?.running ? (entry.workingSince ?? null) : null,
      // Everyone working here: the thread's own turn, and any agent answering alongside it.
      working: workingIn(id),
      // Sent while it was working, waiting their turn: who sent each, and whether it's yours to take back.
      queued: polyphemus.store.queuedMessages(id).map((q) => ({
        id: q.id,
        by: polyphemus.store.person(q.personId)?.name ?? 'Someone',
        mine: q.personId === access.person.id,
        text: String(q.body.text ?? ''),
        attachments: (Array.isArray(q.body.images) ? q.body.images.length : 0) + (Array.isArray(q.body.files) ? q.body.files.length : 0),
        at: q.queuedAt,
      })),
      speaker: entry?.running ? (entry.runtime.agent?.id ?? null) : null,
      // Not open right now: what the thread was last set to.
      autoApprove: entry?.runtime.autoApprove ?? meta.yolo === true,
      asks: asksFirst((entry?.runtime.model ?? modelFor(polyphemus.config, meta.provider, meta.model)).provider),
      questions: pendingQuestions().filter((q) => q.sessionId === id),
      ...(!light && {
        turns: polyphemus.store.turns(id),
        times: polyphemus.store.messageTimes(id),
        // Who wrote each message and answered each question, with the names to show for them.
        actors: polyphemus.store.messageActors(id),
        answers: polyphemus.store.answers(id),
        reactions: polyphemus.store.reactions(id),
      }),
      people: inThread.map(({ id: personId, name, owner }) => ({ id: personId, name, owner })),
      canAct: access.canWorkInSession(meta),
      // Who's in it, and everyone who could be brought in.
      members: threadMembers(id).map(({ id: agentRef, name, title, mark }) => ({ id: agentRef, name, title, mark })),
      roster: rosterAgents().filter((agent) => access.canSeeAgent(agent) && fitsThread(agent, slug)).map(({ id: agentRef, name, title, mark }) => ({ id: agentRef, name, title, mark })),
      work: runs.detail(id),
      // Pictures a workflow took belong to their run step, not the conversation.
      artifacts: polyphemus.store.artifacts(id).filter((a) => a.by !== 'workflow'),
      lead: members.length > 1 ? (leadOf(id)?.id ?? null) : null,
      // Who came and went, with names to show: agents in the thread, people in its project.
      attendance: attendanceView(id),
      guard: { limit: meta.guardLimit ?? null, default: DEFAULT_GUARD },
      agentsAnswerAll: meta.agentsAnswerAll === true,
      spunFrom: meta.spunFrom ? { id: meta.spunFrom, title: polyphemus.store.get(meta.spunFrom)?.title ?? '(gone)', visible: polyphemus.store.get(meta.spunFrom) !== undefined && access.canSeeSession(polyphemus.store.get(meta.spunFrom)!) } : null,
      spinOuts: polyphemus.store.spinOuts(id).filter((child) => access.canSeeSession(child)).map((child) => ({ id: child.id, title: child.title, createdAt: child.createdAt, work: runs.summary(child.id) })),
    };
  }

  /**
   * Writes a value into the vault. The value is the argument and nothing else: not the log line,
   * not the reference that comes back.
   */
  function saveSecret(name: string, value: string, purpose: string, use: SecretUse | undefined, by: string): string {
    if (!SECRET_NAME.test(name)) throw new HttpError(400, `"${name}" isn’t a secret name. Use lowercase words separated by / . _ or -, like aws/site.`);
    if (!value) throw new HttpError(400, 'That secret is empty.');
    polyphemus.vault.set(name, value, { kind: 'other', ...(purpose && { note: purpose.slice(0, 200) }), ...(use && { use }) });
    opts.log?.(`${by} saved ${secretRef(name)}`);
    return secretRef(name);
  }

  /**
   * What a finished sign-in question came to. A browser sign-in for this thread's project is kept
   * there. The reason it's held back, when it is, is for the agent — never a cookie or a token.
   */
  function signInOutcome(stored: StoredQuestion, personId: string): { heldBack?: string } {
    const connection = polyphemus.connections.get(String(stored.detail.connection));
    if (!connection) throw new HttpError(404, 'That connection is gone.');
    if (stored.detail.how === 'oauth') {
      if (!polyphemus.connections.signedIn(connection.id)) throw new HttpError(400, `Sign in to ${connection.name} first, then say you’re done.`);
      return {};
    }
    const site = String(stored.detail.site ?? '');
    const signIn = polyphemus.connections.signIns(connection.id).find((s) => s.owner === personId && s.site === site);
    if (!signIn) throw new HttpError(400, `Sign in to ${site} and keep it, then say you’re done.`);
    const project = typeof stored.detail.project === 'string' ? stored.detail.project : '';
    if (project && !signIn.projects.includes(project)) {
      try {
        polyphemus.connections.setSignInProjects(signIn.id, [...signIn.projects, project]);
      } catch {
        // The browser isn't granted there. The sign-in stays, and the agent is told it isn't used here.
      }
    }
    const kept = polyphemus.connections.signIns(connection.id).find((s) => s.id === signIn.id) ?? signIn;
    const why = project ? polyphemus.connections.signInHeldBack(kept, project) : 'it isn’t kept for a project';
    return { ...(why && { heldBack: why }) };
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string, device: DeviceMeta): Promise<void> {
    const parts = path.split('/').filter(Boolean); // ['api', ...]
    const body = req.method === 'POST' ? await readJson(req) : {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const access = new Access(polyphemus.store, requirePerson(device));
    // Setup — sign-ins, keys, models, routing — is the install owner's: it's their credentials and
    // their plans (settled brief §7). Refused here, once, for every route under it.
    if (/^\/api\/(providers|catalogue|selected|models|routing)(\/|$)/.test(path) && !access.owner) throw new HttpError(403, OWNER_ONLY);
    /** A thread this person may see, or a 404 that doesn't say whether it exists. */
    const visibleSession = (id: string): SessionMeta => {
      const meta = polyphemus.store.get(id);
      if (!meta || !access.canSeeSession(meta)) throw new HttpError(404, NOT_FOUND);
      return meta;
    };
    const workableSession = (id: string): SessionMeta => {
      const meta = visibleSession(id);
      if (!access.canWorkInSession(meta)) throw new HttpError(403, READ_ONLY);
      return meta;
    };

    if (req.method === 'GET' && path === '/api/state') return sendJson(res, 200, state(device));
    if (req.method === 'GET' && path === '/api/events') return events(req, res, device);

    if (req.method === 'POST' && path === '/api/push/subscribe') {
      if (!opts.push) throw new HttpError(503, 'Notifications aren’t set up on this daemon.');
      polyphemus.store.savePushSubscription(device.id, pushSubscription(body.subscription));
      opts.log?.(`Notifications on: ${device.name} (${device.id})`);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/push/problem') {
      // Phones can't show you a console, so the reason lands in the daemon's log instead.
      opts.log?.(`Notifications failed on ${device.name} (${device.id}): ${clip(String(body.message ?? ''), 300)} [${clip(String(body.userAgent ?? ''), 160)}]`);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/push/test') {
      const delivered = await deliver({ title: 'polyphemus', body: 'Test notification: this is how polyphemus will reach you.', url: '/', tag: 'test' }, { device: device.id });
      if (!delivered) opts.log?.(`Test notification for ${device.name} (${device.id}) wasn't accepted by the push service`);
      return sendJson(res, 200, { ok: true, delivered });
    }
    // Sign out another device from the app: the owner, any device; anyone else, only their own. Not
    // the one you're on — that would leave you locked out mid-tap.
    const revoking = /^\/api\/devices\/([\w-]+)\/revoke$/.exec(path);
    if (req.method === 'POST' && revoking) {
      const target = polyphemus.store.listDevices().find((d) => d.id === revoking[1] && !d.revokedAt);
      if (!target || !(access.owner || target.personId === access.person.id)) throw new HttpError(404, 'No such device.');
      if (target.id === device?.id) throw new HttpError(400, 'That’s the device you’re using. Sign it out from another one, or from your computer: poly devices revoke.');
      polyphemus.store.revokeDevice(target.id);
      dropRevokedStreams();
      opts.log?.(`${access.person.name} signed out device ${target.id} (${target.name})`);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/push/settings') {
      if (!Array.isArray(body.kinds)) throw new HttpError(400, 'Send the kinds of notifications you want.');
      const wanted = body.kinds as unknown[];
      const kinds = PUSH_KINDS.filter((kind) => wanted.includes(kind));
      polyphemus.store.setPushKinds(device.id, kinds);
      return sendJson(res, 200, { kinds });
    }
    if (req.method === 'POST' && path === '/api/push/unsubscribe') {
      polyphemus.store.removeDevicePush(device.id);
      opts.log?.(`Notifications off: ${device.name} (${device.id})`);
      return sendJson(res, 200, { ok: true });
    }

    if (await connectionApi.handle(req, res, parts, body, access, sendJson)) return;

    // One routine: its file to read and edit, pausing and resuming, and removing it. A project's routines
    // are for the people who work in it; the install's own (~/.polyphemus/routines) are the owner's.
    if (parts[1] === 'routines' && parts[2] && (parts.length === 3 || (parts.length === 4 && (parts[3] === 'pause' || parts[3] === 'remove' || parts[3] === 'accept' || parts[3] === 'settings')))) {
      const id = decodeURIComponent(parts[2]);
      const routine = scheduler.list().routines.find((r) => r.id === id);
      if (!routine || !(routine.project ? access.canSeeProject(routine.project) : access.owner)) throw new HttpError(404, 'No such routine.');
      const canChange = routine.project ? access.canWorkInProject(routine.project) : access.owner;
      if (req.method === 'GET' && parts.length === 3) {
        // The text is the one that was parsed, and its digest is what Accept must name: what you read is what runs.
        return sendJson(res, 200, { routine: { id: routine.id, name: routine.name, project: routine.project ?? null, mode: routine.mode, notify: routine.notify, prompt: routine.prompt, file: routine.file, text: routine.source ?? '', digest: routine.digest ?? null, waiting: waitingRoutine(routine), asks: routineAsks(routine), canChange } });
      }
      if (!canChange) throw new HttpError(403, READ_ONLY);
      // A project's routine that's new or changed since a person last said yes: accepting is what lets it run.
      if (req.method === 'POST' && parts[3] === 'accept') {
        if (routine.mode === 'yolo' && !access.owner) throw new HttpError(403, 'It runs without asking, so only the owner of this install can accept it.');
        if (!routine.digest) return sendJson(res, 200, { accepted: routine.id });
        // Accepting is of the version that was read: if the file changed since, read it again (independent review, 2026-09-19).
        if (body.digest !== routine.digest) throw new HttpError(409, `${routine.name} changed since you opened it. Read it again before accepting it.`);
        polyphemus.store.updateRoutineState(routine.id, { acceptedDigest: routine.digest });
        opts.log?.(`Routine ${routine.id} accepted by ${access.person.name}`);
        return sendJson(res, 200, { accepted: routine.id });
      }
      // What it asks before doing, and whether a clean run says so: a person's decisions, made here
      // rather than by editing the file's settings by hand (2026-09-20).
      if (req.method === 'POST' && parts[3] === 'settings' && parts.length === 4) {
        const mode = body.mode === undefined ? undefined : String(body.mode);
        if (mode !== undefined && !['ask', 'read-only', 'yolo'].includes(mode)) throw new HttpError(400, 'A routine asks first, only reads, or runs without asking.');
        // Running without asking is the owner's call, as it is everywhere else.
        if (mode === 'yolo' && routine.mode !== 'yolo' && !access.owner) throw new HttpError(403, 'Only the owner of this install can make a routine run without asking.');
        const tellMe = body.notify === undefined ? undefined : body.notify === true;
        const notify: Routine['notify'] | undefined = tellMe === undefined ? undefined : tellMe ? ['finish', 'failure'] : ['failure'];
        if (mode === undefined && notify === undefined) throw new HttpError(400, 'Say what to change.');
        const text = withRoutineSettings(routine.source ?? readFileSync(routine.file, 'utf8'), { ...(mode && { mode: mode as Routine['mode'] }), ...(notify && { notify }) });
        // Checked as it's written, the way a person's own edit is.
        const project = routine.project ? polyphemus.store.project(routine.project) : undefined;
        try {
          parseRoutine(text, routine.file, project ? { project } : { findProject: (slug) => polyphemus.store.project(slug) });
        } catch (err) {
          throw new HttpError(400, (err as Error).message.replace(`${routine.file}: `, ''));
        }
        writeRoutineFile(routine, text);
        // Changed by a person is accepted by them: it doesn't go back to waiting for their own edit.
        polyphemus.store.updateRoutineState(routine.id, { acceptedDigest: routineDigest(text) });
        opts.log?.(`Routine ${routine.id} set to ${mode ?? routine.mode}${notify ? `, telling you when it ${tellMe ? 'finishes' : 'fails'}` : ''} by ${access.person.name}`);
        return sendJson(res, 200, { ok: true, mode: mode ?? routine.mode, notify: notify ?? routine.notify });
      }
      if (req.method === 'POST' && parts[3] === 'pause') {
        const paused = body.paused !== false;
        polyphemus.store.updateRoutineState(routine.id, paused ? { paused: true, pausedReason: `paused by ${access.person.name}` } : { paused: false, pausedReason: undefined, failures: 0 });
        opts.log?.(`Routine ${routine.id} ${paused ? 'paused' : 'resumed'} by ${access.person.name}`);
        return sendJson(res, 200, { paused });
      }
      if (req.method === 'POST' && parts.length === 3) {
        const text = typeof body.text === 'string' ? body.text : '';
        const project = routine.project ? polyphemus.store.project(routine.project) : undefined;
        let parsed;
        try {
          parsed = parseRoutine(text, routine.file, project ? { project } : { findProject: (slug) => polyphemus.store.project(slug) });
        } catch (err) {
          throw new HttpError(400, (err as Error).message.replace(`${routine.file}: `, ''));
        }
        if (parsed.id !== routine.id) throw new HttpError(400, 'Keep its name: a routine with another name is a different routine.');
        // Running without asking is the owner's call, as it is everywhere else — including a yolo file
        // an agent wrote that nobody has accepted yet.
        if (parsed.mode === 'yolo' && (routine.mode !== 'yolo' || waitingRoutine(routine)) && !access.owner) throw new HttpError(403, 'Only the owner of this install can make a routine run without asking.');
        const saved = text.endsWith('\n') ? text : `${text}\n`;
        writeRoutineFile(routine, saved);
        // Saved by a person is accepted by them: this is the version that runs.
        if (routine.project) polyphemus.store.updateRoutineState(routine.id, { acceptedDigest: routineDigest(saved) });
        opts.log?.(`Routine ${routine.id} edited by ${access.person.name}`);
        return sendJson(res, 200, { ok: true });
      }
      // A POST, like every other change, so the same-origin check covers it.
      if (req.method === 'POST' && parts[3] === 'remove') {
        // A project's routine is removed from the project's folder, through no link.
        const project = routine.project ? polyphemus.store.project(routine.project) : undefined;
        if (project) removeInside(project.path, routine.file);
        else rmSync(routine.file, { force: true });
        opts.log?.(`Routine ${routine.id} removed by ${access.person.name}`);
        return sendJson(res, 200, { removed: routine.id });
      }
    }

    // Run a routine now (it still goes through its checks). Ids contain a slash, so they arrive encoded.
    if (req.method === 'POST' && parts[1] === 'routines' && parts[2] && parts[3] === 'run' && parts.length === 4) {
      const id = decodeURIComponent(parts[2]);
      const routine = scheduler.list().routines.find((r) => r.id === id);
      if (routine && !(routine.project ? access.canSeeProject(routine.project) : access.owner)) throw new HttpError(404, 'No such routine.');
      if (routine && !(routine.project ? access.canWorkInProject(routine.project) : access.owner)) throw new HttpError(403, READ_ONLY);
      const fired = scheduler.runNow(id);
      if (fired === undefined && !scheduler.list().routines.some((r) => r.id === id)) throw new HttpError(404, 'No such routine.');
      return sendJson(res, 200, { fire: fired ?? null });
    }

    // ── Providers, models and signing in ────────────────────────────────
    // A phone-only person couldn't get a model at all before this: `poly models add` and
    // `poly login` were terminal-only and there was no endpoint behind them.

    // Who else uses this install, and what they can reach: the owner's, from the app as well as the
    // terminal, because a phone-only owner couldn't invite anyone at all.
    if (parts[1] === 'people' && (parts.length === 2 || parts.length === 3 || parts.length === 4)) {
      if (!access.owner) throw new HttpError(403, OWNER_ONLY);
      if (req.method === 'POST' && parts.length === 2) {
        const name = String(body.name ?? '').trim();
        if (!name) throw new HttpError(400, 'What are they called?');
        if (polyphemus.store.people().some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `${name} is already here.`);
        const person = polyphemus.store.addPerson(name);
        opts.log?.(`Added ${person.name} (${person.id})`);
        // A code straight away: an invitation nobody can use isn't one.
        return sendJson(res, 201, { person, code: polyphemus.store.createPairingCode(undefined, person.id), url: httpsUrl ?? opts.httpsUrl ?? null });
      }
      const person = parts[2] ? polyphemus.store.person(decodeURIComponent(parts[2])) : undefined;
      if (!person) throw new HttpError(404, 'No such person.');
      if (req.method === 'POST' && parts[3] === 'pair') {
        return sendJson(res, 200, { code: polyphemus.store.createPairingCode(undefined, person.id), url: httpsUrl ?? opts.httpsUrl ?? null });
      }
      if (req.method === 'POST' && parts[3] === 'remove') {
        if (person.owner) throw new HttpError(400, 'The owner of this install can’t be removed: it’s whose computer this is.');
        polyphemus.store.removePerson(person.id);
        dropRevokedStreams();
        opts.log?.(`Removed ${person.name}: their devices are cut off and their project roles are gone`);
        broadcast({ type: 'people_changed' });
        return sendJson(res, 200, { removed: person.id });
      }
      throw new HttpError(404, NOT_FOUND);
    }

    if (req.method === 'GET' && path === '/api/providers') {
      await discover();
      return sendJson(res, 200, { providers: vendorList() });
    }

    // Sign in to a vendor CLI. Polyphemus starts its own login and watches: the flow finishes in a
    // browser on this machine, so it can never complete it for you — what it can do is show you
    // the URL or code the CLI prints, and then confirm by asking the CLI again.
    if (req.method === 'POST' && parts[1] === 'providers' && parts[2] && parts[3] === 'signin' && parts.length === 4) {
      const id = decodeURIComponent(parts[2]);
      const providerConfig = polyphemus.config.providers[id];
      if (!providerConfig) throw new HttpError(404, `No provider called "${id}".`);
      if (!isCliAdapter(providerConfig.adapter)) throw new HttpError(400, `${id} signs in with an API key, not a CLI.`);
      if (signingIn.has(id)) throw new HttpError(409, 'That sign-in is already running.');
      const started = startCliLogin(providerConfig.adapter, (line) => broadcast({ type: 'signin', provider: id, line }));
      if (!started) throw new HttpError(400, `Polyphemus doesn't know how to sign ${id} in.`);
      signingIn.set(id, started);
      void started.done.then(async () => {
        signingIn.delete(id);
        discovered = { at: 0, states: {} };
        await discover();
        polyphemus.registry.forget(id);
        const state = discovered.states[providerConfig.adapter];
        opts.log?.(`${id} sign-in finished: ${state?.signedIn ? `signed in${state.account ? ` as ${state.account}` : ''}` : 'not signed in'}`);
        // Signed in: whatever paused it for a rejected login is over now, not at the end of its wait.
        if (state?.signedIn) polyphemus.breakers.clear(id);
        broadcast({ type: 'signin_done', provider: id, signedIn: state?.signedIn ?? false, account: state?.account ?? null });
      });
      return sendJson(res, 202, { started: true, command: cliLoginCommand(providerConfig.adapter) ?? null });
    }

    // Install a vendor CLI, on the owner's word: the vendor's own installer into their home folder, or
    // npm into Polyphemus's own (discover.ts). The command is shown before it runs and streamed as it
    // does. A catalogue CLI that isn't set up yet can be installed too: that's how setup starts.
    if (req.method === 'POST' && parts[1] === 'providers' && parts[2] && parts[3] === 'install' && parts.length === 4) {
      const id = decodeURIComponent(parts[2]);
      const adapter = polyphemus.config.providers[id]?.adapter ?? catalogueEntry(id)?.adapter;
      if (!adapter || !isCliAdapter(adapter)) throw new HttpError(404, `No CLI called "${id}" to install.`);
      if (installing.has(id)) throw new HttpError(409, 'That install is already running.');
      const started = startCliInstall(adapter, (line) => broadcast({ type: 'install', provider: id, line }));
      if (!started) throw new HttpError(400, `Polyphemus doesn't know how to install ${id}.`);
      installing.set(id, started);
      void started.done.then(async () => {
        installing.delete(id);
        discovered = { at: 0, states: {} };
        await discover();
        polyphemus.registry.forget(id);
        const state = discovered.states[adapter];
        opts.log?.(`${id} install finished: ${state?.installed ? 'installed' : 'not installed'}`);
        broadcast({ type: 'install_done', provider: id, installed: state?.installed ?? false });
      });
      return sendJson(res, 202, { started: true, command: cliInstallCommand(adapter) ?? null });
    }

    if (req.method === 'DELETE' && parts[1] === 'providers' && parts[2] && parts[3] === 'signin' && parts.length === 4) {
      const id = decodeURIComponent(parts[2]);
      signingIn.get(id)?.cancel();
      signingIn.delete(id);
      return sendJson(res, 200, { stopped: true });
    }

    // Everything polyphemus knows how to connect to, and what's already set up.
    if (req.method === 'GET' && path === '/api/catalogue') {
      await discover();
      const configured = new Set(Object.keys(polyphemus.config.providers));
      return sendJson(res, 200, {
        catalogue: CATALOGUE.map((entry) => {
          const found = discovered.states[entry.adapter];
          return {
            ...entry,
            configured: configured.has(entry.id),
            offered: configured.has(entry.id) && polyphemus.status(entry.id).offered === true,
            ...(found ? { installed: found.installed, signedIn: found.signedIn ?? null, account: found.account ?? null, sandbox: found.sandbox ?? null, onWindows: found.onWindows === true } : {}),
            install: entry.connect === 'cli' ? (cliInstallCommand(entry.adapter) ?? null) : null,
          };
        }),
        more: MORE_PROVIDERS,
      });
    }

    // Add a connection from the catalogue: polyphemus writes the config block so nobody has to
    // hand-edit TOML. The key comes after, through the same endpoint as any other provider.
    if (req.method === 'POST' && path === '/api/providers') {
      const id = String(body.id ?? '').trim();
      const entry = catalogueEntry(id);
      if (!entry) throw new HttpError(400, `Polyphemus doesn't know how to set up "${id}" yet.`);
      if (polyphemus.config.providers[id]) throw new HttpError(409, `${entry.name} is already set up.`);
      const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
      if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new HttpError(400, 'A server URL starts with http:// or https://.');
      if (!baseUrl && !entry.baseUrl && entry.adapter === 'openai-chat') {
        throw new HttpError(400, `${entry.name} needs its server URL — polyphemus doesn't have a reliable one for it.`);
      }
      const history = new ConfigHistory(polyphemus.home, polyphemus.store, `app:${device.name}`);
      history.apply(history.plan(`providers.${id}`, providerBlock(entry, { baseUrl })).after, `added provider ${id}`);
      polyphemus.reloadConfig();
      // Adding one yourself is saying yes to it.
      polyphemus.accept(id, `app:${device.name}`);
      polyphemus.registry.forget(id);
      opts.log?.(`Added provider ${id} (${entry.name})`);
      return sendJson(res, 201, { id, providers: vendorList() });
    }

    // Test a connection: ask the CLI again who's signed in, then send one real question through it,
    // on a model you've chosen there if there is one.
    if (req.method === 'POST' && parts[1] === 'providers' && parts[2] && parts[3] === 'test' && parts.length === 4) {
      const id = decodeURIComponent(parts[2]);
      const providerConfig = polyphemus.config.providers[id];
      if (!providerConfig) throw new HttpError(404, `No provider called "${id}".`);
      discovered = { at: 0, states: {} };
      await discover();
      polyphemus.registry.forget(id);
      const chosen = polyphemus.config.selected.find((ref) => ref.startsWith(`${id}:`));
      let modelId = chosen?.slice(id.length + 1) ?? (providerConfig.auth.type === 'cli' ? 'default' : undefined);
      if (!modelId) {
        try {
          modelId = (await polyphemus.registry.get(id).listModels())[0]?.id;
        } catch (err) {
          return sendJson(res, 200, { test: { ok: false, said: (err as Error).message, usage: null, ms: 0 }, providers: vendorList() });
        }
      }
      if (!modelId) throw new HttpError(400, `${id} didn’t list any models to test with.`);
      const test = await testModel(polyphemus, { label: `${id}:${modelId}`, provider: id, model: modelId });
      opts.log?.(`Tested ${id}: ${test.ok ? 'ok' : test.said}`);
      return sendJson(res, 200, { test, model: modelId, providers: vendorList() });
    }

    // What a provider actually offers, asked of the provider itself. Needs its key.
    if (req.method === 'GET' && parts[1] === 'providers' && parts[2] && parts[3] === 'models' && parts.length === 4) {
      const id = decodeURIComponent(parts[2]);
      if (!polyphemus.config.providers[id]) throw new HttpError(404, `No provider called "${id}".`);
      try {
        const models = (await polyphemus.registry.get(id).listModels()).sort();
        return sendJson(res, 200, { models });
      } catch (err) {
        // Not a 500: being signed out or offline is an answer, and the app says so.
        return sendJson(res, 200, { models: [], problem: (err as Error).message });
      }
    }

    if (parts[1] === 'providers' && parts[2] && parts[3] === 'key' && parts.length === 4) {
      const id = decodeURIComponent(parts[2]);
      const providerConfig = polyphemus.config.providers[id];
      if (!providerConfig) throw new HttpError(404, `No provider called "${id}".`);
      if (providerConfig.auth.type !== 'api_key') throw new HttpError(400, `${id} signs in through its own CLI, so there's no key to save.`);
      if (req.method === 'DELETE') {
        polyphemus.credentials.deleteApiKey(id);
        polyphemus.registry.forget(id);
        opts.log?.(`Signed out of ${id}.`);
        return sendJson(res, 200, { providers: vendorList() });
      }
      if (req.method === 'POST') {
        const key = typeof body.key === 'string' ? body.key.trim() : '';
        if (!key) throw new HttpError(400, 'Paste the API key.');
        polyphemus.credentials.setApiKey(id, key);
        // Giving it a key is saying yes to it.
        polyphemus.accept(id, `app:${device.name}`);
        polyphemus.registry.forget(id);
        try {
          const models = (await polyphemus.registry.get(id).listModels()).sort();
          opts.log?.(`Signed in to ${id}: ${models.length} models.`);
          return sendJson(res, 200, { providers: vendorList(), models });
        } catch (err) {
          const message = (err as Error).message;
          // A rejected key is worse than none: it would make the provider look ready. Only a key
          // that failed for some other reason (offline, say) is worth keeping.
          if (classifyError(message) === 'auth') {
            polyphemus.credentials.deleteApiKey(id);
            polyphemus.registry.forget(id);
            throw new HttpError(400, `${id} rejected that key, so it wasn't saved: ${message}`);
          }
          return sendJson(res, 200, { providers: vendorList(), models: [], problem: `Saved, but the test request failed: ${message}` });
        }
      }
    }

    // The models you've chosen. Ticking one is the whole interaction — no name to invent, and
    // "provider then model" is how you narrow it down (Alex's spec, 2026-09-12).
    if (req.method === 'POST' && path === '/api/selected') {
      const refs = Array.isArray(body.selected) ? body.selected.map(String) : undefined;
      if (!refs) throw new HttpError(400, 'Send the models you want as a list of provider:model-id.');
      for (const ref of refs) {
        const at = ref.indexOf(':');
        if (at <= 0 || at === ref.length - 1) throw new HttpError(400, `"${ref}" must be provider:model-id.`);
        if (!polyphemus.config.providers[ref.slice(0, at)]) throw new HttpError(400, `No provider called "${ref.slice(0, at)}".`);
      }
      const unique = [...new Set(refs)];
      // Choosing a model is saying yes to the provider it runs on.
      for (const provider of new Set(unique.map((ref) => ref.slice(0, ref.indexOf(':'))))) polyphemus.accept(provider, `app:${device.name}`);
      const history = new ConfigHistory(polyphemus.home, polyphemus.store, `app:${device.name}`);
      history.apply(history.plan('selected', unique).after, `chose ${unique.length} model${unique.length === 1 ? '' : 's'}`);
      polyphemus.reloadConfig();
      // Nobody should be left with a roster and nothing to run it on.
      if (!polyphemus.config.defaultModel && unique[0]) polyphemus.rememberDefault(resolveModel(polyphemus.config, unique[0]));
      opts.log?.(`Models chosen: ${unique.join(', ') || '(none)'}`);
      return sendJson(res, 200, { selected: polyphemus.config.selected, defaultModel: polyphemus.config.defaultModel ?? null });
    }

    // Naming a model is a config change like any other: validated, recorded, undoable.
    if (req.method === 'POST' && path === '/api/models' ) {
      const label = String(body.label ?? '').trim();
      const provider = String(body.provider ?? '').trim();
      const model = String(body.model ?? '').trim();
      if (!label || !provider || !model) throw new HttpError(400, 'A model needs a name, a provider and a model id.');
      if (!/^[a-z0-9][a-z0-9.-]*$/i.test(label)) throw new HttpError(400, 'Use letters, numbers, dashes and dots for the name.');
      if (!polyphemus.config.providers[provider]) throw new HttpError(400, `No provider called "${provider}".`);
      const effort = typeof body.effort === 'string' && body.effort ? body.effort : undefined;
      if (effort && !EFFORTS.includes(effort as Effort)) throw new HttpError(400, `Effort must be one of: ${EFFORTS.join(', ')}.`);
      const history = new ConfigHistory(polyphemus.home, polyphemus.store, `app:${device.name}`);
      history.apply(history.plan(`models.${label}`, { provider, model, ...(effort ? { effort } : {}) }).after, `added model ${label} = ${provider}:${model}`);
      polyphemus.reloadConfig();
      polyphemus.accept(provider, `app:${device.name}`);
      // The first model you name is the one everything else inherits, so nobody is left with a
      // roster and nothing to run it on.
      if (!polyphemus.config.defaultModel) polyphemus.rememberDefault(resolveModel(polyphemus.config, label));
      opts.log?.(`Added model ${label} → ${provider}:${model}`);
      return sendJson(res, 201, { label, defaultModel: polyphemus.config.defaultModel ?? null });
    }

    // Say yes to a provider polyphemus offers: from then on it runs, and its models can be picked.
    if (req.method === 'POST' && parts[1] === 'providers' && parts[2] && parts[3] === 'accept' && parts.length === 4) {
      const id = decodeURIComponent(parts[2]);
      if (!polyphemus.config.providers[id]) throw new HttpError(404, `No provider called "${id}".`);
      if (polyphemus.accept(id, `app:${device.name}`)) opts.log?.(`Accepted provider ${id}`);
      polyphemus.registry.forget(id);
      return sendJson(res, 200, { accepted: id, providers: vendorList() });
    }

    // Codex without its sandbox, on a computer where the sandbox can't start. The owner's call, said plainly.
    if (req.method === 'POST' && parts[1] === 'providers' && parts[2] && parts[3] === 'sandbox' && parts.length === 4) {
      const id = decodeURIComponent(parts[2]);
      const providerConfig = polyphemus.config.providers[id];
      if (!providerConfig) throw new HttpError(404, `No provider called "${id}".`);
      if (providerConfig.adapter !== 'codex-cli') throw new HttpError(400, 'Only Codex has a sandbox to turn off.');
      const on = body.on !== false;
      const history = new ConfigHistory(polyphemus.home, polyphemus.store, `app:${device.name}`);
      // On is the default, so turning it back on removes the setting rather than writing true.
      const plan = on ? (providerConfig.sandbox === false ? history.plan(`providers.${id}.sandbox`, undefined) : undefined) : history.plan(`providers.${id}.sandbox`, false);
      if (plan) history.apply(plan.after, on ? `turned ${id}'s sandbox back on` : `turned ${id}'s sandbox off`);
      polyphemus.reloadConfig();
      polyphemus.registry.forget(id);
      polyphemus.sandboxNoted.clear();
      opts.log?.(on ? `${id} runs in its sandbox again` : `${id} runs without its sandbox, as the owner set`);
      return sendJson(res, 200, { sandbox: on, providers: vendorList() });
    }

    if (req.method === 'DELETE' && parts[1] === 'providers' && parts[2] && parts.length === 3) {
      const id = decodeURIComponent(parts[2]);
      if (!polyphemus.config.providers[id]) throw new HttpError(404, `No provider called "${id}".`);
      const named = [
        ...polyphemus.config.selected.filter((ref) => ref.startsWith(`${id}:`)).map((ref) => ref.slice(id.length + 1)),
        ...Object.entries(polyphemus.config.models).filter(([, m]) => m.provider === id).map(([label]) => label),
      ];
      if (named.length) throw new HttpError(400, `Remove the models that use it first: ${named.join(', ')}.`);
      const history = new ConfigHistory(polyphemus.home, polyphemus.store, `app:${device.name}`);
      history.apply(history.plan(`providers.${id}`, undefined).after, `removed provider ${id}`);
      if (polyphemus.config.accepted?.includes(id)) history.apply(history.plan('accepted', polyphemus.config.accepted.filter((p) => p !== id)).after, `stopped using provider ${id}`);
      polyphemus.credentials.deleteApiKey(id);
      polyphemus.reloadConfig();
      polyphemus.registry.forget(id);
      opts.log?.(`Removed provider ${id}`);
      return sendJson(res, 200, { removed: id, providers: vendorList() });
    }

    // Where agents' commands and file changes run, for the whole install (docs/design/isolation.md).
    if (req.method === 'POST' && path === '/api/isolation') {
      if (!access.owner) throw new HttpError(403, OWNER_ONLY);
      if (!isIsolationLevel(body.level)) throw new HttpError(400, 'Pick isolated, isolated-open or host.');
      const history = new ConfigHistory(polyphemus.home, polyphemus.store, `app:${device.name}`);
      history.apply(history.plan('isolation.level', body.level).after, `set isolation.level = ${body.level}`);
      polyphemus.reloadConfig();
      polyphemus.hostNoted.clear();
      opts.log?.(`Agents now run: ${ISOLATION_WORDS[body.level].title}`);
      return sendJson(res, 200, { isolation: isolationView(true) });
    }

    // What everything inherits: the default model, and where a turn goes when it can't take it.
    if (req.method === 'POST' && path === '/api/routing') {
      const history = new ConfigHistory(polyphemus.home, polyphemus.store, `app:${device.name}`);
      if (body.defaultModel !== undefined) {
        const label = String(body.defaultModel);
        polyphemus.rememberDefault(listedModel(label)); // fails now rather than at the first turn
      }
      if (body.fallback !== undefined) {
        if (!Array.isArray(body.fallback)) throw new HttpError(400, 'A fallback list is a list of model names.');
        const chain = body.fallback.map(String).filter(Boolean);
        for (const ref of chain) resolveModel(polyphemus.config, ref);
        history.apply(history.plan('routing.fallback', chain).after, `set routing.fallback = [${chain.join(', ')}]`);
        polyphemus.reloadConfig();
      }
      if (body.allowMetered !== undefined) {
        const on = body.allowMetered === true;
        history.apply(history.plan('routing.allow_metered', on).after, `set routing.allow_metered = ${on}`);
        polyphemus.reloadConfig();
      }
      if (body.quotaRetryMinutes !== undefined) {
        const minutes = Number(body.quotaRetryMinutes);
        if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) throw new HttpError(400, 'Wait a whole number of minutes, from 5 to 1440.');
        history.apply(history.plan('routing.quota_retry_minutes', minutes).after, `set routing.quota_retry_minutes = ${minutes}`);
        polyphemus.reloadConfig();
      }
      if (body.onFallback !== undefined) {
        const policy = String(body.onFallback);
        if (!['ask', 'continue', 'pause'].includes(policy)) throw new HttpError(400, 'on_fallback is ask, continue or pause.');
        history.apply(history.plan('routing.on_fallback', policy).after, `set routing.on_fallback = ${policy}`);
        polyphemus.reloadConfig();
      }
      return sendJson(res, 200, {
        defaultModel: polyphemus.config.defaultModel ?? null,
        fallback: polyphemus.config.routing.fallback,
        onFallback: polyphemus.config.routing.onFallback,
        allowMetered: polyphemus.config.routing.allowMetered,
        quotaRetryMinutes: polyphemus.config.routing.quotaRetryMinutes,
      });
    }

    // Test one model for real, because someone pressed Test. It says what it cost.
    if (req.method === 'POST' && path === '/api/models/test') {
      const model = modelRef(polyphemus.config, String(body.ref ?? ''));
      const test = await testModel(polyphemus, model);
      opts.log?.(`Tested ${model.provider}:${model.model}: ${test.ok ? 'ok' : test.said}`);
      return sendJson(res, 200, { test });
    }

    // Move a model to another way in, everywhere it's named.
    if (req.method === 'POST' && path === '/api/models/move') {
      const moved = moveModel(polyphemus, String(body.ref ?? ''), String(body.connection ?? ''), `app:${device.name}`);
      opts.log?.(`Moved ${String(body.ref)} to ${moved.to}`);
      return sendJson(res, 200, moved);
    }

    if (req.method === 'POST' && path === '/api/models/remove') {
      const removed = removeModel(polyphemus, String(body.ref ?? ''), `app:${device.name}`);
      opts.log?.(`Removed model ${String(body.ref)}`);
      return sendJson(res, 200, removed);
    }

    if (parts[1] === 'models' && parts[2] && parts.length === 3) {
      const label = decodeURIComponent(parts[2]);
      if (!polyphemus.config.models[label]) throw new HttpError(404, `There's no model called "${label}".`);
      const history = new ConfigHistory(polyphemus.home, polyphemus.store, `app:${device.name}`);
      if (req.method === 'DELETE') {
        if (polyphemus.config.defaultModel === label) throw new HttpError(400, `${label} is the default. Make something else the default first.`);
        history.apply(history.plan(`models.${label}`, undefined).after, `removed model ${label}`);
        polyphemus.reloadConfig();
        opts.log?.(`Removed model ${label}`);
        return sendJson(res, 200, { removed: label });
      }
      // Make it the default for everything that doesn't name one.
      if (req.method === 'POST' && body.default === true) {
        polyphemus.rememberDefault(resolveModel(polyphemus.config, label));
        opts.log?.(`Default model is now ${label}`);
        return sendJson(res, 200, { defaultModel: label });
      }
      // Point an existing name at a different model. A vendor CLI takes a model id too — letting
      // it choose is one option, not the only one.
      if (req.method === 'POST' && typeof body.model === 'string' && body.model.trim()) {
        const model = body.model.trim();
        // Set the whole entry, not `models.<label>.model`: a model added from the app is written
        // as an inline table, and config edits can't reach inside one field by field.
        const current = polyphemus.config.models[label]!;
        history.apply(history.plan(`models.${label}`, { ...current, model }).after, `set models.${label}.model = ${model}`);
        polyphemus.reloadConfig();
        opts.log?.(`${label} now uses ${model}`);
        return sendJson(res, 200, { label, model });
      }
    }

    if (req.method === 'POST' && path === '/api/projects') {
      if (!access.owner) throw new HttpError(403, OWNER_ONLY);
      const from = typeof body.from === 'string' && body.from.trim() ? body.from.trim() : undefined;
      const about = typeof body.about === 'string' ? body.about : undefined;
      // A private GitHub repository: the service has no GitHub sign-in of yours, so it's read as one of
      // polyphemus's own identities that's installed on it.
      const repo = from ? parseGitHubRemote(from) : undefined;
      const identity = repo ? polyphemus.connections.githubIdentityForRepo(repo) : undefined;
      const clone = repo && identity ? { url: repoRemote(repo), env: identityGitEnv((await polyphemus.connections.githubToken(identity.connection)).token) } : undefined;
      let project;
      try {
        ({ project } = await createProject(polyphemus.store, polyphemus.home, polyphemus.config.projectsRoot, { name: String(body.name ?? ''), about, from, git: body.git === true, ...(clone && { clone }) }));
      } catch (err) {
        if (repo && !identity && /Authentication failed|could not read Username|terminal prompts disabled|not found/i.test((err as Error).message)) {
          throw new HttpError(400, `Couldn’t clone ${repo}: it looks private, and none of your GitHub identities is installed on it. Install one on it (Connections → the identity → Change which repositories it’s on), then try again.`);
        }
        throw err;
      }
      opts.log?.(`New project: ${project.name} (${project.path})`);
      return sendJson(res, 201, { project });
    }

    if (parts[1] === 'projects' && parts[2]) {
      const project = polyphemus.store.project(parts[2]);
      if (!project || !access.canSeeProject(project.slug)) throw new HttpError(404, 'No such project.');
      if (req.method === 'POST' && !access.canWorkInProject(project.slug)) throw new HttpError(403, READ_ONLY);
      // An agent reads what's there and drafts AGENTS.md and notes into the inbox for review.
      // The name everywhere. The slug, the folder, and the address stay. The owner's call.
      if (req.method === 'POST' && parts[3] === 'name' && parts.length === 4) {
        if (!access.owner) throw new HttpError(403, OWNER_ONLY);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) throw new HttpError(400, 'Give the project a name.');
        if (name.length > 80) throw new HttpError(400, 'Keep the name under 80 characters.');
        const renamed = polyphemus.store.renameProject(project.slug, name);
        if (!renamed) throw new HttpError(404, 'No such project.');
        opts.log?.(`${project.slug} is now called ${renamed.name}`);
        broadcast({ type: 'project_changed', slug: project.slug, name: renamed.name });
        return sendJson(res, 200, { name: renamed.name, slug: renamed.slug });
      }
      // A project's own level: stricter than the install's, or back to it with null. The owner's call.
      if (req.method === 'POST' && parts[3] === 'isolation' && parts.length === 4) {
        if (!access.owner) throw new HttpError(403, OWNER_ONLY);
        const level = body.level === null ? null : body.level;
        if (level !== null && !isIsolationLevel(level)) throw new HttpError(400, 'Pick isolated, isolated-open or host — or null for the install’s.');
        if (level !== null && effectiveLevel(polyphemus.config.isolation.level, level) !== level) throw new HttpError(400, `A project can be stricter than the install (${ISOLATION_WORDS[polyphemus.config.isolation.level].title}), not looser.`);
        polyphemus.store.setProjectIsolation(project.slug, level);
        polyphemus.hostNoted.clear();
        opts.log?.(`${project.name}: agents run ${ISOLATION_WORDS[polyphemus.isolationFor(polyphemus.store.project(project.slug)!)].title}`);
        return sendJson(res, 200, { own: level, applies: polyphemus.isolationFor(polyphemus.store.project(project.slug)!) });
      }
      // Who belongs to this project, and how: a member works here, a viewer reads. The owner's call.
      if (req.method === 'POST' && parts[3] === 'people' && parts.length === 4) {
        if (!access.owner) throw new HttpError(403, OWNER_ONLY);
        const person = polyphemus.store.person(String(body.person ?? ''));
        if (!person) throw new HttpError(400, 'No such person.');
        if (person.owner) throw new HttpError(400, `${person.name} owns this install and already sees every project.`);
        const role = body.role === null ? null : String(body.role ?? '');
        if (role !== null && role !== 'member' && role !== 'viewer') throw new HttpError(400, 'A role is member or viewer.');
        polyphemus.store.setProjectRole(project.slug, person.id, role, Date.now(), access.actor);
        opts.log?.(role ? `${person.name} is a ${role} of ${project.name}` : `${person.name} no longer belongs to ${project.name}`);
        broadcast({ type: 'people_changed' });
        return sendJson(res, 200, { people: polyphemus.store.projectMembers(project.slug).map(({ person: p, role: r }) => ({ id: p.id, name: p.name, role: r })) });
      }
      // What its agents may reach on the network while isolated: presets and hosts, replaced whole. The owner's call.
      if (req.method === 'POST' && parts[3] === 'network' && parts.length === 4) {
        if (!access.owner) throw new HttpError(403, OWNER_ONLY);
        const presets = Array.isArray(body.presets) ? body.presets : [];
        const typed = Array.isArray(body.hosts) ? body.hosts : [];
        if (!presets.every(isNetworkPreset)) throw new HttpError(400, `Presets are ${Object.keys(NETWORK_PRESETS).join(' and ')}.`);
        const hosts: string[] = [];
        for (const entry of typed) {
          const normal = typeof entry === 'string' ? normalizeHost(entry) : { error: 'Hosts are text.' };
          if ('error' in normal) throw new HttpError(400, normal.error);
          if (!hosts.includes(normal.host)) hosts.push(normal.host);
        }
        const network = { presets: [...new Set(presets as string[])], hosts };
        polyphemus.store.setProjectNetwork(project.slug, network);
        opts.log?.(`${project.name}: agents may reach ${grantedHosts(network).length ? grantedHosts(network).join(', ') : 'no hosts'} when isolated`);
        return sendJson(res, 200, { presets: network.presets, hosts: network.hosts });
      }
      if (req.method === 'POST' && parts[3] === 'orient' && parts.length === 4) {
        const ref = typeof body.model === 'string' && body.model ? body.model : polyphemus.config.defaultModel;
        if (!ref) throw new HttpError(400, 'Pick a model.');
        const model = listedModel(ref);
        const meta = polyphemus.store.create({ title: `Orientation: ${project.name}`, provider: model.provider, model: model.model, cwd: project.path, agent: defaultAgent(polyphemus, project.path, project.slug)?.id });
        startTurn(liveSession(meta.id, model)!, orientationPrompt(polyphemus.home, project));
        return sendJson(res, 201, { id: meta.id });
      }
      if (req.method === 'POST' && parts[3] === 'incoming' && parts.length === 4) {
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) throw new HttpError(400, 'Say what came in.');
        const kind = (typeof body.kind === 'string' && body.kind in INCOMING_KINDS ? body.kind : 'feedback') as IncomingKind;
        const landed = landIncoming(project, kind, text, access.actor, access.person.name);
        return sendJson(res, 201, landed);
      }
      // Where it stands: what the last session left for the next one. Anyone who can see the project
      // can read it — it's the state of the work, which is what a viewer is here for.
      if (req.method === 'GET' && parts[3] === 'handoff' && parts.length === 4) {
        const handoff = projectHandoff(polyphemus.home, project.slug);
        return sendJson(res, 200, { text: handoff?.text ?? '', at: handoff?.at ?? null });
      }
      // What's been made here: the files agents produced, which until now lived only in the thread
      // that produced them. Newest first, with the thread each came out of.
      if (req.method === 'GET' && parts[3] === 'artifacts' && parts.length === 4) {
        const here = polyphemus.store.list(400, { cwd: project.path }).filter((meta) => access.canSeeSession(meta));
        const titles = new Map(here.map((meta) => [meta.id, meta.title]));
        const artifacts = polyphemus.store.artifactsIn([...titles.keys()]).map((a) => ({ ...a, in: titles.get(a.sessionId) ?? '' }));
        return sendJson(res, 200, { artifacts });
      }
      if (req.method === 'GET' && parts[3] === 'inbox' && parts.length === 4) return sendJson(res, 200, { items: inboxItems(polyphemus.home, project) });
      if (req.method === 'POST' && parts[3] === 'inbox' && parts[4] && parts.length === 5) {
        const action = body.action === 'accept' ? 'accept' : body.action === 'discard' ? 'discard' : undefined;
        if (!action) throw new HttpError(400, 'Accept or discard?');
        const placed = resolveInboxItem(polyphemus.home, project, decodeURIComponent(parts[4]), action);
        opts.log?.(`${project.name}: ${action === 'accept' ? `accepted ${parts[4]}` : `discarded ${parts[4]}`}`);
        // Every device's count of what's waiting in review changes, not only the one that answered.
        broadcast({ type: 'project_changed', slug: project.slug });
        return sendJson(res, 200, { placed: placed ?? null });
      }
    }

    // Agents from the app: a name, a mark and a sentence. The sentence writes the persona, and
    // creation doesn't wait for it (docs/design/agents.md) — the agent exists either way.
    // The default agent: named and given a personality on first run, and re-voiced from Team.
    if (req.method === 'POST' && path === '/api/default-agent') {
      if (!access.owner) throw new HttpError(403, OWNER_ONLY);
      const personality = String(body.personality ?? 'plain') as Parameters<typeof setUpDefaultAgent>[1]['personality'];
      const agent = setUpDefaultAgent(polyphemus, { title: String(body.title ?? ''), personality, words: typeof body.words === 'string' ? body.words : undefined, by: `app:${device.name}` });
      opts.log?.(`Default agent: ${agent.title} (${agent.name})`);
      broadcast({ type: 'agent_changed', name: agent.id });
      return sendJson(res, 200, { id: agent.id, title: agent.title });
    }
    // Skills: what's installed where, the library to add from, and installing or removing one.
    if (parts[1] === 'skills') return skillsApi(req, res, parts, body, access, device);

    // What's in an agent's computer's Downloads and on its Desktop, and fetching one: files out of it.
    if (req.method === 'GET' && parts[1] === 'agents' && parts[2] && parts[3] === 'computer' && parts[4] === 'files') {
      const agent = agentNamed(decodeURIComponent(parts[2]));
      if (!agent || !access.owner) throw new HttpError(404, 'No such agent.');
      const home = polyphemus.desktops.homeDir(agent.id);
      const params = new URL(req.url ?? '/', 'http://polyphemus').searchParams;
      if (parts.length === 6 && parts[5] === 'download') {
        const where = params.get('in') === 'Desktop' ? 'Desktop' : 'Downloads';
        const name = params.get('name') ?? '';
        if (!name || name.includes('/') || name.startsWith('.')) throw new HttpError(400, 'Which file?');
        const file = join(home, where, name);
        // From its home, the folder polyphemus made, through no link at any step: Downloads itself is the agent's to replace.
        const content = readBytesInside(home, file);
        if (!content) throw new HttpError(404, 'That file isn’t there anymore.');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store' });
        res.end(content);
        return;
      }
      const list = (where: 'Downloads' | 'Desktop') =>
        listInside(home, join(home, where))
          .filter((name) => !name.startsWith('.'))
          .flatMap((name) => {
            const found = fileInside(home, join(home, where, name));
            return found ? [{ name, in: where, ...found }] : [];
          });
      return sendJson(res, 200, { files: [...list('Downloads'), ...list('Desktop')].sort((a, b) => b.at - a.at) });
    }

    // An agent's own computer (docs/design/desktop.md): whether it's awake, and waking or sleeping it.
    if (parts[1] === 'agents' && parts[2] && parts[3] === 'computer' && parts.length === 4) {
      const agent = agentNamed(decodeURIComponent(parts[2]));
      if (!agent || !access.canSeeAgent(agent)) throw new HttpError(404, 'No such agent.');
      // The Computer connection: polyphemus's own, set up the first time any agent is given its computer.
      const computerConnection = () => polyphemus.connections.list().find((c) => c.server.kind === 'builtin' && c.server.builtin === 'computer');
      const allowed = () => {
        const c = computerConnection();
        return c ? polyphemus.store.connections.grants(c.id).some((g) => g.agent === agent.id && g.project === '') : false;
      };
      if (req.method === 'POST') {
        if (!access.owner) throw new HttpError(403, OWNER_ONLY);
        if (body.action === 'allow') {
          // "Riley can use its computer": the agent carries every tool the computer has, wherever it works.
          let c = computerConnection();
          if (body.on === true) {
            if (!c) c = await polyphemus.connections.add({ name: 'Computer', owner: access.person.id, server: { kind: 'builtin', builtin: 'computer' }, createdBy: access.person.id });
            c = await polyphemus.connections.test(c.id);
            polyphemus.connections.grant({ connection: c.id, agent: agent.id, tools: c.tools.map((t) => t.name), by: access.actor });
          } else if (c) polyphemus.connections.revoke(c.id, '', agent.id);
          opts.log?.(`${agent.title} ${body.on === true ? 'can' : 'can’t'} use its computer (${access.person.name})`);
          broadcast({ type: 'connections_changed' });
        } else if (body.action === 'take') polyphemus.desktops.hold(agent.id, access.person.name);
        else if (body.action === 'give') polyphemus.desktops.hold(agent.id, undefined);
        else if (body.action === 'sleep') await polyphemus.desktops.sleep(agent.id);
        else if (body.action === 'record') return sendJson(res, 200, await recording(agent, body, access));
        else {
          // Waking can take minutes the first time (the image is built): answered straight away, and the
          // app is told when it's up.
          void polyphemus.desktops
            .wake(agent.id)
            .then(() => broadcast({ type: 'computer', agent: agent.id, state: 'awake' }))
            .catch((err: Error) => broadcast({ type: 'computer', agent: agent.id, state: 'asleep', error: err.message }));
        }
      }
      return sendJson(res, 200, { state: await polyphemus.desktops.state(agent.id), imageReady: await polyphemus.desktops.imageReady(), canUse: access.owner, runtime: polyphemus.runtime()?.name ?? null, allowed: allowed(), heldBy: polyphemus.desktops.heldBy(agent.id) ?? null });
    }

    if (req.method === 'POST' && parts[1] === 'agents' && parts.length === 2) {
      if (!access.owner) throw new HttpError(403, OWNER_ONLY);
      const name = String(body.name ?? '').trim();
      const project = typeof body.project === 'string' && body.project ? polyphemus.store.project(body.project) : undefined;
      if (body.project && !project) throw new HttpError(400, 'No such project.');
      const dir = project ? projectAgentsDir(project.path) : libraryAgentsDir(polyphemus.home);
      // An agent keeps the model it was made with: the one asked for, else today's default.
      const model = typeof body.model === 'string' && body.model ? body.model : polyphemus.config.defaultModel;
      if (model && model !== FOLLOW_DEFAULT) listedModel(model); // fails now rather than at the first turn
      const from = typeof body.from === 'string' && body.from ? body.from : undefined;
      const mark = markFrom(body.mark);
      const description = String(body.description ?? '').trim();
      // A project's agent is made from the project's folder, which its agents can't replace.
      const root = project?.path ?? polyphemus.home;
      const file = from ? createFromTemplate('agents', from, dir, name, root) : createAgent(dir, name, { description, model, ...(mark ? { mark } : {}) }, root);
      const made = agentId(name, project?.slug);
      if (from && (model || mark)) updateAgent(agentNamed(made)!, { ...(model ? { model } : {}), ...(mark ? { mark } : {}) });
      opts.log?.(`New agent: ${made}${from ? ` (from the ${from} template)` : ''}`);
      // A template brings its own persona; a sentence is what needs writing up.
      const drafting = !from && description.length > 0 && draftingModel(polyphemus, model) !== undefined;
      if (drafting) void draftFor(made);
      return sendJson(res, 201, { name, id: made, file, drafting });
    }
    // Before deleting an agent: what leans on it. Afterwards, the threads stay and its routines stop.
    if (parts[1] === 'agents' && parts[2] && (parts[3] === 'dependents' || parts[3] === 'delete') && parts.length === 4) {
      if (!access.owner) throw new HttpError(403, OWNER_ONLY);
      const agent = agentNamed(decodeURIComponent(parts[2]));
      if (!agent) throw new HttpError(404, 'No such agent.');
      const threads = polyphemus.store.sessionsWithAgent(agent.id);
      const routines = scheduler.list().routines.filter((r) => r.agent && findAgent(polyphemus.home, r.project ? polyphemus.store.project(r.project)?.path : undefined, r.agent, r.project)?.id === agent.id);
      if (req.method === 'GET' && parts[3] === 'dependents') {
        return sendJson(res, 200, { threads: threads.map((t) => ({ id: t.id, title: t.title })), routines: routines.map((r) => ({ id: r.id, name: r.name, file: r.file })) });
      }
      if (req.method === 'POST' && parts[3] === 'delete') {
        if (agent.scope === 'library' && agent.name === polyphemus.config.defaultAgent) throw new HttpError(409, `${agent.title} is the default agent — the one a thread is with when nobody picked another. Rename or re-voice it instead.`);
        if (threads.some((t) => live.get(t.id)?.running) || threads.some((t) => runs.activeRun(t.id))) throw new HttpError(409, `${agent.title} is working in a thread right now: stop it first.`);
        const to = deleteAgent(polyphemus.home, agent);
        const detached = polyphemus.store.detachAgent(agent.id);
        for (const id of detached) {
          const entry = live.get(id);
          if (entry && entry.runtime.agent?.id === agent.id) entry.runtime.speakAs(undefined);
          broadcast({ type: 'session_changed', sessionId: id });
        }
        for (const routine of routines) {
          polyphemus.store.updateRoutineState(routine.id, { paused: true, pausedReason: `Its agent, ${agent.title}, was deleted. Point it at another agent, then resume it.` });
        }
        opts.log?.(`Deleted agent ${agent.id} (moved to ${to}); ${detached.length} threads kept without it, ${routines.length} routines stopped`);
        broadcast({ type: 'agent_changed', name: agent.id, deleted: true });
        return sendJson(res, 200, { deleted: true, trash: to, threads: detached.length, routines: routines.length });
      }
    }
    if (parts[1] === 'agents' && parts[2] && parts.length === 3) {
      const agent = agentNamed(decodeURIComponent(parts[2]));
      if (!agent || !access.canSeeAgent(agent)) throw new HttpError(404, 'No such agent.');
      if (req.method === 'POST' && !access.owner) throw new HttpError(403, OWNER_ONLY);
      if (req.method === 'GET') {
        const { dir: _dir, ...rest } = agent;
        return sendJson(res, 200, { agent: { ...rest, fallback: agent.fallback ?? [] } });
      }
      if (req.method === 'POST') {
        const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
        updateAgent(agent, {
          description: text(body.description),
          title: text(body.title),
          persona: text(body.persona),
          instructions: text(body.instructions),
          // "default" follows the default on purpose; "" clears it, back to the model the session would have used.
          model: body.model === undefined ? undefined : body.model ? checkedAgentModel(String(body.model)) : null,
          // An empty list clears the fallbacks.
          fallback: body.fallback === undefined ? undefined : Array.isArray(body.fallback) ? body.fallback.map((ref: unknown) => checkedAgentModel(String(ref))) : null,
          // null resets it: back to the mark its name gets.
          mark: body.mark === undefined ? undefined : body.mark === null ? null : markFrom(body.mark),
        });
        opts.log?.(`Edited agent: ${agent.id}`);
        const updated = agentNamed(agent.id)!;
        const { dir: _dir, ...rest } = updated;
        return sendJson(res, 200, { agent: { ...rest, fallback: updated.fallback ?? [] } });
      }
    }

    // Workflows: what there is to start, and starting one as a new work item in a project.
    if (parts[1] === 'workflows' && parts.length === 2 && req.method === 'GET') {
      return sendJson(res, 200, { workflows: allWorkflows().map((w) => ({ id: w.id, name: w.name, about: w.about, input: w.input })) });
    }
    if (parts[1] === 'workflows' && parts[2] && parts[3] === 'start' && parts.length === 4 && req.method === 'POST') {
      const workflow = findWorkflow(decodeURIComponent(parts[2]));
      if (!workflow) throw new HttpError(404, 'No such workflow.');
      const project = typeof body.project === 'string' && body.project ? polyphemus.store.project(body.project) : undefined;
      if (!project) throw new HttpError(400, 'Pick a project for it to run in.');
      if (!access.canSeeProject(project.slug)) throw new HttpError(404, 'No such project.');
      if (!access.canWorkInProject(project.slug)) throw new HttpError(403, READ_ONLY);
      const input = body.input && typeof body.input === 'object' ? (body.input as Record<string, unknown>) : {};
      const id = startWorkflowThread({ project, workflow, input, agentRef: typeof body.agent === 'string' && body.agent ? body.agent : undefined, modelRef: typeof body.model === 'string' && body.model ? body.model : undefined, by: access.actor, yolo: body.yolo === true });
      return sendJson(res, 201, { id });
    }

    if (parts[1] === 'sessions' && parts.length === 2 && req.method === 'POST') {
      // start: false creates the session without a turn (the terminal sends the message next).
      const start = body.start !== false;
      // A thread opened on a brand-new agent starts with the agent, not with an empty box.
      const introduce = body.introduce === true;
      const images = imagesFrom(body, access);
      const fileEntries = Array.isArray(body.files) ? (body.files as Array<{ name?: unknown }>) : [];
      if (start && !introduce && !text && images.length === 0 && !fileEntries.length) throw new HttpError(400, 'Type a message to start the session.');
      // A project's agent (`shop/critic`) brings its project: that's where a thread with it belongs.
      const agentProject = typeof body.agent === 'string' && body.agent.includes('/') ? body.agent.slice(0, body.agent.indexOf('/')) : undefined;
      const projectRef = typeof body.project === 'string' && body.project ? body.project : agentProject;
      const project = projectRef ? polyphemus.store.project(projectRef) : undefined;
      if (projectRef && (!project || !access.canSeeProject(project.slug))) throw new HttpError(404, 'No such project.');
      // Somewhere to start it: a project this person works in. Only the owner starts threads with
      // agents outside any project — membership of one project grants nothing anywhere else. Anyone
      // can message a person, though: a conversation between people, with no agent in it, runs
      // nothing and reaches nothing, so it needs no project.
      const askedFor = (Array.isArray(body.with) ? body.with : []).map(String).filter(Boolean);
      const betweenPeople = !project && !(typeof body.agent === 'string' && body.agent) && askedFor.length > 0 && askedFor.every((ref) => ref.startsWith('person:'));
      if (project ? !access.canWorkInProject(project.slug) : !(access.owner || betweenPeople)) {
        throw new HttpError(403, project ? READ_ONLY : 'Pick one of your projects to start a thread in.');
      }
      // Only the terminal on this computer starts sessions in any folder; paired devices pick a project.
      const folder = device.id === LOCAL_CLIENT.id && typeof body.cwd === 'string' ? body.cwd : undefined;
      if (folder !== undefined && !(isAbsolute(folder) && existsSync(folder))) throw new HttpError(400, `No such folder: ${folder}`);
      // No project: its own folder beside your projects — never the folder the daemon happens to run in,
      // which is usually a project itself and would quietly make the thread part of it.
      const cwd = project?.path ?? folder ?? directFolder(polyphemus.config.projectsRoot);
      // As an agent: checked first, so a name that isn't there says so rather than complaining
      // about the model. Its route is used unless a model was named outright, and its name is
      // kept on the session, so reopening it brings back its persona, instructions, and skills.
      const agentName = typeof body.agent === 'string' && body.agent ? body.agent : undefined;
      const chosen = agentName ? findAgent(polyphemus.home, project?.path, agentName, project?.slug) : undefined;
      if (agentName && !chosen) throw new HttpError(400, `No agent called "${agentName}".`);
      const asked = (Array.isArray(body.with) ? body.with : []).map(String).filter(Boolean);
      // "with" may name people as well as agents: person:<id>, for a conversation outside a project.
      const withPeople = asked.filter((ref) => ref.startsWith('person:')).map((ref) => ref.slice(7));
      for (const personId of withPeople) if (!polyphemus.store.person(personId)) throw new HttpError(400, 'No such person.');
      // A conversation between people has someone else in it.
      if (betweenPeople && withPeople.every((personId) => personId === access.person.id)) throw new HttpError(400, 'Pick someone to talk to.');
      if (withPeople.length && project) throw new HttpError(400, 'In a project, who can see a thread comes from the project’s people.');
      // Nobody picked: the thread is with the default agent, so it's never with no one.
      const agent = chosen ?? (asked.length ? undefined : defaultAgent(polyphemus, project?.path, project?.slug));
      // Anyone else brought in from the start ("more" on the draft line): checked before anything is made.
      const also = asked.filter((ref) => ref !== agent?.id && !ref.startsWith('person:'));
      const alsoAgents = also.map((ref) => {
        const found = findAgent(polyphemus.home, project?.path, ref, project?.slug);
        if (!found) throw new HttpError(400, `No agent called "${ref}".`);
        return found;
      });
      const named = typeof body.model === 'string' && body.model ? body.model : undefined;
      // An agent brings its own model, so it answers "which model?" when nothing else has.
      const ref = named ?? polyphemus.config.defaultModel ?? agent?.model;
      if (!ref) throw new HttpError(400, 'Pick a model.');
      const base = named === undefined ? resolveModel(polyphemus.config, ref) : listedModel(ref);
      const model = named === undefined && agent ? agentModel(polyphemus.config, agent, base) : base;
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : text || (fileEntries[0] ? String(fileEntries[0].name ?? 'A file') : 'Image');
      // Files go in the thread's folder before the thread exists, so one that can't be placed makes nothing.
      const said = withFiles(body, text, cwd, requirePerson(device).id);
      const meta = polyphemus.store.create({ title: clip(title, 60), provider: model.provider, model: model.model, cwd, agent: agent?.id, startedBy: `person:${requirePerson(device).id}` });
      // Started with, not added later: recorded at the thread's own start.
      for (const extra of alsoAgents) polyphemus.store.addMember(meta.id, extra.id, meta.createdAt, `person:${requirePerson(device).id}`);
      for (const personId of withPeople) polyphemus.store.addThreadPerson(meta.id, personId, meta.createdAt, `person:${requirePerson(device).id}`);
      const entry = liveSession(meta.id, model)!;
      entry.runtime.sender = `person:${requirePerson(device).id}`;
      entry.runtime.autoApprove = body.yolo === true;
      if (entry.runtime.autoApprove) polyphemus.store.setYolo(meta.id, true);
      // Between people, with no agent in it, a message is delivered, not answered: nobody's model
      // replies to "hey" meant for someone else.
      if (start && !agent && !alsoAgents.length && withPeople.length) {
        entry.runtime.say(said, images);
        tellPeopleIn(meta.id, said, requirePerson(device));
        return sendJson(res, 201, { id: meta.id, meta });
      }
      // A thread's first message can start agents talking to each other too.
      if (start) void converse(entry, introduce && !said ? INTRODUCE_YOURSELF : said, images);
      return sendJson(res, 201, { id: meta.id, meta });
    }

    if (parts[1] === 'sessions' && parts.length === 2 && req.method === 'GET') {
      // Every thread, not just the recent fifty on /api/state: a search, the archive, a project's,
      // or an agent's.
      const params = new URL(req.url ?? '/', 'http://polyphemus').searchParams;
      const q = params.get('q')?.trim();
      if (q) {
        const questions = pendingQuestions();
        const found = polyphemus.store.search(q, access.owner ? 50 : 500).filter((m) => access.canSeeSession(m.meta)).slice(0, 50);
        return sendJson(res, 200, { sessions: found.map((m) => ({ ...sessionRow(m.meta, questions, access), snippet: m.snippet ?? null })) });
      }
      const slug = params.get('project');
      const project = slug ? polyphemus.store.project(slug) : undefined;
      if (slug && (!project || !access.canSeeProject(project.slug))) throw new HttpError(404, 'No such project.');
      const agent = params.get('agent') || undefined;
      const questions = pendingQuestions();
      const metas = polyphemus.store.list(500, { archived: params.get('archived') === '1', cwd: project?.path, agent });
      return sendJson(res, 200, { sessions: metas.filter((meta) => access.canSeeSession(meta) && !meta.startedBy?.startsWith('run:')).map((meta) => sessionRow(meta, questions, access)) });
    }

    if (parts[1] === 'sessions' && parts[2]) {
      const [, , id, action] = parts;
      visibleSession(id);
      if (req.method === 'POST') workableSession(id);
      if (req.method === 'GET' && !action) return sendJson(res, 200, sessionDetail(id, access, new URL(req.url ?? '/', 'http://polyphemus').searchParams.get('light') === '1'));
      // A thread's flow: who worked when, what each turn cost, who handed on to whom, and where it
      // waited on a person — the data a swimlane over time is drawn from (docs/design/app.md).
      if (req.method === 'GET' && action === 'flow') {
        const meta = polyphemus.store.get(id)!;
        // Drawing a flow reads everything ever said in the thread, and the app asks for it again on
        // every render. What's been said can only be added to, so counting it says whether the last
        // answer still stands; a name or a mark that changed shows within the minute after that
        // (review of parallel agents, 2026-09-20).
        const stamp = `${polyphemus.store.messageCount(id)}:${polyphemus.store.turns(id).length}:${polyphemus.store.attendance(id).length}:${polyphemus.store.answers(id).length}`;
        const remembered = flowCache.get(id);
        if (remembered && remembered.stamp === stamp && Date.now() - remembered.at < 60_000) return sendJson(res, 200, remembered.flow);
        const times = polyphemus.store.messageTimes(id);
        const actors = polyphemus.store.messageActors(id);
        const turns = polyphemus.store.turns(id);
        const attendance = polyphemus.store.attendance(id);
        const answers = polyphemus.store.answers(id);
        const messages = polyphemus.store.messages(id);
        // The agent a turn's messages came from: the last agent to speak among them.
        const spokeIn = (who: Array<string | null>, endSeq: number) => {
          for (let i = Math.min(endSeq, who.length) - 1; i >= 0; i--) if (who[i]?.startsWith('agent:')) return who[i]!;
          return undefined;
        };
        // Who it was answering: whoever spoke last before it started.
        const askedBefore = (who: Array<string | null>, at: number[], started: number) => {
          for (let i = at.length - 1; i >= 0; i--) if ((at[i] ?? 0) <= started && who[i]) return who[i]!;
          return undefined;
        };
        // Everyone who appears anywhere in it, in the order they first do.
        const seen = new Map<string, { id: string; kind: 'person' | 'agent' | 'thread'; name: string; mark: unknown }>();
        const note = (ref: string | null | undefined) => {
          if (!ref || seen.has(ref)) return;
          const who = ref.startsWith('person:') ? polyphemus.store.person(ref.slice(7)) : undefined;
          const agent = ref.startsWith('agent:') ? agentNamed(ref.slice(6)) : undefined;
          seen.set(ref, {
            id: ref,
            kind: ref.startsWith('person:') ? 'person' : ref.startsWith('agent:') ? 'agent' : 'thread',
            name: who?.name ?? agent?.title ?? (ref.startsWith('routine:') ? 'A routine' : 'The thread'),
            mark: agent?.mark ?? null,
          });
        };
        for (const actor of actors) note(actor);
        for (const turn of turns) note(turn.speaker ? `agent:${turn.speaker}` : null);
        for (const change of attendance) note(change.subject);
        const flow = {
          startedAt: meta.createdAt,
          actors: [...seen.values()],
          // What was said, by whom, in a line — the dots along each row.
          says: messages.flatMap((message, i) => {
            const actor = actors[i] ?? null;
            if (message.role === 'user' && !actor) return []; // a tool's answer, not something anyone said
            // What a person or an agent actually said, without the blocks polyphemus adds around it.
            const text = message.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
              // Under every name the blocks have been stored as: a thread outlives a rename.
              .replace(/<polyphemus_[a-z_]+>[\s\S]*?<\/polyphemus_[a-z_]+>/g, '')
              .replace(/<\/?polyphemus_[a-z_]+[^>]*>/g, '')
              .trim();
            if (!text) return [];
            return [{ seq: i, at: times[i] ?? meta.createdAt, actor, role: message.role, preview: clip(text, 120) }];
          }),
          // Each turn: whose it was, who it answered, and what it took. Turns from before polyphemus kept
          // those are read from the messages the turn left behind, and whoever spoke last before it.
          turns: turns.map((t) => ({
            at: t.startedAt,
            until: t.endedAt,
            speaker: t.speaker ?? spokeIn(actors, t.endSeq)?.slice(6) ?? null,
            sender: t.sender ?? askedBefore(actors, times, t.startedAt) ?? null,
            model: `${t.provider}:${t.model}`,
            stopReason: t.stopReason,
            tokens: t.usage.inputTokens + t.usage.outputTokens,
            costUsd: t.costUsd ?? null,
            // Recorded before polyphemus told a CLI's running total from a turn's own cost: it isn't
            // added up, and it's said rather than quietly missing.
            costUnknown: t.costUnknown === true,
            billing: t.billing ?? null,
            endSeq: t.endSeq,
          })),
          // Where it waited on a person, and who answered.
          waits: answers.map((a) => ({ at: a.at, kind: a.kind, summary: a.summary, answer: a.answer, by: a.by })),
          comings: attendance.map((c) => ({ at: c.at, who: c.subject, change: c.change, by: c.by ?? null })),
        };
        // Only the threads being looked at are remembered, and only the newest few.
        for (const old of [...flowCache.keys()].slice(0, Math.max(0, flowCache.size - 15))) flowCache.delete(old);
        flowCache.set(id, { stamp, at: Date.now(), flow });
        return sendJson(res, 200, flow);
      }
      if (req.method === 'POST' && (action === 'archive' || action === 'delete')) {
        const meta = polyphemus.store.get(id);
        if (!meta) throw new HttpError(404, 'No such session.');
        const existing = live.get(id);
        if (existing?.running || existing?.asides?.size || runs.activeRun(id)) throw new HttpError(409, 'It’s still working: stop it first.');
        if (action === 'archive') {
          const on = body.on !== false;
          polyphemus.store.setArchived(id, on);
          opts.log?.(`${on ? 'Archived' : 'Unarchived'} thread ${id}`);
          broadcast({ type: 'session_changed', sessionId: id, archived: on });
          return sendJson(res, 200, { archived: on });
        }
        // Nothing waits on a thread that's about to stop existing.
        if (existing) {
          for (const pending of [...existing.questions.values()]) pending.answer(undefined);
          for (const aside of existing.asides?.values() ?? []) {
            aside.running.abort();
            aside.runtime.close();
          }
          existing.runtime.close();
          live.delete(id);
        }
        polyphemus.store.delete(id);
        rmSync(artifactsDir(polyphemus.home, id), { recursive: true, force: true });
        opts.log?.(`Deleted thread ${id}: ${meta.title}`);
        broadcast({ type: 'session_changed', sessionId: id, deleted: true });
        writeStatus();
        return sendJson(res, 200, { deleted: true });
      }
      const entry = liveSession(id);
      if (!entry) throw new HttpError(404, 'No such session.');
      if (req.method === 'GET' && action === 'status') return sendJson(res, 200, { rows: entry.runtime.statusRows() });
      switch (req.method === 'POST' ? action : undefined) {
        case 'title':
          if (!text) throw new HttpError(400, 'Give it a title.');
          entry.runtime.rename(clip(text, 80));
          broadcast({ type: 'session_changed', sessionId: id, title: entry.runtime.meta?.title ?? text });
          return sendJson(res, 200, { title: entry.runtime.meta?.title ?? text });
        case 'keep':
        case 'finish': {
          const on = body.on !== false;
          if (action === 'keep') polyphemus.store.setKept(id, on);
          else polyphemus.store.setFinished(id, on);
          broadcast({ type: 'session_changed', sessionId: id, [action === 'keep' ? 'kept' : 'finished']: on });
          return sendJson(res, 200, { [action === 'keep' ? 'kept' : 'finished']: on });
        }
        case 'react': {
          // A reaction to a message, like a chat app's: yours goes on, or comes off if it was there.
          const seq = Number(body.seq);
          const emoji = canonicalEmoji(String(body.emoji ?? ''));
          if (!Number.isInteger(seq) || seq < 0 || seq >= polyphemus.store.messageTimes(id).length) throw new HttpError(400, 'Which message?');
          if (!emoji) throw new HttpError(400, 'React with an emoji.');
          const on = polyphemus.store.toggleReaction(id, seq, access.actor, emoji);
          const reactions = polyphemus.store.reactions(id);
          broadcast({ type: 'reactions', sessionId: id, reactions });
          return sendJson(res, 200, { on, reactions });
        }
        case 'effort': {
          const effort = body.effort ?? null;
          if (effort !== null && !EFFORTS.includes(effort as Effort)) throw new HttpError(400, `Effort must be one of: ${EFFORTS.join(', ')}, or null for the model's default.`);
          entry.runtime.effort = effort === null ? undefined : (effort as Effort);
          return sendJson(res, 200, { effort: entry.runtime.effort ?? null });
        }
        case 'send-now': {
          // A held message that can't wait: it goes next, and what's working is stopped to let it
          // (a thread takes one turn at a time). The app says so before it asks for this.
          const held = polyphemus.store.queuedMessages(id).find((q) => q.id === String(body.id ?? ''));
          if (!held) throw new HttpError(404, 'That message isn’t waiting any more.');
          if (held.personId !== access.person.id && !access.owner) throw new HttpError(403, 'Only whoever sent it can send it now.');
          // For an agent that isn't working, it goes to them now, alongside — nothing is stopped
          // (2026-09-19: sending one to another agent was stopping the thread's turn).
          const asked = addressedTo(String(held.body.text ?? ''), threadMembers(id));
          const free = asked.length === 1 && asked[0]!.id !== entry.runtime.agent?.id && !entry.asides?.has(asked[0]!.id) ? asked[0]! : undefined;
          if (free && entry.running) {
            polyphemus.store.unqueueMessage(held.id);
            broadcast({ type: 'queue', sessionId: id });
            const sender = polyphemus.store.person(held.personId) ?? access.person;
            // With whatever came with it: a held message's pictures and files go too.
            const heldImages = imagesFrom(held.body, new Access(polyphemus.store, sender));
            const said = withFiles(held.body, String(held.body.text ?? ''), threadFolder(id), sender.id);
            startAside(entry, polyphemus.store.get(id)!, free, said, heldImages, `person:${sender.id}`);
            opts.log?.(`${access.person.name} sent a held message to ${free.title} in thread ${id}, alongside`);
            return sendJson(res, 200, { ok: true, stopped: false, alongside: true });
          }
          polyphemus.store.prioritiseMessage(held.id);
          broadcast({ type: 'queue', sessionId: id });
          if (entry.running) {
            entry.running.abort();
            opts.log?.(`${access.person.name} stopped the turn in thread ${id} to send a held message`);
          } else {
            drainQueue(id);
          }
          return sendJson(res, 200, { ok: true, stopped: Boolean(entry.running) });
        }
        case 'unqueue': {
          // Taking back a message that hasn't gone yet: your own, or anyone's for the owner.
          const held = polyphemus.store.queuedMessages(id).find((q) => q.id === String(body.id ?? ''));
          if (!held) throw new HttpError(404, 'That message isn’t waiting any more.');
          if (held.personId !== access.person.id && !access.owner) throw new HttpError(403, 'Only whoever sent it can take it back.');
          polyphemus.store.unqueueMessage(held.id);
          broadcast({ type: 'queue', sessionId: id });
          return sendJson(res, 200, { ok: true });
        }
        case 'messages': {
          const images = imagesFrom(body, access);
          const files = Array.isArray(body.files) ? body.files.length : 0;
          if (!text && images.length === 0 && !files) throw new HttpError(400, 'Empty message.');
          const going = runs.activeRun(id);
          // At a gate the thread is free to talk in; while a step is working, it isn't.
          if (going && going.status !== 'waiting') throw new HttpError(409, 'A run is working here: wait, or stop it first.');
          // Working, but you're talking to someone else here: that agent answers alongside, with a
          // turn of its own (docs/design/parallel-agents.md).
          if (entry.running && !polyphemus.store.queuedMessages(id).length) {
            // Someone new, named while another works, comes in and answers alongside too: held until
            // the working agent finished, they seemed not to have heard (2026-09-19).
            bringInNamed(id, text, access);
            const named = addressedTo(text, threadMembers(id));
            const free = named.length === 1 && named[0]!.id !== entry.runtime.agent?.id && !entry.asides?.has(named[0]!.id) ? named[0]! : undefined;
            if (free) {
              const sender = requirePerson(device);
              entry.runtime.sender = `person:${sender.id}`;
              const said = withFiles(body, text, threadFolder(id), sender.id);
              tellNamedPeople(id, text, sender);
              startAside(entry, polyphemus.store.get(id)!, free, said, images, `person:${sender.id}`);
              return sendJson(res, 202, { ok: true, answering: free.name, alongside: true });
            }
          }
          // Still working, or others already waiting their turn: held, in order, and sent when it stops.
          const waiting = polyphemus.store.queuedMessages(id);
          if (entry.running || waiting.length) {
            // A queue that only grows is a thread nobody can catch up with, and a way to fill the
            // database from a phone (review of parallel agents, 2026-09-20).
            if (waiting.length >= QUEUE_LIMIT) throw new HttpError(429, `${QUEUE_LIMIT} messages are already waiting here. Wait for the thread to catch up, or take one back.`);
            if (waiting.filter((q) => q.personId === access.person.id).length >= QUEUE_LIMIT_EACH)
              throw new HttpError(429, `You have ${QUEUE_LIMIT_EACH} messages waiting here. Wait for the thread to catch up, or take one back.`);
            const queued = polyphemus.store.queueMessage({ id: randomUUID().slice(0, 8), sessionId: id, personId: access.person.id, deviceId: device.id, body: { text, ...(body.images !== undefined && { images: body.images }), ...(body.files !== undefined && { files: body.files }) } });
            broadcast({ type: 'queue', sessionId: id });
            if (!entry.running) void drainQueue(id);
            return sendJson(res, 202, { ok: true, queued: queued.id });
          }
          return sendJson(res, 202, { ok: true, ...deliverMessage(id, entry, body, access, device) });
        }
        case 'lead': {
          const ref = String(body.agent ?? '').trim();
          const agent = threadMembers(id).find((m) => m.id === ref || m.name === ref);
          if (!agent) throw new HttpError(400, 'The lead has to be one of the agents in the thread.');
          polyphemus.store.setLead(id, agent.id);
          broadcast({ type: 'session_changed', sessionId: id });
          return sendJson(res, 200, { lead: agent.id });
        }
        case 'answer-all': {
          const on = body.on === true;
          polyphemus.store.setAgentsAnswerAll(id, on);
          broadcast({ type: 'session_changed', sessionId: id });
          return sendJson(res, 200, { agentsAnswerAll: on });
        }
        case 'guard': {
          // null: back to the default; 0: don't ask in this thread; n: ask after n.
          const limit = body.limit === null ? null : Number(body.limit);
          if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > 100)) throw new HttpError(400, 'The guard is a whole number of exchanges, 0 to stop asking here, or null for the default.');
          polyphemus.store.setGuardLimit(id, limit);
          broadcast({ type: 'session_changed', sessionId: id });
          return sendJson(res, 200, { guardLimit: limit, default: DEFAULT_GUARD });
        }
        case 'spinout': {
          // A new thread for part of this one, linked both ways, with the same agents and project.
          const parent = polyphemus.store.get(id)!;
          const title = clip(text || String(body.title ?? '').trim(), 60);
          if (!title) throw new HttpError(400, 'Say what the new thread is for.');
          const child = polyphemus.store.create({ title, provider: parent.provider, model: parent.model, cwd: parent.cwd, agent: leadOf(id)?.id ?? parent.agent, startedBy: access.actor, spunFrom: id });
          for (const member of threadMembers(id)) polyphemus.store.addMember(child.id, member.id, child.createdAt, access.actor);
          opts.log?.(`Spun ${child.id} out of ${id}: ${title}`);
          broadcast({ type: 'session_changed', sessionId: id, spinOut: child.id });
          return sendJson(res, 201, { id: child.id });
        }
        case 'people': {
          // A conversation outside a project is between whoever's in it: no roles, no project.
          const meta = polyphemus.store.get(id)!;
          if (polyphemus.store.projectFor(meta.cwd)) throw new HttpError(400, 'In a project, who can see a thread comes from the project’s people.');
          const personId = String(body.person ?? '').trim();
          const them = polyphemus.store.person(personId);
          if (!them) throw new HttpError(400, 'No such person.');
          if (body.remove === true) {
            if (them.id === meta.startedBy?.slice(7)) throw new HttpError(400, 'Whoever started it stays in it.');
            polyphemus.store.removeThreadPerson(id, them.id, Date.now(), access.actor);
          } else polyphemus.store.addThreadPerson(id, them.id, Date.now(), access.actor);
          opts.log?.(`${body.remove === true ? 'Removed' : 'Added'} ${them.name} ${body.remove === true ? 'from' : 'to'} thread ${id}`);
          broadcast({ type: 'session_changed', sessionId: id });
          return sendJson(res, 200, { people: polyphemus.store.peopleIn(id) });
        }
        case 'members': {
          // Bring someone in, or send them out. Membership is the thread's, not the message's.
          const ref = String(body.agent ?? '').trim();
          const threadMeta = polyphemus.store.get(id);
          const slug = threadMeta ? polyphemus.store.projectFor(threadMeta.cwd)?.slug : undefined;
          const agent = agentNamed(ref, slug);
          // Refused alike whether it doesn't exist, can't be seen, or belongs to another project: saying
          // which would tell someone about agents they can't see (independent review, 2026-09-19).
          if (!agent || !access.canSeeAgent(agent) || (body.remove !== true && !fitsThread(agent, slug))) throw new HttpError(400, `No agent called "${ref}".`);
          const why = body.remove === true ? undefined : cantBringIn(access, agent, id);
          if (why) throw new HttpError(403, why);
          if (body.remove === true) {
            polyphemus.store.removeMember(id, agent.id, access.actor);
            if (agent.name !== agent.id) polyphemus.store.removeMember(id, agent.name, access.actor); // stored by name before ids
          } else polyphemus.store.addMember(id, agent.id, Date.now(), access.actor);
          const now = threadMembers(id);
          opts.log?.(`${body.remove === true ? 'Removed' : 'Added'} ${agent.id} ${body.remove === true ? 'from' : 'to'} thread ${id}`);
          broadcast({ type: 'members', sessionId: id, members: now.map((a) => a.id) });
          // Everyone looking at the thread sees who came or went.
          broadcast({ type: 'session_changed', sessionId: id });
          return sendJson(res, 200, { members: now.map(({ id: agentRef, name: n, title, mark }) => ({ id: agentRef, name: n, title, mark })) });
        }
        case 'outcome': {
          // Track it as work, or drop back to a chat. Neither touches the thread: same id, same place.
          if (body.drop === true) {
            if (runs.activeRun(id)) throw new HttpError(409, 'A run is going: stop it before dropping the outcome.');
            polyphemus.store.runs.dropOutcome(id, access.actor);
          } else {
            if (!text) throw new HttpError(400, 'Say what it’s trying to achieve.');
            if (runs.activeRun(id)) throw new HttpError(409, 'A run is going: stop it before changing the outcome.');
            polyphemus.store.runs.setOutcome(id, clip(text, 120), access.actor);
          }
          broadcast({ type: 'work_changed', sessionId: id });
          return sendJson(res, 200, { work: runs.detail(id) });
        }
        case 'run': {
          try {
            if (body.stop === true) {
              if (!runs.stop(id, access.actor)) throw new HttpError(409, 'No run is going here.');
            } else runs.start(id, access.actor);
          } catch (err) {
            if (err instanceof RunError) throw new HttpError(err.status, err.message);
            throw err;
          }
          return sendJson(res, 200, { work: runs.detail(id) });
        }
        case 'interrupt': {
          // One agent's turn, or the thread's own: each working agent is stopped on its own.
          const who = typeof body.agent === 'string' && body.agent ? body.agent : undefined;
          const aside = who ? entry.asides?.get(who) : undefined;
          if (who && !aside && entry.runtime.agent?.id !== who) throw new HttpError(404, 'That agent isn’t working here.');
          if (aside) aside.running.abort();
          else entry.running?.abort();
          return sendJson(res, 200, { ok: true });
        }
        case 'model':
          entry.runtime.switchModel(listedModel(String(body.model ?? '')));
          return sendJson(res, 200, { model: entry.runtime.model });
        case 'yolo':
          entry.runtime.autoApprove = body.on === true;
          // Anyone answering alongside follows the thread too, from their next tool call.
          for (const aside of entry.asides?.values() ?? []) aside.runtime.autoApprove = body.on === true;
          polyphemus.store.setYolo(id, entry.runtime.autoApprove);
          return sendJson(res, 200, { autoApprove: entry.runtime.autoApprove });
      }
    }

    // A key pasted into a thread, saved instead of sent. The value is not echoed, logged, or stored on the question.
    if (req.method === 'POST' && path === '/api/secrets') {
      // From a thread that's already open, or from the box that starts one (no thread yet).
      let project = typeof body.project === 'string' && body.project ? polyphemus.store.project(body.project) : undefined;
      let agent = typeof body.agent === 'string' ? body.agent : '';
      if (typeof body.session === 'string' && body.session) {
        const meta = workableSession(body.session);
        project = polyphemus.store.projectFor(meta.cwd);
        agent = meta.agent;
      } else if (body.project) {
        if (!project || !access.canSeeProject(project.slug)) throw new HttpError(404, 'No such project.');
        if (!access.canWorkInProject(project.slug)) throw new HttpError(403, READ_ONLY);
      } else if (!access.owner) {
        throw new HttpError(403, 'Say which thread this secret is for.');
      }
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const value = typeof body.value === 'string' ? body.value : '';
      const purpose = typeof body.purpose === 'string' && body.purpose.trim() ? body.purpose.trim() : 'Pasted from a thread';
      const who = body.who === 'project' ? 'project' : body.who === 'agent' ? 'agent' : 'keep';
      let use: SecretUse | undefined;
      if (who === 'project') {
        if (!project) throw new HttpError(400, 'This isn’t in a project.');
        use = { who, project: project.slug, ...(agent && { agent }) };
      } else if (who === 'agent') {
        if (!agent) throw new HttpError(400, 'There isn’t an agent to keep it for.');
        use = { who, agent, ...(project && { project: project.slug }) };
      }
      const ref = saveSecret(name, value, purpose, use, access.person.name);
      return sendJson(res, 201, { ref, name });
    }

    if (req.method === 'POST' && parts[1] === 'questions' && parts[2] && (parts.length === 3 || (parts.length === 4 && parts[3] === 'claim'))) {
      const stored = polyphemus.store.question(parts[2]);
      if (!stored) throw new HttpError(404, 'No such question.');
      workableSession(stored.sessionId);
      const me = access.actor;
      if (stored.status !== 'open') {
        throw new HttpError(409, stored.status === 'answered' ? `Already answered by ${actorLabel(stored.answeredBy, access)}.` : `It can’t be answered any more: ${stored.expiredWhy ?? 'it expired.'}`);
      }
      if (parts[3] === 'claim') {
        if (body.release === true) {
          polyphemus.store.releaseQuestion(stored.id, me);
          broadcast({ type: 'question_claimed', id: stored.id, sessionId: stored.sessionId, by: null, at: null });
          return sendJson(res, 200, { claimedBy: null });
        }
        // Soft: taking it over from someone is allowed, and recorded — but only when you mean to.
        if (stored.claimedBy && stored.claimedBy !== me && body.takeOver !== true) {
          throw new HttpError(409, `${actorLabel(stored.claimedBy, access)} is handling this. Take it over if you mean to.`);
        }
        const { previous } = polyphemus.store.claimQuestion(stored.id, me);
        const at = Date.now();
        opts.log?.(`${access.person.name} ${previous ? 'took over' : 'claimed'} question ${stored.id}`);
        broadcast({ type: 'question_claimed', id: stored.id, sessionId: stored.sessionId, by: me, at, tookOverFrom: previous ?? null });
        return sendJson(res, 200, { claimedBy: me, tookOverFrom: previous ?? null });
      }
      if (stored.claimedBy && stored.claimedBy !== me) {
        throw new HttpError(409, `${actorLabel(stored.claimedBy, access)} is handling this. Take it over first if you mean to answer it.`);
      }
      if (stored.kind === 'gate') {
        const answer = body.answer === 'approve' ? 'approve' : 'decline';
        const picked = Array.isArray(body.picked) ? body.picked.filter((x: unknown): x is string => typeof x === 'string') : undefined;
        let recorded: boolean;
        try {
          recorded = runs.answerGate(stored, answer, me, typeof body.note === 'string' ? clip(body.note.trim(), 300) : undefined, picked);
        } catch (err) {
          if (err instanceof RunError) throw new HttpError(err.status, err.message);
          throw err;
        }
        if (!recorded) {
          throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
        }
        return sendJson(res, 200, { ok: true });
      }
      if (stored.kind === 'invite') {
        // Saying yes brings an agent in: the same rule as bringing one in by hand (third review, 2026-09-19).
        if (body.answer === 'bring') {
          const wanted = agentNamed(String(stored.detail.agentId));
          const why = wanted ? cantBringIn(access, wanted, stored.sessionId) : 'That agent is gone.';
          if (why) throw new HttpError(403, why);
        }
        const answered = answerInvite(stored, body.answer === 'bring' ? 'bring' : 'dismiss', me);
        if (!answered.ok) throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
        return sendJson(res, 200, { ok: true, ...(answered.thread && { thread: answered.thread }) });
      }
      if (stored.kind === 'guard') {
        const answer = body.answer === 'always' ? 'always' : body.answer === 'continue' ? 'continue' : 'stop';
        if (!answerGuard(stored, answer, me)) throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
        return sendJson(res, 200, { ok: true });
      }
      if (stored.kind === 'skill') {
        const places = (stored.detail.places ?? []) as string[];
        const answer = typeof body.answer === 'string' && places.includes(body.answer) ? body.answer : 'decline';
        if (answer !== 'decline') {
          const project = stored.detail.project ? polyphemus.store.project(String(stored.detail.project)) : undefined;
          // A project's skills are its people's to add; an agent's own, or every agent's, the owner's.
          const allowed = answer === 'project' ? Boolean(project) && access.canWorkInProject(project!.slug) : access.owner;
          if (!allowed) throw new HttpError(403, answer === 'project' ? 'Only someone who works in the project can keep a skill there.' : OWNER_ONLY);
          const agent = agentNamed(String(stored.detail.agent));
          if (answer === 'agent' && !agent) throw new HttpError(404, 'That agent is gone.');
          const dir = answer === 'agent' ? agentSkillsDir(agent!.dir) : answer === 'project' ? projectSkillsDir(project!.path) : librarySkillsDir(polyphemus.home);
          const file = (() => {
            try {
              // Written from a folder the agent can't replace: the project's (or the project agent's), or polyphemus's home.
              // The destination's own root: the library and a library agent's are polyphemus's home.
              const root = answer === 'project' ? project!.path : answer === 'agent' ? (agent?.root ?? polyphemus.home) : polyphemus.home;
              const name = String(stored.detail.name);
              // A revision of a skill that's already there replaces it once the person says so; the old
              // one is moved aside, not deleted (it used to fail only after Accept, with no way on).
              if (body.replace === true && existsInside(root, join(dir, name, 'SKILL.md'))) {
                const aside = join(polyphemus.home, 'trash', 'skills', `${name}-${Date.now()}`);
                mkdirSync(dirname(aside), { recursive: true });
                moveOutInside(root, join(dir, name), aside);
              }
              return writeSkill(dir, name, String(stored.detail.description), String(stored.detail.body), root);
            } catch (err) {
              throw new HttpError(err instanceof PolyphemusError && err.code === 'CONFLICT' ? 409 : 400, (err as Error).message);
            }
          })();
          if (!polyphemus.store.answerQuestion(stored.id, answer, me)) throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
          opts.log?.(`Kept ${String(stored.detail.agentTitle)}’s skill ${String(stored.detail.name)} (${answer}): ${file}`);
          broadcast({ type: 'skills_changed' });
        } else if (!polyphemus.store.answerQuestion(stored.id, 'decline', me)) {
          throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
        }
        broadcast({ type: 'question_resolved', id: stored.id, sessionId: stored.sessionId, by: me, answer });
        return sendJson(res, 200, { ok: true });
      }
      if (stored.kind === 'note') {
        const scopes = (stored.detail.scopes ?? []) as MemoryScope[];
        const answer = typeof body.answer === 'string' && scopes.includes(body.answer as MemoryScope) ? (body.answer as MemoryScope) : 'decline';
        if (answer !== 'decline') {
          const agent = String(stored.detail.agent);
          const project = stored.detail.project ? polyphemus.store.project(String(stored.detail.project)) : undefined;
          // Kept where anyone in the project can recall it: theirs to accept. Kept with an agent: the owner's.
          const allowed = answer === 'project' ? Boolean(project) && access.canWorkInProject(project!.slug) : access.owner;
          if (!allowed) throw new HttpError(403, answer === 'project' ? 'Only someone who works in the project can keep this there.' : OWNER_ONLY);
          // Private memory belongs to the person it was told to, so only they can keep it.
          if (answer === 'private' && stored.detail.person !== access.person.id) throw new HttpError(403, 'Only the person it was told to can keep a private memory.');
          if (!polyphemus.store.answerQuestion(stored.id, answer, me)) throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
          const folder =
            answer === 'private' ? privateMemoryDir(polyphemus.home, agent, String(stored.detail.person))
            : answer === 'craft' ? craftMemoryDir(polyphemus.home, agent)
            : join(memoryDir(polyphemus.home, project!.slug), 'notes');
          const file = writeMemoryNote(folder, String(stored.detail.name), String(stored.detail.description), String(stored.detail.text), join(polyphemus.home, 'memory'));
          opts.log?.(`Remembered ${String(stored.detail.name)} (${answer}) for ${String(stored.detail.agentTitle)}: ${file}`);
        } else if (!polyphemus.store.answerQuestion(stored.id, 'decline', me)) {
          throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
        }
        broadcast({ type: 'question_resolved', id: stored.id, sessionId: stored.sessionId, by: me, answer });
        return sendJson(res, 200, { ok: true });
      }
      if (stored.kind === 'profile') {
        const answer = body.answer === 'accept' ? 'accept' : 'decline';
        if (answer === 'accept') {
          const agent = agentNamed(String(stored.detail.agent));
          if (!agent) throw new HttpError(404, 'That agent is gone.');
          // Whose profile it is decides who accepts: a project's agent, the people who work there; the library's, the owner.
          const allowed = agent.scope === 'project' && agent.project ? access.canWorkInProject(agent.project) : access.owner;
          if (!allowed) throw new HttpError(403, agent.scope === 'project' ? 'Only someone who works in the project can accept this.' : OWNER_ONLY);
          if (!polyphemus.store.answerQuestion(stored.id, answer, me)) throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
          const fields = (stored.detail.fields ?? []) as Array<{ field: 'persona' | 'instructions' | 'description'; after: string }>;
          updateAgent(agent, Object.fromEntries(fields.map((f) => [f.field, f.after])));
          opts.log?.(`${agent.title}: ${fields.map((f) => f.field).join(', ')} accepted by ${access.person.name}`);
        } else if (!polyphemus.store.answerQuestion(stored.id, answer, me)) throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
        broadcast({ type: 'question_resolved', id: stored.id, sessionId: stored.sessionId, by: me, answer });
        return sendJson(res, 200, { ok: true });
      }
      if (stored.kind === 'routine') {
        const answer = body.answer === 'accept' ? 'accept' : 'decline';
        const slug = String(stored.detail.project ?? '');
        const project = slug ? polyphemus.store.project(slug) : undefined;
        const name = String(stored.detail.name);
        // Where it will live: its project's folder, or polyphemus's own when the thread is in no project.
        const file = project ? join(projectStateDir(project.path), 'routines', `${name}.md`) : homeRoutineFile(polyphemus.home, name);
        if (answer === 'accept') {
          // A routine runs unattended: in a project, whoever accepts must be able to work there; with
          // no project it's the install's own, which is the owner's to allow.
          if (slug ? !project || !access.canWorkInProject(project.slug) : !access.owner)
            throw new HttpError(403, slug ? 'Only someone who works in the project can accept a routine for it.' : 'Only the owner of this install can accept a routine that belongs to no project.');
          // One that runs without asking is the owner's to allow, wherever it lives (as when it's edited).
          if (stored.detail.mode === 'yolo' && !access.owner) throw new HttpError(403, 'It runs without asking, so only the owner of this install can accept it.');
          if (stored.detail.stop === true || stored.detail.replaces === true) {
            // Stopping, or changing: the one there now goes to the trash rather than being deleted.
            if (!existsSync(file) && stored.detail.stop === true) throw new HttpError(409, `There’s no routine called ${name} there any more.`);
            if (existsSync(file)) {
              const aside = join(polyphemus.home, 'trash', 'routines', `${project?.slug ?? '~'}--${name}-${Date.now()}.md`);
              mkdirSync(dirname(aside), { recursive: true });
              moveOutInside(project?.path ?? polyphemus.home, file, aside);
            }
          }
          if (stored.detail.stop === true) {
            if (!polyphemus.store.answerQuestion(stored.id, answer, me)) throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
            opts.log?.(`${project?.name ?? 'Outside every project'}: routine ${name} stopped by ${access.person.name}`);
            broadcast({ type: 'question_resolved', id: stored.id, sessionId: stored.sessionId, by: me, answer });
            return sendJson(res, 200, { ok: true, stopped: name });
          }
          const text = String(stored.detail.text);
          if (existsSync(file)) throw new HttpError(409, `There’s already a routine called ${name} ${project ? `in ${project.name}` : 'outside every project'}.`);
          // Checked again as it's written: what's accepted is exactly what was shown.
          try {
            parseRoutine(text, file, project ? { project } : {});
          } catch (err) {
            throw new HttpError(400, (err as Error).message);
          }
          if (!polyphemus.store.answerQuestion(stored.id, answer, me)) throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
          createInside(project?.path ?? polyphemus.home, file, Buffer.from(text));
          polyphemus.store.updateRoutineState(`${project?.slug ?? '~'}/${name}`, { acceptedDigest: routineDigest(text) });
          opts.log?.(`${project?.name ?? 'Outside every project'}: routine ${name} accepted by ${access.person.name}`);
        } else if (!polyphemus.store.answerQuestion(stored.id, answer, me)) throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
        broadcast({ type: 'question_resolved', id: stored.id, sessionId: stored.sessionId, by: me, answer });
        return sendJson(res, 200, { ok: true, ...(answer === 'accept' && { file }) });
      }
      if (stored.kind === 'incoming') {
        const answer = body.answer === 'work' ? 'work' : 'dismiss';
        if (answer === 'work') {
          // Started before it's marked answered: if it can't start, the card stays for another try.
          try {
            runs.startWorkflow(stored.sessionId, intakeWorkflow, { text: String(stored.detail.text), kind: String(stored.detail.kind) }, me);
          } catch (err) {
            if (err instanceof RunError) throw new HttpError(err.status, err.message);
            throw err;
          }
        }
        if (!polyphemus.store.answerQuestion(stored.id, answer, me)) throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
        if (answer === 'dismiss') {
          polyphemus.store.setArchived(stored.sessionId, true);
          broadcast({ type: 'session_changed', sessionId: stored.sessionId, archived: true });
        }
        broadcast({ type: 'question_resolved', id: stored.id, sessionId: stored.sessionId, by: me, answer });
        broadcast({ type: 'work_changed', sessionId: stored.sessionId });
        return sendJson(res, 200, { ok: true, id: stored.sessionId });
      }
      if (stored.kind === 'outcome') {
        const answer = body.answer === 'track' ? 'track' : 'decline';
        if (!polyphemus.store.answerQuestion(stored.id, answer, me)) throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
        if (answer === 'track') {
          const agent = typeof stored.detail.agent === 'string' ? `agent:${stored.detail.agent}` : me;
          polyphemus.store.runs.setOutcome(stored.sessionId, String(stored.detail.text), agent, me);
        }
        broadcast({ type: 'question_resolved', id: stored.id, sessionId: stored.sessionId, by: me, answer });
        broadcast({ type: 'work_changed', sessionId: stored.sessionId });
        return sendJson(res, 200, { ok: true });
      }
      if (stored.kind === 'secret') {
        // The value stays in this request. The question, the event, and the model hear only saved or decline.
        const pending = live.get(stored.sessionId)?.questions.get(stored.id);
        if (!pending) {
          polyphemus.store.expireQuestion(stored.id, 'The turn it belonged to stopped: it was stopped, or polyphemus restarted.');
          broadcast({ type: 'question_resolved', id: stored.id, sessionId: stored.sessionId, by: null, answer: null });
          throw new HttpError(409, 'It can’t be answered any more: the turn that asked has stopped (someone stopped it, or polyphemus restarted). Ask the agent again if it’s still needed.');
        }
        if (body.answer === 'decline') {
          pending.answer('decline', me);
          if (polyphemus.store.question(stored.id)?.answeredBy !== me) {
            throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
          }
          return sendJson(res, 200, { ok: true });
        }
        const value = typeof body.value === 'string' ? body.value : '';
        const scopes = Array.isArray(stored.detail.scopes) ? stored.detail.scopes.map(String) : [];
        const who = body.who === 'project' ? 'project' : body.who === 'agent' ? 'agent' : '';
        let use: SecretUse | undefined;
        if (scopes.length > 0) {
          if (who !== 'agent' && who !== 'project') throw new HttpError(400, 'Say who may use it.');
          if (!scopes.includes(who)) throw new HttpError(400, 'That isn’t a choice for this secret.');
          use = who === 'project' ? { who, project: String(stored.detail.project) } : { who, agent: String(stored.detail.agent), ...(stored.detail.project ? { project: String(stored.detail.project) } : {}) };
        }
        const ref = saveSecret(String(stored.detail.name), value, String(stored.detail.purpose ?? ''), use, access.person.name);
        pending.answer('saved', me);
        if (polyphemus.store.question(stored.id)?.answeredBy !== me) {
          throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
        }
        return sendJson(res, 200, { ok: true, ref });
      }
      if (stored.kind === 'signin') {
        const pending = live.get(stored.sessionId)?.questions.get(stored.id);
        if (!pending) {
          // Nothing is waiting on it any more, so this is housekeeping: the card goes, without an
          // error the person can do nothing about (2026-09-22, a card that couldn't be cleared).
          polyphemus.store.expireQuestion(stored.id, 'The turn it belonged to stopped: it was stopped, or polyphemus restarted.');
          broadcast({ type: 'question_resolved', id: stored.id, sessionId: stored.sessionId, by: null, answer: null });
          return sendJson(res, 200, { ok: true, dismissed: true, why: 'The turn that asked for this had already stopped, so the card is closed. Ask the agent again if it’s still needed.' });
        }
        if (body.answer === 'decline') {
          pending.answer('decline', me);
          if (polyphemus.store.question(stored.id)?.answeredBy !== me) throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
          return sendJson(res, 200, { ok: true });
        }
        if (body.answer !== 'done') throw new HttpError(400, 'Sign in, then say you’re done — or decline.');
        const outcome = signInOutcome(stored, access.person.id);
        pending.heldBack = outcome.heldBack;
        pending.answer('signed-in', me);
        if (polyphemus.store.question(stored.id)?.answeredBy !== me) throw new HttpError(409, `Already answered by ${actorLabel(polyphemus.store.question(stored.id)?.answeredBy, access)}.`);
        return sendJson(res, 200, { ok: true, ...(outcome.heldBack && { heldBack: outcome.heldBack }) });
      }
      const pending = live.get(stored.sessionId)?.questions.get(stored.id);
      if (!pending) {
        // Open in the database, with no turn waiting on it: the daemon restarted. Say so, once.
        polyphemus.store.expireQuestion(stored.id, 'The turn it belonged to stopped: it was stopped, or polyphemus restarted.');
        broadcast({ type: 'question_resolved', id: stored.id, sessionId: stored.sessionId, by: null, answer: null });
        throw new HttpError(409, 'It can’t be answered any more: the turn that asked has stopped (someone stopped it, or polyphemus restarted). Ask the agent again if it’s still needed.');
      }
      pending.answer(typeof body.answer === 'string' ? body.answer : undefined, me);
      if (polyphemus.store.question(stored.id)?.answeredBy !== me) {
        const winner = polyphemus.store.question(stored.id);
        throw new HttpError(409, `Already answered by ${actorLabel(winner?.answeredBy, access)}.`);
      }
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Not found.');
  }

  function events(req: IncomingMessage, res: ServerResponse, device: DeviceMeta): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.set(res, { deviceId: device.id, person: requirePerson(device), seen: new Map() });
    req.on('close', () => clients.delete(res));
  }

  /**
   * Ends the stream of any device that's no longer paired. A stream is authenticated once, when it
   * opens, so without this a revoked phone kept receiving every event until it disconnected on its
   * own (assessment, 2026-09-12). `poly devices revoke` runs in another process and only writes
   * the database, so this checks on a timer rather than waiting to be told.
   */
  function dropRevokedStreams(): void {
    if (clients.size === 0 && screenViews.size === 0) return;
    const paired = new Map(polyphemus.store.listDevices().filter((d) => !d.revokedAt).map((d) => [d.id, d]));
    // An agent's computer is the owner's alone to open: a view closes when its device is signed out,
    // or its person removed or no longer the owner — not when it happens to disconnect.
    for (const [view, deviceId] of screenViews) {
      const device = paired.get(deviceId);
      const person = device ? personOf(device) : undefined;
      if (person && polyphemus.store.person(person.id)?.owner) continue;
      screenViews.delete(view);
      view.terminate();
      opts.log?.(`Closed the computer view of device ${deviceId}: it’s no longer the owner’s`);
    }
    for (const [client, stream] of clients) {
      const { deviceId } = stream;
      // Roles and people change from the CLI too: forget what this stream could see, and look again.
      stream.access = undefined;
      stream.seen.clear();
      const device = paired.get(deviceId);
      const person = device ? personOf(device) : undefined;
      if (person) stream.person = person;
      // Gone with their person, not only when the device row is revoked: a device left behind must not keep the stream.
      if (deviceId === LOCAL_CLIENT.id || person) continue;
      clients.delete(client);
      client.end();
      opts.log?.(`Closed the event stream of revoked device ${deviceId}`);
    }
  }

  /** Times of recent wrong pairing codes, to stop anyone guessing. */
  const pairFailures: number[] = [];

  function pair(req: IncomingMessage, res: ServerResponse, code: string): void {
    const now = Date.now();
    while (pairFailures.length > 0 && pairFailures[0]! < now - PAIR_FAILURE_WINDOW_MS) pairFailures.shift();
    if (pairFailures.length >= MAX_PAIR_FAILURES) {
      return sendHtml(res, 429, pairPage('Too many wrong codes', 'Pairing is paused for a few minutes. Then run <code>poly pair</code> for a fresh code.'));
    }
    const paired = code ? polyphemus.store.redeemPairingCode(code, deviceName(req.headers['user-agent'])) : undefined;
    if (!paired) {
      pairFailures.push(now);
      return sendHtml(res, 403, pairPage('That code didn’t work', 'It may have expired or already been used. Run <code>poly pair</code> on your computer for a new one.'));
    }
    // Lax, not Strict: Strict cookies get dropped when the page was opened from another app (a camera, a
    // home-screen launch). Cross-site POSTs are refused separately (see route), so Lax gives nothing away.
    // Secure whenever the page came over HTTPS (Tailscale's serve proxy forwards to plain http here),
    // so the cookie is never sent in the clear. Not on plain http: a browser would drop it, and
    // pairing over the local address would silently fail.
    const secure = overHttps(req) ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${paired.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`);
    res.writeHead(303, { Location: '/' }).end();
    opts.log?.(`Paired: ${paired.device.name} (${paired.device.id})`);
  }

  function overHttps(req: IncomingMessage): boolean {
    if (String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https') return true;
    try {
      return httpsUrl !== undefined && new URL(httpsUrl).host === req.headers.host;
    } catch {
      return false;
    }
  }

  /** The people who may answer a thread's questions (settled brief §7: "shows who else can act"). */
  function whoCanAnswer(sessionId: string, everyone = polyphemus.store.people()): string[] {
    const meta = polyphemus.store.get(sessionId);
    return meta ? everyone.filter((p) => new Access(polyphemus.store, p).canWorkInSession(meta)).map((p) => p.id) : [];
  }

  /** "Sam", or "you", for an actor string. */
  function actorLabel(actor: string | undefined, access: Access): string {
    if (!actor) return 'someone';
    if (actor === access.actor) return 'you';
    if (actor.startsWith('person:')) return polyphemus.store.person(actor.slice(7))?.name ?? 'someone';
    return 'someone';
  }

  /**
   * Who a device acts as. The terminal on this computer is the install owner, and so is a device
   * from before people existed (no person id). A device whose person is gone is nobody: it must not
   * fall open to the owner.
   */
  function personOf(device: DeviceMeta): Person | undefined {
    if (device.id === LOCAL_CLIENT.id) return polyphemus.store.installOwner();
    return polyphemus.store.personForDevice(device);
  }

  /** A device that still has a person. One that doesn't is signed out. */
  function requirePerson(device: DeviceMeta): Person {
    const person = personOf(device);
    if (!person) throw new HttpError(401, 'This device isn’t paired. Run `poly pair` on your computer and scan the code.');
    return person;
  }

  function authenticate(req: IncomingMessage): DeviceMeta | undefined {
    const bearer = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
    if (bearer) return sameSecret(bearer, localToken) ? LOCAL_CLIENT : undefined;
    const token = cookieValue(req.headers.cookie, COOKIE);
    const device = token ? polyphemus.store.deviceForToken(token) : undefined;
    if (!device || !personOf(device)) return undefined;
    return device;
  }

  const answered = new Map<string, Promise<Answer>>();

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://polyphemus.invalid');
    const path = url.pathname;
    securityHeaders(res);
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) takesGzip.add(res);
    if (path.startsWith('/api/')) noticeConfigChange();
    // Only this app's own pages may change anything: a POST from any other site is refused outright.
    if (req.method === 'POST' && !sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-site request refused.' });
    if (req.method === 'GET' && path === '/pair') return pair(req, res, url.searchParams.get('code') ?? '');
    if (req.method === 'GET' && PUBLIC_FILES.has(path.slice(1))) return serveFile(res, path.slice(1));

    const device = authenticate(req);
    if (!device) {
      if (path.startsWith('/api/')) return sendJson(res, 401, { error: 'This device isn’t paired. Run `poly pair` on your computer and scan the code.' });
      return sendHtml(res, 401, pairPage('Pair this device', 'On your computer, run <code>poly pair</code>. Type the code it shows here, or scan its QR code with your camera.'));
    }
    // An action sent again with the same key — the app's retry after the network blinked — gets the
    // first one's answer, once that's in, instead of being done a second time. Per device, for ten minutes.
    const key = req.method !== 'GET' ? req.headers['idempotency-key'] : undefined;
    if (typeof key === 'string' && key) {
      const id = `${device.id}:${key.slice(0, 100)}`;
      const first = answered.get(id);
      if (first) {
        const answer = await first;
        res.writeHead(answer.status, answer.headers);
        return void res.end(answer.body);
      }
      answered.set(id, recordAnswer(res));
      setTimeout(() => answered.delete(id), 10 * 60_000).unref();
      // Bounded, whatever a client sends: the oldest go first.
      if (answered.size > 1000) answered.delete(answered.keys().next().value!);
    }
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) return serveFile(res, 'index.html');
    if (req.method === 'GET' && path === '/app.js') return serveFile(res, 'app.js');
    // The emoji a message box offers, and reactions accept: every one, trimmed to what the picker needs.
    if (req.method === 'GET' && path === '/api/emoji') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, max-age=86400' });
      return void res.end(emojiList());
    }
    // noVNC, the viewer for an agent's computer: its own modules, served as they ship.
    if (req.method === 'GET' && path.startsWith('/vendor/novnc/')) return serveNoVnc(res, path.slice('/vendor/novnc/'.length));
    // Back from GitHub, making or installing one of polyphemus's GitHub App identities.
    if (req.method === 'GET' && (path === '/github/app-created' || path === '/github/app-installed')) {
      try {
        const to = await connectionApi.githubCallback(url, new Access(polyphemus.store, requirePerson(device)));
        res.writeHead(302, { Location: to });
        res.end();
        return;
      } catch (err) {
        return sendHtml(res, err instanceof HttpError ? err.status : 400, notice('GitHub identity not set up', (err as Error).message.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`), '<p><a href="/#/connections">Back to connections</a></p>'));
      }
    }
    // Back from signing in to a connection's service.
    if (req.method === 'GET' && path === '/oauth/callback') {
      try {
        const back = await connectionApi.oauthCallback(url, new Access(polyphemus.store, requirePerson(device)));
        // Where to land — the thread whose card started this, or the connection — is decided with the sign-in.
        res.writeHead(302, { Location: back.redirect });
        res.end();
        return;
      } catch (err) {
        return sendHtml(res, err instanceof HttpError ? err.status : 400, notice('Not signed in', (err as Error).message.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`), '<p><a href="/#/connections">Back to connections</a></p>'));
      }
    }
    // Images travel as their own bytes, not inside JSON.
    if (req.method === 'POST' && path === '/api/images') return uploadImage(req, res, device);
    if (req.method === 'POST' && path === '/api/files') return uploadFile(req, res, device);
    if (req.method === 'POST' && /^\/api\/agents\/[^/]+\/computer\/files$/.test(path)) return uploadToComputer(req, res, device, decodeURIComponent(path.split('/')[3]!));
    if (req.method === 'GET' && path.startsWith('/api/images/')) return serveUpload(res, path.slice('/api/images/'.length), device);
    if (req.method === 'GET' && /^\/artifacts\/[0-9a-f]{16}\/(file|frame|download)$/.test(path)) {
      const [, , id, how] = path.split('/');
      return serveArtifact(res, id!, device, how as 'file' | 'frame' | 'download');
    }
    if (path.startsWith('/api/')) {
      if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return sendJson(res, 415, { error: 'Send JSON.' });
      }
      return api(req, res, path, device);
    }
    sendJson(res, 404, { error: 'Not found.' });
  }

  const handler = (req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((err: unknown) => {
      const status =
        err instanceof HttpError ? err.status
        : err instanceof PolyphemusError ? ({ NOT_FOUND: 404, CONFLICT: 409 } as Record<string, number>)[err.code] ?? 400
        : 500;
      if (!res.headersSent) sendJson(res, status, { error: (err as Error).message });
      else res.end();
    });
  };

  /**
   * An agent's computer's screen, over a WebSocket: the VNC stream from its socket, passed through
   * unchanged. Paired devices only, from this app's own pages, and the owner only — for now, taking
   * over is the only way to look (members watching comes with the agent's hands, desktop.md D2).
   */
  // The Computer's tools grow as polyphemus does, and "can use it" means all of them: on start, its
  // tool list is read again and each agent's grant widened to match.
  void (async () => {
    const computer = polyphemus.connections.list().find((c) => c.server.kind === 'builtin' && c.server.builtin === 'computer');
    if (!computer) return;
    const fresh = await polyphemus.connections.test(computer.id).catch(() => undefined);
    if (!fresh) return;
    const all = fresh.tools.map((t) => t.name);
    for (const grant of polyphemus.store.connections.grants(computer.id)) {
      if (all.some((tool) => !grant.tools.includes(tool))) polyphemus.connections.grant({ connection: computer.id, project: grant.project || undefined, agent: grant.agent || undefined, tools: all, by: grant.by });
    }
  })();

  // An agent working its computer: the app offers to show it, so you can watch what it does.
  polyphemus.connections.onCall((call) => {
    const c = polyphemus.connections.list().find((one) => one.id === call.connection);
    if (c?.server.kind === 'builtin' && c.server.builtin === 'computer' && call.ctx.agent && call.outcome === 'ok') broadcast({ type: 'computer', agent: call.ctx.agent, state: 'awake', active: true, sessionId: call.ctx.sessionId ?? null });
  });

  /** Open views of agents' computers, with the device each was opened from. */
  const screenViews = new Map<import('ws').WebSocket, string>();
  const screens = new WebSocketServer({ noServer: true, handleProtocols: (offered) => (offered.has('binary') ? 'binary' : false) });
  async function computerScreen(req: IncomingMessage, socket: import('node:net').Socket, head: Buffer): Promise<void> {
    const refuse = (status: number) => {
      socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Not Found'}\r\n\r\n`);
    };
    const match = /^\/api\/agents\/([^/]+)\/computer\/screen$/.exec(new URL(req.url ?? '/', 'http://polyphemus.invalid').pathname);
    if (!match) return refuse(404);
    const device = authenticate(req);
    if (!device) return refuse(401);
    if (!sameOrigin(req) || !req.headers.origin) return refuse(403);
    const access = new Access(polyphemus.store, requirePerson(device));
    let name: string;
    try {
      name = decodeURIComponent(match[1]!);
    } catch {
      return refuse(404);
    }
    const agent = agentNamed(name);
    if (!agent || !access.owner) return refuse(403);
    let vnc: import('node:net').Socket;
    try {
      vnc = await polyphemus.desktops.screen(agent.id);
    } catch {
      return refuse(404);
    }
    screens.handleUpgrade(req, socket, head, (ws) => {
      screenViews.set(ws, device.id);
      ws.on('message', (data: Buffer) => {
        if (!screenViews.has(ws)) return;
        polyphemus.desktops.touch(agent.id);
        vnc.write(data);
      });
      vnc.on('data', (chunk) => ws.readyState === ws.OPEN && ws.send(chunk));
      const end = () => {
        screenViews.delete(ws);
        vnc.destroy();
        ws.close();
        // Nobody can hold it without watching it: closing the view gives it back.
        if (polyphemus.desktops.heldBy(agent.id) === access.person.name) polyphemus.desktops.hold(agent.id, undefined);
      };
      ws.on('close', end);
      vnc.on('close', end);
      vnc.on('error', end);
      opts.log?.(`${access.person.name} opened ${agent.title}’s computer`);
    });
  }

  const servers: Server[] = [];
  const urls: string[] = [];
  let port = opts.port ?? DEFAULT_PORT;
  async function listen(host: string): Promise<void> {
    const server = createServer(handler);
    // An upgrade that fails in any way is refused, never left to take the daemon down with it.
    server.on('upgrade', (req, socket, head) =>
      computerScreen(req, socket as import('node:net').Socket, head).catch((err: Error) => {
        opts.log?.(`Refused a computer view: ${err.message}`);
        if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      }),
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    // With port 0, the first server picks a free port and the others share it.
    const address = server.address();
    if (address && typeof address === 'object') port = address.port;
    servers.push(server);
    urls.push(`http://${host}:${port}`);
  }
  // Tell every device, once per window, when a provider starts heading for running out before it
  // resets. "Once" has to survive a restart: the daemon restarts on every deploy, and keeping
  // this in memory meant each one repeated the same warning.
  const checkForecasts = async () => {
    // The first check is on a timer that outlives a quick close.
    if (closing) return;
    // Free to ask, so ask before looking: codex's logs and Claude Code's /usage both cost
    // nothing and both carry work done outside polyphemus.
    await polyphemus.refreshCliUsage({ ask: true }).catch(() => {});
    // Asking can take a while, and the daemon (and its store) may have closed meanwhile.
    if (closing) return;
    for (const f of polyphemus.forecasts()) {
      if (f.status !== 'short') continue;
      const alerted = polyphemus.store.forecastAlertedFor(f.provider, f.window);
      if (alerted !== undefined && alerted === (f.resetsAt ?? null)) continue;
      polyphemus.store.recordForecastAlert(f.provider, f.window, f.resetsAt);
      opts.log?.(`${f.provider} ${f.window}: ${describeForecast(f)}`);
      notify({ title: `${f.provider} may run out early`, body: `Its ${f.window} window: ${describeForecast(f)}.`, url: '/#/you', tag: `forecast-${f.provider}-${f.window}` }, { kind: 'questions' });
    }
  };
  const forecastTimer = setInterval(() => void checkForecasts(), 5 * 60_000);
  // Once at startup too, so a reading that froze while the daemon was down is refreshed now.
  setTimeout(() => void checkForecasts(), 10_000).unref();
  forecastTimer.unref();

  // Held messages outlive a restart: whatever was waiting when polyphemus stopped goes now.
  const heldAtStart = setTimeout(() => {
    if (closing) return;
    for (const sessionId of new Set(polyphemus.store.queuedMessages().map((q) => q.sessionId))) drainQueue(sessionId);
  }, 1000);
  heldAtStart.unref();

  // Created before listening, so the first request already has routines to report.
  const scheduler = startScheduler(
    polyphemus,
    {
      start: (routine, model, title) => {
        const { agent, model: routed } = routineRoute(routine, model);
        const meta = polyphemus.store.create({ title, provider: routed.provider, model: routed.model, cwd: routine.cwd, agent: agent?.id, startedBy: `routine:${routine.id}` });
        const entry = liveSession(meta.id, routed)!;
        entry.runtime.sender = `routine:${routine.id}`;
        entry.runtime.autoApprove = routine.mode === 'yolo';
        if (entry.runtime.autoApprove) polyphemus.store.setYolo(meta.id, true);
        entry.runtime.readOnly = routine.mode === 'read-only';
        const done = startTurn(entry, routine.prompt, { quiet: true }).then(({ stop, error }) =>
          error
            ? { ok: false, reason: error }
            : stop === 'end_turn'
              ? { ok: true, reply: lastReply(entry.runtime) }
              : { ok: false, reason: stop === 'aborted' ? 'stopped before it finished' : `it ended with "${stop}"` },
        );
        return { sessionId: meta.id, done };
      },
      isRunning: (id) => live.get(id)?.running !== undefined,
      agentExists: (routine) => findAgent(polyphemus.home, routine.project ? polyphemus.store.project(routine.project)?.path : undefined, routine.agent, routine.project) !== undefined,
      notify: (title, body, kind, url) => notify({ title, body, url, tag: `routine-${title}` }, { kind, sessionId: /^\/#\/s\/([0-9a-f]+)/.exec(url)?.[1] }),
      log: (line) => opts.log?.(line),
    },
    { tickMs: opts.routineTickMs },
  );

  for (const host of opts.hosts) await listen(host);
  writeStatus();
  // Workflow runs a restart cut off carry on from their last finished node — once everything's up.
  const resumed = runs.resumeAfterRestart();
  if (resumed) opts.log?.(`Carrying on with ${resumed} workflow run${resumed === 1 ? '' : 's'} after the restart`);
  const keepAlive = setInterval(() => {
    for (const client of clients.keys()) client.write(': keep-alive\n\n');
  }, KEEPALIVE_MS);
  const revocationCheck = setInterval(dropRevokedStreams, opts.revocationCheckMs ?? REVOCATION_CHECK_MS);
  // A newer polyphemus? Asked at most once a day (the check keeps its own time); nothing about you is sent.
  const askForUpdates = () => void checkForUpdate(polyphemus.home, { enabled: polyphemus.config.updates.check, channel: polyphemus.config.updates.channel }).then((status) => {
    if (status.newer) opts.log?.(`polyphemus ${status.latest} is out (running ${status.current}): poly update`);
  });
  askForUpdates();
  // Computers left running by a daemon that didn't stop cleanly (a crash, a kill): asleep again.
  void polyphemus.desktops.sleepAll().then((n) => n && opts.log?.(`Put ${n} agent computer${n === 1 ? '' : 's'} left running to sleep.`)).catch(() => {});
  const updateTimer = setInterval(askForUpdates, 6 * 60 * 60 * 1000);
  updateTimer.unref();

  return {
    urls,
    listen,
    setHttpsUrl: (url) => {
      httpsUrl = url;
    },
    alert: (title, body) => notify({ title, body, url: '/', tag: 'polyphemus-alert' }, { kind: 'questions' }),
    routines: scheduler,
    close: async () => {
      closing = true;
      // Stopping takes the waiting turns with it; the questions say that, rather than "the turn stopped".
      // Runs first: a step whose turn is cut off here must read interrupted, not whatever the cut-off turn left.
      polyphemus.store.runs.interruptActive(RESTARTED);
      polyphemus.store.expireOpenQuestions('polyphemus restarted while this was waiting, so the turn it belonged to stopped.');
      clearInterval(keepAlive);
      clearInterval(revocationCheck);
      clearInterval(updateTimer);
      for (const viewer of screens.clients) viewer.terminate();
      // Agents' computers stop with the daemon: nothing would put them to sleep otherwise.
      await polyphemus.desktops.sleepAll().catch(() => 0);
      clearInterval(forecastTimer);
      scheduler.close();
      stopHearingConnections();
      rmSync(statusFile, { force: true });
      rmSync(tokenFile, { force: true });
      for (const client of clients.keys()) client.end();
      for (const entry of live.values()) {
        entry.running?.abort();
        // Agents answering alongside stop with it, so nothing outlives the daemon or its store.
        for (const aside of entry.asides?.values() ?? []) {
          aside.running.abort();
          aside.runtime.close();
        }
        entry.runtime.close();
      }
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    },
  };
}

/**
 * The headers on every response, kept in a JSON file so the browser smoke test serves exactly the
 * same ones — it couldn't catch a CSP violation while its fixture sent no CSP at all. no-referrer
 * also keeps a pairing code in the URL from leaking anywhere.
 */
const SECURITY_HEADERS = JSON.parse(readFileSync(assetPath('daemon', 'security-headers.json'), 'utf8')) as Record<string, string>;

function securityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

// Its package exports only rfb.js; the folder two up from that is noVNC's own.
/**
 * Every emoji, from emojibase: [character, name, group, search words], in the order phones show them.
 * Skin tones and bare components are left out; flags and the rest are in. Built once, then kept.
 */
let emojiCache: { json: string; canonical: Map<string, string> } | undefined;
/** The same emoji typed with or without the invisible "show as emoji" mark is the same emoji. */
const bareEmoji = (text: string) => text.replace(/\uFE0F/g, '');
function loadEmoji() {
  if (!emojiCache) {
    const data = createRequire(import.meta.url)('emojibase-data/en/compact.json') as Array<{ unicode: string; label: string; group?: number; order?: number; tags?: string[] }>;
    const list = data.filter((e) => e.group !== undefined && e.group !== 2).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    emojiCache = { json: JSON.stringify(list.map((e) => [e.unicode, e.label, e.group, (e.tags ?? []).join(' ')])), canonical: new Map(list.map((e) => [bareEmoji(e.unicode), e.unicode])) };
  }
  return emojiCache;
}
const emojiList = () => loadEmoji().json;
/** The one way polyphemus writes an emoji, however it was typed — or undefined when it isn't one. */
const canonicalEmoji = (text: string) => loadEmoji().canonical.get(bareEmoji(text));

const NOVNC_DIR = dirname(dirname(createRequire(import.meta.url).resolve('@novnc/novnc')));

/** A file of noVNC's, from its core and vendor folders only. */
async function serveNoVnc(res: ServerResponse, rel: string): Promise<void> {
  const clean = rel.split('/').filter((part) => part && part !== '..' && part !== '.').join('/');
  if (!/^(core|vendor)\/[\w./-]+\.js$/.test(clean)) return sendJson(res, 404, { error: 'Not found.' });
  const content = await readFile(join(NOVNC_DIR, clean)).catch(() => undefined);
  if (!content) return sendJson(res, 404, { error: 'Not found.' });
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'private, max-age=86400' });
  res.end(content);
}

async function serveFile(res: ServerResponse, name: string): Promise<void> {
  const content = await readFile(join(WEB_DIR, name));
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(name)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(content);
}

/** Responses whose browser takes gzip. A thread of a thousand messages is megabytes of JSON, over a phone's tailnet. */
const takesGzip = new WeakSet<ServerResponse>();

/** An action's first answer, kept so a retry of it gets that rather than doing it again. */
interface Answer {
  status: number;
  headers: Record<string, number | string | string[] | undefined>;
  body: Buffer;
}

/**
 * Records what a response sends as it's sent. Chrome cancels a request whenever this computer's
 * network changes — a Docker container starting is enough, and a busy one does that every few
 * seconds — so the app retries, and a retried action must not happen twice (2026-09-23).
 */
function recordAnswer(res: ServerResponse): Promise<Answer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let headed: Answer['headers'] = {};
    const take = (chunk: unknown) => {
      if (typeof chunk === 'string' || chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    };
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
    res.writeHead = ((...args: unknown[]) => {
      const given = args.find((a) => a && typeof a === 'object') as Answer['headers'] | undefined;
      if (given) headed = { ...headed, ...given };
      return writeHead(...args);
    }) as ServerResponse['writeHead'];
    res.write = ((chunk: unknown, ...rest: unknown[]) => (take(chunk), write(chunk, ...rest))) as ServerResponse['write'];
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (typeof chunk !== 'function') take(chunk);
      resolve({ status: res.statusCode, headers: { ...res.getHeaders(), ...headed }, body: Buffer.concat(chunks) });
      return end(chunk, ...rest);
    }) as ServerResponse['end'];
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  if (takesGzip.has(res) && body.length > 1024) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    res.end(gzipSync(body));
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function notice(title: string, body: string, extra = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>polyphemus</title><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/style.css"></head>
<body><main class="notice-page"><h1>${title}</h1><p>${body}</p>${extra}</main></body></html>`;
}

/** A notice with a box for the pairing code, so pairing works without leaving the installed app. */
function pairPage(title: string, body: string): string {
  return notice(
    title,
    body,
    `<form action="/pair" method="get" class="pair-form">
<input name="code" required autocomplete="one-time-code" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="ABC-DEF-GHJ" aria-label="Pairing code">
<button class="primary wide">Pair</button>
</form>`,
  );
}

/** A POST's Origin (sent by every current browser) must be this server's own address. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser (curl, tests); cookies still required
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readBytes(req: IncomingMessage, limit: number, tooLarge: string): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, tooLarge);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readBytes(req, MAX_BODY_BYTES, 'That message is too large.');
  if (bytes.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'That wasn’t valid JSON.');
  }
}

/** A browser's push subscription, checked before anything is sent to it. */
function pushSubscription(value: unknown): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const sub = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null | undefined;
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || typeof p256dh !== 'string' || typeof auth !== 'string') {
    throw new HttpError(400, 'That isn’t a push subscription.');
  }
  return { endpoint, keys: { p256dh, auth } };
}

/** The last thing the assistant said, flattened for a notification. */
function lastReply(runtime: SessionRuntime): string | undefined {
  const last = [...runtime.history].reverse().find((message) => message.role === 'assistant');
  const text = (last?.content ?? []).flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(' ');
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat ? clip(flat, 200) : undefined;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/** A friendly default name for a newly paired device. */
function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux computer';
  return 'Browser';
}

/** An attendance change in words: "Alex added Helm", "Sam became a viewer of the project". */
function attendanceWords(a: { kind: string; who: string; change: string; role?: string; byName: string | null; by?: string }): string {
  const by = a.byName ?? (a.by?.startsWith('routine:') ? 'A routine' : a.by?.startsWith('run:') ? 'A run' : null);
  if (a.kind === 'agent') {
    if (a.change === 'joined') return by ? `${by} added ${a.who}` : `${a.who} joined`;
    return by ? `${by} removed ${a.who}` : `${a.who} left (the agent was deleted)`;
  }
  // Brought into a conversation outside every project: there's no role, just who's in it.
  if (!a.role && a.change !== 'role') {
    if (a.change === 'joined') return by ? `${by} added ${a.who}` : `${a.who} joined`;
    return by ? `${by} took ${a.who} out of the conversation` : `${a.who} left the conversation`;
  }
  if (a.change === 'joined') return by ? `${by} gave ${a.who} access to the project, as a ${a.role}` : `${a.who} joined the project, as a ${a.role}`;
  if (a.change === 'role') return by ? `${by} made ${a.who} a ${a.role} of the project` : `${a.who} became a ${a.role} of the project`;
  return by ? `${by} removed ${a.who} from the project` : `${a.who} left the project`;
}

