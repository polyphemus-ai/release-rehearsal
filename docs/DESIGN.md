# Polyphemus — design

An open-source agent harness: one agent loop over many model providers, threads you can actually
follow, agents and people working in the same place, and workflows that prove their work — run by a
daemon on your own computer and used from a phone-first app. This file is the architecture, the
pillars and the decisions log; [design/roadmap.md](design/roadmap.md) is the order things are built in,
and [../AGENTS.md](../AGENTS.md) is where to start if you're changing the code.

## Goals

- **Multiple providers as a first-class feature.** Claude, OpenAI, and Grok from day one,
  each through its API with a key, or through the vendor's own CLI on a subscription.
- **Legible sessions.** Every conversation is a row you can list, name, resume, and switch
  models inside.
- **Headless core.** The core never touches a terminal. Clients (the terminal, and the daemon's
  phone-first web app) sit on top of the same events.
- **Simple.** Features get added when they're missed, not up front.
- **Best practice by default.** Defaults come from researching what the leading teams do
  (sources are cited in each design doc), and are then checked against what failed in earlier agent
  setups.

## What makes Polyphemus different

The list, 2026-09-11, in priority order. Every feature should serve one of these; anything that
serves none of them needs a reason.

1. **Multiplayer native.** Teams of agents, and later people, working in the same place — not a
   single-player chat window. ([design/agents.md](design/agents.md), phase 8)
2. **An app you can actually navigate.** Sessions you can follow, one place that says what needs
   you, and no wall of tool output unless you ask for it. The opposite of OpenClaw's control UI.
   ([design/app.md](design/app.md))
3. **Rich customization.** Agents, skills, routines, and templates are files you can read, edit,
   diff, and share.
4. **Expert agents for specific work.** A roster with real roles (Builder, Reviewer, Researcher,
   Ops), each with its own model route, persona, skills, and permissions.
5. **Never locked to one provider.** Subscriptions, paid APIs, gateways, and models on your own
   machine, all behind one loop, with fallback when one runs out.
   ([design/routing.md](design/routing.md), [design/capacity.md](design/capacity.md))

## Pillars

Each pillar has its own design doc:

| Pillar | Doc | One line |
|---|---|---|
| Memory | [design/memory.md](design/memory.md) | Markdown in git is the source of truth; the index is derived; rules are kept separate from recalled notes; consolidation produces reviewable branches |
| Secrets and identity | [design/secrets.md](design/secrets.md) | Bots use credentials they never see; one identity per bot; bindings that fail closed; separation of duties enforced by GitHub |
| Worker isolation | [design/isolation.md](design/isolation.md) | Agents' commands and files run in a worker with only what was granted; vendor CLIs stay on the host with their tools sent there; the owner picks the risk level |
| Routing and fallbacks | [design/routing.md](design/routing.md) | `route = ["claude", "gpt", "grok"]`; errors classified before any fallback; breakers; sticky sessions; every attempt recorded |
| Capacity | [design/capacity.md](design/capacity.md) | Every limit window tracked, forecast by burn rate, shown to you and to the bots |
| Workflows | [design/workflows.md](design/workflows.md) | Orchestration is code; a fresh session per node; typed artifacts; evidence tied to a commit; status observed, not narrated |
| Computer use | [design/computer-use.md](design/computer-use.md) | Canonical action schema; browser first (accessibility tree), then desktop sandboxes; the model never sees passwords |
| App | [design/app.md](design/app.md) | Daemon as source of truth; one place for what's waiting on you; a phone-first web app the daemon serves over your tailnet (native apps and voice are later) |
| Scheduling | [design/scheduling.md](design/scheduling.md) | Routines with triggers (time, events, capacity resets); cheap code checks before any model wakes; every firing recorded; quiet unless something changed |
| Agents and people | [design/agents.md](design/agents.md) | Each project is a server: a roster of agents and people, threads where they work together, and DMs. An agent owns its model route, persona, skills (its own or shared), and routines; templates and skills come built in or from a reviewed store |
| Projects | [design/projects.md](design/projects.md) | A project is a folder Polyphemus knows about: `AGENTS.md` and `.polyphemus/` in the folder (safe to commit), memory private in `~/.polyphemus`; code lives in `~/projects` or wherever it already is, never inside `~/.polyphemus` |
| Upgrades | [design/upgrades.md](design/upgrades.md) | Each version beside the last; the new one checks itself on a copy of your data before the switch; a backup, a watched restart, and going back on its own if it doesn't come up; data only ever adds |
| Agent-friendly CLI | [design/cli-for-agents.md](design/cli-for-agents.md) | One command registry that generates help, JSON schemas, MCP tools, and the agent guide; config changes planned, validated, reversible, with hand edits detected |

