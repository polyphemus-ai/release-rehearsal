import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  describeTrigger,
  dueFiring,
  loadRoutines,
  resolveModel,
  type FireRecord,
  type Polyphemus,
  type ResolvedModel,
  type Routine,
  type RoutineProblem,
} from '@polyphemus/core';

// Runs routines on their schedules (docs/design/scheduling.md). Every firing is checked first
// (project, folder, model, login, usage, daily limit, overlap), recorded whatever happens, and
// run as a fresh thread. Successful runs stay quiet; three failures in a row pause the routine.

const TICK_MS = 20_000;
const PAUSE_AFTER = 3;

export interface RoutineRun {
  sessionId: string;
  /** `reply`: the last thing the agent said, for the "finished" notification. */
  done: Promise<{ ok: boolean; reason?: string; reply?: string }>;
}

export interface SchedulerHooks {
  /** Starts a fresh thread with the routine's prompt. */
  start(routine: Routine, model: ResolvedModel, title: string): RoutineRun;
  isRunning(sessionId: string): boolean;
  /** Whether a routine's agent still exists: a routine whose agent is gone stops rather than running without it. */
  agentExists?(routine: Routine): boolean;
  notify(title: string, body: string, kind: 'questions' | 'finished', url: string): void;
  log(line: string): void;
}

export interface Scheduler {
  /** Checks every routine's schedule once (the timer calls this; tests call it with a time). */
  tick(now?: number): void;
  /** Runs a routine now, through the same checks. */
  runNow(id: string): FireRecord | undefined;
  list(): { routines: Routine[]; problems: RoutineProblem[] };
  close(): void;
}

