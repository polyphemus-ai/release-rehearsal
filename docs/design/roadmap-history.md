# Roadmap history

**What was built, phase by phase, as it was recorded at the time** — moved here from
[roadmap.md](roadmap.md) on 2026-09-13, unchanged, so the roadmap can say what's true now. The "Now"
headings below were "now" when they were written. Original introduction:

**This file decides the order. The design docs decide the detail.** Before this there were two
numbering schemes — phases 1–8 in `DESIGN.md` and a build order in each design doc, some
matching and some not — and by 2026-09-11 they disagreed with each other and with what had
actually shipped. One list, named rather than numbered, so nothing is "phase 6" twice.

## What it's for

**An open-source alternative to OpenClaw, with an experience like Grok Bot, that lets you use any
provider or model: bring your own tokens.** The owner, 2026-09-12, to the independent assessment
(`.codex/assessment.md`, not committed). It replaces "Polyphemus is where you work with your agents"
(2026-09-11), which was right but narrower.

What that pins down, all confirmed by the owner in the same conversation:

- **General-purpose.** A project is any body of work. The owner's own heaviest use — autonomously
  building data-intensive SaaS, with Ledger as the example, from feedback and audits through
  deployment and ETLs — is the demanding test case, not the product's boundary.
- **All four of Grok Bot's pillars are the product:** persistent agents with personalities,
  proactive scheduled work, integrations that take actions, and an interface that organises it.
  None is optional; the order below is about dependencies.
- **Plugins and MCP servers are core**, because connectivity is how a general-purpose platform gets
  domain capabilities without putting every integration in its core.
- **Multiplayer is a launch requirement.** People, memberships and authorisation are part of what
  "done" means for a public release — not a later expansion.
- **Permissions at agent, thread and project scope.** The owner runs YOLO themselves; other people won't.
- **The OpenClaw complaint is legibility.** You should understand autonomous work without managing
  its sessions.

The test for anything we build: **can you see who's working, what they can reach, what changed,
what evidence there is, and what needs a decision — from your phone?**

## Where things stand

| Milestone | What it means | |
|---|---|---|
| **Terminal** | The loop, tools, sessions, and every provider: Claude/OpenAI/Grok APIs and the Claude Code, Codex and Grok CLIs on your subscriptions | ✅ |
| **Your phone** | The daemon, the web app, pairing, push, HTTPS over your tailnet, the background service that runs its own tested copy of a commit | ✅ |
| **Projects and agents** | Projects (any folder of work), orientation and the review inbox, project memory and handoffs, skills, the vault, routines, capacity forecasts, routing with fallback, agents as files | ✅ |
| **Getting a model from the phone** | Models & providers, real tests that say their price, first-run setup, fallback that won't start a per-token bill unasked; threads you can rename, archive, delete and search; several agents in a thread | ✅ |
| **Trust what's there** | The confirmed holes from the assessment | ✅ |
| **The settled UI brief** | Six phases, below: identity ✅, Home ✅, connections and grants ✅, outcomes and runs ✅, starting something ✅, work-shaped surfaces ✅ | ✅ |
| **Show and connect** | Artifacts in the thread; a connections catalogue (Notion, GitHub); Google Drive and Gmail | ✅ |
| **It does the work** | Workflows on top of runs: the engine, loop, ship-issue and spec, intake. The no-repository workflow and computer use come later | ✅ enough to publish |
| **Ready for other people** | Worker isolation, and the launch bar for multiplayer | |
| **Ready to publish** | Open source on npm: one versioned package, releases, update checks, macOS, and a repository with nothing private in it | **Now** (2026-09-13) |
| **It gets better at it** | Memory that consolidates, the steward, the store | |

## Now: trust what's there

The assessment (2026-09-12) found concrete holes, and each one was checked against the code before
it went on this list. They're small, need no product decisions, and everything after this assumes
them closed.

