---
'@polyphemus/cli': patch
---

Stopping or updating the background service shuts Polyphemus down cleanly. A service manager's stop
reached the daemon twice, and the second killed it halfway through closing, so every stop and every
update was recorded as a failure and cut the shutdown short.
