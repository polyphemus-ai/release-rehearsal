# Agents, threads, and people

Status: in progress. Direction set 2026-09-11; ordering lives in [roadmap.md](roadmap.md). The
unit used to be a session bound to a model. It's the **agent** now, and later the **team of
agents and people**.

## The shape: each project is a server

Discord's structure, Grok Bot's agents (see the mockups that picked the Hybrid layout) — but
with one conversation noun, not three:

| Discord | Polyphemus |
|---|---|
| Server | **Project** (later: an organization holds several) |
| Members | The project's **roster**: agents, and (phase 8) people, each with a role |
| Channels, threads and DMs | **Threads.** One noun. What varies is who's in it and where it belongs |
| Home | **Home**: what needs you, across every project |

**A thread has nought or more agents, and belongs to a project or to nothing** (decided
2026-09-11). That's the whole model, and it's enough to say everything the three nouns said:

| What you'd call it | What it is |
|---|---|
| A DM with an agent | A thread with one agent, belonging to no project |
| A group chat | A thread with several agents |
| A project's `#general` | A thread in a project that you keep rather than archive |
| A task | A thread in a project, usually with one agent, that ends |

**Why not channels.** The owner, on being shown both: "maybe I'm just confused again." They weren't —
the distinction was real but the vocabulary was doing the work of an attribute. What actually
differs between a "channel" and a "group DM" is whether a project is set, because that's what
decides the files, memory and credentials a conversation gets. Setting a project already says
that. A channel is a thread you keep, and keeping is a property, not a type.

The word comes back in phase 8 if it earns its keep, because a standing room several *people*
share genuinely is a different thing from a conversation one person owns. Until then it's one
noun, and nobody has to be taught the difference between two.

## Home: the front door

**Discord's nouns, Grok Bot's surface** (decided 2026-09-11). The structure above is Discord's
because a flat list of conversations stops working somewhere around a dozen — and the evidence
is inside Grok Bot itself. Five of the bots in the list are called *Acme BD*, *Acme Markets*,
*Acme Apps*, *Acme Finance* and *Acme Data*. Grok Bot has one noun, so the grouping had to
be encoded in the names. That prefix is a missing project showing through.

But Discord's *shape* costs what Grok Bot's doesn't: server → channel → thread before you can
say anything. On a phone that's three taps to reach someone you talk to daily. So we take the
nouns from one and the front door from the other:

- **Home is one list**, newest first, of every thread that wants you, across every project. It
  is the first screen, and everything is one tap from it.
  A row is a mark, a name, and the last *outcome* rather than the last thing a model said
  (app.md).
- **A project scopes; it doesn't gate.** It decides which files, memory, credentials and roster
  a conversation has, and it rides along as a tag on the row — not a rail you pass through
  first. You open a project when you want its structured view: roster, threads, files.
- **The prefix disappears.** "Acme BD" is `BD · Acme` — an agent in a project, shown with its
  project's name. Nothing to type and nothing to keep consistent by hand.
- **Recency, then search.** The list is ordered by what happened last, because that's what's
  true; finding an old conversation is search's job, not the hierarchy's.

## Inside a thread

- **One timeline everyone in it sees.** Agent-to-agent messages show in the thread, and you can
  jump in at any time; your message goes ahead of the next agent turn.
- **Who speaks when** is explicit, never "every agent answers everything":
  - an agent answers when it's @mentioned, when the thread's lead agent hands it the work, or
    when one of its routines runs;
  - **a runaway guard:** after a set number of agent-to-agent exchanges with no person in
    between (and within a token budget), the thread pauses and asks you to continue;
  - quiet hours and per-thread budgets.
- **@mentions** decide who answers: typing `@` lists who's here (agents now, people later), and
  agents use it too, which is how hand-offs show ("@Reviewer ready for review"). `@team` reaches
  every agent in the thread and always runs under the runaway guard.
- **A message that names no agent gets no answer** (decided 2026-09-16), unless the thread has one
  agent and one person — that's a chat — or the thread is set to have agents answer everything, when
  it goes to the lead. In a thread of people and agents, people mostly talk to each other; an agent
  guessing it was meant for it is worse than waiting to be asked. A name quoted as something to type
  (`` `@Helm` ``, a code block, a quote) isn't a mention.
- **Who came and went is kept** (2026-09-16): an agent added to or removed from a thread, and a person
  given, changed or taken off the thread's project, with who did it and when. It shows as a line in the
  thread where it happened, and agents are told it with each message, so nobody mistakes who's here.
- **A thread can spin out another**, and the new one links back — that's how a long-running one
  stays readable, and it replaces what "a thread inside a channel" used to mean.
- **A DM stays a DM** (2026-09-21). One agent, outside every project. When that agent asks to
  bring another in and you say yes, Polyphemus starts a new thread with both of them and leaves
  this conversation as it was. The new thread links back. In a project, saying yes still brings
  them into the thread, because the work is there. Naming someone yourself with an @mention still
  brings them into the thread you’re in.
