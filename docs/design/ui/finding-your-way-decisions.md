# Finding your way: the decisions

Additions to `settled-brief.md`, in its voice. Written as decisions. The companion mockup is
`mockup-finding-your-way-response.html`.

---

## Additions to §2 (Navigation)

**Home is one list, and you may arrange it three ways.** A **View** control at the top of the list
groups it by **Time**, **Project** or **Agent**. Time is the default and is the list §2 already
describes. Grouping re-arranges the same list, from the same endpoint, with the same row — it never
changes what a thread is or how it reads.

**Group, don't sort.** There is no sort control. Sorting by project alphabetises and destroys
recency, which is the one thing the list is good at. Grouping keeps newest-first inside each group,
orders the groups by their newest thread, and promotes the project from grey text on line two to a
heading carrying its colour.

**Grouping rules.** A thread appears in exactly one group, always:

- By project: a thread with no project goes into **No project**, placed last.
- By agent: a thread files under its **lead** agent; failing that its only agent; failing that
  **No agent**, placed last. A multi-agent thread is never listed twice.
- A group heading collapses, and a collapsed heading always shows its count, because collapsing
  hides rows.

**Filtering is separate from grouping, and it is always visible.** Opening a project **scopes Home
to it** rather than replacing the list: a **project chip** appears above the list and stays until
it's cleared. Beside the chip is what's hidden, in words — "hiding 27 threads in 4 projects". The
chip's × clears it, as does tapping the Home rail item while a filter is on.

**In a project, View offers Time · Kind · Agent, and Kind is the default**, giving *Waiting on you*,
then *Work*, then *Conversations*.

**A filter never hides a waiting item without saying so.** When a filter is on and something is
waiting on you in another project, a line under *Waiting on you* says how many and where, and
clears the filter in one tap. This overrides the weaker rule that *Waiting on you* merely "stays on
top": staying on top is not enough when a filter can empty it.

**The View choice and the filter persist per device**, not per person and not per install. A phone
and a desktop are used differently and should be allowed to disagree.

**The list never reorders under you.** New and updated threads collect into a "N new" pill at the
top of the list instead of pushing the row you're reading down. The pill applies the changes when
tapped, and always on a fresh load. One exception: a thread that becomes *waiting on you* arrives
immediately, because that is the only thing worth interrupting for.

**A project page has two tabs: Work and Setup.** Work holds *Waiting on you* and this project's
threads — the Home list with this project's filter on. Setup holds what needs doing, what it can
reach, rules and memory, people, agents and the folder. There is no third tab: *Work* and
*Conversations* were one list split in two, and merging them removes the "which list is this thread
in?" question that §2 exists to prevent.

**A project opens on Setup until it is set up, and on Work forever after.** While setup is
unfinished it is the only thing on the Setup tab; the other sections appear beneath it as they're
completed. Work, tapped early, says nothing is here yet and points back.

**Starting something is always the + button.** *Add feedback or an idea* and *Start a workflow* are
choices in the project's + sheet, alongside *Message an agent*. They are not standing buttons on the
project page.

**Setup's icon is sliders** — two horizontal tracks with a knob on each. Not a person, which
collides with Team.

## Additions to §3 (Threads, and work above them)

**A mark is never a model.** The mark slot answers "whose is this", in this order: the thread's
agents (composed when there are several), else a person's face, else the project's squircle, else a
dashed outline. A thread with no agent must not borrow the mark of the model it runs on — when most
threads run on the same model, most rows lead with the same shape and the "who" signal becomes
noise.

**Who started a thread is prose on line two**, not a fourth signal: "Polyphemus · …" or "you started
this".

**Quiet machine-made threads roll up.** Three or more consecutive threads that were all started by
Polyphemus, are all the same kind, and have nothing waiting on a person collapse into one row with a
count and the projects it spans. It expands in place. Nothing is ever hidden without a count and a
way to open it, and anything waiting on a person breaks the run and shows as its own row.

**No project colour stripe on rows.** A coloured edge per row reads as a fourth signal and competes
with the amber dot. The project's colour reaches the row through the group heading, the filter chip,
or the squircle when there is no agent.

**A grant change states when it takes effect**, in words, on the screen where it's made: the agent's
next turn, not retroactively, and never applied to a gate already waiting.

---

## What changes in the code's contract

