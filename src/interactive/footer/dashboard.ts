// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { PancodeSettings } from "../../core/config.js";
import type { OutputStyle } from "../../core/defaults.js";
import { peekHarnessProfile, recordLessonShown } from "../../core/harness-profile.js";
import type { JobRecord } from "../../core/job-types.js";
import { presentationTier, tierPolicy, tierRevision } from "../../core/presentation-tier.js";
import type { ContextActivityStatus } from "../../core/telemetry/session-vocabulary.js";
import { motionEnabled } from "../../core/terminal-preferences.js";
import type { LiveBudgetView } from "../../domains/context/budget/live-view.js";
import type { ContextState } from "../../domains/context/index.js";
import type { TaskMemoryOperatorStatus } from "../../domains/memory/index.js";
import type { CapabilityFlags, ProvidersContract } from "../../domains/providers/index.js";
import { acceptsImageInput } from "../../domains/providers/index.js";
import type { AutonomyStatus } from "../../domains/safety/autonomy-window.js";
import type { LocalCapacity } from "../../domains/scheduling/local-capacity.js";
import type { ContextUsageSnapshot } from "../../domains/session/context-accounting.js";
import type { ContextLedger } from "../../domains/session/context-ledger.js";
import type { TaskBoardSnapshot } from "../../domains/session/task-board.js";
import type { WorkspaceSnapshot } from "../../domains/session/workspace/index.js";
import type { TelemetryView } from "../../domains/telemetry/contract.js";
import type { TokenThroughputSnapshot } from "../../domains/telemetry/index.js";
import { type Component, Text } from "../../engine/tui.js";
import type { BackgroundCall } from "../background-calls.js";
import type { DispatchBoardRow } from "../dispatch-row-model.js";
import { ACTIVE_DISPATCH_STATUSES, type FooterPanel } from "../footer-panel.js";
import type {
	HarnessFactsSnapshot,
	HarnessFactsSource,
	HarnessLearnedFacts,
	HarnessRouteReadinessData,
} from "../harness-facts.js";
import { createHarnessFactsSource } from "../harness-facts.js";
import type { QuotaProviders } from "../quota-view.js";
import type { AgentStatus, TurnSummary } from "../status/index.js";
import { animationStep, pancodeTheme } from "../theme/index.js";
import { skinEpoch } from "../theme/tokens.js";
import { projectFooterRenderState } from "./chrome-projection.js";
import type { ThinkingRailFacts } from "./context-rail.js";
import { renderDeckDrawer } from "./deck-drawer.js";
import { type ExtensionFact, extensionFactsKey } from "./extension-facts.js";
import type { FleetBand } from "./fleet-band.js";
import { getCurrentBranch } from "./git.js";
import type { ComposerKeyContext, KeyHintFacts } from "./key-hints.js";
import type { Notification } from "./notifications.js";
import type { FooterTelemetry } from "./spend.js";
import { renderStatusLineParts } from "./status-line.js";
import {
	COMPACT_KEYS_DOOR_LIFETIME,
	renderCapabilityMap,
	selectContextualMoment,
	selectWhisperCue,
} from "./teaching.js";
import type { AgentWorkFacts, ContextEngineFacts, SessionFacts, ToolTallySnapshot, WorkspaceFacts } from "./widgets.js";
import { fitDashboardLine } from "./widgets.js";

export function capabilityLabels(caps: CapabilityFlags | null): string[] {
	if (!caps) return [];
	const out: string[] = [acceptsImageInput({ vision: caps.vision }) ? "images yes" : "images no"];
	if (caps.tools) out.push("tools");
	if (caps.reasoning) out.push("reason");
	if (caps.vision) out.push("vision");
	if (caps.fim) out.push("fim");
	if (caps.embeddings) out.push("embed");
	if (typeof caps.contextWindow === "number" && caps.contextWindow > 0)
		out.push(`ctx ${Math.round(caps.contextWindow / 1000)}k`);
	return out.slice(0, 5);
}

/** Whether Alt+U has opened the dashboard; never a presentation tier. */
export type FooterDashboardMode = "closed" | "open";

