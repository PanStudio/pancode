A group of agents is a workload. Each job needs a route, a share of a real endpoint, a boundary on what it may touch, and a way to tell whether it did its work. PanCode schedules its own workers and other coding agents under those rules. This page describes that design and how to measure it.

::: note Design described for the 0.9.0 development tree
The mechanisms here are read from source on the development branch. The role grader, the evidence packets, and the capability envelope are newer than the 0.8.4 release. Nothing on this page is measured yet. The experiment is proposed and not yet run.
:::

## The design

- **A typed intent and an envelope that only subtracts.** A dispatch names its read roots, write roots, expected outputs, and the checks that will judge it. Shell commands are refused in that field. What the worker may do is narrowed in a fixed order by its role, the request, the runtime, and the host, and every capability withheld is recorded and sealed.
- **Roles that owe evidence.** A builder owes a change or a declared reason for none. A checker owes checks that ran. A reviewer or judge owes cited evidence. The host grades each return against facts it observed. A return that misses its obligation is retried once on a different model, unless the attempt may have changed files.
- **Review gates built on citations.** The host assembles a packet for the reviewer: the worker's handback, the measured diff, and host check results, each with an id and a digest. A verdict that cites nothing, or cites an id the packet lacks, does not pass the gate.
- **Host verification with a replay on the base.** After a worker settles, the host runs the declared checks itself. A failing check is replayed on the base commit inside the sandbox. A failure the base already had is sealed as not implicating the worker.
- **Failures mapped to the part that failed.** Each failure class excludes one part of the route: the model, the target, the node, or the runtime. A context overflow earns one retry on a strictly larger window. No retry runs when the failed attempt may have changed files.
- **Capacity leases.** An endpoint's slot count comes from an operator setting, then a live probe, then a remembered value. Leases are held across processes. A dispatch is refused when the main turn already holds every slot, because waiting would deadlock.
- **Cache-aware fan-out.** Workers that share a prompt prefix wait up to 15 seconds for the first one's first token, so the others read the prefix from cache.
- **Councils and polls.** Two to five read-only seats answer over at most three rounds, and the result is a vote or a judge's synthesis.

## Source map

::: compare
| Mechanism | Source | Default | Switch |
| --- | --- | --- | --- |
| Typed intent and envelope | `src/domains/dispatch/intent.ts`, `envelope.ts` | On | Target and permission mode |
| Role obligations and grading | `src/domains/dispatch/obligation.ts`, `grading.ts` | On | `fleet.retry.maxRetries` |
| Evidence packets and gates | `src/domains/dispatch/evidence-packet.ts`, `gate-decisions.ts` | On request | `review`, compete mode |
| Host verification | `src/domains/dispatch/host-verification.ts` | With declared checks | Omit the checks |
| Failure classes | `src/domains/dispatch/failure-classification.ts` | On | `fleet.retry` settings |
| Capacity leases | `src/domains/dispatch/capacity-lease.ts` | On | `fleet.concurrency` |
| Prefix stagger | `src/domains/dispatch/prefix-stagger.ts` | On | `fleet.staggerSharedPrefix` |
:::

## The question

Does a graded fleet finish more work per token than one agent on the same tasks? The comparison is a single agent, the same agent behind a review gate, and several candidates with a judge. The answer could be no. Review costs tokens, and on easy tasks it may buy nothing.

## What is known so far

These are facts about the design, read from source. They are not study results.

- One policy is enforced for PanCode's own workers, the Claude SDK, and agents reached through mediated ACP. Other agent command lines receive the closest flags they support, and OpenCode cannot enforce read-only.
- Whether a reviewer is independent of the builder (a different agent and model lineage) is recorded and never enforced.
- Candidates in compete mode share one model, so their diversity comes from short prompts.
- Matching a worker's claim to a command that ran is text matching.
- Adaptive routing from past results is off by default.
- No comparison between a single agent and any of these arrangements has been run.

## Why it matters

Every vendor now ships subagents, and the usual evidence for them is a demonstration. A team paying for several models needs to know when a second agent raises the pass rate and when it only raises the bill. That takes the same tasks, the same models, and a count of tokens per task that passed.

## Use PanCode on it today

::: steps
### Send one worker and read its record

Type `/run reviewer <task>` in a session, then inspect the run from a shell.

```sh
pancode evidence inspect <run-id>
pancode fleet verify <run-id> --json
```

### Ask several agents

`/poll 3 <question>` takes a vote, and `/council` gives a roster one task. Both need a roster in your settings.

### Turn the retry off for a comparison

```sh
pancode config set fleet.retry.maxRetries 0
```
:::

## First experiment

::: note Proposed, not yet run
Nobody has run this protocol. If you do, your numbers are the first this page has.
:::

Choose ten tasks with a hidden check each, half of them hard enough that a single agent often fails. Run each task three ways: one builder, one builder behind a review gate, and compete mode with a judge. Record the pass rate on the hidden check, the runs that reported success and failed it, and tokens per passed task.

Vary the reviewer's model lineage in a second round. That measures whether independence, which the record already tracks, changes the outcome.

## Open questions

- [When do several agents or small models pay off?](/research/fleets-and-local-models.html)

## How to join

Open a [GitHub issue](https://github.com/akougkas/pancode/issues) that says what you plan to measure, and read the [contributor guide](https://github.com/akougkas/pancode/blob/main/CONTRIBUTING.md). Results are published on this page with their numbers, including null and negative ones.
