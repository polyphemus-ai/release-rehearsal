# Developing Polyphemus

How to run each part, test it, look at it, and ship it — and where each feature lives. Read
[AGENTS.md](../AGENTS.md) first: it has the rules this assumes.

## Running it without touching a real install

Everything Polyphemus keeps — config, sessions, the vault, memory — is under `POLYPHEMUS_HOME`
(default `~/.polyphemus`). Point it at a temp folder for anything experimental:

```bash
export POLYPHEMUS_HOME=$(mktemp -d)
pnpm poly config set projects_root "\"$POLYPHEMUS_HOME/projects\""   # or new projects land in your real ~/projects
pnpm polyphemus                 # the CLI; the first run writes a config and asks for a default model
POLYPHEMUS_PORT=3999 POLYPHEMUS_TAILSCALE=off pnpm poly serve   # the daemon and app, this computer only
pnpm poly pair            # in another terminal: a one-time code to open the app with
```

The tests that put agents in a real worker fail, loudly, on a machine with no Docker or Podman rather
than skipping: a green run would otherwise say nothing about isolation. `POLYPHEMUS_NO_CONTAINERS=1` turns
them into skips, for a machine that can't (CI on macOS).

A fresh install runs agents Isolated, in Docker or Podman workers. `POLYPHEMUS_CONTAINER_RUNTIME=off`
makes Polyphemus act as if neither is installed; the test suite sets it (`vitest.config.ts`), so tests
start no containers unless they're about workers — those find the runtime directly, hand it to
Polyphemus, and remove what they started. A test about how things run on this computer says
`[isolation] level = "host"` in its config.

The daemon listens on 127.0.0.1 and, when Tailscale is up, the tailnet address. Opening
`http://127.0.0.1:3999/` shows the pairing page; pair with the code and the app loads.

For subscriptions, Polyphemus drives the vendors' CLIs (`claude`, `codex`, `grok`) signed in on this
computer. For APIs, set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `XAI_API_KEY`, or
`pnpm poly login <provider>` to put a key in the vault.

**Codex on Linux needs unprivileged user namespaces.** Its sandbox is bubblewrap (`/usr/bin/bwrap`
when installed, else a copy Codex ships). On Ubuntu 24.04+ `kernel.apparmor_restrict_unprivileged_userns = 1`
blocks it, and every command Codex runs fails with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`.
`codex sandbox -- true` reproduces it without a model call; `core/src/agents/codex-sandbox.ts` runs
exactly that (falling back to `unshare --user --map-root-user --net true` for a Codex without `sandbox`),
reads the kernel settings to say why, and caches the answer (30 minutes when it works, 2 when it
doesn't). The providers screen shows it on Codex's card with the fix, and a Codex thread gets one
notice. Polyphemus never changes the machine: the owner adds an AppArmor profile for bwrap or turns the
restriction off. Not checked on macOS (Seatbelt) or Windows. Tests use a fake `codex`
(`packages/core/test/codex-sandbox.test.ts`).

### Environment variables

| Variable | What it's for |
|---|---|
| `POLYPHEMUS_HOME` | Where Polyphemus keeps everything (default `~/.polyphemus`) |
| `POLYPHEMUS_PORT` | The daemon's port (default 3900) |
| `POLYPHEMUS_TAILSCALE` | `off`: listen on this computer only, and leave Tailscale alone. **Always set it for a test or throwaway daemon** — otherwise it can take over the tailnet HTTPS address your real daemon uses |
| `POLYPHEMUS_GITHUB_API`, `POLYPHEMUS_GITHUB_WEB` | Point GitHub identities at a fake GitHub (tests) |
| `POLYPHEMUS_GOOGLE_AUTH`, `POLYPHEMUS_GOOGLE_TOKEN`, `POLYPHEMUS_GOOGLE_API` | Point Google sign-in and Drive/Gmail at fakes (tests) |
| `POLYPHEMUS_CHROME` | The Chrome or Chromium Polyphemus opens pages with, when it isn't on the PATH as `google-chrome` or `chromium` (or in `/Applications` on macOS) |
| `POLYPHEMUS_BROWSER_ALLOW` | Origins on this computer the Browser connection may open anyway, comma-separated, like `http://127.0.0.1:4567` (tests serve their pages locally; never set it on a real install) |
| `POLYPHEMUS_NPM_REGISTRY` | Where the update check asks for the latest version (tests) |
| `POLYPHEMUS_LEAK_DENYLIST` | Your private denylist for `scripts/leak-check.mjs` (default `~/.config/polyphemus-dev/leak-denylist.txt`) |
| `CODEX_HOME` | Tests set it to a folder that doesn't exist, so a real Codex login never leaks into a test |

