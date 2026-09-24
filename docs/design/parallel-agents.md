# More than one agent working in a thread

**Decided 2026-09-19** (the owner, from a thread where one agent had been working 38 minutes):
*"Reel is busy working, but I'd think I could still talk to the other agents."* That's right, and a
queue isn't the answer to it — a queue is for a message the same agent should get next.

## How it was

A thread had one runtime: one history in memory, one turn at a time. Everything anyone said went to
that turn, or waited for it (see the queue in [app.md](app.md)). Talking to a second agent meant
another thread.

## How it is

- **A turn belongs to an agent, not to the thread.** The thread keeps its own runtime (the lead's,
  as before) and gives any other agent addressed while that one is busy a runtime of its own, made
  from the thread as it stands. Each has its own model route, persona, skills and native CLI session.
- **They share the conversation.** Every runtime is opened with the thread's history and appends to
  it, so each agent sees what the others said up to the moment its turn began. Nothing is hidden
  from anyone in the thread.
- **Who takes a message:**
  - `@name` for an agent that isn't working: it answers now, alongside whoever else is working.
  - `@name` for an agent that *is* working: held (the queue), so it gets it next.
  - Nobody named: the lead takes it, as before; while the lead is working, it's held.
- **Stopping** is per agent: each working agent's row has its own stop. Stopping one leaves the
  others working.
- **Sending a held message now** still stops the lead's turn, because that's what it's for.

## Keeping the conversation whole (review, 2026-09-20)

Two agents working at once interleave their messages in the thread, which is what a person wants to
read — but a model needs each tool call answered by its own result, one after the other. So:

- **What's stored is what happened**, in the order it happened. The app shows that.
- **What a model is sent is stitched** (`stitchHistory`, core/src/history.ts): a result is moved up
  to its call, anything that came in between follows after, and a call nobody answered (a stopped
  turn) gets a result saying so.
- **Every runtime reads the thread again before each turn** (`syncHistory`), so an agent answers
  what everyone has said, not its own copy from when it opened.
- **A thread's detail comes from the thread**, not from one runtime's copy, so an agent answering
  alongside is never missing from it.
- Agents answering alongside are stopped when the thread is deleted or Polyphemus closes, and they
  count as working, so a deploy waits for them.

- **What a vendor CLI has seen is a position in the thread**, not a length of one runtime's array.
  A CLI keeps its own session and is passed whatever it missed since its last turn; counted in a
  runtime's own copy, everything another agent wrote alongside it was skipped for ever. It's counted
  in the thread as stored — from where a turn began, through what that turn wrote, stopping at the
  first message someone else put in between (`AgentSessionState.seenSeq`).
- **The queue is bounded:** 50 messages waiting in a thread, 20 from any one person, refused plainly
  after that. A queue nobody can catch up with isn't a queue.
- **Reading how a thread flowed** doesn't read every message again: the last answer stands while the
  number of messages, turns, comings and goings and answers is unchanged (and for a minute at most,
  so a name or a mark that changed still shows).

## What it doesn't do (on purpose, for now)

- **An agent answering alongside doesn't hand off.** Hand-offs (`@another` in a reply) and the guard
  that counts them belong to the thread's own line of work: the lead's. An agent working alongside
  replies, and stops. If its reply names someone, a person can bring them in.
- **No limit on how many work at once** beyond what the models and the isolation level allow. If that
  turns out to need a cap, it belongs next to the guard.
- **A workflow run still owns the thread while a step works.** Runs are a line of work with evidence;
  talking past them is a separate question.

## Where it lives

`packages/daemon/src/server.ts`: `LiveSession.asides` (agent id → its runtime, its stop and when it
started), `startAside`, and the dispatch in the `messages` action. A thread's detail says who's
working (`working`), and the app draws a row per agent, each with its own stop. Streaming events
carry the agent they came from, so two replies don't land in one bubble.
