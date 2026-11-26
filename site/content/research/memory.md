A context window is storage that fills, and the provider's prompt cache makes some of that storage cheap to keep and expensive to disturb. PanCode manages the window as a tiered store: live context, records it can recall exactly, and a summary as the last resort. This page describes that design and how to measure it.

::: note Design described for PanCode 0.9.1
The mechanisms here are read from source. Nothing on this page is measured yet. The experiment is proposed and not yet run.
:::

## The design

- **A working set with ordered rungs.** Eviction takes the cheapest material first: output made stale by a later edit, a read replaced by a newer read of the same lines, a failure that was later resolved, a listing already used. Age is the last rung and runs only under pressure. The most recent turns, unresolved failures, and refusals are protected.
- **Eviction priced against the cache.** Removing a body near the start of the conversation forces the provider to rewrite everything behind it. PanCode keeps such a body unless the tokens it frees, read over the next ten requests, outweigh rewriting that span at 11.5 times the cached-read price.
- **Exact recall.** The session ledger is never rewritten. An evicted body leaves a marker with its tool, path, size, a short preview, and the literal call that returns it unchanged. A body recalled twice is pinned.
- **A ladder that depends on the route.** Results replaced by a later identical call are removed only on routes with no prompt cache. Step checkpoints apply only to small or uncached routes. Below a 52,428-token window, the reserve for output is capped at half the window.
- **A summary that rides the warm prefix.** When a summary is needed, PanCode checks whether the summarizer request can extend the last request byte for byte. If it can and the cache-weighted cost is lower, the summary call reads the conversation from cache.
- **Facts that survive a summary.** Each checkpoint carries facts the host measured: files with their line counts and hashes, the newest numeric tool results, and the active request word for word. A file the checkpoint names must be read again before it is edited.

## Source map

::: compare
| Mechanism | Source | Default | Switch |
| --- | --- | --- | --- |
| Working-set rungs | `src/domains/context/working-set/policies/` | On | `context.workingSet.policy` |
| Cache-priced eviction | `src/domains/context/working-set/policies/cache-price.ts` | On | None yet |
| Rearm band | `src/domains/context/fold/pressure.ts` | On | `context.workingSet.rearmFraction` |
| Exact recall | `src/domains/context/working-set/marker.ts`, `recall.ts` | On | None yet |
| Route-conditional ladder | `src/domains/context/fold/contract.ts` | On | Target `cache.retention` |
| In-prefix summary | `src/engine/in-prefix-summary.ts` | On | `context.compaction.model` |
| Exact facts and edit guard | `src/domains/session/compaction/exact-facts.ts`, `stale-edit-guard.ts` | On | None yet |
:::

## The question

Does pricing eviction against the provider's cache beat evicting by age on a long task? The measure is the input a session pays for, with the task still passing. The answer could be no, if the rewrite a naive policy causes is small in practice.

## What is known so far

These are facts about the design, read from source. They are not study results.

- The 11.5 ratio comes from one provider's pricing and is applied to every route.
- Removal of replaced results never runs unless a target declares that it has no prompt cache, because caching is assumed by default, local servers included.
- The per-turn pool for tool output has a floor larger than a 32K window, so on small windows the guard after each tool batch does the protecting.
- Search by meaning is off by default.
- Whether the agent still knows what it needs after a reduction is not measured. That question has its own page below.

## Why it matters

Long tasks routinely outlive a model's window. Every reduction is a trade: bytes removed now against cached bytes rewritten on the following turns. A policy that counts only tokens can make a session more expensive while making it smaller.

## Use PanCode on it today

::: steps
### See what fills the window

Type `/context` in a session. It shows what occupies the window.

### Switch the eviction policy

```sh
pancode config set context.workingSet.policy age-horizon
```

`structural-v2` is the default. `age-horizon` evicts by age alone.

### Read the cost per turn

```sh
pancode telemetry tokens --session <id> --by-source --json
```

Compare cached and fresh input across the turns that follow an eviction.
:::

Worked example: [Keep a long coding task on track](/tutorials/keep-long-coding-tasks-on-track.html).

## First experiment

::: note Proposed, not yet run
Nobody has run this protocol. If you do, your numbers are the first this page has.
:::

Take one task long enough to trigger several reductions, forty turns or more. Run it under `structural-v2`, under `age-horizon`, and with the working set disabled, three times each on one model. Record fresh input, tokens the provider had to rewrite, the number of summary calls, and whether the task's check passes.

Cache-priced eviction itself has no switch yet. Adding one would let the pricing rule be compared with the same rungs unpriced.

## Open questions

- [What does an agent lose when its context is reduced?](/research/context-and-retrieval.html)
- [Does agent memory change outcomes?](/research/proactive-memory.html)

## How to join

Open a [GitHub issue](https://github.com/PanStudio/pancode/issues) that says what you plan to measure, and read the [contributor guide](https://github.com/PanStudio/pancode/blob/main/CONTRIBUTING.md). Results are published on this page with their numbers, including null and negative ones.
