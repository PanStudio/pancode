---
version: 3
name: tdd
description: "Test first: write the smallest failing test for the request, implement until it passes, then run the suite with a bounded fix loop. Registry commands required: test."
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
maxWorkers: 1
onFailure: stop
---

{{task}}

This is one chain with several authors. Do only the step you were given.

Test first, then build. Before you touch product code, write the smallest test that states what the request
asks: one focused case beside the project's tests, and run it to see it fail for the reason the request gives.
Then make the smallest change that makes it pass and does what the request asks, and nothing beside it. Do not
edit the test to fit the code. Say in your summary which test you wrote and how it failed before the change; list
as validations only the runs against your final tree.

Suite. Code then runs the repository's registered `test` command and reports its exit code and output
verbatim. It also runs the test files the chain changed through the project's recognized test runner, so the test
you add gates the result. Do not invent another test command.

Repair. When a check fails you receive its findings and the previous attempt's report as input data. Fix
exactly what was reported and nothing else. Never weaken or delete a test to make it pass, and do not widen the
change beyond the repair.
