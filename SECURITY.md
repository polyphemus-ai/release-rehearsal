# Security

Polyphemus runs agents with access to your files, your shell and the services you connect, so security
reports are the most important issues we get.

## Reporting a vulnerability

Please **don't open a public issue.** Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). Include what an attacker can do, the steps to reproduce it,
and the version (`polyphemus --version`).

You'll get an acknowledgement within a few days. Fixes ship as a patch release, credited to you unless
you'd rather not be.

## What's in scope

Especially:

- a model, tool, connection or web page getting hold of a credential Polyphemus holds;
- an agent acting outside what it was granted, or a workflow merging or publishing without the
  approvals it requires;
- the daemon being reachable, or its data readable, by anyone other than its paired devices;
- a paired device, or a person with a narrower role, doing what their role doesn't allow.

## What isn't (yet)

Polyphemus's guards reduce exposure; they aren't a sandbox. The boundary is worker isolation: by
default an agent's commands and files run in a container with only what was granted
([isolation.md](docs/design/isolation.md)). At the "On this computer" level an agent's shell runs as
your user, so a command you allowed — or ran in YOLO mode — can do what you can. That's the documented
model at that level, not a vulnerability. Something that gets out of a worker is.
