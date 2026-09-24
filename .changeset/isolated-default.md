---
"@polyphemus/core": minor
"@polyphemus/daemon": patch
"@polyphemus/cli": patch
---

Isolated is now the default for new installs. An install already in use keeps running agents on this computer: Polyphemus writes that choice into its config once, and says so when the daemon starts.
