---
"@polyphemus/core": patch
---

When Claude's API is overloaded, the thread no longer shows "API Error: 529 Overloaded…" as if the agent had said it, followed by a "Continue where the previous model left off." in your name. The error is kept out of the conversation, and the next model in the fallback takes the turn from your message.
