#!/bin/sh
# After a release: what a new user and an existing one get, on a clean Ubuntu in Docker, from the
# published release itself — the one-line install from the GitHub release, and `poly update` from an
# older version (and from a beta, when there is one) onto the newest.
#
#   sh scripts/release-check.sh [owner/repository] [package] [older version] [beta version]
#   sh scripts/release-check.sh polyphemus-ai/release-rehearsal polyphemus-rehearsal 0.1.0 0.1.1-beta.0
#
# Needs Docker. Nothing touches this computer's own install.
set -e
REPO=${1:-polyphemus-ai/polyphemus}
PACKAGE=${2:-polyphemus}
OLDER=${3:-}
BETA=${4:-}
LATEST=$(npm view "${PACKAGE}" dist-tags.latest)
echo "npm: ${PACKAGE} latest=${LATEST} next=$(npm view "${PACKAGE}" dist-tags.next 2>/dev/null || echo none)"
docker run --rm -e REPO="${REPO}" -e LATEST="${LATEST}" -e OLDER="${OLDER}" -e BETA="${BETA}" ubuntu:24.04 bash -c '
set -e
apt-get update -qq >/dev/null && apt-get install -y -qq curl ca-certificates >/dev/null 2>&1
URL="https://github.com/${REPO}/releases/latest/download/install.sh"
check() { # user, what to set before the install, whether to update, what it should end on
  useradd -m "$1"
  got=$(su "$1" -c "export PATH=\$HOME/.local/bin:\$PATH POLYPHEMUS_CLIS=none POLYPHEMUS_TAILSCALE=off; curl -fsSL $URL | $2 sh >/tmp/$1.log 2>&1 || { cat /tmp/$1.log; exit 1; }; [ -z \"$3\" ] || poly update >>/tmp/$1.log 2>&1; command -v poly >/dev/null && poly --version")
  if [ "$got" = "$4" ]; then echo "✓ $5: $got"; else echo "✗ $5: got \"$got\", wanted $4"; cat "/tmp/$1.log"; exit 1; fi
}
check alex "" "" "$LATEST" "a new install"
[ -z "$OLDER" ] || check sam "POLYPHEMUS_VERSION=$OLDER" update "$LATEST" "$OLDER, then poly update"
[ -z "$BETA" ] || check kim "POLYPHEMUS_VERSION=$BETA POLYPHEMUS_CHANNEL=beta" update "$LATEST" "the beta $BETA, then poly update"
'
