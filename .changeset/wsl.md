---
'@polyphemus/cli': patch
---

Inside WSL on Windows, `poly start` opens the setup wizard in Windows's own browser, and
`poly service install` says how to turn systemd on when WSL is running without it, instead of
passing on systemctl's complaint.
