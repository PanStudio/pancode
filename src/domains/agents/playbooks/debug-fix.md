---
version: 3
name: debug-fix
description: "Diagnose a failure read-only, fix the named cause with a reproduction test, then run the suite with a bounded fix loop. Registry commands required: test."
steps:
  - kind: agent
    id: diagnose
    agent: debugger
    scope: readonly
    dependencies: []
  - kind: agent
    id: fix
    agent: coder
    scope: worktree
    dependencies: [diagnose]
  - kind: loop
    id: suite
    maxAttempts: 3
    dependencies: [fix]
    check: {kind: code, command: test, scope: worktree}
    repair: {kind: agent, agent: coder, scope: worktree}
maxWorkers: 1
onFailure: stop
---

{{task}}

This is one chain with several authors. Do only the step you were given.

Diagnose. Investigate the failure the request describes: read the code it reaches and trace it to its cause.
Name the cause with the evidence: the file and line, the input that triggers it, and what happens instead of what
should. Change nothing.

Fix. Fix the cause the diagnosis names (it is attached as input data) with the smallest change, and nothing beside
it. Add the smallest reproduction test: one case that fails before the fix and passes after it.

Suite. Code then runs the repository's registered `test` command and reports its exit code and output
verbatim. It also runs the test files the chain changed through the project's recognized test runner, so the test
you add gates the result. Do not invent another test command.

Repair. When a check fails you receive its findings and the previous attempt's report as input data. Fix
exactly what was reported and nothing else. Never weaken or delete a test to make it pass, and do not widen the
change beyond the repair.
