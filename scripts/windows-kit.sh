#!/bin/sh
# The Windows check, packed to run on a Windows computer: this build of Polyphemus, both install
# scripts (install.ps1 is the Windows one), and the two halves of the check (windows-check.ps1 and
# windows-check-wsl.sh).
#
#   sh scripts/windows-kit.sh              # builds it into dist/windows-check
#   sh scripts/windows-kit.sh <computer>   # …and sends it there with Taildrop
#
# On the Windows computer it lands in Downloads. In PowerShell there:
#   cd ~\Downloads; powershell -ExecutionPolicy Bypass -File .\windows-check.ps1
# It writes windows-check-report.txt beside itself, to paste back.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
node "$root/scripts/build.mjs" --pack >/dev/null
out="$root/dist/windows-check"
rm -rf "$out" && mkdir -p "$out"
cp "$root/install/install.sh" "$root/install/install.ps1" "$root/scripts/windows-check.ps1" "$root/scripts/windows-check-wsl.sh" "$(ls "$root"/dist/polyphemus-*.tgz | tail -1)" "$out/"
# One file too, for a Windows computer Taildrop can't reach: moved any way at all, and unzipped anywhere.
rm -f "$root/dist/windows-check.zip" && (cd "$out" && zip -q -j "$root/dist/windows-check.zip" ./*)
echo "The kit is in $out, and as one file: $root/dist/windows-check.zip"
if [ -n "$1" ]; then
  tailscale file cp "$out"/* "$1:"
  echo "Sent to $1. It lands in Downloads there; in PowerShell:"
  echo '  cd ~\Downloads; powershell -ExecutionPolicy Bypass -File .\windows-check.ps1'
fi
