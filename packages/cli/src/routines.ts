import {
  agentModel,
  defaultAgent,
  describeTrigger,
  findAgent,
  PolyphemusError,
  resolveModel,
  loadRoutines,
  nextRoutineFire,
  upcomingFires,
  type Polyphemus,
  type Routine,
} from '@polyphemus/core';
import { DaemonClient } from './daemon-client.js';
import { iso, printJson } from './output.js';
import { bold, cyan, dim, green, red, yellow } from './render.js';

// `poly routine …`: see and control routines (docs/design/scheduling.md). The daemon runs them;
// these commands read the same files and database, and `run` asks the daemon.

const when = (ms: number | undefined) =>
  ms === undefined ? 'never again' : new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function find(polyphemus: Polyphemus, ref: string | undefined): Routine {
  if (!ref) throw new PolyphemusError('Which routine? See: poly routine', 'USAGE', 'poly routine');
  const { routines } = loadRoutines(polyphemus.home, polyphemus.store);
  const exact = routines.find((r) => r.id === ref);
  if (exact) return exact;
  const named = routines.filter((r) => r.name === ref);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new PolyphemusError(`Several routines are named "${ref}": ${named.map((r) => r.id).join(', ')}. Use the full id.`, 'USAGE');
  throw new PolyphemusError(`No routine called "${ref}".`, 'NOT_FOUND', 'poly routine');
}

/** Whether what this routine runs on asks before it acts: the route the daemon takes (its model, else its agent's). */
function asksFirst(polyphemus: Polyphemus, r: Routine): boolean {
  try {
    const ref = r.model ?? polyphemus.config.defaultModel;
    if (!ref) return true;
    const base = resolveModel(polyphemus.config, ref);
    const project = r.project ? polyphemus.store.project(r.project) : undefined;
    const agent = r.agent ? findAgent(polyphemus.home, project?.path, r.agent, r.project) : defaultAgent(polyphemus, project?.path, project?.slug);
    const model = agent && !r.model ? agentModel(polyphemus.config, agent, base) : base;
    return polyphemus.config.providers[model.provider]?.adapter !== 'codex-cli';
  } catch {
    return true;
  }
}

function summary(polyphemus: Polyphemus, r: Routine) {
  const state = polyphemus.store.routineState(r.id);
  const [last] = polyphemus.store.fires(r.id, 1);
  return {
    id: r.id,
    name: r.name,
    project: r.project ?? null,
    file: r.file,
    schedule: r.triggers.map(describeTrigger),
    next: state.paused || !r.enabled ? null : iso(nextRoutineFire(r, Date.now())),
    enabled: r.enabled,
    paused: state.paused,
    pausedReason: state.pausedReason ?? null,
    // A project's routine, new or changed since a person accepted it: it doesn't run until then.
    waiting: r.project !== undefined && r.digest !== undefined && state.acceptedDigest !== r.digest,
    failuresInARow: state.failures,
    last: last ? { ...last, createdAt: iso(last.createdAt), finishedAt: iso(last.finishedAt) } : null,
  };
}

const lastLine = (last: ReturnType<typeof summary>['last']) => {
  if (!last) return dim('never run');
  if (last.status !== 'started') return yellow(`${last.status}: ${last.reason ?? ''}`);
  if (!last.outcome) return cyan('running');
  return last.outcome === 'succeeded' ? green('✓ succeeded') : red(`✗ failed: ${last.reason ?? ''}`);
};

