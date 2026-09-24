# Polyphemus

One agent harness over every model you use: Claude, OpenAI and Grok through their APIs **or the
vendors' own CLIs on your subscriptions**, anything that speaks the OpenAI API, or models on your own
machine. Projects, agents with personalities, workflows that do real work and prove it, connections
to outside services with grants you control — and a phone app that shows who's working, what they
can reach, what changed, and what needs you.

> **Early.** Polyphemus is 0.x: things change between minor versions, and the security model below is
> the one it has today, not the one it's aiming for. Read it before you point Polyphemus at anything
> that matters.

## Install

Requirements: **Node.js 22.13 or newer**, **git**, and **Linux or macOS** (on Windows, use WSL2).
For subscriptions, the vendor CLIs you already use (`claude`, `codex`, `grok`), signed in.

**Docker or Podman**, for agents to work. By default an agent's commands and file changes run in a
container that has only what you granted (see below). Without a container runtime, Polyphemus installs
and its app runs, but an agent that needs to run a command stops and says why. You can choose to run
agents on this computer instead (setup, or `poly config set isolation.level host`), knowing what
that means. On macOS: Docker Desktop, OrbStack or Colima. An agent's own computer (a desktop it can
use, which you can watch and take over) also runs in a container, 2 GB each.

```bash
curl -fsSL https://polyphemus.ai/install.sh | sh   # installs Node too, if yours is missing or too old
# or, with Node 22.13 or newer already: npm install -g polyphemus
poly start    # runs it in the background and opens setup in your browser
poly doctor   # what this computer has and lacks, and how to fix each gap
poly pair     # pair your phone: a one-time code, or scan the QR
```

`poly start` is the whole first run: the daemon as a background service, this computer paired, and
the setup wizard open — where you pick models, name your agent, and choose where agents run. On
Windows, run all of this inside WSL2; `poly start` opens Windows's own browser.

