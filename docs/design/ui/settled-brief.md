# Polyphemus UI: the settled brief

One file. Supersedes two earlier rounds of additions to the brief — everything in both is folded in
here, and where they disagreed with each other or with the four settlements of 12 Sep, this file wins.

Paste it after the original brief and the addendum. These are decisions, not options. If one turns
out to be wrong in code, stop and say so rather than substituting a different structure.

---

## 1. Vocabulary

These words mean one thing each, in the interface and in the code. Nothing else may mean them.

| Word | Meaning |
|---|---|
| Thread | The only conversation noun. Has zero or more agents, zero or more people, and a project or nothing. |
| Outcome | What a thread is trying to achieve. A thread has zero or one. A thread with one is a *work item*. |
| Run | One attempt at an outcome. Has steps. The only new noun in the data model. |
| Step | One unit of a run. Its transcript is a thread. |
| Evidence | An artifact a step produced. Either carries a receipt or is local. |
| Receipt | An acknowledgement from outside Polyphemus: a response id, a commit sha, a message id. |
| Gate | A step that needs a person before the run continues. |
| Kept | A thread you keep around. Never auto-hidden. |
| Finished | A thread that ended. Still openable; leaves Home after 7 days. |
| Paused | Stopped on its own and needs a person. |
| Routine | A schedule that starts threads. A *firing* is one occurrence. |
| Lead | The agent that routes work in a multi-agent thread. |
| Guard | The limit on agent-to-agent exchanges before Polyphemus asks a person to continue. |
| Waiting on you | The one label for anything blocked on a human. |
| **Provider** | Whose models you can run: Anthropic, OpenAI, xAI. |
| **Way in** | How Polyphemus reaches a provider: Claude Code CLI, an API key. Providers are *signed in to*. |
| **Connection** | An account at an outside service: HubSpot, GitHub, Postgres, Gmail. Services are *connected*. |
| Ceiling | The most a credential permits. Nothing may exceed it. |
| Grant | A subset of a ceiling, given to a project or an agent. |
| Claim | One person taking responsibility for an item in Waiting on you. |

Never use: task, ticket, job, session (in navigation), channel, permission level. Never use
"connection" for a provider way in, or "provider" for an outside service.

Verbs follow the split. Providers: **sign in · test · sign in again · remove**. Services:
**connect · test · reconnect · disconnect**. The two never borrow each other's verbs, even though
they share a card component.

## 2. Navigation

**Home · Projects · Team · Setup.**

- **Home** — one recency-ordered list of everything, permission-filtered, Waiting on you on top.
  Canonical. A project's list and an agent's list are this list with a filter, from the same
  endpoint with the same ordering. If the same thread shows a different sub-line in two places,
  that's a bug with a test.
- **Projects** — a project holds its people, its work, its conversations, its connections and
  grants, its agents, routines, rules and memory.
- **Team** — agents and people in one directory, two sections. Agents are colleagues here, not
  configuration.
- **Setup** — you (usage, devices, notifications), connections, models & providers, workspace.

**Models & providers keeps three tabs: Models · Providers · Defaults & fallback.** The tab
formerly called Connections is Providers. This is settled and the existing screen should be
renamed as part of phase 3.

**Added 2026-09-13:** Home may be grouped by time, project or agent, a project scopes Home with a chip that says what it hides, the list never reorders under you, and a project page has Work and Setup tabs. The decisions are in [finding-your-way-decisions.md](finding-your-way-decisions.md), which adds to this section and §3.

## 3. Threads, and work above them

A **work item is a thread that has grown an outcome.** There is no work-item object above threads
and no separate discussion thread beneath one.

- A thread gains an outcome when a person accepts the offer, when an agent proposes one and it's
  accepted, or when a routine or workflow starts the thread. Never automatically from message
  count or length.
- It can lose one. Dropping the outcome keeps the transcript and the run history and returns the
  row to a chat row. The id and position never change.
- Sessions are never navigated. No screen's job is to list sessions.
- A thread's row shows three signals and no more: the mark says who (composed from members;
  agents get shapes, people get round faces with initials, and these never mix), one glyph says
  the state, the amber dot says it's on a person. Everything else is prose on the second line.
- A work item's row carries a factual status word and a step count where a chat's carries a last
  outcome in prose.

## 4. Status, and evidence

A status may only come from something that happened: a process exit, an HTTP response, a file that
exists, a webhook, a gate a person answered. An agent writing "deployed" sets nothing.

