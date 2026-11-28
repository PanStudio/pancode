# Artifact Placement

PanCode assigns generated harness artifacts a home according to who reads them.
The placement convention is that **the repo working tree holds files a human asked for.**
The `artifact` tool defaults to the project-local `.pancode/` directory; other
harness stores use the project-local or XDG paths listed below. This convention
does not constrain every file an admitted `write`, `bash`, or script call can create.
PanCode writes `.pancode/.gitignore` itself, so generated files stay out of Git and
what an operator authors there can be committed.

This page is the contract. [artifact-paths.ts](../../src/core/artifact-paths.ts) is the code that
implements the part of it the `artifact` tool owns, and [xdg.ts](../../src/core/xdg.ts) resolves the
four per-machine roots.

## Three audiences

| Audience | What it means | Where it goes |
| --- | --- | --- |
| Human deliverable | A file the user asked to keep, and will read and commit | Repo working tree, at the path the user named |
| Human transient | Something a human may want to read once; losing it costs nothing | Project-local `.pancode/` (normally gitignored) |
| Agent-to-agent state | Machine-read plumbing between turns, workers, and sessions | `.pancode/` for per-project state; XDG data/state/cache for per-machine state |

A class is human-facing only if a person is expected to open it. A plan an
agent wrote for its own next step is agent-to-agent state even though it is
Markdown.

## Placement by class

