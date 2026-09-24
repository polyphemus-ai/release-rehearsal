# Review prompt: the workflow engine

The next independent review pass. The passes on 2026-09-19 and 09-20 covered files agents write,
routines, agents in threads, merge evidence and the read-only classifier; they flagged the workflow
engine as the one area they hadn't examined. This is the prompt for that pass.

**To run this review,** point a capable model — ideally a different vendor's than the one that wrote
the code — at this file, in a clone it can run things in:

> Read `docs/reviews/workflow-engine-prompt.md` in this repository and carry out the review it
> describes.

Everything below the line is written for that reviewer and is the whole brief; there is nothing to
copy out. The notes here are for whoever is running the pass. Save its answer as
`docs/research/workflow-engine-review-<vendor>-<date>.md`, which this repository keeps but doesn't
publish (a raw report quotes paths and output from the machine it ran on). Then file what it finds
the usual way: every real finding fixed with a test, the fix and the test named in the decisions log
in `docs/DESIGN.md`, anything deferred written into the roadmap's backlog with the reason.

Give the reviewer a clone and let it run things. It must not touch a real install: tell it to set
`POLYPHEMUS_HOME` to a temp folder and `POLYPHEMUS_TAILSCALE=off` for anything it starts, and to work in a
scratch clone rather than the working tree it was handed.

**On the wording.** This asks for the same work as any security review, in the register the work
actually has: does this code stay correct when the files and processes it reads are written by
something unreliable? The 2026-09-19 pass was cut off part way by its vendor's own filter — prompts
written in an offensive-security register get refused or truncated by some models, and that pass lost
everything it hadn't written down. So: engineering questions, concrete inputs, expected versus
actual — and **findings written into the report as they're confirmed, never saved for the end.** If a
vendor still stops part way, that's the tooling, not a verdict on the code; start again elsewhere.

---

You are reviewing one subsystem of an open-source program for correctness when handling input it does
not control. I want defects with evidence — concrete input, what the code does, what it should do —
not a summary of the design, and not reassurance.

Write your findings into the report file as you confirm each one, rather than keeping them until the
end. If you stop early for any reason, what you've written should still be worth reading.

## Reporting, first, because it matters more than finishing

**Write your findings to a markdown file as you confirm each one**, at the path named above in this
repository. Create it with its headings in the first few minutes and append to it as you go — do not
save the report for the end. An earlier reviewer on this project was cut off part way through and
everything it hadn't written down was lost.

**When you finish, reply with the full path to that file and a short summary of what you found** —
the most serious thing in a sentence or two, and a one-line list of the rest. Don't paste the whole
report into your reply; the file is the report.

## What the program is, in one paragraph

Polyphemus runs AI agents on the owner's own computer: they hold conversations, run commands, and — the
part you're reviewing — run **workflows**, which are ordinary code walking a graph of nodes. A node is
either a model doing work (often through a vendor CLI like Claude Code) or something the engine does
itself: running a repository's checks, asking a person a question, pushing a branch, merging a pull
request. The main one is `ship-issue`: take a GitHub issue, plan it, build it in a folder of its own
until the repository's checks pass, have it reviewed by a model from a different vendor, and merge it
once a person says yes.

## The premise to review under

**Treat everything inside a node as unvalidated input to everything outside it.** A language model
can be wrong, can loop, can act on instructions it read in an issue, a dependency or a web page it
was working with. None of that is exotic — it is the normal operating condition of this system. The
engine's correctness therefore cannot depend on a node behaving well.

So for each question below, the shape of the answer is: *given a run folder containing X, does the
engine do Y or Z?* Build the input, run the code, report what happened.

## The claims the code makes

Each of these is a claim in the source or the docs. Your job is to decide whether it holds, and show
your work either way. Treat a claim you can't confirm as a finding in its own right.

1. **Secrets stay in the engine.** GitHub identity tokens are used only by git commands the engine
   runs itself. A node's shell gets an environment with them removed.
2. **A workflow doesn't merge its own work.** Pushes and merges happen as the program's own GitHub
   identities inside the engine, never from a node's shell. A merge requires an approval recorded by
   a different identity, on exactly the commit being merged, plus a person's yes.
3. **State comes from observation, not from what a model said.** A step is done because of an exit
   code, a commit, a service's response, a file, or a person's answer.
