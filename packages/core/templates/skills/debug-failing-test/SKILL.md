---
name: debug-failing-test
description: a test is failing and you need to find out why before changing anything
---

# debug-failing-test

## When to use this

A test fails, in CI or locally, and the cause isn't obvious from the message.

## Steps

1. **Reproduce it, narrowed.** Run that one test, not the suite, and keep the exact command:
   it's what you'll use to confirm the fix.
2. **Read the failure properly** — the assertion, the expected and actual values, and the
   first frame of the stack that's in this project's code rather than a library's.
3. **Decide which it is** before touching anything:
   - the test is wrong (it asserts something that was never promised),
   - the code is wrong (the test is right and just caught it),
   - or the setup is wrong (order-dependent state, a clock, a temp folder, the network).
   Say which, and what convinced you.
4. **Check whether it's flaky**: run it a few times, and on its own versus with the suite. A test
   that passes alone and fails in the suite is shared state, not a bug in the code under test.
5. **Find when it started** if the cause is still unclear:
   ```bash
   git log --oneline -20 -- <the file>
   git stash && git checkout <older-sha> -- <the file>   # then put it back
   ```
6. **Fix the cause, not the symptom,** then re-run the narrowed command, then the full suite.

## Rules

- Never make a test pass by weakening what it asserts, unless the assertion itself was wrong —
  and then say so explicitly in what you report.
- Never delete or skip a failing test to get green. If it must be skipped, say why and what
  would un-skip it.
- Report the cause, not just the fix: the next person needs to know why it broke.
