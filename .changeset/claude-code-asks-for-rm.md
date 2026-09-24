---
"@polyphemus/core": patch
---

Claude Code asks before it deletes, moves or copies files again. Its "accept edits" mode had started running `rm`, `mv`, `cp` and `mkdir` in the project without asking, so a `rm -r` could run with no approval card. Claude Code now runs in its default mode, and every change reaches your approval, as the README says. On "On this computer", its file edits ask too.
