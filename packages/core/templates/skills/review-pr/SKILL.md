---
name: review-pr
description: reviewing a pull request or a branch before it merges
---

# review-pr

## When to use this

Someone asks for a review of a PR, a branch, or a diff that's about to merge.

## Steps

1. **Get the whole change**, not just the patch:
   ```bash
   git fetch origin && git diff --stat origin/HEAD...HEAD && git diff origin/HEAD...HEAD
   git log --oneline origin/HEAD...HEAD
   ```
2. **Read what it claims to do**: the PR description, the issue it closes, the commit messages.
   A change that works but doesn't match its claim is a finding.
3. **Open the files around the change**, not only the changed lines: callers, the tests that
   cover them, and anything that shares the state being touched.
4. **Run what proves it** — the project's tests, typecheck, and linter, as its AGENTS.md says.
   Quote what you ran and what came back.
5. **Look for what's missing:** the error path, the empty and single-item cases, concurrent
   callers, data that already exists, anything that needs a migration or a flag.
6. **Write the review:** broken first, then missing, then risky, then preferences (marked as
   such). File and line for each, and the failure it causes.

## Rules

- Don't push, merge, or rewrite the author's code unless you were asked to.
- Don't raise style that a formatter or linter already decides.
- "It looks right, here's what I checked" is a complete review when it's true.
