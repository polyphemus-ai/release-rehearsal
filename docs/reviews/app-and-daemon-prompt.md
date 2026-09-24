# Review prompt: the app and the daemon's surface

The last big area nobody has examined. Earlier passes covered files agents write, routines, agents in
threads, merge evidence, the read-only classifier, the workflow engine, and connections and secrets.
One pass built `packages/daemon/test/access-matrix.test.ts`, which proves **who may call each route**
— it does not check what a route does with what it is given, what it puts in the answer, or what the
app does with any of it once it arrives. That is this pass.

**To run this review,** point a capable model from a vendor that hasn't reviewed this code before at
this file, in a clone it can run things in:

> Read `docs/reviews/app-and-daemon-prompt.md` in this repository and carry out the review it
> describes.

Everything from here on is written for that reviewer, and is the whole brief — there is nothing to
copy out. It ends by writing a report to a file and telling you the path.

## What this is

You are reviewing the HTTP surface of a local daemon and the web app it serves, for correctness in
how it handles input it doesn't control and what it hands back to whom. I want defects with evidence
— concrete request or input, what happens, what should happen — not a summary of the design, and not
reassurance.

## Reporting, first, because it matters more than finishing

**Write your findings to a markdown file as you confirm each one**, at
`docs/research/app-review-<your-vendor>-<today's date>.md` in the repository you are given. Create it
with its headings in the first few minutes and append to it as you go — do not save the report for
the end. An earlier reviewer on this project was cut off part way through and everything it hadn't
written down was lost.

**When you finish, reply with the full path to that file and a short summary of what you found** —
the most serious thing in a sentence or two, and a one-line list of the rest. Do not paste the whole
report into your reply; the file is the report.

## What the program is

Polyphemus runs AI agents on the owner's own computer. A daemon (`packages/daemon`) serves a JSON API
and a web app to the owner's phone and to other people they've added, over the local network and a
tailnet. The app (`packages/daemon/web/app.js`, plain JavaScript, no framework, no bundler) shows
threads where people and agents talk, the files and pictures agents produce, runs and their evidence,
and the settings behind all of it.

Three things about the setting, because they shape what matters:

- **Several people.** The owner, members and viewers of a project, and people with no role at all.
  Someone with a narrow role is an ordinary participant, not a hypothetical.
- **Everything in a thread is model output.** What an agent says, the tool results it quotes, the
  names of files it wrote, the titles it gives things, and the HTML, SVG and Markdown documents it
  produces as artifacts — all of it is rendered in the app, and none of it was written by a person.
- **A phone is a paired device**, holding a cookie, over a network the owner controls but doesn't
  own end to end.

## The claims the code makes

Decide whether each holds, and show your work either way.

1. **The daemon binds to 127.0.0.1 and the Tailscale address, and nothing else**, and every POST is
   refused unless it is same-origin (`server.ts`, `sameOrigin`).
2. **A device is paired by a one-time code**, wrong codes are rate-limited, and a revoked device or a
   removed person stops working — including streams already open.
3. **A route answers only with what its caller may see.** The access matrix proves who may *call*;
   the question here is what comes back in the body: titles, paths, agent names, project names,
   people's names, error text from somewhere they can't see.
4. **An artifact is shown without letting it act.** An HTML artifact is served with
   `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; …; frame-ancestors 'self'`
   — scripts may run, in an opaque origin, with no network — and SVG with a stricter one
   (`server.ts` around the artifact route).
5. **The app builds DOM with `h(tag, attrs, …children)`** and its own CSP forbids inline `style`
   attributes. Nothing a model wrote should be able to become markup, script, a style, or a link
   that acts.
6. **Uploads are yours.** An upload id is a content hash, and knowing one isn't the same as having
   sent it (`server.ts`, "Only your own uploads").
7. **Events are per-device.** `/api/events` streams to one device, and what it carries is what that
   person may see.
8. **A message, a title or a file name can be anything** and still not break a screen: the app must
   work at 400px with text nobody sanitised.

## Where to look

| Path | What it is |
|---|---|
| `packages/daemon/src/server.ts` | The API, pairing, SSE, uploads, artifacts, questions, intake |
| `packages/daemon/src/access.ts` | Who may see and do what |
| `packages/daemon/web/app.js` | The app: one file, plain JS, `h()` and `fill()` |
| `packages/daemon/web/style.css`, `sw.js` | Styling, and the service worker |
| `packages/daemon/src/tailscale.ts` | The other address it binds |
| `packages/core/src/artifacts.ts` | What an artifact is and how it's stored |
| `packages/core/src/session/store.ts` | What the answers are built from |
| `docs/design/ui/settled-brief.md`, `docs/design/app.md` | What it's meant to do |

Read these before concluding something is untested: `packages/daemon/test/access-matrix.test.ts`,
`access.test.ts`, `daemon.test.ts`, `artifacts.test.ts`, `app-integrity.test.ts`.

