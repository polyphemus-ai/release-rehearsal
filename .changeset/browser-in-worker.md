---
"@polyphemus/core": minor
"@polyphemus/daemon": patch
"@polyphemus/cli": patch
---

The Browser connection's Chrome runs in a container of its own wherever Docker or Podman is installed: no folders, and the web only through Polyphemus's proxy, so a page can't reach this computer or your local network however its address resolves. The worker image now includes Chromium and fonts; Polyphemus builds it when the daemon starts, and removes earlier versions.
