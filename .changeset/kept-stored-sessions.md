---
'@polyphemus/cli': minor
---

Sign-ins are kept for sites that don't use cookies. Some sites hold your whole session in the
browser's own storage instead, so keeping one refused with "hasn't set anything to keep yet" after
a sign-in that plainly worked. What the site stored now goes to the vault beside the cookies, is put
back before the page's own scripts run, and is masked in anything a tool returns whatever the site
calls it.
