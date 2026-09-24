# Scheduling: routines that make bots feel alive

**Goal:** bots act on their own at the right moments (on a schedule, when something happens,
or when capacity frees up), without waking a model to find out there's nothing to do and
without ever flooding you.

## Three layers

| Layer | Decides | Doc |
|---|---|---|
| **Bots** | *Who*: a persistent identity with a role, route, memory, and grants | [app.md](app.md), roadmap phase 6 |
| **Routines** (this doc) | *When*: triggers, and whether this particular firing should run | here |
| **Workflows** | *How*: loops and graphs of nodes | [workflows.md](workflows.md) |

OpenClaw blurred the three. Its heartbeats were a bot, a schedule, and an executor all in one
chat session. Here a routine only ever *starts a workflow run*. It never types into a
conversation.

## What went wrong in OpenClaw

| Incident | Rule here |
|---|---|
| A Scout watcher ran 59 times and flooded the human chat (`sessionTarget=current`) | Every firing runs in a **fresh, isolated run**. Delivering results to you is a separate policy that defaults to "only on change or failure" |
| A cron job kept firing against an **archived session** | **Preflight** before each firing: the target exists, auth works, and the budget allows it. If not, the firing is recorded with a typed error, and repeated failures **auto-pause** the routine |
| The watchdog reported a retired job ID as broken | Sensors re-read live state; they never reuse old observations |
| System jobs took the direct-API auth path while the CLI subscription worked | Preflight resolves the *actual* credential route of the run's provider |
| Heartbeats woke a model with nothing to do | **Sensors** check in code first. The model wakes only when something changed |

## Model

### Triggers

A routine can have several triggers:

| Kind | Examples |
|---|---|
| `cron` / `interval` | `0 9 * * 1-5` in `America/Chicago`; every 30 minutes |
| `once` | "tomorrow at 8am". Disables itself after firing |
| `event` | a GitHub webhook (a new issue labeled `intake`, a PR comment), email, a file change, a message from you |
| `condition` | **`after_reset: codex/7d`**, i.e. run when a capacity window resets. Nobody else ships this yet; our capacity data makes it possible |
| `api` / manual | `poly routine run <name>`, a button in the app |
| `self` | a run schedules its own follow-up ("check CI again in 10 minutes"), with backoff |

### Each firing is a record, even when nothing starts

This follows Anthropic's `deployment_run` design:

```
fire { id, routine, trigger, slot_at, idem_key UNIQUE,
       status: started | skipped | deduped | deferred | rejected,
       reason, run_id? }
```

