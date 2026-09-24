import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, emptyUsage, findChrome, Polyphemus, mergeApproved, type Block, type ChatRequest, type Message, type ModelProvider, type ProviderEvent, type StopReason } from '@polyphemus/core';
import { startDaemon, type Daemon } from '../src/server.js';
import { containerRuntime, itInContainers } from '../../core/test/containers.js';
import { fakeGitHub, makeIdentity } from './fake-github.js';

// Shipping to GitHub (roadmap: it does the work, 3): a run works in its own worktree, pushes and opens
// the pull request as polyphemus's Builder identity, is reviewed by a model from another vendor and that
// review is posted by the Reviewer identity at the head commit; it merges only after you say so, and
// only what someone other than its author approved at exactly that commit.

type Reply = { content: Block[]; stopReason: StopReason };
const say = (text: string): Reply => ({ content: [{ type: 'text', text }], stopReason: 'end_turn' });
const call = (name: string, input: Record<string, unknown>): Reply => ({ content: [{ type: 'tool_call', id: `c${Math.random().toString(36).slice(2)}`, name, input }], stopReason: 'tool_use' });

class Sessions implements ModelProvider {
  readonly kind = 'model' as const;
  prompts: string[] = [];
  constructor(
    readonly id: string,
    public plan: (prompt: string, fresh: boolean) => Reply[],
  ) {}
  async *stream(req: ChatRequest): AsyncIterable<ProviderEvent> {
    const first = req.messages.find((m: Message) => m.role === 'user')!;
    const prompt = first.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const answered = req.messages.filter((m: Message) => m.role === 'assistant').length;
    if (answered === 0) this.prompts.push(prompt);
    const reply = this.plan(prompt, answered === 0)[answered] ?? say('ok');
    yield { type: 'message_done', message: { role: 'assistant', content: reply.content, origin: { provider: this.id, model: req.model } }, stopReason: reply.stopReason, usage: emptyUsage() };
  }
  async listModels() {
    return [];
  }
}

let home: string;
let polyphemus: Polyphemus;
/** The shipping test runs twice: on this computer, and with the project isolated. */
let isolatedShip = false;
/** The container runtime, found directly: the suite turns polyphemus's own detection off. */
const runtime = containerRuntime;
let daemon: Daemon;
let base: string;
let gh: ReturnType<typeof fakeGitHub>;
const savedEnv = { ...process.env };

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'polyphemus-ship-'));
  gh = fakeGitHub(home);
  const web = await gh.start();
  Object.assign(process.env, { POLYPHEMUS_GITHUB_API: web, POLYPHEMUS_GITHUB_WEB: web, CODEX_HOME: join(home, 'no-codex'), OPENAI_API_KEY: 'test-key', ANTHROPIC_API_KEY: 'test-key', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  // Models picked the way the app picks them (a selected list, not named aliases): the judge comes from it.
  writeFileSync(join(home, 'config.toml'), `projects_root = ${JSON.stringify(join(home, 'projects'))}\ndefault_model = "gpt-api"\n${DEFAULT_CONFIG.replace('accepted = []', '').replace('selected = []', 'selected = ["openai:gpt-test", "anthropic:claude-test-judge"]')}\n[isolation]\nlevel = "host"\n`);
});
afterEach(async () => {
  await daemon?.close().catch(() => {});
  if (isolatedShip) await polyphemus?.workers.close();
  isolatedShip = false;
  polyphemus?.close();
  await gh.stop();
  process.env = { ...savedEnv };
});

async function start(builder: Sessions, reviewer: Sessions) {
  polyphemus = await Polyphemus.open(home);
  polyphemus.registry.use('openai', builder);
  // Whichever Anthropic connection is ready judges it: never the builder's vendor.
  polyphemus.registry.use('anthropic', reviewer);
  polyphemus.registry.use('claude-code', reviewer);
  daemon = await startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home });
  base = daemon.urls[0]!;
  const cookie = (await fetch(`${base}/pair?code=${polyphemus.store.createPairingCode()}`, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
  const me = async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await res.text();
    return { status: res.status, raw, data: JSON.parse(raw || '{}') as Record<string, any> };
  };
  return { me, cookie };
}

async function until<T>(check: () => Promise<T | undefined | false>, what: string, tries = 600): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A project that's a clone of the repository, with origin pointing at GitHub as usual. */
async function ledger(me: Awaited<ReturnType<typeof start>>['me']) {
  const project = (await me('/api/projects', { name: 'Ledger', from: gh.bare })).data.project;
  gh.git('-C', project.path, 'remote', 'set-url', 'origin', 'https://github.com/acme/site.git');
  if (isolatedShip) {
    polyphemus.runtime = () => runtime;
    polyphemus.store.setProjectIsolation(project.slug, 'isolated');
  }
  return project;
}

