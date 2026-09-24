---
"@polyphemus/core": minor
"@polyphemus/daemon": minor
---

A thread in no project now works in a folder of its own beside your projects, instead of whatever folder the daemon was started in — which was usually a project, so "No project" quietly made the thread part of it. Messaging an agent that belongs to no project starts a thread with no project, rather than the last one you worked in, and the draft says what that means: no project's rules, memory or connections.
