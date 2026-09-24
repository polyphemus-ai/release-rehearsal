# Contributing to Polyphemus

Thanks for looking. Polyphemus is early, so the most useful things are bug reports with the exact
steps, and small, focused pull requests.

## Running it from a checkout

```bash
pnpm install
pnpm polyphemus            # the CLI, straight from the TypeScript (no build step needed)
pnpm poly serve      # the daemon and the app, in this terminal
```

`poly service install` from a checkout runs the daemon from its own tested copy of your latest
commit; `poly service update` deploys a newer commit.

## Before you open a pull request

Every change passes the same checks CI runs:

```bash
pnpm typecheck
pnpm test
node scripts/smoke.mjs      # every screen of the app in a real browser (needs Chrome)
node scripts/pack-check.mjs # installs the package as it would be published, and runs it
```

If someone using Polyphemus would notice the change, add a changeset: `pnpm changeset` (patch for a
fix, minor for something new — before 1.0, also for something that breaks).

## How the code is organised

- `packages/core` — the agent loop, providers, sessions, projects, agents, connections, workflows.
- `packages/daemon` — the HTTP server, the run engine, and the web app (`web/`, plain JavaScript).
- `packages/cli` — the `polyphemus` command.
- `docs/DESIGN.md` and `docs/design/` — why things are the way they are. `AGENTS.md` holds the
  rules for anyone (or any agent) changing this repository; read it first.

## Rules that aren't negotiable

- A model or a tool never sees a credential.
- The daemon never listens beyond this computer and the tailnet, and never relaxes its same-origin
  check.
- Status comes from something that happened — an exit code, a commit, a response — never from what a
  model says.
- No browser `confirm`/`alert`/`prompt` in the app, and no inline style attributes (its
  Content-Security-Policy forbids them).