- **A thread's mark composes from its members'**, so a conversation looks like who's in it (Grok
  Bot's group chats, seen 2026-09-11). Its name is optional: Grok offers **Skip** until you type
  one, and a thread that names itself from the work is better than one called "(untitled)".
- **Agents can message each other outside a thread too.** You can read those ("messaged Reviewer:
  ready for review"), and they're audited like everything else.
- **Person ↔ person** arrives with phase 8.

## Three layers keep a team of agents healthy

| Layer | What it is | When it acts |
|---|---|---|
| **The guard** | Rules in Polyphemus's code, not a model: agent-to-agent exchange limits, token budgets, quiet hours, approvals | Every message; free; can't be talked out of it |
| **The lead** | In a thread with several agents, the one that routes live work ("@Builder takes this, @Reviewer checks it") | In the moment; kept fast and cheap |
| **The steward** | A background agent per project that reviews how the agents worked together: stalled hand-offs, loops, denied approvals, failed runs | On a schedule (nightly or weekly) or after something goes wrong |

**The steward proposes; it doesn't edit.** Its suggestions (sharper instructions, a missing
skill, a better model route, a thread that needs a clearer lead) land in the project's review
inbox like notes and rules do. You can let it apply small, low-risk fixes itself, but only by
choice. It works in the background and doesn't chat with you, but it isn't hidden: what it
looked at and what it recommended are always visible, which matters more once other people join.
It extends memory's consolidation ("sleep", design/memory.md) from notes to the agents themselves.

## An agent owns its definition

The model moves from the session to the **agent**. Each agent is a folder of files you can
read, edit (in the app or any editor), diff, and version:

```
.polyphemus/agents/builder/          (in a project; or ~/.polyphemus/agents/ for agents you use everywhere)
  agent.toml      name, title, mark (shape + colour), model route (primary + fallbacks), budgets,
                  permissions and approval rules, notifications, GitHub identity
  persona.md      who it is and how it works: its voice and judgment
  instructions.md what it does in this project (like AGENTS.md, scoped to the agent)
  skills.toml     its own skills, plus which shared skills it uses
  routines.toml   when it wakes up and what it does (design/scheduling.md)
```

- A thread with an agent uses the agent's route (design/routing.md); you can still override
  the model for one thread.
- **An agent keeps the model it was made with** (decided 2026-09-12, from the Models & providers
  mockup). A new agent gets today's default written into `agent.toml`, and changing the default
  later doesn't move it. `model = "default"` is the deliberate way to follow the default instead.
  Agents that had no model were pinned once, to the default they were following, with a config
  history entry naming each agent, its file and the model.
- Plugins (MCP servers) are **granted** per agent and per project, with that agent's own
  credentials (design/secrets.md), never someone else's. A grant and a use are two different
  keys, exactly as with shared skills: the grant says what this agent *may* reach, and
  `agent.toml` says what it *uses*. Nothing becomes reachable by accident, and the profile
  shows both.

## Making one

