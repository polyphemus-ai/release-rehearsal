# Addendum to the Polyphemus UI brief: what changed since I sent it

An independent assessment of Polyphemus came back, and my answers to its questions settled a few things the brief didn't say. Please fold these in. Where they conflict with the brief, these win.

## The product, stated plainly

**An open-source alternative to OpenClaw, with an experience like Grok Bot, that lets you use any provider or model: bring your own tokens.**
- It's general-purpose. Building software is one kind of work in it, not the product's boundary.
- **All four Grok Bot pillars are the product:** persistent agents with personalities, proactive scheduled work, integrations that take actions, and an interface that organises it all.

## Four things the design now has to carry

1. **Multiplayer is required at launch.** Design for other people from the start, even though the first builds have one:
   - who's in a project, and a small set of roles;
   - who started, answered or approved something;
   - two people looking at the same approval;
   - a person seeing only the projects and decisions they're allowed to.

   Don't reintroduce channels to get there. A shared standing room may still earn its own noun later.
2. **Plugins and MCP servers are core, not a later settings page.** Connections to outside services (a CRM, a database, GitHub, email) need a real home:
   - what the service enables, whose account it is, and who may use it;
   - what access each agent or project was granted, and whether it's working;
   - recent activity, and action receipts on the work they touched.

   Setup problems and failures show up as specific items in Needs you.
3. **Permissions at agent, thread and project scope.** Keep "may this happen" (a grant) separate from "should it ask me first" (an approval preference, Ask vs YOLO). A narrower scope can only narrow access, never widen it. The UI should make it easy to answer "what can this agent reach here, and why?" without reading config. I run YOLO myself, and other people won't.
4. **Work above conversations.** This is the big open question for this round. The assessment proposes Project → **Work item** → **Run** → Step → session details:
   - A work item is an outcome: "fix the data import", "weekly research brief".
   - A run is one attempt at it: a graph of steps, retries, evidence.
   - Sessions are a drill-down, not the thing you navigate.

   My complaint about OpenClaw is exactly that it makes you manage sessions. But the brief's model is Project → **Thread** (one conversation noun), and ordinary chat has to stay lightweight. Please propose how work items and threads relate without forcing every chat into a workflow. Some possible answers: a thread can *become* or *spawn* a work item; a work item has a discussion thread; or something better. Show your pick in the mockup.

## What "legible" has to mean on every screen

The test is: can I see **who's working, what they can reach, what changed, what evidence there is, and what needs a decision** — from my phone?
- Status is factual, from what actually happened: queued, running, waiting for approval, retrying, failed, interrupted, done. An agent *saying* "deployed" isn't evidence it deployed.
- Artifacts (diffs, reports, screenshots, test results) have a place beyond chat bubbles.
- The **Needs you** inbox:
  - survives disconnects and restarts;
  - shows only what the current person can act on, and who has claimed each item;
  - resolves an item once, visibly to everyone who can see it.

## Updates to the ten problems

- **#1 (navigation):** the top level must now also make room for work items and runs, connections (plugins/MCP), and people.
- **#5 (Needs you):** it's shared and permission-filtered, and connection failures land there too.
- **#6 (work that isn't chat):** this is now #4 above, and it's the most important decision in the round.
- **#8 (agent profile):** add what it may reach (grants) versus what it uses.
- **#9 (project page):** add its members, its connections and their grants, and its work items.

## Please add to what you send back

- One screen showing **work items and runs** (a run's graph, its current step, evidence, a gate waiting for approval), and how you get there from a thread and from Home.
- One screen for **connections**: connecting a service, who owns the account, what's granted to which agent or project.
- A **project with two people in it**: who's there, their roles, and an approval one of them has claimed.
- In the rationale, your answer to **work items vs threads**, with the alternative you rejected.
