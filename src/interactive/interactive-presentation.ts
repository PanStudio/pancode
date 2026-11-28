// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { PancodeSettings } from "../core/config.js";
import { DEFAULT_SETTINGS, outputStyleLabel } from "../core/defaults.js";
import { peekHarnessProfile, recordLessonShown, subscribeHarnessProfile } from "../core/harness-profile.js";
import type { JobRecord } from "../core/job-types.js";
import { setPresentationTier, tierPolicy } from "../core/presentation-tier.js";
import { probedSandboxAvailability } from "../core/sandbox/availability.js";
import { mainShellContained, yoloShellState } from "../core/sandbox/main-session.js";
import { sandboxOutcome } from "../core/sandbox/status.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { CompactionPayload } from "../core/telemetry/live-events.js";
import { motionEnabled } from "../core/terminal-preferences.js";
import type { NotificationLevel } from "../core/views/notice-words.js";
import type { AgentsContract } from "../domains/agents/contract.js";
import { listPlaybooks } from "../domains/agents/playbook.js";
import { isUserVisibleAgent } from "../domains/agents/spec.js";
import type { ContextState } from "../domains/context/index.js";
import { renderEffectivePromptContext } from "../domains/context/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { TaskMemoryOperatorStatus } from "../domains/memory/index.js";
import { PANES_PRESETS } from "../domains/mux/operations.js";
import { selectProjectPreload } from "../domains/prompts/preload.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import { resolveModelRuntimeCapabilitiesForProviders, thinkingLevelDisplayWord } from "../domains/providers/index.js";
import { createQuotaSummaryFeed } from "../domains/quota/summary-feed.js";
import type { ResourcesContract } from "../domains/resources/index.js";
import type { McpSubmitReader } from "../domains/resources/submit-expansion.js";
import { jobIsComplete } from "../domains/scheduling/job-model.js";
import type { LocalCapacity } from "../domains/scheduling/local-capacity.js";
import type { SessionContract, TaskBoardSnapshot } from "../domains/session/index.js";
import type {
	TelemetryContract,
	TelemetryRunReaderBinder,
	TokenThroughputSnapshot,
} from "../domains/telemetry/index.js";
import type { UserTasksStore } from "../domains/user-tasks/store.js";
import type { Component, ScrollView, TUI } from "../engine/tui.js";
import { truncateToWidth } from "../engine/tui.js";
import { effectiveYoloConfinement } from "../lib/autonomy/autonomy.js";
import { createAssistantGenerationTiming, liveThroughput } from "../session-control/assistant-generation-timing.js";
import type { ChatLoop, ChatLoopEvent } from "../session-control/chat-loop.js";
import type { RunIo } from "../session-control/slash-command-types.js";
import { parseSlashCommand } from "../session-control/slash-commands.js";
import { readWorkerRunResultFacts } from "../session-control/worker-run-results.js";
import type { JobOperations } from "../tools/job-types.js";
import { createBackgroundCallTracker } from "./background-calls.js";
import type { ChatPanel } from "./chat-panel.js";
import { createChatPanel } from "./chat-panel.js";
import type { CoalescingChatRenderer } from "./chat-renderer.js";
import { createCoalescingChatRenderer } from "./chat-renderer.js";
import { createCommandOutputRunIo } from "./command-output.js";
import { createContextActivityStore, createContextProgressRail } from "./context-activity.js";
import { admissionHint } from "./context-operation-view.js";
import type { DispatchBoardView } from "./dispatch-board.js";
import { createDispatchBoardView } from "./dispatch-board.js";
import { createDispatchBoardStore } from "./dispatch-board-store.js";
import { dockTop, setDockFooterRows } from "./dock.js";
import { parseEditorBashCommand, unguardPastedEditorOperator } from "./editor-bash.js";
import { parseEditorSteerMention, resolveSteerTarget } from "./editor-steer.js";
import {
	createFileReferenceCompletionSource,
	type FileReferenceCompletionSource,
} from "./file-reference-completion.js";
import { readDurableFleetPlans } from "./fleet-plan-history.js";
import { readDurableWorkerRuns, recordedRunUsage } from "./fleet-run-history.js";
import type { FollowUpQueuePanel } from "./follow-up-queue-panel.js";
import { createFollowUpQueuePanel } from "./follow-up-queue-panel.js";
import { harnessEditorChrome, projectThinkingRail } from "./footer/chrome-projection.js";
import type { FooterDashboardDeps, FooterDashboardPanel } from "./footer/dashboard.js";
import { buildFooterDashboard } from "./footer/dashboard.js";
import { createFleetBand, type FleetBand } from "./footer/fleet-band.js";
import type { ComposerKeyContext } from "./footer/key-hints.js";
import type { NotificationCenter } from "./footer/notifications.js";
import { createNotificationCenter, type Notification, routeAppliedNoticeKey } from "./footer/notifications.js";
import { COMPACT_KEYS_DOOR_LIFETIME } from "./footer/teaching.js";
import type { ShellSettlement, ToolTallySnapshot } from "./footer/widgets.js";
import type { HarnessFactsSource } from "./harness-facts.js";
import { createHarnessFactsSource } from "./harness-facts.js";
import { getActiveRenderTrace } from "./interactive-shell.js";
import { resolveThinkingCapability } from "./interactive-slash-runtime.js";
import type { PancodeKeybindingManager } from "./keybinding-manager.js";
import { actionKeyLabel, createKeybindingManager, formatKeyLabel } from "./keybinding-manager.js";
import { buildLayout, preserveTranscriptScroll } from "./layout.js";
import { mcpPromptArgumentSource, mcpPromptTemplates, mcpReferenceSource } from "./mcp-completion.js";
import { PancodeEditor } from "./pancode-editor.js";
import type { EditorChrome } from "./pancode-editor-model.js";
import type { QuotaProviders } from "./quota-view.js";
import type { SessionTranscript } from "./session-transcript.js";
import { createSilenceTranscriptRow } from "./silence-row.js";
import { type CompletionValue, createSlashCommandAutocompleteProvider } from "./slash-autocomplete.js";
import type { StatusController, TurnSummary } from "./status/index.js";
import { createStatusController, humanWaitTotalMs } from "./status/index.js";
import type { SmoothStreamingMode } from "./stream-pacer.js";
import { processAutoPacingAllowed } from "./stream-pacing-policy.js";
import type { WorkspaceSurfaces } from "./surfaces/registry.js";
import { createDropAlerts } from "./telemetry-drops.js";
import { ACTIVITY_STEP_MS } from "./theme/glyphs.js";
import { animationStep, GLYPH } from "./theme/index.js";
import { modelNickname } from "./theme/labels.js";
import type { WelcomeDashboardComponent, WelcomeShellSandbox } from "./welcome-dashboard.js";
import { createWelcomeDashboard } from "./welcome-dashboard.js";
import { bindWorkerResponseLimit } from "./worker-activity.js";
import type { WorkspaceFacts } from "./workspace-facts.js";

/** How long one `/skill <name>` listing serves later keystrokes. */
const SKILL_COMPLETION_TTL_MS = 2_000;
const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["enqueued", "running", "cancelling", "retrying"]);