The app is served by your own computer, on this machine and your [Tailscale](https://tailscale.com)
network only — nothing goes through a Polyphemus server, because there isn't one.

`poly update` installs a newer version when there is one (an installed Polyphemus checks npm once a
day; `updates.check = false` in `~/.polyphemus/config.toml` stops that). `poly update --channel beta`
follows beta releases too; `--channel stable` goes back.

## How safe is it

- **Credentials are kept from models.** API keys, OAuth tokens and connection secrets live in a local
  vault; tool output is redacted; agents reach outside services through Polyphemus, which checks each
  call against what you granted. At the Isolated levels the container is the boundary; on this
  computer the guards reduce exposure but aren't one.
- **Isolated by default.** An agent's commands and file changes run in a container with only its
  project's folder and memory: no home folder, no credentials, nothing that controls Polyphemus, and no
  network except hosts you grant. The vendor CLIs stay on your computer with their tools sent to the
  container. You choose the level: Isolated, Isolated with an open network, or On this computer
  (commands run as you; Polyphemus's guards keep credential files out of reach, but they aren't a
  boundary). See [docs/design/isolation.md](docs/design/isolation.md).
- **Asks first.** Commands that change things ask first unless you choose YOLO. (Codex doesn't ask:
  it relies on its own sandbox, or on the worker when agents are isolated.)
- **Workflows prove their work.** Status comes from exit codes, commits and service responses, not
  from what a model says. A workflow that ships code pushes and merges as GitHub identities of its
  own, reviewed by a model from another vendor, and merges only with your yes.
- **Reachable only by you.** The daemon listens on this computer and your tailnet; every device is
  paired with a one-time code, and you can sign one out from any other.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## From the terminal

```bash
poly                               # a session with your default agent
poly models                        # every model, and whether it's ready to use
poly -m codex                      # pick per session: an alias, a provider name, or provider:model-id
poly -m claude-api                 # pay-as-you-go API (ANTHROPIC_API_KEY or `poly login anthropic`)
poly -c                            # continue the latest session in this directory
poly -p "summarize README.md" -y   # one-shot, tools allowed
```

Subscriptions run through each vendor's own CLI (`claude`, `codex`, `grok`), so sign in there
once. APIs (`claude-api`, `gpt-api`, `grok-api`) need keys.

## Bring your own models

Anything that speaks the OpenAI chat API works, so you aren't limited to the providers above:
models on your own machine (Ollama, LM Studio, llama.cpp, vLLM — no key, nothing leaves the
computer), or a gateway with hundreds of models behind one key (OpenRouter, Groq, DeepSeek,
Together, Mistral, Gemini's compatible endpoint). `config.toml` ships with each one ready to
uncomment.

```bash
poly config set providers.ollama '{ adapter = "openai-chat", base_url = "http://127.0.0.1:11434/v1", auth = { type = "none" } }'
poly models --all                       # ask every provider what it offers
poly models add llama ollama:llama3.1   # give one a name
poly -m llama                           # use it
```

Named models are a config change like any other: checked before saving, kept in
`poly config history`, and undoable. They work everywhere a model does — per session with
`-m`, as your default, in a fallback list, or for a routine.

Inside a session, `/model` opens a picker (type to filter, arrows, Enter) showing every model,
whether it's ready, and its usage. `/model codex` switches directly, and whichever model takes
over is brought up to date automatically. `/default` changes what new sessions start with. `/sessions` and `/resume <id>` move between sessions,
`/title` renames one, and `/help` lists the rest. Ctrl+C interrupts a turn. After each turn, a usage line shows tokens,
cost, and your plan's usage windows, e.g. `$0.020 · 5h 30% · 7d 20%`.

When a model runs out or is down, Polyphemus says why and when it resets, then offers another
model: `Switch to codex and retry? [Y/n]`. It won't send to a provider it knows is out. To pick
the order, set `[routing] fallback = ["codex", "claude-api"]` in the config. Add
`on_fallback = "continue"` to switch without asking.

Read-only commands (listing, reading, searching, `git status`/`log`/`diff`) run without asking.
Anything that changes things asks, unless you start with `--yolo` or type `/yolo`. That includes
Claude Code: when it wants to do something its permission mode doesn't allow, the request shows up
as a Polyphemus prompt instead of failing. Grok Build asks the same way. **Codex doesn't ask**: run
headless, it never asks about an action, so it works within its sandbox (or the worker, where agents
are isolated), and the app says "Doesn't ask" for it rather than "Asks first".

## Threads

```bash
poly sessions search flaky test   # titles and what was said, archived ones included
poly sessions rename 3cdf "Login bug"
poly sessions archive 3cdf        # off the lists; send it a message and it's back
poly sessions --archived
poly sessions delete 3cdf         # for good
```

In the app, a thread's **⋯** button does the same, Home has search and the archive, and a
project's page and an agent's profile each open every thread they're in.

## Skills

A skill is a folder with a `SKILL.md`: instructions for one kind of work, which a model opens
only when the work matches. Every session sees the names and one-line descriptions; the
instructions themselves are read on demand, so twenty skills cost a few hundred tokens.

```bash
poly skills new review-pr "reviewing a pull request before merge"   # in your library
poly skills new deploy "shipping this project" --project   # in this project
poly skills   # what sessions here can use
```

Your library lives in `~/.polyphemus/skills/` and is available everywhere. A project's skills live
in `.polyphemus/skills/` beside its `AGENTS.md`, safe to commit, and win over a library skill with
the same name. It's the same format Claude Code and Codex read, so a skill written here works
outside Polyphemus too — and every model gets them, whether it runs through a vendor CLI or an API.

## Agents

An agent is an expert for one kind of work, with its own model route, persona, instructions, and
skills. It's a folder you can read, edit, diff, and commit — not a row in a database.

```bash
poly agents templates                      # what comes with Polyphemus
poly agents new reviewer --from reviewer   # make one yours, then edit it
poly agents                                # who you have
poly -a reviewer                           # start a session with one
```

Polyphemus ships a **Reviewer**, a **Researcher**, and a **Builder**, and the skills `review-pr`
and `debug-failing-test` (`poly skills templates`). They're templates you copy, not agents
installed behind your back: once copied, it's your file and nothing updates it.

```
~/.polyphemus/agents/reviewer/
  agent.toml       what it's for, its model and fallbacks, which skills it uses
  persona.md       who it is and how it works
  instructions.md  what it does here
```

An agent's model route is just a model with fallbacks, so routing, breakers, and capacity treat
it like any other. Give it a `skills` list and it sees only those; leave it out and it sees
everything in scope. A project's agents live in `.polyphemus/agents/` and win over a library agent
of the same name, and a session remembers which agent it ran as, so resuming keeps it in
character.

**You never need a keyboard for this.** On your phone, Team → **+** makes an agent from one of
the shipped templates, and tapping one opens it: what it's for, its model, who it is, and what
it does here, all editable, plus a button to start a thread with it. New thread has an Agent
picker too (choosing one leaves the model alone, since the agent brings its own).

## From your phone

```bash
poly service install   # runs the daemon in the background from now on, and at boot
poly pair              # a one-time code: type it into the app, or scan the QR code
```

`poly serve` runs the same daemon in a terminal instead. It listens on this computer and
your Tailscale address only, and sets up HTTPS through Tailscale (tailnet only), so the app
installs to your home screen and can send notifications.

With Tailscale on, your phone shows every session, grouped by project, and streams replies
live. You can start sessions (in Ask or YOLO mode), send messages, stop a turn, switch models,
and answer approvals and "switch models?" questions with buttons. The bell turns on
notifications for when a session needs you or finishes. Each device has its own key:
`poly devices` lists them, and `poly devices revoke <id>` cuts one off. The daemon uses
port 3900 (`POLYPHEMUS_PORT` to change it).

Messages can carry images: tap the picture button (or paste one) in the app, or in the
terminal paste or drag an image's path into your message, or use `/image <path>`. Photos are
shrunk on the phone before they're sent. Every model sees them: the APIs and Claude Code
directly, Codex through `--image`, and Grok by opening the saved file.

While the daemon is running, `poly` in the terminal runs its sessions there too, so a
session you start at your desk is live on your phone (and the other way round), and either one
can answer its approvals. `poly --local` keeps a session in the terminal only.

## Projects

```bash
poly projects new "Side Quest" --about "A tiny arcade game"   # in ~/projects, or --from <git-url>
poly projects add ~/code/existing   # a folder you already have
poly projects orient side-quest     # an agent drafts AGENTS.md and notes
poly projects review side-quest     # keep or discard what it proposed
```

A project is a folder Polyphemus knows about. Its `AGENTS.md` (safe to commit) holds the rules;
its memory stays private in `~/.polyphemus/memory/projects/<name>/`. Every session in a project
starts with its rules, the last session's handoff, and its notes, and nothing from other
projects. Agents propose rules and notes into an inbox; nothing changes until you keep it
(also from the app: **Set up** and **Review**). See [docs/design/projects.md](docs/design/projects.md).

## For agents and scripts

```bash
poly capabilities                             # start here: commands, models, projects, paths, as JSON
poly help sessions show                       # one command: usage, examples, whether it prints JSON
poly sessions show <id>                       # a session's conversation: messages, tool calls, results
poly usage                                    # each plan's usage, and whether it will last until it resets
poly config set routing.on_fallback continue --dry-run   # settings: validated, recorded, undoable
claude mcp add polyphemus -- poly mcp serve   # Polyphemus's read-only commands as MCP tools
```

Change settings with `poly config` rather than editing `config.toml` by hand: every change
is checked against the whole config, saved as a revision (`poly config history`), and can
be undone (`poly config undo`). If the file is edited by hand anyway, Polyphemus says so until
you keep the edit (`poly config adopt`) or go back (`poly config undo`).

List and show commands print `{ ok, schemaVersion, data, warnings, error? }` with `--json`, or
automatically when stdout isn't a terminal (`POLYPHEMUS_OUTPUT=text` turns that off). Exit codes:
0 ok, 1 failed, 2 usage, 3 not found, 6 conflict.

Config lives in `~/.polyphemus/config.toml` (created on first run). Sessions are in
`~/.polyphemus/sessions.db`. Put personal instructions in `~/.polyphemus/AGENTS.md`, or project
instructions in `./AGENTS.md`.

## When something's wrong

`poly doctor` checks this computer and says how to fix each gap it finds.

On Linux, Codex runs every command inside a bubblewrap sandbox, which needs unprivileged user
namespaces. Ubuntu 24.04 and later restrict those through AppArmor, and then every command Codex
runs fails before it starts. Polyphemus checks for this and, when it's the case, says so on Codex's card
in Models & providers with the fix: an AppArmor profile that allows namespaces for `bwrap` only, or
turning `kernel.apparmor_restrict_unprivileged_userns` off. It's a system setting, so you make the
change yourself; Polyphemus doesn't. To check by hand: `codex sandbox -- true` should exit without an error.
If you'd rather not change the machine, you can turn Codex's sandbox off on its card in Models &
providers: its commands then run with your full permissions, without asking.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): how to run it from a checkout, the checks every change
passes, and how releases work ([docs/RELEASING.md](docs/RELEASING.md)). The design lives in
[docs/DESIGN.md](docs/DESIGN.md) and [docs/design/](docs/design/).

## License

[Apache License 2.0](LICENSE).