async function grantRoles(me: Awaited<ReturnType<typeof start>>['me'], cookie: string, project: string, roles: Array<[string, number]>) {
  const ids: Record<string, string> = {};
  for (const [role, installation] of roles) {
    const id = await makeIdentity(base, cookie, role, installation);
    const tools = (await me(`/api/connections/${id}`)).data.connection.tools.map((t: { name: string }) => t.name);
    await me(`/api/connections/${id}/grant`, { project, tools });
    ids[role] = id;
  }
  return ids;
}

const steps = (run: { steps: Array<{ title: string; status: string }> }) => run.steps.map((s) => `${s.title}: ${s.status}`);

describe('ship-issue', () => {
  for (const isolated of [false, true]) itInContainers.when(isolated)(`takes an issue to a merged pull request, as polyphemus’s identities, reviewed by another vendor, merged when you say${isolated ? ' — with its agents, checks and pages in workers' : ''}`, async () => {
    isolatedShip = isolated;
    const builder = new Sessions('openai', (prompt) => {
      if (prompt.includes('Plan the change for issue #12')) return [call('submit', { summary: 'Add feature.txt saying shipped.', steps: ['Write feature.txt'], proof: ['grep -qx shipped feature.txt'] }), say('Submitted.')];
      const round = Number(/round (\d+)\./.exec(prompt)?.[1]);
      const work = [
        // It also tries to push behind polyphemus's back, with a token that would work: it never leaves.
        // And rigs its folder's git config for polyphemus's push: a URL rewrite, a proxy, a hook that would copy the token.
        `printf 'draft\\n' > feature.txt && git add -A && git commit -qm "Draft the feature" && (git push "$SNEAK" HEAD:refs/heads/sneaky || true) && git config url.http://127.0.0.1:9/.insteadOf "$GH/" && git config http.proxy http://127.0.0.1:9 && mkdir -p .git/rigged && printf '#!/bin/sh\\nenv > "$LEAK"\\n' > .git/rigged/pre-push && chmod +x .git/rigged/pre-push && git config core.hooksPath .git/rigged`,
        `printf 'shipped\\n' > feature.txt && git commit -qam "Ship it"`,
        `echo "Shipped on purpose." > NOTES.md && git add -A && git commit -qm "Say why"`,
      ][round - 1]!;
      return [call('bash', { command: work.replace('$SNEAK', `${gh.base.replace('://', '://x-access-token:ghs_installation_55@')}/acme/site.git`).replace('$GH', gh.base).replace('$LEAK', join(home, 'leaked-env')) }), call('submit', { changed: `round ${round}` }), say('Submitted.')];
    });
    let reviews = 0;
    const reviewer = new Sessions('anthropic', (_prompt, fresh) => {
      if (fresh) reviews += 1;
      return reviews === 1
        ? [call('submit', { verdict: 'request_changes', summary: 'It works, but nothing says why.', concerns: ['Add a note saying why it shipped.'] }), say('Submitted.')]
        : [call('submit', { verdict: 'approve', summary: 'Does what the issue asks.', concerns: [] }), say('Submitted.')];
    });
    const { me, cookie } = await start(builder, reviewer);
    const project = await ledger(me);
    const ids = await grantRoles(me, cookie, project.slug, [
      ['builder', 55],
      ['reviewer', 77],
    ]);

    const started = await me('/api/workflows/ship-issue/start', { project: project.slug, input: { issue: 12, checks: 'test -f feature.txt' }, yolo: true });
    expect(started.status).toBe(201);
    const runOf = async () => (await me(`/api/sessions/${started.data.id}`)).data.work.runs[0];
    const gate = async (title: string) => {
      await until(async () => (await runOf())?.steps.some((s: { title: string; status: string }) => s.title === title && s.status === 'waiting'), `the gate "${title}"`);
      const q = (await me('/api/state')).data.questions.find((x: { kind: string }) => x.kind === 'gate');
      return q;
    };

    // The plan's own proof runs only once you've seen it.
    const contract = await gate('Run these checks?');
    // A second run on the same issue while this one is going is refused, and leaves no thread behind.
    const threadsBefore = (await me('/api/state')).data.sessions.length;
    const twice = await me('/api/workflows/ship-issue/start', { project: project.slug, input: { issue: 12, checks: 'true' } });
    expect(twice).toMatchObject({ status: 409, data: { error: expect.stringContaining('already going for that in “Ship issue #12”') } });
    expect((await me('/api/state')).data.sessions.length).toBe(threadsBefore);
    expect(contract.detail?.asks ?? JSON.stringify(contract)).toContain('grep -qx shipped feature.txt');
    await me(`/api/questions/${contract.id}`, { answer: 'approve' });

    const merge = await gate('Merge?');
    let run = await runOf();
    expect(steps(run)).toEqual([
      'Read the issue: done',
      'Make a worktree: done',
      'Find the checks: done',
      'Plan: done',
      'Run these checks?: done',
      'Round 1 · Build: done',
      'Round 1 · Checks: failed',
      'Round 2 · Build: done',
      'Round 2 · Checks: done',
      'Round 2 · Look at the pages: done',
      'Round 2 · Push: done',
      'Round 2 · Open the pull request: done',
      'Round 2 · Review: done',
      'Round 2 · Post the review: done',
      'Round 2 · Approved: failed',
      'Round 3 · Build: done',
      'Round 3 · Checks: done',
      'Round 3 · Look at the pages: done',
      'Round 3 · Push: done',
      'Round 3 · Open the pull request: done',
      'Round 3 · Review: done',
      'Round 3 · Post the review: done',
      'Round 3 · Approved: done',
      'Merge?: waiting',
    ]);
    // Reasons read as what happened, not as the engine's commands.
    const reasonOf = (title: string) => run.steps.find((st: { title: string }) => st.title === title)?.reason;
    expect(reasonOf('Round 2 · Approved')).toMatch(/^The reviewer asked for changes: It works, but nothing says why\. Add a note saying why it shipped\.$/);
    expect(reasonOf('Round 3 · Open the pull request')).toBe('Already done: pull request #31, as polyphemus App 1.');
    const head2 = gh.seen.reviews[0]!.commit_id;
    const head3 = gh.headOf('polyphemus/issue-12');
    expect(head3).not.toBe(head2);

    // Pushed as the Builder, through git's own auth, with an installation token — never the Reviewer, never you.
    // The agent's own push, with a working token in the URL, never reached GitHub.
    expect(gh.headOf('sneaky')).toBe('');
    // The rigged config changed nothing about polyphemus's pushes, and its hook never ran.
    expect(existsSync(join(home, 'leaked-env'))).toBe(false);
    const pushes = gh.seen.gitAuth.filter((a) => a.push);
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes.every((a) => a.user === 'x-access-token' && a.token === 'ghs_installation_55')).toBe(true);
    // One pull request, opened by the Builder; each review posted by the Reviewer at the commit it read.
    expect(gh.pulls).toHaveLength(1);
    expect(gh.pulls[0]).toMatchObject({ head: 'polyphemus/issue-12', base: 'main', author: 'polyphemus-app-1[bot]', body: expect.stringContaining('Closes #12') });
    expect(gh.seen.reviews.map((r) => [r.user.login, r.state, r.commit_id])).toEqual([
      ['polyphemus-app-2[bot]', 'CHANGES_REQUESTED', head2],
      ['polyphemus-app-2[bot]', 'APPROVED', head3],
    ]);
    // Commits carry the Builder's name, not yours.
    expect(gh.git('-C', gh.bare, 'log', '-1', '--format=%an', head3)).toBe('polyphemus App 1');
    // The review was a fresh session on another vendor, told what it was the next round.
    const reviewSteps = run.steps.filter((s: { title: string }) => s.title.endsWith('· Review'));
    for (const s of reviewSteps) expect((await me(`/api/sessions/${s.sessionId}`)).data.meta).toMatchObject({ provider: 'anthropic', model: 'claude-test-judge' });
    expect(builder.prompts.find((p) => p.includes('round 3.'))).toContain('Add a note saying why it shipped.');
    expect(builder.prompts.find((p) => p.includes('round 2.'))).toContain('grep -qx shipped feature.txt');
    // The worktree sits in the project without showing in its status, and a push from inside it goes nowhere.
    const tree = join(project.path, '.polyphemus-runs', 'polyphemus-issue-12');
    expect(existsSync(tree)).toBe(true);
    // Its own clone, not a worktree sharing the project's .git: a worker can be given just this folder.
    expect(statSync(join(tree, '.git')).isDirectory()).toBe(true);
    expect(existsSync(join(tree, '.git', 'objects', 'info', 'alternates'))).toBe(false);
    expect(gh.git('-C', project.path, 'status', '--porcelain', '--untracked-files=all')).not.toContain('.polyphemus-runs');
    expect(() => gh.git('-C', tree, 'push', 'origin', 'HEAD')).toThrow();
    // Nothing merged yet: it waits for you.
    expect(gh.seen.merges).toEqual([]);
    if (isolatedShip) {
      // Its checks and its look at the pages had a worker of their own, given only the run's folder.
      const listed = spawnSync(runtime!.command, ['ps', '--filter', 'label=polyphemus.worker=1', '--format', '{{.Label "polyphemus.key"}}'], { encoding: 'utf8' }).stdout;
      expect(listed).toContain(`|run|${tree}`);
    }

    await me(`/api/questions/${merge.id}`, { answer: 'approve' });
    run = await until(async () => {
      const r = await runOf();
      return ['done', 'failed'].includes(r.status) ? r : undefined;
    }, 'the run to finish');
    expect(run.status).toBe('done');
    expect(steps(run).slice(-3)).toEqual(['Merge?: done', 'Merge: done', 'Remove the worktree: done']);
    expect(gh.seen.merges).toEqual([{ number: 31, sha: head3 }]);
    expect(gh.headOf('main')).toBe(head3);

    // The worktree is gone and never showed in the project's own status.
    expect(existsSync(join(project.path, '.polyphemus-runs', 'polyphemus-issue-12'))).toBe(false);
    expect(gh.git('-C', project.path, 'status', '--porcelain', '--untracked-files=all')).not.toContain('.polyphemus-runs');
    // No model or thread ever saw a token or a key.
    for (const s of run.steps.filter((x: { sessionId?: string }) => x.sessionId)) {
      // Minus the token this test itself planted in the agent's sneaky push.
      const raw = (await me(`/api/sessions/${s.sessionId}`)).raw.replaceAll('x-access-token:ghs_installation_55@', '');
      expect(raw).not.toContain('ghs_installation_');
      expect(raw).not.toContain('PRIVATE KEY');
    }
    expect((JSON.stringify(builder.prompts) + JSON.stringify(reviewer.prompts)).replaceAll('x-access-token:ghs_installation_55@', '')).not.toContain('ghs_');
    expect(ids.builder).not.toBe(ids.reviewer);
  }, 600_000);

  it('uses the checks the repository declares when you give none, and asks before they first run', async () => {
    const builder = new Sessions('openai', (prompt) => {
      if (prompt.includes('Plan the change for issue #12')) return [call('submit', { summary: 'Add feature.txt.', steps: ['Write it'], proof: [] }), say('Submitted.')];
      return [call('bash', { command: `printf 'shipped\\n' > feature.txt && git add -A && git commit -qm "Ship it"` }), call('submit', { changed: 'done' }), say('Submitted.')];
    });
    const reviewer = new Sessions('anthropic', () => [call('submit', { verdict: 'approve', summary: 'Fine.' }), say('Submitted.')]);
    const { me, cookie } = await start(builder, reviewer);
    const project = await ledger(me);
    await grantRoles(me, cookie, project.slug, [
      ['builder', 55],
      ['reviewer', 77],
    ]);
    const started = await me('/api/workflows/ship-issue/start', { project: project.slug, input: { issue: 12 }, yolo: true });
    expect(started.status).toBe(201);
    const runOf = async () => (await me(`/api/sessions/${started.data.id}`)).data.work.runs[0];
    await until(async () => (await runOf())?.steps.some((s: { title: string; status: string }) => s.title === 'Run these checks?' && s.status === 'waiting'), 'the checks question');
    const gate = (await me('/api/state')).data.questions.find((x: { kind: string }) => x.kind === 'gate');
    expect(gate.asks).toContain('From package.json (npm):\n• npm run test');
    const found = (await runOf()).steps.find((s: { title: string }) => s.title === 'Find the checks');
    expect(found.reason).toBe('From package.json (npm): npm run test');
    await me(`/api/questions/${gate.id}`, { answer: 'approve' });
    const run = await until(async () => {
      const r = await runOf();
      return r.steps.some((s: { title: string; status: string }) => s.title === 'Merge?' && s.status === 'waiting') ? r : undefined;
    }, 'the merge question');
    const checks = run.steps.find((s: { title: string }) => s.title === 'Round 1 · Checks');
    expect(checks.status).toBe('done');
    expect(checks.evidence.map((e: { label: string }) => e.label)).toContain('npm run test');
  }, 60_000);

  it.skipIf(!findChrome())('opens the pages the plan names at phone and desktop widths: a page that throws sends the round back, and the reviewer and you get the pictures', async () => {
    const builder = new Sessions('openai', (prompt) => {
      if (prompt.includes('Plan the change for issue #12')) return [call('submit', { summary: 'A home page.', steps: ['Write index.html'], pages: ['/'] }), say('Submitted.')];
      const round = Number(/round (\d+)\./.exec(prompt)?.[1]);
      const page = round === 1 ? `<title>Ledger</title><h1>Ledger</h1><script>throw new Error('broken on purpose')</script>` : `<title>Ledger</title><h1>Ledger</h1>`;
      return [call('bash', { command: `printf '%s' "${page}" > index.html && git add -A && git commit -qm "Page, round ${round}"` }), call('submit', { changed: `round ${round}` }), say('Submitted.')];
    });
    const reviewer = new Sessions('anthropic', () => [call('submit', { verdict: 'approve', summary: 'Looks right at both widths.' }), say('Submitted.')]);
    const { me, cookie } = await start(builder, reviewer);
    const project = await ledger(me);
    await grantRoles(me, cookie, project.slug, [
      ['builder', 55],
      ['reviewer', 77],
    ]);
    // Your checks, and plain HTML served by polyphemus itself: nothing of the project's runs unseen, so nothing to ask first.
    const started = await me('/api/workflows/ship-issue/start', { project: project.slug, input: { issue: 12, checks: 'true' }, yolo: true });
    expect(started.status).toBe(201);
    const detail = async () => (await me(`/api/sessions/${started.data.id}`)).data;
    const run = await until(async () => {
      const r = (await detail()).work.runs[0];
      return r?.steps.some((s: { title: string; status: string }) => s.title === 'Merge?' && s.status === 'waiting') ? r : undefined;
    }, 'the merge question', 1500);
    expect(steps(run).filter((t) => t.includes('Look') || t.includes('Build'))).toEqual(['Round 1 · Build: done', 'Round 1 · Look at the pages: failed', 'Round 2 · Build: done', 'Round 2 · Look at the pages: done']);
    const look1 = run.steps.find((s: { title: string }) => s.title === 'Round 1 · Look at the pages');
    expect(look1.reason).toBe('/ at 400px: Uncaught: Error: broken on purpose');
    // The next round is told what the page did.
    expect(builder.prompts.find((p) => p.includes('round 2.'))).toContain('Uncaught: Error: broken on purpose');
    const look2 = run.steps.find((s: { title: string }) => s.title === 'Round 2 · Look at the pages');
    expect(look2.evidence.map((e: { label: string; detail: string; ok: boolean }) => [e.label, e.detail.split(' · ')[0], e.ok])).toEqual([
      ['Open / at 400px', 'Loaded: “Ledger”.', true],
      ['Open / at 1280px', 'Loaded: “Ledger”.', true],
    ]);
    // Pictures sit on the step, not in the conversation, and open as images.
    expect(look2.pictures.map((p: { title: string }) => p.title)).toEqual(['/ at 400px', '/ at 1280px']);
    expect((await detail()).artifacts).toEqual([]);
    const picture = await fetch(`${base}/artifacts/${look2.pictures[0].id}/file`, { headers: { cookie } });
    expect(picture.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await picture.arrayBuffer()).slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    // The reviewer was handed the pictures of the commit it reviewed, as files it can open.
    const review = reviewer.prompts.at(-1)!;
    const files = [...review.matchAll(/^- \/ at \d+px: (.+\.png)$/gm)].map((m) => m[1]!);
    expect(files).toHaveLength(2);
    for (const file of files) expect(existsSync(file)).toBe(true);
    const gate = (await me('/api/state')).data.questions.find((x: { kind: string }) => x.kind === 'gate');
    expect(gate.asks).toContain('2 pictures of its pages');
  }, 90_000);

  it('ships a queue of issues one after another, each from the base the last one merged into', async () => {
    const builder = new Sessions('openai', (prompt) => {
      const n = /issue #(\d+)/.exec(prompt)?.[1];
      if (prompt.includes('Plan the change')) return [call('submit', { summary: `Do #${n}.`, steps: ['Write it'], proof: [] }), say('Submitted.')];
      return [call('bash', { command: `printf 'done\\n' > issue-${n}.txt && git add -A && git commit -qm "Issue ${n}"` }), call('submit', { changed: `issue ${n}` }), say('Submitted.')];
    });
    const reviewer = new Sessions('anthropic', () => [call('submit', { verdict: 'approve', summary: 'Fine.' }), say('Submitted.')]);
    const { me, cookie } = await start(builder, reviewer);
    const project = await ledger(me);
    await grantRoles(me, cookie, project.slug, [
      ['builder', 55],
      ['reviewer', 77],
    ]);
    const first = await me('/api/workflows/ship-issue/start', { project: project.slug, input: { issue: 12, checks: 'true', then: '13' }, yolo: true });
    expect(first.status).toBe(201);
    const runIn = async (id: string) => (await me(`/api/sessions/${id}`)).data.work.runs[0];
    const mergeIn = async (id: string) => {
      await until(async () => (await runIn(id))?.steps.some((st: { title: string; status: string }) => st.title === 'Merge?' && st.status === 'waiting'), `the merge question in ${id}`);
      const q = (await me('/api/state')).data.questions.find((x: { kind: string; sessionId: string }) => x.kind === 'gate' && x.sessionId === id);
      await me(`/api/questions/${q.id}`, { answer: 'approve' });
    };
    await mergeIn(first.data.id);
    // Merged: the next issue starts on its own, in a thread of its own, from the base with #12 in it.
    const next = await until(async () => (await me('/api/state')).data.sessions.find((x: { spunFrom?: string; title: string }) => x.spunFrom === first.data.id && x.title === 'Ship issue #13'), 'the next issue’s thread');
    expect((await runIn(first.data.id)).status).toBe('done');
    await until(async () => (await runIn(next.id))?.steps.some((st: { title: string; status: string }) => st.title === 'Make a worktree' && st.status === 'done'), 'the next worktree');
    const merged12 = gh.seen.merges[0]!.sha;
    expect((await runIn(next.id)).steps.find((st: { title: string }) => st.title === 'Make a worktree').reason).toContain(`from main at ${merged12.slice(0, 7)}`);
    await mergeIn(next.id);
    await until(async () => (await runIn(next.id))?.status === 'done', 'the second run to finish');
    expect(gh.seen.merges.map((m) => m.number)).toEqual([31, 32]);
    // The end of the queue: nothing after #13.
    await new Promise((r) => setTimeout(r, 200));
    expect((await me('/api/state')).data.sessions.filter((x: { spunFrom?: string }) => x.spunFrom === next.id)).toEqual([]);
  }, 90_000);

  it('stops the queue when an issue is sent back, and offers the rest', async () => {
    const builder = new Sessions('openai', (prompt) => {
      if (prompt.includes('Plan the change')) return [call('submit', { summary: 'Do it.', steps: ['Write it'], proof: [] }), say('Submitted.')];
      return [call('bash', { command: `printf 'done\\n' > it.txt && git add -A && git commit -qm "It"` }), call('submit', { changed: 'it' }), say('Submitted.')];
    });
    const reviewer = new Sessions('anthropic', () => [call('submit', { verdict: 'approve', summary: 'Fine.' }), say('Submitted.')]);
    const { me, cookie } = await start(builder, reviewer);
    const project = await ledger(me);
    await grantRoles(me, cookie, project.slug, [
      ['builder', 55],
      ['reviewer', 77],
    ]);
    const first = await me('/api/workflows/ship-issue/start', { project: project.slug, input: { issue: 12, checks: 'true', then: '13, 14' }, yolo: true });
    const runOf = async () => (await me(`/api/sessions/${first.data.id}`)).data.work.runs[0];
    await until(async () => (await runOf())?.steps.some((st: { title: string; status: string }) => st.title === 'Merge?' && st.status === 'waiting'), 'the merge question');
    const q = (await me('/api/state')).data.questions.find((x: { kind: string }) => x.kind === 'gate');
    await me(`/api/questions/${q.id}`, { answer: 'decline', note: 'Not this week' });
    const run = await until(async () => {
      const r = await runOf();
      return r.status === 'failed' ? r : undefined;
    }, 'the run to end');
    expect(run.upNext).toEqual({ workflow: 'ship-issue', input: { checks: 'true', issue: 13, then: '14' } });
    await new Promise((r) => setTimeout(r, 200));
    expect((await me('/api/state')).data.sessions.filter((x: { spunFrom?: string }) => x.spunFrom === first.data.id)).toEqual([]);
    expect(gh.seen.merges).toEqual([]);
  }, 90_000);

  it('stops before any model works when the project has no Reviewer identity, saying what to set up', async () => {
    const builder = new Sessions('openai', () => [say('I would plan now.')]);
    const { me, cookie } = await start(builder, new Sessions('anthropic', () => []));
    const project = await ledger(me);
    await grantRoles(me, cookie, project.slug, [['builder', 55]]);
    const { data } = await me('/api/workflows/ship-issue/start', { project: project.slug, input: { issue: 12, checks: 'true' } });
    const run = await until(async () => {
      const r = (await me(`/api/sessions/${data.id}`)).data.work.runs[0];
      return r && r.status === 'failed' ? r : undefined;
    }, 'the run to fail');
    expect(run.reason).toContain('No GitHub Reviewer identity is granted to ledger');
    expect(steps(run)).toEqual(['Read the issue: failed']);
    expect(builder.prompts).toEqual([]);
  }, 30_000);
});

