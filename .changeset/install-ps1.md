---
'@polyphemus/cli': minor
---

Windows has its own one-line install: `irm https://polyphemus.ai/install.ps1 | iex`. It asks before
installing or updating WSL, installing Ubuntu, or turning on systemd, and stops honestly on no; then
installs Polyphemus inside WSL, offers the Claude, ChatGPT and SuperGrok CLIs, and opens setup in
your Windows browser. Setup also picks the CLI you just installed or signed in to, so continuing is
one tap.
