// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { randomUUID } from "node:crypto";
import type { ContextOperationFact } from "../core/context-operation.js";
import { CONTEXT_OPERATION_CUSTOM_TYPE, createContextOperation } from "../core/context-operation.js";
import { isHostPolicyMessage } from "../core/host-policy-message.js";
import type { PendingSkillToolPolicy } from "../core/skill-activation.js";
import type { ContextActivityPhase, ContextActivityStatus } from "../core/telemetry/live-events.js";
import type { CallMessageObserver } from "../core/telemetry/producer.js";
import { supersededStageApplies } from "../domains/context/fold/contract.js";
import { SMALL_WINDOW_TOKENS } from "../domains/context/fold/pressure.js";
import { withinRearmBand } from "../domains/context/working-set/checkpoint.js";
import { foldWorkingSet } from "../domains/context/working-set/fold.js";
import { resolveWorkingSetPolicy } from "../domains/context/working-set/policies/index.js";
import { compactionCut } from "../domains/context/working-set/visible.js";
import {
	type CompactInput,
	type CompactResult,
	checkpointContinuityCarry,
	checkpointSkillContext,
	hostCheckpoint,
} from "../domains/session/compaction/compact.js";
import { DEFAULT_KEEP_RECENT_TOKENS } from "../domains/session/compaction/defaults.js";
import { estimateTokens } from "../domains/session/compaction/tokens.js";
import type { SessionContract } from "../domains/session/contract.js";
import {
	type CompactionSummaryEntry,
	type CompactionTrigger,
	mainSkillContextState,
} from "../domains/session/entries.js";
import { findLastEntry } from "../domains/session/tree/active-path.js";
import { compactEngineCodex, engineInitialSystemPrompt } from "../engine/agent.js";
import { prepareInPrefixSummary } from "../engine/in-prefix-summary.js";
import { HOST_STATUS_NOTICE_KEY } from "./chat-loop-messages.js";
import { CONTEXT_STATUS_NOTICE_KEY, footerTokens, renderCompactionSummaryLine } from "./compaction-lines.js";
import { createContextFold, type FoldDecision, foldCheckpointFor, ledgerHoldsCheckpoint } from "./context-fold.js";
import type { ContinuityReductionHooks } from "./continuity-controller.js";
import { buildModelReplayAgentMessagesFromTurns, continuityContextFromSession } from "./model-session-replay.js";
import { resolveFitOutputReserve, resolveSummaryOutputCap } from "./output-reserve.js";
import type { LiveContextEstimate, TurnContext } from "./turn-context.js";
import { sha256Json, type TurnContextScope } from "./turn-context-scope.js";
import type { AgentRuntime } from "./turn-state.js";

const AUTO_COMPACT_FAILURE_LIMIT = 3;

/** A summary that came back empty, by its empty reason: the `context.fold` stage reason and the card's conclusion. */
const EMPTY_SUMMARY = {
	"repeat-no-gain": ["repeat_no_gain", "same history as the last summary without gain; no call made"],
	"protected-skill": ["protected_skill", "nothing older than the protected skill turn to summarize"],
	"protected-recent": ["protected_recent", "nothing older than the protected recent window to summarize"],
	"nothing-to-summarize": ["nothing_to_summarize", "nothing to summarize"],
	"below-summary-room": ["nothing_to_summarize", "nothing to summarize"],
} as const;

/** The summarizer streams a delta every few milliseconds; the rail needs a few redraws a second. */
const SUMMARY_PROGRESS_INTERVAL_MS = 250;

/**
 * Context compaction for one turn context: the reduction lifecycle and its activity card, the context fold, the
 * automatic compaction (`performAutoCompact`, `runAutoCompact`) and the step checkpoint.
 */
