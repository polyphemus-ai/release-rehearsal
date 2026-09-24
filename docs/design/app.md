# The app

**Goal:** a multi-provider app on par with the Codex app and Grok Bot, on Windows, Linux,
Android, and iOS. It's voice-first, so you're not tied to a keyboard, a mouse, or even your
phone, and you can always tell what every bot is doing.

## The reference experience

You pointed at OpenAI's **GPT-6 Astra** launch video
([x.com/OpenAI/status/2095595741528125780](https://x.com/OpenAI/status/2095595741528125780),
2026-09-03) as the experience you want. In it, someone sits in a chair and *talks* to their
computer while the agent works through spreadsheets, forms, web pages, and even a KiCad
circuit-board layout, "often at superhuman speed" (per
[Fortune](https://fortune.com/2026/09/03/openai-debuts-gpt-6-astra-computer-use-greg-brockman-says-start-of-agi/)).
The launch framed this as not having to "click around a mouse or type on a keyboard ever
again" ([VentureBeat](https://venturebeat.com/technology/welcome-to-the-agi-era-openai-launches-gpt-6-astra)).

What that means for Polyphemus:

- **Voice in, actions out.** You speak the goal, the computer does it, and you watch it happen.
- **Computer use on your own machine is the core feature,** not an add-on (see
  [computer-use.md](computer-use.md)).
- **Fast matters.** Actions should be visibly quick: prefer accessibility trees and batched
  actions over screenshot round trips. Use the fastest capable model for each step.
- **Unlike the demo, any provider:** Claude's computer toolset, GPT-6 Astra's `computer` tool,
  and generic tools for everything else, all behind one action schema.

## What went wrong in OpenClaw's UI

Your complaint is documented upstream:

- the chat page "shows exactly one session at a time" (openclaw#100690)
- labels are lost on reconnect because a new UUID is generated (#91664)
- "New session" does nothing (#10558)

The root cause is that clients owned session state. **Here the daemon is the single source
of truth**: stable session ids, an append-only event log, and clients that are thin views
able to resume from anywhere.

## Layout

The leaders have converged on this (Codex, Cursor 3, the Claude Code desktop redesign):

```
┌──────────────┬───────────────────────────┬──────────────────┐
│ Inbox        │ Conversation              │ Detail           │
│ ● needs you  │                           │ diff / artifacts │
│ ◐ working    │  messages, tool calls,    │ run graph        │
│ ○ idle       │  "recalled 2 notes",      │ capacity         │
│ grouped by   │  "why this model"         │                  │
│ project/bot  │                           │                  │
└──────────────┴───────────────────────────┴──────────────────┘
```

- **One inbox for everything:** sessions, bots, and workflow runs from every provider and
  every source (terminal, app, voice, schedule, GitHub). Each shows its status and where it
  came from, and can be filtered by status, project, or bot.
- **Bots are named teammates** (Grok Bot's model) for persistent work. **Sessions** are
  threads for one-off work. **Runs** are pipelines. Each is a distinct kind of item in the
  inbox, not three separate apps.
- **The dispatcher:** one always-there conversation you talk or type to. It starts, steers,
  and summarizes the others (Claude Dispatch, ChatGPT Voice's multi-agent mode). This is the
  front door for voice.
- **Housekeeping is automatic:** worktrees are cleaned up, sessions auto-archive when their
  PR merges, and nothing sprawls.
- **Switching must be instant.** Codex users complain that threads take seconds to minutes to
  open. We load from the local event log.

## What a conversation shows

Grok Bot's thread view (x.ai/bot, seen 2026-09-11) does four things worth taking:

- **A receipt, not a log.** When work finishes, one card says what actually happened, per
  service: `✓ Salesforce → list pulled · 52 accounts`, `✓ LinkedIn → 4 profiles skipped ·
  recently contacted`, `✓ Sequencer → 36 drafts queued · 0 sent`. We have the activity summary
  ("read 4 files, ran 2 commands"); the missing half is the **outcome per target, with counts**.
- **Other agents appear in your thread.** "Messages from ● Account Manager and ● Chief", then
  plain words: "Account Manager sent over the Acme + Globex threads and Chief flagged the
  priority accounts. Both are folded into tonight's list." Hand-offs surface where you're
  already reading, each with its mark, instead of hiding in another conversation.
- **Threads name themselves** from the work as it starts ("Renamed to Sales Outbound").
- **Nothing goes out until you've looked.** The bot says where the work is parked and what
  sending it would take ("The 36 drafts are sitting in the LinkedIn queue… Nothing goes out
  until you've had a look"). That promise is the product, not a setting.

In the list itself, each row's second line is the **last outcome** — "report filed. 9 receipts,
nothing out of policy" — not the last thing the model happened to say.

## Approvals, review, and notifications

- **Interrupt only when you're needed:** a gate, a question, a failure, or completion.
  Everything else stays in the log, with an optional daily digest.
- **One-tap approve or deny** straight from the push notification.
- **Progress shows on the lock screen** (iOS Live Activities, Android 16 Live Updates) with a
  single Stop button, so a stream of alerts isn't needed.
- **The phone is a remote control.** Execution stays on your daemon or sandboxes. Some safety
  controls can't be loosened from mobile (no "bypass approvals" toggle there).
- **Review:** on desktop, a real diff with view modes and inline comments that go back to the
  agent. On mobile, a **summary first**: what changed, check results, screenshots, and risk
  flags, with the raw diff one tap away.

## Voice

This is a real gap in the market: Grok Bot has no voice, and users ask for it.

- **Push-to-talk by default,** hands-free (wake word) as an option later.
- **Walkie-talkie style.** Hold, speak the *goal*, release. Bots report back with a short
  spoken summary when done ("the tests pass, the PR is up, and it needs your approval"), not
  a live narration.
- **Say what you want, not the syntax.** The dispatcher turns intent into commands, and code
  identifiers are resolved from context.
- **Architecture:** a realtime voice model is the front end. Its tools are daemon calls:
  `spawn`, `status`, `steer`, `approve`, `capacity`. Options are OpenAI's realtime models
  (WebRTC) or xAI's Grok Voice Agent API ($0.05/min). The work itself runs on whatever route
  each bot has. Voice minutes are metered separately and show up in capacity.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Source of truth | The **daemon** (home box or VPS): sessions, event log, runs, providers, broker | Clients stay thin; nothing gets lost |
| Mobile (iOS and Android) + web | **Expo (React Native)** | Push with actionable buttons, native modules for Live Activities and Live Updates, secure store. Happy and Omnara ship this way |
| Desktop (Windows and Linux; macOS free) | **Electron** | Chromium's microphone and WebRTC are consistent everywhere. Tauri 2 on Linux uses WebKitGTK, which is weaker for realtime voice, and its mobile tooling is still maturing |
| Shared | TypeScript packages for the protocol, state, and UI logic | One implementation of the event model |

**Decided 2026-09-10:** this replaces the original "Tauri 2 for everything" plan. Electron
costs memory, but voice reliability is the priority.

## Reaching your daemon

**Local-first:** the daemon, your sessions, the agent CLIs, and your credentials all live on
*your* machine (a desktop, a home server, or your own VPS). The phone and the desktop app are
remote controls. They never hold secrets and never run agents.

The transport and the trust are separate layers, so no one network trick is the only lock:

| Layer | What it does |
|---|---|
| **Transport** (pluggable) | How the phone reaches the daemon (options below) |
| **Device pairing** (always on) | Scan a QR code from `poly pair` once. Each device gets its own key; the daemon checks it on every connection and can revoke any device (`poly devices`) |
| **End-to-end encryption** (for relays) | Anything passing through a server we don't control is encrypted between the phone and the daemon |

| Transport | For | Notes |
|---|---|---|
| **Tailscale** | You now, and anyone comfortable with it | Private WireGuard network, no public ports, free for personal use. `poly serve` detects it and prints the address |
| **Cloudflare Tunnel** | People who already use Cloudflare | Outbound-only; pairing is still required |
| **LAN only** | At home, no remote access | The simplest option |
| **Encrypted relay** | Non-technical users: install, scan a QR code, done | The pattern the mobile coding apps use (Happy, Omnara, Claude Remote Control). The relay passes encrypted messages and never sees content or credentials. The project can run one, and anyone can self-host it |

**Hosted daemons** (your daemon in a cloud sandbox instead of on your machine) are a possible
later option. The rule that shapes them is that **each person uses their own subscription or
key.** Polyphemus never pools or resells anyone's login. Running your own Claude Code on your own
VPS is normal; running it as a service for other people isn't.

**Always on, with notifications (built).** `poly service install` runs the daemon as a
systemd user service that starts at boot, restarts if it crashes, and starts listening on
Tailscale whenever Tailscale comes up. The service runs **its own copy of Polyphemus**, one commit
per folder in `~/.polyphemus/releases/` with `current` pointing at the running one, never the
working copy being edited. `poly service update` builds a clean copy of the latest commit,
installs it, runs its tests (a failure changes nothing), waits until no session is mid-turn
(the daemon keeps `~/.polyphemus/daemon.json` current), then switches and restarts. Phones only allow notifications on HTTPS, so the daemon
sets up `tailscale serve` (HTTPS for your tailnet only, never Funnel) and `poly pair` hands
out that address. Notifications are standard Web Push: the daemon makes its own VAPID keys
(`~/.polyphemus/vapid.json`), and every message is encrypted for the phone, so the push service in
between (Google or Apple) can't read it. Phones get a push when a session asks a question (always)
and when a turn finishes or fails (unless Polyphemus is already open in front of you). Revoking a
device drops its subscriptions too. The web app can be installed to the home screen, which iOS
requires before it allows notifications.

**Build order:** M1 ships Tailscale plus device pairing. The relay and the rest follow once others
start using polyphemus.

## Anti-patterns to avoid

- sessions that vanish or don't sync between devices
- slow thread switching
- **silent stops at usage limits** (routing and capacity fix this)
- more than 3–5 parallel agents per person ("more agents doesn't mean more of *you*")
- confusing merge-back ("apply" vs "overwrite local")
- hidden activity
- features bolted on without being integrated

## Build order

| Phase | Work |
|---|---|
| 2 | Daemon with a WebSocket/HTTP API and the event log; the terminal becomes a client |
| 5 | Expo app (mobile and web) and Electron desktop: inbox, conversation, detail pane, approvals, push, Live Activities, capacity meters, push-to-talk dispatcher |
| 7 | Hands-free wake word, and memory and route editors polished |

## Key sources

Codex: [code review in the app](https://learn.chatgpt.com/docs/code-review?surface=app).
Claude Code: [desktop](https://code.claude.com/docs/en/desktop), [mobile](https://code.claude.com/docs/en/mobile).
[Grok Bot](https://x.ai/news/introducing-grok-bot).
[GitHub Mission Control](https://github.blog/changelog/2025-10-28-a-mission-control-to-assign-steer-and-track-copilot-coding-agent-tasks/),
[GitHub live notifications](https://github.blog/changelog/2026-02-26-github-mobile-track-coding-agent-progress-in-real-time-with-live-notifications/).
[Happy](https://github.com/slopus/happy), [Omnara](https://omnara.com).
[React Native Live Activities](https://www.freecodecamp.org/news/react-native-live-activities-handbook/).
OpenClaw UI issues: [#100690](https://github.com/openclaw/openclaw/issues/100690), [#91664](https://github.com/openclaw/openclaw/issues/91664), [#10558](https://github.com/openclaw/openclaw/issues/10558).

## How a thread flowed

A thread's ⋯ sheet opens **How it flowed**, which reads two ways — the one you last picked is the one
you get back.

**Graph** (the default, the shape of a git graph): a lane per actor, a row per thing said, a dot in
its speaker's lane, and a curve wherever the thread passed from one lane to another — a hand-off, or
a person asking. Each row says who, what, when, how long the turn took and what it cost.

**Timeline**: a row per actor (people and agents), time left to right,
and a bar for every turn in its agent's row — so two agents working at once read as two bars side by
side, and a gap reads as the thread waiting. Arrows join the end of one turn to the start of the
next where one agent handed on to another or a person asked; dots are what each said; an orange
diamond is where it waited on a person; a green tick is someone joining. Tapping anything says what
it was, in a line under the title. Stopped turns are drawn in the danger colour. The whole thread
fits to begin with, and zooming in makes it wider.

It's drawn from what's already kept: `turns` (now with the agent whose turn it was and who it
answered), messages and their actors, the answers to questions, and attendance. `GET
/api/sessions/:id/flow`.