`POLYPHEMUS_CALLER`, `POLYPHEMUS_APPROVAL_*` and `POLYPHEMUS_CONNECTIONS_*` are set by Polyphemus for the small
servers it starts; you don't set them.

## Tests

`pnpm test` runs every package; `pnpm test packages/daemon/test/intake.test.ts` runs one file, and
`-t "part of a test name"` one test.

**The patterns, so a new test looks like the others:**

- **Fake models.** A test defines a class implementing `ModelProvider` whose `stream()` yields one
  `message_done` per call, answering from the prompt (see `Sessions` in
  `packages/daemon/test/workflows.test.ts`), and registers it with `polyphemus.registry.use('openai', …)`.
  Reply with `tool_call` blocks to exercise tools (`bash`, `write_file`, `submit`, `propose_work`…).
- **A real daemon.** `startDaemon({ polyphemus, hosts: ['127.0.0.1'], port: 0, cwd: home })` on a
  `mkdtemp` home, with a config written first. Pair with
  `fetch(`${base}/pair?code=${polyphemus.store.createPairingCode(undefined, personId)}`)` and keep the
  cookie. `polyphemus.store.addPerson('Sam')` and `setProjectRole(slug, id, 'member' | 'viewer')` make a
  second person.
- **Waiting.** Runs and turns are asynchronous: poll with a small `until(check, what)` helper (each
  daemon test file has one) rather than sleeping.
- **Fake services.**
  - GitHub: `packages/daemon/test/fake-github.ts` — the REST calls identities make, installation
    tokens checked against a real RSA key, and **real git over HTTP** (`git http-backend`) that only
    lets a token with write access push.
  - MCP servers and OAuth: `connections.test.ts` and `oauth.test.ts` start small fake servers inline.
  - Google: `google.test.ts`.
- **Mutation checks.** For a rule that matters (a refusal, a permission, a leak), break it in the
  source, run the test, watch it fail, and put it back. The tests in this repository were written that
  way; keep it up.

## The app

`packages/daemon/web/app.js` is the whole app: plain JavaScript, no build step, served by the daemon
with a strict Content-Security-Policy (`packages/daemon/security-headers.json`).

**How it's put together.** `render()` reads the route (`parseRoute()`), and on a wide screen draws the
section's list into the sidebar (`SIDEBAR_OF`) beside the screen. State comes from `/api/state`
(`refresh()`); the daemon pushes changes over SSE (`onEvent`), which redraw. Rows everywhere come from
`sessionRow()`; marks from `whoMark()`; waiting cards from `questionCard()`. Home and a project's Work
tab share `threadList()`.

**Checking a change.**

```bash
node scripts/smoke.mjs                           # every screen: fails on an error, a CSP block, a blank screen
node scripts/smoke.mjs '#/p/demo?tab=setup'      # one
node scripts/smoke.mjs --shots /tmp/shots '#/'   # screenshots at 400/1200px, light and dark — look at them
```

A screenshot of something moving shows one frame, which says nothing about where it went. For an
animation, hold one loop still at several moments and look at them side by side:

```bash
node scripts/phases.mjs alive                    # the working mark's comet: 8 moments, light and dark
node scripts/phases.mjs alive --steps 12 --size 120 --shots /tmp/phases
```

Each subject in `SUBJECTS` names the app's own markup and stylesheet, so what's drawn is what the
app draws; add one when there's a new thing that moves. This is how the comet was found to be
circling outside the mark and turning over a quarter-lap early — three attempts had been made from
single frames before it existed.

