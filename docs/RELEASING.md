# Releasing Polyphemus

Polyphemus is published to npm as one package, `polyphemus`, built from this repository.

## Versions

[Semantic versioning](https://semver.org): `MAJOR.MINOR.PATCH`.

- **Before 1.0**, a minor bump (0.4 → 0.5) may break things, and a patch (0.5.0 → 0.5.1) only fixes.
- **1.0.0 is a promise:** from then on, a config file and a Polyphemus home (sessions, the vault,
  projects) keep working across every 1.x release. A breaking change needs 2.0.
- A prerelease (`0.6.0-beta.1`) publishes under the `next` tag; everything else under `latest`.

The three workspace packages (`@polyphemus/cli`, `@polyphemus/core`, `@polyphemus/daemon`) are private, share
one version, and are bundled into the published `polyphemus` by `scripts/build.mjs`.

## Day to day

1. With a change someone using Polyphemus would notice, run `pnpm changeset`: pick patch, minor or
   major, and write the changelog line in plain words.
2. Merge to `main`. CI runs on Linux and macOS: typecheck, tests, the app smoke check,
   `scripts/pack-check.mjs` (the package as published, installed into an empty folder and run),
   `scripts/upgrade-check.mjs` (installed with install.sh, updated, a bad update refused, rolled back),
   and the install script on clean Ubuntu, Debian and Fedora machines.
3. The Release workflow keeps a **Version packages** pull request open with the next version and its
   changelog. CI on that pull request waits for someone to approve the run (the pull request's
   Checks, "Approve workflows to run"): GitHub holds runs on pull requests the Actions bot opens.
   Approve it, and merge once it's green.

## Releasing

Who does what: an agent or maintainer prepares and checks; the owner approves and merges. The merge is
the release, so it's always a person's click.

1. **Main is green** on Linux and macOS, and every user-visible change since the last release has a
   changeset.
2. **The Version packages pull request:** read its version and changelog. Approve its CI run (see
   above), wait for green, and merge. A push to `main` after that rebuilds the pull request, and its
   run needs approving again.
3. **The Release workflow** (`.github/workflows/release.yml`) then, from `main` as it is: builds the
   package, runs the pack check (including an npm publish dry run that fails if npm would change
   anything), publishes to npm with provenance through trusted publishing (no npm token lives in the
   repository), waits until npm serves the version (a minute or two), tags `vX.Y.Z`, and makes the
   GitHub release with both install scripts and the notes from `scripts/release-notes.mjs`.
4. **Check it as a user would:** `sh scripts/release-check.sh polyphemus-ai/polyphemus polyphemus
   <previous version> [<a beta>]` — on a clean Ubuntu in Docker, the one-line install from the GitHub
   release gets the new version, and `poly update` brings the older one (and the beta) up to it. On
   npmjs.com the version shows a provenance badge; on GitHub the release is Latest (or Pre-release, for
   a beta).

**A beta:** `pnpm changeset pre enter beta`, commit, push: the Version packages pull request becomes
`X.Y.Z-beta.N`, and its release goes to npm's `next` tag and a GitHub pre-release; `latest` doesn't
move. More changesets, more betas. `pnpm changeset pre exit` makes the next release stable, with every
beta's changes in its notes.

**The first release** is `0.1.0`, with one changelog line: the changesets written before it are
replaced by one (`'@polyphemus/cli': minor`, "The first release."), and every package's version set to
`0.0.0`, just before the export.

## Rehearsing

`polyphemus-ai/release-rehearsal` publishes this code as `polyphemus-rehearsal`, through the same
workflow. A change to the release workflow, the build, the install scripts or `poly update` is tried
there before it's trusted with the real package: `sh scripts/rehearse.sh <a clone of it>` brings it up
to this repository's last commit (keeping its own version, changelogs and changesets), then commit
and push there, add a changeset, and release it as above. The rehearsal of 2026-09-23 ran 0.1.0, a
beta and 0.1.1 end to end, and found everything in the next section. The npm package was deleted
afterwards (2026-09-24): to rehearse again, claim `polyphemus-rehearsal` with a placeholder and add
the trusted publisher first, as for the real package.

## Traps (each found the hard way)

- `npm publish dist/polyphemus` publishes the GitHub repository `dist/polyphemus`: the folder needs `./`.
- npm 11 drops a `bin` entry written `./bin/…` when publishing, but not when installing a tarball — so
  a package with no `poly` passes an install test. The pack check's publish dry run catches that kind.
- `changesets/action@v1` can't read the `.changeset/pre` folder Changesets 3 keeps during a beta; v2
  can, with renamed inputs (`version-script`, `pr-title`, `commit-message`, `has-changesets`).
- A release run that started before the Version packages merge and finished after it reopened that
  pull request from the old commit: the workflow checks out `main` as it is, not the commit that
  started it.
- `changeset status` needs `main`'s history, which a pull request's checkout lacks; changeset names
  are checked by a test (`scripts/changesets.test.mjs`) instead. A changeset names a workspace package
  (`'@polyphemus/cli'`), never the published `polyphemus`.
- A first release's changelogs list the packages' version bumps as entries: the notes leave them out.
- Anything that changes the database's shape only adds (a table, a column with a default); a change
  an older version would misread raises `DATA_GENERATION` (docs/design/upgrades.md). `poly self-check`
  and `scripts/upgrade-check.mjs` are what stop a release that can't read its users' data.
- gitleaks-action fails on a repository's first commit (there's no commit before it to diff from):
  CI runs the gitleaks binary over the whole history instead.