## Questions to answer

**What a route is given**

- Every route takes ids, names, paths and JSON from the caller. Go looking for the ones that use
  them without checking: a thread id that is a path, a project slug with `..` in it, a file name
  that is absolute, a number where a string was expected, a missing field, a field that is an object
  where a string was expected, an array of a million items, a 100 MB body, a JSON body that parses
  to `null`.
- Uploads: what limits the size, the count, the type? What is the file called on disk, and who can
  read it back? Is the content hash checked against the content?
- Where does a request's value reach the filesystem, a shell, a URL Polyphemus fetches, or an argument
  to something Polyphemus runs?

**What a route hands back**

- Take a person with a role in one project and a person with no role at all. For every route each
  may call, look at what comes back: does any answer carry a thread title, a folder path, an agent's
  name, another project's name, a person's name, or an error message from something they can't see?
  The access matrix does not check this, so this is new ground — be systematic.
- Errors: does a 404 for "doesn't exist" differ from a 404 for "not yours"? Where that difference
  tells someone that something exists, is it worth it?

**Pairing, devices, sessions**

- The pairing code: how long is it, how long does it live, how many tries, is the rate limit per
  device, per address or global, and can a code be used twice? Is the comparison constant-time, and
  does that matter at this length?
- The cookie: flags, lifetime, renewal, and what happens to it when the person is removed, the
  device revoked, or the daemon restarted.
- Open streams: revoke a device, remove a person from a project, change their role. What happens to
  a `/api/events` stream already open, to a computer view, to a run's step stream? An earlier pass
  covered sign-out; the role change and the project removal are the interesting ones.

**Artifacts, and rendering what a model wrote**

- Read the artifact CSP carefully and try to get out of it: navigation, `window.open`, a form,
  `frame-ancestors`, a data: or blob: URL, a service worker, storage, a link the person clicks,
  anything that reaches the network or the app's own origin. Say plainly what the sandbox does and
  doesn't stop, and whether the page can act as the person who opened it.
- In the app: follow one agent message from the store to the screen, and find any place text becomes
  markup — `innerHTML`, `insertAdjacentHTML`, a template string built into DOM, an attribute set
  from a value (`href`, `src`, `style`, `on*`), a Markdown or link renderer, an emoji or mention
  chip, a file name in a download link, a title in a sheet.
- What happens with a title of 100,000 characters, a name that is all combining marks, a right-to-
  left override, a zero-width space in an agent's name, a file called `../../etc/passwd`, an SVG
  with a script in it, a Markdown link with a `javascript:` URL?

**The daemon's own edges**

- What exactly does it bind, and how is the tailnet address decided? What happens if Tailscale
  reports something unexpected? (Don't start a daemon with Tailscale on — set `POLYPHEMUS_TAILSCALE=off`.)
- The same-origin check on POSTs: what counts as same-origin, what about a request with no `Origin`
  header, a `null` origin, a WebSocket-style upgrade, a form post from another page?
- The service worker: what does it cache, could it serve one person's data to another on a shared
  device, and what happens when the app updates?

## How to work

- Read the code. Run the tests (`pnpm typecheck`, `pnpm test`, one file with `pnpm test <path>`).
  The daemon tests start a real daemon on port 0 with fake providers — copy one and adapt it to
  prove a claim, which is the most direct way to demonstrate anything here.
- **Create nothing inside the repository except your report.** If you need to write tests or
  fixtures, copy the repo elsewhere first (`cp -a <repo> /tmp/app-review-repo`, which brings
  `node_modules` with it) and work there. Before you finish, check `git status --short` in the
  original and say in the report that it is clean, or what you left.
- Set `POLYPHEMUS_HOME` to a temp folder and `POLYPHEMUS_TAILSCALE=off` for anything you start. Never read
  from or write to `~/.polyphemus`, never touch port 3900, never run `poly service ...`. There is a
  live install on this machine with real paired devices.
- Say which findings need someone to be signed in at all, and which a stranger on the network could
  reach.
- If you can't demonstrate something, say so and say what you'd need. "Unknown" is a fine answer; a
  confident wrong one is not.
- Skip style, naming and architecture preferences, and anything the roadmap's backlog already lists
  unless you can show it's worse than described.

## What the report contains

### 1. Findings
Most serious first, written as you confirm them. For each: **what** in one sentence; **where**, file
and line; **why it matters**, tied to one of the claims above; **evidence** — the request or input
you built, what came back, the test you wrote and its output, and if you couldn't get all the way,
exactly where you stopped; **who can reach it** — a stranger, a signed-in person with no role, a
viewer, a member, the owner; and **the test I'd write** to keep it fixed.

### 2. Claims checked and held
Each claim you went after and couldn't fault, with the inputs you tried. This says what has actually
been examined, and is worth as much as the findings.

### 3. What I didn't cover

### 4. The one thing I'd change

Then reply with the file's full path and a short summary — not the report itself.
