# Review prompt: connections, grants and secrets

Fresh ground. The passes on 2026-09-19 and 09-20 covered files agents write, routines, agents in
threads, merge evidence, the read-only classifier, who may call which route, and the workflow engine.
None of them examined how Polyphemus reaches outside services: the vault, grants and their ceilings, the
gateway that hands connection tools to a vendor CLI, OAuth and its refreshes, the GitHub App
identities, browser sign-ins, and what Polyphemus does to keep every one of those out of a model's
sight. That is what this pass is for.

**To run this review,** point a capable model from a vendor that hasn't reviewed this code before at
this file, in a clone it can run things in:

> Read `docs/reviews/connections-and-secrets-prompt.md` in this repository and carry out the review
> it describes.

Everything below the line is written for that reviewer and is the whole brief; there is nothing to
copy out. The notes here are for whoever is running the pass. Save its answer as
`docs/research/connections-review-<vendor>-<date>.md`, which this repository keeps but doesn't
publish (a raw report quotes paths and output from the machine it ran on). Then file what it finds
the usual way: every real finding fixed with a test, the fix and the test named in the decisions log
in `docs/DESIGN.md`, anything deferred written into the roadmap's backlog with the reason.

Two things learned from the earlier passes, already built into the brief below: **findings get
written into the report as they are confirmed, never saved for the end** (one pass was cut off by its
vendor's filter with its report unwritten and everything but a scratch folder was lost), and the
questions are asked in the register the work actually has — does this code hold when the things it
talks to behave badly? Prompts written in an offensive-security register get refused or truncated by
some models, and the subject matter here — credentials — makes that more likely, not less.

The reviewer must not touch the live install: `~/.polyphemus` is a real one, with a real vault and a
daemon serving on port 3900. Temp `POLYPHEMUS_HOME` and `POLYPHEMUS_TAILSCALE=off` for anything started, no
real services, no real credentials, and nothing written inside the repository.

---

You are reviewing one part of an open-source program for correctness in how it handles credentials
and the permissions attached to them. I want defects with evidence — concrete input, what the code
does, what it should do — not a summary of the design, and not reassurance.

Write findings into the report file as you confirm each one, rather than keeping them to the end. If
you stop early for any reason, what you have written should already be worth reading.

## Reporting, first, because it matters more than finishing

**Write your findings to a markdown file as you confirm each one**, at the path named above in this
repository. Create it with its headings in the first few minutes and append to it as you go — do not
save the report for the end. An earlier reviewer on this project was cut off part way through and
everything it hadn't written down was lost.

**When you finish, reply with the full path to that file and a short summary of what you found** —
the most serious thing in a sentence or two, and a one-line list of the rest. Don't paste the whole
report into your reply; the file is the report.

## What the program is

Polyphemus runs AI agents on the owner's own computer, and lets them use outside services — GitHub,
Google, Notion, a bank, a browser, a Linux desktop — through **connections**. A connection is an
account at a service, reached through an MCP server Polyphemus runs or calls. People grant a connection
to a project or to a single agent; agents then call its tools during a turn.

The rule the whole area exists to keep: **no model and no tool ever sees a credential.** Agents get
tool results, never tokens. Polyphemus is honest that this is a guard rather than a boundary — until
worker isolation is on, a process running as the user can reach what the user can — and I want that
distinction kept precisely in your report: say which of your findings need isolation off, and which
hold with it on.

## The premise to review under

Treat four things as unreliable at once, and ask whether the code around them stays correct:

1. **The model.** It can be wrong, can loop, can act on instructions it read in a web page, an
   issue, a file or a tool result it was working with.
2. **The service on the other end.** Its MCP server can return any tool list, any result, any error
   text, at any size, at any time — including tools that appeared after a grant was made.
3. **The other people.** This install can have several people with different roles, and a project
   can be shared. Someone with a narrow role, or none, is an ordinary participant who can reach the
   parts of the system their role allows — reason about what those parts let them cause.
4. **Time.** Grants are narrowed and revoked, people are removed from projects, tokens expire and
   refresh, and turns are long. Something true when a turn started may be false when a call is made.

## The claims the code makes

Each is stated in the source or the docs. Decide whether it holds, and show your work either way. A
claim you cannot confirm is itself worth reporting.

1. **Scope only narrows.** `packages/core/src/connections/scope.ts` states it outright:
   `agent grant ⊆ project grant ⊆ ceiling ⊆ what the server offers`, checked twice — when a grant is
   made (a wider one is refused, not trimmed) and again at every call.
2. **A grant narrowed or revoked mid-turn takes effect on the next call**, whatever tools were
   offered to the model at the start of that turn.
3. **A credential never reaches a model.** Values are masked in tool results and errors
   (`manager.ts`'s redactor, `tools/redact.ts`), kept out of the environment agents' tools run in
   (`tools/guard.ts`), and credential stores can't be read as files.
4. **A vendor CLI reaches connections without ever holding a credential.** The CLI speaks MCP to
   `bin/connections-mcp.mjs`, which has only a socket and a token and forwards to the gateway, where
   the grant is checked at the moment of the call (`connections/gateway.ts`).
5. **A grant with no project is one the agent carries** anywhere it works, including a thread in no
   project, bounded only by the ceiling. Inside a project it has what the project grants plus what
   it carries, and an agent's grant can't widen the project's.
6. **What a service was checked to permit can't be overwritten by a declaration** — the ceiling
   records how it is known (`checked`, `declared`, `unknown`).
7. **A browser sign-in is held back** in any project where someone other than its owner has a role,
   and the model is told why; the cookies live in the vault and are masked in tool results.
8. **GitHub App identities** mint tokens inside the engine for a named repository; an agent's shell
   never holds one.
9. **The trap Polyphemus has written down but not solved** — `docs/design/secrets.md`, under
   "Multiplayer: whose secret, whose bot": a private credential granted to a shared agent leaks by
   proxy. I want to know whether the code's behaviour matches what that section claims about it,
   including anything it says is prevented.

## Where to look

| Path | What it is |
|---|---|
| `packages/core/src/connections/scope.ts` | Ceilings, grants, and the narrowing rule |
| `packages/core/src/connections/manager.ts` | Every call, checked; health; the redactor over results and errors |
| `packages/core/src/connections/gateway.ts` + `packages/core/bin/` | The MCP server a vendor CLI talks to, its socket and token |
| `packages/core/src/connections/mcp-client.ts` | Talking to a server: transports, timeouts, sizes, what a server can say |
| `packages/core/src/connections/oauth.ts` | Sign-in and refresh |
| `packages/core/src/connections/store.ts` | What's recorded about a connection, and what a grant is |
| `packages/core/src/connections/github.ts`, `google.ts`, `plaid.ts`, `simplefin.ts`, `x.ts` | Real services, real credentials |
| `packages/core/src/connections/sign-ins.ts`, `browser.ts`, `computer.ts` | Cookies kept for an agent's browser; the desktop |
| `packages/core/src/secrets/vault.ts`, `packages/core/src/auth/credentials.ts` | The vault, its key, and older plain-text keys |
| `packages/core/src/tools/guard.ts`, `redact.ts` | Keeping credentials out of environments, prompts, logs and results |
| `packages/daemon/src/connections-api.ts`, `access.ts` | The routes people use, and who may |
| `docs/design/secrets.md`, `docs/design/agents.md`, `docs/design/ui/settled-brief.md` §5 | What it's all meant to do |

Read these before concluding something is untested: `packages/core/test/connections.test.ts`,
`vault.test.ts`, `guard.test.ts`, `readonly-services.test.ts`, `browser.test.ts`,
`packages/daemon/test/connections.test.ts`, `access-matrix.test.ts`.

## Questions to answer

Answer each, including where the answer is "it holds, and here's what I tried".

**Grants and ceilings**

- Build the narrowing rule a case at a time: a grant wider than the ceiling, an agent grant wider
  than its project's, a grant naming a tool the server doesn't offer, a grant made before the server
  added a tool, a tool that disappears and returns with the same name and a different schema. Which
  are refused at grant time, which at call time, and is anything trimmed silently rather than
  refused?
- A turn is under way with tools already offered to the model. The grant is narrowed, or revoked, or
  the person who made it loses their role. What happens to the call that lands next? Is the check
  reading current state or something captured earlier?
- A connection is granted to an agent with no project. Which threads can that agent use it in, and
  what stops it being used in a thread where a different person is present?
- `reads: true` decides what counts as read-only, from the server's own `readOnlyHint` or the tool's
  name. What does a server have to say to get a writing tool treated as a reading one, and what does
  that change — approval, isolation level, anything else?

**The credential itself**

- Trace one token end to end: where it is decrypted, what holds it in memory, which processes get it
  in an environment, what is written to disk, what appears in an API response, an event, a log line,
  a status row, an error message. Where does the redactor run, and is there a path around it — a
  result that isn't text, an error thrown before the redactor is installed, a field that isn't
  passed through it, a large result that gets truncated before or after masking?
- The vault: how is it encrypted, where does the key live, what are the file permissions, what
  happens if the key is missing or corrupt, and what does `poly secrets` show?
- A service returns a tool result that contains the credential the caller just used, or another
  connection's. What does the model see?
- `credentialPathFor` blocks reading credential stores as files. What set does it cover, how does it
  decide, and what's the smallest realistic credential store on a developer's machine it doesn't
  know about?

**The gateway to a vendor CLI**

- The CLI talks to a local MCP server over a socket with a token. Who else on the machine can reach
  it while it runs? What authenticates a caller, what is the token's lifetime, and where is it
  written? Can a second CLI, another agent's turn, or a process the agent started reach a gateway
  that isn't theirs?
- The gateway lists "the tools the current speaker may call". What is the speaker bound to, and can
  it change under a call that's already in flight?

**Time and other people**

- Revocation: a person removes a grant, or is removed from a project, while an agent is mid-call, or
  while an MCP server holds an open connection. Is there a case where a call succeeds afterwards?
  This is the one the roadmap names as a launch requirement, so be thorough.
- OAuth refresh: what happens when a refresh fails, when it happens during a call, when two turns
  refresh at once, and when the service returns new tokens — what is stored, and what is redacted
  with which generation of secrets?
- A browser sign-in is held back in a shared project. Check that in the code, not in the doc: what
  exactly is "shared", who counts, and what is the model told?
- Two people, one shared agent, one private credential. Walk it: what can the second person cause
  the agent to do with the first person's credential, and what does the audit record say afterwards?

**The other end behaving badly**

- An MCP server that is slow, that never answers, that returns a gigabyte, that returns a tool list
  of ten thousand tools, that renames its tools between list and call, that returns an error object
  where text is expected, that redirects. Which of these does Polyphemus survive, and what does it do
  to the thread, the daemon and the person watching?
- A service's response is put into a prompt. What in it is treated as data and what could be read as
  instruction — and is there anywhere a tool result decides control flow rather than informing a
  model?

## How to work

- Read the code. Run the tests (`pnpm typecheck`, `pnpm test`, one file with `pnpm test <path>`).
  Write throwaway tests and stand up fake MCP servers to prove a claim — that is the point. Do not
  change the repository's own tests or source, and create nothing inside the repository: if you need
  to write files, copy the repo elsewhere first (`cp -a <repo> /tmp/review-repo`, which brings
  `node_modules` with it) and work there.
- Set `POLYPHEMUS_HOME` to a temp folder and `POLYPHEMUS_TAILSCALE=off` for anything you start. Never read
  from or write to `~/.polyphemus`, never call a real service, never use a real credential, never run
  `poly service ...`. There is a live install on this machine and a daemon on port 3900.
- Say which findings need worker isolation off and which hold with it on.
- If you can't demonstrate something, say so and say what you'd need. "Unknown" is a fine answer; a
  confident wrong one is not.
- Skip style, naming and architecture preferences, and anything the roadmap already lists as a known
  gap unless you can show it's worse than described.

## What to hand back

A markdown file, written as you go:

### 1. Findings
Most serious first. For each: **what** in one sentence; **where**, file and line; **why it matters**,
tied to one of the claims above; **evidence** — the input you built, the sequence you ran, the test
you wrote and its output, and if you couldn't get all the way, exactly where you stopped; **how
reachable** — does it need isolation off, a second person, a particular service, a race; and **the
test I'd write** to keep it fixed.

### 2. Claims checked and held
Each claim you went after and couldn't fault, with the inputs you tried.

### 3. What I didn't cover
Honestly.

### 4. The one thing I'd change
If the owner does one thing from this review, what and why.
