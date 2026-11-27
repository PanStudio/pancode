# Authoring a portable agent plugin

An agent plugin packages a workflow and its supporting resources as one versioned installation: skills, prompt templates, agents, playbooks and the files they read. You write a root `plugin.json`, add your resources, validate the package, and install it from a path or a PanHub index. A plugin is content only: installation and discovery do not execute plugin code, and code that changes PanCode itself ships as a separate [extension](harness-extensions.md). Scripts in a plugin become ordinary executables only when a user or tool explicitly runs them, under normal safety policy.

Its canonical identity is the [Agent Plugins 1.0.0 manifest](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json). PanCode keeps the complete package together, verifies its full-tree digest, and discovers the resources supported by the current runtime. This page owns the manifest fields, and `isPluginId` in [discovery.ts](../../src/domains/plugins/discovery.ts) validates package identifiers. Package invariants are in [PanHub architecture](../architecture/panhub.md) and operator commands are in [PanHub](panhub.md).

The minimal package has a root `plugin.json` and an immediate child skill directory:

```text
lab-research/
  plugin.json
  skills/
    research/
      SKILL.md
```

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "lab-research",
  "version": "1.0.0",
  "description": "Research from supplied lab evidence"
}
```

## Root manifest fields

The root schema permits exactly these keys, and any other key is a validation error.

| Key | Rule |
| --- | --- |
| `$schema` | Required. Must equal `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`. |
| `name` | Required. 1 to 64 lowercase letters, digits, hyphens or periods, beginning and ending with an alphanumeric character, with neither `--` nor `..`. `state.json` is reserved as installation bookkeeping. |
| `version` | Required, including for a local authoring install. An explicit Semantic Version of at most 256 characters, with no `v` prefix. Numeric prerelease identifiers cannot contain leading zeros. |
| `description`, `homepage`, `repository`, `license` | Optional strings. |
| `author` | Optional object with string `name`, `email` and `url`. |
| `keywords` | Optional array of strings. |
| `extensions` | Optional map of namespaced objects. PanCode reads only its own namespace, `dev.pancode`. |

A root `state.json` is rejected, and `plugin.json` must be a regular file at the package root. A root `mcp.json` is preserved and reported as a warning. Its stdio servers become plugin-scope declarations after installation and enablement; none launches until the operator runs `pancode mcp trust <id>`, except that a first-party `core` pack installed from the index PanCode ships is trusted while its files match the pinned digest. See [plugin MCP loading](plugins.md#how-plugin-resources-reach-a-session).

### Per-tool action classes in mcp.json

`mcp.json` has the Agent Plugins shape `{"mcpServers": {"<id>": {...}}}`. A server entry accepts `type` (only `stdio`), `command`, `args`, `cwd`, `env`, `timeoutMs`, `network` and PanCode's `toolActionClasses` and `envVars`; any other field fails the whole file closed. `network` in a plugin file is ignored with a warning, because only the operator grants network with `pancode mcp trust <id> --network`. `${PLUGIN_ROOT}` (the installed plugin root) and `${PLUGIN_DATA}` (a writable directory under PanCode's data root, created before launch, kept across updates and removed when the plugin is removed) expand in `args`, `env` values and `cwd`, never in `command`, and the server process gets both as environment variables; an `env` entry of either name fails the file. A `cwd` is relative to the plugin root, or starts with one of the two variables and stays inside that directory. `command` is an executable name or an absolute path, so launch a bundled file as `"command": "node", "args": ["${PLUGIN_ROOT}/server.mjs"]`; PanCode puts the directory of the Node it runs on first on a plugin server's `PATH`, so `node` is that Node even on a host without one; a user or project server gets the same directory last, so its own `node` and `npx` win. `toolActionClasses` maps up to 128 tool names to `read`, `execute`, `destructive` or `unknown`, so a pack can let its read tools run while its file-writing tools ask:

```json
{
  "mcpServers": {
    "pandas": {
      "type": "stdio",
      "command": "pandas-mcp",
      "args": ["--stdio"],
      "timeoutMs": 120000,
      "toolActionClasses": {
        "statistical_summary": "read",
        "save_data": "destructive"
      }
    }
  }
}
```

`pancode mcp list` and `pancode mcp trust` print the map, and the declaration digest that the trust record pins covers it, so editing a class in an installed package makes the server's trust stale. The map applies only once the server is trusted. A listed tool takes its declared class; a tool the map does not list takes the class in the trust record, which stays `unknown` (asks) unless the operator passes `--action-class` to `mcp trust`. The bundled `literature` pack classifies every tool it ships this way; see [Science packs](panhub.md#science-packs). Source: `src/domains/gateway/mcp/config.ts`, `src/domains/gateway/mcp/action-classes.ts`.

A plugin server's environment is PanCode's fixed safe set plus its `env`. `envVars` lists, at most 32, the variables it also takes from PanCode's own environment at launch: a name such as `MODULEPATH`, or a prefix of at least 4 characters ending in `*` such as `LMOD_*`. `PANCODE_*`, `NODE_OPTIONS`, `BASH_ENV`, `ENV`, `LD_PRELOAD`, `LD_AUDIT` and names that look like secrets are refused. The names are in the declaration digest and `pancode mcp list` prints them; their values never are. The bundled `hpc` pack passes the module and Spack variables this way.

A skill in the package can confine itself to those server tools: its `allowed-tools` may name a full MCP capability (`mcp_<id>__<tool>`) or extension capability (`extension_<id>__<tool>`), which is kept as written. See the skill frontmatter fields in [extensions-and-sharing.md](extensions-and-sharing.md).

## The PanCode namespace

`extensions["dev.pancode"]`, called the PanCode namespace, holds optional product metadata inside the portable manifest. A plugin containing `skills/<name>/SKILL.md` needs only the root identity fields above: PanCode discovers the conventional `skills/` directory. A standalone skill package with a root `SKILL.md` declares `kind: "skill"`, `resources.skills: "."` and its one public skill component through the extension; the supplied skill template demonstrates that form, and `pancode hub package <directory>` generates it for an existing bare skill while preserving its scripts and references. PanCode prompts, strict agents, playbooks and explicit component graphs also use this metadata. The key does not select a directory: its `resources` map names the paths the package actually uses.

| Field | Rule |
| --- | --- |
| `manifestVersion` | Must be `1` whenever the object is present. |
| `kind` | `plugin` (default), `skill`, `agent`, `prompt`, `playbook` or `server`. |
| `requires` | Package dependencies as `kind:name` references (see [Package dependencies](#package-dependencies)). |
| `compatibility.pancode` | Optional SemVer range. Install and load refuse a package whose range excludes the running PanCode. |
| `resources` | Map from `skills`, `prompts`, `agents` or `playbooks` to a relative directory inside the package. |
| `components` | Up to 1024 component declarations (see [Components and references](#components-and-references)). |

Resources use ordinary top-level directories (`agents/`, `prompts/`, `skills/`, `playbooks/`), while `assets/` holds shared supporting files. PanCode content may instead live under a `dev.pancode/` directory, which keeps peer hosts from default-scanning it; top-level directories are recommended for new packages. Portable skills must use the root `skills` directory unless the package is a standalone skill package.

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "lab-research",
  "version": "1.0.0",
  "description": "Research from supplied lab evidence",
  "extensions": {
    "dev.pancode": {
      "manifestVersion": 1,
      "compatibility": { "pancode": ">=0.9.0" },
      "resources": {
        "skills": "skills",
        "prompts": "prompts",
        "agents": "agents"
      },
      "components": [
        {
          "kind": "resource",
          "id": "methods",
          "path": "assets/methods.md"
        },
        {
          "kind": "skill",
          "id": "research",
          "path": "skills/research/SKILL.md",
          "requires": ["resource:methods"]
        },
        {
          "kind": "agent",
          "id": "researcher",
          "path": "agents/lab-research-researcher.md",
          "requires": ["skill:research"]
        },
        {
          "kind": "prompt",
          "id": "start",
          "path": "prompts/lab-research/start.md",
          "requires": ["agent:researcher"]
        }
      ]
    }
  }
}
```