export function createTurnContextCompaction(shared: TurnContextScope) {
	const {
		activeEntries,
		bindProviderCompaction,
		budgetProducer,
		captureRuntimeContextSnapshot,
		carryReconciledAnchorThroughProjection,
		classifyCall,
		compactionTrigger,
		deps,
		evictionAnchor,
		liveBudgetInput,
		liveContextEstimate,
		middleware,
		noteColdReason,
		observeHistory,
		overflowFitTokens,
		persistContextSnapshot,
		pinOverflowFit,
		reconciledHistoryTokens,
		refreshLiveBudget,
		resetCacheCallBaseline,
		routeCompaction,
		state,
		summaryOnChatRoute,
		syncCodexConfiguration,
	} = shared;

	/** The last request S0 found nothing to commit in; the same request is not read again. */
	let supersededAttemptKey: string | null = null;
	// The chat and summarizer route the failures above were counted on: another route clears them.
	let autoCompactRouteKey = "";

	let compactionOperation: ReturnType<typeof createContextOperation> | null = null;
	let compactionLifecycleStarted = false;
	let compactionLifecycleTrigger: CompactionTrigger = "auto";
	let compactionFacts: ContextOperationFact[] = [];
	let compactionTokens: { before: number; after: number; basis: "runtime-estimate" } | undefined;
	/** The summary line a completed compaction raised, persisted on its operation so a resumed card states it. */
	let compactionNotice: string | undefined;
	let compactionConclusion = "Context compaction finished";
	let compactionActivityPhase: ContextActivityPhase = "compact";
	const emitCompactionActivity = (
		status: ContextActivityStatus,
		message: string,
		phase: ContextActivityPhase = status === "completed"
			? "done"
			: status === "failed"
				? compactionActivityPhase
				: "compact",
		measure?: { current?: number; total?: number; unit: "tokens" },
	): void => {
		if (status === "started" && !compactionLifecycleStarted) {
			compactionLifecycleStarted = true;
			deps.bus?.emit("compaction.started", { trigger: compactionLifecycleTrigger, at: Date.now() });
		}
		compactionActivityPhase = phase;
		if (status === "completed" || status === "failed") {
			compactionConclusion = message;
			return;
		}
		compactionOperation?.progress({
			phase,
			status,
			message,
			...(measure ?? {}),
			...(phase === "summarize" ? { stages: ["compact", "summarize", "state"] as const } : {}),
		});
	};
	const compactionFailureMessage = (error: unknown): string =>
		`compaction failed: ${error instanceof Error ? error.message : String(error)}`;

	// Each hook reads its target when the fold calls it, so ones declared further down this closure resolve.
	const contextFold = createContextFold({
		// Every line the fold emits is working-set status, so it carries the context status tag.
		deps: { ...deps, emitNotice: (text) => deps.emitNotice(text, "info", CONTEXT_STATUS_NOTICE_KEY) },
		state,
		syncCodexConfiguration: (runtime) => syncCodexConfiguration(runtime),
		liveContextEstimate: (runtime, pendingUserText) => liveContextEstimate(runtime, pendingUserText),
		overflowFitTokens: (runtime, pendingUserText) => overflowFitTokens(runtime, pendingUserText),
		pinOverflowFit: (runtime, pendingUserText) => pinOverflowFit(runtime, pendingUserText),
		reconciledHistoryTokens: (runtime, commit) => reconciledHistoryTokens(runtime, undefined, commit),
		evictionAnchor: (runtime, historyTokens, tokensRemoved) => evictionAnchor(runtime, historyTokens, tokensRemoved),
		carryReconciledAnchorThroughProjection: (runtime, historyTokens, tokensRemoved) =>
			carryReconciledAnchorThroughProjection(runtime, historyTokens, tokensRemoved),
		dropReconciledAnchor: () => {
			shared.reconciledAnchor = null;
		},
		publishSnapshot: (runtime, threshold, metadata) => {
			const snapshot = captureRuntimeContextSnapshot(runtime, state.activeUserTurnId || "compaction", threshold, metadata);
			shared.currentContextSnapshot = snapshot;
			persistContextSnapshot(snapshot);
			return snapshot;
		},
		persistContextSnapshot: (snapshot) => persistContextSnapshot(snapshot),
		noteCompactionEvent: (event) => {
			shared.lastCompactionEvent = event;
		},
		notifyMemoryCommit: (commitId, kind, outcome) => shared.notifyMemoryCommit(commitId, kind, outcome),
		resetCacheCallBaseline: () => resetCacheCallBaseline(),
		noteColdReason: (reason) => noteColdReason(reason),
		refreshLiveBudget: (pendingUserText) => {
			refreshLiveBudget(pendingUserText);
		},
		emitCompactionActivity: (status, message) => emitCompactionActivity(status, message),
		compactionFailureMessage,
		noteStructuralEviction: (planned) => {
			const count = planned.items.length;
			compactionFacts.push({ kind: "omitted", unit: "observations", count });
			emitCompactionActivity("completed", `${count} working-set ${count === 1 ? "item" : "items"} evicted`);
			compactionTokens = { before: planned.tokensBefore, after: planned.tokensAfter, basis: "runtime-estimate" };
		},
		recompilePosturePrompt: async (runtime) => {
			if (!shared.postureGeneration) return;
			await shared.controller.ensureSessionPrompt(runtime);
			shared.controller.logPromptCompileIfPending();
		},
	});
	const refreshAgentMessagesFromSession = contextFold.refreshAgentMessagesFromSession;

	/**
	 * Two-mechanism context protection. When pressure crosses the single
	 * threshold, first apply a non-destructive working-set eviction. If pressure
	 * stays above the threshold, delegate to the pi-style LLM compaction path:
	 * append a compaction summary entry, then replay from the session view. The
	 * destructive observation mask remains only as a one-release escape hatch.
	 *
	 * `force = true` skips the pressure check and every pre-stage and runs
	 * the LLM summary directly. Used for `/context compact`, PANCODE_FORCE_COMPACT=1,
	 * and overflow recovery.
	 */
	const performAutoCompact = async (
		agentRuntime: AgentRuntime,
		force: boolean,
		instructions?: string,
		triggerOverride?: CompactionTrigger,
		pendingUserText?: string,
		pendingSkillPolicy?: PendingSkillToolPolicy,
		signal?: AbortSignal,
		handoff?: ContinuityReductionHooks,
		pendingUserIsOperator = true,
		providerFallbackReason?: string,
		pendingUserTurnId?: string,
	): Promise<boolean> => {
		bindProviderCompaction(agentRuntime);
		shared.lastCompactionNoGain = false;
		shared.overflowInputPin = null;
		if (!deps.readSessionEntries) return false;
		// A fresh prompt has no history to shrink; request admission reports its budget (#438).
		if (deps.session && !deps.session.current()) return false;
		const originSession = deps.session?.current()?.id;
		const originNavigation = shared.navigationEpoch;
		// A known window lets overflow recovery force a fit attempt. With an
		// unknown window, summarize directly and let the server judge the retry.
		const effectiveWindow = agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow;
		const knownWindow = effectiveWindow > 0;
		const requiredFit = triggerOverride === "overflow" && knownWindow;
		// Under 52,428 tokens the fixed 20K recent suffix can hold every turn, so /compact refused as too short while
		// the window had no room left for a tool call. A forced pass there sizes its suffix from the window as the
		// automatic one does, so it always has history to summarize (memory-audit 13). Larger windows are unchanged.
		const smallWindowForce = force && knownWindow && effectiveWindow < SMALL_WINDOW_TOKENS;
		const useRequestBudget =
			!force || requiredFit || smallWindowForce || handoff !== undefined || providerFallbackReason !== undefined;
		const activeAutoTurnId = useRequestBudget ? state.activeUserTurnId : null;
		const skillContextState = mainSkillContextState(
			activeEntries(),
			pendingSkillPolicy ?? state.currentPendingSkillPolicy ?? state.activeSkillSurface,
		);
		const settings = deps.getSettings();
		const cfg = settings.context.compaction;
		const autoEnabled = cfg?.auto !== false;
		const routeKey = JSON.stringify([
			agentRuntime.targetId,
			agentRuntime.runtimeId,
			agentRuntime.wireModelId,
			cfg?.model ?? null,
		]);
		if (routeKey !== autoCompactRouteKey) {
			autoCompactRouteKey = routeKey;
			shared.autoCompactFailures = 0;
			shared.summaryRearm = null;
		}
		// The re-checks after a free stage use the same reserve, so a stage that stops short of it does not re-arm.
		const route = routeCompaction(agentRuntime, settings);
		const economic = route.economic;
		const compactionThreshold = economic.threshold;
		const compactionWindow = economic.triggerWindow;
		const workingSetTarget = settings.context.workingSet.target * economic.fractionScale;
		const rearmBand = (summaryChars: number): number =>
			Math.max(0.08 * compactionWindow, 2 * Math.ceil(summaryChars / 4));
		const trigger: CompactionTrigger = triggerOverride ?? (force ? "force" : "auto");
		// S0 (SPEC §3.4): automatic and fit checkpoints on an uncached route, never a manual force or an unknown-window
		// overflow. It reads none of the summary's settings, so every exit below the trigger still runs it (§3.1).
		const supersededApplies =
			(!force || requiredFit) &&
			supersededStageApplies(agentRuntime.runtimeResolution) &&
			Boolean(deps.session?.current());
		let openedDecision: FoldDecision | null = null;
		const openDecision = (): FoldDecision => {
			if (openedDecision === null) {
				openedDecision = contextFold.beginDecision({
					// The portable-fallback resolution is forced on the operator's behalf; its pending prompt is not a submit (cf-q2 R1).
					checkpoint: foldCheckpointFor(trigger, providerFallbackReason === undefined ? pendingUserText : undefined),
					agentRuntime,
					sessionId: originSession,
				});
				foldDecision = openedDecision;
			}
			return openedDecision;
		};
		// The fields every fold stage shares; `superseded` stays explicit at each call.
		const foldInput = (session: SessionContract, estimate: LiveContextEstimate) => ({
			agentRuntime,
			decision: openDecision(),
			session,
			settings,
			compactionThreshold,
			estimate,
			beforeSnapshotId: shared.currentContextSnapshot?.snapshotId ?? null,
			trigger,
			originSession,
			pendingUserText,
			handoff,
			classify: classifyCall,
		});
		const stageRoute = {
			compactionWindow,
			workingSetTarget,
			shouldCompact: route.shouldCompact,
			triggerFraction: route.triggerFraction,
		};
		/** S0 alone, where the checkpoint goes no further: it commits once its floor is met, under the trigger too. */
		const supersededOnly = (estimate: LiveContextEstimate | null): false => {
			const session = deps.session;
			if (!session?.current()) return false;
			const current = estimate ?? liveContextEstimate(agentRuntime, pendingUserText);
			// A hold or a release states the context it left as it was; a commit's own figures take precedence.
			const settle = (): false => {
				openedDecision?.measure(current.tokens);
				return false;
			};
			if (!supersededApplies) return settle();
			// What this checkpoint was asked; an equal key plans the same record, so a declined one is not re-planned.
			const view = foldWorkingSet(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
			const key = sha256Json([
				state.activeUserTurnId || null,
				state.lastTurnId ?? null,
				[[...view.evicted.keys()], view.evictionEvents, view.lastEvictionTurnId, view.recalls],
				observeHistory(agentRuntime).digest(),
			]);
			if (key === supersededAttemptKey) return settle();
			const stage = contextFold.runEvictionStage({
				...foldInput(session, current),
				...stageRoute,
				requiredFit: false,
				structural: false,
				superseded: true,
			});
			if (!stage.committed) supersededAttemptKey = key;
			return settle();
		};
		if (!force && !autoEnabled) return supersededOnly(null);
		if (originSession !== undefined && shared.summaryRearmSeededFor !== originSession) {
			shared.summaryRearmSeededFor = originSession;
			const checkpoint = findLastEntry(activeEntries(), (entry) => entry.kind === "compactionSummary");
			if (shared.summaryRearm === null && checkpoint?.kind === "compactionSummary" && checkpoint.tokensAfter !== undefined)
				shared.summaryRearm = { tokensAfter: checkpoint.tokensAfter, band: rearmBand(checkpoint.summary.length) };
		}
		const pressureEstimate = force && !requiredFit ? null : liveContextEstimate(agentRuntime, pendingUserText);
		if (pressureEstimate && !requiredFit && !route.shouldCompact(pressureEstimate.tokens).shouldCompact)
			return supersededOnly(pressureEstimate);
		// Past the trigger, or forced: every stage this checkpoint reaches from here goes into its `context.fold` event.
		const decision = openDecision();
		if (pressureEstimate) decision.measure(pressureEstimate.tokens);
		// Paused or inside the rearm band, the paid summary waits; the free pre-summary stages below still run.
		const summaryHoldReason = (tokens: number): "paused" | "rearm_band" | null =>
			force
				? null
				: shared.autoCompactFailures >= AUTO_COMPACT_FAILURE_LIMIT
					? "paused"
					: triggerOverride !== "overflow" &&
							shared.summaryRearm !== null &&
							tokens < shared.summaryRearm.tokensAfter + shared.summaryRearm.band
						? "rearm_band"
						: null;
		// A held automatic eviction holds only its own stage until the context grows (C-3): the summary keeps its own
		// holds, and with the stage held it short-circuits here before an operation opens, as with the stage disabled.
		const workingSetHeld =
			pressureEstimate !== null &&
			!requiredFit &&
			settings.context.workingSet.enabled &&
			contextFold.autoEvictionHeld({
				agentRuntime,
				projectedTokens: pressureEstimate.tokens,
				contextWindow: economic.budgetWindow,
				rearmFraction: settings.context.workingSet.rearmFraction,
				pendingUserText,
			});
		const preSummaryStageAvailable =
			pressureEstimate !== null &&
			Boolean(deps.session?.current()) &&
			settings.context.workingSet.enabled &&
			!workingSetHeld;
		if (!force && !preSummaryStageAvailable) {
			const hold = summaryHoldReason(pressureEstimate?.tokens ?? 0);
			if (hold !== null) {
				if (workingSetHeld) decision.stage({ stage: "working_set", outcome: "held", reason: "rearm_band" });
				decision.stage({ stage: "llm_summary", outcome: "held", reason: hold });
				return supersededOnly(pressureEstimate);
			}
		}
		// The hysteresis band. A checkpoint runs before every request, so without
		// it a policy with unconditional rungs fires an event per step and
		// cold-starts the prefix cache each time. Inside the band the automatic
		// path does nothing at all, summary included; the overflow path still
		// forces a fit, and the request-fit admission remains the safety net. The
		// replay runner gates identically. It holds before the operation exists, so
		// a held checkpoint shows no rail activity and records no operation (#422).
		if (pressureEstimate && !requiredFit && deps.session?.current() && settings.context.workingSet.enabled) {
			let held = false;
			try {
				const entries = deps.readSessionEntries() ?? [];
				const view = foldWorkingSet(entries, state.lastTurnId ?? undefined);
				resolveWorkingSetPolicy(settings.context.workingSet.policy);
				held = withinRearmBand({
					projectedTokens: pressureEstimate.tokens,
					contextWindow: economic.budgetWindow,
					rearmFraction: settings.context.workingSet.rearmFraction,
					lastEvictionTokensAfter: view.lastEvictionTokensAfter,
				});
			} catch {
				// Safe to ignore here: the eviction stage repeats this read inside the
				// operation and surfaces the same error with its activity.
			}
			if (held) {
				decision.stage({ stage: "working_set", outcome: "held", reason: "rearm_band" });
				return supersededOnly(pressureEstimate);
			}
		}
		// Empty cuts are reusable only while their source and provider context
		// remain unchanged. Tools can grow the same user turn into a useful cut.
		const attemptKey =
			!force && activeAutoTurnId
				? sha256Json({
						turn: activeAutoTurnId,
						leaf: state.lastTurnId,
						entries: deps
							.readSessionEntries()
							.filter((entry) => entry.kind !== "custom" || entry.customType !== CONTEXT_OPERATION_CUSTOM_TYPE),
						context: {
							systemPrompt: engineInitialSystemPrompt(agentRuntime.agent),
							messages: agentRuntime.agent.state.messages.filter(
								(message) => message.role !== "system" || isHostPolicyMessage(message),
							),
							tools: agentRuntime.agent.state.tools,
							model: agentRuntime.agent.state.model,
							thinkingLevel: agentRuntime.agent.state.thinkingLevel,
						},
						pendingUserText,
						skillContextState,
						estimate: pressureEstimate,
						compaction: cfg,
						workingSet: settings.context.workingSet,
						output: settings.chat.maxOutputTokens,
					})
				: null;
		if (attemptKey && shared.emptyAutoCompactContextKey === attemptKey) return false;
		let preSummaryStageActed = false;
		// G1 from smoke pass 2: a short session generates all its pressure inside
		// the protection window, the non-destructive layer finds nothing, and the
		// destructive summary ran with nothing in the transcript saying eviction
		// was considered and declined. Held here and emitted only if a summary
		// actually follows.
		let evictionSkipNotice: string | null = null;
		const rememberEmptyAutomaticAttempt = (): void => {
			if (force || preSummaryStageActed || !attemptKey) return;
			shared.emptyAutoCompactContextKey = attemptKey;
			// The reducer was actually asked and found nothing. Record the request
			// it was asked about, so the pressure policy can suppress a repeat
			// advisory for that exact request and no other.
			shared.noUsefulCutBasisKey = liveBudgetInput(pendingUserText).reductionBasisKey;
		};

		compactionLifecycleTrigger = trigger;
		const operationCwd = process.cwd();
		compactionFacts = [];
		compactionTokens = undefined;
		compactionNotice = undefined;
		compactionConclusion = "No useful reduction available";
		let recordOutcome = true;
		compactionOperation = createContextOperation(
			{
				kind: "compaction",
				sessionId: originSession ?? null,
				cwd: operationCwd,
				origin: trigger === "force" ? "operator" : "automatic",
				reason: trigger === "auto" ? "automatic threshold" : trigger === "overflow" ? "request overflow" : "manual request",
			},
			(event) => {
				if (
					originSession !== deps.session?.current()?.id ||
					originNavigation !== shared.navigationEpoch ||
					operationCwd !== process.cwd()
				)
					return;
				deps.bus?.emit("context.activity_changed", event);
				if (recordOutcome && event.operation?.outcome && originSession && deps.session)
					deps.session.appendEntry({
						kind: "custom",
						customType: CONTEXT_OPERATION_CUSTOM_TYPE,
						parentTurnId: state.lastTurnId,
						data: event.operation,
					});
			},
		);
		compactionOperation.start("compact", `${compactionOperation.operation.reason}; preparing context`);
		// Give the host a render opportunity before route discovery or the reducer awaits.
		await new Promise<void>((resolve) => setImmediate(resolve));
		signal?.throwIfAborted();
		if (
			originSession !== deps.session?.current()?.id ||
			originNavigation !== shared.navigationEpoch ||
			operationCwd !== process.cwd()
		)
			throw new Error("Context ownership changed before compaction.");

		if (pressureEstimate) {
			const estimate = pressureEstimate;
			const session = deps.session;

			if (session?.current()) {
				if (workingSetHeld) decision.stage({ stage: "working_set", outcome: "held", reason: "rearm_band" });
				const stage = contextFold.runEvictionStage({
					...foldInput(session, estimate),
					...stageRoute,
					requiredFit,
					structural: !workingSetHeld,
					superseded: supersededApplies,
				});
				if (stage.acted) preSummaryStageActed = true;
				else if (stage.committed) compactionConclusion = "superseded tool results evicted";
				if (stage.fit) return true;
				evictionSkipNotice = stage.skipNotice;
			}
		}

		const heldTokens = liveContextEstimate(agentRuntime, pendingUserText).tokens;
		decision.measure(heldTokens);
		const hold = summaryHoldReason(heldTokens);
		if (hold !== null) {
			decision.stage({ stage: "llm_summary", outcome: "held", reason: hold });
			if (!preSummaryStageActed) {
				compactionConclusion =
					shared.autoCompactFailures >= AUTO_COMPACT_FAILURE_LIMIT
						? "automatic summaries paused after repeated failures"
						: "summary held until context grows past the last summary";
				// A held checkpoint that freed nothing settles the rail but writes no session entry;
				// otherwise every checkpoint while paused or inside the band appends an "unchanged" record.
				if (compactionFacts.length === 0) recordOutcome = false;
			}
			return preSummaryStageActed;
		}
		if (!deps.autoCompact) {
			decision.stage({ stage: "llm_summary", outcome: "none", reason: "unavailable" });
			rememberEmptyAutomaticAttempt();
			return false;
		}
		let summaryLifecycleStarted = false;
		let summaryReportedAt = 0;
		// Summary calls between entering beforeSummaryCall and its end; a split fold's two summaries may overlap (MD10).
		let summaryEntriesOpen = 0;
		const startSummaryLifecycle = (): void => {
			// Set first, so a concurrent entry never starts the lifecycle twice.
			summaryLifecycleStarted = true;
			middleware.fireCompactionHook("llm_summary", trigger);
			emitCompactionActivity("started", "summarizing session history", "summarize");
		};
		// Started lazily, in beforeSummaryCall, for forced runs too. Starting it here
		// made a forced compaction with no older history fire the llm_summary hook
		// and end its activity rail on a success tick labelled complete (p8/B2).
		// Said in beforeSummaryCall, not earlier or after: the operator is about to wait
		// on a destructive stage, and the reason the cheap one was skipped is only
		// useful ahead of it. A pass that skips the summary says nothing (bt3 m2a-3).
		let result: CompactResult | null = null;
		let summaryRecordId: string | undefined;
		// Compare full runtime estimates on both sides. The current snapshot and
		// result.tokensBefore may instead carry provider-calibrated history usage.
		const snapshotMetadata =
			shared.currentContextSnapshot &&
			shared.currentContextSnapshot.systemPrompt === engineInitialSystemPrompt(agentRuntime.agent)
				? {
						promptSegments: shared.currentContextSnapshot.promptSegments,
						promptHash: shared.currentContextSnapshot.promptHash,
					}
				: {};
		const preCompactSnapshot = captureRuntimeContextSnapshot(
			agentRuntime,
			state.activeUserTurnId || "compaction",
			compactionThreshold,
			snapshotMetadata,
		);
		// The footer's own figure, taken before the summary replaces the messages,
		// so the transcript row and the footer name one number (p6/U1: the
		// snapshot said 5590 beside a footer that read 28.6K).
		const footerTokensBefore = liveContextEstimate(agentRuntime, pendingUserText).tokens;
		let budget:
			| Pick<
					CompactInput,
					| "providerCompaction"
					| "livePrefix"
					| "providerFallbackReason"
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
					| "chargeTurnId"
			  >
			| undefined = skillContextState !== undefined ? { skillContextState } : undefined;
		if (pendingUserText !== undefined && state.activeUserTurnId === null && pendingUserIsOperator)
			budget = { ...budget, pendingOperatorTurn: true };
		// The calls are charged to the turn they serve: the pending prompt's, the open one, or, for a /compact between
		// turns, the latest. Ledger order alone charged that last case to the next turn, and a discarded run by time.
		const chargeTurnId =
			pendingUserTurnId ??
			state.activeUserTurnId ??
			(pendingUserText === undefined
				? findLastEntry(activeEntries(), (entry) => entry.kind === "message" && entry.role === "user")?.turnId
				: undefined);
		if (chargeTurnId !== undefined) budget = { ...budget, chargeTurnId };
		// A summary written on this route shares its small window with the history it reads (bt-18).
		const summaryCap = summaryOnChatRoute(agentRuntime, settings.context.compaction.model)
			? resolveSummaryOutputCap(agentRuntime)
			: undefined;
		if (summaryCap !== undefined) budget = { ...budget, summaryOutputCap: summaryCap };
		if (useRequestBudget) {
			const estimate = liveContextEstimate(agentRuntime, pendingUserText);
			const output = resolveFitOutputReserve(agentRuntime, estimate.tokens);
			const inputTarget = knownWindow
				? Math.min(compactionWindow * compactionThreshold, estimate.contextWindow - output)
				: economic.ceilingTokens;
			const staticTokens = estimate.breakdown.systemPromptTokens + estimate.breakdown.toolSchemaTokens;
			const calibration = Math.max(
				0,
				estimate.tokens - staticTokens - estimate.breakdown.messageTokens - estimate.breakdown.pendingUserTokens,
			);
			// History space is measured below the automatic trigger, not the request-fit target: a reasoning route's
			// summary reserve can put the trigger far below that target, and a suffix sized against the target then
			// kept nearly all history, so each summary landed just under the trigger and the next turn re-fired it
			// (bt-18). The suffix keeps 30% of that space and the checkpoint takes about as much, so the cut lands
			// near 60% and leaves 40% for growth before the next summary. Without room below the trigger the
			// request-fit target still sizes the cut. The cut remains structural, so the continuation guard verifies it.
			const fixedTokens = staticTokens + estimate.breakdown.pendingUserTokens + calibration;
			const belowTrigger = Math.min(inputTarget, route.triggerTokens(estimate.tokens)) - fixedTokens;
			const historyBudget = belowTrigger > 0 ? belowTrigger : inputTarget - fixedTokens;
			// A cumulative checkpoint grows each cycle, so a fixed 30% suffix let the cut creep toward the trigger. The
			// suffix gives back what the current checkpoint takes past its 30%, down to 10%, to hold the cut near 60%.
			// It cannot drop below the newest tool batch, so the summary request also names the room 60% leaves it.
			const checkpoint = findLastEntry(activeEntries(), (entry) => entry.kind === "compactionSummary");
			const checkpointShare = checkpoint && historyBudget > 0 ? estimateTokens(checkpoint) / historyBudget : 0.3;
			const suffixShare = Math.min(0.3, Math.max(0.1, 0.6 - checkpointShare));
			budget = {
				...budget,
				keepRecentTokens: Math.min(DEFAULT_KEEP_RECENT_TOKENS, Math.max(1, Math.floor(historyBudget * suffixShare))),
				retainedTargetTokens: Math.floor(historyBudget * 0.6),
				...(requiredFit ? { requireFit: true } : {}),
				...(activeAutoTurnId ? { preserveUserTurnId: activeAutoTurnId } : {}),
			};
		}
		let summarySignal = shared.compactionController?.signal;
		const automaticSummary = trigger === "auto" && !force;
		// An unchanged or summary-less settle still names the measured context
		// and the specific reason nothing was reduced (#422).
		const settleWithoutSummary = (reason: string | null): void => {
			if (reason !== null) compactionConclusion = preSummaryStageActed ? `${compactionConclusion}; ${reason}` : reason;
			// An eviction earlier in this pass reported its own figures, and a settle without a summary changed nothing after it.
			compactionTokens ??= {
				before: footerTokensBefore,
				after: liveContextEstimate(agentRuntime, pendingUserText).tokens,
				basis: "runtime-estimate",
			};
			decision.measure(compactionTokens.after);
		};
		// Like a held checkpoint, a pass that made no call and changed nothing writes no session entry: a
		// `session compact` that reports `compacted: false` leaves the ledger as it was (CLI audit 10).
		const skipUnpaidNoChangeRecord = (): void => {
			if (!preSummaryStageActed && compactionFacts.length === 0) recordOutcome = false;
		};
		const countAutomaticFailure = (): void => {
			if (!force && ++shared.autoCompactFailures === AUTO_COMPACT_FAILURE_LIMIT)
				deps.emitNotice(
					`automatic compaction paused after ${AUTO_COMPACT_FAILURE_LIMIT} consecutive failures; run /compact to retry`,
				);
		};
		// A refused or failed overflow summary does not end the turn: the eviction stage runs once more with only the
		// newest step protected, and the turn goes on when that alone fits the request, with no summary written.
		const fitWithoutSummary = (error: unknown): boolean => {
			const session = deps.session;
			if (!requiredFit || !session?.current() || !settings.context.workingSet.enabled) return false;
			const workingSet = { ...settings.context.workingSet, protectLastSteps: 1 };
			let fit = false;
			try {
				fit = contextFold.runEvictionStage({
					...foldInput(session, liveContextEstimate(agentRuntime, pendingUserText)),
					...stageRoute,
					settings: { ...settings, context: { ...settings.context, workingSet } },
					requiredFit: true,
					summaryFailed: true,
					structural: true,
					superseded: false,
				}).fit;
			} catch {
				return false;
			}
			if (!fit) return false;
			const reason = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/u, "");
			deps.emitNotice(
				`[PanCode] overflow summary failed (${reason}); the request was fitted by evicting older observations instead, without a summary.`,
			);
			settleWithoutSummary("summary failed; request fitted by eviction only");
			return true;
		};
		try {
			result = await compactionTrigger.fire(async () => {
				summarySignal = signal;
				summarySignal?.throwIfAborted();
				return (
					(await deps.autoCompact?.(instructions, trigger, {
						...budget,
						...handoff,
						...(providerFallbackReason ? { providerFallbackReason, providerReplayFallback: true } : {}),
						...(settings.context.compaction.provider === "native" &&
						agentRuntime.runtimeId === "openai-codex" &&
						providerFallbackReason === undefined
							? {
									providerCompaction: async (observe: CompactInput["onCall"], callTelemetry?: CallMessageObserver) => {
										// A fresh process has history before its first prompt compile; native must use the main prefix (#423).
										await shared.controller.ensureSessionPrompt(agentRuntime, false, undefined, true);
										syncCodexConfiguration(agentRuntime);
										const timestamp = new Date().toISOString();
										const sessionId = deps.session?.current()?.id;
										return compactEngineCodex(agentRuntime.agent, {
											...(callTelemetry ? { callTelemetry } : {}),
											...(sessionId ? { sessionId } : {}),
											...(summarySignal ? { signal: summarySignal } : {}),
											onUsage: (usage, outcome, failure) =>
												observe?.({ usage, outcome, timestamp, ...(failure ? { failure } : {}) }),
										});
									},
								}
							: {}),
						// T4: the summary may ride the cached prefix of the last request this runtime sent.
						livePrefix: async (prefixSignal?: AbortSignal) => {
							const last = state.lastMainRequest;
							const prepared = await prepareInPrefixSummary(
								agentRuntime.agent,
								last?.runtime === agentRuntime ? last.record : undefined,
								{ free: agentRuntime.runtimeResolution.pricedBy === "free" },
								prefixSignal,
							);
							if (typeof prepared === "string") return null;
							// The live request keeps the turn's thinking, so its output cap is sized for it (CTX-3).
							const thinkingLevel = agentRuntime.runtimeResolution.effectiveThinkingLevel;
							return thinkingLevel !== undefined ? { ...prepared, thinkingLevel } : prepared;
						},
						...(summarySignal ? { signal: summarySignal } : {}),
						...(automaticSummary && shared.noGainSummaryDigest !== null
							? { skipSummaryDigest: shared.noGainSummaryDigest }
							: {}),
						checkpointTokenFigures: (entry) => {
							// The figures are taken just before the append, so the last entry asked about is the one written.
							summaryRecordId = entry.turnId;
							const stream = deps.readSessionEntries?.() ?? [];
							const replayOptions = {
								...(state.lastTurnId ? { activeLeafTurnId: state.lastTurnId } : {}),
								continuity: continuityContextFromSession(deps.session),
							};
							const messages = buildModelReplayAgentMessagesFromTurns(
								[...stream, { ...entry, timestamp: new Date().toISOString() }],
								replayOptions,
							);
							const tokensAfter = liveContextEstimate(agentRuntime, pendingUserText, messages).tokens;
							// Both sides on one estimate (CLI-P4): the live figure, or the replaced replay at the route's ratio when the
							// runtime does not hold that history (a reset), whichever is larger.
							const replayBefore = liveContextEstimate(
								agentRuntime,
								pendingUserText,
								buildModelReplayAgentMessagesFromTurns(stream, replayOptions),
							).tokens;
							const triggerTokens = route.triggerTokens(tokensAfter);
							// A cut that still sits above the trigger states by how much, never as negative headroom (CTX-2).
							return {
								tokensBefore: Math.max(footerTokensBefore, replayBefore),
								tokensAfter,
								headroomTokens: Math.max(0, triggerTokens - tokensAfter),
								...(tokensAfter > triggerTokens ? { overTriggerTokens: tokensAfter - triggerTokens } : {}),
								fitReserveTokens: resolveFitOutputReserve(agentRuntime, tokensAfter),
							};
						},
						beforeSummaryCall: async (hold, signal) => {
							// An entry that overlaps another keeps that one's progress line and pacing.
							const overlapping = summaryEntriesOpen > 0;
							summaryEntriesOpen += 1;
							try {
								await (handoff?.beforeSummaryCall ?? budget?.beforeSummaryCall)?.(hold, signal);
							} finally {
								summaryEntriesOpen -= 1;
							}
							if (evictionSkipNotice) deps.emitNotice(evictionSkipNotice, "info", CONTEXT_STATUS_NOTICE_KEY);
							evictionSkipNotice = null;
							if (!summaryLifecycleStarted) startSummaryLifecycle();
							if (overlapping) return;
							// Nothing is measurable while the summarizer reads, so the rail
							// stays indeterminate and says what it is waiting for.
							summaryReportedAt = 0;
							emitCompactionActivity("running", `reading ${footerTokens(footerTokensBefore)} tokens of history`, "summarize", {
								unit: "tokens",
							});
						},
						// Once the summary streams, its written size is the scale: against
						// the request's output cap when it sends one, as a count otherwise.
						onSummaryOutput: ({ tokens, limit }) => {
							const now = Date.now();
							if (now - summaryReportedAt < SUMMARY_PROGRESS_INTERVAL_MS) return;
							summaryReportedAt = now;
							emitCompactionActivity(
								"running",
								`summarizing ${footerTokens(footerTokensBefore)} tokens of history`,
								"summarize",
								{ current: tokens, ...(limit !== undefined ? { total: limit } : {}), unit: "tokens" },
							);
						},
					})) ?? null
				);
			});
		} catch (error) {
			decision.stage({ stage: "llm_summary", outcome: "failed", reason: "error" });
			if (!summaryLifecycleStarted) startSummaryLifecycle();
			emitCompactionActivity("failed", compactionFailureMessage(error));
			summarySignal?.throwIfAborted();
			countAutomaticFailure();
			if (fitWithoutSummary(error)) return true;
			throw error;
		}
		if (result?.noGain) decision.stage({ stage: "llm_summary", outcome: "none", reason: "no_gain" });
		else if (!result || result.summary.length === 0)
			decision.stage({
				stage: "llm_summary",
				outcome: "none",
				reason: EMPTY_SUMMARY[result?.emptyReason ?? "nothing-to-summarize"][0],
			});
		else {
			const recordId = result.checkpointId ?? summaryRecordId;
			decision.stage({
				stage: "llm_summary",
				outcome: "committed",
				reason: "summarized",
				...(recordId !== undefined ? { recordId } : {}),
			});
		}
		if (
			originSession !== deps.session?.current()?.id ||
			originNavigation !== shared.navigationEpoch ||
			operationCwd !== process.cwd()
		)
			throw new Error("Context ownership changed during compaction.");
		// The summarizer checks the signal before it saves, so a summary in hand is already on disk. A stop arriving now
		// would report `cancelled` over a changed context and leave the runtime replaying the old history (J2-F04).
		if (result === null || result.summary.length === 0) summarySignal?.throwIfAborted();
		if (result?.providerFallbackReason)
			deps.emitNotice(
				`Native compaction used PanCode's portable path: ${result.providerFallbackReason}.`,
				"info",
				HOST_STATUS_NOTICE_KEY,
			);
		if (result?.noGain) {
			shared.lastCompactionNoGain = true;
			// Remembered even when eviction acted in this pass: the summary request
			// is what repeats, and eviction already changed what it would read.
			if (automaticSummary && result.summaryDigest !== undefined) shared.noGainSummaryDigest = result.summaryDigest;
			// A span below the summary room was skipped before any call, so nothing was paid or discarded (bt-47 cf1j-d).
			if (result.emptyReason === undefined) {
				deps.emitNotice(
					"compaction would not reduce context; checkpoint discarded (usage recorded)",
					"info",
					CONTEXT_STATUS_NOTICE_KEY,
				);
				// A paid call that changed nothing is a failure toward the pause.
				countAutomaticFailure();
			}
			settleWithoutSummary(
				result.emptyReason === undefined
					? "summary would not reduce context (usage recorded)"
					: "history outside the kept turns is smaller than a summary; no call made",
			);
			if (result.emptyReason !== undefined) skipUnpaidNoChangeRecord();
			rememberEmptyAutomaticAttempt();
			return false;
		}
		if (!result || result.summary.length === 0) {
			if (summaryLifecycleStarted) {
				emitCompactionActivity("completed", "nothing to compact");
				settleWithoutSummary(null);
			} else {
				settleWithoutSummary(EMPTY_SUMMARY[result?.emptyReason ?? "nothing-to-summarize"][1]);
				skipUnpaidNoChangeRecord();
				rememberEmptyAutomaticAttempt();
			}
			return false;
		}
		if (!summaryLifecycleStarted) startSummaryLifecycle();
		emitCompactionActivity("running", "saving checkpoint and rebuilding context", "state");
		// The flow names the checkpoint it confirmed; a compactor that does not is read back from the ledger.
		const checkpointId =
			result.checkpointId ??
			findLastEntry(deps.readSessionEntries?.() ?? [], (entry) => entry.kind === "compactionSummary")?.turnId;
		if (checkpointId === undefined) throw new Error("compaction returned a summary but no checkpoint is on the ledger");

		if (deps.memoryCommitBridge && !handoff && deps.session?.flushAppends) {
			deps.session.flushAppends();
			await deps.session.checkpoint("context-summary");
			if (originSession !== deps.session.current()?.id || originNavigation !== shared.navigationEpoch)
				throw new Error("Context ownership changed during checkpoint.");
			shared.notifyMemoryCommit(checkpointId, "summary", "summarized");
		}

		const { tokensBefore, tokensAfter } = await contextFold.publishCheckpoint({
			checkpointId,
			kind: "summary",
			agentRuntime,
			before: preCompactSnapshot,
			threshold: compactionThreshold,
			snapshotMetadata,
			tokensBefore: footerTokensBefore,
			pendingUserText,
			trigger,
			sessionId: originSession,
		});
		decision.committed({ tokensBefore, tokensAfter });
		// The reducer reports selected ledger rows, not just message rows.
		compactionFacts.push({ kind: "summarized", unit: "entries", count: result.messagesSummarized });
		compactionTokens = { before: tokensBefore, after: tokensAfter, basis: "runtime-estimate" };
		emitCompactionActivity("completed", "context compaction complete");
		shared.autoCompactFailures = 0;
		shared.noGainSummaryDigest = null;
		shared.summaryRearm = { tokensAfter, band: rearmBand(result.summary.length) };

		compactionNotice = renderCompactionSummaryLine({
			messagesSummarized: result.conversationMessagesSummarized,
			summaryChars: result.summary.length,
			tokensBefore,
			tokensAfter,
			isSplitTurn: result.isSplitTurn,
		});
		deps.emitNotice(compactionNotice, "info", CONTEXT_STATUS_NOTICE_KEY);
		// The requireFit summary cleared what the fold could not: the next main request pins the same A4 count.
		if (requiredFit) pinOverflowFit(agentRuntime, pendingUserText);
		refreshLiveBudget(pendingUserText);
		return true;
	};

	let reductionInFlight: Promise<boolean> | null = null;
	/** The running reduction's fold decision, closed once the reduction settles. */
	let foldDecision: FoldDecision | null = null;
	const runAutoCompact: TurnContext["runAutoCompact"] = (...args) => {
		if (reductionInFlight) {
			if (args[7]) return Promise.reject(new Error("Another context reduction is already in progress."));
			return reductionInFlight;
		}
		const controller = new AbortController();
		shared.compactionController = controller;
		const operationArgs: Parameters<TurnContext["runAutoCompact"]> = [...args];
		operationArgs[6] = args[6] ? AbortSignal.any([args[6], controller.signal]) : controller.signal;
		shared.lastCompactionCardSettled = false;
		foldDecision = null;
		shared.reductionPendingText = args[4];
		const operation = performAutoCompact(...operationArgs)
			.then(
				(changed) => {
					const outcome = changed || compactionFacts.length > 0 ? "completed" : "unchanged";
					compactionOperation?.finish(outcome, compactionConclusion, {
						facts: compactionFacts,
						...(compactionTokens ? { tokens: compactionTokens } : {}),
						...(compactionNotice !== undefined ? { notice: compactionNotice } : {}),
					});
					if (compactionLifecycleStarted)
						deps.bus?.emit("compaction.ended", { trigger: compactionLifecycleTrigger, at: Date.now(), outcome });
					return changed;
				},
				(error: unknown) => {
					const outcome =
						operationArgs[6]?.aborted || (error instanceof Error && error.name === "AbortError") ? "cancelled" : "failed";
					// A stop is the operator's own choice, not a fault, and what it left behind is the fact they need.
					// The card is the one place a stop is reported, so it carries the size the context stayed at.
					const view = budgetProducer.current();
					const at = view?.inputTokens != null ? ` at ${footerTokens(view.inputTokens)} tokens` : " as it was";
					const conclusion =
						outcome === "cancelled"
							? compactionFacts.length === 0
								? `nothing saved; context still${at.replace(/^ at/u, "")}`
								: "cancelled before the summary was saved"
							: compactionFailureMessage(error);
					shared.lastCompactionCardSettled = compactionOperation !== null && outcome === "cancelled";
					compactionOperation?.finish(outcome, conclusion, {
						facts: compactionFacts,
						...(compactionTokens ? { tokens: compactionTokens } : {}),
					});
					if (compactionLifecycleStarted)
						deps.bus?.emit("compaction.ended", { trigger: compactionLifecycleTrigger, at: Date.now(), outcome });
					throw error;
				},
			)
			.finally(() => {
				shared.reductionPendingText = undefined;
				foldDecision?.close();
				foldDecision = null;
				compactionOperation = null;
				compactionLifecycleStarted = false;
				if (shared.compactionController === controller) shared.compactionController = null;
			});
		reductionInFlight = operation;
		void operation
			.finally(() => {
				if (reductionInFlight === operation) reductionInFlight = null;
			})
			.catch(() => {});
		return operation;
	};

	/**
	 * A step-boundary checkpoint (WTF-P 0.8.3 C5): a compaction summary the host
	 * writes from the previous checkpoint and `lead` with no summarizer call, cutting every earlier message
	 * from replay. The ledger keeps them, so resume, recall and token
	 * attribution read the same history the next request starts from. After the
	 * write it does what a native checkpoint does: the on_compaction hook and
	 * the compaction lifecycle carry trigger `step`, the entry carries the
	 * verified skill context, the previous checkpoint's preserved request and
	 * the continuity payload, which replay puts
	 * right after the summary, and the memory bridge learns of the commit, so
	 * its restoration rides this turn's tail.
	 */
	const runStepCheckpoint: TurnContext["runStepCheckpoint"] = async (agentRuntime, lead, pendingSkillPolicy) => {
		if (reductionInFlight !== null || !deps.readSessionEntries || !deps.session?.current()) return false;
		const sessionId = deps.session.current()?.id;
		const active = activeEntries();
		const visible = compactionCut(active).visible;
		const messagesSummarized = visible.filter((entry) => entry.kind === "message").length;
		const cutCursor = findLastEntry(active, (entry) => entry.kind === "message")?.turnId;
		if (messagesSummarized === 0 || cutCursor === undefined) return false;
		// Throws when a skill an earlier checkpoint carried no longer verifies, as native compaction does.
		const skills = checkpointSkillContext(
			active,
			active,
			mainSkillContextState(active, pendingSkillPolicy ?? state.currentPendingSkillPolicy ?? state.activeSkillSurface),
		);
		// A native checkpoint keeps a skill turn it cannot carry as raw messages; this one keeps none, so it does not cut.
		if (skills.protectedStart !== null) return false;
		const continuity = continuityContextFromSession(deps.session);
		const continuityCarry = checkpointContinuityCarry({ entries: active, ...continuity });
		deps.bus?.emit("compaction.started", { trigger: "step", at: Date.now() });
		const threshold = deps.getSettings().context.compaction?.threshold ?? null;
		const before = captureRuntimeContextSnapshot(agentRuntime, state.activeUserTurnId || "compaction", threshold);
		const tokensBefore = liveContextEstimate(agentRuntime).tokens;
		middleware.fireCompactionHook("step_checkpoint", "step", tokensBefore);
		const entry: Omit<CompactionSummaryEntry, "timestamp"> = {
			kind: "compactionSummary",
			turnId: randomUUID(),
			parentTurnId: cutCursor,
			...hostCheckpoint(active, lead, process.cwd()),
			...(skills.skillContext ? { skillContext: skills.skillContext } : {}),
			...(continuityCarry === null ? {} : { continuity: continuityCarry }),
			tokensBefore,
			firstKeptTurnId: "",
			messagesSummarized,
			isSplitTurn: false,
			trigger: "step",
		};
		entry.tokensAfter = liveContextEstimate(
			agentRuntime,
			undefined,
			buildModelReplayAgentMessagesFromTurns([...active, { ...entry, timestamp: new Date().toISOString() }], {
				activeLeafTurnId: cutCursor,
				continuity,
			}),
		).tokens;
		const decision = contextFold.beginDecision({ checkpoint: "step", agentRuntime, sessionId });
		decision.measure(tokensBefore);
		try {
			deps.session.appendEntry(entry);
			deps.session.flushAppends?.();
		} catch (error) {
			// A write may reach the ledger before its caller throws: the checkpoint id decides, as it does for a summary.
			if (!ledgerHoldsCheckpoint(deps.readSessionEntries(), entry.turnId)) {
				decision.stage({ stage: "step_checkpoint", outcome: "failed", reason: "error" });
				deps.bus?.emit("compaction.ended", { trigger: "step", at: Date.now(), outcome: "failed" });
				decision.close();
				throw error;
			}
		}
		decision.stage({ stage: "step_checkpoint", outcome: "committed", reason: "step_boundary", recordId: entry.turnId });
		try {
			// The entry carries no memory receipt, so nothing waits on a durable session checkpoint before memory hears of it.
			if (deps.memoryCommitBridge) shared.notifyMemoryCommit(entry.turnId, "summary", "summarized");
			const published = await contextFold.publishCheckpoint({
				checkpointId: entry.turnId,
				kind: "step",
				agentRuntime,
				before,
				threshold,
				tokensBefore,
				pendingUserText: undefined,
				trigger: "step",
				sessionId,
			});
			decision.committed({ tokensBefore: published.tokensBefore, tokensAfter: published.tokensAfter });
			// Ended last: its subscriber restarts the cache comparison for the new context generation.
			deps.bus?.emit("compaction.ended", { trigger: "step", at: Date.now(), outcome: "completed" });
		} finally {
			decision.close();
		}
		refreshLiveBudget();
		return true;
	};
	return { contextFold, refreshAgentMessagesFromSession, runAutoCompact, runStepCheckpoint };
}
