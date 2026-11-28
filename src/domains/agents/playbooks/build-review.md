---
version: 3
name: build-review
description: Implement the change, then hold it against an independent reviewer with a bounded revise loop.
steps:
  - kind: agent
    id: build
    agent: coder
    scope: worktree
    dependencies: []
  - kind: loop
    id: review
    maxAttempts: 2
    dependencies: [build]
    check: {kind: agent, agent: reviewer, scope: readonly}
    repair: {kind: agent, agent: coder, scope: worktree}
maxWorkers: 1
onFailure: stop
---

Implement this change so that an independent reviewer would approve it.

{{task}}

Make the smallest change that does what the request asks, and nothing beside it: no new guards, fallbacks,
options or rewrites of code that already works unless the request needs them. Add the smallest test that proves
the change, one focused case that fails without it, and no tests for behaviour you did not change.

A separate read-only reviewer inspects the workspace afterwards and answers a
typed pass/fail with per-check evidence, including whether the request needs each hunk you changed. It is a
different run with its own context: it cannot see your reasoning, only the tree you leave behind and the
task above. Nothing you write here persuades it.

If it fails you, you receive its failed checks and the previous attempt's report as input data and get exactly one
revision. Close the findings it reported and nothing else.
