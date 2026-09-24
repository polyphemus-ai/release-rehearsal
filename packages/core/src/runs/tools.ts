import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { relative } from 'node:path';
import { promisify } from 'node:util';
import { resolvePath, type Tool } from '../tools/tool.js';
import { PolyphemusError } from '../types.js';
import type { RunStore, Step, StepKind } from './store.js';
import { misfit, toJsonSchema, type Shape } from '../workflows/define.js';

// The tools an agent works a run with. They let it say what it plans and point at what it made —
// and polyphemus checks each pointer itself: a file has to exist, a commit has to be in the repository.
// Nothing here lets an agent set a status.

/** The run a turn belongs to: planning it, or doing one of its steps. */
export interface WorkContext {
  runId: string;
  /** The planning turn, before there are steps. */
  planning?: boolean;
  step?: Step;
  /** Total steps, for the prompt. */
  of?: number;
  /** A workflow's agent node: it finishes by submitting an artifact that fits this shape. */
  submit?: { shape: Shape; accept(data: unknown): void };
}

const KINDS: readonly StepKind[] = ['work', 'think', 'verify', 'gate'];
const MAX_STEPS = 12;
const run = promisify(execFile);

export interface PlannedStep {
  title: string;
  kind: StepKind;
  verifies?: number;
  asks?: string;
}

/** Checks a plan before any of it is kept: every verify points back at a step, every gate says what it asks. */
export function checkPlan(value: unknown): PlannedStep[] {
  if (!Array.isArray(value) || value.length === 0) throw new PolyphemusError('A plan needs at least one step.', 'USAGE');
  if (value.length > MAX_STEPS) throw new PolyphemusError(`Keep it to ${MAX_STEPS} steps or fewer: a longer job is more than one outcome.`, 'USAGE');
  return value.map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const n = i + 1;
    const title = typeof s.title === 'string' ? s.title.trim() : '';
    if (!title) throw new PolyphemusError(`Step ${n} needs a title.`, 'USAGE');
    const kind = s.kind as StepKind;
    if (!KINDS.includes(kind)) throw new PolyphemusError(`Step ${n}'s kind must be one of ${KINDS.join(', ')}.`, 'USAGE');
    const step: PlannedStep = { title: title.slice(0, 120), kind };
    if (kind === 'verify') {
      const verifies = Number(s.verifies);
      if (!Number.isInteger(verifies) || verifies < 1 || verifies >= n) throw new PolyphemusError(`Step ${n} verifies an earlier step: give "verifies" its number.`, 'USAGE');
      const target = value[verifies - 1] as Record<string, unknown>;
      if (target?.kind === 'gate') throw new PolyphemusError(`Step ${n} can't verify a gate: a person answered it.`, 'USAGE');
      step.verifies = verifies;
    }
    if (kind === 'gate') {
      const asks = typeof s.asks === 'string' ? s.asks.trim() : '';
      if (!asks) throw new PolyphemusError(`Step ${n} is a gate: say in "asks" what the person is allowing.`, 'USAGE');
      step.asks = asks.slice(0, 300);
    }
    return step;
  });
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

