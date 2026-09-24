---
"@polyphemus/core": patch
"@polyphemus/daemon": patch
---

Disconnecting a connection now forgets the set-up-once credentials behind it as well, once nothing else uses them: your Plaid app and the banks linked with it (unlinked at Plaid too), your SimpleFIN address, your Google sign-in client, your X app. The confirmation says what will go before you answer.
