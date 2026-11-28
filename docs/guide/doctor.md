# Doctor

`pancode doctor` checks your PanCode install and the current workspace and prints one row per check, each marked `OK`, `INFO`, `WARN` or `!!`. Run it when something does not work, after an upgrade, or before you report a problem. The first row says whether chat can run and what to run when it cannot. `pancode doctor --fix` repairs what PanCode can repair by itself, and `/doctor` shows the same report inside a session. See [First problems](troubleshooting.md#first-problems) to interpret common errors.

Plain `doctor` is read-only and sends no model generation request (passive endpoint probes use a 2.5s budget per target). The command lives in [doctor.ts](../../src/cli/doctor.ts) and the core checks in [doctor.ts](../../src/domains/lifecycle/doctor.ts).

## Invocations

| Invocation | Behavior |
| --- | --- |
| `pancode doctor` | Standard checks; text output prints `chat`, `PanCode version` and every `warn`/`error` row, then one count line (``N rows need attention, M checks passed, K notes; `pancode doctor --verbose` prints every row``). On an unconfigured home a line above it reads ``chat is not set up: run `pancode configure` ``. |
| `pancode doctor --verbose` | Every row in text output. |
| `pancode doctor --json` | Emits `{ ok, fix, deep, findings: [{ ok, name, level, detail }] }` on stdout (every row). |
| `pancode doctor --fix` | Repairs missing dirs, templates, `settings.yaml`/`credentials.yaml` mode (`0600` POSIX), state/data root mode (`0700` when ownership verifies), YAML 1.1 `on`/`off` booleans (preserving comments unless aliases/anchors prevent it), fleet preflight cache, stale task worktree claims, plugin and extension install records this build does not accept, stale Yazi profile, GUI background service/launchers, and missing source checkout build outputs. Wrong model IDs change only after confirmation: a terminal asks, and `--fix --yes` (or `-y`) applies them without asking; without a terminal and without `--yes` they are reported and skipped. It never removes or renames settings keys. |
| `pancode doctor --deep [--tools-timeout <s>]` | Adds live streamed tool-call probes (`tools <target>`, default `120`s timeout) and validation contract dry run (`validator <n>`). Composes with `--json` and `--fix`. |
| `/doctor [--deep]` | In-session summary notice (e.g. `doctor: 58 checks, 0 error(s), 3 warning(s)`) with worst-row level; read-only (never repairs). |

`--tools-timeout` without `--deep`, a non-positive `--tools-timeout`, `--yes` without `--fix`, or an unknown flag prints one error line and `see: pancode doctor --help` to stderr and exits `2` (with `--json`, a JSON failure document also goes to stdout). `--help` prints to stdout and exits `0`.

## Levels and exit codes

| `level` | Badge | Meaning | Exit code |
| --- | --- | --- | --- |
| `ok` | `OK` | Healthy. | `0` |
| `info` | `INFO` | Informational (e.g., absent optional tool). | `0` |
| `warn` | `WARN` | Degraded or advisory; PanCode still runs. | `0` |
| `error` | `!!` | Broken requirement (`ok: false`). | `1` |

- `warn` and `error` findings that do not already contain a backticked `pancode`, `pnpm`, `chmod`, or `export NAME=` command get `` ; next: `<command>` `` appended automatically (`withDoctorCommand`), after the detail's closing period is dropped.

## First run: which rows to read first

1. **`chat`**: Leads the report; names the configured route and `endpoint reachable` or the missing piece with its recovery command. Fix `!!` rows first.
2. **`connection <id>`**: One per configured target; reports credential availability, passive probe answer, and any failure detail.
3. **`shell sandbox`**: `OK` when contained in an OS sandbox; `WARN` when uncontained (more commands ask for approval).

## Target and capacity rows

- **`chat`**: On an uninitialized or unconfigured home, plain `doctor` warns on `chat` (and on `installation`, `not set up yet`, when uninitialized), writes nothing, and exits `0` (`--fix` creates directories without configuring a model). On a home that names a chat target, `chat` is `!!` and doctor exits `1` when the route cannot run: an ineligible runtime, no model, a missing credential, an endpoint that did not answer, or a failed `connection`/`model` row for that target ([doctor.ts](../../src/cli/doctor.ts)).
- **`connection <id>`**: Per-target credential check and 2.5s passive probe (expired browser OAuth is reported without refreshing). Missing credentials/failed probe is `error` for targets used by `chat`/`fleet`/`memory`, else `warn`. Successful public metadata does not prove credentials are ready for inference. `alcf` passive check reads catalog only (does not probe inference URL).
- **`model <id>`**: Checks configured role models against live, cached, configured, or provider catalog lists. A catalog match is not live availability (and absence from a catalog/recorded list is `WARN`). Absence from a live list on a `chat`/`fleet`/`memory` target is `error` (except `copilot-sdk`, which emits `INFO` and sends model ID as typed).
- **`copilot sign-in` / `copilot tier <id>`**: When a `copilot-sdk` target and SDK component exist, probes Copilot login with system keychain closed (`run`/worker behavior); in a TTY, falls back to keychain open and emits `WARN` with headless fix instructions if login exists only there (`no terminal` notes keychain was skipped). Missing login is `error` if active in `chat`/`memory`/`fleet`, else `warn`. PanCode reads no token; only the runtime answers. `contextTier: long_context` emits an `INFO` `copilot tier <id>` row.
- **`local worker capacity`**: Reports usable CPUs, available memory, cgroup/process limit, and resolved `auto` worker count (explicitly notes GPU/VRAM fit is not inspected).

## Core install rows

| Row(s) | Checks and failure conditions |
| --- | --- |
| `repair` | `!!` (`--fix could not finish: <reason>`) if `--fix` threw while repairing directories. |
| `PanCode version`, `node version`, `platform`, `engine runtime` | CLI version, Node `>= 22.19.0`, OS/arch, bundled/SDK runtime presence. |
| `install method` | Kind (`installer`, `npm`, `pnpm`, `bun`, `homebrew`, `winget`, `source`, `local`, `unknown`), tracking/pin state (`follows <channel>; background updates on` or `off (<blocker>)` where blocker is `env`\|`setting`\|`installer`; `pinned to <version> since <date> (<origin>); release with pancode upgrade --channel <channel>`; npm/pnpm/bun `<kind> global; follows latest through <kind>; update after exit on\|off (<reason>)`), last background update / waiting `pid@host` holds. `WARN` on launcher/Node mismatch, failed/waiting update, or `unknown` layout. |
| `directory layout`, `config dir`, `data dir`, `state dir`, `cache dir` | Absolute, distinct, non-nesting paths (including symlinks). |
| `settings.yaml*` | `settings.yaml` (`OK` or `!!` invalid keys), `settings.yaml mode` (`WARN` > `0600` POSIX; `--fix` prints `tightened <old> -> 600`; skipped on Windows), `settings.yaml booleans` (`WARN` YAML 1.1 `on`/`off`), `settings.yaml repair` / `repair skipped` (`WARN` when aliases/anchors/tags block rewrite). |
| `credentials` | `OK` `none saved; save a key with pancode auth login <target>` when `credentials.yaml` does not exist (the first saved key creates it); `!!` if it is unreadable or mode != `0600` on POSIX; on Windows `WARN` names any ACL principal beyond the owner, SYSTEM and Administrators, and `--fix` makes the file owner-only. |
| `state metadata` | `!!` if `home.json` missing/unreadable/older version (`dev` build skips stamp check), or if a newer PanCode wrote the home (lists newer version, `PATH` binaries, `PANCODE_ALLOW_OLDER=1` override for headless/ACP). |
| `state dir mode`, `data dir mode` | `WARN` if group/other bits set on POSIX (`--fix` tightens when ownership verifies -> `tightened to 700`; otherwise `chmod 700` it yourself when not PanCode's alone). |
| `installation files`, `running <surface> <pid>` | Release builds/checkouts verify outputs (`!!` remedies: `pnpm --dir <checkout> run build` for source, which `--fix` runs, or `pancode upgrade` for packages); stale live processes emit `WARN`. |
| `GUI background`, `GUI running version` | Shown when `state/gui/background` exists; `WARN` on broken/foreign service/launchers (`--fix` repairs) or stale running GUI version. |
| `session store` | Readable session ledger count; `!!` on unreadable ledgers/dirs. |
| `plugin install records (<scope>)`, `extension install records (<scope>)`, `<kind> install record <id> (<scope>)` | One row per scope (`user`, `project`) for `plugins/state.json` and `extensions/state.json`: `OK` counts the valid records, `!!` if the file cannot be read. Each record this build does not accept is a `WARN` row with the reason, and PanCode skips it with a single warning when it loads. `--fix` drops the record: package files that match its digest are removed, any other files are moved aside to a recovery copy, and a symlinked package is left in place. Reinstall with `pancode hub install <pack>`. |
| `telemetry`, `cache telemetry` | Effective capture mode, workspace consent count/grant (`WARN` on unreadable settings/consent), and latest session prompt-cache stats (`INFO` if no cached calls, `WARN` if journal unreadable; `pancode telemetry doctor` checks seals). |
| `state storage`, `home storage`, `install root` | Disk footprint of state (with top subdir), config/data/cache, and installer root (`WARN` when binary runs outside an existing installer root; remove with `pancode uninstall --inactive`). |
| `sandbox cache` | Size of the main-session sandbox's tool cache against `safety.sandboxCacheMaxGiB`; `WARN` when over the cap. `--fix` removes the least recently used tool directories until it fits, and skips while a running process holds the cache. |
| `dispatch reservations`, `dispatch capacity leases`, `dispatch cache lanes` | Valid records in the dispatch admission store, with the live owners of prompt cache lanes. A live record no current reader accepts is `!!` and refuses dispatch until `--fix` drops it; a settled one is `WARN` and is dropped at the next start (a cache lane at the next store write) or by `--fix`. An unreadable store shows as `dispatch admission store`, which `--fix` resets. |
| `model catalog overlays`, `model catalog file` | Shown when an overlay directory exists: its entry count and model families. A file that fails to parse is a `WARN` `model catalog file` row naming it; the other overlay files still apply. |
| `target <id>`, `cache <id>` | `WARN` if OpenAI/Anthropic-compat target behaves like native LM Studio/Ollama (suggests `pancode targets convert`) or has cache advisories; `!!` on unknown runtime. |
| `proxy`, `scheduler commands` | `proxy` shown when `HTTP_PROXY`/`HTTPS_PROXY` set; `scheduler commands` shown when sandbox active and Slurm/PBS/LSF/Flux CLI found on `PATH`. |

Conditional rows:
- `validation contract`: valid (raises rigor default to `high`), absent, `WARN` Markdown-only, or `!!` invalid ([doctor-validation-contract.ts](../../src/cli/doctor-validation-contract.ts)).
- `interop <agent>`, `fleet node <id>` (SSH preflight cache), `harness` / `harness <file>` (`!!` per unresolved custom agent/skill/settings ref), `playbook <name>` (`WARN` on shadowed name), `reports` (`INFO` `<N> sent, <M> fixed`, listing fixed issues with release).
- `store root`: store dir + free space ([doctor-store.ts](../../src/cli/doctor-store.ts), [store.md](panstore.md)).

## External tools, PDFs, and panes

`external tool <id>` covers `asciinema`, `herdr`, `yazi`, `croc` (never `error`) ([doctor-toolchain.ts](../../src/cli/doctor-toolchain.ts), [resolve.ts](../../src/domains/toolchain/resolve.ts)):
- `herdr` uses PanCode's pinned copy only: ``pane host <pin> (PanCode's pinned copy) at <path>`` (`OK`), `` pane host <pin> is not installed; run `pancode panes install` `` (`WARN`), or `no pinned pane host for this platform; PanCode runs without panes` (`INFO`).
- Other tools prefer `PATH` when version `>= minimumVersion`, else vendored copy (`WARN` on missing `yazi` while files pane enabled; `INFO` on missing `croc`/`asciinema`):

| Detail | Meaning |
| --- | --- |
| `PATH <path> (<version>, pin <pin>)` | `PATH` binary met minimum floor and is used. |
| `vendored <path> (<pin>)` | Bundled/installed binary used (names any rejected `PATH` binary and floor). |
| ``vendored <versions> is superseded by the <pin> pin (update with `pancode tools install <id>`)`` | Only older vendored copies exist on disk; nothing resolves. |
| `PATH copy <path> is <version>, below the <floor> floor, and nothing is vendored (install with ...)` | `PATH` binary is too old and no vendored binary exists. |
| ``not found (install with `pancode tools install <id>`)`` | Neither `PATH` nor vendored copy resolves. |
| `not installed and no pinned asset for this platform (<platform>)` | No upstream pinned asset for host platform. |
| `experimental integration disabled by settings` | `yazi` when files pane is disabled (`OK`). |

- `files pane profile`: managed Yazi profile (`OK`/`INFO`/`WARN`; `--fix` regenerates when `yazi` + `ya` resolve and Yazi validates it; cache write errors return a profile error without crashing launchers).
- `panes ...` ([doctor-panes.ts](../../src/cli/doctor-panes.ts)): Outside `HERDR_ENV=1`, emits only `panes mode` and `panes layout`. Inside `HERDR_ENV=1`, emits 6 non-error rows (`panes mode`, `panes socket`, `panes protocol`, `panes binary`, `panes layout`, `panes journal dir`).
- `pdf attachments`: checks `pdftotext` + `pdfinfo` on `PATH` (`OK` with version, else `INFO` with `brew install poppler` / `scoop install poppler` / `poppler-utils`; runs on uninitialized homes too).

## HPC toolchain rows

Probes `cc` (`gcc`), `c++` (`g++`), `clang`, `gfortran`, `mpicc`, `mpicxx`, `mpirun`, `nvcc`, `cmake`, `make`, `ninja`, `meson`, `python3`, `sbatch` concurrently (2s `--version` timeout from a scratch dir; [doctor-hpc.ts](../../src/cli/doctor-hpc.ts)). Absent = `INFO` (or `WARN` if referenced by validation contract or missing `sbatch` with `runtime.kind: slurm`); non-zero exit = `WARN`; Slurm timeout = `WARN` (other timeouts stay `OK` with timeout note).

## Task worktrees

In a Git repo ([doctor-task-worktrees.ts](../../src/cli/doctor-task-worktrees.ts)):
- `task worktree root`: resolved dir, filesystem type, free space (`WARN` if `tmpfs`/`ram`/`auto` fell back to disk).
- `task worktree <runId>` (or `task worktrees`: `none preserved`): prints `<branch> (<state>, <age>, <reason>): inspect with git log <base>..<branch>; drop with ...`. `INFO` for `settled`, `WARN` for `abandoned` or orphaned claims (`--fix` removes stale claims whose branch and worktree are both gone, never deletes surviving branches or worktrees).

## Shell sandbox rows

`shell sandbox` summarizes host containment ([main-session.ts](../../src/core/sandbox/main-session.ts)):
- Contained (`safety.sandbox` != `off` and backend available): `OK` (or `WARN` if secret discovery hit its limit, sockets fell back to masks, or unconfined yolo refused): `default-autonomy shell commands run in the <backend> sandbox; writable roots: ...`, masked secret count (when the search stopped, the warning names each capped root, the limit of 2,000 directories or 100,000 names per root, and the fix: start PanCode in the project's own directory or move bulk data out of the workspace, or remove stale trees from the scratch root or keep secret files out of it; past 512 masks it says that is the most one launch masks), Unix socket enforcement (`seccomp`/`Seatbelt`/allow/masked), plus yolo line.
- Uncontained (`safety.sandbox: off` or no backend): `WARN`: `<reason>; <yoloState>; default-autonomy shell commands run uncontained and keep the approval rails`.
- Yolo state texts: `yolo runs contained in the same sandbox`, `contained yolo runs commands as default does and refuses what would ask`, `unconfined yolo commands run sandboxed too (safety.sandbox is required)`, `unconfined yolo refuses commands: safety.sandbox is required and no sandbox is available (...)`, `unconfined yolo runs unsandboxed`.
- `safety.scratchRoots`: one `WARN` row per invalid/excluded configured scratch root.

See [Containment at default](../architecture/safety-model.md#containment-at-default).

## System One

- **System One** ([doctor.ts](../../src/domains/lifecycle/doctor.ts)): `INFO` `off` if unconfigured, else `OK`/`WARN` per route plus `system one (experimental) engine <name>` (profile, context window provenance, passive health; use `pancode systemone check <engine> --live` to test decisions).

## Deep checks

Enabled via `pancode doctor --deep` or `/doctor --deep` ([doctor-deep.ts](../../src/cli/doctor-deep.ts)):
- **`tools <target>`**: Live streamed tool-call probe (`--tools-timeout`, default `120`s) per target (`OK` valid call + latency; `WARN` failed health/credentials or malformed/missing call; `INFO` no model, non-streaming runtime, no live probe, or non-chat decision engine). Unloads only a cold local model loaded by the probe itself.
- **`validator <n>`**: Resolves each contract validator executable (`PATH` or workspace-relative when containing `/`) and evaluates bash admission at configured `safety.autonomy` (or live session autonomy for `/doctor --deep`) without execution (`OK` if resolved + runs without ask, else `WARN`):

| Verdict | Meaning |
| --- | --- |
| `runs without approval at default` / `at yolo in the operator's session` | Admitted without approval prompt at evaluated level. |
| `asks for approval at default and runs at yolo in the operator's session` | Prompts (or judge-reviewed) at `default`; runs at `yolo`. If unrecognized, declare in `.pancode/safety.yaml` + `pancode config trust safety`. |
| `asks for confirmation at default and at yolo in the operator's session` | Explicit confirmation required even at `yolo` (with rule reason code). |
| `blocked by the safety policy (<reasonCode \| classification>)` | Blocked at the evaluated level. |
