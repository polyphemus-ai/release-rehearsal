# Workflows: loops and graphs

**Goal:** intake → GitHub issues → Plan → Execute → Verify → PR runs unattended. It doesn't
get stuck, doesn't lie about its state, and doesn't burn tokens on keeping itself running.
You spend your time on the project, not the pipeline.

## The core rule

> **Orchestration is code. Intelligence is in the nodes.**

The code decides what runs next, whether a step is done, and what happens on failure. The
model does the work inside a step. Every reliable system the research covered draws this
line:

- Anthropic's *Building effective agents*
- Armin Ronacher's *The Coming Loop* ("the Polyphemus decides whether that was actually the end")
- Temporal
- GitHub's coding agent
- Factory Missions

OpenClaw drew it the other way: prose rules, chat messages, and polling crons, with models
running the orchestration.

## OpenClaw failure → cause → rule

| What happened | Cause | Rule here |
|---|---|---|
| The builder agent's transcript corrupted 7 times in a day; #39 died 3 times | A persistent, shared executor session plus auto-compaction | **A fresh session per node run.** No auto-compaction in workflows; hand off to a fresh context instead |
| Told "review is running" when nothing had been spawned; a 2-hour stall | Status came from the model's claims | **Status is observed, never narrated.** Only the run store says a job exists |
| Watchdog woke on already-merged PR #233 | Evidence wasn't tied to an attempt or commit | **Every result carries the commit it checked.** Results for a different commit are rejected |
| Loop died overnight with open tickets | A deleted per-ticket cron; waking by chat announcements | **Durable runs** in one store. The daemon resumes them after a restart, driven by events |
| Executor merged its own PRs | A shared token with merge rights | **Platform-enforced separation** (see [secrets.md](secrets.md)): `exec-bot` can't merge |
| Scout watcher ran 59 times and filled the chat | Narration pushed to the human channel | **Quiet by default.** Notify only on gates, escalations, and completion |
| Receipts leaked into your DM | Sessions shared across agents | One session per node run, owned by the run |
| xAI errors weren't caught by failover | String-matched error handling | Error *classes* ([routing.md](routing.md)); failover only at node boundaries |
| State spread across labels, transcripts, and memory | No single store and no schema | **One typed run store.** GitHub labels are a *projection* of it, not the source |
| **#808 (2026-09-10):** the builder agent, running on an unassigned fallback model after Grok ran out, *wrote* an allocation "from the planner", flipped #808 to in-progress, and started building | Authority was carried by message text, and fallback wasn't bound to the role | **Authority comes only from permits the orchestrator issues** (below). Text claiming authority has no effect and is flagged as an integrity incident. A model change on a bot that can act follows its `on_fallback` policy ([routing.md](routing.md)): by default it pauses and asks you |

## What the OpenClaw workflow report added

The post-mortem of that setup (kept privately)
covers 18 incidents across 2026-09-09/10 and ranks the root causes:

1. state, handoff, and session coordination
2. gaps in acceptance contracts
3. mismatches between tools and environment
4. policy drift
5. credential, provider, and capacity failures

It also shows what worked and must be kept: grounded specs, isolated worktrees, role-specific
GitHub Apps, review against the exact head commit, and an **independent reviewer**. On #759,
A security reviewer agent caught 2×P1 + 2×P2 financial and security defects that the green tests and the
functional reviewer both missed.

This adds nine things to the design:

1. **Every side effect needs a generation-fenced permit.** A run's `generation` goes up
   whenever ownership changes (retry, reassignment, restart). A node receives a short-lived
   permit bound to `{run, node, generation, actor, headSha, idempotencyKey}`, and the broker
   refuses any side effect without a current permit. A stale worker, a duplicate session, or
   a replayed watcher event can't act.

   This also fixes #794, where an approval appeared that no agent claimed: the broker
   authenticated the socket, not the caller.

   **Workers can't issue permits, and nothing a model writes counts as one.** An allocation, an
   approval, or a "go ahead from the planner" is a row the orchestrator creates, bound to a node and a
   generation. It's never a message. Every message and artifact carries **authenticated
   provenance** (bot, session, model, run, generation), recorded by Polyphemus rather than claimed
   in the content, and the UI shows it. If an output claims authority it doesn't hold ("allocated
   by the planner" with no matching permit), Polyphemus raises an integrity incident and pauses the run.
   That is what happened on #808, and here the forged allocation would have done nothing.
