---
version: 3
name: tests-add
description: "Add focused tests for behaviour that exists, then run the suite with a bounded fix loop; product code does not change. Registry commands required: test."
steps:
  - kind: agent
    id: write-tests
    agent: tester
    scope: worktree
    dependencies: []
  - kind: loop
    id: suite
    maxAttempts: 3
    dependencies: [write-tests]
    check: {kind: code, command: test, scope: worktree}
    repair: {kind: agent, agent: tester, scope: worktree}
maxWorkers: 1
onFailure: stop
---

{{task}}

This is one chain with several authors. Do only the step you were given.

Write tests. Add the fewest focused, deterministic test cases that pin the behaviour the request names, beside
the project's tests and in their style. Do not change product code. When the code does something the request
calls wrong, report it instead of testing for it.

Suite. Code then runs the repository's registered `test` command and reports its exit code and output
verbatim. It also runs the test files the chain changed through the project's recognized test runner, so the test
you add gates the result. Do not invent another test command.

Repair. If the suite comes back red you receive its output and the previous attempt's report as input data. Fix
the tests you wrote; do not change product code, and do not weaken a test that already existed.