- ✅ **The read-only shell check let writes through.** `git remote add`, `sort -o`, `sed w`,
  `git -c core.sshCommand=…` and `git log --output=` all ran without asking. Now: sed passes only
  print and substitute scripts, git refuses `-c` and flags that write or run programs, `ls-remote`
  only against a named remote, and awk/sort/uniq/tree/date/hostname lose their writing forms.
- ✅ **The credential guard was easy to spell around.** `~/.codex/./auth.json`, `../`, relative
  paths from home, symlinks, and Polyphemus's own secrets under a custom `POLYPHEMUS_HOME` all slipped by;
  project `.env` files weren't covered. Globs or variables into a hidden home folder now always ask.
  The docs say what it is: a guard that reduces exposure, not isolation.
- ✅ **"Always" allowed the whole tool.** It now covers that exact command or file for the session.
- ✅ **A revoked device kept its event stream** until it disconnected on its own. Streams are tied
  to their device and closed within seconds of revocation, including from `poly devices revoke`.
- ✅ **The pairing cookie wasn't `Secure`** over HTTPS; **`~/.polyphemus` was group-writable** with
  `sessions.db` world-readable. Both fixed, and permissions are re-applied on every start.
- ✅ **Deploys only ran the tests.** `poly service update` now also gates on typecheck and the
  browser smoke check, which serves the daemon's real security headers and fails on a near-empty
  screen or an error toast — it couldn't see a CSP violation before.

Not in this step, on purpose: filtering vendor CLIs' environment (they need parts of it to sign
in — that belongs with isolation), and Ask mode meaning different things per CLI (a product
contract — that belongs with grants).

## Now: the settled UI brief

**[ui/settled-brief.md](ui/settled-brief.md) decides the structure; this section only orders it.**
It came back from the design round on 2026-09-12 and folds in both passes, with the mockups beside
it ([work and people](ui/mockup-work-and-people.html), [models and providers](ui/mockup-models-providers.html),
[first pass](ui/mockup-first-pass.html) for the screens the second didn't redraw, and a
a snapshot of the app before it, kept privately). Its vocabulary is binding in the
interface and the code: thread, outcome, run, step, evidence, receipt, gate; provider and *way in*
(signed in to) apart from *connection* (connected); install owner, and per-project member or viewer.

Each phase ends in a commit, with what changed, how it was verified, what couldn't be done, and
screenshots at 400px and 1200px in both themes — from phase 1 on, including one screen as a second
person with narrower permissions.

### Before phase 1: an agent keeps the model it was made with

From the Models & providers mockup ("changing the default doesn't move them"). A new agent gets the
current default written into its `agent.toml`; agents that had no model are pinned once, and that
change is written to config history naming every agent, its file and the model it got.
`model = "default"` is the escape hatch — that agent follows the default, on purpose.

### 1. Identity and permission plumbing ✅ (2026-09-12)

No new screens; existing ones gain "who did this" once there's more than one person.

- **Agents get stable, scope-aware ids.** Library agents keep their name as their id; a project's
  agent is `project/name`, so two projects' `reviewer`s stop colliding. A vendor CLI's native
  session is keyed by agent as well as thread and provider, with a fingerprint of the agent's
  instructions — which fixes Reviewer's instructions never reaching Codex after Builder spoke first.
- **People.** The install owner exists on every install, implicitly, and every existing device is
  theirs. Other people and their devices, per-project member or viewer roles, from the CLI for now.
- **Attribution:** who started a thread, who sent each message (a person, or which agent), who
  answered each approval.
- **Permission-filtered at the API, not the UI:** sessions, search, projects, agents, routines,
  events, push, uploads. A viewer can't send, start or approve.

### 2. Home and the row ✅ (2026-09-12)

One list, Waiting on you on top with claiming, marks and faces, state glyphs. **Durable approvals
land here**, not later: journey 2 (resolve once, reconcile after a disconnect) needs them in the
database, not in memory.

