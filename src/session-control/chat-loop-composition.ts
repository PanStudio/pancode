// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { stripPlanCloseOptions } from "../core/plan-request.js";
import { effectiveToolCall } from "../core/tool-surface.js";
import { createRunCapCounter } from "../core/turn-constraints.js";
import { requestFits } from "../domains/context/budget/request-fit.js";
import { withOperatorSessionNotes } from "../domains/memory/index.js";
import { acceptsImageInput, runtimeTargetSnapshot } from "../domains/providers/index.js";
import { estimateAgentMessageTokens } from "../domains/session/context-accounting.js";
import { createContinuityPersistencePorts } from "../domains/session/continuity/ports.js";
import { continuityReplayText, resolveContinuityProjection } from "../domains/session/continuity/projection.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { activePath } from "../domains/session/tree/active-path.js";
import { cacheKeepalivePromptTokens } from "../engine/cache-keepalive.js";
import { countImageBlocks } from "../engine/image-context.js";
import type { MainRequestRecord } from "../engine/in-prefix-summary.js";
import type { AgentEvent, AgentMessage, EngineModel } from "../engine/types.js";
import type { TurnFailureRecord } from "../lib/turn-control/outcome.js";
import { resolveSessionTools } from "../tools/agent-tools.js";
import { isGatewayChain } from "../tools/gateway-display.js";
import { requestCursorOf } from "./attempt-receipt.js";
import type { ChatLoopEvent, RouteMoveFit, RouteMoveWait } from "./chat-loop.js";
import {
	explainInterruptedAssistant,
	isThinkingOnlyLengthStop,
	nameMissingCredentialRemedy,
	terminalFailureFromAssistantMessage,
	toolSignatureFromState,
} from "./chat-loop-messages.js";
import type { ChatLoopScope } from "./chat-loop-scope.js";
import { coldCacheNoticeText } from "./cold-reasons.js";
import { ContinuityController } from "./continuity-controller.js";
import { createHostInserts } from "./host-inserts.js";
import { createMessagePath } from "./message-path.js";
import { continuityContextFromSession } from "./model-session-replay.js";
import { createOperatorMemory } from "./operator-memory.js";
import { resolveFitOutputReserve } from "./output-reserve.js";
import { repetitionRecoveryForecast, repetitionRecoveryStage } from "./repetition-detector.js";
import { createSteerInterrupter } from "./steer-interrupt.js";
import { compactCommandHint } from "./surface-hints.js";
import { createTurnContext } from "./turn-context.js";
import { createTurnMiddleware } from "./turn-middleware.js";
import { createTurnOutcomeCollector } from "./turn-outcome-collector.js";
import { createTurnPersistence } from "./turn-persistence.js";
import { createTurnQueues, heldQueueNotice } from "./turn-queues.js";
import { createTurnRecovery, type MovedRoute, type RetryForecast, rewriteStallAbortMessage } from "./turn-recovery.js";
import { createTurnRuntime } from "./turn-runtime.js";
import type { AssistantDeltaEvent } from "./turn-runtime-types.js";
import type { AgentRuntime, ChatLoopCompositionState, ChatLoopTarget } from "./turn-state.js";

