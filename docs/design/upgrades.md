# Upgrades

An update must never leave Polyphemus broken. It can fail, and say why; it can't leave someone with
a daemon that won't start, data the running version can't read, or a half-installed package — the
things that make people dread updating a self-hosted tool and reach for a terminal to repair it.

The version that runs an update is the old one. Whatever makes updates safe has to ship before the
update that needs it: it was in place before the first release (2026-09-24).

## How `poly update` goes

1. **Beside, never over.** The installer's layout keeps each version in a folder of its own —
   `~/.local/share/polyphemus/versions/<version>/` — with `current` pointing at the one in use. The
   service, and the `poly` and `polyphemus` commands, run through `current`. An update installs the
   next version into its own folder; nothing that's running is touched. If npm fails partway, the
   folder is removed and nothing else has changed.
2. **It checks itself on a copy of your data.** The new version runs `poly self-check`: a copy of
   `sessions.db` (a consistent snapshot, safe while it's in use), `config.toml`, the vault and its key,
   agents and routines, made in `~/.polyphemus/self-check/` and removed afterwards (also when the check
   is killed partway; one left by a check that died is swept by the next). It applies its own
   database changes to the copy, reads the config, decrypts a secret (never shown), and loads agents,
   routines, threads, projects and people. It starts nothing that acts: no turns, routines, runs or
   connections — a whole daemon started on a copy would send queued messages and resume runs for
   real. If anything fails, the update stops there, with nothing changed. It also checks the new
   version's Node.js requirement against this computer's.
3. **Nothing mid-work.** It waits for turns and workflow runs going (not those waiting on a person:
   a restart asks their gate again), up to an hour, or goes ahead with `--now`.
4. **A backup.** `sessions.db`, `config.toml` and the vault, into `~/.polyphemus/backups/`, the last
   three kept. Backups and the self-check's copy hold the vault and its key, so the credential guard
   covers both folders, as it does the vault itself.
5. **The switch.** `current` moves to the new version in one step, and the service restarts onto it.
6. **Watched.** The daemon has to answer within 90 seconds and still be answering five seconds later.
   If it doesn't, the service is stopped, the backup is put back, `current` moves back, and the service
   starts again on the old version — on its own, and it says so.

`poly rollback` goes back later, by hand: to the version before the last update, keeping the data
(see below), or with `--restore`, putting back the backup from just before that update too, and losing
what happened since. The last three versions are kept on disk. `~/.polyphemus/updates.json` records
each update, where its backup is, and how it ended.

A plain `npm install -g polyphemus` can't keep versions side by side: npm replaces the package in
place. The same checks run (the new version is installed into a staging folder first, for its
self-check), and going back reinstalls the old version from npm.

Running the installer again over an installed Polyphemus leaves the package alone and says to use
`poly update`, so a second `curl | sh` never swaps a running version without the checks. Asking for a
particular version or package (`POLYPHEMUS_VERSION`, `POLYPHEMUS_PACKAGE`) installs it and switches.

## Data only ever adds

Going back a version keeps the data because the database only ever adds: a new table, or a column
with a default. An older version ignores what it doesn't know. `DATA_GENERATION` in
`packages/core/src/session/store.ts` is stamped in the database (`PRAGMA user_version`); a change an
older version would misread — dropping, renaming or changing the meaning of a column — raises it, and
an older version then refuses to open the data, saying to update or to `poly rollback --restore`,
rather than writing into what it can't understand. Config works the same way: settings that aren't
known are ignored, never fatal, and a change a version makes to them is a revision `poly config undo`
reverses.

## How it's tested

- `scripts/upgrade-check.mjs` (CI, Linux and macOS): three versions of the current build, served
  by a stand-in npm registry. The first is installed with the real installer, and data made with it
  (a secret, a setting, its history). An update to the second must go live with the data intact and
  a backup made; one to the third, which can't read the data, must be refused with nothing changed;
  `poly rollback` must bring back the first.
- `packages/cli/test/upgrade.test.ts`: the service half, with a stand-in service — live when healthy;
  when not, the old version and the backup put back, the service stopped before the data is replaced.
- `scripts/release-check.sh`, after a real release: installs from the GitHub release on a clean
  machine, and `poly update` from the previous version.
