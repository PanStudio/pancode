// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { assistantOutputChars } from "../core/assistant-output.js";
import { isHostPolicyMessage } from "../core/host-policy-message.js";
import { providerCheckpointFromMessage, providerFallbackDigests } from "../core/provider-checkpoint-handle.js";
import type { SandboxAvailability } from "../core/sandbox/types.js";
import { mainAgent } from "../core/telemetry/context.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import { pancodeStateDir } from "../core/xdg.js";
import type { SuccessfulMemoryContextCommit } from "../domains/memory/commit-state.js";
import type { MemoryInterventionRegistration } from "../domains/memory/intervention-types.js";
import { compactionBudget, getCatalogModelForRuntime } from "../domains/providers/catalog.js";
import { readSessionContextSnapshots } from "../domains/telemetry/index.js";
import {
	engineCodexUserTurn,
	engineInitialSystemPrompt,
	setEngineCodexConfiguration,
	setEngineCodexUserTurn,
	setEngineProviderCheckpointObserver,
	setEngineProviderCompactionPolicy,
	setEngineProviderReplayFallback,
} from "../engine/agent.js";
import { inPrefixRequestRefusal } from "../engine/in-prefix-summary.js";
import { callRepeatsAsRead } from "../engine/loop-guard.js";
import { effectiveCallIdentity } from "../engine/loop-guard-repeat.js";
import type { ContinuityReductionHooks } from "./continuity-controller.js";
import type { MessageListDigests } from "./message-list-digest.js";
import { createMessageListFold, withSettledHistory } from "./message-list-digest.js";
/**
 * Turn context ownership: the session-prompt compile cache, context-snapshot
 * accounting, prompt-cache honesty, and compaction. `runAutoCompact` is the
 * one compaction entry point; the pre-submit trigger, the preflight overflow
 * guard, overflow recovery, `/context compact`, and the post-tool continuation guard
 * all flow through it.
 */

import type { BackendCacheVerdict, BackendCompletionTimings } from "../core/cache-telemetry.js";
import type { PancodeSettings } from "../core/config.js";
import { hostFramedTexts, systemReminderBlock } from "../core/reminder-framing.js";
import type { RouteName, RouteSource } from "../core/route-provenance.js";
import type { PendingSkillToolPolicy } from "../core/skill-activation.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { CallSettled } from "../core/telemetry/schemas.js";
import type { ToolName } from "../core/tool-names.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import type { NotificationLevel } from "../core/views/notice-words.js";
import type { BudgetInspection } from "../domains/context/budget/inspection.js";
import {
	createLiveBudgetProducer,
	type LiveBudgetHandoffProjection,
	type LiveBudgetOutcomeProjection,
	type LiveBudgetView,
} from "../domains/context/budget/live-view.js";
import { requestFits } from "../domains/context/budget/request-fit.js";
import { supersededStageApplies } from "../domains/context/fold/contract.js";
import type { planEviction } from "../domains/context/working-set/engine.js";
import type { ClassifyCall } from "../domains/context/working-set/superseded.js";
import { type PinnedContextBlock, pinnedContextDelta } from "../domains/extensions/pinned-context.js";
import type { MemoryPromptRequest } from "../domains/memory/prompt-cache.js";
import type { MemoryRecordStanding } from "../domains/memory/prompt-section.js";
import type { CompiledSessionPrompt } from "../domains/prompts/compiler.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import { isOrchestratorEligibleRuntime, type ProvidersContract } from "../domains/providers/index.js";
import {
	AutoCompactionTrigger,
	DEFAULT_COMPACTION_THRESHOLD,
	effectiveCompactionThreshold,
} from "../domains/session/compaction/auto.js";
import type { CompactInput, CompactResult } from "../domains/session/compaction/compact.js";
import {
	type CaptureContextSnapshotInput,
	type ContextSnapshot,
	type ContextUsageSnapshot,
	captureContextSnapshot,
	ceilChars,
	contextUsageSnapshot,
	type estimateAgentContextBreakdown,
	snapshotInputTokens,
} from "../domains/session/context-accounting.js";
import { buildContextLedger, type ContextLedger, type PrewarmStats } from "../domains/session/context-ledger.js";
import type { SessionContract } from "../domains/session/contract.js";
import {
	type CompactionTrigger,
	type SessionEntry,
	withProviderCheckpointMeasurements,
} from "../domains/session/entries.js";
import { readPromptCompileRecords, type SessionPromptCompileRecord } from "../domains/session/prompt-manifest.js";
import { activePath, findLastEntry } from "../domains/session/tree/active-path.js";
import type { TelemetryContract } from "../domains/telemetry/contract.js";
import type {
	AgentMessage,
	AnthropicResponseObservation,
	CodexConfiguration,
	CodexTransportObservation,
	ResponsesCacheDiagnostic,
	Usage,
} from "../engine/types.js";
import type { AutonomyLevel } from "../lib/autonomy/autonomy.js";
import type { ToolRegistry } from "../tools/registry-contract.js";
import { extractUserText } from "./chat-loop-messages.js";
import { codexEffortGeneration, codexEffortUpdates } from "./codex-effort.js";
import type { HostInserts } from "./host-inserts.js";
import { contextFloorRefusal, resolveFitOutputReserve, turnAdmissionRemedy } from "./output-reserve.js";
import { extractTurnText } from "./session-replay-messages.js";
import { createTurnContextAnchor } from "./turn-context/anchor.js";
import { createTurnContextBudget } from "./turn-context/budget.js";
import { createTurnContextCache } from "./turn-context/cache.js";
import { createTurnContextFit } from "./turn-context/fit.js";
import { continuationContextUpdate, memoryOrigin, toolResultTail } from "./turn-context/helpers.js";
import { createTurnContextRoute } from "./turn-context/route.js";
import { createTurnContextCompaction } from "./turn-context-compaction.js";
import { createTurnContextMemory } from "./turn-context-memory.js";
import { createTurnContextPrompt } from "./turn-context-prompt.js";
import type { TurnContextScope } from "./turn-context-scope.js";
import type { TurnMiddleware } from "./turn-middleware.js";
import type { AgentRuntime, TurnContextState } from "./turn-state.js";

export interface TurnContextDeps {
	getAutonomy?: () => AutonomyLevel;
	/** A submit is between its start and its settle, so the runtime it built is still the route it runs on. */
	isTurnActive?: () => boolean;
	turnSignal?: () => AbortSignal | undefined;
	/**
	 * The session's standing tool limits (operator flags, an ACP ceiling). The
	 * session prompt compiles from these alone; a turn's own scope rides in its
	 * reminder, so a scope change never recompiles the prompt (#422).
	 */
	standingTurnConstraints?: () => TurnConstraints | undefined;
	memoryCommitBridge?: MemoryInterventionRegistration | undefined;
	/** Durable host inserts: pinned deltas and memory restorations, and the re-issue a checkpoint owes them. */
	hostInserts?: HostInserts | undefined;
	interactiveGuidance?: boolean;
	/** An ACP client that advertised interviews: ask_user guidance without the TUI-only demo tips. */
	operatorInterviews?: boolean;
	/** True for a headless `pancode run`, whose approval asks are always denied. */
	headless?: boolean;
	/** False when no operator message can arrive mid-run; the prompt then omits steering guidance. */
	liveSteering?: boolean;
	/** This host's sandbox backend; absent, the session prompt claims no sandbox. */
	sandboxAvailability?: () => SandboxAvailability;
	state: TurnContextState;
	getSettings: () => Readonly<PancodeSettings>;
	providers: ProvidersContract;
	session?: SessionContract | undefined;
	prompts?: PromptsContract | undefined;
	toolRegistry?: ToolRegistry | undefined;
	telemetry?: TelemetryContract | undefined;
	bus?: TelemetryHub | undefined;
	readSessionEntries?: (() => ReadonlyArray<SessionEntry>) | undefined;
	autoCompact?:
		| ((
				instructions?: string,
				trigger?: CompactionTrigger,
				budget?: Pick<
					CompactInput,
					| "providerCompaction"
					| "livePrefix"
					| "providerFallbackReason"
					| "providerReplayFallback"
					| "keepRecentTokens"
					| "summaryOutputCap"
					| "retainedTargetTokens"
					| "requireFit"
					| "preserveUserTurnId"
					| "pendingOperatorTurn"
					| "skillContextState"
					| "signal"
					| "beforeSummaryCall"
					| "onSummaryOutput"
					| "checkpointForSummary"
					| "checkpointTokenFigures"
					| "skipSummaryDigest"
				>,
		  ) => Promise<CompactResult | null>)
		| undefined;
	/** Test seam for the eviction planner; production uses `planEviction` from the working-set engine. */
	planEviction?: typeof planEviction;
	getMemorySection?: ((request: MemoryPromptRequest) => string) | undefined;
	/** False while `context.memory.enabled` is off: no section, held or live, and no update reminder. */
	memoryEnabled?: (() => boolean) | undefined;
	getMemoryRecordStatuses?: ((ids: readonly string[]) => ReadonlyMap<string, MemoryRecordStanding>) | undefined;
	getReadySkillCount?: (() => number) | undefined;
	/** The extensions' pinned context blocks, sent in the message tail whenever context lacks their current value. */
	pinnedContext?: (() => ReadonlyArray<PinnedContextBlock>) | undefined;
	/** Live source of each active route for the attended prompt; absent for headless runs. */
	getRouteSources?: (() => Readonly<Record<RouteName, RouteSource>>) | undefined;
	/**
	 * Optional continuity projections carried into the live budget view. They
	 * are injected interfaces: this module never reads, writes, or validates the
	 * durable records behind them, and a throwing reader degrades to null rather
	 * than failing a budget publication.
	 */
	getPendingHandoff?: (() => LiveBudgetHandoffProjection | null) | undefined;
	getLastOutcome?: (() => LiveBudgetOutcomeProjection | null) | undefined;
	middleware: TurnMiddleware;
	/** `key` names the notice's kind; a context engine status line carries `CONTEXT_STATUS_NOTICE_KEY`. */
	emitNotice: (text: string, level?: NotificationLevel, key?: string) => void;
	/**
	 * Report that the next response's prompt cache may be cold, and why. It is
	 * telemetry about the run rather than the conversation: the footer's notice
	 * slot shows it, and the Detailed receipt names the reasons beside the reuse
	 * the provider reported. A host without it gets the old transcript notice.
	 */
	emitCacheNotice?: (reasons: ReadonlyArray<string>) => void;
	emitCacheReuseNotice?: (text: string) => void;
}

