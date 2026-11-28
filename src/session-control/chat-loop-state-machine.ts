// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { classifyCallFailure } from "../core/call-failure.js";
import {
	continuationCountsAgainstCap,
	TURN_CONTINUATION_CAP,
	type TurnContinuationCause,
	turnContinuationDelayMs,
} from "../core/job-types.js";
import type { SideCallAuth } from "../core/oauth-retry.js";
import { mainAgent, ownerTelemetryContext, telemetryContext } from "../core/telemetry/context.js";
import type { FailureCause, TurnNoAnswerCause } from "../core/telemetry/enums.js";
import { telemetryHub } from "../core/telemetry/hub.js";
import { pricesCalls, pricingBasisFields } from "../core/telemetry/pricing.js";
import { turnTemplateName } from "../core/turn-constraints.js";
import type { TurnOrigin, TurnToolCall } from "../core/turn-origin.js";
import type { EffectivePricing } from "../domains/providers/catalog.js";
import { resolveEffectivePricing } from "../domains/providers/catalog.js";
import { modelEndpointKey, registerForegroundStream } from "../domains/providers/index.js";
import { resolveSideCallAuth } from "../domains/providers/side-call-auth.js";
import { sessionCeilingReached } from "../domains/scheduling/budget.js";
import type { SessionContract } from "../domains/session/contract.js";
import { turnSettlementFromCalls } from "../domains/telemetry/call-facts.js";
import type { AdmissionHold, CallJournalOptions } from "../domains/telemetry/call-scope.js";
import type { TurnControlRecord, TurnOutcomeRecord } from "../domains/turn-control/index.js";
import { reduceTurnOutcome } from "../domains/turn-control/index.js";
import { resolveSessionTools } from "../tools/agent-tools.js";
import type { ChatSubmitOptions, CreateChatLoopDeps, StepPipelineEnd } from "./chat-loop.js";
import { notConfiguredNotice } from "./chat-loop-messages.js";
import type { ChatLoopScope } from "./chat-loop-scope.js";
import { loopGuardContinuationDetail, TOOL_LOCK_RESET_DETAIL } from "./loop-guard-interrupt.js";
import { type StepRun, stepTurnOutcome } from "./step-start.js";
import { createTurnKeepalive, type TurnKeepaliveDeps } from "./turn-keepalive.js";
import { createTurnPrewarm, subscribePrewarmToCompaction } from "./turn-prewarm.js";
import type { QueuedChatMessage } from "./turn-queues.js";
import type { AgentRuntime, ChatLoopStateMachineState } from "./turn-state.js";
import { createWorkerReceipts, noOutcomeUsage } from "./worker-receipts.js";

/** The endpoint stream slot an out-of-turn round holds; both calls are idempotent (#250). */
interface EndpointSlot {
	acquire(): void;
	release(): void;
}

/**
 * Placeholder key a target that needs no auth still has to be handed. Mirrors
 * the turn runtime's own local fallback, so a `/btw` round against a local
 * server authenticates exactly the way a turn against it does.
 */
export const LOCAL_SIDE_QUESTION_API_KEY = "pancode-local-target";

/** Why a settled turn gets another one at yolo; `step` marks a step continuation, which spends the cap (bt-6). */
interface YoloContinuation {
	cause: TurnContinuationCause;
	reason: string;
	retryAfterMs?: number;
	detail?: string;
	step?: true;
	/** What the continuation asks for, in place of "continue from where it stopped": a step continuation is a new step turn. */
	next?: string;
	/** A silent budget roll (XR-6): its closing record already told the transcript, so no second notice. */
	rolled?: true;
}

const countsAgainstCap = (stop: YoloContinuation): boolean =>
	stop.step === true || continuationCountsAgainstCap(stop.cause);

/**
 * Run one out-of-turn round while holding a slot on the endpoint it streams
 * to, exactly as the turn and the pre-warm do. A `/btw` or `/handoff` round
 * is a full request against the same inference scheduler, so endpoint
 * capacity (#250) has to count it for as long as it is out, and the
 * background-memory tier has to read that endpoint as busy (#229). The round
 * may release the slot while it waits and take it back before it sends.
 */
