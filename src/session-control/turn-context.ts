import { isHostPolicyMessage } from "../core/host-policy-message.js";
import type { SandboxAvailability } from "../core/sandbox/types.js";
import type { SuccessfulMemoryContextCommit } from "../domains/memory/commit-state.js";
import type { MemoryInterventionRegistration } from "../domains/memory/intervention-types.js";
import { callRepeatsAsRead } from "../engine/loop-guard.js";
import { effectiveCallIdentity } from "../engine/loop-guard-repeat.js";
import type { ContinuityReductionHooks } from "./continuity-controller.js";
import type { MessageListDigests } from "./message-list-digest.js";
import { createMessageListFold } from "./message-list-digest.js";
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
import type { planEviction } from "../domains/context/working-set/engine.js";
import type { ClassifyCall } from "../domains/context/working-set/superseded.js";
import { type PinnedContextBlock, pinnedContextDelta } from "../domains/extensions/pinned-context.js";
import type { CompactInput, CompactResult } from "../domains/memory/compaction/compact.js";
import type { MemoryPromptRequest } from "../domains/memory/prompt-cache.js";
import type { MemoryRecordStanding } from "../domains/memory/prompt-section.js";
import type { CompiledSessionPrompt } from "../domains/prompts/compiler.js";
import type { PromptsContract } from "../domains/prompts/contract.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import { AutoCompactionTrigger } from "../domains/session/compaction/auto.js";
import type {
	CaptureContextSnapshotInput,
	ContextSnapshot,
	ContextUsageSnapshot,
	estimateAgentContextBreakdown,
} from "../domains/session/context-accounting.js";
import type { ContextLedger, PrewarmStats } from "../domains/session/context-ledger.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { CompactionTrigger, SessionEntry } from "../domains/session/entries.js";
import type { SessionPromptCompileRecord } from "../domains/session/prompt-manifest.js";
import { activePath } from "../domains/session/tree/active-path.js";
import type { TelemetryContract } from "../domains/telemetry/contract.js";
import type {
	AgentMessage,
	AnthropicResponseObservation,
	CodexTransportObservation,
	ResponsesCacheDiagnostic,
	Usage,
} from "../engine/types.js";
import type { AutonomyLevel } from "../lib/autonomy/autonomy.js";
import type { ToolRegistry } from "../tools/registry-contract.js";
import type { HostInserts } from "./host-inserts.js";
import { contextFloorRefusal } from "./output-reserve.js";
import { createTurnContextAnchor } from "./turn-context/anchor.js";
import { createTurnContextBudget } from "./turn-context/budget.js";
import { createTurnContextCache } from "./turn-context/cache.js";
import { createTurnContextCompaction } from "./turn-context/compaction.js";
import { createTurnContextFit } from "./turn-context/fit.js";
import { memoryOrigin } from "./turn-context/helpers.js";
import { createTurnContextMemory } from "./turn-context/memory.js";
import { createTurnContextPrompt } from "./turn-context/prompt.js";
import { createTurnContextProvider } from "./turn-context/provider.js";
import { createTurnContextRoute } from "./turn-context/route.js";
import type { TurnContextScope } from "./turn-context/scope.js";
import { createTurnContextSession } from "./turn-context/session.js";
import { createTurnContextUsage } from "./turn-context/usage.js";
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

export { OVERSIZED_RESULT_STOP } from "./turn-context/helpers.js";

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
			return sessionState.persistContextSnapshot;
		},
		get captureRuntimeContextSnapshot() {
			return sessionState.captureRuntimeContextSnapshot;
		},
		get lastRecordedPromptHash() {
			return sessionState.lastRecordedPromptHash;
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
			return providerReplay.bindProviderCompaction;
		},
		get syncCodexConfiguration() {
			return providerReplay.syncCodexConfiguration;
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
			return providerReplay.resolveProviderReplay;
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
			return sessionState.pendingUserInputTokens;
		},
		get liveStreamingOutputTokens() {
			return sessionState.liveStreamingOutputTokens;
		},
		get routeSuperseded() {
			return routing.routeSuperseded;
		},
		get previewCompactionRoute() {
			return routing.previewCompactionRoute;
		},
		get refreshAgentMessagesFromSession() {
			return refreshAgentMessagesFromSession;
		},
		get runAutoCompact() {
			return runAutoCompact;
		},
		get anchoredInputTokens() {
			return fitting.anchoredInputTokens;
		},
		get overflowStop() {
			return fitting.overflowStop;
		},
		get boundBatchToFit() {
			return fitting.boundBatchToFit;
		},
		get contextFold() {
			return contextFold;
		},
		get bindMemoryScope() {
			return bindMemoryScope;
		},
		get unsubscribeColdReasonSources() {
			return cache.unsubscribeColdReasonSources;
		},
	};

	const cache = createTurnContextCache(shared);

	const sessionState = createTurnContextSession(shared);

	const routing = createTurnContextRoute(shared);

	const anchors = createTurnContextAnchor(shared);

	const fitting = createTurnContextFit(shared);

	const budgeting = createTurnContextBudget(shared);

	const providerReplay = createTurnContextProvider(shared);

	const { contextFold, refreshAgentMessagesFromSession, runAutoCompact, runStepCheckpoint } =
		createTurnContextCompaction(shared);

	const { bindMemoryScope, installMemoryRestoration, memoryTurnMethods, notifyMemoryCommit } =
		createTurnContextMemory(shared);

	const promptMethods = createTurnContextPrompt(shared);

	const usageView = createTurnContextUsage(shared);
	const controller: TurnContext = {
		thinkingUsesConfigurationUpdate: () => shared.thinkingUsesConfigurationUpdate,
		notifyMemoryCommit,
		installMemoryRestoration,
		prepareMemoryTurn: memoryTurnMethods.prepareMemoryTurn,

		syncRouteConfiguration: providerReplay.syncCodexConfiguration,

		commitMemoryTurn: memoryTurnMethods.commitMemoryTurn,

		captureRuntimeContextSnapshot: sessionState.captureRuntimeContextSnapshot,
		persistContextSnapshot: sessionState.persistContextSnapshot,
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
		inspectLiveBudget: usageView.methods.inspectLiveBudget,

		setCurrentSnapshot: anchors.methods.setCurrentSnapshot,

		flushReconciledSnapshot: anchors.methods.flushReconciledSnapshot,

		reconcileUsage: anchors.methods.reconcileUsage,

		promptSideTokens: usageView.methods.promptSideTokens,

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

		postToolContinuationGuard: providerReplay.methods.postToolContinuationGuard,

		contextUsage: usageView.methods.contextUsage,

		contextLedger: usageView.methods.contextLedger,

		noteColdReason: cache.noteColdReason,

		consumeExpectedColdReasons: cache.methods.consumeExpectedColdReasons,

		takeCallColdReasons: cache.methods.takeCallColdReasons,

		cacheGeneration: cache.methods.cacheGeneration,

		noteCacheRequestToolChoice: cache.methods.noteCacheRequestToolChoice,

		noteCacheRequestSystemPrompt: cache.methods.noteCacheRequestSystemPrompt,

		promptCachePayloadForAssistant: cache.methods.promptCachePayloadForAssistant,

		notePrewarm: cache.methods.notePrewarm,

		noteRunCacheSummary: cache.methods.noteRunCacheSummary,

		resetForSession: sessionState.methods.resetForSession,

		journalResumedBudget: usageView.methods.journalResumedBudget,

		dispose: sessionState.methods.dispose,
	};
	return controller;
}
