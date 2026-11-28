---
version: 3
name: test-fix
description: "Run the suite and repair what it reports, up to three repairs, without weakening a test. Registry commands required: test."
steps:
  - kind: loop
    id: suite
    maxAttempts: 4
    dependencies: []
    check: {kind: code, command: test, scope: workspace}
    repair: {kind: agent, agent: coder, scope: workspace}
maxWorkers: 1
onFailure: stop
---

{{task}}

This is one chain with several authors. Do only the step you were given.

Suite. Code then runs the repository's registered `test` command and reports its exit code and output
verbatim. It also runs the test files the chain changed through the project's recognized test runner, so the test
you add gates the result. Do not invent another test command.

Repair. You receive the suite's verbatim output and the previous attempt's report as input data. Fix the
cause the output points to with the smallest change, in the code under test unless the test itself is wrong about
what the request says. Never weaken, skip or delete a test to make it pass, and do not change code the failures do
not reach.
