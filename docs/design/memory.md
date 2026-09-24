# Memory

**Goal:** any bot, on any provider, can pick up where the last session left off at a
predictable token cost. Memory stays *true* over time instead of piling up.

## Where the field has landed (Sep 2026)

The leading systems have converged on **plain files that agents edit with ordinary file
tools**:

- Anthropic's memory tool and Managed Agents memory stores
- Claude Code auto-memory
- Codex memories
- Letta Context Repositories (git-backed)
- Karpathy's LLM Wiki

In Letta's LoCoMo benchmark, a plain filesystem scored 74%, beating specialized memory
libraries. The same systems also share a set of habits:

1. **A small index is always loaded, and details load on demand.** Claude Code loads a
   `MEMORY.md` index (about 200 lines or 25 KB) and reads topic files only when needed.
2. **Rules are separate from memory.** Codex puts it this way: "treat memories as a helpful
   recall layer, not as the only source for rules." Cursor removed its Memories feature in
   favour of Rules.
3. **Consolidation runs in the background and can be reviewed.** Anthropic's Dreams writes a
   *new* version and leaves the input untouched. Letta runs sleep-time agents. Karpathy runs
   a "lint" pass.
4. **Many small files, every change versioned** (Managed Agents versions; Letta git commits).
5. **Memory is an attack surface.** A prompt injection can write something that later
   sessions will trust.

## What OpenClaw showed us

| Evidence | Lesson |
|---|---|
| About 100 KB of standing prose (AGENTS.md 39 KB, MEMORY.md 63 KB) injected into every session | Budget the always-loaded part and enforce the budget in tooling |
| 393 memory files / 4.8 MB, never pruned; 9 "NON-NEGOTIABLE" blocks; a parked project still listed as "active focus" | Writes need discipline; consolidation has to actually run |
| `NEXT-SESSION.md` grew to a 53 KB pile, with 11 copies | Handoff is **one file, overwritten**, with history in git |
| HEARTBEAT still pointed at a retired watchdog | Facts need validity dates and checks |
| Acme, infra and Game Night context leaking into Ledger sessions | Scope memory per project |
| The dream diary had little operational value | Consolidation output must be operational and reviewable |

## Design

### 1. Four kinds of content

| Kind | What | How it's used |
|---|---|---|
| **Rules** | Instructions you approved: `AGENTS.md`, `~/.polyphemus/AGENTS.md`, project rules | Always loaded. The authority |
| **Notes** (semantic) | Facts and decisions (decisions include the *why*) | The index is always loaded; bodies are recalled when relevant |
| **Procedures** | How to do recurring things | Loaded on demand like skills, when a task matches |
| **Journal** (episodic) | What happened each session | Low trust. Searchable, never auto-recalled. Raw material for consolidation |

Plus one **handoff** per project or bot: current state, next steps, blockers. It's always
loaded for the active project, overwritten each time, and marked consumed once read.

**Promotion path:** a note that keeps getting confirmed can be proposed as a rule. You
approve it and it moves. Rules never change without you.

### 2. Layout and scopes

```
~/.polyphemus/memory/              ← a git repo
  user/                         you: preferences, profile
  projects/<slug>/              notes, decisions, handoff.md
  bots/<bot>/                   private notes, journal/
  teams/<team>/                 shared between bots
  procedures/                   reusable how-tos
```

- A bot **reads** user + its projects + its own folder + its teams, and nothing from other
  projects unless you ask.

*Built 2026-09-17 (agent scopes):* `agents/<agent>/craft/` and `agents/<agent>/people/<person>/`, with
the rule that decides recall — **a memory can only come back in a room no more open than the one it was
learned in.** Craft (what the agent learned about its work, about nobody) is recalled in any thread with
that agent. What a person told it alone is recalled only in threads with that person and that agent, and
nobody else: another person or another agent in the thread is a more open room, and it isn't there.
Project memory is unchanged: everyone who works there can read those threads anyway. An agent writes
none of it — `remember` proposes, and which scope a person accepts is what decides where it can come
back (`memory.ts`). Private memory is kept only by the person it was told to; craft by the owner;
project memory by anyone who works there. Craft is the agent's, not a project's: what it
learned about its work in one project comes with it into the next (the owner, 2026-09-17 — "crafts,
skills, personality should carry with the agent just like they would with a person"). Still to come:
`user/`, `teams/`, consolidation, and recall by search rather than a list of descriptions.
- A bot **writes** directly only to its own folder and to project handoffs. Changes to
  shared scopes (user, project notes, team) are *proposed* and land through consolidation or
  your review.
- Concurrent writes use compare-and-swap on the file's content hash (the Managed Agents
  pattern).

### 3. Note format

