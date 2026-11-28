---
version: 3
name: review-fix
description: "Hold a change already in this checkout against an independent reviewer and fix what it finds, up to three revisions."
steps:
  - kind: loop
    id: review
    maxAttempts: 4
    dependencies: []
    check:
      kind: agent
      agent: reviewer
      scope: readonly
      instructions: "No earlier step of this chain made the change: it is the uncommitted work already in this checkout. Read it as `git diff HEAD` plus the untracked files `git status --short --untracked-files=all` lists, and judge it against the request."
    repair: {kind: agent, agent: coder, scope: workspace}
maxWorkers: 1
onFailure: stop
---

{{task}}

This is one chain with several authors. Do only the step you were given.

Review. The change under review is the uncommitted work already in this checkout. A separate read-only
reviewer judges it against the request and answers a typed pass/fail with per-check evidence.

Repair. When a check fails you receive its findings and the previous attempt's report as input data. Fix
exactly what was reported and nothing else. Never weaken or delete a test to make it pass, and do not widen the
change beyond the repair.
