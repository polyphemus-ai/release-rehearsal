# Polyphemus — read this first

Polyphemus is an open-source, multi-provider agent harness. One agent loop over Claude, OpenAI and
Grok — their APIs, and the vendors' own CLIs on your subscriptions — plus anything that speaks the
OpenAI API. A daemon on your own computer serves a phone-first web app over your tailnet. Projects,
agents with personalities, workflows that prove their work, connections to outside services with
grants, several agents and several people in a thread.

It's **0.x and public**. This file is for anyone — person or agent — changing this repository. Read
it, then the docs it points to, before changing anything.

## Read in this order

1. **This file** — commands, layout, conventions, what never to do, how work is verified and
   reported.
2. **[docs/design/roadmap.md](docs/design/roadmap.md)** — what's built, what's next, and in what
   order. The section marked **Now** is the current work. The roadmap decides order; the design docs
   decide detail.
3. **[docs/DEVELOPING.md](docs/DEVELOPING.md)** — how to run, test, screenshot and debug each part,
   and where each feature lives.
4. **[docs/design/ui/settled-brief.md](docs/design/ui/settled-brief.md)** and
   **[finding-your-way-decisions.md](docs/design/ui/finding-your-way-decisions.md)** — binding for
   anything in the app: vocabulary, navigation, status, permissions.
5. The pillar doc for whatever you're touching: [docs/DESIGN.md](docs/DESIGN.md) lists them
   (workflows, secrets, routing, capacity, memory, agents, projects, scheduling, app, CLI for agents).

## Commands

```bash
pnpm install                          # pnpm 10, Node >= 22.13
pnpm typecheck                        # tsc --noEmit
pnpm test                             # vitest: every package (one file: pnpm test <path>)
node scripts/smoke.mjs                # every screen of the app in a real browser (needs Chrome)
node scripts/smoke.mjs --shots <dir>  # …and screenshots at 400/1200px, light and dark
node scripts/phases.mjs <subject>     # one loop of an animation, held still at several moments
pnpm build                            # the published package, into dist/polyphemus
node scripts/pack-check.mjs           # install that package into an empty folder, and run it
node scripts/upgrade-check.mjs        # install it with install.sh, update it, refuse a bad update, roll back
node scripts/leak-check.mjs           # nothing secret or private in the tracked files (bar scripts/private-files.mjs)
pnpm changeset                        # record a user-visible change (patch / minor / major)
pnpm poly                          # the CLI from source (tsx; no build needed)
pnpm poly serve                    # the daemon and app in this terminal (port 3900, POLYPHEMUS_PORT)
pnpm poly service update           # deploy your latest commit to the background service
```

**Done means:** `pnpm typecheck && pnpm test` pass, `node scripts/smoke.mjs` passes for any app
change, and `node scripts/pack-check.mjs` and `node scripts/upgrade-check.mjs` pass for anything that touches
packaging, installing, updating, file paths, dependencies or the database's shape. CI runs the same on Linux and macOS, plus a secret scan.

Run `node scripts/install-hooks.mjs` once per clone: it makes every commit run the leak check.

## Layout

