#!/bin/bash
# The half of the Windows check that runs inside WSL (windows-check.ps1 runs it). It checks what
# Polyphemus needs there, installs it, and starts it as a service where systemd allows. Every line
# it prints is PASS, FAIL or an indented note, for the report.
#
# $1 is the folder the kit is in, as WSL sees it: a polyphemus-*.tgz there is installed instead of
# the published package, with the install.sh beside it.
# As root, from windows-check.ps1 once the person has said yes: systemd on in /etc/wsl.conf, keeping
# anything else there. WSL reads it the next time it starts.
if [ "$1" = --enable-systemd ]; then
  f=/etc/wsl.conf
  touch "$f"
  if grep -q '^[[:space:]]*systemd[[:space:]]*=' "$f"; then sed -i 's/^[[:space:]]*systemd[[:space:]]*=.*/systemd=true/' "$f"
  elif grep -q '^\[boot\]' "$f"; then sed -i '/^\[boot\]/a systemd=true' "$f"
  else printf '\n[boot]\nsystemd=true\n' >> "$f"
  fi
  echo "/etc/wsl.conf now has systemd=true under [boot]"
  exit 0
fi
kit="$1"
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; }
note() { echo "      $1"; }
port="${POLYPHEMUS_PORT:-3900}"

. /etc/os-release 2>/dev/null
note "Linux: ${PRETTY_NAME:-unknown}, kernel $(uname -r)"

if [ -d /run/systemd/system ]; then
  pass "systemd is running, so poly service can keep Polyphemus running"
  systemd=1
else
  fail "systemd isn't running, so poly service can't install"
  note "Fix: sudo nano /etc/wsl.conf, add the lines [boot] and systemd=true, then in Windows: wsl --shutdown"
fi

command -v curl >/dev/null 2>&1 && pass "curl" || fail "no curl (sudo apt install curl)"
command -v git >/dev/null 2>&1 && pass "git" || fail "no git: projects need it (sudo apt install git)"
if command -v docker >/dev/null 2>&1 && docker version >/dev/null 2>&1; then
  pass "Docker answers inside WSL ($(docker version --format '{{.Server.Version}}' 2>/dev/null))"
else
  fail "no Docker inside WSL, so agents can't run isolated"
  note "Docker Desktop with WSL integration on for this distribution fixes it; without it, agents run 'On this computer'"
fi

# The newest by time: a second send arrives as "polyphemus-0.1.0 (1).tgz", which sorts first by name.
pkg=$(ls -t "$kit"/polyphemus-*.tgz 2>/dev/null | head -1)
if [ -n "$pkg" ]; then
  note "Installing the build in the kit: $(basename "$pkg")"
  POLYPHEMUS_PACKAGE="$pkg" sh "$kit/install.sh" >/tmp/poly-install.log 2>&1
else
  note "Installing the published package"
  curl -fsSL https://polyphemus.ai/install.sh | sh >/tmp/poly-install.log 2>&1
fi
poly="$HOME/.local/bin/poly"
if [ -x "$poly" ] && version=$("$poly" --version 2>/dev/null); then
  pass "installed polyphemus $version"
else
  fail "the install didn't finish; its last lines:"
  tail -15 /tmp/poly-install.log | sed 's/^/      /'
  exit 0
fi

if [ -n "$systemd" ]; then
  if "$poly" service install >/tmp/poly-service.log 2>&1; then
    pass "poly service install"
  else
    fail "poly service install; it said:"
    tail -8 /tmp/poly-service.log | sed 's/^/      /'
  fi
  for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 1; done
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")
  [ "$code" = 401 ] && pass "the daemon answers inside WSL" || fail "the daemon isn't answering inside WSL (HTTP $code)"
fi

# Everything else this computer has and lacks, as a new person would see it.
note "poly doctor says:"
POLYPHEMUS_OUTPUT=text "$poly" doctor 2>&1 | sed 's/^/      /'
