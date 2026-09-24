# Finding your way: threads, projects, and where you are

A design brief for the next UI round. Paste it after [settled-brief.md](settled-brief.md), which
still binds everything it doesn't explicitly reopen. The mockup beside it,
[mockup-finding-your-way.html](mockup-finding-your-way.html), shows the app as it is today
with the problems marked, and one direction to react to. **The direction is not a decision.** A
better answer is welcome; say why it's better.

---

## 1. What the owner said

> I'm struggling a little bit with this chronological list of threads. Maybe we could add a sort
> button at the top where we can have options to organize the list by time, project, agent, etc?
> Bouncing back over to Projects and making changes and then coming back here to find the right
> thread makes me feel a little lost. Also, on the project page itself, maybe we could add some
> tabs like we have on the Setup tab, for project configuration and threads or something? And the
> Setup tab needs a different icon.

This was said on 2026-09-13, while setting up a first real project (a company website)
and watching its first workflow run. That's the moment the design has to survive: several projects,
a run going, questions arriving, and a person moving between a thread and its project's settings.

## 2. What's on screen today

Desktop, 1200px and wider: a nav rail (Home · Projects · Team · Setup), a **list column**, the
**thread**, and on a work item a **Work panel** on the right with the run's steps. On a phone the
same screens stack, one at a time.

The list column is whatever the rail says. Home shows *Waiting on you*, then every thread newest
first, grouped *Working now · Today · Yesterday · Earlier*. Tapping **Projects** replaces that
column with the project list, and a project replaces it with the project page.

A thread row has three signals (settled brief §3): a **mark** (who), one **state** glyph or status
word, and the **amber dot** when it's on a person. Line two is prose: the project name, then the
last thing said or where the run is.

The project page is **one long scroll**, in this order: *Set this project up* (while it needs it),
two buttons (*Add feedback or an idea*, *Start a workflow*), *Waiting on you*, *Work*,
*Conversations*, *People*, *Agents*, *What it can reach* (each connection's grant, with every tool
name), and *Rules and memory* (rules, the review inbox, the folder).

## 3. Where it goes wrong

Each of these is visible in the mockup's first panel, marked with its number.

1. **One list, and nothing groups it.** Every thread in every project sits in one time-ordered
   list. With five projects, a run going and a couple of chats, you find a thread by reading
   line two of each row. The project name is the only clue, and it's small grey text.
2. **The marks don't tell threads apart.** A thread with no agent shows its model's mark, so when
   most threads run on the same model, most rows lead with the identical shape and colour. The
   "who" signal becomes noise.
3. **Going to a project loses your place.** You're watching a run, you need to change a grant, so
   you tap Projects. The list column becomes the project list, then the project page. When you
   come back to Home, the list has moved on: new rows on top, the one you were in somewhere below.
   Nothing on screen says which project you were in or how to get back to it. This is the "feel a
   little lost".
4. **The project page mixes doing with configuring.** What's happening (waiting, work,
   conversations) and how it's set up (people, agents, grants with long tool lists, rules, memory,
   folder) share one scroll. A project with three GitHub identities granted shows a screen of
   tool names between you and the rules. On a phone that's several thumbs of scrolling.
5. **The list will get busier.** Since the brief was settled, Polyphemus started making threads of
   its own: each request that comes in is a thread; an intake makes a work item per piece you
   keep; orientation is a thread. Each workflow step is a thread too, hidden from Home, reached
   from its run. The list has to hold ten times what it holds today without turning to noise.
6. **Setup's icon is a person.** Team is also people. Setup holds connections, models and
   providers, devices, notifications: it reads as "you" or "profile", not as settings.

## 4. What still holds

Keep all of these unless you explicitly argue against one:

- **Vocabulary** (§1): thread, outcome, work item, run, step, gate, Waiting on you, connection,
  grant. Never task, ticket, job, session, channel.
- **Navigation** stays Home · Projects · Team · Setup (§2).
- **Home is canonical** (§2): a project's list and an agent's list are the Home list with a
  filter, from the same endpoint, with the same row. The same thread never reads differently in
  two places.
