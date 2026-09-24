---
"@polyphemus/core": patch
"@polyphemus/daemon": patch
---

An agent working in a thread outside every project can ask for a routine. It couldn't before — the tool was only offered inside a project, so an agent that wanted recurring work had to tell you to go and write the file yourself. It now proposes one that belongs to the install, running in the folder that thread works in, and it waits for a person exactly like a project's does. Accepting one is the owner's call, since no project bounds it. Polyphemus has always run routines that belong to no project; only asking for one had nowhere to go.