## Non-goals (for now)

A public plugin marketplace, and server-side context compaction. Plugins for agents are planned: see
[design/roadmap.md](design/roadmap.md).

## Architecture

```
            ┌─────────────── clients ───────────────┐
            │ terminal        │ web app (phone first) │
            └───────┬───────────────────┬───────────┘
                    │ the daemon: HTTP + server-sent events
                    │ (the source of truth: threads, runs, event log)
            ┌───────▼───────────────────▼───────────┐
            │ core                                   │
            │  loop ─ providers ─ credentials        │
            │   │                                    │
            │  tools          session store (SQLite) │
            └────────────────────────────────────────┘
```

Monorepo layout:

| Package | Role |
|---|---|
| `packages/core` | Canonical types, provider adapters, credentials, tools, loop, session store, config |
| `packages/cli` | Terminal client: REPL, one-shot `-p` mode, and every `polyphemus …` command (declared once in `commands.ts`; `--json` for agents) |
| `packages/daemon` | The daemon: HTTP + SSE for the phone web app (`web/`), pairing, Web Push, Tailscale |

## Core concepts

### Canonical messages (`core/src/types.ts`)

The loop, store, and clients only see provider-neutral types:

- `Message { role, content: Block[], origin?, native? }`
- `Block` = `text` | `thinking` | `tool_call` | `tool_result`
- `origin` records which provider and model produced an assistant message.
- `native` holds the provider's own representation of that message: Anthropic content
  blocks with thinking signatures, or OpenAI output items with encrypted reasoning.

**Replay rule.** When the next request goes to the same provider *and* model that produced
a message, the adapter replays `native` verbatim, so reasoning continuity survives. When it
goes anywhere else, the adapter rebuilds the message from `content` and drops thinking
(reasoning is bound to the model that produced it). This is what makes switching models
mid-session safe.

History is append-only. Nothing edits earlier turns. That keeps prompt caches warm and
satisfies providers that reject edited reasoning history.

### Providers (`core/src/providers/`)

```ts
interface ModelProvider {
  id: string;
  stream(req: ChatRequest): AsyncIterable<ProviderEvent>; // deltas, then one message_done
  listModels(): Promise<string[]>;
}
```

| Adapter | API | Used for |
|---|---|---|
| `anthropic` | Anthropic Messages API (streaming, beta namespace) | Claude |
| `openai-responses` | OpenAI Responses API (streaming, `store: false`, encrypted reasoning) | OpenAI; xAI Grok via `base_url` |
| `openai-chat` | OpenAI Chat Completions | Ollama, OpenRouter, and anything else OpenAI-compatible |

**Agent providers** (`core/src/agents/`) drive the vendors' own CLIs headlessly, on your
subscriptions:

| Adapter | CLI and stream |
|---|---|
| `claude-cli` | Claude Code, `stream-json` |
| `codex-cli` | `codex exec --json` |
| `claude-cli` (again) | Grok Build: a Messages-format stream, parsed by the same code as Claude's |

They run their own loop and tools. Polyphemus keeps the canonical transcript and stores each
CLI's native session id so it can resume that session.

- **Joining mid-conversation:** when a CLI joins or rejoins, it's handed the turns it missed.
- **Handing back to an API model:** turns a CLI ran are rewritten as text, because its tools
  aren't Polyphemus tools.
- **Errors** are classified (e.g. `quota_exhausted`), and rate-limit windows are read from each
  CLI (Claude's `rate_limit_event`, Codex's session log).

Adapter details worth knowing:

- **Anthropic:** adaptive thinking with summarized display, automatic prompt caching
  (top-level `cache_control`), and server-side refusal fallbacks (`fallbacks: "default"`) on
  Opus 5 / Fable 5.1. Legacy models (Haiku 4.5 and older) run without thinking.
