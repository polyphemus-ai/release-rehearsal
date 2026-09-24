---
'@polyphemus/cli': minor
---

`poly start` takes a fresh install straight to setup: the daemon in the background, this computer
paired, and the wizard open in your browser. It used to take starting the daemon, pairing by hand
and reading a code off the terminal to reach it.

The wizard was also unreachable once you got there: a new install ships six providers to choose
between, and the app checked whether any models were *listed* rather than whether you had *picked*
one, so the "Nothing to run on yet" card and the redirect into setup never fired.
