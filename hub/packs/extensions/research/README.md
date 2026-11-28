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

`pancode research --help` lists every flag, and every subcommand takes `--json`. The full guide, including how a change
is judged, the budgets and contained yolo, is [Research campaigns and the arena](https://pancode.dev/docs/guide/research-and-arena.html).

Every worktree starts from a commit, with the verifier catalog and the untracked files the checks name copied in as the
workspace holds them. A tracked check input with uncommitted changes, the catalog included, is refused at start: commit
it first, since it would otherwise be committed into every iteration.

While it runs, `pancode research` writes the step it is on to standard error as `pancode research: <id>: <step>`.
Ctrl-C, SIGTERM and SIGHUP stop the agent run in flight, journal the stop and remove the worktrees; `resume` continues
it. One start or resume runs at most 23 hours 55 minutes, then stops so `resume` can continue it.

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

## Exit codes

| Command | 0 | 1 | 2 | Signals |
| --- | --- | --- | --- | --- |
| `research start`, `resume` | A budget cap ended the campaign | An error, a noisy A/A check, unenforceable spend, the 23 hour 55 minute stop, or a refused resume | Usage, unconfined yolo, or the pack not installed | 130 SIGINT, 143 SIGTERM, 129 SIGHUP |
| `research report` | Every regrade agrees with the journal | A regrade disagrees, or the campaign is missing | Usage | |
| `research status`, `list` | Done | The campaign is missing | Usage | |
