# Review: installing, updating, and what changed before the first release

You're reviewing Polyphemus, an open-source agent harness: a daemon on a person's own computer that
runs AI agents (Claude, OpenAI, Grok, through their APIs or the vendors' own CLIs) and serves a
phone-first web app over their tailnet. Read `AGENTS.md` first, especially "Never", and look at one
earlier review prompt in this folder for the standard expected.

The question throughout: **does this code stay correct when what it reads — a registry's answer, an
environment variable, a path, a web page an agent opened, another device's request — was written by
something unreliable?** Every finding must be reproduced (a command, test or script, and what it
printed). Anything you couldn't reproduce is labelled "suspected", with why.

## Scope

What changed since commit `c893517832`, the last reviews (`git log --oneline c893517832..HEAD`). The
code with the most power first:

1. **The installers:** `install/install.sh` (`curl | sh`; installs Node when needed; each version in
   its own folder with `current` pointing at the one in use; offers to install vendor CLIs) and
   `install/install.ps1` (Windows: finds, installs or updates WSL, enables systemd as root inside WSL,
   then runs install.sh). Injection through environment variables or paths, temp files, downloads
   and their checks, anything done as root that needn't be, partial failure.
2. **Updates:** `packages/cli/src/upgrade.ts`, `service.ts`, and `update` / `rollback` / `self-check`
   in `main.ts` (design: `docs/design/upgrades.md`). It installs a version beside the running one, has
   it check itself against a copy of the data (the database, config, vault and its key), backs the
   data up, switches a symlink, watches the service, and restores the backup when it doesn't come
   up. Look at permissions on backups and copies, what an agent's tools can reach (`tools/guard.ts`,
   `readonly.ts`), version strings from the registry, symlinks, restoring under a running daemon, and
   what's left behind when something is killed partway.
3. **The app installing vendor CLIs:** `POST /api/providers/:id/install`, `packages/core/src/discover.ts`.
   Who may call it (`packages/daemon/test/access-matrix.test.ts`), and whether anything user-controlled
   reaches a shell.
4. **Browser sign-ins keeping site storage:** `packages/core/src/browser/tab.ts`,
   `packages/core/src/connections/sign-ins.ts`, `manager.ts`, `browser.ts`,
   `packages/daemon/src/connections-api.ts`. Are stored values redacted wherever a model or a log could
   see them; can one site's sign-in reach another site, or another project, without the person saying so.
5. **Repeated requests:** the `Idempotency-Key` replay cache in `packages/daemon/src/server.ts`. Can a
   device or person ever be given another's response.
6. **`poly doctor`** and other new status output: does any of it print a credential.
7. **The release workflow** (`.github/workflows/release.yml`): what runs with permission to publish.
8. Anything else in the diff you judge risky.

## Ground rules

- There's a live install on this machine with a real vault and paired devices. Anything you run uses
  a temp `POLYPHEMUS_HOME`, `POLYPHEMUS_TAILSCALE=off`, and a port other than 3900. Never run
  `poly service …` or `systemctl`, never stop or restart the daemon on 3900, and never run the install
  scripts against this machine's own home: use a container (Docker is available) or point `HOME`,
  `POLYPHEMUS_PREFIX` and `POLYPHEMUS_BIN_DIR` at temp folders.
- Change nothing in the repository except your report. Scratch work goes in a temp folder.
- Contact no outside service beyond what the test suite already does.

## The report

Write it to `docs/research/review-installers-and-updates-<date>-<your vendor>.md`, adding each
finding **as soon as it's confirmed**: don't save them for the end. Each finding: severity, file:line,
what's wrong in a sentence or two, the reproduction and its output, and a suggested fix. End with what
you checked and found sound. Reply with the report's full path and a short summary.

An earlier pass (Claude, 2026-09-24) reported findings on the vault copies an update makes, registry
version strings, sign-ins matched across sites too loosely, restoring under a daemon run in a
terminal, Grok's permission mode, the release job's permissions, and the installers. Fixes for those
may be in by the time you run this: check that they hold, rather than taking them as done.
