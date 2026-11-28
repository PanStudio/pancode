---
version: 3
name: build-test-review
description: "Implement the change, run the suite with a bounded fix loop, then hold the green result against an independent reviewer. Registry commands required: test."
steps:
  - kind: agent
    id: build
    agent: coder
    scope: worktree
    dependencies: []
  - kind: loop
    id: suite
    maxAttempts: 3
    dependencies: [build]
    check: {kind: code, command: test, scope: worktree}
    repair: {kind: agent, agent: coder, scope: worktree}
  - kind: loop
    id: review
    maxAttempts: 2
    dependencies: [suite]
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

Suite. Code then runs the repository's registered `test` command and reports its exit code and output
verbatim. It also runs the test files the chain changed through the project's recognized test runner, so the test
you add gates the result. Do not invent another test command.

Review. A separate read-only reviewer then inspects the tree and answers a typed pass/fail with per-check
evidence, including whether the request needs each hunk that changed. It is a different run with its own context:
it sees only the tree left behind and the request, not your reasoning, and nothing you write persuades it.

Repair. When a check fails you receive its findings and the previous attempt's report as input data. Fix
exactly what was reported and nothing else. Never weaken or delete a test to make it pass, and do not widen the
change beyond the repair.
