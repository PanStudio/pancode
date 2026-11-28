# Research

`pancode research` improves one measured number in your project, such as wall time, an error or a score. It runs
PanCode's own agent in a fresh worktree, measures each change against the current best with interleaved trials, and
keeps it only when the improvement clears your threshold with a bootstrap 95% interval that excludes zero and every gate
check passes. Kept changes land on the branch `pancode/research/<id>`, never on yours.

Research is a first-party hub extension that ships with PanCode: the installer and `pancode upgrade` install it once,
and it is updated and removed on its own like any other pack:

```sh
pancode hub remove extension:research     # stays removed across upgrades
pancode hub install extension:research    # brings it back
pancode hub update extension:research     # moves to the release's pinned copy
```

Without it, `pancode research` answers `pancode research: extension:research is not installed; pancode hub install
extension:research installs it` and exits 2.

## What it is allowed to do

The manifest is the consent. Installing the pack approves this envelope, and an update that grows it asks again:

| Capability | Why |
| --- | --- |
| `cli: research` | The `pancode research` verb. It runs the `research` command headlessly and prints what the command answers. |
| `commands: research` (`long: true`, up to 24 hours, alias `/research`) | The campaign itself. In a session `/research` alone opens the campaign panel, and `/research <subcommand> ...` runs the verb. |
| `ui: panel` | The read-only campaign list and per-campaign timeline. |
| `state.project` | Campaigns, kept in the project under `.pancode/data/research/`. |
| `services.runs` | Each iteration is one headless `pancode run` without dispatch, one at a time, up to 86400 seconds, at default or contained yolo autonomy. |
| `services.worktrees` | A base worktree and one worktree per iteration, cut from the best commit; the branch `pancode/research/<id>`, moved by compare-and-swap. |
| `services.verify` | The objective and gate checks, measured in each worktree. |
| `services.claims` | Judged gates record claims, and each measured iteration records the agent's plan as a hypothesis, tested on the measurement's own runs: succeeded, failed, or aborted when the campaign stopped first. |

It has no file, program or network permission of its own: everything it runs goes through those services.

## Quick start

Declare a check that prints a JSON payload in `.pancode/verifiers.yaml`, commit it, then:

```sh
pancode research start --check bench --metric wall_ms --direction min --max-iterations 3
pancode research status              # the latest campaign
pancode research report <id>         # regrade every verdict from the raw samples
pancode research resume <id>         # pick a stopped campaign up where its journal ends
git diff HEAD pancode/research/<id>  # review the kept changes, then merge them yourself
```

`pancode research --help` lists every flag, and every subcommand takes `--json`. Research never judges quality with a
model: it decides from your checks and the measurements.

Every worktree starts from a commit, with the verifier catalog and the untracked files the checks name copied in as the
workspace holds them. A tracked check input with uncommitted changes, the catalog included, is refused at start: commit
it first, since it would otherwise be committed into every iteration.

While it runs, `pancode research` writes the step it is on to standard error as `pancode research: <id>: <step>`.
Ctrl-C, SIGTERM and SIGHUP stop the agent run in flight, journal the stop and remove the worktrees; `resume` continues
it. One start or resume runs at most 23 hours 55 minutes, then stops so `resume` can continue it.

## Declare the objective and the gates

