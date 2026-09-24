---
"@polyphemus/core": patch
---

What a run ships is what you approved. A merge now checks the branch it's going into, not only the commit: the question names a branch, and a pull request's base can be changed on GitHub after it was asked — Polyphemus refuses instead of merging somewhere else, and only adopts an existing pull request that goes where this run is going. A review whose author GitHub no longer names no longer counts as "somebody other than the author". A run's folder is cloned through git's own transport, so a project's `objects/info/alternates` can't lend it another repository's files to commit and push out under Polyphemus's identity. The pictures Polyphemus takes of a site are taken on the port it gave the command, not at whatever address the command prints, so a run can't offer pictures of something it didn't build as evidence for its own merge. And two runs on one issue can't share a folder because the repository was spelled differently.