4. **Results are bound to the commit they describe.** A check result for one commit must not be read
   as a result for another.
5. **What the engine reads out of a run folder is handled as unvalidated input.** The folder is
   written by the node. `package.json`, a `Makefile`, git output and the files served by the preview
   server are all input, not configuration the engine can trust.
6. **A run's git settings don't reach the engine's git.** The repository's own config, hooks, URL
   rewrites, transports, alternates, credential helpers and filters must not apply to a command the
   engine runs with a token.
7. **A command that comes from the repository is shown to a person before it first runs** — both for
   checks and for the preview server — and one nobody has seen is refused.
8. **Container isolation**, when the owner turns it on, keeps a node's commands and files inside a
   container with only what was granted.

## Where to look

Start here; follow what it leads to.

| Path | What it is |
|---|---|
| `packages/core/src/workflows/git.ts` | Run folders (clones), `SAFE_GIT`, `identityGitEnv`, `noPushEnv`, `pristine`, `prepareWorktree`, `pushBranch`, `removeWorktree`, `sweepSetAside` |
| `packages/core/src/workflows/ship.ts` | `ship-issue` and `spec`: the node graph, the reviewer node, `mergeApproved` |
| `packages/core/src/workflows/checks.ts` | Running a repository's checks; `headCommit`, `failureSignature`, `workingTreeFingerprint` |
| `packages/core/src/workflows/find-checks.ts` | Deciding what the checks are from `package.json`, Cargo, Go, a `Makefile` |
| `packages/core/src/workflows/preview.ts` | Serving the built site from a run folder: a project command, or the program's own file server |
| `packages/core/src/workflows/define.ts`, `builtin.ts`, `intake.ts` | How a workflow is declared, and the other built-ins |
| `packages/daemon/src/runs.ts` | The engine: walking nodes, rounds, budgets, gates, restart and resume |
| `packages/core/src/runs/store.ts`, `status.ts`, `tools.ts` | The run store: runs, steps, evidence, artifacts |
| `packages/core/src/contained.ts` | The path helpers (`readInside`, `readBytesInside`, `renameInside`, `folderInside`, `removeFolderInside`, …) the above rely on |
| `packages/core/src/connections/github.ts` | GitHub App identities and the API calls made with them |
| `packages/core/src/isolation/` | Containers, and the container-side variants of the paths above |
| `docs/design/workflows.md`, `docs/design/isolation.md`, `docs/design/secrets.md` | What it's all meant to do |

Read these tests before concluding something is untested:
`packages/core/test/workflow-boundaries.test.ts`, `git-safety.test.ts`, `no-push.test.ts`,
`find-checks.test.ts`, `runs.test.ts`, `guard.test.ts`, `contained.test.ts`, and the daemon's
`access-matrix.test.ts`.

## Questions to answer

Answer each one, including the ones where the answer is "it holds, and here's the input I tried".

**Run folders and git**

- A run's clone lives at `<project>/.polyphemus-runs/<branch>`, inside a repository the node can write
  to. What happens if the contents change between the engine's calls? Work through: a symbolic link
  in place of a folder, a `.git` that is a file, an `objects/info/alternates` file, `.gitmodules`,
  hooks, `core.fsmonitor`, `include.path` and conditional includes, `insteadOf`, `protocol.*`,
  `credential.helper`, gitattributes filters, a `.git/config` rewritten mid-run, and a folder
  replaced between a check and its use.
- `pushBranch` builds a bundle where the run's commands ran and compares its head against what was
  checked. Is there an input for which a commit the checks never ran on ends up pushed? Can objects
  beyond the branch tip end up in the bundle?
- `pristine()` lends a freshly made clone's objects to a temporary repository as an alternate. Is
  anything the node controls reachable through that path?
- Is there any input for which a fetch or push goes to a host other than the one the identity's token
  is for, or for which the token is handed to a helper, a proxy or an `ext::` transport?
- `noPushEnv` rewrites push URLs to a scheme that goes nowhere. Enumerate what that does and doesn't
  cover: `git send-email`, `git bundle` plus another transfer, `GIT_CONFIG_*` set by the node itself,
  a second git binary earlier on the path, `gh`, `curl`, ssh, a dependency's install script. Which of
  these does container isolation stop, and which are only stopped when it's switched on?

**What the engine reads out of the folder**

