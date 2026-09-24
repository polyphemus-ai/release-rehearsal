---
"@polyphemus/cli": patch
---

Deploying while sessions are working no longer waits for itself or cuts them off: Polyphemus prepares the copy, and it goes live when they finish. A copy that doesn't answer after the restart is put back automatically, and `poly service rollback` goes back by hand. The tests that hold agents inside a real worker now fail on a machine with no container runtime instead of skipping quietly.