### 3. Providers rename, then connections and grants ✅ (2026-09-12)

The Models & providers tab becomes Providers and its words become *way in* and *sign in* — small and
isolated, first. Then the connections area, ceilings with their provenance (checked, declared,
unknown), grants that can only narrow, enforced at Polyphemus's call layer, failures in Waiting on you.
This is where plugins and MCP arrive, as connections with grants; a provider that needs code
becomes one kind of plugin (see *Open questions* for what we took from OpenClaw's packaging).

What was built:
- **A connection is an MCP server** (a command on this computer, or an https URL) with an owner,
  its credentials in the vault under `connection/<id>/…`, and what its server offers.
- **Polyphemus is always the client.** API models get granted tools as `<connection>__<tool>`; Claude
  Code (`--mcp-config`) and Codex (`-c mcp_servers…`, with Polyphemus doing the approving) reach them
  through `bin/connections-mcp.mjs`, which holds a socket and a token, never a credential. Grok
  Build can't take MCP servers headlessly yet: a thread there is told so, once.
- **Every call is checked at the moment it's made** — agent grant ∩ project grant ∩ ceiling — and
  recorded with its thread, agent and sender, including refusals. A grant that would widen is
  refused at the API (403), never trimmed.
- **Ceilings say how they're known:** checked (OAuth scopes a remote server reports), declared (by
  whom, when), or unknown, in the brief's words.
- **A refused credential or unreachable server** marks the connection failing with the actual
  error and the thread it came up in, lands in Waiting on you for the connection's owner, and
  pushes to their devices. Reconnect clears it.
- Setup (the You tab, renamed) → Connections; a connection's page; grant sheets that only offer
  what's being narrowed; "what it can reach, and why" on the project page and agent profile.

Not yet: OAuth sign-in for remote servers (a bearer token or header only), a per-project admin who
can grant, `poly connections` in the terminal.

### 4. Outcomes and runs ✅ (2026-09-12)

The outcome strip, run and step records, status derived only from what happened, evidence with
receipts, gates. **Work that survives lands here:** runs, steps and evidence persisted as they
happen; interrupted told apart from done after a restart; uncertain side effects marked for
reconciliation and never replayed; a draining daemon.

What was built:
- **An outcome on a thread** — set by a person from the thread's menu, or offered by an agent
  (`propose_outcome`) and accepted. It never moves or renames the thread; dropping it keeps the runs.
