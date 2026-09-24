---
"@polyphemus/core": patch
---

Usage forecasts stop warning that a window will run out when it's too early to tell: just after a weekly reset, 1% used no longer reads as "runs out tomorrow". A weekly window's pace is its average since the reset, not its busiest last hour.
