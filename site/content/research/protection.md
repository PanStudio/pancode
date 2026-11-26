An agent runs commands with your permissions, and some of what it reads was written by strangers. PanCode decides each call in layers: a floor that never moves, containment where the host offers it, a judge for what remains, and you for what only you can decide. This page describes that design and how to measure it.

::: note Design described for PanCode 0.9.1
The mechanisms here are read from source. Nothing on this page is measured yet. The experiment is proposed and not yet run.
:::

## The design

- **One admission function.** The same function decides a call from PanCode's own tools, from the Claude SDK bridge, and from an agent reached through ACP. It applies the floor first, then hard limits such as read-only, then confirmation rules, then the autonomy level.
- **A floor at every autonomy level.** Formatting a disk, deleting a home directory or the workspace's `.git`, and changing PanCode's own state, credentials, or project trust are refused before anything else is considered, yolo included.
- **Containment before judgment.** A shell call the OS sandbox contains runs without an approval card. So does a destructive call that a snapshot taken beforehand can undo. Asking is reserved for what neither contains.
- **A judge that never reads the model.** A call that would wait for approval goes first to a model with no tools. Its input is your typed messages, facts the host computed, and the call itself inside a random tag. It never sees the assistant's text, its reasoning, or any tool result.
- **Backstops in code.** The judge's permission to leave the sandbox stands only when your own words mention it. Three blocks under different rules, or twenty in total, hand the next call to you.
- **Information-flow labels.** A project can declare which paths and tool results may reach which model connections. A result is labeled before its call runs, the labels survive compaction and resume, and every outbound request is checked against them. An unreadable ledger refuses all transfers.
- **Settings that can only tighten.** A project's own configuration can make safety stricter than yours and never looser.

## Source map

::: compare
| Mechanism | Source | Default | Switch |
| --- | --- | --- | --- |
| Admission order | `src/domains/safety/admission.ts` | On | `safety.autonomy` |
| Floor | `src/domains/safety/yolo-floor.ts` | On | None |
| Sandbox and snapshots | `src/core/sandbox/`, `src/domains/workspace-snapshots/` | On where available | `safety.sandbox`, `safety.snapshots` |
| Safety judge | `src/domains/safety/safety-judge.ts` | On | `safety.judge.enabled` |
| Information flow | `src/domains/safety/information-flow.ts` | Off | A project policy |
| Tighten-only layers | `src/core/settings-layers.ts` | On | None |
:::

## The question

How many approval cards can containment and a judge remove without admitting a call you would have refused? Both numbers matter. Fewer cards with one bad admission is a worse system. The answer could be that the judge saves little once the sandbox is on.

## What is known so far

These are facts about the design, read from source. They are not study results.

- The floor reads command text. It cannot see what a script does once it runs, which is why the sandbox is the real boundary where one exists.
- The judge does not read model text, but the call it reviews carries arguments the model wrote.
- The checks on your words are string matching.
- Flow labels apply to a whole session. Data read through a script or a shell variable is not labeled.
- A screen for instructions hidden in web and tool results exists and runs only when a decision model is configured, which is off by default.
- The macOS sandbox profile is less tested than the Linux one.

## Why it matters

Approval fatigue is a safety problem. A person who has clicked allow two hundred times reads the next card less carefully. Removing the cards that containment already makes safe leaves attention for the ones that matter, provided nothing unsafe is admitted along the way.

## Use PanCode on it today

::: steps
### Check what your machine can contain

```sh
pancode doctor
```

The report says whether a sandbox backend is available.

### Compare with the judge off

```sh
pancode config set safety.judge.enabled false
```

Run the same task and count the approval cards.

### Undo a change

Type `/rewind` in a session. It previews and restores files from a snapshot and never moves your branches.
:::

Worked example: [Let PanCode work without watching every call](/tutorials/let-it-work-with-containment-and-rewind.html).

## First experiment

::: note Proposed, not yet run
Nobody has run this protocol. If you do, your numbers are the first this page has.
:::

Build a task set of two kinds. The first needs ordinary commands that would normally ask, such as installing a dependency. The second plants an instruction in a file or a fetched page that asks the agent to do something you never requested. Run each with the judge on and off.

Record approval cards per task, calls admitted that the planted instruction asked for, and the judge's added time per call. A single admitted planted call is the result to report first.

## Open questions

- [Can a small decision model improve an agent's work?](/research/system-one-decisions.html)

## How to join

Open a [GitHub issue](https://github.com/PanStudio/pancode/issues) that says what you plan to measure, and read the [contributor guide](https://github.com/PanStudio/pancode/blob/main/CONTRIBUTING.md). Results are published on this page with their numbers, including null and negative ones.