describe('spec', () => {
  it('has the Planner write only the spec, merge it once reviewed and allowed, then file its issues after asking', async () => {
    const planner = new Sessions('openai', (prompt) => {
      if (prompt.includes('break it into issues')) return [call('submit', { issues: [{ title: 'Store notifications', body: 'A table for them.' }, { title: 'Send notifications', body: 'The sender.' }] }), say('Submitted.')];
      const round = Number(/Write a spec, round (\d+)\./.exec(prompt)?.[1]);
      // Round 1 strays outside the specs folder; round 2 puts it right.
      const work = round === 1
        ? `printf '# Notifications\n' > docs/specs/notifications.md && echo hack > src.txt && git add -A && git commit -qm "Spec, and a stray file"`
        : `git rm -q src.txt && git commit -qm "Only the spec"`;
      return [call('bash', { command: work }), call('submit', { file: 'docs/specs/notifications.md', changed: `round ${round}` }), say('Submitted.')];
    });
    const reviewer = new Sessions('anthropic', () => [call('submit', { verdict: 'approve', summary: 'A clear spec.' }), say('Submitted.')]);
    const { me, cookie } = await start(planner, reviewer);
    const project = await ledger(me);
    await grantRoles(me, cookie, project.slug, [
      ['planner', 66],
      ['reviewer', 77],
    ]);
    const { data } = await me('/api/workflows/spec/start', { project: project.slug, input: { idea: 'Notifications for ledger' }, yolo: true });
    const runOf = async () => (await me(`/api/sessions/${data.id}`)).data.work.runs[0];
    const answer = async (title: string) => {
      await until(async () => (await runOf())?.steps.some((s: { title: string; status: string }) => s.title === title && s.status === 'waiting'), `the gate "${title}"`);
      const q = (await me('/api/state')).data.questions.find((x: { kind: string }) => x.kind === 'gate');
      await me(`/api/questions/${q.id}`, { answer: 'approve' });
      return q;
    };
    await answer('Merge?');
    expect(gh.seen.issues).toEqual([]);
    const filing = await answer('File the issues?');
    expect(filing.detail?.asks ?? JSON.stringify(filing)).toContain('Store notifications');
    const run = await until(async () => {
      const r = await runOf();
      return ['done', 'failed'].includes(r.status) ? r : undefined;
    }, 'the run to finish');
    expect(run.status).toBe('done');
    const scope = run.steps.find((s: { title: string }) => s.title === 'Round 1 · Only the spec');
    expect(scope).toMatchObject({ status: 'failed' });
    expect(scope.evidence.some((e: { detail: string }) => e.detail.includes('src.txt'))).toBe(true);
    // Opened and merged as the Planner, approved by the Reviewer; issues filed as the Planner.
    expect(gh.pulls[0]).toMatchObject({ author: 'polyphemus-app-1[bot]', merged: true });
    expect(gh.seen.reviews.map((r) => r.user.login)).toEqual(['polyphemus-app-2[bot]']);
    expect(gh.seen.issues.map((i) => [i.title, i.by])).toEqual([
      ['Store notifications', 'polyphemus-app-1[bot]'],
      ['Send notifications', 'polyphemus-app-1[bot]'],
    ]);
    expect(gh.git('-C', gh.bare, 'ls-tree', '-r', '--name-only', 'main').split('\n').sort()).toEqual(['README.md', 'docs/specs/README.md', 'docs/specs/notifications.md', 'package.json'].sort());
    expect(gh.seen.gitAuth.filter((a) => a.push && a.token !== 'ghs_installation_66')).toEqual([]);
  }, 60_000);
});

