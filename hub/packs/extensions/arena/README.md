# Arena

`pancode arena` gives one prompt to 2 to 4 target/model pairs side by side. You see their answers and diffs without
knowing which model produced which, vote, and get standings from your votes. PanCode records results and never judges:
no model grades a contender, and standings come only from your votes.

Arena is a first-party hub extension that ships with PanCode: the installer and `pancode upgrade` install it once, and
it is updated and removed on its own like any other pack:

```sh
pancode hub remove extension:arena     # stays removed across upgrades
pancode hub install extension:arena    # brings it back
pancode hub update extension:arena     # moves to the release's pinned copy
```

Without it, `pancode arena` answers `pancode arena: extension:arena is not installed; pancode hub install
extension:arena installs it` and exits 2.

## What it is allowed to do

The manifest is the consent. Installing the pack approves this envelope, and an update that grows it asks again:

| Capability | Why |
| --- | --- |
| `cli: arena` | The `pancode arena` verb. It runs the `arena` command headlessly and prints what the command answers. |
| `commands: arena` (`long: true`, up to 24 hours) | The match itself, also reachable in a session as `/ext:arena:arena <subcommand> ...`. |
| `state.project` | Matches and votes, kept in the project under `.pancode/data/arena/`. |
| `services.runs` | Each contender is one headless `pancode run`, at most 4 at a time, each up to 86400 seconds and 1000 USD, at default or contained yolo autonomy. |
| `services.worktrees` | One Git worktree per contender, cut from `HEAD` and removed when the match ends. |
| `services.verify` | `--check` runs one of the project's checks in each contender's worktree. |

It has no file, program or network permission of its own: everything it runs goes through those services.

## Quick start

Name two `<target>/<model>` pairs from `pancode targets` and give them a prompt:

```bash
pancode arena run --contender <target>/<model> --contender <target>/<model> \
  -- "Fix the bug in calc.py so test_calc.py passes."
pancode arena show <match-id>          # the id run printed; answers and diffs under blind labels
pancode arena vote <match-id> A        # or B, tie, both-bad
```

| You want to | Use |
| --- | --- |
| Pick a model or target for a kind of task in your own repository | `arena run`, then `arena vote` and `arena standings` |
| See how two models approach the same bug before trusting either | `arena run --check <id>` |

Every subcommand works headless with `--json`, and `pancode arena --help` lists every flag. `--cwd <dir>` runs it for
another project.

## Run a match

```bash
pancode arena run --suite bugs --check unit \
  --contender copilot/claude-haiku-5.5 \
  --contender litellm/gateway/qwen3.8-27b \
  -- "Fix the bug in calc.py so test_calc.py passes. Keep the change minimal."
```

A contender is `<target>/<model>`, split at the first `/`, so models with slashes in their names work. Every contender
runs as a normal `pancode run`, so the same safety policy, cost accounting and run evidence apply. Inside Git, every
contender runs in its own worktree from `HEAD`. Uncommitted changes are not part of the baseline, and the worktrees are
removed when the match ends, after each contender's diff is saved. Outside Git, or with `--read-only`, contenders only
read. Put `--` before a prompt that starts with `-`.

`--timeout <seconds>` is each contender's `run --timeout`: 600 by default, at most 86400. `--max-cost-usd <N>` is each
contender's `run --max-cost-usd`, at most 1000. Without it each contender is still bounded at 1000 USD, the pack's
ceiling; a route PanCode cannot price is not bounded by either.

`--check <id>` runs one of the project's checks (see [Project quality policies](https://pancode.dev/docs/guide/quality-policy.html))
in each contender's worktree when it finishes. The check runs in the sandbox host verification uses, rooted at the
worktree, since it executes what the contender wrote. An id the project cannot resolve is refused before any contender
starts. A sweep check takes one run, `--check <sweep>/<run>`. The project's `.pancode/verifiers.yaml` is copied into
each worktree, committed or not, and replaces any copy a contender wrote. So are the uncommitted files the check names:
untracked or changed files under each path on its command (the run directory of a sweep included), its `reference` or
`baseline` file and a `reproduce` check's pinned inputs. They are copied before the contender starts and again before
the check runs, so the check reads the project's bytes, and the diff starts after the copy, so it shows only what the
contender changed. Ignored files and links are not copied, and a check that names more than 256 uncommitted files or
32 MiB is refused before any contender starts; commit those inputs instead. A file the check reads without naming it,
such as one its script opens, must be committed.

