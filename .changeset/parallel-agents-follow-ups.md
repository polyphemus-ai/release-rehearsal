---
"@polyphemus/core": patch
"@polyphemus/daemon": patch
---

Four things the review of parallel agents found, fixed. An agent CLI is now told what another agent said in the thread while it was working — what it had seen was counted in one runtime's copy of the thread, so anything written alongside it was skipped for ever. A thread holds at most 50 messages waiting, 20 from any one person, and says so plainly instead of growing without end. Reading how a thread flowed no longer reads everything ever said in it each time it's drawn. And the folder an earlier run worked in, set aside when a run is retried, is cleared out: the newest is kept for a week, the rest go.
