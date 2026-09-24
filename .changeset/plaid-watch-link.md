---
"@polyphemus/core": patch
"@polyphemus/daemon": patch
---

Banks linked at Plaid now appear on their own. Polyphemus watches the link session for fifteen minutes instead of waiting for you to return to the tab you started in and say you'd finished — which is easy to miss when Plaid sends you back in a different tab. It also reads every result in a session, so linking two banks at once keeps both.
