# Roadmap

**This file decides the order; the design docs decide the detail.** It says what's true now: where
things stand, what's being built, what's next, and every known gap in one place. How each piece was
built, phase by phase, is in [roadmap-history.md](roadmap-history.md). Reviewed and rewritten
2026-09-13; brought up to date 2026-09-21.

## What it's for

**An open-source agent harness with an experience like Grok Bot, that lets you use any provider or
model — bring your own tokens — and understand autonomous work without managing its sessions.**
The owner, 2026-09-12 (it began as an alternative to OpenClaw).

What that pins down:

- **General-purpose.** A project is any body of work. Building and running software autonomously —
  from feedback and audits through deployment — is the demanding test case, not the boundary.
- **Grok Bot's four pillars are the product:** persistent agents with personalities, proactive
  scheduled work, integrations that take actions, and an interface that organises it.
- **Connections (MCP) are core**: they're how a general-purpose platform gets domain capabilities.
- **Multiplayer is a launch requirement**, and permissions work at agent, thread and project scope.

The test for anything we build: **can you see who's working, what they can reach, what changed, what
evidence there is, and what needs a decision — from your phone?**

## Where things stand

| Milestone | What it means | |
|---|---|---|
| **Terminal** | The loop, tools, sessions; Claude, OpenAI and Grok APIs and the Claude Code, Codex and Grok CLIs | ✅ |
| **Your phone** | The daemon, the web app, pairing, push, HTTPS over your tailnet, the background service | ✅ |
| **Projects and agents** | Projects, orientation and review, memory and handoffs, skills, the vault, routines, capacity forecasts, routing with fallback, agents as files | ✅ |
| **Models from the phone** | Models & providers, first-run setup, fallback that won't start a per-token bill unasked, managing threads, several agents in a thread | ✅ |
| **Trust what's there** | The holes the independent assessment found | ✅ |
| **The settled UI brief** | Identity, Home, connections and grants, outcomes and runs, starting something, work-shaped surfaces | ✅ |
| **Show and connect** | Artifacts in threads; a connections catalogue; Notion, GitHub, Google Drive and Gmail | ✅ |
| **It does the work** | The workflow engine; `loop`, `ship-issue`, `spec`, `intake`; GitHub identities of Polyphemus's own | ✅ — proven on a real repository |
| **Finding your way** | Home grouped and filtered, project Work/Setup tabs, marks that say who, a default agent, people talking without agents interrupting | ✅ |
| **Agents that do more** | An agent's own computer (watch it, take it over, teach it by showing), skills of its own and a library of 800, memory that carries across projects, files in and out of threads, people and agents in conversations | ✅ 2026-09-17 to 19 |
| **Worker isolation** | Agents' commands and files in a container with only what was granted; the vendor CLIs' tools sent there; a level the owner picks | ✅ 2026-09-16 |
| **Reviewed from outside** | Independent review passes on 2026-09-19 and 20. There were three security passes, then passes on the new features, the workflow engine, connections and secrets, and the app and the daemon's surface. Every finding reproduced at the time is fixed with a test, or is listed under Backlog as a deliberate call | ✅ |
| **Ready to publish** | One npm package, releases, update checks, macOS, a repository with nothing private, docs for contributors | **Now** — built; publishing waits on accounts |
| **Ready for other people** | Multiplayer to a public standard: release tests for who can do what | **Now**, alongside publishing |
| **It gets better at it** | Memory that consolidates, the steward, the store, a workflow catalogue | Later |

## Now: publish

Everything that can be built is built (see [RELEASING.md](../RELEASING.md) and the history): a
bundled `polyphemus` package with a pack check, changesets and CI on Linux and macOS, a release workflow
with provenance, daily update checks and `poly update`, a launchd service on macOS, the leak check
and the public export, README, CONTRIBUTING, SECURITY, Apache-2.0, and AGENTS.md and DEVELOPING.md
for whoever picks the work up next.

Left, in order:

