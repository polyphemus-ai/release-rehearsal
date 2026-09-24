---
'@polyphemus/cli': minor
---

Getting a subscription working no longer stops at "Not installed". Setup lists Claude Code, Codex and
Grok Build whether or not they're installed, with an Install button that shows the exact command
first — each vendor's own installer into your home folder, or npm into Polyphemus's own, never with a
password — and a Sign in button once it's there. The install script offers the same three, asking
each time (Enter skips it, for anyone who only uses an API key). A CLI installed on Windows but not
inside WSL says so. And "Skip for now" in setup goes where it says, instead of straight back.
