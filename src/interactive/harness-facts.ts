// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Pure data-only snapshot model of every harness-owned fact in the TUI.
 *
 * Holds states, counts, ids, timestamps, enums, and raw domain objects only.
 * Imports no theme, glyph, widget, renderer, or width-measuring module, and stays
 * unreachable from Stage 0. Snapshots are memoized by a monotonic `revision` that
 * advances only when underlying fact data changes, never on animation ticks.
 */

import type { PancodeSettings } from "../core/config.js";
import { DEFAULT_SETTINGS, type OutputStyle, type RetrySettings } from "../core/defaults.js";
import { peekHarnessProfile } from "../core/harness-profile.js";
import type { JobRecord } from "../core/job-types.js";
import { presentationTier } from "../core/presentation-tier.js";
import type { LiveBudgetView } from "../domains/context/budget/live-view.js";
import type { ContextState } from "../domains/context/index.js";
import { type Missing, missingFromTargetStatus } from "../domains/lifecycle/setup-status.js";
import type { TaskMemoryOperatorStatus } from "../domains/memory/index.js";
import type { ProvidersContract, RuntimeTier, TargetHealthStatus, TargetStatus } from "../domains/providers/index.js";
import { modelResidencyForStatus, resolveModelRuntimeCapabilitiesForProviders } from "../domains/providers/index.js";
import type { AutonomyStatus } from "../domains/safety/autonomy-window.js";
import type { LocalCapacity } from "../domains/scheduling/local-capacity.js";
import type { ContextUsageBreakdown, ContextUsageSnapshot } from "../domains/session/context-accounting.js";
import type { ContextLedger } from "../domains/session/context-ledger.js";
import type { TaskBoardSnapshot } from "../domains/session/task-board.js";
import type { WorkspaceSnapshot } from "../domains/session/workspace/index.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import type { TokenThroughputSnapshot } from "../domains/telemetry/index.js";
import { effectiveYoloConfinement } from "../lib/autonomy/autonomy.js";
import { normalizeRetrySettings } from "../session-control/chat-loop-policy.js";
import type { AgentStatus, TurnSummary } from "../session-control/status-types.js";
import type { TurnPreparationPhase, TurnPreparationStep } from "../session-control/turn-state.js";
import type { BackgroundCall } from "./background-calls.js";
import type { ContextActivitySnapshot } from "./context-activity.js";
import type { DispatchBoardRow } from "./dispatch-row-model.js";
import type { ContextOccupancyFacts } from "./footer/context-rail.js";
import type { Notification } from "./footer/notifications.js";
import type {
	AgentWorkFacts,
	CompactionRailFacts,
	SessionFacts,
	ShellSettlement,
	ToolTallySnapshot,
} from "./footer/widgets.js";
import type { QuotaProviders } from "./quota-view.js";

const IDLE_AGENT_STATUS: AgentStatus = {
	phase: "idle",
	since: 0,
	lastMeaningfulAt: 0,
	watchdogTier: 0,
	watchdogPeak: 0,
	localRuntime: false,
};

const EMPTY_TOOL_COUNTS: ToolTallySnapshot = { tools: {}, errors: 0 };
const EMPTY_LOOPS: ReadonlyArray<JobRecord> = [];
const EMPTY_ROWS: ReadonlyArray<DispatchBoardRow> = [];
const EMPTY_BACKGROUND: ReadonlyArray<BackgroundCall> = [];

export type HarnessContextActivity = ContextActivitySnapshot | Exclude<AgentWorkFacts["contextActivity"], undefined>;

export interface TurnPreparationSnapshot {
	readonly phase: TurnPreparationPhase;
	readonly since: number;
	readonly stage?: { readonly step: TurnPreparationStep; readonly since: number } | null;
}

const IDLE_TURN_PREPARATION: TurnPreparationSnapshot = { phase: "idle", since: 0, stage: null };

export interface HarnessRouteFacts {
	readonly targetId: string | null;
	readonly modelId: string | null;
	/** Effective model id, falling back to the target's default model. */
	readonly effectiveModelId: string | null;
	readonly runtimeId: string | null;
	readonly runtimeTier: RuntimeTier | undefined;
	readonly wireModelId: string | null;
	readonly targetStatus: TargetStatus | null;
}

export type ResolvedThinkingCapability = NonNullable<
	ReturnType<typeof resolveModelRuntimeCapabilitiesForProviders>
>["thinking"];

export interface HarnessThinkingFacts {
	readonly requestedLevel: string;
	readonly resolvedModelId: string | null;
	readonly capability: ResolvedThinkingCapability | null;
	readonly alwaysThinks: boolean;
	readonly unprobed: boolean;
	readonly isDefaultRequest: boolean;
	readonly noteDelivered: boolean;
}

export interface HarnessRouteReadinessData {
	readonly targetId: string;
	readonly available: boolean;
	readonly reason: string;
	readonly health: TargetHealthStatus;
	readonly lastStop: TurnSummary["stopReason"] | null;
	readonly lastFailure?: TurnSummary["failure"];
	readonly notResident?: boolean;
	readonly missing?: Missing;
}

