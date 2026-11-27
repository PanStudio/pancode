// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** What the interactive application is given: the InteractiveDeps contract startInteractive fills, and the submit expansion it names. */
import type { PancodeSettings } from "../core/config.js";
import type { FlowRestrictionSet } from "../core/flow-restrictions.js";
import type { SettingsOrigin } from "../core/settings-layers.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { ConfigChangeSource } from "../core/telemetry/live-events.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import type { ContextState } from "../domains/context/index.js";
import type { DispatchContract, RouteBreakerView } from "../domains/dispatch/contract.js";
import type { ExtensionsContract } from "../domains/extensions/index.js";
import type { ExtensionRuntimeHookBridge } from "../domains/extensions/runtime-hook-bridge.js";
import type { InteropContract } from "../domains/interop/index.js";
import type { TaskMemoryOperatorStatus } from "../domains/memory/index.js";
import type { MuxContract } from "../domains/mux/index.js";
import type { MusicOperations } from "../domains/mux/music-operations.js";
import type { PanesOperations, PanesWatchController } from "../domains/mux/operations.js";
import type { ProvidersContract, ThinkingLevel } from "../domains/providers/index.js";
import type { ResourcesContract } from "../domains/resources/index.js";
import { expandSubmitText, type McpSubmitReader, type SubmitExpansion } from "../domains/resources/submit-expansion.js";
import type { AutonomyReport } from "../domains/safety/autonomy-window.js";
import type { FleetNodeSnapshot } from "../domains/scheduling/cluster.js";
import type { SchedulingContract } from "../domains/scheduling/contract.js";
import type { DecisionLedgerEntry } from "../domains/session/entries.js";
import type { SessionContract, SessionEntry, TaskBoardSnapshot } from "../domains/session/index.js";
import type { ShareContract } from "../domains/share/index.js";
import type { SystemOne } from "../domains/system-one/index.js";
import type { TelemetryContract, TelemetryRunReaderBinder } from "../domains/telemetry/index.js";
import type { UserTasksStore } from "../domains/user-tasks/store.js";
import type { ChatLoop } from "../session-control/chat-loop.js";
import type { ReloadClassesController } from "../session-control/reload-report.js";
import type {
	ContextClearCommandOptions,
	InitCommandOptions,
	RunIo,
	SlashCommandContext,
	TaskMemorySeedCommandResult,
} from "../session-control/slash-command-types.js";
import type { AskUserHandler } from "../tools/ask-user.js";
import type { JobOperations } from "../tools/job-types.js";
import type { ToolRegistry } from "../tools/registry-contract.js";
import type { createMuxBridge } from "./mux-bridge.js";
import type { createPeerInbox } from "./peer-inbox.js";
import type { BootInteractivity, TerminalLease } from "./terminal-lease.js";
import type { createWatchPaneController } from "./watch-pane.js";
import type { createYaziBridge, YaziBridge } from "./yazi-bridge.js";