- **A run plans itself** (`plan_run`: work, think, verify and gate steps, checked before it's kept),
  then the daemon works it a turn per step. Claude Code and Codex get the run tools through the
  gateway; Grok Build can't yet, and the run says so.
- **Status only from what happened.** A work step is done when it has evidence Polyphemus checked —
  a file that exists, a commit in the repository, a call a service answered (a receipt); a failed
  call fails it with the real error whatever the agent says; with nothing checkable it's `unknown`.
  A verify step fails outright if what it checks isn't done, and otherwise needs a recorded check
  and something Polyphemus saw it read. A gate is `waiting` until a person allows it or sends it back.
- **Written as it happens.** Stopping the daemon — cleanly or not — leaves the step and run
  `interrupted`, never `running`, with the evidence intact. Run 2 starts fresh and keeps run 1.
- The strip, the run's steps with evidence and receipts, gates answered inside the run, a status
  word and "run 2 · step 3 of 4 · gate" on the row.

Not yet: resuming an interrupted run from its step (run N+1 starts over, told how the last went);
a step handed to a different agent; routines starting threads with outcomes; retries beyond model
fallback.

### 5. Starting something ✅ (2026-09-12)

The draft composer with `@`, draft chips, the old form behind "more". Nothing persisted until send.

What was built: + opens an empty thread with a composer. `@` offers agents (arrow keys, Enter or Tab,
or tap); picking one puts `@Name` in the message and fills the draft line — agent, project (the
agent's own, or where you last worked with it, said in words), Asks first/YOLO, and "more" for a
model or a second agent. The same `@` picker addresses a thread's agents. Journey 11 was driven in a
real browser: no request was sent and no database row was written until send.

Not yet: an image attached and then abandoned is still uploaded (the upload happens when it's picked).

### 6. Work-shaped surfaces ✅ (2026-09-12)

Project page sections, the agent reading view with its grants, multi-agent threads (speaker, inset
agent-to-agent messages, lead, the guard's pause, spin-outs), and the desktop run pane.

What was built:
- **Agents talk to agents.** When an agent's reply @mentions another agent in the thread, that
  agent goes next. A message that names nobody goes to the thread's **lead** (the first in, or who
  you made lead). The reply to a hand-off is inset under who it was for; a thread with several
  agents names its speaker, and the lead.
- **The guard** is code: after 6 agent-to-agent exchanges with no person in between (per thread:
  2, 12, or not at all), the thread pauses where it happened with what it has cost — Continue,
  Continue and stop asking here (this thread only), Stop. Home shows it paused; writing in the
  thread moves it on.
- **Spin-outs:** a new thread for part of one, same agents and project, linked both ways.
- **The thread header** is one line: who's in it and who leads, the project, where it came from,
  and only non-default settings ("YOLO — no approvals"). Model, mode, view and the guard are in ⋯.
- **Project page:** waiting on you, work, conversations, people, agents, routines, what it can
  reach, rules and memory.
- **An agent reads like a profile**, with Edit one tap away. Deleting one names its threads (they
  stay, without it) and routines (they stop, saying why); its folder goes to Polyphemus's trash.
  Routines can name an agent (`agent: bd`).
- **The desktop run pane:** at 1280px and wider, a work item's run sits beside the conversation;
  closing it is remembered on the device, and "Show the run" brings it back.
- Also: Enter sends (Shift+Enter or Alt+Enter for a new line; a touch keyboard keeps Enter for new
  lines), `@` offers connections as well as agents, and reduced motion is respected everywhere.

Not yet: `@team`; token budgets and quiet hours in the guard; the steward; people-to-people messages.

### Alongside, from the assessment

Permission modes as product contracts mapped per adapter (with phase 3); process-tree cancellation
and model switches queued for the next turn (with phase 4); versioned migrations and a state backup;
splitting `server.ts` and `app.js` as each phase touches them rather than as a cleanup of its own.

## Now: show and connect

Decided 2026-09-12, in this order. Each ends in a commit with what changed, how it was verified,
and screenshots at 400px and 1200px in both themes.

### 1. Artifacts in the thread ✅ (2026-09-12)

An agent that makes a chart, a page or a table should show it, not describe where the file is.

- A `show_artifact` tool for every agent — Polyphemus's own tools for API models, and the connections
  gateway for Claude Code and Codex — taking a file the agent wrote: HTML, SVG, PNG/JPEG, CSV, Markdown.
- Polyphemus copies it into the thread's own store (so it survives the file being changed or deleted)
  and draws it inline where it was shown: images and SVG as images, CSV as a table, Markdown as text,
  HTML in a sandboxed frame served with its own CSP — no scripts reaching Polyphemus, no cookies, no
  network — because an agent-written page is untrusted code.
- Open full size, download, and see which step made it. A run's step can count one as evidence (local).
- Visible to whoever can see the thread, and nobody else, like uploads.

Built: `show_artifact` for API models and, through the gateway, Claude Code and Codex (checked live
with Claude Code drawing an SVG chart). Polyphemus keeps its own copy; the thread draws images and SVG,
CSV as a table, Markdown as text, and HTML in a frame served with `sandbox allow-scripts` and no
network. Refused: credential stores, other file types, over 10 MB. Deleting a thread deletes them.
Also: whoever is answering now shows as their own mark, breathing, where the reply will land.

Not yet: an artifact's step link, and SVG/HTML thumbnails on Home.

### 2. A connections catalogue: Notion and GitHub first ✅ (2026-09-12)

Like the providers catalogue: pick a service, and what it needs is already filled in.

- **Notion** — its hosted MCP server (`mcp.notion.com/mcp`) signs in with OAuth and lets Polyphemus
  register itself: one tap, then sign in. (Checked 2026-09-12.)
- **GitHub** — its hosted server (`api.githubcopilot.com/mcp/`) takes a token, since GitHub doesn't
  let apps register themselves. The entry says which fine-grained token to make and with which
  repositories, and a classic token's scopes, reported by GitHub, make the ceiling *checked*.
- Entries carry a logo, what it's for, how it signs in, and suggested first grants (read-only).
- An MCP server you run yourself stays one "Other" away.

Built: + on Connections opens the catalogue. Notion is one tap to its sign-in; GitHub walks through
making a fine-grained token and takes it. Entries fill in the address and sign-in from the catalogue,
never from the request. Found on the way: sign-in's return address was built from the browser's Origin
header, which browsers omit under no-referrer — Notion refused the resulting http address; it now comes
from how the request actually arrived. Not yet: real logos (tiles use the brand colour and initial).
The catalogue screens first shipped without the app's half (`app.js` was left out of the commit, and the smoke check passed because the routes fell back to the old form); they went out with Google, and the smoke check now fails a screen that doesn't show what it's for.

### 3. Google: Drive, then Gmail ✅ (2026-09-12)

Google has no hosted MCP server that signs in this way, so this is its own piece of work.

- One guided setup for a Google Cloud OAuth client of your own (consent screen, test user), kept in
  the vault and shared by every Google connection.
- A local MCP server Polyphemus runs for Drive (read-only first), then Gmail (read-only first; sending
  behind a gate). Gmail's scopes are *restricted* in Google's terms: fine for your own account in
  testing, a verification process before anyone else's.

Built: a guided setup for your own Google client (the return address to register is shown, with a
copy button), Google sign-in with offline access and PKCE, and `bin/google-mcp.mjs` — Polyphemus's own
server for Drive (search, recent, read Docs as text and Sheets as CSV) and Gmail (search, read,
labels), read-only. The server is handed only a one-hour access token; Polyphemus refreshes it and
restarts the server, and a token Google refuses early is refreshed and the call tried once more.
Tested against a stand-in Google, not yet against a real account.

Not yet: sending mail or changing files (behind a gate), Calendar.

## Now: it does the work

Decided 2026-09-12: built in these phases, each ending in a commit with what changed, how it was
verified, what couldn't be done, and screenshots. [workflows.md](workflows.md) is the design; this
orders it.

1. ✅ **The engine** (2026-09-12). Workflows as code: a definition checked at load, with `agent`, `check`, `gate`,
   `action` and `loop` nodes, run on phase 4's runs. An agent node is a fresh session (its own
   thread, linked to the run) that finishes by submitting an artifact checked against a schema. A
   check runs commands and records the commit they ran against. Actions need a permit bound to the
   run's generation, so a stale worker can't act. Attempts per node, rounds per loop, and wall-clock
   and token budgets; the same failure twice in a row escalates to you. A restart resumes from the
   last completed node with the generation bumped.
2. ✅ **`loop`** (2026-09-12). "Keep going until this passes": a fresh session per round, state in files and git, an
   objective exit check, a hard cap. From the app and `poly loop`.
   Built: `packages/core/src/workflows` (definitions checked at load, shapes, checks with commit and
   working-tree fingerprints) and the engine in the daemon's run driver. Each agent attempt is its own
   thread, kept off Home and linked from its step; its instructions show as Polyphemus's. Stuck means the
   same failure *and* no change to the files, after the screenshots caught a silent check being called
   stuck while the work progressed. Checked live with Claude Code (a round, a submit through the
   gateway, a passing check). `poly loop "<goal>" --until "<command>"` and Start a workflow on a
   project page. Not yet: custom workflow files, token budgets per node, heartbeats for CLI jobs.
3. **`ship-issue` in a worktree.** Issue → plan with an executable contract → execute in its own
   worktree → objective checks at the head commit → review by a different provider → open the PR →
   gate the merge. Identities that can't merge their own work.
   *Built so far (2026-09-12):* GitHub identities of Polyphemus's own — Planner, Builder, Reviewer —
   each a GitHub App made with GitHub's manifest flow from the catalogue, installed on the
   repositories you pick, reached with hour-long installation tokens made from a key only the vault
   holds. Polyphemus's own GitHub server offers each role only its tools, has no merge tool, and refuses
   a review for a commit that isn't the head. An agent's own identity for a service replaces the
   project's. A token of yours stays available, labelled "acts as you".
   `ship-issue` (issue → plan → a gate before the plan's own proof commands first run → rounds
   of build, checks at the head commit, push and PR as Builder, review by another vendor's model
   posted by Reviewer at that commit → a merge gate → merge) and `spec` (the Planner writes only
   under the specs folder, checked; reviewed, merged by the Planner, and its issues filed after a
   gate). Each run has a worktree inside the project, excluded from its status, where commits
   carry the identity's name and `git push` goes nowhere: Polyphemus fetches and pushes itself, the
   token reaching git only through an askpass script, with your git config left out. Merging
   checks on GitHub that someone other than the author and the merger approved exactly the head
   commit, that nothing's failing or still running there, and passes that commit so GitHub
   refuses if the branch moved. Tested against a fake GitHub with real git over HTTP.
   *Since (2026-09-13):* ran end to end against real GitHub; inside a run's worktree an agent's
   shell can't push at all (every push is rewritten to nowhere, whatever credentials the computer
   has); one run per issue at a time; issues intake files can each be shipped in one tap.
   *Not yet:* taking open issues in as incoming.
4. ✅ **`intake` and the work inbox** (2026-09-13). Feedback, ideas, schedules and audit findings land in one inbox;
   a spec agent turns one into tickets; you approve each.
   Built without a new noun (settled brief §1, §3): something that comes in becomes a thread in its
   project holding the words as they came, with a card in Waiting on you — **Make work of it** or
   **Dismiss**. It comes in from the project page (Feedback · Idea · Finding), `poly intake`, or an
   agent's `propose_work` tool, so a routine running an audit files its findings the same way.
   Making work of it runs `intake`: where it goes (GitHub issues by the Planner when the project has a
   repository and a Planner identity, otherwise work items here), an agent shapes it read-only into
   pieces with how to tell each is done, a gate where you untick what you don't want, and filing —
   issues found by title aren't filed twice; a work item is its own thread with an outcome, not
   started. Gates can now carry choices. `ship-ticket` is `ship-issue`: "ticket" is a word the
   brief doesn't allow. *Not yet:* taking open GitHub issues in as incoming; starting `ship-issue`
   on what was filed; a routine setting that sends its output to incoming without an agent choosing
   to.
5. **A workflow with no repository.** One of the owner's that runs on connections and files — with data
   checks that don't trust an exit code. *Banked 2026-09-13* until a real, repeatable job is picked;
   candidates were a weekly report from Drive or Notion, inbox triage, and a data clean-up.
   `ship-issue` ran end to end on a real repository the same day (PR merged by the Builder, reviewed
   on another vendor, at the head commit).
6. **Browser and computer use** ([computer-use.md](computer-use.md)).
7. ~~**Turning OpenClaw off.**~~ *Dropped 2026-09-13:* the owner migrates their own projects; Polyphemus
   is tested in the real world by publishing it instead.

Workflows on top of phase 4's runs (node types, worktrees, budgets, stuck detection), `intake` and `ship-issue`,
the browser and computer-use executors. Exercised on two workflows, not one: The owner's SaaS delivery
(intake → triage → acceptance contract → plan → implement → verify → release → observe, with data
checks that don't trust an exit code) and at least one that has no repository at all. Intake takes
feedback, ideas, schedules and audit findings into the same work-item inbox. This is the milestone
that turns OpenClaw off.

Detail: [workflows.md](workflows.md), [computer-use.md](computer-use.md).

## Before launch: ready for other people

The public-release bar, not a later phase:

- **Worker isolation.** Workers get the files, environment variables and network they were granted,
  and nothing that controls Polyphemus — vault, daemon token, other people's connections. Vendor CLIs
  keep their own sign-in through a deliberately designed boundary. Until this ships, the guards are
  exposure reduction, and Polyphemus says so.
- **Multiplayer:** invitations, project membership, a small role set, deploy and data operations as
  separate capabilities, every read/write/stream/upload/approval/execution checked centrally, and
  release tests that prove a person can't read, answer or run what they shouldn't — including over
  an already-open connection after revocation.
- The trap still holds: a private credential granted to a shared agent leaks by proxy.
- Diagnostics you can read, onboarding from a fresh install to a finished task, and honest
  per-provider capability and data-destination labels.

Detail: [secrets.md](secrets.md#multiplayer-whose-secret-whose-bot).

## Now: ready to publish

Moved up 2026-09-13: publishing an open-source project comes before the owner's own migration, so
Polyphemus gets tested in the real world. It publishes as **0.x, clearly early**, with the security
model stated plainly (guards reduce exposure; worker isolation is still to come).

Order: **1** packaging (a build, one `polyphemus` package, installs from its tarball) · **2** versions
and releases (changesets, CI on Linux and macOS, publish with provenance) · **3** update checks and
`poly update` · **4** macOS (launchd) · **5** nothing private (scrub, leak guard, fresh repository)
· **6** the open-source files · then publish, once the decisions below are made.

*Built 2026-09-13, steps 1–6:* `pnpm build` makes one `polyphemus` package (a bundle plus each
package's own files, found the same way from a checkout or an install), and `pnpm pack:check`
installs its tarball into an empty folder and runs it. Changesets with one shared version; CI on
Linux and macOS; a release workflow publishing with provenance ([RELEASING.md](../RELEASING.md)).
An installed copy checks npm once a day and says so in Setup and the CLI; `poly update`. On macOS
the service is a launchd agent. The building install's names, clients, hosts, paths and email are
replaced with neutral examples; `scripts/leak-check.mjs` scans for secrets and a denylist kept outside
the repository, and `scripts/export-public.mjs` makes the public copy from the last commit, without
this history or the private notes, refusing on any hit. README, CONTRIBUTING, SECURITY; gitleaks in CI.
*Left before publishing:* the decisions below (brand, license, names); the npm organisation and
trusted publisher; the public repository; the first CI run on macOS, and the first release.

**Decided 2026-09-13:** license **Apache-2.0** (LICENSE and NOTICE added, in every package); a
**standalone brand**, not an existing one — its name still to choose.

**Decisions to make first**

- **Brand:** under the owner's existing brand, or standalone. It decides the npm org, the GitHub org
  and repository name, and the domain.
- **License:** MIT (simplest), Apache-2.0 (the same, plus patent protection — the recommendation),
  or AGPL (a modified version run as a service must be shared).
- **What's public:** the design docs, once scrubbed, probably yes; the research reports and the UI
  snapshot, which hold real data, probably not.
- **Names:** `polyphemus` was unclaimed on npm on 2026-09-13; the scope has to be checked when the org
  is made.

**Versioning and releases**

- Semantic versioning. **0.x until launch** (a minor bump may break things; a patch only fixes);
  **1.0.0 is the promise** that config and data stay compatible from then on.
- **One version, one package:** `polyphemus`, with core, daemon and CLI bundled into plain JavaScript
  by a build step — no `tsx` at runtime, and an allowlist of files in the package.
- **Changesets** for what each change is (patch, minor, major), the changelog, and the version bump;
  a git tag per release.
- **Published from CI**, not a laptop: GitHub Actions to npm with provenance. `latest` for releases,
  `next` for previews.
- **Upgrades from any earlier version keep working:** the database already migrates itself on start;
  releases get a test that opens an old install's data.

**Updates**

- The daemon asks npm for the latest version once a day — nothing about the install is sent, it's
  cached, and `updates.check = false` turns it off.
- Setup and the CLI say when there's a newer one, with its changelog; `poly update` installs it and
  restarts the service. `poly service update` stays as the path for building from a commit.

**Nothing private in the repository**

- Checked 2026-09-13: no real secret in the tracked files or anywhere in history (only test fakes and
  placeholders). But names, clients, hostnames, home-folder paths, an email address, agent and project
  names from the building install, and OpenClaw workspace details run through docs, tests, comments and
  mockups — and the commit author is on every commit.
- Replace them with neutral examples (Sam, Alex, Acme). Leave the research reports and the UI snapshot
  out.
- **Publish from a fresh repository with one initial commit**, not this history.
- **A leak guard on every build:** a secret scanner (gitleaks), a denylist of the building install's
  names, hosts and paths — kept outside the repository, since the list is itself what mustn't leak —
  and a check of what `npm pack` would publish.
- LICENSE, README, CONTRIBUTING, and SECURITY.md (how to report a vulnerability).

**Platforms**

- **Today it's Linux only in practice:** the background service is systemd, the shell tool and
  workflow checks use bash, and GitHub pushes go through an `sh` askpass script.
- **macOS at launch:** a launchd service instead of systemd, and macOS in the CI matrix. Moderate work.
- **Windows through WSL2 at launch**, native later: no bash by default, different signals and paths,
  and the vault's owner-only file permissions don't carry over — native needs Windows ACLs.

## Later: it gets better at it

The memory browser in the app, consolidation ("sleep"), the steward that reviews how the agents
worked together and proposes into the review inbox, and the store for agents and skills — with
review and pinned versions, because skills are instructions plus code.

**A workflow catalogue** (banked 2026-09-13). Today there are four built-in workflows and nothing
else. The catalogue grows in three steps, like connections did:
1. **Templates you configure** — more built-ins, each with its inputs asked for when you start it
   (a weekly report, inbox triage, a data clean-up), shown in Start a workflow by what they're for.
2. **Your own workflow files** — the TypeScript builder in [workflows.md](workflows.md#custom-workflows),
   loaded from `~/.polyphemus/workflows/` or a project, checked at load.
3. **Shared ones** — in the store, with review and pinned versions: a workflow is code that acts with
   your connections, so one from someone else is untrusted until reviewed.

Detail: [memory.md](memory.md), [agents.md](agents.md#templates-and-the-store).

## Open questions

**Work items or threads at the top?** Decided 2026-09-12 by the settled brief: a work item is a thread
that has grown an outcome. No object above threads.

**Providers as packages?** (2026-09-12) OpenClaw ships each provider as an npm plugin on its own
plugin API. We don't reuse theirs (it only runs inside OpenClaw) but read them for endpoints,
sign-in flows, pricing and quirks. Ours stay catalogue data while an OpenAI-compatible entry is
enough; a provider that needs code becomes one thing a Polyphemus plugin can contribute, with a
manifest readable without running it, and plugins treated as untrusted code — phase 3.

**Hosting for multiplayer.** Required at launch; whether that's everyone reaching one person's
daemon, a shared server, or something else isn't decided. It doesn't require hosted SaaS.

**Does the web app stay the app?** (open, 2026-09-11) The web app the daemon serves is the daily
driver: it installs, has push, and lays out on a desktop. Native would buy Live Activities, better
notifications, a wake word and store presence. Left open until something the web app can't do is
actually in the way.

**Is anything shared between a thread and its project's other threads?** A memory question, not a
threads question.