export interface HarnessAutonomyFacts {
	readonly mode: string;
	readonly yoloConfinement: string;
	readonly window: AutonomyStatus | null;
}

export interface HarnessActivityFacts {
	readonly hasStatusProducer: boolean;
	readonly status: AgentStatus;
	readonly isStreaming: boolean;
	readonly turnPreparation: TurnPreparationSnapshot;
	readonly compaction: CompactionRailFacts | null;
	readonly compactionActive: boolean;
	readonly contextActivity: HarnessContextActivity;
	readonly lastTurn: TurnSummary | null;
	readonly lastShell: ShellSettlement | null;
	readonly lastCompactionStop: "cancelled" | "failed" | null;
	readonly backgroundCalls: ReadonlyArray<BackgroundCall>;
	readonly toolCounts: ToolTallySnapshot;
}

export interface HarnessContextFacts {
	readonly budget?: Pick<LiveBudgetView, "revision" | "historical" | "inputSource">;
	readonly used: number | null;
	readonly contextWindow: number | null;
	readonly toolSchemaTokens: number | null;
	readonly breakdown: ContextUsageBreakdown | null;
	readonly ledger: ContextLedger | null;
	/** Ledger exposed to occupancy consumers (null once a live budget revision owns the reading). */
	readonly railLedger: ContextLedger | null;
	readonly compactionThreshold: number | null;
	readonly compactionAuto: boolean | null;
	readonly compactionActive: boolean;
	readonly pancodeMdState: ContextState["pancodeMd"] | null;
	readonly memoryCount: number | null;
	readonly extensions: { readonly active: number; readonly installed: number } | null;
}

export interface HarnessWorkFacts {
	readonly dispatchRows: ReadonlyArray<DispatchBoardRow>;
	readonly liveRows: ReadonlyArray<DispatchBoardRow>;
	readonly settledWorkerRows: ReadonlyArray<DispatchBoardRow>;
	readonly loops: ReadonlyArray<JobRecord>;
	readonly taskBoard: TaskBoardSnapshot | null;
	readonly localCapacity: LocalCapacity | null;
	/** True while the Herdr Watch pane is open and visible beside PanCode. */
	readonly watchPaneVisible: boolean;
}

export interface HarnessTelemetryFacts {
	readonly view: TelemetryView | null;
	readonly throughput: TokenThroughputSnapshot | null;
	readonly quota: QuotaProviders;
	readonly costCeilingUsd: number | undefined;
}

export interface HarnessWorkspaceFacts {
	readonly snapshot: WorkspaceSnapshot | null;
	readonly branchFallback: string | null;
	readonly session: { readonly id: string | null; readonly name: string | null; readonly turns: number | null };
	readonly activeSkills: ReadonlyArray<string>;
	readonly duckBadge: boolean;
	readonly memoryIntervention: NonNullable<SessionFacts["memoryIntervention"]> | null;
	readonly connections: { readonly mcp: readonly string[]; readonly plugins: readonly string[] } | undefined;
}

export interface HarnessNoticeFacts {
	readonly live: ReadonlyArray<Notification>;
	readonly ended: ReadonlyArray<Notification>;
	readonly leaderArmed: boolean;
	readonly shutdownArmed: boolean | string;
	readonly dismissKeyLabel: string | undefined;
}

export interface HarnessExtensionData {
	readonly statusLines: ReadonlyArray<string>;
	readonly lifecycleHint: string | null;
}

export interface LearnedFeatureFact {
	readonly count: number;
	readonly firstUsedAt: string | null;
	readonly lastUsedAt: string | null;
}

export interface HarnessLearnedFacts {
	readonly revision: number;
	readonly hydrated: boolean;
	readonly features: Readonly<Record<string, LearnedFeatureFact>>;
}

let cachedLearnedProfile: {
	revision: number;
	hydrated: boolean;
	profile: ReturnType<typeof peekHarnessProfile>["profile"];
	facts: HarnessLearnedFacts;
} | null = null;

function defaultLearnedFeatures(): HarnessLearnedFacts {
	const peeked = peekHarnessProfile();
	if (
		cachedLearnedProfile !== null &&
		cachedLearnedProfile.revision === peeked.revision &&
		cachedLearnedProfile.hydrated === peeked.hydrated &&
		cachedLearnedProfile.profile === peeked.profile
	) {
		return cachedLearnedProfile.facts;
	}
	const features: Record<string, LearnedFeatureFact> = {};
	const times = peeked.profile.featureTimes;
	for (const [id, count] of Object.entries(peeked.profile.features)) {
		const timing = times?.[id];
		features[id] = {
			count,
			firstUsedAt: timing?.firstUsedAt ?? null,
			lastUsedAt: timing?.lastUsedAt ?? null,
		};
	}
	const facts: HarnessLearnedFacts = {
		revision: peeked.revision,
		hydrated: peeked.hydrated,
		features,
	};
	cachedLearnedProfile = {
		revision: peeked.revision,
		hydrated: peeked.hydrated,
		profile: peeked.profile,
		facts,
	};
	return facts;
}

