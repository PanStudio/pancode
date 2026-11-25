# Environment Variables

Environment variables change how one PanCode process behaves: where it keeps its files, how the terminal looks, which diagnostic traces it writes, which credentials it sees, and what it passes to the processes it starts. Standing policy belongs in `settings.yaml` instead (see the [configuration reference](configuration-reference.md)). This page lists every `PANCODE_*` variable PanCode reads, with its default and effect, followed by the upstream and OS variables PanCode honors. When prose and source disagree, trust the cited source file.

A repository check ([check-hygiene.ts](https://github.com/akougkas/pancode/blob/main/scripts/check-hygiene.ts)) keeps the backticked `PANCODE_*` and `NO_COLOR` names on this page in step with what `src/` (plus `scripts/build-output.ts`) reads, in both directions. Variables read only outside `src/` appear in [Variables read outside src](#variables-read-outside-src) **without backticks** for that reason.

## Layout and installation overrides

Precedence per directory role: `PANCODE_*_DIR` > `PANCODE_HOME/<role>` > XDG / Windows platform defaults ([xdg.ts](../../src/core/xdg.ts)). Use `pancode paths --json` to inspect resolved paths instead of re-implementing these rules ([paths.ts](../../src/cli/paths.ts)).

| Variable | Default | Effect and validation |
| --- | --- | --- |
| `PANCODE_HOME` | unset | Single-tree root for `config`, `data`, `state`, `cache`. Setting it to `$HOME` or an ancestor is rejected as an unsafe layout ([xdg.ts](../../src/core/xdg.ts)). |
| `PANCODE_CONFIG_DIR`, `PANCODE_DATA_DIR`, `PANCODE_STATE_DIR`, `PANCODE_CACHE_DIR` | Linux: `$XDG_*_HOME/pancode` (`~/.config`, `~/.local/share`, `~/.local/state`, `~/.cache`); macOS: `~/Library/...`; Windows: `APPDATA` / `LOCALAPPDATA` | Per-role directory overrides; beat `PANCODE_HOME`. Must be four absolute, distinct, non-nesting paths ([xdg.ts](../../src/core/xdg.ts)). |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | `~/.config`, `~/.local/share`, `~/.local/state`, `~/.cache` | Linux base dirs when `PANCODE_*_DIR` and `PANCODE_HOME` are unset ([xdg.ts](../../src/core/xdg.ts)). |
| `APPDATA`, `LOCALAPPDATA` | Windows profile defaults | Windows roaming/local base dirs when `PANCODE_*_DIR` and `PANCODE_HOME` are unset ([xdg.ts](../../src/core/xdg.ts)). |
| `PANCODE_INTEROP_HOME` | unset | User home for sibling-agent roots (`~/.claude/skills`, `~/.codex/AGENTS.md`, quota credentials). Unset reads `HOME` even when `PANCODE_HOME` is set; a path redirects it; `none` disables all foreign user roots and sibling quota adapters (even if agent-specific home vars are set). Project roots (`<cwd>/.claude/skills`, etc.) are unaffected ([xdg.ts](../../src/core/xdg.ts)). |
| `PANCODE_INSTALL_DIR` | Linux: `${XDG_DATA_HOME:-~/.local/share}/pancode-install`; macOS: `~/Library/Application Support/pancode/install`; Windows: `%LOCALAPPDATA%\pancode\install`; or `$PANCODE_HOME/install` | Native installer root checked by installers, `paths`, `doctor`, and `uninstall` ([install-method.ts](../../src/domains/lifecycle/install-method.ts)). |
| `PANCODE_BIN_DIR` | `~/.local/bin` | Launcher directory created by installers and `install-local.sh` (`~` expands); inspected by `uninstall` when no installer record applies ([install-method.ts](../../src/domains/lifecycle/install-method.ts)). |
| `PANCODE_CLAUDE_SDK_DIR` | unset | Absolute prefix containing `node_modules/@anthropic-ai/claude-agent-sdk` (never modified by PanCode). Beats `pancode tools install claude-sdk` component dir and package-local fallback ([claude-sdk-install.ts](../../src/domains/lifecycle/claude-sdk-install.ts)). |
| `PANCODE_OPERATOR_COMPONENTS_DIR` | unset | Written by `pancode campaign run` into each entry: the operator's absolute `<data>/components`. The copilot-sdk and claude-sdk lookups check it after the process's own `<data>/components`, read-only; a process with it set never offers or runs a component install, and its install hint names this directory ([components.ts](../../src/domains/lifecycle/components.ts)). |
| `PANCODE_OPERATOR_TOOLS_DIR` | unset | Written by `pancode campaign run` into each entry: the operator's absolute `<data>/tools`. A pinned tool lookup that finds no usable PATH copy checks it after the process's own `<data>/tools`, read-only ([paths.ts](../../src/domains/toolchain/paths.ts)). |
| `PANCODE_TOOLCHAIN_MIRROR` | unset | Base directory, `file:` URL, or HTTP(S) URL for `pancode tools install` downloads. Checks `<tool>/<version>/<name>` (e.g. `herdr/0.9.5/herdr-linux-x86_64`, `herdr/0.9.5/LICENSE`) before flat `<name>` to prevent asset collisions across tools (such as `LICENSE`), picking the first match for the pinned SHA-256 ([install.ts](../../src/domains/toolchain/install.ts)). |
| `PANCODE_VERIFICATION_SLOT_DIR` | `$XDG_RUNTIME_DIR/pancode`, else `<tmpdir>/pancode-<uid>` | Absolute path for the machine-wide host-verification lock (`dispatch-verification-slot.lock`, mode `0700`, 30 min wait), shared across homes so parallel checks queue instead of contending. Relative paths are ignored; bad ownership, symlinks, or group/other permissions fall back to unlocked execution with a diagnostic ([verification-slot.ts](../../src/domains/dispatch/verification-slot.ts)). |
| `PANCODE_NODE_VERSION` | managed runtime | Node.js major (`24`) or exact version installed by installers; `upgrade` pins it to the current runtime unless `--refresh-runtime` clears it ([upgrade.ts](../../src/cli/upgrade.ts), [install-method.ts](../../src/domains/lifecycle/install-method.ts)). See [Installer environment variables](installation-and-lifecycle.md#installer-environment-variables). |
| `PANCODE_AUTO_UPDATE` | recorded choice | `0` disables background updates in-session, after quit (npm/pnpm/bun/volta), and in native installer runs; `1` enables updates on an unpinned install ([native-update.ts](../../src/domains/lifecycle/native-update.ts), [update-check.ts](../../src/domains/lifecycle/update-check.ts)). |
| `PANCODE_VERSION` | channel | Exact semver (pins and disables background updates) or dist-tag (`latest`, `beta`; clears pin) for installers. Stripped before background update runs ([native-update.ts](../../src/domains/lifecycle/native-update.ts)). |
| `PANCODE_PACKAGE` | unset | Local `npm pack` tarball path for installers (marks install pinned). Stripped before background update runs ([native-update.ts](../../src/domains/lifecycle/native-update.ts)). |
| `PANCODE_PACKAGE_ROOT` | auto-detected | Package root for bundled `docs/`, agents, playbooks, model catalog, and PanHub packs; set by `pancode gui` for the desktop app server and its background service ([package-root.ts](../../src/core/package-root.ts), [docs-engine.ts](../../src/tools/context/docs-engine.ts), [gui.ts](../../src/cli/gui.ts)). |

### Relocated-home isolation for sibling CLIs

When all PanCode directories are at platform/XDG defaults and `PANCODE_INTEROP_HOME` is not `none`, sibling CLI quota adapters (`claude-code` via `CLAUDE_CONFIG_DIR`/`.credentials.json`, `codex-cli` via `CODEX_HOME`/`auth.json`, `antigravity-code` via `ANTIGRAVITY_HOME`/`antigravity-oauth-token`, and `copilot` through the signed-in Copilot runtime, which is also enabled whenever `COPILOT_HOME` is set explicitly) are enabled ([registry.ts](../../src/domains/quota/registry.ts)). When any PanCode directory differs from its default, implicit sibling adapters are disabled unless their own env var (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `ANTIGRAVITY_HOME`) is explicitly set (and `PANCODE_INTEROP_HOME` is not `none`). PanCode's own stored logins (`anthropic-max`, `openai-codex`) stay active in relocated homes.

## Runtime, safety, and UI knobs

| Variable | Default | Effect and validation |
| --- | --- | --- |
| `PANCODE_ALLOW_OLDER` | unset | `1` lets an older PanCode binary open a home stamped by a newer version without prompting (TTY) or exiting `2` (headless/ACP) ([pancode.ts](../../src/cli/pancode.ts)). |
| `PANCODE_SANDBOXED` | unset | `1` attests the process is containerized/sandboxed, allowing `--autonomy yolo` under `euid === 0` when auto-detection (`container`, `KUBERNETES_SERVICE_HOST`, `/.dockerenv`, `/run/.containerenv`, `/proc/1/cgroup`) does not fire ([yolo-host.ts](../../src/core/yolo-host.ts)). |
| `PANCODE_AUTONOMY_CEILING` | unset | Written by PanCode into tool child processes when live autonomy is below `yolo`. Causes child `pancode run`, `research`, or `arena` calls to exit `2` on `--autonomy yolo` ([tool-env-controls.ts](../../src/core/tool-env-controls.ts), [yolo-host.ts](../../src/core/yolo-host.ts)). |
| `PANCODE_YOLO_CONFINEMENT` | unset | Written by `research`, `arena`, and `contained` yolo sessions into child envs. Any non-empty value forces `contained` yolo regardless of `safety.yoloConfinement` ([autonomy.ts](../../src/domains/safety/autonomy.ts), [tool-env-controls.ts](../../src/core/tool-env-controls.ts)). |
| `PANCODE_RIGOR` | repo-derived | Overrides finish-contract rigor with `normal` or `high` over the repo-derived default ([rigor.ts](../../src/domains/safety/rigor.ts)). |
| `PANCODE_DISABLE_RETRIEVE_TOOLS` | off | `1` removes RETRIEVE-category tools from registries (does not isolate bash/hooks/providers). ([network-policy.ts](../../src/tools/network-policy.ts)). |
| `PANCODE_WEB_FETCH_ALLOW_PRIVATE_NETWORK` | off | `1` permits `web_fetch` to target private/local addresses; process env only ([network-policy.ts](../../src/tools/network-policy.ts)). |
| `PANCODE_ANTHROPIC_CACHE_RETENTION` | unset | `none`, `short`, or `long` for native `anthropic-messages` requests (`long` requests 1h cache TTL when model metadata supports it). Invalid values throw; per-call preferences override it ([provider-diagnostics.ts](../../src/engine/provider-diagnostics.ts)). |
| `PANCODE_PROVIDER_DUMP_PATH` | unset | Absolute path for opt-in native-provider JSONL diagnostics (one record per completed call; mode `0600`, operator-owned regular file, non-symlink, existing parent dir; omits auth headers and redacts known credentials, **retains prompt content**, so keep it private and delete it when finished; external-CLI transports are not captured). Write/close failures emit process warning code `PANCODE_PROVIDER_DUMP_FAILED` without failing the call ([provider-diagnostics.ts](../../src/engine/provider-diagnostics.ts)). |
| `PANCODE_LMSTUDIO_CORESIDENT_CONTEXT` | `131072` | Max context length requested when loading an LM Studio model alongside another resident model (LM Studio reports no VRAM and caps GPU offload instead of refusing, so oversized KV caches crawl on CPU). Positive int overrides; `off`, `false`, or `0` disables clamping; invalid/negative/empty keeps default ([lmstudio-residency.ts](../../src/engine/apis/lmstudio-residency.ts)). |
| `PANCODE_ENDPOINT_SLOTS_TTL_MS` | `86400000` | TTL (ms) for persisted endpoint concurrency slot counts before expiry/pruning ([endpoint-slots-store.ts](../../src/domains/providers/endpoint-slots-store.ts)). |
| `PANCODE_SKILL_CATALOG_DIR` | unset | Local skill-catalog directory override ([marketplace.ts](../../src/domains/resources/skills/marketplace.ts), [provenance-pin.ts](../../src/domains/resources/skills/provenance-pin.ts)). |
| `PANCODE_SKILL_MARKETPLACE_INDEX` | unset | Skill-marketplace index file path override ([marketplace.ts](../../src/domains/resources/skills/marketplace.ts)). |
| `PANCODE_MODEL_CATALOG_DIRS` | unset | Extra model-catalog overlay directories separated by `path.delimiter` (`:` on POSIX) ([catalog-overlays.ts](../../src/domains/providers/catalog-overlays.ts)). |
| `PANCODE_UPDATE_CHECK` | on | `0` suppresses interactive startup update monitor (runs 5s after first frame) and background/after-quit update triggers ([interactive-application.ts](../../src/interactive/interactive-application.ts), [update-check.ts](../../src/domains/lifecycle/update-check.ts)). |
| `NO_COLOR` | unset | Any non-empty value disables foreground/background ANSI colors (keeps bold/dim/italic/underline). `TERM=dumb` or `TERM=unknown` does the same ([terminal-preferences.ts](../../src/core/terminal-preferences.ts)). |
| `PANCODE_THEME` | unset | `dark`, `light`, or `neutral`; skips startup OSC 11 query. Unset uses OSC 11 then `COLORFGBG` ([terminal-background.ts](../../src/core/terminal-background.ts)). |
| `PANCODE_REDUCE_MOTION` | off | `1` forces smooth-streaming `auto` to immediate coalescing and stops terminal animation ([terminal-preferences.ts](../../src/core/terminal-preferences.ts), [stream-pacing-policy.ts](../../src/interactive/stream-pacing-policy.ts)). |
| `PANCODE_NERD_FONT` | off | `1` enables Nerd Font brain icons on thinking rail unless ASCII or screen-reader mode is active ([terminal-preferences.ts](../../src/core/terminal-preferences.ts)). |
| `PANCODE_ASCII` | off | `1` (or `TERM=dumb`/`unknown`) forces ASCII glyphs, meters, frames, identity-only welcome, and no animation ([terminal-preferences.ts](../../src/core/terminal-preferences.ts)). |
| `PANCODE_SCREEN_READER` | off | `1` selects one-row identity welcome, textual thinking effort, no animation, and immediate coalescing ([terminal-preferences.ts](../../src/core/terminal-preferences.ts), [welcome-dashboard.ts](../../src/interactive/welcome-dashboard.ts)). |
| `PANCODE_INSTANT_SHELL` | on | `0` disables the instant shell (Stage 0), which mounts the interactive terminal and editor before the rest of startup finishes ([terminal-lease.ts](../../src/interactive/terminal-lease.ts)). ACP, headless, ordinary non-TTY, and subcommand paths never mount it; `PANCODE_INTERACTIVE=1` keeps forced non-TTY TUI boot. |
| `PANCODE_PANE_LAUNCH` | unset | `shell` types the session's command at your shell's prompt in the pane, after your shell startup files have run, instead of starting it before the shell (macOS and Linux; [platform-posix.ts](../../src/domains/mux/workspace/platform-posix.ts)). Use it when the session is started from somewhere that has not run those files and needs what they export. |
| `PANCODE_FORCE_COMPACT` | off | `1` forces context compaction before every interactive turn ([chat-loop-submit.ts](../../src/session-control/chat-loop-submit.ts)). |
| `PANCODE_STATUS_STUCK_MS` | `180000` | Stuck-turn watchdog threshold in ms (must be positive number) ([watchdog.ts](../../src/interactive/status/watchdog.ts)). |
| `PANCODE_SHUTDOWN_HOOK_MS` | `500` | Wall-clock budget in ms per shutdown hook / domain stop (positive integer) ([termination.ts](../../src/core/termination.ts)). |
| `PANCODE_HOOK_BUDGET_MS` | per-phase built-in | Global middleware hook budget override (positive ms). Built-in defaults: `before_tool` 25, `after_tool` 25, `turn_start` 50, `turn_end` 75, `on_compaction` 150 ([budget.ts](../../src/domains/middleware/budget.ts)). |
| `PANCODE_HOOK_BUDGET_<PHASE>_MS` | built-in / global | Phase-specific budget (e.g. `PANCODE_HOOK_BUDGET_TURN_END_MS`), overriding `PANCODE_HOOK_BUDGET_MS` ([budget.ts](../../src/domains/middleware/budget.ts)). |
| `PANCODE_HOOK_BUDGET_WARMUP_CALLS` | `1` | Initial hook calls per key exempt from budget warnings (non-negative int) ([budget.ts](../../src/domains/middleware/budget.ts)). |
| `PANCODE_HOOK_BUDGET_WINDOW` | `5` | Rolling window size (positive int) for steady-state hook-budget warnings ([budget.ts](../../src/domains/middleware/budget.ts)). |
| `PANCODE_HOOK_BUDGET_THRESHOLD` | `3` | Overruns within window required to warn (positive int) ([budget.ts](../../src/domains/middleware/budget.ts)). |
| `PANCODE_BUILD_VERBOSE` | off | `1` prints full tsup/Vite build logs and code-map stats ([build-output.ts](https://github.com/akougkas/pancode/blob/main/scripts/build-output.ts)). |

## Debug toggles and file traces

Diagnostic toggles default off and activate on `1`:

- `PANCODE_PROFILE_COMPARE`: logs configured routes missing from or differing from `models/profiles.yaml`, once per process ([extension.ts](../../src/domains/providers/extension.ts)).
- `PANCODE_TRACE_BOOT`: stamps `[pancode:boot] +<ms> <phase>` lines to stderr ([boot-trace.ts](../../src/core/boot-trace.ts)).
- `PANCODE_TIMING`: prints startup timing summary on non-interactive bannered boot ([orchestrator.ts](../../src/entry/orchestrator.ts)).
- `PANCODE_DEBUG_SHUTDOWN`: logs shutdown hook timings/diagnostics ([termination.ts](../../src/core/termination.ts), [domain-loader.ts](../../src/core/domain-loader.ts)).
- `PANCODE_HOOK_BUDGET_DEBUG`: records and prints every hook-budget overrun after a hook's warmup calls. Without it, an occasional overrun only counts toward the rolling window, and only steady-state slowness and stalls (10 times the budget or more) are recorded ([runtime.ts](../../src/domains/middleware/runtime.ts)).
- `PANCODE_CONFIG_DEBUG`: prints full error/stack when settings hot-reload watcher fails instead of one summary line ([watcher.ts](../../src/domains/config/watcher.ts)).

File-writing trace:

The render trace takes a path, not `1`. Setting it to `1` writes a file named `1` in the working directory. Unset or empty disables it; parent directories are created automatically and truncated per session.

- `PANCODE_RENDER_TRACE`: versioned JSONL timing trace of the interactive render pipeline (no conversation text) ([render-trace.ts](../../src/interactive/render-trace.ts); see [tui-boot-performance.md](../architecture/tui-boot-performance.md#measuring-an-interactive-boot)).

```bash
PANCODE_RENDER_TRACE=/tmp/pancode-render.jsonl pancode
```

## Ambient upstream and OS variables

These follow OS or upstream conventions; `settings.yaml` does not mirror them:

| Variable / family | Read by and behavior |
| --- | --- |
| Provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, Google Vertex credentials) | Mapped per selected provider ([env-api-keys.ts](../../src/engine/env-api-keys.ts)). Managed auth (`pancode auth`) is preferred where supported. |
| `OLLAMA_API_KEY` | Sent directly as `Bearer` token to `https://ollama.com` when no `authorization` header is already present ([ollama-http.ts](../../src/engine/apis/ollama-http.ts)). |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` (+ lowercase) | Proxy config for model requests, probes, OAuth, and `web_fetch`. `localhost`, `127.0.0.1`, `[::1]` bypass proxy; `NO_PROXY` matches exact host/IP, domain suffixes (`example.com`, `.example.com`, `*.example.com`, optional `:port`), `*`, CIDR (`10.0.0.0/8`, `fd00::/8`), and IPv4 wildcards (`192.168.*`) without DNS resolution ([proxy-env.ts](../../src/core/proxy-env.ts)). |
| `NO_UPDATE_NOTIFIER`, `CI` | Any non-empty value suppresses the update monitor ([interactive-application.ts](../../src/interactive/interactive-application.ts), [follow-up.ts](../../src/domains/report/follow-up.ts)). |
| `npm_config_registry`, `NPM_CONFIG_REGISTRY` | Valid `http:` / `https:` registry URL used by update checks (`https://registry.npmjs.org` fallback) ([release-version.ts](../../src/domains/lifecycle/release-version.ts)). |
| `VISUAL`, `EDITOR`, `SHELL`, `ComSpec` | External editor command (`VISUAL` beats `EDITOR`), run under `SHELL` (fallback `/bin/sh`) or `ComSpec` (Windows `!command` stored API keys, fallback `cmd.exe`) ([external-editor.ts](../../src/core/external-editor.ts), [resolve-config-value.ts](../../src/core/resolve-config-value.ts)). |
| `TERM`, `COLORTERM`, `COLORFGBG`, `TERM_PROGRAM`, `WT_SESSION`, `ZELLIJ`, `SSH_CONNECTION`, `SSH_TTY`, `TMUX`, `STY` | Terminal capabilities, color depth, background detection, multiplexer mouse handling, and adaptive stream pacing ([terminal-preferences.ts](../../src/core/terminal-preferences.ts), [stream-pacing-policy.ts](../../src/interactive/stream-pacing-policy.ts), [instrumented-tui.ts](../../src/engine/instrumented-tui.ts)). |
| `PI_TUI_ESC_TIMEOUT` | Lone-ESC wait time (ms) for pi-tui; set to `50` on local (non-SSH) terminals when unset ([interactive-shell.ts](../../src/interactive/interactive-shell.ts)). |
| `COLUMNS`, `TZ` | Non-TTY wrap width fallback ([text-layout.ts](../../src/cli/text-layout.ts)) and local time formatting ([format-time.ts](../../src/interactive/format-time.ts)). |
| `VIRTUAL_ENV` | Fallback Python interpreter (`$VIRTUAL_ENV/bin/python` or `Scripts/python.exe`) for typed Python verify entries when neither uv lock nor `.venv` exists ([toolchain.ts](../../src/tools/verify/toolchain.ts)). |
| `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_SESSION`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID` | herdr pane-host detection (`HERDR_ENV=1` required for guest panes). `HERDR_SOCKET_PATH` binds explicitly; `HERDR_SESSION` selects `sessions/<name>/herdr.sock` (no fallback to default socket if dead). Bare `pancode` strips inherited `HERDR_*` before opening its private host, while `HERDR_ENV=1` starts a nested host under the alternate prefix ([detect.ts](../../src/domains/mux/detect.ts), [panes-and-files.md](panes-and-files.md)). |
| `USER`, `LOGNAME`, `USERNAME` | Fallbacks in order for local account name stamped into run records and prompts (`src/domains/dispatch/run-identity.ts`). |
| `XDG_RUNTIME_DIR` | Tmpfs candidate (after `/dev/shm`) for `fleet.worktrees.root=tmpfs\|auto`, default private pane socket dir outside macOS, and verification-slot fallback dir ([platform-posix.ts](../../src/domains/mux/workspace/platform-posix.ts), [worktree-root.ts](../../src/tools/worktree-root.ts)). |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `ANTIGRAVITY_HOME`, `COPILOT_HOME`, `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG` | Override sibling agent config/home paths (`interop.md`); `CODEX_HOME` also locates Codex `auth.json` for the quota reader ([codex-cli-provider.ts](../../src/domains/quota/codex-cli-provider.ts)). `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` resolve `{env:NAME}` keys forwarded to OpenCode peers ([opencode.ts](../../src/engine/external-cli/opencode.ts)). |
| `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` | Stripped from `copilot-sdk` child environments so auth uses signed-in `copilot` / `gh` accounts only ([client.ts](../../src/engine/copilot/client.ts)). |
| `NODE_COMPILE_CACHE`, `NODE_DISABLE_COMPILE_CACHE` | Beat PanCode's managed V8 compile cache and pass through unchanged to workers ([compile-cache.ts](../../src/core/compile-cache.ts)). |

## Internal plumbing

Managed automatically by PanCode; do not set manually unless debugging process boundaries:

- `AI_AGENT`: Set to `pancode` at CLI/worker entry and child tools/hooks ([index.ts](../../src/cli/index.ts), [bash-exec.ts](../../src/core/bash-exec.ts)).
- `CDPATH`, `BASH_ENV`: Stripped from bash tools, `run_script`, verify, and other `safe-exec` children ([tool-env-controls.ts](../../src/core/tool-env-controls.ts), [bash-exec.ts](../../src/core/bash-exec.ts)).
- `PANCODE_INTERACTIVE`: Set to `1` by bare `pancode` when both stdin and stdout are TTYs; with `PANCODE_INTERACTIVE` unset, non-TTY stdin empty/EOF, and no stdin task, bare boot prints `(non-interactive boot. pass PANCODE_INTERACTIVE=1 to launch the TUI.)` and exits `0` ([orchestrator.ts](../../src/entry/orchestrator.ts)). `1` forces interactive TUI boot on non-TTY streams, silences non-interactive stderr hints/recovery lines, and is stripped from child tool processes ([pancode.ts](../../src/cli/pancode.ts), [tool-env-controls.ts](../../src/core/tool-env-controls.ts)).
- Git commit attribution plumbing ([git-commit-attribution.ts](../../src/core/git-commit-attribution.ts)): `PANCODE_GIT_COMMITS_ENABLED`, `PANCODE_GIT_COMMIT_AUTHOR`, `PANCODE_GIT_AUTHOR_MANAGED` (guards `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`), `PANCODE_COMMIT_ASSISTED`, `PANCODE_COMMIT_AUTHORED`, `PANCODE_COMMIT_DECISIONS`, `PANCODE_GIT_CONFIG_BASE_COUNT` (tracks pre-existing `GIT_CONFIG_COUNT`), `PANCODE_GIT_DEFAULT_HOOKS_EQUIVALENT`.
- Installer/updater plumbing: `PANCODE_BACKGROUND_UPDATE`, `PANCODE_BACKGROUND_CURRENT`, `PANCODE_UPGRADE_PARENT`, `PANCODE_LAUNCHER_PID`, `PANCODE_MANAGER_UNINSTALL`, `PANCODE_PATH_REFRESH` (Windows user-env broadcast key), `PANCODE_INSTALL_GUI` (`install.sh` passes its choice to `upgrade --post-install`, which leaves an existing desktop app and its shortcut alone at `0`) ([native-update.ts](../../src/domains/lifecycle/native-update.ts), [upgrade.ts](../../src/cli/upgrade.ts), [uninstall.ts](../../src/cli/uninstall.ts), [install-method.ts](../../src/domains/lifecycle/install-method.ts)).
- Worker / mux / run transport: `PANCODE_RESTART_EXEC_PID` ([restart-intent.ts](../../src/core/restart-intent.ts)), `PANCODE_RUN_OVERRIDES` ([run-overrides.ts](../../src/core/run-overrides.ts)), `PANCODE_YAZI_PICK_TOKEN` ([session.ts](../../src/domains/mux/yazi/session.ts)), `PANCODE_PANE_RUN` (Windows, [platform-win32.ts](../../src/domains/mux/workspace/platform-win32.ts)), `PANCODE_TERMINAL_BACKGROUND` and `PANCODE_TERMINAL_SIZE` (the terminal's background as `rrggbb` and its size as `<columns>x<rows>`, handed by the launcher to the session it starts in a pane and read once, [terminal-background.ts](../../src/core/terminal-background.ts)), `PANCODE_WORKER_LABELS` and `PANCODE_WORKER_PGID` ([transport.ts](../../src/domains/dispatch/transport.ts), [entry.ts](../../src/worker/entry.ts)), `PANCODE_INJECTED_COMPILE_CACHE` ([compile-cache.ts](../../src/core/compile-cache.ts)).

## Variables read outside src

Written without backticks because `check-hygiene` scans `src/` and `scripts/build-output.ts` only:

| Name | Reader | Purpose |
| --- | --- | --- |
| PANCODE_NODE | [pancode.cjs](../../bin/pancode.cjs) | Path to Node.js 22.19+; triggers single re-exec when different from current Node. |
| PANCODE_NODE_GUARD | [pancode.cjs](../../bin/pancode.cjs) | Re-exec loop guard set by launcher; do not set manually. |
| PANCODE_CHANNEL, PANCODE_NODE_TARBALL, PANCODE_NODE_SHASUMS, PANCODE_NODE_MIRROR, PANCODE_NODE_UNOFFICIAL_MIRROR, PANCODE_NODE_KEYRING, PANCODE_NODE_BUILD, PANCODE_REQUIRE_SIGNATURE, PANCODE_MODIFY_PATH, PANCODE_INSTALL_ALLOW_SUDO | [install.sh](../../scripts/install.sh), [install.ps1](../../scripts/install.ps1) | Installer overrides; see [Installer environment variables](installation-and-lifecycle.md#installer-environment-variables). |
| PANCODE_INSTALL_GUI | [install.sh](../../scripts/install.sh) | `1` installs the desktop app, `0` skips every desktop step, the post-install handover included, and unset prompts on TTY (set for `install.sh` only; invalid values abort). |
| PANCODE_INSTALL_MANAGER | [native-install.cjs](../../scripts/native-install.cjs) | Package-manager identifier (e.g. `winget`) recorded in `install.json`. |
| PANCODE_BOOTSTRAP_FILE, PANCODE_BOOTSTRAP_EXIT, PANCODE_LAUNCHER_CP, PANCODE_LAUNCHER_EXIT | [install.cmd](../../scripts/install.cmd), [native-install.cjs](../../scripts/native-install.cjs) | Windows installer/launcher temp path, code page, and exit code plumbing. |
| PANCODE_DESKTOP_NODE | [main.ts](https://github.com/akougkas/pancode/blob/main/apps/pancode-gui/server/main.ts) | Node binary the launcher passes to the desktop app server; do not set manually. |
| PANCODE_WEB_CLI | [process-policy.ts](https://github.com/akougkas/pancode/blob/main/apps/pancode-gui/server/process-policy.ts) | Absolute PanCode CLI path the desktop app server starts as its ACP child (falls back to `dist/cli/index.js`, then `pancode` on PATH; see [gui.md](gui.md)). |
| PANCODE_REAL_SYSTEMD | [process-policy.ts](https://github.com/akougkas/pancode/blob/main/apps/pancode-gui/server/process-policy.ts) | `1` permits enabling systemd user unit pointing into a temporary directory. |
| PANCODE_RELEASE_TARBALL, PANCODE_RELEASE_CONTEXT, PANCODE_RELEASE_MODE | [release-candidate.mjs](https://github.com/akougkas/pancode/blob/main/scripts/release-candidate.mjs), [check-release.mjs](https://github.com/akougkas/pancode/blob/main/scripts/check-release.mjs), [release-publish.mjs](https://github.com/akougkas/pancode/blob/main/scripts/release-publish.mjs) | Release qualification tarball path, publish context (`publish` enforces dated changelog), and release script mode. |

Desktop app test fixtures also read PANCODE_WEB_COMMAND_LOG, PANCODE_WEB_COMMAND_SCENARIO, PANCODE_WEB_FIXTURE_LOG, PANCODE_WEB_FIXTURE_SCENARIO, PANCODE_WEB_FIXTURE_ROUTE, PANCODE_WEB_FIXTURE_PROMPT_TURNS, PANCODE_WEB_FIXTURE_REPLAY_TURNS, PANCODE_WEB_FIXTURE_LIBRARY_RELOAD, and PANCODE_TEST_OPENAI_KEY (unused in production builds).

## Test-only (`src/`)

- `PANCODE_WORKER_FAUX` (+ `_MODEL`, `_TEXT`, `_STOP_REASON`, `_ERROR_MESSAGE`): Registers faux worker model when `1` ([ai.ts](../../src/engine/ai.ts)).
- `PANCODE_REQUIRE_HOME_PREFIX`: When `1`, aborts if resolved dirs escape `PANCODE_HOME` ([init.ts](../../src/core/init.ts)).