Create every declared directory and file before validation. A manifest declaring any other resource kind, `themes` included, fails validation.

### Package kinds

A `plugin` may carry many public components. Every other content kind is a single-component package, and the manifest parser and `hub validate` enforce these rules:

- It declares exactly one public component of its own kind (`skill`, `agent`, `prompt` or `playbook`).
- Its `resources` map holds only its own resource root (`skills`, `agents`, `prompts` or `playbooks`).
- The resource root exposes exactly the declared file: a `SKILL.md` for a skill, a single Markdown file otherwise. Private supporting files may sit elsewhere in the package.
- A standalone skill package uses `resources.skills: "."` with a root `SKILL.md`.
- A standalone agent package declares `skills: []`, because an agent cannot bind a skill outside its own package.
- `README.md` stays at the package root, outside any resource directory, so the loader does not discover it as a second public component.

A third-party `server` pack may include files its launcher runs, but no components or `skills/`, `agents/`, `prompts/` or `playbooks/` root, even if undeclared. Its root `mcp.json` declares exactly one stdio server whose id is the pack name and which is not the id of a server PanCode ships. `hub validate` reads that file with the gateway's declaration and size checks. Installed with `pancode hub install server:<name>`, it becomes a plugin-scope declaration that launches only after `pancode mcp trust <name>`; another agent host runs it with `pankit serve <name>` after `pankit add <name>`.

### Components and references