- **OpenAI Responses:** `store: false` plus `include: ["reasoning.encrypted_content"]`, so
  nothing is kept server-side and reasoning still replays. `prompt_cache_key` is the session
  id. Reasoning summaries stream as thinking.
- **xAI:** same adapter. `reasoning_summary` and `prompt_cache_key` are off in the default
  config until they've been verified against the live API.

### Credentials (`core/src/auth/`)

Credentials are separate from providers: any provider can use any source.

| Source | Status |
|---|---|
| `api_key` from an env var | ✅ |
| `api_key` from `~/.polyphemus/credentials.json` (mode 0600, written by `poly login`) | ✅ |
| `oauth` (PKCE / device code, stored and refreshed) | planned: only where the provider permits third-party use |
| `cli` (the CLI owns its login; used by agent providers) | ✅ |

Subscription access (Claude Max, ChatGPT, SuperGrok) goes through each vendor's official CLI
as an agent provider. Polyphemus does not lift their OAuth tokens into its own API calls.

Keys live in the vault (`~/.polyphemus/vault.json`, encrypted, with its key in `vault.key`).
`credentials.json` is still read so older installs keep working, and `poly secrets migrate`
empties it. The broker, grants, and bindings that come next are in
[design/secrets.md](design/secrets.md).

### Tools (`core/src/tools/`)

`bash`, `read_file`, `write_file`, `edit_file`. Each tool has a JSON Schema spec, a
`mutates` flag, and a one-line `describe()` for display and approval prompts. Output is
capped at about 30k characters (the head and tail are kept).

**Permissions.** Mutating tools go through an `approve` callback that the client supplies.
The terminal asks `[y]es / [n]o / [a]lways`. `permissions.allow` in the config and `--yes`
skip the prompt.

### Loop (`core/src/loop.ts`)

`runTurn()` is an async generator. It sends the history to the provider, streams deltas,
runs any tool calls, and repeats until the model stops asking for tools. It emits
`PolyphemusEvent`s:

`text_delta` · `thinking_delta` · `tool_call_start` · `tool_start` · `tool_end` · `message` · `turn_done`

`message` fires for every message appended to history. That's the persistence hook. The loop
never mutates the caller's history. On abort it still closes every open tool call with a
result, so history stays valid for the next turn.

### Sessions (`core/src/session/store.ts`)

SQLite at `~/.polyphemus/sessions.db` through the built-in `node:sqlite`:

- `sessions(id, title, provider, model, cwd, created_at, updated_at, agent, archived_at)`
- `messages(session_id, seq, role, content, origin_provider, origin_model, native, created_at)`

