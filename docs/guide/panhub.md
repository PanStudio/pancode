# PanHub

PanHub is PanCode's collection of installable packs: one index, a review process for what enters it, and the first-party packs that ship under `hub/packs/`.

The commands are `runHubCommand` in [hub.ts](../../src/cli/hub.ts). Discovery and install plans are `discoverHub` and `planHubInstall` in [hub.ts](../../src/domains/resources/hub.ts), lifecycle plans are `planHubLifecycle` in [hub-actions.ts](../../src/domains/resources/hub-actions.ts), signed remote index verification is `refreshRemoteIndex` in [hub-trust.ts](../../src/domains/resources/hub-trust.ts), and the terminal browser is `openHubOverlay` in [hub.ts](../../src/interactive/overlays/hub.ts). Pack invariants and marketplace trust are in the [PanHub architecture](../architecture/panhub.md); manifest fields are in [authoring-plugins.md](authoring-plugins.md).

## What PanHub is

A **pack** is one installable unit, and each pack has one kind: `plugin`, `extension`, `skill`, `agent`, `prompt`, `playbook` or `server`.

- The five content kinds carry a root `plugin.json`, an explicit Semantic Version and a full-tree SHA-256 pin, and share one installation state. A plugin carries several components; each other content kind exposes one public component and may include supporting files.
- An `extension` is code that runs in its own process. It carries `pancode-extension.yaml`, has its own installation state, and installs only after the operator reviews its capability envelope. A plugin and an extension are always separate packs.
- A `server` is one of the seven [PanKit](pankit.md) tool servers PanCode carries (`node`, `modules`, `darshan`, `spack`, `scidata`, `catalog`, `store`). Each is a core row with its pack under `hub/packs/servers/`; it is built in and has no installed copy.

PanHub has three parts:

