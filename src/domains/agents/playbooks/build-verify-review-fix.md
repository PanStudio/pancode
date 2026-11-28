---
version: 3
name: build-verify-review-fix
description: "Implement the change, have an independent verifier run the declared checks, then an independent reviewer judge the result; the coder fixes what each one finds, within bounded loops."
steps:
  - kind: agent
    id: build
    agent: coder
    scope: worktree
    dependencies: []
  - kind: loop
    id: verify
    maxAttempts: 2
    dependencies: [build]
    check:
      kind: agent
      agent: verifier
      scope: readonly
      instructions: "Run the project's declared checks that cover the change through verify() and judge on their results. Report each check you ran with its evidence; a check you could not run fails as unverified."
    repair: {kind: agent, agent: coder, scope: worktree}
  - kind: loop
    id: review
    maxAttempts: 2
    dependencies: [verify]
    check: {kind: agent, agent: reviewer, scope: readonly}
    repair: {kind: agent, agent: coder, scope: worktree}
maxWorkers: 1
onFailure: stop
---

{{task}}

This is one chain with several authors. Do only the step you were given.

Build. Make the smallest change that does what the request asks, and nothing beside it: no new guards,
fallbacks, options or rewrites of code that already works unless the request needs them. Add the smallest test that
proves the change, one focused case that fails without it, and no tests for behaviour you did not change.

Verify. A separate read-only verifier then runs the project's declared checks that cover the change and
answers a typed pass/fail with their evidence.

Review. A separate read-only reviewer then inspects the tree and answers a typed pass/fail with per-check
evidence, including whether the request needs each hunk that changed. It is a different run with its own context:
it sees only the tree left behind and the request, not your reasoning, and nothing you write persuades it.

Repair. When a check fails you receive its findings and the previous attempt's report as input data. Fix
exactly what was reported and nothing else. Never weaken or delete a test to make it pass, and do not widen the
change beyond the repair.