Component kinds are `skill`, `prompt`, `agent`, `playbook`, `script`, `resource`, and `tool`. A component has a stable `kind:id` identity (id: lowercase letters, digits, dots, underscores and hyphens, at most 80 characters), one contained file path, and optional `requires` references to other components in the same plugin. A skill points to its `SKILL.md`. Dependencies must exist and form an acyclic graph. Native discoverable components (`skill`, `prompt`, `agent`, `playbook`) must live beneath their declared resource root, and agent and playbook files must sit directly in that root because nested ones cannot be discovered. Component metadata records relationships; it does not execute scripts or register tool implementations.

PanCode text can refer to `${pluginRoot}/assets/methods.md` or `${component:resource:methods}`. Prompts, agent bodies, and skills recognize prose markers with portable, space-free slash suffixes. For a filename containing spaces or Unicode, declare a component and refer to its `kind:id`. The referenced target must exist within the declaring package. Playbook argument paths use a separate complete-path parser: the reference must occupy the whole argument, and containment is checked after expanding the entire suffix, including spaces and Unicode. A reference embedded in an option such as `--file=${pluginRoot}/data.csv` is rejected; pass the path as its own argument. These are PanCode reference forms; peer exports translate instructions and paths for their native host. Portable skill text should use relative file references where practical.

Prompt names follow their path beneath the prompts root, with directory separators written as colons. The example exposes `/lab-research:start`. Give agent and playbook filenames a package prefix to keep their registered identities unambiguous. Agents retain the strict version 1 contract, including required and optional tool lists, custom audience, budget, and result contract. A plugin's agents may bind skills from their own package, and a bound skill must be trusted and live inside that package. Workers have no `ask_user`; interviews belong to the orchestrator.

### Package dependencies

Package dependencies live in `extensions["dev.pancode"].requires` as typed references such as `["skill:ship"]`, matching `kind:name` with a lowercase name. Copy the same requirements into the PanHub index row, because install refuses a package whose manifest and index rows disagree. They name packages, while component `requires` names files within one package. Neither declares an execution hook. The dependency rules (acyclic, installed, enabled, loadable) are invariant 6 of the [PanHub architecture](../architecture/panhub.md).

## Validation

```bash
pancode hub validate ./lab-research --json
pancode hub inspect ./lab-research --json
```

`hub validate <pack-path|skill-dir|SKILL.md>` performs a read-only content and payload validation before any installation or registration. It exits 0 for a valid package and 1 otherwise, and a `SKILL.md` argument, or a bare skill directory without a `plugin.json`, validates one skill file. With `--json` it prints the candidate manifest plus `manifestValid`, `valid` and a `validation` object holding `contentValid`, per-resource `resources`, `diagnostics` (each with a `severity`, a code such as `ERR_MANIFEST`, `ERR_SKILL`, `ERR_PROMPT`, `ERR_AGENT`, `ERR_PLAYBOOK`, `ERR_COMPONENT` or `ERR_PACKAGE_REFERENCE`, and a path) and `prerequisites`.

- **Manifest validity**: parses `plugin.json` against the schema, verifying identifiers, SemVer compliance, and declared resource roots.
- **Payload and schema validation**: validates skills, prompt loadability, and agents against strict v1 schemas, policy budgets, and custom audience rules; parses playbook DAGs, loop boundaries, and write boundaries.
- **Package reference resolution**: ensures all `${component:...}` and `${pluginRoot}` references point to existing files within the package boundary.
- **Prerequisite separation**: reports required external commands and core agents as environment prerequisites (`type` is `command` or `agent`) rather than failing package content validity.
- **Read-only**: leaves package files, repository files, and installation state roots completely unchanged.