Allowed values and nothing else: `queued`, `running`, `waiting`, `retrying`, `failed`,
`interrupted`, `done`. Where the daemon cannot derive one, it is `unknown` with the reason — never
a cheerful default, never zero standing in for missing.

Every artifact records whether anything outside Polyphemus confirms it: **receipt** or **local**. A
step whose only job is to verify a previous step's claim is a normal, expected shape — build for it.

## 5. Connections, ceilings and grants

Connections get their own area, built from the same card component as provider ways in: an
account, its health, a test, and recent activity.

- A connection has an **owner** (a person) and a **ceiling**.
- A **grant** attaches a connection to a project or an agent with a subset of the ceiling.
  Scope narrows only: agent ⊆ project ⊆ ceiling. Widening must be impossible at the API, not
  merely absent from the UI.
- A grant to an agent with no project is one the agent **carries**: it holds wherever that agent
  works, a thread in no project included, bounded by the ceiling alone. In a project the agent has
  what the project grants plus what it carries; an agent's grant *within* a project still only
  narrows that project's.
- The interface shows where an inherited grant came from, in words.
- Activity lines name the work each call was part of, so "what did this account do and why" is one
  tap rather than a log file.
- Connection failures are items in Waiting on you, addressed to whoever can actually fix them.

**A ceiling has a provenance, and the UI always says which:**

| Provenance | Where it comes from | How it reads |
|---|---|---|
| Checked | The service told us — OAuth scopes, a token-scopes header, a capabilities endpoint. | "Checked with HubSpot when you signed in · 10 Sep". Record freshness and re-check on reconnect. |
| Declared | The connector definition, or the owner saying what they made the credential able to do. | "Read-only, declared by Sam". Name who declared it. |
| Unknown | A bare key, no probe available, nothing declared. | "Unknown — Polyphemus will hold itself to what you grant, but can't confirm the key is limited." |

Where the connector can probe for scopes, probe on save and on reconnect, and record when. Where
it can't, Polyphemus enforces the grant at its own call layer: it refuses to make calls outside the
grant. Say exactly that, and do not let the interface imply the credential itself is limited when
nobody has checked. The difference matters the day a key leaks.

## 6. Permissions

**Grant** ("may this happen at all") and **approval preference** ("should it interrupt me first")
are different things and never share a control.

- Grants live on the connection, the project and the agent.
- Ask/YOLO lives on the person, the thread and the project. It is per person: your preference
  never changes what happens in someone else's threads.
- Turning off asking never widens a grant. Say so, in those words, on the screen where someone
  turns it off.
- "What can this agent reach here, and why?" must be answerable on one screen, with the why naming
  the grant and its source.

## 7. People

**Owning the install is not a role.** It is whose computer this is.

- **Install owner** — the person the daemon runs for. Holds credentials, provider sign-ins,
  devices, and who exists. Sees every project, and the interface says so plainly rather than
  implying a privacy boundary the filesystem doesn't have.
- **Project roles: Member or Viewer**, per project. A member works, messages and approves within
  granted scope. A viewer reads, and cannot approve or send anything that causes an action.
- A person's effective ability is install status ∧ project role ∧ grants. Membership of one
  project grants nothing anywhere else.
- Keep the role enum extensible. A per-project admin who can invite and grant without owning the
  install is the obvious next one; don't build it until someone asks.
- Everything a person did stays attributed: started, answered, approved, denied, took over.
- **Waiting on you** is per-person. It shows only items the viewer can act on, shows who else can
  act, and shows who has claimed each one. Claiming is soft: another permitted person can take it
  over, and that is recorded. Resolving resolves once, for everyone, visibly, and survives a
  disconnect — the daemon is the source of truth and the client reconciles rather than resolving
  optimistically.
- With one person in the install, none of this chrome appears: no claiming, no attribution, no
  roles.

## 8. Rules that hold everywhere

- **Say what it costs before it happens.** Every card that asks for a decision states what the
  action does, what it spends, how long it has waited, and whether it can be undone.
- **Never silently spend money.** A fallback that moves from a subscription to per-token billing
  is a decision a person makes every time, unless they turned that on explicitly.
- **One glyph, one meaning.** The amber dot means "waiting on a person" everywhere and nothing
  else ever uses it.
- **Summaries by default, the work one tap away, always in the same place.**
- **A destructive action names its dependents before it runs** and offers the fix in the same
  dialog.