The objective is one key of the JSON a check prints. Correctness is a separate check that must pass on every candidate.
Commit `.pancode/verifiers.yaml` so that each research worktree contains it
(see [Project quality policies](https://pancode.dev/docs/guide/quality-policy.html)):

```yaml
version: 2
checks:
  - id: bench
    description: Wall time of stats.py on 3000 values (min is better)
    kind: command
    command: [python3, bench.py]   # prints {"wall_ms": 12.3}
    cwd: .
    timeoutMs: 60000
    tags: [benchmark]
  - id: correct
    description: stats.py answers match the reference on a holdout input
    kind: numeric-compare
    command: [python3, check.py]
    reference: tests/reference/stats.json
    tolerance: { relative: 1.0e-9 }
    cwd: .
    timeoutMs: 60000
    tags: [correctness]
```

A `perf-budget` check works as an objective too: its `wall_ms` falls back to the measured duration. A `reproduce` check
cannot be an objective, but it can be a gate.

A sweep check (one with `runs: <directory>`) takes one run at a time, as `verify` does. `--check <sweep>/<run>`
optimizes the metric of that run, and `--gate <sweep>/<run>` gates on it; the run directory is appended to the check's
command and is protected like every other file the check names. A bare sweep id is refused as the objective, with the
runs it holds listed, and as a `--gate` it gates on every run directory present when the campaign opens, each recorded
as its own `<sweep>/<run>` gate. A run directory that is not committed, or has uncommitted changes, is refused when the
campaign opens.

Install what the checks need in the project before the campaign starts, not through the agent. Each candidate is
measured and gated as its commit plus the environment its worktree had before the agent ran, such as installed
dependencies or build output a checkout step leaves. The worktree is created with no repository hook, so a
`post-checkout` hook does not run there; a smudge filter does. The worktrees sit under `.pancode/worktrees/` inside
the project, so a `node_modules` there resolves from them. That environment is read-only to the agent: a file added,
removed or changed inside it rejects the candidate unmeasured as `protected` ("changed the pre-agent environment").
Anything else the agent leaves untracked or ignored, a fresh install or a check's output included, is removed before
measuring, and the checks recreate their own output.

## Run a campaign

```sh
pancode research start --check bench --metric wall_ms --direction min \
  --max-iterations 5 --gate correct --scope stats.py --max-wall-minutes 30 \
  --goal "make stats.py faster without changing any answer"
```

`--max-iterations` is required. Add `--max-cost-usd` for a spend cap and `--target` with `--model` to choose the agent's
model; name both or neither. The campaign prints one line per step and ends with a summary:

```text
A/A: inconclusive (too few trials to judge the noise; raise --trials); inconclusive, median delta +5.15%, 95% CI [-14.69%, +21.51%]
  it-0001  ratcheted; improved, median delta -99.43%, 95% CI [-99.58%, -99.37%]; gates correct pass; cost unknown
  it-0002  not-improved; unchanged, median delta -3.28%, 95% CI [-20.43%, +33.28%]; gates correct pass; cost unknown
stopped: max-iterations: ran 2 of 2 iterations
```

## How a change is judged

1. **A/A check.** Before the first iteration, the base is measured against itself with the same number of trials. If
   that already looks like a change, the measurement is too noisy to trust, and the campaign stops unless you pass
   `--allow-noisy`. The A/A line reads `quiet` only when the two medians stay inside `--min-improvement`. A larger
   move whose interval still spans zero reads `inconclusive (too few trials to judge the noise; raise --trials)`, and
   the campaign goes on.
2. **Agent run.** Each iteration runs `pancode run` at the campaign's `--autonomy` (`default` unless you choose
   `yolo`), with dispatch off, in a fresh worktree at the current best commit, and with a `--timeout` of the wall time
   left. The agent is told the objective, the gates, the scope and what earlier iterations tried.
3. **Rules before measuring.** The change is archived without measuring when it:
   - is a no-op;
   - repeats an earlier tree;
   - touches a protected path (the verifier catalog, every file the checks name including the executable, and the
     symlinks on the way to them);
   - changes a file outside `--scope`. Scope globs match dot segments too, so `**` covers `.github/` and `**/*.yml`
     covers `.github/workflows/ci.yml`.
4. **Measurement.** Base and candidate run in interleaved pairs (`--trials`, default 5). The change counts as improved
   only when two conditions hold:
   - the median moves by at least `--min-improvement` (default 5%) in the right direction;
   - a seeded bootstrap 95% interval (2,000 resamples) excludes zero.
5. **Gates.** Every `--gate` check, and a `numeric-compare` objective itself, must pass in the candidate's worktree.
   The objective and every gate run as `pancode verify` runs them, under the host verification sandbox rooted at their
   worktree.
6. **Ratchet.** A kept change moves `pancode/research/<id>` by compare-and-swap. If that fails because the ref moved, the
   change is archived as `ratchet-lost`. Your checked-out branch is never touched.

Research also writes to the [claims ledger](https://pancode.dev/docs/architecture/evidence-and-memory.html#claims-ledger):

- Judged gates (`numeric-compare`, `reproduce`) append claims.
- Each measured iteration records the agent's hypothesis and prediction, tested on the measurement's own runs:
  `succeeded`, `failed` when a measurement run failed, or `aborted` when the campaign stopped before the objective was
  judged. The objective is never run again just to record the test.
- The research verdict itself (supported, refuted or inconclusive) comes from the grade and is kept in the journal.

## Budgets and stopping

- `--max-iterations`, `--max-wall-minutes` and `--max-cost-usd` are hard stops. The wall deadline also cuts off the
  agent run in flight; a measurement or gate already running finishes within its check's `timeoutMs`, and nothing
  graded after the deadline is kept.
- Spend is summed from each run's cost. **Unknown spend is never counted as zero.** With `--max-cost-usd` and without
  `--allow-unpriced`, one unpriced run stops the campaign as `budget-unenforceable`. Local and gateway models without a
  price are unpriced.
- Ctrl-C, SIGTERM and SIGHUP stop the agent run, journal the stop and remove the worktrees. The exit codes are 130, 143
  and 129.

## Unattended campaigns with contained yolo

`--autonomy yolo` runs each agent as
[contained yolo](https://pancode.dev/docs/architecture/safety-model.html#contained-and-unconfined) inside its iteration
worktree. The OS sandbox, the safety judge and your autonomous caps (`safety.limits.autonomous*`) stay on. A call that
would need you is refused back to the agent instead of waiting, so a campaign never stalls on a prompt nobody is there
to answer. Each refused call is kept in the journal as an open decision, and `research status` and `research report`
list them under "open decisions left for you". A run that its caps or the judge paused is archived as `agent-failed`.
The campaign records its autonomy in `campaign.json`.

Research refuses `--autonomy yolo` with exit 2 before anything opens when your settings choose unconfined yolo
(`safety.yoloConfinement: unconfined`), as root outside a container, and when started from the bash of a session below
yolo (`PANCODE_AUTONOMY_CEILING` is set), the same as `pancode run`. Each agent run is launched with
`PANCODE_YOLO_CONFINEMENT=contained`, so it stays contained even if your settings turn unconfined while the campaign
runs.

## Read, check and resume a campaign

```sh
pancode research list
pancode research status            # the latest campaign
pancode research report <id>       # regrade every verdict from the raw samples
pancode research resume <id>
```

`research report` regrades the A/A check and every measured iteration from the stored samples with the recorded seed. It
exits 1 when any grade disagrees with the journal, so a campaign can be audited after the fact. In a session, `/research`
opens the same campaigns and timelines in a panel, and the GUI's
[Research page](https://pancode.dev/docs/guide/gui.html#research-page) browses, regrades, starts and stops them.

`research resume` picks a campaign up where its journal ends: one you stopped, one the wall budget, the 23 hour 55 minute
limit or an error ended, or one whose process died. The spec and budget stay the same, and the iterations, spend and
wall time already used count against it. The A/A check is not run again; the objective runs once on the best commit and
every gate runs there too, so the output the checks create is known before the next iteration commits. An iteration no
run finished is archived as `interrupted`, and the journal gets a `resumed` event. Resume is refused while another
process runs the campaign (`campaign <id> is already running (since <time>); stop it first`), when its A/A check called
a change, when its budget is already spent, and when something other than the campaign moved `pancode/research/<id>`.

## Where things are stored

| What | Where |
| --- | --- |
| Campaigns | `.pancode/data/research/<id>/` at the top of the repository: `campaign.json` (the frozen spec and checks), `journal.jsonl`, `samples/`, `slate.json` and, while a run holds it, `run.lock` |
| Worktrees | `.pancode/worktrees/ext-research/`, removed after grading unless `--keep` |
| Results | The branch `pancode/research/<id>` |

Campaigns opened by PanCode 0.9.1 and earlier live under `.pancode/research/<id>/` and are not read. Their branch is the
same, so moving the directory makes them readable and resumable again:

```sh
mkdir -p .pancode/data/research && mv .pancode/research/<id> .pancode/data/research/
```

## Limits

- Research optimizes one metric of one check, or of one run of a sweep, at a time and runs one candidate per
  iteration. It does not run candidates in parallel. `research resume` keeps the campaign's budget; it cannot raise it.
- Each agent run gets the filtered environment every extension run gets, not your whole environment; add a name it
  needs to `safety.sandboxPassEnv`.
- A measurement is only as good as its check. Run `research report` and look at the A/A line before you trust a gain.

## Exit codes

| Command | 0 | 1 | 2 | Signals |
| --- | --- | --- | --- | --- |
| `research start`, `resume` | A budget cap ended the campaign | An error, a noisy A/A check, unenforceable spend, the 23 hour 55 minute stop, or a refused resume | Usage, unconfined yolo, or the pack not installed | 130 SIGINT, 143 SIGTERM, 129 SIGHUP |
| `research report` | Every regrade agrees with the journal | A regrade disagrees, or the campaign is missing | Usage | |
| `research status`, `list` | Done | The campaign is missing | Usage | |