export interface HarnessFactsSnapshot {
	readonly revision: number;
	readonly tier: OutputStyle;
	readonly retrySettings: RetrySettings;
	readonly route: HarnessRouteFacts;
	readonly thinking: HarnessThinkingFacts;
	readonly autonomy: HarnessAutonomyFacts;
	readonly activity: HarnessActivityFacts;
	readonly context: HarnessContextFacts;
	readonly work: HarnessWorkFacts;
	readonly telemetry: HarnessTelemetryFacts;
	readonly workspace: HarnessWorkspaceFacts;
	readonly notices: HarnessNoticeFacts;
	readonly extensions: HarnessExtensionData;
	readonly learned: HarnessLearnedFacts;
}

export interface HarnessFactsProducers {
	providers: ProvidersContract;
	getSettings?: () => Readonly<PancodeSettings>;
	getAgentStatus?: () => AgentStatus;
	isStreaming?: () => boolean;
	getTurnPreparation?: () => TurnPreparationSnapshot;
	getContextUsage?: () =>
		| (ContextUsageSnapshot & Partial<Pick<LiveBudgetView, "revision" | "historical" | "inputSource">>)
		| undefined;
	getContextLedger?: () => ContextLedger | null;
	getContextState?: () => ContextState | null;
	getContextActivity?: () => HarnessContextActivity;
	getDispatchRows?: () => ReadonlyArray<DispatchBoardRow>;
	getLiveDispatchRows?: () => ReadonlyArray<DispatchBoardRow>;
	getSettledWorkerRows?: () => ReadonlyArray<DispatchBoardRow>;
	getLoops?: () => ReadonlyArray<JobRecord>;
	getTaskBoard?: () => TaskBoardSnapshot | null;
	getLocalCapacity?: () => LocalCapacity | null;
	/** True while the Herdr Watch pane is open and visible beside PanCode. */
	isWatchPaneVisible?: () => boolean;
	getTelemetry?: () => TelemetryView | null;
	getTokenThroughput?: () => TokenThroughputSnapshot | null;
	getQuotaSnapshots?: () => QuotaProviders;
	getToolCounts?: () => ToolTallySnapshot;
	getWorkspaceSnapshot?: () => WorkspaceSnapshot | null;
	getSessionInfo?: () => { id: string | null; name: string | null; turns: number | null };
	getLastTurnSummary?: () => TurnSummary | null;
	getLastShell?: () => ShellSettlement | null;
	getLastCompactionStop?: () => "cancelled" | "failed" | null;
	getExtensionStats?: () => { active: number; installed: number };
	getExtensionStatus?: () => ReadonlyArray<string>;
	getLifecycleHint?: () => string | null;
	getConnections?: () => { mcp: string[]; plugins: string[] };
	getTaskMemoryStatus?: () => TaskMemoryOperatorStatus;
	getNotifications?: () => ReadonlyArray<Notification>;
	getEndedNotifications?: () => ReadonlyArray<Notification>;
	getBackgroundCalls?: () => ReadonlyArray<BackgroundCall>;
	getLeaderArmed?: () => boolean;
	getShutdownArmed?: () => boolean | string;
	getActiveEggs?: () => readonly string[];
	getActiveSkillSurface?: () => ReadonlyArray<string>;
	getAutonomyStatus?: () => AutonomyStatus | null;
	hasReasoningRoute?: (targetId: string | null | undefined, modelId: string | null | undefined) => boolean;
	hasDeliveredThinkingNote?: (
		targetId: string | null | undefined,
		modelId: string | null | undefined,
		level: string,
	) => boolean;
	getDismissKeyLabel?: () => string | undefined;
	getLearnedFeatures?: () => HarnessLearnedFacts;
}

export interface HarnessFactsSource {
	/** O(1) current revision counter (no producer reads); safe on hot render paths. */
	readonly currentRevision: number;
	/** Signal that an underlying producer changed so cached layout regions re-read facts. */
	bump(): void;
	/** Monotonic revision; advances only when snapshot fact data changes, never on animation steps. */
	revision(branchFallback?: string | null): number;
	tier(): OutputStyle;
	/** Fast O(1) route ids without capability or runtime lookups. */
	modelIdentity(): { readonly targetId: string | undefined; readonly modelId: string | undefined };
	autonomyMode(): string;
	yoloConfinement(): string;
	agentStatus(): AgentStatus;
	turnPreparation(): TurnPreparationSnapshot;
	compaction(): CompactionRailFacts | null;
	contextActivity(): HarnessContextActivity;
	backgroundCalls(): ReadonlyArray<BackgroundCall>;
	settlements(): {
		readonly lastTurn: TurnSummary | null;
		readonly lastShell: ShellSettlement | null;
		readonly lastCompactionStop: "cancelled" | "failed" | null;
	};
	/** Fast occupancy-only slice (skips contextState, extensionStats, and ledger when revisioned). */
	contextOccupancy(): ContextOccupancyFacts;
	loops(): ReadonlyArray<JobRecord>;
	taskBoard(): TaskBoardSnapshot | null;
	liveDispatchRows(): ReadonlyArray<DispatchBoardRow>;
	/** Lightweight O(1) stamp of the current target's availability/health for idle chrome memoization. */
	targetHealthKey(): string;
	route(): HarnessRouteFacts;
	thinking(): HarnessThinkingFacts;
	autonomy(): HarnessAutonomyFacts;
	activity(): HarnessActivityFacts;
	context(): HarnessContextFacts;
	work(): HarnessWorkFacts;
	telemetryView(): TelemetryView | null;
	routeReadiness(): HarnessRouteReadinessData | null;
	/** Memoized immutable data snapshot; returns the same reference while `revision` is unchanged. */
	snapshot(branchFallback?: string | null): HarnessFactsSnapshot;
}