export interface LiveContextEstimate {
	/**
	 * The figure to budget against: the reconciled total when the provider has
	 * attested one for this conversation, otherwise the estimate. Never below
	 * the estimate, because the estimate covers material the last provider call
	 * did not see.
	 */
	tokens: number;
	/** Structural projection; includes the usage floor when no live anchor is trusted. */
	estimatedTokens: number;
	/**
	 * Provider-attested prompt tokens for the messages up to the last reconciled
	 * call, plus a chars/4 estimate of everything appended since. Null before the
	 * first reconcile of a session and after a summary compaction rewrites the
	 * history the attestation described.
	 */
	reconciledTokens: number | null;
	contextWindow: number;
	breakdown: ReturnType<typeof estimateAgentContextBreakdown>;
}

/**
 * Known causes that make the next provider prefix cache miss expected: the journal's closed vocabulary, so the host
 * records no reason a call record cannot carry. `background_memory` is a proactive-memory step on the endpoint this
 * session streams against, whose trajectory prompt displaces a local server's single prefix cache (#229).
 */
export type ExpectedColdReason = CallSettled["cache"]["expectedColdReasons"][number];

export type LiveContextUsage = ContextUsageSnapshot &
	Pick<LiveBudgetView, "revision" | "inputSource" | "historical" | "breakdownSource">;

export interface TurnContext {
	notifyMemoryCommit(
		commitId: string,
		kind: SuccessfulMemoryContextCommit["kind"],
		outcome: SuccessfulMemoryContextCommit["outcome"],
	): void;
	/** `beforeTurnId` is the submitted user row the install renders ahead of; absent, it follows the newest row. */
	installMemoryRestoration(runtime: AgentRuntime, pendingUserText?: string, beforeTurnId?: string): boolean;
	/** Prepare an attempt before preflight; rejected attempts never freeze the next submit. */
	prepareMemoryTurn(
		runtime: AgentRuntime,
		input: { taskText: string; continuation: boolean; images?: ReadonlyArray<unknown> | undefined },
	): void;
	/** Bind first-session creation after append without rereading the prepared snapshot. */
	commitMemoryTurn(runtime: AgentRuntime): void;
	/** The per-route request configuration a submit binds when it commits, for a run that changes route after that. */
	syncRouteConfiguration(agentRuntime: AgentRuntime): void;
	ensureSessionPrompt(
		agentRuntime: AgentRuntime,
		beforeSend?: boolean,
		pendingUserText?: string,
		skipProviderFallback?: boolean,
	): Promise<CompiledSessionPrompt | null>;
	/** Whether the runtime of a session the automatic pass could shrink still carries a prompt other than this session's compile, such as the seeded fallback. */
	sessionPromptPending?(agentRuntime: AgentRuntime): boolean;
	thinkingUsesConfigurationUpdate(): boolean;
	commitSessionPosture(agentRuntime: AgentRuntime, userTurnId: string): void;
	/**
	 * Host-framed text the last `ensureSessionPrompt` left for the turn's
	 * reminder: what changed in frozen prompt inputs since the compile (#423).
	 */
	sessionPromptDelta(): string;
	promptCompileRecord?(): SessionPromptCompileRecord | null;
	compiledSessionPrompt?(): CompiledSessionPrompt | null;
	logPromptCompileIfPending(): void;
	invalidateSessionPromptCache(): void;
	addWorkingContextPaths(paths: ReadonlyArray<string>): void;
	/** Whether the active user turn is in the ledger, so a rebuild from it already carries the request. */
	activeTurnCommitted?(): boolean;
	captureRuntimeContextSnapshot(
		agentRuntime: AgentRuntime,
		turnId: string,
		compactionThreshold: number | null,
		extra?: Partial<CaptureContextSnapshotInput>,
	): ContextSnapshot;
	setCurrentSnapshot(snapshot: ContextSnapshot): void;
	persistContextSnapshot(snapshot: ContextSnapshot): void;
	flushReconciledSnapshot(): void;
	/** Reconcile the live snapshot against one API call's provider usage. */
	/** `call` names the journal call the usage came from, so the persisted snapshot can cite it (#434). */
	reconcileUsage(usage: Usage, call?: { callId: string; attemptId: string }): void;
	/**
	 * Prompt-side tokens the current snapshot accounts for. The prompt of an
	 * in-flight call is spent whatever the operator does next, so an interrupted
	 * turn records this rather than zero. 0 when no snapshot exists yet.
	 */
	promptSideTokens(): number;
	liveContextEstimate(agentRuntime: AgentRuntime, pendingUserText?: string): LiveContextEstimate;
	/**
	 * Recompute and publish the live budget view.
	 *
	 * Called at the seams that change the next request (capture, reconcile,
	 * reduction, the mid-run tool-batch boundary, run settlement) and by any
	 * consumer about to make a decision from it. The only thing it mutates is
	 * the accounting cache: no
	 * persistence, no model call, and no reduction happens because something
	 * asked what the budget is.
	 */
	refreshLiveBudget(pendingUserText?: string): LiveBudgetView;
	/**
	 * After `resetForSession` re-entered a history and the runtime published its next request, journal that
	 * projected figure beside the session's last persisted measurement, once per reset (CLI-P37).
	 */
	journalResumedBudget?(view: LiveBudgetView): void;
	/**
	 * Disarm the A4 pin an overflow fold that fit armed. While armed, the
	 * published view's `inputTokens` is the A4 count; the main request that
	 * carries it disarms it.
	 */
	takeOverflowInputPin?(): void;
	/**
	 * The A4 count of the request these messages and the pending ask make: the
	 * larger of PanCode's estimate and Pi's chars/3.5 count. Window-fit gates that
	 * open the overflow path read it, so Pi's clamp never refuses a request
	 * they passed. With a provider-measured anchor on this route it is the
	 * anchored count instead, and `floor` (the caller's own count) is ignored.
	 */
	overflowFitTokens?(agentRuntime: AgentRuntime, pendingUserText?: string, floor?: number): number;
	/** The anchored count `overflowFitTokens` takes when this route has a provider-measured anchor, else null. */
	anchoredInputTokens?(agentRuntime: AgentRuntime): number | null;
	/**
	 * The refusal of a request that cannot fit this run's --max-context-tokens window under 52,428 tokens even with no
	 * history: its system prompt, tool schemas and ask plus a minimum reply. Null when it clears that floor.
	 */
	contextFloorRefusal?(agentRuntime: AgentRuntime, pendingUserText?: string): string | null;
	/** Null while the request fits on the A4 count; otherwise the sentence naming the largest result it carries. */
	oversizedResult?(agentRuntime: AgentRuntime, pendingUserText?: string): string | null;
	/**
	 * The published live budget view. A pure getter for renderers and tools:
	 * it never rescans the conversation or reprices the footer. The first call
	 * of a session publishes once, because a view has to exist before it can be
	 * read.
	 */
	liveBudget(): LiveBudgetView;
	/** Inspect only when the native engine owns the request; never initialize it. */
	inspectLiveBudget(): BudgetInspection;
	refreshAgentMessagesFromSession(agentRuntime: AgentRuntime): ReadonlyArray<SessionEntry>;
	runAutoCompact(
		agentRuntime: AgentRuntime,
		force: boolean,
		instructions?: string,
		triggerOverride?: CompactionTrigger,
		pendingUserText?: string,
		pendingSkillPolicy?: PendingSkillToolPolicy,
		signal?: AbortSignal,
		handoff?: ContinuityReductionHooks,
		pendingUserIsOperator?: boolean,
		providerFallbackReason?: string,
		/** The id the pending prompt's user turn is reserved under, so this compaction is charged to that turn. */
		pendingUserTurnId?: string,
	): Promise<boolean>;
	lastCompactionWasNoGain(): boolean;
	/**
	 * Start a step turn from a compact state: write a step-boundary checkpoint
	 * whose summary is `lead` and rebuild the messages from it, with no
	 * summarizer call. False when nothing was cut, or when a skill load it
	 * cannot carry would be cut (WTF-P 0.8.3 C5).
	 */
	runStepCheckpoint(
		agentRuntime: AgentRuntime,
		lead: string,
		pendingSkillPolicy?: PendingSkillToolPolicy,
	): Promise<boolean>;
	/** The last reduction that ended in a stop or failure settled its own transcript card, which already says so. */
	lastCompactionCardSettled(): boolean;
	cancelCompaction(): void;
	/**
	 * The pinned context blocks the context does not carry at their current
	 * value, read live against the messages as they stand, so a turn composed
	 * after a compaction sends a dropped block again verbatim.
	 */
	pinnedContextDelta(agentRuntime: AgentRuntime): string[];
	/**
	 * Between tool batches, append the pinned context blocks the context no
	 * longer carries at their current value (a hook changed one, or a
	 * compaction dropped it) as a host-framed tail; true when it appended.
	 */
	appendPinnedContext(agentRuntime: AgentRuntime): boolean;
	postToolContinuationGuard(
		agentRuntime: AgentRuntime,
		signal?: AbortSignal,
		/** A completed background reminder was just appended to the context tail. */
		contextChanged?: boolean,
		/**
		 * Runs once the guard settles without a stop, synchronously after its last publication and in the same settled
		 * history stretch, so a publication it makes reads that walk instead of a fresh one (SC-6). It must not await.
		 */
		settledTail?: () => void,
	): Promise<
		| {
				context: { messages: AgentMessage[]; tools: AgentRuntime["agent"]["state"]["tools"] };
				model: AgentRuntime["agent"]["state"]["model"];
				thinkingLevel: AgentRuntime["agent"]["state"]["thinkingLevel"];
		  }
		| undefined
	>;
	contextUsage(): LiveContextUsage;
	contextLedger(): ContextLedger;
	/** Record one known cache disturbance for the current or next call. */
	noteColdReason(reason: ExpectedColdReason): void;
	/** The tool choice a request sends; `afterRejection` marks the #426 retry of a request the provider rejected. */
	noteCacheRequestToolChoice(toolChoice: string, afterRejection?: boolean): void;
	/** Compare the system prompt a request leads with against the session's previous request (bt-10). */
	noteCacheRequestSystemPrompt?(afterRejection?: boolean): void;
	/** Consume disturbances since the last settled run (T3.3 honesty). */
	consumeExpectedColdReasons(runtimeId: string): void;
	/** Disturbances since the last main request was sent; the journal stamps them on the next one (#434). */
	takeCallColdReasons?(): ExpectedColdReason[];
	/** Advances whenever cache comparison restarts: a committed compaction or a session reset (#423, #434). */
	cacheGeneration?(): number;
	/** Prompt-cache record for one persisted assistant call, with cold-reason stamp. */
	promptCachePayloadForAssistant(
		usage: Usage,
		backend?: BackendCompletionTimings,
		anthropicResponse?: AnthropicResponseObservation,
		transport?: CodexTransportObservation,
		responsesDiagnostic?: ResponsesCacheDiagnostic,
	): Record<string, unknown>;
	/** Record the settled run's cache summary for /context. */
	noteRunCacheSummary(messages: ReadonlyArray<AgentMessage>, runFirstCallVerdict: BackendCacheVerdict | null): void;
	/**
	 * Record one pre-warm for `/context`. It contributes no tokens to the context
	 * estimate and is never an expected-cold reason: a pre-warm is the opposite
	 * of a disturbance, it is the prefix the next turn wants already resident.
	 */
	notePrewarm(prewarm: PrewarmStats): void;
	/**
	 * Drop per-session accounting. `branchAnchorTurnId` is the leaf the incoming
	 * session's next turn parents under; it becomes the advisory branch identity,
	 * which is why it is supplied only here. Ordinary appends advance the leaf
	 * without re-arming an advisory; real navigation re-arms it.
	 */
	resetForSession(branchAnchorTurnId?: string | null): void;
	navigationRevision(): number;
	dispose(): void;
}

