---
"@polyphemus/core": patch
---

Polyphemus reads and writes its own folder more carefully. An agent in your library is now written from `~/.polyphemus` the way a project's agent is written from its project — so a link left where its persona, instructions or settings should be is replaced, not written through — and a file that isn't a plain file (a pipe, a device) is skipped with a note instead of read. Reading one of those never returns, and Polyphemus reads its agents and skills whenever a thread starts, so one left in your library stopped Polyphemus rather than one request.