- `GET /threads` takes `group=time|project|agent|kind` and `project=<id>` / `agent=<id>` filters.
  Grouping is computed server-side and returned as ordered groups — `{key, label, colour, initials,
  count, latest_at, threads[]}` — so paging stays correct and the client never re-sorts.
- The thread row gains a resolved `mark` object — `{kind: 'agent'|'person'|'project'|'none', …}` —
  computed server-side, so the same thread renders identically on Home, in a project and in search.
- The row already has `started_by`; it now also needs `lead_agent_id` and `rollup_key` (kind +
  starter) so consecutive machine-made threads can be collapsed without the client guessing.
- `GET /waiting` takes the same filter parameters and always returns `total_unfiltered`, so the
  "2 more waiting in other projects" line can be honest.
- A list response carries a `stable_cursor`. Changes after it are delivered as a pending count
  rather than being merged in, except items that transition to *waiting on a person*, which stream
  immediately.
- View and filter are stored per device in the client, not in the daemon's config.
- The project page's grant rows need a `tools_changing_count` alongside the full tool list, so the
  card can show "9 tools · 3 that change things" without shipping and rendering every name.

## Where I disagree with §4

One item, and only one: **"Waiting on you stays on top, however the list is arranged"** is correct
for grouping and insufficient for filtering. Grouping hides nothing; filtering does. A gate waiting
in another project, invisible behind a project chip, is the worst failure this screen can produce —
worse than the disorientation this round set out to fix. The replacement rule is above: a filter
never hides a waiting item without a line that counts it, names where it is, and clears the filter.

Everything else in §4 holds, and two parts of it did real work here. "Home is canonical" is what
makes a project's Work tab a filter rather than a second list. "Three signals and no more" is what
killed the project stripe.

---

## As built (2026-09-13)

Everything above is in the app, with these differences in the contract, on purpose:

- **Grouping, filtering and the "N new" pill are computed in the app, not by a `GET /threads`
  endpoint.** The app already holds every row from the one state endpoint, so grouping it there
  keeps "same endpoint, same row" without a second list API. If lists need paging, grouping moves
  to the daemon then.
- **Mark resolution is in the app too** (`whoMark`), used by every row, the thread's header and
  question cards, so a thread looks the same everywhere.
- **Machine-made means** started by an agent, a run or a routine, or a work item spun out of another
  thread and not started yet. Roll-ups group runs of three or more of those, of one kind, with
  nothing waiting.
- **Waiting counts** are counted in the app from the questions it already has, so the "more
  waiting in other projects" line has nothing to be dishonest about.
- The project's **Work tab shows the same list** that Home shows beside it on a wide screen. That
  repeats on desktop, and is the only list on a phone.
- **Not yet:** a "Still to do" checklist beyond setting up and reviewing proposals, and the grant
  row's change-making tools as chips on the connection page itself (they're on the project's Setup).

---

## Added 2026-09-17 (the owner asked for search and collapsing on every list)

**Every list narrows as you type, in place.** Home, Direct, Projects and Team each have a filter
strip: it filters the rows on that screen, says how many it's hiding, and clears with ×. It appears
once a list is long enough to need it (5 threads, 4 projects, 4 agents) and never on a short one.
Filtering is not searching: what's typed is forgotten when you leave, and the strip offers "Search
everything, including archived", which is the threads screen with the query carried over. Two search
affordances that behave differently would be worse than one of each.

**Collapse all belongs to grouping.** Group headings already collapse one at a time; the View row
gains Collapse all / Expand all while the list is grouped by project or agent (headings exist), and
it flips to the other word once everything is shut. It's remembered per device like the individual
headings.

**A project's Work tab doesn't repeat the list beside it.** On a phone, and on a wide screen where
the sidebar is something else, Work is the list filtered to the project, as decided. Where the
sidebar *is* Home scoped to that project, the two panes were the same rows twice; Work is what's
happening there instead — waiting, threads, what's going, what's stopped, what's proposed, its
routines — and says where the list is. Same facts, not the same rows.

**Threads outside every project are a place: Direct.** They were the "No project" group at the
bottom of Home, which read as a leftover. Direct is a rail (and tab) entry showing only those
threads, with only what's waiting on you out there — a gate inside a project belongs to that
project. Home still shows everything, including these, so nothing is hidden by the new entry. The
Projects screen points at Direct rather than listing loose threads itself.