- macOS's `/bin/sh` reads `$WHAT…` as a variable named `WHAT…`: write `${WHAT}…`
  (`scripts/shell-scripts.test.mjs`). Its Unix socket paths stop at 104 bytes, `/var` is a link to
  `/private/var`, and `/home` is an automount — tests that build paths there need care.

## Channels and the install script

- **Channels.** An install follows `stable` (npm's `latest` tag) or `beta` (`next`, or `latest` when
  a stable release is newer): `updates.channel` in config.toml, switched with
  `poly update --channel beta|stable`. The daily check and `poly update` follow it.
- **The install script** is `install/install.sh`, for macOS and Linux. It uses the computer's Node
  if it's 22.13 or newer, and otherwise downloads Node 22 from nodejs.org and checks it against the
  published checksum. It installs the package with npm into `~/.local/share/polyphemus/versions/<version>`,
  with no sudo, points `current` at it, and writes `poly` and `polyphemus` wrappers into
  `~/.local/bin` that run through `current`. Run again over an install, it leaves the package alone and
  says to use `poly update`. `POLYPHEMUS_CHANNEL=beta` installs
  from the beta channel. `poly update` installs the next version beside it, checks it against a copy of
  the data, backs the data up, switches, and goes back on its own if the service doesn't come up
  ([design/upgrades.md](design/upgrades.md)); `poly rollback` goes back by hand. CI runs the script
  against the packed package on Linux and macOS.
- **Every release carries it.** The Release workflow makes a GitHub release for each version with
  `install.sh` and `install.ps1` attached, and its part of the changelog as the notes. Betas are pre-releases, so
  `releases/latest/download/install.sh` is always the newest stable release's script. polyphemus.ai
  serves `/install.sh` by redirecting there.
- **Windows** is `install/install.ps1`: it finds, installs or updates WSL2 and Ubuntu, turns on
  systemd (asking first each time), then runs `install.sh` inside WSL. Native Windows is on the roadmap.

## Before the first release

- Make the public repository with `node scripts/export-public.mjs <folder> --commit --author "Name <email>"`:
  the last commit's files, minus what stays private, checked against the leak denylist — never this
  repository's history. What stays private is one list, `scripts/private-files.mjs`: the export
  removes it, and the leak check skips it when it checks this repository (so the pre-commit hook
  works on a clone that has those files) and checks everything else, wherever it's published from.
- On npmjs.com: add this repository's Release workflow (`release.yml`) as a trusted publisher for the
  `polyphemus` package, publishing access "Require two-factor authentication and disallow tokens". A trusted publisher can only be added to a package that
  already exists, so the name is claimed first with a placeholder published by hand.
- On GitHub: the repository lives under the `polyphemus-ai` account (no organisation, for now). Allow
  Actions to create pull requests (Settings → Actions → General → Workflow permissions); under an
  organisation, the organisation's switch has to be on first, or the Release workflow fails at "GitHub
  Actions is not permitted to create or approve pull requests".
- On GitHub, turn on private vulnerability reporting (Settings → Security → Private vulnerability
  reporting): it's off on a new repository, and SECURITY.md sends reports there.
- Commits in the public repository carry no `Co-Authored-By` lines naming an AI: GitHub lists every
  co-author as a contributor. The export's fresh commit has none; keep it that way for what follows.
- The repository's About: `gh repo edit polyphemus-ai/polyphemus --description "One agent harness for
  Claude, OpenAI and Grok — their APIs or your own subscriptions — running on your computer, reachable
  from your phone. 👁️" --homepage https://polyphemus.ai --add-topic
  ai,ai-agents,agent-harness,llm,claude,openai,grok,mcp,self-hosted,multi-agent,typescript`.
