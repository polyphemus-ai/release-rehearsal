#!/bin/sh
# Installs Polyphemus on a machine that has nothing: no Node, no npm, no git — the state a real
# first install is in, and the one CI runners are never in, because they ship all three.
#
#   docker run --rm -v "$PWD/dist:/work:ro" -e HOME=/root ubuntu:24.04 sh /work/clean-install-check.sh apt
#
# $1 is how to install the one thing the script itself needs (curl), since a person piping curl
# into sh already has it. Everything after that is the installer's job, and is checked below.
set -e
case "$1" in
  apt) apt-get update -qq >/dev/null && apt-get install -y -qq curl ca-certificates >/dev/null 2>&1 ;;
  dnf) dnf install -y -q curl tar >/dev/null 2>&1 ;;
  apk) apk add --quiet curl >/dev/null 2>&1 ;;
esac

# musl: nodejs.org has no build that runs here, so the one thing to check is that it says so
# plainly and stops, rather than unpacking a Node that can't start (2026-09-22).
if [ "$1" = apk ]; then
  POLYPHEMUS_PACKAGE="$(ls /work/polyphemus-*.tgz)" sh /work/install.sh >/tmp/out.txt 2>&1 && { echo "FAIL: it claimed to install on musl"; exit 1; }
  grep -q "need glibc" /tmp/out.txt || { echo "FAIL: no glibc explanation, only:"; cat /tmp/out.txt; exit 1; }
  grep -q "apk add nodejs npm" /tmp/out.txt || { echo "FAIL: didn't say how to fix it"; exit 1; }
  echo "OK: refused musl, explained why, and said how to fix it"
  exit 0
fi

echo "--- this machine before: ---"
for c in node npm git; do command -v $c >/dev/null 2>&1 && { echo "FAIL: $c is already here, this isn't a clean machine"; exit 1; } || echo "  no $c"; done

echo "--- running the one-liner ---"
POLYPHEMUS_PACKAGE="$(ls /work/polyphemus-*.tgz)" sh /work/install.sh 2>&1 | tee /tmp/out.txt

echo "--- checks ---"
test -x "$HOME/.local/bin/poly" || { echo "FAIL: no poly command"; exit 1; }
test -x "$HOME/.local/share/polyphemus/node/bin/node" || { echo "FAIL: Node wasn't downloaded"; exit 1; }
V=$("$HOME/.local/bin/poly" --version) || { echo "FAIL: poly --version did not run"; exit 1; }
WANT=$(ls /work/polyphemus-*.tgz | sed 's/.*polyphemus-//; s/\.tgz$//')
test "$V" = "$WANT" || { echo "FAIL: version is '$V', wanted '$WANT'"; exit 1; }
grep -q "needs git" /tmp/out.txt || { echo "FAIL: no git warning though git is missing"; exit 1; }
grep -q "poly start" /tmp/out.txt || { echo "FAIL: didn't point at poly start"; exit 1; }
# With nobody at a terminal to ask, the subscription CLIs are only described, never installed.
grep -q "To install one later" /tmp/out.txt || { echo "FAIL: didn't say how to install the CLIs later"; exit 1; }
[ ! -e "$HOME/.grok/bin/grok" ] && [ ! -e "$HOME/.local/bin/claude" ] || { echo "FAIL: installed a CLI nobody asked for"; exit 1; }
echo "OK: installed $V, downloaded its own Node, warned about git, pointed at poly start, installed no CLI unasked"
