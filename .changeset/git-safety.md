---
"@polyphemus/core": patch
"@polyphemus/daemon": patch
---

Polyphemus's own git no longer runs a repository's hooks or fsmonitor command — its fetches and pushes carry a GitHub identity's token — and the token is only ever given to GitHub's own host. A workflow run in a project where agents are isolated now refuses before anything runs, rather than at its first agent turn.
