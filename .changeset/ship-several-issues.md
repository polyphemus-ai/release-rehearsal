---
"@polyphemus/core": minor
---

Ship several issues in a row: `ship-issue` takes a “Then” list of issues to ship after the first, each starting once the one before it has merged. A queue that stops — a failure, or a merge sent back — says what’s still waiting and offers “Ship the rest”. Issues filed by intake get “Ship all, in order”.