- `findChecks` and `findPreview` parse `package.json` and read a `Makefile` from the run folder.
  What's the worst a crafted file does — not only shell metacharacters, but the decisions it steers:
  which package manager, which install command, a script that runs work at install time, a `test`
  script that always exits 0, a list of checks that reads plausibly to the person approving it.
- Those commands are shown to a person before they first run. What exactly is shown, and can what
  runs later differ from what was shown? Is the record of approval bound to the text of the command,
  or to something weaker — a name, a project, a run, a hash of an earlier version? What happens when
  the file changes after approval?
- `workingTreeFingerprint` and `failureSignature` decide whether a round made progress. Is there an
  input that makes a stuck loop look like progress, or a failing round look like a passing one?

**The preview server**

- `serveFiles` serves a run folder over loopback. Check path handling: `..` segments,
  percent-encoding and double encoding, symbolic links, case differences, trailing dots and spaces,
  null bytes, `.git` paths, and non-regular files such as fifos and devices. For each, does it serve
  the file, return 404, or hang?
- With no container, a project's own dev command runs under `bash -lc` on the host. What does it
  inherit — environment, working directory, network access, process group? What survives `stop()`?
  The engine reads the address the command prints: what happens if it prints one of its own choosing,
  and what does the screenshotting browser then open?
- The screenshots become evidence on a step and are given to the reviewer node. Can a run make the
  pictures show something other than what it built?

**Merging**

- Read `mergeApproved` against the GitHub API's actual behaviour. Work through: a dismissed review, a
  stale approval, an approval from an identity the run itself drives, an approval on a different
  commit, a review by the author under a second identity, a repository whose required checks aren't
  what the code assumes, a head that moves between the check and the merge, a fork, a base branch
  changed underneath it.
- Is there any path by which a node's shell, or a model's output, causes a merge — directly, or by
  getting the engine to call it with arguments other than the ones the person approved?
- The person's yes is a gate. What exactly does the person see, and is it bound to the commit they're
  saying yes to?

**The engine**

- What happens to a run when the daemon restarts mid-node: rounds, budgets, gates, permits,
  generations, the folder, a child process left behind? Can a step run twice, or two runs share one
  folder? (Known: a gate waiting at restart is asked again rather than kept — say whether that's
  worse than it sounds.)
- Where does a node's output become the engine's control flow? Anywhere a model's text decides what
  happens next, rather than an observed fact, is a finding.
- Budgets and timeouts: what stops a run consuming tokens or wall-clock indefinitely?

**With and without containers**

- Several functions have a container path and a host path. List every place where the host path runs
  something a node influenced, and say precisely what the owner's isolation setting changes. The
  program's own claim is that without container isolation a process running as the user can reach
  what the user can, and the guards reduce exposure rather than enforce a boundary. I'd rather have
  that stated plainly than overstated in either direction.

## How to work

- Read the code. Run the tests (`pnpm typecheck`, `pnpm test`, or one file with `pnpm test <path>`).
  Write throwaway tests and scratch repositories to prove a claim — that's the point. Don't change
  the repository's own tests or source as part of the review.
- Set `POLYPHEMUS_HOME` to a temp folder and `POLYPHEMUS_TAILSCALE=off` for anything you start. Don't touch
  a real install, don't call the real GitHub, don't use real credentials.
- If you can't demonstrate something, say so and say what you'd need. "Unknown" is a fine answer; a
  confident wrong one is not.
- Skip style, naming and architecture preferences. Skip anything the roadmap already lists as a known
  gap, unless you can show it's worse than described.

## What to hand back

A markdown file, written as you go:

### 1. Findings
Most serious first. For each:
- **What** — one sentence.
- **Where** — file and line.
- **Why it matters** — which of the claims above it breaks, and what goes wrong for someone using it.
- **Evidence** — the input you built, the sequence you ran, the test you wrote and its output. If you
  couldn't get all the way, say exactly where you stopped and what's left to show.
- **How reachable** — does it need containers off, a person's approval, a particular repository
  layout, a race?
- **The test I'd write** — the shape of the regression test that would keep it fixed.

### 2. Claims checked and held
Each claim you went after and couldn't fault, with the inputs you tried. This is as valuable as the
findings: it records what has actually been examined.

### 3. What I didn't cover
Honestly.

### 4. The one thing I'd change
If the owner does one thing from this review, what and why.
