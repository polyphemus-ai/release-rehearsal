# An agent's computer (the remote desktop)

**Goal:** an agent can have a whole computer — a Linux desktop with a browser, a terminal and files —
that it works in and you can watch or take over, from a laptop or a phone. What Grok Bot and
Cursor's background agents show (seen 2026-09-18: an XFCE desktop with Chrome, a file manager and a
terminal on a dock, streamed into the app, with a trackpad mode, a keyboard button and a phone
clipboard), built Polyphemus's way: one computer per agent, not one shared by every bot on the account.

This is phase 6 of [computer-use.md](computer-use.md), which has the action schema, the provider
mappings and the safety defaults. This doc is the plan for building it.

## What Polyphemus already has

- **Containers per project** ([isolation.md](isolation.md)): Docker or Podman workers, egress only
  through Polyphemus's proxy (public addresses only), limits on CPU and memory.
- **The Browser connection:** Chromium in a container of its own, a built-in connection granted like
  any other, its tools reaching CLI agents through the connections gateway.
- **A live view you can drive** (`TabHands`, 2026-09-16; a real pointer and keyboard 2026-09-22): a
  JPEG of a tab, polled, driven with the pointer (hover, press, release, double-click), any key with
  its modifiers, a phone-sized or desktop-sized page, and taps and typing,
  keys and scrolling sent back — how a person signs in by hand without an agent seeing the password.

The desktop is the same pattern one level up: a container with a screen instead of a tab.

## Design

### The computer

- **An image of its own** (`polyphemus-desktop`): Debian slim, Xvfb at 1280×800, a small window
  manager (XFCE's xfwm4 and panel, or openbox with a dock), Chromium, a terminal, a file manager,
  `xdotool` and `scrot` for the agent's hands and eyes, and `x11vnc` for the stream.
- **One per agent** (the safety default): its home folder is a volume that persists, so its browser
  sign-ins, downloads and dotfiles are still there tomorrow. The project it's working in is mounted
  at `/workspace` while it's working there, and only then.
- **Egress through Polyphemus's proxy**, as workers do today: public addresses only, the count of
  open connections visible.
- **Hard limits, always:** memory (2 GB default), CPU, and how many desktops run at once (2 by
  default). This box ran out of memory on 2026-09-17; a desktop per agent must never be the thing
  that does it again. Over the limit, the oldest idle one sleeps.
- **On demand:** it starts when an agent or a person opens it, and sleeps (stopped, volume kept) after
  15 minutes with nothing happening. Waking takes a few seconds.

### Streaming it to you

- **VNC through Polyphemus, viewed with noVNC in the app.** `x11vnc` in the container; Polyphemus carries
  the stream over its own authenticated WebSocket (nothing listens on the tailnet but Polyphemus); the
  app draws it with noVNC. VNC is mature, does clipboard and scaling, and noVNC already handles
  touch.
- **Later, WebRTC** (as `neko` does) for smoother video on a phone. Worth it once people watch long
  sessions; not needed to start.

### The agent's hands

- **A built-in connection, Computer,** granted like Browser. Its tools — `screenshot`, `click`,
  `type`, `key`, `scroll`, `drag`, `zoom`, plus `run` for a command in its terminal — are the
  canonical schema in computer-use.md, run with `xdotool` inside the container.
- **Every model can use it:** Anthropic's computer tool and OpenAI's `computer` map onto the same
  actions natively; everything else (Grok, open models, CLI agents through the gateway) gets them as
  ordinary tools, screenshots as images.
- **What's on the screen is untrusted input,** as with web pages. Buying, sending, posting,
  deleting and accepting terms ask first.

### Watching and taking over

- **In the thread:** when the agent has a computer, the thread's head gets a screen button (Grok's
  top-right monitor). It opens the desktop full-screen, live.
- **Watch** is the default: you see what it does, and your input goes nowhere.
- **Take over** pauses the agent's hands and gives you the mouse and keyboard; **Hand back** returns
  them, and the agent is told what changed while you had it ("the person signed in to Stripe").
- **On a phone:** tap to click, two fingers to scroll and right-click, pinch to zoom; a trackpad
  mode (your finger moves a pointer) for precise work; a keyboard button; a clipboard sheet (Copy to
  phone, Paste from phone); and a one-screen "Using the computer" help — Grok's is the model.
- **Files:** anything attached in the thread lands in the desktop's `/workspace/attachments`; a file
  the agent saves to `~/Outbox` shows in the thread to download.

## Build order

| Step | What you can do after it |
|---|---|
| D1 | The image, starting and sleeping it, limits, and the viewer: open an agent's computer from its profile, watch and take over. No agent control yet. |
| D2 (built 2026-09-18) | The Computer connection: look, click, type, key, scroll, drag, open, run — each acting tool answering with the screen after it; always the calling agent's own computer; "can use it" on the agent's page grants it to that agent; taking over holds the agent's hands until it's given back (or the viewer closes); the app offers to show the computer when the agent starts using it. |
| D3 (built 2026-09-18) | Phone controls under the computer: the phone's own keyboard, a Keys sheet (Esc, Tab, arrows, Ctrl shortcuts), the clipboard both ways, a trackpad mode (tap clicks where the pointer is, tap-then-hold drags), and a "Using the computer" help sheet. Using any of them takes the computer over. Direct touch (tap, two-finger scroll, press-and-hold right-click) is noVNC's own. |
| D4a (built 2026-09-18) | Files in and out: the Files tool lists its Downloads and Desktop to download, and sends a file into Downloads; the agent's take_attachment puts a thread's file on its computer and give_file hands one back into the thread's folder. Nothing reaches outside those folders. |
| D4b (built 2026-09-18) | Teaching by showing: Record, do the task, Stop — each click with a picture of what was clicked, typing, keys (with Ctrl/Alt) and scrolls — then "Teach it this" hands the agent the steps and up to six pictures in a thread of their own, asking it to propose a skill (and a routine if it's for a schedule), which the person approves as usual. |
| D4c | A hosted option (E2B Desktop or similar) for a computer that isn't this one — needs an account with the provider. **Deferred (2026-09-19):** Docker covers it for now; build it once Polyphemus needs to run where Docker can't. |

## Decided (2026-09-18)

1. **One computer per agent,** and only one: its sign-ins and habits travel with it.
2. **The owner opens and takes over any agent's computer;** project members can watch (not take
   over) in their project's threads.
3. **2 GB each, and at most two awake at once** across all agents; waking a third puts the one idle
   longest to sleep.
