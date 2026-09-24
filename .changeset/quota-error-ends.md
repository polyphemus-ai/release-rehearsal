---
"@polyphemus/core": patch
"@polyphemus/daemon": patch
---

A quota error no longer keeps a provider out forever. When the error says when it resets, Polyphemus waits until then; when it doesn't, Polyphemus tries that provider again an hour later on the next real turn, and a turn that works clears it. The fallback notice, the status line agents see and Models & providers say when the error happened and when Polyphemus tries again. An old "out of quota" already in your database stops blocking on its own.