`hub inspect <path>` prints the manifest candidate without the content checks. Installation validates the exact manifest bytes included in the tree digest, then stages and publishes the package; see [PanHub](panhub.md#lifecycle) for the install, update, drift and removal commands, and the [PanHub architecture](../architecture/panhub.md) for the integrity and state rules.

## Host projections and runtime capabilities

Agent Plugins 1.0.0 standardizes skills and MCP declarations. PanCode consumes portable skills, its own namespace and explicitly trusted stdio declarations in a root `mcp.json`. Disabling, removing or changing the installed plugin withdraws those declarations; see [plugin MCP loading](plugins.md#how-plugin-resources-reach-a-session). Claude Code and Gemini have their own native manifests and component formats. A package exporter must translate those formats and report which features are native, adapted as instructions, or unavailable. An exported skill workflow does not establish that a peer host runs PanCode playbooks.

Two layouts need no exporter at all, because Claude Code and Codex load them directly from the unchanged package:

- A standalone skill package with a root `SKILL.md`, no `skills/` directory and no top-level `skills` manifest field. Claude Code loads it as a single-skill plugin and takes the invocation name from the `SKILL.md` frontmatter. Codex finds the same directory under any of its skills roots.
- A plugin with a real `skills/` directory. Both hosts publish exactly those skills.

What a peer host does *not* load matters just as much. Claude Code scans a plugin root for `agents/`, `commands/`, `hooks/`, `output-styles/` and `.mcp.json` with no manifest asking it to. A PanCode strict-v1 agent sitting in a top-level `agents/` directory is therefore picked up and shown as a native Claude agent, tools, model and budget fields included, none of which that host honors. PanCode `prompts/` and `playbooks/` are inert to it. A first-party plugin with a root `mcp.json` gets a root `.mcp.json` that `pnpm run hub:pin` generates from it, with `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` renamed to `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` and PanCode's policy fields dropped, so the marketplace publishes its server beside its skills.

That leaves a real choice when a package should serve both audiences. Ordinary top-level `agents/` and `prompts/` directories are the recommended PanCode layout and stay a valid first-class PanHub pack; the repository marketplace simply does not publish such a package, and `pnpm run hub:pin` prints the reason. To publish it as well, declare its PanCode resource roots at paths no peer host scans, for example `"agents": "native/agents"` in the manifest's `resources` map, and put the agents there.

Keep the skill layout intact when you edit a package: adding a `skills/` directory to a standalone skill silently stops its root `SKILL.md` from loading. [hub-portability.test.ts](https://github.com/PanStudio/pancode/blob/main/tests/extended/hub-portability.test.ts) asserts all of this for every curated package. See [coding agent interoperability](interop.md) for the exact install commands.

Extensions are a separate package kind with their own manifest, installation state and consent; see [Extensions](harness-extensions.md), and write one against the [extension API](sdk.md). They cannot declare domain resources: prompts, agents, skills, playbooks and reference files ship in a plugin. An extension that serves a plugin names it with `plugin: <name>` in its own manifest, and the plugin's prompts keep a working fallback for when the extension is absent.

## Authoring templates and contributor journey

PanCode provides working, valid authoring templates for the five content kinds and a server pack in `hub/_authoring/templates/`:

- `hub/_authoring/templates/skill/`: Standalone skill with house conventions and triggers.
- `hub/_authoring/templates/agent/`: Standalone agent using strict v1 fields, `skills: []`, and `audience: custom`.
- `hub/_authoring/templates/prompt/`: Parameterized prompt with path-derived invocation (`/<name>`) and `$ARGUMENTS` expansion.
- `hub/_authoring/templates/playbook/`: Multi-agent coordination playbook with a valid DAG and documented prerequisites.
- `hub/_authoring/templates/plugin/`: Plugin showing an agent binding a contained skill, prompts, and supporting assets.
- `hub/_authoring/templates/server/`: Server pack whose `mcp.json` launches a dependency-free Node MCP server with one read tool.

Templates are reference models: `pnpm run hub:pin` validates them and leaves them out of `hub/index.yaml`. Follow this unified contributor journey:

1. **Choose package kind**: Decide whether your package is a single-kind package (`skill`, `agent`, `prompt`, `playbook`) exposing exactly one public component, or a composite `plugin` combining multiple components. Code that changes PanCode is an extension, authored with `pancode extensions init` and the [extension API](sdk.md) instead.
2. **Copy authoring template**: Copy from `hub/_authoring/templates/<kind>/` into your project or repository.
3. **Author resources**: Single-kind packages expose exactly one public resource file in their declared resource directory. Packages may carry explicitly invoked scripts (for example for offline evaluation or verification tasks); these are declared metadata and are strictly distinct from extensions, which run code with hooks and runtime tools.
4. **Validate**: Run `pancode hub validate ./lab-research --json` to verify manifest schemas, resource payloads, reference syntax, and loadability.
5. **Pin and check**: Maintainers run `pnpm run hub:pin` and `pnpm run hub:check` to refresh and verify full-tree distribution pins, which also refreshes the normalized skill evidence. The registry files and pin stages are described in [PanHub](panhub.md#registry-and-pins).
6. **Try in an isolated project**: Register locally with `pancode hub register ./lab-research --project`. Registration writes identity, version, source, and full-tree SHA-256 into the scoped `hub.yaml` without installing. Preview and install with `hub install plugin:lab-research --project --dry-run`, then `hub install plugin:lab-research --project`. An operator install into new or already trusted project state can approve the identities it wrote. Identical reinstalls, disables and removals preserve consent; an unapproved identity needs `pancode config trust plugins`. See [project package trust](panhub.md#workspace-trust-for-project-packages). Test invocation through `/skill <name>`, `/run`, prompt slash commands, or `/fleet run <playbook>`.
7. **Submit it to PanHub**: For a first-party pack, push your topic branch to your fork and submit a PR against the current development version branch. A pack that lives in its own repository is submitted as one row file; see [Community packs](panhub.md#community-packs).