The smoke check serves the real app against a fixture (`STATE` in `scripts/smoke.mjs`); a screen that
needs particular data gets it there. A route in `EXPECT` must show given words, so a screen that
silently falls back to another one fails. When a screen needs realistic data — several projects,
a run at a gate, a second person — seed a throwaway daemon (fake provider, `POLYPHEMUS_HOME` in a temp
folder, the API to create projects and threads) and screenshot it with headless Chrome.

## Where features live

| Feature | Core | Daemon / app | Tests |
|---|---|---|---|
| Sessions, turns, fallback | `polyphemus.ts`, `loop.ts`, `routing.ts`, `agents/` | `server.ts` (`liveSession`, `startTurn`) | `core/test/polyphemus.test.ts`, `loop.test.ts`, `routing.test.ts` |
| Agents, the default agent, several agents in a thread | `roster.ts`, `default-agent.ts` | `server.ts` (`leadOf`, `handOffs`, `quietForAgents`) | `daemon/test/agents.test.ts`, `agents-talk.test.ts` |
| People and permissions | `session/store.ts` (people, roles) | `access.ts`, pairing and devices in `server.ts` | `daemon/test/access.test.ts`, `daemon.test.ts` |
| Outcomes, runs, gates | `runs/store.ts`, `runs/tools.ts` | `runs.ts` | `daemon/test/runs.test.ts` |
| Workflows (engine, loop, ship-issue, spec, intake) | `workflows/` | `runs.ts` (`driveWorkflow`), `/api/workflows` | `workflows.test.ts`, `ship-issue.test.ts`, `intake.test.ts` |
| Connections, grants, OAuth, the gateway | `connections/` | `connections-api.ts` | `connections.test.ts`, `oauth.test.ts`, `google.test.ts` |
| Looking at a site (ship-issue's “Look at the pages”) | `browser/chrome.ts` (headless Chrome over its DevTools pipe), `workflows/preview.ts` (serving a worktree), the `look` probe in `workflows/ship.ts` | `runs.ts` (probe checks keep pictures on their step), `stepPictures` in the app | `look.test.ts`, `ship-issue.test.ts` (skipped without Chrome) |
| The Browser connection (agents drive a browser) | `browser/tab.ts` (a tab read as the accessibility tree, acted on by ref), `browser/policy.ts` (public addresses only), `connections/browser.ts` (the built-in connection: tools, a tab per thread) | `connections-api.ts` (catalogue entry `browser`) | `browser.test.ts`, `connections.test.ts` |
| Browser sign-ins (a person signs in by hand; agents' browsers start signed in) | `connections/sign-ins.ts` (the store, cookie matching, live views), `Connections.startSignIn` / `keepSignIn` / `signInHeldBack` in `connections/manager.ts`, `TabHands` in `browser/tab.ts` | `signInRoute` in `connections-api.ts`; `signInsSection` and `liveSignInScreen` in the app | `connections.test.ts` (“browser sign-ins”, skipped without Chrome) |
| Finance (SimpleFIN) | `connections/simplefin.ts` (claim a setup token once, the access URL in the vault, two read-only tools) | `/api/connections/simplefin`; `financeSetup` and `simplefinSetup` in the app | `daemon/test/plaid.test.ts` |
| Finance (Plaid) | `connections/plaid.ts` (the app and each bank in the vault, the four read-only tools, run inside the daemon) | `/api/connections/plaid-app`, `/api/connections/<id>/plaid/link \| finish \| remove`; `plaidAppSetup` and `banksSection` in the app | `daemon/test/plaid.test.ts` (a fake Plaid) |
| Worker isolation (where agents' commands run) | `isolation/levels.ts`, `runtime.ts` (Docker or Podman), `image.ts` (the worker image), `workers.ts` (a container per project and agent, exec with a process group); `claude.ts` (Claude Code's shell wrapper), `codex.ts` (the exec-server bridge), `grok.ts` (the ACP client), `checks.ts` (once-per-version checks, `~/.polyphemus/isolation-checks.json`); `egress.ts` + `egress-proxy.ts` (the network proxy container, one per install, `~/.polyphemus/isolation/egress/`) and `network.ts` (presets, hosts); `ToolContext.worker` in `tools/`; `SessionRuntime.workerSpec` and the level check in `polyphemus.ts` | `/api/isolation`, `/api/projects/<slug>/isolation`, `/api/projects/<slug>/network`; `isolationSetting`, `projectIsolation` and `projectNetwork` in the app | `isolation.test.ts`, `egress.test.ts` (the real-worker tests are skipped without Docker or Podman) |
| GitHub identities | `connections/github.ts`, `bin/github-mcp.mjs`, `workflows/git.ts` | `connections-api.ts` (the manifest flow) | `github-identities.test.ts`, `ship-issue.test.ts` |
| Artifacts | `artifacts.ts` | `/artifacts/…` in `server.ts` | `artifacts.test.ts` |
| Projects, orientation, memory | `projects.ts`, `prompt.ts` | `/api/projects` | `core/test/projects.test.ts` |
| Routines | `routines.ts` | `scheduler.ts` | `core/test/routines.test.ts` |
| Capacity and usage | `forecast.ts`, `agents/*` usage readers | `/api/state` | `forecast.test.ts` |
| Config and its history | `config.ts`, `config-edit.ts` | `/api/routing`, `/api/selected` | `config-edit.test.ts` |
| Updates | `updates.ts` | `update` in `/api/state`, Setup → About | `core/test/updates.test.ts`, `pack-check.mjs` |
| The service | — | `cli/src/service.ts`, `service-manager.ts` | `cli/test/service.test.ts` |

## Deploying to your own install

Your daemon runs as a background service (systemd on Linux, launchd on macOS). From a checkout, it
runs its own tested copy of your latest **commit** from `~/.polyphemus/releases/<commit>/`, never your
working tree:

```bash
pnpm poly service install     # once
pnpm poly service update      # after committing: clean copy, install, typecheck, tests, smoke; then restart
pnpm poly service status      # which commit is live
pnpm poly service logs        # follow the daemon's log
```

**Don't deploy while a run is active** — a restart interrupts it (workflow runs resume from their last
finished node, but a waiting gate is asked again). Check first:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(require('os').homedir()+'/.polyphemus/sessions.db',{readOnly:true});console.log(db.prepare(\"SELECT count(*) n FROM runs WHERE status IN ('queued','running','waiting','retrying')\").get().n)"
```

`sessions.db` is plain SQLite: open it read-only to see threads, runs, steps, evidence, questions,
connections and grants when something looks wrong. Never write to it by hand while the daemon runs.

## Checking Windows

Windows runs Polyphemus inside WSL2, and nothing in CI can prove it: GitHub's Windows runners give
WSL1, with no systemd, no Docker and different networking. So it's checked on a real Windows
computer, in one round trip:

```bash
sh scripts/windows-kit.sh <computer>   # builds the kit and sends it there with Taildrop
```

On that computer, in PowerShell (not as Administrator): `cd ~\Downloads; powershell -ExecutionPolicy
Bypass -File .\windows-check.ps1`. It checks WSL and its distribution, installs this build inside it,
starts it as a service where systemd is on, checks Windows reaches it, runs `poly start` (which
should open the setup wizard in Windows's browser), and checks a phone could reach it through
Tailscale on Windows — pointing Tailscale HTTPS at it for a few seconds, then off (`-NoPhone` skips
that). Everything it finds goes to `windows-check-report.txt` beside it, to paste back.

The WSL half (`scripts/windows-check-wsl.sh`) runs in a Linux container too, with
`WSL_DISTRO_NAME=Ubuntu` set, which is how it was tested; the PowerShell half has only been parsed
(`mcr.microsoft.com/powershell`), never run on Windows. Keep `windows-check.ps1` plain ASCII:
Windows PowerShell reads it as Windows-1252 and treats a curly apostrophe as a quote.

## Publishing

Releases are CI's job; see [RELEASING.md](RELEASING.md). Locally, `pnpm build` and
`node scripts/pack-check.mjs` show exactly what would be published.
