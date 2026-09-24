---
"@polyphemus/core": minor
"@polyphemus/daemon": minor
---

Claude Code, Codex and Grok Build run isolated: where a project is set to Isolated, each CLI stays on this computer with its sign-in while its commands and file changes run in the project's worker — Claude Code through a shell wrapper with its own file tools replaced by Polyphemus's, Codex through its exec-server inside the worker, Grok through Polyphemus acting as its ACP client. Each is checked once per version with a small real turn, and every turn is checked after; a CLI caught running something outside its worker isn't used isolated again. While isolated, Codex can't use connections. First-run setup now asks where agents run.