`--autonomy yolo` runs every contender as contained yolo: the sandbox, the judge and your autonomous caps stay on, and a
call that would need you is refused back to the contender. All contenders in a match share the autonomy, and
`match.json` records it. Before a vote, `show` adds each contender's count of open decisions and the cap or judge that
paused it, if any, next to its blocks. The refused commands themselves stay in the contender's own stream. Unconfined
yolo is refused with exit 2 before the match starts, and so is yolo started from the bash of a session below yolo
(`PANCODE_AUTONOMY_CEILING` is set). `--read-only` still applies at yolo. Each yolo contender is launched with
`PANCODE_YOLO_CONFINEMENT=contained`, so it stays contained even if your settings turn unconfined while the match runs.

While it runs, `pancode arena run` writes one line per step to standard error: the match id, the contender count and
isolation, and each contender's blind label as it finishes. Lines closer together than a quarter second fold into the
later one, so two contenders finishing together may show one line. Ctrl-C stops the contenders, records the match as
failed (`canceled before every contender finished`), prints it and exits 130; a second Ctrl-C stops at once.

## Vote blind, then reveal

```bash
pancode arena show <match-id>                   # labels A..D in a seeded random order
pancode arena vote <match-id> A --note "smaller diff"
pancode arena show <match-id> --reveal          # now shows who was who
pancode arena standings --suite bugs
```

Before a vote, `show` lists each contender's answer, diff, turns, tool calls, writes, blocks and check result. It hides
the target, model, duration, tokens and cost, and redacts identifying text such as session ids and worktree paths.
`--reveal` before a vote is refused. One vote counts per match. `--replace` changes it, and the journal keeps both. The
choices are a label, `tie` or `both-bad`. A diff longer than 256 KiB, or one that would take the answer past 1 MiB, is
cut and marked `diffTruncated`; the whole diff stays in the match directory.

`arena list [--suite <name>]` lists the recorded matches with their status, contender count, vote, suite and prompt. It
names the target/model pairs (under `--json`) only for a voted match, so it never unblinds a pending one.

`standings` counts wins, losses, ties and both-bad votes per target/model. Once an identity has 5 votes, it also shows an
Elo rating. Every identity starts at 1000, and the votes are replayed in match order with K 32, so the same records
always give the same ratings. A win beats every other contender in the match, `tie` is a draw between each pair, and
`both-bad` leaves ratings alone. In a 3- or 4-way match, K is split across the opponents.

## In the GUI

The GUI's Arena page runs the same commands through `pancode arena`, so it needs this pack. It has a New match form with
live progress and Cancel, blind columns with answers, diffs and check output, a vote panel, and standings. See
[Graphical application](https://pancode.dev/docs/guide/gui.html#arena-page).

## Where things are stored

| What | Where |
| --- | --- |
| Matches | `.pancode/data/arena/<match-id>/` at the top of the repository (the project directory outside Git): `match.json`, each contender's `contender-N.ndjson` stream and `contender-N.diff`, and `vote.json` |
| Vote journal | `.pancode/data/arena/votes.jsonl`, every vote including replaced ones |
| Contender worktrees | `.pancode/worktrees/ext-arena/`, removed when the match ends |

`match.json` is written first and after every step, so `list` shows a match that is still running. Matches recorded
under `.pancode/arena/` by PanCode 0.9.1 and earlier are not read.

## Limits

Contenders do not inherit your whole environment. Each gets the safe command variables (`PATH`, `HOME`, `USER`, `LANG`,
`TMPDIR`, the XDG base dirs), PanCode's own `PANCODE_*`, `LC_*`, `TERM`, `SHELL`, `TZ`, `NODE_OPTIONS`, proxy and CA
variables, git author and committer names and emails, and the names in `safety.sandboxPassEnv`. From the credentials
it gets only its own target's: the target's `auth.apiKeyEnvVar`, its runtime's default key variable, and that runtime's
own variables. A contender loses everything else: other targets' keys, `GITHUB_TOKEN`/`GH_TOKEN`, `SSH_AUTH_SOCK`,
cloud logins its runtime does not read, `HERDR_*`, `DISPLAY`, `EDITOR`, and toolchain variables such as `VIRTUAL_ENV`.
Add a name it needs to `safety.sandboxPassEnv`.

## Exit codes

| Command | 0 | 1 | 2 | Signals |
| --- | --- | --- | --- | --- |
| `arena run` | Every contender finished | The match failed, or a `--check` the project cannot resolve | Usage, unconfined yolo, or the pack not installed | 130 SIGINT, 143 SIGTERM, 129 SIGHUP |
| `arena show`, `vote` | Done | Unknown match, reveal before a vote, or a second vote without `--replace` | Usage | |
| `arena list`, `standings` | Done | | Usage | |
