#!/bin/sh
# Installs Polyphemus on macOS or Linux, and Node.js with it if yours is missing or too old.
#
#   curl -fsSL https://polyphemus.ai/install.sh | sh
#   curl -fsSL https://polyphemus.ai/install.sh | POLYPHEMUS_CHANNEL=beta sh
#
# Everything goes in your own folders, with no sudo: Node (if it's needed) and the package in
# ~/.local/share/polyphemus, and the `poly` and `polyphemus` commands in ~/.local/bin. Nothing about
# you or this computer is sent anywhere; it downloads Node from nodejs.org and the package from npm.
#
# Settings, all optional:
#   POLYPHEMUS_CHANNEL   stable (default) or beta
#   POLYPHEMUS_VERSION   an exact version instead of the channel's newest
#   POLYPHEMUS_PREFIX    where the package (and Node, if needed) goes; default ~/.local/share/polyphemus
#   POLYPHEMUS_BIN_DIR   where the commands go; default ~/.local/bin
#   POLYPHEMUS_PACKAGE   a package file to install instead of npm's (for testing a build)
#   POLYPHEMUS_NODE      "download" to use Polyphemus's own Node even when yours would do
#   POLYPHEMUS_CLIS      which subscription CLIs to install without asking: claude,codex,grok, all, or
#                        none. Unset, it asks at a terminal, and only says how when there isn't one.
set -eu

NODE_MAJOR=22
NODE_MIN=22.13.0
CHANNEL="${POLYPHEMUS_CHANNEL:-stable}"
PREFIX="${POLYPHEMUS_PREFIX:-$HOME/.local/share/polyphemus}"
BIN_DIR="${POLYPHEMUS_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'polyphemus install: %s\n' "$*" >&2; exit 1; }

case "$CHANNEL" in
  stable) TAG=latest ;;
  beta) TAG=next ;;
  *) fail "POLYPHEMUS_CHANNEL is stable or beta, not \"$CHANNEL\"." ;;
esac

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) fail "this installer is for macOS and Linux. On Windows, run it inside WSL2." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) fail "no Node.js build for $(uname -m)." ;;
esac

command -v curl >/dev/null 2>&1 || fail "it needs curl."
command -v awk >/dev/null 2>&1 || fail "it needs awk."
command -v git >/dev/null 2>&1 || say "Note: Polyphemus needs git for projects and workflows, and it isn't installed. Install it before you use them."

# "22.13.0" is at least "22.13.0"? Compared as numbers, part by part.
at_least() {
  awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, "."); for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 0 }'
}

NODE=""
if [ "${POLYPHEMUS_NODE:-}" != "download" ] && command -v node >/dev/null 2>&1; then
  HAVE="$(node -p 'process.versions.node' 2>/dev/null || true)"
  if [ -n "$HAVE" ] && at_least "$HAVE" "$NODE_MIN"; then
    NODE="$(command -v node)"
    say "Using your Node.js $HAVE."
  else
    say "Your Node.js is ${HAVE:-unknown}; Polyphemus needs $NODE_MIN or newer, so it gets its own."
  fi
fi

if [ -z "$NODE" ]; then
  # The newest Node $NODE_MAJOR for this computer, checked against nodejs.org's published checksums.
  command -v tar >/dev/null 2>&1 || fail "it needs tar to unpack Node.js."
  # nodejs.org builds against glibc. On musl (Alpine) they unpack and then won't run, which used to
  # read as "node: not found" and a failed npm install rather than as what it is.
  # Only when musl is positively there: an unknown system goes ahead, and the check after the
  # download catches it if the binaries turn out not to run.
  if [ "$OS" = linux ] && { ldd /bin/sh 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; }; then
    fail "the Node.js builds on nodejs.org need glibc, and this system doesn't use it (Alpine and other musl systems). Install Node.js $NODE_MIN or newer with your package manager first — on Alpine: apk add nodejs npm — then run this again."
  fi
  BASE="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")" || fail "couldn't reach nodejs.org."
  FILE="$(printf '%s\n' "$SUMS" | awk -v want="-$OS-$ARCH.tar.gz" '$2 ~ want"$" && $2 ~ /^node-v/ { print $2; exit }')"
  [ -n "$FILE" ] || fail "nodejs.org has no Node.js $NODE_MAJOR for $OS-$ARCH."
  WANT="$(printf '%s\n' "$SUMS" | awk -v f="$FILE" '$2 == f { print $1 }')"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  say "Downloading ${FILE}…"
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE" || fail "couldn't download Node.js."
  if command -v sha256sum >/dev/null 2>&1; then GOT="$(sha256sum "$TMP/$FILE" | awk '{ print $1 }')"; else GOT="$(shasum -a 256 "$TMP/$FILE" | awk '{ print $1 }')"; fi
  [ "$GOT" = "$WANT" ] || fail "the Node.js download didn't match its checksum. Nothing was installed."
  mkdir -p "$PREFIX"
  rm -rf "$PREFIX/node"
  mkdir -p "$PREFIX/node"
  tar -xzf "$TMP/$FILE" -C "$PREFIX/node" --strip-components=1
  NODE="$PREFIX/node/bin/node"
  GOT_VERSION="$("$NODE" -p 'process.versions.node' 2>/dev/null || true)"
  [ -n "$GOT_VERSION" ] || fail "Node.js downloaded but won't run on this system. Install Node.js $NODE_MIN or newer with your package manager, then run this again."
  say "Node.js $GOT_VERSION is in $PREFIX/node."
