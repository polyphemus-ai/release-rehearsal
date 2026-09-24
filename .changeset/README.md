# Changesets

Every change that someone using Polyphemus would notice gets a changeset: run `pnpm changeset`, pick
**patch** (a fix), **minor** (something new — or, before 1.0, something that breaks), or **major**
(after 1.0, something that breaks), and write one line for the changelog in plain words.

The three workspace packages share one version (the `fixed` group), and it's the version of the one
`polyphemus` package that's published. Releasing is CI's job — see `docs/RELEASING.md`.
