---
"@polyphemus/core": patch
"@polyphemus/daemon": patch
---

Agents' computers go to sleep when Polyphemus stops, and any left running by one that didn't stop cleanly are put to sleep when it starts, instead of each holding 2 GB with nothing to stop it. Their home folders are kept.