```markdown
---
id: bg-aws-account
type: fact                      # fact | decision | procedure | preference
scope: projects/game-night
description: Which AWS account Game Night deploys to, and how to reach it   # when to recall this
source: { session: 88f44e18, trust: user }       # trust: user | agent | untrusted
created: 2026-09-10
valid_from: 2026-09-08
invalid_at:                     # set when superseded; invalid notes are left out of recall
verified: 2026-09-10
check: polyphemus bindings verify game-night/prod   # optional machine check
supersedes: bg-aws-account-2026-06
paths: ["infra/**"]             # optional: recall when working on these files
---

Game Night deploys through the `prod` binding. Never hard-code the account id;
see [[secrets/bindings]].
```

- **Time is explicit** (Graphiti's `valid_at`/`invalid_at`). Contradicted facts are
  invalidated, not deleted, and dates are absolute.
- **Point at the contract, not its current value.** Infra notes reference a *binding*
  ([secrets.md](secrets.md)) instead of copying an account id. That's the fix for "memory
  says the old AWS account."
- **Review cadence comes from type.** Infra facts get checked often; preferences rarely.
- **`check` commands** re-verify facts automatically during consolidation. None of the
  systems the research covered do this. It's our addition.

### 4. Orientation and recall

Every session starts with a **fixed-budget orientation packet**:

1. Rules (cached in the system prompt)
2. `_index.md`: one line per note (`id: description`), generated, capped
3. The handoff for the active project or bot
4. A capacity line ([capacity.md](capacity.md))

Then, on each turn:

- **Auto-recall** searches the index with the user's message, recent context, and the files
  being touched (`paths`), and appends the top matches to the turn, within a budget.
  Appending keeps the prompt cache warm.
- It's **visible and optional:** "recalled 2 notes" appears in the UI, and `/memory off`
  turns it off for a session.
- **Tools:** `memory_search`, `memory_read`, `remember`, `invalidate`.
- **Search:** full-text search (SQLite FTS5) over descriptions and bodies. Add embeddings
  and reranking only once there are a few hundred notes.

### 5. Writing

- **Write when:**
  - you ask
  - the same correction happens a second time
  - a decision is made
  - the session goes idle (a short journal entry)
- **Don't write** what can be re-derived from the code, git, or the docs.
- **Before writing,** compare against the nearest existing notes and choose one of: add,
  update, invalidate the old one, or do nothing (the Mem0 pattern). Heavy merging waits for
  consolidation.
- **Refuse** anything that looks like a secret.
- **Mark trust:** notes derived from web pages or tool output are marked `untrusted` and
  never become rules.
- **Every write is a git commit** with the session as provenance.

### 6. Consolidation ("sleep")

Runs nightly, or after about 24 hours and 5 sessions (AutoDream's trigger), on a cheap
model.

- **Inputs:** new journal entries, recent session transcripts, current notes, and optional
  steering ("focus on Ledger; ignore one-off debugging").
- **Work:**
  - merge duplicates
  - invalidate contradicted notes
  - promote repeated patterns into notes or procedures
  - propose rules
  - lint: orphans, oversize files, missing descriptions, notes past their review date
  - run `check` commands
  - regenerate `_index.md`
  - enforce size caps
- **Output:** a **branch with a readable changelog.** You approve or edit it (or the
  approval is automatic for bot-private scopes), then it merges. The input is never edited
  in place.

### 7. Evaluation

A small suite built from our own history. It tests:

- knowledge updates (the AWS account move)
- time questions ("what was true in August?")
- abstention ("I don't know" when nothing was stored)
- the repeated-correction rate
- orientation hit rate: did the packet contain what the task needed?

It runs after changes to the memory system.

## Build order

| Phase | Work |
|---|---|
| 3 | Layout, note format, index, orientation packet, auto-recall (FTS), memory tools, handoff, secret scanner |
| 5 | Memory browser in the app: see, edit, invalidate, and pin notes; "recalled" chips |
| 6 | Bot and team scopes, consolidation branches, `check` commands, evaluation suite, embeddings if needed |

## Key sources

Anthropic: [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool),
[Managed Agents memory](https://platform.claude.com/docs/en/managed-agents/memory),
[Dreams](https://platform.claude.com/docs/en/managed-agents/dreams),
[Claude Code memory](https://code.claude.com/docs/en/memory),
[context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).
Codex [memories](https://learn.chatgpt.com/docs/customization/memories).
Letta: [context repositories](https://www.letta.com/blog/context-repositories/),
[sleep-time compute](https://www.letta.com/blog/sleep-time-compute/),
[benchmark](https://www.letta.com/blog/benchmarking-ai-agent-memory/).
[Graphiti / Zep](https://arxiv.org/abs/2501.13956). [Mem0](https://arxiv.org/abs/2504.19413).
[Karpathy's LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).
[LongMemEval](https://arxiv.org/abs/2410.10813).