export interface FooterDashboardDeps {
	/** Shared harness facts source; when supplied, all harness facts read from it. */
	facts?: HarnessFactsSource;
	/** Suppress idle teaching when the welcome already owns it. */
	getWelcomeVisible?: () => boolean;
	/** The last slash command the operator typed, so a demo tip can name its key. */
	getLastCommand?: () => string | null;
	getQuotaSnapshots?: () => QuotaProviders;
	getConnections?: () => { mcp: string[]; plugins: string[] };
	/** Live extension status facts for row 2 and the Alt+U deck. */
	getExtensionFacts?: () => ReadonlyArray<ExtensionFact>;
	/** The active extension workspace's footer line, with how to leave it. */
	getWorkspaceLine?: (width: number) => string | null;
	getLifecycleHint?: () => string | null;
	providers: ProvidersContract;
	getSettings?: () => Readonly<PancodeSettings>;
	getAgentStatus?: () => AgentStatus;
	getTerminalColumns?: () => number;
	getTerminalRows?: () => number;
	onHeightChange?: (rows: number) => void;
	/** The telemetry read model's live view; absent when there is no read model, which renders "not available". */
	getTelemetry?: () => TelemetryView | null;
	getTokenThroughput?: () => TokenThroughputSnapshot | null;
	getContextUsage?: () => ContextUsageSnapshot &
		Partial<Pick<LiveBudgetView, "revision" | "historical" | "inputSource">>;
	getContextLedger?: () => ContextLedger;
	getDispatchRows?: () => ReadonlyArray<DispatchBoardRow>;
	getTaskBoard?: () => TaskBoardSnapshot | null;
	/** Local node worker limit and its binding input; sampled only while workers are listed. */
	getLocalCapacity?: () => LocalCapacity | null;
	getTaskMemoryStatus?: () => TaskMemoryOperatorStatus;
	getContextActivity?: () => {
		message: string;
		detail: string | null;
		status: ContextActivityStatus;
	} | null;
	getToolCounts?: () => ToolTallySnapshot;
	getWorkspaceSnapshot?: () => WorkspaceSnapshot | null;
	getSessionInfo?: () => { id: string | null; name: string | null; turns: number | null };
	getLastTurnSummary?: () => TurnSummary | null;
	getExtensionStats?: () => { active: number; installed: number };
	getContextState?: () => ContextState;
	getNotifications?: () => ReadonlyArray<Notification>;
	getEndedNotifications?: () => ReadonlyArray<Notification>;
	/** Side-agent model calls in flight; the rail names them, and the footer stops repeating them. */
	getBackgroundCalls?: () => ReadonlyArray<BackgroundCall>;
	/** Who answers the keyboard right now; the hint row follows it. Absent reads as the idle composer. */
	getKeyContext?: () => ComposerKeyContext;
	getKeyHintFacts?: () => KeyHintFacts;
	/** Whether the Ctrl+G leader is armed and waiting for its next key. */
	getLeaderArmed?: () => boolean;
	/** Whether a Ctrl+C armed the double tap and its window is still open. */
	getShutdownArmed?: () => boolean | string;
	/** Skills whose tool surface is armed across turns; the compact line names them. */
	getActiveEggs?: () => readonly string[];
	getActiveSkillSurface?: () => ReadonlyArray<string>;
	/** The autonomous window at yolo; null below it. */
	getAutonomyStatus?: () => AutonomyStatus | null;
	/** Transient Fleet & Loop band mounted between the Alert row and the Deck / Status bar. */
	fleetBand?: FleetBand;
	/** Transient context-operation progress band mounted between the Fleet band and the Deck / Status bar. */
	contextProgress?: Component;
	/** Fallback visibility probe when `fleetBand` is mounted externally. */
	isFleetBandVisible?: () => boolean;
	/** True while `/fleet` owns the dock (auto-hides deck and suppresses footer worker count). */
	isFleetBoardOpen?: () => boolean;
	dismissKeyLabel?: string;
	now?: () => number;
	resolveCurrentBranch?: (cwd: string) => Promise<string | null>;
}

