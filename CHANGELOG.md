# Changelog

## 0.9.1-rc.1 - 2026-11-26

PanCode 0.9.1 is the first release published by PanStudio, as `@panstudio/pancode`. It gives PanCode one identity on every surface, rebuilds pancode.dev around what the harness does, lists PanKit's servers in PanHub, and fixes what testing 0.9.0 found in installing, upgrading, authentication and the desktop app.

### Highlights

- **A new mark.** The facet mark, a stone of four facets whose channel is the for-all sign ∀, replaces the P tile on the website, in the desktop app and its icons, and on the sign-in page. In the terminal the three-cell tile carries ∀ (`[V]` in ASCII) and the welcome wordmark draws the A of PAN as the sign. The brand green moves to teal, and success takes a leaf green so it never reads as the brand. The sign-in page, session export and transcript use the same palette. On the website and in the desktop app the dark theme moves from true black to graphite and the light theme from warm paper to cream, and code and terminal surfaces follow the theme.
- **A new website.** pancode.dev opens on "The model is a choice. The harness is what you keep." and shows PanCode in three steps: install, connect a model or an agent you already use, give it work. Five numbered sections follow, one for each thing PanCode holds around an agent: routing work across models and agents, checking "done" against what ran, working inside limits you set, handing bounded tasks to a graded fleet, and keeping what long tasks need. Each shows a recorded session, and a section on cost says who may use PanCode free. Tutorials sit in eight groups that follow those five, the tutorial, pack and research listings lead with a short featured set, articles share one reading rhythm, and the research page opens with the thesis "The harness is a systems problem.", poses an open question for each subsystem and says how to run an experiment, change the system, evaluate it for a team or work with PanStudio. PanCode is presented as one platform: the PanStore, PanKit and extension API pages are gone.
- **PanKit servers in PanHub.** PanHub has a seventh kind, `server`, for the seven PanKit servers PanCode carries (`node`, `modules`, `darshan`, `spack`, `scidata`, `catalog`, `store`). Each is a core row of the bundled index, and its pack under `hub/packs/servers/` holds the server's shipped policy. `pancode hub list --kind server` shows them as `built in`, `pancode hub inspect server:<id>` lists each tool with its action class and the environment variables the server passes through, `install` and `update` answer that the server is built in and write nothing, and `enable`, `disable` and `remove` exit 1. In the terminal, `/hub servers` opens PanHub's Servers tab, and the desktop app's Hub page lists them in a Servers collection. pancode.dev/hub.html shows them in a Servers group, each with the `npx -y -p @panstudio/pancode pankit serve <id>` command that starts it for another MCP host.

### Added

- The Claude Code marketplace gains `pankit`: `claude plugin install pankit@pancode` gives Claude Code six PanKit servers (all but `store`), each started as `npx -y -p @panstudio/pancode pankit serve <id>`.

### Changed

- PanCode is published by PanStudio. The repository is github.com/PanStudio/pancode and the npm package is `@panstudio/pancode` (`npm install -g @panstudio/pancode`). The installers download from the new repository's releases, `pancode report` files issues there, PanHub's default index URL points there, and the Claude Code marketplace is added with `claude plugin marketplace add PanStudio/pancode`.
- The five community packs PanHub listed under the publisher `akougkas` (the `autotldr`, `cite-nexus`, `wtfp` and `zulipchat` plugins and the `wtfp` extension) are now published by `panstudio`, from the same source commits. A copy installed under 0.9.0 keeps its publisher, and `pancode hub list` marks it `installed from akougkas`; `pancode hub install` and `pancode hub update` refuse that pack with `hub_publisher_collision` until `pancode hub remove` deletes the old copy.
- The `panstore` command is removed; the project store's commands are `pancode store <command>`. `pancode store where` now ends with the `pankit serve store` line that serves the project's store over MCP from any directory, and `PANSTORE_PROJECT_ID` is gone: a project's `store.projectId` keys its store.
- The SDK is documented as PanCode's extension API, unstable until PanCode defines it; its `pancode/sdk/<subpath>` imports are unchanged.
- Token counts read one way everywhere in the terminal (13.0k, 142k, 5.0M), compaction lines included.
- An approval card states what a command reaches only when PanCode established it from the command's steps and typed paths, and the allow-once button names the workspace only then. An effect PanCode could not read says to read the command.
- The autonomy modes an ACP client or the desktop app lists describe themselves in plain words built from this host's sandbox and safety check.

