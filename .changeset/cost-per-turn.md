---
"@polyphemus/core": patch
"@polyphemus/daemon": patch
---

What a turn cost is what that turn cost. Claude Code reports `total_cost_usd` as the running total for its whole session, not for the turn that just finished, and Polyphemus kept it as the turn's own — so every turn of a resumed session counted everything before it again, and a thread's total read many times what it was. Polyphemus now records the difference from the last turn of that native session, and the whole figure when a session has just started. Turns recorded before this hold the old meaning and are marked rather than guessed at: they're left out of every total, and the app says how many instead of quietly dropping them.
