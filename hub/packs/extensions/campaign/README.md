# Campaign

`pancode campaign run` runs one seeded project across a roster of models, the same prompt and the same scripted answers
for each, and reports how each run went: how it ended, the extension gates it reached, extension refusals, loop-guard
blocks, tokens, wall time, and the run's own completion and verification. It is built for extension-driven pipelines
that put gates to the author. It is unrelated to `pancode research` campaigns.

Campaign is a first-party hub extension that ships with PanCode: the installer and `pancode upgrade` install it once,
and it is updated and removed on its own like any other pack:

```sh
pancode hub remove extension:campaign     # stays removed across upgrades
pancode hub install extension:campaign    # brings it back
pancode hub update extension:campaign     # moves to the release's pinned copy
```

Without it, `pancode campaign` answers `pancode campaign: extension:campaign is not installed; pancode hub install
extension:campaign installs it` and exits 2.

## What it is allowed to do

The manifest is the consent. Installing the pack approves this envelope, and an update that grows it asks again:

| Capability | Why |
| --- | --- |
| `cli: campaign` | The `pancode campaign` verb. It runs the `campaign` command headlessly and prints what the command answers. |
| `cli.paths` | `--fixture`, `--roster` and `--answers` are opened read-only and `--out` read-write, only for the invocation that names them. |
| `commands: campaign` (`long: true`, up to 24 hours) | The campaign itself. |
| `services.runs` | Each entry is one headless `pancode run` in its fixture copy, one at a time, each up to 86400 seconds, at default or contained yolo autonomy, with its own PanCode home under `--out`. `commands: true` lets `--probe` run another installed extension's command in the copy. |

It has no file, program or network permission of its own. The paths you name on the command line are the only files it
can reach, and PanCode refuses a path that is `/`, your home directory itself, or overlaps PanCode's own directories,
and an `--out` inside a project's `.pancode/`. A missing `--out` is created for the invocation and removed again when
the campaign leaves it empty. In a session, `/ext:campaign:campaign` gets no paths, so it can only print help; run
`pancode campaign run` from a shell.

## Quick start

```bash
pancode campaign run --fixture ./fixtures/brownfield --roster roster.yaml --answers answers.yaml \
  --prompt "/desk:advance" --out ./campaign-out --timeout 1800 --probe desk:status
```

```yaml
roster:
  - target: openai-codex
    model: gpt-6-luna
    thinking: high          # optional, the entry's --thinking
    label: luna-high        # optional, defaults to <target>/<model>[@<thinking>]
  - target: lab
    model: qwen3-32b
```

`pancode campaign --help` lists every flag.

## Inputs