- **Idempotency key:** `routine + scheduled slot` for schedules, `routine + delivery id` for
  events (GitHub's `X-GitHub-Delivery`). Each slot or event gets exactly one run.
- **Order of checks per firing:** preflight (target, auth, capacity, budget), then the sensor,
  then start the workflow run.

### Sensors: cheap checks in code before any tokens

A sensor is a small function or command that returns `{ wake: false }` or `{ wake: true,
digest }`. It keeps a cursor, so "issues opened since the last run" is computed without a model.
The digest becomes the run's input, so the model starts with the facts instead of searching
for them.

### Reliability

| Concern | Default | Options |
|---|---|---|
| Overlap (the previous run is still going) | `skip`, recorded with its reason | `buffer_one`, `cancel_other`, `allow` |
| Missed while the daemon was down | `latest`: catch up once, within a window | `skip`, `all` (backfill) |
| Repeated failures | pause after 3 in a row, and notify | configurable |
| Thundering herd | deterministic jitter (up to 10% of the interval) | |
| Time zones | IANA zones; warn on schedules in the 1–3am DST window | |
| Runaway | budget per run and per day (`max_usd`, `max_runs_per_day`); optional `expires_at` | |
| Daemon restart | the schedule store and leases live in SQLite; dead owners' leases are reclaimed on boot | |

**Events at a home server behind NAT:** poll where possible (GitHub is cheap to poll per repo).
For push, use Cloudflare Tunnel (outbound only). Webhooks are acknowledged immediately,
deduplicated by delivery id, and missed deliveries are re-requested after downtime.

## How it feels "alive" without being noisy

- **Successful runs stay silent.** Results go to the bot's inbox. You're notified only on
  change, failure, or when something needs you.
- **One finite daily digest** per bot, if you want it.
- **Always visible:** "next run at", the last 20 firings (including skips and why), spend, and
  consecutive failures.
- **Self-pacing:** a routine that finds nothing backs off; one that finds activity speeds up.
- **Quiet hours** defer a firing, they don't drop it.
- **Late-firing guardrails** in the routine body, e.g. "if it's after 5pm, just summarize what
  was missed."
- **Asks before running on:** a routine not touched in a long time asks whether to keep running,
  as Grok does.

## Defining a routine

**A routine should be able to start as a sentence.** In Grok Bot, "Run this every week." becomes
a line in the thread — *Created routine ⏱ Overnight outbound* — and the work you just watched
becomes its body. That's the right front door: the run that just happened is the best
description of what you want repeated, and nobody writes frontmatter from memory. The file is
still what gets stored, so it stays reviewable, diffable, and editable afterwards.

The file shape matches the Claude Desktop and Grok skill shape: markdown with frontmatter, in
the bot's folder or `<repo>/.polyphemus/routines/`:

```markdown
---
name: triage-new-issues
bot: scout
triggers:
  - { event: github.issues.opened, repo: acme/game-night, labels: [intake] }
  - { cron: "0 9 * * 1-5", tz: America/Chicago }        # morning sweep for anything missed
sensor: { kind: github-issues, since: last_run, label: intake }
action: { workflow: intake }                             # see workflows.md
deliver: { on: [change, failure], to: inbox }
budget: { max_usd: 2, max_runs_per_day: 20 }
overlap: skip
catchup: latest
---

Triage new intake issues: ask clarifying questions where the request is ambiguous,
propose acceptance criteria, and flag anything that needs the owner.
```

## CLI

```
poly routine ls                    # next fire, last result, failures, spend
poly routine show <name>           # config + last 20 firings (with skip reasons)
poly routine add <file> [--dry-run]
poly routine run <name>            # run now (still goes through preflight and the sensor)
poly routine pause|resume <name>
poly routine next <name>           # the next 5 fire times, after jitter and quiet hours
poly routine backfill <name> --from <time>
```

Every command supports `--json` (see [cli-for-agents.md](cli-for-agents.md)).

## Build order

| Phase | Work |
|---|---|
| 2 | ✅ Fire and state tables in the daemon; `cron`/`every`/`once`/run-now triggers; preflight (project, folder, model, login, usage, daily limit, overlap); catch-up and auto-pause; `poly routine` commands; routines on each project page with Run now. Until workflows exist (phase 4), a routine runs its prompt as a fresh thread in its project. `every` times line up with the clock (every 30m: :00 and :30); use `cron` for a specific time of day. Running out of usage skips a firing without counting as a failure |
| 4 | Sensors (GitHub, files), `event` triggers (GitHub polling first, then webhooks via a tunnel), routines that start workflow runs (intake, ship-ticket) |
| 5 | Inbox delivery, digests, "next run" and history in the app |
| 6 | Bots own routines; `after_reset` capacity triggers; self-scheduling with backoff; routines learned from demonstrations |

## Key sources

Anthropic: [scheduled deployments](https://platform.claude.com/docs/en/managed-agents/scheduled-deployments),
[Claude Code routines](https://code.claude.com/docs/en/routines),
[scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks),
[Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks).
[Grok Bot routines](https://docs.x.ai/grok-bot/skills-routines-and-automations).
[Codex automations](https://learn.chatgpt.com/docs/automations?surface=app).
Durable scheduling: [Temporal schedules](https://docs.temporal.io/schedule),
[Inngest singleton](https://www.inngest.com/docs/guides/singleton),
[DBOS scheduled workflows](https://docs.dbos.dev/typescript/tutorials/scheduled-workflows).
[GitHub webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
[Letta sleep-time agents](https://docs.letta.com/guides/agents/architectures/sleeptime).
OpenClaw: [heartbeat](https://docs.openclaw.ai/gateway/heartbeat),
[cron](https://docs.openclaw.ai/automation/cron-jobs), and incidents in an earlier setup on 2026-09-06
and 2026-09-09.
