---
"@polyphemus/core": minor
"@polyphemus/daemon": minor
---

Write while a thread is working: what you send is held in the thread, in order, and sent when the work stops — agents handing on to each other included — with the messages you sent in a row going as one. A held message can be taken back until it goes, and held messages survive a restart.