function runAge(settledAtMs: number | undefined): string {
	if (settledAtMs === undefined) return "";
	const minutes = Math.max(0, Math.round((Date.now() - settledAtMs) / 60_000));
	if (minutes < 60) return ` ${GLYPH.sep} ${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? ` ${GLYPH.sep} ${hours}h ago` : ` ${GLYPH.sep} ${Math.round(hours / 24)}d ago`;
}

export interface PresentationTickerHandle {
	unref?(): void;
}

type DispatchBoardStore = ReturnType<typeof createDispatchBoardStore>;
type ContextActivityStore = ReturnType<typeof createContextActivityStore>;
type AutocompleteProvider = ReturnType<typeof createSlashCommandAutocompleteProvider>;

export interface InteractivePresentationFactories {
	createKeybindings: typeof createKeybindingManager;
	createBanner: (deps: Parameters<typeof createWelcomeDashboard>[0]) => WelcomeDashboardComponent;
	createChatPanel: typeof createChatPanel;
	createFollowUpQueuePanel: typeof createFollowUpQueuePanel;
	createStatusController: typeof createStatusController;
	createDispatchBoardStore: typeof createDispatchBoardStore;
	createContextActivityStore: typeof createContextActivityStore;
	createNotificationCenter: typeof createNotificationCenter;
	buildFooter: typeof buildFooterDashboard;
	createEditor: (tui: TUI, chrome: ConstructorParameters<typeof PancodeEditor>[1]) => PancodeEditor;
	createAutocomplete: typeof createSlashCommandAutocompleteProvider;
	createDispatchBoardView: typeof createDispatchBoardView;
	createChatRenderer: typeof createCoalescingChatRenderer;
	createIo: typeof createCommandOutputRunIo;
	buildLayout: typeof buildLayout;
}

export interface InteractivePresentationDeps {
	/** The live card for a run a replayed transcript finds still underway; see the chat panel's option. */
	adoptLiveWorker?: (runId: string) => import("../session-control/worker-stream.js").WorkerEntryState | undefined;
	/** The last slash command the operator ran, so a demo tip can name its key. */
	getLastCommand?: () => string | null;
	/** The header's reminder about project configuration that is not applied; cached by its owner. */
	getProjectConfigReminder?: () => string | null;
	getConnections?: () => { mcp: string[]; plugins: string[] };
	extensionCommands?: import("./slash-autocomplete.js").SlashAutocompleteOptions["extensionCommands"];
	/** Session facts that dim or omit palette rows, such as `/panes` without a pane host. */
	commandUnavailable?: (command: string) => string | undefined;
	commandHidden?: (command: string) => boolean;
	/** What an active extension workspace draws in place of the host's parts. */
	workspaceSurfaces?: WorkspaceSurfaces;
	getLifecycleHint?: () => string | null;
	bus: TelemetryHub;
	providers: ProvidersContract;
	dispatch: Pick<DispatchContract, "snapshot">;
	telemetry: TelemetryContract;
	/** Present when the composition owns the telemetry domain; the run board then reads live dispatch state. */
	telemetryRunReaders?: TelemetryRunReaderBinder;
	chat: ChatLoop;
	/** Messages waiting in the queue, which decides whether its keys are worth offering. */
	getQueuedMessageCount?: () => number;
	/** Whether the workers key reaches the workers dock rather than the Fleet Runs board. */
	workersDockAvailable?: () => boolean;
	workspaceFacts: WorkspaceFacts;
	sessionTranscript: Pick<SessionTranscript, "liveSessionTurns">;
	tui: TUI;
	terminal: { readonly columns: number; readonly rows?: number };
	mount?: (root: Component, editor: Component) => void;
	/** Stage 0's exact editor; when present no replacement editor is constructed. */
	editor?: PancodeEditor;
	/** Stage 0's already-installed keybinding manager and pi-tui global. */
	keybindings?: PancodeKeybindingManager;
	/** Pending boot submissions remain visible until serial admission removes them. */
	bootPending?: Component;
	getSettings?: () => Readonly<PancodeSettings>;
	resources?: Pick<ResourcesContract, "skillsForDisplay" | "promptsForDisplay">;
	/** MCP prompts as slash rows, `@<id>:` resource completion and prompt argument values. */
	mcpSubmit?: McpSubmitReader;
	agents?: Pick<AgentsContract, "listSpecs">;
	session?: Pick<SessionContract, "current">;
	recordTurnTiming?: (fields: { turnId: string; elapsedMs: number; humanWaitMs?: number }) => void;
	jobs?: Pick<JobOperations, "list" | "subscribe">;
	getSessionId?: () => string | null;
	getTaskBoard?: () => TaskBoardSnapshot | null;
	getLocalCapacity?: () => LocalCapacity | null;
	userTasks?: Pick<UserTasksStore, "snapshot">;
	getTaskMemoryStatus?: () => TaskMemoryOperatorStatus;
	getTaskMemorySeedOffer?: () => { source: string; count: number } | null;
	getContextState?: (cwd?: string) => ContextState;
	/** Whether the Ctrl+G leader is armed and waiting for its next key. */
	getLeaderArmed?: () => boolean;
	/** Whether a Ctrl+C armed the double tap and its window is still open. */
	getShutdownArmed?: () => boolean | string;
	/** Whether a permission prompt owns the keyboard, for the composer's CONFIRM rail. */
	isAwaitingApproval?: () => boolean;
	/** The overlay holding the keyboard, so a dock can stop naming composer keys while it does. */
	getOverlayState?: () => string;
	/** True while the Herdr Watch pane is visible; collapses the transient Fleet band to one summary rule. */
	isWatchPaneVisible?: () => boolean;
	/** Whether that prompt has a mutation to inspect, and whether it is open (issue #254). */
	getPermissionInspection?: () => import("./permission-hint.js").PermissionInspectionHint;
	/** Whether that prompt's terms are open, so the rail's Esc says it hides them rather than denying. */
	getPermissionTerms?: () => import("./permission-hint.js").PermissionTermsHint;
	getCwd?: () => string;
	/**
	 * True when this process resumed an existing session at boot (`--continue`,
	 * `--session <id>`). The header opens collapsed rather than showing
	 * fresh-start onboarding above a conversation that already has history.
	 */
	startsResumed?: boolean;
	resolveVisibleEventSequence?: (event: ChatLoopEvent) => number | null;
	resolveStreamIngress?: (
		event: ChatLoopEvent,
	) => { sequence: number; generation: string | number; ingressAt: number } | null;
	commitFrame?: (reason?: string) => Promise<unknown>;
	hasObservedBackpressure?: () => boolean;
	onSmoothStreamingMode?: (mode: SmoothStreamingMode, pacingActive: boolean) => void;
	scheduleInterval?: (callback: () => void, intervalMs: number) => PresentationTickerHandle;
	clearScheduledInterval?: (handle: PresentationTickerHandle) => void;
	now?: () => number;
	factories?: Partial<InteractivePresentationFactories>;
}

export interface PresentationToolEnd {
	toolCallId: string;
	isError: boolean;
	truncated: boolean;
	/** A chain that settled as steps the footer tallies on their own, so its start tally is withdrawn. */
	settledAsSteps?: boolean;
}

export interface InteractivePresentation {
	keybindings: PancodeKeybindingManager;
	banner: WelcomeDashboardComponent;
	chatPanel: ChatPanel;
	followUpQueuePanel: FollowUpQueuePanel;
	statusController: StatusController;
	dispatchBoardStore: DispatchBoardStore;
	contextActivityStore: ContextActivityStore;
	harnessFacts: HarnessFactsSource;
	/** True while the transient Fleet band or Herdr Watch pane owns live per-worker progress. */
	fleetOwnsLiveProgress(): boolean;
	footer: FooterDashboardPanel;
	notifications: NotificationCenter;
	notify(level: NotificationLevel, text: string, key?: string, ttlMs?: number): void;
	dismissContextBootstrapNotices(): void;
	announceTaskMemorySeedOffer(): void;
	collapseWelcomeDashboard(): void;
	editor: PancodeEditor;
	editorChrome: EditorChrome;
	dispatchBoard: DispatchBoardView;
	chatRenderer: CoalescingChatRenderer;
	io: RunIo;
	root: Component;
	changeOutputStyle(mutation: () => void): void;
	announceSettingChanges(): void;
	setLocalBashRunning(running: boolean, command?: string, settled?: ShellSettlement): void;
	/** The operator asked the running shell line to stop; it has not necessarily gone yet. */
	setLocalBashCancelling(): void;
	getQuotaSnapshots(): QuotaProviders;
	/** Fold one raw chat event into the ephemeral throughput shown only while this turn is active. */
	recordChatEvent(event: ChatLoopEvent): void;
	recordToolStart(toolCallId: string, toolName: string): void;
	recordToolEnd(result: PresentationToolEnd): void;
	/** The same accumulated tool counts shown by the footer. */
	toolCounts(): ReadonlyMap<string, number>;
	setLastTurnSummary(summary: TurnSummary | null): void;
	/** Drop every piece of presentation state that belonged to the old session. */
	resetForNewSession(): void;
	stopTickers(): void;
	disposeBeforeStatus(): void;
	disposeStatus(): void;
	dispose(): void;
}

const DEFAULT_FACTORIES: InteractivePresentationFactories = {
	createKeybindings: createKeybindingManager,
	createBanner: createWelcomeDashboard,
	createChatPanel,
	createFollowUpQueuePanel,
	createStatusController,
	createDispatchBoardStore,
	createContextActivityStore,
	createNotificationCenter,
	buildFooter: buildFooterDashboard,
	createEditor: (tui, chrome) => new PancodeEditor(tui, chrome),
	createAutocomplete: createSlashCommandAutocompleteProvider,
	createDispatchBoardView,
	createChatRenderer: createCoalescingChatRenderer,
	createIo: createCommandOutputRunIo,
	buildLayout,
};

/**
 * A draft whose Enter is not a message: PanCode runs it, wherever a turn is. `text` is what Enter submits
 * (`getTextForSubmit`): a pasted `!` stays a prompt, and a slash command reads through the paste envelope.
 */
function draftOperator(text: string): "command" | "shell" | null {
	if (parseEditorBashCommand(text)) return "shell";
	const kind = parseSlashCommand(unguardPastedEditorOperator(text).trim()).kind;
	return kind === "unknown" || kind === "empty" ? null : "command";
}

/** What Enter does with this draft, for the hint row, read from the text Enter submits. An empty composer has nothing to say about Enter. */
function draftKeyContext(
	submitted: string,
	streaming: boolean,
	holding: boolean,
	localShell: boolean,
	runsCommand: (token: string) => boolean = () => false,
): ComposerKeyContext {
	const text = unguardPastedEditorOperator(submitted);
	const empty = text.trim().length === 0;
	if (parseEditorBashCommand(submitted)) {
		if (streaming || localShell) return "shell-refused";
		return holding ? "hold" : "send-shell";
	}
	if (!empty && draftOperator(submitted) === "command") {
		const parsed = parseSlashCommand(text.trim());
		const name = truncateToWidth(text.trim().split(/\s+/u)[0] ?? "", 24, GLYPH.ellipsis, false);
		if (parsed.kind === "usage-error") return `usage:${name}`;
		// The parser knows only built-in commands; an installed extension's command runs too, and saying
		// Enter only "checks" it read as if the command were not there.
		if (parsed.kind === "unknown-command" && !runsCommand(parsed.token)) return `check:${name}`;
		return streaming ? `run-command:${name}` : `command:${name}`;
	}
	if (streaming) return empty ? "steer-empty" : "steer";
	if (holding) return empty ? "hold-empty" : "hold";
	if (localShell) return "shell";
	return empty ? "idle" : "send";
}

function willEnterSteerActiveWork(deps: InteractivePresentationDeps, text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0 || parseEditorBashCommand(text)) return false;
	const mention = parseEditorSteerMention(trimmed);
	if (mention) {
		let running: Array<{ runId: string; agentId: string }> = [];
		try {
			running = deps.dispatch.snapshot().running.map((run) => ({ runId: run.runId, agentId: run.agentId }));
		} catch {
			running = [];
		}
		if (running.length > 0) return resolveSteerTarget(mention.target, running).kind === "match";
	}
	return parseSlashCommand(trimmed).kind === "unknown";
}

/** The welcome's shell sandbox once the probe has landed; null before it, so the render path never probes. */
function welcomeShellSandbox(safety: Readonly<PancodeSettings>["safety"]): WelcomeShellSandbox | null {
	const known = probedSandboxAvailability();
	if (known === null) return null;
	return {
		outcome: sandboxOutcome(safety.sandbox, known),
		main: safety.sandbox === "off" ? "off" : mainShellContained(safety.sandbox, known) ? "contained" : "rails",
		yolo: yoloShellState(effectiveYoloConfinement(safety), safety.sandbox, known),
	};
}

/**
 * Construct the terminal-independent presentation graph around an injected
 * TUI. The composition root retains process/session ownership; this unit owns
 * visual components, their mutable footer projection, and their refresh
 * timers as one lifecycle.
 */
export function createInteractivePresentation(deps: InteractivePresentationDeps): InteractivePresentation {
	const factories = { ...DEFAULT_FACTORIES, ...deps.factories };
	const getCwd = deps.getCwd ?? (() => process.cwd());
	const now = deps.now ?? performance.now.bind(performance);
	const requestRender = (): void => deps.tui.requestRender();
	const sessionId = (): string | null => deps.session?.current()?.id ?? deps.getSessionId?.() ?? null;
	let loopSessionId = sessionId();
	let bumpFacts: (() => void) | undefined;
	const loopJobs = new Map<string, JobRecord>();
	let loopSnapshot: readonly JobRecord[] = [];
	const updateLoopSnapshot = (): void => {
		loopSnapshot = [...loopJobs.values()].sort((left, right) => {
			const priority = (job: JobRecord): number =>
				job.cancelRequested || job.active !== null || job.delivery?.state === "running"
					? 0
					: job.state === "paused"
						? 2
						: 1;
			return priority(left) - priority(right) || (left.nextDueAt ?? Infinity) - (right.nextDueAt ?? Infinity);
		});
	};
	const resetLoopJobs = (): void => {
		loopSessionId = sessionId();
		loopJobs.clear();
		for (const job of deps.jobs?.list() ?? []) {
			if (job.owner.sessionId === loopSessionId && !jobIsComplete(job)) loopJobs.set(job.id, job);
		}
		updateLoopSnapshot();
	};
	resetLoopJobs();
	const unsubscribeLoops = deps.jobs?.subscribe((job) => {
		if (loopSessionId !== sessionId()) resetLoopJobs();
		if (job.owner.sessionId !== loopSessionId) return;
		if (jobIsComplete(job)) loopJobs.delete(job.id);
		else loopJobs.set(job.id, job);
		updateLoopSnapshot();
		bumpFacts?.();
		requestRender();
	});
	const settings = deps.getSettings?.() ?? structuredClone(DEFAULT_SETTINGS);
	// Read per render, so a limit changed in /settings is the one a silent worker's words name.
	bindWorkerResponseLimit(() => {
		const seconds = (deps.getSettings?.() ?? settings).safety.limits.workerResponseSeconds;
		return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
	});
	const keybindings = deps.keybindings ?? factories.createKeybindings(settings);
	const { getExtensionStats, getLiveWorkspaceSnapshot, refreshLiveWorkspaceGit } = deps.workspaceFacts;
	/**
	 * The submit binding as the operator has it, or null when it is unbound or
	 * disabled. The header prints a key only when pressing it would actually
	 * submit, so a rebound or removed binding silently drops the hint instead of
	 * advertising a default that does nothing.
	 */
	const effectiveSubmitKeyLabel = (): string | null => {
		if (keybindings.isDisabled("tui.input.submit")) return null;
		const key = keybindings.getKeys("tui.input.submit")[0];
		return key === undefined || key.length === 0 ? null : formatKeyLabel(key, "");
	};

	const quotaSummary = createQuotaSummaryFeed({
		onUpdate: () => {
			footer?.refresh();
			requestRender();
		},
	});
	const announcedPreloadCwds = new Set<string>();
	const banner = factories.createBanner({
		providers: deps.providers,
		getTerminalRows: () => (deps.tui as Partial<Pick<TUI, "terminal">>).terminal?.rows,
		...(deps.agents ? { getAgentCount: () => deps.agents?.listSpecs().filter(isUserVisibleAgent).length ?? 0 } : {}),
		// The launchpad's Git row reads the same live probe as the footer, so the two never disagree about the repository.
		getWorkspaceSnapshot: getLiveWorkspaceSnapshot,
		// The authoritative project-context reader. It is synchronous on a cache
		// miss, so the banner refreshes it off the frame rather than calling it
		// during render; the frame that shows the result is asked for below.
		...(deps.getContextState ? { getContextState: deps.getContextState } : {}),
		getProjectPreload: (cwd) => {
			const current = deps.getSettings?.();
			const capabilities = resolveModelRuntimeCapabilitiesForProviders(
				deps.providers,
				current?.chat?.target,
				current?.chat?.model,
			)?.capabilities;
			const preload = selectProjectPreload(renderEffectivePromptContext(cwd), capabilities?.tools ?? null, {
				cwd,
			}).classification;
			// Coverage is a session fact, not something to put in the operator's face: one short footer
			// notice per workspace that expires, with /context holding the detail. The welcome shows nothing.
			if (preload.mode === "partial" && !announcedPreloadCwds.has(cwd)) {
				announcedPreloadCwds.add(cwd);
				const file = /^([^:]+):/u.exec(preload.label)?.[1] ?? "project instructions";
				queueMicrotask(() =>
					notifications.add({
						level: "info",
						text: `${file} is only partly loaded ${GLYPH.sep} /context for details`,
						key: "project-preload",
						ttlMs: 8_000,
					}),
				);
			}
			return null;
		},
		getSubmitKeyLabel: () => effectiveSubmitKeyLabel(),
		getKeyLabel: (action) => (keybindings.isDisabled(action) ? null : actionKeyLabel(action)),
		onFactsRefreshed: requestRender,
		// Subscription usage is read lazily off the render path and cached, so the
		// banner reads a string and never awaits a provider.
		getQuotaSummary: () => quotaSummary.peek(),
		getShellSandbox: () => welcomeShellSandbox((deps.getSettings?.() ?? settings).safety),
		...(deps.getProjectConfigReminder ? { getProjectConfigReminder: deps.getProjectConfigReminder } : {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		// The launchpad's `last here` fact; session history loads lazily, off the Stage 0 closure.
		readLastSession: async (cwd, now) => {
			const prior = (await import("../domains/session/history.js")).latestPriorSession(cwd, "", now, 1);
			return prior && { lastActiveAt: prior.lastActiveAt, preview: prior.firstMessagePreview, name: prior.name };
		},
	});
	// A boot-time `--continue`/`--session` resume opens onto an existing
	// conversation, so the launchpad's fresh-start onboarding would be a lie
	// before the operator has typed anything.
	if (deps.startsResumed === true) banner.collapseToSessionHeader();
	const renderTrace = getActiveRenderTrace();
	let fleetBandRef: FleetBand | undefined;
	const fleetOwnsLiveProgress = (): boolean =>
		fleetBandRef?.isVisible() === true ||
		deps.isWatchPaneVisible?.() === true ||
		deps.getOverlayState?.() === "dispatch-board";
	const chatPanel = factories.createChatPanel({
		getRunTarget: () => deps.chat.lastRunSnapshot?.()?.targetId ?? null,
		getRunModel: () => deps.chat.lastRunSnapshot?.()?.wireModelId ?? null,
		...(deps.telemetry.read ? { getTelemetry: () => deps.telemetry.read?.live() ?? null } : {}),
		getOutputStyle: () => deps.getSettings?.().interface.outputDetail ?? "standard",
		fleetOwnsLiveProgress,
		// The TUI mode needs a restart to change, so the boot settings name the renderer for the panel's life (#453).
		copyMarks: settings.interface.mode === "fullscreen",
		getTerminalRows: () => process.stdout.rows ?? 40,
		getStopRequestedAt: () => {
			const status = statusController.current();
			return status.phase === "cancelling" ? (status.cancelRequestedAt ?? null) : null;
		},
		getHumanWaitMs: () => humanWaitTotalMs(statusController.current(), Date.now()),
		...(deps.recordTurnTiming ? { recordTurnTiming: deps.recordTurnTiming } : {}),
		...(deps.adoptLiveWorker ? { adoptLiveWorker: deps.adoptLiveWorker } : {}),
		requestRender,
		...(renderTrace ? { onRenderMetrics: (metrics) => renderTrace.recordPanelRender(metrics) } : {}),
		// Rendering ahead yields to input between steps and waits out a stream.
		// A width, height or style change re-lays out the rows around the viewport at once and the rest in these idle
		// steps, on both screens (TUI-4). This is the one switch: without it a layout change renders every entry.
		deferRelayout: true,
		scheduleIdle: (step) => {
			const run = (): void => {
				if (tickersStopped) return;
				if (deps.chat.isStreaming()) {
					setTimeout(run, 250).unref();
					return;
				}
				if (step()) setImmediate(run).unref();
			};
			setImmediate(run).unref();
		},
	});
	const followUpQueuePanel = factories.createFollowUpQueuePanel({
		getNavigateKey: () => keybindings.actionLabel("pancode.queue.open"),
		getSendNowKey: () => keybindings.actionLabel("pancode.message.interrupt"),
		...(deps.getOverlayState ? { getOverlayState: deps.getOverlayState } : {}),
		isHeld: () => !deps.chat.isStreaming() && deps.chat.turnPreparation().phase === "idle",
	});
	const statusController = factories.createStatusController({
		chat: deps.chat,
		providers: deps.providers,
		bus: deps.bus,
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
	});
	const unbindRunReaders = deps.telemetryRunReaders?.bindRunReaders({
		dispatchSnapshot: () => deps.dispatch.snapshot(),
		readRunResult: (runId) => readWorkerRunResultFacts(runId),
	});
	const dispatchBoardStore = factories.createDispatchBoardStore(
		deps.telemetry,
		() => readDurableFleetPlans(getCwd(), deps.getSettings?.().fleet.worktrees.root),
		() => readDurableWorkerRuns(getCwd(), deps.getSettings?.().fleet.worktrees.root, requestRender),
		recordedRunUsage,
	);
	const contextActivityStore = factories.createContextActivityStore(deps.bus, () => deps.chat.getSessionId());

	const footerToolCounts = new Map<string, number>();
	const footerActiveTools = new Map<string, string>();
	let footerToolErrors = 0;
	let footerToolTruncatedResults = 0;
	let cachedToolCounts: ToolTallySnapshot | null = null;
	const currentToolCounts = (): ToolTallySnapshot => {
		if (cachedToolCounts !== null) return cachedToolCounts;
		cachedToolCounts = {
			tools: Object.fromEntries(footerToolCounts),
			errors: footerToolErrors,
			active: footerActiveTools.size,
			truncatedResults: footerToolTruncatedResults,
		};
		return cachedToolCounts;
	};
	let lastTurnSummary: TurnSummary | null = null;
	let telemetrySnapshot = deps.telemetry.snapshot();
	const generationTiming = createAssistantGenerationTiming();
	let liveGeneration = false;
	/** Routes that streamed reasoning this session, which the thinking rail then cannot deny. */
	const reasoningRoutes = new Set<string>();
	const routeKey = (target: string | null | undefined, model: string | null | undefined): string =>
		`${target ?? ""}#${model ?? ""}`;
	/** Route and asked level pairs a turn already ran under, so a level the route cannot honor is news once. */
	const thinkingNotesDelivered = new Set<string>();
	const thinkingNoteKey = (): string => {
		const chat = deps.getSettings?.()?.chat;
		return `${routeKey(chat?.target, chat?.model)}#${chat?.thinkingLevel ?? "off"}`;
	};
	const recordReasoningRoute = (event: ChatLoopEvent): void => {
		if (event.type !== "thinking_delta" || event.delta.length === 0) return;
		const current = deps.getSettings?.();
		const key = routeKey(current?.chat?.target, current?.chat?.model);
		if (reasoningRoutes.has(key)) return;
		reasoningRoutes.add(key);
		deps.tui.requestRender();
	};
	const recordChatEvent = (event: ChatLoopEvent): void => {
		generationTiming.record(event, now());
		if (event.type === "agent_start") {
			liveGeneration = true;
			thinkingNotesDelivered.add(thinkingNoteKey());
		}
		if (event.type === "agent_end") liveGeneration = false;
		recordReasoningRoute(event);
	};
	const currentLiveThroughput = (): TokenThroughputSnapshot | null =>
		liveGeneration ? liveThroughput(generationTiming, now()) : null;
	let footer: FooterDashboardPanel;
	const backgroundCalls = createBackgroundCallTracker(deps.bus, () => {
		footer?.refresh();
		requestRender();
	});
	/** A notice about the session's route stops the moment the route moves on, or the fault it reported clears. */
	const routeNoticeStands = (notice: Notification): boolean => {
		if (!notice.key?.startsWith("route-applied:")) return true;
		const route = deps.getSettings?.().chat;
		if (notice.key !== routeAppliedNoticeKey(route?.target, route?.model)) return false;
		if (notice.level !== "warning") return true;
		return deps.providers.list().find((status) => status.target.id === route?.target)?.health.status === "down";
	};
	const notifications = factories.createNotificationCenter({
		onChange: () => {
			footer?.refresh();
			requestRender();
		},
		stillTrue: routeNoticeStands,
	});
	const notify = (level: NotificationLevel, text: string, key?: string, ttlMs?: number): void => {
		notifications.add({ level, text, ...(key ? { key } : {}), ...(ttlMs === undefined ? {} : { ttlMs }) });
	};
	const dismissContextBootstrapNotices = (): void => {
		for (const notice of notifications.list()) {
			if (
				/^(?:pancode|pancode): (No PanCode(?:-CODER)?\.md detected|malformed PanCode(?:-CODER)?\.md ignored|Imported agent context changed)/.test(
					notice.text,
				)
			) {
				notifications.dismiss(notice.id);
			}
		}
	};
	const announceTaskMemorySeedOffer = (): void => {
		const offer = deps.getTaskMemorySeedOffer?.() ?? null;
		if (!offer || offer.count === 0) return;
		notify(
			"info",
			`task memory: ${offer.count} handoff entr${offer.count === 1 ? "y" : "ies"} available from ${offer.source}; run /memory seed to import`,
			"memory:seed-offer",
		);
	};

	let localBashStartedAt: number | null = null;
	// The footer composes once before the editor exists; until then no list can be open.
	let composerEditor: PancodeEditor | null = null;
	let localBashCommand: string | null = null;
	let localBashCancelledAt: number | null = null;
	/** The last direct shell line, until a model turn settles after it; idle leads with it while it is the newest event. */
	let lastShell: ShellSettlement | null = null;
	/** A compaction that stopped or failed since the last turn or shell line; the rail leads with it until either. */
	let lastCompactionStop: "cancelled" | "failed" | null = null;
	const currentAgentStatus = () => {
		const status = statusController.current();
		if (localBashStartedAt === null || (status.phase !== "idle" && status.phase !== "ended")) return status;
		return {
			...status,
			phase: localBashCancelledAt === null ? ("tool_running" as const) : ("cancelling" as const),
			since: localBashStartedAt,
			lastMeaningfulAt: Math.max(status.lastMeaningfulAt, localBashStartedAt),
			toolStartedAt: localBashStartedAt,
			activeTools: [],
			...(localBashCancelledAt === null ? {} : { cancelRequestedAt: localBashCancelledAt }),
			tool: {
				toolName: "bash",
				toolPreview: "local shell",
				startedAt: localBashStartedAt,
				operatorShell: true,
				...(localBashCommand === null ? {} : { toolSubject: localBashCommand }),
			},
		};
	};
	const harnessFacts = createHarnessFactsSource({
		providers: deps.providers,
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		getAgentStatus: currentAgentStatus,
		isStreaming: () => deps.chat.isStreaming(),
		getTurnPreparation: () => deps.chat.turnPreparation(),
		getContextUsage: () => deps.chat.contextUsage(),
		getContextLedger: () => deps.chat.contextLedger(),
		...(deps.getContextState
			? { getContextState: () => deps.getContextState?.(getCwd()) ?? { pancodeMd: "none", memoryCount: 0 } }
			: {}),
		getContextActivity: () => contextActivityStore.current(),
		getDispatchRows: () => dispatchBoardStore.rows(),
		getLiveDispatchRows: () => dispatchBoardStore.liveRows?.() ?? dispatchBoardStore.activeRows(),
		// A failure an earlier PanCode recorded is history for /fleet, never a live alarm in the band (fleet finding 14).
		getSettledWorkerRows: () => dispatchBoardStore.sessionWorkerRows?.() ?? [],
		getLoops: () => loopSnapshot,
		...(deps.getTaskBoard ? { getTaskBoard: deps.getTaskBoard } : {}),
		...(deps.getLocalCapacity ? { getLocalCapacity: deps.getLocalCapacity } : {}),
		...(deps.isWatchPaneVisible ? { isWatchPaneVisible: deps.isWatchPaneVisible } : {}),
		...(deps.telemetry.read ? { getTelemetry: () => deps.telemetry.read?.live() ?? null } : {}),
		getTokenThroughput: () => (liveGeneration ? currentLiveThroughput() : null),
		getQuotaSnapshots: () => {
			quotaSummary.peekSnapshots();
			return deps.telemetry.read?.quota().providers ?? [];
		},
		getToolCounts: currentToolCounts,
		getWorkspaceSnapshot: getLiveWorkspaceSnapshot,
		getSessionInfo: () => {
			const meta = deps.session?.current();
			return {
				id: meta?.id ?? deps.getSessionId?.() ?? null,
				name: meta?.name ?? null,
				turns: deps.sessionTranscript.liveSessionTurns(),
			};
		},
		getLastTurnSummary: () => lastTurnSummary,
		getLastShell: () => lastShell,
		getLastCompactionStop: () => lastCompactionStop,
		getExtensionStats,
		...(deps.getLifecycleHint ? { getLifecycleHint: deps.getLifecycleHint } : {}),
		...(deps.getConnections ? { getConnections: deps.getConnections } : {}),
		...(deps.getTaskMemoryStatus ? { getTaskMemoryStatus: deps.getTaskMemoryStatus } : {}),
		getNotifications: () => notifications.list(),
		getEndedNotifications: () => notifications.ended(),
		getBackgroundCalls: () => backgroundCalls.active(),
		...(deps.getLeaderArmed ? { getLeaderArmed: deps.getLeaderArmed } : {}),
		...(deps.getShutdownArmed ? { getShutdownArmed: deps.getShutdownArmed } : {}),
		getActiveEggs: () => deps.chat?.activeEggs?.() ?? [],
		getActiveSkillSurface: () => deps.chat?.activeSkillSurface?.() ?? [],
		getAutonomyStatus: () => deps.chat?.autonomyStatus?.() ?? null,
		hasReasoningRoute: (targetId, modelId) => reasoningRoutes.has(routeKey(targetId, modelId)),
		hasDeliveredThinkingNote: (targetId, modelId, level) =>
			thinkingNotesDelivered.has(`${routeKey(targetId, modelId)}#${level}`),
		getDismissKeyLabel: () => keybindings.actionLabel("pancode.notifications.dismiss"),
	});
	bumpFacts = () => harnessFacts.bump();
	// Only bump footer facts when footer-visible status fields change; steady-state text_delta
	// updates only advance `lastMeaningfulAt` (read directly by `silenceRow`) and must not force
	// `facts.snapshot()` / `#historyBudget` recomputation during streaming.
	let lastBumpedStatus = statusController.current();
	const unsubscribeStatusFacts = statusController.subscribe?.((next) => {
		const prev = lastBumpedStatus;
		if (
			prev.phase === next.phase &&
			prev.since === next.since &&
			prev.watchdogTier === next.watchdogTier &&
			prev.phaseSince === next.phaseSince &&
			prev.toolStartedAt === next.toolStartedAt &&
			prev.cancelRequestedAt === next.cancelRequestedAt &&
			prev.preparingToolCall === next.preparingToolCall &&
			prev.writingCallAsText === next.writingCallAsText &&
			prev.tool?.toolName === next.tool?.toolName &&
			prev.tool?.toolSubject === next.tool?.toolSubject &&
			prev.tool?.judging === next.tool?.judging &&
			prev.tool?.operatorShell === next.tool?.operatorShell &&
			prev.retry === next.retry &&
			prev.summary === next.summary &&
			prev.modelRequest === next.modelRequest &&
			(prev.activeTools?.length ?? 0) === (next.activeTools?.length ?? 0) &&
			(prev.activeTools ?? []).every((item, idx) => item === next.activeTools?.[idx])
		) {
			return;
		}
		lastBumpedStatus = next;
		harnessFacts.bump();
	});
	const fleetBand: FleetBand = createFleetBand({
		facts: harnessFacts,
		isDeckOpen: () => footer?.isExpanded() === true,
		isDockOpen: () =>
			dockTop(deps.tui) !== null || (deps.getOverlayState !== undefined && deps.getOverlayState() !== "closed"),
		isFleetBoardOpen: () => deps.getOverlayState?.() === "dispatch-board",
		...(deps.isWatchPaneVisible ? { isWatchPaneVisible: deps.isWatchPaneVisible } : {}),
		getTerminalRows: () => deps.terminal.rows ?? process.stdout.rows ?? 40,
		...(deps.now ? { now: deps.now } : {}),
	});
	fleetBandRef = fleetBand;
	const contextProgress = createContextProgressRail(
		() => contextActivityStore.current(),
		(activity) =>
			admissionHint(activity, {
				streaming: deps.chat.isStreaming(),
				preparation: deps.chat.turnPreparation().phase,
			}),
	);
	const footerDeps: FooterDashboardDeps = {
		facts: harnessFacts,
		providers: deps.providers,
		fleetBand,
		contextProgress,
		isFleetBoardOpen: () => deps.getOverlayState?.() === "dispatch-board",
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		getWelcomeVisible: () => banner.isLaunchpadVisible?.() === true,
		...(deps.getLastCommand ? { getLastCommand: deps.getLastCommand } : {}),
		...(deps.workspaceSurfaces
			? {
					getExtensionFacts: () => deps.workspaceSurfaces?.statusFacts() ?? [],
					getWorkspaceLine: (width: number) => deps.workspaceSurfaces?.footerLine(width) ?? null,
				}
			: {}),
		getTerminalColumns: () => deps.terminal.columns,
		getTerminalRows: () => deps.terminal.rows ?? process.stdout.rows ?? 40,
		onHeightChange: (rows) => {
			if (setDockFooterRows(deps.tui, rows)) requestRender();
		},
		getKeyContext: () => {
			if (dockTop(deps.tui) !== null || composerEditor?.isShowingAutocomplete()) return "surface";
			const text = composerEditor?.getText() ?? "";
			const trimmed = text.trimStart();
			const streaming = deps.chat.isStreaming();
			const holding = deps.chat.turnPreparation().phase !== "idle";
			const localShell = localBashStartedAt !== null;
			// Fast path for plain non-empty drafts: cannot be a shell (`!`), slash (`/`), or `@agent` steer mention.
			if (trimmed.length > 0) {
				const lead = trimmed.charCodeAt(0);
				if (lead !== 33 /* ! */ && lead !== 47 /* / */ && lead !== 64 /* @ */) {
					return streaming ? "steer" : holding ? "hold" : localShell ? "shell" : "send";
				}
			}
			// The rail under a draft addressed to a worker already names its Enter and Esc.
			if (trimmed.length > 0 && composerEditor?.steerTarget(text)) return "surface";
			// A stop already asked for owns an empty composer's hint until the work has exited.
			const stopping = localBashCancelledAt !== null || currentAgentStatus().phase === "cancelling";
			if (stopping && trimmed.length === 0) return "stopping";
			const context = draftKeyContext(
				trimmed.length === 0 ? "" : (composerEditor?.getTextForSubmit() ?? ""),
				streaming,
				holding,
				localShell,
				(token) => deps.extensionCommands?.().some((row) => row.available && row.invocation === token) ?? false,
			);
			// A failed turn is the newest thing on screen until a shell line or another turn follows it.
			return context === "idle" && lastShell === null && lastTurnSummary?.stopReason === "error" ? "recover" : context;
		},
		getKeyHintFacts: () => {
			const mechanism = harnessFacts.thinking().capability?.mechanism;
			return {
				...(deps.getQueuedMessageCount ? { queued: deps.getQueuedMessageCount() } : {}),
				workers: dispatchBoardStore.rows().length,
				...(deps.workersDockAvailable ? { workersDock: deps.workersDockAvailable() } : {}),
				thinkingCycles: mechanism === "effort-levels" || mechanism === "budget-tokens",
				learned: (feature: string) => (peekHarnessProfile().profile.features[feature] ?? 0) > 0,
			};
		},
	};
	footer = factories.buildFooter(footerDeps);
	const unsubscribeProfile = subscribeHarnessProfile(() => {
		harnessFacts.bump();
		footer.refresh();
		requestRender();
	});
	const unsubscribeProjection = deps.telemetry.subscribe((snapshot) => {
		telemetrySnapshot = snapshot;
		harnessFacts.bump();
		footer.refresh();
		requestRender();
	});
	// Spend repaints on persisted batches only, coalesced to 10 Hz by the read model; never per token (#434 §11.3).
	// One listener for every topic, so an update naming several repaints once.
	const repaintSpend = () => {
		harnessFacts.bump();
		footer.refresh();
		requestRender();
	};
	const unsubscribeTelemetry = (["session", "calls", "cost", "runs", "quota"] as const).map(
		(topic) => deps.telemetry.read?.subscribe(topic, repaintSpend) ?? (() => {}),
	);
	// A journal that loses records raises one notice per owner a minute; a rise held by the window is checked when
	// the window ends, so it is never left unreported (#434 §14).
	const dropAlerts = createDropAlerts();
	let dropCheck: NodeJS.Timeout | undefined;
	const checkDrops = () => {
		const readModel = deps.telemetry.read;
		if (!readModel) return;
		const now = Date.now();
		const alerts = dropAlerts.observe(readModel.health(), now);
		for (const alert of alerts) notify("warning", alert.text, alert.key);
		if (alerts.length > 0) requestRender();
		if (dropCheck) clearTimeout(dropCheck);
		dropCheck = undefined;
		const due = dropAlerts.nextCheckAt();
		if (due === null) return;
		dropCheck = setTimeout(checkDrops, Math.max(0, due - now));
		dropCheck.unref();
	};
	unsubscribeTelemetry.push(deps.telemetry.read?.subscribe("health", checkDrops) ?? (() => {}));
	// A compaction's end is the rail's newest fact until a turn or shell line replaces it.
	if (typeof deps.bus?.subscribe === "function") {
		unsubscribeTelemetry.push(
			deps.bus.subscribe("context.activity_changed", () => {
				harnessFacts.bump();
				footer?.refresh();
				requestRender();
			}),
			deps.bus.subscribe("compaction.started", () => {
				lastCompactionStop = null;
			}),
			deps.bus.subscribe("compaction.ended", (payload: CompactionPayload) => {
				lastCompactionStop = payload?.outcome === "cancelled" || payload?.outcome === "failed" ? payload.outcome : null;
				footer?.refresh();
				requestRender();
			}),
		);
	}

	let compactKeysDoorCounted = false;
	const editorChrome: EditorChrome = {
		...harnessEditorChrome(harnessFacts),
		getMotionEnabled: () => motionEnabled(),
		isStreaming: () => deps.chat.isStreaming(),
		...(deps.isAwaitingApproval ? { isAwaitingApproval: deps.isAwaitingApproval } : {}),
		...(deps.getPermissionInspection ? { getPermissionInspection: deps.getPermissionInspection } : {}),
		...(deps.getPermissionTerms ? { getPermissionTerms: deps.getPermissionTerms } : {}),
		getTurnPreparation: () => deps.chat.turnPreparation().phase,
		willEnterSteer: (text) => willEnterSteerActiveWork(deps, text),
		getDraftOperator: draftOperator,
		getSteerRecipient: (token) => {
			try {
				const running = deps.dispatch.snapshot().running.map((run) => ({
					runId: run.runId,
					agentId: run.agentId,
					...(run.outcomePhase === "queued" ? { queued: true } : {}),
				}));
				const resolved = resolveSteerTarget(token, running);
				return resolved.kind === "match" ? { agentId: resolved.run.agentId, queued: resolved.run.queued === true } : null;
			} catch {
				// The rail repaints every frame; an unreadable fleet just leaves it unlabelled.
				return null;
			}
		},
		...(deps.getQueuedMessageCount ? { getQueuedFollowUpCount: deps.getQueuedMessageCount } : {}),
		getQueueReviewKeyLabel: () => keybindings.actionLabel("pancode.queue.open") ?? null,
		isShellDraftLearned: () => (peekHarnessProfile().profile.features["!"] ?? 0) > 0,
		showCompactKeysDoor: () => {
			if (tierPolicy().hintRow) return false;
			if (deps.getSettings?.().interface.demo === false) return false;
			const { profile, hydrated } = peekHarnessProfile();
			if (!hydrated) return false;
			if ((profile.features["?"] ?? 0) > 0) return false;
			return compactKeysDoorCounted || (profile.lessons["compact:keys"]?.shown ?? 0) < COMPACT_KEYS_DOOR_LIFETIME;
		},
		onCompactKeysDoorShown: () => {
			if (compactKeysDoorCounted) return;
			compactKeysDoorCounted = true;
			setImmediate(() => recordLessonShown("compact:keys"));
		},
		getSubmitKeyLabel: () => formatKeyLabel(keybindings.getKeys("tui.input.submit")[0], "Enter"),
		getNewlineKeyLabel: () => formatKeyLabel(keybindings.getKeys("tui.input.newLine")[0], "Ctrl+J"),
	};
	const editor = deps.editor ?? factories.createEditor(deps.tui, editorChrome);
	composerEditor = editor;
	// The setting the operator chose, not the rail's reading of it: a capability probe landing after launch moved the
	// label and announced `Think Off` as if someone had changed it (F5).
	const readSettingState = () => ({
		thinking: deps.getSettings?.()?.chat?.thinkingLevel ?? "off",
		output: harnessFacts.tier(),
		autonomy: harnessFacts.autonomyMode(),
	});
	let lastSettingState = readSettingState();
	// Boot sync of the process-wide tier; every later change reaches it through announceSettingChanges or Alt+O.
	setPresentationTier(lastSettingState.output);
	const announceSettingChanges = (): void => {
		const next = readSettingState();
		const previous = lastSettingState;
		lastSettingState = next;
		// The settings overlay, hot reload and the yolo card commit without changeOutputStyle; this observer sees them all.
		setPresentationTier(next.output);
		const changes: string[] = [];
		if (next.thinking !== previous.thinking) {
			// The shared thinking projection, so the toast, the footer and the picker name one state alike (bt-11).
			const projected = projectThinkingRail(harnessFacts.thinking());
			const words = !projected.quiet ? `${projected.label}${projected.note ? ` (${projected.note})` : ""}` : next.thinking;
			changes.push(`Thinking set to ${words}`);
		}
		if (next.output !== previous.output) changes.push(`Output detail: ${outputStyleLabel(next.output)}`);
		if (next.autonomy !== previous.autonomy)
			changes.push(`Autonomy set to ${next.autonomy === "yolo" ? "YOLO" : next.autonomy}`);
		if (changes.length)
			notifications.add({
				level: "info",
				text: changes.join(` ${GLYPH.sep} `),
				key: "settings:feedback",
				presentation: "setting",
				ttlMs: 3_000,
			});
	};
	editor.focused = true;
	let skillCompletions: { cwd: string; at: number; items: CompletionValue[] } | undefined;
	let playbookCompletions: { cwd: string; at: number; items: CompletionValue[] } | undefined;
	let pathSource: { cwd: string; source: FileReferenceCompletionSource } | undefined;
	/** The removed workspace already announced, so the notice shows once and not per keystroke. */
	let goneCwd: string | undefined;
	const settingKeys = (record: Readonly<Record<string, unknown>> | undefined, description: string): CompletionValue[] =>
		Object.keys(record ?? {}).map((key) => ({ id: key, value: key, label: key, description }));
	const runValues = (finishedOnly: boolean): CompletionValue[] =>
		dispatchBoardStore
			.rows()
			.filter((row) => !finishedOnly || !LIVE_RUN_STATUSES.has(row.status))
			.slice()
			.sort((a, b) => (b.settledAtMs ?? 0) - (a.settledAtMs ?? 0))
			.map((row) => ({
				id: row.runId,
				value: row.runId,
				label: row.runId,
				description: `${row.agentId} ${GLYPH.sep} ${row.status}${runAge(row.settledAtMs)}`,
			}));
	const autocomplete: AutocompleteProvider = factories.createAutocomplete({
		isTurnInFlight: () => deps.chat.isStreaming(),
		commandCounts: () => peekHarnessProfile().profile.features,
		// Completion runs per keystroke and only names templates, so it reads the
		// committed plugin snapshot; submitting one verifies its tree first.
		promptTemplates: () => {
			const cwd = getCwd();
			if (goneCwd !== cwd && !existsSync(cwd)) {
				goneCwd = cwd;
				notify(
					"warning",
					`The workspace directory no longer exists, so completion lists built-in commands only; restart PanCode in an existing directory (${cwd}).`,
					"workspace:missing",
				);
			}
			const templates = deps.resources?.promptsForDisplay(cwd).items ?? [];
			return deps.mcpSubmit ? [...templates, ...mcpPromptTemplates(deps.mcpSubmit, templates)] : templates;
		},
		...(deps.mcpSubmit
			? {
					promptArguments: mcpPromptArgumentSource(deps.mcpSubmit),
					fileReferenceSource: mcpReferenceSource(
						deps.mcpSubmit,
						createFileReferenceCompletionSource({ basePath: process.cwd() }),
					),
				}
			: {}),
		...(deps.extensionCommands ? { extensionCommands: deps.extensionCommands } : {}),
		...(deps.commandUnavailable ? { unavailable: deps.commandUnavailable } : {}),
		...(deps.commandHidden ? { hidden: deps.commandHidden } : {}),
		completionSources: {
			agents: async () => {
				const fleet = (deps.agents?.listSpecs() ?? []).filter(isUserVisibleAgent).map((agent) => ({
					id: agent.id,
					value: agent.id,
					label: agent.id,
					description: agent.description,
				}));
				// External agents follow, marked; a name a fleet agent already owns takes `acp:` to reach them.
				const taken = new Set(fleet.map((row) => row.id));
				const external = (deps.getSettings?.().integrations.externalAgents.entries ?? []).map((entry) => {
					const value = taken.has(entry.id) ? `acp:${entry.id}` : entry.id;
					return { id: value, value, label: value, description: `external ${GLYPH.sep} ${entry.command}` };
				});
				return [...fleet, ...external];
			},
			targets: async () =>
				deps.providers.list().map(({ target, reason }) => ({
					id: target.id,
					value: target.id,
					label: target.id,
					description: reason,
				})),
			models: async () =>
				deps.providers.list().flatMap(({ target, discoveredModels, discoveredModelLabels }) =>
					[
						...new Set([
							...(target.defaultModel ? [target.defaultModel] : []),
							...(target.wireModels ?? []),
							...discoveredModels,
						]),
					].map((model) => ({
						id: `${target.id}/${model}`,
						value: model,
						label: discoveredModelLabels?.[model] ?? model,
						description: target.id,
					})),
				),
			// Runs per keystroke while `/skill <name>` is typed. It only names skills, so
			// it skips the tree digest, and the short memo spares a large catalog a rescan
			// per key. A skill added or reloaded shows within SKILL_COMPLETION_TTL_MS.
			skills: async () => {
				const cwd = getCwd();
				const now = Date.now();
				if (skillCompletions?.cwd === cwd && now - skillCompletions.at < SKILL_COMPLETION_TTL_MS)
					return skillCompletions.items;
				const items = (deps.resources?.skillsForDisplay(cwd).items ?? []).map((skill) => ({
					id: skill.name,
					value: skill.name,
					label: skill.name,
					description: skill.description,
				}));
				skillCompletions = { cwd, at: now, items };
				return items;
			},
			tasks: async ({ subcommand }) =>
				(deps.userTasks?.snapshot() ?? [])
					.filter((task) =>
						subcommand === "hand"
							? task.status === "open"
							: task.status === "open" || task.status === "handed" || task.status === "picked",
					)
					.map((task) => ({
						id: task.id,
						value: task.id,
						label: task.title,
						description: task.status,
					})),
			"thinking-levels": async () => {
				const settings = deps.getSettings?.();
				if (!settings) return [];
				const thinking = resolveThinkingCapability(deps.providers, settings);
				// What the route runs, not what the setting asked for: a level the model lacks resolves to another.
				const current = thinking?.effectiveLevel ?? "off";
				const levels = thinking?.supportedLevels ?? ["off"];
				return [...levels]
					.sort((a, b) => Number(b === current) - Number(a === current))
					.map((level) => ({
						id: level,
						value: level,
						label: level,
						description: `${thinkingLevelDisplayWord(thinking?.mechanism ?? null, level)}${level === current ? ` ${GLYPH.sep} current` : ""}`,
					}));
			},
			// Parses every playbook file, so it shares the skills memo's window.
			playbooks: async () => {
				const cwd = getCwd();
				const now = Date.now();
				if (playbookCompletions?.cwd === cwd && now - playbookCompletions.at < SKILL_COMPLETION_TTL_MS)
					return playbookCompletions.items;
				const items = listPlaybooks(cwd).map((listing) => ({
					id: listing.name,
					value: listing.name,
					label: listing.name,
					description: listing.playbook?.description ?? listing.error?.replace(/^playbook \S+: /u, "") ?? listing.source,
				}));
				playbookCompletions = { cwd, at: now, items };
				return items;
			},
			rosters: async () => settingKeys(deps.getSettings?.().fleet.rosters, "roster"),
			"agent-profiles": async () => settingKeys(deps.getSettings?.().fleet.profiles, "worker profile"),
			"external-agents": async () =>
				(deps.getSettings?.().integrations.externalAgents.entries ?? []).map((entry) => ({
					id: entry.id,
					value: entry.id,
					label: entry.id,
					description: entry.command,
				})),
			"shareable-runs": async () => runValues(true),
			runs: async () => runValues(false),
			"pane-presets": async () =>
				PANES_PRESETS.map((preset) => ({
					id: preset.id,
					value: preset.id,
					label: preset.id,
					description: preset.summary,
				})),
			paths: async ({ prefix, signal }) => {
				const cwd = getCwd();
				if (pathSource?.cwd !== cwd) pathSource = { cwd, source: createFileReferenceCompletionSource({ basePath: cwd }) };
				const values = await pathSource.source({ query: prefix, signal });
				return values.map((value) => {
					const path = value.isDirectory ? `${value.path}/` : value.path;
					// The `@` list opens a directory in place; here a directory is just a value.
					const opens = ` ${GLYPH.sep} Tab/Enter opens`;
					const description = value.description.endsWith(opens)
						? value.description.slice(0, -opens.length)
						: value.description;
					return { id: value.id, value: path, label: path, description };
				});
			},
		},
	});
	editor.setAutocompleteProvider(autocomplete);

	const dispatchBoard = factories.createDispatchBoardView(
		() => dispatchBoardStore.rows(),
		() => telemetrySnapshot,
	);
	const chatRenderer = factories.createChatRenderer({
		chatPanel,
		requestRender,
		...(deps.resolveStreamIngress && deps.getSettings
			? {
					streamIngress: deps.resolveStreamIngress,
					getSmoothStreamingMode: () => {
						const current = deps.getSettings?.();
						const mode = current?.interface.smoothStreaming ?? "off";
						const autoAllowed = processAutoPacingAllowed(deps.hasObservedBackpressure?.() ?? false);
						deps.onSmoothStreamingMode?.(mode, mode === "on" || (mode === "auto" && autoAllowed));
						return mode;
					},
					isAutoPacingAllowed: () => processAutoPacingAllowed(deps.hasObservedBackpressure?.() ?? false),
					...(deps.commitFrame ? { commitFrame: deps.commitFrame } : {}),
				}
			: {}),
		...(renderTrace
			? {
					visibleEventSequence: (event) => deps.resolveVisibleEventSequence?.(event) ?? null,
					onQueue: (eventSeq, action) => renderTrace.recordQueue(eventSeq, action),
					onPanelApplied: (eventSeq) => renderTrace.recordPanelApplied(eventSeq),
				}
			: {}),
	});
	const io = factories.createIo({
		appendReplayBlock: (renderBlock) =>
			chatRenderer.mutate(() => chatPanel.appendReplayBlock(renderBlock), "command-output"),
		requestRender: () => {},
	});
	const pending: Component = deps.bootPending
		? {
				render: (width) => [...(deps.bootPending?.render(width) ?? []), ...followUpQueuePanel.render(width)],
				invalidate: () => {
					deps.bootPending?.invalidate();
					followUpQueuePanel.invalidate();
				},
			}
		: followUpQueuePanel;
	let transcriptView: ScrollView | undefined;
	const root = factories.buildLayout(
		{
			banner: deps.workspaceSurfaces ? deps.workspaceSurfaces.banner(banner) : banner,
			chat: chatPanel,
			...(deps.workspaceSurfaces ? { workspace: deps.workspaceSurfaces.board } : {}),
			pending,
			editor,
			footer: footer.view,
		},
		{
			mode: settings.interface?.mode ?? "regular",
			fullscreenScrollbar: settings.interface?.fullscreenScrollbar ?? "auto",
			getTerminalRows: () => deps.terminal.rows ?? process.stdout.rows ?? 40,
			getFactsRevision: () => harnessFacts.currentRevision,
			getBottomRegionKey: () => {
				const ctx = contextActivityStore.current();
				const liveCtxTick = ctx !== null && ctx.completedAtMs === null ? animationStep(Date.now()) : 0;
				const dockFlag = dockTop(deps.tui) !== null ? 1 : 0;
				return `${footer.isExpanded() ? 1 : 0}|${dockFlag}|${deps.getOverlayState?.() ?? "closed"}|${deps.chat.isStreaming() ? 1 : 0}|${liveCtxTick}`;
			},
			onTranscript: (view) => {
				transcriptView = view;
			},
			// After the frame that asked: a forced request resets the renderer's baseline, which the frame still reads.
			requestFullRedraw: () => queueMicrotask(() => deps.tui.requestRender(true)),
		},
	);
	deps.mount?.(root, editor);

	const scheduleInterval = deps.scheduleInterval ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
	const clearScheduledInterval =
		deps.clearScheduledInterval ??
		((handle: PresentationTickerHandle): void => clearInterval(handle as ReturnType<typeof setInterval>));
	// Counters need only second resolution. The composer rail's spinner steps faster while the model, a tool or the
	// harness is working; a wait on the operator holds a still mark, so it needs no frames at all.
	const awaitingOperator = (): boolean =>
		deps.isAwaitingApproval?.() === true || dockTop(deps.tui)?.frame.dockAwaitingInput?.() === true;
	const workIsMoving = (): boolean => {
		if (awaitingOperator()) return false;
		if (deps.chat.isStreaming() || deps.chat.turnPreparation().phase !== "idle" || localBashStartedAt !== null)
			return true;
		const phase = statusController.current().phase;
		return phase !== "idle" && phase !== "ended" && phase !== "tool_blocked";
	};
	const presentationInterval = (): number => (motionEnabled() && workIsMoving() ? ACTIVITY_STEP_MS : 1_000);
	let tickerInterval = presentationInterval();
	// A minute of silence on a model call earns a transcript row that outlives the rail's escalation (F8).
	const silenceRow = createSilenceTranscriptRow({
		append: (render, isLive) => chatPanel.appendReplayBlock((width) => render(width), isLive),
		modelName: (status) => modelNickname(status.modelRequest?.modelId ?? deps.getSettings?.().chat?.model),
	});
	let lastActivitySecond = -1;
	let tickersStopped = false;
	const tickPresentation = (): void => {
		if (tickersStopped) return;
		const nextInterval = presentationInterval();
		if (nextInterval !== tickerInterval) {
			clearScheduledInterval(footerTicker);
			tickerInterval = nextInterval;
			footerTicker = scheduleInterval(tickPresentation, tickerInterval);
			footerTicker.unref?.();
		}
		let needsRender = tickerInterval === ACTIVITY_STEP_MS;
		const second = Math.floor(performance.now() / 1_000);
		if (second !== lastActivitySecond) {
			lastActivitySecond = second;
			silenceRow.observe(statusController.current(), Date.now());
			const statusActive =
				!["idle", "ended"].includes(statusController.current().phase) ||
				localBashStartedAt !== null ||
				backgroundCalls.active().length > 0 ||
				dispatchBoardStore.rows().some((row) => row.status === "running");
			if (deps.chat.isStreaming() || statusActive || loopSnapshot.some((job) => job.nextDueAt !== null)) {
				// FooterView's timeBucket advances on each second and recomposes with cachedSnapshot without re-reading history budget.
				needsRender = true;
			}
		}
		if (needsRender) requestRender();
	};
	let footerTicker = scheduleInterval(tickPresentation, tickerInterval);
	footerTicker.unref?.();
	const workspaceTicker = scheduleInterval(() => {
		void refreshLiveWorkspaceGit(true);
		footer.refresh();
		requestRender();
	}, 5_000);
	workspaceTicker.unref?.();

	let beforeStatusDisposed = false;
	let statusDisposed = false;
	const stopTickers = (): void => {
		if (tickersStopped) return;
		tickersStopped = true;
		clearScheduledInterval(footerTicker);
		clearScheduledInterval(workspaceTicker);
	};
	const disposeBeforeStatus = (): void => {
		if (beforeStatusDisposed) return;
		beforeStatusDisposed = true;
		// Before the subscriptions go: a project-context refresh already in flight
		// must not land afterwards and ask a torn-down presentation for a frame.
		quotaSummary.dispose();
		banner.dispose();
		footer.dispose();
		unsubscribeProfile();
		unsubscribeProjection();
		for (const off of unsubscribeTelemetry) off();
		if (dropCheck) clearTimeout(dropCheck);
		contextActivityStore.unsubscribe();
		unsubscribeLoops?.();
		backgroundCalls.dispose();
		dispatchBoardStore.unsubscribe();
		unbindRunReaders?.();
	};
	const disposeStatus = (): void => {
		if (statusDisposed) return;
		statusDisposed = true;
		unsubscribeStatusFacts?.();
		statusController.dispose();
	};
	return {
		keybindings,
		banner,
		chatPanel,
		followUpQueuePanel,
		statusController,
		dispatchBoardStore,
		contextActivityStore,
		harnessFacts,
		fleetOwnsLiveProgress,
		footer,
		notifications,
		notify,
		dismissContextBootstrapNotices,
		announceTaskMemorySeedOffer,
		collapseWelcomeDashboard: () => {
			if (banner.collapseToSessionHeader()) requestRender();
		},
		editor,
		editorChrome,
		dispatchBoard,
		chatRenderer,
		io,
		root,
		setLocalBashRunning(running, command, settled) {
			lastShell = running ? null : (settled ?? null);
			lastCompactionStop = null;
			localBashStartedAt = running ? Date.now() : null;
			localBashCommand = running ? (command ?? null) : null;
			localBashCancelledAt = null;
			harnessFacts.bump();
			footer.refresh();
			requestRender();
		},
		setLocalBashCancelling() {
			if (localBashStartedAt === null) return;
			localBashCancelledAt = Date.now();
			harnessFacts.bump();
			footer.refresh();
			requestRender();
		},
		changeOutputStyle: (mutation) =>
			chatRenderer.mutate(
				() =>
					preserveTranscriptScroll(transcriptView, deps.terminal.columns, () => {
						mutation();
						setPresentationTier(readSettingState().output);
					}),
				"output-style",
			),
		announceSettingChanges,
		getQuotaSnapshots: () => {
			quotaSummary.peekSnapshots();
			return deps.telemetry.read?.quota().providers ?? [];
		},
		recordChatEvent,
		recordToolStart: (toolCallId, toolName) => {
			footerActiveTools.set(toolCallId, toolName);
			footerToolCounts.set(toolName, (footerToolCounts.get(toolName) ?? 0) + 1);
			cachedToolCounts = null;
			harnessFacts.bump();
		},
		recordToolEnd: ({ toolCallId, isError, truncated, settledAsSteps }) => {
			const started = footerActiveTools.get(toolCallId);
			if (started === undefined) return;
			footerActiveTools.delete(toolCallId);
			if (settledAsSteps === true) {
				const left = (footerToolCounts.get(started) ?? 1) - 1;
				if (left > 0) footerToolCounts.set(started, left);
				else footerToolCounts.delete(started);
			}
			if (isError) footerToolErrors += 1;
			if (truncated) footerToolTruncatedResults += 1;
			cachedToolCounts = null;
			harnessFacts.bump();
		},
		toolCounts: () => footerToolCounts,
		setLastTurnSummary: (summary) => {
			lastTurnSummary = summary;
			lastShell = null;
			lastCompactionStop = null;
			harnessFacts.bump();
		},
		resetForNewSession: () => {
			resetLoopJobs();
			banner.resetToLaunchpad();
			footerToolCounts.clear();
			footerActiveTools.clear();
			footerToolErrors = 0;
			footerToolTruncatedResults = 0;
			cachedToolCounts = null;
			lastTurnSummary = null;
			lastShell = null;
			lastCompactionStop = null;
			liveGeneration = false;
			statusController.reset();
			harnessFacts.bump();
			// A timed notice spoke about a moment in the session that just ended; a pinned one states a condition still true.
			for (const notice of notifications.list()) if (notice.expiresAt !== null) notifications.dismiss(notice.id);
		},
		stopTickers,
		disposeBeforeStatus,
		disposeStatus,
		dispose: () => {
			stopTickers();
			disposeBeforeStatus();
			disposeStatus();
		},
	};
}
