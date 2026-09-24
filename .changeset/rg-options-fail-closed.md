---
"@polyphemus/core": patch
---

A command only skips the ask when Polyphemus is sure of it. Ripgrep runs a program for `--hostname-bin` (naming the machine) and `--search-zip` (unpacking an archive), not only for `--pre`, and Polyphemus knew about `--pre` alone — so `rg --hostname-bin ./anything.sh foo` ran that program without asking, in a thread where every other command would have. What ripgrep may be given is now named outright, so an option a later version adds is asked about instead of assumed harmless, while ordinary searches carry on without a prompt.
