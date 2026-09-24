---
"@polyphemus/core": patch
"@polyphemus/daemon": patch
---

Polyphemus notices when Codex can't run commands on this computer. On Linux, Codex runs every command in a bubblewrap sandbox, and on Ubuntu 24.04 and later AppArmor's restriction on unprivileged user namespaces stops it from starting, so every command fails. Polyphemus now checks with `codex sandbox -- true` (no model call). When the sandbox can't start, Codex's card in Models & providers and the setup screen say what's wrong and why, and give the fix for you to run: an AppArmor profile for bwrap, or turning the restriction off, with the tradeoff of each. A Codex thread also gets one notice about it. Polyphemus doesn't change system settings and doesn't run Codex without its sandbox.