async function withEndpointKeySlot<T>(
	endpointKey: string | null,
	round: (slot: EndpointSlot) => Promise<T>,
): Promise<T> {
	let held: (() => void) | null = null;
	const slot: EndpointSlot = {
		acquire: () => {
			if (endpointKey !== null && held === null) held = registerForegroundStream(endpointKey);
		},
		release: () => {
			held?.();
			held = null;
		},
	};
	slot.acquire();
	try {
		return await round(slot);
	} finally {
		slot.release();
	}
}

/**
 * Budget admission for each attempt of a side round, a schema or auth retry included. It runs inside the attempt's
 * call, so a hold at the ceiling reads as its admission stage with `waitedOn: "budget"` and journals the crossing
 * and the wait for that call; a session that changed during the wait refuses the request (#424, #434). A held
 * request gives its endpoint slot back for the hold, because a paused request must not hold capacity.
 */
function createSideCallAdmission(deps: CreateChatLoopDeps) {
	return (
		origin: ReturnType<SessionContract["current"]>,
		slot: EndpointSlot,
		signal?: AbortSignal,
		// An automatic round (triage) is refused at the ceiling; only an operator's own request parks for a raise.
		waitForRaise = deps.headless !== true,
	) =>
		async (hold: AdmissionHold): Promise<void> => {
			// Checked whatever the route's pricing: an unpriced route projects nothing, but the session's settled
			// spend may already be at the ceiling.
			const telemetry = telemetryContext();
			await deps.scheduling?.admitPaidRequest?.({
				waitForRaise,
				getCeilingUsd: () => deps.getSettings().safety.limits.sessionCostUsd,
				onBlocked: () => {
					hold.waitedOn = "budget";
					slot.release();
				},
				...(telemetry ? { telemetry } : {}),
				...(signal ? { signal } : {}),
			});
			if ((deps.session?.current()?.id ?? null) !== (origin?.id ?? null))
				throw new Error("session changed before the request");
			slot.acquire();
		};
}

function createSideCallJournal(deps: CreateChatLoopDeps) {
	return (
		runtime:
			| AgentRuntime
			| {
					targetId: string;
					runtimeId: string;
					pricedBy: AgentRuntime["runtimeResolution"]["pricedBy"];
					freeRule?: AgentRuntime["runtimeResolution"]["freeRule"];
					rates?: EffectivePricing["rates"];
			  },
		role: CallJournalOptions["role"],
		origin: ReturnType<SessionContract["current"]>,
	): { telemetry?: CallJournalOptions } => {
		const acquire = deps.telemetry?.acquireTelemetrySession;
		// The route's rates price a target-rates side call from its settled counts (#434).
		const rates =
			"runtimeResolution" in runtime
				? resolveEffectivePricing(
						runtime.runtimeResolution.target,
						runtime.runtimeResolution.runtime,
						runtime.runtimeResolution.wireModelId,
					).rates
				: runtime.rates;
		return acquire
			? {
					telemetry: {
						origin,
						acquire,
						role,
						targetId: runtime.targetId,
						runtimeId: runtime.runtimeId,
						...pricingBasisFields("runtimeResolution" in runtime ? runtime.runtimeResolution : runtime),
						...(rates !== undefined ? { rates } : {}),
					},
				}
			: {};
	};
}

/**
 * What a settled turn stopped on, when nobody asked for it and yolo has continuations left (#445).
 * A guard interrupt (the hard tool-call ceiling or an identical-call loop stop) counts against the cap:
 * the turn did not converge after the soft budget asked it to re-plan.
 */