/** The newest reduction on `path`, in the shape a live commit notes it. */
function compactionEventOnPath(
	path: ReadonlyArray<SessionEntry>,
): { stage: string; tokensBefore: number; tokensAfter: number; trigger: string } | null {
	for (let index = path.length - 1; index >= 0; index -= 1) {
		const entry = path[index];
		if (entry?.kind === "contextEviction") {
			const stage = entry.trigger === "superseded" ? "superseded" : "working_set";
			return { stage, tokensBefore: entry.tokensBefore, tokensAfter: entry.tokensAfter, trigger: entry.trigger };
		}
		if (entry?.kind === "compactionSummary") {
			if (entry.tokensAfter === undefined) return null;
			const stage = entry.trigger === "step" ? "step_checkpoint" : "llm_summary";
			return {
				stage,
				tokensBefore: entry.tokensBefore,
				tokensAfter: entry.tokensAfter,
				trigger: entry.trigger ?? "unknown",
			};
		}
	}
	return null;
}

const tokenCount = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);

const PROMPT_SPLIT_KEYS = [
	"system",
	"tools",
	"agents",
	"skills",
	"memory",
	"project",
	"toolResults",
	"messages",
] as const satisfies ReadonlyArray<keyof ContextSnapshot["categories"]>;

/** `categories` with its prompt split scaled down to sum to `total`; a split already within it is returned as is. */
function splitWithin(categories: ContextSnapshot["categories"], total: number): ContextSnapshot["categories"] {
	const sum = PROMPT_SPLIT_KEYS.reduce((acc, key) => acc + (categories[key] ?? 0), 0);
	if (sum <= total || sum <= 0) return categories;
	const scaled = { ...categories };
	let kept = 0;
	for (const key of PROMPT_SPLIT_KEYS) {
		if (key === "messages") continue;
		scaled[key] = Math.floor((categories[key] ?? 0) * (total / sum));
		kept += scaled[key] ?? 0;
	}
	// The flooring remainder goes to the conversation, as a reconciled split's residual does.
	scaled.messages = Math.max(0, total - kept);
	return scaled;
}

/** The persisted snapshot's split as a journal record, under the real session and turn (#434). */
function recordContextSnapshot(sessionId: string, snapshot: ContextSnapshot): void {
	const split = snapshot.categories;
	telemetryHub().emit(
		"context.snapshotted",
		{
			snapshotId: snapshot.snapshotId,
			providerId: snapshot.providerId,
			runtimeId: snapshot.runtimeId,
			modelId: snapshot.modelId,
			splits: snapshot.sources.splits,
			...(snapshot.promptSegments ? { promptSegments: snapshot.promptSegments } : {}),
			...(snapshot.promptHash ? { promptHash: snapshot.promptHash } : {}),
			...(snapshot.toolSignature ? { toolSignature: snapshot.toolSignature } : {}),
			...(snapshot.messageRange ? { messageRange: snapshot.messageRange } : {}),
			...(snapshot.divergenceRatio !== undefined ? { divergenceRatio: snapshot.divergenceRatio } : {}),
			categories: {
				system: tokenCount(split.system),
				tools: tokenCount(split.tools),
				...(split.toolResults !== undefined ? { toolResults: tokenCount(split.toolResults) } : {}),
				agents: tokenCount(split.agents),
				skills: tokenCount(split.skills),
				memory: tokenCount(split.memory),
				project: tokenCount(split.project),
				messages: tokenCount(split.messages),
				reserve: tokenCount(split.reserve),
				free: tokenCount(split.free),
				streaming: tokenCount(split.streaming),
			},
			window: {
				desired: tokenCount(snapshot.desiredContextWindow),
				effective: tokenCount(snapshot.effectiveContextWindow),
				source: snapshot.contextWindowSource || "unknown",
			},
			source: snapshot.sources.total,
			...(snapshot.estimatedTokens !== undefined ? { estimatedTokens: tokenCount(snapshot.estimatedTokens) } : {}),
			...(snapshot.reconciledTokens !== undefined ? { reconciledTokens: tokenCount(snapshot.reconciledTokens) } : {}),
		},
		{
			sessionId,
			agent: mainAgent(sessionId),
			...(snapshot.turnId ? { turnId: snapshot.turnId } : {}),
			...(snapshot.callId && snapshot.attemptId ? { callId: snapshot.callId, attemptId: snapshot.attemptId } : {}),
		},
	);
}

/**
 * The error name of the post-tool guard's clean stops: one tool result alone still overflows after compaction, the
 * compacted request with its tool results still does not fit the window, or the compaction a fit needed failed. Pi keeps only the message, so the turn runtime reads the name off the throw to journal the harness's own cause.
 */
export const OVERSIZED_RESULT_STOP = "PancodeOversizedResultStop";

const oversizedResultStop = (message: string): Error =>
	Object.assign(new Error(message), { name: OVERSIZED_RESULT_STOP });