- **A row's three signals and no more** (§3). The amber dot means one thing, everywhere (§8).
- **Waiting on you stays on top**, however the list is arranged.
- **Phone parity** (§8): nothing may need the desktop panes. Design at 400px first.
- **Projects aren't only code** (a project is any body of work: a website, a book, a CRM clean-up).
- **In the app:** no browser dialogs (confirm sheets only), and no inline style attributes (a CSP
  rule: anything dynamic goes through classes).

## 5. What this round reopens

§2 says Home is "one recency-ordered list". The owner is asking whether it can be arranged other ways.
Decide, and write the decision as an addition to §2:

- **Sort, group, or filter?** The owner said "sort". Grouping by project (sections, still newest first
  inside each) or filtering to one project may serve "find the right thread" better than
  re-ordering. Pick what fits, and say what each option shows when a thread has no project, or
  several agents.
- **Does the choice persist?** Per device, per person, or only until you leave? "Lost" argues for
  remembering; a canonical Home argues against hiding things without saying so.
- **How does "where am I" work?** When you open a project and come back, what tells you which
  project you were in, and how does one tap get you back to the thread you left?
- **Tabs on the project page?** The owner suggested tabs like Setup's. Say which tabs, what's on each,
  and where the two actions (*Add feedback or an idea*, *Start a workflow*) and *Set this project
  up* belong. Setup's existing tabs are the reference for how tabs look.
- **Can the marks help?** Projects already have coloured squircles with initials. Whether a row
  can carry its project's colour without breaking the three-signal rule is yours to judge.
- **Setup's icon:** pick one that reads as settings and doesn't collide with Team.

## 6. Journeys to design for

Each is a pass or a fail. Show them in the mockup, at 400px and at 1200px.

1. **Find yesterday's chat.** From Home, with 30 threads across 5 projects: open the chat in the
   *Notion Documentation* project where Otter was asked about Notion. Pass: three taps or
   fewer, without reading more than one project's rows.
2. **Change a grant mid-run and come back.** You're watching *Ship issue #3* in the Acme website
   project. Untick a tool on its Planner grant, then return to the run. Pass: you never search for
   the run, and the screen always says which project you're in.
3. **See one project's work on a phone.** At 400px, see only the Acme website's work items and
   what's waiting on you there. Pass: nothing from other projects is on screen, and it's obvious a
   filter is on and how to turn it off.
4. **Waiting on you, arranged.** Group Home by project while a gate is waiting in one project.
   Pass: the gate is still first on screen, and its card still says which project it's in.
5. **Configure, then work.** On a new project: set it up, grant a connection, review what the
   setup agent proposed, then start a workflow. Pass: each is findable without scrolling past the
   others, and "what's happening here" is the first thing the project shows once it's set up.
6. **A busy day.** 40 threads, 12 of them made by Polyphemus (incoming requests, work items from an
   intake), 2 runs going, 3 things waiting. Pass: the rows made by Polyphemus don't bury the ones a
   person started, and none of it is hidden without a way to see it.

## 7. The data you have

So the design doesn't invent fields, and doesn't miss ones that exist. Each **thread row** has:

- title, project (or none), and when it was last updated
- its members: agents with marks (shape and colour), and people as faces
- its state: `paused`, `finished`, `kept`, `routine`, or none
- whether it's waiting on a person
- for a work item: the outcome, run status, step, and whether it's at a gate
- who started it: a person, a routine, or a run (`run:<id>`)
- the thread it was spun from, if any

Each **project** has: a name, a description, a colour and initials, a status (active, parked or
archived), your role in it, counts (threads, things waiting, proposals to review), and whether it
still needs setting up. Each **agent** has: a title, a mark, a description, and a scope (your
library or one project).

## 8. What to hand back

- **A mockup** in the style of the existing ones: one self-contained HTML file on the app's
  tokens, in light and dark, at 400px and 1200px, covering the six journeys.
- **The decisions**, written as additions to settled-brief.md §2 and §3, in its voice: decisions,
  not options.
- **What changes in the code's contract**, if anything. For example: "the list endpoint takes a
  `group` parameter" or "the project filter is remembered per device".
- **Anything in §4 you think is wrong**, with the case against it. Stop and say so rather than
  quietly designing around it.