### Fixes

- Installing: a second install leaves another installation's desktop app where it is and prints the command that moves it; a failed install removes the root it created; `install.sh` and `install.ps1` say a version is not published when the release server says so; reinstalling the same bundle reuses its version directory.
- Upgrading: after a native upgrade or a rollback, the desktop app's background service restarts on the active version instead of refusing with "belongs to another installation"; under `--no-gui` the upgrade names `pancode gui background restart --if-idle` for this installation's app; a package-manager install already on the channel's version is reported as current; pnpm 11+ global installs are recognised; hand-run commands on the beta channel name the version it resolves to, not a missing `beta` dist-tag.
- `pancode doctor` names `pancode auth login <target>` for a connection with no stored credential, keeps the trust review command on an untrusted project row, and leaves `credentials.yaml` to the first saved key.
- A project settings file that redeclares a target your user settings give a credential, an API key or a sign-in, no longer makes PanCode send a placeholder key: PanCode refuses the turn before any request and names the file, and `pancode doctor` says the same. A project `targets` list that replaces yours is reported at start and in doctor, and a 401 from a target whose runtime sends no credential points to `/model`.
- Headless runs count each call a `--max-tool-calls` cap refuses as refused, and a review's failing verdict counts as a finished run.
- `pancode hub install --dry-run` of a pack missing its requirements says the install would be refused and names `--with-requirements`.
- `write` and `edit` say "Nothing was published" once when a publish fails.
- Redaction no longer hides values named by `author` or `authority`: `?author=Austen`, `GIT_AUTHOR_NAME=Jane` and an `author` argument keep their values on an approval card, while `auth`, `authorization` and `oauth` names still mask theirs.
- The compaction card counts the same conversation messages as its notice, and a reopened session no longer shows a thinking-level line for each compaction that left the level unchanged.
- Desktop app: a steer or follow-up appears at its place in the turn; live refusals read as refused; the session approval for a sandbox escape is offered; a turn's token line leaves the coverage gap to its breakdown, and tools that share a phrase share one tally; an interview question's markdown renders on the review page; a desktop entry clash names the command that clears it; setup and queue wording, focus rings and layout fixes; the new-task page fits a 713 px window.

## 0.9.0 - 2026-11-26

PanCode 0.9.0 is the first release under the PanCode name: one npm package, `@akougkas/pancode`, that carries the harness and its family (PanHub, PanKit, PanStore and PanSDK). Panos, the orchestrator agent, works with you in the terminal, in the desktop app (alpha) or over ACP, and dispatches bounded workers whose results it checks before trusting them. Headless runs gain one versioned result, typed exit causes and per-run limits, so a script or another agent can depend on PanCode the way a person does. This release starts fresh: it reads no home, settings file or command spelling from earlier releases. See Breaking changes before you upgrade.

### Highlights

