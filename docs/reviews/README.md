# Review prompts

Independent review passes, one prompt per area. Point a capable model from a vendor that hasn't seen
this code before — a different one each time is the point — at the prompt file, in a clone it can run
things in. Nothing needs copying out of these files:

> Read `docs/reviews/<the prompt>.md` in this repository and carry out the review it describes.

Each one ends by writing its report to a file and telling you the path.

| Prompt | Area | Run |
|---|---|---|
| [workflow-engine-prompt.md](workflow-engine-prompt.md) | Run folders and git, what the engine reads out of a run, the preview server, merge approval, restart | 2026-09-20 (Claude) — five findings fixed |
| [connections-and-secrets-prompt.md](connections-and-secrets-prompt.md) | The vault, grants and ceilings, the gateway a vendor CLI talks to, OAuth, GitHub identities, sign-ins | 2026-09-20 (Grok) — five findings fixed, one working as intended, two product decisions |
| [app-and-daemon-prompt.md](app-and-daemon-prompt.md) | The HTTP surface and the app: what a route is given, what it hands back to whom, pairing and devices, artifacts, rendering what a model wrote | 2026-09-20 (Grok): one finding fixed, one left as it is on purpose |
| [installers-and-updates-prompt.md](installers-and-updates-prompt.md) | Before the first release: the installers, updates and their backups, the app installing CLIs, browser sign-ins' stored data, repeated requests, the release workflow | 2026-09-24 (Claude): findings being fixed |
| [first-hour-prompt.md](first-hour-prompt.md) | A stranger installs it from the README on a clean machine and walks the setup wizard | 2026-09-24 (Claude) |
| [public-repository-prompt.md](public-repository-prompt.md) | The public export read as a stranger: claims against the code, links, leftovers, first impressions | 2026-09-24 (Claude): fixed |

Reports go in `docs/research/`, which this repository keeps but doesn't publish: a raw report quotes
paths and output from the machine it ran on.

## What every one of these says, and why

- **Findings written into the report as they're confirmed, never saved for the end**, and the reply
  gives the report's full path plus a short summary. The 2026-09-19 pass was cut off part way by its
  vendor's own filter with its report unwritten, and everything but a scratch folder was lost.
- **The questions are asked in the register the work actually has** — does this code stay correct
  when what it reads is written by something unreliable? Prompts written in an offensive-security
  register get refused or truncated by some models, and these questions don't need it.
- **Nothing is created inside the repository except the report**, and there's a live install on the
  machine with a real vault and real paired devices: temp `POLYPHEMUS_HOME`, `POLYPHEMUS_TAILSCALE=off`,
  hands off `~/.polyphemus` and port 3900.
- **What held is reported as carefully as what didn't**, so each pass says what has actually been
  examined.

## Afterwards

Every finding is checked against the current code before anything changes — reviews run against a
snapshot, and on 2026-09-20 six of one report's nine findings were already closed, and one described
behaviour that is deliberate and tested. Then: fixed with a test, the fix and the test named in the
decisions log in [DESIGN.md](../DESIGN.md), anything deferred written into the roadmap's backlog
with the reason.
