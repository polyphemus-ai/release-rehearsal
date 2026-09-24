#!/bin/sh
# The release rehearsal: polyphemus-ai/release-rehearsal publishes this repository's code as the npm
# package polyphemus-rehearsal, through the same workflow, so a change to how Polyphemus is released
# is tried in public before it's trusted with the real package (docs/RELEASING.md, "Rehearsing").
#
#   sh scripts/rehearse.sh <a clone of polyphemus-ai/release-rehearsal>
#
# Brings the clone up to this repository's last commit: the public export, the rename to
# polyphemus-rehearsal (each swap counted, so a moved line fails loudly; the code itself reads its
# published name from its package.json, so only the build, the installer and the workflow need it), and the rehearsal's own
# release state kept: its version, changelogs, changesets and beta mode. To rehearse a release, add a
# changeset there (or `pnpm changeset pre enter beta`) and push.
set -e
R=${1:?Usage: sh scripts/rehearse.sh <a clone of polyphemus-ai/release-rehearsal>}
[ -d "$R/.git" ] || { echo "$R isn't a clone of the rehearsal repository."; exit 1; }
HERE=$(cd "$(dirname "$0")/.." && pwd); R=$(cd "$R" && pwd)
EXPORT=$(mktemp -d); trap 'rm -rf "$EXPORT"' EXIT
(cd "$HERE" && node scripts/export-public.mjs "$EXPORT/export" >/dev/null)
V=$(node -p "require('$R/packages/cli/package.json').version")
rsync -a --delete --exclude '/.changeset/*.md' --exclude '/.changeset/pre.json' --exclude '/.changeset/pre/' --exclude '/packages/*/CHANGELOG.md' --exclude .git --exclude node_modules --exclude dist "$EXPORT/export/" "$R/"
cd "$R"
python3 - <<'PY'
import pathlib
N = 'polyphemus-rehearsal'
swaps = [
  ('.github/workflows/release.yml', '"polyphemus@$VERSION"', f'"{N}@$VERSION"', 3),
  ('install/install.sh', 'WHAT="polyphemus@', f'WHAT="{N}@', 1),
  ('scripts/build.mjs', "  name: 'polyphemus',", f"  name: '{N}',", 1),
  ('scripts/build.mjs', 'github.com/polyphemus-ai/polyphemus', 'github.com/polyphemus-ai/release-rehearsal', 2),
  ('scripts/pack-check.mjs', "join(dir, 'node_modules', 'polyphemus')", f"join(dir, 'node_modules', '{N}')", 1),
]
for f, old, new, n in swaps:
    p = pathlib.Path(f); s = p.read_text(); c = s.count(old)
    assert c == n, f'{f}: expected {n} of {old!r}, found {c}'
    p.write_text(s.replace(old, new))
PY
for p in cli core daemon; do node -e "const f='packages/$p/package.json',j=require('./'+f);j.version='$V';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"; done
echo "Synced to $(cd "$HERE" && git log -1 --format=%h). Look at git status there, then commit (no AI co-author lines) and push."