- **Phone parity.** No task may require the desktop detail pane.

## 9. Phases — commit at each boundary

Don't start a phase until the previous one builds, passes its tests, and renders correctly at
400px and 1200px in both themes.

1. **Identity and permission plumbing.** People, roles, attribution, permission-filtered queries.
   No new screens; existing screens gain "who did this".
2. **Home and the row.** One list, Waiting on you with claiming, marks and faces, state glyphs.
3. **Providers rename, then connections and grants.** Rename the Models & providers tab and its
   vocabulary first, as a small isolated change. Then the connections area, the grant model with a
   real ceiling check and its provenance, failures landing in Waiting on you.
4. **Outcomes and runs.** The outcome strip, run and step records, derived status, evidence with
   receipts, gates.
5. **Starting something.** The draft composer with `@`, draft chips, and the old form behind
   "more". Nothing persisted until send.
6. **Work-shaped surfaces.** Project page sections, agent reading view with grants, multi-agent
   threads (speaker attribution, inset agent-to-agent messages, lead, guard pause, spin-outs), and
   the desktop run pane.

## 10. Journeys to verify, with what passing looks like

1. **One approval waiting.** First thing on Home, states the command and its cost, three taps
   without scrolling. Allowing it clears the card and the row's dot in the same render, no reload.
2. **Two people, one approval.** Sam claims it; your device shows it claimed within a second and
   your buttons become "take it over". Sam approves; your card resolves without a reload. Repeat
   with your client offline during the approval: on reconnect it reconciles to resolved, not to a
   stale card.
3. **A permission boundary.** Sam, a member of one project, sees no thread from another — not on
   Home, not in search, not in a push notification. Verify at the API, not just the UI.
4. **A grant cannot widen.** Try, through the API, to grant an agent write access on a connection
   whose project grant is read-only. Refused, and the UI never offered it.
5. **A ceiling with no check.** Add a bare API key. The UI says the ceiling is declared or unknown,
   names who declared it, and never claims it was checked. Polyphemus still refuses calls outside the
   grant.
6. **YOLO is personal.** With YOLO on for you, a thread Sam starts with the same agent still asks
   Sam.
7. **A chat becomes work and back.** Accepting adds a status to the existing row without changing
   its id or position. Dropping the outcome restores the chat row and keeps the runs.
8. **A run fails on an expired connection.** The step is `failed` with the actual 401; the
   connection appears in Waiting on you addressed to its owner; re-running after signing in starts
   run 2 without losing run 1.
9. **A claimed status isn't a real one.** Make an agent assert it wrote records while the call
   failed. The step must not read `done`, and the verify step must catch it.
10. **Evidence survives a restart.** Restart the daemon mid-run: artifacts, receipts and step
    statuses are intact, and the run resumes or reports `interrupted` — never silently `running`.
11. **Start with @.** Typing `@bu` offers Builder; picking it fills the draft line with agent,
    inferred project and mode. Backing out creates nothing — verify no row and no database record.
12. **Tell a group thread from a DM in the list.** Two agents render a composed mark and a named
    speaker; one agent renders neither.
13. **Hit the guard.** The thread pauses, the card appears inline where it happened, Home shows it
    paused, and "continue and stop asking here" changes the limit for that thread only.
14. **Delete an agent with threads and a routine.** The confirmation lists both, says the threads
    survive without an agent and the routine stops, and afterwards the threads still open.
15. **Responsive and themed.** No horizontal scroll at 400px, tabs within thumb reach, the desktop
    detail pane closes and stays closed, both themes, visible keyboard focus,
    `prefers-reduced-motion` respected.

## 11. Don't break

- Thread, project, agent, model and connection identifiers; existing routes and deep links.
- The daemon's HTTP API shape, and `polyphemus` CLI commands and config files.
- Existing single-person installs: no migration step, no login, no visible roles.
- Saved credentials, enabled models, defaults and fallback preferences. Never expose a secret in
  UI output, logs or screenshots.
- Push payloads, except to narrow what triggers them to things waiting on a person.
- Light and dark themes, keyboard focus, reduced motion.

## 12. Hand back, per phase

What changed, what you verified and how, what you couldn't do, and screenshots of every screen the
phase touched at 400px and 1200px in both themes — including, from phase 1 onward, at least one
screen captured as a second person with narrower permissions. If you couldn't take real
screenshots, say so plainly instead of describing what they would show.
