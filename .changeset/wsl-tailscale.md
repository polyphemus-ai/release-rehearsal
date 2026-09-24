---
'@polyphemus/cli': minor
---

Inside WSL on Windows, a phone reaches Polyphemus without setting anything up by hand: it finds
Tailscale on Windows and points Tailscale's HTTPS address at itself, as it already does on Linux and
macOS. `poly doctor` there says Tailscale runs on Windows rather than suggesting it be installed in
Linux, and a Windows build of Claude Code, Codex or Grok Build on WSL's PATH no longer passes for a
Linux one.