**A name, a face, and a sentence** (decided 2026-09-11, from Grok Bot's New Bot screen). Ours
asked five questions before the agent existed — template card, description, name, model,
availability. Three different things were wearing one coat:

| What | Where it belongs |
|---|---|
| **Who it is** — its name and its mark | The create screen; it *is* the create screen |
| **What it does** — the sentence you'd say to a new hire | The create screen, one line |
| **What it runs on** — its model route | A default it inherits, stated there, changed with one tap |

- **The mark is chosen, not computed.** A shape and a colour you pick, stored as `mark` in
  `agent.toml` and left out of the file until you pick one, so a name still decides its own
  default and a copied agent looks right where it lands. Grok Bot
  offers 8 shapes and 11 colours and no way to upload a picture, which is right: a roster of
  twenty reads better as twenty marks than twenty avatars, and nobody has to go find an image.
- **The route is stated, not asked.** Grok Bot's create screen has no model on it because Grok
  Bot has one model. We have the opposite as our whole point (routing.md), so hiding it would
  cost us the thing that makes Polyphemus polyphemus. It shows as a line — *runs on Claude (opus) ›* —
  inherited from the project, tappable now or on the profile later. Visible, never a gate.
- **The sentence writes the persona.** "Handles our BD pipeline and keeps the CRM honest"
  becomes `persona.md` and `instructions.md`, drafted by a model on the `cheap` route
  (routing.md) — not the agent's own route, which is for its work.
- **No approval step** (decided 2026-09-11). Notes and rules go through the review inbox
  because the steward and orientation change things you didn't ask for while you're elsewhere.
  Creation is the opposite: you asked for it, it's new, it overwrites nothing, and its profile
  is one tap away. A gate here would be ceremony.
- **Creation never waits on a model.** The agent exists the moment you tap Create, with your
  sentence as its description; the persona fills in behind you while you're already on the
  profile. If no model can be reached it still works — a description alone already goes into
  the prompt. A half-made agent is never left behind.
- **The profile is where you read it back.** `persona.md` and `instructions.md` are already
  editable there (*What it's for*, *Who it is*, *What it does here*). What's added is a line
  saying where the words came from — *written from your description* — so you're never unsure
  whether you wrote them.

**Templates demote to seeds.** They can't carry creation on their own: Builder, Reviewer and
Researcher are a *coding* roster, and no shelf covers BD, finance ops, a reading group, and
whatever you make next week. You can't author your way to coverage — which is why Grok Bot's
store is 71 bots from 43 creators. So a template stops being the first question and becomes
what the draft starts from when one fits, next to the store and "Save as template".

## Skills: the agent's own, or shared

- ✅ Skills are `SKILL.md` folders (the Agent Skills standard that Claude Code and Codex already
  read), so they work in Polyphemus and outside it.
- **Three scopes:** an agent's own skills; **shared** skills in the project that any agent in
  it can use; and your **library** (`~/.polyphemus/skills/`) across projects. An agent lists the
  shared ones it uses; nothing is shared by accident.
- ✅ **Shipped ahead of agents** (2026-09-11), because a session benefits from skills before a
  roster exists: the library and project scopes, `poly skills ls | new | show | path`, and an
  index of names and descriptions in every session's prompt — API models through the system
  prompt, agent CLIs through their appended instructions, with the library folder opened to them
  so they can read a skill they pick. A project skill beats a library skill of the same name, and
  a skill that can't be read is reported rather than silently skipped. The per-agent scope
  arrives with agents.

## Templates and the store

- **Agent templates** (Builder, Reviewer, Researcher, Ops, …) and **skill templates** come
  with polyphemus. They seed a draft rather than gate creation (see *Making one*): pick one when
  it fits, adjust it, and create an agent or skill from it.
- **"Save as template"** turns any agent or skill into a template you can reuse or share.
- **The store:** install templates and skills from a git URL or a registry. Anything from
  outside is untrusted until you review it: the install screen shows what it does, what it can
  touch, and which plugins or credentials it wants. Versions are pinned, and updates are
  reviewed like the first install, never applied silently. (Skills are instructions plus code:
  they're a supply-chain risk, and the store is where that's handled.)
- **What a working store looks like** (Grok Bot's marketplace, seen 2026-09-11: 71 bots from 43
  creators). An entry is four things — **name, "by <creator>", one line on what it does, and an
  Add button** — and you *browse* rather than search: All, From the Grok Bot Team, Engineering,
  Sales, Marketing, Design, Personal, Recruiting & People, Operations, Product, each with "View
  all", plus a curated shelf from the makers. Ours is that shape in miniature already:
  `poly agents templates` lists name, title and description, and `--from` is Add. What's
  missing is quantity, an author beside each entry, categories once there are enough to need
  them, and a shelf of ones we vouch for.

## From today to there

- **Sessions become threads.** Existing sessions land in their project's #general (or in a DM
  with the agent that matches their model).
- **The Team tab's model list becomes the roster:** each model today turns into a starter
  agent ("Claude", "Codex") you can rename, give a persona, and reassign.
- **The new-thread form's "Model" becomes "Agent."**
- **The tabs become Home.** Today's Projects / Team / You tabs are a structure-first front door;
  Home is the conversation-first one, with the structured views still a tap away.

## Build order

**Order lives in [roadmap.md](roadmap.md)**, with everything else's. What's here is the detail.

✅ **Shipped 2026-09-11.** Agents as files — `agent.toml`, `persona.md`, `instructions.md` — in
your library (`~/.polyphemus/agents`) or a project (`.polyphemus/agents`, which wins on a shared name);
`poly agents ls | new | show`; `polyphemus -a <name>`, whose session records the agent so
resuming keeps it. The roster, an agent picker, and the agent shown on an open thread in the app.
Made from the phone: a name, a face and a sentence — a `mark` in `agent.toml` (8 shapes, 10
colours, the name's own as the default), the route shown as an inherited default rather than
asked, and the sentence written up into `persona.md` and `instructions.md` on the `cheap` route,
in the background, so creation never waits on a model and an agent whose draft failed still
works. Talking with one is a message box, not a form, and its profile opens the last thread with
it. A thread wears the mark of whoever you're talking with.

✅ **Several agents in a thread (2026-09-12).** A thread's membership is its own table, so agents
come and go without rewriting the thread: bring one in, send one out, from the thread's own header.
`@name` decides who answers — matching an agent's name or its title — and with more than one in the
thread Polyphemus **refuses to guess**, because the wrong agent answering in front of the others is
worse than asking. The runtime changes speaker between turns: persona, allowed skills and model all
follow whoever was named, so Anthropic-for-planning and xAI-for-code can be in the same
conversation.

**Still to come**, in roadmap.md's order: agent-to-agent messages and the runaway guard (agents
can't yet address each other, so nothing can run away); threads you can manage; Home as the front
door; per-agent skills, routines and permissions; plugins with grants; the store; and people.
