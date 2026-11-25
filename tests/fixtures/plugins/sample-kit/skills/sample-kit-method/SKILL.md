---
name: sample-kit-method
description: Reviews named functions against their stated contracts and reports every check with an honest status. Test fixture skill.
version: 0.1.0
license: LicenseRef-PanCode-1.0
triggers:
  - sample kit review
pancode:
  agents:
    - main
    - sample-kit-reviewer
    - sample-kit-modeled-reviewer
    - sample-kit-mechanized-reviewer
---

# Contract review

Produce a review report for a small, named set of functions. The report is a
list of checks. Each check states what must hold, why it holds or fails, and how
strongly that was established.

A written argument is not a machine-checked proof. Keep that difference visible
in every check, and never upgrade a status to make the report read better.
