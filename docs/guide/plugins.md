# Portable plugins and PanHub

A plugin is an Agent Plugin: a complete, versioned package of content with a portable root `plugin.json` that follows [Agent Plugins 1.0.0](https://agent-plugins.org/). It is content only. PanCode reads its own prompts, agents, and playbooks from its own namespace in that manifest, `extensions["dev.pancode"]`, and from the `dev.pancode/` directory. Installing a plugin keeps its content and references together, pins the whole tree by SHA-256, and installation and discovery do not execute plugin code inside PanCode.

Source: plugin discovery and validation are in
`src/domains/plugins/` and `src/domains/resources/`; the installed PanHub
lifecycle is in `src/domains/resources/hub.ts` and
`src/domains/resources/hub-packages.ts`; plugin state and digest logic are
in `src/domains/plugins/state.ts`, `src/domains/plugins/integrity.ts`, and
`src/domains/plugins/verified-tree.ts`; plugin MCP declaration and trust are in
`src/domains/gateway/mcp/` and `src/cli/mcp.ts`. Tests:
`tests/contracts/extension-resources.test.ts` and
`tests/extended/plugin-resource-loading.test.ts`. The digest check proves which bytes
PanCode installed and read; it does not make a script that a tool later runs
harmless.

This page is the concept map. Each contract is stated once, in the page named in the last table. A PanHub plugin is unrelated to `integrations.runtimePlugins`, which lists pi-ai compatibility plugins loaded by the engine; see [pi-boundary.md](../architecture/pi-boundary.md). A runtime plugin is imported into PanCode's own process, so an entry must be a bare npm package name or an absolute path under `<configDir>/runtimes/`, and the list is read from user settings only: a project value is ignored with a warning.

## Which page do I need

Seven pages cover extending PanCode. Start from what you want to do:

| I want to | Read |
| --- | --- |
| Reuse a prompt I type often, or teach the agent a procedure as a skill | [Prompts, skills, and share archives](extensions-and-sharing.md) |
| Use the prompts and skills Claude Code, Codex or OpenCode already have | [Trust and compatibility roots](extensions-and-sharing.md#trust-and-compatibility-roots), then [Adopt foreign resources](interop.md#inbound-review-and-adopt-foreign-resources) to adopt them |
| Find and install a skill or plugin someone published | [PanHub](panhub.md#browse-and-install) |
| Package my skills, prompts and agents for others to install | [Authoring plugins](authoring-plugins.md) |
| Add code that changes PanCode: hooks, tools, commands, a workspace | [Extensions](harness-extensions.md) |
| Write and test that code, or an MCP tool server, against PanCode's extension API | [Extension API (unstable)](sdk.md) |
| Hand a task to Claude Code, Codex or OpenCode | [Coding agent interoperability](interop.md) |
| Move my prompts, skills and settings to another machine | [Share archives](extensions-and-sharing.md#share-archives) |
| Tell a plugin from an extension, or find which page owns a contract | [Plugins](plugins.md) |

## Package kinds

PanHub distributes three package kinds. The two content kinds, `plugin` and `skill`, share one engine, one state file per scope, and one lifecycle. The third, `extension`, is code that runs in its own process and has its own manifest, state file, and consent. A kind names what a package exposes.

| Kind | Exposes |
| --- | --- |
| `plugin` | Any mix of skills, prompts, agents, playbooks, MCP servers, scripts, and reference files. The default content kind. |
| `skill` | One skill. |
| `extension` | Code that runs in its own process; see [Extensions](harness-extensions.md). |

User plugins install under `<configDir>/plugins/<name>/` and project plugins under `.pancode/plugins/<name>/`; extensions install under `<configDir>/extensions/<id>/` and `.pancode/extensions/<id>/`. A valid project copy wins over the user copy, and a disabled project copy still suppresses it. A project copy loads only while the operator has approved the workspace's `.pancode/plugins/state.json` (or `.pancode/extensions/state.json` for an extension); an unapproved project copy neither loads nor suppresses the user copy. See [Scopes and installed state](panhub.md#scopes-and-installed-state).

## Plugins, extensions, loose resources, and share archives

| | Plugin | Extension | Loose resource | Share archive |
| --- | --- | --- | --- | --- |
| Installed with | `pancode hub install plugin:<name>`, `/hub` | `pancode hub install extension:<name>`, `/hub` (Extensions tab), `pancode extensions install` | Copy into a resource root | `pancode share import` |
| Manifest | `plugin.json` | `pancode-extension.yaml`, `.yml` or `.json` | None (`SKILL.md` frontmatter) | JSON archive |
| Contributes | Content: skills, prompts, agents, playbooks, scripts, reference files | Code that runs in its own process: hooks, runtime tools, commands, workspaces and skins, interviews | One skill, prompt, agent, or playbook | Copies of loose resources, extension packages, a settings fragment |
| Runs code in PanCode | Never | Only after the operator reviews its capability envelope | Never | Never; extension entries go through the extension installer |
| State | `plugins/state.json` | `extensions/state.json` | None | None |
| Reload | `/reload hub` | `/reload extensions`; tool schemas stay frozen for the session | Next discovery | Not applicable |

The two package systems never overlap. An extension manifest that declares `skills`, `prompts`, `agents`, `playbooks`, or `resources` is refused with a pointer to `pancode hub install <path>`, and an extension root never holds a `plugin.json`. A plugin may carry scripts that a skill or playbook runs explicitly, and explicitly trusted `mcp.json` servers can expose gateway capabilities. Those scripts and server processes are ordinary executables once invoked; "content only" means installation and resource loading do not register plugin code as an extension runtime. A plugin contributes no extension hooks or UI. Prompt templates provide slash invocations without an extension runtime.

### Pairing a plugin with an extension

A plugin and an extension are separate packages, each with its own manifest, digest, state file, and consent. An extension may name the one plugin it serves with a top-level `plugin: <name>` in `pancode-extension.yaml`. That link alone lets one of its commands declare `replaces: prompt` and answer the plugin's `/<plugin>:<command>` prompt of the same name, and the takeover applies only while the plugin is installed and enabled. The extension's runtime snapshot carries the served plugin as `snapshot.plugin`. The plugin's prompts keep a working fallback for when the extension is absent, so a plugin installed alone starts no runtime. The PanHub detail view names each side's partner and says whether it is installed and in effect. Installing a plugin never installs its extension, so the operator installs `extension:<name>` separately. See [Extensions](harness-extensions.md).

## How plugin resources reach a session

- Skills load from the enabled plugin skill roots at package precedence (10), with provenance `source: plugin`.
- Prompts load from enabled plugin prompt roots. A prompt's command name is its path beneath the prompts root with directory separators written as colons.
- Agents and playbooks register through the agent and playbook loaders. An agent ID comes from its definition filename, and a playbook keeps its authored name.
- A session sees additions and replacements after `/reload hub` or a restart. Removal, disabling, and digest drift revoke discovery on the next read.
- The stdio servers in a root `mcp.json` become plugin-scope MCP declarations while the plugin loads, which means it is installed, enabled and unchanged since install. `pancode mcp list` shows each one with the plugin that ships it, and none runs until you trust it with `pancode mcp trust <id>`, unless the plugin came from the index this PanCode ships at tier `core` and its files still match the pinned digest. `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expand in its `args`, `env` values and `cwd`, as in [Per-tool action classes in mcp.json](authoring-plugins.md#per-tool-action-classes-in-mcpjson); removing the plugin deletes its `${PLUGIN_DATA}` directory. A server entry may carry PanCode's `toolActionClasses`, a map from tool name to `read`, `execute`, `destructive` or `unknown`; `pancode mcp list` and `pancode mcp trust` print the map, the trust digest covers it, and once the server is trusted each entry overrides the class the trust record gives its other tools. A foreign package declares servers only while `integrations.projectResources.trustProjectImports` is true, and each still needs that trust. Disabling or removing the plugin, or editing its installed tree in place, removes its declarations, and a server already running stops before its next call. An update or reinstall records a new content digest, which the trust record covers, so the server stays declared but its trust is stale until you trust it again. A session that was running before the update refuses that server until you trust it again and run `/reload mcp`, or restart. A server keeps the id it declares; a user or project declaration with the same id wins. A server whose `type` names a transport other than `stdio` is reported and skipped. A server without `type` is read as stdio, so a remote field such as `url` fails the whole file closed. PanCode does not execute plugin hooks.
- Foreign packages (from `interop adopt` or `hub import`) install with foreign trust, and their skills and prompts load only while `integrations.projectResources.trustProjectImports` is true.
- Project packages of every kind load only after workspace trust approves the project's plugin state (`pancode config trust plugins`). An operator install into new or already trusted project state can approve the package identities it wrote. Imports and adoptions never approve workspace trust; see [project package trust](panhub.md#workspace-trust-for-project-packages). User packages need no workspace approval. The two gates are independent, so a foreign package at project scope needs both.

## Where each contract lives

| Contract | Page |
| --- | --- |
| Package invariants: identity, integrity digest, state, precedence, dependencies, trust origins, operator authority, lifecycle plans | [PanHub architecture](../architecture/panhub.md) |
| Manifest fields, kinds, components, references, validation, templates | [Authoring plugins](authoring-plugins.md) |
| Operator commands, index format, import, extension review, lifecycle receipts, scope and drift, the PanHub overlay, inventory, workspace trust of project packages | [PanHub](panhub.md) |
| Skill install rule, marketplace offers, registry and pins, `hub:pin` | [PanHub](panhub.md#registry-and-pins) |
| Prompt and skill roots, collisions, trust, share archives | [Prompts, skills, and share archives](extensions-and-sharing.md) |
| Extension manifest, capability envelope, hooks, runtime tools, commands, workspaces, sandbox, lifecycle, workspace trust of project extensions | [Extensions](harness-extensions.md) |
| Extension API entry points, extension scaffold and test host, MCP tool servers | [Extension API (unstable)](sdk.md) |