- **The index.** `hub/index.yaml` ships inside the npm package and lists every first-party pack and every accepted community row, each with its digest, publisher, tier and licence. Every client in 0.9.0 installs from this bundled index. Signed remote refresh is planned: the verification code is present, but this build has no root key, so `pancode hub refresh` refuses with `no-root-key` (see [The signed remote index](#the-signed-remote-index)).
- **The review process.** A community pack enters as one row file under `hub/community/`, passes the hub review job, and is listed at a tier; [Community packs](#community-packs) and `hub/TERMS.md` describe it.
- **The first-party packs.** `hub/packs/<kind>/` holds the packs published by `pancode`, each pinned by `pnpm hub:pin`.

Every pack in the bundled index is available on a fresh installation, and none is installed automatically. Built-in tools, agents and playbooks work without any pack.

## Browse and install

### Commands

```text
pancode hub list [--kind <kind>] [--user|--project] [--json]
pancode hub search [query] [--kind <kind>] [--json]
pancode hub components [query] [--kind skill|agent|prompt|playbook] [--source core|package|user|project|compat] [--all] [--json]
pancode hub register <path> [--user|--project] [--force] [--json]
pancode hub inspect <path|kind:name|name> [--user|--project] [--json]
pancode hub install <path|kind:name|name> [--user|--project] [--force] [--with-requirements] [--dry-run] [--json]
pancode hub import <path|github-tree-url> [--user|--project] [--format claude|codex] [--dry-run] [--json] [--yes]
pancode hub update <kind:name|name>|--all [--user|--project] [--force] [--dry-run] [--json]
pancode hub enable <kind:name|name> [--user|--project] [--dry-run] [--json]
pancode hub disable <kind:name|name> [--user|--project] [--dry-run] [--json]
pancode hub remove <kind:name|name> [--user|--project] [--dry-run] [--json]
pancode hub pin <kind:name|name> [--user|--project] [--json]
pancode hub drift [kind:name|name] [--user|--project] [--json]
pancode hub reload [--json]
pancode hub skills [--all] [--json]
pancode hub inventory --json
pancode hub validate <pack-path|skill-dir|SKILL.md> [--json]
pancode hub package <skill-dir> [--force] [--dry-run] [--json]
pancode hub sync [--json]
pancode hub push [--json]
pancode hub remote confirm <url>
pancode hub refresh [--json]
pancode hub status [--json]
```

`--kind` takes the seven kinds; `components` takes the four component kinds. `--from <index.yaml>` adds an index with the highest priority. `-f` is short for `--force`. `--dry-run` is accepted by `install`, `import`, `package`, `update`, `enable`, `disable` and `remove`, and `--source` only by `components`, where it narrows the loader diagnostics as it narrows the rows. `--user` and `--project` are mutually exclusive. `install` and `register` default to user scope; other mutations select the project copy when one exists, and an explicit scope selects exactly that copy.

Exit codes: 0 for success; 1 for an operational failure, an invalid pack, a refused plan, a refused refresh, or a `drift` report that is not clean; 2 for a usage error such as an unknown subcommand or flag, both scope flags, or a bare `pancode hub`.

Each lifecycle mutation builds one reviewed plan, rechecks it inside the pack lock, refuses to break enabled dependents, and reports per-pack outcomes with disk, component-admission and host-refresh facts kept apart. `--dry-run` prints the plan and writes nothing. A CLI never refreshes a running session: after a committed change, plain output ends on stderr with `A running session picks this up after /reload hub.`, or `A running session loads this extension and its hooks after /reload.` when the change includes an extension. A failed step prints `<operation> <ref> (<scope>) failed: <message>`. With `--json`, failures print `{ok: false, error}`.

### Install a pack

```bash
pancode hub search research --kind skill
pancode hub inspect plugin:hpc --json
pancode hub install plugin:hpc --project --dry-run
pancode hub install plugin:hpc --project
```

`list` and `search` answer with install targets. `--kind` and a query also match the components a plugin provides and return the owning pack. Plain output is a table that fits the terminal: one row per pack with `kind:name`, version, the state of each installed copy (`scope:state`), `available`, or `built in` for a server PanCode carries, origin, then publisher, tier and licence, and the description on the line below. Outside PanCode's own checkout, the plain listing leaves out PanCode's authoring skills (`pancode-dev`, `pancode-test`) unless they are installed; `--all` lists them, and `--json` always carries the whole catalog.

```text
pack                            version  state      origin   publisher
extension:local-status          0.1.1    available  bundled  pancode core LicenseRef-PanCode-1.0
  A small local status command and ambient status example.
extension:wtfp                  0.9.0    available  bundled  akougkas verified MIT
  The WTF-P writing desk for PanCode; paper state, gates and the write guard run in code.
```

`inspect` reads a local pack directory, an installed copy (the project copy first) or an indexed pack staged without installing, and exits 1 when the manifest is invalid. For a built-in server, by `server:<id>` or by its directory under `hub/packs/servers/`, it shows the row, each tool with its action class, and the environment variable names the server passes through, read from the shipped PanKit policy; `--json` carries them as `tools` and `environment`. When the pack is missing, fails validation, differs from the row's pinned digest or holds a `server.json` that differs from that policy, it lists no tools, names the damage as `damaged` and exits 1. The install review names the publisher, tier and licence, and the commit a remote source is fetched at. `--force` replaces an ordinary installed pack and keeps edited files in a reported recovery directory; it never overrides a source pin, identity or version mismatch. Without `--force`, installing over an existing copy is refused with ``<ref> is already installed in <scope> scope; update it instead, or reinstall it with `pancode hub install <ref> --force` ``.

An existing local directory wins over an indexed name with the same spelling. A source that is neither fails with ``<source> is not a PanHub pack or a local pack directory; find the name with `pancode hub search` ``. Pack names share one namespace per scope, and a replacement cannot change a pack's kind. A GitHub URL that no index row names cannot be installed: use `hub import` for a reviewed import, or add a pinned row to your own index.

A built-in server has no copy to change. `install` and `update` on `server:<id>` exit 0 with `server:<id> is built into PanCode <version>; pancode mcp list shows it` and write nothing; `enable`, `disable` and `remove` exit 1 with `server:<id> is built into PanCode and has no installed copy; a user declaration with the same id in <config>/mcp.yaml overrides it`. With `--json`, install and update print the plan of no steps and empty `writes`, and a refusal carries `error`. A revoked row gets no successful answer: install and update exit 1 with its `pack_revoked` line, and on a damaged pack they exit 1 naming the damage. `update --all` plans no step for them. So a `built in` row in `list` or `search` is not an install target: `--user`, `--project` and `--force` change nothing for it, and plain `--dry-run` prints the same answer instead of a plan.

`--with-requirements` adds missing dependencies to the plan and installs them in dependency order. Each pack is atomic, so a later failure does not undo a dependency already installed.

### Install an extension

```bash
pancode hub install extension:local-status --user --dry-run
pancode hub install extension:local-status --user
```

The review reads the manifest alone, without loading any pack code, and lists what the extension may do: commands, events, hooks, runtime tools, interface slots, workspaces, the prompts it takes over, the host state it keeps, the content and files it may read and write, and whether it may run programs or use the network, followed by the envelope's SHA-256. An update leads with what the new envelope adds. The install records the envelope digest beside the content digest, and an extension whose envelope does not match the recorded digest stays inactive until the operator reinstalls and reviews it. An extension that serves a plugin shows that plugin in its detail, and the plugin shows its extension; installing one never installs the other. See [Extensions](harness-extensions.md).

### Lifecycle

```bash
pancode hub disable plugin:hpc --project
pancode hub enable plugin:hpc --project
pancode hub drift plugin:hpc --project
pancode hub pin plugin:hpc --project
pancode hub update plugin:hpc --project --dry-run
pancode hub update --all
pancode hub remove plugin:hpc --project
```

- `drift` reports each copy as matching its pin, differing from it, missing from disk, or without a verified pin; without a reference it checks every installed copy and exits 1 unless all are clean. A drifted copy lists as `damaged` and does not load. `pancode hub update <ref> --force` restores the recorded source and keeps edited files in a recovery backup; `enable` alone cannot repair drift.
- `pin` records nothing new: it prints `pinned <ref> (<scope>) at sha256 <digest>` and fails with `plugin_local_changes` when the tree was edited, because it never blesses local changes.
- `update` moves a catalog copy to its index row's version and pin, and requires its dependencies to be installed and enabled. `update --all` updates every copy its row has moved past and skips extensions, naming the command for each, because each extension update needs its own envelope review. A local install updates from its recorded source directory. Update and replacement keep a disabled copy disabled.
- `disable` and `remove` refuse when an enabled dependent would lose a requirement. Removal keeps edited content and reports the recovery path. An installed copy stays addressable after its index row disappears.

A foreign pack (from `hub import` or `interop adopt`) cannot be updated or force-replaced: remove it and review a new adoption. Its skills and prompts load only while `integrations.projectResources.trustProjectImports` is true; see [interoperability](interop.md).

### Import

`hub import <path|github-tree-url>` reviews a portable, Claude Code or Codex plugin, or a bare skill directory, from a directory or a `https://github.com/owner/repo/tree/ref/path` URL. Skills keep their text and frontmatter names, command Markdown becomes prompts, and Claude agents become read-only PanCode agents. A bare skill whose instructions use a script the import cannot copy is refused; `hub package` keeps it instead. Hooks, MCP, LSP, scripts and host settings are reported and never activated, and the source is never changed. `--format claude|codex` picks between two hidden manifests. Import defaults to user scope.

On a terminal the command asks `Import this plan? [y/N]`; `--yes` approves, and without a terminal or approval nothing is installed. The pack installs with `trust: foreign`, so `integrations.projectResources.trustProjectImports` decides whether its skills and prompts load. An import never approves workspace trust. In a session, `/hub import <path-or-url>` opens the same review.

### Register a local pack

```bash
pancode hub validate ./lab-workflow --json
pancode hub register ./lab-workflow --project --json
pancode hub install plugin:lab-workflow --project
```

`register` validates a local pack and writes its identity, version, digest and source into the selected scope's own index without installing it; replacing a registration needs `--force`. `hub package <skill-dir>` writes a `plugin.json` beside a bare skill's `SKILL.md` so an ordinary install keeps the files it bundles; `--dry-run` prints the manifest instead.

## Interactive PanHub

**Alt+L** (`pancode.hub.toggle`) or `/hub` opens the fullscreen PanHub browser, and Alt+L inside it returns to the composer draft. `/hub skills`, `/hub agents`, `/hub prompts`, `/hub playbooks`, `/hub plugins` and `/hub extensions` open it on that tab; bare `/hub` opens on Plugins. `/hub interop` opens local-agent discovery and reviewed adoption. Keybinding overrides are in [commands-and-modes.md](commands-and-modes.md).

| Key | Action |
| --- | --- |
| `/` | Focus search; Enter returns to the list, and Esc clears search before closing |
| Left / Right | Change kind tab |
| `b` | Switch Browse and Installed |
| `s` | Switch user/project action scope |
| `Enter` | Open an installed pack's members |
| `Tab` | Show or hide the detail pane when the layout is too narrow to keep it beside the list |
| `v` | Use the selected component: prepare its invocation in the composer; a playbook opens its `/fleet run` approval preview |
| `i` | Review installation; a second request can include missing requirements |
| `u` | Review update |
| `e` | Enable or disable the selected installed copy |
| `x` | Review removal |
| `n` | Open notices |
| `o` | Open local-agent discovery and reviewed adoption |
| `r` | Reread the inventory |
| `Esc` | Close or cancel |

`/hub inspect <ref>`, `/hub install <ref>`, `/hub update <ref>`, `/hub enable <ref>`, `/hub disable <ref>`, `/hub remove <ref>` and `/hub import <path-or-url>` open the browser on that pack with the review of the same operation `pancode hub` would apply, with an explicit `--user` or `--project` when needed. A verb the row cannot take shows the reason as a notice. Nothing is written until the review is accepted.

The review shows dependencies, affected dependents, fallback behaviour and recovery; `Tab` reveals paths and digests, and Esc cancels and releases staged sources. The outcome reports committed, failed and unattempted steps, disk verification, resource admission and session refresh separately. A failed refresh does not undo a committed write, and `R` retries the refresh without repeating the change. Pin and drift inspection stay in the CLI.

## Scopes and installed state

Content packs install beneath `<configDir>/plugins/<name>/` at user scope or `<cwd>/.pancode/plugins/<name>/` at project scope, and each scope's `plugins/state.json` records kind, source, origin, trust, publisher, install time and verified digest. An extension installs beneath `<configDir>/extensions/<id>/` or `.pancode/extensions/<id>/`, with its own `extensions/state.json` that also records its approved envelope digest.

`hub list --json` returns `{entries, diagnostics}`. Each entry carries the index row, an `installed` array with the `enabled`, `valid`, `compatible`, `effective` and `loadable` flags of every installed scope, a `copies` array of `{scope, state}`, and the `provenance`, `format` and `provides` hints. Copy states are `loadable`, `disabled`, `shadowed`, `invalid`, `incompatible` and `damaged`; broken and disabled copies stay listed for repair or removal. When both scopes hold a valid copy, the project copy wins, and a disabled project copy still suppresses the user copy.

Disabling a pack adds it to the `disabled` list and deletes no files. Resource discovery rechecks installation state on every read ([resources.ts](../../src/domains/plugins/resources.ts)), so disabling, removal, digest drift and revocation take effect without a reload, while additions and replacements need `/reload hub`. `/reload hub` prints a `PanHub (generation <N>)` section counting packs added, removed, modified and unchanged. `hub reload` refreshes only its own process. Extensions reload with `/reload extensions` and never from `/reload hub`.

## Workspace trust for project packages

A project copy installs from the repository's own `.pancode/plugins/state.json`, so its digest check proves integrity, not consent. Project packs of every kind load only after the operator approves that file for the workspace, which is the `plugins` surface of workspace trust. User packs are unaffected.

```bash
pancode config trust plugins                  # review pack identities (read-only)
pancode config trust plugins --hash <sha256>  # approve the reviewed identities
pancode config trust plugins --revoke         # withdraw the approval
```

Until the surface is approved, every project copy is blocked: its components do not load, it satisfies no dependency, and it neither shadows nor suppresses a user copy. A blocked copy stays listed; an enabled one reads `invalid`, and `hub inspect` shows `trustBlocked: true`.

Approval records each pack identity: id, content digest, source, origin, trust flag, envelope digest and kind. Reinstalling the same identity, disabling or removing preserves consent; enabling an unapproved identity or changing one, even only its source, needs approval. `/reload hub` applies a new approval to a running session. The command grammar is in [commands and modes](commands-and-modes.md#project-trust).

An operator project install through the CLI, the browser or the GUI approves the records it wrote when the workspace had no plugin state or its state was already trusted. The approval lands before the install reads the copy back, so the install result, `pancode config trust plugins` and `pancode hub skills` report the same verdict. An import, `interop adopt` or a skill install offer never approves it. A task worktree that PanCode created inherits its origin's approval when its enabled identities are covered, or its state file is byte-identical to the approved origin; a hand-made worktree does not. Source: [workspace-trust.ts](../../src/core/workspace-trust.ts).

## Indexes

PanCode merges these indexes, a later one overriding an earlier row with the same `kind:name`:

1. The bundled `hub/index.yaml` in the installed package.
2. The last verified remote index, while it is current (see below).
3. The user index: `integrations.hub.catalog`, default `<configDir>/hub.yaml`.
4. The project index, `.pancode/hub.yaml`.
5. An index given with `--from`.

Installed packs that no index lists still appear, with an unknown origin.

### Rows

An index is JSON or YAML, either an `entries` object or a list. Every row needs `kind`, `name`, `description`, `version` (Semantic Version), a source and `sha256` (64 lowercase hex characters). Optional fields are `requires`, `category`, `audit`, `triggers`, `provides` (up to 256 body-free `{kind, name, description}` hints, used for discovery only), and for an extension `plugin: <name>`, the plugin it serves.

The source is one of:

- `sourceUrl`, a path relative to the index. First-party rows use `packs/<kind>/...`.
- `source: {repo, commit, subdir}`, with `repo` a `https://github.com/<owner>/<repo>` URL and `commit` 40 lowercase hex characters. PanCode fetches exactly that commit into a fresh stage with Git hooks off, refuses a checkout whose `HEAD` is another commit, and refuses a tree that does not match `sha256`.

Your own index may also give a GitHub tree URL as `sourceUrl`; its ref is resolved once with `git ls-remote` and the install records the commit. Opening PanHub or registering a pack never fetches remote content.

`requires` holds typed pack references and must agree with the manifest's `extensions["dev.pancode"].requires`. Missing, malformed and cyclic dependencies are refused.

PanCode's own indexes, the bundled one and the verified remote one, hold a stricter schema. Every row names a `publisher`, a `tier` and a `license` (an SPDX expression). A first-party row comes from `packs/` with publisher `pancode` and tier `core`. A community row uses `source`, names its own publisher, never `pancode`, and is `verified` or `listed`. Such a row may also carry `envelopeDigest` and `mcpDigest`, the digests of its extension envelope and its MCP declarations, and an install refuses a tree whose digests differ. In your own user, project or `--from` index the tier is ignored and the publisher is honoured.

### Tiers and publishers

| Tier | Which packs | Installs as |
| --- | --- | --- |
| `core` | First-party packs, publisher `pancode` | `trusted` |
| `verified` | Community packs that passed the full review, licence on the allowlist (MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, CC-BY-4.0, CC0-1.0) | `trusted` |
| `listed` | Community packs with a valid row, a reachable commit and a matching digest | `foreign`: skills and prompts load only while `integrations.projectResources.trustProjectImports` is true |

A licence outside the allowlist on a non-core row reads `licence: <id>` in `hub list` and the review, so it reads as a fact to check. A listing at any tier is not an endorsement.

An installed pack records its publisher: the row's publisher, else the GitHub owner of its source, else `local`. Installing a pack id that another publisher holds in either scope is refused before any fetch, with or without `--force`:

```text
hub_publisher_collision: <id> is installed from <publisher> (<scope>); remove it before installing <id> from <publisher>
```

### The signed remote index

The bundled index is fixed at release time.

**0.9.0 ships no root key.** The root key list in [hub-keys.ts](../../src/domains/resources/hub-keys.ts) is empty and no key certificate or remote index is published, so `pancode hub refresh` refuses with `no-root-key` without a network request, `hub status` reads `root key: none in this build`, and the bundled index is the index every client uses. The rest of this section describes the planned remote refresh, whose verification code ships in this build.

A newer index is to be published as the assets of the `hub-index` GitHub release, at `integrations.hub.index` (default `https://github.com/akougkas/pancode/releases/download/hub-index/`; blank turns the remote index off). The base URL serves three files:

- `signing.json`, a key certificate signed by the PanHub root key compiled into PanCode, naming the CI keys allowed to sign;
- `index.envelope.json`, a statement signed by a certified key that pins the index's SHA-256, its sequence, its commit and its expiry;
- `index.yaml`, the index itself.

```bash
pancode hub refresh [--json]
pancode hub status [--json]
```

`hub refresh` fetches the three files and keeps them under the state directory only when every check passes. It refuses a certificate or statement that does not verify (`bad-root-signature`, `bad-signature`, `unknown-key`, `revoked-key`, `key-not-valid-now`), index bytes that differ from the statement (`index-hash-mismatch`), an expired statement (`expired`), a certificate or index sequence lower than the kept one (`certificate-rollback`, `index-rollback`), the kept sequence with different bytes (`sequence-reused`), a malformed or unreachable asset (`malformed`, `unreachable`), and a build with no root key (`no-root-key`). A refusal leaves the kept index, its sequences and its revocations as they were, prints one line, and exits 1:

```text
PanHub index not refreshed (<reason>): <message>; keeping sequence <n>
```

`hub install`, `hub update` and `hub list` refresh first when the last verification or refusal is older than six hours. A refusal there prints one `[pancode:hub]` line on stderr, and the command continues with what is kept. A build with no root key never tries this refresh, since the bundled index is its expected state. `hub status` prints the URL, whether this build has a root key, the kept index and certificate sequences, the signing key, commit, expiry, the time of the last verification, the number of revocations and the last refusal.

Rows from the verified index are offered beside the bundled ones until its `expires` time. After expiry PanCode offers no remote row and says to run `pancode hub refresh`; installed packs keep loading and kept revocations still apply. A first-party remote row is offered only when this release ships the same tree; otherwise PanCode says to update PanCode for that pack and the bundled row stays.

### Revocation

The bundled index and the verified remote index may each carry `revoked: [{sha256, reason, date}]`, and PanCode applies the union of both. A revoked digest is not offered, and `hub install` refuses it. An installed copy with that digest lists as invalid with `pack_revoked: <id> <sha256> revoked <date>: <reason>` and stops loading: a plugin's skills, prompts and MCP servers are withdrawn, and a running extension is stopped with `installation-revoked` at its next command or maintenance check (at least every 30 seconds while it runs). Revocation keeps applying while offline or after the index expires. Remove the copy, or install a version that is not revoked.

### Private index synchronization

A private index repository may opt into Git synchronization. Set `integrations.hub.sync: true` (default false), configure a Git remote named `hub` in the directory that holds the user index, and review it with `pancode hub remote confirm <url>`, which records `integrations.hub.remote` when empty and `integrations.hub.confirmedRemote`. The URL must be `https://`, `ssh://`, `file://`, a `user@host:path` address or an absolute path; `http://` is accepted only for 127.0.0.1, [::1] or localhost, and credentials in an `https://` URL, Git transport helpers and values starting with `-` are refused (`hub_remote_invalid`). `hub sync` runs `git fetch hub` and merges `FETCH_HEAD` with `--ff-only`; `hub push` runs `git push hub`. Disabled synchronization (`hub_sync_disabled`), a missing or unconfirmed `hub` remote (`hub_remote_unconfirmed`) and a confirm URL that differs from the configured remote (`hub_remote_mismatch`) are refused before anything changes. These commands move the index repository; they do not update installed packs.

## Science packs

The bundled index carries four science plugins, published by `pancode` at tier `core`. None is installed automatically. Each pack's `README.md` under `hub/packs/plugins/<name>/` lists its setup, offline behaviour and the terms of any data source it queries.

| Pack | Skills | Servers it uses | Needs |
| --- | --- | --- | --- |
| `plugin:hpc` (0.4.0) | `hpc-modules`, `hpc-parallel-io`, `hpc-darshan` | builtin `modules`, `spack`, `darshan` | the cluster's Lmod or Environment Modules, Spack, Darshan, parallel HDF5 and MPI builds |
| `plugin:science-data` (0.4.0) | `science-data` | builtin `catalog`; the built-in `data` tool and the `store` | a catalog file for searches outside the project |
| `plugin:literature` (0.3.0) | `citation-check`, `hypothesis-workflow`; requires `skill:arxiv-literature` | none; the skills use the `cite-nexus` server from the community `plugin:cite-nexus` pack, every tool classed `read` | `plugin:cite-nexus` and `uvx` on `PATH`; network for every lookup |
| `plugin:life-science` (0.1.1) | `pdb-structures`, `uniprot-proteins`, `pubchem-compounds` | none; `web_fetch` against the public, key-free RCSB PDB, UniProt and PubChem REST APIs | network for every lookup |

```bash
pancode hub install plugin:hpc --project
pancode hub install plugin:science-data --project
pancode hub install plugin:literature --project --with-requirements
pancode hub install plugin:cite-nexus --project
pancode hub install plugin:life-science --project
pancode mcp list
pancode mcp trust cite-nexus     # if the gateway asks
```

Run `/reload hub` in a running session afterwards.

**HPC.** The pack is content only and declares no MCP server. `hpc-modules` finds modules and Spack installs through the builtin `modules` and `spack` servers and plans the module loads a script needs; the load itself always runs in `bash`, because a load lives only in the shell that runs it. `hpc-parallel-io` gives correctness and tuning rules for parallel HDF5 and MPI-IO, checked by readback and Darshan counters. `hpc-darshan` summarizes a Darshan log through the builtin `darshan` server. A server that cannot work on this host (no module tool, no Spack, no darshan-util) answers every call with the reason, and the skills fall back to `module`, `spack` and `darshan-parser` over `bash`. `pancode doctor` shows which servers this host can serve. The pack makes no network calls of its own; `spack install` needs network or a mirror and runs only when the user asks.

**Science data.** The pack declares no MCP server. The `science-data` skill starts from the project [store](panstore.md): it lists tags, takes a dataset's path with `get`, and keeps results with `put`. It answers with PanCode's built-in `data` tool first (HDF5, NetCDF, Parquet, CSV and JSON, read-only) and only for analysis `data` does not do writes a short read-only h5py, netCDF4, pyarrow or pandas script for `run_script`, which records the command and each input's hash. Datasets outside the project come from the builtin `catalog` server, which searches only the sources the operator lists in PanCode's catalog file; a fleet worker reaches a remote portal only after `pancode mcp trust catalog --network`.

**Literature.** `citation-check` extracts BibTeX entries, DOIs and arXiv IDs offline with the bundled `extract_citations.py`, verifies each through CiteNexus (key-free Crossref, DataCite, Europe PMC and arXiv), falls back to `web_fetch` when the server is absent or untrusted, and reports VERIFIED, MISMATCH, NOT_FOUND, UNAVAILABLE or UNVERIFIABLE. It never edits a bibliography, and it checks existence and metadata only, not whether a source supports the claim it is cited for. With the `cite-nexus` pack installed, `arxiv-literature` also exports BibTeX, RIS or CSL-JSON and verifies arXiv IDs. The literature pack declares no MCP server: install `plugin:cite-nexus` beside it for the CiteNexus server, or its skills fall back to `web_fetch`. That server stays untrusted until `pancode mcp trust cite-nexus` records the operator's review, which covers its per-tool class map; see [Per-tool action classes](authoring-plugins.md#per-tool-action-classes-in-mcpjson). It builds its environment on first launch, which needs network once.

**Hypothesis workflow.** `hypothesis-workflow` turns a research question into ranked, testable hypotheses: intake through `ask_user`, literature grounding with every statement cited or marked unsourced, independent council proposals, a testability ranking, the smallest experiment for each top hypothesis, and a hazard checkpoint. The bundled `hypothesis_slate.py` checks the slate offline. The workflow never picks the question or the hypothesis: it asks that choice as an [`operator_only`](tool-usage.md#askuser-host-owned-operator-interviews) `ask_user` question, which nobody answers for an absent operator, and a headless run ends with the ranked options. PanCode records each hypothesis in the project's [claims ledger](../architecture/evidence-and-memory.md#claims-ledger) as proposed and moves it only when the check it names runs; `pancode claims` reports that status.

**Life science.** Each skill answers from a live GET request and stamps the answer with the source's entry revision or release. Offline, each skill says the source could not be reached instead of answering from memory.

The builtin servers ship inside PanCode as PanKit and appear in PanHub as the seven `server` rows; their tools, action classes, configuration and limits are in [PanKit](pankit.md).

**Launcher pins.** A pack's digest covers its `mcp.json`, not what the launcher fetches. A `uvx` or `npx` version pin, such as `uvx --from cite-nexus-mcp==0.2.5`, fixes the launcher's input, not the bytes it downloads: uv or npm resolves the package and its dependencies from its registry on first launch.

## Community packs

A community pack lives in its owner's public repository and enters PanHub as one row file, `hub/community/<publisher>/<name>.yaml`, naming the repository, one exact commit, the subdirectory, the tree digest, the licence and a tier. `pnpm hub:pin` fetches that commit, refuses a tree whose digest differs, and writes the index row. A pull request from a fork may change one row file and nothing else, and the hub review job fetches the commit as data, validates it, recomputes its digests, and checks the licence and every `uvx` or `npx` launch pin. Submissions start at `listed`; a maintainer moves a row to `verified` against the checklist in `hub/community/README.md`. `hub/TERMS.md` states what a listing promises, takedown and revocation.

The bundled index holds five community rows, all published by `akougkas` at tier `verified` under MIT:

| Pack | Provides | Source (`github.com/akougkas/...` at commit, subdirectory) |
| --- | --- | --- |
| `plugin:wtfp` (0.9.0) | seven academic research and writing skills (`wtfp-start-project`, `wtfp-plan-section`, `wtfp-write-section`, `wtfp-review-manuscript`, `wtfp-research-literature`, `wtfp-deliver-research`, `wtfp-manage-project`), eleven agents, two playbooks and the `/wtfp:` prompts | `wtf-p` at `d227608f6a7b814b914c2bb2fabbee5611b846b8`, `pancode/plugin` |
| `extension:wtfp` (0.9.0) | the WTF-P writing desk for `plugin:wtfp`: paper state, gates and a write guard that run in code | `wtf-p` at `d227608f6a7b814b914c2bb2fabbee5611b846b8`, `pancode/extension` |
| `plugin:zulipchat` (0.8.1) | an MCP server (`uvx zulipchat-mcp@0.8.1`) and the `zulipchat` skill: Zulip messaging and search, and hand-off to Zulip agent bots | `zulipchat-mcp` at `a1c464f5e8d8d68c95e8e1f83dde20658fd2664c`, `pancode` |
| `plugin:autotldr` (0.2.0) | the AutoTLDR MCP server (`uvx --from autotldr==0.2.0`), which summarizes a source in the shape asked for | `AutoTLDR` at `335637919dbe5e3c5e0d721698f9198f7edf71d9`, `pancode` |
| `plugin:cite-nexus` (0.2.5) | the `cite-nexus` MCP server (`uvx --from cite-nexus-mcp==0.2.5`): scholarly metadata search, identifier resolution, reference checks and BibTeX, RIS or CSL-JSON export, key-free by default; the server the literature pack's skills call | `cite-nexus-mcp` at `881debc25c03f82abeccc6bbbc86e33954abe674`, `pancode` |

Installing a row fetches that exact commit. A server a community pack declares stays untrusted until `pancode mcp trust <id>`.

## Skills

Skills are one kind of pack and use the same manifest, version, full-tree digest, origins, scope and lifecycle as every other kind. `loadSkills` in [loader.ts](../../src/domains/resources/skills/loader.ts) selects the runtime skills. The SKILL.md format, discovery roots, collision order and trust rules are in [extensions-and-sharing.md](extensions-and-sharing.md#skills).

```bash
pancode hub search interview --kind skill
pancode hub install skill:plan-interview --project --dry-run
pancode hub install skill:plan-interview --project
pancode hub skills --all --json
```

`/skill <name> [task]` invokes a skill, `/skill off` clears the session's skill tool-surface narrowing without erasing instructions already loaded, and bare `/skill` opens PanHub on its Skills tab. An unmanaged `SKILL.md` stays a valid runtime resource. A packaged skill installs from PanCode's shipped files without network access.

`/skill <name>` for a skill that is not installed but has an index row asks "Install and run" (user scope), "Install for this project and run", or "Cancel"; an accepted choice installs, reloads and runs the skill. A name with no installed or indexed skill reports that no local marketplace entry is available. The project choice does not approve workspace trust.

### What the model sees

`context(scope="skills")` with no `name` returns a bounded listing: ready skills in PanCode (a drifted one is marked `[drifted]` and warns `skill_drift` when loaded), skills supplied with `--skill <path>`, installed packs that provide skills, and marketplace skills not yet installed (omitted for workers, `--no-skills` runs and runs bound to an agent definition). It accepts `query`, `limit` (at most 200) and `offset`.

A pack's readiness reads `ready`, `requires trust`, `pending reload; run /reload hub`, `damaged`, `shadowed`, `disabled`, `incompatible` or `invalid`. Only `ready` skills are advertised. In `default` and `yolo` the model loads a ready skill itself with `context(scope="skills", name="<name>")`; loading narrows the allowed tools and never grants one the host disallows.

## Registry and pins

Every distributable byte is pinned by SHA-256, and the pins are generated, never edited by hand.

| File | Role |
| --- | --- |
| `hub/index.yaml` | The bundled index: one row per pack with its full-tree `sha256`, version, publisher, tier, licence, `triggers`, `audit` and `provides`, plus the `revoked` list. Installs resolve from it. |
| `hub/revoked.yaml` | The revoked digests `hub:pin` copies into the index. |
| `hub/community/<publisher>/<name>.yaml` | One community row file per pack. |
| `hub/packs/skills/registry.yaml` | Normalized skill-body hashes. An installed skill with `registry-id` provenance is compared with its hash at activation, and a mismatch warns of drift. Provenance evidence, not an installation pin. |
| `hub/packs/skills/skill-marketplace.json` | Published by `skills:pin` for authoring and provenance inspection; not an installation authority. |
| `.claude-plugin/marketplace.json` | A projection of the pins for Claude Code, so another agent can install the packs from the repository. |

`pnpm hub:pin` validates every pack under `hub/packs/<kind>/` and the authoring templates, requiring each pack's kind to match its directory and identities to be unique. It refuses a pack whose bytes changed since the last release tag under the same version: bump the version in both `plugin.json` and `SKILL.md`. It refreshes the normalized skill evidence (the work of `pnpm skills:pin`), fetches each community row's commit and regenerates its row, writes `hub/index.yaml` with the revoked list, and regenerates `.claude-plugin/marketplace.json`. A community row that fails to fetch keeps its committed row and fails the run. `pnpm hub:check` repeats every stage as a check without fetching, fails on a stale pin, and runs inside `pnpm lint`.

`hub validate` and `hub:pin` also check skill authoring: a missing linked local file is an error; missing bare companion paths, unknown skills in routing clauses and a body over 120 lines are warnings. An optional `pancode.verified-at` must be a valid date; a future date or one older than 180 days warns. A catalog skill carries `name`, `description`, `version` and `license` frontmatter and a `pancode:` block with `registry-id`, `source-url` and `audit: pass`. Every bundled skill also declares `triggers`, a list of the requests it serves: the skill reminder offers a skill with triggers only when the operator names it or reaches two thirds of one trigger's terms, and offers a skill without them on lexical rank alone.

The marketplace projection makes packs installable from the repository with `claude plugin marketplace add akougkas/pancode`, then `claude plugin install <name>@pancode`. A pack is published there only when a peer host would load a real skill surface from it and nothing it would scan into a native component; `hub:pin` prints each pack it leaves out and why. See [coding agent interoperability](interop.md).

## Attended install rule

The `operating.skill-installs` fragment ([skill-installs.md](../../src/domains/prompts/fragments/operating/skill-installs.md)) is attended-only: the compiler adds it for TUI, GUI and ACP sessions whenever skills are usable, right after `operating.discovered-skills`. Headless `pancode run` prompts carry the discovery fragment without it, and worker prompts carry neither. It tells PanCode:

- Install only when the operator requests or approves it.
- Honour a `[Marketplace]` reminder's exact interview options; a declined installation settles the offer for this task.
- After an approved install, inspect readiness again and report `/reload hub` if the running session has not admitted the skill.
- `/skill` is an interactive command, not a shell command.
- Do not bypass integrity or import trust checks.

For an explicit operator request, the route is `pancode hub install kind:name --user|--project` through `bash` with operator approval; `--dry-run` previews it without a write or an approval prompt.

### Marketplace offers

A marketplace offer is the unsolicited path, and it is local: the matcher in [promotion.ts](../../src/domains/resources/skills/promotion.ts) scores the operator's request against the pinned index with no model call and no network access.

- A whole-phrase match on an authored `triggers` entry (at least 4 characters), or an overlap of at least 3 distinctive name and description tokens, produces a `[Marketplace]` reminder. The model then asks with `ask_user` (header "Install skill"), offering exactly "Install for this project", "Install globally", "Not now" and "Never offer this skill". PanCode acts only on an answer bound to the offer and performs the install itself.
- Each skill is offered at most once per session. "Not now" pauses offers for the session; "Never offer this skill" persists in `<configDir>/skill-promotion-declines.json`, keyed by name and catalog version. A turn with narrowed tools, disabled skills, or `answer` or `proposal` mode gets no offer.
- A consented install passes `assertPromotionInstallSource`, which accepts only PanCode's own packs: the shipped index or `https://github.com/akougkas/pancode/` URLs.
- Headless runs and ACP sessions get passive guidance (`install with pancode hub install <name>`) and no question. Workers never see offers.

## Operator ownership of installed skills

Active `.pancode/{skills,plugins,extensions}/` and `<configDir>/{skills,plugins,extensions}/` trees are operator-owned. Main and worker tool admission refuses model writes, edits, deletes and shell mutations there at autonomy `default` with reason `skill-authority`; reads stay allowed. At `yolo` the yolo floor still refuses them under PanCode's own config directory (`pancode-owned-state`), while the project's `.pancode/` trees are not protected. A model shell call is also inspected for the operator CLI:

| Model shell call | Disposition |
| --- | --- |
| `pancode hub install`, `import`, `package`, `update`, `remove`, `enable`, `disable`, `pin`, `register`, `sync`, `push`, `remote` | One-shot operator confirmation in `default` (reason `hub-confirm`), which the safety judge never answers. Admitted in `yolo`. A headless run denies the ask. |
| `--dry-run` of `install`, `import`, `package`, `update`, `enable`, `disable`, `remove`; and `search`, `list`, `components`, `inspect`, `validate`, `drift`, `reload`, `skills`, `inventory`, `refresh`, `status` | Not treated as mutations; never asks. |
| `pancode share import` without `--dry-run`, `pancode extensions test`, `pancode extensions validate` | One-shot operator confirmation in `default`, admitted in `yolo`, denied headless. An import installs packs from an archive the model may have written, and the other two run a pack's own code. |
| `pancode extensions` install, update, remove, enable, disable, pin; `pancode interop adopt --yes`; any `pancode config trust` | Blocked at `default`. At `yolo` only `config trust` stays blocked, as part of the yolo floor (`trust-authority`), so the model never approves a project's surfaces. |

This is command inspection and tool admission, not an operating-system sandbox for arbitrary scripts. Draft skills outside active roots, for example `draft-skills/example/`; the operator can `hub validate` the draft, then register and install it.

## One inventory for the operator and the model

```bash
pancode hub components --json
pancode hub components verification --kind agent
pancode hub components --source core --all
```

`hub components` is the versioned, body-free read of the skills, agents, prompts and playbooks actually discovered: core components, loose user and project files, installed pack members, and foreign files in interop compatibility roots. Each row carries its runtime name, owning pack or source class, scope, origin, availability (`available`, `untrusted`, `invalid`, `shadowed`, `unavailable`) and, where usable, its invocation. `--all` adds internal diagnostic agents. It never fetches and never writes.

`hub skills [--all]` lists runtime skills, including unmanaged files. `hub inventory --json` is the fixed, body-free skills contract (version 1, at most 64 skills) that GUI hosts read. The model reads the same inventory through `gateway(op="call", capability="pancode_hub", args={})`, a bounded read with no install, activation or pin write; see [tool usage](tool-usage.md) for its arguments.

## Lifecycle receipts

Every committed install, update, enable, disable, remove, register and import writes a lifecycle receipt: the operation, the pack kind and id, the content digest, the envelope digest for an extension, the scope, the source and the actor (`operator`, `model-confirmed` or `upgrade`). PanCode keeps the most recent 512 receipts in `hub-receipts.json` under its state directory (`recordLifecycleReceipt` in [hub-receipts.ts](../../src/core/hub-receipts.ts)), and journals each operation as a `hub.*` record such as `hub.installed`. The PanHub detail pane and `/extensions` show a pack's last lifecycle line.

## Authoring a pack

Writing a pack, an extension or an MCP server is covered in [Extension API (unstable)](sdk.md); manifest fields and the contributor journey are in [authoring-plugins.md](authoring-plugins.md#authoring-templates-and-contributor-journey). A first-party pack goes under `hub/packs/<kind>/` and is pinned with `pnpm hub:pin`; a community pack is submitted as one row file, as described in [Community packs](#community-packs).