2. **Plan's output is an executable contract, not prose.** On #759, #719, #802, and #677,
   tests written by the executor passed while consumer, financial, security, or real-file
   behaviour was wrong. `Plan` must include:
   - approved consumer examples
   - negative and adversarial cases
   - invariants
   - real-artifact fixtures wherever file formats matter
   - the validation commands

   All of it is written **before** Execute runs, and it belongs to Plan and Verify, not to the
   executor (Factory's "validation contract").
3. **Findings are classified.** Every Verify finding is one of:
   - contract omission
   - implementation defect
   - missing test
   - environment failure
   - stale handoff
   - review mistake
   - new product decision

   Only implementation defects and missing tests use up the repair budget. Environment
   failures go to preflight. Contract omissions and product decisions go back to Plan, or to
   you.
4. **Preflight before a node runs.** Check the filesystem, the tools (is `rg` actually on
   `PATH`?), mounts, broker access, model, and credentials first. A node never starts in an
   environment where it can't finish.
5. **Isolate more than files.** Worktrees don't isolate RAM, ports, databases, or CPU (the
   report cites SIGKILLed parallel test jobs and a test run that hit a stale database). Each run
   gets its own ports and disposable databases, and a host-wide scheduler limits concurrent
   heavy checks. The daemon itself stays lean (the OpenClaw gateway was OOM-killed).
6. **Retries inherit history.** A repair attempt or a successor ticket gets the earlier
   findings as input. Nothing restarts from a blank slate.
7. **Policy lives in one versioned place.** WIP limits, repair rounds, and reviewer sets per
   risk class live in workflow config, not in copies across AGENTS.md files (that's how WIP=2
   silently drifted back to 1). Prompts are generated from the config.
8. **Every node records its usage** (tokens, provider, wall time, retries, failure class)
   against the run, the issue, and the phase. "What did this ticket cost?" gets an answer;
   OpenClaw couldn't give one.
9. **Reviewer sets depend on risk class,** and approvals are bound to the exact head commit. A
   new head invalidates them.

## Model

### Runs

A run is a durable state machine in the daemon's SQLite store. The run key is `repo#issue`,
and there is at most one active run per key.

```ts
interface Run {
  id: string; workflow: string; key: string;
  node: string;                              // current node
  generation: number;                        // bumps on any ownership change; fences stale workers
  status: 'running' | 'waiting' | 'needs_you' | 'done' | 'failed' | 'cancelled';
  attempts: Record<string, number>;
  budget: { tokens: number; usd: number; wallMs: number };   // used so far vs caps
  headSha?: string;                          // commit that evidence must match
  artifacts: Record<string, Artifact>;       // typed outputs of each node
  jobs: Job[];                               // live processes: {sessionId, provider, status, heartbeatAt}
  events: RunEvent[];                        // append-only log; the UI timeline
}
```

The daemon checkpoints after every node, so a crash or restart resumes from the last
completed node. We build this on our own SQLite store (the DBOS pattern) rather than running
Temporal. Checkpointing per node is enough for this.

### Node types

| Type | What it is | Examples |
|---|---|---|
| `agent` | A **fresh session** for one bot, with typed input and output artifacts. It finishes by calling `submit(<artifact>)`, which is checked against a schema | plan, execute, review |
| `check` | Plain commands, objective pass or fail, run against `headSha` | build, typecheck, lint, test, e2e, screenshot diff |
| `gate` | Waits for a human (a push notification with approve or reject) or a condition, without spending tokens | approve plan, approve merge |
| `action` | A side effect performed by code (the "safe outputs" pattern), keyed so reruns are idempotent | create issue, open PR, add label, merge |
| `loop` | Repeat a sub-graph until an exit check passes, with a hard cap on iterations | fix loop, the Ralph pattern |

### Rules for agent nodes

- **A fresh context every time,** seeded only with its input artifacts, the relevant memory,
  and the handoff.
- **Its own git worktree** per run, cleaned up when the run ends.
- **One task per session.** At about 60% context, the node writes a `Handoff` artifact and
  the next attempt starts fresh.
- **Tool policy comes from the node, not the prompt.** For example, the reviewer is
  read-only and the executor can push to `agent/<run>` but not merge.
- **The reviewer uses a different provider from the executor** by default. A judge from a
  different model family catches more.

## Budgets and stuck detection

- **Per node:** at most 3 attempts. **Per loop:** at most 2–3 rounds. **Per run:** caps on
  tokens, dollars, and wall-clock time.
