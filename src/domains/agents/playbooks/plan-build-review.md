---
version: 3
name: plan-build-review
description: "Plan the change as a written artifact, implement it, then hold it against an independent reviewer with a bounded revise loop."
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
  - kind: loop
    id: review
    maxAttempts: 2
    dependencies: [plan, build]
    check:
      kind: agent
      agent: reviewer
      scope: readonly
      instructions: "The plan step wrote a plan artifact (.pancode/artifacts/PLAN.md) before the build; its report is attached on the first check. Read that plan and judge the tree against both the request and the plan."
    repair: {kind: agent, agent: coder, scope: worktree}
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

Review. A separate read-only reviewer then inspects the tree and answers a typed pass/fail with per-check
evidence, including whether the request needs each hunk that changed. It is a different run with its own context:
it sees only the tree left behind and the request, not your reasoning, and nothing you write persuades it.

Repair. When a check fails you receive its findings and the previous attempt's report as input data. Fix
exactly what was reported and nothing else. Never weaken or delete a test to make it pass, and do not widen the
change beyond the repair.
