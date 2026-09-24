---
'@polyphemus/cli': patch
---

Polyphemus knows whether Grok is signed in: it was asking a question this Grok doesn't have, so it
never knew. Signing in to Grok gives a link, with its code in it, that works from any device, and the
link a CLI prints to sign in is a button to tap rather than text in a box. Setup won't offer a
signed-out CLI as ready, a paused provider whose login was rejected says what to do, and signing in
lifts the pause at once.