fi

NODE_BIN="$(dirname "$NODE")"
NPM="$NODE_BIN/npm"
[ -x "$NPM" ] || NPM="$(command -v npm || true)"
[ -n "$NPM" ] || fail "found Node.js but not npm beside it."

if [ -n "${POLYPHEMUS_PACKAGE:-}" ]; then WHAT="$POLYPHEMUS_PACKAGE"; else WHAT="polyphemus-rehearsal@${POLYPHEMUS_VERSION:-$TAG}"; fi
say "Installing ${WHAT}…"
mkdir -p "$PREFIX" "$BIN_DIR"
PATH="$NODE_BIN:$PATH" "$NPM" install --global --prefix "$PREFIX" --no-fund --no-audit --no-update-notifier --loglevel=error "$WHAT" || fail "npm couldn't install $WHAT."

LAUNCHER="$PREFIX/lib/node_modules/polyphemus-rehearsal/bin/polyphemus.mjs"
[ -f "$LAUNCHER" ] || fail "the package installed, but its launcher isn't at $LAUNCHER."
# Small wrappers rather than npm's links: they run the Node this install chose, whatever else is on
# PATH later, and `poly update` finds the same npm.
for name in poly polyphemus; do
  cat > "$BIN_DIR/$name" <<EOF
#!/bin/sh
PATH="$NODE_BIN:\$PATH" exec "$NODE" "$LAUNCHER" "\$@"
EOF
  chmod 755 "$BIN_DIR/$name"
done

# The channel, kept where poly reads it, so `poly update` follows the same one.
if [ "$CHANNEL" = beta ]; then "$BIN_DIR/poly" config set updates.channel beta >/dev/null 2>&1 || true; fi

# The CLIs that use a Claude, ChatGPT or SuperGrok plan rather than an API key: offered, never
# assumed, since someone with only a key needs none of them. Each goes where its vendor's own
# installer puts it (neither needs a password), or, from npm, into Polyphemus's own folder — the same
# three ways the app's setup offers (packages/core/src/discover.ts). Asked through /dev/tty, since
# `curl | sh` is reading this script on its input.
TOOLS="${XDG_DATA_HOME:-$HOME/.local/share}/polyphemus/tools"
ASK=no
if [ -z "${POLYPHEMUS_CLIS:-}" ] && [ -t 1 ] && (: </dev/tty) 2>/dev/null; then ASK=yes; fi
wants() {
  case ",${POLYPHEMUS_CLIS:-}," in *",all,"*|*",$1,"*) return 0 ;; esac
  [ "$ASK" = yes ] || return 1
  printf '%s [y/N] ' "$2" >/dev/tty
  read -r answer </dev/tty || answer=""
  case "$answer" in y|Y|yes|Yes) return 0 ;; *) return 1 ;; esac
}
have() { command -v "$1" >/dev/null 2>&1 || [ -x "$2" ]; }
say ""
say "Polyphemus can use a Claude, ChatGPT or SuperGrok plan through that company's own CLI. Skip any"
say "you don't have: an API key works instead, and setup in the app can install these later too."
LATER=""
offer() { # name, command, where its installer puts it, what it's for, how to install, [that, as said]
  if have "$2" "$3"; then say "  ✓ $1 is already here"; return; fi
  if wants "$2" "  Install $1 (for $4)? It runs: ${6:-$5}"; then
    say "  Installing $1…"
    if sh -c "$5" >"$TMP_LOG" 2>&1 && have "$2" "$3"; then say "  ✓ $1 is installed. Sign in to it in setup."
    else say "  ✗ $1 didn't install; its last lines:"; tail -5 "$TMP_LOG" | sed 's/^/      /'; fi
  else
    LATER="$LATER\n    $1: ${6:-$5}"
  fi
}
TMP_LOG="$(mktemp)"
offer "Claude Code" claude "$HOME/.local/bin/claude" "a Claude Pro or Max plan" "curl -fsSL https://claude.ai/install.sh | bash"
# Said without the Node paths it needs to run, which are this install's own and would only be noise.
offer "Codex" codex "$TOOLS/bin/codex" "a ChatGPT plan" "PATH=\"$NODE_BIN:\$PATH\" \"$NPM\" install -g --prefix \"$TOOLS\" --no-fund --no-audit --loglevel=error @openai/codex" "npm install -g @openai/codex, into $(echo "$TOOLS" | sed "s|^$HOME|~|")"
offer "Grok Build" grok "$HOME/.grok/bin/grok" "a SuperGrok plan" "curl -fsSL https://x.ai/cli/install.sh | bash"
rm -f "$TMP_LOG"
if [ -n "$LATER" ] && [ "$ASK" = no ] && [ "${POLYPHEMUS_CLIS:-}" != none ]; then printf "  To install one later:$LATER\n"; fi

VERSION="$("$BIN_DIR/poly" --version 2>/dev/null || true)"
say ""
say "✓ Polyphemus ${VERSION:-} is installed: $BIN_DIR/poly"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "  $BIN_DIR isn't on your PATH yet. Add it to your shell's profile:"
     say "    export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
say ""
say "Next, one command — it starts polyphemus in the background, pairs this computer, and opens the"
say "setup wizard in your browser, where you pick your models and name your agent:"
say ""
say "  poly start"
say ""
say "Then: poly doctor shows what this computer is missing and how to fix it, poly pair adds your"
say "phone (needs Tailscale), and poly help lists the rest."
say "Agents' commands run in a container by default, which needs Docker or Podman."
