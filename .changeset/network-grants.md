---
"@polyphemus/core": minor
"@polyphemus/daemon": minor
---

Isolated projects can be granted network: package registries, GitHub, or hosts by name, on the project's Setup tab. A worker still has no network of its own; granted hosts are reached through Polyphemus's proxy, which refuses this computer, your local network and your tailnet even for a granted name. A refused connection is said in the thread and offered to grant. "Isolated, open network" now goes through the same proxy, so it reaches any public host but no longer this computer's local network.
