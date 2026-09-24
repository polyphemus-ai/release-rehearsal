// What this repository keeps but never publishes: real data from the building install, notes about
// private systems, and the move from the names it had before Polyphemus (which nobody outside ever used). `export-public.mjs` removes these from the public copy, then checks what's
// left; `leak-check.mjs` skips them when it checks this repository, so the pre-commit hook works on
// a clone that has them. Anything that is published is checked, in the folder it's published from.
export const PRIVATE = ['docs/research', 'docs/design/ui/snapshot-2026-09-12.html', 'memory', 'docs/MOVING.md', 'scripts/move-in.mjs', 'docs/brand/original'];

export const inPrivate = (path) => PRIVATE.some((p) => path === p || path.startsWith(`${p}/`));