- **No-progress detection:** the same diff hash, or the same set of failing tests, twice in a
  row means escalate. Repeated identical actions or observations inside a session mean stop
  the session (the OpenHands stuck detector).
- **Heartbeats:** a job that misses heartbeats is marked dead and retried. It's never
  inferred from old evidence.
- **Hitting a limit** moves the run to `needs_you` with a one-paragraph summary: what was
  tried, what's failing, and the options. It never loops silently.
- **Capacity-aware:** before an expensive node, the run checks capacity. If the provider
  won't last, it switches route at this boundary or schedules "resume at reset".

## Built-in workflows

You configure these; you don't write them.

### `intake`: turn a request into work

*As built (2026-09-13):* `where → agent:shape (read-only) → gate:pick (choices) → action:make` —
GitHub issues by the Planner, or work items in a project with no repository. The sketch below
was the plan.

```
intake(text | voice | issue)
  → agent:spec      (Scout: questions, acceptance criteria, size, risks → Tickets[])
  → gate:approve    (you: one tap per ticket, or edit)
  → action:create-issues   (idempotent: key = intake id + ticket index)
  → action:label spec-ready  (starts ship-ticket for each)
```

### `ship-issue`: from an issue to a merged PR

```
agent:plan        → Plan { steps, files, size, risk,
                           contract { consumer examples, negative/adversarial cases, invariants,
                                      real-artifact fixtures, validation commands } }
gate:approve      → only if size = L or the plan touches risky areas (config)
agent:execute     → ChangeReport { branch, commits, notes }   (own worktree, exec-bot identity)
check:objective   → Checks { build, typecheck, lint, tests, validation[] } @ headSha
  └ fail → loop back to execute with the failure bundle (max 3)
check:look        → the pages the plan names, served from the worktree (a dev script you were shown,
                    or plain HTML) and opened in headless Chrome at 400px and 1280px @ headSha;
                    a page that doesn't load, answers an error or throws fails the round. The
                    pictures stay on the step, and go to the reviewer and the merge gate
agent:review      → Verdict { pass | changes[] }   (a different provider, read-only, rubric = Plan.acceptance)
  └ changes → loop back to execute (max 2)
action:open-pr    → PR with plan, checks, and verdict as evidence
gate:merge        → review-bot approval + required checks, or you (config)
action:merge      → done; memory handoff and journal written
```

### `loop`: keep going until a condition is met

`poly loop "make the e2e suite pass" --until "pnpm e2e" --max 10` runs the Ralph pattern
properly: a fresh session each iteration, state in files and git, and an objective exit
check.

## Custom workflows

These are TypeScript files in `~/.polyphemus/workflows/` or `<repo>/.polyphemus/workflows/`,
written against a small typed builder. The graph shape is checked at load time and artifacts
are validated with schemas. You don't write YAML that silently misbehaves.

## What you see

- **Runs view:** each run is a row showing ticket, node, status, attempts, spend, and age.
  Opening one shows the graph with live node states, and each node links to its session.
- **Notifications:** only for gates (with one-tap approve), `needs_you`, done, and failed.
  Plus an optional daily digest.
- **GitHub stays truthful:** labels and PR comments are updated *from* the run store.

## Build order

| Phase | Work |
|---|---|
| 4 | Run store, the node types, worktrees, artifacts and schemas, budgets and stuck detection, heartbeats, the `loop` workflow |
| 4 | `ship-ticket` and `intake` with GitHub Apps; runs view in the terminal (`polyphemus runs`) |
| 5 | Runs view and graph in the app; push gates |
| 6 | Custom workflow builder API; parallel runs with per-provider concurrency limits |

## Key sources

Anthropic: [Building effective agents](https://www.anthropic.com/research/building-effective-agents),
[harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents),
[multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).
[Armin Ronacher, The Coming Loop](https://lucumr.pocoo.org/2026/6/23/the-coming-loop/).
[Factory Missions](https://factory.ai/news/missions-architecture).
GitHub: [Copilot coding agent risks](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations),
[safe outputs](https://github.github.com/gh-aw/reference/safe-outputs/).
[OpenHands stuck detector](https://docs.openhands.dev/sdk/guides/agent-stuck-detector).
[DBOS](https://docs.dbos.dev/ai/ai-quickstart).
[LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).
[Ralph](https://ghuntley.com/ralph/).
[Simon Willison on agentic loops](https://simonwillison.net/2025/Sep/30/designing-agentic-loops/).