IDs are 8 hex characters and can be referenced by prefix. The title defaults to the first
prompt. A thread can be renamed (its place in the list stays), archived (off every list, still
in search, back the moment it's used), deleted for good, and searched by title and by what was
said.

### Config (`~/.polyphemus/config.toml`)

Written with defaults on first run. It covers providers (adapter, base URL, auth), model
aliases (`claude`, `gpt`, `grok`) used by `/model`, and permissions. `POLYPHEMUS_HOME`
overrides the directory.

## Roadmap

**It lives in [design/roadmap.md](design/roadmap.md)** — one list, named rather than numbered, with
what's built, what's now and what's later. Every design doc's own build order holds detail, not order.

## Open questions

- xAI Responses API: verify tool calling, streaming reasoning, and whether
  `reasoning.summary` and `prompt_cache_key` are accepted. Then flip the config defaults.
- Which OAuth flows (if any) are permitted for third-party harnesses, per provider.
- GitHub rulesets on private repos under a personal account: confirm whether GitHub Pro is
  needed.

## Decisions log

- 2026-09-24: **An update can fail, but it can't leave Polyphemus broken.** Versions are installed
  beside each other and switched; the new one checks itself against a copy of the data first; the data
  is backed up; a service that doesn't come up has the old version and the data put back on its own.
  Data only ever adds, so going back a version is safe; a change that can't be read by an older
  version raises the data's generation. Built before the first release, because the version that runs
  an update is the old one ([design/upgrades.md](design/upgrades.md)).
- 2026-09-23: **The first release is a fresh 0.1.0, rehearsed first.** Its changelog is one line, not
  the history of how it was built. Anything that changes how Polyphemus is released is tried on the
  public stand-in (`polyphemus-rehearsal`, `scripts/rehearse.sh`) before the real package. Releasing is
  always a person's merge; publishing is by trusted publishing from the workflow, never a token.
- 2026-09-23: **Commits in the public repositories carry no AI co-author lines.** GitHub lists every
  `Co-Authored-By` as a contributor, and the contributors listed should be people and Polyphemus's
  own identities.
- 2026-09-21: **Install with the same doors on every computer.** macOS, Linux, and Windows each get
  an app download, a one-liner, npm, pnpm, and a from-source install. The apps and the one-liners
  install Node when it isn’t there, then the daemon, then open the web app. On Windows that
  includes a native daemon, which does not install WSL, and a WSL setup for the Linux daemon.
  Updates can follow a dev channel or a stable one. The phone stays the web app. (Built by the first
  release: the one-liners, npm and from source on macOS and Linux, and on Windows the one-liner that
  sets up WSL. The app downloads, a native Windows daemon and a dev channel are still to come.)

- 2026-09-21: **A DM stays a DM.** Saying yes when an agent asks to bring another into a conversation
  that is one agent outside every project used to add them to it, and the DM became a group. It now
  starts a new thread with both agents, linked back, and the conversation you were in is unchanged.
  In a project, saying yes still brings them into the thread. Naming someone yourself with an
  @mention still brings them into the thread you’re in.

- 2026-09-20: **What a turn cost is that turn's, and a number nobody can work out isn't shown.** A
  vendor CLI's `total_cost_usd` is its running total for the native session, not the turn's cost;
  Polyphemus stored it as the turn's, so a resumed session's cost landed again on every turn. Checked
  against the CLI rather than inferred: a second turn of six tokens reported the first turn's total
  plus its own. The turn now records the difference from the last one in that native session, and
  the whole figure when the session is new (a smaller number than last time means a fresh session,
  so it's taken as-is). The rows already written can't be undone — what each turn of a resumed
  session cost isn't recoverable from a running total once the native session ids are gone — so
  they're marked `cost_running_total`, left out of every sum, and counted out loud in the app
  instead of quietly missing. Reported by an agent reading its own transcripts; the direction was
  confirmed here, the ten-fold figure it gave wasn't reproducible from the store alone.

- 2026-09-20: **Proving who may call a route doesn't prove what the answer may contain.** The review
  of the app and the daemon's surface went through the bodies, which
  `packages/daemon/test/access-matrix.test.ts` never looks at, and found this computer's folders in
  them: the projects folder went to everyone paired, including someone with no role at all, and a
  project's path and its threads' folders went to anyone who could see the project. Where something
  is on disk now goes to whoever can work there (`canWorkInProject`, `canWorkInSession`); a viewer
  gets the work without the machine's layout. The test that keeps it is in `access.test.ts` and
  checks the whole answer for the host's path, not one field — which is how the session rows in
  `/api/state`, missed in the first fix, were caught.

- 2026-09-20: **A secret inside a record is a secret.** The review of connections found the masking
  that keeps credentials out of what a model sees working on whole stored values: a sign-in or a
  linked bank is kept as one JSON record, and what a service hands back is a token from inside it,
  which matched nothing and went through. The redactor now takes every string inside a stored record
  too, above the length where masking would eat ordinary words. From the same pass: taking a
  connection away stops the server Polyphemus started for it, which kept running with the credential
  and a line to the service (the roadmap names this as a launch requirement — a connection left open
  after revocation); the MCP config Polyphemus hands Claude Code goes in a file only the owner can read
  rather than on a command line, because the connections gateway's token is in it and a process's
  arguments are readable by anyone on the machine; a server's answer is bounded in size and in pages
  of tools; and the credential-store guard knows the stores a developer's machine actually has.
  Weighed and left as it is: a tool call that fails with 401 still marks its connection as needing a
  sign-in, which is how a stale credential shows up and is what puts it in Waiting on you — a server
  can spend a refresh of its own connection by saying "403" about something else, and that's the
  cheaper mistake.

- 2026-09-20: **What a run ships is what the person approved — the branch as well as the commit.**
  The review of the workflow engine found the merge re-verifying everything the gate had promised
  except where it lands: the question says "into main", and a pull request's base can be changed on
  GitHub afterwards. The merge now refuses a base that isn't the one approved, and the `pr` node
  adopts only a pull request going to the same base. With it, from the same pass: a run's folder is
  cloned through git's own transport, because a local clone copies `objects/info/alternates` and a
  project's `.git` is its agents' to write — so another repository's objects could be committed in a
  run and pushed out as Polyphemus; the pictures that become a merge's evidence are taken on the port
  Polyphemus handed the command, not the address the command prints; a review whose author GitHub no
  longer names isn't "someone other than the author"; and one issue means one run, because the
  branch and the folder are named after the issue alone. Said plainly rather than fixed: `SAFE_GIT`
  doesn't stop a `filter.*.clean` a repository's own `.gitattributes` names — git has no switch for
  it — so on this computer that program runs as you, and worker isolation, not that list, is the
  answer.

- 2026-09-20: **A list that decides whether to ask says what's allowed, not what isn't.** The fourth
  independent review (the third pass's report, delivered after it was interrupted) found ripgrep's
  `--hostname-bin` running a program with no question asked: the read-only check named `--pre` as the
  one option that does. Named the other way round — ripgrep's own options, minus the four that run
  something — an option a later version adds asks instead of slipping through. The same pass's other
  live findings, both in Polyphemus's own home: an agent in your library is written from `~/.polyphemus`, so
  a link left in its folder is replaced rather than written through (a project's agents already
  worked this way), and anything that isn't a plain file is skipped rather than read — `readFileSync`
  on a pipe never returns, and agents and skills are read whenever a thread starts, so one left there
  stopped Polyphemus rather than one request. Reads in Polyphemus's own home still follow a link, because
  those folders are the owner's to arrange; writes don't.

- 2026-09-20: **What a vendor CLI has seen is a position in the thread, not in a runtime's array.**
  A CLI keeps its own session, and Polyphemus passes it whatever it missed since its last turn. That was
  counted as a length of the runtime's own copy of the conversation — which holds only what that
  runtime has read, so once two agents worked in one thread, anything written alongside a CLI's turn
  was never passed on. It's now a position in the thread as it's stored (append-only, so it means the
  same after a restart): from where a turn began, through everything that turn wrote, stopping at the
  first message another agent put in between. Alongside it, the same review's other findings: a
  thread holds a bounded number of messages waiting (50, and 20 from any one person) rather than
  growing without end, the flow of a thread is drawn from a remembered answer while nothing in it has
  changed, and the folders retried runs set aside are swept — the newest for each branch kept for a
  week, the rest removed without following a link out.

- 2026-09-19: **A turn belongs to an agent, not to a thread.** A thread had one runtime and one turn
  at a time, so talking to a second agent while the first worked meant waiting or another thread. An
  agent addressed while someone else is working now answers alongside, with a runtime of its own
  opened on the thread as it stands; each working agent is stopped on its own. A message to an agent
  that *is* working is still held (the queue), and an agent answering alongside doesn't hand the
  thread on — hand-offs and the guard belong to the thread's own line of work
  ([design/parallel-agents.md](design/parallel-agents.md)).

- 2026-09-19: **What an agent can write is untrusted input to Polyphemus on this computer.** An
  independent review found host-side readers and writers following links an isolated agent could
  plant: a project's AGENTS.md, notes, skills, agents and routines, attachments and an agent's
  computer's files. They now go through `core/src/contained.ts`: every path is walked from a root the
  agent can't replace (the project, the memory folder a worker is given, the computer's home), one
  folder at a time, never following a link — on Linux through held folders (/proc/self/fd), so a
  link swapped in mid-walk can't redirect it; on macOS by lstat at each step, which a swap can still
  race. A second pass that day caught the first version trusting swappable subfolders as roots. The same review settled that a project's routines run unattended only as
  a person accepted them (by a digest of the file; yolo ones by the owner), that a thread takes only
  library agents and its own project's, and that evidence Polyphemus can't read (a merge's reviews and
  checks) stops the action instead of reading as "nothing wrong". Accepting a routine names the digest
  of the version that was read. Codex, which never asks before acting, is labelled "Doesn't ask"
  rather than "Asks first".

- 2026-09-17: **What a bank was consented for is part of the connection, and is said out loud.** Plaid
  answers only for the products consented when a bank was linked, and Polyphemus asked for transactions
  alone — so the investments and bills tools had nothing to read and reported "no investment accounts",
  which an agent passes on as "you have no 401k". Linking now consents investments and liabilities as
  well (billed only when used), falling back when the Plaid app isn't approved for them; each bank
  records what it covers and can be widened in Plaid's update mode; and a bank that couldn't be asked
  is reported as that, named, with the one person who can fix it.

- 2026-09-17: **A connection can go to an agent, not only to a project.** A grant with no project is
  one the agent *carries*: it holds wherever that agent works, including a thread in no project at
  all, which is what a direct thread with an agent is. Its only bound is the ceiling — the person
  deciding what one agent of theirs may do doesn't need a project to say it in. Inside a project the
  agent has what the project grants plus what it carries, and an agent's grant *within* a project is
  unchanged: it can only narrow that project's. Before this, every connection needed a project, so a
  DM with an agent could reach nothing outside Polyphemus however it was granted.

- 2026-09-17: **Hosting is two shapes, not one.** A *shared install* — you and a few collaborators, a
  VM you own, a tunnel on the same box to `127.0.0.1` and an identity-aware proxy in front — needs
  nothing new in the code: the daemon already honours `x-forwarded-proto`, the same-origin check
  compares Origin to Host rather than requiring a tailnet address, and `access.ts` already enforces
  owner/member/viewer per project centrally. A *company server* — joining, leaving, budgets, audit —
  needs server mode, SSO and the rest, and lands with multiplayer at 1.0. Personal subscriptions never
  serve other people's turns in either shape; that is a licensing line, not an engineering one
  ([design/hosting.md](design/hosting.md)).

- 2026-09-12: An agent keeps the model it was made with; `model = "default"` follows the default on
  purpose. The one-time pin of agents that had none is recorded in config history by name, file and
  model, and waits while config.toml has an unrecorded edit so it can't adopt one silently.

- 2026-09-12: The direction, from the owner's answers to the independent assessment: an open-source
  alternative to OpenClaw with a Grok Bot–like experience and any provider (bring your own tokens);
  general-purpose; all four Grok Bot pillars; plugins/MCP core; **multiplayer required at launch**;
  permissions at agent, thread and project scope. The roadmap was reordered around it: close the
  confirmed holes now, then identity, the UI round, durable work, grants, workflows, and isolation
  plus multiplayer as the launch bar. See [design/roadmap.md](design/roadmap.md).
- 2026-09-12: The credential guard and read-only shell check are **exposure reduction, not a
  boundary**, and the docs say so until worker isolation ships. "Always" approves one exact action.

- 2026-09-12: Models & providers, from the owner's mockup: model health from real turns, real tests that
  state their cost first, moving a model between connections everywhere it's named, one Remove, and
  `routing.allow_metered` off by default so a fallback never starts a per-token bill unasked.
  Detail in [design/routing.md](design/routing.md#looking-after-your-models-decided-2026-09-12).

- 2026-09-12: Managing threads. **Archive is reversible by use:** sending an archived thread a
  message brings it back, because archiving means "done with it" and it evidently isn't; `-c`
  won't continue one. **Renaming isn't activity,** so it doesn't move a thread up the list.
  **Delete is for good** and refused mid-turn, as is archive; a vendor CLI's own transcript of the
  conversation belongs to that tool and stays. **Search reads titles and what people and models
  said,** not tool output, which would bury the thread you meant under every file it touched.

- 2026-09-11: Polyphemus is built to be installed by anyone, standalone: a public repo on GitHub and
  an npm package, set up either from source or with npm. So nothing may assume this machine — every
  path comes from `POLYPHEMUS_HOME`, `projects_root`, or the config; the vault, its key, and the
  daemon's token are per-user and made on first run; and Polyphemus never reads another tool's
  credential stores. A checkout lives wherever other projects do, never inside another tool's folder.

- 2026-09-11: The vault ships as a local encrypted file: AES-256-GCM per secret, sealed to its
  name, with the key in `~/.polyphemus/vault.key` (0600). It needs no account and no purchase, and
  it works unattended when the service starts at boot. 1Password becomes a second backend behind
  the same interface once the plan is confirmed. This supersedes the 2026-09-10 decision below.
- 2026-09-10: 1Password service accounts are the vault; an `age` file is the offline fallback.
- 2026-09-10: Expo (mobile and web) plus Electron (desktop) replace Tauri 2. (Superseded: the app is
  a web app the daemon serves.)
- 2026-09-10: Phase 2 goes subscription-first: the setups it learned from ran on Claude Code, Codex
  and Grok subscriptions, not API keys.
- 2026-09-10: What earlier workflow setups taught is folded into [design/workflows.md](design/workflows.md).
- 2026-09-16: What Polyphemus is for, read against the field: trust, evidence and permissions that hold —
  not another open Grok Bot. Native apps, voice and cloud desktops are not being chased
  ([design/landscape.md](design/landscape.md)).
- 2026-09-11: Projects are first-class ([design/projects.md](design/projects.md)). Code lives in
  `~/projects` (configurable) or wherever it already is, not in `~/.polyphemus`: resetting Polyphemus
  must never touch your work.
- 2026-09-11: No `CLAUDE.md` in projects; Polyphemus hands `AGENTS.md` to the Claude Code sessions it
  runs, so a project's setup doesn't change Claude Code run by hand (including the one building
  Polyphemus).
- 2026-09-11: The service runs its own tested copy of the latest commit (`~/.polyphemus/releases/`),
  updated with `poly service update`, never the working copy: restarts used to put
  half-finished edits live and cut off running sessions.
- 2026-09-17: Craft, skills and personality travel with the agent, the way they would with a person:
  what an agent learned about its work in one project comes with it into the next, and into a new
  thread with anyone. That's the point of it being an agent rather than a project's notes. The room
  rule still holds for everything about people.
- 2026-09-17: What an agent remembers is scoped by the room it was learned in, not by the agent: a
  memory can only be recalled where everyone present was already there. What you tell an agent alone
  stays in your own threads with it; what it learns about its work ("craft") travels anywhere but must
  be about nobody; a project's memory stays the project's. Agents propose, people accept, and accepting
  is what picks the scope ([design/memory.md](design/memory.md)).
- 2026-09-16: Isolated workers never get a network. Granted hosts are reached through Polyphemus's proxy
  over a Unix socket only that worker mounts, so the socket is the worker's identity, workers can't
  reach each other, and no Docker address pools are used per project. The proxy refuses private,
  loopback, tailnet and metadata addresses even for a granted name
  ([design/isolation.md](design/isolation.md)). "Isolated, open network" goes through the same proxy.
- 2026-09-16: SuperGrok's plan usage is read from xAI's billing endpoint with the Grok CLI's own
  sign-in — the one, read-only exception to never using a subscription's tokens outside its CLI
  (AGENTS.md). The Grok CLI reports no plan usage, and without it a stale quota error hid 98% left.
- 2026-09-16: A message that names no agent gets no answer, unless it's one agent and one person or
  the thread says agents answer everything ([design/agents.md](design/agents.md#inside-a-thread)).
  Replaces "the lead takes it": with people and agents together, most untagged lines are for people.
- 2026-09-16: Browser sign-ins are kept cookies, not passwords: a person signs in by hand in a live
  view (a picture of the page, tapped and typed into), Polyphemus keeps the cookies the site set, and
  agents' browsers start with them. A sign-in is its owner's to place, and it's held back wherever
  anyone besides its owner has a role in the project — the personal-credential trap in
  [design/secrets.md](design/secrets.md#multiplayer-whose-secret-whose-bot), enforced where the call
  happens. The install owner isn't counted: they can read the vault on their own computer anyway.
- 2026-09-12: Connections to outside services are MCP servers that Polyphemus alone talks to. Agent
  CLIs get a gateway MCP server with no credentials; grants are checked at Polyphemus's call layer on
  every call, because most credentials can't be confirmed limited (settled brief §5).