- **One package, three commands.** The installer (or `npm install -g @akougkas/pancode`) puts `pancode`, `panstore` and `pankit` on your `PATH`. PanSDK ships inside the same package as `pancode/sdk/extension`, `pack`, `testing`, `tool` and `mcp-server`.
- **PanHub.** `pancode hub`, `/hub` and `Alt+L` browse, install, pin and remove packs (plugins, extensions, skills, agents, prompts and playbooks) from the index bundled in the package, which records each pack's digest, publisher, tier and licence. Installs record their publisher, and revoked digests stop loading. Signed remote refresh of the index is planned: the verification code ships, but this build has no root key, so `hub refresh` refuses with `no-root-key` and `hub status` reads `root key: none in this build`.
- **PanKit.** Seven MCP servers for HPC and scientific work (node facts, environment modules, Spack, Darshan, scientific data, a data catalog and the project store) run as PanCode's `builtin` MCP scope, and `pankit serve <id>` offers each one to any other MCP host.
- **PanStore.** The project store keeps files as blobs in named tags outside the working tree, with provenance for each put. It gains several roots with frozen tag placement (`store.roots`, `store.placement`), a stable `store.projectId`, locks, reflink puts and the standalone `panstore` command.
- **One result for headless runs.** `pancode run --output-format json` prints one `run_end` envelope (`schemaVersion: 3`) with the answer, exit code, outcome, typed `causes[]`, timings, checks and usage. `stream-json` ends with the same envelope, and `pancode schema run-result` prints its JSON Schema.
- **Runs that state how they ended.** The `finish` tool declares `done`, `partly_done` or `not_done` with limitations. PanCode seals the claim beside its own assessment, lowers a `done` that left unvalidated changes or a failing check, and `run --exit-code` turns anything short of done into exit 1.
- **Limits and previews per run.** `--max-requests`, `--max-tool-calls`, `--max-cost-usd`, `--timeout 15m`, `--sandbox required`, `--require-priced`, `--deny-tools` and `--on-permission fail` bound one run; `--dry-run` prints the route, tools, sandbox and limits without calling a model; `--output-schema` makes the answer one host-validated JSON object.
- **Dispatch by job, graded by role.** Each job goes to the agent whose job it is (`scout`, `reviewer`, `verifier`, `debugger`, `tester`, `coder`, `documenter`), every role owes a kind of evidence, and reviewers judge an evidence packet of the builder's diff and checks.
- **Fleet runs off your checkout.** A playbook step with scope `worktree` runs in a kept task worktree, and `pancode fleet land` previews and lands the result, or with `--discard` removes it.
- **Cost that says who pays.** A `funding` block declares who pays for each target. Every call keeps the provider's charge, your extra cost, seat credits, local energy and the public API price as separate facts, and an amount nothing measured reads `not measured`, never zero.
- **MCP surfaces you approved.** A project or plugin MCP server needs a second approval of the exact tools it serves (`pancode mcp trust <id> --surface`); a changed surface blocks its calls until you approve it again.
- **More ways in.** A `browser` tool in the same sandbox as `bash`, a second terminal on a running session (`/attach observe|approve|pair`, `pancode session attach <id>`), the Antigravity CLI as an ACP delegation target, and `pancode interop adopt` for the hooks, MCP servers and instructions you set up for Claude Code or Codex.

### Breaking changes

- **One npm package.** Only `@akougkas/pancode` is published. `@pancode/kit`, `@pancode/store`, `@pancode/sdk` and `@pancode/scidata` are private workspace packages bundled into it. Extensions import `pancode/sdk/extension` and `pancode/sdk/testing`; there is no `pancode/extensions` export.
- **No compatibility readers for older homes.** PanCode 0.9.0 has no migration steps, retired-key tables or legacy readers. Configuration, data, state and cache directories written by earlier releases are not read or converted. A version 1 `settings.yaml` or credentials file fails validation, a key outside the current schema is reported as unknown, and `pancode doctor --fix` never renames or removes it. Set up again with `pancode configure`; a new home's `settings.yaml` is a short scaffold that sets no keys.
- **License.** PanCode is source-available under the PanCode License 1.0: free for individuals, small organizations, and noncommercial research and teaching; larger organizations need a commercial license. PanSDK stays Apache-2.0. Read [LICENSE](LICENSE) for the terms.
- **Release channels.** Channels are `latest` and `beta`. `--channel dev` and `pancode upgrade --skip-migrations` are gone.

Changed behaviour:

