// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The operator copy for settings controls: labels, descriptions, help and per-value help. settings-controls.ts
 * builds the control catalogue from these tables.
 */

export const SETTINGS_LABELS_BY_ID = {
	"safety.autonomy": "Autonomy level",
	// A row id is its settings path; visible names are shared by every settings surface.
	"fleet.permissions.mode": "When a worker asks permission",
	"fleet.permissions.escalation.timeoutMs": "Time to answer a worker",
	"fleet.permissions.escalation.fallback": "If you do not answer",
	"integrations.externalAgents.defaults.toolGovernance": "External agent permissions",
	"integrations.hub.trustProjectImports": "Trust project imports",
	"integrations.git.commitAttribution": "Credit in Git commits",
	"integrations.git.commitAuthor": "Author of autonomous commits",
	safetyNet: "Safety net",
	"chat.thinkingLevel": "Thinking level",
	"chat.target": "Chat connection",
	"chat.model": "Chat model",
	"context.memory.target": "Memory connection",
	"context.memory.model": "Memory model",
	"context.memory.enabled": "Proactive memory",
	"context.memory.cadenceToolCalls": "Tools between memory updates",
	"context.memory.trajectorySteps": "Recent steps to remember",
	"context.memory.maxOutputTokens": "Memory note length",
	"context.memory.timeoutMs": "Memory response time",
	"chat.prewarm": "Prompt pre-warm",
	"fleet.default.target": "Default fleet connection",
	"fleet.default.model": "Default fleet model",
	"fleet.default.thinkingLevel": "Default thinking level",
	"fleet.profiles": "Add profile",
	"fleet.agentProfiles": "Bind agent",
	"fleet.retry.maxRetries": "Fleet retries",
	"fleet.staggerSharedPrefix": "Stagger shared-prefix workers",
	"fleet.retry.routeCooldownMs": "Wait after a route fails",
	"fleet.adaptiveRouting.roles": "Roles using automatic routing",
	"fleet.adaptiveRouting.postures": "Automatic routing priorities",
	"fleet.adaptiveRouting.agentRoles": "Agents using automatic routing",
	"interface.panes.notifications": "Pane notifications",
	"interface.panes.layout": "Startup layout",
	"interface.panes.workers.ratio": "Workers dock share",
	"fleet.history.journal": "Run event journal",
	"interface.panes.files.enabled": "Files pane",
	"interface.panes.files.mode": "Files pane mode",
	"interface.panes.files.profile": "Files pane profile",
	"interface.panes.files.followCwd": "Files follow chat folder",
	"interface.panes.files.ratio": "Files dock share",
	"chat.modelPicker.cycleSet": "Models in quick switch",
	"chat.modelPicker.recentLimit": "Recent models kept",
	"chat.modelPicker.favorites": "Pinned favorites",
	"safety.limits.sessionCostUsd": "Session cost limit",
	"chat.maxOutputTokens": "Maximum answer length",
	"context.toolResultMaxBytes": "Maximum tool result size",
	"fleet.concurrency": "Workers at once",
	"safety.limits.chatToolCallsPerTurn": "Tools per chat turn",
	"fleet.limits.toolCallsPerRun": "Tools per worker run",
	"fleet.history.maxRuns": "Past runs to keep",
	"safety.limits.readBytesPerCall": "Maximum file read size",
	"safety.limits.observationBytesPerTurn": "Tool output per turn",
	"fleet.limits.internalRunTimeoutMs": "Maximum internal run time",
	"context.compaction.auto": "Summarize automatically",
	"context.compaction.threshold": "When to summarize",
	"context.compaction.maxTokens": "Context token ceiling",
	"context.compaction.provider": "Provider compaction",
	"context.workingSet.enabled": "Clear old tool output",
	"context.workingSet.policy": "How old output is chosen",
	"context.workingSet.profile": "What to keep in context",
	"context.workingSet.target": "Context level after cleanup",
	"context.workingSet.protectLastTurns": "Recent turns to keep",
	"context.workingSet.protectLastSteps": "Recent steps to keep",
	"context.workingSet.minEvictableTokens": "Smallest output to clear",
	"context.workingSet.rearmFraction": "Wait before clearing again",
	"chat.retry.enabled": "Retry transient errors",
	"chat.retry.maxRetries": "Max retries",
	"chat.retry.baseDelayMs": "Wait before first retry",
	"chat.retry.maxDelayMs": "Longest retry wait",
	"chat.retry.streamStallMs": "Wait for a stalled reply",
	"chat.retry.firstTokenStallMs": "Wait for reply to start",
	"interface.terminalProgress": "Terminal progress indicator",
	"interface.outputDetail": "Output detail",
	"interface.mode": "Transcript layout",
	"interface.fullscreenScrollbar": "Fullscreen scrollbar",
	"interface.smoothStreaming": "Smooth streaming",
	"interface.desktopNotifications": "Desktop notifications",
	"safety.review.enabled": "Review changed work",
	"safety.review.target": "Review connection",
	"safety.review.cadenceToolCalls": "Tools between reviews",
	"integrations.providerPackages": "Provider packages",
	"context.compaction.model": "Compaction model",
	"context.compaction.systemPrompt": "Compaction prompt",
	"integrations.externalAgents.defaults.connectTimeoutMs": "Time for agent to connect",
	"integrations.externalAgents.defaults.turnTimeoutMs": "Maximum agent turn time",
	"integrations.externalAgents.defaults.permissionTimeoutMs": "Time for agent permission",
	targets: "Configured connections",
	funding: "Funding pools",
	"interface.keybindings": "Keybinding overrides",
	"integrations.externalAgents.entries": "Available agents",
	"integrations.hub.catalog": "Hub catalog path",
	"integrations.hub.remote": "Hub remote",
	"integrations.hub.confirmedRemote": "Confirmed hub remote",
	"integrations.hub.sync": "Hub remote sync",
	"integrations.hub.index": "Hub signed index",
} as const;

