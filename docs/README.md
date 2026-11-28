<p align="center">
  <img src="../assets/pancode-mark-gui.webp" alt="PanCode logo" width="96" height="96" />
</p>

# PanCode documentation

PanCode is systems software for coding agents. These pages are
its user guides and architecture references. Start with the task you have:
the guides say what to run and what you will see. The architecture pages hold
schemas, runtime flow and implementation boundaries.

```text
docs/
├── README.md        Documentation map
├── corpus.json      Maintainer documentation-policy metadata
├── guide/           Configuration and operator workflows
└── architecture/    Runtime architecture and contracts
```

The same Markdown ships in the `@panstudio/pancode` package, so PanCode answers questions
about itself from these pages without a network request (see
[Where PanCode finds these docs](#where-pancode-finds-these-docs-when-it-is-running-in-someone-elses-project)).
The website publishes the guides listed in `site/public-docs.json`. When a page
and the source disagree, the source in `src/` is authoritative.

## Start here

| Goal | Guide |
| --- | --- |
| Install PanCode and connect the first model | [Installation and Lifecycle](guide/installation-and-lifecycle.md) → [Configuration and Targets](guide/configuration-and-targets.md) |
| Install on an HPC cluster: no root, old glibc, proxies, airgapped mirrors | [HPC clusters](guide/hpc-clusters.md) |
| Learn the terminal interface, slash commands and `pancode` commands | [Commands and Modes](guide/commands-and-modes.md) |
| Understand what PanCode may read, change, or execute | [Sandbox and Safety](guide/sandbox-and-safety.md) → [Safety Model](architecture/safety-model.md) |
| Diagnose a problem by its exact message | [Troubleshooting](guide/troubleshooting.md) |
| Run the read-only install check: core install, targets, HPC toolchain, task worktrees, System One rows, and the deep checks | [Doctor](guide/doctor.md) |
| Bring a decision model in one setting: the `consult` tool, the judge screen, steering triage and their limits | [System One](guide/system-one.md) |

## Your first hour

1. **Install and connect.** Run the installer, then `pancode` in a project.
   Until a model is chosen, the first launch runs setup. It lists any key,
   sign-in or model server it found for you to choose, or asks what you have,
   then sends one short test request before saving. A model server on a local
   port is used only after you say yes. The first connection you save (a
   *target*) serves chat and workers.
   Read [First-run flow](guide/configuration-and-targets.md#first-run-flow);
   if it fails, see [Install and startup](guide/troubleshooting.md#install-and-startup).
2. **Check the install.** `pancode doctor` lists problems first and
   `doctor --fix` makes only the repairs it reports. See [Doctor](guide/doctor.md).
3. **Ask a read-only question.** Ask how the project builds and tests, with
   "do not change files". `/help` lists commands; PanCode also answers questions
   about itself from these docs. See
   [Interactive slash commands](guide/commands-and-modes.md#interactive-slash-commands).
4. **Make one small change.** Name the finish line: which test must pass,
   which number must match. Approval cards appear for commands PanCode cannot
   sandbox or recognize; see
   [Sandbox and safety](guide/sandbox-and-safety.md).
   `/view` shows the evidence it kept.
5. **Write the finish line down.** `.pancode/quality.yaml` names the checks
   each changed path needs. See [Project quality policies](guide/quality-policy.md).
6. **Use a second model.** Add another target with `/config` → **Guided setup**, switch chat with
   `/model`, or send workers elsewhere: see
   [Configure a different model for workers](guide/configuration-and-targets.md#configure-a-different-model-for-workers).
7. **Add your field's tools.** `pancode hub search <topic>` finds packs
   such as `plugin:hpc`. See [Science packs](guide/panhub.md#science-packs).

Scripts and CI use headless runs, `pancode run`
([Headless run flags](guide/commands-and-modes.md#headless-run-flags)). Editors
connect over ACP with `pancode acp` ([ACP](architecture/acp.md)).
[PanCode on the desktop](guide/gui.md) (alpha) runs on your machine and opens
in your browser.

## Using PanCode day to day

| Topic | Guide |
| --- | --- |
| Connecting a model: targets, providers, auth, the settings center and inventory, live routing versus saved defaults, model profiles, and local runtime settings | [Configuration and Targets](guide/configuration-and-targets.md) |
| Settings keys with defaults, project files, local stdio MCP trust, and CLI flag and tool argument contracts | [Configuration Reference](guide/configuration-reference.md) |
| Runtime discovery, model capabilities, local overlays, and field notes | [Model Catalog](architecture/model-catalog.md) |
| Argonne ALCF Sophia and Metis targets over Globus OAuth | [ALCF Provider](architecture/alcf-provider.md) |
| Context windows, output reserves and request fit, compaction against a window threshold and a token ceiling, fold stages, small-window rules and step checkpoints, prefix caching, project handbooks, and the codemap | [Context Engine](architecture/context-engine.md) |
| Codemap, bounded orientation, current project evidence, and artifact compatibility | [Project Context](architecture/project-context.md) |
| Choose compaction and recover interrupted handoffs | [Context Continuity](guide/context-continuity.md) |
| Index code, scientific artifacts, memory, evidence, and recorded work by meaning | [Semantic Context Beta](guide/semantic-context.md) |
| Non-destructive working-set eviction, markers, recall and its room bound, and the session-format records they write | [Context Working Set](architecture/context-working-set.md) |
| Session ledgers, branches, checkpoints, resume, and recovery | [Session Lifecycle](architecture/session-lifecycle.md) |
| Proactive task memory, interventions, and handoffs | [Proactive Memory](guide/proactive-memory.md) |
| The project claims ledger: judged reproduce and numeric-compare verdicts, hypotheses and their status, and contradiction edges | [Claims Ledger](architecture/evidence-and-memory.md#claims-ledger) |
| Resource roots and precedence, prompt templates, skill loading, and share archives | [Prompts, Skills, and Share Archives](guide/extensions-and-sharing.md) |
| PanHub and `pancode hub`: browse, install, update, pin and drift for packs of every kind, scopes and workspace trust, the bundled index and the planned signed refresh, receipts, skills and their pins, and submitting a pack | [PanHub](guide/panhub.md) |
| The HPC, science-data, literature and life-science packs, the hypothesis workflow, and their stated limits | [Science Packs](guide/panhub.md#science-packs) |
| Package kinds, how plugins differ from extensions and how the two pair, and where each contract lives | [Plugins](guide/plugins.md) |
| The extension API's entry points for writing an extension, pack, tool or MCP server, and `pancode extensions init\|validate\|test` (unstable) | [Extension API (unstable)](guide/sdk.md) |
| Package manifests and component references | [Authoring Plugins](guide/authoring-plugins.md) |
| Extensions: code in its own process, capability envelope, sandbox, hooks, runtime tools, commands, workspaces, and lifecycle | [Extensions](guide/harness-extensions.md) |
| TUI layout, responsive behavior, colors, and interaction rules | [TUI Design](architecture/tui-design.md) |
| Terminal panes beside a session and the files pane: install, keys, settings, doctor, troubleshooting | [Panes and the Files Pane](guide/panes-and-files.md) |
| Focus radio in a pane, shipped as the music extension pack; its pane uses the `extension` dock slot | [Music pack](../hub/packs/extensions/music/README.md) |
| The agent's `browser` tool: pages, Playwright scripts, dev servers, screenshots, host grants and attaching to a running browser | [Browser](guide/tool-usage.md#browser-drive-a-headless-browser-session) |
| A second terminal on a running session: `/attach observe\|approve\|pair` and `pancode session attach` | [Interactive slash commands](guide/commands-and-modes.md#interactive-slash-commands) |
| The desktop app: starting it, the background app, the installer option, shell layout, approvals, and what the local server exposes | [PanCode on the desktop](guide/gui.md) (alpha) |

### Extend PanCode: which page

| I want to | Read |
| --- | --- |
| Reuse a prompt I type often, or teach the agent a procedure as a skill | [Prompts, skills, and share archives](guide/extensions-and-sharing.md) |
| Use the prompts and skills Claude Code, Codex or OpenCode already have | [Trust and compatibility roots](guide/extensions-and-sharing.md#trust-and-compatibility-roots), then [Adopt foreign resources](guide/interop.md#inbound-review-and-adopt-foreign-resources) to adopt them |
| Find and install a skill or plugin someone published | [PanHub](guide/panhub.md) |
| Package my skills, prompts and agents for others to install | [Authoring plugins](guide/authoring-plugins.md), then [Extension API](guide/sdk.md) |
| Give PanCode or another MCP host tools for my cluster and data | [Science packs](guide/panhub.md#science-packs) |
| Add code that changes PanCode: hooks, tools, commands, a workspace | [Extensions](guide/harness-extensions.md) |
| Hand a task to Claude Code, Codex or OpenCode | [Coding agent interoperability](guide/interop.md) |
| Move my prompts, skills and settings to another machine | [Share archives](guide/extensions-and-sharing.md#share-archives) |
| Tell a plugin from an extension, or find which page owns a contract | [Plugins](guide/plugins.md) |

## Safety, evidence, and reproducibility

| Topic | Guide |
| --- | --- |
| What the sandbox allows and hides, when PanCode asks, `/trust`, and what a project may change | [Sandbox and Safety](guide/sandbox-and-safety.md) |
| Autonomy levels, shell containment, the safety judge, workspace snapshots and `/rewind`, the yolo floor, project policy, and damage-control rules | [Safety Model](architecture/safety-model.md) |
| Source labels, approved destinations, worker admission, and refusal recovery | [Information Flow](guide/information-flow.md) |
| What System One sends, where it can only tighten, and what it cannot tell you | [System One](guide/system-one.md) |
| Required checks by changed path, fresh verification snapshots, and completion findings | [Project Quality Policies](guide/quality-policy.md) |
| Improve a measured metric with verified research campaigns | [Research and Arena](guide/research-and-arena.md) |
| Compare models blind with vote-based standings, shipped as the arena extension pack | [Arena pack](../hub/packs/extensions/arena/README.md) |
| The `/view` artifact viewer | [Observability](architecture/observability.md#view) |
| Run evidence assessments, findings, and reviewed memory | [Evidence and Memory](architecture/evidence-and-memory.md) |
| Telemetry events, per-scope journals, capture modes and consent, objects, seals and bundles, verify, share and import, retention, and the read model | [Telemetry](architecture/telemetry.md) |
| Where generated files live and who should read them | [Artifact Placement](architecture/artifact-placement.md) |
| Versioned artifact schemas and mismatch handling | [Artifact Versions](architecture/artifact-versions.md) |

Run journals link execution observations to tool activity and results. Project checks,
reference data, and review define the acceptance criteria for a change.

## Delegation and fleets

| Topic | Guide |
| --- | --- |
| Built-in worker agents, discovery, frontmatter, and admission | [Built-in Agents](guide/built-in-agents.md) |
| Playbooks, local and multi-node fleet execution, placement, gates, and run records | [Fleet Dispatch](guide/fleet-dispatch.md) |
| Stretch a subscription seat with a quota reserve and a best-supported or cheapest-adequate route choice | [Seat stretch](guide/seat-stretch.md) |
| PanStore: tags and blobs, `pancode store`, roots and placement, records, worker tag grants, MCP store references, and its limits | [PanStore](guide/panstore.md) |
| Capacity leases, heartbeats, locks, and node drain control | [Capacity and Scheduling](architecture/capacity-and-scheduling.md) |
| Worker process protocol, watchdogs, exit mapping, the refusal limit and denial format, failure classification and retries, and route history labels | [Worker Dispatch Mechanics](architecture/worker-dispatch-mechanics.md) |
| Worker context inheritance, fork, and splice modes | [Worker Context](architecture/worker-context.md) |
| Typed dispatch intent and compatibility boundaries | [Dispatch Typed Intent](architecture/dispatch-typed-intent.md) |
| The contracts the dispatch domain shares: plan compilation, reservation, attempt identity, admission, write attribution, run record authority, and import direction | [Dispatch Domain Boundaries](architecture/dispatch-architecture-rationale.md) |

## Automation and integration

| Topic | Guide |
| --- | --- |
| Agent Client Protocol in both directions: the stdio server, capability negotiation, extension methods, permission mediation, and outbound delegation to peers | [ACP](architecture/acp.md) |
| Which fragments each prompt tier carries, how they are selected, substitutions, and the dynamic sections | [Prompt Compilation](architecture/prompt-compilation.md) |
| Prompt-envelope reuse, the builtin tool planes and their placement, promoted extension tools and pinned context, provider tool delivery, and bounded results | [Prompt Envelope and Tools](architecture/prompt-envelope-and-tools.md) |
| Built-in tool contracts, operating boundaries, and core workflows | [Tool Usage](guide/tool-usage.md) |
| Read-only HDF5, NetCDF and Parquet inspection through the `data` tool | [Data Tool](guide/tool-usage.md#data-inspect-structured-files-through-the-gateway) |
| Implementing a runtime or inference-server adapter | [Provider Adapter Cookbook](architecture/provider-adapter-cookbook.md) |
| Delegate to installed coding agents through their supported ACP, headless CLI, or pane modes; inspect and adopt their resources | [Coding Agent Interoperability](guide/interop.md) |
| Middleware hooks, effects, budgets, and component snapshots | [Middleware and Components](architecture/middleware-and-components.md) |
| Decision-layer contract: decision points, engines, formation, the runner and capability profiles | [System One Architecture](architecture/system-one.md) |
| Process exit codes, stdout/stderr rules, JSONL, and `--help` contracts | [Exit Codes and Output](guide/exit-codes-and-output.md) |
| Environment overrides, directory controls, and debug toggles | [Environment Variables](guide/environment-variables.md) |

## Architecture and contributing

| Topic | Guide |
| --- | --- |
| Source layout, compile-time boundaries, domain loading, and runtime flow | [Architecture](architecture/architecture.md) |
| Package identity, envelope, integrity, install state, dependency rule, trust by origin, the shared inventory, and the signed hub index design | [PanHub Architecture](architecture/panhub.md) |
| The components inside PanCode (the harness, PanStore, PanHub, the extension API), their workspace packages, boundaries, licences and dependencies, and how the harness reaches them | [Components and workspace packages](architecture/components.md) |
| Pi framework boundary and PanCode-owned policy | [Pi Boundary](architecture/pi-boundary.md) |
| Clock, duration, timestamp, and ordering conventions | [Time Conventions](architecture/time-conventions.md) |
| Boot sequence, startup presentation modes, and how to benchmark boot on a machine | [TUI Boot Performance](architecture/tui-boot-performance.md) |
| Core terms mapped to source concepts | [Glossary](guide/glossary.md) |

## Developer quick start

```bash
git clone https://github.com/PanStudio/pancode.git
cd pancode
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run build
node dist/cli/index.js --help
```

For a persistent local command:

```bash
pnpm run install:local
export PATH="$HOME/.local/bin:$PATH"
hash -r
pancode --version
```

Use `pnpm run dev` for a watch build. Choose the smallest check that exercises
the change; the contributor handbook, [PANCODE-DEV.md](https://github.com/PanStudio/pancode/blob/main/PANCODE-DEV.md),
lists them. `pnpm run ci` runs the whole gate (a release build, the test tiers
and an install of the built bundle), so keep it for packaging and release work.

## Where PanCode finds these docs when it is running in someone else's project

PanCode's documentation ships with the software, not with your workspace. Everything below
resolves from the installed package root, never from the directory you launched
in. The root is `PANCODE_PACKAGE_ROOT` when that variable is set, and
otherwise the nearest directory holding a `package.json` above the running code
(`resolvePackageRoot()`, [package-root.ts](../src/core/package-root.ts)).

### What pancode_docs indexes

`pancode_docs` ([docs-engine.ts](../src/tools/context/docs-engine.ts))
walks `<package root>/docs` for every `.md` file in name order. It then adds the package root's `README.md` and
`CHANGELOG.md`, each only when it exists. In an installed package, the product
corpus is therefore this map, `docs/guide/**`, `docs/architecture/**`,
`README.md`, and `CHANGELOG.md`.

A project's `PANCODE.md` is different: PanCode loads it as workspace
handbook context, not as packaged documentation. `pancode_docs` does not add it,
and the npm package does not ship an arbitrary project's handbook.

`scripts/check-hygiene.ts` requires every other Markdown file under `docs/` to
appear in the listing. A search returns sections, one per heading, ranked by
BM25 over headings and bodies with PanCode vocabulary aliases and phrase
boosts. The index is deterministic and needs no network or embedding service.

### What docs/corpus.json records

`docs/corpus.json` is maintainer-facing policy metadata, not an executable
manifest. It declares the product-corpus roots relative to `docs/` (this map,
`architecture/`, and `guide/`) and the package-root files that also count. It
ships in the package, and the installed-package smoke test checks that it
exists, but no retrieval, build, or
website code reads it. Adding or removing a page changes runtime
retrieval through the Markdown file alone; editing `corpus.json` does not change
what `pancode_docs` returns.

### Search and read the installed documentation

`gateway(op="call", capability="pancode_docs", args={query: "…"})`
returns up to five sections by default (`limit` up to twelve). Each hit carries a
package-relative `file` such as `docs/architecture/safety-model.md`, its heading
and line range, and `read.args`: the absolute `path`, `offset`, `limit` and
`line_numbers` that read exactly that section. Pass `read.args` to `read` as
given. This is the step that matters when the workspace is someone else's
repository: reading `docs/architecture/safety-model.md` as a plain relative path
reads *that project's* `docs/`, if it has one. PanCode's own system prompt names the
installed documentation directory as `{PANCODE_DOCS_PATH}`, substituted as
`join(packageRoot, "docs")` ([compiler.ts](../src/domains/prompts/compiler.ts)).
To resolve a `file` by hand, resolve it against the **package root**, which is
that directory's parent. So when the prompt names `/pkg/docs`:

- `docs/guide/foo.md` → `/pkg/docs/guide/foo.md`
- `CHANGELOG.md` → `/pkg/CHANGELOG.md`, not `/pkg/docs/CHANGELOG.md`

Do not duplicate the `docs/` segment, and do not resolve a citation against the
workspace. Omitting `query` lists the corpus (file list, document and section
counts) instead of searching it.

### Read documentation in a browser or offline

Read the user guides at
<https://pancode.dev/docs.html>. The desktop app's Shortcuts & help dialog links
to that site and shows the installed `docs/` directory. Use an editor to read
those Markdown files offline, or ask PanCode to retrieve them with `pancode_docs`.
There is no documentation command or separate documentation server.

## Reading the bundled reference

The package ships the Markdown and `docs/corpus.json`, whatever project you
are working in. The `pancode_docs` capability indexes that Markdown offline:
retrieval needs no model call and no network request.

Edit the authoritative Markdown once to update the installed reference. The
static product website deploys independently from npm and publishes only the
guides listed in `site/public-docs.json`, so a guide in this map or in
`pancode_docs` results is not necessarily on the website. `site/sync-docs.py`
builds that snapshot, and its manifest records the source revision, file hashes
and, once a release pins it, the commit.

## Writing documentation

Use the [contributor guidance](../CONTRIBUTING.md) when updating these pages. In particular:

- Ground commands in the current source. Exercise the built binary when the
  task permits a safe, isolated check rather than copying an old example.
- Use current, canonical settings paths, and describe current behavior only:
  no retired names, upgrade notes or release history.
- Separate deterministic contracts from model-dependent observations.
- Put release chronology in the [CHANGELOG](../CHANGELOG.md), not in the
  product README or an evergreen task guide.
- Link to the detailed contract instead of duplicating a large schema in
  several places.
- Link every new page from this map. `pancode_docs` indexes any Markdown file under
  `docs/` without registration, and
  `scripts/check-hygiene.ts` checks relative links, heading anchors, cited
  source paths and the corpus listing.