- `pancode run` reads stdin only when `-` is passed: `run -` takes the task from stdin and `run "<task>" -` appends it as a `<stdin>` block. With neither a task nor `-` it exits 2 `empty_task`. The printed answer is every reply of the final user turn, joined; stdout, `-o` and `result.text` agree.
- `playbook validate` and `playbook graph` exit 2 for an invalid playbook. `fleet verify` and `pancode tasks` print text unless `--json`.
- Command hooks receive their event as one JSON object on stdin, and exit code 2 blocks: at `before_tool` it refuses the call, at `turn_start` the turn.
- `fleet.adaptiveRouting.roles` and `agentRoles` name the roles `explorer`, `seat`, `checker`, `reviewer` and `judge` (and `builder` in `agentRoles`).
- Every dispatched worker run has a wall clock, `fleet.limits.runTimeoutMs` (default 30 minutes, queue time included). At 85% the run hands back; at the limit it seals `timed_out`.
- Reviewing earlier sessions for memory is off unless `context.memory.surfaces.history: on`; observation memory is `context.memory.surfaces.observe`.
- `pancode context index` writes `.pancode/codemap.json`, and playbooks live in `.pancode/playbooks/`.
- A turn on a cloud or subscription target is refused when the live model list lacks the requested model (`model_unavailable`) or another model answered (`served_model_mismatch`).
- An unknown or peer-incompatible agent profile refuses the dispatch instead of falling back to another target.

### Terminal

- A new look: the Pan/Code palette and wordmark, a `>P_` mark, and yolo mode painting its own composer rails. `PANCODE_ASCII=1`, `TERM=dumb` and `TERM=unknown` draw all chrome, diagram line art and the turn receipt in ASCII.
- `pancode --resume [<id|prefix>]` reopens a session (bare opens the picker) and `--continue` opens the project's latest. `pancode --target <id> --model <ref>` opens a session on another chat route without changing `settings.yaml`.
- `/view` opens on Diffs & checks. A cut transcript card says how to see the rest.
- `/help` finds commands by alias, and `/help <plugin>` lists a plugin's prompts beside its extension commands.
- Turn receipts split fresh and cached input and state cache writes. The exit summary covers the whole visit and names the parts nothing measured.
- `/context` shows the autocompact threshold and output reserve, including after `/compact`. `/usage` names the quota window that binds first.
- Approval cards take the dock width. A verify card prints the argv and the command its policy resolved, and a pure sandbox-escape card offers `Alt+P` to approve that exact escape for the session.
- A lowered completion claim reads `declared done, assessed partly done: ...` and names the tasks still open.
- The Fleet band lists live workers first, and a resumed session lists its helper runs.
- Browser screenshots draw inline on Kitty and iTerm2 graphics terminals.

### Desktop (alpha)

- `pancode gui` opens in dark by default; light and system stay under Settings, General.
- A first run can choose Explore without a model, which opens every page that needs no connection. PanHub, Machines, Usage, Connections and Models work with no workspace open.
- The background service runs as a systemd user unit, a launchd agent on macOS or a logon task on Windows.
- The slash palette lists PanCode commands, prompt templates and extension commands. A typed `/name` the open session cannot serve is never sent.
- Approval cards name what a dispatch plan starts in the terminal's words and state their deadline.
- The Usage page shows the 30-day `usage report` with its Economics section. Resumed turns keep their usage, and unmeasured figures read `not measured`.
- The Evidence page names the check that decided a compromised run.
- A copilot-sdk or claude-sdk target missing its component names it and the `pancode tools install <id>` that adds it.
- Layouts fit 390 px phone screens, and unknown addresses get a not-found page with a link home.

### ACP

- `pancode acp` follows the current ACP schema: PanCode's own data (models, thinking levels, notices, fork parents) rides under `_meta`, model selection is `_pancode/session/set_model`, and `session/new` requires `mcpServers`.
- `session/resume` and `session/load` replay a session, compaction included, and `session/resume` sends `usage_update`.
- `$/cancel_request` is honoured: a prompt ends with stop reason `cancelled`, other requests answer `-32800`. One session runs per process; a second opener gets `-32010 session_limit`.
- `usage_update` carries `cost` only for a measured personal charge. `_meta["pancode/usage"]` is compact unless the client asks for the full form with `clientCapabilities._meta["pancode/usage"] = {version: 1}`.
- `_pancode/commands/list` returns the catalog, the loaded prompt templates and the extension commands. Extension commands run in the extension runtime, not as model turns, over ACP and `pancode run`.
- Delegations to external ACP agents report their usage and model, settle typed causes (`acp_auth_required`, `acp_model_unavailable`, `acp_transport_error`, `usage_limit_reached`) and can continue in the peer's session (`run --agent <id> --continue <runId>`).