| Path | What |
|---|---|
| `packages/core/src` | The headless core. `polyphemus.ts` (the shared session runtime: turns, tools, fallback, agents), `loop.ts` (API-model turns), `types.ts` (canonical messages), `config.ts`, `routing.ts`, `projects.ts`, `prompt.ts`, `roster.ts` (agents), `default-agent.ts`, `assets.ts` (finding Polyphemus's own files), `updates.ts` |
| `packages/core/src/providers` | API adapters: `anthropic`, `openai-responses` (OpenAI, xAI), `openai-chat` (anything OpenAI-compatible) |
| `packages/core/src/agents` | Vendor-CLI providers: `claude-cli.ts` (Claude Code, Grok Build), `codex-cli.ts`, the approval bridge |
| `packages/core/src/tools` | bash/read/write/edit, `readonly.ts` (auto-allowed commands), `guard.ts` + `redact.ts` (credentials out of reach: a guard, not isolation) |
| `packages/core/src/connections` | Outside services as MCP servers: `manager.ts` (every call checked against grants), `scope.ts` (ceilings and grants), `oauth.ts`, `gateway.ts` (tools for agent CLIs), `github.ts` (GitHub App identities), `google.ts`, `catalogue.ts` |
| `packages/core/src/runs`, `workflows` | Outcomes, runs, steps and evidence (`runs/store.ts`); workflows as code (`workflows/define.ts`), built-ins (`builtin.ts`, `ship.ts`, `intake.ts`), git for worktrees (`git.ts`), checks (`checks.ts`) |
| `packages/core/src/session/store.ts` | SQLite via `node:sqlite` (`~/.polyphemus/sessions.db`), migrations on open |
| `packages/core/bin` | Small standalone servers Polyphemus starts: approvals, the connections gateway, GitHub, Google; `git-askpass.sh` |
| `packages/daemon/src` | `server.ts` (HTTP + SSE, pairing, people and access, questions, intake), `runs.ts` (the workflow engine), `connections-api.ts`, `access.ts`, `scheduler.ts`, `tailscale.ts` |
| `packages/daemon/web` | The app: plain JavaScript (`app.js`, one file), `style.css`, a service worker. No bundler, no framework |
| `packages/cli/src` | The `polyphemus` command: `main.ts`, `commands.ts` (the one command registry: help, JSON schemas, MCP tools), `service.ts` + `service-manager.ts` (systemd, launchd), `upgrade.ts` (updates that can't leave it broken), `mcp.ts` |
| `packages/*/test` | Vitest. Daemon tests start a real daemon on port 0 with fake providers and fake services |
| `scripts/` | `smoke.mjs`, `phases.mjs` (animation, moment by moment), `build.mjs`, `pack-check.mjs`, `leak-check.mjs`, `export-public.mjs`, `install-hooks.mjs` |
| `docs/` | `DESIGN.md` (architecture, pillars, decisions log), `design/` (one doc per pillar, the roadmap, the UI briefs and mockups), `DEVELOPING.md`, `RELEASING.md` |

Runtime state lives in `~/.polyphemus` (config.toml, sessions.db, the vault, memory/, releases/).
**Set `POLYPHEMUS_HOME` to a temp folder** to run anything without touching a real install.

## Conventions

- **TypeScript:** ESM, `module: NodeNext` (relative imports end in `.js`), `verbatimModuleSyntax`
  (`import type`), strict with `noUncheckedIndexedAccess`. Packages import each other as
  `@polyphemus/core` / `@polyphemus/daemon`; the build bundles them.
- **The core never touches a terminal.** Clients render `PolyphemusEvent`s; any client can answer a
  question (approvals, gates, "switch models?").
- **History is append-only.** Never edit earlier turns: prompt caches and reasoning replay rely on it.
- **Status is observed, never narrated.** A step is done because of an exit code, a commit, a
  service's response, a file that exists or a person's answer — never because a model said so.
- **Words.** The settled brief's vocabulary is binding in the app *and* the code: thread, outcome,
  work item, run, step, gate, evidence, receipt, Waiting on you, connection, grant, provider, way in.
  Never task, ticket, job, session (in the app), or channel.
- **Copy** is plain, calm and specific: say what happened and what to do next ("Waiting for your OK
  to run bash: …", not "Allow Bash?"). Curly apostrophes. A project is any body of work — never
  assume it's code.
- **The app** (`packages/daemon/web/app.js`): build DOM with `h(tag, attrs, …children)`. Its CSP
  forbids inline `style` attributes (set CSSOM properties, or use classes) and there is no framework.
  Put children in an existing node with `fill(node, …children)`, never `replaceChildren()`, which
  prints "null" for a child that isn't there. No browser
  `confirm`/`alert`/`prompt` — use `confirmSheet()` and `sheet()`. Everything must work at 400px.
- **Comments** explain *why*, briefly, matching the density of the file.
- **Commits:** a sentence-case title saying what someone using Polyphemus gets, and a short body with the
  why. A user-visible change gets a changeset. Lasting decisions go in the Decisions log in
  `docs/DESIGN.md` and the pillar doc; progress goes in the roadmap.
- **People are "they".** In docs and copy, refer to the owner or a user without names, genders or
  pronouns other than they/them.
- **Every API route is in `packages/daemon/test/access-matrix.test.ts`**, with who may use it. A route
  that isn't fails that test; list it with its roles, and let the test prove everyone else is refused.
- Add features when they're missed, not up front.

## Never

- **Never let a model or a tool see a credential.** Don't weaken `tools/guard.ts`, `readonly.ts` or
  `redact.ts`; don't put keys in prompts, logs, status lines or API responses. Be honest about them:
  they reduce exposure, they aren't a boundary. Worker isolation is the boundary, at the level the
  owner picks ([isolation.md](docs/design/isolation.md)); at "On this computer", a process running as
  the user can reach what the user can.
- **Never lift a vendor's subscription OAuth tokens** into Polyphemus's own API calls. Subscriptions go
  through the vendor's CLI. The one exception, decided by the owner 2026-09-16: reading SuperGrok's
  plan usage (`agents/grok-usage.ts`) — one read-only GET to xAI's billing endpoint with the Grok CLI's
  current sign-in, read when needed, never stored, refreshed or used for anything else. Don't widen it.
- **Never bind the daemon to anything but 127.0.0.1 and the Tailscale address**, and never relax the
  same-origin check on POSTs.
- **Never let a workflow merge its own work.** Pushes and merges happen as Polyphemus's GitHub identities
  inside the engine, never from an agent's shell; a merge needs another identity's approval at the
  exact head commit, and a person's yes.
- **Never commit anything private.** Every commit is public: no real names, emails, hostnames, IPs,
  home-folder paths, client names or tokens — tests use neutral examples (Alex, Sam, Acme, `example.com`).
  The pre-commit leak check and CI enforce what they can; the rest is on you.
- **Never put code or projects inside `~/.polyphemus`.** Never overwrite an existing `AGENTS.md` when
  setting up a project, and don't write a `CLAUDE.md`: Polyphemus hands `AGENTS.md` to the Claude Code
  sessions it runs.
- **Never write a project's notes or rules directly** — propose them into
  `~/.polyphemus/memory/projects/<slug>/inbox/`. The handoff is the only file written directly.
- **Never deploy while a run is active.** A restart interrupts it (see "Deploying" in DEVELOPING.md).
- **Never start a test or throwaway daemon with Tailscale on.** Set `POLYPHEMUS_TAILSCALE=off` and a temp
  `POLYPHEMUS_HOME`: otherwise it can take the tailnet HTTPS address the real daemon's phones use.

## How work is done and reported

The owner works in the app and the terminal, and reviews results rather than every step. What's worked:

- **Take a phase, finish it, report it.** Plan from the roadmap and the design docs, build, verify,
  commit, and report: what changed (in plain words, for someone using Polyphemus), how it was verified,
  what couldn't be done, and what's next. Short progress notes while a long task runs.
- **Verify like you mean it.** Tests for the behaviour, including the refusals. For a rule that
  matters, break it on purpose and watch a test fail, then restore it ("mutation check"). For any app
  change, look at it: `node scripts/smoke.mjs --shots <dir> '<route>'` at 400px and 1200px in light
  and dark — and, where people and roles matter, as a person with narrower permissions.
- **Say what's true.** If something wasn't tested, or only against a fake, say so. If a check fails,
  say so with the output. Don't claim a guarantee a guard can't give.
- **Decide the obvious; ask about the real choices.** Conventional defaults and anything the docs
  already settle don't need a question. Product direction, anything irreversible or outward-facing
  (publishing, pushing, sending, spending), and a genuine fork in the design do.
- **Deploying tested work to the owner's own install doesn't need asking** (0.x): run the checks,
  confirm no run is active, deploy with `pnpm poly service update`, and say that you did.
- **The roadmap and docs are the memory.** Anything the next person needs to know goes in the repo,
  not in a conversation.
