When an agent says a task is done, that is a claim. PanCode keeps its own account of what happened: which checks ran on the final tree, which of the agent's statements a command supports, and what was never measured. This page describes that design and the first experiment the project plans to run.

::: note Design described for the 0.9.0 development tree
The mechanisms here are read from source on the development branch. The claimed and assessed completion states and the intervention ledger are newer than the 0.8.4 release. Nothing on this page is measured yet. The experiment is proposed and not yet run.
:::

## The design

- **Checks count only on the final tree.** The host classifies every tool call as a check, an inspection, or a change. A change to the workspace retires every pass recorded before it, so a test that passed before the last edit verifies nothing.
- **Claimed and assessed, side by side.** The agent declares done, partly done, or not done. The host seals its own state beside that claim, and a declared done over an open fact becomes partly done. Open facts include a change with no check after it, a failed check, and a missing expected output.
- **Claims matched to commands.** A worker's statement that a check passed is matched to a command the host saw exit cleanly. Trust is kept as five separate readings (integrity, grounding, independent review, context provenance, and completion evidence) and is never collapsed into one score.
- **Assess, then seal.** A run's settlement and assessment are written before a hash chain over its journal is sealed. Verification replays the chain, checks every file's size and hash, and rejects lines added after the seal.
- **Unknown stays unknown.** Every usage and cost value is measured, estimated, unknown, or absent, each with a reason. A sum keeps its known subtotal and counts the unknowns. A cost cap that cannot be priced stops the run.
- **Checks for numerical work.** A check can compare results within a relative, absolute, or ULP tolerance, repeat a seeded run and report the spread, or reproduce from inputs pinned by hash. Each judged check becomes a claim tied to its commit, command, and tolerance, and two opposite verdicts under the same conditions are recorded as a contradiction.
- **PanCode accounts for itself.** Every nudge and block the host issues gets an id and settles exactly once: acted on, ignored, recovered, or exhausted. The same holds for a lesson from memory, which counts as delivered only when its text reached the model and is held only when later evidence supports it.

## Source map

::: compare
| Mechanism | Source | Default | Switch |
| --- | --- | --- | --- |
| Final-tree freshness | `src/domains/safety/run-effects.ts`, `check-classifier.ts` | On | None yet |
| Claimed and assessed | `src/domains/safety/finish-contract.ts`, `src/tools/finish.ts` | On, advisory | `PANCODE_RIGOR`, `run --exit-code` |
| Claim grounding and trust | `src/domains/dispatch/validation-grounding.ts`, `src/domains/evidence/trust-status.ts` | On | None |
| Seal and verify | `src/domains/telemetry/seal.ts` | On | None |
| Measured, estimated, unknown | `src/core/telemetry/fact.ts` | On | None |
| Numerical checks | `src/tools/verify/numeric.ts`, `reproduce-run.ts` | When declared | The check catalog |
| Claims ledger | `src/domains/claims/` | When declared | The check catalog |
| Intervention ledger | `src/domains/middleware/fired-record.ts` | On | Instrumentation |
:::

## The question

How often does a model declare a task done when the evidence does not support it, and how often does the host catch it? A third number keeps the first two honest: how often the host lowers a done that was in fact correct. The answer could be that models rarely overclaim, or that the host misses most of it.

## What is known so far

These are facts about the design, read from source. They are not study results.

- The seal is unkeyed and unsigned. It shows a record is intact and cannot show who produced it.
- The host that did the work also assesses it.
- The assessment only lowers a declared done. A declared partly done is not examined further.
- At normal rigor the completion check advises and does not block. `PANCODE_RIGOR=high` makes it ask again.
- A writer the host does not recognize, run after a passing check, leaves that pass standing.
- A second clean run that agrees with the first shows self-agreement, not correctness.

## Why it matters

A change to research code is finished when the checks say so, and a summary written after one more edit may describe a tree that no longer exists. A reader of a result, in the same lab or another one, needs to know which statements a command supports and which rest on the agent's word.

## Use PanCode on it today

::: steps
### Make an unfinished run fail the job

```sh
pancode run --exit-code --verify "npm test" --fail-on-verify \
  --output-format json "<task>" | jq '.outcome, .causes'
```

The run exits 1 when the agent declared partly done, when its done left unvalidated changes, or when the check failed.

### Read what a run did

```sh
pancode evidence inspect <run-id>
pancode claims
```

### Verify a sealed record

```sh
pancode telemetry verify --run <run-id>
```

The command uses only the record's own files, so it works on another machine.
:::

## First experiment

::: note Proposed, not yet run
This is the first experiment the project plans to run. Nobody has run it yet.
:::

Write trap tasks, each with a hidden grader the agent never sees. In one, the natural fix passes the visible test and a later cleanup edit breaks it. In another, the test runner cannot start. In a third, a numerical result drifts inside the test's tolerance and outside the reference's. A fourth cannot be completed as stated.

Run each task several times on one model from each model lineage, at normal and at high rigor. Record three rates: declared done with the grader failing, those the host lowered, and done lowered while the grader passed.

Two things are needed first. The trap tasks do not exist yet, and the campaign runner does not read the sealed assessment or repeat a run.

## Open questions

- [Can an agent run be a scientific record?](/research/sealed-run-records.html)
- [What would make a scientist trust an agent's change?](/research/scientific-and-hpc-workflows.html)
- [Does agent memory change outcomes?](/research/proactive-memory.html)

## How to join

Open a [GitHub issue](https://github.com/akougkas/pancode/issues) that says what you plan to measure, and read the [contributor guide](https://github.com/akougkas/pancode/blob/main/CONTRIBUTING.md). Results are published on this page with their numbers, including null and negative ones.
