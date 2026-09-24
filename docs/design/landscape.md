# The landscape: what else is being built, and what Polyphemus is for

Written 2026-09-16, after reading one project closely. It exists to keep Polyphemus honest about what's
already done better elsewhere, and clear about the part only it is doing. Anything here is what those
projects say about themselves plus what their code shows — none of it was run.

## OpenMausBot (github.com/milind-soni/OpenMausBot)

Apache-2.0, with a source-available `enterprise/` folder (white-label, single sign-on, budgets,
billing). Its own words: “an open-source version of Grok Bot — bring-your-own-agent, local-first”.
A chat app whose contacts are agents, each with a personality, a model, a computer and connected apps.

**Scale, read 2026-09-16:** about 140,000 lines of TypeScript outside its tests, 563 test files, over
1,278 pull requests, commits the same day. Signed installers for macOS, Windows and Ubuntu, iOS and
Android apps, an npm command, and a Docker/VPS deployment path. Polyphemus, for comparison: about 27,000
lines and 62 test files.

**Ahead of us, plainly:**

- A computer per bot — a cloud Linux desktop (Box, paid), a local VM, or control of your own Mac or
  Ubuntu — with a live screen you can take over.
- Voice: replies read aloud, and calls with a bot (ElevenLabs key).
- 500+ connected apps through Composio, a hosted service that holds the app sign-ins.
- Teams of bots: a Chief of Staff, delegation, rooms, goal runs with a `done | continue | wait`
  verdict per turn, whole teams installed from one Markdown file.
- Routines, webhook triggers, spend caps, a usage ledger.
- Memory you can see: a gauge of how much loads each turn, a change journal with undo.
- More engines: the Claude, Codex, Grok, Antigravity, Cursor and Pi CLIs, any ACP CLI, OpenAI-compatible endpoints.

**What Polyphemus does differently, and why it's the point:**

| | OpenMausBot | Polyphemus |
|---|---|---|
| Credentials | Its docs: “API keys are saved as plaintext, not encrypted” in `config.json` (0600). App sign-ins live at Composio | An encrypted vault, and a guard that keeps models and tools out of credential stores; Polyphemus's own servers hold short-lived tokens |
| Approvals | The vendor CLI's own permission modes, passed through — its docs: “there is no app-side allowlist, classifier, or pattern rule” | Polyphemus's own guard, read-only rules and approvals, the same whichever model runs |
| Who may use what | Connected apps: “every bot can use them as tools” | Grants per project and per agent, inside a ceiling, checked again at the moment of every call |
| Work that's proven | Goals, routines, delegation. No shipping pipeline in the repository: no GitHub App identities, no merge checks, no checks read from a project | Workflows whose status comes from exit codes, commits and GitHub's own answers: a worktree per run, review by another vendor's model, a merge only of a commit someone else approved and only after a person says yes, and the pages it changed opened and checked |
| Shape | Bots and channels, like a messaging app | Projects: threads, outcomes, runs, steps, evidence |
| API models | Mostly the vendors' CLIs | Polyphemus's own loop, so fallback, grants and guards apply to API models too |

**What this settles for Polyphemus (2026-09-16):**

1. **Not “the open-source Grok Bot”.** That position is taken, by a project with native apps, voice
   and an audience. Polyphemus is for work you have to be able to trust: nothing a model runs can reach
   your credentials, every change arrives with evidence, and permissions still hold when several
   people share a project. [hosting.md](hosting.md) points the same way.
2. **Don't chase** native apps, voice, or cloud desktops for now. They're expensive, and they aren't
   the difference.
3. **Borrow, adapted to our rules** (in the roadmap's backlog): spend caps and a usage ledger; teams
   or workflows packaged as portable files, installed with connections off and routines paused; a
   memory budget you can see, with undo; “busy means wait and resume, never fail” for an agent busy
   elsewhere; a webhook receiver of its own, separate from the app's API.
4. **One safety idea worth copying outright:** their most permissive mode can only be switched on
   from the desktop app, never through the HTTP API an agent can reach. Polyphemus's equivalent is that
   only the install's owner can grant, and agents never hold a credential — worth keeping that line
   as sharp as theirs when YOLO and standing approvals grow.

## OpenClaw (github.com/openclaw/openclaw, docs.openclaw.ai)

Where this began: the fleet on subscriptions and the control UI Polyphemus was an answer to. Read
properly on 2026-09-17, from the published `openclaw@2026.9.4` docs, the repository's own
`AGENTS.md`, and its creator's account of how the team now works.

**They build OpenClaw with OpenClaw, and say so.** Peter Steinberger: two months ago they started
"the mission to 'build OpenClaw with OpenClaw'", and moved everyone off their local coding harnesses
onto `team.openclaw.ai` — a shared agent that "knows what everyone's working on and orchestrates it
all". His conclusion: "local harnesses feel like relics of the past now."

**How it works, and why it doesn't eat itself:**

- **The orchestrator isn't what's being built.** A Gateway owns the conversation, the reconciled
  workspace, model credentials and placement records; commands, file edits and tool work run
  elsewhere — a paired device, or a throwaway machine leased through Crabbox. Shipping a new
  OpenClaw never restarts the process running the build.
- **Sessions outlive their workers.** Suspended cloud workers "restart on the next message, including
  idle workers released after a Gateway build update".
- **Managed worktrees** give each task its own branch and checkout outside the source repository,
  recorded in a shared state database and snapshotted before removal. That is what keeps several
  agents on one repository from colliding.
- **Credentials stay at the Gateway:** inference is proxied, so provider credentials never reach the
  remote machine. The same rule we hold, reached independently.
- **Agents may not touch the deployment they live in.** Their `AGENTS.md` forbids modifying live
  Gateways an agent didn't create, and forbids mutating `team.openclaw.ai` directly.
- **Review is agent-assisted; merging isn't.** Barnacle is deterministic triage that never runs
  contributor code. ClawSweeper is a queued AI reviewer whose pass is "supporting evidence, not
  maintainer approval".

**What this settles for Polyphemus (2026-09-17):**

1. **"Local harness" is now a position someone argues against by name.** The answer isn't to deny it.
   Our case was never the terminal: it's credentials no model can reach, changes that arrive with
   evidence, and permissions that hold for a team. Running on a server costs us none of those —
   [hosting.md](hosting.md) already points that way.
2. **Separating the orchestrator from the executor is the lesson to take.** Not leased cloud machines
   — the property. A daemon restart must not end the work it was running. That is the prerequisite
   for Polyphemus building Polyphemus, and it lands before multiplayer, not after.
3. **Their multiplayer is the bar.** "Knows what everyone's working on and orchestrates it all" is
   what our launch requirement has to mean in practice, beyond invitations and roles.
4. **Don't chase** a node fleet or leased cloud workers. One person with a server gets most of the
   benefit from placement that survives a restart.

## Others, not yet read closely

- **Grok Bot** (xAI, closed): the experience Polyphemus's four pillars come from. Recent: routing its
  cloud computer's traffic out through your own machine, and several computers per account — see
  “which way out” in [computer-use.md](computer-use.md) and [hosting.md](hosting.md).
- **OpenClaw**: read above. The workflow report it produced is folded into
  [workflows.md](workflows.md).