export interface InteractiveDeps {
	getConnections?: () => { mcp: string[]; plugins: string[] };
	/** MCP prompts and resource mentions in a submitted request; see `expandSubmitText`. */
	mcpSubmit?: McpSubmitReader;
	bus: TelemetryHub;
	providers: ProvidersContract;
	dispatch: DispatchContract;
	agents?: AgentsContract;
	/** Session budget state `/fleet run` shows as the ceiling a plan is admitted under. */
	scheduling?: SchedulingContract;
	/** System One status lines for the `/usage` Health tab. */
	systemOneControl?: { run(): string[] };
	/** The session's System One instance, for the breakers the `/usage` Health tab shows. */
	systemOne?: SystemOne;
	telemetry: TelemetryContract;
	/** The owning composition's right to point the run projection at this terminal's live readers. */
	telemetryRunReaders?: TelemetryRunReaderBinder;
	chat: ChatLoop;
	/** Fired once after the first real TUI render transaction issued all of its terminal writes. */
	onFirstFrameCommit?: (frameId: number) => void;
	/** See EditorSubmitDeps.labelOperatorCommand. */
	labelOperatorCommand?: (command: string, cwd: string) => string | null;
	/** Runs before an operator shell line reaches the ledger, so a ledger fact can precede it. */
	beforeShellEntryRecorded?: () => void;
	/** Existing Stage 0 owner to hydrate in place. */
	terminalLease?: TerminalLease;
	/** `--session-file <path>` (absolute): where the session's exit record is written. */
	sessionFile?: string;
	/** Fired after the first committed frame containing the hydrated Stage 1 root. */
	onHydratedFrameCommit?: (frameId: number | null, interactivity: BootInteractivity) => void;
	/** Startup notices collected before the TUI is ready; rendered in the transcript. */
	initialNotices?: ReadonlyArray<string>;
	/** Why yolo cannot run here, read once at boot (root outside a container), or null (#407). */
	yoloRefusal?: string | null;
	/** The session was started at yolo and holds at default until the operator accepts it once (#407). */
	yoloHeldAtBoot?: boolean;
	resources?: ResourcesContract;
	extensions?: ExtensionsContract;
	/** `/reload extensions` seam; the composition root supplies the coordinator. */
	reloadExtensions?: SlashCommandContext["reloadExtensions"];
	/** Where api 2 hook registrations reach the runtimes this surface owns. */
	runtimeHooks?: ExtensionRuntimeHookBridge;
	reloadPlugins?: SlashCommandContext["reloadPlugins"];
	mcpStatuses?: SlashCommandContext["mcpStatuses"];
	reloadClasses?: ReloadClassesController;
	armRestartHandoff?: () => void;
	interop?: InteropContract;
	share?: ShareContract;
	/**
	 * Pane layer. A `none` contract still reaches the interactive surface so the
	 * files preset can use its terminal chooser; every mux operation remains
	 * best-effort and never reaches a dispatch or a turn.
	 */
	mux?: MuxContract;
	/**
	 * Pane-layer operations behind `/panes` and the `panes` tool. Built by the
	 * composition root so the tool registry and this surface drive one instance.
	 */
	panes?: PanesOperations;
	/** The music pane behind `/music` and its leader key. Absent without panes. */
	music?: MusicOperations;
	/**
	 * The shared job control behind `/loop`, from the composition root that owns
	 * the session. Absent where no session-owned job host exists, which `/loop`
	 * says instead of scheduling anything.
	 */
	jobs?: JobOperations;
	/**
	 * Factory seam for the dispatch-to-pane bridge, so a contract test can drive
	 * it without a TUI. Production leaves it unset and gets `createMuxBridge`.
	 */
	createMuxBridge?: typeof createMuxBridge;
	/** The peer prompt inbox, from the same composition root; absent on a plain boot. */
	createPeerInbox?: typeof createPeerInbox;
	/** Bind the file-pane return path after the composer and TUI exist. */
	attachYaziBridge?: (bridge: YaziBridge) => () => void;
	/**
	 * Watch-pane factory from the `--with-panes` composition root; absent on a
	 * plain boot. The controller it builds backs Enter in the workers view.
	 */
	createWatchPane?: typeof createWatchPaneController;
	/** Bind the watch controller into the shared PanesOperations for `/panes show`. */
	attachWatchPane?: (controller: PanesWatchController) => () => void;
	/**
	 * File-pane factory. Supplied by the `--with-panes` composition root (or a
	 * contract test); absent on a plain boot, which therefore loads no yazi code.
	 */
	createYaziBridge?: typeof createYaziBridge;
	/**
	 * Shared tool registry. When wired, the permission overlay opens automatically
	 * whenever a tool call is parked waiting for operator confirmation, and the
	 * confirm / cancel overlay handlers drive `resumeParkedCalls` /
	 * `cancelParkedCall` so blocked bash batches run (or reject cleanly)
	 * after the permission decision rather than stalling indefinitely.
	 */
	toolRegistry?: ToolRegistry;
	session?: SessionContract;
	/** Git hook files changed since this process started, for the exit summary (src/domains/safety/hook-drift.ts). */
	gitHookChanges?: () => ReadonlyArray<{ path: string; kind: string; key?: string }>;
	/** The yolo audit for the exit summary (src/domains/safety/autonomy-window.ts). */
	autonomy?: () => AutonomyReport | null;
	/** Read current session entries for replay/context rebuilds after local non-chat entries. */
	readSessionEntries?: () => ReadonlyArray<SessionEntry>;
	/** Live session task board for the footer tasks row and the /tasks overlay. */
	getTaskBoard?: () => TaskBoardSnapshot | null;
	/** Settled interview snapshots folded from the active session branch. */
	getDecisionBoard?: () => ReadonlyArray<DecisionLedgerEntry>;
	/** The flow ledger, for labels a failed `/handoff` could not land in a session. */
	absorbFlow?: (set: FlowRestrictionSet) => void;
	/** Whether a session carries an information-flow restriction; `/memory` will not promote out of one. */
	sessionFlowRestricted?: (sessionId: string) => boolean;
	/** Append an acknowledged operator-authored decision revision. */
	supersedeDecision?: (interviewId: string, key: string, correction?: string) => unknown;
	/** Project-scoped operator task inbox used by `/tasks` subcommands. */
	userTasks?: UserTasksStore;
	/** Live, read-only task-memory state for status surfaces and the /memory overlay. */
	getTaskMemoryStatus?: () => TaskMemoryOperatorStatus;
	/** Newest structured handoff available for an opt-in seed, when enabled. */
	getTaskMemorySeedOffer?: () => { source: string; count: number } | null;
	/** Merge the newest structured handoff into the current task bank. */
	seedTaskMemory?: () => TaskMemorySeedCommandResult;
	/** XDG state dir (pancodeStateDir()). `/view verify` reads the run's sealed scope under it. */
	stateDir: string;
	/** XDG data dir (pancodeDataDir()). The memory overlay reads and writes its records under it. */
	dataDir: string;
	/**
	 * Resolver for current settings. Footer reads the orchestrator target
	 * (what chat actually dispatches to) rather than the providers catalog's
	 * first-available entry.
	 */
	getSettings?: () => Readonly<PancodeSettings>;
	/** Live fleet node snapshots for the /fleet nodes view and node-pin editor. */
	getFleetNodes?: () => ReadonlyArray<FleetNodeSnapshot>;
	/** Live dispatch breaker state per route for the Settings → Targets rows. */
	getRouteBreakers?: () => ReadonlyArray<RouteBreakerView>;
	/** Optional resolver for the active session id used as the cost overlay title suffix. */
	getSessionId?: () => string | null;
	/** Install the TUI-backed ask_user handler for this interactive process. */
	registerAskUserHandler?: (handler: AskUserHandler) => () => void;
	/**
	 * Install the notice the `report` tool raises for an agent's saved draft (R-12). Only a notice: the review starts on
	 * the operator's own `/report send`, never mid-turn under keys typed for something else (R2b-report-05).
	 */
	registerReportReviewOpener?: (open: (draftId: string) => void) => () => void;
	/** Live PANCODE.md and memory state for the footer Context quadrant. */
	getContextState?: (cwd?: string) => ContextState;
	/**
	 * True when this process resumed an existing session at boot (`--continue`,
	 * `--session <id>`). The welcome header opens collapsed so a conversation
	 * with history is not topped by fresh-start onboarding.
	 */
	startsResumed?: boolean;
	/** `pancode --resume` without an id: the `/resume` picker opens once the first frame is out. */
	opensResumePicker?: boolean;
	/**
	 * Persist a thinking level set by `/thinking <level>` or `/model <pattern>:<level>`.
	 * Scope "session" leaves settings.yaml alone; omitted means the historical
	 * write-through, which is what the Shift+Tab cycle and `/thinking` still want.
	 */
	onSetThinkingLevel?: (
		level: ThinkingLevel,
		scope?: "session" | "project" | "global",
		source?: ConfigChangeSource,
	) => void;
	/** Persist the next thinking level when Shift+Tab is pressed. */
	onCycleThinking?: () => void;
	/**
	 * Apply the orchestrator target selected in /model at the scope the operator
	 * chose. "session" routes this session only and never touches settings.yaml.
	 */
	onSelectModel?: (
		ref: { target: string; model: string },
		scope: "session" | "project" | "global",
		source?: ConfigChangeSource,
	) => void;
	/** Write handler the /settings overlay uses to persist cycled values. */
	writeSettings?: (next: PancodeSettings) => void;
	/**
	 * Scoped commit for a single /settings edit. `id` is the config-path id, `next`
	 * the effective view with that one leaf changed. scope "session" applies live
	 * only; "global" also persists it as the default. Absent ⇒ the overlay falls
	 * back to writeSettings (global-only). Returns false when a gate held the
	 * change instead of applying it (the yolo acceptance card, #407).
	 */
	commitSetting?: (
		id: string,
		next: PancodeSettings,
		scope: "session" | "project" | "global",
		source?: ConfigChangeSource,
	) => unknown;
	/** Which layer set a setting's effective value; /settings shows it beside the value. */
	settingOrigin?: (path: string) => SettingsOrigin | "session";
	/** Resume a past session id. Called from the /resume overlay. */
	onResumeSession?: (sessionId: string) => void;
	/** Start a fresh session. Called from /new. */
	onNewSession?: () => void;
	/**
	 * Fork from a parent assistant turn picked in /fork. Default wiring
	 * delegates to session.fork(parentTurnId); the override exists so a
	 * host can layer telemetry or settings merging on top.
	 */
	onForkSession?: (parentTurnId: string) => void;
	/**
	 * Run `/context compact` for the current session. Resolves the compaction model
	 * (settings.context.compaction.model with fallback to the chat target),
	 * reads session entries, streams a summary via the session compaction
	 * engine, and persists a compactionSummary entry.
	 */
	onCompact?: (instructions: string | undefined) => Promise<void>;
	onRecoverHandoff?: (handoffId: string, action: "reduce" | "deliver") => Promise<void>;
	/** Run /context init for the current working directory. */
	onInit?: (options: InitCommandOptions, io?: RunIo) => Promise<unknown>;
	/** Run /context reset for the current working directory. */
	onContextClear?: (options: ContextClearCommandOptions, io?: RunIo) => Promise<void>;
	/** Run /context refresh: re-index codewiki and refresh .pancode state without touching PANCODE.md. */
	onContextRefresh?: (io?: RunIo) => Promise<void>;
	/**
	 * Advance the orchestrator target one step forward through `provider.scope`.
	 * False means nothing moved, which the UI answers with a notice: the keys are
	 * documented in the help center and a silent no-op reads as a dropped key.
	 */
	onCycleScopedModelForward?: () => boolean;
	/** Advance the orchestrator target one step backward through `provider.scope`. */
	onCycleScopedModelBackward?: () => boolean;
	/**
	 * Convert the newest attached `dispatch` call into a detached batch. The
	 * outcome carries the line to render: `ok: false` covers both "nothing is
	 * running" and a topology that refuses the conversion, and both read better
	 * as a notice than as a keypress that changes no pixel.
	 */
	onBackgroundDispatch?: () => { ok: boolean; message: string };
	onShutdown: () => Promise<void>;
}

/** The terminal's name for the shared submit expansion; see `expandSubmitText`. */
export type InteractiveSubmitExpansion = SubmitExpansion;
export const expandInteractiveSubmitAsync = expandSubmitText;
