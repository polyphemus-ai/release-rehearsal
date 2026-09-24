import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentSessionState } from '../agents/common.js';
import type { Artifact } from '../artifacts.js';
import { ConnectionStore } from '../connections/store.js';
import { RunStore } from '../runs/store.js';
import { windowLength } from '../forecast.js';
import { INTRODUCE_YOURSELF_OPENING } from '../roster.js';
import { quotaRetryMs } from '../quota.js';
import { isIsolationLevel, type IsolationLevel } from '../isolation/levels.js';
import { parseNetwork, type ProjectNetwork } from '../isolation/network.js';
import { PolyphemusError, type CapacityReading, type Message, type StopReason, type Usage } from '../types.js';

export interface SessionMeta {
  id: string;
  title: string;
  provider: string;
  model: string;
  cwd: string;
  /** The agent this session runs as, or "" for none (docs/design/agents.md). */
  agent: string;
  createdAt: number;
  updatedAt: number;
  /** When it was archived: off every list, still searchable, back the moment it's used. */
  archivedAt?: number;
  /** Who started it: `person:<id>` or `routine:<id>`. Absent on threads from before people. */
  startedBy?: string;
  /** Kept: a thread you come back to. Never leaves Home on its own. */
  kept?: boolean;
  /** When it was marked finished. It leaves Home a week later, and stays in search and its project. */
  finishedAt?: number;
  /** Why it stopped on its own and needs a person, while it does. */
  pausedWhy?: string;
  /** In a thread with several agents, the one that answers when nobody is named. Absent: the first in. */
  lead?: string;
  /** Agent-to-agent exchanges before polyphemus asks a person; 0 means don't ask here. Absent: the default. */
  guardLimit?: number;
  /** The thread this one was spun out of. */
  spunFrom?: string;
  /** With several people in it, agents answer every message rather than only when named. */
  agentsAnswerAll?: boolean;
  /** YOLO: every tool call in this thread runs without asking, until it's turned off. */
  yolo?: boolean;
}

/** A thread search found, and the words that matched, so a result says why it's there. */
export interface SessionMatch {
  meta: SessionMeta;
  /** A few words either side of the match in what was said, or undefined when only the title matched. */
  snippet?: string;
}

/**
 * Which shape of data this version writes. Changes to the schema only ever add (a table, a column
 * with a default), so an older polyphemus reads newer data and ignores what it doesn't know — which is
 * what makes going back a version safe. A change an older version would misread (a column dropped,
 * renamed or given a new meaning) raises this, and an older version then refuses to open the data
 * rather than writing into what it can't understand (docs/design/upgrades.md).
 */
export const DATA_GENERATION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  provider   TEXT NOT NULL,
  model      TEXT NOT NULL,
  cwd        TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  agent_state TEXT NOT NULL DEFAULT '{}',  -- per agent CLI: its native session id and how much it has seen
  agent      TEXT NOT NULL DEFAULT '',     -- the agent it runs as, if any
  archived_at INTEGER,                     -- set while archived
  started_by TEXT,                         -- who started it: person:<id>, routine:<id>; empty from before people
  kept       INTEGER NOT NULL DEFAULT 0,   -- a thread you come back to: never leaves Home on its own
  finished_at INTEGER,                     -- it ended: still openable, leaves Home after a week
  paused_why TEXT,                         -- it stopped on its own and needs a person
  lead       TEXT,                         -- the agent that answers when nobody's named
  guard_limit INTEGER,                     -- agent-to-agent exchanges before asking; 0 = don't ask here
  spun_from  TEXT,                         -- the thread it was spun out of
  answer_all INTEGER NOT NULL DEFAULT 0,    -- with several people in it, agents answer every message, not only when named
  yolo       INTEGER NOT NULL DEFAULT 0     -- YOLO: it runs tools without asking, and stays that way across restarts
);
CREATE INDEX IF NOT EXISTS sessions_by_updated ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  origin_provider TEXT,
  origin_model    TEXT,
  native          TEXT,
  created_at      INTEGER NOT NULL,
  actor           TEXT,             -- who wrote it: person:<id>, agent:<id>, routine:<id>; null for tool results and before people
  PRIMARY KEY (session_id, seq)
);

-- Every question a turn asks a person — an approval, a model switch — from the moment it's asked
-- (settled brief §7): resolved once, for everyone; claimed softly; surviving a disconnect, and a
-- restart, where it's marked expired rather than silently lost.
CREATE TABLE IF NOT EXISTS questions (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- approval | fallback
  detail      TEXT NOT NULL,             -- JSON: tool and summary, or reason and candidates
  asked_at    INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',  -- open | answered | expired
  answer      TEXT,
  answered_by TEXT,
  answered_at INTEGER,
  expired_why TEXT,
  claimed_by  TEXT,
  claimed_at  INTEGER,
  claims      TEXT NOT NULL DEFAULT '[]'  -- JSON: every claim, who from, and whether it took one over
);
CREATE INDEX IF NOT EXISTS questions_open ON questions(status, asked_at);

-- Answers recorded before questions were kept whole (phase 1). Read, never written.
CREATE TABLE IF NOT EXISTS answers (
  question_id TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  answer      TEXT,
  answered_by TEXT,
  answered_at INTEGER NOT NULL
);

-- Devices paired with the daemon (docs/design/app.md). Only token hashes are stored.
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER
);

-- One-time pairing codes from \`poly pair\`, read by the daemon (a separate process).
CREATE TABLE IF NOT EXISTS pairing_codes (
  code_hash  TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

-- Web Push subscriptions, one or more per paired device.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint     TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  subscription TEXT NOT NULL,
  kinds        TEXT NOT NULL DEFAULT 'questions,finished',  -- which notifications this device wants
  created_at   INTEGER NOT NULL
);

-- config.toml's history: every change made through polyphemus (and every outside edit you adopt).
CREATE TABLE IF NOT EXISTS config_revisions (
  rev     INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER NOT NULL,
  caller  TEXT NOT NULL,
  action  TEXT NOT NULL,
  hash    TEXT NOT NULL,
  content TEXT NOT NULL
);

-- Which secret was used, by whom, and when. Never the value (docs/design/secrets.md).
CREATE TABLE IF NOT EXISTS secret_reads (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  at   INTEGER NOT NULL,
  name TEXT NOT NULL,
  by   TEXT NOT NULL
);

-- Every usage reading over time (the capacity table keeps only the latest), for forecasts.
CREATE TABLE IF NOT EXISTS capacity_samples (
  provider    TEXT NOT NULL,
  window_name TEXT NOT NULL,
  used_pct    REAL NOT NULL,
  resets_at   INTEGER,
  observed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS capacity_samples_by_window ON capacity_samples(provider, window_name, observed_at);

-- Routines (docs/design/scheduling.md): each one's state, and a record of every firing, even
-- the ones that didn't run, so "why didn't it run?" always has an answer.
CREATE TABLE IF NOT EXISTS routine_state (
  id            TEXT PRIMARY KEY,
  paused        INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  failures      INTEGER NOT NULL DEFAULT 0,   -- in a row
  handled_until INTEGER,                      -- schedule times up to here are dealt with
  accepted_digest TEXT                        -- the version of a project's routine a person last accepted
);
CREATE TABLE IF NOT EXISTS fires (
  id          TEXT PRIMARY KEY,
  routine     TEXT NOT NULL,
  trigger     TEXT NOT NULL,
  slot_at     INTEGER NOT NULL,
  idem_key    TEXT NOT NULL UNIQUE,            -- one firing per scheduled time
  status      TEXT NOT NULL,                   -- started | skipped | rejected
  reason      TEXT,
  session_id  TEXT,
  outcome     TEXT,                            -- succeeded | failed, once a started run ends
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS fires_by_routine ON fires(routine, created_at DESC);

-- One row per finished turn: how long it took and what it used, for the summary under each reply.
CREATE TABLE IF NOT EXISTS turns (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  end_seq     INTEGER NOT NULL,   -- how many messages the session had when the turn ended
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER NOT NULL,
  stop_reason TEXT NOT NULL,
  usage       TEXT NOT NULL,      -- JSON: inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens
  cost_usd    REAL,
  billing     TEXT,               -- plan | metered
  speaker     TEXT,               -- the agent whose turn it was (agent id), or null for a thread with no agent
  sender      TEXT                -- who it was for: person:<id>, agent:<id>, routine:<id>
);
CREATE INDEX IF NOT EXISTS turns_by_session ON turns(session_id, end_seq);

-- Projects polyphemus knows about (docs/design/projects.md). The code stays wherever it lives; this points to it.
CREATE TABLE IF NOT EXISTS projects (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'active',   -- active | parked | archived
  description TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

-- How each model last went, per connection: the last turn that worked and the last that failed.
-- Real turns and tests the user asked for write here; nothing probes on its own (capacity.md).
CREATE TABLE IF NOT EXISTS model_results (
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  last_ok_at    INTEGER,
  last_error_at INTEGER,
  last_error    TEXT,
  error_class   TEXT,
  PRIMARY KEY (provider, model)
);

-- People (docs/design/ui/settled-brief.md §7). The install owner is whose computer this is — not a
-- role — and every install has one, created the first time it's needed. Everyone else is a
-- member or viewer of particular projects, and nothing more.
CREATE TABLE IF NOT EXISTS people (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE TABLE IF NOT EXISTS project_members (
  project    TEXT NOT NULL,
  person_id  TEXT NOT NULL,
  role       TEXT NOT NULL,              -- member | viewer
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (project, person_id)
);

-- Who uploaded each image (the same bytes can come from more than one person).
CREATE TABLE IF NOT EXISTS uploads (
  id          TEXT NOT NULL,
  person_id   TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL,
  PRIMARY KEY (id, person_id)
);

-- Messages sent while a thread was working: held, in order, and delivered when it stops.
CREATE TABLE IF NOT EXISTS queued_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  person_id  TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  body       TEXT NOT NULL,              -- the message as it was sent: text, images, files
  queued_at  INTEGER NOT NULL
);

-- What agents showed in a thread: polyphemus's own copy of the file, and where it goes in the conversation.
CREATE TABLE IF NOT EXISTS artifacts (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  media_type TEXT NOT NULL,
  name       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  step_id    TEXT
);
CREATE INDEX IF NOT EXISTS artifacts_by_session ON artifacts(session_id, seq);

-- Things a person put out of sight for themselves, until what they dismissed changes.
CREATE TABLE IF NOT EXISTS dismissals (
  person_id TEXT NOT NULL,
  key       TEXT NOT NULL,             -- what: connection:<id>
  value     TEXT NOT NULL,             -- as it was when dismissed: a different value shows it again
  at        INTEGER NOT NULL,
  PRIMARY KEY (person_id, key)
);

-- One-time changes to things outside the database (agent files), so each runs exactly once.
CREATE TABLE IF NOT EXISTS migrations (
  name       TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- Who came and went: an agent added to or removed from a thread, a person given or losing a project.
-- Kept after they leave, so a conversation can say who was in it when.
CREATE TABLE IF NOT EXISTS attendance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  session_id TEXT,                        -- a thread's agents
  project    TEXT,                        -- a project's people
  subject    TEXT NOT NULL,               -- agent:<id> | person:<id>
  change     TEXT NOT NULL,               -- joined | left | role
  role       TEXT,
  by         TEXT                         -- person:<id>, routine:<id>, run:<id>; null when polyphemus did it
);
CREATE INDEX IF NOT EXISTS attendance_by_thread ON attendance(session_id, at);
CREATE INDEX IF NOT EXISTS attendance_by_project ON attendance(project, at);

-- Latest usage-window reading per provider (see docs/design/capacity.md).
-- People invited into a thread that belongs to no project: a conversation between people, where
-- project roles decide nothing. Whoever is here can see it and write in it.
-- A person's reaction to a message: one of each emoji per person per message, like a chat app.
CREATE TABLE IF NOT EXISTS reactions (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  actor      TEXT NOT NULL,                -- person:<id>
  emoji      TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq, actor, emoji)
);

CREATE TABLE IF NOT EXISTS thread_people (
  session_id TEXT NOT NULL,
  person_id  TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, person_id)
);

CREATE TABLE IF NOT EXISTS thread_members (
  session_id TEXT NOT NULL,
  agent      TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, agent)
);
CREATE TABLE IF NOT EXISTS capacity_alerts (
  provider    TEXT NOT NULL,
  window_name TEXT NOT NULL,
  resets_at   INTEGER,
  alerted_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, window_name)
);
CREATE TABLE IF NOT EXISTS capacity (
  provider    TEXT NOT NULL,
  window_name TEXT NOT NULL,
  used_pct    REAL,
  resets_at   INTEGER,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (provider, window_name)
);
`;

