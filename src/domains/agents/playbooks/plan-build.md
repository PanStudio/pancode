---
version: 3
name: plan-build
description: "Plan the change as a written artifact, then implement it."
steps:
  - kind: agent
    id: plan
    agent: architect
    scope: worktree
    dependencies: []
  - kind: agent
    id: build
    agent: coder
    scope: worktree
    dependencies: [plan]
maxWorkers: 1
onFailure: stop
---

{{task}}

This is one chain with several authors. Do only the step you were given.

Plan. Turn the request into an implementable plan and write it to the artifact your contract names: what
changes where, in what order, and the checks that prove it. Keep it to what the request needs.

Build. Implement that plan (it is attached as input data). Make the smallest change that does what the request asks, and nothing beside it: no new guards,
fallbacks, options or rewrites of code that already works unless the request needs them. Add the smallest test that
proves the change, one focused case that fails without it, and no tests for behaviour you did not change.
