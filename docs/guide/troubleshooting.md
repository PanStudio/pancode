# Troubleshooting & Error Remediation

Diagnose errors, permission refusals, target connection failures, and runtime anomalies. Quoted messages match source strings; `<...>` denotes runtime-interpolated values.

## First problems

Run `pancode doctor` first ([doctor.md](doctor.md)): its `chat` row identifies missing prerequisites and prints `` ; next: `<command>` `` when a direct fix exists.

| Symptom | Remediation | Reference |
| --- | --- | --- |
| `pancode: command not found` right after install | Open a new shell or run the `export PATH=...` line printed at the end of install (`~/.local/bin`). | [Installation](installation-and-lifecycle.md#install-pancode) |
| `<target> at <url> did not answer (<detail>). Start the server, or change the address with /config.` | Start the model server or update its URL with `/config`. Re-run `pancode doctor`. | [Configuration and targets](configuration-and-targets.md#configure-targets) |
| `<provider> has no key or sign-in stored. Run: pancode auth login <provider>`, or `connection <id>` HTTP 401/403 | Run the named `pancode auth login` command or fix credentials in `/config`. | [Doctor](doctor.md#core-install-rows) |
| `orchestrator model '<model>' on target '<id>' reports no tool support; PanCode drives every agent role through typed tools.` | Pick a tool-capable model via `/model` or `pancode targets use <id> --model <model>`. | [Configuration and targets](configuration-and-targets.md#chat) |
| `shell sandbox` row WARN: `<reason>; <yoloState>; default-autonomy shell commands run uncontained and keep the approval rails` | Host lacks OS sandboxing (`bubblewrap` on Linux, plus unprivileged user namespaces inside containers). PanCode works uncontained with tighter approval prompts. | [Sandbox and safety](sandbox-and-safety.md) |
| Final reply names an open decision; call denied without answer | An interactive approval card exceeded `safety.unattendedAfterSeconds` (default `300` s). Name the needed action in your prompt so the safety judge can evaluate it, or set `0` to wait indefinitely. | [Sandbox and safety](sandbox-and-safety.md#how-each-level-treats-an-escaping-command) |

## Install and startup

### Node runtime and startup checks

- **`pancode requires Node.js >=22.19.0; this is <version>.`** (exit `1`, or npm `EBADENGINE` warnings on older Node such as Node 18): Install with the installer, which brings its own Node.js (`curl -fsSL https://pancode.dev/install.sh | sh`), or point PanCode at a supported runtime with `PANCODE_NODE=/path/to/node/bin/node`. See [HPC clusters](hpc-clusters.md).
- **`No model target is configured.` / `No usable default target is configured.`**: Bare `pancode` found no saved or detected chat route and launches `pancode configure`. Finish setup or run `pancode targets use <id> --model <model>`.
- **`Target '<id>' has no chat model. Run: pancode targets use <id> --model <model>` / `Target '<id>' runs on '<runtime>', which cannot drive the main agent.`** (exit `2`): Saved chat route cannot run the orchestrator (`Your saved chat route is kept and no other target is used.`). Repair via `pancode configure` or `pancode targets use <id> --model <model>`.
- **`Chat: <target> / <model> is unavailable. <what is missing> Your saved chat route is kept.`**: Opens the TUI with credentials missing. Fix in `/config`, set the named env var, or run the printed `pancode auth login <provider>`.
- **``configuration cancelled; no target saved. Run `pancode configure` when you are ready.``** (exit `130`): Setup aborted before saving; rerun `pancode configure`.
- **`This home was last used by PanCode <newer>; you are running <version> (<path>).`** (exit `2` on decline or headless): Older binary on a newer home. Run the newer binary (`pancode doctor` `state metadata` lists `pancode` copies on `PATH`), confirm interactively, or set `PANCODE_ALLOW_OLDER=1` for headless `run` or ACP.
- **`pancode: a task on stdin needs a subcommand; use: pancode run -`** (exit `2`): Piped non-empty stdin into bare `pancode` without `PANCODE_INTERACTIVE=1`. Pipe into `pancode run -`, or pass the task as `pancode run "<task>"`.
- **`PanCode: terminal panes unavailable (...). Continuing in this terminal.`**: Pane host socket path exceeded 100 bytes or no writable owner-only directory was found (`$XDG_RUNTIME_DIR/pancode`, `TMPDIR`, `<state>/mux/run`, `<cache>/run`, `/run/user/<uid>/pancode`, `/tmp`). Session continues single-pane; export a shorter `XDG_RUNTIME_DIR` or `TMPDIR` as named after `to fix,`.
- **``PanCode: terminal panes unavailable (<why>). Continuing in this terminal; run `pancode panes install` to retry.``**: This home has a pane host, but not the version this build pins, and launch could not install the pinned version. Launch does not retry for 24 hours; run `pancode panes install` to retry now.

### Installer and update errors

| Message | Cause | Fix |
| --- | --- | --- |
| `[install] error: do not run this installer with sudo; it installs into your home directory. Rerun the same command without sudo, or set PANCODE_INSTALL_ALLOW_SUDO=1 to install for root on purpose.` | `install.sh` run with `SUDO_USER` set | Rerun without `sudo`, or set `PANCODE_INSTALL_ALLOW_SUDO=1` for root installs. |
| `[install] error: refusing to overwrite <launcher>, which this installer did not write; move it aside, choose another --bin-dir, or rerun with --force` / `refusing to replace <launcher>; it points to <target> (a source-checkout launcher, perhaps). Rerun with --force to replace it, or choose another --bin-dir.` | Non-installer binary or external symlink at `--bin-dir` | Move existing file, choose another `--bin-dir`, or pass `--force`. |
| `[install] error: installation locked at <root>/.install-lock by pid <pid> on <host>. ...` (exit `75`) | Concurrent installer/rollback/uninstall/update, or stale lock (`> 10` min with dead local PID is reclaimed automatically as `reclaimed stale installation lock`) | Wait for owner; remove only `.install-lock` if the owning local process died recently. Background updaters retry exit `75`. |
| `[install] error: only <N> MB free under <root>; PanCode needs about 488 MB.` | Less than `500000` KB free under install root | Free space or pass `--install-dir` on a larger filesystem. |
| `[install] error: <asset> has SHA-256 <actual>, but the release lists <expected>; nothing was installed` | Corrupt or truncated download, or a mirror serving a modified bundle | Retry, or fix the mirror named by `PANCODE_RELEASE_MIRROR`. A checksum mismatch always stops the install. |
| `[install] error: could not read <base>/channel/<channel> (<reason>); ...` / `could not read <base>/v<version>/SHA256SUMS (<reason>); check the network or proxy (https_proxy)` (`install.ps1`: `...; PanCode <version> may not exist, ...`) | No route to pancode.dev or GitHub, or a proxy that blocks them; `<reason>` is the downloader's own message | Set `https_proxy`, pass `--version <exact version>` when only pancode.dev is blocked, set `PANCODE_RELEASE_MIRROR`, or install a downloaded bundle with `--bundle`. |
| `[install] error: PanCode <version> is not published at <base> (it has no v<version>/SHA256SUMS); check the version, or leave out --version to install the latest release` | The release server or mirror answered that no such release exists (HTTP 404, or no such file in a `file://` mirror) | Check the version at the project's releases, or leave out `--version`. |
| `[install] error: PanCode <version> ships no <target> bundle. ...` | The release has no bundle for this OS, CPU and C library | Install Node.js 22.19 or newer yourself, then `npm install -g @akougkas/pancode@<version>`. |
| `[install] error: could not unpack <file> under <root> (a full disk, or not a PanCode bundle)` | Disk or quota filled while unpacking, or `--bundle` names another file | Free space or choose a larger `--install-dir`; check the file given to `--bundle`. |
| `[install] error: the bundled Node at <path> does not run: ...` | The bundle does not match the host's C library | On x64 with an old glibc set `PANCODE_TARGET=linux-x64-glibc-217`; on Alpine run `apk add libstdc++`. |
| `[install] error: neither curl nor wget was found; install one, or fetch a bundle by hand and pass --bundle` | Missing downloader | Install `curl` or `wget`, or download the bundle elsewhere and pass `--bundle`. |
| `[install] error: the <channel> channel resolved to <version>, older than the active <active>; the installation was left unchanged. To leave the pre-release for stable <version>, pass --leave-prerelease; to return to the previous install, use --rollback.` (or `To install <version>, pass --version <version>; to return to the previous install, use --rollback.`) | Channel points older than installed version | Use `pancode upgrade --channel latest` (passes `--leave-prerelease`), pass `--version <version>`, pass `--rollback`, or check the mirror named by `PANCODE_RELEASE_MIRROR`. |
| `[install] error: PanCode is installed, but local initialization needs attention; run: <launcher> upgrade --post-install. Previous binary remains available via --rollback.` | Post-install checks failed (`install.ps1` prints the equivalent with `pancode upgrade --post-install`) | Inspect output above the line, run `<launcher> upgrade --post-install` then `pancode doctor`, or `--rollback`. |
| `[install] error: candidate checks failed; previous install remains active` | New version failed startup check | Read errors above line, fix, and rerun; previous version remains active. |
| `[install] error: glibc <version> is older than 2.28, which arm64 Node.js builds need, and no older-glibc arm64 bundle exists.` / `glibc <version> is older than 2.17, the oldest any Node.js 22+ build supports` | System glibc too old for any bundle | Install conda-forge `nodejs` (`conda create -n node -c conda-forge 'nodejs>=22'`) and `npm install -g @akougkas/pancode`. |
| `pancode: upgraded <from> → <to>. What changed is in CHANGELOG.md, section <to>.` | First interactive launch after version change | Informational (printed once per version). |
| `Installation changed · /quit, then run pancode --continue` / `build replaced · /restart` | Files or dev build replaced under live session | `/quit`, then `pancode --continue` (or `/restart` after dev rebuild). |
| `v<version> available · installs after you quit[; the last attempt waited for <pid@host,...>]` / `v<version> available · <command>` / `v<version> available · pancode upgrade[ --channel=<channel>] to install` / `v<version> available · installing in the background` | Update check found newer release | Quit live sessions (pm updates), run printed command / `/upgrade` / `pancode upgrade`. Silence with `PANCODE_UPDATE_CHECK=0` or `interface.autoUpdate: false`. |
| `Updated to v<version> · restart pancode to use it; this session keeps v<running>; upgrade --rollback undoes` / `Updated to v<version> · installed by <manager> after your last session` / `background update to v<version> failed (<detail>); log: <path>; run <command>` / `v<version> available · background update failed: <detail>; run pancode upgrade` | Background or after-quit update settled or failed | Restart with `pancode --continue` (`pancode upgrade --rollback` undoes); on failure, read `<log>` and run the printed upgrade command. |
| `Other PanCode processes of this install are running; nothing was replaced` (exit `75`) | Live sessions hold package lease | Quit listed `<pid>@<host>` processes and rerun, or use `/upgrade` in a session. |
| `pancode: the update is still running after 120 s; see <log>` (exit `75`) | Concurrent package-manager update took `> 120` s | Wait for completion and inspect `<log>`. |
| `[install] error: PANCODE_INSTALL_GUI must be 1 or 0, got '<value>'` | Invalid `PANCODE_INSTALL_GUI` | Set `1`, `0`, or unset for prompt. |
| `[install] warning: the desktop app runs as a login service on Linux and macOS only; start it here with: pancode gui` | `--gui` / `PANCODE_INSTALL_GUI=1` on another system | Run `pancode gui` in your session. |
| `[install] warning: the desktop app was not set up. Retry with: pancode doctor --fix` | Missing systemd user session or active background service handover | Finish active work, ensure a systemd user session exists, run `pancode doctor --fix`. |
| `[install] error: no installer manifest at <root>/install.json; nothing to roll back` | `--rollback` on non-installer root | Pass the matching `--install-dir` or reinstall. |
| `This install is pinned to <version> since <date> (<origin>); release with pancode upgrade --channel <channel>. Upgrade and background updates leave it there.` | Pinned by `--version` or `--package` | Run the printed installer command (`--version <channel> --auto-update`) to unpin. |

## Lifecycle commands

- **`This installation needs a package-manager update; no package was replaced.`** (`upgrade`, exit `1`): Run the printed package-manager command, then `pancode upgrade --post-install`.
- **`Rollback works only for native installer installs, made by install.sh or install.ps1`** (`upgrade --rollback`, exit `2`): Use your package manager (`npm`/`pnpm`/`bun`) to downgrade.
- **`No previous version is installed, so there is nothing to roll back to`** (`upgrade --rollback`, exit `1`): Pass `--version <ver>` to the installer instead.
- **`Rollback failed; the active version is unchanged`** (`upgrade --rollback`, exit `1`): Inspect installer output; active install was preserved.
- **`installation integrity check failed`** (`upgrade`, exit `1`): Run `pancode doctor --fix`, then `pancode upgrade --post-install`.
- **`unsafe directory layout`** (`doctor`/`uninstall`/`reset`, exit `2`): Four XDG roots overlap, nest, are relative, or point at/above `$HOME`. Set four distinct non-nesting absolute paths below `$HOME` via `PANCODE_*_DIR`, then verify with `pancode paths` and `pancode doctor`.
- **`not a PanCode-only directory (...); remove PanCode's files inside it by hand`** (`reset` exit `1`, or `uninstall` `Kept, and why`): Override root cannot be proven owned by PanCode (contains foreign entries or misses `settings.yaml` / `home.json` / `.pancode-root`). Clean manually or use a dedicated directory.
- **`` `pancode reset` needs a terminal to confirm; pass --yes to skip the prompt ``** (same for `uninstall`, exit `2`): Pass `--dry-run` to preview or `--yes` to execute non-interactively.
- **`Another native session (pid <N>) is still running; close it before uninstalling`** / **`Native installation is locked; retry after the installer exits`**: Stop the listed PID or wait for `.install-lock`.
- **`Reset stopped; PanCode state was preserved.` / `Could not stop the graphical installation; PanCode state was preserved.`**: Run `pancode gui background uninstall && pancode gui launcher uninstall`, then retry.
- **`Background service belongs to another installation; PanCode state was left unchanged.`** (`reset`/`uninstall`, exit `1`): Run `reset`/`uninstall` (or `pancode gui background uninstall`) from the owning installation.
- **`PanCode background app is running but did not prove it is this installation's app, so it was left running. See pancode gui background status.`** (`gui background restart --if-idle`): Check `pancode gui background status`, then run `pancode gui background restart` once active work is finished.
- **`<N> path(s) could not be removed:`**: Fix file permissions or close processes holding handles, then rerun the printed command.

## Claude Agent SDK

- **`CLAUDE_AGENT_SDK_UNAVAILABLE`** (`The Claude SDK runtime needs @anthropic-ai/claude-agent-sdk@0.3.292. Run: pancode tools install claude-sdk.`): Install `@anthropic-ai/claude-agent-sdk@0.3.292` under `<dataDir>/components/claude-agent-sdk/0.3.292` via `pancode tools install claude-sdk` (uses paired `npm`, or `npm` on `PATH` for unmanaged Linux installs).
- **`The Claude SDK runtime needs a separate component. Install it now?`**: Choosing **Not now** disables `claude-sdk` targets until restart; choose **Install now** or run `pancode tools install claude-sdk`.
- **`No @anthropic-ai/claude-agent-sdk in prepared prefix <dir>.`**: `PANCODE_CLAUDE_SDK_DIR` lacks `node_modules/@anthropic-ai/claude-agent-sdk`. Populate that prefix or unset `PANCODE_CLAUDE_SDK_DIR` and run `pancode tools install claude-sdk`.

## Project files ignored for lack of trust

Project settings, hooks, and `safety.yaml` require SHA-256 approval of their exact file bytes; project extensions and plugins require approval of package identities in `.pancode/extensions/state.json` or `.pancode/plugins/state.json`. Unapproved surfaces are ignored (ACP surfaces them in `_meta["pancode/trust"]` on `session/new`, `session/load`, `session/resume`).

- **`[pancode:trust] <file> is untrusted; project <surface> ignored. Review with pancode config trust <surface>.`** (or **`is changed;`**): `<surface>` is `settings`, `hooks`, `safety`, `extensions`, or `plugins`. Run `pancode config trust <surface>` to inspect files and digest, approve with `pancode config trust <surface> --hash <sha256>`, then restart or reload (`/reload extensions`, `/reload hub`). `--revoke` removes approval.
- **`project <surface> changed since review; inspect it again before approving`** (exit `1`): Re-run `pancode config trust <surface>` and approve the updated digest.
- **`no readable project <surface> files to approve`** (exit `1`): File missing/unreadable or no project package installed yet.
- **`extensions list` shows `untrusted` / `hub list` shows `invalid` or `requires trust`**: In-session diagnostics report `project extensions are not trusted for this workspace and are not loaded; review with pancode config trust extensions` ([state.ts](../../src/domains/extensions/state.ts)) or `project plugins are not trusted for this workspace and are not loaded; review with pancode config trust plugins, then run /reload hub` ([state.ts](../../src/domains/plugins/state.ts)). Approve `.pancode/extensions/state.json` or `.pancode/plugins/state.json` via `pancode config trust extensions|plugins`, then reload. Packs installed by `hub import`, `interop adopt`, `share import`, `/archive import`, or skill install offers never auto-trust the workspace; hand-created `git worktree` directories never inherit trust.
- **`usage: pancode config trust ...`** (exit `2`): Supply a valid surface and, for `--hash`, the full 64-hex SHA-256 digest.
- **`credentials are not allowed in project settings; key ignored`**: Move secrets to `pancode auth` or user settings.
- **`project autonomy may only tighten the level in user settings; project value ignored`** / **`autonomy is set only in user settings or by the operator; project value ignored`** / **`trustedUnmediated is set only in user settings; project value ignored`**: Configure looser `safety.autonomy` or `trustedUnmediated` in user `settings.yaml` (or pass `--autonomy` / session toggle).

## Policy, approval, and sandbox refusals

Refused tool calls start with `Refused by PanCode policy`, `Refused by operator approval`, or `Refused by MCP server policy`, and print a `To allow it:` line ([denial.ts](../../src/domains/safety/denial.ts)). Within a turn, identical repeats of policy/MCP refusals are cached and denied without re-execution; attended operator refusals can re-prompt.

| Message / Failure | Cause | Remediation |
| --- | --- | --- |
| `PanCode's safety judge blocked this <tool> call (rule <rule>): <reason>` | At `default` autonomy, safety judge saw no user authorization (reviews only operator messages + call). After `3` consecutive or `20` total blocks, the next call escalates to the operator; approving resets review. | Explicitly ask for the action in your prompt, or configure `safety.judge.environment` / `safety.judge.allow` in user settings ([Choosing an autonomy level](commands-and-modes.md#telling-the-safety-judge-about-your-environment)). |
| Remedy reads `nothing within this run; it is the yolo floor, which holds at every autonomy level.` | Yolo floor hit (e.g., wiping `/`, `$HOME`, system trees, `mkfs`/`wipefs`, block-device writes, fork bombs, writing PanCode config, state or trust files, reading credential store). | Run manually outside PanCode if genuinely required. |
| `<tool> blocked: no workspace snapshot` | Snapshot required to admit destructive action at `default` failed. | Fix the reported Git error, run manually, or set `safety.snapshots: off` (switches calls to ask). |
| `The operator did not answer this <tool> approval within <n> s, so PanCode denied it automatically; the call did not run.` | Approval card timed out on `safety.unattendedAfterSeconds` (default `300`). | Raise `safety.unattendedAfterSeconds` (`0` disables timeout). Inspect with `/decisions`. |
| `sandbox: this command could write only to <roots> ...` | Contained command wrote outside writable roots (`~/.cache`, `~/.npm` are read-only; sandbox sets `XDG_CACHE_HOME`, `npm_config_cache`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `PLAYWRIGHT_BROWSERS_PATH`). | Rerun with `unsandboxed: true` (safety-judge reviewed) or add writable path to `safety.scratchRoots` in user settings. |
| `Operation not permitted` (EPERM) opening Unix sockets (Docker, `tsx`, X11/D-Bus, Python `forkserver`) | `safety.sandboxUnixSockets: block` blocks new Unix-domain sockets (`socketpair`, pipes, TCP remain open). | Rerun with `unsandboxed: true`, set Python multiprocessing to `spawn`, or set `safety.sandboxUnixSockets: owned` or `allow` in user settings. |
| Empty `GITHUB_TOKEN`/`NPM_TOKEN` or blocked `.env`/keys in sandbox | Sandbox strips credential env vars by name/value and masks secret files (`.env.example` and unmodified tracked files stay readable). | Rerun with `unsandboxed: true` or whitelist specific vars in `safety.sandboxPassEnv` in user settings. |
| `safety.sandbox is "required" and no OS sandbox is available, so yolo does not run this command; ...` | Under `safety.sandbox: required`, outward `git push`/`gh`/`ssh`/`rsync` commands only leave containment alone on a line with literal args from workspace repo; `scp`, masked secrets, local pushes, or modified git hooks stay contained (`this one stays inside because <reason>`). | Put outward command alone on its own line (use `--body-file`), restore modified hooks/config, or set `safety.sandbox: auto`. See [Safety model](../architecture/safety-model.md#sandbox-questions-and-turns). |
| `safety.sandbox is "required", so yolo does not run this command outside the sandbox; drop unsandboxed: true, ...` | Requested `unsandboxed: true` at unconfined yolo while `safety.sandbox: required`. | Drop `unsandboxed: true` or set `safety.sandbox: auto` in user settings. |
| `<tool> needs operator approval: git hooks or executable git config changed during this session` | Git hooks or executable git config changed mid-session; safety judge never auto-approves. | Inspect changed files/config; approve interactively or revert changes. |
| `sandbox: the main-session sandbox is unavailable (<reason>); the command was not run` | Sandbox backend answered at admission but failed at spawn. | Check `shell sandbox` row in `pancode doctor`. |
| `yolo is refused: PanCode runs as root outside a container, ...` | Effective UID `0` with no detected container (`run --autonomy yolo` exits `2`). | Run as non-root user, run in a container, or set `PANCODE_SANDBOXED=1` inside custom sandboxes. |

## Cost shows "not measured" (pricing unknown)

- **Cost omitted, `not measured`, or `$<amount> +?`**: Model call has no rate (no `targets[].pricing`, not a local-native runtime, not in Pi catalog). Declare `targets[].pricing: free` or USD per million tokens; local-native runtimes report `$0.00 local`, catalog entries report `~$<amount> est`.
- **`Tracked spending` `$<amount> per session; unpriced usage is not covered`**: `safety.limits.sessionCostUsd` tracks priced spend only; unpriced calls never trip the ceiling.
- **`no session ceiling` / `Session cost limit: none` / `ceiling none`**: `safety.limits.sessionCostUsd` is `0` (disables cap enforcement while still tracking usage).
- **`budget_ceiling: session priced spend $<spent> reached the $<ceiling> ceiling; raise safety.limits.sessionCostUsd`** (`run` exits `4`): Raise `safety.limits.sessionCostUsd` or set `0` for uncapped.
- **`settings.yaml failed validation:` `safety.limits.sessionCostUsd: expected a number >= 0, got <val>` / `budget: ceiling must be >= 0`** ([budget.ts](../../src/domains/scheduling/budget.ts)): Set a non-negative number in `settings.yaml`.

## Headless runs and dispatched workers

- **`pancode run cannot confirm permission requests; rerun interactively to approve this action.`**: Headless run hit an ask with no judge verdict (judge off, escalated, or operator-only action). State required actions explicitly in the task prompt, whitelist commands in approved `.pancode/safety.yaml`, run interactively, or run unconfined yolo (`--autonomy yolo` with `safety.yoloConfinement: unconfined` and `safety.yoloUnconfinedAccepted: true` in user settings) inside a container.
- **`permission refusal limit reached: the worker ended after 3 refused commands with no approval route: ...`** (`run` exits `3`, outcome `failed/permission_required`): Whitelist needed commands in `.pancode/safety.yaml` + `pancode config trust safety`, adjust task, or run attended. See [Exit codes and output](exit-codes-and-output.md).
- **`permission required for <tool> (<class>); fleet.permissions.mode=fail ends this run`**: Switch `fleet.permissions.mode` to `judge` (default) or `deny`, or adjust permissions.
- **`pancode run: output token limit reached (stopReason=length)`** (exit `1`): Narrow task, lower reasoning effort, or raise output limit.
- **`pancode run: [PanCode] the model spent its whole output budget thinking and stopped before acting or answering, twice in this turn.`** (exit `1`): The first such stop in a turn is retried once with a reminder and thinking one step lower where the route controls thinking. Lower `--thinking` or raise `chat.maxOutputTokens`.
- **`pancode run: provider stream ended without an assistant response or terminal tool result`** (exit `1`): Probe target (`pancode targets --probe`) and retry.
- **`pancode run: the agent recorded an explicit limitation; the task is incomplete`** (exit `1`): Read reported limitation and supply missing input/permissions. A `no-runner` limitation never raises it.
- **`no model <id> on target <target>; available: ...`** and **`requested <a>, provider served <b>; the turn is refused`** (exit `1`, causes `model_unavailable` and `served_model_mismatch`). The target's live model list does not contain the requested model, or the provider answered with a different one. Pick a listed model with `/model` or `--model`. Only cloud and subscription targets are checked; local and gateway targets, and a router id ending in `/auto`, are not.
- **`pancode run: no-op: <N> tool calls were blocked without recovery and no write succeeded`** / **`no-op under --fail-on-noop`** (exit `1`): Resolve blocked call or pass `--turn-mode answer` for read-only Q&A tasks.
- **`pancode run: <N> dispatched worker(s) did not deliver: <runId> (<agent>, <outcome>): <detail>`** (exit `1`, detail clipped to 600 chars): Inspect full settled record with `pancode fleet view <runId>` or `monitor(run_id="<id>", mode="record")`.
- **`pancode run: timed out after <N>s (--timeout)`** (exit `124`): Increase `--timeout` or split the task.
- **`worker_final_output_missing`** (`terminalReason: final_output_missing_no_repair`, [outcome.ts](../../src/domains/dispatch/outcome.ts)): Two paths trigger it: (1) the worker process exited **`1`** and logged `[worker] worker loop ended without a final assistant output (last role=<role>, stopReason=<reason>)` ([worker-runtime.ts](../../src/engine/worker-runtime.ts)); (2) the worker exited `0` without a sealed, durable final output, so the host failed the run with detail `worker loop ended without a sealed final assistant output` ([extension.ts](../../src/domains/dispatch/extension.ts)). Inspect settled run with `pancode fleet view <runId>`.
- **`[worker] bulk output incomplete: <reason>`**: Worker failed writing stdout event frames (frame `> 4 MiB`, backlog `> 16 MiB`, write/drain failure) and exited nonzero. Check orchestrator for stalls; inspect settled run.
- **`[worker] bulk evidence incomplete: <reason>`**: Orchestrator detected truncated/unparsable/overflowing worker event frames or unread stdout `> 1` s after exit; forces exit `1` and marks tool telemetry `partial`.
- **`worker_turn_timeout` / `worker_output_cap_exhausted`**: Worker round exceeded `safety.limits.workerResponseSeconds` or output token cap. Deterministic (no automatic retry or breaker penalty). Narrow task, raise `safety.limits.workerResponseSeconds`, or change model.
- **`result_contract_exhausted`**: Worker exhausted repair attempts without satisfying the result contract (`terminalReason: contract_exhausted_after_repair`). Deterministic (no retry). Simplify task or pick a stronger model.
- **`result_contract_invalid`**: Worker finished, but host validator rejected result (`result contract failed: <reason>`). Classified `model-quality`, eligible for retry on another agent/model without target breaker penalty. Inspect with `pancode fleet view <runId>`.
- **`vram_capacity_fit_failure`**: Emitted when the model residency sink reports `will-not-fit` for the requested model/context allocation on the target endpoint. Choose a smaller quantization, reduce context size, or target a higher-VRAM host.
- **`loop_guard_tools_disabled_exhausted`**: Loop guard locked tools after repeated identical calls and asked for text-only synthesis, but the model kept emitting tool calls instead of text. Tighten prompt instructions or inspect tool failures.

## Settings, targets, proxies, and skills

| Error / Symptom | Cause | Fix |
| --- | --- | --- |
| `fleet.decisionProfiles` / `turnControl.interpretation` / `turnControl.orientation` / `fleet.speculativeDispatch` / `systemOne` keys this build does not read, reported as `unknown key` | `settings.yaml` still holds keys this build does not read | Run `pancode upgrade --post-install`, or delete the key; configure active engine via `systemOne.use`. |
| `systemOne.engines.<name>.target: target '<id>' is not defined in targets` / absent `consult` | Missing target definition, key, open breaker, or window overflow | Define target under `targets`, inspect `pancode systemone status` and `pancode systemone check <engine> --live`. |
| Judge screen never parks anything | Engine uses `generic` profile (no token probabilities), judge disabled, or no recent web/MCP result | Configure `jev` or a non-`generic` engine profile ([Judge screen](system-one.md#judge-screen)). |
| `safety.autonomy: expected one of default \| yolo, got "auto-edit"` (or `suggest`, `read-only`, `full-auto`) | `safety.autonomy` holds a value this build does not accept | Run `pancode doctor --fix` (rewrites enums in place, preserving comments). |
| `<arg> is a global option and must come before the subcommand: pancode <usage> <command> ...` (exit `2`) | `--api-key`, `--no-context-files`, or `-nc` placed after a subcommand (note: `--skill` and `--no-skills` work in either position on `run`) | Move `--api-key`/`--no-context-files`/`-nc` before the subcommand (`pancode --api-key <key> run ...`). |
| `<flag> applies only to the interactive session, pancode run, and pancode acp; pancode <cmd> does not honor it.` / `--allow-tools and --delegate-tools apply to the interactive session, pancode run, and pancode acp; pancode <cmd> does not honor them.` (exit `2`) | `--api-key`, `--no-context-files`/`-nc`, `--skill`, or `--no-skills` (first form), or `--allow-tools`/`--delegate-tools` (second form), passed before a subcommand other than `run`/`acp` | Omit the flag for `<cmd>`, or run interactive / `run` / `acp`. |
| `--autonomy before a subcommand applies to the interactive session only. For a headless turn use: pancode run --autonomy <level> "<task>"` (exit `2`) | `--autonomy` placed before a subcommand | Move `--autonomy <level>` *after* `run` (`pancode run --autonomy <level> "<task>"`). |
| `--autonomy before a subcommand applies to the interactive session only; pass it after it: pancode acp --autonomy <level>` (exit `2`) | `--autonomy` placed before `acp` | Move it after `acp` (`pancode acp --autonomy default`). |
| `--allow-tools and --delegate-tools before a subcommand apply to the interactive session only; pass them after it: pancode <run\|acp> --allow-tools <names>` (exit `2`) | `--allow-tools`/`--delegate-tools` placed before `run` or `acp` | Move them *after* `run` or `acp`. |
| `--demo and --no-demo apply to interactive sessions only; start pancode without a subcommand.` / `--session-file applies to the interactive session only; start pancode without a subcommand.` / `--with-panes applies only to the interactive session; ...` (exit `2`) | Interactive-only startup flag used with a subcommand | Remove subcommand to run interactively (`pancode --with-panes`), or drop the interactive-only flag. |
| `no target with id <id>` / `unknown target or runtime: <id>` | Unknown target ID in `settings.yaml` | Inspect with `pancode targets` or add via `pancode configure`. |
| `context-window-unverified`: `This model's context window is unknown, so PanCode compacts at its token budget instead.` | Target probe did not report window size; compaction uses `context.compaction.maxTokens` (default `400000`) | Probe loaded server (`pancode targets --probe`) or set `targets[].capabilities.contextWindow`. |
| `Connection error. (through proxy <url>)` / `pancode: proxy variables ignored (<error>); requests go direct` | Request routed via `HTTPS_PROXY`/`HTTP_PROXY` (only `localhost`, `127.0.0.1`, `[::1]` bypass automatically) or malformed proxy URL | Fix proxy env vars or add host/CIDR to `NO_PROXY` (`NO_PROXY=*` disables proxy). Verify active routing via `pancode doctor` `proxy` row. |
| `Sign-in cancelled` | OAuth flow dismissed in wizard | Rerun `pancode auth login <target>` or `pancode configure`. |
| `no local skill marketplace catalog or index configured` | No skill catalog/index found on disk or via env overrides | Set `PANCODE_SKILL_CATALOG_DIR` or `PANCODE_SKILL_MARKETPLACE_INDEX`, install locally (`pancode hub install <path>`), or import (`pancode hub import <github-tree-url>`). |

## Telemetry, sessions, and local model servers

- **`unsealed <path>: no bundle.json (live or never sealed)`** (`telemetry verify`, exit `1`): Process still live or crashed before sealing. Re-verify once exited; `pancode telemetry doctor` summarizes live vs sealed scopes.
- **`failed <path>: <mismatch>`** (`telemetry verify` / `telemetry doctor`, exit `1`): Post-seal modification detected; treat scope as untrusted.
- **`session was written by a newer PanCode (format version <N>, this build reads version 7): <path>. Upgrade pancode to resume this session.`**: The session was written or resumed by a newer PanCode. Upgrade, or resume the session with the newer version. ACP `session/load` returns the same text without the path as error `-32602` with `code: "session_format"`.
- **`session metadata has an unsupported format version (expected version 7, got <N>): <path>. Remove the session directory to start a new session.`**: The session predates format 3, the oldest format this build reads. Start a new session.
- **`the session recorded no working directory` / `no longer exists` / `is not a directory`** (`/resume`): Recorded path missing; pick **Continue here** or cancel.
- **`Copy unconfirmed: <reasons>; OSC 52 sent` / `Sent to terminal clipboard (OSC 52)`**: Terminal clipboard integration used OSC 52 fallback (expected over non-X11 SSH). Locally on Linux, install `wl-copy`, `xclip`, or `xsel`, or enable X11 forwarding/OSC 52 in your terminal/multiplexer.
- **LM Studio notices**:
  - `LM Studio instance '<id>' is also loaded on <peers>`: Informational; footer and ledger show which LM Link peer served the request. Check via `pancode targets --probe`.
  - `LM Studio resolved '<model>' to loaded instance '<instance>' on target '<id>'.`: Informational; reused resident instance.
  - `LM Studio target '<id>' does not advertise model '<model>'. Resident instances: <ids or none>.`: Pick a listed model or add an explicit load profile.
- **`400 model is already running`** (llama.cpp router): Another client loaded/kept slots active or router slot state is stale; inspect router slots before evicting.

## Reading a cold cache

Use `/context` to inspect cache hit telemetry, compiled-prompt reuse, and prefill timing. If PanCode knows why the prefix went cold, `/context` displays it (e.g., `prompt read again after trimmed tool output (reuse measured separately)`).

For finished runs, inspect `current.jsonl` under the session store (`pancode paths`): check `promptCache.expectedColdReasons` (`working_set_evict`, `compaction`, `dispatch`, `residency`, `thinking_change`, `tool_surface_change`, `prompt_recompiled`, `system_prompt_changed`, `background_memory`, `model_changed`, `transport_reset`, `input_changed`, `tool_choice_change`, `observation_aging`, `step_checkpoint`), `promptCache.backendVerdict`, and `promptCache.backend`. Run summaries via:

```bash
pancode doctor
pancode telemetry cache <session>
pancode usage report
```

If compiled prompts were identical yet the backend missed cache, check:
1. **Server lifetime and sleep settings**: a restart, unload, or router sleep can discard resident cache state.
2. **Idle-slot caching & slow hits**: cache hits can still show long time-to-first-token while restoring slots from host memory or queuing behind another request; llama.cpp routers can toggle idle-slot caching with `--no-cache-idle-slots` / `cache-idle-slots = false`.
3. **Hybrid/recurrent models**: recurrent-state models may reprocess from a context checkpoint when earlier history changes; check serving checkpoint settings.
4. **Concurrent traffic / residency swaps / prompt identity**: compare `pancode targets --probe` slot availability, router model residency, and `promptHash`/`toolSignature` across `context.snapshotted` records.

## A TUI that stops answering the keyboard

Interactive sessions buffer the last `256` input-ingress events and `256` committed stdout frames in memory, writing `<stateDir>/input-wedge/<ISO timestamp>-<pid>.json` on `SIGTERM` (keeps newest `5` dumps):
- `classification`: `input-not-committed` (renderer stuck), `no-input-recorded` (stdin reader stuck), `input-committed` (pipeline moving; check `msSinceLastInputIngress`, `msSinceLastCommittedFrame`, `inputIngress`, `frames`).
- Full live trace: `PANCODE_RENDER_TRACE=/path/to/trace.jsonl` (takes a file path, not `1`).

## Report a problem to the maintainers

`/report` (TUI/ACP/desktop) and `pancode report` (shell) draft bugs, features, or questions for `github.com/akougkas/pancode` (`--dry-run` previews locally without network calls):

- **Draft & mask**: `/report bug|feature|question [summary]` or `pancode report ... [--title <t>] [--body-file <f>|-] [--last|--session <id>]`. Masks local paths, external URLs, user/host/repo/branch/remote/target names, emails, IPs, and process API keys; refuses send (even `--yes`) if unmasked identifiers or hidden control characters remain.
- **Confirm & exit codes**: TUI sends only on `s` (`e` edits, `m` toggles masks); ACP/desktop require `/report send <id>` matching the exact shown text. Shell requires terminal confirm or `--yes` (`2` on usage / non-TTY without `--yes`, `0` sent/opened/previewed, `1` send error/refused bundle). Signed-in `gh` checks duplicates (`--on-duplicate comment|new|stop`; `stop` saves draft and exits `3`; a closed match with a newer release out suggests upgrading first and also exits `3`); without `gh`, opens browser URL or writes local file. `--credit` requests release-note credit. Security issues use `/report security` or `pancode report security`.
- **Manage & replies**: `pancode report status|show <id>|send <id>|forget <id>`. Reply checks (`--reply-check` / `r`) run `<= 1/day` via `gh` for open reports `< 90` days old (off in CI or `PANCODE_UPDATE_CHECK=0` / `NO_UPDATE_NOTIFIER`).
- **Diagnostic bundle** (shell only): `--bundle mechanics --consent debug|dataset` (`--last`/`--session <id>`, `--transcript [N]` default `3` max `10`, `--with-tool-output`, `--anonymize-models`). Stored mode `0600` in `<stateDir>/reports/bundles/`, auto-deleted `30` days after send (or immediately via `forget <id>`). `pancode report selftest [--session <id>]` verifies zero leaks. The leak check refuses paths, remotes, private names and install tokens, and matches the workspace path exactly; product vocabulary (shipped runtime ids such as `copilot`, settings field names, billing providers) is never taken as an identity name; dataset builds (`scripts/report-dataset.ts`) require `dataset` consent (`>= 20` traces, re-keyed, `2000-01-01` epoch).
- **Agent limits**: At most 1 session draft via `report` capability (3 unsent max, control chars stripped); agent **never** sends (`--yes` refused on agent drafts and tool shells).
- **Crashes & offers**: Crashes write `<stateDir>/reports/crashes/` (`settings.yaml` validation excluded); headless faults print `pancode: this looks like a PanCode fault; ...` to `stderr` (unless CI, `--output-format json|stream-json`, `report.offers: off`). Report offers fire `<= 1/session` and `<= 1/week`, never in first session, mid-turn, or unattended yolo (2 min idle), and lapse after 2 min (`REPORT_OFFER_TAKE_MS`) or session change (`report.offers: off` disables; [offers.ts](../../src/domains/report/offers.ts), [extension.ts](../../src/domains/report/extension.ts)).

### Share with the maintainers

Report sharing is turned off in this build. `pancode report ... --share`, `pancode report send <id> --share` and `pancode telemetry share --send` upload nothing: each prints `Report sharing is turned off in this build.` and exits `2`. A diagnostic bundle and a telemetry share archive stay on this machine.

Diagnostic bundles kept on this machine are deleted with:

```bash
pancode report forget <id>
pancode report sweep
```

- **Deletion**: `report forget <id>` deletes a report's local draft and bundle, or only the bundle of a report already sent; it never withdraws the public issue, which you edit or close on GitHub. `report sweep` deletes now every bundle sent `30` days ago or withdrawn, and names them; the same sweep runs first whenever `report` composes, sends or forgets. `dataset` consent cannot be recalled once published.

## Diagnostic Commands

| Check | Command |
| --- | --- |
| System & workspace health (add `--fix` for safe repairs) | `pancode doctor [--fix]` |
| Endpoint reachability & auth probes | `pancode targets --probe` |
| Full settled run ledger, display feed & diagnostic text | `pancode fleet view <runId>` |
| Session model calls, stop reasons & cold-cache breakdown | `pancode telemetry calls <session>`, `why-stopped <session>`, `cache <session>` |
| Verify sealed telemetry integrity | `pancode telemetry verify <scope-dir>`, `pancode telemetry doctor`, `pancode fleet verify <runId> --json` |
