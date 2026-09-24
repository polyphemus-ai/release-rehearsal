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
2. Merge to `main`. CI runs on Linux and macOS: typecheck, tests, the app smoke check, and
   `scripts/pack-check.mjs`, which installs the package as published into an empty folder and runs it.
3. The Release workflow keeps a **Version packages** pull request open with the next version and its
   changelog. CI on that pull request waits for someone to approve the run (the pull request's
   Checks, "Approve workflows to run"): GitHub holds runs on pull requests the Actions bot opens.
   Approve it, and merge once it's green.

## Releasing

Merge the **Version packages** pull request. The Release workflow then:

1. builds the package and runs the pack check again,
2. publishes it to npm with provenance, through npm trusted publishing (no npm token lives in the
   repository),
3. tags the commit `vX.Y.Z`.

## Channels and the install script

- **Channels.** An install follows `stable` (npm's `latest` tag) or `beta` (`next`, or `latest` when
  a stable release is newer): `updates.channel` in config.toml, switched with
  `poly update --channel beta|stable`. The daily check and `poly update` follow it.
- **The install script** is `install/install.sh`, for macOS and Linux. It uses the computer's Node
  if it's 22.13 or newer, and otherwise downloads Node 22 from nodejs.org and checks it against the
  published checksum. It installs the package with npm into `~/.local/share/polyphemus`, with no sudo,
  and writes `poly` and `polyphemus` wrappers into `~/.local/bin`. `POLYPHEMUS_CHANNEL=beta` installs
  from the beta channel. `poly update` updates an install made this way in place. CI runs the script
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
- On npmjs.com: create the organization, and add this repository's Release workflow as a trusted
  publisher for the `polyphemus` package. A trusted publisher can only be added to a package that
  already exists, so the name is claimed first with a placeholder published by hand.
- On GitHub: allow Actions to create pull requests **for the organization**, not only the repository
  (the organization's Settings → Actions → General → Workflow permissions). With the organization's
  switch off, the repository's can't be turned on, and the Release workflow fails at "GitHub Actions
  is not permitted to create or approve pull requests" — found by the release rehearsal.
- The whole process is rehearsed in public on a stand-in package first, with the same workflow as
  this repository's, kept apart from Polyphemus so nothing links the two.
