---
"@polyphemus/core": minor
"@polyphemus/daemon": minor
---

Fixes from an independent security review. An isolated agent can no longer use a link in its own folder to get a file of yours into its prompt, onto its computer, or written outside its folder. Setting an environment variable in front of a read-only command no longer skips the approval. A project's own agents can't be brought into another project's threads. A routine in a project's folder runs only once a person has accepted that exact version (and one that runs without asking, only with the owner's yes); routines that were already running keep running. Signing out a device or removing a person closes any agent computer it had open, and a malformed request for one can no longer stop polyphemus.