function routeTier(
	providers: ProvidersContract,
	targetId: string | null | undefined,
	targetStatus: TargetStatus | null = null,
): RuntimeTier | undefined {
	if (targetStatus?.runtime?.tier !== undefined) return targetStatus.runtime.tier;
	if (!targetId || typeof providers.getTarget !== "function" || typeof providers.getRuntime !== "function")
		return undefined;
	const target = providers.getTarget(targetId);
	return target ? providers.getRuntime(target.runtime)?.tier : undefined;
}

function isContextActivitySnapshot(activity: HarnessContextActivity): activity is ContextActivitySnapshot {
	return activity !== null && "kind" in activity;
}

function runningCompactionFrom(activity: HarnessContextActivity): CompactionRailFacts | null {
	return isContextActivitySnapshot(activity) && activity.kind === "compaction" && activity.completedAtMs === null
		? { phase: activity.phase, startedAtMs: activity.startedAtMs }
		: null;
}

function sameArray<T>(a: ReadonlyArray<T> | undefined, b: ReadonlyArray<T> | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function sameToolCounts(a: ToolTallySnapshot, b: ToolTallySnapshot): boolean {
	if (a === b) return true;
	if (a.errors !== b.errors || a.active !== b.active || a.truncatedResults !== b.truncatedResults) return false;
	if (a.tools === b.tools) return true;
	const aKeys = Object.keys(a.tools);
	const bKeys = Object.keys(b.tools);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		if (a.tools[key] !== b.tools[key]) return false;
	}
	return true;
}

function sameStatus(a: AgentStatus, b: AgentStatus): boolean {
	if (a === b) return true;
	return (
		a.phase === b.phase &&
		a.since === b.since &&
		a.watchdogTier === b.watchdogTier &&
		a.phaseSince === b.phaseSince &&
		a.toolStartedAt === b.toolStartedAt &&
		a.cancelRequestedAt === b.cancelRequestedAt &&
		a.preparingToolCall === b.preparingToolCall &&
		a.writingCallAsText === b.writingCallAsText &&
		a.tool?.toolName === b.tool?.toolName &&
		a.tool?.toolSubject === b.tool?.toolSubject &&
		a.tool?.judging === b.tool?.judging &&
		a.tool?.operatorShell === b.tool?.operatorShell &&
		a.retry === b.retry &&
		a.summary === b.summary &&
		a.modelRequest === b.modelRequest &&
		sameArray(a.activeTools, b.activeTools)
	);
}

function sameRecord<T extends object>(a: T | null | undefined, b: T | null | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	const keys = Object.keys(a) as Array<keyof T>;
	if (keys.length !== Object.keys(b).length) return false;
	for (const key of keys) {
		if (a[key] !== b[key]) return false;
	}
	return true;
}

function sameTargetStatus(a: TargetStatus | null, b: TargetStatus | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.target.id === b.target.id &&
		a.target.defaultModel === b.target.defaultModel &&
		a.available === b.available &&
		a.reason === b.reason &&
		a.health?.status === b.health?.status &&
		a.runtime?.id === b.runtime?.id &&
		a.runtime?.tier === b.runtime?.tier
	);
}

function sameLedger(a: ContextLedger | null | undefined, b: ContextLedger | null | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.usedTokens === b.usedTokens &&
		a.contextWindow === b.contextWindow &&
		a.percent === b.percent &&
		a.measured === b.measured &&
		a.toolCount === b.toolCount &&
		a.compactionThreshold === b.compactionThreshold &&
		a.compactionAuto === b.compactionAuto
	);
}

function sameQuota(a: QuotaProviders, b: QuotaProviders): boolean {
	if (a === b) return true;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		const pa = a[i];
		const pb = b[i];
		if (pa === pb) continue;
		if (
			!pa ||
			!pb ||
			pa.provider !== pb.provider ||
			pa.status !== pb.status ||
			pa.observedAt !== pb.observedAt ||
			pa.windows.length !== pb.windows.length
		) {
			return false;
		}
		for (let j = 0; j < pa.windows.length; j += 1) {
			if (pa.windows[j]?.usedPct.display !== pb.windows[j]?.usedPct.display) return false;
		}
	}
	return true;
}

