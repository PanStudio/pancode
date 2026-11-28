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
	estimateEngineRequestTokens,
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
	type LiveBudgetInput,
	type LiveBudgetOutcomeProjection,
	type LiveBudgetView,
	resolveLiveBudgetPolicy,
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
	endpointDigest,
	estimateAgentContextBreakdown,
	estimateAgentMessageTokens,
	latestUsableAssistantUsage,
	reconcileSnapshot,
	rehydrationRecord,
	snapshotInputTokens,
	usageAnchoredTokens,
} from "../domains/session/context-accounting.js";
import { buildContextLedger, type ContextLedger, type PrewarmStats } from "../domains/session/context-ledger.js";
import type { SessionContract } from "../domains/session/contract.js";
import {
	type CompactionTrigger,
	type EvictionAnchor,
	HOST_INSERT_CUSTOM_TYPE,
	isHostInsertData,
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
import { extractUserText, toolSignatureFromState } from "./chat-loop-messages.js";
import { codexEffortGeneration, codexEffortUpdates } from "./codex-effort.js";
import type { HostInserts } from "./host-inserts.js";
import { continuityContextFromSession, renderModelReplay } from "./model-session-replay.js";
import { contextFloorRefusal, resolveFitOutputReserve, turnAdmissionRemedy } from "./output-reserve.js";
import { extractTurnText } from "./session-replay-messages.js";
import { createTurnContextCache } from "./turn-context/cache.js";
import {
	anchorModelKey,
	capturedBreakdown,
	carriedTokens,
	continuationContextUpdate,
	memoryOrigin,
	optionalProjection,
	sameRoute,
	snapshotWindowSource,
	toolResultTail,
} from "./turn-context/helpers.js";
import { createTurnContextRoute } from "./turn-context/route.js";
import { createTurnContextCompaction } from "./turn-context-compaction.js";
import { createTurnContextMemory } from "./turn-context-memory.js";
import { createTurnContextPrompt } from "./turn-context-prompt.js";
import { sha256Json, type TurnContextScope } from "./turn-context-scope.js";
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

/**
 * The token and route facts of one budget publication, separate from the
 * identity fields that name it. Split out so the live and pre-runtime paths
 * produce the same shape and the reduction basis can be keyed over it after it
 * is resolved rather than before.
 */
type LiveBudgetAccounting = Pick<
	LiveBudgetInput,
	| "targetId"
	| "runtimeId"
	| "modelId"
	| "modelApi"
	| "effectiveWindow"
	| "windowSource"
	| "estimatedInputTokens"
	| "anchoredInputTokens"
	| "inputTokens"
	| "inputSource"
	| "historical"
	| "breakdown"
	| "breakdownSource"
	| "outputReserveTokens"
>;

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

/** A tool result cut to fit keeps at least this much, so what the model reads still says what to ask for next. */
const BOUNDED_RESULT_MIN_CHARS = 2_048;
/** Room the cut leaves beyond the overflow for the note it inserts and estimate rounding. */
const BOUNDED_RESULT_SLACK_CHARS = 1_024;

/** What bounding the latest tool batch came to: it fits, there was nothing to cut, or even the cut floor overflows. */
/** What a compaction trigger reads of a route: a built runtime, or the route in settings before one is built. */
export type CompactionRouteView = Pick<AgentRuntime, "targetId" | "wireModelId" | "runtimeResolution"> & {
	agent: { state: { model: AgentRuntime["agent"]["state"]["model"] } };
};

type BoundBatchOutcome = { kind: "fit" } | { kind: "none" } | { kind: "short"; stop: string };

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
			return reconciledHistoryTokens;
		},
		get summaryOnChatRoute() {
			return routing.summaryOnChatRoute;
		},
		get routeCompaction() {
			return routing.routeCompaction;
		},
		get liveContextEstimate() {
			return liveContextEstimate;
		},
		get overflowFitTokens() {
			return overflowFitTokens;
		},
		get pinOverflowFit() {
			return pinOverflowFit;
		},
		get liveBudgetInput() {
			return liveBudgetInput;
		},
		get refreshLiveBudget() {
			return refreshLiveBudget;
		},
		get evictionAnchor() {
			return evictionAnchor;
		},
		get carryReconciledAnchorThroughProjection() {
			return carryReconciledAnchorThroughProjection;
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

	/**
	 * Seed the live anchor from the eviction record step 1 selects (ContextFold §4 step 3). The record's figure covers
	 * the history elements whose rows precede it; an element whose row was written later, such as an insert rendered
	 * ahead of it, is priced on top. The history has to be the path's render, byte for byte, or the figure describes
	 * another request and the estimate stays structural.
	 */
	const rehydrateAnchor = (agentRuntime: AgentRuntime, observed: MessageListDigests): boolean => {
		const stream = deps.readSessionEntries?.() ?? [];
		if (stream.length === 0) return false;
		const key = JSON.stringify([stream.length, state.lastTurnId, observed.digest(), anchorModelKey(agentRuntime)]);
		if (shared.rehydrationMiss?.key === key && shared.rehydrationMiss.runtime === agentRuntime) return false;
		shared.rehydrationMiss = { key, runtime: agentRuntime };
		const path = activePath(stream, state.lastTurnId ?? undefined);
		const record = rehydrationRecord(path);
		if (!record || !sameRoute(agentRuntime, record.anchor.route)) return false;
		const render = renderModelReplay(stream, {
			...(state.lastTurnId ? { activeLeafTurnId: state.lastTurnId } : {}),
			continuity: continuityContextFromSession(deps.session),
		});
		const rendered: AgentMessage[] = [];
		const sources: Array<string | null> = [];
		render.messages.forEach((message, index) => {
			if (message.role === "system" && !isHostPolicyMessage(message)) return;
			rendered.push(message);
			sources.push(render.sourceIds[index] ?? null);
		});
		if (rendered.length > observed.messages.length || observed.digest(rendered.length) !== sha256Json(rendered))
			return false;
		const position = new Map<string, number>();
		path.forEach((entry, index) => {
			position.set(entry.turnId, index);
			if (entry.kind === "custom" && entry.customType === HOST_INSERT_CUSTOM_TYPE && isHostInsertData(entry.data))
				position.set(entry.data.id, index);
		});
		const recordIndex = path.indexOf(record);
		// An element with no row of its own, such as a continuity block, is priced on top: the figure may not cover it.
		const written = sources.map((source) => (source === null ? Number.POSITIVE_INFINITY : (position.get(source) ?? -1)));
		let covered = written.length - 1;
		while (covered >= 0 && (written[covered] ?? 0) > recordIndex) covered -= 1;
		let tokens = record.anchor.tokens;
		for (let index = 0; index < covered; index += 1)
			if ((written[index] ?? 0) > recordIndex) tokens += observed.messageTokens[index] ?? 0;
		shared.rehydrationMiss = null;
		shared.reconciledAnchor = {
			tokens,
			anchoredMessages: observed.messages.slice(0, covered + 1),
			contentDigest: observed.digest(covered + 1),
			runtime: agentRuntime,
			model: agentRuntime.agent.state.model,
			modelKey: anchorModelKey(agentRuntime),
			targetId: agentRuntime.targetId,
			runtimeId: agentRuntime.runtimeId,
			wireModelId: agentRuntime.wireModelId,
			systemPromptTokens: record.anchor.sys,
			toolSchemaTokens: record.anchor.tools,
			measured: false,
		};
		return true;
	};

	/**
	 * At a commit with no live anchor, the usage the fallback rehydrated from the replayed history becomes the live
	 * anchor, so the carry has a figure to subtract the saving from; the eviction then invalidates that usage. The
	 * figure is the fallback's own: the usage, its system and tools as they stand, and the elements after it priced.
	 */
	const seedAnchorFromUsage = (agentRuntime: AgentRuntime, observed: MessageListDigests): void => {
		const usage = latestUsableAssistantUsage(observed.messages);
		if (!usage) return;
		const breakdown = estimateAgentContextBreakdown({
			systemPrompt: engineInitialSystemPrompt(agentRuntime.agent),
			messages: [],
			tools: agentRuntime.agent.state.tools,
		});
		shared.reconciledAnchor = {
			tokens: usage.tokens,
			anchoredMessages: observed.messages.slice(0, usage.index + 1),
			contentDigest: observed.digest(usage.index + 1),
			runtime: agentRuntime,
			model: agentRuntime.agent.state.model,
			modelKey: anchorModelKey(agentRuntime),
			targetId: agentRuntime.targetId,
			runtimeId: agentRuntime.runtimeId,
			wireModelId: agentRuntime.wireModelId,
			systemPromptTokens: breakdown.systemPromptTokens,
			toolSchemaTokens: breakdown.toolSchemaTokens,
			// Seeded only for the carry that follows, from a usage whose route this does not check.
			measured: false,
		};
	};

	/**
	 * Price appended history separately so eviction can retain it without folding in static growth twice. With no
	 * live anchor, an anchored eviction record on the path seeds one; `commit` also seeds one from a replayed usage.
	 * Elements past the anchor are priced by `messageTokens`, the basis for content no count has measured.
	 */
	const reconciledHistoryTokens = (
		agentRuntime: AgentRuntime,
		history?: MessageListDigests,
		commit = false,
	): number | null => {
		const observed = history ?? observeHistory(agentRuntime);
		if (!shared.reconciledAnchor && !rehydrateAnchor(agentRuntime, observed) && commit)
			seedAnchorFromUsage(agentRuntime, observed);
		const anchor = shared.reconciledAnchor;
		if (!anchor) return null;
		const messages = observed.messages;
		// The identity, route, and length checks are cheap and run first; `||`
		// short-circuits, so the content digest is only computed for a prefix that
		// still looks like the attested one. The digest covers the attested prefix
		// and never the tail, so an append does not invalidate the anchor. The
		// history fold caches each message's bytes and trusts them while the
		// message's identity and key/leaf trace match, so an in-place edit still
		// re-folds from the first changed message.
		if (
			anchor.runtime !== agentRuntime ||
			anchor.model !== agentRuntime.agent.state.model ||
			anchor.modelKey !== anchorModelKey(agentRuntime) ||
			anchor.targetId !== agentRuntime.targetId ||
			anchor.runtimeId !== agentRuntime.runtimeId ||
			anchor.wireModelId !== agentRuntime.wireModelId ||
			anchor.anchoredMessages.length > messages.length ||
			anchor.anchoredMessages.some((message, index) => message !== messages[index]) ||
			observed.digest(anchor.anchoredMessages.length) !== anchor.contentDigest
		) {
			shared.reconciledAnchor = null;
			return null;
		}
		let tail = 0;
		for (let i = anchor.anchoredMessages.length; i < messages.length; i += 1) tail += observed.messageTokens[i] ?? 0;
		return anchor.tokens + tail;
	};

	const liveContextEstimate = (
		agentRuntime: AgentRuntime,
		pendingUserText?: string,
		replayMessages?: ReadonlyArray<AgentMessage>,
		history?: MessageListDigests,
	): LiveContextEstimate => {
		const contextWindow = agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow;
		const observed = replayMessages === undefined ? (history ?? observeHistory(agentRuntime)) : undefined;
		const estimateInput = {
			systemPrompt: engineInitialSystemPrompt(agentRuntime.agent),
			messages:
				observed?.messages ??
				(replayMessages ?? []).filter((message) => message.role !== "system" || isHostPolicyMessage(message)),
			...(observed ? { messageTokens: observed.messageTokens } : {}),
			tools: agentRuntime.agent.state.tools,
			...(pendingUserText !== undefined ? { pendingUserText, pendingUserImages: shared.pendingUserImages } : {}),
		};
		const breakdown = estimateAgentContextBreakdown(estimateInput);
		const policyText = pendingUserText === undefined ? null : pendingPolicyText();
		const pendingPolicyTokens =
			policyText === null ? 0 : estimateAgentMessageTokens({ role: "system", content: policyText });
		breakdown.pendingUserTokens += pendingPolicyTokens;
		const historyTokens = observed ? reconciledHistoryTokens(agentRuntime, observed) : null;
		const anchor = shared.reconciledAnchor;
		// Provider usage already includes the old system prompt and schemas.
		// Price only positive growth, separately: shrinking one must not hide
		// growth in the other when the measured prompt exceeds chars/4.
		const reconciledTokens =
			historyTokens !== null && anchor
				? historyTokens +
					breakdown.pendingUserTokens +
					Math.max(0, breakdown.systemPromptTokens - anchor.systemPromptTokens) +
					Math.max(0, breakdown.toolSchemaTokens - anchor.toolSchemaTokens)
				: null;
		// The structural projection (pending policy included) and, with no live anchor (a resume, or an anchor a
		// rewrite dropped), the newest usable usage plus the delta since that call, each walked once.
		const projection =
			breakdown.systemPromptTokens + breakdown.messageTokens + breakdown.pendingUserTokens + breakdown.toolSchemaTokens;
		const usageFloor = reconciledTokens === null ? usageAnchoredTokens(estimateInput, breakdown) : null;
		const estimatedTokens = usageFloor === null ? projection : Math.max(projection, usageFloor);
		const ratio = routeTokenRatio(agentRuntime, observed);
		const priced = (tokens: number): number => (ratio === 1 ? tokens : Math.ceil(tokens * ratio));
		// The usage floor is already a provider count, so only the chars/4 projection takes the ratio (FX-31).
		return {
			// The estimate is a floor, not a competing verdict: it prices material
			// the attested call never saw, so a provider count below it would be
			// answering about a smaller conversation. It is priced at the route's
			// measured chars per token when the route has one, else at chars/4.
			tokens:
				usageFloor === null
					? Math.max(priced(estimatedTokens), reconciledTokens ?? 0)
					: Math.max(priced(projection), usageFloor),
			estimatedTokens,
			reconciledTokens,
			contextWindow,
			breakdown,
		};
	};

	/**
	 * The provider-measured anchor of this route under `observed`, or null. The live anchor counts when
	 * `reconciledHistoryTokens` (route, prefix identity and digest) kept it and a call measured it: a figure carried
	 * through an eviction or rehydrated from its record priced its tail at chars/4 and does not count (bt-47 D-A).
	 * With no live anchor, as on a resumed session, the newest usable usage counts when the same model, provider,
	 * API and endpoint reported it; an eviction or masking since stamped it unusable.
	 */
	const measuredAnchor = (
		agentRuntime: AgentRuntime,
		observed: MessageListDigests,
	): { tokens: number; covered: number; systemPromptTokens: number; toolSchemaTokens: number } | null => {
		if (reconciledHistoryTokens(agentRuntime, observed) !== null) {
			const anchor = shared.reconciledAnchor;
			return anchor?.measured
				? {
						tokens: anchor.tokens,
						covered: anchor.anchoredMessages.length,
						systemPromptTokens: anchor.systemPromptTokens,
						toolSchemaTokens: anchor.toolSchemaTokens,
					}
				: null;
		}
		if (shared.reconciledAnchor) return null;
		const usage = latestUsableAssistantUsage(observed.messages);
		const message = usage
			? (observed.messages[usage.index] as { api?: unknown; provider?: unknown; model?: unknown; baseUrlDigest?: unknown })
			: null;
		const model = agentRuntime.agent.state.model;
		if (!usage || !message || !model) return null;
		if (message.api !== model.api || message.provider !== model.provider || message.model !== model.id) return null;
		// A reply recorded with its endpoint counts only on that endpoint; one recorded before the stamp keeps the old rule.
		if (message.baseUrlDigest !== undefined && message.baseUrlDigest !== endpointDigest(model.baseUrl)) return null;
		// The usage already covers the system prompt and tools it was sent with; with no record of their size then, none counts as growth.
		const statics = estimateAgentContextBreakdown({
			systemPrompt: engineInitialSystemPrompt(agentRuntime.agent),
			messages: [],
			tools: agentRuntime.agent.state.tools,
		});
		return {
			tokens: usage.tokens,
			covered: usage.index + 1,
			systemPromptTokens: statics.systemPromptTokens,
			toolSchemaTokens: statics.toolSchemaTokens,
		};
	};

	/**
	 * The route's tokens per chars/4 token (CTX-1), or 1 where it has no measurement. The provider-measured anchor
	 * `measuredAnchor` admits, live or a resumed reply's usage, sets it: its count over the chars/4 figure of the
	 * request it measured. A held ratio prices the context after a compaction or eviction dropped that anchor, on the
	 * same route only. A ratio outside 0.5 to 2 (8 to 2 characters a token) is a count of something chars/4 never
	 * saw, such as server-side state, not a tokenizer, and leaves chars/4 in place. Without `observed` (a replay
	 * estimate) only the held ratio applies.
	 */
	const routeTokenRatio = (agentRuntime: AgentRuntime, observed?: MessageListDigests): number => {
		const key = JSON.stringify([
			agentRuntime.targetId,
			agentRuntime.runtimeId,
			agentRuntime.wireModelId,
			anchorModelKey(agentRuntime),
		]);
		const anchor = observed ? measuredAnchor(agentRuntime, observed) : null;
		if (observed && anchor) {
			let estimate = anchor.systemPromptTokens + anchor.toolSchemaTokens;
			for (let index = 0; index < anchor.covered; index += 1) estimate += observed.messageTokens[index] ?? 0;
			const ratio = estimate > 0 ? anchor.tokens / estimate : 0;
			shared.routeCalibration = ratio >= 0.5 && ratio <= 2 ? { key, ratio } : null;
		}
		return shared.routeCalibration?.key === key ? shared.routeCalibration.ratio : 1;
	};

	/**
	 * The request priced at this route's measured anchor (bt3 drv-rv5): the anchor, the messages after it and the
	 * pending ask with its policy text each at max(fold estimate, Pi's chars/3.5), and positive growth of the system
	 * prompt and tool schemas, as the reconciled count prices it. Null without a measured anchor.
	 */
	const anchoredFitCount = (
		agentRuntime: AgentRuntime,
		observed: MessageListDigests,
		live: LiveContextEstimate,
		pending: ReadonlyArray<AgentMessage>,
	): number | null => {
		const anchor = measuredAnchor(agentRuntime, observed);
		if (!anchor) return null;
		let foldTail = 0;
		for (let index = anchor.covered; index < observed.messages.length; index += 1)
			foldTail += observed.messageTokens[index] ?? 0;
		// Pi's count of the bare system message and tools, subtracted so only the messages are priced.
		const statics = estimateEngineRequestTokens(agentRuntime.agent, []);
		const piTail = estimateEngineRequestTokens(agentRuntime.agent, observed.messages.slice(anchor.covered)) - statics;
		const piPending = estimateEngineRequestTokens(agentRuntime.agent, pending) - statics;
		const { breakdown } = live;
		return (
			anchor.tokens +
			Math.max(foldTail, piTail) +
			Math.max(breakdown.pendingUserTokens, piPending) +
			Math.max(0, breakdown.systemPromptTokens - anchor.systemPromptTokens) +
			Math.max(0, breakdown.toolSchemaTokens - anchor.toolSchemaTokens)
		);
	};

	/**
	 * The overflow path's one count (A4): the live estimate or Pi's chars/3.5
	 * count of the same request, whichever is larger. The fold evicts until it
	 * fits and the next main request pins it, so admission and Pi's clamp size
	 * the request the fold fitted. With a provider-measured anchor on this
	 * route the count is the anchored one instead, and neither the chars/4
	 * floor over the measured prefix nor the caller's `floor` applies; without
	 * one it is max(floor, A4).
	 */
	const overflowFitTokens = (
		agentRuntime: AgentRuntime,
		pendingUserText?: string,
		floor = 0,
		history?: MessageListDigests,
	): number => {
		const observed = history ?? observeHistory(agentRuntime);
		const live = liveContextEstimate(agentRuntime, pendingUserText, undefined, observed);
		const pending: AgentMessage[] = [];
		if (pendingUserText !== undefined) {
			pending.push({
				role: "user",
				content: [{ type: "text", text: pendingUserText }, ...shared.pendingUserImages],
				timestamp: 0,
			} as AgentMessage);
			const policy = pendingPolicyText();
			if (policy !== null) pending.push({ role: "user", content: policy, timestamp: 0 });
		}
		const anchored = anchoredFitCount(agentRuntime, observed, live, pending);
		if (anchored !== null) return anchored;
		const pi = estimateEngineRequestTokens(agentRuntime.agent, [...observed.messages, ...pending]);
		return Math.max(floor, live.tokens, pi);
	};

	/**
	 * The part of the next request no compaction removes, on the A4 terms: the system prompt, tool schemas and pending
	 * ask, at the larger of PanCode's estimate and Pi's chars/3.5 count.
	 */
	const fixedRequestTokens = (agentRuntime: AgentRuntime, pendingUserText?: string): number => {
		const { breakdown } = liveContextEstimate(agentRuntime, pendingUserText, []);
		const pending: AgentMessage[] = [];
		if (pendingUserText !== undefined) {
			pending.push({
				role: "user",
				content: [{ type: "text", text: pendingUserText }, ...shared.pendingUserImages],
				timestamp: 0,
			} as AgentMessage);
			const policy = pendingPolicyText();
			if (policy !== null) pending.push({ role: "user", content: policy, timestamp: 0 });
		}
		return Math.max(
			breakdown.systemPromptTokens + breakdown.toolSchemaTokens + breakdown.pendingUserTokens,
			estimateEngineRequestTokens(agentRuntime.agent, pending),
		);
	};

	/**
	 * The anchored count of the next request with nothing pending, or null when this route has no measured anchor.
	 * `history`, when given, is an observation of the same runtime nothing has changed since.
	 */
	const anchoredInputTokens = (agentRuntime: AgentRuntime, history?: MessageListDigests): number | null => {
		const observed = history ?? observeHistory(agentRuntime);
		const live = liveContextEstimate(agentRuntime, undefined, undefined, observed);
		return anchoredFitCount(agentRuntime, observed, live, []);
	};

	/** After an overflow fold or the requireFit summary: a request that fits on the A4 count pins it for the next main request. */
	const pinOverflowFit = (agentRuntime: AgentRuntime, pendingUserText?: string): boolean => {
		const fitAfter = overflowFitTokens(agentRuntime, pendingUserText);
		const window = liveContextEstimate(agentRuntime, pendingUserText).contextWindow;
		if (!requestFits(fitAfter, resolveFitOutputReserve(agentRuntime, fitAfter), window)) return false;
		shared.overflowInputPin = { sessionId: deps.session?.current()?.id };
		return true;
	};

	/**
	 * Null while the request fits on the A4 count. Otherwise what the overflow fold and the requireFit summary could
	 * not clear: the A4 count, and the sentence naming the largest tool result the request still carries and its size,
	 * left empty unless that result alone is larger than the overflow.
	 */
	const overflowOversize = (
		agentRuntime: AgentRuntime,
		pendingUserText?: string,
	): { tokens: number; reserve: number; window: number; largest: string } | null => {
		const window = liveContextEstimate(agentRuntime, pendingUserText).contextWindow;
		if (!(window > 0)) return null;
		const tokens = overflowFitTokens(agentRuntime, pendingUserText);
		const reserve = resolveFitOutputReserve(agentRuntime, tokens);
		if (requestFits(tokens, reserve, window)) return null;
		const messages = agentRuntime.agent.state.messages;
		let largest: { id: string; tool: string; chars: number } | null = null;
		for (const message of messages) {
			if (message.role !== "toolResult") continue;
			const chars = message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
			if (largest === null || chars > largest.chars) largest = { id: message.toolCallId, tool: message.toolName, chars };
		}
		if (largest === null || Math.ceil(largest.chars / 3.5) < tokens + reserve - window)
			return { tokens, reserve, window, largest: "" };
		const call = messages
			.flatMap((message) => (message.role === "assistant" ? message.content : []))
			.find((block) => block.type === "toolCall" && block.id === largest.id);
		const target = call?.type === "toolCall" && typeof call.arguments.path === "string" ? ` ${call.arguments.path}` : "";
		return {
			tokens,
			reserve,
			window,
			largest: `The ${largest.tool}${target} result alone is ${largest.chars} characters (about ${Math.ceil(largest.chars / 3.5)} tokens); ask for a narrower ${largest.tool} (an offset and limit).`,
		};
	};

	/**
	 * The turn's last word once the overflow fold and the requireFit summary are spent and one tool result is what
	 * still overflows. Phrased so overflow recovery does not read it as a provider overflow and compact again.
	 */
	const overflowStop = (agentRuntime: AgentRuntime): string | null => {
		const over = overflowOversize(agentRuntime);
		if (over === null || !over.largest) return null;
		return `[PanCode] This turn stopped: after compaction about ${over.tokens} input tokens plus ${over.reserve} reserved for the reply do not fit the ${over.window}-token window. ${over.largest} The session stays usable; send a smaller request.`;
	};

	/**
	 * After compaction, cut the latest tool batch's largest text results (head and tail kept, a note between them) until
	 * the continuation fits, so the model can ask for a narrower range instead of the turn ending on one oversized
	 * observation. Only the outgoing messages change; the session record keeps the full result. Restores the messages and
	 * returns false when no cut makes the request fit, so the guard's stop stands.
	 */
	const boundBatchToFit = (agentRuntime: AgentRuntime): BoundBatchOutcome => {
		const before = agentRuntime.agent.state.messages;
		const batch: number[] = [];
		for (let index = before.length - 1; index >= 0; index -= 1) {
			const message = before[index];
			if (message?.role === "assistant") break;
			if (message?.role === "toolResult") batch.push(index);
		}
		if (batch.length === 0) return { kind: "none" };
		const textChars = (message: AgentMessage): number =>
			message.role === "toolResult"
				? message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0)
				: 0;
		const excessTokens = (): number => {
			const window = liveContextEstimate(agentRuntime).contextWindow;
			if (!(window > 0)) return 0;
			const input = overflowFitTokens(agentRuntime);
			return input + resolveFitOutputReserve(agentRuntime, input) - window;
		};
		const window = liveContextEstimate(agentRuntime).contextWindow;
		// A cut result by its message index: the text block cut, its full text, and how much of it the model sees.
		const cuts = new Map<number, { tool: string; block: number; text: string; chars: number; kept: number }>();
		const shown = (index: number): number =>
			cuts.get(index)?.kept ?? textChars(agentRuntime.agent.state.messages[index] as AgentMessage);
		// Each pass cuts the largest result still above the floor from its full text, priced at Pi's 3.5 characters a token
		// plus slack for the note, until the request fits or every result of the batch is at the floor. Every pass shows
		// one result less, so the loop ends.
		for (;;) {
			const excess = excessTokens();
			if (excess <= 0) break;
			const messages = agentRuntime.agent.state.messages;
			const index = batch.filter((i) => shown(i) > BOUNDED_RESULT_MIN_CHARS).sort((a, b) => shown(b) - shown(a))[0];
			const message = index === undefined ? undefined : messages[index];
			if (index === undefined || message?.role !== "toolResult") break;
			const blocks = message.content;
			let entry = cuts.get(index);
			if (entry === undefined) {
				const largest = blocks.reduce<number>(
					(best, block, i) =>
						block.type === "text" && (best < 0 || block.text.length > (blocks[best] as { text: string }).text.length)
							? i
							: best,
					-1,
				);
				const block = blocks[largest];
				if (block?.type !== "text") break;
				const call = messages
					.flatMap((item) => (item.role === "assistant" ? item.content : []))
					.find((item) => item.type === "toolCall" && item.id === message.toolCallId);
				const target =
					call?.type === "toolCall" && typeof call.arguments.path === "string" ? ` ${call.arguments.path}` : "";
				const chars = block.text.length;
				entry = { tool: `${message.toolName}${target}`, block: largest, text: block.text, chars, kept: chars };
			}
			const keep = Math.max(BOUNDED_RESULT_MIN_CHARS, entry.kept - Math.ceil(excess * 3.5) - BOUNDED_RESULT_SLACK_CHARS);
			if (keep >= entry.kept) break;
			const { tool, text: full, chars } = entry;
			const head = Math.ceil(keep / 2);
			const note = `\n\n[PanCode cut this ${tool} result from ${chars} to ${keep} characters, keeping its start and end, so the request fits the ${window}-token context window. Ask for the part you need in narrower ranges (an offset and limit, or filtered output) instead of repeating this call.]\n\n`;
			const text = `${full.slice(0, head)}${note}${full.slice(chars - (keep - head))}`;
			const next = [...messages];
			next[index] = {
				...message,
				content: blocks.map((item, i) => (i === entry.block && item.type === "text" ? { ...item, text } : item)),
			};
			agentRuntime.agent.state.messages = next;
			cuts.set(index, { ...entry, kept: keep });
		}
		const cut = [...cuts.values()];
		if (cut.length === 0) return { kind: "none" };
		if (excessTokens() > 0) {
			// Even the floor overflows: what is left is the fixed request, which no cut of this batch can shrink.
			const tokens = overflowFitTokens(agentRuntime);
			const reserve = resolveFitOutputReserve(agentRuntime, tokens);
			agentRuntime.agent.state.messages = before;
			const cuts = cut.map((entry) => `the ${entry.tool} result cut to ${entry.kept} characters`).join(" and ");
			return {
				kind: "short",
				stop: `[PanCode] This turn stopped: the context window is too small for it. Even with ${cuts}, about ${tokens} input tokens plus ${reserve} reserved for the reply do not fit the ${window}-token window. ${turnAdmissionRemedy(agentRuntime, tokens)} The session stays usable.`,
			};
		}
		for (const entry of cut) {
			deps.emitNotice(
				`[PanCode] The ${entry.tool} result (${entry.chars} characters) did not fit the ${window}-token window after compaction; the model sees ${entry.kept} of them, from its start and end, and was told to read narrower ranges. The session keeps the full result.`,
				"warning",
			);
		}
		return { kind: "fit" };
	};

	/** The system prompt rarely changes between publications; hash it again only when it does. */
	const systemPromptDigest = (prompt: string | null): string => {
		if (shared.promptDigest?.prompt !== prompt) shared.promptDigest = { prompt, digest: sha256Json(prompt) };
		return shared.promptDigest.digest;
	};

	/**
	 * Identity of the exact material the next request would carry, plus the
	 * settings that decide its reserve and whether a reduction is even eligible.
	 * This is the pre-accounting half: the reduction basis adds the resolved
	 * estimate, cap, and reservation on top of it.
	 *
	 * Token counts alone cannot do this job: `estimateAgentMessageTokens` prices
	 * by character count, so replacing a message with another of the same length
	 * leaves every figure identical while the request is a different one. The
	 * conversation is therefore hashed by content, not by length or count.
	 */
	const liveBudgetContentFingerprint = (
		agentRuntime: AgentRuntime | null,
		pendingUserText: string | undefined,
		promptFingerprint: string | null,
		toolSignature: string | null,
		history?: MessageListDigests,
	): string => {
		const settings = deps.getSettings();
		const eligibility = {
			compaction: settings.context.compaction ?? null,
			workingSet: settings.context.workingSet ?? null,
			maxOutputTokens: settings.chat?.maxOutputTokens ?? null,
		};
		if (!agentRuntime) {
			const snapshot = shared.currentContextSnapshot;
			return sha256Json([
				"historical/1",
				settings.chat?.target ?? null,
				settings.chat?.model ?? null,
				snapshot?.snapshotId ?? null,
				snapshot ? snapshotInputTokens(snapshot) : null,
				snapshot?.sources.total ?? null,
				routing.windowWithoutRuntime().contextWindow,
				promptFingerprint,
				toolSignature,
				eligibility,
			]);
		}
		const details = agentRuntime.runtimeResolution.contextWindowDetails;
		return sha256Json([
			"live/1",
			agentRuntime.targetId,
			agentRuntime.runtimeId,
			agentRuntime.wireModelId,
			agentRuntime.agent.state.model?.api ?? null,
			details.effectiveContextWindow,
			details.contextWindowSource,
			promptFingerprint,
			toolSignature,
			// Same serialization the anchor validates its attested prefix with, so
			// the two cannot disagree about whether the conversation changed.
			(history ?? observeHistory(agentRuntime)).digest(),
			pendingUserText ?? null,
			pendingUserText === undefined ? null : shared.pendingUserImages,
			eligibility,
		]);
	};

	/**
	 * Token facts of the live next request, all from one `liveContextEstimate`
	 * call: the same one admission budgets against. Old snapshot categories are
	 * never summed to reconstruct the total, and streaming output is never added
	 * on top, because the live next-request message list already carries the
	 * completed assistant turn and the estimate already carries the pending
	 * text. Each is charged exactly once.
	 */
	const liveRuntimeAccounting = (
		agentRuntime: AgentRuntime,
		pendingUserText: string | undefined,
		history?: MessageListDigests,
		computed?: LiveContextEstimate,
	): LiveBudgetAccounting => {
		const estimate = computed ?? liveContextEstimate(agentRuntime, pendingUserText, undefined, history);
		const details = agentRuntime.runtimeResolution.contextWindowDetails;
		// After an overflow fold that fit, the view publishes the A4 count it fitted, so the card, admission and Pi's
		// clamp read one figure until the request that carries it goes out.
		const inputTokens = overflowPinArmed()
			? overflowFitTokens(agentRuntime, pendingUserText, estimate.tokens)
			: estimate.tokens;
		return {
			targetId: agentRuntime.targetId,
			runtimeId: agentRuntime.runtimeId,
			modelId: agentRuntime.wireModelId,
			modelApi: agentRuntime.agent.state.model?.api ?? null,
			effectiveWindow: details.effectiveContextWindow > 0 ? details.effectiveContextWindow : null,
			windowSource: details.contextWindowSource,
			estimatedInputTokens: estimate.estimatedTokens,
			anchoredInputTokens: estimate.reconciledTokens,
			inputTokens,
			inputSource: estimate.reconciledTokens === null ? "estimated" : "anchored-plus-estimated-tail",
			historical: false,
			breakdown: { ...estimate.breakdown },
			breakdownSource: "live",
			outputReserveTokens: resolveFitOutputReserve(agentRuntime, inputTokens),
		};
	};

	/** Token facts before this process built a runtime: a persisted measurement, labelled as one. */
	const historicalAccounting = (
		snapshot: ContextSnapshot | null,
		settings: Readonly<PancodeSettings>,
	): LiveBudgetAccounting => {
		// Inspection uses already-loaded capture facts, never a diagnostic-ledger scan.
		const sameRoute =
			!snapshot || (snapshot.providerId === settings.chat?.target && snapshot.modelId === settings.chat?.model);
		// A saved request from model A cannot acquire model B's window while
		// retaining A's identity and input measurement. Keep that capture coherent.
		const window =
			snapshot && !sameRoute
				? {
						contextWindow: snapshot.effectiveContextWindow,
						contextWindowSource: snapshotWindowSource(snapshot),
					}
				: routing.windowWithoutRuntime();
		const pendingTokens = pendingUserInputTokens();
		return {
			targetId: snapshot?.providerId ?? settings.chat?.target ?? null,
			runtimeId: snapshot?.runtimeId ?? null,
			modelId: snapshot?.modelId ?? settings.chat?.model ?? null,
			modelApi: null,
			effectiveWindow: window.contextWindow > 0 ? window.contextWindow : null,
			windowSource: window.contextWindowSource,
			estimatedInputTokens: snapshot?.estimatedTokens ?? null,
			anchoredInputTokens: snapshot?.reconciledTokens ?? null,
			inputTokens: snapshot ? snapshotInputTokens(snapshot) + pendingTokens : null,
			inputSource: snapshot ? "historical" : "unknown",
			historical: true,
			breakdown: snapshot ? capturedBreakdown(snapshot, pendingTokens) : null,
			breakdownSource: snapshot ? "captured" : null,
			// No resolved route means no honest output reservation, and an unpriced
			// reserve is unknown rather than zero.
			outputReserveTokens: null,
		};
	};

	/**
	 * Assemble one publication from the live runtime, or from the persisted
	 * capture when this process has not built a runtime yet.
	 */
	const liveBudgetInput = (
		pendingUserText?: string,
		capturedHistory?: MessageListDigests,
		estimate?: LiveContextEstimate,
	): LiveBudgetInput => {
		const settings = deps.getSettings();
		const agentRuntime = state.runtime;
		const history = agentRuntime ? (capturedHistory ?? observeHistory(agentRuntime)) : undefined;
		const snapshot = shared.currentContextSnapshot;
		const promptFingerprint = agentRuntime
			? systemPromptDigest(engineInitialSystemPrompt(agentRuntime.agent) ?? null)
			: (snapshot?.promptHash ?? null);
		const toolSignature = agentRuntime
			? toolSignatureFromState(agentRuntime.agent.state.tools)
			: (snapshot?.toolSignature ?? null);
		const contentFingerprint = liveBudgetContentFingerprint(
			agentRuntime,
			pendingUserText,
			promptFingerprint,
			toolSignature,
			history,
		);
		// Two independent existing settings, not one derived from the other: the
		// reduce point is `context.compaction.threshold` and the working-set
		// target is `context.workingSet.target`. A pair the policy refuses is
		// reported as a refusal rather than repaired into a fabricated setting.
		const policyResolution = resolveLiveBudgetPolicy(
			settings.context.compaction?.threshold,
			settings.context.workingSet?.target,
		);

		// Accounting first, then the identity that describes it. A reduction
		// refusal is only reusable for the request the reducer actually saw, and
		// the resolved anchor, cap, and reservation are part of that request even
		// when not a byte of the conversation moved.
		const accounting = agentRuntime
			? liveRuntimeAccounting(agentRuntime, pendingUserText, history, estimate)
			: historicalAccounting(snapshot, settings);
		const economic = compactionBudget(
			accounting.effectiveWindow ?? 0,
			policyResolution.policy.reduce,
			settings.context.compaction.maxTokens,
			agentRuntime?.agent.state.model ??
				getCatalogModelForRuntime(
					accounting.runtimeId ?? settings.targets.find((target) => target.id === accounting.targetId)?.runtime ?? "",
					accounting.modelId ?? "",
				),
		);
		const configured = policyResolution.policy;
		const policy = {
			...configured,
			notice: configured.notice * (economic.threshold / configured.reduce),
			prepare: configured.prepare * (economic.threshold / configured.reduce),
			reduce: economic.threshold,
			target: configured.target * economic.fractionScale,
		};
		const reductionBasisKey = sha256Json([
			"reduction-basis/1",
			contentFingerprint,
			accounting.effectiveWindow,
			accounting.estimatedInputTokens,
			accounting.anchoredInputTokens,
			accounting.inputTokens,
			accounting.inputSource,
			accounting.outputReserveTokens,
			// The resolved cap can move without moving the reservation, because a
			// route clamp may be the binding constraint. Both belong in the key.
			agentRuntime?.runtimeResolution.capabilityDecisions?.maxTokens ?? null,
			snapshot?.categories.reserve ?? null,
			policy.reduce,
			policy.target,
		]);

		return {
			...accounting,
			sessionId: deps.session?.current()?.id ?? snapshot?.sessionId ?? null,
			branchAnchorTurnId: shared.branchAnchorTurnId,
			activeLeafTurnId: state.lastTurnId,
			activeUserTurnId: state.activeUserTurnId,
			capturedSnapshotId: snapshot?.snapshotId ?? null,
			// Compaction headroom recorded by the capture. Carried under its own
			// name so nothing can mistake it for the output reserve.
			thresholdReserveTokens: snapshot?.categories.reserve ?? null,
			policy,
			policyRejection: policyResolution.rejection,
			// Reduction has not been asked about unless an automatic attempt for
			// this exact basis already came back empty.
			reduction:
				shared.noUsefulCutBasisKey !== null && shared.noUsefulCutBasisKey === reductionBasisKey
					? "no-useful-cut"
					: "unknown",
			reductionBasisKey,
			promptFingerprint,
			toolSignature,
			navigationEpoch: shared.navigationEpoch,
			lastReduction: shared.lastCompactionEvent ? { ...shared.lastCompactionEvent } : null,
			pendingHandoff: optionalProjection(deps.getPendingHandoff),
			lastOutcome: optionalProjection(deps.getLastOutcome),
		};
	};

	// A republish while a reduction runs (the summary stage reading the view) prices the request the fold prices,
	// so the card, the record and every usage frame state one figure (bt-47 D1).
	const refreshLiveBudget = (
		pendingUserText?: string,
		history?: MessageListDigests,
		estimate?: LiveContextEstimate,
	): LiveBudgetView =>
		budgetProducer.publish(
			liveBudgetInput(
				pendingUserText ?? (estimate === undefined ? shared.reductionPendingText : undefined),
				history,
				estimate,
			),
		);

	/** The record's copy of what the carry leaves: the same figure, the anchor's system and tools, and its route. */
	const evictionAnchor = (
		agentRuntime: AgentRuntime,
		historyTokens: number | null,
		tokensRemoved: number,
	): EvictionAnchor | undefined => {
		const anchor = shared.reconciledAnchor;
		if (!anchor || historyTokens === null) return undefined;
		return {
			tokens: carriedTokens(historyTokens, tokensRemoved),
			sys: anchor.systemPromptTokens,
			tools: anchor.toolSchemaTokens,
			route: {
				targetId: agentRuntime.targetId,
				runtimeId: agentRuntime.runtimeId,
				wireModelId: agentRuntime.wireModelId,
				modelKey: anchorModelKey(agentRuntime),
			},
		};
	};

	const carryReconciledAnchorThroughProjection = (
		agentRuntime: AgentRuntime,
		historyTokens: number | null,
		tokensRemoved: number,
	): void => {
		if (!shared.reconciledAnchor || historyTokens === null) return;
		const history = observeHistory(agentRuntime);
		shared.reconciledAnchor = {
			...shared.reconciledAnchor,
			tokens: carriedTokens(historyTokens, tokensRemoved),
			anchoredMessages: history.messages,
			// Re-anchoring on the projected list is the point of this carry, so its
			// content identity is retaken here. Keeping the old digest would fail
			// the next validation and discard the attestation this preserves.
			contentDigest: history.digest(),
			// The carry prices the unmeasured tail and the removed bodies at chars/4 (bt-47 D-A).
			measured: false,
		};
	};

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
		liveContextEstimate,

		refreshLiveBudget,
		takeOverflowInputPin(): void {
			shared.overflowInputPin = null;
		},
		overflowFitTokens,
		anchoredInputTokens,
		contextFloorRefusal: (runtime: AgentRuntime, pendingUserText?: string) =>
			contextFloorRefusal(runtime, fixedRequestTokens(runtime, pendingUserText)),
		oversizedResult: (runtime: AgentRuntime, pendingUserText?: string) =>
			overflowOversize(runtime, pendingUserText)?.largest || null,
		refreshAgentMessagesFromSession,
		runAutoCompact,
		runStepCheckpoint,
		lastCompactionWasNoGain: () => shared.lastCompactionNoGain,
		lastCompactionCardSettled: () => shared.lastCompactionCardSettled,
		navigationRevision: () => shared.navigationEpoch,
		cancelCompaction: () => shared.compactionController?.abort(),

		liveBudget: (): LiveBudgetView => budgetProducer.current() ?? refreshLiveBudget(),
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
				view: refreshLiveBudget(),
				...(live
					? {
							outputReserveAt: (tokens: number) => resolveFitOutputReserve(live, tokens),
							priceAt: (tokens: number) => {
								const ratio = routeTokenRatio(live);
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

		setCurrentSnapshot(snapshot: ContextSnapshot): void {
			shared.currentContextSnapshot = snapshot;
			refreshLiveBudget(snapshot.pendingUserInput);
		},

		flushReconciledSnapshot(): void {
			if (shared.snapshotPersistPending && shared.currentContextSnapshot)
				persistContextSnapshot(shared.currentContextSnapshot);
			// Run settlement. Its callers are `agent_end` and submit's finally, so
			// this is where the finished run's accounting is published, not the
			// mid-run tool-batch boundary; that one is `postToolContinuationGuard`.
			refreshLiveBudget();
		},

		reconcileUsage(usage: Usage, call?: { callId: string; attemptId: string }): void {
			// Cached prompt tokens still occupy the window; providers report them
			// outside `input`, so the attested prompt is the three summed.
			const promptTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
			const runtime = state.runtime;
			const history = runtime ? observeHistory(runtime) : undefined;
			if (promptTokens > 0 && runtime && history) {
				const breakdown = estimateAgentContextBreakdown({ ...runtime.agent.state, messages: [] });
				// The output of this call is part of the next call's prompt for the
				// same messages, which is why it is folded in here.
				shared.reconciledAnchor = {
					tokens: promptTokens + (usage.output || 0),
					anchoredMessages: history.messages,
					contentDigest: history.digest(),
					runtime,
					model: runtime.agent.state.model,
					modelKey: anchorModelKey(runtime),
					targetId: runtime.targetId,
					runtimeId: runtime.runtimeId,
					wireModelId: runtime.wireModelId,
					systemPromptTokens: breakdown.systemPromptTokens,
					toolSchemaTokens: breakdown.toolSchemaTokens,
					measured: true,
				};
			}
			if (!shared.currentContextSnapshot) {
				// The anchor still moved, and it is what the next request budgets
				// against, so the view is republished with or without a snapshot.
				refreshLiveBudget(undefined, history);
				return;
			}
			// Reconcile in memory on every API call so the live meters
			// track usage; persistence waits for the run to settle.
			if (runtime && history) {
				const messages = history.messages;
				// The just-completed response is output, not part of its own prompt.
				const promptMessages = messages.at(-1)?.role === "assistant" ? messages.slice(0, -1) : messages;
				shared.currentContextSnapshot = captureRuntimeContextSnapshot(
					runtime,
					shared.currentContextSnapshot.turnId,
					deps.getSettings().context.compaction?.threshold ?? null,
					{
						conversationMessages: promptMessages,
						promptSegments: shared.currentContextSnapshot.promptSegments,
						promptHash: shared.currentContextSnapshot.promptHash,
						toolSignature: shared.currentContextSnapshot.toolSignature,
					},
				);
			}
			shared.currentContextSnapshot = {
				...reconcileSnapshot(shared.currentContextSnapshot, usage),
				callId: call?.callId,
				attemptId: call?.attemptId,
			};
			shared.snapshotPersistPending = true;
			// A reconcile moves the anchor and therefore the figure the next
			// request budgets against, so it is a publication point of its own.
			refreshLiveBudget(undefined, history);
		},

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
				const input = overflowFitTokens(agentRuntime, undefined, view.inputTokens ?? 0, settled());
				const reserve = view.outputReserveTokens === null ? null : resolveFitOutputReserve(agentRuntime, input);
				return requestFits(input, reserve, view.effectiveWindow);
			};
			// The view's figures, or with a measured anchor the anchored count admission sends on (bt3 drv-rv5).
			const fitFigures = (view: LiveBudgetView): { input: number | null; reserve: number | null } => {
				const anchored = anchoredInputTokens(agentRuntime, settled());
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
					const oversize = requireFit && !aborted ? overflowStop(agentRuntime) : null;
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
				const overflowing = (mustFit && overflowStop(agentRuntime) !== null) || (knownWindow && !viewFits(view));
				const bound = overflowing ? boundBatchToFit(agentRuntime) : null;
				if (bound?.kind === "short") throw oversizedResultStop(bound.stop);
				if (bound?.kind === "fit") {
					attemptStarted = true;
					view = refreshLiveBudget();
				}
				const oversize = mustFit ? overflowStop(agentRuntime) : null;
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
				const before = liveContextEstimate(agentRuntime, undefined, undefined, history);
				const beforeView =
					agentRuntime === state.runtime ? refreshLiveBudget(undefined, history, before) : refreshLiveBudget();
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
			if (!mustFit && knownWindow && !a4Fits(refreshLiveBudget())) {
				mustFit = true;
				await compact(true);
			}
			return withSettledHistory(() => finish(refreshLiveBudget()));
		},

		contextUsage(): LiveContextUsage {
			// Footer reads project the last publication. They never rescan the
			// ledger or add streaming output to the next-request message estimate.
			const view = budgetProducer.current() ?? refreshLiveBudget();
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
			const view = budgetProducer.current() ?? refreshLiveBudget();
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
