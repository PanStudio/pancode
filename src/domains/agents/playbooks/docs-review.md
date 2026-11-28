---
version: 3
name: docs-review
description: "Write or update documentation from the source, then hold it against an independent reviewer with a bounded revise loop."
steps:
  - kind: agent
    id: document
    agent: documenter
    scope: worktree
    dependencies: []
  - kind: loop
    id: review
    maxAttempts: 2
    dependencies: [document]
    check:
      kind: agent
      agent: reviewer
      scope: readonly
      instructions: "The change is documentation. Hold every claim it makes against the source it describes: a name, flag, default or behaviour the code does not have fails its check with the file and line that show it."
    repair: {kind: agent, agent: documenter, scope: worktree}
maxWorkers: 1
onFailure: stop
---

{{task}}

This is one chain with several authors. Do only the step you were given.

Document. Write what the request asks from the source as it is: read the code before you describe it, and
describe only what it does. Change no code.

Review. A separate read-only reviewer then holds every claim against the source and answers a typed pass/fail
with per-check evidence.

Repair. When the review fails you receive its findings and the previous attempt's report as input data. Correct
exactly what it reported and nothing else.
