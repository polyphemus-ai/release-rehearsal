# Prompt: organizing Polyphemus around threads, projects and agents

I'm building **Polyphemus**, an open-source, multi-provider AI Polyphemus: one place where I work with AI agents about my work, from my phone first and my desktop second. It runs on my own computer as a daemon. The app is a web app it serves over my private network (Tailscale), installed to my phone's home screen, with push notifications.

Attached is **polyphemus-current-ui.html**, a faithful snapshot of every screen as it exists today: the real markup and CSS captured from the running app, with sample data. Use its screen switcher to browse. Treat it as the current state, not as a design to preserve.

We just redesigned **Models & providers** from a mockup, and it worked because it:
- answered three plain questions with three tabs;
- put status and the fix on the same row ("Needs attention: your plan returned 403 · Test again / Switch connection");
- stated costs before any action;
- read the whole policy back as one sentence.

I want that level of clarity for the rest of the app, which is where it's weakest now.

## What Polyphemus is made of

- **Threads.** A thread is a conversation. It has zero or more **agents** and belongs to a **project** or to nothing. That is deliberately the only conversation noun: there are no channels, DMs or tasks as separate types. The one noun already covers each of them:
  - A DM is a thread with one agent and no project.
  - A group chat is a thread with several agents.
  - A project's "#general" is a thread you keep.
  - A task is a thread that ends.
- **Projects.** A project is a folder of work plus the context agents get in it: its rules (`AGENTS.md`), private memory notes, a handoff, a roster, routines, and later credentials and plugins. It isn't only code; it can be a client's documents or a job in someone else's system. A project is active, parked or archived. A new project gets "set up" by an agent that drafts rules and notes into a **review inbox** that I keep or discard.
- **Agents.** An agent is an expert I work with. Each has:
  - a name, a mark (shape + colour) and a one-line purpose;
  - a persona and instructions;
  - a model route with fallbacks, and skills.

  Agents live in my library (everywhere) or in one project. Making one is "a name, a face and a sentence." Talking to one should be a message box, not a form.
- **Several agents in one thread** works today. `@name` decides who answers, and Polyphemus refuses to guess when nobody is named.
- **Questions that need me:**
  - approvals ("Waiting for your OK to run bash: …", with Allow / Always / Deny);
  - "switch models?" when one runs out;
  - proposals waiting in a project's review inbox;
  - failed routines;
  - models needing attention.
- **Routines** are scheduled jobs an agent runs, each with a next run and a history of firings.
- **Models & providers** are settled; see the snapshot.

## Where the UI is today

Bottom tabs on a phone, and a left rail on desktop (≥900px, as rail + list + content):
- **Home:** Needs you (approval cards), Working now, Recent (15 threads, each tagged with its project), search, and archived.
- **Projects:** project cards, each with its threads, routines, rules, review inbox and folder.
- **Team:** agents; each profile is a long editable form with "Message [agent]".
- **You:** usage meters, notifications, Models & providers, compact/detailed view, devices.

A thread's header holds: its mark, its title, a member count (a sheet to add or remove agents), a ⋯ menu (rename / archive / delete), and a row of chips (agent, model select, Ask/YOLO, Compact/Detailed, project). New thread is a form: Project → Agent → Model → Mode → Message.

## What's coming, in order

1. **Home as the front door.** Already decided: one recency-ordered list of everything that wants me, across every project. A project is a tag on the row, not a place you pass through first. Each row's second line is the last *outcome* ("report filed · 9 receipts, nothing out of policy"), not the last thing a model said.
2. **More than one agent in a thread, properly:**
   - agent-to-agent messages visible in the timeline;
   - a "lead" agent that routes work;
   - a runaway guard that pauses the thread after N agent-to-agent exchanges and asks me to continue;
   - a thread that can spin out another, which links back;
   - a thread's mark composed from its members' marks.
