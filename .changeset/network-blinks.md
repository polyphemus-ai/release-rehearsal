---
'@polyphemus/cli': patch
---

The app rides out a blink in the network instead of saying "Failed to fetch". Chrome cancels a
request whenever the computer's network changes — a Docker container starting is enough — so the app
tries again for a couple of seconds, and an action sent twice that way, like a message, is done once.
