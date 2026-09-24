import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  artifactFile,
  failureSignature,
  keepArtifact,
  findWorkflow,
  headCommit,
  misfit,
  runCheck,
  workingTreeFingerprint,
  type CheckResult,
  type NodeContext,
  type Permit,
  type Workflow,
  type WorkflowNode,
  deriveRun,
  deriveStep,
  isEnded,
  precheckVerify,
  runPrompt,
  type Polyphemus,
  type ResolvedModel,
  type WorkflowServices,
  type GateOption,
  GITHUB_ROLES,
  PolyphemusError,
  type Run,
  type SessionRuntime,
  type Status,
  type Step,
  type StopReason,
  type StoredQuestion,
  type TurnEnd,
} from '@polyphemus/core';

// Runs, driven by the daemon (settled brief §3–4). A run plans itself in one turn, then works its
// steps one turn each; a gate stops it for a person, and answering the gate carries on. Every
// status is derived from what happened and written the moment it's known, so a restart finds the
// truth: what was running is interrupted, never still running.

interface Live {
  id: string;
  runtime: SessionRuntime;
  running?: AbortController;
}

export interface RunDeps {
  polyphemus: Polyphemus;
  liveSession(id: string): Live | undefined;
  startTurn(entry: Live, text: string, opts: { quiet?: boolean }): Promise<{ stop?: StopReason; error?: string }>;
  broadcast(data: Record<string, unknown>): void;
  /** A question for whoever can work in the thread, kept in the database like any other. */
  announceQuestion(question: StoredQuestion): void;
  notify(sessionId: string, body: string): void;
  /** True once the daemon is shutting down: nothing more is written for a run after that. */
  closing(): boolean;
  /** A fresh session for one attempt at a workflow's agent node: its own thread, linked to the run's. */
  openNodeSession(run: Run, agent: string | undefined, title: string, opts: { cwd: string; model?: ResolvedModel }): Live;
  /** Starts the next workflow in a queue, in a thread of its own beside this run's. Resolves to its thread. */
  startNext(after: Run, next: { workflow: string; input: Record<string, unknown> }): string;
  /** A ready model from a different vendor than this provider's, for a judge that isn't the author. */
  otherVendorModel(provider: string): ResolvedModel | undefined;
  personName(actor: string | undefined): string;
  log?(line: string): void;
}

const ACTIVE: readonly Status[] = ['queued', 'running', 'waiting', 'retrying'];
export const RESTARTED = 'polyphemus restarted while it was running.';
const idle = async (entry: Live) => {
  for (let i = 0; entry.running && i < 3000; i++) await new Promise((r) => setTimeout(r, 100));
};

