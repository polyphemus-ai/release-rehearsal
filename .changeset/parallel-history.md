---
"@polyphemus/core": patch
"@polyphemus/daemon": patch
---

With more than one agent working in a thread, what a model is sent keeps every tool call next to its answer, and each agent reads the whole thread before its turn — so nothing another agent said goes missing, and a stopped turn can't break the next one. Agents answering alongside are stopped when a thread is deleted or Polyphemus closes, count as working so a deploy waits for them, follow the thread's YOLO setting, and carry a held message's attachments.
