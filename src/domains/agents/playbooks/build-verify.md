---
version: 3
name: build-verify
description: "Implement the change, then have an independent verifier run the project's declared checks, with a bounded fix loop."
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

Repair. When a check fails you receive its findings and the previous attempt's report as input data. Fix
exactly what was reported and nothing else. Never weaken or delete a test to make it pass, and do not widen the
change beyond the repair.