interface SessionRow {
  id: string;
  title: string;
  provider: string;
  model: string;
  cwd: string;
  agent: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  started_by: string | null;
  kept: number;
  finished_at: number | null;
  paused_why: string | null;
  lead: string | null;
  guard_limit: number | null;
  spun_from: string | null;
  answer_all?: number;
  yolo?: number;
}

interface MessageRow {
  role: 'user' | 'assistant';
  content: string;
  origin_provider: string | null;
  origin_model: string | null;
  native: string | null;
}

/** How a model last went on one connection. */
export interface ModelResult {
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  errorClass?: string;
}

/** Someone coming into or leaving a thread: an agent (the thread's), or a person (its project's). */
export interface AttendanceChange {
  at: number;
  /** agent:<id> or person:<id>. */
  subject: string;
  change: 'joined' | 'left' | 'role';
  /** A person's role in the project, when given or changed. */
  role?: string;
  /** Who did it, when someone did. */
  by?: string;
}

/** A person using this install. `owner` is whose computer it is; everyone else has project roles. */
export interface Person {
  id: string;
  name: string;
  owner: boolean;
  createdAt: number;
}

export type ProjectRole = 'member' | 'viewer';
export const PROJECT_ROLES: readonly ProjectRole[] = ['member', 'viewer'];

