# Configuration, Targets, Runtimes, and Auth

PanCode talks to models through targets. A target is a saved model connection: a provider API, a subscription sign-in, a model server on your machine or a compute node, or a lab gateway, with its address, credential and default model. Use this guide to connect a model, choose which targets answer chat and run workers, and change saved settings. It also lists every setting with its default and when a change takes effect.

The exact contracts live in source: [settings](../../src/core/defaults.ts), [validation](../../src/core/settings-validate.ts), [target descriptors](../../src/domains/providers/types/target-descriptor.ts), and the [runtime registry](../../src/domains/providers/runtimes/builtins.ts).

## Start here

| Task | Entry point |
| --- | --- |
| Connect a model | [First-run flow](#first-run-flow), or `pancode configure --quick` when you already know the endpoint |
| Use a model running on your own machine or a compute node | [Use a local model server](#use-a-local-model-server) |
| Understand how an existing home picks a chat route | [Chat route detection](#chat-route-detection) |
| Apply a lab or site setup file | [Setup files](#setup-files): `pancode configure --import <path-or-https-url>` |
| Edit saved settings | `pancode configure --settings` or TUI `/settings`; TUI `/config` opens Connections, where **Add a target** or **Connect by URL** adds one |
| Inspect or probe targets | `pancode targets` |
| Check a model list | `pancode models --target <id>` |
| Make a target report cost | [Pricing and cost provenance](#pricing-and-cost-provenance) |
| Find exact keys, flags, and project file owners | [Configuration reference](configuration-reference.md) |
| Troubleshoot startup and provider errors | [Troubleshooting checklist](#troubleshooting-checklist) |

## Use a local model server

1. Start the server and load a model that can call tools: LM Studio, Ollama,
   llama.cpp, vLLM, SGLang or Lemonade. PanCode works only through tools,
   so a model without tool calling cannot read a file or run a command.
2. Run `pancode`. On a new home it looks for a server on its default port
   (LM Studio 1234, Ollama 11434, llama.cpp 8080, vLLM 8000, SGLang 30000)
   and offers it, for example `A model server at http://127.0.0.1:11434 (Ollama)`.
   Choose it. PanCode sends one short test request and saves when the model
   answers.
3. On another address or port, run `pancode configure`, choose
   **A model server or gateway** and give its address.
4. Run `pancode doctor`. Its `chat` row should end in `endpoint reachable`.
   `pancode targets --probe --tools --target <id>` sends a test that shows
   whether the model really calls tools.

The context window comes from the server where it reports one; see
[Context-window provenance](#context-window-provenance).

## Directory locations

### Where does settings.yaml live?

User `settings.yaml` lives in the config directory; run `pancode paths --json` to find its location on this machine.

`pancode paths --json` prints the resolved config, data, state, and cache directories. `PANCODE_HOME` sets a shared root; `PANCODE_CONFIG_DIR`, `PANCODE_DATA_DIR`, `PANCODE_STATE_DIR`, and `PANCODE_CACHE_DIR` override individual roots. See the [environment reference](environment-variables.md) and [directory resolver](../../src/core/xdg.ts).

User settings are stored at `<configDir>/settings.yaml`. Project layers are `.pancode/settings.yaml` and `.pancode/settings.local.yaml`. Later layers win: built-in defaults, then the user file, then the project file, then the local file, then CLI flags. Inside a Git repository these files apply from any subdirectory: each project entry comes from the nearest `.pancode/` that has it, up to the repository root, and a new one is written at the root. Outside a repository only the working directory counts. `.pancode/verifiers.yaml` and generated files stay with the working directory.

## First-run flow

For terminal setup, run `pancode configure` or start `pancode` in a new home. An interactive start whose home has no chosen model runs setup before anything else, including the question about opening a home or system folder; after setup in such a folder that question offers **Exit, then cd into a project and run pancode** first and **Open this folder anyway** second. An existing home with no chat route first tries [chat route detection](#chat-route-detection) and starts configure only when nothing is detected. A saved chat route that cannot be used is kept, and startup says what to fix. For setup in the desktop app, run `pancode gui --open` and use **Guided setup** on the home page; a prior configure run is optional. Both presentations run the same connection wizard.

The first question is **What do you have?**: **An API key**, **A subscription** (ChatGPT Plus or Pro, Claude Pro or Max, GitHub Copilot), **A model server or gateway**, or **A setup file from my lab or team** (see [Setup files](#setup-files)). PanCode chooses a unique internal connection id and fills known local addresses. An installed coding agent is a separate worker-only choice when adding another connection with `configure`; first-run setup does not ask for one.

1. Provide what the row asks for. A pasted API key names its provider from the key's prefix (`sk-ant-` is Anthropic, for example) and PanCode asks which provider only when the prefix is shared or unknown. A subscription signs in: a browser opens on a desktop, and over SSH or without a display a link and a code are printed. A model server asks for its address.
2. For a model server or gateway, PanCode performs a passive reachability and model-list probe; this sends no generation request. A key or subscription provider gets no passive check.
3. PanCode picks the model: the provider's recommended model when its catalog lists one, otherwise the only model a server lists; when a server lists several and none is recommended, you pick from the list. If a discoverable endpoint returns no models, start the server or load a model and choose **Check again**. Typing an unverified wire id is an explicitly advanced fallback.
4. Test. PanCode sends the model one short test request and saves when it answers: `Testing <target> / <model> ... answered in <t> s.`, then `Saved. Chat and workers use this model. Change it any time with /model or /config.` A failure shows the provider's message and one fix, with **Try again**, **Change the key or address**, **Save anyway** (saved as not checked) and **Connection and machine details**. That last row opens the review: reachable, live model discovery, catalog/cache fallback and facts not checked, **Choose a different model**, and usable CPUs, available memory and automatic local-worker sizing; its **Save target** sends the test again. With `--no-verify` setup ends on that review instead.
5. The first connection becomes the chat and fleet model; shipped defaults handle the remaining settings.

When PanCode finds a route before asking (a provider key in the environment, a sign-in or key it stored, a saved target, or a model server on a default loopback port), the first screen is **PanCode found a way to reach a model:** with one row per route, such as `Anthropic, with the key in ANTHROPIC_API_KEY` or `A model server at http://127.0.0.1:11434 (Ollama)`, and **Set up something else**. Choosing one skips the provider, address and credential steps and goes to the test request, or to the model step when the detection carried no model. The detection rules are in [Chat route detection](#chat-route-detection).

When setup still needs something, PanCode says it the same way everywhere (startup, `doctor`, `run`, the footer and the desktop app): one sentence naming what is missing, followed by the command that fixes it, for example `openai has no key or sign-in stored. Run: pancode auth login openai`. In the terminal app the footer and a failed prompt add `(or press Enter on /config)` to a missing sign-in. A chat target at an address a project's settings chose gets none of your keys, so its sentence says to define the target in your user settings with its own key variable (`auth.apiKeyEnvVar`) instead of naming a login. It never suggests a well-known variable such as `OPENAI_API_KEY`, since the project picked the address.

`pancode configure --quick` retains the URL-first shortcut. It identifies compatible local runtimes where possible, requires live model discovery, and is intended for users who already know the endpoint.

For saved defaults use `pancode configure --settings`. Each area shows its complete setting catalog in one grouped menu; uncommon controls are not hidden behind a second page. Chat, fleet, and proactive-memory routes select a connection and then offer its discovered/catalog models instead of asking for a handwritten model id. **Use connection default** keeps inheritance, so later changes to that connection’s default also apply to the route. Proactive memory's connection picker offers **Chat route (no memory model set)**, which runs the memory tier on the active chat route. Turn proactive memory off to stop its background model calls. Jump to an area with `pancode configure --section models|chat|workers|context|safety|workspace|advanced`; no other name opens one. Runtime IDs available in the installed build come from `pancode configure --list`.

## Setup files

A lab, site or team can publish one YAML file that connects PanCode to its models. `pancode configure --import <path-or-https-url>` reads it, prints where prompts will go, asks once, and saves it; first-run setup offers the same as **A setup file from my lab or team**.

```yaml
# lab-pancode.yaml
notes: "Lab gateway. Ask #research-computing for a key; export it as LAB_API_KEY."
targets:
  - id: lab
    runtime: openai-compat
    url: https://llm.lab.example.org/v1
    defaultModel: qwen3-coder-480b
    capabilities: { contextWindow: 131072 }
    auth: { apiKeyEnvVar: LAB_API_KEY }
chat: { target: lab }
fleet: { target: lab, model: qwen3-coder-480b }
```

- A file may hold only `targets`, `chat`, `fleet` and `notes`. Each target may hold only `id`, `runtime`, `url`, `defaultModel`, `wireModels`, `capabilities`, `pricing` and `auth` with `apiKeyEnvVar` or `oauthProfile`; `chat` and `fleet` hold `target` (a target in the file) and an optional `model`. Any other key, such as a literal key (`auth.apiKey`), request `headers` or `safety` settings, refuses the whole file and names the key, so a setup file never carries a secret or changes what PanCode may do.
- The preview lists each target's address, model and key source, and warns `warning: <id> uses plain http to a public address; prompts and keys cross the network unencrypted` for plain `http` to a host that is not loopback or a private IP address (a cluster hostname such as `gpu-node-07` gets the warning too).
- On a terminal it asks `Apply these changes? [y/N]`. `--yes` applies without asking, for scripts; without a terminal and without `--yes` it prints the import preview, then exits 2 without applying it.
- A target with the same id and different settings is refused unless `--replace` is given. Importing a file that is already saved changes nothing and exits 0.
- Only the named targets and routes change; other settings, project settings and stored credentials stay as they are. After saving, PanCode prints one line per target saying whether it is ready or what is missing, such as a key variable not set in this shell.
- A URL must be `https` (a redirect to anything else is refused); the file may be at most 64 KiB, and the fetch uses the proxy the environment names.

## Chat route detection

A bare `pancode` start in an interactive terminal checks the saved chat route before the TUI boots. Headless `run`, ACP and non-TTY starts never detect or configure, unless `PANCODE_INTERACTIVE=1` forces interactive mode. The check is `classifyDefaultTarget` in [`src/cli/default-target.ts`](../../src/cli/default-target.ts), a credential-presence check that does no network work. Its verdict is `usable`, `no-target`, `no-model`, `ineligible-runtime` (the target's runtime is not an HTTP runtime) or `missing-credential`. A user whose route is `usable` pays nothing for what follows.

| Home state | Verdict | What the start does |
| --- | --- | --- |
| New: `settings.yaml` is missing or names no target and no chat route (as the installer leaves it) | not usable | Skips detection and runs `pancode configure`, whose wizard lists detected routes first. |
| Existing | `usable` | Boots with the saved route. |
| Existing | `no-target`: no chat route is saved, or the saved one names a target that no longer exists | Runs detection. The first detected route that carries a model is used and the start continues without configure; a model server found on a loopback port is used only after a yes (on Linux the question names the listener's owner and defaults to no when another user owns it). With none, configure runs as for a new home. |
| Existing | `missing-credential` | Opens with the saved route and prints `Chat: <target> / <model> is unavailable. <what is missing> Your saved chat route is kept.`, where the middle sentence names what is missing and the command that fixes it. No other target is used. |
| Existing | `no-model` or `ineligible-runtime` | Prints what is wrong, then `` Your saved chat route is kept and no other target is used. Run `pancode configure` to fix it. ``, and exits 2. |

[`detectChatRoutes`](../../src/cli/detect-chat-routes.ts) considers only HTTP runtimes that offer chat and can drive the main agent. It collects routes in this order, and the startup path takes the first one that has a model:

1. Usable configured targets. A target counts when its runtime is eligible and, if it needs a credential, one is present. Its model is its `defaultModel`, else the runtime's curated model.
2. Runtime-declared environment keys. A runtime with `credentialsEnvVar` (for example `OPENAI_API_KEY`) and a nonempty variable yields a route whose target reads that variable with `auth.apiKeyEnvVar`, so no key is stored. Gateway runtimes that need an operator-supplied URL, such as `alcf`, are skipped.
3. PanCode's own stored logins. A `credentials.yaml` entry for an eligible runtime counts when its type matches the runtime's auth: an OAuth login for an OAuth runtime, an API key for an API-key runtime. The target references the stored credential with `auth.oauthProfile` or `auth.apiKeyRef`.
4. A GitHub Copilot login, when no `copilot-sdk` target is configured and the Copilot SDK component is installed. PanCode asks the runtime for the account and its model list, allows 3 seconds for the answer, and takes `gpt-6-luna` when the account lists it, else the first listed model ([GitHub Copilot](#github-copilot)).
5. Local servers on the default loopback ports. PanCode asks `http://127.0.0.1:<port>/v1/models`, or `/api/tags` for Ollama, under one shared 400 ms deadline. It follows no redirects, sends no credentials, reads at most 1 MiB of an answer, and takes the first model the server lists whose id holds no control or format characters. The ports are `llamacpp` 8080, `lmstudio` 1234, `ollama` 11434, `vllm` 8000, `sglang` 30000, `litellm` 4000, and 8000 for `lemonade`, `openai-compat` and `anthropic-compat`.

The curated model of a route found through steps 1 to 3 is the runtime's `defaultModel`, which is `gpt-6-luna` for `openai` and `openai-codex` and `mercury-3` for `inception`; else a recommended model PanCode names for providers whose models come from the Pi catalog (`claude-sonnet-5-5` for `anthropic` and `anthropic-max`, `deepseek-v4-pro` for `deepseek`, `gemini-3.8-flash` for `google`, `openai/gpt-oss-120b` for `groq`, `devstral-latest` for `mistral`, `anthropic/claude-sonnet-5.5` for `openrouter`) when the catalog lists it; else the first id of a model list the runtime owns. A runtime with none of these has no curated model, because catalog order is alphabetical and recommends nothing. Its route is listed in the wizard with `choose a model next` and skipped by the startup pick.

[`useDetectedChatRoute`](../../src/cli/detect-chat-routes.ts) applies the pick and prints `Chat: <runtime> / <model> from <source>. Change it with /config.` It writes the target and the chat route to the user `settings.yaml` only when no chat route exists: `chat.target` is empty in memory and absent from the saved file. A saved `chat.target` is the user's choice even when it cannot be used now, so a missing credential, a missing model or a runtime that cannot drive the main agent never starts detection (see the table above). The one saved value that does reach detection is a `chat.target` naming a target that is no longer configured, because settings normalization clears it to empty. The detected route then applies to this session alone, the saved value stays as written, and the notice adds `Session only; saved chat route unchanged.` A configured route is never overwritten. Detection skips the target dedicated to background memory, by id or by URL, because nobody chose it as a chat route.

## Advanced settings

Configure, desktop app Settings and TUI `/settings` share one set of areas; the TUI adds **Recent & Pinned** in front. The desktop app hides or identifies controls specific to terminal presentation. The areas are:

| Area | Owns |
| --- | --- |
| Models | Connections, the chat model, reasoning and length, speed, quick switching, model tiers |
| Chat and display | Output detail, streaming, alerts, retries, transcript, guidance, updates |
| Workers | Worker defaults, profiles, agent routes, routing, machines, limits, run history, loops |
| Context and memory | Compaction, working-set eviction, memory, semantic search |
| Safety and limits | Autonomy, safety judge, approvals, sandbox, review, spending and tool limits |
| Workspace | Panes, files, Git, task copies, PanStore, PanHub, external agents, plugins |
| Advanced | Setup tools (version, directories, Run doctor), timing and size limits, experimental engines, raw collections, and the validated full-file editor |

Settings YAML paths shown in the inventory below are canonical. Use [Configuration reference](configuration-reference.md) for the full settings-key/default map and the owning code for exact types.

## Strict validation and lifecycle repair

Settings use one strict version-2 schema. Unknown keys and invalid values stop startup with a path-specific diagnostic. Objects merge by key; arrays and scalars replace the lower layer. Project layers are read only after the workspace's project settings are trusted; until then PanCode ignores them and prints a notice, and `pancode config trust settings` shows the captured files and how to approve exactly those bytes. Workspace trust gates five more parts of a project the same way (`safety`, `hooks`, `extensions`, `plugins` and `handbook`); project extensions and PanHub packs load only after `pancode config trust extensions` or `plugins` approves their install state, as described in [Commands and modes](commands-and-modes.md). Credential-bearing keys (`auth`, `apiKey`, `token`, `secret`, `password`) in project layers are dropped with a diagnostic, except a target's `auth.apiKeyEnvVar`, which names a variable rather than holding a key: the trust card says the connection sends `$NAME` to its URL, and after trust that variable is the only credential sent there. A project `safety.autonomy` is kept only when it is no looser than the user's level, so it can tighten `yolo` to `default` and never the reverse; a looser value is dropped with a diagnostic. `safety.sandbox`, `safety.sandboxNetwork`, `safety.snapshots`, `fleet.permissions.mode` and every limit under `safety.limits` and `fleet.limits` follow the same rule, and `integrations.runtimePlugins` and `integrations.projectResources.trustProjectImports` are read from user settings only.

A version-1 `settings.yaml` is not read or converted; move it aside and the next run writes a short version-2 file that sets no keys, so every key keeps its built-in default. `pancode doctor --fix` repairs selected installation state. It also rewrites YAML 1.1 `on`/`off` booleans, preserving comments and formatting; plain `doctor` lists that repair without writing it. A key outside the current schema is reported as unknown, and `doctor --fix` never removes or renames it. See [settings validation](../../src/core/config.ts).

## Live routing vs saved defaults

Saved `chat.target`, `chat.model`, `chat.thinkingLevel`, `chat.modelPicker.cycleSet`, `fleet.default.target`, `.model` and `.thinkingLevel`, and `context.memory.target` and `.model` seed routing at session start. The active interactive session owns its current route. `/model`, `/thinking`, and `/settings` can change that route; choose apply-this-session, save for this project, or save globally where offered. Project saves write `.pancode/settings.local.yaml` and require existing project settings to be trusted; PanCode approves the exact bytes it writes. A write from another process updates saved defaults but does not redirect a running session. PanCode saves a setting by editing the YAML document in place, so a save changes only the keys that changed. Comments, blank lines, quoting (a quoted `'on'` stays quoted), flow style and list indentation elsewhere in the file are kept.

Other settings apply at the boundary shown in the inventory. The routing classifier is in [`src/core/settings-layers.ts`](../../src/core/settings-layers.ts) and [`src/core/settings-controls.ts`](../../src/core/settings-controls.ts).

## Settings Center

Open `/settings` in the TUI, `pancode configure --settings`, or Settings in the desktop app. The TUI command `/config` opens `/settings models` (see [commands and modes](commands-and-modes.md)). The TUI starts with **Recent & Pinned**, then seven areas: **Models**, **Chat and display**, **Workers**, **Context and memory**, **Safety and limits**, **Workspace**, and **Advanced**. Configure and the desktop app list the same seven areas. A connection is the provider/app/server entry stored as a `target`; the CLI's `targets` commands and the YAML keys keep that technical name.

Use **Models → Connections → Add a target** to reopen Guided setup inside the TUI. It runs the same setup flow as configure, including model inventories, passive checks, and review before Save. **Models → Chat model** selects the connection and model that answer you. **Workers → Default worker** selects the connection, model, and thinking level for delegated work; profiles and agent routes stay in Workers. **Safety and limits** opens with **Autonomy**, then **Safety judge**, worker approvals, **Sandbox**, review and spending/tool limits.

Each section keeps related controls together. Configure combines a route's connection and model into one guided action; the TUI offers separate connection and model pickers in the same group. Select **Use connection default** in a TUI or desktop app model picker to clear that route's model override. A blank override in the text fallback has the same meaning; a typed model id is unverified. **Context and memory → Proactive memory → Memory connection → Chat route (no memory model set)** clears the dedicated memory route, so the memory tier follows the active chat route. Turn proactive memory off to disable it.

In the TUI, use arrows to move, Enter to open, and `/` to filter by name or canonical key. On wide terminals, Tab switches between sections and their controls; narrow terminals show one level at a time. Esc goes back. Previewing a value does not save it. Edits offer this session, this project, global, or cancel when the control supports that scope. A **this session** choice belongs to the conversation that was open when it was made, and it is not saved to any file. Switching conversations swaps in that conversation's own choices. A choice made before the first message goes to the conversation that message creates, and resuming an existing conversation drops it. A fork starts from a copy of its parent's choices, and a resumed conversation gets the ones it kept. Startup flags such as `--autonomy` and `--demo` apply to every conversation. Project saves require trusted project settings. Restart-required controls explain that timing before saving; target and profile removal shows affected routes before confirmation.

Configure edits saved global defaults. It does not offer the TUI's session/project scope menu or redirect an already-running chat session. In **Advanced**, the TUI's **Check setup** row closes settings and runs `/doctor`, and **Edit settings file** opens your settings file or the project's in `$VISUAL` or `$EDITOR`, checks the draft when the editor exits, saves only a valid file and says which changes wait for a restart. Not every setting has a row in `/settings`: tuning constants, computed fingerprints, acceptance records, research telemetry flags and long lists live only in the file, where they keep working and still show in `pancode config inspect` and `pancode configure`.

In the desktop app, **Connections → Guided setup** runs the same connection wizard before or after opening a project, with the same labels for live, catalog and cached model evidence. Adding a connection, in the terminal `pancode configure` wizard, its settings menu, the terminal app's `/settings` and the desktop app, sends the model one short test request once the model is chosen and saves only after it answers; a failure shows the provider's message and one fix, with **Try again**, **Change the key or address**, **Save anyway** (saved as not checked) and **Connection and machine details** (the review, whose **Save target** tests again). `--no-verify` skips the request, and editing a connection sends none. The desktop app's first run lists the routes PanCode found, as the terminal's does, and both end on the same test message. When a terminal setup picks a key from an environment variable and the desktop app is installed, the passed test asks once whether to store the key for the app too, because the app's background service cannot see your shell's environment; **Yes, store it** writes a copy to `credentials.yaml` (mode 0600, unencrypted) under the variable's own entry, `env:<VAR>`, and the connection still reads the variable first. Only a connection naming that variable reads the copy, and only while the variable is unset, so the runtime's key from `auth login` and other connections of the same runtime are untouched; `pancode auth logout <target>` with the variable unset removes the copy. OAuth credentials are saved when sign-in succeeds, while connection settings wait for **Save target**, and adding or editing a connection preserves explicit chat, fleet and memory routes. Launch, cancellation, credential storage and project override behavior are described in the [desktop app guide](gui.md).

## Settings inventory

This inventory lists compiled defaults and selected optional settings in the version-2 schema. Validation is strict, but additional optional fields exist; see [optional keys](configuration-reference.md#optional-keys-with-no-default) and `src/core/settings-validate.ts` for the accepted schema. Any other key is rejected as unknown.

"When it applies" follows [`settingsChangeKind`](../../src/domains/config/classify.ts), whose three buckets the [configuration reference](configuration-reference.md#effect-timing) names hot reload, next turn and restart required. **Immediately** is hot reload: a running process observes the value without rebuilding runtime state. **Next turn** and **next dispatch** are the next-turn bucket, and current work finishes on the old value. **Next session** marks routing defaults copied into session-owned state at launch, which a later save does not push into a running session. **Restart** means process or pane-host setup must be rebuilt.

### Structural and target catalog

| Key | Default | When it applies |
| --- | --- | --- |
| `version` | `2` | restart |
| `turnControl.workflows` | `["detached-collection"]` | next turn |
| `targets` | `[]` | next turn for the catalog; next session for saved routing defaults |
| `targets[].contextTier` | absent (`default`) | next turn |
| `targets[].funding` | absent | next turn; optional user-only pool binding. A changed or unverified login invalidates detected evidence; declared facts do not authorize spending. |
| `funding` | `{}` | next turn; user-only pool definitions for reporting. Pools may describe payer, native unit, fee with ISO currency and period, grant with expiry, and active/idle watts and electricity rate per kWh. |
| `store.roots` | `[]` (one root under the data directory) | restart; user layer only. Each entry is `name`, an absolute `path`, `durable` (default `true`) and `purge` (free text or `null`); the first root holds records and locks and must be durable, and a root with `durable: false` takes only tags of class `cache`. |
| `store.placement.byTag` | `{}` | restart; user layer only. Tag name to root name for a tag not yet created; a tag never moves once created. |
| `store.placement.byClass` | `{}` | restart; user layer only. Tag class (`input`, `output`, `cache`, `archive`) to root name for a tag not yet created. |
| `store.projectId` | unset (the store is keyed by the main checkout's real path) | restart; the project's tracked `.pancode/settings.yaml` only, read while you trust the project's settings, and ignored with a settings issue elsewhere. 1 to 64 characters of `a-z`, `0-9`, `.`, `_` and `-`, starting with a letter or digit; the store is keyed by the id, so checkouts at different paths on different hosts reach one store ([Sharing a store across hosts](panstore.md#sharing-a-store-across-hosts)). |

### Chat

| Key | Default | When it applies |
| --- | --- | --- |
| `chat.target` | `null` | next session |
| `chat.model` | `null` | next session |
| `chat.thinkingLevel` | `low` | next session |
| `chat.modelPicker.cycleSet` | `[]` | immediately for this session; next session as the saved default |
| `chat.modelPicker.favorites` | `[]` | immediately |
| `chat.modelPicker.recentLimit` | `12` | immediately |
| `chat.maxOutputTokens` | `0` | next turn |
| `chat.prewarm` | `false` | next turn |
| `chat.cacheKeepalive` | `true` | immediately; see [prompt cache retention and keepalive](../architecture/model-catalog.md#prompt-cache-retention-and-keepalive) |
| `chat.loopsUntilStopped` | `false` | immediately; read when a loop or job is created |
| `chat.retry.enabled` | `true` | next turn |
| `chat.retry.maxRetries` | `3` | next turn |
| `chat.retry.baseDelayMs` | `2000` | next turn |
| `chat.retry.maxDelayMs` | `60000` | next turn |
| `chat.retry.streamStallMs` | `180000` | next turn |
| `chat.retry.firstTokenStallMs` | `600000` | next turn; local and self-hosted endpoints only, because a hosted (cloud or subscription) route aborts a call with no first token after `chat.retry.streamStallMs`, or sooner once it has shown 5 first tokens in the running process: max(30 s, 10 times their p95), never past `chat.retry.streamStallMs` |
| `chat.steering.triage.enabled` | `false` | next turn |
| `chat.steering.triage.target` | `null` | next turn |
| `chat.steering.triage.model` | `null` | next turn |
| `chat.steering.triage.thinkingLevel` | `off` | next turn |
| `chat.steering.triage.minQueued` | `2` | next turn |
| `chat.steering.triage.timeoutMs` | `8000` | next turn |
| `chat.steering.triage.autoInterrupt` | `true` | next turn |

### Configure a different model for workers

To configure a different model for workers, open `/settings` and choose
**Workers**, then **Default worker**, which sets `fleet.default.target` and
`fleet.default.model`. For a
saved route, use `pancode targets profile` to bind a worker or agent to a
profile. These values affect dispatch as shown in the table below; they do not
change the current chat model. The [fleet dispatch guide](fleet-dispatch.md)
explains worker route selection.

### Fleet

`fleet.rosters.<name>.members` contains two to five members. Each member has a unique `label`, a `target`, and optional `model`, `thinkingLevel`, `color`, and `agent` (the agent recipe the member runs as in a council; a council run refuses an id no installed agent has). `fleet.agentProfiles` is the persisted agent-id-to-profile map.

| Key | Default | When it applies |
| --- | --- | --- |
| `fleet.default.target` | `null` | next dispatch |
| `fleet.default.model` | `null` | next dispatch |
| `fleet.default.thinkingLevel` | `off` | next dispatch |
| `fleet.profiles` | `{}` | next dispatch |
| `fleet.rosters` | `{}` | next dispatch |
| `fleet.agentProfiles` | `{}` | next dispatch |
| `fleet.defaultNode` | `null` | next dispatch |
| `fleet.default.node` | unset | next dispatch |
| `fleet.nodes` | `[]` | next dispatch |
| `fleet.adaptiveRouting.roles` | `[]` | next dispatch |
| `fleet.adaptiveRouting.postures` | `[]` | next dispatch |
| `fleet.adaptiveRouting.agentRoles` | `[]` | next dispatch |
| `fleet.permissions.mode` | `judge` | next dispatch; `judge` hands a native local worker's ordinary ask to the main session's safety judge at autonomy `default` and runs as `deny` elsewhere; a project layer can only tighten it |
| `fleet.permissions.escalation.timeoutMs` | `120000` | next dispatch |
| `fleet.permissions.escalation.fallback` | `deny` | next dispatch |
| `fleet.concurrency` | `auto` | restart |
| `fleet.staggerSharedPrefix` | `true` | next dispatch; held workers start after the leader streams (at most 15 s); batch handles return at once; a held worker's run row records the dispatching session's pid until its own process starts, so another session's recovery does not settle it; it publishes `run.enqueued` at admission and `run.started` once its process is live, and joins its batch's agent board then; members of a batch with an agent board share a prefix, since the board rides after it |
| `fleet.keepPeerInstructionFiles` | `[]` | next dispatch; runtime ids of delegated harnesses that read their own instruction files beside the compiled rules |
| `fleet.retry.maxRetries` | `2` | next dispatch |
| `fleet.retry.routeCooldownMs` | `15000` | next dispatch |
| `fleet.retry.breakerThreshold` | `1` | next dispatch |
| `fleet.worktrees.root` | `disk` | next dispatch |
| `fleet.limits.toolCallsPerRun` | `300` | next dispatch; a project layer can only tighten it |
| `fleet.limits.runTimeoutMs` | `1800000` | next dispatch; a project layer can only tighten it |
| `fleet.limits.internalRunTimeoutMs` | `2700000` | next dispatch; a project layer can only tighten it |
| `fleet.history.maxRuns` | `1000` | next dispatch |
| `fleet.history.journal` | `true` | next dispatch |

### Context

| Key | Default | When it applies |
| --- | --- | --- |
| `context.toolResultMaxBytes` | `65536` | next turn; a live session change applies to the next tool result |
| `context.workingSet.enabled` | `true` | next turn |
| `context.workingSet.policy` | `structural-v2` | next turn |
| `context.workingSet.profile` | `default` | next turn |
| `context.workingSet.target` | `0.6` | next turn |
| `context.workingSet.protectLastTurns` | `6` | next turn |
| `context.workingSet.protectLastSteps` | `8` | next turn |
| `context.workingSet.minEvictableTokens` | `200` | next turn |
| `context.workingSet.rearmFraction` | `0.1` | next turn |
| `context.compaction.auto` | `true` | next turn |
| `context.compaction.threshold` | `0.8` | next turn |
| `context.compaction.maxTokens` | `400000` | immediately |
| `context.compaction.provider` | `off` | immediately |
| `context.compaction.model` | unset | next turn |
| `context.compaction.systemPrompt` | unset | next turn |
| `context.memory.enabled` | `true` | next turn |
| `context.memory.sideShare` | `0.15` | next turn; the side-share governor: after a session's first three automatic memory calls, a further one is skipped with `side_share` while settled memory output tokens, plus the output budget of each memory call in flight or settled without usage, exceed this share of settled main output tokens, and on a route that reports premium units also while memory premium units exceed this share of main ones; a zero main denominator admits only the three free calls. An operator-requested call (the classifier after a remember, `memory consolidate`) is never skipped. `0` turns the governor off. 0.15 is a design assumption, not a measured optimum, and the governor can refuse a call that would have helped |
| `context.memory.surfaces.correct` | `rules` | next turn; `rules` keeps the repeated-failure annotation and turn-end reminder with no model call, `model` adds the memory model step on two consecutive tool errors or a loop-guard block. |
| `context.memory.surfaces.bank` | `rules` | next turn; `rules` writes procedural entries from failures and knowledge from operator statements with no model call, `model` adds the memory model's bank maintenance every `context.memory.cadenceToolCalls` tools. |
| `context.memory.target` | `null` | next session |
| `context.memory.model` | `null` | next session |
| `context.memory.thinkingLevel` | `off` | next turn |
| `context.memory.cadenceToolCalls` | `10` | next turn |
| `context.memory.trajectorySteps` | `8` | next turn |
| `context.memory.maxOutputTokens` | `2000` | next turn |
| `context.memory.timeoutMs` | `60000` | next turn |
| `context.memory.surfaces.observe` | `off` | next turn; `on` prepares observation notes for the next compaction. Preparation runs only when the next automatic fold would send history to a separate summary request, starts within 0.15 of the window below the compaction trigger, and stops for the session after two committed folds in a row decline its notes for no gain |
| `context.memory.surfaces.delivery` | `decision` | next turn for reminders; the `# Memory` section of a running session keeps what it was compiled with. `off` delivers nothing from the store (`memory_recall` still does), `section` only the `# Memory` section, `decision` the section plus reminders at decision points (a failed command, a verification gap, a touched file, the turn's task), `broadcast` those plus the first-change broadcast of every pending lesson. Every lesson is checked when it is loaded for delivery: one whose command no longer resolves or whose quoted span left its file is withheld, and demoted unless an operator approved it |
| `context.memory.surfaces.lessons` | `agent` | next turn; `memory_note` is attached only to sessions that start under `agent`, so turning `agent` on reaches the tool after a restart, and an attached tool refuses from the next turn once the value changes. `agent` gives the main agent `memory_note`, whose command must have succeeded in the session and whose path must have been read there; a note with neither is kept for `memory_recall` only and is never promoted without the operator. `rules` files a failed command and the next success of the same program and operands that added or removed only bare options, with no workspace change between, as an unverified fix note (a `--flag=value` word is part of what runs, reordered options are the same command, and a help, version or always-succeeding command never pairs); that capture runs under every value but `off`. `side` adds the memory model's lesson pass and completion retention, armed only by such a pair and run at most once per turn. `off` writes nothing. |
| `context.memory.surfaces.history` | `off` | next turn; `on` lets the memory model mine this repository's earlier sessions for lessons while the session is idle, charged under `memory.history`. `pancode memory consolidate` is the separate, explicit, model-free pass. |
| `context.semantic.enabled` | `false` | next turn |
| `context.semantic.target` | `null` | next turn or semantic CLI request |
| `context.semantic.model` | `null` | next turn or semantic CLI request |
| `context.semantic.assetIdentity` | `null` | next turn or semantic CLI request; changing it selects a new index namespace |
| `context.semantic.projectorIdentity` | `null` | next turn or semantic CLI request; changing it selects a new index namespace |
| `context.semantic.canaryFingerprint` | `null` | next turn or semantic CLI request; set by qualification |
| `context.semantic.modalities` | `[text]` | next turn or semantic CLI request |
| `context.semantic.background` | `false` | next session |
| `context.semantic.inboxes` | `[]` | next turn or semantic CLI request; explicit registered roots only |

`context.compaction.maxTokens` is the working budget: an input ceiling that caps compaction on every route, chat and dispatched workers alike, whatever the model's window is, and it stands in for the window while the serving window is unknown. A model whose catalog price steps up above a token count lowers the effective ceiling to just under that boundary. `context.compaction.provider: native` uses Codex's own checkpoints on the `openai-codex` runtime and stores each one as a private file under `<stateDir>/provider-checkpoints/`; `off` keeps portable PanCode summaries. See [Threshold and ceiling compaction](../architecture/context-engine.md#threshold-and-ceiling-compaction).

Working-set eviction is the only stage before a summary, and `context.workingSet.enabled: false` turns it off. On a known window under 52,428 tokens, automatic eviction acts at the automatic compaction trigger, before any paid summary, and aims at the same share of the history above the system prompt and tool schemas as `context.workingSet.target` is of `context.compaction.threshold` (75% at the defaults). On those windows a compaction summary asks for at most 8,192 visible output tokens, or `chat.maxOutputTokens` when that is larger ([`pressure.ts`](../../src/domains/context/fold/pressure.ts)).

The compaction and memory controls serve different roles. An unset `context.compaction.model` uses active chat; an explicit model must uniquely resolve to an available eligible summary route or fail visibly. `context.compaction.systemPrompt` is a nonempty UTF-8 prompt file, at most 65,536 bytes, read at compaction time and resolved relative to the session workspace.

Configure `context.memory.target` and `context.memory.model` to give memory a dedicated route. With both unset, the memory tier runs on the active chat route and its calls are billed to the chat model; an explicit memory route still wins. Set `context.memory.enabled: false` to turn proactive memory off. Memory prefers its dedicated route and can use active chat when that route is unavailable and request capacity permits. Known dedicated saturation skips the step rather than initiating failover; neither routing choice edits saved settings.

### System One

System One is experimental and off by default, and its keys may change between releases. `systemOne.use` names one route or an ordered list of them: `jev`, `memory`, `main`, a declared engine or a target. A named route answers the `consult` tool, the judge screen and steering triage, so on a hosted route web and MCP result text leaves the machine at judge time. `systemOne.engines` maps a name you choose to `{ kind, target, model?, profile? }`, where `kind` is `systemone` or `llm`, `target` is a `targets[].id` and `profile` (the served model's capability profile, such as `julia-1`) applies only to `systemone`. The [System One guide](system-one.md) explains each key.

| Key | Default | When it applies |
| --- | --- | --- |
| `systemOne.use` | `null` | restart |
| `systemOne.engines` | `{}` | next turn |

### Safety

The safety-limit leaves have no one-process `PANCODE_*` overrides. Resolution follows the normal settings stack, from session or project layers where supported through user `settings.yaml`, then the compiled default. `safety.autonomy` is an operator choice: the user layer and operator session controls set it, and a project layer can only tighten it.

| Key | Default | When it applies |
| --- | --- | --- |
| `safety.autonomy` | `default` | immediately; user layer or operator session control, and a project layer can only tighten it |
| `safety.limits.sessionCostUsd` | `5` | immediately; a parked request re-reads it every 250 ms; a project layer can only tighten it |
| `safety.limits.chatToolCallsPerTurn` | `60` | next turn; a project layer can only tighten it |
| `safety.limits.readBytesPerCall` | `51200` | next turn; a project layer can only tighten it |
| `safety.limits.observationBytesPerTurn` | `196608` | next turn; a project layer can only tighten it |
| `safety.limits.templateToolCallsPerTurnMax` | `null` | next turn; a project layer can only lower it below the user value |
| `safety.limits.templateObservationBytesPerTurnMax` | `null` | next turn; a project layer can only lower it below the user value |
| `safety.limits.workerResponseSeconds` | `600` | next turn; a project layer can only tighten it |
| `safety.limits.autonomousToolCalls` | `600` | next turn; a project layer can only tighten it |
| `safety.limits.autonomousMinutes` | `120` | next turn; a project layer can only tighten it |
| `safety.limits.autonomousTokens` | `5000000` | next turn; a project layer can only tighten it |
| `safety.limits.bashIdleSeconds` | `0` | immediately; the next foreground bash call reads it; `0` is off; a project layer can only tighten it |
| `safety.review.enabled` | `false` | immediately; a project layer can only turn review on or lower the cadence |
| `safety.review.target` | unset | immediately |
| `safety.review.cadenceToolCalls` | unset | immediately; a project layer can only turn review on or lower the cadence |
| `safety.sandbox` | `auto` | next turn; `auto` runs native worker bash, run_script and verify, and the main session's bash, run_script and command-running verify checks at autonomy `default`, under bubblewrap on Linux when available, or under a `sandbox-exec` seatbelt profile on macOS, whose profile is unverified; `required` refuses worker commands without a sandbox and also sandboxes yolo commands; `off` never sandboxes; a project layer can only tighten it |
| `safety.sandboxNetwork` | `false` | next dispatch; `true` gives sandboxed worker commands network access, which workers holding `web_fetch` or `web_read` already get; a project layer can only set `false` |
| `safety.scratchRoots` | `[]` | immediately; user layer only; extra directories the main session's sandboxed commands and typed `write` and `edit` calls may write at autonomy `default` without asking, where its deletes run as they do in the workspace |
| `safety.sandboxPassEnv` | `[]` | immediately for the main session, next dispatch for workers; user layer only; environment variable names a sandboxed command keeps although they look like credentials, which the sandbox otherwise removes before the command starts; arena contenders also keep these names from your environment |
| `safety.liveCheckTargets` | `[]` | immediately; user layer only; target ids whose runtime's own login file the main session's sandboxed commands may read, read-only, so a live check of a candidate build can sign in; only `copilot-sdk` targets qualify, revealing `$COPILOT_HOME/config.json` (default `~/.copilot/config.json`); gh's token, the keychain and PanCode's credentials stay hidden, and dispatched workers and host verification keep every mask |
| `safety.sandboxUnixSockets` | `block` | immediately for the main session, next dispatch for workers; user layer only; `block` makes creating a Unix-domain socket fail inside the OS sandbox (a seccomp filter under bubblewrap, profile rules under the unverified seatbelt), because a socket a contained command reaches, such as tmux, an X11 display or a daemon's control socket, runs commands outside it; `owned` (bubblewrap only, Seatbelt blocks) hides only the sockets you own and leaves other users' reachable, such as the MUNGE, `sackd` and SSSD sockets cluster commands need, while abstract sockets and sockets created after the launch stay reachable too; `allow` leaves every socket reachable |
| `safety.sandboxCacheMaxGiB` | `4` | immediately; user layer only; GiB the main-session sandbox's tool cache `<cache dir>/sandbox-cache` may hold; once a day at startup, and on `pancode doctor --fix`, its least recently used top-level tool directories are removed until it fits, never while a running process that ran a contained command holds its lease under `<cache dir>/sandbox-cache-leases/`, and nothing outside the directory; `doctor` warns when it is over; `0` is no cap |
| `safety.snapshots` | `auto` | immediately; `auto` snapshots a Git work tree before each turn's first mutating call and before every destructive call, `off` takes none; a project layer can only set `auto` |
| `safety.validationWrappers` | `[]` | immediately for the main session, next dispatch for workers; wrapper scripts that run a check with the words after them: an entry with a slash matches that script path, a bare name its basename, and a command that starts with one (its own leading options skipped) counts as the check behind it, so `scripts/test-slot.sh pnpm run test:file x` is validation evidence; the whole command's exit decides pass or fail, and the call still counts as a workspace change, since the wrapper may write; the word must resolve (by path from the working directory, or a bare name on `PATH`) to a file; an entry naming a file writer, a shell, an interpreter or a word that runs no check of its words (`echo`, `printf`, `true`, `xargs`, `command`, `cat`, `sed`) is refused with an issue, and a word resolving to one never matches |
| `safety.unattendedAfterSeconds` | `300` | immediately; user layer only; seconds an attended permission card or ask_user round waits before PanCode denies the call or picks the recommended option (declining one that leaves the workspace); `0` waits forever, except a yolo question, which waits 300; an `operator_only` question always waits for the operator |
| `safety.yoloAccepted` | `false` | immediately; user layer only; set by the one-time card that turns yolo on interactively, and `false` shows the card again |
| `safety.yoloConfinement` | `contained` | immediately; user layer only; `contained` keeps default's sandbox, snapshots and safety judge at yolo and refuses what would wait for you, `unconfined` is the skip-permissions yolo and takes effect only with `safety.yoloUnconfinedAccepted` |
| `safety.yoloUnconfinedAccepted` | `false` | immediately; user layer only; set by the separate card that turns unconfined yolo on, or by hand; `false` keeps yolo contained |
| `safety.judge.enabled` | `true` | immediately; user layer only; at autonomy `default` a model reviews each main-session call that would park for approval against the operator's own messages, then runs it or refuses it with a reason; it also answers worker asks under `fleet.permissions.mode: judge` |
| `safety.judge.target` | `null` | immediately; user layer, or a trusted project naming a target the user layer declares; `null` asks the session's chat route |
| `safety.judge.model` | `null` | immediately; user layer, or a trusted project whose judge target the user layer declares; `null` asks the chat model, or the judge target's default model when `safety.judge.target` is set |
| `safety.judge.environment` | `[]` | immediately; user layer only; facts about the operator's environment the judge reads |
| `safety.judge.allow` | `[]` | immediately; user layer only; allow rules appended to the judge's defaults |
| `safety.judge.deny` | `[]` | immediately; user layer only; block rules appended to the judge's defaults |

On macOS, `sandbox-exec` provides a seatbelt backend when its probe succeeds. The profile exists but remains unverified on macOS, as the availability check reports. `required` refuses worker commands if the backend is unavailable.

Inside a container, bubblewrap must be installed in the image, and the container runtime must allow unprivileged user namespaces and mounts. Default Docker and Podman seccomp and AppArmor profiles usually forbid them; the availability check then reports `bubblewrap cannot create a sandbox here` and names the kernel or enclosing container as the cause. Under `required` every worker command is then refused. Run the container with a profile that permits the namespaces, or use `auto` and accept that commands run unsandboxed there.

### Interface

| Key | Default | When it applies |
| --- | --- | --- |
| `interface.terminalProgress` | `false` | next turn |
| `interface.demo` | `true` | tier-bounded welcome presentation, tips and optional footer learning immediately; prompt line next turn; pacing and motion independent |
| `interface.outputDetail` | `standard` | immediately; `compact` \| `standard` \| `detailed` |
| `interface.mode` | `regular` | restart |
| `interface.fullscreenScrollbar` | `auto` | restart |
| `interface.smoothStreaming` | `auto` | immediately |
| `interface.exitSummary` | `on` | immediately, at the next exit; `on` \| `off`, and `interface.outputDetail` sizes the summary |
| `interface.desktopNotifications` | `false` | next turn |
| `interface.autoUpdate` | `true` | immediately; `false` keeps the update notice and leaves the native background install and the after-quit npm, pnpm, Bun or Volta update to `pancode upgrade` |
| `interface.guiTurnCapacity` | `4` | next desktop app turn when changed in the app's settings; a change made elsewhere applies when the desktop app's server restarts. Range 1 to 16 |
| `interface.panes.notifications` | `failures` | immediately |
| `interface.panes.layout` | `off` | restart |
| `interface.panes.workers.ratio` | `0.34` | immediately on the next workers dock open |
| `interface.panes.files.enabled` | `false` | immediately on the next files-pane open |
| `interface.panes.files.mode` | `companion` | immediately on the next files-pane open |
| `interface.panes.files.profile` | `managed` | immediately on the next files-pane open |
| `interface.panes.files.followCwd` | `true` | immediately on the next files-pane open |
| `interface.panes.files.ratio` | `0.3` | immediately on the next files-pane open |
| `interface.keybindings` | `{}` | immediately |

### Integrations

| Key | Default | When it applies |
| --- | --- | --- |
| `integrations.projectResources.trustProjectImports` | `false` | next turn; user layer only |
| `integrations.externalAgents.entries` | `[]` | next dispatch |
| `integrations.externalAgents.defaults.connectTimeoutMs` | `30000` | next dispatch |
| `integrations.externalAgents.defaults.turnTimeoutMs` | `0` | next dispatch |
| `integrations.externalAgents.defaults.permissionTimeoutMs` | `120000` | next dispatch |
| `integrations.externalAgents.defaults.toolGovernance` | `pancode-policy` | next dispatch |
| `integrations.runtimePlugins` | `[]` | restart; user layer only; a bare npm package name or an absolute path under the config `runtimes/` directory, and relative paths are refused |
| `integrations.hub.catalog` | `null` (the catalog in the config directory) | next turn. Absolute path of the private catalog `pancode hub` reads; installed packs land in the usual skill and resource roots either way. |
| `integrations.hub.remote` | `null` (PanHub stays local) | next turn. Git URL of the remote named `hub` beside the user index that `hub sync` and `hub push` use; `pancode hub remote confirm <url>` records it when empty. |
| `integrations.hub.confirmedRemote` | `null` | next turn. The remote you approved with `pancode hub remote confirm <url>`; syncing is refused until it matches `integrations.hub.remote`. |
| `integrations.hub.sync` | `false` | next turn. When off, `hub sync` and `hub push` stop before contacting the remote. See [PanHub](panhub.md). |
| `integrations.hub.index` | `https://github.com/akougkas/pancode/releases/download/hub-index/` | immediately, at the next refresh; the base URL of the signed PanHub index (`https://`, `file://`, or `http://` on loopback only), or blank to turn the remote index off; unused in 0.9.0, which has no root key |
| `integrations.git.commitAttribution` | `true` | immediately for subsequent commits |
| `integrations.git.commitAuthor` | `auto` | immediately for subsequent commits |
| `integrations.music.enabled` | `false` | immediately, at the next `/music` |
| `integrations.music.station` | `http://radio.cliamp.stream/lofi/stream` | immediately, at the next `/music` |
| `integrations.music.agentControl` | `false` | restart |

### Telemetry

`telemetry.mode` sets what each scope's telemetry journal admits. `standard`, the default, keeps accountability and operational records, all of them content-free or structural. `research` also admits the research-tier records that the `telemetry.research` flags turn on, and `content` additionally needs the operator's consent for the workspace. In this build `content` keeps the text of each distinct compiled system prompt, each main-loop and side call's provider request body (only its first 1 MiB when larger), and the prompts, replies and facts of background memory and compaction steps as `memory.traced` and `memory.observed` records, with the text in the session's telemetry `objects/` directory; `busTrace` journals a `bus.traced` record naming each live event the telemetry hub delivers; `deltas` keeps each provider call's streaming timing as one record: its delta count, a histogram of the gaps between deltas, the longest gap and the first-to-last span, with no streamed text; `providerHeaders` keeps a call's response status and its allow-listed rate-limit, quota, request-id and server-timing response headers, each value cut to 256 characters, and never cookies, auth echoes or any other header. Content capture runs only in a workspace the operator consented for with `pancode telemetry consent`, which records the consent in PanCode's state directory and never in the workspace; `--revoke` ends it from the session's next call. A session's research capture stops at 256 MiB, and a `journal.gap` record marks what was refused. Every journal segment header records the mode and the effective flags, and a change starts a new segment at the journal's next write. A project or local layer can lower capture but never raise it above user settings.

| Key | Default | When it applies |
| --- | --- | --- |
| `telemetry.mode` | `standard` | next turn; a running worker keeps its mode, and a project layer can only lower it |
| `telemetry.research.content` | `false` | next turn, in research mode with workspace consent |
| `telemetry.research.deltas` | `true` | next turn, in research mode |
| `telemetry.research.providerHeaders` | `true` | next turn, in research mode |
| `telemetry.research.busTrace` | `false` | next turn, in research mode |

### Reports

`report.offers` decides whether PanCode may suggest `/report` after one of its own failures, such as an internal error or a crash in an earlier session. `ask` allows at most one suggestion a session and one a week, and never again for a problem the operator declined; `off` never suggests. PanCode never sends a report on its own.

| Key | Default | When it applies |
| --- | --- | --- |
| `report.offers` | `ask` | immediately |

### Prompts

`prompts.profile` selects the main agent's system prompt text: `v1` is the current text, `v2` an experimental leaner text. Workers follow it for their operating contract.

| Key | Default | When it applies |
| --- | --- | --- |
| `prompts.profile` | `v1` | next turn |

### Model tiers

Each model gets a tier, `small`, `standard` or `frontier`, that says how much scaffolding a prompt should give it. Hooks read it as `model.tier` ([extension hooks](harness-extensions.md#runtime-api-2)) and prompt templates pick a body by it ([variants](extensions-and-sharing.md#variants-per-model-tier)). Nothing in the system prompt reads it, so a tier never changes a cached prefix.

Turn policy and context also consume the resolved tier without changing that
prefix. A template's `turnPolicy.when` admits the matching `small`, `standard`
or `frontier` token at the start of each turn
([turn-constraints.ts](../../src/core/turn-constraints.ts)); the superseded
stage runs on routes that do not cache prompts, whatever their tier
([superseded stage](../architecture/context-engine.md#superseded-stage-s0)).
The separate `uncached` token tests the route's `promptCaching: false` fact.
Consequently a model switch can activate step turns and the superseded stage on
the next turn while leaving the template bytes and system-prompt shape alone.

`models.<id>.tier` sets the tier for one model, keyed by the wire model id; `models` takes no other field. In `/settings` the map is under **Model tiers**.

```yaml
models:
  qwen3-32b:
    tier: small
```

An unlisted model gets its tier from the first of these rules that applies:

1. A known context window under 32,768 tokens is `small`.
2. A parameter count in the model id decides next: under 20B is `small`, 20B and up is `standard`. A size hint never makes a model `frontier`.
3. A cloud or subscription model in the model catalog with a window of at least 128,000 tokens is `frontier`, unless its id names a reduced variant (`mini`, `nano`, `haiku`, `lite`, `small`, `tiny`), which stays `standard`.
4. Everything else is `standard`, including a local or protocol route with no size hint and a model whose window is unknown.

The tier settles once per model in a process, so it never changes under a running session, and a change to `models` applies after a restart. A model first resolved before its context window was known stays `standard` until then.

| Key | Default | When it applies |
| --- | --- | --- |
| `models` | `{}` | restart |

---

## Configure targets

### What is a target?

A target is a saved model connection: a named entry for one model provider or server. It combines a runtime, endpoint and authentication with model defaults; a model ID alone does not describe that connection.

In the TUI, open `/settings models`, choose **Add a target**, or open a connection and choose **Edit URL, runtime and default model**. **Connect by URL** asks only for an endpoint URL, a key when the endpoint needs one, and a model from its live list; it saves the connection and makes that model the chat model. The configure wizard runs in the composer dock, with the same probing, model validation and review-before-save behavior. Enter advances, Esc goes back, and Ctrl+C cancels target setup. **Save target** writes global target settings and keeps explicit chat, fleet and memory route defaults. Browser sign-in stores credentials immediately; other target settings wait for Save.

Use guided `pancode configure` for source-led setup, `pancode configure --quick` for the URL-first shortcut, `pancode configure --section models` for the target console. The non-interactive flags are documented by `pancode configure --help` and parsed in [`src/cli/configure-args.ts`](../../src/cli/configure-args.ts) and applied in [`src/cli/configure-target-setup.ts`](../../src/cli/configure-target-setup.ts).

A target binds an id to a registered runtime, endpoint/auth, model defaults, and optional capability or runtime-specific settings. Example user settings:

    version: 2
    targets:
      - id: lab
        runtime: openai-compat
        url: https://api.example.test/v1
        defaultModel: model-id
        auth:
          apiKeyEnvVar: OPENAI_API_KEY
    chat:
      target: lab

Keep credentials in user settings or the credential store. Project settings deliberately discard credential-bearing keys. A target that a project layer points at a URL is never sent your stored or environment keys, on turns, side calls, target probes or System One engines; the run fails naming why, and only a `--api-key` override still applies to it. A target naming `auth.apiKeyRef` reads from the environment only `auth.apiKeyEnvVar` or its runtime's own variable. A loopback URL is no exception when the target's runtime needs a credential; only runtimes that need none, such as Ollama, may point at loopback from a project.

A project `targets:` list replaces the whole list in your user settings; it is not merged entry by entry. Startup prints a `[pancode:config]` notice naming the project file, and `pancode doctor` shows it as a `project targets` row. Startup prints it once, including on the launch where you first trust that file. When that list redeclares a target your user settings give a credential (`auth.apiKeyRef`, `auth.oauthProfile` or `auth.apiKeyEnvVar`), the redeclared entry carries none of it. PanCode refuses the turn before any request and names the file. Remove `targets:` from that file, or give the target `auth.apiKeyEnvVar` there. A sign-in runtime such as GitHub Copilot reads no key variable, so for a target whose user entry names `auth.oauthProfile` or `auth.apiKeyRef` the only fix is removing `targets:` from that file. Only a runtime that does not require a credential sends PanCode's local placeholder key, and only for a target that declares no credential. A runtime that requires one, such as a cloud provider, reports the missing credential instead. When an endpoint refuses the placeholder key, the error says the target sends none. It points to `pancode configure --id <id>` for a target in your user settings. For a target a project file declares, it names `auth.apiKeyEnvVar` in that file, since `configure` edits only your user settings. A runtime that reads no key, such as native Ollama, gets neither fix. The error points to a route that sends a credential instead.

For ALCF, the `configure` wizard asks for a gateway URL and shows a
Sophia example because the endpoint varies by cluster or resource.
`gatewayUrlGuidance` in [configure-target.ts](../../src/cli/configure-target.ts)
provides that prompt. See the [ALCF provider contract](../architecture/alcf-provider.md#configure)
for the Sophia and Metis URLs and model IDs.

## Target management

| Command | Use |
| --- | --- |
| `pancode targets [--json] [--target <id>]` | List configured targets and status, or only one target. |
| `pancode targets --probe` | Probe configured endpoints and refresh discovery. With `--target <id>` it probes only that target. |
| `pancode targets use <id>` | Without role flags, set chat and fleet to the target default or shared `--model`; preserve memory. With `--orchestrator-model`, `--background-model`, `--fleet-target` or `--fleet-model`, change only the named roles. `--model` supplies a fallback only for a selected role that needs one. See [command contracts](commands-and-modes.md#cli-commands). |
| `pancode targets profile <subcommand>` | Use `list`, `set <name> <id> [--model] [--thinking]`, `remove <name> [--force]`, `rename`, `bind <agentId> <profileName>`, `unbind <agentId>`, or `bindings` for worker routes and agent bindings. |
| `pancode targets remove <id>`, `rename <old> <new>`, `convert <id> --runtime <runtimeId>` | Maintain target entries. `remove` also drops the key stored under the target's own key reference (`target:<id>`), because nothing can name that key once the target is gone, and the desktop app's stored copy of the key variable it names (`env:<VAR>`) once no remaining target names that variable. It keeps a runtime's own key and a key another target still reads, and its output line says which key it removed or kept. The desktop app's Connections remove runs this command. Settings → Connections → Remove target in the terminal app does the same when the removal is saved globally; a removal for this session or this project leaves the key. |

`targets --probe --reasoning` and `targets --probe --tools` (with optional `--tools-timeout <seconds>`) opt into generating qualification probes; they may load a local model. Use them only when that qualification is intended. Exact accepted flags and restrictions are printed by `pancode targets --help`.

## Context-window provenance

PanCode keeps the window a route serves apart from the maximum a model declares. The serving window bounds a session. A profile's `claims.modelMaxContext` and a row in Pi's model catalog are model maxima, and neither becomes an inference server's serving window. When a resident model's serving window differs from the target's model maximum, `pancode targets` names both, as in `ctx <serving> (serving; model max <maximum>)`.

`targets --json` reports `contextWindowProvenance` for the window of the target's default model, as defined in [`contract.ts`](../../src/domains/providers/contract.ts):

| Value | Meaning |
| --- | --- |
| `configured` | Set by `targets[].capabilities.contextWindow`. |
| `discovered` | Reported by the live endpoint for that exact model id. For `openai-codex` it is the window the Codex backend lists for the model. |
| `catalog` | Taken from Pi's catalog row for the model. It is an estimate, not a server report. |
| `runtime-default` | Nothing answered, so the number is the runtime's placeholder, which the text listing marks `unverified runtime default`. `openai-codex` reports `0` instead until its backend answers. |

A session plans against the serving window resolved on each turn by [`runtime-resolution.ts`](../../src/domains/providers/runtime-resolution.ts). `/context` labels its source as follows ([`context-overlay.ts`](../../src/interactive/context-overlay.ts)), and the footer's context page prints the raw source value:

| `/context` label | Source | Meaning |
| --- | --- | --- |
| `loaded window` | `loaded` | The backend reports the model open at this window. |
| `probed window` | `probe` | The target reported a route or model limit without resident instance state. A llama.cpp slot share shows as `<share> (<total> / <n> slots)`. |
| `configured window` | `target-override` | `targets[].capabilities.contextWindow`, a window sent with every request such as `ollama.numCtx`, or `--max-context-tokens` on interactive `pancode` or `pancode run`. A setting can lower a live limit but never raise it. |
| `catalog estimate window` | `catalog` | A cloud route whose runtime has no window endpoint. The window is the model maximum from its profile or Pi's catalog, labeled an estimate. |
| `context window unknown` | `unknown` | No live report or setting answered. |

Older session snapshots can carry `descriptor-default`, which `/context` shows as `assumed`.

Only a cloud route without a window endpoint plans a session against an estimate. Local servers, protocol endpoints such as `openai-compat` and `litellm`, and `openai-codex` before its backend answers have no fallback number. When no probe, loaded state or setting reports their window, it is unknown: `/context` shows `context window unknown` beside the estimated token count, the window-based compaction threshold has nothing to measure, and PanCode shows once per target and model `This model's context window is unknown, so PanCode compacts at its token budget instead. pancode configure can set the window.` Automatic compaction still fires when the request reaches `context.compaction.maxTokens`. Run `pancode targets --probe`, load the model, or set `targets[].capabilities.contextWindow` to the deployment's limit.

The server stays the authority on its own limit. When it rejects a chat request for exceeding its context window, PanCode compacts once and retries the request, whether or not the window or output limit is known ([`turn-recovery.ts`](../../src/session-control/turn-recovery.ts)). A second overflow is reported instead of retried. A worker makes one recovery attempt after a server overflow: it evicts reversible observations from its projected request and retries once when that shrinks the request enough ([`pressure.ts`](../../src/domains/context/worker/pressure.ts)). The worker's initial fork is never trimmed, and the attempt needs `context.compaction.auto` and `context.workingSet.enabled`; otherwise the server's error ends the run.

## Model profiles

The package ships [`models/profiles.yaml`](../../models/profiles.yaml), which describes what each known model is: capability flags, a declared context and output maximum, its thinking mechanism, and a recommended output budget. A profile describes the model, not a deployment, so it cannot set `contextWindow`, `maxTokens`, `reasoningLevels`, `thinkingControlRuntime` or `parallelSlots`; only a live server report supplies those. Loading, matching and validation are in [`model-profiles.ts`](../../src/domains/providers/model-profiles.ts).

A profile's `match` block selects models by id, ignoring case:

- `exactIds` compares the full model id, including a route prefix such as `lab/`.
- `familyPrefixes` compares the model name after its last `/`. A prefix matches that name exactly or when followed by `-`, `_`, `.` or `@`. Prefixes are literal, so `/` and regular-expression characters are rejected.
- `runtimeIds` limits the profile to those runtime ids. A profile without it applies on every runtime.

An exact match beats a prefix match, a longer match beats a shorter one, and a runtime-qualified profile beats an unqualified one. Two profiles still tied after those rules are an error.

Profile claims merge under live reports and target settings ([`capabilities.ts`](../../src/domains/providers/capabilities.ts)):

| Field | Precedence |
| --- | --- |
| `tools`, `vision`, `reasoning` | A live server report decides. A target's `capabilities` value of `false` can lower a reported `true`, but `true` never raises a reported `false`, and PanCode notes that the report stands. The profile fills the flag only when the server and the target are both silent. |
| Serving window and output cap | A live limit is the ceiling. `targets[].capabilities.contextWindow` and `maxTokens` can lower it, or stand alone when the server reports none. `claims.modelMaxContext` is never a serving window, and `claims.modelMaxOutput` ranks below server and target limits. |
| Other flags, such as `toolCallFormat`, `thinkingFormat` and `structuredOutputs` | The profile outranks the server's flag list, and a target's `capabilities` outranks the profile. A live report of no audio input still wins. |

When `chat.maxOutputTokens` is `0` and the request sets no limit, the profile's `recommendations.outputTokens` becomes the output budget, clamped to the model's output cap and the remaining window ([`output-budget.ts`](../../src/engine/apis/output-budget.ts)). Sampling presets come from the profile's `recommendations.sampling`; a profile without one takes the preset of the [`model-catalog.d` overlay](../architecture/model-catalog.md#local-catalog-overlays) entry whose `family` is the profile id.

Each request also holds back an output reserve from the window, and the automatic compaction trigger counts at least the reserve admission checks, so it fires before admission would refuse the next request. A configured `chat.maxOutputTokens` is reserved in full, up to the model's output cap; when the window cannot hold it, the refusal names `chat.maxOutputTokens` instead of shrinking it, and a refusal caused by a `--max-context-tokens` cap names that flag. Without one, the profile recommendation or the 32,768-token product default claims at most half the window, so a small `--max-context-tokens` cap still leaves room for input. On a window under 52,428 tokens with no `chat.maxOutputTokens`, the fit check and the worker guard reserve 8,192 output tokens instead of half the window. On a window of 52,428 tokens or more, transports that do not clamp output at the wire, such as Copilot, Anthropic and OpenAI Responses (every transport except OpenAI-compatible chat completions and native Ollama), reserve at most a quarter of the window and never under 16,384, so a 64K window triggers compaction at 49,152 tokens ([`output-budget.ts`](../../src/engine/apis/output-budget.ts), [`pressure.ts`](../../src/domains/context/fold/pressure.ts)).

`behavior.thinking` names the mechanism (`effort-levels`, `budget-tokens`, `on-off`, `always-on` or `none`) and, for `effort-levels`, the effort string each PanCode level sends in `effortByLevel`. Beyond `off`, the thinking picker offers only the mapped levels. The packaged Qwen3.8-27B (`qwen3.8-27b`) profile maps levels onto `low`, `medium` and `xhigh`, the only efforts its upstream chat template accepts. A requested `high` or `max` is sent as `xhigh`.

### User override file

`<configDir>/model-profiles.yaml` layers the operator's profiles over the packaged ones. It uses the packaged shape:

    version: 1
    models:
      - id: qwen3.8-27b
        claims:
          capabilities:
            vision: false
      - id: lab-coder
        match:
          familyPrefixes:
            - lab-coder
        claims:
          capabilities:
            tools: true
            toolCallFormat: openai

The first entry adjusts a packaged profile and the second adds one. An entry whose `id` names a packaged profile, ignoring case, merges onto it field by field: nested maps merge, while lists and scalar values replace the packaged value. An entry with a new `id` adds a profile and needs its own `match` with `exactIds` or `familyPrefixes`. An entry may set `id`, `match`, `claims` (`modelMaxContext`, `modelMaxOutput` and `capabilities`), `behavior`, `recommendations` and `provenance`. Capability fields are the booleans `chat`, `tools`, `reasoning`, `vision`, `audio`, `embeddings`, `rerank`, `fim` and `decisions`, and the enums `toolCallFormat`, `thinkingFormat` and `structuredOutputs`. Profile claims still rank below live reports as the table above describes.

A mistake in the override costs the smallest unit, and each is reported as a `[providers:profiles]` diagnostic naming the file and entry:

| Diagnostic | Effect |
| --- | --- |
| `<file> entry '<id>': <field> ignored, <problem>` | An unknown field, a live-only capability, or a wrong value type is dropped. The rest of the entry loads. |
| `<file> entry '<id>' skipped: <reason>` | The entry lacks a trimmed nonempty `id`, repeats an earlier override `id`, or fails validation after merging, for example a new profile without `match` or a prefix that is not literal. |
| `<file> ignored: <reason>` | The file does not parse, lacks `version: 1` and a `models` list, or has another top-level key. The packaged profiles still load. |
| `model profiles disabled: <reason>` | Two profiles claim the same exact id or prefix for the same runtime scope. Every profile is disabled, and PanCode runs as if no profile matched. |

PanCode reads both files at startup and rereads them whenever the `/model` overlay refreshes targets: when it opens, and on `r` or `R`.

## Target fields

A `targets[]` entry accepts `id` and `runtime` (both required), `url`, `auth`, `defaultModel`, `wireModels`, `capabilities`, `lifecycle`, `gateway`, `pricing`, `cache`, `lmstudio`, `litellm`, `ollama`, `maxConcurrentRequests`, `trustedUnmediated` and `contextTier`. Any other key is rejected. Target ids are unique. When `defaultModel` is omitted, the first `wireModels` entry is used.

`auth` takes `apiKeyEnvVar` (environment variable read per request), `apiKeyRef`, `oauthProfile` and `headers`. `capabilities` takes the booleans `chat`, `tools`, `reasoning`, `vision`, `audio`, `embeddings`, `rerank` and `fim`, the enums `toolCallFormat`, `thinkingFormat` and `structuredOutputs`, and the integers `contextWindow` and `maxTokens`. `gateway: true` marks the endpoint as a gateway. `pricing` is `free` or a rate map; see [pricing and cost provenance](#pricing-and-cost-provenance). `cache.retention` is `none`, `short` or `long`; `cache.deployment` binds the read-only control URL of a `llamacpp`, `vllm` or `lmstudio` deployment (`backend`, `controlUrl`, `model`, `build`, and an optional `gatewayDeploymentId`) so PanCode can observe its cache state; `cache.warm` bounds startup prewarm with `startup`, `maxInputTokens`, `maxDurationMs` and `cooldownMs`; an unset `maxInputTokens` allows 16,384 input tokens, or the model's context window when that is smaller, and 8,192 when the window is unknown. Startup prewarm does nothing while `cache.retention` is `none`. `maxConcurrentRequests` is an explicit request-slot limit for the endpoint and overrides live discovery. `lifecycle` is `user-managed` or `pancode-managed`; `user-managed` keeps PanCode from loading or unloading models on that server. `trustedUnmediated: true` lets a runtime that runs its own tool loop (`claude-code`, `codex-cli`, `pi-cli`, `opencode-cli`, `antigravity-code`) take write-capable dispatch work under its own authority; without it such work is refused, and the opt-in is recorded in the worker permit the run's result carries. Only user settings may set it; a project layer's value is ignored. `contextTier` (`default` or `long_context`, `copilot-sdk` targets only) opts a Copilot target into the long-context tier; see [GitHub Copilot](#github-copilot).

## Pricing and cost provenance

Pricing is declared per target in `targets[].pricing` ([`src/core/settings-validate-target.ts`](../../src/core/settings-validate-target.ts)). There is no per-model price: every model served through one target shares that target's rates. The value is the word `free` or a rate map in USD per million tokens:

    targets:
      - id: gateway
        runtime: litellm
        url: http://gateway.example:4000
        pricing:
          input: 3
          output: 15
          cacheRead: 0.3
          cacheWrite: 3.75
      - id: lab-gpu
        runtime: openai-compat
        url: http://lab.example:8000/v1
        pricing: free

`input` and `output` are required nonnegative numbers. `cacheRead` and `cacheWrite` are optional: an omitted `cacheRead` bills cache reads at the `input` price, and an omitted `cacheWrite` reads as 0. Any other key is rejected. `configure` has no pricing flag, so set it in `settings.yaml` directly or through `pancode configure --edit`.

[`resolveEffectivePricing`](../../src/domains/providers/catalog.ts) turns a target, its runtime and the wire model id into rates. It takes the first rule that matches, and the rule decides the `pricing` each `call.settled` record carries: a `usd` fact, a `pricedBy` source and, for `free`, a `freeRule` naming the rule ([`call-facts.ts`](../../src/domains/telemetry/call-facts.ts)).

| Order | Rule | Rates | `pricedBy` and `usd` |
| --- | --- | --- | --- |
| 1 | The target declares a rate map | The declared rates | `target-rates`, measured; `free` with `freeRule: zero-rates`, measured 0, when every declared rate is 0 |
| 2 | The target declares `pricing: free` | 0 | `free` with `freeRule: declared`, measured 0 |
| 3 | The runtime tier is `local-native` (`lmstudio`, `ollama`, `llamacpp` and its variants, `vllm`, `sglang`, `lemonade`) | 0 | `free` with `freeRule: local-native`, measured 0 |
| 4 | PanCode's own catalog, or else the Pi catalog, has a row for the runtime and wire model with at least one nonzero rate, or an all-zero row whose model id ends in `:free` | The catalog rates | `catalog`, estimated with method `catalog` |
| 5 | None of the above, including a catalog row whose rates are all 0 | None | `none`, unknown |

PanCode's own catalog has two rows, both on `inception`: `mercury-3` at Inception's list rates (the launch discount is ignored, so a cost cap never under-counts), and `mercury-decide` ([catalog.ts](../../src/domains/providers/catalog.ts)). Otherwise only runtimes that map to a Pi catalog provider can reach rule 4: `anthropic`, `anthropic-max`, `claude-code`, `claude-sdk`, `deepseek`, `google`, `groq`, `mistral`, `openai`, `openai-codex` and `openrouter`. Both catalogs are static data and not a live price feed. An all-zero catalog row, such as OpenRouter `auto`, is a missing price rather than a free one, so it stays unknown until its target declares `pricing: free` or rates. An OpenRouter `:free` model is the exception: its zero is the published price, so it estimates as `catalog` at $0. Other models and runtimes outside rule 3, such as `alcf`, the other `inception` models, `copilot-sdk` and the subprocess delegation runtimes, stay unpriced until a target prices them. Protocol-tier runtimes (`litellm`, `openai-compat`, `anthropic-compat`, `systemone`) are never assumed free, because a proxy can front a paid cloud model. A LiteLLM target therefore reports an unknown cost until it declares `pricing`, even when the model behind it is local. Workers price from the same target rates; a cost the provider call itself reports is kept as reported, as a measured `usd` with `pricedBy: provider`.

Cost appears in these places, and every one renders the journaled facts through one renderer ([`render.ts`](../../src/core/telemetry/render.ts)). How a value keeps its kind from journal to display is described in [honest values](../architecture/telemetry.md#honest-values).

- Each run's `run.settled` record carries its `usage` and `pricing` facts.
- The footer shows the session total, and the Details page (Alt+U) shows the session ceiling beside it as `ceiling`, which reads `none` when `safety.limits.sessionCostUsd` is `0`.
- `/usage` shows a `cost` row for the session and for each model.
- The dispatch board, `pancode fleet` output and the `monitor` tool show a cost per run.
- The exit summary prints a `Session cost` row, and under `report` a cost per model in its `Models` section, in the same wording as the table below.

| `usd` fact | What the footer, `/usage` and run tables show |
| --- | --- |
| measured | A dollar amount such as `$1.23`. |
| measured 0 with `pricedBy: free` | When every priced call was free: `$0.00 local` under `local-native`, `$0.00 free (declared)` under `declared` and `$0.00 free (zero-rates)` under `zero-rates`. Calls that name different rules read `$0.00 free (mixed)`, and a free amount with no recorded rule reads `$0.00 free`. |
| estimated | `~$1.23 est`. |
| unknown | Tokens are still counted, but the call adds nothing to the dollar total. A session with some priced calls shows `$1.23 +?`. A session with none shows no cost field in the footer and `/usage`, and `not measured` in the fixed-width tables. |

The pricing rule also decides what the cost ceiling sees. `safety.limits.sessionCostUsd` gates chat requests only on routes priced by target rates or the catalog, and gates dispatched routes that have a nonzero rate. Free and unpriced routes are not counted, so work on an unpriced LiteLLM target spends outside the ceiling until the target declares `pricing`. Side calls (`/btw` side questions, `/handoff` rounds, compaction summaries, System One and the safety judge) are checked against the ceiling whatever their route's pricing: an unpriced side call adds nothing, but once the session's priced spend has reached the ceiling it is held or refused like a priced one. A pre-warm is gated like the turn it warms, so it is not held on an unpriced route. A dispatch routing intent that sets `maxCostUsd` prices a route with no rates at a fixed admission estimate of 1 USD. On a priced route whose server omits token usage, a call made while a session ceiling or `--max-cost-usd` cap is active is charged an estimate from its request size and streamed output at the route's rates, shown as `~$<amount> est`, and the session gets one notice that the route's spend is estimated. A provider error status is charged nothing.

`safety.limits.sessionCostUsd` accepts any finite number of at least 0, fractions included. `0` means no session ceiling. The session gate admits every paid request, and an interactive session never waits on a raise. A dispatch plan and a Scout continuation carry a ceiling of 0 that enforces nothing, and a fleet preview skips its remaining-budget check. A negative value fails settings validation with `safety.limits.sessionCostUsd: expected a number >= 0, got <value>`. `pancode configure` shows a ceiling of 0 as `none` and a positive one as `$<amount> USD` on its `Session cost limit` row, and its prompt accepts 0 to remove the ceiling. A positive ceiling still refuses a paid request once priced spend reaches it, and `pancode run` then exits 4 with `budget_ceiling` ([exit codes](exit-codes-and-output.md)). In every mode it also stops running workers at their next metered call once session spend reaches it.

### Funding facts

`funding` records who pays for a target's usage. Reports use it for the marginal charge, the energy estimate and period fees; it prices nothing, authorizes nothing, feeds no cap and is never included in shared telemetry; route pricing stays `targets[].pricing` ([`src/core/funding-config.ts`](../../src/core/funding-config.ts)).

```yaml
funding:
  lab-grant:
    scheme: declared
    payer: sponsor
    nativeUnit: compute-hours
    grant: { amount: 5000, expiresAt: "2027-06-30T00:00:00Z" }
  workstation:
    scheme: declared
    payer: personal
    local:
      activeWatts: 320
      idleWatts: 45
      tariff: { ratePerKwh: 0.14, currency: USD }
targets:
  - id: campus
    # runtime, url and model as before
    funding: { pool: lab-grant }
```

| Pool key | Value |
| --- | --- |
| `scheme` | Required: `detected`, `declared` or `unknown`. |
| `payer` | `personal`, `sponsor`, `employer` or `none`. A `sponsor` or `employer` pool is a declared pool with a grant expiry. |
| `nativeUnit` | The unit the provider meters in, such as `tokens`, `requests`, `premium-requests`, `compute-hours` or `provider-credits`. |
| `fee` | `amount`, an ISO 4217 `currency` and a `period` of `day`, `week`, `month`, `year` or `one-time`. |
| `grant` | `expiresAt` as a UTC timestamp and an optional `amount`, which needs `nativeUnit`. |
| `local` | `activeWatts`, `idleWatts` (never above `activeWatts`) and `tariff` with `ratePerKwh` and `currency`. |

A pool id starts with a letter and has up to 48 letters, digits, `_` or `-`. A target names its pool with `targets[].funding.pool`; naming an unknown pool is a validation error. `pancode configure` offers a "Funding for a target" step, which records what it can observe (`detection`: a `local-native` runtime or a stored sign-in) without refreshing a login or calling a provider. A target with no binding, an `unknown` scheme, or a detected sign-in that has since changed resolves to unknown funding.

Funding is set in user settings only. A project layer that sets `funding` or `targets[].funding` is ignored with the notice `funding is set only in user settings; project value ignored`.

## Local model settings

Target-specific options are typed in [`target-descriptor.ts`](../../src/domains/providers/types/target-descriptor.ts). For example, `ollama.numCtx` is sent as the request context and is also the window PanCode plans against; changing it can reload a model on a shared Ollama server. Runtime probing and loaded-model state are implemented in [`src/domains/providers/runtimes/local-native/`](../../src/domains/providers/runtimes/local-native/ollama.ts).

### LM Studio load profile

`lmstudio.load` states how PanCode loads a model on an LM Studio server, so the server's GUI defaults stop deciding the context window, slot count or speculative draft. `lmstudio.models.<model id>.load` overrides fields for one model; the key is the model id selected on that target. Every field maps to the key LM Studio's `POST /api/v1/models/load` takes: `contextLength`, `parallel`, `flashAttention`, `speculativeDraftMaxTokens`, `evalBatchSize`, `numExperts` and `offloadKvCacheToGpu`. The adapter sends these fields to the load API; configure them for the installed server and model.

    targets:
      - id: lab-gateway
        runtime: litellm
        url: http://gateway.example:4000
        lmstudio:
          load:
            contextLength: 131072
            parallel: 4
            flashAttention: true
            speculativeDraftMaxTokens: 2
          models:
            lab/qwen3.8-27b:
              load:
                contextLength: 65536

Before a request, PanCode loads the model with the profile when it is not resident. When it is resident with a different value for a field the profile sets, for example because another client's just-in-time load took the GUI defaults, PanCode unloads that instance and loads it again, then prints one `reloading '<model>' ... to match its load profile` line. A field the loaded instance does not report is never treated as drifted. The profile applies on the next turn after the setting changes.

While another model is resident on the same server, PanCode caps a context length it chose, including one inherited from the target-level `lmstudio.load`, at the co-residency ceiling that `PANCODE_LMSTUDIO_CORESIDENT_CONTEXT` sets ([environment reference](environment-variables.md)), and prints `loading '<model>' alongside <models>: context clamped <requested> to <ceiling> tokens`. A `contextLength` set for that model under `lmstudio.models.<model id>.load` is never clamped; PanCode loads it and warns that it is above the ceiling. When a drift reload fails, PanCode restores the previous instance, plans against the window that instance serves, and does not retry the profile until the instance or the profile changes. If the restore also fails, the error names both failures and the model must be reloaded on the server ([`lmstudio.ts`](../../src/engine/apis/lmstudio.ts)).

It applies to a `lmstudio` target and to a `litellm` target. On a LiteLLM gateway, PanCode reads `/v1/model/info` and acts only on a route with exactly one deployment that declares `model_info.runtime: lm-studio`; it loads on that deployment's `api_base` under the upstream model key and still sends the request to the gateway alias. Routes on other runtimes, gateways that hide detail metadata from the key, and targets without a profile stay observe-only, and `lifecycle: user-managed` disables every load and unload. The gateway credential is never sent to the LM Studio server. Loads and reloads are serialized across the orchestrator and its workers by the residency lock.

PanCode remembers the LM Studio instances it loads in one state file per server (`lmstudio-ownership/` under the state directory), shared by the orchestrator, its workers and separate runs. Before loading a model under a profile, it unloads the instances any PanCode process loaded earlier on that server for other models, and prints one `unloading '<model>', which PanCode loaded earlier ...` line for each. LM Studio offloads an oversubscribed model to CPU instead of refusing it, so leaving two large models resident degrades both. A model another client loaded is never unloaded. While a PanCode process streams on a model it holds a lease on it, so neither another process's load nor a profile reload unloads it mid-request; a lease whose process has exited protects nothing. Back-to-back turns and runs on one model reuse the resident instance. PanCode does not unload anything when it exits.

### Per-request options for LM Studio and LiteLLM

`lmstudio.request` accepts `ttlSeconds`, `draftModel` and `reasoning` (`auto`, `off`, `on`, `low`, `medium` or `high`). `litellm.request` accepts `tags` (no commas; PanCode always adds `pancode`), `sendSessionId` (default true, sent as `x-litellm-session-id`), `timeoutSeconds` and `streamTimeoutSeconds` (0.001 to 86400), and `numRetries` (0 to 100, a router retry count and not a client SDK retry).

Sampling is per request and follows the model catalog; see [model-catalog.md](../architecture/model-catalog.md).

Model-family quirks belong to the model profiles, not the target descriptor. See [`models/profiles.yaml`](../../models/profiles.yaml) for current entries.

## Model listing and refresh

To refresh the models for a subscription or provider, run `pancode models --target <id>` without `--offline`. Live model discovery depends on the target's runtime; a fallback list is labeled as cached or catalog data.

Use `pancode models [search] [--target <id>] [--json] [--offline]` to inspect configured, discovered, and catalog models. The optional positional filters rows by a search term, `--json` is available for scripts, `--offline` skips live probing and uses cached, configured and catalog hints, and `--target` limits the listing to one target. Live probing is the default. A target whose provider lists models live is asked; when it cannot be asked, the list is the cached list or the provider catalog with a note saying why. The model-list command is implemented in [`src/cli/models.ts`](../../src/cli/models.ts), and the discovery contract is in the [model catalog](../architecture/model-catalog.md).

## gpt-oss tool turns and reasoning replay

For a route resolved to the Harmony response parser, including gpt-oss,
PanCode preserves reasoning on replayed tool turns. When an assistant turn has
reasoning, text and tool calls together, the outgoing request joins the text
into the reasoning field and sends a single analysis with the tool calls.
This avoids `Cannot pass both content and thinking in an assistant message with tool calls`
from the gpt-oss chat template. The conversion applies to the request;
the saved transcript keeps its original blocks. There is no operator setting
for it (`src/engine/apis/openai-completions.ts`).

## Thinking levels for out-of-turn model calls

PanCode supplies a thinking choice for model calls outside the main conversation instead of inferring one from whether the model supports reasoning. Memory retention requests `context.memory.thinkingLevel` and steering triage requests `chat.steering.triage.thinkingLevel`, both default `off` and independent of `chat.thinkingLevel` (whose default is `low`). Compaction also requests thinking off through the simple stream path. These choices bound auxiliary work without changing the session's saved thinking level. A model may still produce reasoning despite an off request; memory keeps text blocks from the response and accounts for reported usage. See [ai.ts](../../src/engine/ai.ts), the [memory caller](../../src/entry/orchestrator.ts) and [compaction](../../src/domains/session/compaction/compact.ts).

## Built-in runtimes

`pancode configure --list` prints the user-facing runtime ids and `pancode configure --list --all` adds the hidden registrations. A runtime descriptor fixes its kind (`http`, `sdk` or `subprocess`), tier, API family and auth method; the registry is [`builtins.ts`](../../src/domains/providers/runtimes/builtins.ts). Only `http` runtimes can drive the main agent, so a chat target must resolve to one. The `sdk` and `subprocess` runtimes are worker-only and are selected through fleet routes or `/run`. The tier also decides pricing, as [pricing and cost provenance](#pricing-and-cost-provenance) describes.

| Tier | Runtime ids | API family and auth |
| --- | --- | --- |
| `cloud` | `openai`, `openai-codex`, `anthropic`, `anthropic-max`, `google`, `mistral`, `groq`, `deepseek`, `openrouter`, `inception`, `alcf` | `openai` uses `openai-responses`, `openai-codex` uses `openai-codex-responses`, `anthropic` and `anthropic-max` use `anthropic-messages`, `google` uses `google-generative-ai`, `mistral` uses `mistral-conversations`, and `groq`, `deepseek`, `openrouter`, `inception` and `alcf` use `openai-completions`. Auth is an API key from the runtime's variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `INCEPTION_API_KEY`), or OAuth for `openai-codex`, `anthropic-max` and `alcf`. |
| `local-native` | `lmstudio`, `ollama`, `llamacpp`, `vllm`, `sglang`, `lemonade` | `ollama` speaks its native API and needs no key. The others use `openai-completions` with an optional key. They probe the server, report loaded models and serving windows, and price as free. |
| `protocol` | `openai-compat`, `anthropic-compat`, `litellm` | Generic endpoints that carry no local-server assumptions, over `openai-completions` or `anthropic-messages`. `litellm` is a gateway runtime with per-route capability discovery. They never price as free. |
| `subscription` | `claude-code`, `claude-sdk`, `codex-cli`, `opencode-cli`, `pi-cli`, `antigravity-code` | Worker-only. `claude-code` runs the installed `claude` CLI and `claude-sdk` the Claude Agent SDK, both on the CLI's own login. For this release the `claude-sdk` paths have been exercised only against a stand-in for the Claude Agent SDK, not against the real package and a live account. `codex-cli`, `opencode-cli`, `pi-cli` and `antigravity-code` run the installed command headlessly under its own login. `claude-code` and those four run their own tool loop, so write-capable dispatch work on them needs the target's `trustedUnmediated`. |

`copilot-sdk` is the one `subscription` runtime that is not worker-only. It is an `http`-kind runtime with the `copilot-sdk` API family, so it serves chat, main and worker routes like any target; [GitHub Copilot](#github-copilot) describes it.

Hidden registrations stay resolvable by id: `llamacpp-anthropic`, `llamacpp-completion`, `llamacpp-embed` and `llamacpp-rerank` are the other endpoints of one llama.cpp server, `lemonade-anthropic` is Lemonade's Anthropic endpoint, `systemone` is the System One decision server, and `typesafe-jev` is its hosted engine. `alcf` is documented in the [ALCF provider contract](../architecture/alcf-provider.md). A custom runtime joins the registry as the [provider adapter cookbook](../architecture/provider-adapter-cookbook.md) describes. The Claude Agent SDK is an optional dependency that the installer skips; see the [installation guide](installation-and-lifecycle.md) for how `claude-sdk` obtains it on first use.

`inception` declares no reasoning support, so `off` is the only thinking level. Every Mercury chat request carries `reasoning_effort: "instant"`, the minimum effort the API accepts. On the other Mercury models (`mercury-2.5`, `mercury-2`, `mercury-edit-2`) any higher effort returns an empty completion; on `mercury-3`, omitting the field makes the backend reason at its default, and that reasoning counts as output tokens but is stripped from the reply. Thinking controls supplied by callers are still removed.

## Auth

| Command | Effect |
| --- | --- |
| `pancode auth list` | List runtimes that PanCode can authenticate, and Copilot (`copilot-sdk`), whose own login `pancode auth login copilot-sdk` drives. |
| `pancode auth status [target-or-runtime]` | Inspect credential availability and source. Copilot's row reads `SDK not installed`, `signed in as <user>`, `keychain only (<user>)`, `not signed in` or `unavailable`; it offers the keychain prompt only when a target uses `copilot-sdk`. |
| `pancode auth login [target-or-runtime]` | Sign in or store an API key. |
| `pancode auth logout [target-or-runtime]` | Remove stored credentials. With no argument it lists each stored key once, under an id that removes exactly that key: a runtime's own credential under the runtime id, and a target's key under the target id. A bare id names the target when a target has that id, so a runtime that shares its id with a target (the first target `configure` creates for it does) is listed as `runtime:<id>`, and `pancode auth logout runtime:<id>` removes only the runtime's credential. A key several targets use is listed once with the other targets named, since removing it signs all of them out. |

`auth login` never echoes an API key: a terminal gets a masked field, and a key piped on stdin is read as its first line, so a script keeps the key out of argv (`printf %s "$KEY" | pancode auth login openai`). It also accepts `--api-key <value>`, which warns on a terminal that the value lands in shell history and the process list; with `TERM=dumb` the key is read with echo off, and a terminal that cannot hide typed input is refused with a hint to pipe the key (`pancode auth login <target> < keyfile`). Prefer `pancode configure --api-key-env <VAR>` (the target's `auth.apiKeyEnvVar`): PanCode reads the variable when making a request and stores no key. When the variable is unset in the shell that runs `configure`, the target is still saved and a warning names the variable to export. Stored API keys and OAuth credentials live in `credentials.yaml` in the config directory with mode `0600`, but are plaintext and are not encrypted. The auth CLI and storage are in [`src/cli/auth.ts`](../../src/cli/auth.ts) and [`src/domains/providers/auth/`](../../src/domains/providers/auth/index.ts).

The global `pancode --api-key <key>` override also satisfies an OAuth
target for that invocation. It is scoped to the active target and does not
replace the saved login (`src/domains/providers/auth/storage.ts`).

For one request, PanCode resolves a credential in this order: the per-process API key override that `--api-key` installs for the active target; the variable the target names in `auth.apiKeyEnvVar`, when it is set, the target has no `auth.apiKeyRef` and its runtime does not sign in with OAuth (an OAuth target ignores the variable and keeps its login); while that variable is unset, a copy of it stored for the desktop app (`env:<VAR>`); a stored credential for the target's provider id (an API key, or an OAuth login); then the environment, where the target's `auth.apiKeyEnvVar` or else the runtime's own variable is read first and the provider's known variables follow. The provider id is the target's `auth.oauthProfile` or `auth.apiKeyRef`, else the runtime's OAuth provider id, else the runtime id. A stored OAuth login is used as is while it is unexpired. Once its `expires` time passes, PanCode refreshes it under the credential file lock and writes the new tokens back before using them. A refresh that fails falls back to a re-read of the store and uses the stored token only if it is still valid. When the variable a target names is unset, the stored key is used and `auth status` and `doctor` say so.

Login depends on the runtime's auth method. An `api-key` runtime prompts for the key, or takes `--api-key`, and stores it in `credentials.yaml` with a plaintext warning. An `oauth` runtime picks its sign-in method from where it runs: on a desktop it opens your browser and waits for the callback (the opener gets your display session and none of your keys), and over SSH, on Linux without a display, or in WSL without `wslview` it uses the device-code or copy-code flow. `auth login --method browser|device` overrides the choice. A loopback callback with no browser to open prints an `ssh -L` hint, and an unreachable sign-in service names the proxy in effect. If a browser callback has not arrived after 10 seconds, a prompt appears for the verification code or redirect URL. The `alcf` Globus flow has no callback server and always ends with a pasted code. The `claude-cli` and `none` methods store no credential: `claude-code` and `claude-sdk` use the installed Claude CLI's login, `ollama` needs no credential, and the delegation CLIs keep their own login. `auth login` refuses them, except `pancode auth login copilot-sdk`, which runs the [GitHub Copilot](#github-copilot) component install and sign-in check. `auth status` reports each of them. For Copilot, `auth status copilot-sdk` (or a Copilot target id) asks the runtime who it is signed in as and prints, for example, `signed in as octocat on github.com`, exiting 0; without a login it names `copilot login` and exits 1. Plain `auth status` adds the same Copilot row when a `copilot-sdk` target is configured.

PanCode has no `github-copilot` login: `pancode auth login github-copilot` exits 2 with `unknown target or runtime: github-copilot`. To use Copilot, run `copilot login` and configure a `copilot-sdk` target.

OAuth credential storage and refresh stay PanCode's own. [`src/engine/oauth.ts`](../../src/engine/oauth.ts) adapts the login flows that Pi provides for `anthropic` (Claude Pro/Max) and `openai-codex` (ChatGPT Plus/Pro), and adds the Globus flow for `alcf` in [`src/engine/alcf-oauth.ts`](../../src/engine/alcf-oauth.ts). [`src/domains/providers/auth/storage.ts`](../../src/domains/providers/auth/storage.ts) owns persistence, the file lock, and the refresh. Pi's own credential store and refresh path are not used.

## Subscription-based Targets and Runtimes

OAuth providers, supported worker runtimes, and external-agent delegation have different runtime roles. `openai-codex` and `anthropic-max` are HTTP chat runtimes behind a subscription login. `claude-code`, `claude-sdk` and the `*-cli` runtimes are worker-only and use the installed tool's own login. `auth status` shows which credential source answers for each. Use [Interop](interop.md) for detected coding-agent peers. Runtime descriptors in [`src/domains/providers/runtimes/`](../../src/domains/providers/runtimes/builtins.ts) define their auth method and whether they serve chat or dispatch.

## GitHub Copilot

A `copilot-sdk` target sends model calls through the official GitHub Copilot SDK (`@github/copilot-sdk`), as the GitHub account signed in with the official `copilot login`. It is an ordinary target: `pancode configure` offers it, detected-route onboarding offers it when the SDK component is installed and a Copilot login exists, and it can be the chat, main or worker route, chosen with `/model`, `/config`, dispatch `target`/`model` pins or `run --target`/`--model`. Its models are the ones the account's Copilot policy has enabled, listed by the SDK at runtime; a model the organization has not enabled is not listed, and PanCode never enables one. A probe that finds an empty list fails with `GitHub Copilot lists no enabled models for this account`. The runtime also serves some models its listing leaves out (Gemini 3.8 Flash on the 1.0.26 runtime). Name such a model on its target, `run --target copilot --model gemini-3.8-flash` or `--model copilot/gemini-3.8-flash`, and PanCode sends the id as typed with a note that the target does not list it; a bare unlisted id with other targets configured fails with a message showing that qualified form. The ACP model picker, and so the desktop app, offers only declared models; add the id to the target's `wireModels` to offer it there too. Setup and onboarding pick `gpt-6-luna` when the account lists it, as `openai-codex` does, and otherwise the listing's first model; the listing usually starts with `auto`, which lets Copilot choose the model per request. A model the runtime does not serve fails with `Model "<id>" is not available.` followed by the models the account lists.

```yaml
targets:
  - id: copilot
    runtime: copilot-sdk
    defaultModel: <a model id from `pancode targets`>
```

- **Login.** PanCode has no Copilot sign-in and stores no Copilot token. Run `copilot login` (the official GitHub Copilot CLI) first; a missing login fails with a message naming it. In a terminal, `pancode auth login copilot-sdk`, interactive `pancode configure` and the onboarding wizard find no login and offer to run `copilot login` (or `gh auth login` when only the GitHub CLI is on PATH) for you, then confirm the account; the desktop app's setup cannot run it and names the command instead; that sign-in is GitHub's own. A login stored on disk under `COPILOT_HOME` works everywhere, and so does a GitHub CLI session (`gh auth login`), which the SDK also accepts as a signed-in user. Token variables (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`) are deliberately removed from the runtime's environment, so a token never stands in for a signed-in user; headless use needs `copilot login` stored on disk or `gh auth login`. When both exist, the SDK decides which account is used. A `copilot login` kept in the system keychain works only where an operator can answer a keychain prompt: the interactive TUI, `pancode acp` and the desktop app, whose sessions run over ACP, and `configure`, onboarding or `auth login copilot-sdk` in a terminal. Headless `pancode run`, fleet workers and other processes without an operator start the runtime with the keychain closed (the SDK's isolated mode), so a prompt can never hang them, and there a keychain-only login fails with a message naming the fix: run `gh auth login`, or add `"storeTokenPlaintext": true` to `settings.json` in the Copilot home and run `copilot login` again. The `auth` column of `pancode targets` reads `copilot login` for a Copilot target, and `auth status copilot-sdk` names the account. `pancode doctor` reports which login the runtime sees with the keychain closed and, run in a terminal, whether a login lives only in the keychain. PanCode never reads the keychain or a token itself; the Copilot runtime does. `COPILOT_HOME` is honored. Pi's `github-copilot` login is retired, as [auth](#auth) describes.
- **Component.** The SDK (`@github/copilot-sdk`, pinned at 1.0.26) and its platform runtime install once as a separate component, about 180 MB on Linux x64, under `<dataDir>/components/copilot-sdk/1.0.26`. Interactive `pancode configure` and `pancode auth login copilot-sdk` offer the install, and `pancode tools install copilot-sdk` runs it directly. Detected-route onboarding never downloads it: it offers a Copilot route only when the component is already installed.
- **Authorization.** Signing in is the authorization, as with the ChatGPT (`openai-codex`) and Claude (`anthropic-max`) subscriptions: PanCode asks no separate question and keeps no consent record. Setup names the account it found, for example `Uses your GitHub Copilot subscription as octocat on github.com; your organization's Copilot policies apply.` Any Copilot plan works (Individual, Pro, Pro+, Business, Enterprise, or a GitHub Enterprise Server host); the plan and the organization's policy decide which models are listed and how requests are counted. Non-interactive `pancode configure` saves the target and warns when the SDK component or the login is missing.
- **Tools and prompt.** PanCode's own agent loop runs every tool under its usual permission policy; Copilot's built-in tools are all disabled, and PanCode's compiled prompt replaces Copilot's default system prompt.
- **Session state and files.** The Copilot runtime keeps its session records under `<cacheDir>/copilot-sdk/sessions/<session id>/`, per OS user. A conversation left idle stays resumable: a later process that continues the same PanCode session (`run --session`, `run --continue`, ACP session load, `/resume`) resumes that Copilot session and sends only the new turn, as long as the transcript still extends what it holds under the same system prompt; otherwise it starts a fresh one from the transcript. PanCode removes the directory when it closes a conversation that is not resumable, when its session is deleted, and in a sweep that keeps the newest 32 resumable conversations and none idle for over 7 days. Every other path reaches the runtime through the SDK's `sessionFs` at its real location and read-only: a write, mkdir, rename or rm outside the session directory is refused, because workspace changes go through PanCode's own tools ([session-fs.ts](../../src/engine/copilot/session-fs.ts)). The cache root and session directory are re-verified before every write and delete, but a window remains between that check and the call that follows, because Node has no descriptor-relative directory calls. Using it needs write access to your own cache directory and a race on each operation.
- **Context size.** A Copilot route sizes the context from the prompt budget Copilot enforces, by default the default tier's budget (200K tokens for Claude models even when the listing advertises about 1M for the long-context tier), so compaction (including `/compact`) works against that budget. A Copilot prompt-budget or context-limit refusal counts as a context overflow, so the session compacts and retries instead of stopping.
- **Long-context tier.** `contextTier: long_context` on a `copilot-sdk` target opts its sessions into the model's long-context tier. PanCode passes the tier when it creates the Copilot session and when it switches model, sizes the context from the listing's `billing.tokenPrices.longContext.maxPromptTokens`, and reads the long-context token prices (`longContext.inputPrice`, `outputPrice`, `cacheReadPrice`, `cacheWritePrice`) instead of the default ones. A model whose listing has no long-context tier keeps its default budget and prices. Absent, or `default`, nothing is sent and behavior is unchanged. The footer route, the `/model` confirmation and a `pancode doctor` info row show `long context` when the tier is on. The key is rejected on any other runtime. It applies from the next turn.

  ```yaml
  targets:
    - id: copilot
      runtime: copilot-sdk
      contextTier: long_context
  ```
- **Cost and limits.** A Copilot target has no dollar price: with no `pricing` declared on the target it settles as `pricedBy: none`. Token usage is recorded as the SDK reports it. Each model call also records premium requests, from the growth of the Copilot runtime's own session total, and AI credits, from the call's own reports or that total. Either can be recorded as unknown, never as zero, when the runtime gives no accounting answer, a call's usage never arrives, or a usage report cannot be tied to one call. A target admits four requests at a time unless `maxConcurrentRequests` says otherwise, so dispatched workers can run beside the chat turn; when it is full, the refusal names the target and `maxConcurrentRequests`. A refusal from Copilot (policy, quota, rate limit) is shown as is and is never retried on another account or moved to another target.

## Troubleshooting checklist

If your provider gives a 401 authentication error, check the target's credentials with `pancode auth status <target-or-runtime>`. Use `pancode auth login <target-or-runtime>` to sign in again, or correct the API-key environment variable named by the target. Then check reachability and the model list:

    pancode doctor --json
    pancode targets --probe
    pancode models --target <id>
    pancode auth status <target-or-runtime>

For a report, include the PanCode and Node versions, target id/runtime, model id, probe result, and a `pancode telemetry share` archive or a redacted transcript. Do not include API keys or credential files.

How a dispatched worker's provider error is classified, and whether it retries on another target, is described in [worker dispatch mechanics](../architecture/worker-dispatch-mechanics.md).
