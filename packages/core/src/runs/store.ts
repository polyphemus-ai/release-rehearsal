import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

// Outcomes, runs, steps and evidence (docs/design/ui/settled-brief.md §3–4). A work item is a
// thread with an outcome; a run is one attempt at it; a step is one unit of a run, its transcript a
// range of the thread; evidence is what a step produced. Everything is written as it happens, so a
// restart finds exactly what was true — and marks what was running as interrupted, never running.

/** The only statuses there are. Where polyphemus can't derive one, it's `unknown`, with the reason. */
export type Status = 'queued' | 'running' | 'waiting' | 'retrying' | 'failed' | 'interrupted' | 'done' | 'unknown';

/**
 * - work: produces something polyphemus can check — a file, a commit, a call to a connection.
 * - think: only needs an answer; done means it answered, and says so.
 * - verify: re-checks an earlier step's result from its source.
 * - gate: stops for a person before the run continues.
 * - check (workflows): commands whose exit codes decide it.
 * - action (workflows): a side effect done by code, under a permit.
 */
export type StepKind = 'work' | 'think' | 'verify' | 'gate' | 'check' | 'action';

export interface Outcome {
  id: string;
  sessionId: string;
  text: string;
  /** Who set it: person:<id>, or agent:<id> when a person accepted an agent's proposal (acceptedBy). */
  setBy: string;
  acceptedBy?: string;
  setAt: number;
  droppedAt?: number;
  droppedBy?: string;
}

export interface Run {
  id: string;
  sessionId: string;
  outcomeId: string;
  /** 1, 2, 3… within the thread. */
  n: number;
  status: Status;
  reason?: string;
  startedBy: string;
  startedAt: number;
  endedAt?: number;
  /** A workflow run: the workflow it runs. Unset for a run an agent planned itself. */
  workflow?: string;
  /** Goes up whenever ownership changes (a restart, a retry by someone else): a worker from an older one can't act. */
  generation: number;
  /** What the workflow was started with. */
  input?: Record<string, unknown>;
}

export interface Step {
  id: string;
  runId: string;
  /** 1-based position in the run. */
  n: number;
  title: string;
  kind: StepKind;
  /** For a verify step: the step it checks. */
  verifies?: number;
  /** For a gate: what the person is asked to allow. */
  asks?: string;
  /** Who does it: an agent id, or none for the thread's default. */
  agent?: string;
  status: Status;
  reason?: string;
  startedAt?: number;
  endedAt?: number;
  /** Its transcript: messages [seqStart, seqEnd) of the thread. */
  seqStart?: number;
  seqEnd?: number;
  /** For a verify step: what it said it checked, and whether that passed. */
  check?: { passed: boolean; what: string };
  /** For a gate: who answered it. */
  answeredBy?: string;
  /** In a workflow: the node it ran (`work`, or `fix#2/test` inside a loop's second round). */
  node?: string;
  attempt?: number;
  /** An agent node's own thread: a fresh session for every attempt. */
  sessionId?: string;
  /** For a failed check: what failed, so the same failure twice can be told apart from progress. */
  signature?: string;
}

/**
 * What a step produced. A receipt is an acknowledgement from outside polyphemus (a service answered, a
 * commit is on a remote); without one it's local — it exists, and nothing else vouches for it.
 * A call that failed is recorded too: it's why a step failed.
 */
export interface Evidence {
  id: string;
  runId: string;
  stepId: string;
  kind: 'file' | 'commit' | 'call' | 'check';
  label: string;
  detail?: string;
  receipt?: string;
  ok: boolean;
  at: number;
}