export function runExecutor(deps: RunDeps) {
  const { polyphemus } = deps;
  const store = polyphemus.store.runs;
  const changed = (sessionId: string): void => {
    if (!deps.closing()) deps.broadcast({ type: 'work_changed', sessionId });
  };

  const activeRun = (sessionId: string): Run | undefined => {
    const run = store.latestRun(sessionId);
    return run && ACTIVE.includes(run.status) ? run : undefined;
  };

  /** Runs before this one, in a few lines, so run 2 knows how run 1 went without replaying it. */
  function history(sessionId: string, before: number): string {
    return store
      .runs(sessionId)
      .filter((r) => r.n < before)
      .map((r) => {
        const steps = store.steps(r.id).map((s) => `  ${s.n}. ${s.title} — ${s.status}${s.reason ? ` (${s.reason})` : ''}`);
        return [`Run ${r.n}: ${r.status}${r.reason ? ` — ${r.reason}` : ''}`, ...steps].join('\n');
      })
      .join('\n');
  }

  function finish(run: Run): void {
    const derived = deriveRun(store.steps(run.id));
    store.setRunStatus(run.id, derived.status, derived.reason);
    changed(run.sessionId);
    deps.log?.(`Run ${run.n} in ${run.sessionId}: ${derived.status}${derived.reason ? ` — ${derived.reason}` : ''}`);
    const outcome = store.outcomeById(run.outcomeId);
    deps.notify(run.sessionId, derived.status === 'done' ? `Done: ${outcome?.text ?? 'the run'} — every step confirmed.` : `Run ${run.n} ${derived.status}: ${derived.reason ?? ''}`);
  }

  /** One turn of the run, with its work context set for exactly that turn. */
  async function turn(entry: Live, work: NonNullable<SessionRuntime['work']>, prompt: string, onModelSwitch?: () => void): Promise<TurnEnd> {
    await idle(entry);
    entry.runtime.work = work;
    const off = onModelSwitch ? entry.runtime.on((event) => event.type === 'model' && onModelSwitch()) : undefined;
    try {
      const result = await deps.startTurn(entry, prompt, { quiet: true });
      return result.error ? { kind: 'error', message: result.error } : result.stop === 'aborted' ? { kind: 'aborted' } : { kind: 'completed' };
    } finally {
      off?.();
      entry.runtime.work = undefined;
    }
  }

  // ── Workflows (docs/design/workflows.md) ──
  // The engine walks a workflow's nodes in order. Whether a node is done is decided here, from what
  // happened; a node already done is skipped, so after a gate or a restart the run carries on from
  // where it was. Every attempt at an agent node is a fresh session of its own.

  function askGate(run: Run, step: Step, asks: string, title: string, options?: GateOption[]): void {
    store.setRunStatus(run.id, 'waiting', `${title}`);
    const outcome = store.outcomeById(run.outcomeId);
    const question = polyphemus.store.askQuestion({
      id: randomUUID().slice(0, 8),
      sessionId: run.sessionId,
      kind: 'gate',
      detail: { runId: run.id, stepId: step.id, step: step.n, of: store.steps(run.id).length, run: run.n, title, asks, outcome: outcome?.text ?? '', ...(options && { options }) },
    });
    deps.announceQuestion(question);
  }

  async function driveWorkflow(runId: string): Promise<void> {
    const started = store.run(runId);
    if (!started?.workflow || isEnded(started.status)) return;
    const workflow = findWorkflow(started.workflow);
    const parent = deps.liveSession(started.sessionId);
    if (!workflow || !parent) {
      store.setRunStatus(runId, 'failed', workflow ? 'Its thread is gone.' : `There's no workflow called ${started.workflow} any more.`);
      return changed(started.sessionId);
    }
    const generation = started.generation;
    const home = parent.runtime.cwd;
    const project = polyphemus.store.projectFor(home)?.slug;
    const services: WorkflowServices = {
      async github(role) {
        const title = GITHUB_ROLES[role].title;
        const found = project ? polyphemus.connections.githubIdentity(project, role) : undefined;
        if (!found) throw new PolyphemusError(`No GitHub ${title} identity is granted to ${project ?? 'this thread'}: make one in Connections → GitHub, install it on the repository, and grant it to the project.`, 'USAGE');
        const { token } = await polyphemus.connections.githubToken(found.connection);
        const { name, slug } = found.record;
        return { connection: found.connection, name, login: `${slug}[bot]`, token, author: { name, email: `${slug}[bot]@users.noreply.github.com` } };
      },
      worker: (cwd) => polyphemus.runWorker(cwd),
      hasGitHub: (role) => (project ? polyphemus.connections.githubIdentity(project, role) !== undefined : false),
      async workItem({ title, body }) {
        const parentMeta = polyphemus.store.get(started.sessionId)!;
        const already = polyphemus.store.list(500, { cwd: home }).find((m) => m.spunFrom === started.sessionId && m.title === title.slice(0, 80));
        if (already) return { sessionId: already.id };
        const meta = polyphemus.store.create({ title: title.slice(0, 80), provider: parentMeta.provider, model: parentMeta.model, cwd: home, agent: parentMeta.agent || undefined, startedBy: started.startedBy, spunFrom: started.sessionId });
        // What it's for, as polyphemus's words at the top of the thread: a run on it starts from there.
        polyphemus.store.append(meta.id, { role: 'user', content: [{ type: 'text', text: `<polyphemus_note title="What it’s for">\n${body}\n</polyphemus_note>` }] }, started.startedBy);
        store.setOutcome(meta.id, title.slice(0, 120), started.startedBy);
        changed(meta.id);
        return { sessionId: meta.id };
      },
    };
    const current = () => store.run(runId)!;
    /** Someone else owns the run now, it ended, or polyphemus is shutting down: stop without touching anything. */
    const stale = () => deps.closing() || current().generation !== generation || isEnded(current().status);
    const failRun = (reason: string) => {
      store.setRunStatus(runId, 'failed', reason);
      changed(started.sessionId);
      deps.notify(started.sessionId, `${workflow.name} failed: ${reason}${queuePaused(workflow, started.input)}`);
    };
    const context = (round?: number): NodeContext => {
      const saved = store.runArtifacts(runId);
      const checks: Record<string, CheckResult[]> = {};
      const artifacts: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(saved)) {
        if (key.startsWith('check:')) checks[key.slice(6)] = value as CheckResult[];
        else artifacts[key.replace(/^.*\//, '')] = value;
      }
      const ctx: NodeContext = { runId, input: started.input ?? {}, artifacts, checks, ...(round !== undefined && { round }), cwd: home, home, ...(project && { project }), services };
      return { ...ctx, cwd: workflow.cwd?.(ctx) ?? home };
    };
    const stepsFor = (key: string) => store.steps(runId).filter((s) => s.node === key);
    const latest = (key: string) => stepsFor(key).at(-1);
    const done = (key: string) => stepsFor(key).some((s) => s.status === 'done');
    const titled = (node: WorkflowNode, round?: number) => (round === undefined ? node.title : `Round ${round} · ${node.title}`);
    /** A picture a check took, kept in the run's thread on its step — shown there, not in the conversation. Resolves to polyphemus's copy. */
    const keepPicture = (image: { title: string; png: Buffer }, step: Step): string => {
      const dir = mkdtempSync(join(tmpdir(), 'polyphemus-look-'));
      try {
        const source = join(dir, `${image.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'page'}.png`);
        writeFileSync(source, image.png);
        const artifact = keepArtifact(polyphemus.home, source, { sessionId: started.sessionId, seq: parent.runtime.history.length, title: image.title, by: 'workflow', stepId: step.id });
        polyphemus.store.recordArtifact(artifact);
        return artifactFile(polyphemus.home, artifact);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    /** Over a budget: the run stops and says which, rather than carrying on and spending. */
    const overBudget = (): string | undefined => {
      const wallMs = workflow.budget?.wallMs;
      if (wallMs && Date.now() - started.startedAt > wallMs) return `it went over its time budget of ${Math.round(wallMs / 60_000)} minutes`;
      const tokens = workflow.budget?.tokens;
      if (tokens) {
        const used = store
          .steps(runId)
          .flatMap((s) => (s.sessionId ? polyphemus.store.turns(s.sessionId) : []))
          .reduce((sum, t) => sum + t.usage.inputTokens + t.usage.outputTokens, 0);
        if (used > tokens) return `it used ${used} tokens, over its budget of ${tokens}`;
      }
      return undefined;
    };

    type Result = 'done' | 'check-failed' | 'stopped' | 'failed';

    async function execNodes(nodes: WorkflowNode[], prefix: string, round?: number): Promise<Result> {
      for (const node of nodes) {
        if (stale()) return 'stopped';
        const key = `${prefix}${node.id}`;
        if (node.kind !== 'loop' && done(key)) continue;
        const over = overBudget();
        if (over) {
          failRun(`Stopped: ${over}.`);
          return 'failed';
        }
        const result = await execNode(node, key, round);
        if (result !== 'done') return result;
      }
      return 'done';
    }

    async function execNode(node: WorkflowNode, key: string, round?: number): Promise<Result> {
      const ctx = context(round);
      switch (node.kind) {
        case 'agent': {
          const attempts = workflow!.attempts ?? 3;
          let reason = '';
          for (let attempt = stepsFor(key).length + 1; attempt <= attempts; attempt++) {
            const step = store.addStep(runId, { title: titled(node, round), kind: 'work', node: key, attempt });
            store.setRunStatus(runId, 'running', step.title);
            // A judge from another vendor than the author's, when there is one ready.
            let model: ResolvedModel | undefined;
            let note: string | undefined;
            if (node.independentOf) {
              const author = store.steps(runId).filter((s) => (s.node === node.independentOf || s.node?.endsWith(`/${node.independentOf}`)) && s.status === 'done').at(-1);
              const authorProvider = author?.sessionId ? polyphemus.store.get(author.sessionId)?.provider : undefined;
              model = authorProvider ? deps.otherVendorModel(authorProvider) : undefined;
              note = authorProvider && !model ? 'No model from another vendor was ready, so the same vendor as the author did it.' : undefined;
            }
            const live = deps.openNodeSession(current(), node.agent, `${workflow!.name} · ${step.title}${attempt > 1 ? ` (attempt ${attempt})` : ''}`, { cwd: ctx.cwd, ...(model && { model }) });
            store.setStepSession(step.id, live.id);
            live.runtime.readOnly = node.readOnly === true;
            changed(started!.sessionId);
            let submitted: { data: unknown } | undefined;
            // Wrapped so the thread shows it as polyphemus's instructions for this step, not as a person's message.
            const prompt = `<polyphemus_node title="${step.title.replace(/"/g, "'")}">\n${node.prompt(ctx)}\n</polyphemus_node>`;
            const end = await turn(live, { runId, step, submit: { shape: node.output, accept: (data) => (submitted = { data }) } }, prompt);
            if (stale()) return 'stopped';
            if (end.kind === 'aborted') {
              store.setStepStatus(step.id, 'interrupted', 'Stopped before it finished.');
              return 'stopped';
            }
            reason = end.kind === 'error' ? end.message : submitted ? '' : 'It ended without submitting what this step produces.';
            const wrong = submitted && misfit(submitted.data, node.output);
            if (submitted && !wrong && end.kind === 'completed') {
              store.saveArtifact(runId, key, step.id, submitted.data);
              store.setStepStatus(step.id, 'done', [attempt > 1 ? `Done on attempt ${attempt}.` : '', note ?? (model ? `Done on ${live.runtime.model.label}.` : '')].filter(Boolean).join(' ') || undefined);
              changed(started!.sessionId);
              return 'done';
            }
            store.setStepStatus(step.id, 'failed', wrong ? `What it submitted doesn’t fit: ${wrong}.` : reason);
            changed(started!.sessionId);
          }
          failRun(`${titled(node, round)} didn’t finish after ${attempts} attempts: ${reason}`);
          return 'failed';
        }

        case 'check': {
          const step = store.addStep(runId, { title: titled(node, round), kind: 'check', node: key, attempt: stepsFor(key).length + 1 });
          store.setRunStatus(runId, 'running', step.title);
          changed(started!.sessionId);
          const cwd = ctx.cwd;
          // Where agents are isolated, a check runs in the run's worker, never on this computer.
          let worker: Awaited<ReturnType<typeof polyphemus.runWorker>>;
          try {
            worker = await polyphemus.runWorker(cwd);
          } catch (err) {
            store.setStepStatus(step.id, 'failed', (err as Error).message);
            failRun((err as Error).message);
            return 'failed';
          }
          const head = await headCommit(cwd, worker);
          const results: CheckResult[] = [];
          let note: string | undefined;
          const record = (result: CheckResult) => {
            results.push(result);
            const lastLine = result.output.split('\n').filter(Boolean).at(-1);
            // A probe says what it saw; a command's exit code is what it saw.
            const said = node.probe ? result.output.split('\n')[0]!.slice(0, 200) : `exit ${result.exitCode ?? 'none'}`;
            store.addEvidence({ runId, stepId: step.id, kind: 'check', label: result.command, detail: [said, head ? `at ${head.slice(0, 7)}` : null, !node.probe && !result.ok && lastLine ? lastLine.slice(0, 200) : null].filter(Boolean).join(' · '), ok: result.ok });
          };
          if (node.probe) {
            try {
              const probed = await node.probe(ctx);
              if (stale()) return 'stopped';
              note = probed.note;
              for (const { image, ...result } of probed.results) record({ ...result, ...(head && { head }), ...(image && { files: [keepPicture(image, step)] }) });
            } catch (err) {
              record({ command: node.title, exitCode: null, ok: false, output: (err as Error).message, ...(head && { head }) });
            }
          } else {
            for (const command of node.commands!(ctx)) {
              if (stale()) return 'stopped';
              record({ ...(await runCheck(command, cwd, { timeoutMs: node.timeoutMs, ...(worker && { worker }) })), ...(head && { head }) });
            }
          }
          store.saveArtifact(runId, `check:${node.id}`, step.id, results);
          const passed = results.every((r) => r.ok);
          if (passed) store.setStepStatus(step.id, 'done', note ?? (head ? `Passed at ${head.slice(0, 7)}.` : 'Passed.'));
          else {
            // The same failure on the same files is no progress; the same failure after changing things might be.
            store.setStepSignature(step.id, `${failureSignature(results)}:${await workingTreeFingerprint(cwd, worker)}`);
            const failed = results.find((r) => !r.ok)!;
            store.setStepStatus(step.id, 'failed', node.says?.(results) ?? `${failed.command} exited ${failed.exitCode ?? 'without a code'}${head ? ` at ${head.slice(0, 7)}` : ''}.`);
          }
          changed(started!.sessionId);
          if (passed) return 'done';
          if (round === undefined) failRun(`${node.title} failed: ${results.find((r) => !r.ok)!.command}`);
          return round === undefined ? 'failed' : 'check-failed';
        }

        case 'gate': {
          const existing = latest(key);
          if (existing?.status === 'waiting') return 'stopped';
          if (node.when && !node.when(ctx)) {
            store.addStep(runId, { title: titled(node, round), kind: 'gate', node: key, attempt: 1, status: 'done' });
            return 'done';
          }
          const asks = node.asks(ctx);
          const options = node.options?.(ctx);
          if (options && options.length === 0) {
            store.addStep(runId, { title: titled(node, round), kind: 'gate', node: key, attempt: 1, status: 'done' });
            store.saveArtifact(runId, key, store.steps(runId).at(-1)!.id, []);
            return 'done';
          }
          const step = store.addStep(runId, { title: titled(node, round), kind: 'gate', node: key, attempt: 1, asks, status: 'waiting' });
          askGate(current(), step, asks, step.title, options);
          changed(started!.sessionId);
          return 'stopped';
        }

        case 'action': {
          const permitKey = `${runId}:${node.key(ctx)}`;
          const step = store.addStep(runId, { title: titled(node, round), kind: 'action', node: key, attempt: stepsFor(key).length + 1 });
          const already = store.action(permitKey);
          if (already) {
            // What it did the first time, in its own words when it has them.
            const earlier = already.result === undefined ? undefined : node.says?.(already.result);
            store.setStepStatus(step.id, 'done', earlier ? `Already done: ${earlier.charAt(0).toLowerCase()}${earlier.slice(1)}` : 'Already done earlier in this run.');
            return 'done';
          }
          const permit: Permit = { runId, node: key, generation, key: permitKey };
          // Only the current generation acts: a worker from before a restart or a takeover can't.
          if (stale()) {
            store.setStepStatus(step.id, 'interrupted', 'Its permit was out of date.');
            return 'stopped';
          }
          try {
            const result = await node.run(ctx, permit);
            if (current().generation !== permit.generation) {
              store.setStepStatus(step.id, 'unknown', 'The run changed hands while this was acting; check what it did before running it again.');
              return 'stopped';
            }
            store.recordAction(permitKey, runId, key, generation, result);
            store.saveArtifact(runId, key, step.id, result ?? null);
            store.setStepStatus(step.id, 'done', node.says?.(result));
            return 'done';
          } catch (err) {
            store.setStepStatus(step.id, 'failed', (err as Error).message);
            failRun(`${node.title} failed: ${(err as Error).message}`);
            return 'failed';
          }
        }

        case 'loop': {
          const max = typeof node.max === 'function' ? node.max(ctx) : node.max;
          // Whichever check stopped a round, not only the one that ends the loop.
          const failedCheck = (r: number) =>
            node.body
              .filter((child) => child.kind === 'check')
              .map((child) => latest(`${node.id}#${r}/${child.id}`))
              .find((s) => s?.status === 'failed');
          for (let round = 1; round <= max; round++) {
            const prefix = `${node.id}#${round}/`;
            const untilKey = `${prefix}${node.until}`;
            // A round is over once a check in it failed or the loop's own check passed: after a gate or a restart it isn't redone.
            if (latest(untilKey)?.status !== 'done' && !failedCheck(round)) {
              const result = await execNodes(node.body, prefix, round);
              if (result === 'stopped' || result === 'failed') return result;
            }
            if (latest(untilKey)?.status === 'done') return 'done';
            if (round === max) {
              failRun(`Still not passing after ${max} round${max === 1 ? '' : 's'}: ${failedCheck(round)?.reason ?? 'its check failed'}`);
              return 'failed';
            }
            // The same failure as last round: no progress. Ask, rather than spend another round on it.
            const previous = round > 1 ? failedCheck(round - 1) : undefined;
            const now = failedCheck(round);
            if (previous?.signature && now?.signature && previous.signature === now.signature) {
              const stuckKey = `${prefix}stuck`;
              if (!done(stuckKey)) {
                if (latest(stuckKey)?.status === 'waiting') return 'stopped';
                const asks = `It failed the same way two rounds running, and changed nothing in between: ${(now.reason ?? 'the check').replace(/\.$/, '')}. Another round, or stop here?`;
                const step = store.addStep(runId, { title: `Round ${round} · Stuck`, kind: 'gate', node: stuckKey, attempt: 1, asks, status: 'waiting' });
                askGate(current(), step, asks, step.title);
                changed(started!.sessionId);
                deps.notify(started!.sessionId, `${workflow!.name} is stuck: the same failure twice. Another round?`);
                return 'stopped';
              }
            }
          }
          return 'failed';
        }
      }
    }

    const result = await execNodes(workflow.nodes, '');
    if (result === 'done' && !stale()) {
      store.setRunStatus(runId, 'done', `${workflow.name}: every node done.`);
      changed(started.sessionId);
      deps.notify(started.sessionId, `Done: ${store.outcomeById(started.outcomeId)?.text ?? workflow.name}`);
      deps.log?.(`Workflow ${workflow.id} run ${runId}: done`);
      // The next in its queue, now that this one is done.
      const next = workflow.next?.(started.input ?? {});
      if (next) {
        try {
          const thread = deps.startNext(current(), next);
          deps.log?.(`Workflow ${workflow.id} run ${runId}: started the next, ${next.workflow} in ${thread}`);
        } catch (err) {
          deps.notify(started.sessionId, `The next in the queue didn’t start: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Works a run from wherever it is until it ends or reaches a gate. */
  async function drive(runId: string): Promise<void> {
    if (store.run(runId)?.workflow) return driveWorkflow(runId);
    let run = store.run(runId);
    if (!run || isEnded(run.status)) return;
    const entry = deps.liveSession(run.sessionId);
    const outcome = store.outcomeById(run.outcomeId);
    if (!entry || !outcome) return;

    if (store.steps(run.id).length === 0) {
      const adapter = polyphemus.config.providers[entry.runtime.model.provider]?.adapter;
      if (adapter === 'grok-cli') {
        store.setRunStatus(run.id, 'failed', 'Grok Build can’t take polyphemus’s run tools yet. Switch this thread to Claude Code, Codex or an API model, then start a run.');
        changed(run.sessionId);
        return;
      }
      const end = await turn(entry, { runId: run.id, planning: true }, runPrompt({ runId: run.id, planning: true }, outcome.text, run.n, history(run.sessionId, run.n)));
      // Stopped by a person while it planned: that's already recorded, in their name.
      if (isEnded(store.run(run.id)!.status)) return;
      if (store.steps(run.id).length === 0) {
        const who = entry.runtime.agent?.title ?? 'The agent';
        const reason =
          end.kind === 'aborted' ? 'Stopped while it was planning.'
          : end.kind === 'error' ? `Planning failed: ${end.message}`
          : `${who} didn’t record a plan, so nothing ran.`;
        store.setRunStatus(run.id, end.kind === 'aborted' ? 'interrupted' : 'failed', reason);
        changed(run.sessionId);
        return;
      }
      changed(run.sessionId);
    }

    for (;;) {
      run = store.run(runId)!;
      if (isEnded(run.status)) return;
      const steps = store.steps(run.id);
      const next = steps.find((s) => s.status === 'queued');
      if (!next) return finish(run);
      const at = entry.runtime.history.length;

      if (next.kind === 'gate') {
        store.startStep(next.id, at, 'waiting');
        store.setRunStatus(run.id, 'waiting', `Step ${next.n}: ${next.title}`);
        const question = polyphemus.store.askQuestion({
          id: randomUUID().slice(0, 8),
          sessionId: run.sessionId,
          kind: 'gate',
          detail: { runId: run.id, stepId: next.id, step: next.n, of: steps.length, run: run.n, title: next.title, asks: next.asks ?? next.title, outcome: outcome.text },
        });
        deps.announceQuestion(question);
        changed(run.sessionId);
        return;
      }

      if (next.kind === 'verify') {
        const target = steps.find((s) => s.n === next.verifies);
        const failed = precheckVerify(next, target);
        if (failed) {
          store.startStep(next.id, at);
          store.setStepStatus(next.id, failed.status, failed.reason, { seqEnd: at });
          changed(run.sessionId);
          continue;
        }
      }

      store.startStep(next.id, at);
      store.setRunStatus(run.id, 'running', `Step ${next.n}: ${next.title}`);
      changed(run.sessionId);
      const end = await turn(entry, { runId: run.id, step: next, of: steps.length }, runPrompt({ runId: run.id, step: next, of: steps.length }, outcome.text, run.n, ''), () => {
        // A fallback to another model mid-step: it's being retried, and says on what.
        store.setStepStatus(next.id, 'retrying', `Switched to ${entry.runtime.model.label} and carried on.`);
        changed(run!.sessionId);
      });
      // A person may have stopped the run while this turn was going.
      if (isEnded(store.run(run.id)!.status)) return;
      const derived = deriveStep(store.step(next.id)!, end, store.evidence(next.id));
      store.setStepStatus(next.id, derived.status, derived.reason, { seqEnd: entry.runtime.history.length });
      changed(run.sessionId);
      if (derived.status !== 'done') {
        // Whatever was going to verify it fails now, saying why — then the run stops.
        for (const verify of store.steps(run.id).filter((s) => s.kind === 'verify' && s.verifies === next.n && s.status === 'queued')) {
          const failed = precheckVerify(verify, store.step(next.id))!;
          store.startStep(verify.id, entry.runtime.history.length);
          store.setStepStatus(verify.id, failed.status, failed.reason, { seqEnd: entry.runtime.history.length });
        }
        return finish(store.run(run.id)!);
      }
    }
  }

  return {
    activeRun,

    /** Starts the next run for a thread's outcome. */
    start(sessionId: string, by: string): Run {
      const outcome = store.outcome(sessionId);
      if (!outcome) throw new RunError(400, 'This thread isn’t tracking an outcome: track it as work first.');
      if (activeRun(sessionId)) throw new RunError(409, 'A run is already going here.');
      const entry = deps.liveSession(sessionId);
      if (!entry) throw new RunError(404, 'No such session.');
      if (entry.running) throw new RunError(409, 'It’s still answering: wait, or stop it first.');
      const run = store.startRun(sessionId, outcome.id, by);
      deps.log?.(`Run ${run.n} started in ${sessionId} by ${by}`);
      changed(sessionId);
      void drive(run.id).catch((err: unknown) => {
        if (!deps.closing()) store.setRunStatus(run.id, 'failed', `polyphemus couldn’t carry on: ${(err as Error).message}`);
        changed(sessionId);
      });
      return run;
    },

    /** Stops the run a thread has going: its current step is interrupted, and so is the run. */
    stop(sessionId: string, by: string): boolean {
      const run = activeRun(sessionId);
      if (!run) return false;
      const reason = `Stopped by ${deps.personName(by)}.`;
      for (const step of store.steps(run.id).filter((s) => ['running', 'retrying', 'waiting'].includes(s.status))) {
        store.setStepStatus(step.id, 'interrupted', reason);
      }
      for (const q of polyphemus.store.openQuestions().filter((q) => q.kind === 'gate' && q.detail.runId === run.id)) {
        polyphemus.store.expireQuestion(q.id, reason);
        deps.broadcast({ type: 'question_resolved', id: q.id, sessionId, by: null, answer: null });
      }
      store.setRunStatus(run.id, 'interrupted', reason);
      deps.liveSession(sessionId)?.running?.abort();
      changed(sessionId);
      return true;
    },

    /** A person answers a gate: allowed carries the run on; sent back ends it, with their note as the reason. */
    answerGate(question: StoredQuestion, answer: string, by: string, note?: string, picked?: string[]): boolean {
      const allowed = answer === 'approve';
      const options = question.detail.options as GateOption[] | undefined;
      const kept = options && allowed ? options.filter((o) => picked?.includes(o.id)) : undefined;
      if (kept && kept.length === 0) throw new RunError(400, 'Pick at least one, or send it back.');
      if (!polyphemus.store.answerQuestion(question.id, answer, by)) return false;
      const stepId = String(question.detail.stepId);
      const runId = String(question.detail.runId);
      const name = deps.personName(by);
      const allowedWhy = kept ? `${name} kept ${kept.length} of ${options!.length}.` : `Allowed by ${name}.`;
      store.setStepStatus(stepId, allowed ? 'done' : 'failed', allowed ? allowedWhy : `Sent back by ${name}${note ? `: ${note}` : '.'}`, { answeredBy: by });
      if (kept) store.saveArtifact(String(question.detail.runId), store.step(stepId)!.node ?? '', stepId, kept.map((o) => o.id));
      deps.broadcast({ type: 'question_resolved', id: question.id, sessionId: question.sessionId, by, answer });
      const run = store.run(runId);
      if (!run) return true;
      if (allowed) {
        store.setRunStatus(runId, 'running');
        changed(question.sessionId);
        void drive(runId).catch((err: unknown) => {
          if (!deps.closing()) store.setRunStatus(runId, 'failed', `polyphemus couldn’t carry on: ${(err as Error).message}`);
          changed(question.sessionId);
        });
      } else if (run.workflow) {
        store.setRunStatus(runId, 'failed', `Sent back by ${name}${note ? `: ${note}` : '.'}`);
        changed(question.sessionId);
        const queued = queuePaused(findWorkflow(run.workflow), run.input);
        if (queued) deps.notify(question.sessionId, `Sent back.${queued}`);
      } else finish(run);
      return true;
    },

    /** Starts a workflow in a thread, as its outcome's next run. */
    startWorkflow(sessionId: string, workflow: Workflow, input: Record<string, unknown>, by: string): Run {
      const wrong = misfit(input, workflow.input);
      if (wrong) throw new RunError(400, `To start ${workflow.name}: ${wrong}.`);
      if (activeRun(sessionId)) throw new RunError(409, 'A run is already going here.');
      const entry = deps.liveSession(sessionId);
      if (!entry) throw new RunError(404, 'No such session.');
      if (workflow.oneAtATime) {
        const key = workflow.oneAtATime(input);
        const projectOf = (id: string) => polyphemus.store.projectFor(polyphemus.store.get(id)?.cwd ?? '')?.slug;
        const here = projectOf(sessionId);
        const busy = store.activeWorkflowRuns(workflow.id).find((r) => r.sessionId !== sessionId && projectOf(r.sessionId) === here && workflow.oneAtATime!(r.input ?? {}) === key);
        if (busy) throw new RunError(409, `${workflow.name} is already going for that in “${polyphemus.store.get(busy.sessionId)?.title ?? 'another thread'}”. Let it finish, or stop it first.`);
      }
      const outcome = store.outcome(sessionId) ?? store.setOutcome(sessionId, workflow.outcome(input).slice(0, 120), by);
      const run = store.startRun(sessionId, outcome.id, by, Date.now(), { id: workflow.id, input });
      deps.log?.(`Workflow ${workflow.id} run ${run.n} started in ${sessionId} by ${by}`);
      changed(sessionId);
      void drive(run.id).catch((err: unknown) => {
        if (!deps.closing()) store.setRunStatus(run.id, 'failed', `polyphemus couldn’t carry on: ${(err as Error).message}`);
        changed(sessionId);
      });
      return run;
    },

    /**
     * After a restart, a workflow run carries on from its last finished node — as a new generation, so
     * anything still holding the old one can't act. A run a person stopped stays stopped.
     */
    resumeAfterRestart(): number {
      let resumed = 0;
      for (const run of polyphemus.store.runs.interruptedWorkflows(RESTARTED)) {
        store.bumpGeneration(run.id);
        store.setRunStatus(run.id, 'running', 'Carrying on after a restart.');
        resumed += 1;
        void drive(run.id).catch((err: unknown) => {
          if (!deps.closing()) store.setRunStatus(run.id, 'failed', `polyphemus couldn’t carry on: ${(err as Error).message}`);
          changed(run.sessionId);
        });
      }
      return resumed;
    },

    /** What a list row shows about a work item. */
    summary(sessionId: string) {
      const outcome = store.outcome(sessionId);
      if (!outcome) return null;
      const run = store.latestRun(sessionId);
      if (!run) return { outcome: outcome.text, status: null, reason: null, run: null, step: null, steps: 0, gate: false, evidence: 0, receipts: 0 };
      const steps = store.steps(run.id);
      // A workflow retries and loops, so an earlier failed step isn't where it is: its latest step is.
      const current = run.workflow ? steps.at(-1) : (steps.find((s) => ['running', 'retrying', 'waiting', 'failed', 'interrupted', 'unknown'].includes(s.status)) ?? steps.filter((s) => s.status === 'done').at(-1));
      const evidence = store.runEvidence(run.id).filter((e) => e.ok);
      return {
        outcome: outcome.text,
        status: run.status,
        reason: run.reason ?? null,
        run: run.n,
        step: current?.n ?? null,
        steps: steps.length,
        gate: current?.kind === 'gate' && current.status === 'waiting',
        evidence: evidence.length,
        receipts: evidence.filter((e) => e.receipt).length,
      };
    },

    /** Everything about a thread's work, newest run first. */
    detail(sessionId: string) {
      const outcome = store.outcome(sessionId);
      const pictures = polyphemus.store.artifacts(sessionId).filter((a) => a.by === 'workflow' && a.stepId);
      const runs = store.runs(sessionId).reverse().map((run) => ({
        ...run,
        outcome: store.outcomeById(run.outcomeId)?.text ?? null,
        startedByName: deps.personName(run.startedBy),
        // A queue waiting behind a run that ended without finishing: offered, never started on its own.
        upNext: run.workflow && run.status !== 'done' && !ACTIVE.includes(run.status) ? (findWorkflow(run.workflow)?.next?.(run.input ?? {}) ?? null) : null,
        steps: store.steps(run.id).map((step: Step) => ({
          ...step,
          answeredByName: step.answeredBy ? deps.personName(step.answeredBy) : null,
          evidence: store.evidence(step.id),
          pictures: pictures.filter((a) => a.stepId === step.id).map(({ id, title }) => ({ id, title })),
          // GitHub issues a step filed, so the app can offer to ship each one.
          ...(step.kind === 'action' && step.status === 'done' ? filedIssues(store.stepArtifact(step.id)) : {}),
        })),
      }));
      return {
        outcome: outcome ? { ...outcome, setByName: deps.personName(outcome.acceptedBy ?? outcome.setBy), proposedBy: outcome.acceptedBy ? outcome.setBy : null } : null,
        active: activeRun(sessionId)?.id ?? null,
        runs,
      };
    },
  };
}

function filedIssues(artifact: unknown): { filedIssues?: { repo: string; numbers: number[] } } {
  const a = artifact as { kind?: string; repo?: string; filed?: unknown } | undefined;
  return a?.kind === 'github' && typeof a.repo === 'string' && Array.isArray(a.filed) && a.filed.length ? { filedIssues: { repo: a.repo, numbers: a.filed.map(Number).filter(Number.isInteger) } } : {};
}

/** What a notification adds when a queue stops behind a run: what's waiting, and that it won't start by itself. */
function queuePaused(workflow: Workflow | undefined, input: Record<string, unknown> | undefined): string {
  const next = workflow?.next?.(input ?? {});
  if (!next) return '';
  const issues = [next.input.issue, ...(String(next.input.then ?? '').match(/\d+/g) ?? [])].filter(Boolean).map((n) => `#${n}`);
  return ` The queue stops here: ${issues.join(', ')} ${issues.length === 1 ? 'is' : 'are'} waiting, to ship from this run when you’re ready.`;
}

export class RunError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