export const SETTINGS_DESCRIPTIONS_BY_ID = {
	"safety.autonomy": "How freely PanCode acts; the safety net always applies.",
	"fleet.permissions.mode":
		"Choose whether the safety judge reviews a worker's blocked tool, or the worker skips it, stops, or asks you to approve it.",
	"fleet.permissions.escalation.timeoutMs": "How long PanCode waits for your answer when a worker asks permission.",
	"fleet.permissions.escalation.fallback": "What the worker does if you do not answer in time.",
	"integrations.externalAgents.defaults.toolGovernance": "Tool policy for delegated external agents.",
	"integrations.hub.trustProjectImports": "Allow explicitly imported foreign skills and prompts to run.",
	"integrations.git.commitAttribution":
		"Add evidence-backed assistance, testing, review, and contributor trailers to commits created through PanCode.",
	"integrations.git.commitAuthor":
		"Who authors commits PanCode makes on its own: dispatched workers and their landing, headless runs, and scheduled jobs.",
	safetyNet: "Always-on rails; tuned in .pancode/safety.yaml.",
	"chat.thinkingLevel": "How much reasoning the chat model uses before answering.",
	"chat.target": "Connection that answers in chat.",
	"chat.model": "Chat model override; unset uses the connection default.",
	"context.memory.target":
		"Connection for task memory. With no memory connection or model set, memory uses the chat route.",
	"context.memory.model":
		"Dedicated task-memory model. With no memory connection or model set, memory uses the chat route.",
	"context.memory.enabled": "Allow PanCode to update task memory as work progresses.",
	"context.memory.cadenceToolCalls": "Maximum number of tool uses between memory updates.",
	"context.memory.trajectorySteps": "How many recent steps PanCode considers when updating memory.",
	"context.memory.maxOutputTokens": "Maximum length of one memory reminder, in tokens.",
	"context.memory.timeoutMs": "How long PanCode waits for a memory model response.",
	"chat.prewarm": "Send the next turn's known prefix ahead of time so a local server has already prefilled it.",
	"fleet.default.target": "Default connection for delegated fleet work.",
	"fleet.default.model": "Default fleet model override; unset uses the connection default.",
	"fleet.default.thinkingLevel": "Reasoning budget for dispatched workers.",
	"fleet.profiles": "Saved connection, model, and reasoning choices for workers. Enter adds one.",
	"fleet.agentProfiles": "Choose which saved profile each PanCode agent uses. Enter adds one.",
	"fleet.retry.maxRetries": "Automatic retries for a retryable worker outcome.",
	"fleet.staggerSharedPrefix":
		"On by default; workers that share a prompt prefix start after the leader streams (at most 15 s), so they reuse its cache.",
	"fleet.retry.routeCooldownMs":
		"How long a failing target, runtime, and model route is skipped before it is tried again.",
	"fleet.adaptiveRouting.roles": "Types of worker allowed to use an automatically selected model.",
	"fleet.adaptiveRouting.postures": "Priorities that automatic model selection may use for workers.",
	"fleet.adaptiveRouting.agentRoles": "Specific agents allowed to use automatic model selection.",
	"interface.panes.notifications": "Choose which worker updates show a pane notification.",
	"interface.panes.layout": "Choose which companion panes open when PanCode starts.",
	"interface.panes.workers.ratio": "Share of the width the workers dock takes, at most half.",
	"fleet.history.journal": "Save worker activity so you can inspect finished runs later.",
	"interface.panes.files.enabled":
		"Whether `/files`, its key, and `/panes open files` may open the files pane or the one-shot pick.",
	"interface.panes.files.mode": "Keep the files pane beside the conversation, or close it after one selection.",
	"interface.panes.files.profile": "Use PanCode's theme or your own file manager settings.",
	"interface.panes.files.followCwd": "Keep an open files pane on the same folder as the conversation.",
	"interface.panes.files.ratio": "Share of the height the files dock takes, at most half.",
	"chat.modelPicker.cycleSet": "Models the quick-switch key cycles through.",
	"chat.modelPicker.recentLimit": "How many recently used models /model remembers.",
	"chat.modelPicker.favorites": "Connections and models pinned in the model picker.",
	"safety.limits.sessionCostUsd": "Per-session cost cap.",
	"chat.maxOutputTokens": "Output tokens requested per turn, applied to every target.",
	"context.toolResultMaxBytes": "Maximum bytes returned from one tool result before the full text spills to scratch.",
	"fleet.concurrency": "Maximum number of workers running at the same time.",
	"safety.limits.chatToolCallsPerTurn": "Maximum tool uses PanCode may make during one chat turn.",
	"fleet.limits.toolCallsPerRun": "Maximum tool uses one worker may make during its run.",
	"fleet.history.maxRuns": "How many finished worker runs remain in local history.",
	"safety.limits.readBytesPerCall": "Maximum text one file read may return to the model.",
	"safety.limits.observationBytesPerTurn": "Combined tool output PanCode may read during one turn.",
	"fleet.limits.internalRunTimeoutMs": "Maximum time for one internal worker run.",
	"context.compaction.auto": "Summarize older context automatically before the conversation fills up.",
	"context.compaction.threshold": "How full the model's context can get before PanCode summarizes older content.",
	"context.compaction.provider": "Use native Codex checkpoints when supported; off keeps portable PanCode summaries.",
	"context.compaction.maxTokens":
		"Input token ceiling used to trigger context cleanup independently of the model's window.",
	"context.workingSet.enabled": "Free space by setting aside stale tool output before summarizing the conversation.",
	"context.workingSet.policy": "Choose how PanCode finds old tool output to set aside.",
	"context.workingSet.profile": "Keep extra outputs that matter for the current kind of work.",
	"context.workingSet.target": "How full the context should be after PanCode clears old output.",
	"context.workingSet.protectLastTurns": "Keep tool output from this many recent user turns.",
	"context.workingSet.protectLastSteps": "Keep tool output from this many recent assistant steps.",
	"context.workingSet.minEvictableTokens":
		"Results below this token estimate stay; the marker would cost more than it saves.",
	"context.workingSet.rearmFraction": "Wait for context use to grow by this much before clearing old output again.",
	"chat.retry.enabled": "Automatically retry a chat turn after a transient provider error.",
	"chat.retry.maxRetries": "Retry attempts after the initial failure.",
	"chat.retry.baseDelayMs": "Initial retry delay in milliseconds.",
	"chat.retry.maxDelayMs": "Maximum retry delay in milliseconds.",
	"chat.retry.streamStallMs": "How long PanCode waits when a model stops sending text mid-answer.",
	"chat.retry.firstTokenStallMs": "How long PanCode waits for a model to start its answer.",
	"interface.terminalProgress": "Show running-task progress in terminals that support tab or taskbar badges.",
	"interface.outputDetail":
		"How much evidence every terminal surface shows inline: outcomes, bounded evidence, or provenance and telemetry.",
	"interface.mode": "Use regular terminal scrollback or a fullscreen transcript with a sticky composer and footer.",
	"interface.fullscreenScrollbar": "When the draggable transcript scrollbar is visible in fullscreen mode.",
	"interface.smoothStreaming": "Presentation-only pacing for streamed assistant text and thinking.",
	"interface.desktopNotifications":
		"Content-free desktop notification when a turn ends, a detached batch settles, or an approval parks.",
	"safety.review.enabled": "After PanCode changes files, ask a read-only reviewer to check the work.",
	"safety.review.target": "Connection used for the review. Leave blank to use the chat connection.",
	"safety.review.cadenceToolCalls":
		"Also review during a long turn after this many tool uses; leave blank for an end-of-turn review only.",
	"integrations.providerPackages":
		"Additional provider runtime packages loaded when PanCode starts. Install and enable only packages you trust.",
	"context.compaction.model": "Model used to summarize older conversation. Leave blank to use the chat model.",
	"context.compaction.systemPrompt":
		"Optional file with custom summarizing instructions. Leave blank for PanCode's built-in instructions.",
	"integrations.externalAgents.defaults.connectTimeoutMs": "How long to wait for a delegated agent to connect.",
	"integrations.externalAgents.defaults.turnTimeoutMs": "How long a single delegated turn may run.",
	"integrations.externalAgents.defaults.permissionTimeoutMs":
		"How long PanCode waits for your answer to an external agent's permission request.",
	targets: "Inference targets available for chat and workers. Add one with `pancode configure`.",
	funding:
		"Optional user-owned fees, grants, payers and electricity facts for reports. Never grants spending authority.",
	"interface.keybindings": "Custom key overrides layered on the defaults.",
	"integrations.externalAgents.entries": "Other coding agents you can call through /run.",
	"integrations.hub.catalog": "Path to the private resource catalog; blank uses the one in your config directory.",
	"integrations.hub.remote": "Git remote the catalog syncs with; blank keeps the hub entirely local.",
	"integrations.hub.confirmedRemote": "The remote you approved. Syncing waits until it matches the current hub remote.",
	"integrations.hub.sync": "Whether `pancode hub sync` and `push` may talk to the remote at all.",
	"integrations.hub.index": "Where PanCode fetches the signed hub index; blank turns remote refresh off.",
} as const satisfies Record<keyof typeof SETTINGS_LABELS_BY_ID, string>;