/** The chat loop's module composition: builds the turn modules over the shared state and returns them. */
export function createChatLoopComposition(loop: ChatLoopScope, state: ChatLoopCompositionState) {
	const {
		createAgent,
		currentToolInvokeOptions,
		deps,
		emit,
		emitFooterNotice,
		emitNotice,
		headlessObservation,
		middlewareToolChoice,
		missingOutputs,
		noteTurnControlCollection,
		retrySettings,
		toolStartTimes,
	} = loop;
	// --- module composition -------------------------------------------------

	const messagePath = createMessagePath({
		sessionId: () => deps.session?.current()?.id ?? null,
		turnId: () => state.activeUserTurnId ?? state.lastTurnId ?? null,
	});
	const steerInterrupter = createSteerInterrupter({
		pendingSteerSince: () => {
			const waiting = queues
				.entries()
				.filter((entry) => entry.kind === "steer" && entry.constraints === undefined)
				.map((entry) => entry.enqueuedAt);
			return waiting.length === 0 ? null : Math.min(...waiting);
		},
		onInterrupt: (toolName, graceMs) =>
			emitNotice(
				`[PanCode] a queued steer ended the running ${toolName} call after ${Math.round(graceMs / 1000)}s; the model gets its partial output, then the steer.`,
			),
		...(deps.steerInterruptGraceMs !== undefined ? { graceMs: deps.steerInterruptGraceMs } : {}),
	});
	const queues = createTurnQueues({
		state,
		emitQueueUpdateEvent: (messages) => emit({ type: "queue_update", messages }),
		emitQueueHeld: (count) =>
			emit({ type: "notice", level: "info", surface: "transcript", text: heldQueueNotice(count), heldQueue: { count } }),
		emitQueueDropped: (texts) =>
			emit({
				type: "notice",
				level: "warning",
				surface: "transcript",
				text: `[PanCode] the session changed; not sent: ${texts.join(" | ")}`,
				queueDropped: { texts },
			}),
		emitQueuedUserTurn: (entry) =>
			emit({
				type: "queued_user_turn",
				text: entry.text,
				kind: entry.kind,
				...(entry.display ? { display: entry.display } : {}),
				...(entry.origin !== undefined ? { origin: entry.origin } : {}),
			}),
		emitNotice,
		// The loop's own resubmits (stranded steers, continuation requests) run
		// from submit's finally and bypass the admission gate: an interrupt that
		// holds the gate while awaiting that same run would otherwise deadlock.
		submit: (text, options) => loop.submitTracked(text, options),
		onEvent: (event) => {
			if (event.type === "delivered") loop.operatorSpokeAt = Date.now();
			messagePath.queueEvent(event);
			steerInterrupter.poke();
		},
	});

	const hostInserts = createHostInserts({
		session: deps.session,
		readSessionEntries: deps.readSessionEntries,
		leaf: () => state.lastTurnId,
	});
	const middleware = createTurnMiddleware({
		memoryContentGuard: deps.memoryCommitBridge?.isContentCurrent,
		hostInserts,
		state,
		middleware: deps.middleware,
		toolRegistry: deps.toolRegistry,
		session: deps.session,
		middlewareToolChoice,
		emitNotice: (text, level, source) => emitNotice(text, level, undefined, undefined, source),
		emitFooterNotice,
		bus: deps.bus,
		stepTurnEnd: () => loop.stepTurnEnd(),
		hostCompletionFacts: () => [
			...(headlessObservation?.stopped() === true ? (["observation_budget"] as const) : []),
			...(deps.hostCompletionFacts?.() ?? []),
		],
		missingOutputs,
		suppressFirings: (firingIds) => outcomeCollector.suppressFirings(firingIds),
		queueHostMessage: (text, source, rule) => queues.queueHostMessage(text, source, rule),
	});
	// A reminder an after_tool rule emits for this session's call rides the next tool-batch boundary (X6).
	const detachBoundaryReminders = deps.toolRegistry?.onToolBoundaryReminders?.((reminders, input) => {
		if (input.sessionId === undefined || input.sessionId === deps.session?.current()?.id)
			middleware.applyToolBoundaryReminders(reminders);
	});

	try {
		// The one deferred reminder producer is task memory, and the one deferred notice producer is the watchdog.
		deps.registerDeferredReminderSink?.((message, isCurrent) =>
			middleware.injectDeferredReminder(message, "advisory", isCurrent, "memory"),
		);
		deps.registerDeferredNoticeSink?.((text) => middleware.emitDeferredNotice(text, "warning", "watchdog"));
	} catch {
		// A background observer losing its delivery path must not stop the loop
		// from starting; it simply stays silent.
	}
	const operatorMemory = createOperatorMemory({
		store: deps.operatorMemory,
		session: deps.session,
		parentTurnId: () => state.lastTurnId,
		headless: deps.headless === true,
		emit: (report) =>
			emit({
				type: "notice",
				level: report.level,
				surface: "transcript",
				text: report.text,
				...(report.chip ? { memory: report.chip } : {}),
			}),
	});
	/**
	 * The continuity fold both live-budget fields read. A publication asks for both at once, so they share one
	 * resolution at one clock reading. `activePath` returns the same frozen branch until the ledger snapshot or the
	 * explicit leaf changes: a tree switch moves the leaf without appending (Astra r8-5).
	 */
	let budgetFold: {
		path: ReadonlyArray<SessionEntry>;
		sessionId: string;
		nowMs: number;
		current: ReturnType<typeof resolveContinuityProjection>["current"];
	} | null = null;
	const budgetContinuity = (): ReturnType<typeof resolveContinuityProjection>["current"] => {
		const sessionId = deps.session?.current()?.id;
		if (!sessionId) return null;
		const path = activePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
		const nowMs = Date.now();
		if (budgetFold?.path !== path || budgetFold.sessionId !== sessionId || budgetFold.nowMs !== nowMs)
			budgetFold = {
				path,
				sessionId,
				nowMs,
				current: resolveContinuityProjection({ entries: path, sessionId, nowMs }).current,
			};
		return budgetFold.current;
	};
	const context = createTurnContext({
		hostInserts,
		isTurnActive: () => loop.turnActive,
		turnSignal: () => loop.submitOwner?.signal,
		standingTurnConstraints: () => loop.sessionToolLimits,
		interactiveGuidance: deps.interactiveGuidance === true,
		operatorInterviews: deps.operatorInterviews === true,
		headless: deps.headless === true,
		...(deps.liveSteering === false ? { liveSteering: false } : {}),
		...(deps.sandboxAvailability ? { sandboxAvailability: deps.sandboxAvailability } : {}),
		state,
		getSettings: deps.getSettings,
		...(deps.getAutonomy ? { getAutonomy: deps.getAutonomy } : {}),
		providers: deps.providers,
		session: deps.session,
		prompts: deps.prompts,
		toolRegistry: deps.toolRegistry,
		telemetry: deps.telemetry,
		bus: deps.bus,
		readSessionEntries: deps.readSessionEntries,
		autoCompact: deps.autoCompact,
		// Notes the operator pinned to this session ride in the same `# Memory` section as stored records.
		getMemorySection: (request) =>
			withOperatorSessionNotes(deps.getMemorySection?.(request) ?? "", operatorMemory.sessionNotes()),
		...(deps.memoryEnabled ? { memoryEnabled: deps.memoryEnabled } : {}),
		getMemoryRecordStatuses: (ids) =>
			new Map([...(deps.getMemoryRecordStatuses?.(ids) ?? []), ...operatorMemory.noteStandings(ids)]),
		memoryCommitBridge: deps.memoryCommitBridge,
		getReadySkillCount: deps.getReadySkillCount,
		...(deps.pinnedContext ? { pinnedContext: deps.pinnedContext } : {}),
		...(deps.getRouteSources ? { getRouteSources: deps.getRouteSources } : {}),
		getPendingHandoff: () => {
			const fold = budgetContinuity();
			return fold?.identity && fold.phase !== "acknowledged"
				? {
						id: fold.identity.handoffId,
						preparedAt: fold.policy ? new Date(fold.policy.preparedAtMs).toISOString() : null,
						sourceRevision: fold.identity.sourceRevision,
					}
				: null;
		},
		getLastOutcome: () => {
			const fold = budgetContinuity();
			return fold?.identity ? { outcome: fold.phase, at: null, detail: fold.commit?.outcome ?? null } : null;
		},
		middleware,
		emitNotice,
		// #423: an estimate, not a fault, so it reads as one and ends when the call that answers it settles.
		emitCacheReuseNotice: (text) =>
			emit({ type: "notice", level: "info", surface: "footer", text, key: "context.cache.reuse-uncertain" }),
		emitCacheNotice: (reasons) =>
			emit({
				type: "notice",
				level: "info",
				surface: "footer",
				text: coldCacheNoticeText(reasons),
				key: "context.cache.cold",
				coldReasons: [...reasons],
			}),
	});

	let continuityReplayInstalled = false;
	const continuity = new ContinuityController({
		captureOrigin: () => {
			continuityReplayInstalled = false;
			const session = deps.session;
			const meta = session?.current();
			const runtime = state.runtime;
			const leaf = state.lastTurnId;
			const operator = state.activeUserTurnId;
			if (!session || !meta || !runtime || !leaf || !operator || context.inspectLiveBudget().status !== "available") {
				throw new Error("Self-compaction requires a native runtime and a persisted operator turn.");
			}
			const revision = context.navigationRevision();
			const route = `${deps.getSettings().chat.connection}/${deps.getSettings().chat.model}`;
			return {
				sessionId: meta.id,
				leafTurnId: leaf,
				initiatingTurnId: operator,
				sourceRevision: context.refreshLiveBudget().revision,
				ports: createContinuityPersistencePorts({
					session,
					origin: {
						sessionId: meta.id,
						cwdHash: meta.cwdHash,
						stillCurrent: () =>
							context.navigationRevision() === revision &&
							state.runtime === runtime &&
							state.activeUserTurnId === operator &&
							`${deps.getSettings().chat.connection}/${deps.getSettings().chat.model}` === route,
					},
				}),
			};
		},
		entries: () => activePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined),
		leaf: () => state.lastTurnId,
		admitNote: (accepted) => {
			const view = context.refreshLiveBudget();
			if (!view.breakdown || view.historical) return false;
			const messages = state.runtime?.agent.state.messages ?? [];
			const operator = [...messages].reverse().find((message) => message.role === "user");
			const note = continuityReplayText({
				note: accepted.note,
				handoffId: "pending",
				commitId: "pending",
				originSessionId: view.sessionId ?? "",
				phase: "prepared",
				authority: "execution",
			});
			// Include the complete skill messages and tool receipts already in the
			// protected suffix. The final guard still prices the actual replay.
			// A chain that loaded a skill carries that load's instructions too; it
			// is identified by its activation stamp, never named a context call.
			const protectedSkills = messages
				.filter(
					(message) =>
						message.role === "toolResult" &&
						(effectiveToolCall(message.toolName, undefined, message.details).toolName === "context" ||
							(isGatewayChain(message.toolName, undefined, message.details) &&
								(message.details as { capability?: unknown } | undefined)?.capability === "context")),
				)
				.reduce((sum, message) => sum + estimateAgentMessageTokens(message), 0);
			const floor =
				view.breakdown.systemPromptTokens +
				view.breakdown.toolSchemaTokens +
				protectedSkills +
				(operator ? estimateAgentMessageTokens(operator) : 0) +
				estimateAgentMessageTokens({ role: "assistant", content: [{ type: "text", text: note }] }) +
				512;
			return view.effectiveWindow === null || requestFits(floor, view.outputReserveTokens, view.effectiveWindow);
		},
		fits: () => {
			const view = context.refreshLiveBudget();
			return (
				view.effectiveWindow === null || requestFits(view.inputTokens, view.outputReserveTokens, view.effectiveWindow)
			);
		},
		inputTokens: () => context.refreshLiveBudget().inputTokens ?? 0,
		reduce: async (hooks, signal) => {
			if (!state.runtime) throw new Error("Native runtime was detached.");
			continuityReplayInstalled = await context.runAutoCompact(
				state.runtime,
				true,
				undefined,
				"overflow",
				undefined,
				undefined,
				signal,
				hooks,
			);
		},
		installReplay: () => {
			if (state.runtime && !continuityReplayInstalled) {
				context.refreshAgentMessagesFromSession(state.runtime);
				continuityReplayInstalled = true;
			}
		},
		onCommit: (commitId, outcome) => context.notifyMemoryCommit(commitId, "continuity", outcome),
		notice: emitNotice,
	});

	const persistence = createTurnPersistence({
		hostInserts,
		getToolOwner: (name) => deps.toolRegistry?.get(name as import("../core/tool-names.js").ToolName)?.sourceInfo?.owner,
		state,
		session: deps.session,
		...(deps.beforeTurnRecorded ? { beforeTurnRecorded: deps.beforeTurnRecorded } : {}),
		readSessionEntries: deps.readSessionEntries,
		getSettings: deps.getSettings,
		middlewareToolChoice,
		consumePersistedEcho: (text) => queues.consumePersistedEcho(text),
		removeQueuedMirrorEntry: (text) => {
			const entry = queues.acknowledgeInjected(text);
			return entry === null
				? undefined
				: { kind: entry.kind, ...(entry.origin !== undefined ? { origin: entry.origin } : {}) };
		},
		promptCachePayloadForAssistant: (usage, backend, anthropicResponse, transport, responsesDiagnostic) =>
			context.promptCachePayloadForAssistant(usage, backend, anthropicResponse, transport, responsesDiagnostic),
		telemetry: deps.telemetry,
	});
	const outcomeCollector = deps.turnOutcomeCollector ?? createTurnOutcomeCollector();
	if (deps.turnOutcomeCollector === undefined) deps.middlewareRegistrar?.registerHook(outcomeCollector);
	/** Settles every firing that costs a round, against the requests and typed facts that follow it (memory design 4.1). */
	const detachOutcomeLedger = deps.bus
		? outcomeCollector.attachLedger(
				deps.bus,
				() => deps.session?.current()?.id,
				() => middleware.heldFirings(),
			)
		: null;

	/**
	 * A recovery exchange is a durable insert (F13): the record holds the exact pair, stands for the stopped reply
	 * the live history drops and for the row the event path writes for the host-authored call, so a rebuild sends
	 * what the recovery request sent. Pi pushes the pair itself, so this only writes.
	 */
	const recordRecovery = (
		source: "repetition-recovery" | "thinking-length-recovery" | "synthesis-recovery",
		messages: ReadonlyArray<AgentMessage>,
		stopped?: AgentMessage,
	): AgentMessage[] => {
		const stoppedRow = stopped !== undefined ? persistence.rowIdOf(stopped) : undefined;
		const replaces = [
			...(stoppedRow !== undefined ? [stoppedRow] : []),
			...messages.filter((message) => message.role === "assistant").map((message) => hostInserts.reserveRowId(message)),
		];
		hostInserts.record(source, messages, { replaces, ...(stoppedRow !== undefined ? { exclude: [stoppedRow] } : {}) });
		return [...messages];
	};
	const currentTurnFailure = (): TurnFailureRecord | undefined => loop.terminalTurnFailure;
	const recovery = createTurnRecovery({
		auth: deps.providers.auth,
		isYolo: () => (deps.getAutonomy?.() ?? deps.getSettings().safety.autonomy) === "yolo",
		turnSignal: () => loop.submitOwner?.signal,
		turnIdentity: () => loop.submitGeneration,
		state,
		persistence,
		context,
		retrySettings,
		applyRouteMove: (runtime) => applyRouteMove(runtime),
		markPersistedUserEcho: (text, prompt) => queues.markPersistedUserEcho(text, prompt),
		emitRetryStatus: (status) => {
			if (status.phase === "retrying") loop.turnRetryAttempts += 1;
			emit({ type: "retry_status", status });
		},
		emitFailureMessage: (message) => {
			const forecast = state.runtime ? recovery.forecastRetry(state.runtime, message) : null;
			emit({ type: "message_end", message, ...(forecast ? { retryPending: forecast } : {}) });
		},
		emitNotice,
		compactCommand: () => compactCommandHint(deps.headless === true, deps.session?.current()?.id),
	});
	const movedRoute = (route: { targetId: string; wireModelId: string }): MovedRoute => ({
		targetId: route.targetId,
		modelId: route.wireModelId,
	});
	/**
	 * Everything a submit binds to its route before the first call, done again for the next one: a next-turn switch
	 * recompiles for the new route on its way out, and a moved request has to arrive with what that route was told.
	 */
	const applyRouteMove = async (runtime: AgentRuntime): Promise<{ from: MovedRoute; to: MovedRoute } | null> => {
		const target = state.routeMove;
		state.routeMove = null;
		if (target === null) return null;
		const from = movedRoute(runtime);
		turnRuntime.rebindRoute(target);
		runtime.agent.state.tools = resolveSessionTools(
			runtime,
			deps.toolRegistry,
			currentToolInvokeOptions,
			turnRuntime.toolTelemetry,
			loop.sessionToolLimits,
		);
		context.syncRouteConfiguration(runtime);
		const compiled = await context.ensureSessionPrompt(runtime);
		context.logPromptCompileIfPending();
		// A request on another target or wire model shares no cached prefix with the previous call's (#434).
		context.noteColdReason("model_changed");
		loop.moveForeground?.(runtime);
		if (state.lastRunSnapshot) {
			const promptHash = compiled?.systemPromptHash ?? state.lastRunSnapshot.compiledPromptHash;
			Object.assign(state.lastRunSnapshot, {
				targetId: runtime.targetId,
				targetUrl: runtime.runtimeResolution.target.url ?? null,
				runtimeId: runtime.runtimeId,
				runtimeKind: runtime.runtimeResolution.runtimeKind,
				wireModelId: runtime.wireModelId,
				pricedBy: runtime.runtimeResolution.pricedBy,
				compiledPromptHash: promptHash,
				staticCompositionHash: promptHash,
				promptSignature: promptHash,
				toolSignature: toolSignatureFromState(runtime.agent.state.tools),
				runtimeResolution: runtimeTargetSnapshot(runtime.runtimeResolution),
			});
		}
		return { from, to: movedRoute(runtime) };
	};
	const routeMoveWait = (): RouteMoveWait => {
		if (!state.streaming) return "idle";
		// A pick already aborted the call, and this pick replaces where it goes.
		if (state.routeMove !== null) return "first-output";
		if (recovery.inRetryWait()) return "retry-wait";
		const wait = turnRuntime.callWait();
		return wait === "first-output" && !state.routeMoveSeat ? "elsewhere" : wait;
	};
	const routeFit = (candidate: { target: ChatLoopTarget; model: EngineModel }): RouteMoveFit => {
		const runtime = state.runtime;
		if (!runtime) return { kind: "unresolved", reason: "the turn has no runtime yet" };
		const resolution = candidate.target.runtimeResolution;
		if (
			state.routeMove === null &&
			runtime.targetId === candidate.target.target.id &&
			runtime.runtimeId === candidate.target.runtime.id &&
			runtime.wireModelId === candidate.target.wireModelId
		)
			return { kind: "same" };
		const prompt = [...runtime.agent.state.messages].reverse().find((message) => message.role === "user");
		if (
			prompt !== undefined &&
			countImageBlocks([prompt]) > 0 &&
			!acceptsImageInput({ runtimeId: candidate.target.runtime.id, vision: resolution.capabilityDecisions.vision })
		)
			return { kind: "images" };
		const inputTokens = context.refreshLiveBudget().inputTokens ?? 0;
		const window = resolution.contextWindowDetails.effectiveContextWindow;
		const outputTokens = resolveFitOutputReserve(
			{ runtimeResolution: resolution, agent: { state: { model: candidate.model } } },
			inputTokens,
		);
		// An unknown window is nothing to check against, and an overflow there still compacts and retries once.
		if (window > 0 && !requestFits(inputTokens, outputTokens, window))
			return { kind: "too-large", neededTokens: inputTokens + outputTokens, window };
		return { kind: "fits" };
	};
	/** Set between a retried attempt's `message_end` and the `agent_end` that closes that attempt. */
	let attemptRetryForecast: RetryForecast | null = null;
	const emitRuntimeEvent = (event: AgentEvent | AssistantDeltaEvent): void => {
		if (event.type === "agent_end" && attemptRetryForecast !== null) {
			Object.assign(event, { retryPending: attemptRetryForecast });
			attemptRetryForecast = null;
		}
		if (event.type === "message_end") {
			nameMissingCredentialRemedy(event.message, state.runtime?.runtimeResolution.target);
			if (event.message.role === "assistant") {
				const terminal = terminalFailureFromAssistantMessage(event.message);
				if (terminal?.failure) {
					loop.terminalTurnFailure = terminal.failure;
					loop.providerRetryAttempts += terminal.failure.retryAttempts ?? 0;
				} else if (!terminal) loop.terminalTurnFailure = undefined;
			}
			rewriteStallAbortMessage(state, event.message);
			explainInterruptedAssistant(event.message, state.activeInterruptReason);
			if (event.message.role === "assistant") {
				attemptRetryForecast = state.runtime ? recovery.forecastRetry(state.runtime, event.message) : null;
				// A reply the repetition check stopped, when a recovery follows, closes an attempt and not the turn (bt-48-1).
				const repetitionStage =
					attemptRetryForecast === null && (event.message as { stopReason?: unknown }).stopReason === "aborted"
						? repetitionRecoveryStage(state)
						: null;
				if (repetitionStage !== null) attemptRetryForecast = repetitionRecoveryForecast(repetitionStage);
				// A thinking-only output-limit stop whose one recovery follows closes an attempt too, so the footer does not
				// read "Output limit" before the recovered turn's own outcome (f-repeat).
				else if (
					attemptRetryForecast === null &&
					state.activeInterruptReason === null &&
					state.activeUserTurnId !== null &&
					state.thinkingLengthRecoveryTurnId !== state.activeUserTurnId &&
					isThinkingOnlyLengthStop(event.message)
				)
					attemptRetryForecast = { attempt: 1, maxAttempts: 1, recovery: true };
				if (attemptRetryForecast !== null) Object.assign(event, { retryPending: attemptRetryForecast });
			}
			if (state.currentAskUserPolicy?.planOnly && event.message.role === "assistant") {
				for (const block of event.message.content) {
					if (block.type !== "text") continue;
					const clean = stripPlanCloseOptions(block.text);
					if (clean !== block.text) {
						block.text = clean;
						Object.assign(event, { lockedSynthesisSanitized: true });
					}
				}
			}
		}
		emit(event as ChatLoopEvent);
	};
	const requestBudgetRoll = (budget: "calls" | "observation"): void => {
		if (loop.budgetRoll !== null || !state.streaming) return;
		loop.budgetRoll = budget;
		state.toolBudgetLock = true;
		const what = budget === "calls" ? "tool-call" : "observation";
		loop.api.cancel({
			reason: `[PanCode] Turn budget rolled: this turn reached its per-turn ${what} budget, and the work continues in a fresh turn because autonomy is yolo.`,
			source: "loop_guard",
			auditReason: `turn budget roll: ${what}`,
			atToolBoundary: true,
		});
	};
	/** `run --max-requests`/`--max-tool-calls`: one count for the life of this loop, which is one headless run. */
	const runCapCounter = createRunCapCounter();
	const turnRuntime = createTurnRuntime({
		hostInserts,
		onMemoryRequestSubmitted: deps.onMemoryRequestSubmitted,
		turnIdentity: () => loop.submitGeneration,
		interactiveGuidance: deps.interactiveGuidance === true,
		state,
		gatewayCapabilityNames: () => deps.toolRegistry?.listGateway().map((spec) => spec.name) ?? [],
		getSettings: deps.getSettings,
		providers: deps.providers,
		knownTargets: deps.knownTargets,
		telemetry: deps.telemetry,
		scheduling: deps.scheduling,
		headless: deps.headless,
		missingOutputs,
		createAgent,
		noteMainRequest: (runtime, request, stream) => {
			loop.keepalive.noteRequest(runtime, request, stream);
			const record: MainRequestRecord = { request, sentAt: Date.now(), promptTokens: null, cachedTokens: null };
			state.lastMainRequest = { runtime, record };
			// The prompt size the provider reports is what a compaction inside this prefix reads from cache (T4); its
			// cache read is the only proof a slot cache (llama.cpp) is holding this prefix.
			stream.result().then(
				(message) => {
					if (message.stopReason !== "error" && message.stopReason !== "aborted") {
						record.promptTokens = cacheKeepalivePromptTokens(message);
						record.cachedTokens = message.usage?.cacheRead ?? 0;
					}
				},
				() => {
					// A failed request leaves no cache entry to read; promptTokens stays null and the prefix is refused.
				},
			);
		},
		continuity,
		hasQueuedSteering: () => queues.hasPendingSteer(),
		stopAtToolBoundary: () => {
			const stop = loop.boundaryStop;
			if (stop === null) return false;
			loop.boundaryStop = null;
			loop.api.cancel(stop);
			return true;
		},
		runCaps: {
			admitRequest: () => runCapCounter.admitRequest(state.currentTurnConstraints?.runCaps),
			admitToolCalls: (count) => runCapCounter.admitToolCalls(state.currentTurnConstraints?.runCaps, count),
		},
		queueHandOver: {
			atFinishTurn: (final) => queues.handOverAtFinishTurn(final),
			afterPrepareNextTurn: () => queues.handOverAfterPrepareNextTurn(),
			takeHostMessages: () => queues.takeHostMessages(),
		},
		middlewareToolChoice,
		persistence,
		context,
		middleware,
		retrySettings,
		sessionId: () => deps.session?.current()?.id,
		sessionOrigin: () => deps.session?.current() ?? null,
		onModelRequestSent: (call) => {
			if (call !== null) messagePath.requestSent(call);
			// Journaled or not, this request carried exactly what the middleware held for it, and admits only that.
			outcomeCollector.requestSent(call?.callId ?? null, middleware.requestCarried());
		},
		onModelCallSettled: (facts) => messagePath.callSettled(facts),
		requestCursor: () =>
			requestCursorOf(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? null, {
				...continuityContextFromSession(deps.session),
				...(state.continuityAtMs !== null ? { nowMs: state.continuityAtMs } : {}),
			}),
		...(deps.admitFlow !== undefined ? { admitFlow: deps.admitFlow } : {}),
		emit: emitRuntimeEvent,
		emitNotice,
		emitFooterNotice,
		toolStartTimes,
		prepareInRunContinuation: async (signal) => {
			const userTurnId = state.activeUserTurnId;
			if (!deps.turnControl || userTurnId === null) return null;
			const identity = loop.submitGeneration;
			const ownerSignal = loop.submitOwner?.signal;
			const controllerAbort = new AbortController();
			const forward = () => controllerAbort.abort();
			signal?.addEventListener("abort", forward, { once: true });
			if (signal?.aborted || ownerSignal?.aborted) controllerAbort.abort();
			try {
				const result = await deps.turnControl.run({ userTurnId, signal: controllerAbort.signal });
				if (controllerAbort.signal.aborted || ownerSignal?.aborted || identity !== loop.submitGeneration) return null;
				noteTurnControlCollection(result);
				outcomeCollector.recordControl(result.record);
				if (deps.session?.current()) {
					try {
						deps.session.appendEntry({
							kind: "custom",
							customType: "turnControl",
							parentTurnId: state.lastTurnId,
							display: false,
							data: result.record,
						});
					} catch {
						/* S6: ledger recording is best effort and never costs the continuation. */
					}
				}
				return result.block;
			} finally {
				signal?.removeEventListener("abort", forward);
			}
		},
	});
	// A fresh ledger and footer render before the first submit. Start the same
	// live capability probe that submit and resume use so those boot surfaces
	// refresh to the probed model window as soon as provider discovery lands.
	// The turn runtime coalesces the first submit onto this request, then its
	// target and model TTL keeps later submits from repeating it.
	void turnRuntime.ensureLiveCapabilitiesForSelectedModel().catch(() => {});
	return {
		context,
		continuity,
		currentTurnFailure,
		detachBoundaryReminders,
		detachOutcomeLedger,
		messagePath,
		middleware,
		operatorMemory,
		outcomeCollector,
		persistence,
		queues,
		recordRecovery,
		recovery,
		requestBudgetRoll,
		routeFit,
		routeMoveWait,
		steerInterrupter,
		turnRuntime,
	};
}