export interface FooterDashboardRenderState {
	/** Session-wide presentation tier; absent uses the default tier. */
	outputStyle?: OutputStyle;
	/** Live extension status facts: idle Row 2 right slot (ahead of the onboarding whisper) and the deck's Extensions island. */
	extensionFacts?: ReadonlyArray<ExtensionFact>;
	/** Active extension workspace leave chord, slotted into the bottom bar without adding an extra row. */
	workspaceLine?: string | null;
	quota?: QuotaProviders;
	quotaRoute?: Pick<DispatchBoardRow, "runtimeId" | "wireModelId" | "node">;
	demoHint?: string | null;
	/** What a long silence owes the operator, widest form first; the row shows the first that fits. */
	silenceNotes?: readonly string[] | null;
	/** Optional learning is enabled; immediate controls are independent. */
	demo?: boolean;
	keyContext?: ComposerKeyContext;
	keyHintFacts?: KeyHintFacts;
	background?: ReadonlyArray<BackgroundCall>;
	welcomeVisible?: boolean;
	connections?: { mcp: string[]; plugins: string[] };
	costCeilingUsd?: number;

	workspace: WorkspaceFacts;
	session: SessionFacts;
	context: ContextEngineFacts;
	agent: AgentWorkFacts;
	notices: ReadonlyArray<Notification>;
	/** Warnings and errors that already left the footer, which the Activity page still lists. */
	endedNotices?: ReadonlyArray<Notification>;
	dismissKeyLabel?: string;
	status: AgentStatus;
	toolCounts: ToolTallySnapshot;
	dispatchRows: ReadonlyArray<DispatchBoardRow>;
	throughput: TokenThroughputSnapshot | null;
	telemetry: FooterTelemetry;
	tick: number;
	now: number;
	/** Revision from `HarnessFactsSnapshot` for width x tier x revision memoization. */
	factsRevision?: number;
	/** True while the Alt+U deck/drawer is open so the bottom bar renders in slimmed anchor mode. */
	deckOpen?: boolean;
	/** Projected thinking effort facts for Row 1. */
	thinking?: ThinkingRailFacts;
	/** Session-scoped scheduled loops for Row 2 / compact busy Row 1. */
	loops?: ReadonlyArray<JobRecord>;
	/** Route readiness data for idle blocker/fault display on Row 1. */
	readiness?: HarnessRouteReadinessData | null;
	/** Learned capabilities snapshot (with hydration flag) for quieting cues. */
	learned?: HarnessLearnedFacts;
	/** True when the compact idle new-user `?` door is eligible (hydration-guarded). */
	compactKeysDoor?: boolean;
	/** True while the transient Fleet & Loop band is visible above Row 1 (suppresses duplicate worker count). */
	fleetBandVisible?: boolean;
	/** True while `/fleet` owns the dock (auto-hides deck and suppresses footer worker count). */
	fleetBoardOpen?: boolean;
	/** Optional whisper cue for idle Row 2 right slot. */
	whisper?: string | null;
	/** Optional one-time contextual moment for Row 2 (takes precedence over whisper cue). */
	contextualMoment?: string | null;
}

export interface FooterDashboardPanel extends FooterPanel {
	mode(): FooterDashboardMode;
	isExpanded(): boolean;
	setExpanded(expanded: boolean): void;
	toggleExpanded(): FooterDashboardMode;
	dispose(): void;
}

