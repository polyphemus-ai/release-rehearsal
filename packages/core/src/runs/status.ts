import type { Evidence, Status, Step } from './store.js';

// Status comes only from something that happened (settled brief §4): a process exit, a service's
// answer, a file that exists, a gate a person answered. What an agent says about its own work sets
// nothing — "I wrote 52 records" after a 401 is a failed step, whatever the reply says.

export interface Derived {
  status: Status;
  reason?: string;
}

/** How a step's turn ended, as polyphemus saw it. */
export type TurnEnd = { kind: 'completed' } | { kind: 'aborted' } | { kind: 'error'; message: string };

const ENDED: readonly Status[] = ['failed', 'interrupted', 'done', 'unknown'];
export const isEnded = (status: Status) => ENDED.includes(status);

/** Calls that failed and weren't followed by the same call succeeding. */
function unrecoveredFailures(evidence: readonly Evidence[]): Evidence[] {
  return evidence.filter((e, i) => e.kind === 'call' && !e.ok && !evidence.slice(i + 1).some((later) => later.kind === 'call' && later.ok && later.label === e.label));
}

/**
 * A verify step before it runs: there has to be a confirmed result to verify. If the step it checks
 * isn't done, the verification fails here, without asking a model — which is how a claimed write that
 * never happened is caught even when the agent insists it worked.
 */
export function precheckVerify(step: Step, target: Step | undefined): Derived | undefined {
  if (step.kind !== 'verify') return undefined;
  if (!target) return { status: 'failed', reason: `Step ${step.verifies ?? '?'} isn’t part of this run, so there’s nothing to verify.` };
  if (target.status === 'done') return undefined;
  const why = target.reason ? `${target.status}: ${target.reason}` : target.status;
  return { status: 'failed', reason: `Step ${target.n} isn’t done (${why}), so there’s no confirmed result to verify.` };
}

/** A step's status once its turn has ended. */
export function deriveStep(step: Step, end: TurnEnd, evidence: readonly Evidence[]): Derived {
  if (end.kind === 'aborted') return { status: 'interrupted', reason: 'Stopped before it finished.' };
  if (end.kind === 'error') return { status: 'failed', reason: end.message };
  const failed = unrecoveredFailures(evidence);
  if (failed.length > 0) return { status: 'failed', reason: failed.map((e) => `${e.label}: ${e.detail ?? 'failed'}`).join('; ') };
  const confirmed = evidence.filter((e) => e.ok);
  switch (step.kind) {
    case 'think':
      return { status: 'done', reason: 'It answered; there was nothing else to check.' };
    case 'work':
      return confirmed.length > 0
        ? { status: 'done' }
        : { status: 'unknown', reason: 'It ended without anything polyphemus could check — no file, commit or confirmed call. What it said is in the thread.' };
    case 'verify':
      if (!step.check) return { status: 'unknown', reason: 'It didn’t record whether the check passed.' };
      if (!step.check.passed) return { status: 'failed', reason: `The check failed: ${step.check.what}` };
      return confirmed.length > 0
        ? { status: 'done', reason: `Checked: ${step.check.what}` }
        : { status: 'unknown', reason: `It said the check passed (${step.check.what}), but read nothing polyphemus can see.` };
    case 'gate':
      return { status: 'unknown', reason: 'A gate is answered by a person, not by a turn.' };
    default:
      // Checks and actions belong to workflows, whose engine records their status directly.
      return { status: 'unknown', reason: 'Polyphemus didn’t record how this ended.' };
  }
}

/** A run's status, from its steps. */
export function deriveRun(steps: readonly Step[]): Derived {
  if (steps.length === 0) return { status: 'unknown', reason: 'It has no steps.' };
  const first = (status: Status) => steps.find((s) => s.status === status);
  for (const status of ['running', 'retrying', 'waiting'] as const) {
    const step = first(status);
    if (step) return { status, reason: `Step ${step.n}: ${step.title}` };
  }
  for (const status of ['failed', 'interrupted', 'unknown'] as const) {
    const step = first(status);
    if (step) return { status, reason: `Step ${step.n}, ${step.title}: ${step.reason ?? status}` };
  }
  if (steps.every((s) => s.status === 'done')) return { status: 'done' };
  return { status: 'queued' };
}