/** What a compaction trigger reads of a route: a built runtime, or the route in settings before one is built. */
export type CompactionRouteView = Pick<AgentRuntime, "targetId" | "wireModelId" | "runtimeResolution"> & {
	agent: { state: { model: AgentRuntime["agent"]["state"]["model"] } };
};

export function createTurnContext(deps: TurnContextDeps): TurnContext {
	const { state, middleware } = deps;
	const activeEntries = () => activePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
	const compactionTrigger = new AutoCompactionTrigger<CompactResult | null>();

	/**
	 * The last provider-attested prompt size, and how many agent messages it
	 * covered (issue #227).
	 *
	 * `tokens` is the provider's own prompt count for that call plus the output
	 * it produced, which together are what the next call's prompt carries for
	 * the same messages. The anchored message prefix identifies that history,
	 * so anything appended since is priced by estimate and added on top.
	 * Unlike the per-message usage anchor inside
	 * `estimateAgentContextTokens`, this survives `contextUsageInvalidated`:
	 * a working-set projection subtracts the tokens it removed rather than
	 * throwing the attestation away.
	 */
	const historyFold = createMessageListFold();
	/** The next request's history, folded: only messages appended since the last publication are serialized. */
	const observeHistory = (agentRuntime: AgentRuntime): MessageListDigests =>
		historyFold.observe(
			agentRuntime.agent.state.messages.filter((message) => message.role !== "system" || isHostPolicyMessage(message)),
		);
	const overflowPinArmed = (): boolean =>
		shared.overflowInputPin !== null && shared.overflowInputPin.sessionId === deps.session?.current()?.id;
	const pendingPolicyText = (): string | null => {
		if (!shared.pendingPosture || !deps.prompts?.renderSessionPostureUpdate) return null;
		const autonomy = deps.getAutonomy?.() ?? deps.getSettings().safety.autonomy ?? "default";
		if (autonomy === shared.pendingPosture.effectiveAutonomy) return null;
		let text = shared.pendingPosture.rendered.get(autonomy);
		if (text === undefined) {
			text = deps.prompts.renderSessionPostureUpdate(autonomy, shared.pendingPosture.inputs);
			shared.pendingPosture.rendered.set(autonomy, text);
		}
		return text;
	};
	// The pinned blocks the context lacks at their current value. Read against the messages as they stand, after any
	// compaction, so a block a summary dropped goes again verbatim and an unchanged one never repeats.
	const pinnedDelta = (agentRuntime: AgentRuntime): string[] => {
		const blocks = deps.pinnedContext?.() ?? [];
		return blocks.length === 0 ? [] : pinnedContextDelta(blocks, hostFramedTexts(agentRuntime.agent.state.messages));
	};
	const sessionWorkingContextPaths = new Set<string>();
	/** The loop guard's call identity and A1 read test, with each extension tool's declared effect. */
	const classifyCall: ClassifyCall = (name, args) => ({
		identity: effectiveCallIdentity(name, args),
		read: callRepeatsAsRead(name, args, (tool) => deps.toolRegistry?.get(tool as ToolName)?.metadata),
	});

	// The live budget view and the identity that decides when an advisory
	// re-arms. `branchAnchorTurnId` moves only on real branch navigation, so two
	// tool batches advancing `state.lastTurnId` under the same branch keep one
	// advisory epoch; `navigationEpoch` separates two visits to the same leaf id.
	const budgetProducer = createLiveBudgetProducer();

	// Cache-disturbance honesty (T3.3). Accumulate every known local-runtime
	// disturbance and prefix-byte change since the last settled run. The next
	// submit consumes the set, stamps `promptCache.expectedColdReasons` on its
	// first assistant entry, and shows one dim notice.
	const pendingColdReasons = new Set<ExpectedColdReason>();
	const shared: TurnContextScope = {
		deps,
		state,
		middleware,
		activeEntries,
		compactionTrigger,
		observeHistory,
		sessionWorkingContextPaths,
		memoryOrigin,
		classifyCall,
		budgetProducer,
		get loadCacheCallBaseline() {
			return cache.loadCacheCallBaseline;
		},
		get resetCacheCallBaseline() {
			return cache.resetCacheCallBaseline;
		},
		get noteColdReason() {
			return cache.noteColdReason;
		},
		get persistContextSnapshot() {
			return persistContextSnapshot;
		},
		get captureRuntimeContextSnapshot() {
			return captureRuntimeContextSnapshot;
		},
		get lastRecordedPromptHash() {
			return lastRecordedPromptHash;
		},
		get reconciledHistoryTokens() {
			return anchors.reconciledHistoryTokens;
		},
		get summaryOnChatRoute() {
			return routing.summaryOnChatRoute;
		},
		get routeCompaction() {
			return routing.routeCompaction;
		},
		get liveContextEstimate() {
			return fitting.liveContextEstimate;
		},
		get overflowFitTokens() {
			return fitting.overflowFitTokens;
		},
		get pinOverflowFit() {
			return fitting.pinOverflowFit;
		},
		get liveBudgetInput() {
			return budgeting.liveBudgetInput;
		},
		get refreshLiveBudget() {
			return budgeting.refreshLiveBudget;
		},
		get evictionAnchor() {
			return anchors.evictionAnchor;
		},
		get carryReconciledAnchorThroughProjection() {
			return anchors.carryReconciledAnchorThroughProjection;
		},
		get bindProviderCompaction() {
			return bindProviderCompaction;
		},
		get syncCodexConfiguration() {
			return syncCodexConfiguration;
		},
		compactionController: null,
		disposed: false,
		currentContextSnapshot: null,
		promptDigest: null,
		overflowInputPin: null,
		reconciledAnchor: null,
		lastCompactionNoGain: false,
		routeCalibration: null,
		lastCompactionEvent: null,
		lastPromptCache: null,
		lastSystemPromptReused: false,
		lastPrewarm: null,
		sessionPrompt: null,
		sessionPromptKey: null,
		sessionPromptInvalidated: false,
		postureGeneration: null,
		postureGenerationPersisted: false,
		pendingPosture: null,
		frozenMemorySection: null,
		frozenRouteSources: undefined,
		frozenRouteIdentity: "",
		thinkingUsesConfigurationUpdate: false,
		frozenMemorySessionId: "",
		memoryRestoredSessionId: null,
		sessionPromptDelta: "",
		sessionPromptHash: null,
		resumedPromptHashRead: false,
		resumedPromptHash: null,
		memoryAuthorityEpoch: 0,
		memoryTurn: null,
		pendingPromptLogEntry: null,
		pendingPromptLogMemory: null,
		latestPromptCompile: null,
		emptyAutoCompactContextKey: null,
		autoCompactFailures: 0,
		summaryRouteMemo: null,
		summaryRearm: null,
		summaryRearmSeededFor: null,
		noGainSummaryDigest: null,
		branchAnchorTurnId: null,
		navigationEpoch: 0,
		noUsefulCutBasisKey: null,
		resumedBudget: null,
		runExpectedColdReasons: [],
		nextAssistantColdReasons: [],
		callColdReasons: [],
		cacheGeneration: 0,
		cacheCallBaseline: null,
		cacheCallBaselineLoaded: false,
		cacheRequestToolChoice: "auto",
		sentToolChoice: undefined,
		priorSentToolChoice: undefined,
		cacheRequestSystemPromptHash: undefined,
		sentSystemPrompt: undefined,
		priorSentSystemPrompt: undefined,
		nextChangedSection: undefined,
		previousPromptSections: null,
		snapshotPersistPending: false,
		rehydrationMiss: null,
		pendingUserImages: [],
		reductionPendingText: undefined,
		lastCompactionCardSettled: false,
		get notifyMemoryCommit() {
			return notifyMemoryCommit;
		},
		get resolveProviderReplay() {
			return resolveProviderReplay;
		},
		get controller() {
			return controller;
		},
		pendingColdReasons,
		pendingPolicyText,
		get routeTokenRatio() {
			return anchors.routeTokenRatio;
		},
		get measuredAnchor() {
			return anchors.measuredAnchor;
		},
		get windowWithoutRuntime() {
			return routing.windowWithoutRuntime;
		},
		overflowPinArmed,
		get pendingUserInputTokens() {
			return pendingUserInputTokens;
		},
	};

	const cache = createTurnContextCache(shared);

	const persistContextSnapshot = (snapshot: ContextSnapshot): void => {
		const currentSession = deps.session?.current();
		if (!currentSession) {
			shared.snapshotPersistPending = true;
			return;
		}
		if (snapshot.sessionId !== null && snapshot.sessionId !== currentSession.id) return;
		snapshot.sessionId = currentSession.id;
		recordContextSnapshot(currentSession.id, snapshot);
		shared.snapshotPersistPending = false;
	};

	/**
	 * Capture a context snapshot from the runtime's live agent state. All
	 * capture sites (turn submit, both compaction paths) flow through this
	 * helper so window resolution and category decomposition stay identical.
	 */
	const captureRuntimeContextSnapshot = (
		agentRuntime: AgentRuntime,
		turnId: string,
		compactionThreshold: number | null,
		extra: Partial<CaptureContextSnapshotInput> = {},
	): ContextSnapshot => {
		const details = agentRuntime.runtimeResolution.contextWindowDetails;
		const systemPrompt = engineInitialSystemPrompt(agentRuntime.agent);
		// The compiled prompt the agent carries splits itself, so a capture that names no
		// segments (a checkpoint, an eviction) keeps the Agent fleet and Project rows
		// instead of folding the whole prompt into System prompt (bt-48).
		const compiled =
			shared.sessionPrompt !== null && shared.sessionPrompt.systemPrompt === systemPrompt ? shared.sessionPrompt : null;
		// The snapshot row belongs to the named PanCode session whose ledger it is
		// appended to; the engine agent's own sessionId is unset in practice.
		return captureContextSnapshot({
			sessionId: deps.session?.current()?.id ?? null,
			turnId,
			providerId: agentRuntime.targetId,
			runtimeId: agentRuntime.runtimeId,
			modelId: agentRuntime.wireModelId,
			systemPrompt,
			conversationMessages: agentRuntime.agent.state.messages.filter(
				(message) => message.role !== "system" || isHostPolicyMessage(message),
			),
			activeToolSchemas: agentRuntime.agent.state.tools,
			desiredContextWindow: details.desiredContextWindow,
			effectiveContextWindow: details.effectiveContextWindow,
			contextWindowSource: details.contextWindowSource,
			compactionThreshold,
			...extra,
			...(compiled
				? {
						promptSegments: compiled.sections.map((s) => ({ id: s.id, tokenEstimate: s.tokenEstimate })),
						promptHash: compiled.systemPromptHash,
					}
				: {}),
		});
	};

	/**
	 * Output tokens of the in-flight response. While streaming, estimate from
	 * the partial assistant tail; once the turn settles, the reconciled
	 * snapshot carries the provider-reported value.
	 */
	const liveStreamingOutputTokens = (): number => {
		if (!state.runtime) return 0;
		if (state.streaming) {
			const partial = state.runtime.agent.state.streamingMessage;
			if (partial?.role === "assistant") {
				return ceilChars(assistantOutputChars(partial));
			}
			return 0;
		}
		return shared.currentContextSnapshot?.categories.streaming || 0;
	};

	/**
	 * Tokens for the submitted text that the snapshot has not yet counted.
	 * The turn snapshot is captured before the user message joins the
	 * conversation, so until the provider reconciles (or a fresh capture sees
	 * the text in the conversation) the pending input occupies window space
	 * that no category covers. Zero once reconciled or once the text landed.
	 */
	const pendingUserInputTokens = (): number => {
		const snapshot = shared.currentContextSnapshot;
		if (!snapshot?.pendingUserInput) return 0;
		if (snapshot.sources.total === "reconciled") return 0;
		if (snapshot.turnId !== "pending") {
			const pending = snapshot.pendingUserInput;
			const landed = (snapshot.conversationMessages ?? []).some(
				(message) => extractUserText(message as AgentMessage) === pending,
			);
			if (landed) return 0;
		}
		return ceilChars(snapshot.pendingUserInput.length);
	};

	/**
	 * The window the next turn will resolve to, read the way ensureRuntime
	 * reads it but without building an agent. Before the first turn of a
	 * process, /resume included, state.runtime is null, and the ledger and the
	 * footer meter said `context window unknown · 0 tokens` until a turn ran
	 * (issue #189). Null when no target is configured or it does not resolve,
	 * and the overlay's "unknown" is then true.
	 */
	/**
	 * The prompt hash this session last recorded, for the first compile of a
	 * resumed process. Without it a resume reports `previousHash: null`, which
	 * reads as "there was no prompt before" when in fact there was one and it
	 * is exactly what a reader needs to attribute the cold cache to: a layout
	 * bump, a fragment edit, or a moved context window (issue #249).
	 */
	const lastRecordedPromptHash = (): string | null => {
		if (shared.resumedPromptHashRead) return shared.resumedPromptHash;
		shared.resumedPromptHashRead = true;
		const currentSession = deps.session?.current();
		if (!currentSession) {
			// No session to read; leave the lookup open for the next compile.
			shared.resumedPromptHashRead = false;
			return null;
		}
		const records = readPromptCompileRecords(currentSession);
		const previous = records[records.length - 1];
		shared.resumedPromptHash = previous?.systemPromptHash ?? null;
		shared.previousPromptSections = previous?.sections ?? null;
		return shared.resumedPromptHash;
	};

	const routing = createTurnContextRoute(shared);

	const anchors = createTurnContextAnchor(shared);

	const fitting = createTurnContextFit(shared);

	const budgeting = createTurnContextBudget(shared);

	const bindProviderCompaction = (runtime: AgentRuntime): void => {
		setEngineProviderCompactionPolicy(
			runtime.agent,
			() => deps.getSettings().context.compaction.provider === "native" && runtime.runtimeId === "openai-codex",
		);
		const origin = deps.session?.current()?.id;
		setEngineProviderReplayFallback(runtime.agent, async (reason) => {
			if (origin !== deps.session?.current()?.id) throw new DOMException("Replay ownership changed", "AbortError");
			await resolveProviderReplay(runtime, reason);
		});
		setEngineProviderCheckpointObserver(runtime.agent, (handle, inputTokens) => {
			if (origin !== deps.session?.current()?.id) return;
			const entries = withProviderCheckpointMeasurements(activeEntries());
			const checkpoint = entries.find(
				(entry) => entry.kind === "compactionSummary" && entry.providerCheckpoint?.digest === handle.digest,
			);
			if (checkpoint?.kind !== "compactionSummary" || checkpoint.providerCheckpoint?.replayInputTokens !== undefined)
				return;
			// The full inclusive request is a measured upper bound; it never underprices opaque input (#423).
			deps.session?.appendEntry({
				kind: "custom",
				parentTurnId: state.lastTurnId,
				customType: "pancode_provider_checkpoint_input",
				data: { version: 1, checkpointDigest: handle.digest, inputTokens, measurement: "inclusive-request-upper-bound" },
			});
			deps.session?.flushAppends?.();
			runtime.agent.state.messages = runtime.agent.state.messages.map((message) => {
				const marker = providerCheckpointFromMessage(message);
				return marker?.digest === handle.digest
					? { ...message, pancodeProviderCheckpoint: { ...marker, replayInputTokens: inputTokens } }
					: message;
			});
		});
	};

	// Ledger boundaries, rather than request retries, own Codex effort changes (#423).
	const syncCodexConfiguration = (runtime: AgentRuntime): void => {
		bindProviderCompaction(runtime);
		const model = runtime.agent.state.model;
		shared.thinkingUsesConfigurationUpdate = false;
		if (model?.api !== "openai-codex-responses") {
			setEngineCodexConfiguration(runtime.agent, undefined);
			return;
		}
		const effortFor = (level: string): string => {
			const map = model.thinkingLevelMap as Record<string, string | null> | undefined;
			return map?.[level] ?? (level === "off" ? "none" : level);
		};
		const currentEffort = effortFor(runtime.runtimeResolution.effectiveThinkingLevel);
		const entries = activeEntries();
		const generation = codexEffortGeneration(entries);
		const start = entries.length - generation.length;
		const baseline = generation.find((entry) => entry.kind === "thinkingLevelChange" && entry.configurationInitial);
		let initialEffort = baseline?.kind === "thinkingLevelChange" ? baseline.effectiveEffort : undefined;
		if (initialEffort === undefined) {
			const meta = deps.session?.current();
			const firstCompile = start === 0 && meta ? readPromptCompileRecords(meta)[0] : undefined;
			initialEffort = firstCompile?.thinkingLevel ? effortFor(firstCompile.thinkingLevel) : currentEffort;
			if (meta) {
				deps.session?.appendEntry({
					kind: "thinkingLevelChange",
					parentTurnId: state.lastTurnId,
					thinkingLevel: runtime.runtimeResolution.effectiveThinkingLevel,
					effectiveEffort: initialEffort,
					configurationInitial: true,
				});
			}
		}
		const available = new Set<string>();
		const usersByTime = new Map<number, Array<SessionEntry>>();
		for (const entry of entries) {
			if (entry.kind !== "message" || entry.role !== "user") continue;
			const time = Date.parse(entry.timestamp);
			const group = usersByTime.get(time) ?? [];
			group.push(entry);
			usersByTime.set(time, group);
		}
		// Resume/refresh already built these messages; never construct another replay (#423).
		for (const message of runtime.agent.state.messages) {
			if (message.role !== "user") continue;
			const bound = engineCodexUserTurn(message);
			if (bound) {
				available.add(bound);
				continue;
			}
			const text = extractUserText(message);
			const entry = usersByTime.get(message.timestamp)?.find((candidate) => {
				if (candidate.kind !== "message" || available.has(candidate.turnId)) return false;
				const original = extractTurnText(candidate.payload);
				return text === original;
			});
			if (entry) {
				setEngineCodexUserTurn(message, entry.turnId);
				available.add(entry.turnId);
			}
		}
		// The admitted user is appended to Pi after commitMemoryTurn; message_end binds it (#423).
		if (state.activeUserTurnId) available.add(state.activeUserTurnId);
		const updates = codexEffortUpdates(
			generation,
			initialEffort,
			available,
			(entry) => entry.effectiveEffort ?? effortFor(entry.thinkingLevel),
		);
		const configuration: CodexConfiguration = { initialEffort, updates };
		setEngineCodexConfiguration(runtime.agent, configuration);
		shared.thinkingUsesConfigurationUpdate = updates.at(-1)?.position === state.activeUserTurnId;
	};

	const { contextFold, refreshAgentMessagesFromSession, runAutoCompact, runStepCheckpoint } =
		createTurnContextCompaction(shared);

	const { bindMemoryScope, installMemoryRestoration, memoryTurnMethods, notifyMemoryCommit } =
		createTurnContextMemory(shared);

	const resolveProviderReplay = async (
		runtime: AgentRuntime,
		reason: string,
		pendingUserText?: string,
		pendingIsOperator = true,
	): Promise<void> => {
		const origin = deps.session?.current()?.id;
		const navigation = shared.navigationEpoch;
		const signal = deps.turnSignal?.();
		const active = activeEntries();
		const checkpoint = findLastEntry(active, (entry) => entry.kind === "compactionSummary");
		if (checkpoint?.kind !== "compactionSummary" || !checkpoint.providerCheckpoint) {
			refreshAgentMessagesFromSession(runtime);
			return;
		}
		if (!providerFallbackDigests(active).has(checkpoint.providerCheckpoint.digest)) {
			let changed = false;
			let resolutionReason = reason;
			try {
				changed = await runAutoCompact(
					runtime,
					true,
					undefined,
					"force",
					pendingUserText,
					undefined,
					signal,
					undefined,
					pendingIsOperator,
					reason,
				);
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
				resolutionReason = `${reason}:portable-summary-failed`;
				deps.emitNotice("Portable compaction failed; continuing from the original session history.");
			}
			if (signal?.aborted || origin !== deps.session?.current()?.id || navigation !== shared.navigationEpoch)
				throw new DOMException("Replay ownership changed", "AbortError");
			if (!changed) {
				deps.session?.appendEntry({
					kind: "custom",
					parentTurnId: state.lastTurnId,
					customType: "pancode_provider_fallback",
					data: {
						version: 1,
						checkpointDigest: checkpoint.providerCheckpoint.digest,
						providerFallbackReason: resolutionReason,
					},
				});
				deps.session?.flushAppends?.();
			}
		}
		refreshAgentMessagesFromSession(runtime);
	};
	const promptMethods = createTurnContextPrompt(shared);

	const controller: TurnContext = {
		thinkingUsesConfigurationUpdate: () => shared.thinkingUsesConfigurationUpdate,
		notifyMemoryCommit,
		installMemoryRestoration,
		prepareMemoryTurn: memoryTurnMethods.prepareMemoryTurn,

		syncRouteConfiguration: syncCodexConfiguration,

		commitMemoryTurn: memoryTurnMethods.commitMemoryTurn,

		captureRuntimeContextSnapshot,
		persistContextSnapshot,
		liveContextEstimate: fitting.liveContextEstimate,

		refreshLiveBudget: budgeting.refreshLiveBudget,
		takeOverflowInputPin(): void {
			shared.overflowInputPin = null;
		},
		overflowFitTokens: fitting.overflowFitTokens,
		anchoredInputTokens: fitting.anchoredInputTokens,
		contextFloorRefusal: (runtime: AgentRuntime, pendingUserText?: string) =>
			contextFloorRefusal(runtime, fitting.fixedRequestTokens(runtime, pendingUserText)),
		oversizedResult: (runtime: AgentRuntime, pendingUserText?: string) =>
			fitting.overflowOversize(runtime, pendingUserText)?.largest || null,
		refreshAgentMessagesFromSession,
		runAutoCompact,
		runStepCheckpoint,
		lastCompactionWasNoGain: () => shared.lastCompactionNoGain,
		lastCompactionCardSettled: () => shared.lastCompactionCardSettled,
		navigationRevision: () => shared.navigationEpoch,
		cancelCompaction: () => shared.compactionController?.abort(),

		liveBudget: (): LiveBudgetView => budgetProducer.current() ?? budgeting.refreshLiveBudget(),
		inspectLiveBudget(): BudgetInspection {
			const targetId = deps.getSettings().chat?.target;
			const target = !state.runtime && targetId ? deps.providers.getTarget(targetId) : null;
			const runtime =
				state.runtime?.runtimeResolution.runtime ?? (target ? deps.providers.getRuntime(target.runtime) : null);
			if (runtime && (!isOrchestratorEligibleRuntime(runtime) || runtime.externalAgentLoop))
				return {
					status: "unsupported",
					reason: "The external agent owns its context; native request accounting is unavailable.",
				};
			if (!runtime)
				return {
					status: "unavailable",
					reason: "No native runtime descriptor is resolved. Inspection does not initialize a runtime.",
				};
			const live = state.runtime;
			return {
				status: "available",
				capability: "native",
				view: budgeting.refreshLiveBudget(),
				...(live
					? {
							outputReserveAt: (tokens: number) => resolveFitOutputReserve(live, tokens),
							priceAt: (tokens: number) => {
								const ratio = anchors.routeTokenRatio(live);
								return ratio === 1 ? tokens : Math.ceil(tokens * ratio);
							},
							// The checks the fold's `livePrefix` port runs before rebuilding the transcript (MD9).
							livePrefixSummary: () =>
								routing.summaryOnChatRoute(live, deps.getSettings().context.compaction?.model) &&
								inPrefixRequestRefusal(
									live.agent.state.model,
									state.lastMainRequest?.runtime === live ? state.lastMainRequest.record : undefined,
									{ free: live.runtimeResolution.pricedBy === "free" },
								) === null,
						}
					: {}),
				...(shared.sessionPrompt
					? {
							promptSections: shared.sessionPrompt.sections.map((section) => ({
								id: section.id,
								tokenEstimate: section.tokenEstimate,
							})),
						}
					: {}),
			};
		},

		setCurrentSnapshot: anchors.methods.setCurrentSnapshot,

		flushReconciledSnapshot: anchors.methods.flushReconciledSnapshot,

		reconcileUsage: anchors.methods.reconcileUsage,

		promptSideTokens(): number {
			return shared.currentContextSnapshot ? snapshotInputTokens(shared.currentContextSnapshot) : 0;
		},

		sessionPromptPending: promptMethods.sessionPromptPending,

		ensureSessionPrompt: promptMethods.ensureSessionPrompt,

		commitSessionPosture: promptMethods.commitSessionPosture,

		logPromptCompileIfPending: promptMethods.logPromptCompileIfPending,

		compiledSessionPrompt: () => shared.sessionPrompt,
		promptCompileRecord: () => shared.latestPromptCompile,
		sessionPromptDelta(): string {
			return shared.sessionPromptDelta;
		},

		invalidateSessionPromptCache(): void {
			// #423: retain the known key for the dry comparison while forcing a fresh compile.
			shared.sessionPromptInvalidated = true;
		},

		addWorkingContextPaths(paths: ReadonlyArray<string>): void {
			for (const path of paths) sessionWorkingContextPaths.add(path);
		},

		activeTurnCommitted(): boolean {
			const turnId = state.activeUserTurnId;
			if (!turnId) return false;
			return (deps.readSessionEntries?.() ?? []).some(
				(entry) => entry.kind === "message" && entry.role === "user" && entry.turnId === turnId,
			);
		},

		pinnedContextDelta: pinnedDelta,

		appendPinnedContext(agentRuntime): boolean {
			const delta = pinnedDelta(agentRuntime);
			if (delta.length === 0) return false;
			// A context-only tail, like a deferred reminder: the cached prefix keeps its bytes (#423).
			const message: AgentMessage = { role: "user", content: systemReminderBlock(delta), timestamp: Date.now() };
			if (deps.hostInserts) deps.hostInserts.insert(agentRuntime, "pinned", [message]);
			else agentRuntime.agent.state.messages.push(message);
			return true;
		},

		async postToolContinuationGuard(
			agentRuntime: AgentRuntime,
			signal?: AbortSignal,
			contextChanged = false,
			settledTail?: () => void,
		) {
			if (signal?.aborted || (!contextChanged && !toolResultTail(agentRuntime))) {
				settledTail?.();
				return undefined;
			}
			// A host tail appended before this guard is a durable insert: a compaction
			// that rebuilds the messages re-issues it after the checkpoint when the
			// cut took its anchor, so the rebuild itself carries it.
			// The tool batch appended results the last publication predates, and the
			// guard is about to decide on them. Publish before that inspection, not
			// after it, from the same history observation and estimate it decides on.
			let history: MessageListDigests | undefined;
			let knownWindow = false;
			let mustFit = false;
			let compacted = false;
			// Eviction rebuilds the messages before the summary call, so a failed summary can still leave them changed.
			const messagesBefore = agentRuntime.agent.state.messages;
			// Until a compaction attempt yields, nothing touches the messages, so the checks read `history` instead of
			// walking every message again; a check after an attempt starts observes afresh (SC-6).
			let attemptStarted = false;
			const settled = (): MessageListDigests | undefined => (attemptStarted ? undefined : history);
			// The A4 count (overflowFitTokens) decides whether the request fits; the fit line's reserve is A5's, read at that count.
			const a4Fits = (view: LiveBudgetView): boolean => {
				const input = fitting.overflowFitTokens(agentRuntime, undefined, view.inputTokens ?? 0, settled());
				const reserve = view.outputReserveTokens === null ? null : resolveFitOutputReserve(agentRuntime, input);
				return requestFits(input, reserve, view.effectiveWindow);
			};
			// The view's figures, or with a measured anchor the anchored count admission sends on (bt3 drv-rv5).
			const fitFigures = (view: LiveBudgetView): { input: number | null; reserve: number | null } => {
				const anchored = fitting.anchoredInputTokens(agentRuntime, settled());
				if (anchored === null) return { input: view.inputTokens, reserve: view.outputReserveTokens };
				const reserve = view.outputReserveTokens === null ? null : resolveFitOutputReserve(agentRuntime, anchored);
				return { input: anchored, reserve };
			};
			const viewFits = (view: LiveBudgetView): boolean => {
				const { input, reserve } = fitFigures(view);
				return requestFits(input, reserve, view.effectiveWindow);
			};
			const compact = async (requireFit: boolean): Promise<void> => {
				attemptStarted = true;
				try {
					const done = await runAutoCompact(
						agentRuntime,
						requireFit,
						undefined,
						requireFit ? "overflow" : "auto",
						undefined,
						undefined,
						signal,
					);
					compacted = compacted || done;
				} catch (err) {
					const reason = err instanceof Error ? err.message : String(err);
					const aborted = signal?.aborted || (err instanceof Error && err.name === "AbortError");
					const oversize = requireFit && !aborted ? fitting.overflowStop(agentRuntime) : null;
					// One tool result is what overflows: finish() bounds it, or stops naming it when no cut fits.
					if (oversize !== null) return;
					if (requireFit || aborted) {
						const stop = `[PanCode] post-tool context guard could not compact before continuation: ${reason}`;
						// The request needs a fit it cannot get: the harness's stop, not the route's (FX-22c). A cancel stays a plain error.
						throw aborted ? new Error(stop) : oversizedResultStop(stop);
					}
					// Optional compaction: the request still fits, so the run goes on and the fit check below stays the stop.
					deps.emitNotice(
						`[PanCode] automatic compaction failed: ${reason.replace(/[.\s]+$/u, "")}. This turn goes on without it.`,
					);
				}
			};
			// The mid-run settled tool-batch boundary: whatever the guard did or
			// declined to do, this is the context the continuation will send. The
			// caller's settled tail (the memory install) runs last, in the same
			// stretch as this view's publication, so it reads that walk (SC-6).
			const finish = (afterView: LiveBudgetView): ReturnType<typeof continuationContextUpdate> | undefined => {
				let view = afterView;
				// Compaction is spent and the latest batch is what overflows: bound it rather than end the turn, on every surface.
				const overflowing = (mustFit && fitting.overflowStop(agentRuntime) !== null) || (knownWindow && !viewFits(view));
				const bound = overflowing ? fitting.boundBatchToFit(agentRuntime) : null;
				if (bound?.kind === "short") throw oversizedResultStop(bound.stop);
				if (bound?.kind === "fit") {
					attemptStarted = true;
					view = budgeting.refreshLiveBudget();
				}
				const oversize = mustFit ? fitting.overflowStop(agentRuntime) : null;
				if (oversize !== null) throw oversizedResultStop(oversize);
				const after = fitFigures(view);
				if (knownWindow && !requestFits(after.input, after.reserve, view.effectiveWindow)) {
					// The guard's own stop, like the oversized-result one: the harness cause, not a route failure (CLI-3).
					// Compaction already ran, so the remedy names what it cannot shrink, in terms every surface accepts.
					throw oversizedResultStop(
						`[PanCode] post-tool context guard stopped continuation before provider call: estimated input ${after.input} plus reserved output ${after.reserve} tokens does not fit context window ${view.effectiveWindow}. ${turnAdmissionRemedy(agentRuntime, after.input ?? 0)} Ask for narrower reads or smaller tool output in a follow-up turn.`,
					);
				}
				const update =
					compacted || agentRuntime.agent.state.messages !== messagesBefore
						? continuationContextUpdate(agentRuntime)
						: undefined;
				settledTail?.();
				return update;
			};
			// One settled stretch from the first observation to the decision; without an attempt the guard never yields or
			// touches the messages, so the first publication already describes the context and the tail runs in it too.
			const decision = withSettledHistory(() => {
				history = observeHistory(agentRuntime);
				const before = fitting.liveContextEstimate(agentRuntime, undefined, undefined, history);
				const beforeView =
					agentRuntime === state.runtime
						? budgeting.refreshLiveBudget(undefined, history, before)
						: budgeting.refreshLiveBudget();
				knownWindow = before.contextWindow > 0;
				const verdict = routing.routeCompaction(agentRuntime, deps.getSettings()).shouldCompact(before.tokens);
				// An automatic pass the trigger asks for runs first (A5); the A4 count then decides the overflow pass.
				mustFit = knownWindow && (!viewFits(beforeView) || (!verdict.shouldCompact && !a4Fits(beforeView)));
				// S0 commits under the trigger on an uncached route, so the guard asks there too (SPEC §3.4).
				const attempted = mustFit || verdict.shouldCompact || supersededStageApplies(agentRuntime.runtimeResolution);
				return attempted ? { attempted: true as const } : { attempted: false as const, update: finish(beforeView) };
			});
			if (!decision.attempted) return decision.update;
			await compact(mustFit);
			if (!mustFit && knownWindow && !a4Fits(budgeting.refreshLiveBudget())) {
				mustFit = true;
				await compact(true);
			}
			return withSettledHistory(() => finish(budgeting.refreshLiveBudget()));
		},

		contextUsage(): LiveContextUsage {
			// Footer reads project the last publication. They never rescan the
			// ledger or add streaming output to the next-request message estimate.
			const view = budgetProducer.current() ?? budgeting.refreshLiveBudget();
			// Occupancy includes the active response. Admission still reads the
			// published next-request input, so generated output is not charged a
			// second time when it becomes settled history.
			const tokens =
				view.inputTokens === null ? null : view.inputTokens + (state.streaming ? liveStreamingOutputTokens() : 0);
			const window = routing.routeSuperseded(view.targetId, view.modelId)
				? routing.windowWithoutRuntime().contextWindow
				: view.effectiveWindow;
			return {
				...contextUsageSnapshot(tokens, window, view.breakdown ?? undefined),
				revision: view.revision,
				inputSource: view.inputSource,
				historical: view.historical,
				breakdownSource: view.breakdownSource,
			};
		},

		contextLedger(): ContextLedger {
			const settings = deps.getSettings();
			// Without a runtime (before the first turn of this process, /resume
			// included) the window comes from the live resolution or the resumed
			// snapshot, and the token facts from the snapshot: the resumed
			// messages are the ones it measured.
			const routed =
				state.runtime && !routing.routeSuperseded(state.runtime.targetId, state.runtime.wireModelId) ? state.runtime : null;
			const window = routed
				? {
						contextWindow: routed.runtimeResolution.contextWindowDetails.effectiveContextWindow,
						contextWindowSource: routed.runtimeResolution.contextWindowDetails.contextWindowSource,
						contextWindowSlots: routed.runtimeResolution.contextWindowDetails.contextWindowSlots,
					}
				: routing.windowWithoutRuntime();
			const compactionThreshold = window.contextWindow > 0 ? (settings.context.compaction?.threshold ?? null) : null;
			const compactionAuto = settings.context.compaction?.auto !== false;
			const route = routed
				? routing.routeCompaction(routed, settings)
				: window.contextWindow > 0
					? routing.previewCompactionRoute(window.contextWindow, settings)
					: null;
			const economic =
				route?.economic ??
				compactionBudget(
					window.contextWindow,
					compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
					settings.context.compaction.maxTokens,
					getCatalogModelForRuntime(
						(state.runtime ? undefined : shared.currentContextSnapshot?.runtimeId) ??
							settings.targets.find((target) => target.id === settings.chat.target)?.runtime ??
							"",
						settings.chat.model ?? "",
					),
				);
			const compactionCeilingTokens = economic.ceilingTokens;
			// The trigger counts the reserve the threshold's headroom does not cover, so the
			// ledger names the fraction it actually fires at (F-C2).
			const ledgerThreshold =
				compactionThreshold === null
					? null
					: route
						? effectiveCompactionThreshold(
								economic.threshold,
								economic.triggerWindow,
								route.triggerReserve(economic.threshold * economic.triggerWindow),
							)
						: economic.threshold;
			const provider = routed?.targetId ?? settings.chat?.target ?? null;
			const model = routed?.wireModelId ?? settings.chat?.model ?? null;
			const liveToolCount = state.runtime?.agent.state.tools.length ?? 0;
			// The total is the published view's, the figure the footer and admission read; the capture only splits it.
			const view = budgetProducer.current() ?? budgeting.refreshLiveBudget();
			const streamingOutput = liveStreamingOutputTokens();
			// Settled output is already history in the view, so only a response in flight is added, as the footer does.
			const totalUsed = view.inputTokens === null ? 0 : view.inputTokens + (state.streaming ? streamingOutput : 0);
			const measured = view.historical
				? shared.currentContextSnapshot?.sources.total === "reconciled"
				: view.anchoredInputTokens !== null;

			if (!shared.currentContextSnapshot) {
				return buildContextLedger({
					provider,
					model,
					...window,
					toolCount: liveToolCount,
					compactionThreshold: ledgerThreshold,
					compactionCeilingTokens,
					compactionAuto,
					streamingTokens: streamingOutput,
					liveTotalTokens: totalUsed > 0 ? totalUsed : null,
					measured,
					lastCompaction: shared.lastCompactionEvent,
					promptCache: shared.lastPromptCache,
					prewarm: shared.lastPrewarm,
				});
			}

			const pendingTokens = pendingUserInputTokens();
			// An unreconciled capture (the one a compaction publishes) is a raw chars/4 split, while the view prices
			// the same request at the route's token ratio. The view's total wins, so the split scales to it rather
			// than outvoting it with a larger figure than the compaction reported.
			const split =
				view.historical || view.inputTokens === null || shared.currentContextSnapshot.sources.total === "reconciled"
					? shared.currentContextSnapshot.categories
					: splitWithin(shared.currentContextSnapshot.categories, Math.max(0, view.inputTokens - pendingTokens));

			return buildContextLedger({
				provider,
				model,
				...window,
				compactionThreshold: ledgerThreshold,
				compactionCeilingTokens,
				compactionAuto,
				systemPromptTokens: split.system,
				toolSchemaTokens: split.tools,
				// Persisted snapshots strip the captured schemas; fall back to
				// the live agent state after a session resume.
				toolCount: shared.currentContextSnapshot.activeToolSchemas?.length ?? liveToolCount,
				messageTokens: split.messages,
				toolResultTokens: split.toolResults ?? 0,
				agentsTokens: split.agents,
				skillsTokens: split.skills,
				memoryTokens: split.memory,
				projectTokens: split.project,
				projectPreload: shared.sessionPrompt?.projectPreload?.label ?? null,
				projectHandbookFiles: shared.sessionPrompt?.projectHandbookFiles ?? null,
				// A session switch keeps the outgoing prompt object until the next compile; only the hash is cleared.
				priorSessionFact: shared.sessionPromptHash === null ? null : (shared.sessionPrompt?.priorSessionFact ?? null),
				pendingTokens,
				streamingTokens: streamingOutput,
				liveTotalTokens: totalUsed > 0 ? totalUsed : null,
				measured,
				lastCompaction: shared.lastCompactionEvent,
				promptCache: shared.lastPromptCache,
				prewarm: shared.lastPrewarm,
			});
		},

		noteColdReason: cache.noteColdReason,

		consumeExpectedColdReasons: cache.methods.consumeExpectedColdReasons,

		takeCallColdReasons: cache.methods.takeCallColdReasons,

		cacheGeneration: cache.methods.cacheGeneration,

		noteCacheRequestToolChoice: cache.methods.noteCacheRequestToolChoice,

		noteCacheRequestSystemPrompt: cache.methods.noteCacheRequestSystemPrompt,

		promptCachePayloadForAssistant: cache.methods.promptCachePayloadForAssistant,

		notePrewarm: cache.methods.notePrewarm,

		noteRunCacheSummary: cache.methods.noteRunCacheSummary,

		resetForSession(incomingBranchAnchorTurnId: string | null = null): void {
			shared.cacheCallBaseline = null;
			shared.cacheCallBaselineLoaded = false;
			shared.cacheGeneration += 1;
			if (state.runtime) setEngineCodexConfiguration(state.runtime.agent, undefined);
			shared.thinkingUsesConfigurationUpdate = false;
			shared.cacheRequestToolChoice = "auto";
			shared.sentToolChoice = undefined;
			shared.priorSentToolChoice = undefined;
			shared.nextChangedSection = undefined;
			shared.previousPromptSections = null;
			shared.postureGeneration = null;
			shared.postureGenerationPersisted = false;
			shared.pendingPosture = null;
			shared.memoryTurn = null;
			shared.memoryAuthorityEpoch += 1;
			shared.compactionController?.abort();
			// An in-process switch replaces the whole prefix: the backend's slot
			// still holds the outgoing session's prompt and history, so the first
			// turn on the incoming one is expected-cold on every tier, exactly as
			// a recompile is. The manifest can no longer say so on its own once
			// provenance follows the session, because the incoming session's last
			// recorded hash usually equals its fresh compile, so the stamp comes
			// from here. Only when this process had actually applied a prompt:
			// before the first compile there is nothing in the slot to have lost.
			if (shared.sessionPromptHash !== null) cache.noteColdReason("prompt_recompiled");
			shared.frozenMemorySection = null;
			shared.frozenRouteSources = undefined;
			shared.frozenRouteIdentity = "";
			shared.frozenMemorySessionId = "";
			shared.sessionPromptDelta = "";
			shared.lastPromptCache = null;
			shared.lastPrewarm = null;
			shared.lastSystemPromptReused = false;
			shared.sessionPromptHash = null;
			shared.sessionPromptKey = null;
			shared.sessionPromptInvalidated = false;
			shared.resumedPromptHashRead = false;
			shared.resumedPromptHash = null;
			sessionWorkingContextPaths.clear();
			shared.pendingPromptLogEntry = null;
			shared.pendingPromptLogMemory = null;
			shared.memoryRestoredSessionId = null;
			shared.cacheRequestSystemPromptHash = undefined;
			shared.sentSystemPrompt = undefined;
			shared.priorSentSystemPrompt = undefined;
			shared.latestPromptCompile = null;
			shared.emptyAutoCompactContextKey = null;
			shared.autoCompactFailures = 0;
			shared.summaryRearm = null;
			shared.summaryRearmSeededFor = null;
			shared.noGainSummaryDigest = null;
			shared.noUsefulCutBasisKey = null;
			contextFold.resetAutoHold();
			shared.reconciledAnchor = null;
			shared.rehydrationMiss = null;
			// The last reduction /context and ACP name is the one on the path now current, not the branch left.
			shared.lastCompactionEvent = compactionEventOnPath(activeEntries());
			// Real branch navigation. The epoch separates two visits to the same
			// leaf id, so an advisory announced on the branch this session left is
			// re-armed rather than treated as already said.
			shared.branchAnchorTurnId = incomingBranchAnchorTurnId;
			shared.navigationEpoch += 1;
			bindMemoryScope();
			budgetProducer.reset();
			const session = deps.session?.current();
			const snapshots = session ? readSessionContextSnapshots(pancodeStateDir(), session.id) : [];
			const persisted = snapshots.at(-1) ?? null;
			// The figure the session was last measured at, so the journal can set the resumed projection beside it: the
			// newest reconciled snapshot, since a submit cancelled before usage leaves an estimated one after it.
			let measured: (typeof snapshots)[number] | undefined;
			for (let index = snapshots.length - 1; index >= 0 && measured === undefined; index -= 1) {
				const snapshot = snapshots[index];
				if (snapshot?.sources.total === "reconciled" && snapshot.reconciledTokens !== undefined) measured = snapshot;
			}
			shared.resumedBudget = session
				? {
						sessionId: session.id,
						priorTokens:
							measured?.reconciledTokens !== undefined ? measured.reconciledTokens + measured.categories.streaming : null,
					}
				: null;
			// The session's latest capture may describe the branch just left; a runtime captures the history now in place.
			shared.currentContextSnapshot = state.runtime
				? captureRuntimeContextSnapshot(
						state.runtime,
						incomingBranchAnchorTurnId ?? "session",
						deps.getSettings().context.compaction?.threshold ?? null,
					)
				: persisted;
		},

		journalResumedBudget(view: LiveBudgetView): void {
			const resumed = shared.resumedBudget;
			shared.resumedBudget = null;
			if (!resumed || view.historical || view.inputTokens === null) return;
			if (deps.session?.current()?.id !== resumed.sessionId) return;
			telemetryHub().emit(
				"context.resumed",
				{
					...(resumed.priorTokens !== null ? { priorTokens: tokenCount(resumed.priorTokens) } : {}),
					projectedTokens: tokenCount(view.inputTokens),
					...(view.estimatedInputTokens !== null ? { estimatedTokens: tokenCount(view.estimatedInputTokens) } : {}),
					inputSource: view.inputSource,
				},
				{ sessionId: resumed.sessionId, agent: mainAgent(resumed.sessionId) },
			);
		},

		dispose(): void {
			shared.disposed = true;
			shared.compactionController?.abort();
			for (const unsubscribe of cache.unsubscribeColdReasonSources) unsubscribe?.();
		},
	};
	return controller;
}
