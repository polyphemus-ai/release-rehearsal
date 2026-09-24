# Review: the public repository, read as a stranger

Read Polyphemus the way someone landing on its GitHub page would, just before its first public
release, and find what would embarrass it. What goes public is exactly what
`node scripts/export-public.mjs <folder>` produces: it leaves out the paths listed in
`scripts/private-files.mjs`. Export into a fresh temp folder and review **that**, not the working tree.

## Check

1. `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, `NOTICE`, `docs/DEVELOPING.md`,
   `docs/RELEASING.md` and `docs/DESIGN.md`: does every claim match what's built? Check commands
   against `packages/cli/src/commands.ts` (the one command registry) and features against the code.
   Flag anything described as working that isn't, and planned things presented as done.
2. Links: every relative link in every markdown file resolves inside the export. Use a script. List
   the external links, but fetch only a handful.
3. Leftovers: old names; internal jargon a stranger can't parse; TODO, FIXME and XXX; references to
   files that don't exist; notes that read like a private diary or are addressed to one person;
   home-folder paths; machine names; anything that looks like a real person's name or address. The
   leak check (`scripts/leak-check.mjs`) catches some of this: look for what it wouldn't.
4. First impressions: from the README, is it clear within 30 seconds what this is, who it's for, how
   to install it, and that it's 0.x? Is anything likely to make a security-minded reader nervous, such
   as a claim of a guarantee the docs elsewhere say isn't one?
5. The published package's metadata (`scripts/build.mjs` writes it): name, description, keywords,
   homepage, repository, bugs, license, engines.

## Ground rules

Change nothing in the repository except your report. Work in a temp folder. Don't run the daemon or
any `poly service` command.

## The report

Write it to `docs/research/review-public-repository-<date>-<your vendor>.md`, adding each finding as
you confirm it. Group the findings as must fix before release, should fix, and nice to have. Each
finding gets its file:line (the same path in the export and the repo), what's wrong, and the
suggested wording or fix. Reply with the report's full path and a short summary.
