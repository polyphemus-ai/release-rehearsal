---
"@polyphemus/core": minor
"@polyphemus/daemon": minor
---

Where agents run is now the owner's choice, in Setup and per project: Isolated (commands and file changes in a container with only the project's folder and memory, no network), Isolated with open network, or On this computer (as before, and said once in each thread). Isolation uses Docker or Podman and fails closed: vendor CLIs and workflow runs, which can't run isolated yet, are refused there rather than run on this computer. Vendor CLIs now get only their own sign-in variables instead of every key Polyphemus has, and pushes are locked for them inside a run's worktree, which they never were.