### Headless runs and the CLI

- `pancode run` JSON usage is compact by default (facts and economy displays per scope); `--full-usage` writes the full fold. `run_end` carries the main agent's tools and safety and counts dispatched workers' usage.
- A text run ends with one stderr line: `pancode run: session <id> · <outcome> · <N> requests · <in>/<out> tokens · <cost>`.
- `--output <path>` names a file the run must write (else exit 1 `missing_output`), `-o` writes the final answer, `--task-file` carries a whole task envelope, and `--fail-on-verify` fails on any red check.
- Typed exits: 3 `permission_required`; 4 `max_requests`, `max_tool_calls` or `max_cost_usd`; 2 for usage errors, `schema_unsupported` and `session_live`; 1 with a cause such as `context_overflow` or `verify_failed`.
- `pancode schema <name>` prints `run-result`, `run-events`, `task`, `help` and `fleet-result`. `help --json` prints the command manifest and `--help --all` every path, `dev` and `systemone` included.
- Unknown subcommands and flag typos suggest the closest name. An ambiguous session prefix lists the matches.
- `pancode session history|show|export|fork|compact|rm`, `run --resume` with `--fork`, and `pancode config get|set|unset` work from the shell.
- `pancode doctor` lists only rows that need attention (`--verbose` for all), exits 1 when a configured chat route cannot run (a home with no route yet exits 0 and names `pancode configure`), and warns when another `pancode` comes first on `PATH`.
- `pancode usage` with no subcommand prints the report.
- `pancode extensions services <id> --model <target>/<model>` gives an extension that declares the model service its model.

### Fleet and dispatch

- `fleet run <playbook> "<task>"` fills the playbook's `{{task}}`. `fleet run` takes `--output-format`, `--cwd`, `--timeout`, `--max-cost-usd` and `--detach`, with `fleet wait`, `fleet cancel`, `fleet list` and `fleet admission status|drain|open`. A drained gate refuses `fleet run` before it creates anything.
- Builtin playbooks `build-review` and `seat-stretch`; `pancode playbook new <name> --from <builtin>` copies one.
- `pancode fleet land --discard` previews removing a kept run's branch, worktree and claim, and `--discard --yes` removes them. A failed review loop prints each failed check inline.
- A reviewer that finds issues settles `done` with `review found N issues` and records one finding per failed check. A check name such as `test coverage` reports what the reviewer read and claims no run.
- A worker whose own report or final tree shows a failing check reads `failed validation: <checks>`. A run whose evidence is missing is retried once on another model.
- `compete` runs host checks on every candidate before judging. A plan wider than a concurrency limit runs in waves.
- `fleet status` shows running code steps and cached tokens; batch headers count cancelled runs apart from failed ones.
- SSH dispatch carries store grants (project id, roots, tag paths) that the node verifies before it runs.

### Safety

- New settings: `safety.liveCheckTargets`, `safety.sandboxCacheMaxGiB` (default 4), `safety.limits.bashIdleSeconds` (default off) and `safety.validationWrappers`.
- MCP tool calls are judged on their declared path arguments like file access, and a path may name a PanStore blob as `store:<tag>:<blob>`. `pancode mcp trust <builtin id> --network` lets one shipped PanKit server reach the network in workers.
- Deleting the workspace's `.git` is a hard block, and `rm-rf-root` matches only root, top-level and home deletions. Operator-only changes (trust, settings, PanCode's own state) go to the operator.
- An `ask_user` answer approves a sandbox escape only when its question names leaving the sandbox.
- Redaction covers more credentials (`DB_PASS`, `PGPASS`, `*_PASSPHRASE`, `MYSQL_PWD`, `AccountKey`, `Authorization: ApiKey`) and any value assigned to a secret-looking variable name in command output.
- Shell command classification reads hex dumps, checksums and `file` as inspection, treats print-only text and quoted heredocs as data, and does not count `$TMPDIR` redirects as changes. A project check script run by its interpreter counts as validation.
- A blocked-tool finding names each blocked tool and the rule that refused it.