function factsSourceFromDeps(deps: FooterDashboardDeps): HarnessFactsSource {
	if (deps.facts) return deps.facts;
	return createHarnessFactsSource({
		providers: deps.providers,
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		...(deps.getTerminalRows ? { getTerminalRows: deps.getTerminalRows } : {}),
		...(deps.getAgentStatus ? { getAgentStatus: deps.getAgentStatus } : {}),
		...(deps.getContextUsage ? { getContextUsage: deps.getContextUsage } : {}),
		...(deps.getContextLedger ? { getContextLedger: deps.getContextLedger } : {}),
		...(deps.getContextState ? { getContextState: deps.getContextState } : {}),
		...(deps.getContextActivity ? { getContextActivity: deps.getContextActivity } : {}),
		...(deps.getDispatchRows ? { getDispatchRows: deps.getDispatchRows } : {}),
		...(deps.getTaskBoard ? { getTaskBoard: deps.getTaskBoard } : {}),
		...(deps.getLocalCapacity ? { getLocalCapacity: deps.getLocalCapacity } : {}),
		...(deps.getTelemetry ? { getTelemetry: deps.getTelemetry } : {}),
		...(deps.getTokenThroughput ? { getTokenThroughput: deps.getTokenThroughput } : {}),
		...(deps.getQuotaSnapshots ? { getQuotaSnapshots: deps.getQuotaSnapshots } : {}),
		...(deps.getToolCounts ? { getToolCounts: deps.getToolCounts } : {}),
		...(deps.getWorkspaceSnapshot ? { getWorkspaceSnapshot: deps.getWorkspaceSnapshot } : {}),
		...(deps.getSessionInfo ? { getSessionInfo: deps.getSessionInfo } : {}),
		...(deps.getLastTurnSummary ? { getLastTurnSummary: deps.getLastTurnSummary } : {}),
		...(deps.getExtensionStats ? { getExtensionStats: deps.getExtensionStats } : {}),
		...(deps.getLifecycleHint ? { getLifecycleHint: deps.getLifecycleHint } : {}),
		...(deps.getConnections ? { getConnections: deps.getConnections } : {}),
		...(deps.getTaskMemoryStatus ? { getTaskMemoryStatus: deps.getTaskMemoryStatus } : {}),
		...(deps.getNotifications ? { getNotifications: deps.getNotifications } : {}),
		...(deps.getEndedNotifications ? { getEndedNotifications: deps.getEndedNotifications } : {}),
		...(deps.getBackgroundCalls ? { getBackgroundCalls: deps.getBackgroundCalls } : {}),
		...(deps.getLeaderArmed ? { getLeaderArmed: deps.getLeaderArmed } : {}),
		...(deps.getShutdownArmed ? { getShutdownArmed: deps.getShutdownArmed } : {}),
		...(deps.getActiveEggs ? { getActiveEggs: deps.getActiveEggs } : {}),
		...(deps.getActiveSkillSurface ? { getActiveSkillSurface: deps.getActiveSkillSurface } : {}),
		...(deps.getAutonomyStatus ? { getAutonomyStatus: deps.getAutonomyStatus } : {}),
		getDismissKeyLabel: () => deps.dismissKeyLabel,
	});
}

/**
 * Direct-line footer component memoized by `(width, rows, tier, skinEpoch, factsRevision,
 * owner, welcome, fleetBoard, deckOverrideRev, timeBucket)`. Returning the cached `string[]`
 * reference directly avoids `Text.setText` / `wrapTextWithAnsi` and lets `RegularRoot` skip
 * `visibleWidth` on unchanged footer rows on every keystroke and stream delta.
 */
class FooterView extends Text {
	private composedWidth: number | null = null;
	private composedRows: number | null = null;
	private composedLines: string[] = [];
	private composedEpoch = -1;
	private composedOwner: string | undefined;
	private composedFactsRev = -1;
	private composedTierRev = -1;
	private composedWelcome = false;
	private composedFleetBoard = false;
	private composedDeckRev = -1;
	private composedTimeBucket = "";
	private composedExtKey = "";

	constructor(
		private readonly compose: (width: number, refreshFacts: boolean) => string[],
		private readonly getRows: () => number,
		private readonly getOwner: () => string | undefined = () => undefined,
		private readonly getFactsRev: () => number = () => 0,
		private readonly getWelcome: () => boolean = () => false,
		private readonly getFleetBoard: () => boolean = () => false,
		private readonly getDeckRev: () => number = () => 0,
		private readonly getTimeBucket: () => string = () => "0",
		private readonly getExtKey: (width: number) => string = () => "",
	) {
		super("", 0, 0);
	}

	composeAt(width: number, refreshFacts = true): void {
		const next = this.compose(width, refreshFacts);
		// Capture facts revision and time bucket AFTER `compose` so any revision bump or
		// `lastTimeKind` transition performed during composition matches on the very next render.
		this.composedWidth = width;
		this.composedEpoch = skinEpoch();
		this.composedRows = this.getRows();
		this.composedOwner = this.getOwner();
		this.composedFactsRev = this.getFactsRev();
		this.composedTierRev = tierRevision();
		this.composedWelcome = this.getWelcome();
		this.composedFleetBoard = this.getFleetBoard();
		this.composedDeckRev = this.getDeckRev();
		this.composedTimeBucket = this.getTimeBucket();
		this.composedExtKey = this.getExtKey(width);
		if (next.length === this.composedLines.length && next.every((line, index) => line === this.composedLines[index])) {
			return;
		}
		this.composedLines = next;
	}