describe('a project from a private repository', () => {
  it('clones as an identity installed on it, leaving nothing secret in the copy, and says what to do when none is', async () => {
    const { me, cookie } = await start(new Sessions('openai', () => []), new Sessions('anthropic', () => []));
    const url = `${gh.base}/acme/site`;
    // No identity yet: the private repository refuses, and polyphemus says how to fix it.
    const refused = await me('/api/projects', { name: 'Ledger', from: url });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toContain('none of your GitHub identities is installed on it');

    await makeIdentity(base, cookie, 'reviewer', 77);
    const made = await me('/api/projects', { name: 'Ledger', from: url });
    expect(made.status).toBe(201);
    const path = made.data.project.path;
    expect(gh.git('-C', path, 'log', '-1', '--format=%s')).toBe('Start');
    expect(gh.git('-C', path, 'remote', 'get-url', 'origin')).toBe(url);
    expect(gh.git('-C', path, 'config', '--list', '--show-origin')).not.toContain('ghs_');
    // Read by the Reviewer's token, which can't push: reading is all a clone needs.
    expect(gh.seen.gitAuth.every((a) => !a.push && a.token === 'ghs_installation_77')).toBe(true);
  }, 30_000);
});

describe('merging', () => {
  it('refuses what only its author approved, an approval of an older commit, and a branch that moved', async () => {
    const { me, cookie } = await start(new Sessions('openai', () => []), new Sessions('anthropic', () => []));
    const project = await ledger(me);
    const ids = await grantRoles(me, cookie, project.slug, [
      ['builder', 55],
      ['reviewer', 77],
    ]);
    const builderToken = (await polyphemus.connections.githubToken(ids.builder!)).token;
    // A branch and a pull request, by the Builder.
    const work = join(home, 'work');
    gh.git('clone', '--quiet', gh.bare, work);
    execFileSync('bash', ['-c', `cd ${work} && echo one > a.txt && git add -A && git -c user.name=B -c user.email=b@x commit -qm one && git push -q origin HEAD:refs/heads/polyphemus/x`]);
    const first = gh.headOf('polyphemus/x');
    await fetch(`${gh.base}/repos/acme/site/pulls`, { method: 'POST', headers: { authorization: `Bearer ${builderToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ head: 'polyphemus/x', base: 'main', title: 'x' }) });
    const attempt = (head: string, merger = 'polyphemus-app-1[bot]', base = 'main') => mergeApproved({ repo: 'acme/site', number: 31, head, base, token: builderToken, merger, title: 'x' });

    await expect(attempt(first)).rejects.toThrow(/nobody but its author or the merger approved/);
    // The Reviewer approves the first commit; then the branch moves on.
    gh.seen.reviews.push({ user: { login: 'polyphemus-app-2[bot]' }, state: 'APPROVED', commit_id: first, body: '' });
    // Approved by the one merging doesn't count either.
    await expect(attempt(first, 'polyphemus-app-2[bot]')).rejects.toThrow(/nobody but its author or the merger/);
    execFileSync('bash', ['-c', `cd ${work} && echo two > a.txt && git -c user.name=B -c user.email=b@x commit -qam two && git push -q origin HEAD:refs/heads/polyphemus/x`]);
    const second = gh.headOf('polyphemus/x');
    await expect(attempt(first)).rejects.toThrow(/moved on/);
    await expect(attempt(second)).rejects.toThrow(/nobody but its author or the merger approved/);
    expect(gh.seen.merges).toEqual([]);
    gh.seen.reviews.push({ user: { login: 'polyphemus-app-2[bot]' }, state: 'APPROVED', commit_id: second, body: '' });
    // Evidence it can't read is no evidence: a status lookup that fails stops the merge.
    gh.seen.statusDown = true;
    await expect(attempt(second)).rejects.toThrow(/couldn’t read its commit status/);
    gh.seen.statusDown = false;
    // A request for changes past the first hundred reviews still stands.
    const approved = gh.seen.reviews.pop()!;
    for (let i = 0; i < 100; i++) gh.seen.reviews.push({ user: { login: `someone-${i}` }, state: 'COMMENTED', commit_id: second, body: '' });
    gh.seen.reviews.push(approved, { user: { login: 'a-maintainer' }, state: 'CHANGES_REQUESTED', commit_id: second, body: 'not yet' });
    await expect(attempt(second)).rejects.toThrow(/changes requested/);
    gh.seen.reviews.pop();
    // Where it lands is part of what was approved: everything else is right, and the question said
    // main (fourth review, 2026-09-20).
    await expect(attempt(second, 'polyphemus-app-1[bot]', 'production')).rejects.toThrow(/goes into main now, not production/);
    expect(gh.seen.merges).toEqual([]);
    await expect(attempt(second)).resolves.toMatchObject({ merged: true, sha: second });
  }, 30_000);
});