function createYoloContinuationDue(loop: ChatLoopScope, state: ChatLoopStateMachineState) {
	const { deps } = loop;
	return (
		guardInterrupted = false,
		guardFailure: { tool: string; failure: string } | null = null,
		stepStop: { template?: string } | null = null,
		stepRun: StepRun | null = null,
	): YoloContinuation | null => {
		if ((deps.getAutonomy?.() ?? deps.getSettings().safety.autonomy) !== "yolo") return null;
		// `finish` is turn-terminal (fleet design 4.3, FX-38): the host never continues a declared turn, whatever stopped it.
		if (state.turnCompletion !== null) return null;
		const failed = state.continuation.stop;
		// Continuing would send this provider a request before the time it named.
		if (failed?.cause === "wait_past_budget") return null;
		// A step turn continues whether it ended on its own summary or on the second-call refusal, and each step
		// continuation counts against the cap, so a step tool that never says its pipeline is done cannot loop (bt-6).
		// A turn that did a step's work without the step call continues too while the pipeline is open (bt-15), and
		// either way the continuation is a new turn that opens with the next step call, as the scope reminder says.
		const template = stepStop?.template ?? state.currentTurnConstraints?.turnPolicy?.template;
		const named = template ? `prompt template ${template}` : "its template";
		const stepTool = state.currentTurnConstraints?.turnPolicy?.stepTool ?? "the step tool";
		const step = {
			cause: "step" as const,
			reason:
				stepRun?.carried === true
					? `it made no ${stepTool} call, and the step pipeline of ${named} has not said it is done`
					: `it ran one step of ${named}, which runs one step per turn`,
			step: true as const,
			next: `This is a new step turn: first call ${stepTool} with the after value the last finished step reached, run the step it returns, then end the turn with a compact state summary. If ${stepTool} already said the pipeline is complete, say so and stop.`,
		};
		// A failure stop outranks a budget crossing in the same turn, so a failing turn cannot escape the cap on one.
		// A budget roll is the guard's own boundary stop, not a loop: it continues uncounted like a budget crossing.
		const stop: YoloContinuation | null =
			failed ??
			(loop.budgetRoll !== null
				? {
						cause: "tool_budget" as const,
						reason: `it reached the per-turn ${loop.budgetRoll === "calls" ? "tool-call" : "observation"} budget and rolled over`,
						next:
							"Its last tool batch ran and the results are above; a call that did not run says so. Continue the work from there with a fresh budget. No recap of earlier turns is needed; answer the operator when the work is done.",
						rolled: true as const,
					}
				: guardInterrupted
					? { cause: "loop_guard" as const, reason: "the loop guard stopped it" }
					: state.synthesisToolLock
						? { cause: "loop_guard" as const, reason: "the loop guard locked its tools" }
						: state.toolBudgetLock
							? stepStop !== null
								? step
								: { cause: "tool_budget" as const, reason: "it reached the per-turn tool budget" }
							: stepRun !== null
								? step
								: null);
		if (stop === null) return null;
		if (stop.step === true && stepRun?.pipelineDone === true) return null;
		if (countsAgainstCap(stop) && state.continuation.yoloContinuations >= TURN_CONTINUATION_CAP) return null;
		// A turn whose tools were blocked turn-wide (the budget, its hard ceiling,
		// or a synthesis lock) continues in a new turn that holds them again (F-C14).
		const toolsWereLocked =
			failed === null && stop.rolled !== true && (state.toolBudgetLock || state.synthesisToolLock || guardInterrupted);
		const detail = [
			...(toolsWereLocked ? [TOOL_LOCK_RESET_DETAIL] : []),
			...(stop.cause === "loop_guard" && guardFailure !== null ? [loopGuardContinuationDetail(guardFailure)] : []),
		];
		return detail.length === 0 ? stop : { ...stop, detail: detail.join("\n") };
	};
}

/** The keepalive's ledger entry: one display-less `prewarm` custom entry per refresh. */
function createKeepaliveRecord(
	deps: CreateChatLoopDeps,
	state: ChatLoopStateMachineState,
): TurnKeepaliveDeps["record"] {
	return (runtime, refresh) => {
		try {
			deps.session?.appendEntry({
				kind: "custom",
				customType: "prewarm",
				// A fact about the provider cache, never a model message or a transcript block.
				display: false,
				parentTurnId: state.lastTurnId,
				data: {
					trigger: "keepalive",
					phase: refresh.phase,
					target: runtime.targetId,
					model: runtime.wireModelId,
					promptTokens: refresh.promptTokens,
					economics: refresh.economics,
					promptCache: {
						input: refresh.message?.usage.input ?? null,
						cacheRead: refresh.message?.usage.cacheRead ?? null,
						cacheWrite: refresh.message?.usage.cacheWrite ?? null,
					},
					...(refresh.error === null ? {} : { error: refresh.error }),
				},
			});
		} catch {
			// The ledger entry is diagnostics; the spend is already booked above.
		}
	};
}

