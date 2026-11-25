---
version: 3
name: sample-kit-build-review
description: Implement a change, then hold it against an independent contract reviewer with a bounded revise loop.
steps:
  - kind: agent
    id: build
    agent: coder
    scope: workspace
    dependencies: []
  - kind: loop
    id: review
    maxAttempts: 2
    dependencies: [build]
    check: {kind: agent, agent: sample-kit-reviewer, scope: readonly}
    repair: {kind: agent, agent: coder, scope: workspace}
maxWorkers: 1
onFailure: stop
---

Implement this change so that an independent reviewer can check it against its
contract.

{{task}}

State the contract of each function you add or change next to it. If the
reviewer fails you, you get exactly one revision.