### Memory and context

- `memory_note` records a note bound to evidence: a command that succeeded or a file that was read. `context.memory.surfaces.lessons` and `.delivery` set who writes lessons and how they arrive.
- `context.memory.sideShare` (default `0.15`) caps automatic memory spend. `pancode memory consolidate` merges and demotes with no model call.
- `pancode memory list` and `/memory` name lessons the checkout withholds, and `memory prune --stale` says why it keeps one.
- A stated memory keeps every labelled, bulleted or numbered item after it.
- Compaction prices context at the route's measured characters per token, keeps the session when a fold would save nothing, and enters long code reads as signatures. Small windows scale their reserve and refuse a window below the request floor.
- `/fork` carries a compaction written on the fork message.

### Usage and cost

- `/usage`, the exit summary, `telemetry cost`, `usage report` and the desktop Usage page show the economy per call: extra cost, provider charge, seat credits, energy and API equivalent. Partial sums name the calls they cover.
- Seat routes such as GitHub Copilot show measured credits as the cost. `$0.00 local` is for local-native targets only; other free amounts read `$0.00 free` or `$0.00 free (mixed)`.
- Usage windows count a project's task worktree runs under the project and add a safety judge line. `telemetry surfaces` lists what each side surface cost.
- Retried worker runs count toward the turn that dispatched them.

### PanHub, PanKit, PanStore, PanSDK

- **PanHub.** `hub list` and `hub search` print a table that fits the terminal. Core and verified packs install trusted, listed packs install as foreign, and an install refuses an id another publisher holds. `integrations.hub.index` names the base URL for the planned signed index refresh; this build never reads it. The hpc and science-data packs use the PanKit servers, and every bundled skill declares the requests it serves.
- **PanKit.** `pankit serve|list|doctor|manifest|catalog`; `pankit catalog --example` prints a valid catalog file. `pancode doctor` reports each builtin server and the paths it launches.
- **PanStore.** `panstore --root <dir>` runs the store without the harness. New: `store locks` and `store locks break`, `store put --link`, `store usage` and `store verify --record-unrecorded`.
- **PanSDK.** `defineTool`, `defineServer` and `serveStdio` build MCP servers with no runtime dependencies. Extensions that declare model or store services get `ctx.complete` and `ctx.blobs`. `pancode extensions init|validate|test` scaffold and check an extension.
- **Data.** The `data` tool and PanKit's scidata server read Zarr v2 and v3 stores and inspect ADIOS2 BP4 and BP5 directories.

### Install and upgrade

- Install with the installer (`curl -fsSL https://pancode.dev/install.sh | sh`) or `npm install -g @akougkas/pancode`. The installer downloads one bundle for your platform from the GitHub release, verifies its SHA-256 against the release's `SHA256SUMS` and unpacks it. A bundle holds PanCode, the Node.js it runs on and the dependency tree the release was tested with, so nothing is resolved from a package registry at install time.
- The installer writes a launcher for every packaged command, so `panstore` and `pankit` are on `PATH`, and uninstall removes them.
- After a package-manager update, run `pancode upgrade --post-install`, then `pancode doctor`. `pancode upgrade --rollback` switches back to the previous installed version.
- `pancode doctor --fix` drops plugin or extension install records this build does not accept.
- `pancode tools install browser` adds the browser runtime, and a `browser` verifier kind gates a page on console errors, failed requests or accessibility checks.
- The documentation and pancode.dev describe current behaviour only, with guides for PanHub, PanKit, PanStore and PanSDK and a PanHub catalog page built from the bundled index.