/** The chat loop's turn state machine: admission, settlement, side-call slots, prewarm and keepalive. */
export function createChatLoopStateMachine(loop: ChatLoopScope, state: ChatLoopStateMachineState) {
	const {
		context,
		currentToolInvokeOptions,
		deps,
		emitNotice,
		outcomeCollector,
		queues,
		recovery,
		stepPipeline,
		turnRuntime,
	} = loop;
	// --- the state machine --------------------------------------------------
	const yoloContinuationDue = createYoloContinuationDue(loop, state);

	/**
	 * A step turn runs one pipeline step by contract, so the finish contract waits while a step continuation follows
	 * it and assesses the whole pipeline at the turn that ends it (bt-12 #4). Read at turn_end, before the turn settles.
	 */
	const stepTurnEnd = (): { continues: boolean; startTurnId?: string } | null => {
		const stepTool = state.currentTurnConstraints?.turnPolicy?.stepTool;
		const scope = loop.stepTurnScope;
		if (stepTool === undefined || scope === null) return null;
		const ran = stepTurnOutcome(scope.evidence.messages(), stepTool);
		const { run, startTurnId } = stepPipeline.peek(stepTool, ran, scope.continuation);
		const continues = run !== null && yoloContinuationDue(false, null, loop.stepPolicyStop, run)?.step === true;
		return { continues, ...(startTurnId === undefined ? {} : { startTurnId }) };
	};

	/**
	 * Who started a submitted turn, for extension hooks. PanCode's continuation of
	 * a stopped turn runs under the same template scope as the turn it
	 * continues, so an extension must not read it as a new operator prompt.
	 */
	const submittedTurnOrigin = (options: ChatSubmitOptions): TurnOrigin => {
		const template = turnTemplateName(state.currentTurnConstraints);
		const origin: TurnOrigin["origin"] = options.machineTurn
			? "job"
			: options.yoloContinuation === true
				? "continuation"
				: options.origin !== undefined && options.operatorAuthored !== true
					? "peer"
					: "operator";
		return {
			origin,
			...(options.yoloContinuationAttempt === undefined
				? {}
				: { continuation: { index: options.yoloContinuationAttempt, cap: TURN_CONTINUATION_CAP } }),
			...(template === undefined ? {} : { template }),
		};
	};

	const restorableQueuedText = (entry: QueuedChatMessage): string =>
		entry.constraints !== undefined ? (entry.display?.text ?? entry.text) : entry.text;

	/** Give a stopped turn another one, fresh budget included, with what stopped it in the prompt (#445). */
	const continueStoppedTurn = async (
		stop: YoloContinuation,
		generation: number,
		constraints: ChatSubmitOptions["constraints"],
		lastToolCall: TurnToolCall | null,
		stoppedTurnId: string | null,
	): Promise<void> => {
		const counted = countsAgainstCap(stop);
		const attempt = counted ? state.continuation.countYoloContinuation() : state.continuation.yoloContinuations;
		const context = deps.session?.current()?.id;
		deps.bus?.emit(
			"turn.continued",
			{
				cause: stop.cause,
				attempt,
				cap: TURN_CONTINUATION_CAP,
				at: Date.now(),
				// The turn it continues, so a continuation joins the stopped turn's own records (memory design 4.6).
				...(stoppedTurnId !== null ? { continues: stoppedTurnId } : {}),
			},
			...(context === undefined ? [] : [ownerTelemetryContext({ sessionId: context })]),
		);
		if (stop.rolled !== true)
			emitNotice(
				`Continuing this turn because autonomy is yolo${counted ? ` (${attempt} of ${TURN_CONTINUATION_CAP})` : ""}: ${stop.reason}.`,
				"warning",
				"turn.continued",
			);
		if (stop.cause === "retries_exhausted" || stop.cause === "compaction") {
			const waited = await recovery.waitBeforeContinuation(
				turnContinuationDelayMs(attempt, stop.retryAfterMs),
				attempt,
				TURN_CONTINUATION_CAP,
				stop.reason,
			);
			if (waited === "cancelled") return;
		}
		if (loop.disposed || generation !== loop.submitGeneration || state.activeUserTurnId !== null || state.streaming)
			return;
		if (await queues.resubmitStranded()) return;
		await loop.api.submit(
			`[PanCode] The previous turn stopped: ${stop.reason}. ${stop.next ?? "Its work and tool results are above. Continue from where it stopped, and if the work is already finished, say so and stop."}${counted ? ` This is continuation ${attempt} of ${TURN_CONTINUATION_CAP}.` : ""}${stop.detail === undefined ? "" : `\n${stop.detail}`}`,
			{
				origin: `yolo continuation ${attempt}`,
				yoloContinuation: true,
				yoloContinuationAttempt: attempt,
				...(lastToolCall === null ? {} : { continuationToolCall: lastToolCall }),
				...(constraints === undefined ? {} : { constraints }),
			},
		);
	};

	const interruptRefusalReason = (): string | null => {
		if (deps.hasAttachedDispatch?.() === true) {
			return "an attached dispatch is running and the interrupt would kill the worker's run with no run record; use @<agent> to steer it or Esc to cancel it";
		}
		if (deps.toolRegistry?.hasParkedCalls() === true) {
			return "a permission ask is parked and already waiting on you; answer it or press Esc";
		}
		return null;
	};

	/**
	 * Everything an out-of-turn round needs, or the reason it cannot run.
	 *
	 * `/btw`, `/draft`, `/handoff` and the pre-warm are the callers. All read the
	 * compiled history the next turn would see and authenticate exactly the way
	 * a turn against the same target does. Whether one runs while a turn is in
	 * flight is the caller's choice: `/handoff` and the pre-warm pass a refusal,
	 * while `/btw` and `/draft` pass null and answer beside the running turn
	 * (#415). Mid-turn the live runtime is taken as it stands, because
	 * `ensureRuntime` may hot-swap the model, rebuild and abort the agent the
	 * turn is streaming on, or append a session entry. A submit counts as in
	 * flight from entry, as it does for the pre-warm, because it is preparing
	 * that runtime before `state.streaming` flips.
	 */
	type OutOfTurnPreparation =
		| {
				ok: true;
				runtime: AgentRuntime;
				apiKey: string | undefined;
				refreshApiKey?: SideCallAuth["refreshApiKey"];
				origin: ReturnType<SessionContract["current"]>;
				inFlight: boolean;
		  }
		| { ok: false; reason: string };
	/**
	 * Build what the next request would carry after a navigation: the runtime over the replayed history, the session
	 * tools and the session prompt, then republish the view. The figure a reopen shows is then the one live would
	 * show, never the persisted snapshot. No provider call: the portable fallback is skipped like the pre-warm's.
	 */
	const prepareNextRequest = async (navigation: number): Promise<void> => {
		await Promise.resolve();
		const sessionId = loop.api.getSessionId();
		const current = () =>
			!loop.disposed &&
			navigation === loop.nextRequestNavigation &&
			loop.api.getSessionId() === sessionId &&
			!state.streaming &&
			!loop.turnActive;
		if (!current()) return;
		// M-26: the probe a submit awaits restores the session's thinking level and served window, so the budget priced
		// here, the pre-warm and the send compile one prompt. It joins the probe the resume starts, never a second one.
		await turnRuntime.ensureLiveCapabilitiesForSelectedModel({ silent: true }).catch(() => {});
		if (!current()) return;
		let runtime: AgentRuntime | null;
		try {
			runtime = turnRuntime.ensureRuntime({ silent: true });
		} catch {
			return;
		}
		if (!runtime || !current()) return;
		runtime.agent.state.tools = resolveSessionTools(
			runtime,
			deps.toolRegistry,
			currentToolInvokeOptions,
			turnRuntime.toolTelemetry,
			loop.sessionToolLimits,
		);
		try {
			await context.ensureSessionPrompt(runtime, false, undefined, true);
		} catch {
			// The view below still prices the route's tools and the replayed history.
		}
		if (current()) {
			const view = context.refreshLiveBudget();
			context.journalResumedBudget?.(view);
		}
	};

	const prepareOutOfTurnRound = async (
		inFlightRefusal: string | null,
		signal?: AbortSignal,
		silent = false,
		/** The pre-warm admits once here; a side round admits each of its attempts through `sideCallAdmission` (#424). */
		admitHere = true,
	): Promise<OutOfTurnPreparation> => {
		const inFlight = state.streaming || loop.turnActive;
		if (inFlight && inFlightRefusal !== null) return { ok: false, reason: inFlightRefusal };
		if (inFlight && !state.runtime) return { ok: false, reason: "the turn is still starting its runtime; ask again" };
		const origin = deps.session?.current() ?? null;
		let agentRuntime: AgentRuntime | null;
		try {
			agentRuntime = inFlight ? state.runtime : turnRuntime.ensureRuntime({ silent });
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : String(err) };
		}
		if (!agentRuntime) return { ok: false, reason: notConfiguredNotice(deps.getSettings().chat) };
		const resolution = agentRuntime.runtimeResolution;
		try {
			// The pre-warm is gated like the turn it warms: the turn on an unpriced route is
			// not held at the ceiling, so neither is the round that warms it.
			if (admitHere && pricesCalls(resolution.pricedBy)) {
				await deps.scheduling?.admitPaidRequest?.({
					waitForRaise: deps.headless !== true,
					getCeilingUsd: () => deps.getSettings().safety.limits.sessionCostUsd,
					...(signal ? { signal } : {}),
				});
			}
			const sideAuth = await resolveSideCallAuth(
				deps.providers.auth,
				resolution.target,
				resolution.runtime,
				LOCAL_SIDE_QUESTION_API_KEY,
				signal,
			);
			if ((deps.session?.current()?.id ?? null) !== (origin?.id ?? null))
				return { ok: false, reason: "session changed before the request" };
			return { ok: true, runtime: agentRuntime, apiKey: sideAuth.apiKey, ...sideAuth, origin, inFlight };
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : String(err) };
		}
	};

	const withEndpointSlot = async <T>(runtime: AgentRuntime, round: (slot: EndpointSlot) => Promise<T>): Promise<T> =>
		withEndpointKeySlot(modelEndpointKey(runtime.runtimeResolution.target, runtime.wireModelId), round);

	const sideCallAdmission = createSideCallAdmission(deps);
	const sideCallJournal = createSideCallJournal(deps);
	// Install cancellation before publishing the preparation edge; listeners may cancel synchronously.
	const prepareCompactionPaint = (): (() => Promise<void>) => {
		const controller = new AbortController();
		loop.pendingCompactionPaint = controller;
		const sessionId = deps.session?.current()?.id;
		const cwd = process.cwd();
		return async () => {
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				controller.signal.throwIfAborted();
				if (sessionId !== deps.session?.current()?.id || cwd !== process.cwd())
					throw new DOMException("Context ownership changed before compaction", "AbortError");
			} finally {
				if (loop.pendingCompactionPaint === controller) loop.pendingCompactionPaint = null;
			}
		};
	};
	const operatorTurnIndex = (excludeTurnId?: string): number => {
		loop.operatorTurnsBefore ??= (deps.readSessionEntries?.() ?? []).filter((entry) => {
			if (entry.kind !== "message" || entry.role !== "user") return false;
			return (entry.payload as { synthetic?: unknown } | null)?.synthetic !== true && entry.turnId !== excludeTurnId;
		}).length;
		return loop.operatorTurnsBefore;
	};

	const workerReceipts = createWorkerReceipts(deps.outcomeDispatch, deps.session);

	/** One turn.settled per settled user turn, from the turn's own call facts (#430, #434). */
	const recordTurnSettled = async (
		userTurnId: string,
		stopReason: unknown,
		retries: number,
		fallbackCause?: FailureCause,
		noAnswer?: TurnNoAnswerCause,
	): Promise<void> => {
		const calls = turnRuntime.takeSettledCalls(userTurnId);
		const bareFinishRefusals = turnRuntime.takeBareFinishRefusals(userTurnId);
		const origin = deps.session?.current();
		const acquire = deps.telemetry?.acquireTelemetrySession;
		if (!origin || !acquire) return;
		try {
			const lease = await acquire(origin, mainAgent(origin.id), userTurnId);
			try {
				telemetryHub().emit(
					"turn.settled",
					turnSettlementFromCalls(stopReason, calls, retries, fallbackCause, noAnswer, bareFinishRefusals),
					lease.context,
				);
			} finally {
				await lease.release();
			}
		} catch {
			// Recording an outcome never costs the turn it describes; the journal reports its own write gaps.
		}
	};

	/**
	 * How a step template's pipeline ended, journaled after the turn.settled of its last turn so why-stopped and usage
	 * read a stalled pipeline from the session rather than only from the `run --json` stream (bt-20).
	 */
	const recordStepPipelineSettled = async (userTurnId: string, end: StepPipelineEnd): Promise<void> => {
		const origin = deps.session?.current();
		const acquire = deps.telemetry?.acquireTelemetrySession;
		if (!origin || !acquire) return;
		try {
			const lease = await acquire(origin, mainAgent(origin.id), userTurnId);
			try {
				telemetryHub().emit("step_pipeline.settled", { ...end }, lease.context);
			} finally {
				await lease.release();
			}
		} catch {
			// Recording an outcome never costs the turn it describes; the journal reports its own write gaps.
		}
	};

	/** Append the outcome row, settle the turn, then follow the worker receipts the row reported as partial. */
	const writeTurnOutcome = async (
		record: TurnOutcomeRecord,
		settle: {
			stopReason: unknown;
			retries: number;
			cause: FailureCause | undefined;
			noAnswer?: TurnNoAnswerCause | undefined;
			runIds: ReadonlyArray<string>;
			missing: ReadonlyArray<string>;
		},
	): Promise<void> => {
		const parentTurnId = state.lastTurnId;
		deps.session?.appendEntry({ kind: "custom", customType: "turnOutcome", parentTurnId, display: false, data: record });
		outcomeCollector.seedClarificationStreak(record.conversation.clarificationStreak);
		await recordTurnSettled(record.turnId, settle.stopReason, settle.retries, settle.cause, settle.noAnswer);
		workerReceipts.amendLate({ turnId: record.turnId, parentTurnId, runIds: settle.runIds, missing: settle.missing });
	};

	/**
	 * A turn the operator cancelled before admission (the pre-turn reads, the
	 * orientation act or pre-submit compaction) leaves no user turn, so the settle
	 * path never runs for it, yet Esc on a turn is the strongest label there is.
	 * This writes the one outcome row that path would have, under the reserved
	 * id every decision about the turn already carries.
	 */
	const recordCanceledBeforeAdmission = async (input: {
		userTurnId: string;
		continuation: boolean;
		control: TurnControlRecord | null;
		submittedAt: number;
	}): Promise<void> => {
		if (!deps.session?.current()) return;
		try {
			if (input.control) outcomeCollector.recordControl(input.control);
			const collected = outcomeCollector.take(input.userTurnId);
			const missingReceipts = await workerReceipts.awaitSeal(collected.harness.runIds);
			const record = reduceTurnOutcome({
				...collected,
				turnId: input.userTurnId,
				turnIndex: operatorTurnIndex(),
				continuation: input.continuation,
				finalAssistantText: "",
				taskEstablished: deps.getTaskEstablished?.() ?? false,
				canceled: true,
				tokens: {
					coordinator: noOutcomeUsage(),
					workers: workerReceipts.usage(collected.harness.runIds),
				},
				failure: classifyCallFailure("Cancelled before admission", { invoked: false, aborted: true, retryAttempts: 0 }),
				stopReason: "aborted",
				durationMs: Math.max(0, performance.now() - input.submittedAt),
			});
			await writeTurnOutcome(record, {
				stopReason: "aborted",
				retries: 0,
				cause: "operator_cancel",
				runIds: collected.harness.runIds,
				missing: missingReceipts,
			});
		} catch {
			// Measurement must not change how a cancelled turn settles.
		}
	};

	const prewarm = createTurnPrewarm({
		callJournal: (runtime, origin) => sideCallJournal(runtime, "prewarm", origin),
		notice: (text) => emitNotice(text),
		// Prompt guidance is interactive exactly on the terminal UI: neither headless nor ACP.
		isAttended: () => deps.interactiveGuidance === true,
		state,
		getSettings: deps.getSettings,
		providers: deps.providers,
		context,
		bus: deps.bus,
		...(deps.admitFlow !== undefined ? { admitRuntimeFlow: deps.admitFlow } : {}),
		...(deps.session ? { session: deps.session } : {}),
		isLatencySurface: () => deps.isLatencySurface?.() !== false,
		isTurnActive: () => loop.turnActive || deps.isPrewarmBusy?.() === true,
		hasActiveDispatch: () => deps.hasAttachedDispatch?.() === true,
		prepareRuntime: async (signal) => {
			// The same probe a submit awaits, so the pre-warm resolves the model the
			// next turn will resolve rather than a stale catalog entry.
			await turnRuntime.ensureLiveCapabilitiesForSelectedModel({ silent: true }).catch(() => {});
			return prepareOutOfTurnRound("a turn is in flight", signal, true);
		},
		applySessionTools: (runtime) => {
			runtime.agent.state.tools = resolveSessionTools(
				runtime,
				deps.toolRegistry,
				currentToolInvokeOptions,
				turnRuntime.toolTelemetry,
				loop.sessionToolLimits,
			);
		},
		...(deps.registerPrewarmEndpointSlot ? { registerEndpointSlot: deps.registerPrewarmEndpointSlot } : {}),
	});
	const unsubscribePrewarmCompaction = subscribePrewarmToCompaction(deps.bus, prewarm);
	// #423: a hosted route's prompt cache outlives the turn's waits on its own tools, above all an attached dispatch.
	const keepalive = createTurnKeepalive({
		enabled: () => deps.getSettings().chat.cacheKeepalive,
		isTurnActive: () => loop.turnActive,
		waitsOnOperator: () => state.currentAskUserPolicy?.inFlight === true || deps.toolRegistry?.hasParkedCalls() === true,
		hasAttachedDispatch: () => deps.hasAttachedDispatch?.() === true,
		isCurrentRuntime: (runtime) => state.runtime === runtime,
		canSpend: (usd) => {
			const budget = deps.scheduling?.preflight();
			return budget === undefined || !sessionCeilingReached(budget.currentUsd + usd, budget.ceilingUsd);
		},
		withEndpointSlot,
		callJournal: (runtime) => sideCallJournal(runtime, "prewarm", deps.session?.current() ?? null).telemetry,
		record: createKeepaliveRecord(deps, state),
	});
	// The prompt this process will send is known now: the session prompt compiles
	// against the configured target, and a boot-time resume rebuilds the message
	// array in the same tick, which the scheduler collapses onto one round.
	prewarm.schedule("session-start");
	return {
		continueStoppedTurn,
		interruptRefusalReason,
		keepalive,
		operatorTurnIndex,
		prepareCompactionPaint,
		prepareNextRequest,
		prepareOutOfTurnRound,
		prewarm,
		recordCanceledBeforeAdmission,
		recordStepPipelineSettled,
		restorableQueuedText,
		sideCallAdmission,
		sideCallJournal,
		stepTurnEnd,
		submittedTurnOrigin,
		unsubscribePrewarmCompaction,
		withEndpointKeySlot,
		withEndpointSlot,
		workerReceipts,
		writeTurnOutcome,
		yoloContinuationDue,
	};
}