	override render(width: number): string[] {
		const factsRev = this.getFactsRev();
		const factsChanged = factsRev !== this.composedFactsRev;
		if (
			this.composedEpoch !== skinEpoch() ||
			width !== this.composedWidth ||
			this.getRows() !== this.composedRows ||
			this.getOwner() !== this.composedOwner ||
			factsChanged ||
			this.composedTierRev !== tierRevision() ||
			this.getWelcome() !== this.composedWelcome ||
			this.getFleetBoard() !== this.composedFleetBoard ||
			this.getDeckRev() !== this.composedDeckRev ||
			this.getTimeBucket() !== this.composedTimeBucket ||
			this.getExtKey(width) !== this.composedExtKey
		) {
			// Pure clock/spinner ticks, extension status updates, or keyContext changes reuse the cached
			// facts snapshot without re-running `facts.snapshot()` (`contextUsage` / `#historyBudget` / `providers.list`).
			this.composeAt(width, factsChanged);
		}
		return this.composedLines;
	}

	override invalidate(): void {
		this.composedWidth = null;
		super.invalidate();
	}
}

export function buildFooterDashboard(deps: FooterDashboardDeps): FooterDashboardPanel {
	const facts = factsSourceFromDeps(deps);
	const terminalRows = () => deps.getTerminalRows?.() ?? process.stdout.rows ?? 40;
	const welcomeOpen = () => deps.getWelcomeVisible?.() === true;
	const fleetBoardOpenProbe = () => deps.isFleetBoardOpen?.() === true;
	let deckOverrideRev = 0;
	// Tracks whether the last composed state had any time-driven element (busy spinner/clock, loop countdown,
	// background call, or expiring notice) so idle keystrokes return `"0"` in O(1) without reading `Date.now()`.
	let lastTimeKind: "none" | "second" | "animate" = "none";
	const timeBucket = (): string => {
		if (lastTimeKind === "none") return "0";
		const now = deps.now?.() ?? Date.now();
		const sec = Math.floor(now / 1000);
		return lastTimeKind === "animate" && motionEnabled() ? `${sec}:${animationStep(now)}` : `${sec}`;
	};
	const extKey = (width: number): string => {
		const extFacts = deps.getExtensionFacts?.();
		const ws = deps.getWorkspaceLine?.(width);
		if ((!extFacts || extFacts.length === 0) && !ws) return "";
		return `${extensionFactsKey(extFacts)}\x1d${ws ?? ""}`;
	};
	const view = new FooterView(
		(width, refreshFacts) => composeFooter(width, refreshFacts),
		terminalRows,
		() => deps.getKeyContext?.(),
		() => facts.currentRevision,
		welcomeOpen,
		fleetBoardOpenProbe,
		() => deckOverrideRev,
		timeBucket,
		extKey,
	);
	let branchSlot: string | null = null;
	// Cached snapshot & readiness so pure clock/spinner ticks and keyContext switches never
	// re-run `facts.snapshot()` (`contextUsage` / `#historyBudget` / `providers.list`).
	let cachedSnapshot: HarnessFactsSnapshot | null = null;
	let cachedSnapshotBranch: string | null = null;
	let cachedSnapshotTierRev = -1;
	let cachedReadiness: HarnessRouteReadinessData | null = null;
	// Explicit operator toggle per tier; switching tiers resets to the new tier's default
	// (detailed = open, except auto-folded while the Welcome Launchpad is visible).
	let explicitDeckOverride: { tier: OutputStyle; open: boolean } | null = null;
	let observedTier: OutputStyle | null = null;
	let disposed = false;
	let compactDoorCounted = false;
	// Whisper rotation advances calmly after each completed turn (never on a timer).
	let whisperSeed = 0;
	let seenLastTurn: TurnSummary | null = null;
	// Active one-time contextual moment kept visible for its triggering turn/state, then permanently retired.
	let activeMoment: { id: string; turn: TurnSummary | null; busy: boolean } | null = null;
	const recordedMoments = new Set<string>();

	const currentTier = (): OutputStyle => deps.getSettings?.().interface?.outputDetail ?? presentationTier();
	const syncTier = (tier: OutputStyle): void => {
		if (observedTier !== null && observedTier !== tier) explicitDeckOverride = null;
		observedTier = tier;
	};
	const desiredDeckOpen = (tier: OutputStyle, welcomeVisible: boolean): boolean => {
		syncTier(tier);
		return explicitDeckOverride !== null && explicitDeckOverride.tier === tier
			? explicitDeckOverride.open
			: tierPolicy(tier).provenance && !welcomeVisible;
	};
	const isDeckAutoHidden = (width: number, rows: number, keyContext: ComposerKeyContext | undefined): boolean =>
		keyContext === "surface" || deps.isFleetBoardOpen?.() === true || rows < 20 || width < 44;

	function composeFooter(width: number, refreshFacts = true): string[] {
		const now = deps.now?.() ?? Date.now();
		let snapshot = cachedSnapshot;
		if (
			refreshFacts ||
			snapshot === null ||
			cachedSnapshotBranch !== branchSlot ||
			cachedSnapshotTierRev !== tierRevision()
		) {
			snapshot = facts.snapshot(branchSlot);
			cachedSnapshot = snapshot;
			cachedSnapshotBranch = branchSlot;
			cachedSnapshotTierRev = tierRevision();
			cachedReadiness = facts.routeReadiness();
		}
		const welcomeVisible = welcomeOpen();
		const keyContext = deps.getKeyContext?.();
		const settings = deps.getSettings?.();
		const status = snapshot.activity.status;
		const notices = snapshot.notices.live;
		const dispatch = snapshot.work.dispatchRows;
		const profile = peekHarnessProfile().profile;
		const rows = terminalRows();
		const fleetBoardOpen = deps.isFleetBoardOpen?.() === true;
		const deckOpen = desiredDeckOpen(snapshot.tier, welcomeVisible) && !isDeckAutoHidden(width, rows, keyContext);
		const mainBusy = status.phase !== "idle" && status.phase !== "ended";
		if (snapshot.activity.lastTurn !== null && snapshot.activity.lastTurn !== seenLastTurn) {
			if (seenLastTurn !== null) whisperSeed += 1;
			seenLastTurn = snapshot.activity.lastTurn;
		}
		if (activeMoment !== null && (activeMoment.busy !== mainBusy || activeMoment.turn !== snapshot.activity.lastTurn)) {
			activeMoment = null;
		}
		const hasTimed =
			mainBusy ||
			snapshot.work.loops.length > 0 ||
			snapshot.activity.backgroundCalls.length > 0 ||
			notices.some((notice) => notice.expiresAt !== null) ||
			dispatch.some((row) => ACTIVE_DISPATCH_STATUSES.has(row.status));
		lastTimeKind = mainBusy && status.phase !== "tool_blocked" ? "animate" : hasTimed ? "second" : "none";
		const compactKeysDoor =
			snapshot.learned.hydrated &&
			settings?.interface.demo !== false &&
			(snapshot.learned.features["?"]?.count ?? 0) === 0 &&
			(compactDoorCounted || (profile.lessons["compact:keys"]?.shown ?? 0) < COMPACT_KEYS_DOOR_LIFETIME);
		if (compactKeysDoor && !compactDoorCounted && !tierPolicy(snapshot.tier).hintRow) {
			compactDoorCounted = true;
			setImmediate(() => recordLessonShown("compact:keys"));
		}
		const fleetBandVisible = deps.fleetBand ? deps.fleetBand.isVisible() : deps.isFleetBandVisible?.() === true;
		const workspace = deps.getWorkspaceLine?.(width) ?? null;
		const extensionFacts = deps.getExtensionFacts?.() ?? [];
		const baseState = projectFooterRenderState(snapshot, {
			width,
			now,
			welcomeVisible,
			demo: settings ? settings.interface.demo !== false : true,
			demoHint: null,
			deckOpen,
			readiness: cachedReadiness,
			compactKeysDoor,
			fleetBandVisible,
			fleetBoardOpen,
			...(extensionFacts.length > 0 ? { extensionFacts } : {}),
			...(workspace ? { workspaceLine: workspace } : {}),
			...(keyContext ? { keyContext } : {}),
			...(deps.getKeyHintFacts ? { keyHintFacts: deps.getKeyHintFacts() } : {}),
		});
		const moment = !deckOpen ? selectContextualMoment(baseState, width, profile.lessons, activeMoment?.id ?? null) : null;
		if (moment !== null && !recordedMoments.has(moment.id)) {
			recordedMoments.add(moment.id);
			activeMoment = { id: moment.id, turn: snapshot.activity.lastTurn, busy: mainBusy };
			setImmediate(() => recordLessonShown(moment.id));
		}
		const whisper =
			moment === null && !deckOpen && keyContext !== "surface" ? selectWhisperCue(baseState, width, whisperSeed) : null;
		const current: FooterDashboardRenderState =
			moment !== null || whisper !== null
				? {
						...baseState,
						...(whisper !== null ? { whisper } : {}),
						...(moment !== null ? { contextualMoment: moment.text } : {}),
					}
				: baseState;
		const lifecycleHint = snapshot.extensions.lifecycleHint;
		const lifecycleLine = lifecycleHint ? [fitDashboardLine(pancodeTheme().fg("annotation", lifecycleHint), width)] : [];
		// Footer stack order (top to bottom): Alert row -> Fleet band -> Context progress -> Deck drawer -> Status bar / Row 2.
		// Workspace leave chord slots into the bottom bar (`workspaceLine`); extension facts get the deck's Extensions island.
		const { alertRows, bodyRows } = renderStatusLineParts(current, width, rows);
		const fleetRows = deps.fleetBand ? deps.fleetBand.render(width) : [];
		const contextProgressRows = deps.contextProgress && rows >= 20 ? deps.contextProgress.render(width) : [];
		if (contextProgressRows.length > 0 && lastTimeKind !== "animate") {
			lastTimeKind = "animate";
		}
		const capabilityMap = deckOpen ? renderCapabilityMap(current, width) : { lines: [], key: "" };
		const panel = deckOpen
			? renderDeckDrawer(current, width, rows, {
					capabilityMapLines: capabilityMap.lines,
					capabilityMapKey: capabilityMap.key,
				})
			: [];
		const lines = [...alertRows, ...fleetRows, ...contextProgressRows, ...panel, ...bodyRows, ...lifecycleLine];
		// Report combined footer stack height (alert + fleet band + deck + status line) so docks above size accurately.
		deps.onHeightChange?.(Math.max(1, lines.length));
		return lines;
	}
	const refresh = (): void => {
		if (disposed) return;
		view.composeAt(deps.getTerminalColumns?.() ?? process.stdout.columns ?? 80);
	};
	const isExpanded = (): boolean => {
		const tier = currentTier();
		const width = deps.getTerminalColumns?.() ?? process.stdout.columns ?? 80;
		return desiredDeckOpen(tier, welcomeOpen()) && !isDeckAutoHidden(width, terminalRows(), deps.getKeyContext?.());
	};
	const setExpanded = (expanded: boolean): void => {
		explicitDeckOverride = { tier: currentTier(), open: expanded };
		deckOverrideRev += 1;
		refresh();
	};
	refresh();
	const resolveBranch = deps.resolveCurrentBranch ?? getCurrentBranch;
	void resolveBranch(process.cwd()).then((name) => {
		if (disposed) return;
		if (name === null) return;
		branchSlot = name;
		refresh();
	});
	return {
		view,
		refresh,
		mode() {
			return isExpanded() ? "open" : "closed";
		},
		isExpanded,
		setExpanded,
		toggleExpanded() {
			const tier = currentTier();
			const next = !desiredDeckOpen(tier, welcomeOpen());
			setExpanded(next);
			return isExpanded() ? "open" : "closed";
		},
		dispose() {
			disposed = true;
		},
	};
}
