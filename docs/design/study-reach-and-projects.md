# To study: what agents can reach, and moving work into projects

**Status: open questions, not decided.** Written 2026-09-19 from a conversation with the owner while
agents were making promotional videos for Polyphemus in a Direct thread. The goal behind it: agents as
aware as they can safely be, so a person isn't stuck in the middle of every hand-off.

## How it works today

Two different things decide what an agent knows, and they're easy to mix up.

### What Polyphemus gives an agent: the memory rules ([memory.md](memory.md))

Every turn, Polyphemus hands an agent some of what it remembers. A memory only comes back in a room no
more open than the one it was learned in:

| Memory | What it is | Where it comes back |
|---|---|---|
| Private | What a person told this agent in their own threads with it | Only there — never where anyone else is |
| Craft | What the agent learned about doing its work, and about nobody | Any thread with that agent, in any project |
| Project | The project's notes, handoff and AGENTS.md | Any thread in that project, for every agent in it |

Agents propose memories; a person accepts, and accepting decides the scope. No agent is handed
another agent's private or craft memory. What agents share is a **project**: its notes and handoff
are how work carries from one thread, or one agent, to the next. A thread in Direct is in no
project, so it gets no project memory — only each agent's craft, and what's said in the thread.

### What an agent can go and get: the isolation level ([isolation.md](isolation.md))

- **On this computer:** an agent's commands run as the person. It can read any folder, every other
  project included; use the `polyphemus` CLI, including `poly sessions show` on any thread; and read
  `~/.polyphemus/memory`. Only credential files are held back, by a guard that isn't a boundary. The
  memory rules then decide what Polyphemus *offers* an agent, not what it can go and look at.
- **Isolated:** a Direct thread's worker has only the Direct folder; a project thread's has only
  that project and its memory. No other projects, no other threads, not Polyphemus itself.

## What came up

- Work that runs across several threads and agents (the promo videos with Reel, Herald and Helm)
  wants a project: a shared handoff and notes, and an AGENTS.md all of them follow.
- That work needs to *read* Polyphemus's own docs and code to get claims right, and must never change
  them. On this computer the only thing stopping an edit is a rule in AGENTS.md (on 2026-09-19 Helm
  edited Polyphemus's source from a Direct thread). Isolated, the agents can't read Polyphemus at all.

## Ideas to study

1. **Move a thread into a project** (and out of one, and between projects). What changes: who can
   see its whole history (the project's people gain it; people in a Direct conversation who aren't
   in the project lose it); which agents can stay (library agents and the project's own); what
   agents are handed from the next turn (project memory, grants, isolation level); attachments,
   which live in the old folder and would need copying; the vendor CLIs' own sessions, which are
   tied to the folder and would start over with the history handed in. Not while it's working or
   has a run; the owner, or a member moving their own thread with nobody else in it. A confirmation
   that names who gains and who loses it.
2. **Reference folders:** a project can add another folder read-only — its worker mounts it
   read-only, and Polyphemus's own readers treat it as outside the project. The promo project could
   read Polyphemus's docs and code and never change them, isolated.
3. **Say it in the app:** what an agent in a thread can reach, in plain words, next to the isolation
   level — so "can it see my other projects?" has an answer on screen.