3. **An agent owns more of itself:** its own skills, routines, permissions and approval rules, and plugin (MCP) grants.
4. **Workflow runs:** pipelines like "ticket → plan → build → review → merged PR". Each run is a graph of steps, each step is an agent session, and gates need my approval.
5. **Memory and the steward:**
   - a browser for each project's notes and handoff;
   - a background "steward" agent that reviews how agents worked together and proposes fixes into the review inbox.
6. **Later:** other people (organisations, roles, shared projects) and a voice "dispatcher" conversation.

## The problems I need solved

1. **The tabs are structure-first, and Home is meant to be conversation-first.** Once Home is the front door, what are the other top-level destinations? Do Projects and Team stay as tabs, merge, or become places you reach from Home? Where do settings and usage go?
2. **One noun, many shapes.** In a list, a DM with Builder, a group thread with Builder and Reviewer, a project's kept "#general" and a task that's done all look identical. How does a row show who's in it, whether it's kept or finished, and what happened, without reintroducing channel/DM/task as types?
3. **Starting something.** The new-thread form leads with Project, when the field that decides everything else is *who's on the other side*. An agent brings its own model, so Model is only sometimes relevant. Picking several agents shouldn't promise more than the group runtime can deliver. What is "start a conversation" on a phone: a form, a message box with @, or starting from the agent or the project?
4. **The same thread shows up in three lists:** Home, the project page (recent plus "every thread here"), and the agent profile ("Message Builder" opens the last thread; "every thread with Builder"). Which list is canonical, and how do the others relate to it?
5. **"Needs you" is scattered.** Approvals are on Home, proposals in each project's review inbox, failed routines on the project page, and broken models under You. Is there one inbox, and how does it avoid becoming noise?
6. **Kinds of work that aren't chat are arriving:** workflow runs (a graph with gates), routine firings, steward proposals and memory notes. They need a home that isn't "yet another tab", and each links to the threads that did the work.
7. **A thread with several agents** needs to show who's speaking, who's the lead, agent-to-agent hand-offs, a paused-by-guard state with Continue, and spin-out links. The thread header is already crowded with chips (agent, model, mode, view, project).
8. **The agent profile is one long form.** It'll soon also hold skills, routines, permissions and plugin grants. What's the reading view, and what's the editing view?
9. **A project page** will hold roster, threads, routines, rules, memory, review inbox and later credentials and plugins. What's the shape, following the Models & providers pattern of a few clear sections?
10. **Desktop:** the rail + list + content layout exists. Should the content pane gain a detail pane (diffs, run graph, artifacts), and when?

## Constraints

- **Phone first** (about 400px); desktop at 900px and up. Light and dark themes.
- Plain web tech: no framework, no build step, and no inline style attributes (CSP). Fonts are Figtree (UI) and Bricolage Grotesque (titles). Keep the existing visual language from the snapshot unless there's a reason to change it.
- **Copy** is plain, calm and specific. Say what happened and what to do next ("Waiting for your OK to run bash: …", not "Allow Bash?"). Use curly apostrophes.
- Keep one conversation noun: **thread**. Don't reintroduce channels.
- Nothing is hidden: what an agent did, what it cost, and why a model was switched are always one tap away. But the default view is summaries, not walls of tool output.
- The phone is a remote control. Some safety switches (YOLO) warn before they turn on.

## What I'd like back

1. **A single self-contained HTML mockup**, like the Models & providers one: a preview bar to switch between screens and states, realistic sample data (the projects, agents and threads from the snapshot are fine), phone width first, plus the desktop layout for Home.
   - Cover at least: the new top-level navigation; Home; a thread row in its different shapes; starting a conversation; a multi-agent thread including a guard pause; a project page; an agent profile; and wherever runs, routines and proposals live.
2. **For problems 1 and 3, two alternatives each**, with the one you'd pick and why.
3. **A short written rationale:** for each of the ten problems, the decision in one or two sentences, plus anything you think is still genuinely open.