export function startScheduler(polyphemus: Polyphemus, hooks: SchedulerHooks, opts: { tickMs?: number } = {}): Scheduler {
  const reported = new Set<string>();
  const list = () => loadRoutines(polyphemus.home, polyphemus.store);
  // Routines that were running before acceptance existed keep running as they are: accepted once, here.
  if (polyphemus.store.routineState('*').acceptedDigest === 'as-they-were') {
    for (const routine of list().routines) if (routine.digest) polyphemus.store.updateRoutineState(routine.id, { acceptedDigest: routine.digest });
    polyphemus.store.updateRoutineState('*', { acceptedDigest: 'done' });
  }

  function failed(routine: Routine, reason: string, sessionId?: string): void {
    const failures = polyphemus.store.routineState(routine.id).failures + 1;
    const where = sessionId ? `/#/s/${sessionId}` : routine.project ? `/#/p/${routine.project}` : '/';
    if (failures >= PAUSE_AFTER) {
      const pausedReason = `${failures} failures in a row; the last: ${reason}`;
      polyphemus.store.updateRoutineState(routine.id, { failures, paused: true, pausedReason });
      hooks.log(`Routine ${routine.id} paused: ${pausedReason}`);
      hooks.notify(`Routine paused: ${routine.name}`, `${pausedReason}. Resume it with: poly routine resume ${routine.name}`, 'questions', where);
      return;
    }
    polyphemus.store.updateRoutineState(routine.id, { failures });
    hooks.log(`Routine ${routine.id} failed: ${reason}`);
    if (routine.notify.includes('failure')) hooks.notify(`Routine failed: ${routine.name}`, reason, 'questions', where);
  }

  function needsAcceptance(routine: Routine): boolean {
    return routine.project !== undefined && routine.digest !== undefined && polyphemus.store.routineState(routine.id).acceptedDigest !== routine.digest;
  }

  function fire(routine: Routine, trigger: string, slot: number, idemKey: string): FireRecord | undefined {
    const record = (status: FireRecord['status'], reason?: string) => polyphemus.store.recordFire({ routine: routine.id, trigger, slotAt: slot, idemKey, status, reason });
    const reject = (reason: string) => {
      const rec = record('rejected', reason);
      if (rec) failed(routine, reason);
      return rec;
    };
    const skip = (reason: string) => {
      const rec = record('skipped', reason);
      if (rec) hooks.log(`Routine ${routine.id} skipped: ${reason}`);
      return rec;
    };

    // A project's routines live in its folder, where its agents can write. What runs unattended is
    // only ever what a person accepted: a new or changed file waits (independent review, 2026-09-19).
    if (needsAcceptance(routine)) {
      const note = `${routine.name} is new or changed since a person last accepted it, so it doesn’t run until someone does.`;
      if (!reported.has(`accept:${routine.id}:${routine.digest}`)) {
        reported.add(`accept:${routine.id}:${routine.digest}`);
        hooks.notify(`Routine waiting: ${routine.name}`, note, 'questions', routine.project ? `/#/p/${routine.project}` : '/');
      }
      return skip(note);
    }
    // Checked before anything starts, so a firing never runs against something that's gone.
    if (routine.project && polyphemus.store.project(routine.project)?.status !== 'active') return reject(`project ${routine.project} isn't active`);
    if (!existsSync(routine.cwd)) return reject(`folder ${routine.cwd} doesn't exist`);
    if (routine.agent && hooks.agentExists && !hooks.agentExists(routine)) return reject(`its agent, ${routine.agent}, doesn't exist any more`);
    const ref = routine.model ?? polyphemus.config.defaultModel;
    if (!ref) return reject('no model: add model: to the routine, or pick a default model');
    let model: ResolvedModel;
    try {
      model = resolveModel(polyphemus.config, ref);
    } catch (err) {
      return reject((err as Error).message);
    }
    const status = polyphemus.status(model.provider);
    if (!status.ready) return reject(`${model.provider} isn't set up: ${status.note}`);
    // A provider that's out of usage or resting after failures isn't the routine's fault: skip without counting it.
    const why = polyphemus.unavailable(model.provider);
    if (why) return skip(`${model.provider} ${why}`);
    if (routine.maxRunsPerDay !== undefined) {
      const midnight = new Date(slot).setHours(0, 0, 0, 0);
      if (polyphemus.store.startedSince(routine.id, midnight) >= routine.maxRunsPerDay) return skip(`already ran ${routine.maxRunsPerDay} times today (max_runs_per_day)`);
    }
    if (routine.overlap === 'skip') {
      const busy = polyphemus.store.fires(routine.id, 10).find((f) => f.status === 'started' && !f.outcome && f.sessionId && hooks.isRunning(f.sessionId));
      if (busy) return skip('the previous run is still going');
    }

    const started = record('started');
    if (!started) return undefined; // this time was already handled
    const when = new Date(slot).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    let run: RoutineRun;
    try {
      run = hooks.start(routine, model, `${routine.name} · ${when}`);
    } catch (err) {
      polyphemus.store.finishFire(started.id, 'failed', (err as Error).message);
      failed(routine, (err as Error).message);
      return started;
    }
    polyphemus.store.fireStarted(started.id, run.sessionId);
    hooks.log(`Routine ${routine.id} started (${trigger}): thread ${run.sessionId}`);
    void run.done.then(({ ok, reason, reply }) => {
      if (ok) {
        polyphemus.store.finishFire(started.id, 'succeeded');
        polyphemus.store.updateRoutineState(routine.id, { failures: 0 });
        // The notification carries the result itself (a brief, a report), not just "it's done".
        if (routine.notify.includes('finish')) hooks.notify(`${routine.name} finished`, reply ?? 'Tap to see what it did.', 'finished', `/#/s/${run.sessionId}`);
      } else {
        polyphemus.store.finishFire(started.id, 'failed', reason);
        failed(routine, reason ?? 'the run failed', run.sessionId);
      }
    });
    return { ...started, sessionId: run.sessionId };
  }

  function tick(now = Date.now()): void {
    const { routines, problems } = list();
    for (const problem of problems) {
      if (reported.has(problem.message)) continue;
      reported.add(problem.message);
      hooks.log(`Routine not loaded: ${problem.message}`);
    }
    for (const routine of routines) {
      try {
        const state = polyphemus.store.routineState(routine.id);
        // A routine starts from when polyphemus first sees it (no backfill); a paused one lets its times pass.
        if (state.handledUntil === undefined || state.paused || !routine.enabled) {
          polyphemus.store.updateRoutineState(routine.id, { handledUntil: now });
          continue;
        }
        const { run, missed } = dueFiring(routine, state.handledUntil, now);
        polyphemus.store.updateRoutineState(routine.id, { handledUntil: now });
        if (missed > 0) {
          polyphemus.store.recordFire({
            routine: routine.id,
            trigger: 'schedule',
            slotAt: now,
            idemKey: `${routine.id}:missed:${state.handledUntil}`,
            status: 'skipped',
            reason: `missed ${missed} time${missed === 1 ? '' : 's'} while polyphemus was off`,
          });
        }
        if (run) fire(routine, describeTrigger(run.trigger), run.slot, `${routine.id}:${run.slot}`);
      } catch (err) {
        hooks.log(`Routine ${routine.id}: ${(err as Error).message}`);
      }
    }
  }

  const timer = setInterval(() => tick(), opts.tickMs ?? TICK_MS);
  timer.unref();

  return {
    tick,
    runNow: (id) => {
      const routine = list().routines.find((r) => r.id === id);
      if (!routine) return undefined;
      return fire(routine, 'run now', Date.now(), `${id}:now:${randomUUID()}`);
    },
    list,
    close: () => clearInterval(timer),
  };
}