export interface DeviceMeta {
  id: string;
  name: string;
  /** Who the device belongs to. Devices paired before people existed are the install owner's. */
  personId?: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

interface DeviceRow {
  id: string;
  name: string;
  person_id: string | null;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

const toDevice = (row: DeviceRow): DeviceMeta => ({
  id: row.id,
  name: row.name,
  ...(row.person_id !== null && row.person_id !== undefined && { personId: row.person_id }),
  createdAt: row.created_at,
  ...(row.last_seen_at !== null && { lastSeenAt: row.last_seen_at }),
  ...(row.revoked_at !== null && { revokedAt: row.revoked_at }),
});

/** A question a turn asked a person, as stored. */
export interface StoredQuestion {
  id: string;
  sessionId: string;
  kind: string;
  detail: Record<string, unknown>;
  askedAt: number;
  status: 'open' | 'answered' | 'expired';
  answer?: string;
  answeredBy?: string;
  answeredAt?: number;
  expiredWhy?: string;
  claimedBy?: string;
  claimedAt?: number;
  claims: Array<{ by: string; at: number; tookOverFrom?: string }>;
}

interface QuestionRow {
  id: string;
  session_id: string;
  kind: string;
  detail: string;
  asked_at: number;
  status: 'open' | 'answered' | 'expired';
  answer: string | null;
  answered_by: string | null;
  answered_at: number | null;
  expired_why: string | null;
  claimed_by: string | null;
  claimed_at: number | null;
  claims: string;
}

const toQuestion = (r: QuestionRow): StoredQuestion => ({
  id: r.id,
  sessionId: r.session_id,
  kind: r.kind,
  detail: JSON.parse(r.detail) as Record<string, unknown>,
  askedAt: r.asked_at,
  status: r.status,
  ...(r.answer !== null && { answer: r.answer }),
  ...(r.answered_by !== null && { answeredBy: r.answered_by }),
  ...(r.answered_at !== null && { answeredAt: r.answered_at }),
  ...(r.expired_why !== null && { expiredWhy: r.expired_why }),
  ...(r.claimed_by !== null && { claimedBy: r.claimed_by }),
  ...(r.claimed_at !== null && { claimedAt: r.claimed_at }),
  claims: JSON.parse(r.claims) as StoredQuestion['claims'],
});

/** One line saying what a question was about: "bash: pnpm test", or the reason a model switch was offered. */
export const questionSummary = (q: Pick<StoredQuestion, 'kind' | 'detail'>): string =>
  q.kind === 'approval' ? `${String(q.detail.tool)}: ${String(q.detail.summary)}`
  : q.kind === 'gate' ? String(q.detail.title ?? q.detail.asks ?? '')
  : q.kind === 'outcome' ? String(q.detail.text ?? '')
  : q.kind === 'incoming' ? `${String(q.detail.kindTitle ?? 'Request')} from ${String(q.detail.fromName ?? 'someone')}`
  : q.kind === 'guard' ? `${String(q.detail.from ?? '')} and ${String(q.detail.to ?? '')}`
  : q.kind === 'secret' ? `${String(q.detail.name ?? '')}: ${String(q.detail.purpose ?? '')}`
  : q.kind === 'signin' ? `sign in to ${String(q.detail.where ?? '')}`
  : String(q.detail.reason ?? '');

export interface QueuedMessage {
  id: string;
  sessionId: string;
  personId: string;
  deviceId: string;
  body: Record<string, unknown>;
  queuedAt: number;
}

interface PersonRow {
  id: string;
  name: string;
  owner: number;
  created_at: number;
}

/** The account name, capitalised: alex → Alex. POLYPHEMUS_OWNER_NAME sets it instead (tests, and anyone who'd rather). */
function ownerName(): string {
  if (process.env.POLYPHEMUS_OWNER_NAME) return process.env.POLYPHEMUS_OWNER_NAME;
  try {
    const name = userInfo().username;
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Owner';
  } catch {
    return 'Owner';
  }
}

const toPerson = (row: PersonRow): Person => ({ id: row.id, name: row.name, owner: row.owner === 1, createdAt: row.created_at });

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

interface ArtifactRow {
  id: string;
  session_id: string;
  seq: number;
  title: string;
  kind: Artifact['kind'];
  media_type: string;
  name: string;
  bytes: number;
  created_at: number;
  created_by: string | null;
  step_id: string | null;
}

const toArtifact = (r: ArtifactRow): Artifact => ({
  id: r.id,
  sessionId: r.session_id,
  seq: r.seq,
  title: r.title,
  kind: r.kind,
  mediaType: r.media_type,
  name: r.name,
  bytes: r.bytes,
  createdAt: r.created_at,
  ...(r.created_by && { by: r.created_by }),
  ...(r.step_id && { stepId: r.step_id }),
});

const toMeta = (row: SessionRow): SessionMeta => ({
  id: row.id,
  title: row.title,
  provider: row.provider,
  model: row.model,
  cwd: row.cwd,
  agent: row.agent ?? '',
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.archived_at !== null && row.archived_at !== undefined && { archivedAt: row.archived_at }),
  ...(row.started_by && { startedBy: row.started_by }),
  ...(row.kept === 1 && { kept: true }),
  ...(row.finished_at !== null && row.finished_at !== undefined && { finishedAt: row.finished_at }),
  ...(row.paused_why && { pausedWhy: row.paused_why }),
  ...(row.lead && { lead: row.lead }),
  ...(row.guard_limit !== null && row.guard_limit !== undefined && { guardLimit: row.guard_limit }),
  ...(row.spun_from && { spunFrom: row.spun_from }),
  ...(row.answer_all === 1 && { agentsAnswerAll: true }),
  ...(row.yolo === 1 && { yolo: true }),
});

/** Append-only session storage. Pass ':memory:' for a throwaway store. */
/** Notifications a device can ask for: a session is waiting on you, or a turn finished (or failed). */
export type PushKind = 'questions' | 'finished';
export const PUSH_KINDS: readonly PushKind[] = ['questions', 'finished'];

export interface SecretRead {
  at: number;
  name: string;
  /** Who asked: "you (terminal)", "session 3cdf80b3", "polyphemus". */
  by: string;
}

export interface ConfigRevision {
  rev: number;
  at: number;
  /** Who made it: "you (terminal)", "an agent or script", "polyphemus". */
  caller: string;
  action: string;
  hash: string;
  content: string;
}

export interface RoutineState {
  paused: boolean;
  pausedReason?: string;
  /** Failed or rejected firings in a row; three pause the routine. */
  failures: number;
  /** Schedule times up to here have been dealt with (run, skipped, or missed). */
  handledUntil?: number;
  /** The version (a digest of its file) a person last accepted, for a routine in a project's folder. */
  acceptedDigest?: string;
}

export interface FireRecord {
  id: string;
  routine: string;
  /** What fired it: 'every 30m', 'cron "…"', 'run now', 'schedule'. */
  trigger: string;
  slotAt: number;
  status: 'started' | 'skipped' | 'rejected';
  reason?: string;
  sessionId?: string;
  outcome?: 'succeeded' | 'failed';
  createdAt: number;
  finishedAt?: number;
}

interface FireRow {
  id: string;
  routine: string;
  trigger: string;
  slot_at: number;
  status: FireRecord['status'];
  reason: string | null;
  session_id: string | null;
  outcome: FireRecord['outcome'] | null;
  created_at: number;
  finished_at: number | null;
}

const toFire = (row: FireRow): FireRecord => ({
  id: row.id,
  routine: row.routine,
  trigger: row.trigger,
  slotAt: row.slot_at,
  status: row.status,
  ...(row.reason !== null && { reason: row.reason }),
  ...(row.session_id !== null && { sessionId: row.session_id }),
  ...(row.outcome !== null && row.outcome !== undefined && { outcome: row.outcome }),
  createdAt: row.created_at,
  ...(row.finished_at !== null && { finishedAt: row.finished_at }),
});

/** A finished turn: when, on what, and how many tokens it took. */
export interface TurnRecord {
  /** How many messages the session had when the turn ended; the turn's messages come before it. */
  endSeq: number;
  provider: string;
  model: string;
  startedAt: number;
  endedAt: number;
  stopReason: StopReason;
  usage: Usage;
  costUsd?: number;
  /** What it cost isn't known: recorded before polyphemus told a CLI's running total from a turn's own. */
  costUnknown?: true;
  /** plan: covered by a subscription, so costUsd is only what the API would have charged. */
  billing?: 'plan' | 'metered';
  /** The agent whose turn it was; unset for a thread with no agent in it. */
  speaker?: string;
  /** Who it answered: person:<id>, agent:<id> (a hand-off) or routine:<id>. */
  sender?: string;
}

interface TurnRow {
  end_seq: number;
  provider: string;
  model: string;
  started_at: number;
  ended_at: number;
  stop_reason: StopReason;
  usage: string;
  cost_usd: number | null;
  cost_running_total: number;
  billing: 'plan' | 'metered' | null;
  speaker: string | null;
  sender: string | null;
}

/** Parked projects stay put but don't load or show by default; archived ones are done. */
export type ProjectStatus = 'active' | 'parked' | 'archived';
export const PROJECT_STATUSES: readonly ProjectStatus[] = ['active', 'parked', 'archived'];

export interface ProjectMeta {
  /** Short id used everywhere: memory folder, CLI, API. */
  slug: string;
  name: string;
  /** Absolute path to the project's folder. */
  path: string;
  status: ProjectStatus;
  description: string;
  createdAt: number;
  /** Stricter than the install's, when set: where agents' commands and file changes run here. */
  isolation?: IsolationLevel;
  /** What agents here may reach on the network while isolated: nothing unless granted. */
  network?: ProjectNetwork;
}

interface ProjectRow {
  slug: string;
  name: string;
  path: string;
  status: ProjectStatus;
  description: string;
  created_at: number;
  isolation?: string | null;
  network?: string | null;
}

const toProject = (row: ProjectRow): ProjectMeta => ({
  slug: row.slug,
  name: row.name,
  path: row.path,
  status: row.status,
  description: row.description,
  createdAt: row.created_at,
  ...(isIsolationLevel(row.isolation) && { isolation: row.isolation }),
  ...(parseNetwork(row.network) && { network: parseNetwork(row.network) }),
});

/** Pairing code characters: no 0/O or 1/I, so a typed code can't be misread. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** However the code was typed (lowercase, spaces, dashes), the same code. */
function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function parseKinds(text: string): PushKind[] {
  return PUSH_KINDS.filter((kind) => text.split(',').includes(kind));
}

/**
 * Questions nothing is waiting on: an offer, a proposal, an invitation. They're answered from what's
 * stored, so a restart leaves them open. An invite used to expire with the turn that raised it, and a
 * deploy that restarted at the end of that turn threw it away two seconds after it was asked
 * (2026-09-21).
 */
export const OUTLIVE_A_TURN = ['outcome', 'invite', 'skill', 'note', 'profile', 'routine', 'incoming'];

export class SessionStore {
  private db: DatabaseSync;
  /** Connections to outside services, their grants and activity, in the same database. */
  readonly connections: ConnectionStore;
  /** Outcomes, runs, steps and evidence. */
  readonly runs: RunStore;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const generation = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (generation > DATA_GENERATION) {
      this.db.close();
      throw new PolyphemusError(
        'A newer version of polyphemus changed this computer’s data in a way this version can’t read, so it stopped rather than risk it. Update polyphemus, or put back the data from before that update.',
        'FAILED',
        'poly update  ·  or: poly rollback --restore',
      );
    }
    if (generation < DATA_GENERATION) this.db.exec(`PRAGMA user_version = ${DATA_GENERATION}`);
    this.db.exec(SCHEMA);
    this.connections = new ConnectionStore(this.db);
    this.runs = new RunStore(this.db);
    const turnColumns = this.db.prepare('PRAGMA table_info(turns)').all() as unknown as Array<{ name: string }>;
    // Who ran each turn and who it answered: what a thread's flow is drawn from (2026-09-19).
    if (!turnColumns.some((column) => column.name === 'speaker')) this.db.exec('ALTER TABLE turns ADD COLUMN speaker TEXT');
    if (!turnColumns.some((column) => column.name === 'sender')) this.db.exec('ALTER TABLE turns ADD COLUMN sender TEXT');
    // Until 2026-09-20 a vendor CLI's turn kept what the CLI reported — its running total for the
    // whole native session, not this turn's cost — so every one of those was counted again by the
    // next turn. The rows already written are marked rather than guessed at: what each turn of a
    // resumed session actually cost isn't recoverable from them.
    if (!turnColumns.some((column) => column.name === 'cost_running_total')) {
      this.db.exec('ALTER TABLE turns ADD COLUMN cost_running_total INTEGER NOT NULL DEFAULT 0');
      this.db.exec("UPDATE turns SET cost_running_total = 1 WHERE cost_usd IS NOT NULL AND provider IN ('claude-code', 'grok-build')");
    }
    const routineColumns = this.db.prepare('PRAGMA table_info(routine_state)').all() as unknown as Array<{ name: string }>;
    if (!routineColumns.some((column) => column.name === 'accepted_digest')) {
      this.db.exec('ALTER TABLE routine_state ADD COLUMN accepted_digest TEXT');
      // Routines that were already running before acceptance existed are accepted as they are, once,
      // by the scheduler that next starts: '*' marks that it hasn't happened yet.
      this.db.exec("INSERT OR IGNORE INTO routine_state (id, accepted_digest) VALUES ('*', 'as-they-were')");
    }
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'agent_state')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN agent_state TEXT NOT NULL DEFAULT '{}'");
    }
    if (!columns.some((column) => column.name === 'agent')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN agent TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some((column) => column.name === 'archived_at')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN archived_at INTEGER');
    }
    if (!columns.some((column) => column.name === 'started_by')) this.db.exec('ALTER TABLE sessions ADD COLUMN started_by TEXT');
    if (!columns.some((column) => column.name === 'kept')) this.db.exec('ALTER TABLE sessions ADD COLUMN kept INTEGER NOT NULL DEFAULT 0');
    if (!columns.some((column) => column.name === 'finished_at')) this.db.exec('ALTER TABLE sessions ADD COLUMN finished_at INTEGER');
    if (!columns.some((column) => column.name === 'paused_why')) this.db.exec('ALTER TABLE sessions ADD COLUMN paused_why TEXT');
    if (!columns.some((column) => column.name === 'lead')) this.db.exec('ALTER TABLE sessions ADD COLUMN lead TEXT');
    if (!columns.some((column) => column.name === 'guard_limit')) this.db.exec('ALTER TABLE sessions ADD COLUMN guard_limit INTEGER');
    if (!columns.some((column) => column.name === 'spun_from')) this.db.exec('ALTER TABLE sessions ADD COLUMN spun_from TEXT');
    if (!columns.some((column) => column.name === 'answer_all')) this.db.exec('ALTER TABLE sessions ADD COLUMN answer_all INTEGER NOT NULL DEFAULT 0');
    if (!columns.some((column) => column.name === 'yolo')) this.db.exec('ALTER TABLE sessions ADD COLUMN yolo INTEGER NOT NULL DEFAULT 0');
    const projectColumns = this.db.prepare('PRAGMA table_info(projects)').all() as unknown as Array<{ name: string }>;
    if (!projectColumns.some((column) => column.name === 'isolation')) this.db.exec('ALTER TABLE projects ADD COLUMN isolation TEXT');
    if (!projectColumns.some((column) => column.name === 'network')) this.db.exec('ALTER TABLE projects ADD COLUMN network TEXT');
    const messageColumns = this.db.prepare('PRAGMA table_info(messages)').all() as unknown as Array<{ name: string }>;
    if (!messageColumns.some((column) => column.name === 'actor')) this.db.exec('ALTER TABLE messages ADD COLUMN actor TEXT');
    const deviceColumns = this.db.prepare('PRAGMA table_info(devices)').all() as unknown as Array<{ name: string }>;
    if (!deviceColumns.some((column) => column.name === 'person_id')) this.db.exec('ALTER TABLE devices ADD COLUMN person_id TEXT');
    const codeColumns = this.db.prepare('PRAGMA table_info(pairing_codes)').all() as unknown as Array<{ name: string }>;
    if (!codeColumns.some((column) => column.name === 'person_id')) this.db.exec('ALTER TABLE pairing_codes ADD COLUMN person_id TEXT');
    const pushColumns = this.db.prepare('PRAGMA table_info(push_subscriptions)').all() as unknown as Array<{ name: string }>;
    if (!pushColumns.some((column) => column.name === 'kinds')) {
      this.db.exec(`ALTER TABLE push_subscriptions ADD COLUMN kinds TEXT NOT NULL DEFAULT '${PUSH_KINDS.join(',')}'`);
    }
  }

  /** A one-time code for pairing a device, valid for `ttlMs`. Only its hash is stored. */
  /**
   * A one-time code, short enough to type (e.g. K7Q-M4P-X2): 9 characters from 32 is about
   * 3.5 × 10^13 possibilities, alive for minutes, with wrong guesses limited by the daemon.
   */
  createPairingCode(ttlMs = 10 * 60 * 1000, personId?: string): string {
    const chars = [...randomBytes(9)].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join(''); // 256 % 32 == 0: unbiased
    const code = `${chars.slice(0, 3)}-${chars.slice(3, 6)}-${chars.slice(6)}`;
    const now = Date.now();
    this.db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(now);
    this.db.prepare('INSERT INTO pairing_codes (code_hash, expires_at, person_id) VALUES (?, ?, ?)').run(sha256(normalizeCode(code)), now + ttlMs, personId ?? null);
    return code;
  }

  /** Uses up a pairing code and registers a device. Returns the device's secret token (shown once, never stored). */
  redeemPairingCode(code: string, name: string): { device: DeviceMeta; token: string } | undefined {
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      const hash = sha256(normalizeCode(code));
      const row = this.db.prepare('SELECT expires_at, person_id FROM pairing_codes WHERE code_hash = ?').get(hash) as { expires_at: number; person_id: string | null } | undefined;
      this.db.prepare('DELETE FROM pairing_codes WHERE code_hash = ?').run(hash);
      if (!row || row.expires_at < now) {
        this.db.exec('COMMIT');
        return undefined;
      }
      const token = randomBytes(32).toString('base64url');
      // A code made for someone pairs a device as them; otherwise it's the install owner's.
      const personId = row.person_id ?? this.installOwner().id;
      const device: DeviceMeta = { id: randomUUID().replaceAll('-', '').slice(0, 8), name, personId, createdAt: now };
      this.db.prepare('INSERT INTO devices (id, name, token_hash, created_at, person_id) VALUES (?, ?, ?, ?, ?)').run(device.id, name, sha256(token), now, personId);
      this.db.exec('COMMIT');
      return { device, token };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The active device a token belongs to, if any (and notes that it was seen). */
  deviceForToken(token: string): DeviceMeta | undefined {
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(token)) as DeviceRow | undefined;
    if (!row) return undefined;
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id);
    return toDevice(row);
  }

  listDevices(): DeviceMeta[] {
    return (this.db.prepare('SELECT * FROM devices ORDER BY created_at').all() as unknown as DeviceRow[]).map(toDevice);
  }

  /** The install owner: whose computer this is. Made the first time anything asks, so every install has one. */
  installOwner(): Person {
    const row = this.db.prepare('SELECT * FROM people WHERE owner = 1 AND removed_at IS NULL').get() as PersonRow | undefined;
    if (row) return toPerson(row);
    // Named after the account on this computer, because other people see this name on what the owner
    // does. "You" would read as themselves. `poly people rename` changes it.
    const person: Person = { id: randomUUID().replaceAll('-', '').slice(0, 8), name: ownerName(), owner: true, createdAt: Date.now() };
    this.db.prepare('INSERT INTO people (id, name, owner, created_at) VALUES (?, ?, 1, ?)').run(person.id, person.name, person.createdAt);
    return person;
  }

  /** Who a device acts as. A device from before people existed is the owner's. */
  personForDevice(device: Pick<DeviceMeta, 'personId'>): Person | undefined {
    if (!device.personId) return this.installOwner();
    const person = this.person(device.personId);
    return person;
  }

  person(id: string): Person | undefined {
    const row = this.db.prepare('SELECT * FROM people WHERE id = ? AND removed_at IS NULL').get(id) as PersonRow | undefined;
    return row && toPerson(row);
  }

  /** People still here, the owner first. */
  people(): Person[] {
    this.installOwner();
    return (this.db.prepare('SELECT * FROM people WHERE removed_at IS NULL ORDER BY owner DESC, created_at').all() as unknown as PersonRow[]).map(toPerson);
  }

  /** A person by id, id prefix, or name (case-insensitive), when exactly one matches. */
  resolvePerson(ref: string): Person | undefined {
    const matches = this.people().filter((p) => p.id === ref || p.name.toLowerCase() === ref.toLowerCase());
    if (matches.length === 1) return matches[0];
    const byPrefix = this.people().filter((p) => p.id.startsWith(ref));
    return byPrefix.length === 1 ? byPrefix[0] : undefined;
  }

  renamePerson(id: string, name: string): boolean {
    return Number(this.db.prepare('UPDATE people SET name = ? WHERE id = ? AND removed_at IS NULL').run(name, id).changes) > 0;
  }

  addPerson(name: string, at = Date.now()): Person {
    const person: Person = { id: randomUUID().replaceAll('-', '').slice(0, 8), name, owner: false, createdAt: at };
    this.db.prepare('INSERT INTO people (id, name, owner, created_at) VALUES (?, ?, 0, ?)').run(person.id, name, at);
    return person;
  }

  /** Someone leaves: their devices stop working and their project roles go. What they did stays attributed. */
  removePerson(id: string, at = Date.now()): void {
    const person = this.person(id);
    if (!person || person.owner) return;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE people SET removed_at = ? WHERE id = ?').run(at, id);
      for (const { id: deviceId } of this.db.prepare('SELECT id FROM devices WHERE person_id = ? AND revoked_at IS NULL').all(id) as unknown as Array<{ id: string }>) {
        this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(at, deviceId);
        this.db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(deviceId);
      }
      for (const project of this.projectRoles(id).keys()) this.recordAttendance({ at, project, subject: `person:${id}`, change: 'left' });
      this.db.prepare('DELETE FROM project_members WHERE person_id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Gives someone a role in a project, or takes it away with null. The owner needs none. */
  setProjectRole(project: string, personId: string, role: ProjectRole | null, at = Date.now(), by?: string): void {
    const before = this.projectRoles(personId).get(project);
    if (role === null) {
      this.db.prepare('DELETE FROM project_members WHERE project = ? AND person_id = ?').run(project, personId);
      if (before) this.recordAttendance({ at, project, subject: `person:${personId}`, change: 'left', by });
      return;
    }
    this.db
      .prepare('INSERT INTO project_members (project, person_id, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(project, person_id) DO UPDATE SET role = excluded.role')
      .run(project, personId, role, at);
    if (before !== role) this.recordAttendance({ at, project, subject: `person:${personId}`, change: before ? 'role' : 'joined', role, by });
  }

  private recordAttendance(e: { at: number; sessionId?: string; project?: string; subject: string; change: AttendanceChange['change']; role?: string; by?: string }): void {
    this.db
      .prepare('INSERT INTO attendance (at, session_id, project, subject, change, role, by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.at, e.sessionId ?? null, e.project ?? null, e.subject, e.change, e.role ?? null, e.by ?? null);
  }

  /**
   * Who came and went in a thread, oldest first: its agents, and people given or losing its project
   * while the thread existed.
   */
  attendance(sessionId: string): AttendanceChange[] {
    const meta = this.get(sessionId);
    if (!meta) return [];
    const project = this.projectFor(meta.cwd)?.slug ?? null;
    const rows = this.db
      .prepare('SELECT * FROM attendance WHERE session_id = ? OR (project IS NOT NULL AND project = ? AND at >= ?) ORDER BY at, id')
      .all(sessionId, project, meta.createdAt) as unknown as Array<{ at: number; subject: string; change: AttendanceChange['change']; role: string | null; by: string | null }>;
    return rows.map((r) => ({ at: r.at, subject: r.subject, change: r.change, ...(r.role !== null && { role: r.role }), ...(r.by !== null && { by: r.by }) }));
  }

  /** A person by id, even one who has left: what they did stays attributed. */
  personEver(id: string): Person | undefined {
    const row = this.db.prepare('SELECT * FROM people WHERE id = ?').get(id) as PersonRow | undefined;
    return row && toPerson(row);
  }

  /** What an agent's last reply in a thread actually ran on. */
  lastOrigin(sessionId: string, actor: string): { provider: string; model: string } | undefined {
    const row = this.db
      .prepare("SELECT origin_provider, origin_model FROM messages WHERE session_id = ? AND actor = ? AND role = 'assistant' AND origin_provider IS NOT NULL ORDER BY seq DESC LIMIT 1")
      .get(sessionId, actor) as { origin_provider: string; origin_model: string } | undefined;
    return row && { provider: row.origin_provider, model: row.origin_model };
  }

  /** A person's role in each project they belong to. */
  projectRoles(personId: string): Map<string, ProjectRole> {
    const rows = this.db.prepare('SELECT project, role FROM project_members WHERE person_id = ?').all(personId) as unknown as Array<{ project: string; role: ProjectRole }>;
    return new Map(rows.map((r) => [r.project, r.role]));
  }

  /** Who belongs to a project, and as what. */
  projectMembers(project: string): Array<{ person: Person; role: ProjectRole }> {
    const rows = this.db.prepare('SELECT person_id, role FROM project_members WHERE project = ? ORDER BY added_at').all(project) as unknown as Array<{ person_id: string; role: ProjectRole }>;
    return rows.flatMap((r) => {
      const person = this.person(r.person_id);
      return person ? [{ person, role: r.role }] : [];
    });
  }

  /** Revokes a device by id or unique id prefix. Returns false if nothing matched. */
  revokeDevice(idOrPrefix: string): boolean {
    const rows = this.db.prepare("SELECT id FROM devices WHERE id LIKE ? || '%' AND revoked_at IS NULL").all(idOrPrefix) as unknown as Array<{ id: string }>;
    if (rows.length !== 1) return false;
    this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(Date.now(), rows[0]!.id);
    this.db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(rows[0]!.id);
    return true;
  }

  /** Saves (or refreshes) a device's Web Push subscription, keeping the kinds of notifications it chose. */
  savePushSubscription(deviceId: string, subscription: { endpoint: string }): void {
    const kinds = (this.pushKinds(deviceId) ?? PUSH_KINDS).join(',');
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, device_id, subscription, kinds, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET device_id = excluded.device_id, subscription = excluded.subscription, kinds = excluded.kinds`,
      )
      .run(subscription.endpoint, deviceId, JSON.stringify(subscription), kinds, Date.now());
  }

  /** Subscriptions of devices that are still allowed in. */
  pushSubscriptions(): Array<{ deviceId: string; subscription: { endpoint: string }; kinds: PushKind[] }> {
    const rows = this.db
      .prepare('SELECT p.device_id, p.subscription, p.kinds FROM push_subscriptions p JOIN devices d ON d.id = p.device_id WHERE d.revoked_at IS NULL')
      .all() as unknown as Array<{ device_id: string; subscription: string; kinds: string }>;
    return rows.map((row) => ({ deviceId: row.device_id, subscription: JSON.parse(row.subscription) as { endpoint: string }, kinds: parseKinds(row.kinds) }));
  }

  /** Which notifications a device wants, or undefined if it hasn't turned them on. */
  pushKinds(deviceId: string): PushKind[] | undefined {
    const row = this.db.prepare('SELECT kinds FROM push_subscriptions WHERE device_id = ? LIMIT 1').get(deviceId) as { kinds: string } | undefined;
    return row ? parseKinds(row.kinds) : undefined;
  }

  setPushKinds(deviceId: string, kinds: readonly PushKind[]): void {
    this.db.prepare('UPDATE push_subscriptions SET kinds = ? WHERE device_id = ?').run(kinds.join(','), deviceId);
  }

  removePushSubscription(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  /** Turns notifications off for a device. */
  removeDevicePush(deviceId: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE device_id = ?').run(deviceId);
  }

  /** The latest thing the assistant said in a session, on one line, for list previews. */
  lastReply(sessionId: string, max = 140): string | undefined {
    const rows = this.db
      .prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 8")
      .all(sessionId) as unknown as Array<{ content: string }>;
    for (const row of rows) {
      const blocks = JSON.parse(row.content) as Array<{ type: string; text?: string }>;
      const text = blocks
        .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
        .join(' ')
        .replace(/\*\*|__|`/g, '') // markdown emphasis and code marks read as noise in a one-line preview
        .replace(/(^|\s)#{1,6}\s+/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    }
    return undefined;
  }

  /** When each message in a session was written (ms), in order. */
  /** Who wrote each message, in order, alongside messageTimes. */
  messageActors(sessionId: string): Array<string | null> {
    const rows = this.db.prepare('SELECT actor FROM messages WHERE session_id = ? ORDER BY seq').all(sessionId) as unknown as Array<{ actor: string | null }>;
    return rows.map((row) => row.actor);
  }

  askQuestion(q: { id: string; sessionId: string; kind: string; detail: Record<string, unknown> }, at = Date.now()): StoredQuestion {
    this.db
      .prepare('INSERT INTO questions (id, session_id, kind, detail, asked_at) VALUES (?, ?, ?, ?, ?)')
      .run(q.id, q.sessionId, q.kind, JSON.stringify(q.detail), at);
    return this.question(q.id)!;
  }

  question(id: string): StoredQuestion | undefined {
    const row = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as QuestionRow | undefined;
    return row && toQuestion(row);
  }

  /** Waiting on a person, oldest first. */
  openQuestions(): StoredQuestion[] {
    return (this.db.prepare("SELECT * FROM questions WHERE status = 'open' ORDER BY asked_at").all() as unknown as QuestionRow[]).map(toQuestion);
  }

  /**
   * Answers a question — once. The update only matches while it's still open, so two people
   * answering at the same moment can't both win: the second gets false, and the question says who did.
   */
  answerQuestion(id: string, answer: string | undefined, by: string | undefined, at = Date.now()): boolean {
    const result = this.db
      .prepare("UPDATE questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE id = ? AND status = 'open'")
      .run(answer ?? null, by ?? null, at, id);
    return Number(result.changes) === 1;
  }

  /** Nobody can answer it any more: the turn stopped, or polyphemus restarted under it. */
  expireQuestion(id: string, why: string, at = Date.now()): boolean {
    const result = this.db.prepare("UPDATE questions SET status = 'expired', expired_why = ?, answered_at = ? WHERE id = ? AND status = 'open'").run(why, at, id);
    return Number(result.changes) === 1;
  }

  /** On start: whatever was waiting belonged to turns that no longer exist. */
  expireOpenQuestions(why: string, at = Date.now()): number {
    const outlive = OUTLIVE_A_TURN.map(() => '?').join(', ');
    return Number(this.db.prepare(`UPDATE questions SET status = 'expired', expired_why = ?, answered_at = ? WHERE status = 'open' AND kind NOT IN (${outlive})`).run(why, at, ...OUTLIVE_A_TURN).changes);
  }

  /**
   * Someone takes responsibility for a question. Soft: another permitted person can take it over,
   * and that's recorded. Returns who had it before, if anyone.
   */
  claimQuestion(id: string, by: string, at = Date.now()): { previous?: string } {
    const q = this.question(id);
    if (!q || q.status !== 'open') return {};
    const previous = q.claimedBy && q.claimedBy !== by ? q.claimedBy : undefined;
    const claims = [...q.claims, { by, at, ...(previous && { tookOverFrom: previous }) }];
    this.db.prepare('UPDATE questions SET claimed_by = ?, claimed_at = ?, claims = ? WHERE id = ?').run(by, at, JSON.stringify(claims), id);
    return previous ? { previous } : {};
  }

  releaseQuestion(id: string, by: string): boolean {
    return Number(this.db.prepare("UPDATE questions SET claimed_by = NULL, claimed_at = NULL WHERE id = ? AND claimed_by = ? AND status = 'open'").run(id, by).changes) === 1;
  }

  /** What was answered in a thread, and by whom: questions, plus answers kept before questions were. */
  answers(sessionId: string): Array<{ questionId: string; kind: string; summary: string; answer: string | null; by: string | null; at: number }> {
    const legacy = this.db.prepare('SELECT * FROM answers WHERE session_id = ?').all(sessionId) as unknown as Array<{
      question_id: string;
      kind: string;
      summary: string;
      answer: string | null;
      answered_by: string | null;
      answered_at: number;
    }>;
    const answered = (this.db.prepare("SELECT * FROM questions WHERE session_id = ? AND status = 'answered'").all(sessionId) as unknown as QuestionRow[]).map(toQuestion);
    return [
      ...legacy.map((r) => ({ questionId: r.question_id, kind: r.kind, summary: r.summary, answer: r.answer, by: r.answered_by, at: r.answered_at })),
      ...answered.map((q) => ({ questionId: q.id, kind: q.kind, summary: questionSummary(q), answer: q.answer ?? null, by: q.answeredBy ?? null, at: q.answeredAt! })),
    ].sort((a, b) => a.at - b.at);
  }

  messageTimes(sessionId: string): number[] {
    const rows = this.db.prepare('SELECT created_at FROM messages WHERE session_id = ? ORDER BY seq').all(sessionId) as unknown as Array<{ created_at: number }>;
    return rows.map((row) => row.created_at);
  }

  /** Records that a secret was used. The value is never stored. */
  recordSecretRead(name: string, by: string): void {
    this.db.prepare('INSERT INTO secret_reads (at, name, by) VALUES (?, ?, ?)').run(Date.now(), name, by);
  }

  /** Newest first. */
  secretReads(limit = 50): SecretRead[] {
    return this.db.prepare('SELECT at, name, by FROM secret_reads ORDER BY id DESC LIMIT ?').all(limit) as unknown as SecretRead[];
  }

  addConfigRevision(revision: Omit<ConfigRevision, 'rev' | 'at'>): number {
    const result = this.db
      .prepare('INSERT INTO config_revisions (at, caller, action, hash, content) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), revision.caller, revision.action, revision.hash, revision.content);
    return Number(result.lastInsertRowid);
  }

  /** Newest first. */
  configRevisions(limit = 20): ConfigRevision[] {
    return this.db.prepare('SELECT * FROM config_revisions ORDER BY rev DESC LIMIT ?').all(limit) as unknown as ConfigRevision[];
  }

  configRevision(rev: number): ConfigRevision | undefined {
    return this.db.prepare('SELECT * FROM config_revisions WHERE rev = ?').get(rev) as ConfigRevision | undefined;
  }

  routineState(id: string): RoutineState {
    const row = this.db.prepare('SELECT * FROM routine_state WHERE id = ?').get(id) as
      | { paused: number; paused_reason: string | null; failures: number; handled_until: number | null; accepted_digest: string | null }
      | undefined;
    if (!row) return { paused: false, failures: 0 };
    return {
      paused: row.paused === 1,
      ...(row.paused_reason !== null && { pausedReason: row.paused_reason }),
      failures: row.failures,
      ...(row.handled_until !== null && { handledUntil: row.handled_until }),
      ...(row.accepted_digest !== null && { acceptedDigest: row.accepted_digest }),
    };
  }

  updateRoutineState(id: string, patch: Partial<RoutineState>): void {
    const next = { ...this.routineState(id), ...patch };
    this.db
      .prepare(
        `INSERT INTO routine_state (id, paused, paused_reason, failures, handled_until, accepted_digest) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET paused = excluded.paused, paused_reason = excluded.paused_reason, failures = excluded.failures, handled_until = excluded.handled_until, accepted_digest = excluded.accepted_digest`,
      )
      .run(id, next.paused ? 1 : 0, next.pausedReason ?? null, next.failures, next.handledUntil ?? null, next.acceptedDigest ?? null);
  }

  /** Records a firing. Undefined when this idempotency key was already used: that time was handled. */
  recordFire(fire: Omit<FireRecord, 'id' | 'createdAt' | 'outcome' | 'finishedAt'> & { idemKey: string }): FireRecord | undefined {
    const id = randomUUID().replaceAll('-', '').slice(0, 10);
    const now = Date.now();
    const inserted = this.db
      .prepare('INSERT INTO fires (id, routine, trigger, slot_at, idem_key, status, reason, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (idem_key) DO NOTHING')
      .run(id, fire.routine, fire.trigger, fire.slotAt, fire.idemKey, fire.status, fire.reason ?? null, fire.sessionId ?? null, now);
    if (inserted.changes === 0) return undefined;
    const { idemKey: _key, ...rest } = fire;
    return { ...rest, id, createdAt: now };
  }

  fireStarted(id: string, sessionId: string): void {
    this.db.prepare('UPDATE fires SET session_id = ? WHERE id = ?').run(sessionId, id);
  }

  finishFire(id: string, outcome: 'succeeded' | 'failed', reason?: string): void {
    this.db.prepare('UPDATE fires SET outcome = ?, reason = COALESCE(?, reason), finished_at = ? WHERE id = ?').run(outcome, reason ?? null, Date.now(), id);
  }

  /** A routine's latest firings, newest first. */
  fires(routine: string, limit = 20): FireRecord[] {
    const rows = this.db.prepare('SELECT * FROM fires WHERE routine = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(routine, limit) as unknown as FireRow[];
    return rows.map(toFire);
  }

  /** How many runs a routine has started since a time (for max_runs_per_day). */
  startedSince(routine: string, since: number): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM fires WHERE routine = ? AND status = 'started' AND created_at >= ?").get(routine, since) as { n: number };
    return row.n;
  }

  recordTurn(sessionId: string, turn: TurnRecord): void {
    this.db
      .prepare('INSERT INTO turns (session_id, end_seq, provider, model, started_at, ended_at, stop_reason, usage, cost_usd, billing, speaker, sender) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, turn.endSeq, turn.provider, turn.model, turn.startedAt, turn.endedAt, turn.stopReason, JSON.stringify(turn.usage), turn.costUsd ?? null, turn.billing ?? null, turn.speaker ?? null, turn.sender ?? null);
  }

  /** Every finished turn in a session, oldest first. */
  turns(sessionId: string): TurnRecord[] {
    const rows = this.db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY end_seq, rowid').all(sessionId) as unknown as TurnRow[];
    return rows.map((row) => ({
      endSeq: row.end_seq,
      provider: row.provider,
      model: row.model,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      stopReason: row.stop_reason,
      usage: JSON.parse(row.usage) as Usage,
      ...(row.speaker !== null && { speaker: row.speaker }),
      ...(row.sender !== null && { sender: row.sender }),
      // A row from before that distinction existed holds the session's running total: it isn't this
      // turn's cost, and nothing may add it up as though it were.
      ...(row.cost_usd !== null && !row.cost_running_total && { costUsd: row.cost_usd }),
      ...(row.cost_running_total ? { costUnknown: true as const } : {}),
      ...(row.billing !== null && { billing: row.billing }),
    }));
  }

  addProject(project: Omit<ProjectMeta, 'status' | 'createdAt'>): ProjectMeta {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO projects (slug, name, path, description, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(project.slug, project.name, project.path, project.description, now);
    return { ...project, status: 'active', createdAt: now };
  }

  /** A project's own isolation level, or back to the install's with null. */
  setProjectIsolation(slug: string, level: IsolationLevel | null): void {
    this.db.prepare('UPDATE projects SET isolation = ? WHERE slug = ?').run(level, slug);
  }

  /** What a project's agents may reach on the network while isolated; nothing, with null. */
  setProjectNetwork(slug: string, network: ProjectNetwork | null): void {
    this.db.prepare('UPDATE projects SET network = ? WHERE slug = ?').run(network && (network.presets.length || network.hosts.length) ? JSON.stringify(network) : null, slug);
  }

  projects(statuses: readonly ProjectStatus[] = PROJECT_STATUSES): ProjectMeta[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all() as unknown as ProjectRow[];
    return rows.map(toProject).filter((project) => statuses.includes(project.status));
  }

  project(slug: string): ProjectMeta | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug) as ProjectRow | undefined;
    return row && toProject(row);
  }

  /** The project a folder belongs to: the one that is it or contains it (the deepest, if they nest). */
  projectFor(folder: string): ProjectMeta | undefined {
    return this.projects()
      .filter((project) => folder === project.path || folder.startsWith(`${project.path}${sep}`))
      .sort((a, b) => b.path.length - a.path.length)[0];
  }

  /**
   * A project's files moved: the registry follows them, and so does the folder every past session
   * recorded, so old sessions still resume where their work is.
   */
  moveProject(slug: string, path: string): { from: string; sessions: number } | undefined {
    const project = this.project(slug);
    if (!project || project.path === path) return project && { from: project.path, sessions: 0 };
    this.db.prepare('UPDATE projects SET path = ? WHERE slug = ?').run(path, slug);
    const rows = this.db.prepare('SELECT id, cwd FROM sessions').all() as unknown as Array<{ id: string; cwd: string }>;
    const inside = rows.filter((row) => row.cwd === project.path || row.cwd.startsWith(`${project.path}${sep}`));
    const update = this.db.prepare('UPDATE sessions SET cwd = ? WHERE id = ?');
    for (const row of inside) update.run(`${path}${row.cwd.slice(project.path.length)}`, row.id);
    return { from: project.path, sessions: inside.length };
  }

  setProjectStatus(slug: string, status: ProjectStatus): boolean {
    return this.db.prepare('UPDATE projects SET status = ? WHERE slug = ?').run(status, slug).changes > 0;
  }

  /** The name people see. The slug, the folder, and the address stay. */
  renameProject(slug: string, name: string): ProjectMeta | undefined {
    if (!this.project(slug)) return undefined;
    this.db.prepare('UPDATE projects SET name = ? WHERE slug = ?').run(name, slug);
    return this.project(slug);
  }

  /** Saves the latest reading for each window a provider reported (newer readings win). */
  recordCapacity(provider: string, readings: readonly CapacityReading[], observedAt = Date.now()): void {
    const upsert = this.db.prepare(
      `INSERT INTO capacity (provider, window_name, used_pct, resets_at, observed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (provider, window_name) DO UPDATE SET used_pct = excluded.used_pct, resets_at = excluded.resets_at,
         observed_at = excluded.observed_at WHERE excluded.observed_at >= capacity.observed_at`,
    );
    for (const r of readings) upsert.run(provider, r.window, r.usedPct ?? null, r.resetsAt?.getTime() ?? null, observedAt);
    // History for forecasts: kept 8 days, long enough for a weekly window.
    const sample = this.db.prepare('INSERT INTO capacity_samples (provider, window_name, used_pct, resets_at, observed_at) VALUES (?, ?, ?, ?, ?)');
    for (const r of readings) if (r.usedPct !== undefined) sample.run(provider, r.window, r.usedPct, r.resetsAt?.getTime() ?? null, observedAt);
    this.db.prepare('DELETE FROM capacity_samples WHERE observed_at < ?').run(Date.now() - 8 * 86_400_000);
  }

  /** Readings of one window since a time, oldest first. */
  /**
   * Which window polyphemus has already warned about running out early. Kept in the database, not
   * in memory: the daemon restarts on every deploy, and an in-memory note meant each restart
   * told you the same thing again. Keyed by the reset time, so the next window warns once more.
   */
  forecastAlertedFor(provider: string, window: string): number | null | undefined {
    const row = this.db.prepare('SELECT resets_at FROM capacity_alerts WHERE provider = ? AND window_name = ?').get(provider, window) as
      | { resets_at: number | null }
      | undefined;
    return row === undefined ? undefined : row.resets_at;
  }

  recordForecastAlert(provider: string, window: string, resetsAt: number | undefined, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO capacity_alerts (provider, window_name, resets_at, alerted_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (provider, window_name) DO UPDATE SET resets_at = excluded.resets_at, alerted_at = excluded.alerted_at`,
      )
      .run(provider, window, resetsAt ?? null, now);
  }

  capacitySamples(provider: string, window: string, since: number): Array<{ usedPct: number; resetsAt?: number; observedAt: number }> {
    const rows = this.db
      .prepare('SELECT used_pct, resets_at, observed_at FROM capacity_samples WHERE provider = ? AND window_name = ? AND observed_at >= ? ORDER BY observed_at')
      .all(provider, window, since) as unknown as Array<{ used_pct: number; resets_at: number | null; observed_at: number }>;
    return rows.map((row) => ({ usedPct: row.used_pct, ...(row.resets_at !== null && { resetsAt: row.resets_at }), observedAt: row.observed_at }));
  }

  clearCapacity(provider: string, window: string): void {
    this.db.prepare('DELETE FROM capacity WHERE provider = ? AND window_name = ?').run(provider, window);
  }

  /** Latest readings per provider. Windows whose reset time has passed are dropped: they've started over. */
  capacity(now = Date.now()): Map<string, CapacityReading[]> {
    const rows = this.db.prepare('SELECT * FROM capacity ORDER BY provider, window_name').all() as unknown as Array<{
      provider: string;
      window_name: string;
      used_pct: number | null;
      resets_at: number | null;
      observed_at: number;
    }>;
    const byProvider = new Map<string, CapacityReading[]>();
    for (const row of rows) {
      if (row.resets_at !== null && row.resets_at <= now) continue;
      // A 7d reading observed more than 7 days ago is certainly from an earlier window, whatever
      // its reset time claimed. Dropping it is better than showing a number from two windows ago.
      const length = windowLength(row.window_name);
      if (length !== undefined && now - row.observed_at > length) continue;
      // A quota error that gave no reset time only keeps a provider out for a while (quota.ts), so a
      // row written by an older polyphemus, or days ago, stops blocking without anyone clearing it.
      if (row.window_name === 'quota' && row.resets_at === null && now - row.observed_at >= quotaRetryMs()) continue;
      const reading: CapacityReading = { window: row.window_name, observedAt: new Date(row.observed_at) };
      if (row.used_pct !== null) reading.usedPct = row.used_pct;
      if (row.resets_at !== null) reading.resetsAt = new Date(row.resets_at);
      byProvider.set(row.provider, [...(byProvider.get(row.provider) ?? []), reading]);
    }
    return byProvider;
  }

  agentState(id: string, provider: string): AgentSessionState | undefined {
    return this.allAgentState(id)[provider];
  }

  setAgentState(id: string, provider: string, state: AgentSessionState): void {
    const all = { ...this.allAgentState(id), [provider]: state };
    this.db.prepare('UPDATE sessions SET agent_state = ? WHERE id = ?').run(JSON.stringify(all), id);
  }

  private allAgentState(id: string): Record<string, AgentSessionState> {
    const row = this.db.prepare('SELECT agent_state FROM sessions WHERE id = ?').get(id) as { agent_state: string } | undefined;
    return row ? (JSON.parse(row.agent_state) as Record<string, AgentSessionState>) : {};
  }

  create(init: { title?: string; provider: string; model: string; cwd: string; agent?: string; startedBy?: string; spunFrom?: string }): SessionMeta {
    const now = Date.now();
    const id = randomUUID().replaceAll('-', '').slice(0, 8);
    const agent = init.agent ?? '';
    this.db
      .prepare('INSERT INTO sessions (id, title, provider, model, cwd, agent, created_at, updated_at, started_by, spun_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, init.title ?? '', init.provider, init.model, init.cwd, agent, now, now, init.startedBy ?? null, init.spunFrom ?? null);
    if (agent) {
      this.db.prepare('INSERT OR IGNORE INTO thread_members (session_id, agent, joined_at) VALUES (?, ?, ?)').run(id, agent, now);
      this.recordAttendance({ at: now, sessionId: id, subject: `agent:${agent}`, change: 'joined', by: init.startedBy });
    }
    return { id, title: init.title ?? '', provider: init.provider, model: init.model, cwd: init.cwd, agent, createdAt: now, updatedAt: now, ...(init.startedBy && { startedBy: init.startedBy }), ...(init.spunFrom && { spunFrom: init.spunFrom }) };
  }

  /** Threads an agent is in: as the thread's agent, or as a member. */
  sessionsWithAgent(agent: string): SessionMeta[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE agent = ? OR id IN (SELECT session_id FROM thread_members WHERE agent = ?) ORDER BY updated_at DESC')
      .all(agent, agent) as unknown as SessionRow[];
    return rows.map(toMeta);
  }

  /**
   * An agent is gone: every thread it was in stays, without it. A thread's own agent becomes whoever
   * else is in it, or nobody; its lead, if that was the agent, goes back to the first in.
   */
  detachAgent(agent: string): string[] {
    const affected = this.sessionsWithAgent(agent).map((meta) => meta.id);
    for (const id of affected) if (this.members(id).includes(agent)) this.recordAttendance({ at: Date.now(), sessionId: id, subject: `agent:${agent}`, change: 'left' });
    this.db.prepare('DELETE FROM thread_members WHERE agent = ?').run(agent);
    for (const id of affected) {
      const next = this.members(id)[0] ?? '';
      this.db.prepare('UPDATE sessions SET agent = ? WHERE id = ? AND agent = ?').run(next, id, agent);
      this.db.prepare('UPDATE sessions SET lead = NULL WHERE id = ? AND lead = ?').run(id, agent);
    }
    this.db.prepare("DELETE FROM connection_grants WHERE agent = ?").run(agent);
    return affected;
  }

  recordArtifact(a: Artifact): void {
    this.db
      .prepare('INSERT INTO artifacts (id, session_id, seq, title, kind, media_type, name, bytes, created_at, created_by, step_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.sessionId, a.seq, a.title, a.kind, a.mediaType, a.name, a.bytes, a.createdAt, a.by ?? null, a.stepId ?? null);
  }

  /**
   * What was made across a set of threads, newest first: a project's deliverables, which otherwise
   * exist only inside the thread that produced them. Pictures a workflow took of its own pages are
   * evidence on a step, not something someone made, so they're left out.
   */
  artifactsIn(sessionIds: readonly string[], limit = 60): Artifact[] {
    if (!sessionIds.length) return [];
    const ids = sessionIds.slice(0, 400);
    const marks = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM artifacts WHERE session_id IN (${marks}) AND (created_by IS NULL OR created_by != 'workflow') ORDER BY created_at DESC LIMIT ?`)
      .all(...ids, limit) as unknown as ArtifactRow[];
    return rows.map(toArtifact);
  }

  artifacts(sessionId: string): Artifact[] {
    return (this.db.prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY seq, created_at').all(sessionId) as unknown as ArtifactRow[]).map(toArtifact);
  }

  artifact(id: string): Artifact | undefined {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRow | undefined;
    return row && toArtifact(row);
  }

  /** Puts something out of this person's sight, until it changes. */
  dismiss(personId: string, key: string, value: string, at = Date.now()): void {
    this.db.prepare('INSERT INTO dismissals (person_id, key, value, at) VALUES (?, ?, ?, ?) ON CONFLICT (person_id, key) DO UPDATE SET value = excluded.value, at = excluded.at').run(personId, key, value, at);
  }

  /** Whether this person dismissed it as it is now. */
  isDismissed(personId: string, key: string, value: string): boolean {
    const row = this.db.prepare('SELECT value FROM dismissals WHERE person_id = ? AND key = ?').get(personId, key) as { value: string } | undefined;
    return row?.value === value;
  }

  /** Who answers in a group thread when nobody's named. */
  setLead(id: string, agent: string | null): void {
    this.db.prepare('UPDATE sessions SET lead = ? WHERE id = ?').run(agent, id);
  }

  /** How many agent-to-agent exchanges before asking, for this thread only; null goes back to the default. */
  setAgentsAnswerAll(id: string, on: boolean): void {
    this.db.prepare('UPDATE sessions SET answer_all = ? WHERE id = ?').run(on ? 1 : 0, id);
  }

  /** YOLO stays with the thread: polyphemus restarting (an update, a reboot) doesn't quietly start asking again. */
  setYolo(id: string, on: boolean): void {
    this.db.prepare('UPDATE sessions SET yolo = ? WHERE id = ?').run(on ? 1 : 0, id);
  }

  setGuardLimit(id: string, limit: number | null): void {
    this.db.prepare('UPDATE sessions SET guard_limit = ? WHERE id = ?').run(limit, id);
  }

  /** Threads spun out of this one, oldest first. */
  spinOuts(id: string): SessionMeta[] {
    return (this.db.prepare('SELECT * FROM sessions WHERE spun_from = ? ORDER BY created_at').all(id) as unknown as SessionRow[]).map(toMeta);
  }

  /**
   * Who's in a thread. A thread has nought or more agents (docs/design/agents.md): one is the
   * ordinary case, several is a group, and none is you and a bare model. Kept as its own table so
   * agents can come and go without rewriting the thread.
   */
  members(id: string): string[] {
    const rows = this.db.prepare('SELECT agent FROM thread_members WHERE session_id = ? ORDER BY joined_at, agent').all(id) as unknown as Array<{ agent: string }>;
    return rows.map((row) => row.agent);
  }

  addMember(id: string, agent: string, at = Date.now(), by?: string): void {
    const { changes } = this.db.prepare('INSERT OR IGNORE INTO thread_members (session_id, agent, joined_at) VALUES (?, ?, ?)').run(id, agent, at);
    if (Number(changes) > 0) this.recordAttendance({ at, sessionId: id, subject: `agent:${agent}`, change: 'joined', by });
    // The first one in is also the thread's agent, so anything that knows about one still works.
    const meta = this.get(id);
    if (meta && !meta.agent) this.db.prepare('UPDATE sessions SET agent = ? WHERE id = ?').run(agent, id);
  }

  removeMember(id: string, agent: string, by?: string, at = Date.now()): void {
    const { changes } = this.db.prepare('DELETE FROM thread_members WHERE session_id = ? AND agent = ?').run(id, agent);
    if (Number(changes) > 0) this.recordAttendance({ at, sessionId: id, subject: `agent:${agent}`, change: 'left', by });
    const meta = this.get(id);
    if (meta?.agent === agent) {
      // The thread's own agent left: hand that over to whoever is still here, or nobody.
      this.db.prepare('UPDATE sessions SET agent = ? WHERE id = ?').run(this.members(id)[0] ?? '', id);
    }
  }

  get(id: string): SessionMeta | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row && toMeta(row);
  }

  /** Finds a session by id or unique id prefix. */
  resolve(idOrPrefix: string): SessionMeta | undefined {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE id LIKE ? || '%' ORDER BY updated_at DESC LIMIT 2")
      .all(idOrPrefix) as unknown as SessionRow[];
    return rows.length === 1 && rows[0] ? toMeta(rows[0]) : this.get(idOrPrefix);
  }

  /**
   * The model a provider actually replied with, most recently. `model = "default"` means a vendor
   * CLI chooses for itself, so polyphemus genuinely doesn't know which model that is until one has
   * answered — and then it does, because every reply records the origin it came from.
   */
  lastReplyModelOn(provider: string): string | undefined {
    const row = this.db
      .prepare("SELECT origin_model FROM messages WHERE origin_provider = ? AND origin_model IS NOT NULL AND origin_model != 'default' ORDER BY seq DESC, created_at DESC LIMIT 1")
      .get(provider) as { origin_model: string } | undefined;
    return row?.origin_model || undefined;
  }

  /**
   * The last model actually used on a provider. Fallback needs this: a provider you're signed in
   * to but have named no alias for still has to be offerable, and guessing a model id would
   * fail exactly when you need it not to. Only ids that have really run are offered.
   */
  lastModelOn(provider: string): string | undefined {
    const row = this.db
      .prepare('SELECT model FROM sessions WHERE provider = ? ORDER BY updated_at DESC LIMIT 1')
      .get(provider) as { model: string } | undefined;
    return row?.model || undefined;
  }

  /**
   * Most recent first. Archived threads are left out unless asked for; `archived: true` lists only
   * those. `agent` means threads that agent is in, not only ones it started.
   */
  list(limit = 20, filter: { archived?: boolean; cwd?: string; agent?: string } = {}): SessionMeta[] {
    const where = [filter.archived ? 'archived_at IS NOT NULL' : 'archived_at IS NULL'];
    const params: Array<string | number> = [];
    if (filter.cwd !== undefined) {
      where.push('cwd = ?');
      params.push(filter.cwd);
    }
    if (filter.agent !== undefined) {
      where.push('(agent = ? OR id IN (SELECT session_id FROM thread_members WHERE agent = ?))');
      params.push(filter.agent, filter.agent);
    }
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, limit) as unknown as SessionRow[];
    return rows.map(toMeta);
  }

  recordModelOk(provider: string, model: string, at = Date.now()): void {
    this.db
      .prepare('INSERT INTO model_results (provider, model, last_ok_at) VALUES (?, ?, ?) ON CONFLICT(provider, model) DO UPDATE SET last_ok_at = excluded.last_ok_at')
      .run(provider, model, at);
  }

  recordModelError(provider: string, model: string, message: string, errorClass: string, at = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO model_results (provider, model, last_error_at, last_error, error_class) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider, model) DO UPDATE SET last_error_at = excluded.last_error_at, last_error = excluded.last_error, error_class = excluded.error_class`,
      )
      .run(provider, model, at, message.slice(0, 500), errorClass);
  }

  /** Keyed by "provider:model". */
  modelResults(): Map<string, ModelResult> {
    const rows = this.db.prepare('SELECT * FROM model_results').all() as unknown as Array<{
      provider: string;
      model: string;
      last_ok_at: number | null;
      last_error_at: number | null;
      last_error: string | null;
      error_class: string | null;
    }>;
    return new Map(
      rows.map((r) => [
        `${r.provider}:${r.model}`,
        {
          ...(r.last_ok_at !== null && { lastOkAt: r.last_ok_at }),
          ...(r.last_error_at !== null && { lastErrorAt: r.last_error_at }),
          ...(r.last_error !== null && { lastError: r.last_error }),
          ...(r.error_class !== null && { errorClass: r.error_class }),
        },
      ]),
    );
  }

  /**
   * Sessions this person can see, as SQL on `sessions s`. No id means the owner, who sees every row.
   * The same rule as who may open a thread: the deepest project that contains its folder, or — when
   * it isn't in one — the person who started it or was invited in. Done here so a count doesn't read
   * every thread into memory first (app review, 2026-09-20).
   */
  private visibleTo(personId?: string): { sql: string; params: string[] } {
    if (!personId) return { sql: '1', params: [] };
    const slug = '(SELECT p.slug FROM projects p WHERE s.cwd = p.path OR instr(s.cwd, p.path || ?) = 1 ORDER BY length(p.path) DESC LIMIT 1)';
    return {
      sql: `(${slug} IN (SELECT project FROM project_members WHERE person_id = ?) OR (${slug} IS NULL AND (s.started_by = ? OR s.id IN (SELECT session_id FROM thread_people WHERE person_id = ?))))`,
      params: [sep, personId, sep, `person:${personId}`, personId],
    };
  }

  /** Threads still on your lists, per "provider:model" they run on. With a person, only the ones they can see. */
  threadCounts(personId?: string): Map<string, number> {
    const { sql, params } = this.visibleTo(personId);
    const rows = this.db
      .prepare(`SELECT s.provider, s.model, COUNT(*) AS n FROM sessions s WHERE s.archived_at IS NULL AND ${sql} GROUP BY s.provider, s.model`)
      .all(...params) as unknown as Array<{ provider: string; model: string; n: number }>;
    return new Map(rows.map((r) => [`${r.provider}:${r.model}`, r.n]));
  }

  /** Holds a message sent while the thread was working, to be delivered when it stops. */
  queueMessage(q: { id: string; sessionId: string; personId: string; deviceId: string; body: Record<string, unknown> }, at = Date.now()): QueuedMessage {
    this.db.prepare('INSERT INTO queued_messages (id, session_id, person_id, device_id, body, queued_at) VALUES (?, ?, ?, ?, ?, ?)').run(q.id, q.sessionId, q.personId, q.deviceId, JSON.stringify(q.body), at);
    return { ...q, queuedAt: at };
  }

  /** A thread's held messages, oldest first; or every thread's, with no id. */
  queuedMessages(sessionId?: string): QueuedMessage[] {
    const rows = (sessionId
      ? this.db.prepare('SELECT * FROM queued_messages WHERE session_id = ? ORDER BY queued_at, rowid').all(sessionId)
      : this.db.prepare('SELECT * FROM queued_messages ORDER BY queued_at, rowid').all()) as unknown as Array<{ id: string; session_id: string; person_id: string; device_id: string; body: string; queued_at: number }>;
    return rows.map((r) => ({ id: r.id, sessionId: r.session_id, personId: r.person_id, deviceId: r.device_id, body: JSON.parse(r.body) as Record<string, unknown>, queuedAt: r.queued_at }));
  }

  /** Puts a held message at the front of its thread's queue: the next thing sent when the thread is free. */
  prioritiseMessage(id: string): boolean {
    return this.db.prepare('UPDATE queued_messages SET queued_at = 0 WHERE id = ?').run(id).changes > 0;
  }

  unqueueMessage(id: string): boolean {
    return this.db.prepare('DELETE FROM queued_messages WHERE id = ?').run(id).changes > 0;
  }

  recordUpload(id: string, personId: string, at = Date.now()): void {
    this.db.prepare('INSERT OR IGNORE INTO uploads (id, person_id, uploaded_at) VALUES (?, ?, ?)').run(id, personId, at);
  }

  uploadedBy(id: string, personId: string): boolean {
    return this.db.prepare('SELECT 1 FROM uploads WHERE id = ? AND person_id = ?').get(id, personId) !== undefined;
  }

  /** Threads whose messages carry an image, so it's shown to anyone who can see one of them. */
  sessionsWithImage(id: string): SessionMeta[] {
    // An image a message actually carries: an image block, or a picture a tool returned — never
    // any field that happens to be called "path" (a tool call's input is the model's to write), and
    // never a mention of the name (re-review, 2026-09-19).
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE id IN (
           SELECT m.session_id FROM messages m, json_each(m.content) b
           WHERE json_extract(b.value, '$.type') = 'image' AND substr(json_extract(b.value, '$.path'), -length(?) - 1) = '/' || ?
           UNION
           SELECT m.session_id FROM messages m, json_each(m.content) b, json_each(json_extract(b.value, '$.images')) i
           WHERE json_extract(b.value, '$.type') = 'tool_result' AND json_extract(i.value, '$.type') = 'image' AND substr(json_extract(i.value, '$.path'), -length(?) - 1) = '/' || ?)`,
      )
      .all(id, id, id, id) as unknown as SessionRow[];
    return rows.map(toMeta);
  }

  migrated(name: string): boolean {
    return this.db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name) !== undefined;
  }

  markMigrated(name: string, at = Date.now()): void {
    this.db.prepare('INSERT OR IGNORE INTO migrations (name, applied_at) VALUES (?, ?)').run(name, at);
  }

  /** Archived threads. With a person, only the ones they can see — counted in the database, not by loading the list. */
  archivedCount(personId?: string): number {
    const { sql, params } = this.visibleTo(personId);
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM sessions s WHERE s.archived_at IS NOT NULL AND ${sql}`).get(...params) as { n: number }).n;
  }

  /** Most recently active session started in `cwd`. An archived one is finished, so it isn't continued. */
  latest(cwd: string): SessionMeta | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE cwd = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1')
      .get(cwd) as SessionRow | undefined;
    return row && toMeta(row);
  }

  /** A new name isn't activity, so the thread keeps its place in the list. */
  setTitle(id: string, title: string): void {
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id);
  }

  setKept(id: string, kept: boolean): void {
    this.db.prepare('UPDATE sessions SET kept = ? WHERE id = ?').run(kept ? 1 : 0, id);
  }

  setFinished(id: string, finished: boolean, at = Date.now()): void {
    this.db.prepare('UPDATE sessions SET finished_at = ? WHERE id = ?').run(finished ? at : null, id);
  }

  setPaused(id: string, why: string | null): void {
    this.db.prepare('UPDATE sessions SET paused_why = ? WHERE id = ?').run(why, id);
  }

  /**
   * The last thing said in a thread, and who said it: what a row's second line shows. Skips tool
   * results, polyphemus's status lines, and the nudge that asks a new agent to introduce itself.
   */
  lastLine(sessionId: string, max = 140): { actor: string | null; role: 'user' | 'assistant'; text: string } | undefined {
    const rows = this.db
      .prepare('SELECT role, content, actor FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT 12')
      .all(sessionId) as unknown as Array<{ role: 'user' | 'assistant'; content: string; actor: string | null }>;
    for (const row of rows) {
      const blocks = JSON.parse(row.content) as Array<{ type: string; text?: string }>;
      const text = blocks
        .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
        .join(' ')
        .replace(/<polyphemus_status>[\s\S]*?<\/polyphemus_status>/g, '')
        .replace(/<\/?polyphemus_note[^>]*>/g, '')
        .replace(/\*\*|__|`/g, '')
        .replace(/(^|\s)#{1,6}\s+/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
      // Its wording has changed before; how it opens is what marks it as polyphemus's.
      if (!text || text.startsWith(INTRODUCE_YOURSELF_OPENING)) continue;
      return { actor: row.actor, role: row.role, text: text.length > max ? `${text.slice(0, max - 1)}…` : text };
    }
    return undefined;
  }

  /** The people who have said something in a thread, or started it, most recent first. */
  peopleIn(sessionId: string): string[] {
    const rows = this.db
      .prepare("SELECT actor FROM messages WHERE session_id = ? AND actor LIKE 'person:%' GROUP BY actor ORDER BY MAX(seq) DESC")
      .all(sessionId) as unknown as Array<{ actor: string }>;
    const started = this.get(sessionId)?.startedBy;
    const ids = rows.map((r) => r.actor.slice(7));
    if (started?.startsWith('person:') && !ids.includes(started.slice(7))) ids.push(started.slice(7));
    // Invited but yet to say anything: they're in the conversation, and it's in their list.
    for (const id of this.threadPeople(sessionId)) if (!ids.includes(id)) ids.push(id);
    return ids;
  }

  /** Adds your reaction to a message, or takes it back if it's already there. True when it's now on. */
  toggleReaction(sessionId: string, seq: number, actor: string, emoji: string, at = Date.now()): boolean {
    const { changes } = this.db.prepare('DELETE FROM reactions WHERE session_id = ? AND seq = ? AND actor = ? AND emoji = ?').run(sessionId, seq, actor, emoji);
    if (Number(changes) > 0) return false;
    this.db.prepare('INSERT INTO reactions (session_id, seq, actor, emoji, at) VALUES (?, ?, ?, ?, ?)').run(sessionId, seq, actor, emoji, at);
    return true;
  }

  /** A thread's reactions, message by message, in the order they were made. */
  reactions(sessionId: string): Array<{ seq: number; actor: string; emoji: string; at: number }> {
    return this.db.prepare('SELECT seq, actor, emoji, at FROM reactions WHERE session_id = ? ORDER BY at').all(sessionId) as unknown as Array<{ seq: number; actor: string; emoji: string; at: number }>;
  }

  /** People invited into a thread outside every project. */
  threadPeople(sessionId: string): string[] {
    const rows = this.db.prepare('SELECT person_id FROM thread_people WHERE session_id = ? ORDER BY joined_at').all(sessionId) as unknown as Array<{ person_id: string }>;
    return rows.map((row) => row.person_id);
  }

  addThreadPerson(sessionId: string, personId: string, at = Date.now(), by?: string): void {
    const { changes } = this.db.prepare('INSERT OR IGNORE INTO thread_people (session_id, person_id, joined_at) VALUES (?, ?, ?)').run(sessionId, personId, at);
    if (Number(changes) > 0) this.recordAttendance({ at, sessionId, subject: `person:${personId}`, change: 'joined', ...(by && { by }) });
  }

  removeThreadPerson(sessionId: string, personId: string, at = Date.now(), by?: string): void {
    const { changes } = this.db.prepare('DELETE FROM thread_people WHERE session_id = ? AND person_id = ?').run(sessionId, personId);
    if (Number(changes) > 0) this.recordAttendance({ at, sessionId, subject: `person:${personId}`, change: 'left', ...(by && { by }) });
  }

  setArchived(id: string, archived: boolean, at = Date.now()): void {
    this.db.prepare('UPDATE sessions SET archived_at = ? WHERE id = ?').run(archived ? at : null, id);
  }

  /**
   * Gone for good: the thread, its messages, its turns, and who was in it. A vendor CLI's own copy
   * of the conversation (Claude Code's transcript, Codex's rollout) is that tool's, and stays.
   */
  delete(id: string): boolean {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM thread_members WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM attendance WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM reactions WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM queued_messages WHERE session_id = ?').run(id);
      this.db.prepare('DELETE FROM artifacts WHERE session_id = ?').run(id);
      const { changes } = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id); // messages and turns cascade
      this.db.exec('COMMIT');
      return Number(changes) > 0;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Threads whose title or conversation contains `query`, archived ones included — finding an old
   * conversation is what search is for. Only words people and models actually said count: a match
   * inside a tool's output or a file it read would bury the thread you meant.
   */
  search(query: string, limit = 30): SessionMatch[] {
    const needle = query.trim();
    if (!needle) return [];
    const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE title LIKE ?1 ESCAPE '\\'
           OR id IN (SELECT session_id FROM messages WHERE content LIKE ?1 ESCAPE '\\')
         ORDER BY updated_at DESC LIMIT ?2`,
      )
      .all(like, limit * 3) as unknown as SessionRow[];
    const lower = needle.toLowerCase();
    const matches: SessionMatch[] = [];
    for (const row of rows) {
      const snippet = this.snippetFor(row.id, lower);
      if (snippet === undefined && !row.title.toLowerCase().includes(lower)) continue;
      matches.push({ meta: toMeta(row), ...(snippet !== undefined && { snippet }) });
      if (matches.length === limit) break;
    }
    return matches;
  }

  /** The latest thing said in a thread that contains `lower`, trimmed to the words around it. */
  private snippetFor(id: string, lower: string): string | undefined {
    const rows = this.db.prepare('SELECT content FROM messages WHERE session_id = ? ORDER BY seq DESC').all(id) as unknown as Array<{ content: string }>;
    for (const row of rows) {
      const blocks = JSON.parse(row.content) as Array<{ type: string; text?: string }>;
      for (const block of blocks) {
        if (block.type !== 'text' || !block.text) continue;
        const text = block.text.replace(/\s+/g, ' ');
        const at = text.toLowerCase().indexOf(lower);
        if (at < 0) continue;
        const start = Math.max(0, at - 50);
        const end = Math.min(text.length, at + lower.length + 70);
        return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
      }
    }
    return undefined;
  }

  setModel(id: string, provider: string, model: string): void {
    this.db.prepare('UPDATE sessions SET provider = ?, model = ?, updated_at = ? WHERE id = ?').run(provider, model, Date.now(), id);
  }

  /** Adds a message to the end of a thread, and says where in the thread it landed. */
  append(id: string, message: Message, actor?: string): number {
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      const { next } = this.db
        .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM messages WHERE session_id = ?')
        .get(id) as { next: number };
      this.db
        .prepare(
          'INSERT INTO messages (session_id, seq, role, content, origin_provider, origin_model, native, created_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          id,
          next,
          message.role,
          JSON.stringify(message.content),
          message.origin?.provider ?? null,
          message.origin?.model ?? null,
          message.native === undefined ? null : JSON.stringify(message.native),
          now,
          actor ?? null,
        );
      // Using an archived or finished thread brings it back: both mean done with, and it evidently isn't.
      this.db.prepare('UPDATE sessions SET updated_at = ?, archived_at = NULL, finished_at = NULL WHERE id = ?').run(now, id);
      this.db.exec('COMMIT');
      return next;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** How many messages a thread has: a position in it, without reading what any of them say. */
  messageCount(id: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(id) as unknown as { n: number };
    return row.n;
  }

  /** A thread's messages from a position in it onwards, skipping the ones before without reading them. */
  messagesFrom(id: string, from: number): Message[] {
    return this.messages(id, Math.max(0, from));
  }

  messages(id: string, from = 0): Message[] {
    const rows = this.db
      .prepare('SELECT role, content, origin_provider, origin_model, native FROM messages WHERE session_id = ? ORDER BY seq LIMIT -1 OFFSET ?')
      .all(id, from) as unknown as MessageRow[];
    return rows.map((row) => {
      const message: Message = { role: row.role, content: JSON.parse(row.content) };
      if (row.origin_provider && row.origin_model) message.origin = { provider: row.origin_provider, model: row.origin_model };
      if (row.native !== null) message.native = JSON.parse(row.native);
      return message;
    });
  }

  close(): void {
    this.db.close();
  }
}