function sameSnapshotData(prev: HarnessFactsSnapshot, next: Omit<HarnessFactsSnapshot, "revision">): boolean {
	return (
		prev.tier === next.tier &&
		sameRecord(prev.retrySettings, next.retrySettings) &&
		prev.route.targetId === next.route.targetId &&
		prev.route.modelId === next.route.modelId &&
		prev.route.effectiveModelId === next.route.effectiveModelId &&
		prev.route.runtimeId === next.route.runtimeId &&
		prev.route.runtimeTier === next.route.runtimeTier &&
		prev.route.wireModelId === next.route.wireModelId &&
		sameTargetStatus(prev.route.targetStatus, next.route.targetStatus) &&
		prev.thinking.requestedLevel === next.thinking.requestedLevel &&
		prev.thinking.resolvedModelId === next.thinking.resolvedModelId &&
		prev.thinking.alwaysThinks === next.thinking.alwaysThinks &&
		prev.thinking.unprobed === next.thinking.unprobed &&
		prev.thinking.isDefaultRequest === next.thinking.isDefaultRequest &&
		prev.thinking.noteDelivered === next.thinking.noteDelivered &&
		prev.thinking.capability?.mechanism === next.thinking.capability?.mechanism &&
		prev.thinking.capability?.display === next.thinking.capability?.display &&
		prev.thinking.capability?.effectiveLevel === next.thinking.capability?.effectiveLevel &&
		sameArray(prev.thinking.capability?.supportedLevels, next.thinking.capability?.supportedLevels) &&
		prev.autonomy.mode === next.autonomy.mode &&
		prev.autonomy.yoloConfinement === next.autonomy.yoloConfinement &&
		prev.autonomy.window === next.autonomy.window &&
		prev.activity.hasStatusProducer === next.activity.hasStatusProducer &&
		sameStatus(prev.activity.status, next.activity.status) &&
		prev.activity.isStreaming === next.activity.isStreaming &&
		prev.activity.turnPreparation.phase === next.activity.turnPreparation.phase &&
		prev.activity.turnPreparation.since === next.activity.turnPreparation.since &&
		prev.activity.turnPreparation.stage?.step === next.activity.turnPreparation.stage?.step &&
		prev.activity.turnPreparation.stage?.since === next.activity.turnPreparation.stage?.since &&
		sameRecord(prev.activity.compaction, next.activity.compaction) &&
		prev.activity.compactionActive === next.activity.compactionActive &&
		prev.activity.contextActivity === next.activity.contextActivity &&
		prev.activity.lastTurn === next.activity.lastTurn &&
		prev.activity.lastShell === next.activity.lastShell &&
		prev.activity.lastCompactionStop === next.activity.lastCompactionStop &&
		sameArray(prev.activity.backgroundCalls, next.activity.backgroundCalls) &&
		sameToolCounts(prev.activity.toolCounts, next.activity.toolCounts) &&
		sameRecord(prev.context.budget, next.context.budget) &&
		prev.context.used === next.context.used &&
		prev.context.contextWindow === next.context.contextWindow &&
		prev.context.toolSchemaTokens === next.context.toolSchemaTokens &&
		sameRecord(prev.context.breakdown, next.context.breakdown) &&
		sameLedger(prev.context.ledger, next.context.ledger) &&
		prev.context.compactionThreshold === next.context.compactionThreshold &&
		prev.context.compactionAuto === next.context.compactionAuto &&
		prev.context.compactionActive === next.context.compactionActive &&
		prev.context.pancodeMdState === next.context.pancodeMdState &&
		prev.context.memoryCount === next.context.memoryCount &&
		sameRecord(prev.context.extensions, next.context.extensions) &&
		sameArray(prev.work.dispatchRows, next.work.dispatchRows) &&
		sameArray(prev.work.liveRows, next.work.liveRows) &&
		sameArray(prev.work.settledWorkerRows, next.work.settledWorkerRows) &&
		sameArray(prev.work.loops, next.work.loops) &&
		prev.work.taskBoard === next.work.taskBoard &&
		prev.work.localCapacity === next.work.localCapacity &&
		prev.work.watchPaneVisible === next.work.watchPaneVisible &&
		prev.telemetry.view === next.telemetry.view &&
		sameRecord(prev.telemetry.throughput, next.telemetry.throughput) &&
		sameQuota(prev.telemetry.quota, next.telemetry.quota) &&
		prev.telemetry.costCeilingUsd === next.telemetry.costCeilingUsd &&
		prev.workspace.snapshot === next.workspace.snapshot &&
		prev.workspace.branchFallback === next.workspace.branchFallback &&
		sameRecord(prev.workspace.session, next.workspace.session) &&
		sameArray(prev.workspace.activeSkills, next.workspace.activeSkills) &&
		prev.workspace.duckBadge === next.workspace.duckBadge &&
		sameRecord(prev.workspace.memoryIntervention, next.workspace.memoryIntervention) &&
		sameArray(prev.workspace.connections?.mcp, next.workspace.connections?.mcp) &&
		sameArray(prev.workspace.connections?.plugins, next.workspace.connections?.plugins) &&
		sameArray(prev.notices.live, next.notices.live) &&
		sameArray(prev.notices.ended, next.notices.ended) &&
		prev.notices.leaderArmed === next.notices.leaderArmed &&
		prev.notices.shutdownArmed === next.notices.shutdownArmed &&
		prev.notices.dismissKeyLabel === next.notices.dismissKeyLabel &&
		sameArray(prev.extensions.statusLines, next.extensions.statusLines) &&
		prev.extensions.lifecycleHint === next.extensions.lifecycleHint &&
		prev.learned.revision === next.learned.revision &&
		prev.learned.hydrated === next.learned.hydrated &&
		prev.learned.features === next.learned.features
	);
}