/** Longer, optional guidance shown beneath the one-line description when there is room. */
export const SETTINGS_HELP_BY_ID: Partial<Record<string, string>> = {
	"safety.autonomy":
		"Default edits the workspace, dispatches routine work, and runs your shell commands without asking inside an OS sandbox where the host has one (workspace and scratch roots writable, credentials hidden). Commands that leave the sandbox, outward actions and former hard blocks are first reviewed by the safety judge against your requests, larger dispatch plans ask you, and destructive workspace operations run after a snapshot /rewind can undo. YOLO shows no approval cards: it keeps default's sandbox and safety judge, and a call that would need your approval is refused back to PanCode instead. Both modes still ask you questions. Unconfined YOLO (safety.yoloConfinement, accepted once) skips approvals and the sandbox; only the YOLO floor and rules in an approved .pancode/safety.yaml block. YOLO's first activation asks you to accept it once, and it is refused as root outside a container.",
	"chat.maxOutputTokens":
		"Clamped down to each model's max-output cap and the remaining context window. Set 0 to use per-model caps only.",
	"context.toolResultMaxBytes":
		"At least 4 KB. The Tool output per turn limit still caps the whole turn, even if this per-result limit is higher.",
	"context.compaction.threshold":
		"Choose how full the model's context may get. A higher percentage keeps more history but leaves less room for the next answer.",
	"context.compaction.maxTokens":
		"Whole number of at least 1 · default: 400000 tokens. A lower ceiling limits input cost by triggering cleanup sooner, even when the model has a larger context window.",
	"context.workingSet.enabled":
		"Old tool output is set aside without changing chat history. When off, PanCode waits until it needs to summarize the conversation.",
	"context.workingSet.policy":
		"Current structure also protects output the model returned to twice. Classic structure uses the older selection rule. Age only clears the oldest eligible output first.",
	"context.workingSet.profile":
		"Data analysis keeps recent numeric command output. Web design keeps recently read stylesheets and components. Default adds no special protection.",
	"context.workingSet.target":
		"Choose a percentage below the summarize threshold. PanCode keeps clearing eligible output until context use falls to this level.",
	"context.workingSet.protectLastTurns": "Counted in user turns. Whole number of at least 1 · default: 6.",
	"context.workingSet.protectLastSteps":
		"Counted in assistant steps inside the turn window, so a long agentic turn stays evictable. Whole number of at least 1 · default: 8.",
	"context.workingSet.minEvictableTokens":
		"Smaller outputs stay in context because replacing them saves little space. Choose 0 to allow every size.",
	"context.workingSet.rearmFraction":
		"PanCode waits for context use to grow by this percentage after clearing output. Choose 0 to allow another cleanup immediately.",
	"safety.limits.chatToolCallsPerTurn":
		"PanCode stops using tools and summarizes the turn when it reaches this limit. Whole number of at least 1.",
	"fleet.limits.toolCallsPerRun":
		"Only tools that actually ran count. A worker's own smaller limit still applies. Whole number of at least 1.",
	"fleet.history.maxRuns":
		"When history fills, the oldest run and its event log are removed. Whole number of at least 1.",
	"safety.limits.readBytesPerCall":
		"Enter a number of bytes. PanCode reads at least 1 KB even if you choose a smaller value.",
	"safety.limits.observationBytesPerTurn":
		"Shared by every tool in the turn. At the default, the pool grows with the model's context window above 128K tokens, up to 1 MB. Any other value applies exactly. Enter a whole number of bytes, at least 1.",
	"fleet.limits.internalRunTimeoutMs":
		"Ends an internal worker run that never finishes, including the wiki writer and first project Scout. Enter at least 1 millisecond.",
	"chat.retry.streamStallMs":
		"The timer resets whenever text arrives. If it expires, PanCode can retry according to the retry settings above.",
	"chat.retry.firstTokenStallMs":
		"Time allowed before the first text arrives from a local or self-hosted endpoint, which may need to load a model first. Hosted services use the mid-stream wait. Choose 0 to wait indefinitely on every route.",
	"integrations.hub.catalog":
		"Absolute path, or blank for the catalog in your config directory. The catalog is the index `pancode hub` reads; installed resources land in the usual skill and resource roots either way. Default: blank.",
	"integrations.hub.remote":
		"Enter a Git remote URL, or leave blank to keep the hub local. Confirm the remote and turn on syncing before PanCode uses it.",
	"integrations.hub.confirmedRemote":
		"PanCode records this after you confirm the hub remote. It must match the selected remote before syncing is allowed.",
	"integrations.hub.sync": "When off, hub sync and push stop before contacting the remote, even if one is configured.",
	"integrations.hub.index":
		"Base URL holding signing.json, index.envelope.json and index.yaml. PanCode offers the remote rows only after their signatures verify against the root key it ships with. Blank keeps the bundled index only.",
	"fleet.concurrency":
		"Automatic chooses a limit from available CPU and memory, up to eight workers. Choose a number to set a fixed limit.",
	"integrations.hub.trustProjectImports":
		"Applies to foreign packages explicitly imported into PanCode, at user or project scope. Loose skills/prompts in other agents' folders stay discovery-only; this setting never imports them.",
	"integrations.git.commitAttribution":
		"Role trailers are added only when PanCode has trusted evidence for that role. Disabling leaves subsequent commit messages entirely unchanged.",
	"integrations.git.commitAuthor":
		"Automatic makes PanCode the author of autonomous commits, with you as committer and a Co-authored-by trailer naming you. Interactive sessions always keep you as the author. Needs commit credit on and a configured user.name and user.email; an author you or the command chose always wins.",
	"fleet.permissions.mode":
		"Safety judge reviews the call against your own messages while PanCode runs at default; it runs on an allow and is denied on a block or when the judge gives no verdict. Deny the tool lets the worker continue without it. Stop the worker ends the run. Ask me waits for your answer, then uses the fallback choice if time runs out.",
	"fleet.permissions.escalation.timeoutMs":
		"Used only when workers ask you. A key on the card holds it for up to 15 minutes. In sessions with nobody available to answer, the fallback applies. Enter at least 1 millisecond.",
	"fleet.permissions.escalation.fallback":
		"Deny the tool lets the worker continue without it. Stop the worker ends the run.",
	"fleet.retry.routeCooldownMs":
		"After repeated failures, PanCode waits before trying the same connection and model again. A successful run clears the wait. Choose 0 to disable it.",
	"fleet.adaptiveRouting.roles":
		"Automatic model selection only takes effect when both the worker role and its priority are enabled. Otherwise PanCode records its suggestion without using it. Choose explorer, seat, checker, reviewer, or judge.",
	"fleet.adaptiveRouting.postures":
		"Choose which priorities may select a model automatically: quality, balanced, speed, or lower cost. Manually chosen models stay fixed.",
	"fleet.adaptiveRouting.agentRoles":
		"Each entry names one agent and worker role. Edit these pairs in the settings file. The agent name auto is reserved.",
	"chat.prewarm":
		"For a supported local connection, prepare the next prompt when a session starts, resumes, or finishes summarizing. It does not run during an active turn.",
	"fleet.agentProfiles":
		"Bind base, custom, and shadow native agents such as scout, researcher, and provenance to profiles. ACP delegation agents cannot be bound.",
	"integrations.externalAgents.defaults.toolGovernance":
		"PanCode permissions check external agent tools. Agent permissions let that agent decide. Deny all tools blocks every tool request.",
	"chat.modelPicker.cycleSet":
		"Choose connections or specific models. The model switch shortcut cycles through this list.",
	"integrations.providerPackages": "Comma-separated package names, loaded at startup. Restart PanCode after changing.",
	"interface.desktopNotifications":
		"Supported terminals show a brief desktop alert. Alerts never include your prompt, file paths, or model output.",
	"safety.review.enabled":
		"The reviewer reads the files changed during the turn and reports blockers in the transcript. It runs in interactive sessions only.",
	"safety.review.target": "Choose a connection for the reviewer. Leave blank to use the current chat connection.",
	"safety.review.cadenceToolCalls":
		"Set a tool count to check work during a long turn. Leave blank to review only when the turn ends.",
	"interface.keybindings":
		"Alt+O cycles output detail: compact, standard, detailed across terminal surfaces. Use /view for full reasoning and action details. Shift+Tab changes model thinking effort.",
};

