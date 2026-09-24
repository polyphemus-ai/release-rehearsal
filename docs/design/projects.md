# Projects

A project is the unit everything else hangs off: sessions, memory, accounts, routines, models,
and production rules. Before this, a "project" was just whatever folder a session started in.

## What a project is

**A folder Polyphemus knows about, plus the context agents need to work in it.** The context lives
in two places, split by who should see it:

```
~/projects/gamenight/            ← the files: a repo (new, cloned, or one you had), or just a folder
  AGENTS.md                         what this is; how the work is done; the ground rules
  .polyphemus/
    project.toml                    name, description; later: model, fallbacks, mode, production rules
    bindings.toml                   which AWS and GitHub accounts it uses (see secrets.md)
    routines/  workflows/           scheduled jobs; plan/execute/verify pipelines

~/.polyphemus/memory/projects/gamenight/   ← private, never pushed with the code
  handoff.md                        where things stand, what's next, what's blocked
  notes/                            facts and decisions, with the why (see memory.md)
```

- **The name you see can change.** Setup, or `poly projects rename`. The short name, the folder,
  and the address stay, so links and grants keep working.
- **Not only code** (decided 2026-09-11). A project is a folder of work: a repo, or a client's
  documents, or a job that lives in someone else's system and needs somewhere to keep its notes.
  Almost nothing in the project layer ever asked which — roster, routes, memory, handoff,
  approvals and receipts don't care. Four places did, and they stop: Polyphemus no longer runs
  `git init` on every new project (`--from` still clones, `--git` still initialises, and
  `poly projects add` never touched git); `AGENTS.md` scaffolds `## Commands` only when the
  folder it's written into looks like code, and otherwise asks what the work is and how it's
  organised; the session briefing says *files*, not *code*, and *folder*, not *repository*; and
  orientation reads what's actually there instead of hunting for package manifests and CI config.
- **The folder holds what's safe to commit.** `AGENTS.md` is the cross-vendor standard: Codex,
  Copilot, and Cursor read it natively. Claude Code reads `CLAUDE.md` instead, so Polyphemus hands
  it the project's `AGENTS.md` itself in the sessions Polyphemus runs.
- **No `CLAUDE.md` is written** (decided 2026-09-11). Polyphemus first wrote a one-line
  `CLAUDE.md` importing `AGENTS.md`, which meant accepting a project's rules also changed Claude
  Code run by hand in that folder, including the Claude Code building polyphemus. A project's
  setup should change Polyphemus's agents, not your other tools. Add your own `CLAUDE.md` if you
  want Claude Code outside Polyphemus to follow the same rules.
- **Memory stays private.** It holds accounts, half-formed ideas, and your preferences, none of
  which belong in a repo you might open-source.
- **Nothing is ever overwritten.** Adding a folder that already has an `AGENTS.md` or
  `CLAUDE.md` keeps them; Polyphemus only fills in what's missing.

## Where the code lives: `~/projects`, not `~/.polyphemus`

Decided 2026-09-11. The rule: **if losing it would lose your work, it doesn't go in `~/.polyphemus`.**

- Resetting a tool usually means deleting its folder. Code inside `~/.polyphemus` would go with it.
- Dot-folders are hidden in file pickers, editors' Open Folder dialogs, and some backups. Your
  repos should be one click away in VS Code, Cursor, Claude Code, Codex, or plain git.
- Other people already keep repos in `~/code`, `~/src`, or `C:\Users\…\source\repos`. Polyphemus
  points at projects wherever they are; it never requires moving them.

`~/.polyphemus` holds Polyphemus's own state: config, the session database, logins, logs, and memory
(its own git repo, which you can push to a private remote for backup). Throwaway copies that
Polyphemus makes for parallel agents (git worktrees, one per task) are polyphemus-owned and
disposable, so those go in `~/.polyphemus/worktrees/`.

New projects go in `projects_root` (config; default `~/projects`).

## Creating a project

From the app (**+ New project…** in the project picker) or the terminal:

```
poly projects new "Side Quest" --about "A tiny arcade game for grandparents"
poly projects new side-quest --from https://github.com/you/side-quest
poly projects add ~/code/existing-thing          # a folder you already have
poly projects park | archive | activate <project>
```

Polyphemus creates the folder, writes the files above, creates the memory folder, and registers
it. A new project is a plain folder: `--from` clones a repo, `--git` initialises one, and
neither is assumed — adding git to a folder later is one command, and a repo nobody asked for
is clutter in every project that isn't code.

**Status:** active projects show everywhere. Parked projects keep their sessions but don't load
or show up in pickers (OpenClaw kept a parked project listed as "active focus"). Archived ones
are done.

## Sessions belong to projects

A session belongs to the registered project whose folder contains its working folder (the
deepest one, if they nest), so a terminal session in `~/projects/side-quest/src` is in Side
Quest with nothing to set up. The app groups sessions by project.

## What an agent gets (step 2)

When an agent works in a project it gets a fixed-budget orientation packet (memory.md §4): your
rules, the project's `AGENTS.md`, its memory index, the handoff, the accounts it may use (names,
never secrets), and a capacity line. Nothing from other projects: that's the fix for Acme and
Game Night context leaking into Ledger sessions.

**Orientation session** (`poly projects orient`, or **Set up** in the app while `AGENTS.md`
is still the template): an agent reads what's there — the repository for a code project, the
folder and its documents otherwise — and writes a proposed `AGENTS.md` and 3 to 8
notes into the project's **inbox** (`~/.polyphemus/memory/projects/<slug>/inbox/`), and rewrites
the handoff. Nothing in the repo changes.

**The inbox is how rules and notes change.** Agents never write notes or rules directly; they
propose into the inbox, and you keep or discard each one (`poly projects review`, or
**Review** in the app). A kept `AGENTS.md` replaces the project's; a kept note moves into
`notes/` and joins the index every session sees. Agents may rewrite the handoff directly: it's
a status board, not a rule.

The packet is captured once when a session opens, so the system prompt stays identical from
turn to turn (the prompt cache keeps working) even as the handoff is rewritten mid-session.
Claude Code and Codex get `--add-dir` for the memory folder so they can write the handoff and
proposals; Grok Build has no equivalent yet, so it asks.

## Production projects (step 3)

`project.toml` will carry rules that Polyphemus enforces, not just documents:

```toml
production = true    # no YOLO; pause instead of falling back to a weaker model (the #808 lesson);
                     # agents work on branches, never push to main
model = "claude"
fallback = ["codex"]
```

## Build order

| Step | What | Status |
|---|---|---|
| 1 | Registry, `poly projects`, New project in the app, sessions grouped by project, scaffold files | ✅ |
| 2 | Orientation session drafts `AGENTS.md`; memory folder and handoff loaded into sessions; review inbox | ✅ |
| 3 | `project.toml` settings applied: model, fallbacks, mode, production rules | |
| 4 | Bindings and login cards (secrets.md) | |
