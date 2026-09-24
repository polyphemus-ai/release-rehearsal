---
"@polyphemus/core": patch
---

Five things from a review of how Polyphemus holds credentials. A secret kept inside a record — a linked bank's token, another connection's sign-in — is masked in what a model sees, not only when the whole record appears: what a service hands back is the token on its own, and that went through unmasked. Taking a connection away now stops the server Polyphemus started for it, which was still running with the credential and a line to the service. The config Polyphemus hands Claude Code goes in a file only you can read, instead of on a command line anyone on the machine can see. A server's answer is bounded, so one that returns a gigabyte or an endless list of tools can't take the daemon with it. And the guard that keeps credential stores away from agents knows about the ones a developer's machine actually has: `.git-credentials`, gcloud's application default credentials, `.kube/config`, `.npmrc`, `.gnupg` and more.