/** Per-value meaning, surfaced for the current value of an enum knob. */
export const SETTINGS_VALUE_HELP_BY_ID: Partial<Record<string, Record<string, string>>> = {
	"safety.autonomy": {
		default:
			"workspace edits, reads anywhere outside secret paths, and shell commands inside the OS sandbox run (without a sandbox, only recognized commands); outward actions, commands that leave the sandbox and former hard blocks go to the safety judge; larger dispatch plans and project settings ask you",
		yolo:
			"everything runs without asking, unsandboxed by default; only the yolo floor and your approved safety.yaml rules block",
	},
	"fleet.permissions.mode": {
		deny: "the worker skips the blocked tool and continues",
		fail: "the worker stops and reports that permission was needed",
		escalate: "PanCode asks you; if you do not answer in time, it uses the fallback choice below",
		judge:
			"the safety judge reviews the call against your own messages at autonomy default; a block or no verdict denies it, and with the judge off the call is denied",
	},
	"fleet.permissions.escalation.fallback": {
		deny: "the worker skips the blocked tool and continues",
		fail: "the worker stops and reports that permission was needed",
	},
	"chat.prewarm": {
		true: "prepare the next prompt on supported local connections",
		false: "wait until you send the next message before preparing it",
	},
	"context.workingSet.enabled": {
		true: "set old tool output aside before summarizing the conversation",
		false: "keep tool output until the conversation needs a summary",
	},
	"context.workingSet.policy": {
		"structural-v1": "choose output based on where it appears in the conversation",
		"structural-v2": "also keep output that the model returned to more than once",
		"age-horizon": "choose the oldest eligible output first",
	},
	"context.workingSet.profile": {
		default: "keep only PanCode's essential context",
		"data-analysis": "also keep three recent command outputs with numbers",
		"web-design": "also keep recently read stylesheets and components",
	},
	"integrations.hub.sync": {
		true: "allow `pancode hub sync` and `push` to reach the confirmed remote",
		false: "refuse every hub network operation",
	},
	"integrations.externalAgents.defaults.toolGovernance": {
		"pancode-policy": "PanCode's safety policy gates the delegated agent's tools",
		"agent-managed": "the external agent governs its own tools",
		"deny-all": "block every tool the delegated agent requests",
	},
	"context.compaction.auto": {
		true: "compact automatically before a turn crosses the threshold",
		false: "context is only compacted when you run /context compact",
	},
	"interface.exitSummary": {
		on: "print the session summary on exit, sized by output detail",
		off: "print only the command that resumes the session",
	},
	"chat.retry.enabled": {
		true: "retry transient provider errors automatically",
		false: "surface transient errors immediately without retrying",
	},
	"integrations.hub.trustProjectImports": {
		true: "allow explicitly imported foreign skills and prompts",
		false: "keep imported foreign skills and prompts inactive",
	},
	"integrations.git.commitAttribution": {
		enabled: "add only the PanCode role trailers justified by trusted evidence",
		disabled: "leave every subsequent commit message byte-for-byte unchanged",
	},
	"integrations.git.commitAuthor": {
		auto: "PanCode authors autonomous commits and credits you as co-author",
		human: "you author every commit; PanCode is credited only by trailers",
	},
	"interface.terminalProgress": {
		true: "show progress in a supported terminal tab or taskbar",
		false: "no terminal progress badges",
	},
	"interface.outputDetail": {
		compact: "outcomes: states, blockers and next actions",
		standard: "adds bounded evidence and short previews",
		detailed: "adds provenance, ids and telemetry",
	},
	"interface.mode": {
		regular: "preserve terminal scrollback and render the composer below the transcript",
		fullscreen: "use the alternate screen with an independently scrollable transcript and sticky composer/footer",
	},
	"interface.fullscreenScrollbar": {
		hidden: "never draw the fullscreen transcript scrollbar",
		auto: "show the scrollbar while scrolling or dragging",
		always: "reserve the rightmost column for the scrollbar",
	},
	"interface.desktopNotifications": {
		true: "post a content-free desktop notification on turn end, batch settlement, and a parked approval",
		false: "never post a desktop notification",
	},
	"safety.review.enabled": {
		true: "review every mutating turn with one read-only verifier run",
		false: "no verifier run; a turn ends without a second opinion",
	},
	"interface.smoothStreaming": {
		off: "show each chunk of text as soon as it is ready",
		auto: "smooth text when the terminal supports it",
		on: "smooth text as it appears, pausing if the terminal falls behind",
	},
};

