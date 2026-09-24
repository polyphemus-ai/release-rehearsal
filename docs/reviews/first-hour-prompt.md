# Review: a stranger's first hour

Play someone trying Polyphemus for the first time, and find everything that would make them give up
or feel lost. Polyphemus is an open-source agent harness: a daemon on your own computer serving a
phone-first web app. You install it with a one-line script; `poly start` then opens a setup wizard in
the browser, where you pick models (API keys, or vendor CLIs on subscriptions) and name an agent.
Read `README.md` the way that stranger would. Skim `AGENTS.md` only for the ground rules below.

## What to do

1. Build the package as it will be published: `pnpm install`, `pnpm build`, then
   `node scripts/build.mjs --pack` (this makes `dist/polyphemus-<version>.tgz`).
2. In a clean container (`ubuntu:24.04`), follow **only** what the README says. Where it says
   `curl … | sh`, run `POLYPHEMUS_PACKAGE=/path/to/the.tgz sh install.sh` instead: the release doesn't
   exist yet. Note every message the installer prints, and whether it's clear what to do next.
   Answer its questions the way a newcomer would.
3. Run what it tells you next: `poly start`, `poly doctor`, `poly help`. If the container has no
   service manager, note what the person sees and whether it helps them. Then run the daemon directly
   (`poly serve`, with `POLYPHEMUS_TAILSCALE=off`), open the app in a browser (headless Chrome is fine:
   `scripts/smoke.mjs` shows how this project drives Chrome and pairs a device), and walk the first-run
   wizard. Screenshot each step at 400px and 1200px wide. You won't have real model keys: go as far as
   you can (a clearly fake key, for instance), and judge whether a person would understand what to do.
4. Look for: README steps that are wrong, missing or out of order; commands that don't exist or
   behave differently; errors that don't say what to do next; dead ends in the wizard; jargon a
   newcomer wouldn't know; anything slow or silent for long.

## Ground rules

- There's a live install on this machine. Anything run outside the container uses a temp
  `POLYPHEMUS_HOME`, `POLYPHEMUS_TAILSCALE=off`, and a port other than 3900. Never run `poly service …`
  or `systemctl` on the host, and never stop the daemon on 3900.
- Change nothing in the repository except your report and the build output in `dist/`. Sign in to
  nothing real; use no real keys.

## The report

Write it to `docs/research/review-first-hour-<date>-<your vendor>.md`, adding each problem as you find
it. Each problem gets a priority (blocker, annoying, polish), where it happened (README line, command,
or wizard step with its screenshot's path), what the person saw, and a suggested fix. End with what
felt good. Reply with the report's full path and a short summary.
