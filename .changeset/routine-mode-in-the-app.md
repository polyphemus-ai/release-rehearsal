---
"@polyphemus/core": patch
"@polyphemus/daemon": patch
---

What a routine asks before doing is a control, not a line of YAML. A routine's sheet now sets whether it asks first, only reads, or runs without asking — the last still the owner's alone — and whether a clean run tells you or only a failed one. It also says plainly that asking first means a run at 7am waits until you're up, which is the thing you actually need to know when you schedule one. Before this, an agent that proposed a routine had to ask you to open its file and edit the settings by hand.