export const RUN_SCHEMA = `
CREATE TABLE IF NOT EXISTS outcomes (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  text        TEXT NOT NULL,
  set_by      TEXT NOT NULL,
  accepted_by TEXT,
  set_at      INTEGER NOT NULL,
  dropped_at  INTEGER,
  dropped_by  TEXT
);
CREATE INDEX IF NOT EXISTS outcomes_by_session ON outcomes(session_id, set_at DESC);
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  outcome_id  TEXT NOT NULL,
  n           INTEGER NOT NULL,
  status      TEXT NOT NULL,
  reason      TEXT,
  started_by  TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  workflow    TEXT,
  generation  INTEGER NOT NULL DEFAULT 1,
  input       TEXT
);
CREATE INDEX IF NOT EXISTS runs_by_session ON runs(session_id, n);
CREATE TABLE IF NOT EXISTS steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  n           INTEGER NOT NULL,
  title       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  verifies    INTEGER,
  asks        TEXT,
  agent       TEXT,
  status      TEXT NOT NULL,
  reason      TEXT,
  started_at  INTEGER,
  ended_at    INTEGER,
  seq_start   INTEGER,
  seq_end     INTEGER,
  check_json  TEXT,
  answered_by TEXT,
  node        TEXT,
  attempt     INTEGER,
  session_id  TEXT,
  signature   TEXT
);
CREATE INDEX IF NOT EXISTS steps_by_run ON steps(run_id, n);
CREATE TABLE IF NOT EXISTS evidence (
  id       TEXT PRIMARY KEY,
  run_id   TEXT NOT NULL,
  step_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,
  label    TEXT NOT NULL,
  detail   TEXT,
  receipt  TEXT,
  ok       INTEGER NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_by_step ON evidence(step_id, at);
-- What a workflow's agent nodes submitted, every attempt.
CREATE TABLE IF NOT EXISTS run_artifacts (
  run_id   TEXT NOT NULL,
  node     TEXT NOT NULL,
  step_id  TEXT NOT NULL,
  data     TEXT NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS run_artifacts_by_run ON run_artifacts(run_id, at);
-- Actions a workflow took, by their key: doing one again does nothing.
CREATE TABLE IF NOT EXISTS run_actions (
  key        TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  node       TEXT NOT NULL,
  generation INTEGER NOT NULL,
  result     TEXT,
  at         INTEGER NOT NULL
);
`;

const id = () => randomUUID().replaceAll('-', '').slice(0, 12);

type Row = Record<string, string | number | null>;

const toOutcome = (r: Row): Outcome => ({
  id: String(r.id),
  sessionId: String(r.session_id),
  text: String(r.text),
  setBy: String(r.set_by),
  ...(r.accepted_by !== null && { acceptedBy: String(r.accepted_by) }),
  setAt: Number(r.set_at),
  ...(r.dropped_at !== null && { droppedAt: Number(r.dropped_at) }),
  ...(r.dropped_by !== null && { droppedBy: String(r.dropped_by) }),
});
const toRun = (r: Row): Run => ({
  id: String(r.id),
  sessionId: String(r.session_id),
  outcomeId: String(r.outcome_id),
  n: Number(r.n),
  status: r.status as Status,
  ...(r.reason !== null && { reason: String(r.reason) }),
  startedBy: String(r.started_by),
  startedAt: Number(r.started_at),
  ...(r.ended_at !== null && { endedAt: Number(r.ended_at) }),
  ...(r.workflow !== null && r.workflow !== undefined && { workflow: String(r.workflow) }),
  generation: Number(r.generation ?? 1),
  ...(r.input !== null && r.input !== undefined && { input: JSON.parse(String(r.input)) }),
});
const toStep = (r: Row): Step => ({
  id: String(r.id),
  runId: String(r.run_id),
  n: Number(r.n),
  title: String(r.title),
  kind: r.kind as StepKind,
  ...(r.verifies !== null && { verifies: Number(r.verifies) }),
  ...(r.asks !== null && { asks: String(r.asks) }),
  ...(r.agent !== null && { agent: String(r.agent) }),
  status: r.status as Status,
  ...(r.reason !== null && { reason: String(r.reason) }),
  ...(r.started_at !== null && { startedAt: Number(r.started_at) }),
  ...(r.ended_at !== null && { endedAt: Number(r.ended_at) }),
  ...(r.seq_start !== null && { seqStart: Number(r.seq_start) }),
  ...(r.seq_end !== null && { seqEnd: Number(r.seq_end) }),
  ...(r.check_json !== null && { check: JSON.parse(String(r.check_json)) }),
  ...(r.answered_by !== null && { answeredBy: String(r.answered_by) }),
  ...(r.node !== null && r.node !== undefined && { node: String(r.node) }),
  ...(r.attempt !== null && r.attempt !== undefined && { attempt: Number(r.attempt) }),
  ...(r.session_id !== null && r.session_id !== undefined && { sessionId: String(r.session_id) }),
  ...(r.signature !== null && r.signature !== undefined && { signature: String(r.signature) }),
});
const toEvidence = (r: Row): Evidence => ({
  id: String(r.id),
  runId: String(r.run_id),
  stepId: String(r.step_id),
  kind: r.kind as Evidence['kind'],
  label: String(r.label),
  ...(r.detail !== null && { detail: String(r.detail) }),
  ...(r.receipt !== null && { receipt: String(r.receipt) }),
  ok: Number(r.ok) === 1,
  at: Number(r.at),
});