/** A setting path's label and description; where a guided row names the path too, this pair wins. */
export const EXTRA_HELP: Record<string, [string, string]> = {
	"safety.resources.main.memoryMiB": [
		"Main command memory ceiling (MiB)",
		"Memory, without swap, all processes of one of the main session's commands may hold together; the kernel ends the command past it. Linux with a systemd user manager only; a host that cannot enforce it refuses the command. Empty is no ceiling.",
	],
	"safety.resources.main.tasks": [
		"Main command process ceiling",
		"Processes and threads one of the main session's commands may run at once; past it the command cannot start more. Linux with a systemd user manager only; a host that cannot enforce it refuses the command. Empty is no ceiling.",
	],
	"safety.resources.main.cpuPercent": [
		"Main command CPU ceiling (%)",
		"CPU one of the main session's commands may use, 100 being one core. Linux with a systemd user manager only; a host that cannot enforce it refuses the command. Empty is no ceiling.",
	],
	"safety.resources.workers.memoryMiB": [
		"Worker command memory ceiling (MiB)",
		"Memory, without swap, all processes of one of a dispatched worker's commands may hold together; the kernel ends the command past it. Linux with a systemd user manager only; a host that cannot enforce it refuses the command. Empty is no ceiling.",
	],
	"safety.resources.workers.tasks": [
		"Worker command process ceiling",
		"Processes and threads one of a dispatched worker's commands may run at once; past it the command cannot start more. Linux with a systemd user manager only; a host that cannot enforce it refuses the command. Empty is no ceiling.",
	],
	"safety.resources.workers.cpuPercent": [
		"Worker command CPU ceiling (%)",
		"CPU one of a dispatched worker's commands may use, 100 being one core. Linux with a systemd user manager only; a host that cannot enforce it refuses the command. Empty is no ceiling.",
	],
	"context.compaction.provider": [
		"Provider compaction",
		"Use private native checkpoints on compatible Codex routes. Off uses portable PanCode summaries; switching routes generates a portable summary from the retained history.",
	],
	"safety.limits.workerResponseTimeoutMs": [
		"Worker response time",
		"Milliseconds one native worker model response may run, including locked synthesis rounds.",
	],
	"safety.limits.templateToolCallsPerTurnMax": [
		"Template tool calls ceiling",
		"How many tool calls a prompt template's budget may give its turn when it asks for more than Tools per chat turn. Empty lets a template only lower that limit.",
	],
	"safety.limits.templateObservationBytesPerTurnMax": [
		"Template tool output ceiling",
		"How many bytes of tool output a prompt template's budget may give its turn when it asks for more than Tool output per turn. Empty lets a template only lower that limit.",
	],
	"safety.limits.autonomousToolCalls": [
		"YOLO stretch tool calls",
		"Tool calls one YOLO stretch runs before it pauses for you to resume; 0 turns this cap off.",
	],
	"safety.limits.autonomousMinutes": [
		"YOLO stretch minutes",
		"Minutes of active turn time one YOLO stretch runs before it pauses for you to resume; 0 turns this cap off.",
	],
	"safety.limits.autonomousTokens": [
		"YOLO stretch tokens",
		"Tokens one YOLO stretch spends before it pauses for you to resume; 0 turns this cap off.",
	],
	"fleet.limits.runTimeoutMs": [
		"Worker run time",
		"Milliseconds one dispatched worker run may take, time queued for a slot included. At 85% it is told to hand back its report; at the limit it stops as timed out. A recipe or a dispatch's timeout_ms can only lower it.",
	],
	"safety.limits.bashIdleTimeoutMs": [
		"Bash idle timeout",
		"Milliseconds a foreground bash command may run with no output and no CPU use before it is stopped as idle; 0 turns this off.",
	],
	"context.semantic.enabled": [
		"Semantic search",
		"Make the optional project search index available to PanCode after pinning a qualified embedding route.",
	],
	"context.semantic.target": ["Embedding connection", "Target id of the qualified embedding route."],
	"context.semantic.model": ["Embedding model", "Exact model id served by the embedding target."],
	"context.semantic.assetIdentity": ["Embedding asset identity", "GGUF SHA-256 or a visible unverified operator label."],
	"context.semantic.projectorIdentity": [
		"Embedding projector identity",
		"Projector SHA-256 or operator label when using image or audio inputs.",
	],
	"context.semantic.canaryFingerprint": [
		"Embedding canary fingerprint",
		"Fixed canary result from semantic configure --qualify; a changed fingerprint selects a new index space.",
	],
	"context.semantic.modalities": ["Indexed media types", "Select text, image, audio, or mixed after qualification."],
	"context.semantic.background": [
		"Refresh semantic index in background",
		"Schedule bounded refresh at session start and after code map changes.",
	],
	"context.semantic.inboxes": [
		"Artifact inboxes",
		"Registered source folders. Prefer semantic inbox preview/add/remove for guided changes.",
	],
	"context.memory.surfaces.observe": [
		"Continuity preparation",
		"Let the memory model condense older turns in the background so compaction can reuse that record instead of summarizing them again. Starts only near a compaction that would send history to a separate summary request. Needs proactive memory on; off by default.",
	],
	"context.memory.surfaces.delivery": [
		"Lesson delivery",
		"Where kept lessons reach the model: off, the Memory section only, the section plus reminders at decision points (a failed command, a verification gap, a touched file, the turn's task), or those plus the first-change broadcast. Decision by default; memory_recall works in every mode.",
	],
	"context.memory.surfaces.lessons": [
		"Note authorship",
		"Who writes notes for later sessions: agent (the main agent gets memory_note in sessions that start with it, and PanCode binds its command or read as evidence), rules (PanCode files a failed command and the option change that fixed it), side (adds the memory model's lesson pass, only after such a fix), or off. Agent by default as a policy choice, not a measured win.",
	],
	"context.memory.surfaces.correct": [
		"Correction tier",
		"Rules, the default, warns after a repeated failure with no model call. Model also asks the memory model after two tool errors in a row or a loop-guard block. Rules by default as a policy choice: the model tier was measured costing calls without producing reminders.",
	],
	"context.memory.surfaces.bank": [
		"Task bank tier",
		"Rules, the default, records failures and operator statements in the task bank with no model call. Model also asks the memory model to maintain the bank every cadence of tool calls. Rules by default as a policy choice: the model tier's product was rarely read.",
	],
	"context.memory.sideShare": [
		"Memory side share",
		"After three automatic memory calls, a session skips more while its memory output tokens (and premium units, where the route reports them) exceed this share of its main output. Calls you ask for, such as remember, are never skipped. 0 turns the governor off.",
	],
	"context.memory.surfaces.history": [
		"History mining",
		"Let the memory model read the repository's earlier sessions while this one is idle and file the lessons it finds. Off by default; pancode memory consolidate tidies the store without a model call either way.",
	],
	"context.memory.thinkingLevel": [
		"Memory thinking",
		"How much the memory model reasons before it writes a memory step. Off, the default, asks for no reasoning; reasoning spends the memory output budget, and a model that cannot use the chosen level gets its nearest supported one, as in chat.",
	],
	"interface.exitSummary": [
		"Session summary on exit",
		"Print a summary of the session when PanCode exits. Output detail sizes it: compact a few rows, standard a fact table, detailed up to the terminal's height. Off prints only how to resume.",
	],
	"safety.sandbox": [
		"Command sandbox",
		"Run shell commands in an OS sandbox. At autonomy default your session's commands may write the workspace, scratch roots and package caches, with network through PanCode's egress proxy and credentials hidden, and run without asking; dispatched workers' commands write only the run's writable roots and a private /tmp. auto uses it when available, required refuses worker commands without it, off never sandboxes. Under required, scripts the yolo session runs are sandboxed too, or refused without a backend.",
	],
	"safety.egress.main.mode": [
		"Session shell network",
		"Network for your session's sandboxed commands. proxied gives them only PanCode's proxy: each host and port you have not allowed asks you once for this session, and headless runs deny it. A server a command starts listens only inside the sandbox, so your browser cannot reach it; run it from your own shell. off gives them no network; open leaves them on your network, unmonitored. A project layer may only lower it.",
	],
	"safety.egress.main.allow": [
		"Session shell allowed hosts",
		"Exact host:port origins your session's proxied commands reach without asking, such as registry.npmjs.org:443. IPv6 in brackets; no wildcards. User settings only.",
	],
	"safety.egress.main.presets": [
		"Session shell host presets",
		"Named exact host lists your session's proxied commands reach without asking: npm, pypi, github, crates, go. User settings only.",
	],
	"safety.egress.workers.mode": [
		"Worker shell network",
		"Network for dispatched workers' sandboxed commands. off, the default, gives them none, whatever web tools a worker holds. proxied lets them reach only the hosts allowed below, with no asks. open leaves them on your network, unmonitored. A project layer may only lower it.",
	],
	"safety.egress.workers.allow": [
		"Worker shell allowed hosts",
		"Exact host:port origins workers' proxied commands may reach. IPv6 in brackets; no wildcards. User settings only.",
	],
	"safety.egress.workers.presets": [
		"Worker shell host presets",
		"Named exact host lists workers' proxied commands may reach: npm, pypi, github, crates, go. User settings only.",
	],
	"safety.egress.upstreamProxy": [
		"Upstream proxy",
		"An http:// or https:// proxy PanCode's egress proxy sends allowed traffic through, for a network that reaches the internet only through one. Never read from HTTP_PROXY or a project. Credentials in it are never shown. User settings only.",
	],
	"safety.snapshots": [
		"Workspace snapshots",
		"Before PanCode first changes files in a turn, and before every destructive command, save the Git work tree as a private snapshot so /rewind can restore the files. Ignored files and untracked files over 16 MiB are left out. Your index, HEAD and branches are never touched. Off takes no snapshots.",
	],
	"safety.unattendedAfterMs": [
		"Unattended timeout",
		"Milliseconds a permission card or ask_user question waits for you before PanCode resolves it and keeps working: the parked call is denied, each unanswered question takes its recommended option unless that option leaves the workspace, and the session summary counts both. Any key on the card or question holds it. 0 waits forever, except that a YOLO question waits 300 s at most, and after one lapses with no key pressed since, later questions wait at most 30 s. User settings only.",
	],
	"safety.yoloAccepted": [
		"YOLO accepted",
		"Set when you accept the one-time card that turns YOLO on. Turn it off to see the card again. User settings only.",
	],
	"safety.yoloConfinement": [
		"YOLO confinement",
		"contained keeps default's sandbox, snapshots and safety judge, and refuses back to the agent what would wait for you, so nothing stops. unconfined is the skip-permissions YOLO: no sandbox unless safety.sandbox is required, only the YOLO floor and your approved safety.yaml rules block, and it has its own one-time card. User settings only.",
	],
	"safety.yoloUnconfinedAccepted": [
		"Unconfined YOLO accepted",
		"Set when you accept the separate card for unconfined YOLO; unconfined takes effect only when this is on, headless runs included. Turn it off to see that card again. User settings only.",
	],
	"safety.judge.enabled": [
		"Safety judge",
		"At autonomy default, a model reviews each call that would need your approval against your own messages, then runs it or refuses it back to PanCode with a reason. It asks you when it cannot decide, and after 3 refusals in a row or 20 in a session. User settings only.",
	],
	"safety.judge.target": [
		"Safety judge connection",
		"Connection the safety judge asks. Leave blank to use the chat connection. User settings only.",
	],
	"safety.judge.model": [
		"Safety judge model",
		"Model the safety judge asks. Leave blank to use the chat model, or the judge connection's default model. User settings only.",
	],
	"safety.judge.environment": [
		"Safety judge environment",
		"Facts about your environment the judge reads, such as 'shared HPC cluster; /scratch/$USER is mine'. User settings only.",
	],
	"safety.judge.allow": [
		"Safety judge allow rules",
		"Extra kinds of call the judge may run without your explicit request, added to its default rules. User settings only.",
	],
	"safety.judge.deny": [
		"Safety judge block rules",
		"Extra kinds of call the judge refuses unless you ask for that action, added to its default rules. User settings only.",
	],
	"safety.sandboxPassEnv": [
		"Sandbox environment pass-through",
		"Environment variables your sandboxed commands keep although they look like credentials. Every other token, key, password and URL with a password is removed before a sandboxed command starts, because it can reach the network without asking. User settings only.",
	],
	"safety.liveCheckTargets": [
		"Live-check login targets",
		"Target ids whose own login file your sandboxed commands may read, read-only, so a live check of a build can sign in (copilot-sdk targets: the official copilot login in $COPILOT_HOME/config.json). Dispatched workers keep it hidden. User settings only.",
	],
	"safety.sandboxUnixSockets": [
		"Sandbox unix sockets",
		"Block stops sandboxed commands from opening Unix sockets, because a socket they can reach (tmux, an X11 display, a daemon's control socket) can run commands outside the sandbox. Database sockets, Docker and other local IPC then fail inside it, and a command that needs one runs unsandboxed after review. Owned hides only the sockets you own (tmux, an X11 socket file, your agents) and leaves other users' reachable, such as the MUNGE and SSSD sockets cluster commands need; abstract sockets stay reachable. Allow leaves every socket reachable. User settings only.",
	],
	"safety.confine": [
		"Confined integrations",
		"Host-launched integrations that run in PanCode's OS sandbox: mcp:<server id> (main-session MCP servers), extension:<extension id> (a pack's binaries and panes), hooks (project and extension command hooks), git (the typed git tool) and jobs (scheduled job commands). Any other runs on the host as before and is labelled unconfined in its result, doctor and approval card. A project may only add entries.",
	],
	"safety.sandboxUnconfinedLocalWorkers": [
		"Unconfined local workers",
		"When this host has no usable OS sandbox, lets dispatched workers here run their shell and check commands with no sandbox, under your account with your files and network. Off refuses such a worker before it starts. safety.sandbox: required ignores it; fleet nodes keep their own allowUnsandboxed. User settings only.",
	],
	"safety.workerIsolation": [
		"Worker isolation",
		"Children sandboxes the commands a dispatched worker runs and leaves the worker process itself on this host with your provider login. Process also sends the worker's model calls through a route on this host that adds the credential, so the worker never holds it; workers that cannot (Claude SDK, CLI and ACP agents, fleet nodes, local model servers, non-Linux hosts) are refused instead. User settings only.",
	],
	"safety.validationWrappers": [
		"Validation wrappers",
		"Wrapper scripts that run a check with the words after them, such as a test-slot or CI launcher: a path matches that script, a bare name its basename. A command starting with one counts as the check it runs, so a finish after it is not assessed as unvalidated; the run still counts as a change, since the wrapper may write. A file writer, a shell, an interpreter, echo, cat, xargs and similar words are refused.",
	],
	"fleet.keepPeerInstructionFiles": [
		"Peers that keep their own instruction files",
		"Runtime ids (codex-cli, pi-cli, opencode-cli) of delegated harnesses that read their own repository instruction files unchanged, with the rules PanCode compiled for the run beside them. Others read the compiled rules in place of their files; claude-code always reads its own beside them.",
	],
	"safety.scratchRoots": [
		"Scratch roots",
		"Absolute directories your sandboxed commands and file edits may write at autonomy default without asking, and where deletes run as they do in the workspace. TMPDIR, /tmp and /var/tmp always count. User settings only.",
	],
	"safety.sandboxCacheMaxGiB": [
		"Sandbox cache cap (GiB)",
		"Size the sandbox's own tool cache (npm, pnpm, pip, uv and Playwright downloads of your sandboxed commands) may reach. Once a day at startup, and on pancode doctor --fix, the least recently used tool folders are removed until it fits, never while a running session may use them. 0 is no cap. User settings only.",
	],
	"safety.homeReads.main": [
		"Session shell home reads",
		"What your session's sandboxed commands may read under your home. open reads it all, apart from the hidden credentials. listed hides your home, and on WSL2 the Windows drives, except the workspace, scratch roots, PanCode's own files and the roots and toolchains listed below. ~/.gitconfig stays hidden unless listed, so git has no identity unless the repository sets one; ~/.ssh stays hidden in every mode. A project layer may only set listed.",
	],
	"safety.homeReads.workers": [
		"Worker shell home reads",
		"What dispatched workers' sandboxed commands may read under the home of the host they run on. open reads it all, apart from the hidden credentials; listed shows only the run's own roots, PanCode's own files and the roots and toolchains listed below. A project layer may only set listed.",
	],
	"safety.homeReads.roots": [
		"Home read roots",
		"Absolute paths, or paths starting with ~/ in the running host's home, that listed home reads show back read-only, such as ~/src/myproject or ~/.gitconfig. Not your home itself or a directory above it. User settings only.",
	],
	"safety.homeReads.toolchains": [
		"Home read toolchains",
		"Toolchain installs in your home that listed home reads show back read-only, each a fixed set of paths: nvm (~/.nvm), pyenv (~/.pyenv), rustup (~/.rustup and the proxies in ~/.cargo), cargo (~/.cargo), go (~/go, ~/.config/go), uv (~/.local/share/uv, ~/.config/uv, ~/.local/bin/uv and uvx). User settings only.",
	],
	"interface.demo": [
		"Demo presentation and guidance",
		"Welcome presentation and optional learning tips, bounded by output detail. Compact stays quiet; standard shows a short launchpad; detailed adds artwork and shortcut hints. Off starts with an identity header, skips welcome-only reads, and stops tips and the guidance profile. Immediate controls and warnings remain. Stream pacing, motion preferences and permissions are independent.",
	],
	"interface.guiTurnCapacity": [
		"Graphical app turns at once",
		"How many tasks in the graphical app may run a turn at the same time, from 1 to 16. Further requests are recorded in their task and start in order as running turns finish. Open tasks are not limited. A change made in the app applies to its next turn; a change made elsewhere applies when the app's server restarts.",
	],
	"interface.autoUpdate": [
		"Background updates",
		"A native install fetches and activates a newer release in the background; running sessions keep their version until restart, and upgrade --rollback undoes it. Off keeps the update notice and leaves the install to pancode upgrade. Package-manager installs only ever show their upgrade command.",
	],
	"integrations.externalAgents.entries": [
		"Custom agent definitions",
		"Add an external coding agent with its launch command and options as JSON. The command runs when you connect, so choose agents you trust. Use Available agents for guided setup.",
	],
	"fleet.default.node": [
		"Default worker location",
		"Where workers run unless their profile says otherwise. Enter local or a configured remote node name; clear to let PanCode choose.",
	],
	"fleet.profiles": [
		"Worker profiles",
		"Named target, model, thinking, and placement choices. Use Fleet's profile actions for guided edits, or edit this JSON object.",
	],
	models: [
		"Model tiers",
		'Map a model id to its tier (small, standard or frontier) for hooks and prompt template variants, as JSON such as {"qwen3-32b": {"tier": "small"}}. Unlisted models get a tier from their context window, size and catalog entry.',
	],
	"fleet.agentProfiles": [
		"Agent profile assignments",
		"Map native agent names to existing worker profile names. Use Fleet's binding actions or edit this JSON object.",
	],
	"chat.steering.triage.enabled": [
		"Steering triage",
		"Experimental. Once messages queued during a run settle, a side model reads them: an unrelated task waits for the end of the turn and a confident stop may interrupt the run. Off, every queued message lands where your key put it.",
	],
	"chat.steering.triage.target": [
		"Steering triage connection",
		"Connection the triage round uses. Empty uses the session's active connection.",
	],
	"chat.steering.triage.model": [
		"Steering triage model",
		"Model the triage round asks on that connection. Empty uses the connection's default model.",
	],
	"chat.steering.triage.thinkingLevel": [
		"Steering triage thinking",
		"How much the triage model reasons before it labels the queue. Off, the default, asks for no reasoning; a model that cannot use the chosen level gets its nearest supported one, as in chat.",
	],
	"chat.steering.triage.minQueued": [
		"Steering triage queue size",
		"Queued messages that start a triage round. Fewer are delivered as queued without a round.",
	],
	"chat.steering.triage.timeoutMs": [
		"Steering triage timeout",
		"Milliseconds a triage round may take before its answer is dropped and the queue stays as you left it.",
	],
	"chat.steering.triage.autoInterrupt": [
		"Steering triage may interrupt",
		"Let a confident stop reading cancel the run and deliver that message now. Off, it is only marked as urgent in the queue panel.",
	],
	"telemetry.mode": [
		"Telemetry mode",
		"Standard keeps call accounting and operational records without prompts, replies or other content. Research adds the capture switches below for this machine's sessions. Accountability records are kept in both modes. A project file can only lower it.",
	],
	"telemetry.research.content": [
		"Research: capture content",
		"In research mode, also keep content in the session's telemetry objects with secrets removed: the text of each distinct system prompt PanCode compiles, the body of each provider request (only its first 1 MiB when larger), and the prompts, replies and facts of background memory and compaction steps. Takes effect only in a workspace you consented for with pancode telemetry consent.",
	],
	"telemetry.research.deltas": [
		"Research: token timing",
		"In research mode, record each provider call's streaming timing: how many deltas it produced, a histogram of the gaps between them, the longest gap and the first-to-last span. No streamed text is kept.",
	],
	"telemetry.research.providerHeaders": [
		"Research: provider headers",
		"In research mode, record each provider call's response status and its allow-listed response headers: rate-limit and quota windows, request ids and server timing, each value cut to 256 characters. Cookies, auth echoes and every other header are never kept.",
	],
	"telemetry.research.busTrace": [
		"Research: bus trace",
		"In research mode, journal the name of every live event the telemetry hub delivers as a bus.traced record.",
	],
	"prompts.profile": [
		"Prompt profile",
		"Main-agent system prompt text: v1 is the current text, v2 the D-02 rewrite under evaluation. Applies from the next turn, which rereads the whole prompt once.",
	],
	"report.offers": [
		"Suggest reports",
		"When PanCode itself fails, such as an internal error or a crash, it may suggest /report: at most once a session and once a week, and never again for a problem you declined. Off never suggests. Nothing is sent without your keypress.",
	],
	"turnControl.hooks": [
		"Before PanCode answers",
		"Choose whether PanCode collects finished background runs before answering.",
	],
	"fleet.rosters": [
		"Fleet rosters",
		"Named teams of worker profiles used by council and fleet runs. Edit the JSON object; each roster names its members.",
	],
	"fleet.defaultNode": [
		"Standing worker node preference",
		"Unpinned work stays local until chosen. Explicit and profile pins take priority; leave blank to allow a session placement question.",
	],
	"fleet.nodes": [
		"Remote worker nodes",
		"A node is a machine PanCode can run workers on. Edit the JSON list of node details; adding one does not change the default model.",
	],
	"store.projectId": [
		"Store project id",
		"The name that keys this project's store instead of its checkout path, so hosts sharing a store root reach one store. Set only in the project's tracked .pancode/settings.yaml; 1 to 64 of a-z, 0-9, '.', '_' and '-'.",
	],
	"store.backend": [
		"Store backend",
		"Where the store keeps tags, user settings only: local keeps them in directories on this host (store.roots), shared in the folder store.shared names that several hosts mount, s3 in the S3-compatible bucket store.s3 names. Applies on the next start.",
	],
	"store.shared": [
		"Shared store folder",
		"The folder a shared store lives in, user settings only. Edit the JSON object { root }: an absolute directory that every host sharing the store mounts (the mount path may differ per host).",
	],
	"store.s3": [
		"S3 store bucket",
		"The bucket an s3 store lives in, user settings only. Edit the JSON object { endpoint, region, bucket, prefix, accessKeyId, pathStyle }; the secret key is stored by pancode store login.",
	],
	"store.roots": [
		"Store roots",
		"Directories the store keeps tags in, user settings only. Edit the JSON list of { name, path, durable, purge }; the first holds records and must be durable. Empty keeps the one store under the data directory.",
	],
	"store.placement.byTag": [
		"Store placement by tag",
		"The root a new tag is created on, by tag name. Edit the JSON object of tag to root name; an existing tag never moves.",
	],
	"store.placement.byClass": [
		"Store placement by class",
		"The root a new tag is created on, by tag class (input, output, cache, archive). Edit the JSON object of class to root name.",
	],
	"fleet.worktrees.root": [
		"Where task copies live",
		"Choose disk for the normal location, memory for temporary RAM storage, automatic to prefer memory when available, or enter an absolute directory you control.",
	],
	"chat.cacheKeepalive": [
		"Keep prompt cache warm",
		"While a turn waits on its own tools, such as an attached dispatch, refresh a hosted provider's prompt cache shortly before it expires when that is expected to save more than it costs. Applies to Anthropic, OpenAI and Codex routes.",
	],
	"chat.loopsUntilStopped": [
		"Loops run until stopped",
		"A /loop or job created without --count or --for keeps running until you run /loop stop, or its --until condition matches. The cost ceiling and loop guard still apply.",
	],
	"systemOne.use": [
		"Decision engine",
		"Experimental opt-in. Off until chosen. Names what answers the consult tool, the judge screen and steering triage, one route or an ordered list: jev, memory, main, a declared engine or a target. Applies on the next start. A hosted route receives web and MCP result text at judge time.",
	],
	"fleet.retry.breakerThreshold": [
		"Failures before cooldown",
		"Consecutive route failures before PanCode temporarily stops sending work to that route. A healthy request clears the failure count.",
	],
};