| Class | Location | Audience |
| --- | --- | --- |
| `artifact` tool plan / review / report | `.pancode/artifacts/PLAN.md`, `REVIEW.md`, `REPORT.md` | Human transient |
| Any artifact the user named a path for | that path, inside the workspace | Human deliverable |
| RCA write-ups for fixes | An issue comment posted only with the operator's confirmation, never a committed file (the `fix-issue` skill) | Human deliverable |
| Codemap index | `.pancode/codemap.json` | Agent-to-agent |
| Markdown wiki | `.pancode/wiki/` | Human transient |
| Codebase maps: native `context map` HTML | `.pancode/artifacts/maps/` | Human transient |
| Session exports from `/export` | `.pancode/exports/<sessionId>-<date>.html` unless a path is named | Human transient |
| Session context state | `.pancode/state.json` | Agent-to-agent |
| Handbook ledger from `context init` and `context init --verify` | `.pancode/state/handbook-ledger.json`: under `entries`, every sibling handbook unit `context init` judged, with its source file and line, citations, verdict (`verified`, `stale`, `unverifiable`, `contradicted`), reason and commit; under `verification`, `verifiedCommit` and `verifiedAt`, the last `--verify` verdicts for the effective handbook, which `pancode context` and the session hint read and a later `context init` keeps. Written atomically. | Agent-to-agent and provenance |
| Compiled handbook for a repository without `PANCODE.md` | `.pancode/state/compiled-handbook.md` and `compiled-handbook.json` (inputs fingerprint, the size and mtime of each file compiled from, source files, rule count), written by a background compile | Agent-to-agent |
| Task-memory handoffs | `.pancode/handoffs/handoff-YYYY-MM-DD[-slug].md` | Agent-to-agent |
| `PANCODE.md` proposals from `context init` | `.pancode/proposals/PANCODE-<timestamp>-<uuid>.md` with a `.json` provenance sidecar | Human transient |
| Task worktrees | `.pancode/worktrees/<runId>/` by default; `fleet.worktrees.root` can move the working tree to tmpfs or another directory, except when fleet nodes are configured | Agent-to-agent |
| Compete worktrees | `.pancode/worktrees/<group>/candidate-<n>/`, always under the project root | Agent-to-agent |
| Arena matches | The arena pack's project data, `.pancode/data/arena/<matchId>/` (`match.json`, `contender-<n>.ndjson`, `contender-<n>.diff`, `vote.json`, and `vote.json.lock` only while a vote is being written) and the append-only `.pancode/data/arena/votes.jsonl`; contender worktrees are the pack's, under `.pancode/worktrees/ext-arena/`, and are removed after the match | Human transient |
| Research worktrees | `.pancode/worktrees/research-<id>-base/` and `research-<id>-it-NNNN/`, detached checkouts removed when the iteration is graded unless `--keep` | Agent-to-agent |
| Research campaigns | `.pancode/research/<id>/`: `campaign.json` (the frozen objective, budget, gates, scope, protected paths and check specs), `journal.jsonl` (one event per step, appended and synced), `samples/` (raw base and candidate measurements) and `slate.json` (each iteration's hypothesis), read by `pancode research`; the best commit is the branch `pancode/research/<id>` | Human transient and provenance |
| Script runs | `.pancode/runs/<runId>/` | Human transient and provenance |
| Tool-result and harness scratch | XDG state `scratch/`, with tool offloads grouped by session | Agent-to-agent |
| Run evidence | XDG state `telemetry/runs/<runId>/`, the run's sealed telemetry scope | Human transient (`pancode evidence`) |
| Approved memory | XDG data `memory/records.json` | Human transient (`pancode memory`) |
| Session ledgers | XDG state `sessions/` | Agent-to-agent |
| Telemetry journals, objects and seals | XDG state `telemetry/` | Human transient (`pancode telemetry`) |
| Interview transcripts | XDG state `interviews/` | Agent-to-agent |
| Caches | XDG cache | Agent-to-agent |

`pancode paths` prints the resolved XDG directories for your machine. The
`/view` command browses a session's artifacts.

## The four roots

`pancode paths [--json]` prints `config`, `data`, `state` and `cache` and creates nothing
(`src/cli/paths.ts`). Each root resolves in this order: the root's own variable
(`PANCODE_CONFIG_DIR`, `PANCODE_DATA_DIR`, `PANCODE_STATE_DIR`,
`PANCODE_CACHE_DIR`), then `PANCODE_HOME/<role>`, then the platform default.

| Platform | config | data | state | cache |
| --- | --- | --- | --- | --- |
| Linux | `$XDG_CONFIG_HOME/pancode` (`~/.config/pancode`) | `$XDG_DATA_HOME/pancode` (`~/.local/share/pancode`) | `$XDG_STATE_HOME/pancode` (`~/.local/state/pancode`) | `$XDG_CACHE_HOME/pancode` (`~/.cache/pancode`) |
| macOS | `~/Library/Application Support/pancode/config` | `.../pancode/data` | `.../pancode/state` | `~/Library/Caches/pancode` |
| Windows | `%APPDATA%\pancode\config` | `%APPDATA%\pancode\data` | `%LOCALAPPDATA%\pancode\state` | `%LOCALAPPDATA%\pancode\cache` |

The roots must be absolute, distinct and non-nesting; every writer refuses an
unsafe layout before it creates or removes a root, and `pancode doctor` names the
problem.

### Config root: files an operator authors, and the records that vouch for them

| Path | Contents |
| --- | --- |
| `settings.yaml` | Saved settings |
| `credentials.yaml` | Credentials managed by `pancode auth`, mode `0600` |
| `profile.yaml` | Operator profile, overridden field by field by the project `.pancode/profile.yaml` |
| `agents/`, `skills/`, `prompts/`, `playbooks/`, `extensions/`, `runtimes/` | User-tier resources of each kind |
| `plugins/` | PanHub plugin pack state (`state.json`) and one directory per installed pack |
| `hub.yaml`, `skill-marketplace.json`, `skill-promotion-declines.json` | The user PanHub catalog, the user skill index that overrides the shipped one in `hub/packs/skills/`, and declined skill promotions |
| `mcp.yaml`, `mcp-trust.json` | User MCP servers and the trust records for project-declared servers |
| `hooks.yaml` | User middleware hooks, trusted as the operator's own and loaded ahead of project hooks |
| `PANCODE.md` | User handbook, loaded ahead of project handbooks in every session; `interop adopt` writes marked sections into it |
| `workspace-trust/` | Per-workspace approvals from `pancode config trust` |

### Data root: durable artifacts

| Path | Contents |
| --- | --- |
| `memory/records.json` | Reviewed long-term memory; see [evidence-and-memory.md](evidence-and-memory.md) |
| `store/projects/<key>/` | The project store behind the `store` tool, written owner-only (`0600` files, `0700` directories) and keyed by the first 16 hex of the SHA-256 of the main checkout's real path, or of `project-id:<id>` when the project's tracked settings set `store.projectId`: `tags/<tag>/` with each tag's `blobs/` and records, and `locks/`, the cross-process lock files (`<id>.lock`, linked into place) that hold one blob or tag record across a write; a lock is taken over only when its holder ran on this host and is gone, and `pancode store locks break <id>` clears any other ([lock.ts](../../packages/store/src/lock.ts)). Each project keeps `project.json`; every root keeps `root.json`, its id, from the first write there ([identity.ts](../../packages/store/src/identity.ts)); the primary root also keeps `locks/` and `placement.json`, the frozen map from each tag to the root it was created on, so a tag never moves when `store.placement` changes ([paths/index.ts](../../packages/store/src/paths/index.ts)) |
| `<root path>/projects/<key>/tags/<encoded tag>/` | A tag placed on another root configured under `store.roots`; that root holds only its tags' blobs and `tag.json`, never records or locks. See [PanStore](../guide/panstore.md#roots-and-placement). |
| `tools/<id>/<version>/<binary>` | Pinned external programs installed by `pancode tools install`, such as `yazi`. The version is part of the path, so a pin bump installs beside the old copy. |
| `tools/ext/<id>/` | Programs an installed extension pins under `runtime.binaries`, downloaded when the extension is installed or updated and checked against the manifest's sha256. Removing the extension's last copy deletes the folder ([binaries.ts](../../src/domains/extensions/services/binaries.ts)). |
| `components/<id>/<version>/` | Components `pancode tools install` provisions as packages rather than single programs. `components/browser/<version>/` holds `playwright-core` under `node_modules/` and the headless Chromium shell under `browsers/` for the browser tool. A `campaign run` entry reads the operator's components from `PANCODE_OPERATOR_COMPONENTS_DIR` and installs none of its own ([components.ts](../../src/domains/lifecycle/components.ts)). |

### State root: machine-produced state

| Path | Contents |
| --- | --- |
| `sessions/<cwdHash>/<sessionId>/` | `meta.json`, `current.jsonl`, `tree.json` and `details/<ref>.txt`, the full detail behind a compact tool result that `ledger(action="detail", ref=...)` fetches ([tool-details.ts](../../src/domains/session/tool-details.ts)), in `0700` directories with `0600` files. `<cwdHash>` is the first 16 hex characters of the SHA-256 of the resolved working directory. |
| `telemetry/` | Every telemetry journal, object, seal and bundle, plus `consent.json`, `install.json`, `prune.stamp` and `imported/`; see [telemetry.md](telemetry.md#layout) |
| `runs.json`, `fleet-runs/<runId>.json`, `assignments.json`, `batches.json`, `agent-ledgers.json` | The run ledger (written mode `0600`), fleet run records and the durable dispatch stores |
| `gate-decisions/<id>.json` | Review and compete gate decisions; undecided ones sit in `gate-decisions/pending/` |
| `dispatch-admission.json`, `checkout-writer-leases/`, `cancel-requests/`, `code-steps/`, `write-boundaries/`, `runs/` | Capacity leases, writer sets, cancel requests, code-step output logs and executed commands, write-boundary records and run recordings |
| `dispatch-verification-memo.json`, `artifacts/<runId>/verification/` | Host verification memo and its captured artifacts |
| `dispatch-verification-base/<key>.json` | Host verification's base replays of failing whole-repo checks, one per base commit and check (newest 64) |
| `settings-changes.jsonl` | One line per settings change `configure_pancode` saved after operator approval: time, session, path and the changed `path: old → new` lines; never a secret ([configure-pancode.ts](../../src/tools/configure-pancode.ts)) |
| `handbooks/<key>/` | The handbook compile of another repository a run worked in (`<hash>.json`, one per input set) and its verification `ledger.json`. `<key>` is the first 16 hex characters of the SHA-256 of that repository's real path, so nothing is written into it ([sister-repository.ts](../../src/domains/context/sister-repository.ts)) |
| `claims/<sha256(project root)>.jsonl` | The append-only claims log of one project, read by `pancode claims`. It holds eight line types: `claim` (a judged reproduce or numeric-compare verdict with its conditions), `edge`, `regression`, `dispute`, `import`, `hypothesis`, `check-start` and `hypothesis-test` ([store.ts](../../src/domains/claims/store.ts)). The project root is the realpath of the repository root, so every subdirectory shares one log. A line over 64 KiB is never written, and on read it counts as unreadable without being parsed. |
| `memory/banks/<sessionId>.json` | Same-session task-bank snapshot, consumed on resume; newest 64 retained ([task-bank-store.ts](../../src/domains/memory/task-bank-store.ts)) |
| `memory/observations/<sessionId>/` | Source-linked continuity notes of one session, one immutable JSON batch per file (at most 64 read), that compaction can offer in place of raw history ([observation-store.ts](../../src/domains/memory/observation-store.ts)) |
| `memory/history-candidates/` | Lesson candidates saved for filing that an interrupted process or a failed store write left pending; a later process replays and removes them ([lesson-feedback.ts](../../src/domains/memory/lesson-feedback.ts)) |
| `memory/recall-use-v1.json` | Per-record recall and use counts that demote memory a session keeps carrying unused ([recall-use.ts](../../src/domains/memory/recall-use.ts)) |
| `memory/delivery-unsettled-v1.json` | Per-lesson sessions that were reminded of a lesson since its last verdict; three in a row return it to the notes ([delivery-ledger.ts](../../src/domains/memory/delivery-ledger.ts)) |
| `scratch/<sessionId>/`, `scratch/<runId>/` | Offloaded tool output and harness scratch; tool offloads are `0600` files in `0700` directories. `run --verify` keeps a failing check's whole output under its run id while the base replay compares it, and removes the directory when the checks end |
| `reports/` | Reports to the maintainers: `drafts/<id>.json` with the rendered Markdown beside it, `bundles/` for kept diagnostic bundles, `crashes/` for crash records, and the `offers.json`, `reply-check.json` and `outbox.json` ledgers. Drafts are written mode `0600`. |
| `interviews/` | Interview transcripts |
| `welcome/seen/<sha256(project root)>` | Empty marker written after a project's first launchpad painted on a terminal; its absence is what shows the full wordmark on first boot ([welcome-seen.ts](../../src/core/welcome-seen.ts)) |
| `tui/` | The terminal renderer's crash dump `pi-tui-crash.log` (every rendered row, so the transcript), in a directory created mode `0700` |
| `context-observations/`, `context-seeds/` | Recallable observations and worker context seeds |
| `protected-artifact-pending/<key>/` | Write-ahead records for pending protected artifacts |
| `mux/<hash>/`, `mux/locks/<hash>` | The private pane host of one project, keyed by a hash of its canonical PanCode state root and project directory: `config/herdr/config.toml` with `pancode-workspace.json` (the managed herdr config, plus herdr's log and handoff socket, since herdr keeps its data beside its config), `state/` and the `pane-shell` shim; the lock serializes launches of that host. `mux/herdr-install-failed.json` records a failed launch-time herdr install (pinned version and time) so launches skip the download for a day or until the pin changes; a successful install removes it. PanCode rewrites the config on every launch, removes the whole root when the host stops, and never reads or writes the operator's own `~/.config/herdr`. The host socket and exit markers live in the runtime directory: on Linux `$XDG_RUNTIME_DIR/pancode/`, then `$TMPDIR/pancode-<uid>/`; on macOS `$TMPDIR/pancode/`; then `mux/run/` here and `run/` in the cache root, for a launch whose write fence makes the runtime directory read-only; else `/tmp/pancode-<uid>/`. A directory is skipped when the socket path in it would pass 100 bytes or it cannot be made owner-only and written. A clean quit's exit marker carries that session's exit summary to the launcher, which prints it after the host is gone. |
| `gui/` | Graphical application state: `workspaces.json`, `children.json` with `<name>.locks/` directories, and `background/` (`server.json`, `owner.json` and the generated `pancode-gui-<id>.service` unit) |
| `home.json`, `restart-intent.json`, `restart-continuation.json` | Install metadata, a pending relaunch and the task it continues |
| `live/`, `peer-inbox/`, `running-builds/`, `launches/` | Open-session heartbeats with each session's `<sessionId>.attach.sock` (the owner-only Unix socket `session attach` connects through, present only while the session admits clients with `/attach`; there is no TCP listener), messages between sessions, the builds running processes loaded, and the installer launcher's receipts |
| `jobs/`, `provider-checkpoints/`, `sandbox/`, `fleet-preflight.json` | Background job records, provider checkpoints, sandbox state and the last fleet preflight |
| `extensions/` | Extension runtime state: `<id>/store.json` and `<id>/files/` (the extension's own store), `<id>/sessions/<sessionId>.json` (its per-session state), `.pinned/<sha256(sessionId)>.json` (pinned context blocks) and `.dock/` (dock frames and taps). Deleting a session removes its per-session files ([runtime-state.ts](../../src/domains/extensions/runtime-state.ts), [session-state.ts](../../src/domains/extensions/session-state.ts)) |
| `extension-workspaces/`, `extension-dev-roots.json` | Extension working directories and registered dev roots |
| `hub-receipts.json` | PanHub lifecycle receipts: one per install, update, enable, disable, remove, register, import and share import, with the pack's kind, id, version, content and envelope digests, scope, source and actor; the newest 512 are kept and a file over 1 MiB is refused ([hub-receipts.ts](../../src/core/hub-receipts.ts)) |
| `hub-trust.json`, `hub-index/` | The verified PanHub remote index: `hub-trust.json` records the kept index and certificate sequences, signing key, commit, expiry, index digest and the index's revocations; `hub-index/` holds the kept `signing.json`, `index.envelope.json` and `index.yaml`, and `last-refusal.json` for the most recent refused refresh. A refused refresh never changes the kept files ([hub-trust.ts](../../src/domains/resources/hub-trust.ts)) |
| `settings-shortcuts.json`, `recent-models.json`, `harness-profile.json`, `interop.json`, `endpoint-slots.json`, `tool-choice-routes.json`, `quota-cache.json`, `quota-pool.key` | Small per-machine stores; `quota-cache.json` holds each account's last quota reading and the failed reads and rate-limit holds every process honors, scoped by a one-way fingerprint of the credential and written under `quota-cache.json.lock` ([shared-state.ts](../../src/domains/quota/shared-state.ts)); `quota-pool.key` (mode 0600) is the random per-install key that turns a provider's billing identity into a reading's pool pseudonym ([pool-reading.ts](../../src/domains/quota/pool-reading.ts)) |
| `lmstudio-ownership/`, `residency-locks/`, `git-hooks/v12/`, `git-hooks/v12-shim/`, `watch-selection`, `watch-dock-taps` | Runtime ownership markers, locks, the managed Git hooks and git shim, and the request and tap files shared with the workers dashboard |

The verification slot is not under the state root. `dispatch-verification-slot.lock`
lives in `PANCODE_VERIFICATION_SLOT_DIR` when that is an absolute path, else in
`$XDG_RUNTIME_DIR/pancode`, else in a per-user `pancode-<uid>` directory in the
OS temp dir, so one host-verification check or base replay runs at a time per machine,
across PanCode homes. The directory must be the user's own with mode `0700`; otherwise
checks run without the slot (`src/domains/dispatch/verification-slot.ts`).

The clean-exit session summary is built from an in-memory snapshot and is not
persisted. Route history is a fold over `run.settled` records in the run journals
(`src/domains/telemetry/route-history.ts`) and has no file of its own.

### Cache root: disposable derived files

| Path | Contents |
| --- | --- |
| `v8-compile-cache/` | Node compile cache |
| `provider-target-models/<key>.json` | Per-target model discovery snapshots |
| `provider-target-checks/<key>.json` | The last setup test request a target's model answered; read for 24 hours so a just-tested route starts as checked |
| `copilot-sdk/sessions/<session id>/` | The Copilot runtime's records for one `copilot-sdk` conversation, written through the SDK's `sessionFs`; removed when PanCode closes the conversation, unless a record under `copilot-sdk/conversations/` keeps it resumable |
| `copilot-sdk/conversations/<hash>.json` | One resumable Copilot conversation per PanCode session (SDK session id, system prompt hash, transcript fingerprints), so a continued session resumes it; removed when that session is deleted, and swept to the newest 32 and none idle over 7 days |
| `component-npm/` | npm's cache and logs for `pancode tools install claude-sdk`, `copilot-sdk` and `browser`, so a component install writes nothing under `~/.npm` ([components.ts](../../src/domains/lifecycle/components.ts)) |
| `mcp-catalogs/<key>.json` | Cached MCP tool catalogs |
| `yazi/profile/` | The managed file-browser profile for the files pane |
| `yazi/sessions/` | Per-pane DDS/chooser transports and owner receipts (host, PID and birth token). Removed on close; old receipts are swept only after their local owner is confirmed dead. |
| `system-one/julia-1-<revision>/tokenizer.json` | The Julia-1 tokenizer, downloaded when a `julia-1` engine is bound |
| `grammars/<package>@<version>/` | The Ruby and C# tree-sitter grammars for the code index, downloaded on first use and pinned by SHA-256. A failed download is recorded beside the cache path, and no process retries it for 10 minutes while that record exists; an unwritable cache directory lets the next process try again ([fetched-grammars.ts](../../src/domains/context/codewiki/fetched-grammars.ts)). |
| `codewiki-digests/<hash>.json` | Per-file content digests for the code index fingerprint, one file per workspace keyed by a hash of its path, reused while a file's size, times and inode are unchanged so an unchanged tree is checked without reading files ([fingerprint.ts](../../src/domains/context/fingerprint.ts)). Deleting it only makes the next check read every file. |
| `data-readers/<package>@<version>/` | The HDF5, NetCDF and Parquet readers of the `data` tool, fetched as pinned npm tarballs on first use, with the same 10-minute retry window after a failure ([assets.ts](../../packages/scidata/src/assets.ts)) |
| `store/<key>/<tag>/<blob>` | The copies `store get` hands back ([paths/index.ts](../../packages/store/src/paths/index.ts)) |
| `store/index/<key>.db` | The PanStore listing and lineage index of one project (`node:sqlite`). It is only a cache: a scope whose stat fingerprint changed is rescanned, nothing that writes or checks a grant reads it, and the store works with it deleted ([index-db](../../packages/store/src/index-db/index.ts)) |
| `sandbox-cache/` | The persistent cache of contained commands: the sandbox points `XDG_CACHE_HOME`, `npm_config_cache`, `PIP_CACHE_DIR`, `UV_CACHE_DIR` and `PLAYWRIGHT_BROWSERS_PATH` here, so a contained command does not write the operator's `~/.cache` or `~/.npm`; pruned to `safety.sandboxCacheMaxGiB`, least recently used tool directory first ([sandbox-cache.ts](../../src/core/sandbox/sandbox-cache.ts)) |
| `sandbox-cache-leases/` | One lock per process that ran a contained command (`<host>-<pid>.lock`, held until it exits), the pruner's lock and its daily stamp; the pruner removes nothing from `sandbox-cache/` while a lease is live |
| `sandbox-npmrc` | The empty npm user config contained commands read when the operator's `~/.npmrc` is masked |
| `run/` | The pane host's socket directory when neither the runtime directory, `$TMPDIR` nor the state root's `mux/run/` can hold it (see `mux/<hash>/` above) |
| `skill-frontmatter.json` | Parsed `SKILL.md` frontmatter keyed by file path, mtime and size; dropped whole when the PanCode version changes ([frontmatter-cache.ts](../../src/domains/resources/skills/frontmatter-cache.ts)) |
| `update-<fingerprint>.json` | Update-check state |
| `fleet-install-*` | Temporary directories while a fleet node installs PanCode |

## The project `.pancode/` directory

Generated content is listed in the placement table above and stays under the
working directory. A project also keeps authored files there, which the operator
writes and may commit deliberately. Inside a Git repository each authored entry
comes from the nearest `.pancode/` that has it, from the working directory up
to the repository root, and a new one is written at the root (`pancodeProjectRoot`
in `src/core/project-root.ts`). A `.pancode/` holding only generated files never
hides the root's configuration. Outside a repository only the working directory
counts. `verifiers.yaml` stays with the working directory because its commands run there:

| Path | Contents |
| --- | --- |
| `settings.yaml`, `settings.local.yaml` | Project settings layer and its local, uncommitted counterpart |
| `safety.yaml` | Project safety policy |
| `rules/` | Path-scoped project rules |
| `profile.yaml` | Project operator profile |
| `agents/`, `skills/`, `prompts/`, `playbooks/`, `extensions/`, `plugins/` | Project-tier resources; `playbooks/commands.yaml` holds the playbook command registry |
| `hub.yaml` | Project PanHub catalog |
| `hooks.yaml`, `hooks.local.yaml` | Project hooks and their local counterpart |
| `mcp.yaml` | Project MCP servers, which need an explicit trust record |
| `verifiers.yaml`, `validation.yaml` | Declared project checks and the validation contract |
| `user-tasks.json` | The operator task list |
| `model-catalog.d/` | Project model-catalog overlays |

## The `artifact` tool default

`gateway(op="call", capability="artifact", args={kind: "plan"|"review"|"report", content: ...})` without a `path` writes to
`.pancode/artifacts/` under the workspace root. Passing `path` writes exactly
there instead, working tree included. The tool accepts the caller's explicit path; it does not establish that the operator requested that path.
Normal tool admission still applies, and a path that escapes the workspace is refused.

The default is a pure function of `kind`, and has to stay that way. The action
classifier, the policy engine's write-root check, and the protected-artifacts
guard all predict where a pathless call will write, from its arguments alone,
before the tool runs. A default keyed on a session id or a timestamp would make
that prediction impossible and leave the safety layer guarding a path nobody
writes. The consequence is one file per kind: a second report overwrites the
first. Keep several by naming explicit paths.

## Task worktree placement

`fleet.worktrees.root` (default `disk`) chooses where a dispatched task's working tree lives
(`src/tools/worktree-root.ts`). `disk` is `<root>/.pancode/worktrees/<runId>`. `tmpfs`
uses `<base>/pancode-<uid>/worktrees/<sha256(root)[:16]>/<runId>` on `/dev/shm`, or on
`$XDG_RUNTIME_DIR` when that is an absolute path. `auto` uses tmpfs when it exists and has room,
and the project root otherwise. An absolute path uses `<path>/<sha256(root)[:16]>/<runId>`. Any
off-disk root needs free space for twice the tracked tree plus 256 MiB. Only the working tree moves; git
objects, the index and the branch stay with the repository on disk. A tmpfs that is missing or
too small falls back to the project root with a notice (`auto` with no tmpfs at all falls back silently), and any configured fleet node keeps
every task worktree under the project root, because a remote node reaches a worktree by the
project-root path alone.

## Script run records and retention

`run_script` creates `.pancode/runs/<runId>/` with `stdout.log`, `stderr.log`, and an atomically written `run.json` manifest (version 1). The id is a UTC timestamp plus six random hexadecimal characters. Source: [run-records.ts](../../src/core/run-records.ts) and [run-script.ts](../../src/tools/run-script.ts).

The manifest records script path, canonical path, byte size and SHA-256, interpreter name/resolved path/arguments, exact argv, workspace-relative cwd, timeout, start/end times and duration, environment key names, outcome, effective `exitCode`, observed `leaderExit`, signal, stream byte counts, log paths, input identities, output status, `cleanup`, and `pipeDrainIncomplete`. Environment values are never recorded there. Regular-file hashes cover at most 64 MiB; omitted hashes carry `too-large`, `cancelled`, or `unreadable`. These are observed identities, not immutable snapshots. Logs stream to disk and have no total byte ceiling; bounded terminal tails are not the full log.

Failure does not erase partial logs or outputs. Outcomes include `cleanup-incomplete` and `pipe-drain-incomplete`, with effective failure even if the leader exited zero. The first means original-group teardown could not be confirmed; the second means the one-second post-exit drain bound expired. Escaped processes can remain alive and outputs can still change. See [execution and cleanup](../guide/tool-usage.md#runscript-stream-a-scientific-processing-step-to-disk).

After each run, `sweepRunRecords` keeps the newest 100 completed records by completion time. Recent manifest-less directories are treated as active; those at least 24 hours old are orphan candidates. Retention reads at most 64 KiB per manifest. Oversized or malformed regular manifests fall back to opened-file mtime for ordering. Nonregular manifests, symlinked run directories, changed identities, and inaccessible entries are explicitly skipped and counted, not followed or silently removed. The sweep reports `removed`, `kept`, `active`, and `skipped`. This bounds metadata reads, not total directory enumeration or disk usage. Preserve needed evidence outside this retention tree before it ages out.

## `.pancode/` and git

PanCode writes `.pancode/.gitignore` the first time it generates a file there, and
at session start for a `.pancode/` without one (`ensureProjectIgnore` in
`src/core/project-root.ts`). It ignores everything except `settings.yaml`, `safety.yaml`,
`hooks.yaml`, `mcp.yaml`, `verifiers.yaml`, `quality.yaml`, `validation.yaml`, `validation.yml`,
`profile.yaml`, `hub.yaml`, `rules/`, `agents/`,
`skills/`, `prompts/`, `playbooks/`, `extensions/`, `plugins/` and `model-catalog.d/`, and `*.local.yaml`
stays ignored inside those too. An allow-list means a generated path added later stays
out of Git by default. The file ignores itself, so a project with only generated files
shows nothing in `git status`. PanCode never replaces an existing copy, so an edit is kept.
The `grep` and `find` tools ignore this file for a search rooted inside `.pancode/`, because
it keeps generated files out of Git rather than out of reach.

PanCode never edits the project's own `.gitignore`. A blanket `.pancode/` rule there still
wins, because Git does not descend into an excluded parent. `context init` names such a rule; remove the line to commit authored files.

`pancode context reset` removes the accumulated context state
(`.pancode/codemap.json`, `codewiki.json`, `state.json`, `handoffs/` and `proposals/`) and
keeps `PANCODE.md`, `PANCODE.override.md`, `agents/`, `skills/` and `wiki/`.

## Finding what was hidden

Hiding transient output from the working tree must not mean losing it.

- `.pancode/artifacts/` is a plain directory; open it.
- `pancode evidence` lists and inspects run evidence from the sealed run scopes.
- `pancode telemetry` reads, verifies and shares the telemetry journals.
- `pancode memory` lists proposed and approved memory.
- `pancode paths` locates every XDG root.

Related: [evidence-and-memory.md](evidence-and-memory.md),
[telemetry.md](telemetry.md#layout), [observability.md](observability.md#view),
[artifact-versions.md](artifact-versions.md),
[CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution rules.
