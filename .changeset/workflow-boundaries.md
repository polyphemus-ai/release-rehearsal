---
"@polyphemus/core": minor
---

From a review of the workflow engine. A run's folder is made from the project's folder through no link, always as a fresh clone (a folder an earlier run worked in is set aside, not trusted), and git on this computer uses only the transports Polyphemus needs. A run's container is never given a folder that goes through a link or out of its project. Reading a run's package.json or Makefile, and serving its pages, can't follow a link or hang on a pipe, and a malformed address no longer stops the preview server.