export async function routineCommand(polyphemus: Polyphemus, args: string[], flags: { count?: string; digest?: string }, port: number, json: boolean): Promise<void> {
  const [action, ref] = args;
  switch (action) {
    case undefined:
    case 'ls':
    case 'list': {
      const { routines, problems } = loadRoutines(polyphemus.home, polyphemus.store);
      if (json) return printJson({ routines: routines.map((r) => summary(polyphemus, r)), problems }, problems.map((p) => p.message));
      if (routines.length === 0) console.log(dim('No routines yet. Add a markdown file to a project’s .polyphemus/routines/ folder (see docs/design/scheduling.md).'));
      for (const r of routines) {
        const s = summary(polyphemus, r);
        const state = s.waiting ? yellow(`waiting for your OK: poly routine show ${r.name}`) : s.paused ? red(`paused: ${s.pausedReason ?? ''}`) : !r.enabled ? yellow('disabled') : `next ${when(nextRoutineFire(r, Date.now()))}`;
        console.log(`${cyan(r.id.padEnd(30))} ${s.schedule.join(' · ')}\n${' '.repeat(31)}${state} · ${lastLine(s.last)}`);
      }
      for (const p of problems) console.log(red(`✗ ${p.message}`));
      return;
    }
    case 'show': {
      const r = find(polyphemus, ref);
      const fires = polyphemus.store.fires(r.id, 20);
      if (json) return printJson({ ...summary(polyphemus, r), digest: r.digest ?? null, source: r.source ?? null, prompt: r.prompt, model: r.model ?? null, mode: r.mode, overlap: r.overlap, catchup: r.catchup, fires: fires.map((f) => ({ ...f, createdAt: iso(f.createdAt), finishedAt: iso(f.finishedAt) })) });
      const s = summary(polyphemus, r);
      console.log(`${bold(r.id)}  ${dim(r.file)}`);
      if (s.waiting) {
        // Waiting for a yes: the whole file, as it will run, and the digest that accepts exactly this.
        console.log(yellow(`Waiting for your OK. What it is, exactly:\n`));
        console.log(r.source ?? '');
        console.log(yellow(`To let it run as it is: poly routine accept ${r.name} --digest ${r.digest}\n`));
      }
      const approval = r.mode === 'yolo' ? red('YOLO') : r.mode === 'read-only' ? 'read-only' : asksFirst(polyphemus, r) ? 'asks before changes' : yellow('runs on Codex, which doesn’t ask before changes');
      console.log(`${s.schedule.join(' · ')} · ${r.model ?? 'default model'} · ${approval} · overlap ${r.overlap} · catch-up ${r.catchup}`);
      console.log(s.paused ? red(`Paused: ${s.pausedReason ?? ''}`) : `Next: ${when(nextRoutineFire(r, Date.now()))}`);
      console.log(`\n${dim(r.prompt)}\n`);
      if (fires.length === 0) return console.log(dim('No firings yet.'));
      for (const f of fires) {
        const outcome = f.status !== 'started' ? yellow(`${f.status}: ${f.reason ?? ''}`) : !f.outcome ? cyan('running') : f.outcome === 'succeeded' ? green('succeeded') : red(`failed: ${f.reason ?? ''}`);
        console.log(`  ${dim(when(f.createdAt))}  ${f.trigger.padEnd(24)} ${outcome}${f.sessionId ? dim(`  thread ${f.sessionId}`) : ''}`);
      }
      return;
    }
    case 'next': {
      const r = find(polyphemus, ref);
      const count = flags.count === undefined ? 5 : Number(flags.count);
      if (!Number.isInteger(count) || count < 1 || count > 100) throw new PolyphemusError('--count takes a whole number from 1 to 100.', 'USAGE');
      const times = upcomingFires(r, Date.now(), count);
      if (json) return printJson({ id: r.id, next: times.map((t) => iso(t)) });
      for (const t of times) console.log(when(t));
      if (times.length === 0) console.log(dim('It won’t run again.'));
      return;
    }
    case 'run': {
      const r = find(polyphemus, ref);
      const daemon = await DaemonClient.connect(polyphemus.home, port);
      if (!daemon) throw new PolyphemusError('Routines run in the daemon, and it isn’t running.', 'FAILED', 'poly service status');
      try {
        const { fire } = await daemon.request<{ fire: { status: string; reason?: string; sessionId?: string } | null }>('POST', `/api/routines/${encodeURIComponent(r.id)}/run`);
        if (json) return printJson({ fire });
        if (!fire) return console.log(dim('Nothing ran.'));
        if (fire.status === 'started') return console.log(`${green('✓')} Started ${r.name}: poly sessions show ${fire.sessionId}`);
        return console.log(yellow(`Didn’t run (${fire.status}): ${fire.reason ?? ''}`));
      } finally {
        daemon.close();
      }
    }
    case 'accept': {
      // Only the version that was read: `poly routine show` prints its digest, and that's what's accepted.
      const r = find(polyphemus, ref);
      if (r.digest && flags.digest !== r.digest) {
        throw new PolyphemusError(
          flags.digest ? `${r.name} changed since you read it. Read it again: poly routine show ${r.name}` : `Say which version you read: poly routine show ${r.name}, then poly routine accept ${r.name} --digest <digest>`,
          flags.digest ? 'CONFLICT' : 'USAGE',
        );
      }
      if (r.digest) polyphemus.store.updateRoutineState(r.id, { acceptedDigest: r.digest });
      if (json) return printJson({ id: r.id, accepted: true });
      return console.log(`Accepted ${r.id} as it is now${r.mode === 'yolo' ? ', running without asking' : ''}. Next: ${when(nextRoutineFire(r, Date.now()))}`);
    }
    case 'pause':
    case 'resume': {
      const r = find(polyphemus, ref);
      const paused = action === 'pause';
      polyphemus.store.updateRoutineState(r.id, paused ? { paused: true, pausedReason: 'paused by you' } : { paused: false, pausedReason: undefined, failures: 0 });
      if (json) return printJson({ id: r.id, paused });
      return console.log(paused ? `Paused ${r.id}. Resume: poly routine resume ${r.name}` : `Resumed ${r.id}. Next: ${when(nextRoutineFire(r, Date.now()))}`);
    }
    case 'check': {
      const { routines, problems } = loadRoutines(polyphemus.home, polyphemus.store);
      if (json) {
        printJson({ ok: problems.length === 0, routines: routines.length, problems });
      } else {
        for (const p of problems) console.log(red(`✗ ${p.message}`));
        console.log(problems.length ? `${problems.length} routine file${problems.length === 1 ? '' : 's'} need fixing.` : `${green('✓')} ${routines.length} routine${routines.length === 1 ? '' : 's'}, no problems.`);
      }
      if (problems.length) process.exitCode = 2;
      return;
    }
    default:
      throw new PolyphemusError(`Unknown routine command "${action}". Try: show, next, run, pause, resume, check.`, 'USAGE', 'poly help routine');
  }
}
