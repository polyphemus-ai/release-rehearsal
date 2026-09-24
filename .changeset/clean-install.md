---
'@polyphemus/cli': patch
---

The install script is tested on a machine that has nothing — no Node, no npm, no git — on Ubuntu,
Debian and Fedora, which is the state a real first install is in and the one CI runners are never
in. On Alpine and other musl systems it now stops and says nodejs.org's builds need glibc, and how
to fix it, instead of unpacking a Node that can't start and failing later with "node: not found".
It also checks for awk and tar before it needs them.