The roster is a mapping with one key, `roster`, a non-empty list of entries with `target`, `model`, an optional
`thinking` level and an optional `label`. Labels name each entry's rows and directory, so they must be unique: at most
80 letters, digits and `. _ @ / : + -`, starting with a letter or digit. The roster file is at most 64 KiB. The answers
file is a [`run --answers`](https://pancode.dev/docs/guide/commands-and-modes.html#script-the-author-with---answers)
file of at most 64 KiB; a fixture that asks no questions takes `answers: []`. Both are validated before anything
starts, and so is `--out`, which must be absent or empty and must not lie inside the fixture.

## How entries run

Entries run one at a time, and `--repeat <N>` runs the whole roster N times, one pass after another. Each gets a fresh
copy of the fixture under `<out>/<NN>-<label>/project` and its own empty PanCode data, state and cache under
`<out>/<NN>-<label>/home`, so entries share no sessions or memory. `<NN>` is the entry's position from `01`, and the
label's characters other than letters, digits, `.`, `_` and `-` become `-` in the directory name. With `--repeat` above
1, the directory also ends in `-r<K>`, the pass number from 1. Secret files in the fixture (`.env`, private keys, token
files) are copied empty, as an extension never reads them; an entry's run reaches your targets through your config
directory instead.

Each entry uses your config directory as it is (targets, credentials, installed extensions and MCP configuration), the
way your own `pancode run` would: nothing secret is copied under `--out`, and a login an entry refreshes is saved to your
credential store. Each also reads the runtime components you installed with `pancode tools install` (copilot-sdk,
claude-sdk) and your vendored tools from your own data directory, read-only, and an entry missing one names that
directory in its install hint rather than offering to install under `--out`. Its environment is filtered the way every
run an extension starts is (see Limits), with the allowlist read from the fixture copy's settings.

An entry runs headless `pancode run --cwd <copy> --target <target> --model <model> --answers <file>
--output-format stream-json`, with `--thinking` and `--autonomy yolo` when given and `--timeout` always: `--timeout`,
else 86400, the most the pack allows. `run.stdout.log` beside the copy keeps the run's stream-json frames, and
`run.stderr.log` the last 4 KiB of its standard error. `--autonomy yolo` is contained yolo only; unconfined yolo is
refused with exit 2 before anything starts. `--probe <extension>:<command>` then runs `pancode extensions run
<extension> <command> --json` in the copy, against the entry's home, for at most 120 seconds, and records its result as
the desk's final status.

Entries are runs an extension started, so each counts toward the nesting limit for extension runs: a campaign started
from inside a run an extension started is refused when that run is already at the limit.

## The report

The report gives, per entry, its status, exit code, the extension gates reached (the checkpoint ids its interviews put
to the author), extension refusals (hook `block_tool` effects and refused extension tool calls), loop-guard blocks,
input tokens with their fresh and cached parts, output tokens, wall time, the run's completion (its finish claim, the
host's assessment and the facts that lowered it), its verification (outcome and cause codes) and the probe's first line.
Gates and refusals come from the entry's session ledger and journal, tokens from the provider-measured totals that
`pancode telemetry tokens` reads, and completion and verification from the run's `run_end` frame.

The status is `completed` (exit 0), `unscripted` (exit 5, a question the answers file does not script), `timed-out`,
`failed` (any other exit), `canceled`, or `error` when the entry could not be set up or launched. A failing entry is
reported and the campaign continues. `--json` prints the whole campaign, with `completion.state` and
`verdict.aggregate` (`pass` when every entry completed, `fail` when none did, otherwise `partial`), and each entry also
writes `<out>/<NN>-<label>/entry.json`, which records its pass as `repetition` (from 0). The document's
`timeoutSeconds` is each entry's timeout, 86400 when you gave none.

While it runs, `pancode campaign run` writes one line per entry to standard error as it starts and ends. Lines closer
together than a quarter second fold into the later one. Ctrl-C cancels the running entry and the rest, prints the
campaign with `completion.state` `stopped` and exits 130; a second Ctrl-C stops at once.

## Where things are stored

| What | Where |
| --- | --- |
| Everything | The `--out` directory you name: per entry `<NN>-<label>/` holds `project/`, `home/`, `run.stdout.log`, `run.stderr.log` and `entry.json` |

Nothing is written under the project's `.pancode/`.

## Limits

- The whole campaign is one extension command, so it ends after 24 hours however many entries are left.
- Entries do not inherit your whole environment. Each gets the safe command variables (`PATH`, `HOME`, `USER`, `LANG`,
  `TMPDIR`, the XDG base dirs), PanCode's own `PANCODE_*`, `LC_*`, `TERM`, `SHELL`, `TZ`, `NODE_OPTIONS`, proxy and CA
  variables, git author and committer names and emails, and the names in `safety.sandboxPassEnv`. From the credentials
  it gets only its own target's. The `--probe` command gets no target's credentials. Add a name an entry needs to
  `safety.sandboxPassEnv`.

## Exit codes

| Command | 0 | 1 | 2 | Signals |
| --- | --- | --- | --- | --- |
| `campaign run` | Every entry was run, whatever its status; with `--exit-code`, only when every entry completed | The campaign itself failed, or, with `--exit-code`, some entry did not complete | Usage, including an invalid roster or answers file, a refused path, unconfined yolo, or the pack not installed | 130 SIGINT, 143 SIGTERM, 129 SIGHUP |
