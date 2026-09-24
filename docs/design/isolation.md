# Worker isolation

**Goal:** an agent gets only the files, environment and network it was granted, and nothing that
controls Polyphemus — whichever provider runs it. The owner chooses how much risk to take; the default is
the safe one, and Polyphemus says plainly what each choice means.

Written 2026-09-16 from two surveys: what Polyphemus runs on the host today, and how OpenClaw, the vendor
CLIs and container runtimes behave on this kind of machine. Replaces the guards as the security
boundary (they stay, as a second layer), and replaces per-vendor sandbox switches.

## Where things stand

Today every agent runs as the owner, on the host. What holds it back:

| Provider | Holds it back | Gaps found 2026-09-16 |
|---|---|---|
| API models (Polyphemus's tools) | Ask before changes; credential guard (a path and name blocklist); secrets stripped from the shell's environment | File tools take any absolute path; nothing confines them to the project |
| Claude Code | `default`: every command and edit asked through Polyphemus's approval bridge (`acceptEdits` was dropped 2026-09-21: it also ran `rm`, `mv`, `cp` and `mkdir` unasked) | Gets Polyphemus's **whole** environment, API keys included |
| Codex | Its bubblewrap sandbox — which can't start on Ubuntu 24.04+ without a machine change | Whole environment; owner can turn the sandbox off |
| Grok Build | `acceptEdits`, its own rules | Whole environment; no push lock inside a run's worktree |
| Checks and previews | Secrets stripped from the environment | Run the repository's scripts as a login shell with the whole home folder |

And agents can write files that later run with more trust than they had: a routine with `mode: yolo`,
skills, agents, a project's AGENTS.md.

## The shape: brain on the host, hands in a worker

Following OpenClaw's sandbox: **the thinking stays on the host, and
everything that touches files or runs a command happens in a worker container.**

- **On the host:** the daemon, the vault, connections and their credentials, Polyphemus's own loop for API
  models, and the vendor CLI processes with their sign-ins. Git fetch and push as Polyphemus's GitHub
  identities (they hold the token). Nothing an agent chooses runs here.
- **In a worker:** every command and file operation an agent makes — Polyphemus's `bash`/`read_file`/
  `write_file`/`edit_file`, the vendor CLIs' shell and file tools — and the repository code Polyphemus runs
  for a workflow (checks, previews).

### A worker

- **One per project and agent** (a run's worktree gets its own), created once and reused while its
  settings match, removed when idle. A command is a `docker exec` (about 50 ms on a warm container here).
- **Hardened by default:** read-only root filesystem, tmpfs for `/tmp`, every capability dropped,
  `no-new-privileges`, the owner's uid (so files it writes are theirs), limits on processes, memory and
  CPU (OpenClaw leaves these unset; Polyphemus won't).
- **Only what was granted is mounted:** the project folder (or the run's worktree, see below), that
  project's memory folder, skills read-only. Not `~/.polyphemus`, not the home folder, not other projects,
  never the container runtime's socket.
- **An empty environment,** plus what a grant puts there for one command (secrets.md, Broker).
- **Network:** none by default. Granted network goes through a polyphemus-owned proxy that allows named
  hosts only (and refuses this computer, private ranges, tailnets and cloud metadata addresses) — the
  browser's rule, enforced rather than checked. *Built 2026-09-16:* a worker never has a network at all
  (`--network none`: no DNS, no route, no other workers). Its one way out is a Unix socket in a folder
  of a shared volume that only it mounts, to the proxy container (`isolation/egress.ts`,
  `egress-proxy.ts`); a small forwarder inside the worker listens where `HTTP(S)_PROXY` points. Which
  socket a connection arrives on is which worker it is, so there's no token to steal. The proxy checks
  the host against the grant, resolves it itself, refuses any private address it resolves to, and
  connects to the address it checked. Ports 80 and 443 unless a grant names another. Grants change
  without restarting a worker. What it refuses is said in the thread and offered to grant on the
  project's Setup tab. "Isolated, open network" is the same proxy allowing any public host. Tools that
  ignore proxy settings (Node 18's `fetch` in the worker image) have no way out.
- **An image Polyphemus builds:** a slim Debian with git, a shell, common tools, and the toolchains a
  project declares (Node, Python, Rust, Go); extendable per project.

### Vendor CLIs: the hard part

A CLI can't simply move into the worker: its sign-in (a refreshable OAuth token) would be readable by
every command the model runs there. So the CLI stays on the host and **only its tools** go to the worker:

| CLI | How its tools reach the worker | Status |
|---|---|---|
| Claude Code | `CLAUDE_CODE_SHELL_PREFIX` is a per-turn wrapper sending every command to the worker; Polyphemus's own MCP servers carry a nonce so they still start here; `--setting-sources user --strict-mcp-config`; Read, Write, Edit, Glob, Grep, WebFetch (and WebSearch without network) off, Polyphemus's worker-backed file tools offered over the gateway | Built 2026-09-16, verified with Claude Code 2.1.273 |
| Codex | `codex exec` with `CODEX_EXEC_SERVER_URL` pointing at a Polyphemus WebSocket on 127.0.0.1 (secret path), bridged to `codex exec-server --listen stdio` in the worker, from Codex's own static binary mounted read-only; its sandbox is off (the worker is the boundary) | Built 2026-09-16, verified with Codex 0.154.0. Experimental in Codex. **Isolated, Codex starts no MCP servers**, so it can't use connections |
| Grok Build | Polyphemus drives `grok agent stdio` as its ACP client: `terminal/*` and `fs/*` requests run in the worker; the session's agent profile allows only run_terminal_command, read_file, write, search_replace (its grep and list_dir read this computer directly) | Built 2026-09-16, verified with Grok 1.0.34 |

Because these depend on vendor behaviour that can change, **Polyphemus verifies, and fails closed**: before
an isolated CLI turn, a probe command must report it ran inside the worker; if a CLI can't be isolated,
it isn't offered at that level (the owner sees why), rather than quietly running on the host.

### Worktrees and memory

- A run's worktree shares `.git` with the main checkout, so mounting only the worktree breaks git and
  mounting the project exposes the main checkout and its hooks. Runs move to **separate clones** (or
  `git worktree` with a per-run copy of the objects) under a polyphemus-managed folder, fetched and pushed
  by Polyphemus on the host; hooks never run in Polyphemus's own git calls (`core.hooksPath=/dev/null`).
- Memory is one git repository for all projects; a worker mounts only its project's folder, and Polyphemus
  commits on the host.
- Files an agent writes that later carry more trust — routines, skills, agents, AGENTS.md — take effect
  only after a person accepts them (the review inbox already does this for notes and rules).

## Risk levels: the owner's choice

Set for the install, and narrowed (never widened) per project:

| Level | Meaning | Who it's for |
|---|---|---|
| **Isolated** (default) | Everything above. Network none unless granted. | Anyone |
| **Isolated, open network** | A worker, but network to anywhere public | Work that needs package installs and the web |
| **On this computer** | Today's behaviour: runs as you, guards only. Said on every thread it applies to | The owner's own projects, knowingly |

YOLO stays what it is — whether Polyphemus asks before an action — and is separate from where the action
runs. A thread at "On this computer" with YOLO says both.

What "asks first" means per CLI (independent review, 2026-09-19): Claude Code asks Polyphemus through the
approval bridge, and Grok Build asks Polyphemus as its client, isolated or on this computer — both reach
the person, and with nobody to ask the answer is no. A Grok tool that never gets that question is said
as not run, not as you cancelling it. Codex, run headless (`codex exec`), never asks about an action at
any level: in Ask mode its boundary is its sandbox (`workspace-write`) on this computer, or the worker
when isolated, where its own sandbox can't start. Choose Codex knowing it acts within that boundary
without asking.

## Runtimes

- **Speak the Docker CLI's language,** so Docker and Podman both work; prefer rootless when it's
  available and say which is in use.
- **Rootful Docker is root:** anything that can use its socket owns the machine. Fine to use on your own
  computer (the owner already has that access); Polyphemus never mounts the socket into a worker, and a
  shared server (hosting.md) requires rootless.
- **No runtime installed:** setup says so and what to install; until then only "On this computer" is
  available, and that's stated rather than implied.
- **macOS:** Docker Desktop, OrbStack or Colima (a shared Linux VM); Apple's `container` (a VM per
  container, macOS 26) as a second backend later.
- **Stronger:** gVisor (`runsc`) as an option where installed.
- **Inside a worker, vendor sandboxes are off** (bubblewrap can't nest in a default container); the
  worker is the boundary. This retires the Codex sandbox switch and the AppArmor fix message.

## Build order

1. **The worker and Polyphemus's own tools.** A runtime layer (detect, create, exec, remove), the image,
   the install's risk level and a project's; API models' `bash` and file tools, checks and previews in
   the worker; environment scrubbing for CLIs closed on the host too. Setup and a project's Setup tab say
   the level and what it means.
   *Built 2026-09-16, except checks and previews* (they install packages, so they wait for network
   grants in step 3): `isolation/` (runtime, image, workers), `isolation.level` and a project's own,
   Polyphemus's four tools in the worker, refusals for CLIs, workflow runs and a missing runtime, and CLIs
   given only their own sign-in variables — plus the push lock, which had never reached a CLI at all.
2. **Vendor CLIs isolated,** one at a time with its probe: Claude Code, then Codex, then Grok.
   *Built 2026-09-16:* each is checked once per version with a real, small turn (a command whose output
   exists only in a worker), and every turn after is checked too — Claude Code's Bash calls against the
   wrapper's count, Codex's commands and file changes against what crossed the bridge, Grok's tools
   against the allowed set and its commands against terminals created. A mismatch stops that CLI being
   offered isolated until Polyphemus restarts.
3. **Network grants:** the allowlisting proxy, per project; the Browser connection's Chrome in a worker.
   *Also 2026-09-16, found while mapping step 4:* Polyphemus's own git ran hooks and fsmonitor commands from
   the repository's config — the fetch and push with an identity's token in their environment included —
   so every git call Polyphemus makes now carries `core.hooksPath=/dev/null` and `core.fsmonitor=false`,
   and the askpass script only gives the token to the GitHub host it was meant for (a `url.insteadOf`
   rewrite can't redirect it). And a workflow run where agents are isolated is refused before its
   worktree or checks, not at its first agent turn. Filter drivers (`.gitattributes` with a smudge
   command in `.git/config`) can still run during `worktree add`: step 4's clones, whose config Polyphemus
   owns, close that.
   *Proxy and per-project grants built 2026-09-16* (presets for package registries and GitHub, hosts by
   name, refusals said in the thread). *The Browser connection's Chrome in a worker, built 2026-09-16:*
   wherever there's a runtime, whatever the level — Chromium from the worker image, in a worker with no
   folders and "open" network through the proxy, driven over its DevTools pipe by a relay inside the
   worker (a container exec carries only stdin and stdout). Live sign-ins use the same browser; cookies
   go to Chrome over the pipe and never to anything an agent runs. Still to do: checks and previews in
   workers (with step 4), and credentials per command.
4. **Runs in their own clones,** hooks off in Polyphemus's git, memory mounted per project, trust-raising
   files through review.
   *Built 2026-09-16, except trust-raising files:* a run's folder is a full clone of the project under
   `.polyphemus-runs/` (copied, not hard-linked or sharing `.git`), and a run's agents, checks, preview and
   look at its pages get a worker with only that folder (plus memory for agents). Polyphemus's fetches and
   pushes as an identity happen in a temporary repository of its own: the base is fetched there and
   into the clone locally, and a push takes the run's commits as a bundle made in the run's worker and
   streamed out, so nothing in the clone's `.git` (config, alternates, symlinks, hooks) is read on this
   computer by a command holding the token. The push refuses if the bundle's commit isn't the one the
   checks passed at. A preview is served inside the worker (plain HTML by Python's file server) and
   opened by the worker's Chromium over its loopback. Memory was already mounted per project.
5. **Connections' local servers** in workers of their own; gVisor and Apple `container` backends.

## Decided (the owner, 2026-09-16)

- **No runtime installed:** setup explains what's missing and how to install it; until then the owner
  knowingly picks "On this computer", and every affected thread says so.
- **A CLI that can't be verified as isolated isn't offered at the Isolated level;** its card says why,
  and a project can be lowered to use it.
- **The default flips to Isolated once the vendor CLIs can be isolated** (build step 2): before that,
  Isolated would take away every CLI the owner uses. Until then the install's level is chosen in setup.
  *2026-09-16:* the CLIs are isolated, but workflow runs aren't (step 4) and would be refused, so an
  install without a setting still means On this computer; first-run setup now asks. The default flips
  once workflow runs can run isolated.
  *Flipped 2026-09-16,* once runs could: a new install is Isolated. An install already in use without a
  setting has `isolation.level = "host"` written for it the first time the new version opens, recorded
  in config history and said when the daemon starts, so nobody's agents change where they run unasked.
  A new install writes `level = "isolated"` into the config it creates, so it's never mistaken for one
  of those once it has threads (fixed 2026-09-19: a fresh install was pinned to host on its second start).

- **Network presets** (decided in building, 2026-09-16): "Package registries" (npm, PyPI, crates.io, Go
  modules, RubyGems) and "GitHub" (reading: clone, releases, raw files, API — pushing stays Polyphemus's),
  plus hosts by name. Addresses and bare local names can't be granted: they'd be refused anyway.

## Open

- Credentials a command needs (a `gh` or `aws` call) arrive per command from the broker — secrets.md's
  design; built with network grants.
