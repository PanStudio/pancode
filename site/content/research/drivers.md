A model reaches PanCode through a wire format, and each wire caches, prices, and constrains a request in its own way. The driver layer shapes every request for its wire and records what the provider's cache did with it. This page describes that design, where it lives in the source, and how to measure it.

::: note Design described for the 0.9.0 development tree
The mechanisms here are read from source on the development branch, and some are newer than the 0.8.4 release. Nothing on this page is measured yet. The experiment is proposed and not yet run.
:::

## The design

- **A pinned prefix, split per wire.** The prompt compiler orders sections by how long their bytes stay fixed and hashes the part that is the same across an installation. Each wire marks that boundary its own way: a cache breakpoint on Anthropic, a separate input item on Codex, and a breakpoint part on Responses.
- **Cache-break attribution.** Every request is digested field by field. When the provider reads far less from cache than the previous request wrote, PanCode names a cause. It first compares request fingerprints (model, system prompt, thinking, tool choice), then consults reasons the host stamped, such as a compaction or an idle period past the cache lifetime.
- **Tool rounds that keep the prefix.** When a turn must call one named tool, wires that allow it keep the full tool list and name the tool, so the cached tool block survives. A provider's rejection is remembered for that target and model.
- **Keepalive that has to pay for itself.** While a turn waits on a long tool, a small request can keep the cache warm. It is sent only when the expected saving exceeds its own cost by at least five cents.
- **Capabilities from the live server.** A probe of the inference server decides tools, vision, and reasoning before a packaged profile does, and an operator setting can only lower what was found. A context window that nobody reported stays unknown.
- **Family repairs.** Parsers recover tool calls from models that emit them in a nonstandard channel, and a response that stops with thinking and no answer is retried once at a lower thinking level.

Reasoning, vision, and diffusion models run through this layer. For a diffusion model, PanCode renders refinement frames in the terminal, and the agent loop is the same one other models use. A decision model is a separate, opt-in engine for typed questions.

## Source map

::: compare
| Mechanism | Source | Default | Switch |
| --- | --- | --- | --- |
| Pinned prefix | `src/domains/prompts/compiler.ts`, `src/engine/provider-diagnostics.ts` | On | None yet |
| Cache-break attribution | `src/engine/request-structure.ts`, `src/core/cache-telemetry.ts` | On | Instrumentation |
| Tool-round control | `src/engine/provider-payload.ts` | On | None yet |
| Keepalive | `src/engine/cache-keepalive.ts` | On | `chat.cacheKeepalive` |
| Prewarm | `src/session-control/turn-prewarm.ts` | Off | `chat.prewarm` |
| Live capabilities | `src/domains/providers/capabilities.ts` | On | Target `capabilities` |
:::

## The question

Does shaping each request for its wire reduce the fresh input a session pays for, and by how much on each model family? The answer could be no. A provider may cache well enough without help that the split adds nothing.

## What is known so far

These are facts about the design, read from source. They are not study results.

- Behavior on the Codex wire rests on measurements of one model on one date.
- The thresholds that declare a cache break are empirical, and some breaks still record an unknown cause.
- The pinned prefix and tool-round control have no off switch, so they cannot be compared with a baseline yet.
- Prompt wording changes very little between model families.
- Nothing in the loop, the budgets, or tool handling is specific to diffusion models.

## Why it matters

Input tokens dominate the cost of an agent session, and providers bill cached input at a fraction of fresh input. A harness that breaks the cache without noticing pays full price for the same bytes on every turn. Attribution turns that from a suspicion into a recorded cause someone can fix.

## Use PanCode on it today

::: steps
### Read what a session's cache did

```sh
pancode telemetry tokens --session <id> --by-source --json
```

Each turn reports its cached input, fresh input, and output tokens. `--by-source` splits the prompt by where its bytes came from.

### Compare with keepalive off

```sh
pancode config set chat.cacheKeepalive false
```

Run the same long task again and compare cached input on the turns that follow a slow tool call.

### Check what a connection reports

```sh
pancode targets --probe
```

The probe shows the capabilities each target answered with.
:::

## First experiment

::: note Proposed, not yet run
Nobody has run this protocol. If you do, your numbers are the first this page has.
:::

Pick one long task and one model from each family your subscription offers. Run it three times with keepalive on and three times with it off, holding the repository and thinking level fixed. Record cached and fresh input per turn, and the recorded cause of every cache break.

The main mechanism needs a switch first. Until the pinned prefix can be turned off, only keepalive and prewarm can be compared with a baseline.

## Open questions

- [Can a small decision model improve an agent's work?](/research/system-one-decisions.html)

## How to join

Open a [GitHub issue](https://github.com/akougkas/pancode/issues) that says what you plan to measure, and read the [contributor guide](https://github.com/akougkas/pancode/blob/main/CONTRIBUTING.md). Results are published on this page with their numbers, including null and negative ones.
