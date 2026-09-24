---
"@polyphemus/core": minor
"@polyphemus/daemon": minor
---

Workflow runs work where agents are isolated. Each run gets a clone of the project of its own (under `.polyphemus-runs/`, replacing the shared worktree), and its agents, checks, preview and look at its pages run in a worker given only that folder. Polyphemus's pushes as a GitHub identity now take the run's commits as a bundle from its worker into a repository of Polyphemus's own, so nothing an agent does to the clone's git config can touch the token.
