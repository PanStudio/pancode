---
description: Review named functions against their contracts and write a report.
argument-hint: "<path:function ...> [assurance=argued|modeled|mechanized]"
---

Produce a contract review report for: $ARGUMENTS

Select the fixed-policy recipe: `sample-kit-reviewer` for `argued`,
`sample-kit-modeled-reviewer` for `modeled`, or `sample-kit-mechanized-reviewer`
for `mechanized`. Dispatch that agent read-only and render the verifier report it
returns, keeping every status exactly as returned.