/** The tools for this turn of a run, bound to it. */
export function runTools(store: RunStore, work: WorkContext, cwd: string): Tool[] {
  const tools: Tool[] = [];
  if (work.planning) {
    tools.push({
      spec: {
        name: 'plan_run',
        description:
          'Record the plan for this run, once, as short steps. Kinds: "work" makes something polyphemus can check (a file, a commit, a call to a connection); "think" only needs your answer; "gate" stops for a person before anything that can’t be undone — give "asks"; "verify" re-checks an earlier step’s result from its source — give "verifies", that step’s number.',
        inputSchema: object(
          {
            steps: {
              type: 'array',
              items: object({ title: { type: 'string' }, kind: { type: 'string', enum: KINDS }, verifies: { type: 'number' }, asks: { type: 'string' } }, ['title', 'kind']),
            },
          },
          ['steps'],
        ),
      },
      mutates: false,
      describe: (input) => `plan: ${Array.isArray(input.steps) ? input.steps.length : 0} steps`,
      run: async (input) => {
        if (store.steps(work.runId).length > 0) return { content: 'This run already has a plan.', isError: true };
        try {
          const plan = checkPlan(input.steps);
          store.planSteps(work.runId, plan);
          return { content: `Planned ${plan.length} steps. Stop here: polyphemus runs them one at a time and tells you each one.` };
        } catch (err) {
          return { content: (err as Error).message, isError: true };
        }
      },
    });
  }
  const submit = work.submit;
  if (submit) {
    tools.push({
      spec: {
        name: 'submit',
        description: 'Finish this step by submitting what it produced, in the shape asked for. Polyphemus checks the shape; nothing else you say marks the step done.',
        inputSchema: toJsonSchema(submit.shape),
      },
      mutates: false,
      describe: () => 'submit',
      run: async (input) => {
        const wrong = misfit(input, submit.shape);
        if (wrong) return { content: `Not submitted: ${wrong}. Fix it and submit again.`, isError: true };
        submit.accept(input);
        return { content: 'Submitted. Stop here: polyphemus takes it from here.' };
      },
    });
  }
  const step = work.step;
  if (step && step.kind !== 'gate') {
    tools.push({
      spec: {
        name: 'record_evidence',
        description:
          'Point polyphemus at something this step produced: a file (path) or a commit (sha). Polyphemus checks it exists before recording it. Calls to connections are recorded without this.',
        inputSchema: object({ path: { type: 'string' }, commit: { type: 'string' } }),
      },
      mutates: false,
      describe: (input) => String(input.path ?? input.commit ?? ''),
      run: async (input) => {
        if (typeof input.path === 'string' && input.path) {
          const full = resolvePath(cwd, input.path);
          let size: number;
          try {
            const stat = statSync(full);
            if (!stat.isFile()) return { content: `${input.path} isn’t a file.`, isError: true };
            size = stat.size;
          } catch {
            return { content: `There’s no file at ${input.path}, so nothing was recorded.`, isError: true };
          }
          const label = relative(cwd, full).startsWith('..') ? full : relative(cwd, full);
          store.addEvidence({ runId: work.runId, stepId: step.id, kind: 'file', label, detail: size < 1024 ? `${size} bytes` : `${Math.round(size / 1024)} KB`, ok: true });
          return { content: `Recorded ${label} (it exists; nothing outside polyphemus vouches for it).` };
        }
        if (typeof input.commit === 'string' && /^[0-9a-f]{7,40}$/i.test(input.commit)) {
          const sha = input.commit;
          try {
            await run('git', ['-C', cwd, 'cat-file', '-e', `${sha}^{commit}`]);
          } catch {
            return { content: `There’s no commit ${sha} in this repository, so nothing was recorded.`, isError: true };
          }
          const subject = await run('git', ['-C', cwd, 'log', '-1', '--format=%h %s', sha]).then((r) => r.stdout.trim()).catch(() => sha);
          // A receipt only if a remote has it: until then only this computer vouches for it.
          const remote = await run('git', ['-C', cwd, 'branch', '-r', '--contains', sha]).then((r) => r.stdout.trim().split('\n')[0]?.trim()).catch(() => '');
          store.addEvidence({ runId: work.runId, stepId: step.id, kind: 'commit', label: subject, receipt: remote ? `on ${remote}` : undefined, ok: true });
          return { content: `Recorded commit ${subject}${remote ? `, on ${remote}` : ' (not on any remote yet)'}.` };
        }
        return { content: 'Give a file path, or a commit sha.', isError: true };
      },
    });
  }
  if (step?.kind === 'verify') {
    tools.push({
      spec: {
        name: 'record_check',
        description: `Say whether step ${step.verifies}’s result held up, after reading it back from its source, and what you checked. A check that passes needs something polyphemus can see you read.`,
        inputSchema: object({ passed: { type: 'boolean' }, what: { type: 'string' } }, ['passed', 'what']),
      },
      mutates: false,
      describe: (input) => `${input.passed ? 'passed' : 'failed'}: ${String(input.what ?? '')}`,
      run: async (input) => {
        if (typeof input.passed !== 'boolean' || typeof input.what !== 'string' || !input.what.trim()) return { content: 'Say passed (true or false) and what you checked.', isError: true };
        store.recordCheck(step.id, { passed: input.passed, what: input.what.trim().slice(0, 300) });
        return { content: 'Recorded.' };
      },
    });
  }
  return tools;
}

/** What the agent is told at the start of a run's turn. */
export function runPrompt(work: WorkContext, outcome: string, runN: number, history: string): string {
  if (work.planning) {
    return [
      `<polyphemus_run>You're starting run ${runN} for the outcome: "${outcome}".`,
      'Plan it with plan_run, then stop — polyphemus runs the steps one at a time and tells you each one. Keep steps small, each one thing.',
      'Put a gate before anything that can’t be undone: writing to an outside service, deleting, sending. After any step whose result matters, add a verify step that reads it back from its source.',
      'Status comes from what polyphemus can check, not from what you say: a work step is done when it produced a file, a commit or a call that succeeded.',
      history ? `Earlier runs:\n${history}` : '',
      '</polyphemus_run>',
    ]
      .filter(Boolean)
      .join('\n');
  }
  const step = work.step!;
  const what =
    step.kind === 'verify'
      ? `Re-check step ${step.verifies}'s result from its source — read it back; don't rely on what was said — then call record_check with whether it held up and what you checked.`
      : step.kind === 'think'
        ? 'Answer it. Nothing else is needed.'
        : 'Do this step only. Point polyphemus at what you produce with record_evidence (files, commits); calls to connections are recorded for you. If you can’t do it, say why and stop.';
  return `<polyphemus_run>Run ${runN}, step ${step.n} of ${work.of ?? '?'} for "${outcome}": ${step.title}\n${what}</polyphemus_run>`;
}
