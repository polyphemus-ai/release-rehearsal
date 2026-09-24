---
"@polyphemus/core": patch
---

Starting an isolated Codex no longer searches whole folders for its binary: it looks only inside the npm package that has one. A `codex` installed outside node_modules is taken as it is, instead of walking everything above it.