export function createHarnessFactsSource(producers: HarnessFactsProducers): HarnessFactsSource {
	let currentRevision = 0;
	let cached: HarnessFactsSnapshot | null = null;
	let cachedThinking: {
		targetId: string | undefined;
		modelId: string | undefined;
		asked: string;
		targetStatus: TargetStatus | null;
		healthStatus: TargetStatus["health"]["status"] | undefined;
		discoveredSource: TargetStatus["discoveredModelsSource"] | undefined;
		alwaysThinks: boolean;
		delivered: boolean;
		value: HarnessThinkingFacts;
	} | null = null;

	const currentTargetStatus = (settings: Readonly<PancodeSettings> | undefined): TargetStatus | null => {
		const targetId = settings?.chat?.target;
		if (!targetId) return null;
		return producers.providers.list().find((candidate) => candidate.target.id === targetId) ?? null;
	};

	const computeThinking = (
		settings: Readonly<PancodeSettings> | undefined,
		targetStatus: TargetStatus | null,
	): HarnessThinkingFacts => {
		const targetId = settings?.chat?.target ?? undefined;
		const modelId = settings?.chat?.model ?? undefined;
		const asked = settings?.chat?.thinkingLevel ?? "off";
		const hasReasoning = producers.hasReasoningRoute?.(targetId, modelId) === true;
		const delivered = producers.hasDeliveredThinkingNote?.(targetId, modelId, asked) === true;
		const healthStatus = targetStatus?.health?.status;
		const discoveredSource = targetStatus?.discoveredModelsSource;
		if (
			cachedThinking !== null &&
			cachedThinking.targetId === targetId &&
			cachedThinking.modelId === modelId &&
			cachedThinking.asked === asked &&
			cachedThinking.targetStatus === targetStatus &&
			cachedThinking.healthStatus === healthStatus &&
			cachedThinking.discoveredSource === discoveredSource &&
			cachedThinking.alwaysThinks === hasReasoning &&
			cachedThinking.delivered === delivered
		) {
			return cachedThinking.value;
		}
		const runtime = resolveModelRuntimeCapabilitiesForProviders(producers.providers, targetId, modelId, asked);
		const capability = runtime?.thinking ?? null;
		const alwaysThinks = capability?.mechanism === "none" && hasReasoning;
		const unprobed = !alwaysThinks && asked !== "off" && healthStatus === "unknown" && discoveredSource !== "runtime";
		const value: HarnessThinkingFacts = {
			requestedLevel: asked,
			resolvedModelId: runtime?.modelId ?? null,
			capability,
			alwaysThinks,
			unprobed,
			isDefaultRequest: asked === DEFAULT_SETTINGS.chat.thinkingLevel,
			noteDelivered: delivered,
		};
		cachedThinking = {
			targetId,
			modelId,
			asked,
			targetStatus,
			healthStatus,
			discoveredSource,
			alwaysThinks: hasReasoning,
			delivered,
			value,
		};
		return value;
	};

	const tier = (): OutputStyle => producers.getSettings?.().interface.outputDetail ?? presentationTier();

	const modelIdentity = (): { readonly targetId: string | undefined; readonly modelId: string | undefined } => {
		const chat = producers.getSettings?.().chat;
		const modelId = chat?.model ?? currentTargetStatus(producers.getSettings?.())?.target.defaultModel ?? undefined;
		return { targetId: chat?.target ?? undefined, modelId };
	};

	const autonomyMode = (): string => producers.getSettings?.().safety.autonomy ?? "default";
	const yoloConfinement = (): string => effectiveYoloConfinement(producers.getSettings?.().safety);
	const agentStatus = (): AgentStatus => producers.getAgentStatus?.() ?? IDLE_AGENT_STATUS;
	const turnPreparation = (): TurnPreparationSnapshot => producers.getTurnPreparation?.() ?? IDLE_TURN_PREPARATION;
	const contextActivity = (): HarnessContextActivity => producers.getContextActivity?.() ?? null;
	const compaction = (): CompactionRailFacts | null => runningCompactionFrom(contextActivity());
	const backgroundCalls = (): ReadonlyArray<BackgroundCall> => producers.getBackgroundCalls?.() ?? EMPTY_BACKGROUND;
	const settlements = () => ({
		lastTurn: producers.getLastTurnSummary?.() ?? null,
		lastShell: producers.getLastShell?.() ?? null,
		lastCompactionStop: producers.getLastCompactionStop?.() ?? null,
	});
	const contextOccupancy = (): ContextOccupancyFacts => {
		const usage = producers.getContextUsage?.();
		return {
			...(usage?.revision
				? {
						budget: {
							revision: usage.revision,
							historical: usage.historical ?? true,
							inputSource: usage.inputSource ?? "unknown",
						},
					}
				: {}),
			used: usage?.tokens ?? null,
			contextWindow: usage?.contextWindow ?? null,
			toolSchemaTokens: usage?.breakdown?.toolSchemaTokens ?? null,
			breakdown: usage?.breakdown ?? null,
			ledger: usage?.revision ? null : (producers.getContextLedger?.() ?? null),
		};
	};
	const loops = (): ReadonlyArray<JobRecord> => producers.getLoops?.() ?? EMPTY_LOOPS;
	const taskBoard = (): TaskBoardSnapshot | null => producers.getTaskBoard?.() ?? null;
	const liveDispatchRows = (): ReadonlyArray<DispatchBoardRow> =>
		producers.getLiveDispatchRows?.() ?? producers.getDispatchRows?.() ?? EMPTY_ROWS;
	const targetHealthKey = (): string => {
		const target = currentTargetStatus(producers.getSettings?.());
		if (!target) return "";
		return `${target.target.id}|${target.available ? 1 : 0}|${target.health?.status ?? ""}|${target.reason ?? ""}`;
	};

	const thinking = (): HarnessThinkingFacts => {
		const settings = producers.getSettings?.();
		return computeThinking(settings, currentTargetStatus(settings));
	};

	const route = (): HarnessRouteFacts => {
		const settings = producers.getSettings?.();
		const targetStatus = currentTargetStatus(settings);
		const targetId = settings?.chat?.target ?? null;
		const modelId = settings?.chat?.model ?? null;
		const effectiveModelId = modelId ?? targetStatus?.target.defaultModel ?? null;
		return {
			targetId,
			modelId,
			effectiveModelId,
			runtimeId: targetStatus?.runtime?.id ?? null,
			runtimeTier: routeTier(producers.providers, targetId, targetStatus),
			wireModelId: effectiveModelId,
			targetStatus,
		};
	};

	const autonomy = (): HarnessAutonomyFacts => {
		const settings = producers.getSettings?.();
		return {
			mode: settings?.safety.autonomy ?? "default",
			yoloConfinement: effectiveYoloConfinement(settings?.safety),
			window: producers.getAutonomyStatus?.() ?? null,
		};
	};

	const activity = (): HarnessActivityFacts => {
		const hasStatusProducer = producers.getAgentStatus !== undefined;
		const status = producers.getAgentStatus?.() ?? IDLE_AGENT_STATUS;
		const contextActivity = producers.getContextActivity?.() ?? null;
		const compaction = runningCompactionFrom(contextActivity);
		const compactionActive = status.phase === "compacting" || (status.activePhases?.has("compacting") ?? false);
		return {
			hasStatusProducer,
			status,
			isStreaming: producers.isStreaming?.() ?? false,
			turnPreparation: producers.getTurnPreparation?.() ?? IDLE_TURN_PREPARATION,
			compaction,
			compactionActive,
			contextActivity,
			lastTurn: producers.getLastTurnSummary?.() ?? null,
			lastShell: producers.getLastShell?.() ?? null,
			lastCompactionStop: producers.getLastCompactionStop?.() ?? null,
			backgroundCalls: producers.getBackgroundCalls?.() ?? [],
			toolCounts: producers.getToolCounts?.() ?? EMPTY_TOOL_COUNTS,
		};
	};

	const context = (): HarnessContextFacts => {
		const settings = producers.getSettings?.();
		const status = producers.getAgentStatus?.();
		const usage = producers.getContextUsage?.();
		const ledger = producers.getContextLedger?.() ?? null;
		const contextState = producers.getContextState?.() ?? null;
		const compactionActive = status?.phase === "compacting" || (status?.activePhases?.has("compacting") ?? false);
		return {
			...(usage?.revision
				? {
						budget: {
							revision: usage.revision,
							historical: usage.historical ?? true,
							inputSource: usage.inputSource ?? "unknown",
						},
					}
				: {}),
			used: usage?.tokens ?? null,
			contextWindow: usage?.contextWindow ?? null,
			toolSchemaTokens: usage?.breakdown?.toolSchemaTokens ?? null,
			breakdown: usage?.breakdown ?? null,
			ledger,
			railLedger: usage?.revision ? null : ledger,
			compactionThreshold: settings?.context.compaction?.threshold ?? null,
			compactionAuto: settings?.context.compaction?.auto ?? null,
			compactionActive,
			pancodeMdState: contextState?.pancodeMd ?? null,
			memoryCount: contextState?.memoryCount ?? null,
			extensions: producers.getExtensionStats?.() ?? null,
		};
	};

	const work = (): HarnessWorkFacts => {
		const dispatchRows = producers.getDispatchRows?.() ?? [];
		return {
			dispatchRows,
			liveRows: producers.getLiveDispatchRows?.() ?? dispatchRows,
			settledWorkerRows: producers.getSettledWorkerRows?.() ?? [],
			loops: producers.getLoops?.() ?? [],
			taskBoard: producers.getTaskBoard?.() ?? null,
			localCapacity: dispatchRows.length > 0 ? (producers.getLocalCapacity?.() ?? null) : null,
			watchPaneVisible: producers.isWatchPaneVisible?.() === true,
		};
	};

	const routeReadiness = (): HarnessRouteReadinessData | null => {
		const settings = producers.getSettings?.();
		const chat = settings?.chat;
		if (!chat?.target) return null;
		const target = currentTargetStatus(settings);
		if (!target || target.health === undefined || typeof target.reason !== "string") return null;
		const last = producers.getLastTurnSummary?.() ?? null;
		const onRoute = last !== null && last.targetId === chat.target && last.modelId === chat.model;
		const missing = missingFromTargetStatus(target);
		return {
			targetId: chat.target,
			available: target.available,
			reason: target.reason,
			health: target.health.status,
			lastStop: onRoute ? last.stopReason : null,
			...(chat.model && modelResidencyForStatus(target, chat.model) === "absent" ? { notResident: true } : {}),
			...(onRoute && last.failure !== undefined ? { lastFailure: last.failure } : {}),
			...(missing !== null ? { missing } : {}),
		};
	};

	const snapshot = (branchFallback: string | null = null): HarnessFactsSnapshot => {
		const settings = producers.getSettings?.();
		const routeFacts = route();
		const taskMemory = producers.getTaskMemoryStatus?.() ?? null;
		const data: Omit<HarnessFactsSnapshot, "revision"> = {
			tier: tier(),
			retrySettings: normalizeRetrySettings(settings?.chat?.retry),
			route: routeFacts,
			thinking: computeThinking(settings, routeFacts.targetStatus),
			autonomy: autonomy(),
			activity: activity(),
			context: context(),
			work: work(),
			telemetry: {
				view: producers.getTelemetry?.() ?? null,
				throughput: producers.getTokenThroughput?.() ?? null,
				quota: producers.getQuotaSnapshots?.() ?? [],
				costCeilingUsd: settings?.safety.limits.sessionCostUsd,
			},
			workspace: {
				snapshot: producers.getWorkspaceSnapshot?.() ?? null,
				branchFallback,
				session: producers.getSessionInfo?.() ?? { id: null, name: null, turns: null },
				activeSkills: producers.getActiveSkillSurface?.() ?? [],
				duckBadge: producers.getActiveEggs?.().includes("duck") ?? false,
				memoryIntervention: taskMemory
					? {
							enabled: taskMemory.enabled,
							tier: taskMemory.tier,
							size: taskMemory.size,
							stepInFlight: taskMemory.stepInFlight,
							lastDecision: taskMemory.lastDecision,
							...(taskMemory.guardian === undefined ? {} : { guardian: taskMemory.guardian }),
						}
					: null,
				connections: producers.getConnections?.(),
			},
			notices: {
				live: producers.getNotifications?.() ?? [],
				ended: producers.getEndedNotifications?.() ?? [],
				leaderArmed: producers.getLeaderArmed?.() ?? false,
				shutdownArmed: producers.getShutdownArmed?.() ?? false,
				dismissKeyLabel: producers.getDismissKeyLabel?.(),
			},
			extensions: {
				statusLines: producers.getExtensionStatus?.() ?? [],
				lifecycleHint: producers.getLifecycleHint?.() ?? null,
			},
			learned: producers.getLearnedFeatures?.() ?? defaultLearnedFeatures(),
		};
		if (cached !== null && sameSnapshotData(cached, data)) return cached;
		currentRevision += 1;
		cached = { revision: currentRevision, ...data };
		return cached;
	};

	return {
		get currentRevision(): number {
			return currentRevision;
		},
		bump(): void {
			currentRevision += 1;
		},
		revision: (branchFallback = null) => snapshot(branchFallback).revision,
		tier,
		modelIdentity,
		autonomyMode,
		yoloConfinement,
		agentStatus,
		turnPreparation,
		compaction,
		contextActivity,
		backgroundCalls,
		settlements,
		contextOccupancy,
		loops,
		taskBoard,
		liveDispatchRows,
		targetHealthKey,
		route,
		thinking,
		autonomy,
		activity,
		context,
		work,
		telemetryView: () => producers.getTelemetry?.() ?? null,
		routeReadiness,
		snapshot,
	};
}