export class RunStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(RUN_SCHEMA);
    // Columns added after the tables first shipped.
    const has = (table: string, column: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
    for (const [table, column, type] of [
      ['runs', 'workflow', 'TEXT'],
      ['runs', 'generation', 'INTEGER NOT NULL DEFAULT 1'],
      ['runs', 'input', 'TEXT'],
      ['steps', 'node', 'TEXT'],
      ['steps', 'attempt', 'INTEGER'],
      ['steps', 'session_id', 'TEXT'],
      ['steps', 'signature', 'TEXT'],
    ] as const) {
      if (!has(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  // ── Outcomes ──

  /** The outcome a thread is tracking now, if any. */
  outcome(sessionId: string): Outcome | undefined {
    const row = this.db.prepare('SELECT * FROM outcomes WHERE session_id = ? AND dropped_at IS NULL ORDER BY set_at DESC LIMIT 1').get(sessionId) as Row | undefined;
    return row && toOutcome(row);
  }

  outcomeById(outcomeId: string): Outcome | undefined {
    const row = this.db.prepare('SELECT * FROM outcomes WHERE id = ?').get(outcomeId) as Row | undefined;
    return row && toOutcome(row);
  }

  /** Gives a thread an outcome. It doesn't touch the thread itself: same id, same place in every list. */
  setOutcome(sessionId: string, text: string, setBy: string, acceptedBy?: string, at = Date.now()): Outcome {
    const current = this.outcome(sessionId);
    if (current) this.dropOutcome(sessionId, setBy, at);
    const outcomeId = id();
    this.db.prepare('INSERT INTO outcomes (id, session_id, text, set_by, accepted_by, set_at) VALUES (?, ?, ?, ?, ?, ?)').run(outcomeId, sessionId, text, setBy, acceptedBy ?? null, at);
    return this.outcomeById(outcomeId)!;
  }

  /** Back to a chat. The runs stay, and so does the transcript. */
  dropOutcome(sessionId: string, by: string, at = Date.now()): boolean {
    const result = this.db.prepare('UPDATE outcomes SET dropped_at = ?, dropped_by = ? WHERE session_id = ? AND dropped_at IS NULL').run(at, by, sessionId);
    return Number(result.changes) > 0;
  }

  // ── Runs ──

  runs(sessionId: string): Run[] {
    return (this.db.prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY n').all(sessionId) as Row[]).map(toRun);
  }

  run(runId: string): Run | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as Row | undefined;
    return row && toRun(row);
  }

  latestRun(sessionId: string): Run | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY n DESC LIMIT 1').get(sessionId) as Row | undefined;
    return row && toRun(row);
  }

  startRun(sessionId: string, outcomeId: string, startedBy: string, at = Date.now(), workflow?: { id: string; input: Record<string, unknown> }): Run {
    const n = (this.latestRun(sessionId)?.n ?? 0) + 1;
    const runId = id();
    this.db
      .prepare("INSERT INTO runs (id, session_id, outcome_id, n, status, started_by, started_at, workflow, input) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)")
      .run(runId, sessionId, outcomeId, n, startedBy, at, workflow?.id ?? null, workflow ? JSON.stringify(workflow.input) : null);
    return this.run(runId)!;
  }

  /** Workflow runs a restart interrupted, to carry on with. */
  interruptedWorkflows(reason: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE workflow IS NOT NULL AND status = 'interrupted' AND reason = ?").all(reason) as Row[]).map(toRun);
  }

  /** A new owner: anything still holding the old generation can't act. Returns the new one. */
  bumpGeneration(runId: string): number {
    this.db.prepare('UPDATE runs SET generation = generation + 1 WHERE id = ?').run(runId);
    return this.run(runId)!.generation;
  }

  /** One node's execution in a workflow run, added as it starts. */
  addStep(runId: string, step: { title: string; kind: StepKind; node: string; attempt: number; asks?: string; status?: Status; sessionId?: string }, at = Date.now()): Step {
    const stepId = id();
    const n = ((this.db.prepare('SELECT MAX(n) AS n FROM steps WHERE run_id = ?').get(runId) as { n: number | null }).n ?? 0) + 1;
    this.db
      .prepare('INSERT INTO steps (id, run_id, n, title, kind, asks, status, started_at, node, attempt, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(stepId, runId, n, step.title, step.kind, step.asks ?? null, step.status ?? 'running', at, step.node, step.attempt, step.sessionId ?? null);
    return this.step(stepId)!;
  }

  setStepSession(stepId: string, sessionId: string): void {
    this.db.prepare('UPDATE steps SET session_id = ? WHERE id = ?').run(sessionId, stepId);
  }

  setStepSignature(stepId: string, signature: string): void {
    this.db.prepare('UPDATE steps SET signature = ? WHERE id = ?').run(signature, stepId);
  }

  saveArtifact(runId: string, node: string, stepId: string, data: unknown, at = Date.now()): void {
    this.db.prepare('INSERT INTO run_artifacts (run_id, node, step_id, data, at) VALUES (?, ?, ?, ?, ?)').run(runId, node, stepId, JSON.stringify(data), at);
  }

  /** The latest artifact each node submitted. */
  runArtifacts(runId: string): Record<string, unknown> {
    const rows = this.db.prepare('SELECT node, data FROM run_artifacts WHERE run_id = ? ORDER BY at, rowid').all(runId) as Array<{ node: string; data: string }>;
    return Object.fromEntries(rows.map((r) => [r.node, JSON.parse(r.data)]));
  }

  stepArtifact(stepId: string): unknown {
    const row = this.db.prepare('SELECT data FROM run_artifacts WHERE step_id = ? ORDER BY at DESC LIMIT 1').get(stepId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  /** An action already taken under this key, if any. */
  action(key: string): { runId: string; node: string; generation: number; result: unknown } | undefined {
    const row = this.db.prepare('SELECT * FROM run_actions WHERE key = ?').get(key) as { run_id: string; node: string; generation: number; result: string | null } | undefined;
    return row && { runId: row.run_id, node: row.node, generation: row.generation, result: row.result === null ? undefined : JSON.parse(row.result) };
  }

  recordAction(key: string, runId: string, node: string, generation: number, result: unknown, at = Date.now()): void {
    this.db.prepare('INSERT OR IGNORE INTO run_actions (key, run_id, node, generation, result, at) VALUES (?, ?, ?, ?, ?, ?)').run(key, runId, node, generation, result === undefined ? null : JSON.stringify(result), at);
  }

  setRunStatus(runId: string, status: Status, reason?: string, at = Date.now()): void {
    const ended = ['failed', 'interrupted', 'done', 'unknown'].includes(status);
    this.db.prepare('UPDATE runs SET status = ?, reason = ?, ended_at = ? WHERE id = ?').run(status, reason ?? null, ended ? at : null, runId);
  }

  // ── Steps ──

  steps(runId: string): Step[] {
    return (this.db.prepare('SELECT * FROM steps WHERE run_id = ? ORDER BY n').all(runId) as Row[]).map(toStep);
  }

  step(stepId: string): Step | undefined {
    const row = this.db.prepare('SELECT * FROM steps WHERE id = ?').get(stepId) as Row | undefined;
    return row && toStep(row);
  }

  /** A run's plan, once: steps are queued in order. */
  planSteps(runId: string, plan: Array<Pick<Step, 'title' | 'kind' | 'verifies' | 'asks' | 'agent'>>): Step[] {
    const insert = this.db.prepare("INSERT INTO steps (id, run_id, n, title, kind, verifies, asks, agent, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')");
    plan.forEach((s, i) => insert.run(id(), runId, i + 1, s.title, s.kind, s.verifies ?? null, s.asks ?? null, s.agent ?? null));
    return this.steps(runId);
  }

  startStep(stepId: string, seqStart: number, status: Status = 'running', at = Date.now()): void {
    this.db.prepare('UPDATE steps SET status = ?, started_at = ?, seq_start = ? WHERE id = ?').run(status, at, seqStart, stepId);
  }

  setStepStatus(stepId: string, status: Status, reason?: string, extra: { seqEnd?: number; answeredBy?: string } = {}, at = Date.now()): void {
    const ended = ['failed', 'interrupted', 'done', 'unknown'].includes(status);
    this.db
      .prepare('UPDATE steps SET status = ?, reason = ?, ended_at = COALESCE(?, ended_at), seq_end = COALESCE(?, seq_end), answered_by = COALESCE(?, answered_by) WHERE id = ?')
      .run(status, reason ?? null, ended ? at : null, extra.seqEnd ?? null, extra.answeredBy ?? null, stepId);
  }

  recordCheck(stepId: string, check: { passed: boolean; what: string }): void {
    this.db.prepare('UPDATE steps SET check_json = ? WHERE id = ?').run(JSON.stringify(check), stepId);
  }

  // ── Evidence ──

  addEvidence(e: Omit<Evidence, 'id' | 'at'>, at = Date.now()): Evidence {
    const evidenceId = id();
    this.db
      .prepare('INSERT INTO evidence (id, run_id, step_id, kind, label, detail, receipt, ok, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(evidenceId, e.runId, e.stepId, e.kind, e.label, e.detail ?? null, e.receipt ?? null, e.ok ? 1 : 0, at);
    return toEvidence(this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(evidenceId) as Row);
  }

  evidence(stepId: string): Evidence[] {
    return (this.db.prepare('SELECT * FROM evidence WHERE step_id = ? ORDER BY at, rowid').all(stepId) as Row[]).map(toEvidence);
  }

  runEvidence(runId: string): Evidence[] {
    return (this.db.prepare('SELECT * FROM evidence WHERE run_id = ? ORDER BY at, rowid').all(runId) as Row[]).map(toEvidence);
  }

  // ── Restarts ──

  /**
   * After a restart nothing is running, whatever the database last said: a step that was running,
   * retrying or waiting at a gate is interrupted, and so is its run. Returns the threads affected.
   */
  /** A workflow's runs that haven't ended. */
  activeWorkflowRuns(workflow: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE workflow = ? AND status IN ('queued', 'running', 'waiting', 'retrying')").all(workflow) as Row[]).map(toRun);
  }

  interruptActive(reason: string, at = Date.now()): string[] {
    const active = (this.db.prepare("SELECT * FROM runs WHERE status IN ('queued', 'running', 'waiting', 'retrying')").all() as Row[]).map(toRun);
    for (const run of active) {
      this.db.prepare("UPDATE steps SET status = 'interrupted', reason = ?, ended_at = ? WHERE run_id = ? AND status IN ('running', 'waiting', 'retrying')").run(reason, at, run.id);
      this.setRunStatus(run.id, 'interrupted', reason, at);
    }
    return [...new Set(active.map((r) => r.sessionId))];
  }
}