1. ~~**The name.**~~ Polyphemus, on polyphemus.ai (2026-09-21).
2. **Accounts** (the owner): a GitHub organisation and empty repository (`polyphemus` itself is taken
   there), the npm package's trusted publisher, private vulnerability reporting on. *Under way
   (2026-09-23):* a public stand-in package, kept apart from Polyphemus, rehearses the release
   (see RELEASING.md). Polyphemus gets a GitHub account and organisation of its own. Done the same day: mail for polyphemus.ai (Google Workspace, with SPF, DKIM
   and DMARC; `releases@`, `security@`, `hello@` and `dmarc@` as aliases), the npm account
   `polyphemus-releases` (on the releases alias, passkey two-factor) and the npm organisation
   `polyphemus`, which holds the `@polyphemus` scope the code's own package names use; and
   `polyphemus` claimed on npm with a placeholder, 0.0.1. Next: the trusted publisher (once the
   public repository exists), and the GitHub organisation's switch letting Actions open pull
   requests.
3. **The first public commit:** repository, homepage and bugs links in the package (they wait on the
   organisation's name); then
   `scripts/export-public.mjs <folder> --commit --author "<brand> <address>"`, pushed by the owner.
4. **First runs:** CI on Linux and macOS (the launchd service has only been tested on paper), then a
   first changeset and release. Ready for it (2026-09-21): update channels (`poly update --channel
   beta|stable`), the install script (`install/install.sh`, tested here with both this computer's
   Node and a downloaded one, and in CI on both systems), a GitHub release per version with the
   script attached, and polyphemus.ai in About and the package. Still to do: the repository and bugs
   links (they wait on where the public repository lives), and the desktop apps and Windows doors
   from the install decision (6badb8b).
5. **Development moves to the public repository:** the private copy is archived; clone the public one
   back to the same path, and run `node scripts/install-hooks.mjs`.

## Now, alongside publishing: who can do what, proven

Worker isolation is built ([isolation.md](isolation.md)); three outside review passes on 2026-09-19
found gaps route by route, which is the case for proving access as a whole rather than per route:

1. ~~**Release tests for access**~~ built 2026-09-19 (`packages/daemon/test/access-matrix.test.ts`):
   every API route called as the owner, a member, a viewer, someone with no role, a removed person, a
   signed-out device and no device, against Shop, Lab and a thread outside every project; everyone a
   route doesn't name must be refused, and a route missing from the table fails the test. It found an
   agent's carried connections readable by someone with no role, fixed. Streams and computer views
   closing on sign-out are covered in access.test.ts and agents.test.ts.
2. ~~**A review of the workflow engine**~~ done 2026-09-20
   ([reviews/workflow-engine-prompt.md](../reviews/workflow-engine-prompt.md)). Five findings were
   fixed with tests. A merge goes only into the branch that was approved, a run's folder can't
   borrow another repository's objects, and the preview's pictures are of what the run built. The
   judgement calls are under Backlog. Connections and secrets, and the app and the daemon's surface,
   were reviewed the same day ([reviews/](../reviews/README.md)).

## Next

Recommended order, to confirm with the owner:

1. **Browser use, next steps** ([computer-use.md](computer-use.md)). Shipping opens the pages it
   changed, agents drive a browser through the Browser connection, models see the pictures tools
   return, and sign-ins are kept (see Recently shipped). Next: comparing a page before and after a
   change, and Anthropic's and OpenAI's native computer-use tools.
2. ~~**Multiplayer basics:** invitations from the app instead of the terminal, and people and roles
   managed on a project's Setup tab.~~ *Built 2026-09-17:* Team lists the people who use this install,
   invites one (a name, then a code they type into Polyphemus on their phone, with a way to pair another
   device later), and removes one; a project's Setup tab gives, changes and takes away member and
   viewer roles. Still to come for 1.0: the release tests that prove a person can't read, answer or run
   what they shouldn't, including over a connection left open after revocation.

## Before launch (1.0): ready for other people

- ~~**Worker isolation**~~ built 2026-09-16 ([isolation.md](isolation.md)).
- **Multiplayer to a public standard:** invitations, membership, a small role set, deploy and data
  operations as separate capabilities, every read/write/stream/approval checked centrally, and release
  tests that prove a person can't read, answer or run what they shouldn't — including over an open
  connection after revocation. The trap still holds: a private credential granted to a shared agent
  leaks by proxy ([secrets.md](secrets.md#multiplayer-whose-secret-whose-bot-phase-8)).
- **Hosting for multiplayer:** a company that can't run Tailscale needs server mode, single sign-on
  with work accounts, company model accounts with limits, and worker isolation; IT configures a VM, a
  name and certificate, a sign-on app and a way in, once. Banked in [hosting.md](hosting.md) (2026-09-13).
- Diagnostics you can read, onboarding from a fresh install to a finished task, and honest
  per-provider capability and data-destination labels.
- A release test that opens an older install's data, and a state backup.

## Later: it gets better at it

- **Memory** that consolidates ("sleep"), with a browser in the app ([memory.md](memory.md)).
- **The steward**, which reviews how agents worked together and proposes into the review inbox.
- **The store** for agents, skills and workflows, with review and pinned versions — they're
  instructions plus code ([agents.md](agents.md#templates-and-the-store)).
- **A workflow catalogue**, in three steps: more built-in templates you configure (a weekly report,
  inbox triage, a data clean-up); your own workflow files ([workflows.md](workflows.md#custom-workflows));
  shared ones from the store, untrusted until reviewed.
- **A workflow with no repository** — one that runs on connections and files, with data checks that
  don't trust an exit code. Banked until a real, repeatable job is picked.
- **A hosted computer** for an agent (E2B or similar), for installs without Docker. Deferred
  2026-09-19: Docker covers it until Polyphemus needs to run where it can't ([desktop.md](desktop.md)).
- **The same install doors on macOS, Linux, and Windows** (decided 2026-09-21). The phone stays
  the web app. A download is an app that installs Node, the daemon, and opens Polyphemus — the app
  we already have, not a second chat.
  - **Apps:** macOS universal; Windows x64 and ARM64; Linux AppImage and `.deb`.
  - **One-liner:** `curl | bash` on macOS and Linux, PowerShell on Windows. These install Node when
    it isn’t there.
  - **npm and pnpm:** a global install, then onboarding.
  - **From source:** those scripts with a git install method, or clone and `pnpm install`.
  - **Updates** can follow a dev channel or a stable one.
  On Windows the app and the one-liner offer a native daemon and a WSL setup. The native daemon
  does not install WSL. Choosing isolation later is Docker’s own installer, which uses WSL2 on
  Windows. Publishing still waits on the GitHub org and the npm publisher.

## Backlog: known gaps

Everything a phase or a side quest left undone, in one list. Small ones get picked up alongside
related work; anything bigger moves up into Next.

**Workflows and runs**
- Take open GitHub issues in as incoming, and let a routine send its output to incoming without an
  agent choosing to.
- A gate that's waiting when Polyphemus restarts is asked again rather than simply kept.
- Custom workflow files; token budgets per node; heartbeats for long CLI jobs.
- A planned run (not a workflow) resumes from its last step instead of starting over; a step handed
  to a different agent; routines starting threads with outcomes; retries beyond model fallback.

**Agents and threads**
- `@team`; token budgets and quiet hours in the guard.
- **Isolated Grok has no gateway** (no connections, no `show_artifact`). Grok on this computer has it
  since 2026-09-22, over ACP's `mcpServers`, checked against the real CLI (1.0.40). Isolated Codex
  has the same gap (its exec-server starts no MCP servers). Untested: whether Grok asks its own
  permission for a gateway tool that changes something, which would ask the person twice.
- Claude Code's own question form (`AskUserQuestion`) is turned off, because nobody can answer it
  from a thread (2026-09-21). It could become a Polyphemus question that any client answers, the way
  approvals are.
- An image picked for a draft is uploaded even if the draft is abandoned.

**Connections**
- **Asking for a secret in a thread** is built (2026-09-21; design in
  [secrets.md](secrets.md#asking-for-a-secret-in-a-thread-built-2026-09-21-except-the-broker)). It
  needs the broker before an agent can use a general secret in a command. A sign-in from a thread is
  built the same day. Still open for browser sign-ins: a sign-in used by one agent only; “acts as the
  owner” with an OK per use, instead of holding a sign-in back in a shared project.
- **A site that refuses a browser polyphemus drives** (banked 2026-09-22). Chrome sets
  `navigator.webdriver` to true whenever something drives it over the DevTools protocol — in a
  window on your own screen exactly as in a headless one — and any site reads it in a line. Garmin's
  own `/portal/api/login` answers 403 to it, after the “verify you are human” check has been passed
  by hand. Withings doesn't look, and works. So a hand sign-in works for sites that don't probe for
  automation and can never work for ones that do: the only way past is to make Chrome lie about it,
  which is fingerprint evasion and is not something polyphemus does. Two ways to pick up later, both
  banked: say so plainly when a sign-in fails this way, rather than showing a swirl or a raw 403;
  and take the session for one site out of the person's own browser profile, straight to the vault,
  which is the only route that reaches such a site without evasion (an encrypted cookie store, the
  OS keyring and LevelDB, per platform, with Chrome closed).
- A per-project admin who can grant; `poly connections` in the terminal.
- Gmail sending and Drive changes (behind a gate); Calendar. Google is tested only against a stand-in.
- Real logos in the catalogue; an artifact's link to its step; SVG and HTML thumbnails on Home.

**From the landscape** ([landscape.md](landscape.md), 2026-09-16) — ideas worth having, our way
- Spend caps and a usage ledger (a monthly limit that refuses turns, and who spent what).
- Workflows and teams as portable files, installed with connections off and routines paused.
- A memory budget you can see, with an undo journal.
- Busy means wait and resume, never fail, when an agent is busy in another thread.
- A webhook receiver of Polyphemus's own, separate from the app's API.
- **Other ways in than Tailscale** (banked 2026-09-23, the owner): a computer with a static
  address, or a server (an EC2 box, say) with a domain pointed at it. Tailscale stays optional
  today (`POLYPHEMUS_TAILSCALE=off`), but it's the only way a phone reaches Polyphemus, and the
  rule that the daemon listens only on 127.0.0.1 and the Tailscale address exists because a tailnet
  is private. A public address needs its own answer first: TLS, sign-in stronger than a paired
  cookie, and the same-origin check kept — the server mode in [hosting.md](hosting.md).
- Which way out: where a browser or sandbox connects from, once there's a server or isolation ([computer-use.md](computer-use.md#which-way-out-banked-2026-09-16)).

**To study** ([study-reach-and-projects.md](study-reach-and-projects.md), 2026-09-19)
- Moving a thread into (and out of, and between) projects; reference folders a project reads but
  can't change; saying in the app what an agent in a thread can reach.

**The app**
- **Spin-outs in the third panel** (asked for 2026-09-22): a thread's spin-outs and the threads it
  was spun from, and a workflow's step threads, open beside it in the draggable third panel the
  computer view uses, rather than replacing the thread. On a phone, where there's no third panel,
  they stay a tap away as now.
- An agent in a thread outside every project can now ask for a routine (2026-09-20, from a real
  one that couldn't and told the owner to run a CLI command that doesn't exist). What it still
  can't do from there: say where else it could run, or propose one for a project it isn't in.


- Nothing automated watches how the app *behaves*, only that every screen draws: `smoke.mjs` loads
  each route in a real browser and checks for errors and missing text. Tapping a message in the
  flow, then sending a message, dragged the thread back to the tapped message every time it drew —
  found by the owner, not by a test (2026-09-20). Driving the app (tap, type, send, and assert what
  moved) needs a harness smoke doesn't have.

**From the review of the app and the daemon's surface** (2026-09-20)
- Pairing's lockout is global: twenty wrong codes pause pairing for everyone for a few minutes.
  That's the cheap way to stop a short code being guessed, and the cost is that anyone who can reach
  the pair page can stop a new phone being added for a while. Per-address would weaken the first to
  fix the second. Left as it is, deliberately, until someone is actually inconvenienced.

**From the review of connections and secrets** (2026-09-20)
- The trap in [secrets.md](secrets.md#multiplayer-whose-secret-whose-bot-phase-8) is still open for
  MCP connections, as that section says: the actor is recorded on every call, not checked against
  whose credential it is. Browser sign-ins already refuse (held back in a shared project). Closing
  it for MCP is part of multiplayer to a public standard.
- A server can declare a writing tool read-only (`readOnlyHint`) and skip the ask. Polyphemus takes the
  server's word for what reads, and the grant sheet's "Only reads" default follows it. Trusting a
  built-in over a third-party server, or asking once per tool, is a product decision.

**From the review of the workflow engine** (2026-09-20)
- A dev command that outlives `stop()`: the kill goes to the child's process group, so one that calls
  `setsid` survives, and a daemon restart orphans it. It's a dev server left on loopback, and killing
  a detached process portably needs more than a group signal.
- What a person approves for checks and the preview is the command (`pnpm test`), not the script body
  it runs, which the build node rewrites each round. Binding consent to the body means re-asking
  whenever a project edits its own scripts — a product decision, not a patch.
- Checks run under a login shell with a writable HOME in the worker, so a planted `.profile` changes
  PATH for later checks. A non-login shell would close it and break every project that relies on
  nvm-style setup.
- Zero check-runs on GitHub reads as "nothing failing" and merges; and the "different identity"
  a merge requires is Polyphemus's own Reviewer bot echoing a model's verdict, so inside Polyphemus the
  only non-model consent at a merge is a person's yes. Both are true of the design, not bugs in it —
  they belong in [workflows.md](workflows.md) rather than in a fix.

**From the security reviews** (2026-09-19)
- `keepArtifact` follows a link when it's given no folder to read within — which is every call
  outside a worker. Nothing crosses a boundary (an agent that isn't isolated can read the file
  itself, and the credential guard resolves links before it decides), so it's a tidy-up: contain it
  to the folder the path came from. Checked again 2026-09-20.
- On macOS, the link protection checks each folder rather than holding it open: a link already there
  is refused, one swapped in at exactly the wrong moment isn't caught.
- Codex never asks before acting, in any mode: it's labelled "Doesn't ask", not changed.
- Library skills are fetched from each source's current version, not a pinned one.

**The code**
- Permission modes (Ask/YOLO) as contracts mapped per vendor CLI.
- Cancelling a whole process tree; model switches queued for the next turn.
- Versioned migrations; splitting `server.ts` and `app.js` as work touches them.

## Shipped 2026-09-22

- **One command from installing to setup.** `poly start` runs Polyphemus in the background, pairs
  this computer and opens the setup wizard. The wizard was unreachable on a new install anyway: it
  checked whether any models were listed rather than picked, and a new install lists six.
- **`poly doctor`**: what this computer has and lacks — Node, git, the vendor CLIs and whether
  they're signed in, Codex's sandbox, Docker or Podman against the isolation level, Tailscale and
  its HTTPS address, paired phones, a browser — each gap with its fix, JSON for agents, and exit 1
  when something stops Polyphemus working. The detection was the app's; now a terminal has it too.
- **Installing is tested on a machine with nothing on it** (Ubuntu, Debian, Fedora in CI), and
  refuses Alpine plainly: nodejs.org's builds need glibc.
- **Windows through WSL2 works, phone included** (2026-09-23, a Windows 11 computer, Ubuntu 26.04
  in WSL 2.7.14). The check (`scripts/windows-kit.sh`, DEVELOPING.md) installed Polyphemus in WSL,
  ran it as a service under systemd, reached it from Windows at 127.0.0.1, and reached it from the
  tailnet over HTTPS with Tailscale on Windows serving it (`tailscale serve --https=443
  http://127.0.0.1:3900`, run on Windows). Not directly at the tailnet address: WSL forwards only
  Windows's own localhost. It asks before updating the WSL built into Windows, installing WSL or
  Ubuntu, or turning systemd on, and stops on no. Since then, inside WSL: the daemon finds Tailscale on
  Windows (`tailscale.exe`) and points its HTTPS address here itself, listening on the tailnet
  address only where it's this machine's; `poly doctor` says Tailscale runs on Windows and that
  HTTPS is the only way in from WSL; and Windows's own builds of Claude Code, Codex and Grok Build,
  on WSL's PATH under /mnt/c, no longer pass for Linux ones. Checked on that Windows computer since
  (2026-09-23): Polyphemus set Tailscale HTTPS up itself from the service in WSL, Grok was installed
  and signed in inside WSL (`grok login --device-auth`), and a thread with Grok ran commands after
  asking. And `poly start` opens setup in Windows's browser, through PowerShell's
  Start-Process (explorer.exe opened nothing), seen by the check as a newly paired device.
  **`install.ps1`**, the Windows one-liner (`irm https://polyphemus.ai/install.ps1 | iex`), is the
  check's install path made the product's: WSL, Ubuntu and systemd each asked about and fixed, then
  install.sh inside WSL (which asks about the subscription CLIs), then `poly start`. Not yet run on a
  Windows computer from nothing: next, on one with WSL removed.

- **A sign-in to a site that doesn’t use cookies is kept.** Some sites hold your whole session in
  the browser’s own storage rather than in a cookie. Keeping one used to refuse with “hasn’t set
  anything to keep yet” after a sign-in that plainly worked; now what the site stored goes to the
  vault beside the cookies, is put back before the page’s scripts run, and is masked in anything a
  tool returns whatever the site calls it. Not `sessionStorage`, which dies with the tab for anyone.
- **The sign-in browser is the one on your computer**, in a window, when there’s a screen for it:
  headless Chrome says so in its own user agent and a site’s “verify you are human” check refuses
  it however you click. Polyphemus works around no such check; where one refuses the computer it
  runs on, that site can’t be signed in there.

## Shipped 2026-09-21

- **A secret from a thread.** An agent asks with `request_secret`. A card in Waiting on you takes
  the value into the vault and hands back only `secret:name`. A key pasted into a message is offered
  the same place before it is sent. Who it was saved for is recorded. Nothing puts that value into
  a command yet — that is the broker, still to come.
- **A sign-in from a thread.** An agent asks with `request_sign_in`. The card opens the service’s
  own sign-in, or the browser on this computer for a site, and you come back to that thread. The
  agent hears that you finished, never the token or the cookies, and whether a site sign-in is held
  back because other people are in the project.
- **Grok asks before a command, a page, or a file outside the project.** On this computer those
  were dying with “User cancelled”, though nobody pressed stop. The question now reaches you, and a
  tool that doesn’t run says why.
- **A project can be renamed** from its Setup tab. The name everywhere changes. The address, the
  folder, and the short name stay.
- **A DM stays a DM.** When the agent you’re talking with, outside every project, asks to bring
  another in, saying yes starts a new thread with both of them. The conversation you were in stays
  just the two of you, and links to the new one.

## Recently shipped (2026-09-20)

- **More than one agent works in a thread** ([parallel-agents.md](parallel-agents.md)): an agent
  @mentioned while another is working answers alongside, with a runtime of its own; each working
  agent shows with its own Stop. What's stored stays in the order it happened; what a model is sent
  keeps each tool call next to its answer, and every runtime re-reads the thread before its turn.
- **Messages queue instead of being refused** while a thread works: held in order in the database,
  shown under the thread, taken back or sent now (to an idle agent it goes alongside, stopping
  nothing), delivered as their sender when the thread is free, and kept across a restart.
- **How a thread flowed:** a graph (a lane per actor, a curve wherever it passed from one to another)
  or a timeline (time left to right), from the thread's ⋯ sheet. Tapping anything opens that message.
- **Release tests for access:** one table of every route with who may use it; everyone else must be
  refused. It found an agent's reach readable by someone with no role.
- **What the review of parallel agents found, fixed:** an agent CLI is told what another agent said
  while it was working (what it had seen was counted in one runtime's copy of the thread, so anything
  written alongside it was skipped for ever); a thread holds at most 50 messages waiting, 20 from any
  one person, and says so; reading how a thread flowed doesn't read every message again; and the
  folder a retried run sets aside is cleared out — the newest kept for a week, the rest gone.
- **Independent reviews:** three passes on 09-19 (files agents write, routines, agents in threads,
  merge evidence) and one on 09-20 of the new features, which found the interleaved-history problem
  above. The third pass was cut off by its vendor's filter with its report unwritten; it arrived on
  09-20, and of its nine findings six were already closed by the fixes made that afternoon. The three
  that weren't are now fixed with tests: ripgrep ran a program for `--hostname-bin` without asking
  (the read-only list now says what's allowed, so a later version's option asks); an agent in your
  library was written through a link left in its folder; and a pipe left in `~/.polyphemus` stopped
  Polyphemus reading its agents and skills at all. Every finding fixed with a test.

## Shipped just before (2026-09-17 to 19)

- **An agent's own computer** ([desktop.md](desktop.md)): a Linux desktop per agent in a container,
  2 GB each and two awake at most. The owner watches it beside the chat and takes it over (phone
  controls included); the agent uses it through the Computer connection (look, click, type, run);
  files go in and out; and a person can record doing a task there for the agent to learn from.
- **Skills:** an agent's own, proposed by agents and kept only when a person says where; a library of
  about 800 from open sources, installed with their licences.
- **Memory** that carries craft across projects and keeps what a person said alone out of shared rooms
  ([memory.md](memory.md)); routines and profile changes proposed by agents, accepted by people.
- **People and agents:** invite people and set roles from the app; people message each other in
  Direct; agents know their teammates and ask to bring one in; @mentions as chips; profiles for people.
- **Models and providers:** the models list is the limit on what runs; shipped providers are offers you
  accept; twenty more providers and ninety connections; Finance through Plaid or SimpleFIN.
- **The app:** attach any file; a project opens beside its own list; emoji and reactions; agents come
  alive while working; a draggable third panel.
- **Three security review passes** (2026-09-19), everything found fixed with tests: files agents write
  are reached only from folders they can't replace, never through a link; read-only commands can't be
  steered by the shell; project routines run only as accepted; agents join threads by one rule; nothing
  private in what's published. See the decisions log in [DESIGN.md](../DESIGN.md).

## Shipped earlier (2026-09-13 to 16)

Side quests and follow-ups since the phases in the history, so they aren't lost:

- **Shipping for real:** `ship-issue` ran end to end on a real repository (three issues merged).
  Found and fixed on the way: a reviewer's approval only counts with write access; reviews picked
  from another vendor using the models you selected; Polyphemus's own servers found wherever the install
  keeps them; a private repository cloned as an identity; project rules handed to every CLI in a
  worktree; an agent's shell can't push inside a run; one run per issue; checks found in the repository
  instead of asked for; run steps that read as what happened.
- **Finding your way** ([decisions](ui/finding-your-way-decisions.md)): Home grouped by time, project
  or agent; a project scopes Home with a chip; the list doesn't reorder under you; machine-made threads
  roll up; marks never show a model; project Work and Setup tabs; one + to start things.
- **A default agent** (Helm), named and voiced at setup; **people in a thread talk to each other** —
  agents answer when @mentioned, or when a thread says to answer everything; @ offers people.
- **Setup:** models and connections first; sign out other devices from the app; the connection dot on
  the logo; an About section with the version.
- **Safety:** what a service checked about a credential can't be overwritten by a declaration; a
  second Polyphemus never takes the tailnet address from a running one (`POLYPHEMUS_TAILSCALE=off` for tests).
- **Intake** files issues with a Ship button on each.
- **Ship several issues:** `ship-issue` takes a “Then” list; each issue starts from the base the one
  before it merged into and stops at its own merge. A failure or a merge sent back stops the queue,
  says what's waiting and offers “Ship the rest”; intake's filed issues get “Ship all, in order”.
- **Shipping looks at what it built** (2026-09-14): the plan names the pages a change affects; every
  round poly serves the site from the worktree and opens each page at 400px and 1280px in headless
  Chrome. A page that doesn't load, answers an error or throws sends the round back. The pictures
  stay on the step, the reviewer is handed them, and the merge question points to them. A serve command
  from the project is shown before it first runs, and one nobody saw is refused.
- **The Browser connection** (2026-09-14): agents open public pages, read them as text with refs, click,
  type, scroll and take screenshots, through a built-in connection granted like any other — reading
  and acting are separate tools, and acting asks first in Ask mode. Each thread gets its own browser
  with no logins; requests to this computer, private networks and tailnets are blocked.
- **Models see pictures tools return** (2026-09-14): a screenshot, an image a connected service sends,
  or an image file an agent reads goes to the model as a picture — on Claude, OpenAI and
  OpenAI-compatible APIs, and to Claude Code and Codex through the gateway — and shows with the
  result in the thread.

- **Sign-ins agents' browsers keep** (2026-09-16): on the Browser connection, a person signs in to a
  site by hand in a live view — a picture of a browser on Polyphemus's computer, tapped and typed into
  from the phone — and Polyphemus keeps the cookies in the vault. Agents' browsers in the projects the
  owner picks start signed in; the model never sees the password or the cookies (their values are
  masked in tool results), and cookies the site refreshes are saved back. A sign-in is held back in
  any project where someone besides its owner has a role, and the model is told why.
- **Quota errors end, and Codex's sandbox is checked** (2026-09-16): a quota error with no reset
  time keeps a provider out for an hour, not forever; and Polyphemus notices when Codex's Linux sandbox
  can't start here (Ubuntu's AppArmor userns restriction) and shows the owner the fix. The owner can
  turn Codex's sandbox off on its card (off by default, said plainly, read-only work keeps it), and
  set how long a quota error keeps a provider out (`routing.quota_retry_minutes`, on Defaults & fallback).
- **SuperGrok usage from xAI** (2026-09-16): the Grok CLI's plan usage, from xAI's billing endpoint with
  the CLI's own sign-in (the owner's one exception to never using a subscription token outside its CLI),
  every 5 minutes; a reading with room ends an earlier quota error straight away.

- **Who's here, and who answers** (2026-09-16, from a real group thread that went wrong): who came
  and went — agents added or removed, people given or taken off the project — is kept and shown as a
  line in the thread, and told to agents; a message that names no agent gets no answer unless it's one
  agent and one person; a quoted `@name` doesn't hand the turn on; agents are told what each agent
  actually ran on when a fallback stood in, and how Polyphemus is really used (they'd been told about
  `/model` and `/status`, which only exist in the terminal, and passed them on as app instructions).

- **A connection can go to an agent, not only a project** (2026-09-17): a grant with no project is one
  the agent carries — wherever it works, a direct thread with it included, where connections reached
  nothing before — bounded by what the credential can do. Grant it from the connection or from the
  agent's own page; in a project the agent has what the project grants plus what it carries, and an
  agent's grant inside a project still only narrows that project's.

## Decisions and open questions

- **The name:** Polyphemus, with the domain, settled 2026-09-21 before the first public commit. The
  one-eyed giant: what's happening is watched, and said plainly. What you type is `poly`.
- **License:** Apache-2.0 (2026-09-13).
- **The web app stays the app** for now (2026-09-13).
- **Work items:** a work item is a thread that has grown an outcome; nothing above threads (settled brief).
- **Providers as packages?** Catalogue data while an OpenAI-compatible entry is enough; a provider that
  needs code becomes something a plugin contributes, treated as untrusted code.
- **Hosting for multiplayer:** a company server behind single sign-on is the likely shape ([hosting.md](hosting.md)); details open until a real deployment.
- **What Polyphemus is for, next to what else exists:** not another open Grok Bot — work you can trust:
  credentials no model can reach, changes that arrive with evidence, permissions that hold for a team
  ([landscape.md](landscape.md), 2026-09-16). Native apps, voice and cloud desktops are deliberately
  not being chased.
- **Is anything shared between a thread and its project's other threads?** A memory question.
