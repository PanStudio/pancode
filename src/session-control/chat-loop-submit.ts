// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomUUID } from "node:crypto";
import { formatCount } from "../core/format-time.js";
import { TURN_CONTINUATION_CAP } from "../core/job-types.js";
import { isPlanOnlyRequest } from "../core/plan-request.js";
import { hostFramedTexts } from "../core/reminder-framing.js";
import { withModelSkillActivation } from "../core/skill-activation.js";
import { mainAgent } from "../core/telemetry/context.js";
import {
	narrowTurnConstraints,
	routeScopedTurnConstraints,
	snapshotTurnConstraints,
	turnScopeGuidance,
} from "../core/turn-constraints.js";
import type { LiveBudgetView } from "../domains/context/budget/live-view.js";
import { requestFits } from "../domains/context/budget/request-fit.js";
import { stepCheckpointApplies } from "../domains/context/fold/contract.js";
import { toContextOverflowError } from "../domains/providers/errors.js";
import {
	acceptsImageInput,
	modelEndpointKey,
	registerForegroundStream,
	runtimeTargetSnapshot,
} from "../domains/providers/index.js";
import { visionObservationText } from "../domains/providers/vision-sidecar.js";
import type { ContextSnapshot } from "../domains/session/context-accounting.js";
import { readPromptCompileRecords } from "../domains/session/prompt-manifest.js";
import { classifyRecoveryFailure, isRetryableRecoveryFailure } from "../domains/session/retry.js";
import { activePath, findLastEntry } from "../domains/session/tree/active-path.js";
import type { TelemetrySessionLease } from "../domains/telemetry/session-journals.js";
import type { TurnControlRecord } from "../domains/turn-control/index.js";
import { reduceTurnOutcome } from "../domains/turn-control/index.js";
import { replaceEngineMessages } from "../engine/agent.js";
import { countImageBlocks } from "../engine/image-context.js";
import { isLockedSynthesisFallbackOnly, lockedSynthesisRepromptMessages } from "../engine/loop-guard-synthesis.js";
import type { AgentMessage, AnthropicMessagesCompat } from "../engine/types.js";
import { modelMayActivateSkills } from "../lib/autonomy/autonomy.js";
import { resolveSessionTools } from "../tools/agent-tools.js";
import { finalizeAskUserInterviewForHost } from "../tools/ask-user.js";
import { scopedCapabilityShapes, scopeShapesDelta } from "../tools/gateway/scope-shapes.js";
import type { ChatLoop, ChatSubmitOptions, StepPipelineEnd } from "./chat-loop.js";
import {
	classifyTurnEnding,
	createAskUserToolPolicy,
	createPendingSkillToolPolicy,
	detectOverflowFromState,
	detectTerminalFailureFromState,
	extractText,
	HOST_STATUS_NOTICE_KEY,
	isThinkingOnlyLengthStop,
	notConfiguredNotice,
	noticeMessage,
	pendingSkillRequestPreamble,
	rebaseToolMarkupReprompt,
	sumRunUsage,
	THINKING_LENGTH_STOP_REASON,
	terminalFailureFromAssistantMessage,
	toolSignatureFromState,
} from "./chat-loop-messages.js";
import type { ChatLoopScope } from "./chat-loop-scope.js";
import { lastAssistantText } from "./chat-loop-steering.js";
import { lastToolCallOf } from "./continuation-tool-call.js";
import { withSettledHistory } from "./message-list-digest.js";
import { resolveFitOutputReserve, turnAdmissionRemedy } from "./output-reserve.js";
import {
	REPETITION_REPROMPT_NOTICE_KEY,
	repetitionRecoveryStage,
	repetitionRepromptMessages,
} from "./repetition-detector.js";
import { retireActiveUserContextForNextOperator } from "./session-replay-messages.js";
import { type StepRun, stepTurnOutcome } from "./step-start.js";
import { compactCommandHint, routeCommandHint } from "./surface-hints.js";
import {
	lowerThinkingLevel,
	THINKING_LENGTH_RECOVERY_NOTICE_KEY,
	THINKING_LENGTH_STOP_NOTICE_KEY,
	thinkingLengthRecoveryMessages,
} from "./thinking-length-recovery.js";
import type { AwaitedTurnStart } from "./turn-middleware.js";
import { DEFAULT_STEERING_MODE, type SteeringMode } from "./turn-queues.js";
import { reclassifyStallAbort, recoveryAttemptHasOutput } from "./turn-recovery.js";
import { TurnAdmissionError } from "./turn-runtime.js";
import type { ChatLoopSubmitState } from "./turn-state.js";
import { type AgentRuntime, clearActiveInterrupt, takeInterruptedCall } from "./turn-state.js";
import { noOutcomeUsage } from "./worker-receipts.js";
import { isWorkerShareNote } from "./worker-share.js";

/** Closing notice an operator interrupt leaves in the transcript and the ledger. */
export const INTERRUPT_CANCEL_REASON = "[PanCode] run interrupted by operator; delivering the new message now.";

/** The same redirect when triage read a queued message as a stop; no operator cancelled anything. */
export const TRIAGE_INTERRUPT_REASON =
	"[PanCode] run interrupted because triage read the new message as a stop; delivering it now.";

export const isRedirectReason = (reason: string | null | undefined): boolean =>
	reason === INTERRUPT_CANCEL_REASON || reason === TRIAGE_INTERRUPT_REASON;

export const ENGINE_ACTIVE_PROMPT_ERROR =
	"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.";

export const ACTIVE_PROMPT_NOTICE =
	"[PanCode] another response was already active, so this response could not start. Wait for it to finish, then submit again.";

export function operatorFacingEngineError(message: string): string {
	return message.includes(ENGINE_ACTIVE_PROMPT_ERROR) ? ACTIVE_PROMPT_NOTICE : message;
}

export function stepPipelineEnd(
	policy: { stepTool: string; template?: string },
	run: StepRun,
	capSpent: boolean,
	settledCleanly: boolean,
	ended: "cancel" | "failure" | null,
): StepPipelineEnd {
	// A cancel or a failure is what ended the pipeline, at the cap or below it.
	const stoppedBy =
		ended !== null
			? ended
			: !capSpent
				? ("turn" as const)
				: run.carried === true && settledCleanly
					? ("unreported" as const)
					: ("cap" as const);
	return {
		stepTool: policy.stepTool,
		...(policy.template === undefined ? {} : { template: policy.template }),
		done: run.pipelineDone,
		...(run.pipelineDone ? {} : { stoppedBy }),
	};
}

/**
 * Why a forced compaction failed, in words: `compaction stream failed: 401: {"message":"invalid api key"}` reads
 * `the provider answered 401: invalid api key`.
 */
export function compactionFailureReason(err: unknown): string {
	const raw = (err instanceof Error ? err.message : String(err)).replace(/^compaction stream failed:\s*/u, "");
	const status = /^(\d{3}):\s*/u.exec(raw);
	const rest = status ? raw.slice(status[0].length) : raw;
	let detail = rest.trim();
	try {
		const parsed: unknown = JSON.parse(detail);
		const message =
			parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string"
				? parsed.message
				: null;
		if (message !== null) detail = message;
	} catch {
		// Not JSON: the provider's text is already the reason.
	}
	detail = detail.replace(/[.\s]+$/u, "");
	return status ? `The provider answered ${status[1]}: ${detail}` : `The summary call failed: ${detail}`;
}

/** The chat loop's `submit`: runs one submitted turn from admission to settlement. */
export function createChatLoopSubmit(loop: ChatLoopScope, state: ChatLoopSubmitState): ChatLoop["submit"] {
	const {
		armSkillSurface,
		context,
		continueStoppedTurn,
		currentToolInvokeOptions,
		currentTurnFailure,
		deps,
		emit,
		emitAdmissionNotice,
		emitNotice,
		endPreparationCompaction,
		headlessObservation,
		interruptRefusalReason,
		markPreparationStep,
		messagePath,
		middleware,
		middlewareToolChoice,
		noteTurnControlCollection,
		nullRuntimeAdmissionReason,
		operatorMemory,
		operatorTurnIndex,
		outcomeCollector,
		persistence,
		prepareCompactionPaint,
		queuedForTriage,
		queues,
		recordCanceledBeforeAdmission,
		recordRecovery,
		recordStepPipelineSettled,
		recovery,
		refuseSkillRequests,
		retrySettings,
		setTurnPreparation,
		stepPipeline,
		stepStarts,
		submittedTurnOrigin,
		turnRuntime,
		visionModelOptions,
		workerReceipts,
		writeTurnOutcome,
		yoloContinuationDue,
	} = loop;
	return async function submit(text: string, options: ChatSubmitOptions = {}): Promise<void> {
		let owner: AbortController | null = null;
		let promptStarted = false;
		const generation = loop.submitGeneration;
		const admissionCurrent = (): boolean =>
			!loop.disposed &&
			generation === loop.submitGeneration &&
			!owner?.signal.aborted &&
			options.isAdmissionCurrent?.() !== false;
		const returnUnstarted = (): void => {
			if (options.queued === undefined || promptStarted || loop.disposed) return;
			if (generation === loop.submitGeneration) queues.requeueUnstarted(options.queued);
			else queues.reportDropped([options.queued]);
		};
		if (!admissionCurrent()) {
			returnUnstarted();
			return;
		}
		const submittedAt = performance.now();
		const submittedWallAt = Date.now();
		const continuedMessage = options.queued ?? options.continuesMessage;
		// Memory hot keywords read only words the operator typed: never a continuation, a machine or peer turn, a
		// queued resubmit (read when it was first submitted), a worker's shared answer, or file and skill bodies
		// an expansion inlined without keeping the typed line.
		const typedWords =
			options.origin !== undefined ||
			options.machineTurn !== undefined ||
			options.requestContinuation === true ||
			options.yoloContinuation === true ||
			continuedMessage !== undefined ||
			isWorkerShareNote(text)
				? null
				: (options.display?.text ??
					((options.workingContextPaths?.length ?? 0) + (options.pendingSkillRequests?.length ?? 0) > 0 ? null : text));
		const memoryCapture = typedWords === null ? null : operatorMemory.handleTyped(typedWords);
		if (memoryCapture !== null) {
			const { captureOnly } = await memoryCapture;
			if (captureOnly) {
				// The statement was the whole submission: it is stored, and no model turn follows.
				options.onAdmitted?.();
				return;
			}
			if (!admissionCurrent()) {
				returnUnstarted();
				return;
			}
		}
		let interrupted = false;
		if (state.streaming) {
			if (options.machineTurn !== undefined) return;
			let mode: SteeringMode = options.origin !== undefined ? "end-of-turn" : (options.steering ?? DEFAULT_STEERING_MODE);
			let front = options.queueFront === true;
			const trimmed = text.trim();
			// A constrained submission is refused below unless the interrupt
			// lands, so the fallbacks must not announce it as queued.
			const constrained = options.constraints !== undefined;
			let refusal: string | null = null;
			if (mode === "interrupt" && trimmed.length > 0) {
				refusal = interruptRefusalReason();
				if (refusal !== null) {
					if (!constrained)
						emitNotice(`[PanCode] interrupt refused: ${refusal}. Queued for the next slot instead.`, "warning");
					mode = "next-slot";
					front = true;
				} else {
					// Cancel, then wait for the cancelled run to settle (its in-flight
					// tool results and closing ledger turn), then fall through to the
					// fresh-prompt path below. `priorSubmit` is the run being cancelled;
					// `activeSubmit` already points at this call.
					const prior = loop.priorSubmit;
					loop.api.cancel(
						options.triageInterrupt === true
							? {
									reason: TRIAGE_INTERRUPT_REASON,
									source: "triage",
									auditReason: "triage read a queued message as a stop",
								}
							: { reason: INTERRUPT_CANCEL_REASON, auditReason: "operator interrupted the run with a message" },
					);
					await prior;
					if (!admissionCurrent()) {
						returnUnstarted();
						return;
					}
					if (!state.streaming) {
						interrupted = true;
					} else {
						// Something restarted a run while the cancel settled (a
						// continuation resubmit); do not fight it, deliver at the next slot.
						if (!constrained)
							emitNotice(
								"[PanCode] a run restarted before the interrupt landed. Queued for the next slot instead.",
								"warning",
							);
						mode = "next-slot";
					}
				}
			}
			if (!interrupted) {
				if (constrained && options.queueConstrainedTurn === true && refusal === null && trimmed.length > 0) {
					const referencedPaths = options.workingContextPaths ?? [];
					if (referencedPaths.length > 0) {
						deps.labelReferencedPaths?.(referencedPaths);
						context.addWorkingContextPaths(referencedPaths);
					}
					const entry = queues.queueFollowUp(text, options.display, {
						referencedPaths,
						...(options.constraints ? { constraints: options.constraints } : {}),
						...(continuedMessage ? { continues: continuedMessage } : {}),
					});
					// Silent like any queued message: the queue panel is the signal, and the settle names it as it starts.
					// Triage labels it like any queued message; its pinned constraints keep it from interrupting or re-kinding.
					if (queuedForTriage(entry)) return;
				}
				if (constrained) {
					emitAdmissionNotice(
						`A submission with explicit task constraints must start a fresh turn; ${
							refusal !== null ? `the interrupt was refused: ${refusal}` : "wait for settlement or interrupt the active run"
						}.`,
						"constrained-turn-in-flight",
						"error",
					);
					options.onRefused?.("constrained-turn-in-flight");
					returnUnstarted();
					return;
				}
				const hasImages = options.images !== undefined && options.images.length > 0;
				if (!hasImages && trimmed.length > 0 && state.runtime) {
					// Enter while streaming means "correct it now": the engine
					// steering queue drains after every tool batch, so the text
					// lands as a user message before the next model turn.
					// The end-of-turn mode (ACP, or the navigator's slot toggle) keeps the after-this-run intent.
					if (isWorkerShareNote(trimmed)) state.turnSharedWorkerNote = true;
					// Inlined @file content is part of this text and reaches the model
					// at the next slot without passing the fresh-prompt path, so its
					// information-flow sources are labeled now, not when it lands.
					const referencedPaths = options.workingContextPaths ?? [];
					if (referencedPaths.length > 0) {
						deps.labelReferencedPaths?.(referencedPaths);
						context.addWorkingContextPaths(referencedPaths);
					}
					// The queue carries the submitted bytes, not the trimmed copy the
					// guard above reads: a steer is a model-facing turn and the
					// payload contract applies to it too (issue #244).
					const entry =
						mode === "end-of-turn"
							? queues.queueFollowUp(text, options.display, {
									referencedPaths,
									...(options.origin !== undefined ? { origin: options.origin } : {}),
									...(continuedMessage ? { continues: continuedMessage } : {}),
								})
							: queues.steer(text, options.display, {
									front,
									referencedPaths,
									...(continuedMessage ? { continues: continuedMessage } : {}),
								});
					queuedForTriage(entry);
					return;
				}
				emitNotice("[PanCode] response already in progress. Press Esc to cancel the active run.");
				return;
			}
		}

		if (deps.autonomy !== undefined) {
			// A turn PanCode sends itself waits while yolo is paused; the operator's own prompt reopens the window.
			const ownTurn =
				options.requestContinuation === true ||
				options.yoloContinuation === true ||
				options.machineTurn !== undefined ||
				options.origin !== undefined;
			if (!ownTurn) deps.autonomy.operatorSpoke();
			else if (deps.autonomy.halted() !== null) {
				returnUnstarted();
				return;
			}
		}

		owner = new AbortController();
		loop.submitOwner?.abort();
		loop.submitOwner = owner;
		if (options.flushQueue === true) queues.flushOnNextPrompt();
		// A continuation or a machine turn is PanCode's own and no message anyone sent.
		const pathMessage =
			options.requestContinuation === true || options.yoloContinuation === true || options.machineTurn !== undefined
				? null
				: {
						id: continuedMessage?.id ?? `prompt_${randomUUID().slice(0, 8)}`,
						submittedAt: continuedMessage?.enqueuedAt ?? submittedWallAt,
					};
		if (pathMessage && !continuedMessage)
			messagePath.submitted(pathMessage, {
				chars: text.length,
				by: options.origin === undefined ? "operator" : "machine",
				wallMs: submittedWallAt,
				mono: submittedAt,
			});
		let turnLease: TelemetrySessionLease | undefined;
		/**
		 * What this submit holds for its requests (the taken buffer, an armed tool choice, a flushed continuation, the
		 * awaited gate's effects); a return before a request carries them suppresses their firings.
		 */
		const turnHolds = middleware.beginTurnHolds();
		try {
			await loop.sessionResetSettlement;
			if (!admissionCurrent()) return;
			// The turn holds its session's writer open from submit to settle, so the records it makes outside a model
			// call (middleware at turn start, tools, snapshots) reach the journal after an idle close (#434).
			const turnOrigin = deps.session?.current();
			if (turnOrigin && deps.telemetry?.acquireTelemetrySession) {
				try {
					turnLease = await deps.telemetry.acquireTelemetrySession(turnOrigin, mainAgent(turnOrigin.id));
				} catch {
					// The writer reports its own failures; a turn never waits on telemetry.
				}
				if (!admissionCurrent()) return;
			}
			state.currentTurnConstraints =
				options.requestContinuation === true
					? state.currentTurnConstraints
					: snapshotTurnConstraints(narrowTurnConstraints(loop.promptToolLimits, options.constraints));
			const previousRunSnapshot = state.lastRunSnapshot;
			let previousThinkingLevel: string | undefined = previousRunSnapshot?.runtimeResolution?.effectiveThinkingLevel;
			let previousModel: { targetId: string; modelId: string } | undefined = previousRunSnapshot
				? { targetId: previousRunSnapshot.targetId, modelId: previousRunSnapshot.wireModelId }
				: undefined;
			if (previousThinkingLevel === undefined || previousModel === undefined) {
				// #423: resume can append the newly requested dial before this loop boots.
				// Recover what the last call used, ignoring changes after that call.
				const entries = activePath(deps.readSessionEntries?.() ?? [], state.lastTurnId ?? undefined);
				const entry = findLastEntry(entries, (row) => row.kind === "message" && row.role === "assistant");
				const lastCall = entry ? entries.lastIndexOf(entry) : -1;
				if (entry?.kind === "message") {
					const payload = entry.payload as {
						promptCache?: {
							observation?: { requestFingerprint?: { thinkingLevel?: string; targetId?: string; modelId?: string } };
						};
					} | null;
					const fingerprint = payload?.promptCache?.observation?.requestFingerprint;
					if (previousModel === undefined && fingerprint?.targetId !== undefined && fingerprint.modelId !== undefined)
						previousModel = { targetId: fingerprint.targetId, modelId: fingerprint.modelId };
					previousThinkingLevel ??= fingerprint?.thinkingLevel;
					if (previousThinkingLevel === undefined) {
						const meta = deps.session?.current();
						const compile = meta
							? readPromptCompileRecords(meta)
									.reverse()
									.find((record) => record.at <= entry.timestamp)
							: undefined;
						previousThinkingLevel = compile?.thinkingLevel ?? undefined;
						const change = entries
							.slice(0, lastCall)
							.reverse()
							.find((row) => row.kind === "thinkingLevelChange");
						if (change?.kind === "thinkingLevelChange" && (!compile || change.timestamp > compile.at)) {
							previousThinkingLevel = change.thinkingLevel;
						}
					}
				}
			}
			let agentRuntime: AgentRuntime | null;
			try {
				markPreparationStep("capabilities");
				await turnRuntime.ensureLiveCapabilitiesForSelectedModel();
				if (!admissionCurrent()) return;
				agentRuntime = turnRuntime.ensureRuntime();
			} catch (err) {
				emitAdmissionNotice(
					err instanceof Error ? err.message : String(err),
					err instanceof TurnAdmissionError ? err.reason : "admission-failed",
					"error",
				);
				return;
			}
			if (!agentRuntime) {
				emitAdmissionNotice(notConfiguredNotice(deps.getSettings().chat), nullRuntimeAdmissionReason(), "error");
				return;
			}
			// A template step policy scoped by `when` applies only on a matching route, read at each turn's start (C5).
			state.currentTurnConstraints = routeScopedTurnConstraints(
				state.currentTurnConstraints,
				agentRuntime.runtimeResolution,
			);
			if (options.machineTurn?.preparationToken === loop.machinePreparation?.token && loop.machinePreparation !== null)
				loop.machinePreparation.runtime = agentRuntime;
			if (refuseSkillRequests(options.pendingSkillRequests ?? [], options.workingContextPaths ?? [])) return;
			// A request continuation resumes the turn in progress, so it keeps that turn's origin.
			if (options.requestContinuation !== true) {
				// CLI-P46: a yolo continuation belongs to the prompt its chain started from, an operator message handed in included.
				const prior = state.currentTurnOrigin?.origin ?? null;
				state.currentTurnOrigin = submittedTurnOrigin(options);
				if (options.yoloContinuation !== true) state.promptOrigin = state.currentTurnOrigin.origin;
				else if (prior !== "continuation") state.promptOrigin = prior;
			}
			if (deps.promptSubmit && options.requestContinuation !== true) {
				markPreparationStep("prompt-hook");
				const origin = state.currentTurnOrigin ?? { origin: "operator" as const };
				const verdict = await deps.promptSubmit({
					typed: options.display?.text ?? text,
					text,
					// Only a continuation's hooks hear what the turn it continues last called.
					origin:
						options.yoloContinuation === true && options.continuationToolCall !== undefined
							? { ...origin, lastToolCall: options.continuationToolCall }
							: origin,
				});
				if (!admissionCurrent()) return;
				if (verdict.kind === "block") {
					emit({
						type: "notice",
						level: "warning",
						surface: "transcript",
						text: verdict.reason,
						admission: { reason: "prompt-blocked" },
					});
					return;
				}
				text = verdict.text;
			}
			const pendingSkillRequests =
				state.currentTurnConstraints?.skills === "disabled" ? [] : (options.pendingSkillRequests ?? []);
			// The user turn id is fixed before the turn_start gate and turn control run, so
			// their records and the ledger row carry the id the user turn will be filed under.
			// A run that returns before admission leaves the id unused, which costs nothing.
			const reservedUserTurnId = randomUUID();
			// The awaited turn_start phase is the turn's gate. Like the prompt gate it
			// decides before the turn spends anything (an image sidecar call, turn
			// control) or buffers a reminder, so a refused turn leaves nothing for the
			// next prompt. Its effects apply after the synchronous turn_start phase.
			let awaitedTurnStart: AwaitedTurnStart | undefined;
			if (options.requestContinuation !== true) {
				markPreparationStep("turn-start");
				const gate = await middleware.awaitTurnStart(agentRuntime, text, pendingSkillRequests.length, reservedUserTurnId);
				if (!admissionCurrent()) return;
				// A blocking turn_start hook that failed refuses the turn before its first model request.
				if (gate.refusal !== null) {
					emitAdmissionNotice(gate.refusal, "turn-blocked", "warning");
					return;
				}
				awaitedTurnStart = gate;
			}
			const operatorText = text;
			let sidecarObservation: string | null = null;
			const routeAcceptsImages = acceptsImageInput({
				runtimeId: agentRuntime.runtimeResolution.runtime.id,
				vision: agentRuntime.runtimeResolution.capabilityDecisions.vision,
			});
			if (options.images?.length && !routeAcceptsImages) {
				if (deps.visionSidecar?.configured()) {
					const sidecar = deps.visionSidecar;
					const controller = owner;
					loop.pendingVisionSidecar = controller;
					emitNotice(
						`[PanCode] Processing image with ${sidecar.label() ?? "vision sidecar"}...`,
						"info",
						HOST_STATUS_NOTICE_KEY,
					);
					try {
						const question = operatorText.trim() || "Describe the attached image and any visible text.";
						markPreparationStep("images");
						const analysis = await sidecar.analyze(options.images, question, controller.signal);
						if (controller.signal.aborted || !admissionCurrent()) return;
						sidecarObservation = visionObservationText(analysis);
						text = [operatorText, sidecarObservation].filter(Boolean).join("\n\n");
						emitNotice(`[PanCode] Image processed with ${analysis.model}.`, "info", HOST_STATUS_NOTICE_KEY);
					} catch (err) {
						if (controller.signal.aborted) {
							emitAdmissionNotice("[PanCode] Image processing cancelled.", "vision-sidecar-cancelled", "info");
						} else {
							const reason = err instanceof Error ? err.message : String(err);
							emitAdmissionNotice(`[PanCode] Image processing failed: ${reason}`, "vision-sidecar-failed", "error");
						}
						return;
					} finally {
						if (loop.pendingVisionSidecar === controller) loop.pendingVisionSidecar = null;
					}
				} else {
					const route = agentRuntime.runtimeResolution;
					const choices = visionModelOptions();
					const alternatives = choices.length
						? ` Known vision-capable models: ${choices.join(", ")}. Open /model to switch.`
						: " No vision-capable models are known in the configured catalog.";
					emit({
						type: "notice",
						level: "warning",
						surface: "transcript",
						text: `IMAGE_INPUT_UNSUPPORTED: ${route.targetId}/${route.wireModelId} cannot accept image input.${alternatives}`,
						admission: { reason: "image-input-unsupported" },
						source: "images",
					});
					return;
				}
			}
			const historicalImages = countImageBlocks(agentRuntime.agent.state.messages);
			if (!routeAcceptsImages && historicalImages > 0) {
				const route = agentRuntime.runtimeResolution;
				const key = `${route.targetId}/${route.wireModelId}:${historicalImages}`;
				if (key !== loop.lastHistoricalImageNoticeKey) {
					loop.lastHistoricalImageNoticeKey = key;
					emitNotice(
						`[PanCode] ${historicalImages} earlier image${historicalImages === 1 ? "" : "s"} omitted from requests to text-only ${route.targetId}/${route.wireModelId}. The original images remain in session history for a vision-capable model.`,
						"warning",
						undefined,
						undefined,
						"images",
					);
				}
			} else {
				loop.lastHistoricalImageNoticeKey = null;
			}

			// 1. Accept the prompt: reset per-turn accounting, freeze the tool
			// surface, fire turn_start, and assemble the submitted text.
			state.turnToolCalls = 0;
			state.toolMarkupReprompt = rebaseToolMarkupReprompt(state.toolMarkupReprompt);
			state.turnToolNames = [];
			state.turnCallsDone = [];
			state.turnSharedWorkerNote = isWorkerShareNote(text);
			state.turnCollectedDetachedBatch = false;
			state.turnCompletion = null;
			state.turnSealedCompletion = null;
			// The finish round and the bare-finish refusal are once per operator prompt (fleet M5, FX-40, FX-41): a yolo
			// continuation of the prompt keeps them; a handed-over operator message resets the refusal (turn-persistence).
			if (options.requestContinuation !== true && options.yoloContinuation !== true) {
				state.turnCalledWork = false;
				state.finishRoundSpent = false;
				state.finishReplyRefused = false;
				state.finishOutputRefused = false;
				state.turnReplied = false;
				// Per operator prompt: a later submit of the same host run (an --output-schema repair) keeps the pool's fact.
				if (options.machineTurn === undefined) headlessObservation?.reset(options.hostRun?.runId);
			}
			state.continuation.beginPrompt({
				requestContinuation: options.requestContinuation === true,
				yoloContinuation: options.yoloContinuation === true,
			});
			middlewareToolChoice.reset();
			const images = sidecarObservation === null && options.images?.length ? [...options.images] : undefined;
			// Inlined @file content is part of this text, and the pre-turn decision or
			// a preparation compaction can send it before the user turn is filed.
			// A first turn has no session to hold the label yet, so it is recorded
			// again once the turn below has created one.
			const referencedPaths = options.workingContextPaths ?? [];
			if (referencedPaths.length > 0) deps.labelReferencedPaths?.(referencedPaths);
			context.addWorkingContextPaths(referencedPaths);
			context.prepareMemoryTurn(agentRuntime, {
				taskText: text,
				continuation: options.requestContinuation === true,
				images,
			});
			if (options.requestContinuation !== true) {
				loop.operatorSpokeAt = Date.now();
				try {
					deps.onOperatorTurn?.({ task: text });
				} catch {
					// The host's own bookkeeping never costs the submit.
				}
			}

			let turnControlBlock: string | null = null;
			let turnControlRecord: TurnControlRecord | null = null;
			if (deps.turnControl) {
				const controllerAbort = owner;
				loop.pendingPreTurnRead = controllerAbort;
				setTurnPreparation("preparing");
				markPreparationStep("turn-control");
				try {
					const result = await deps.turnControl.run({
						userTurnId: reservedUserTurnId,
						signal: controllerAbort.signal,
					});
					if (generation !== loop.submitGeneration || loop.disposed) return;
					if (!controllerAbort.signal.aborted) noteTurnControlCollection(result);
					turnControlBlock = result.block;
					turnControlRecord = result.record;
				} finally {
					if (loop.pendingPreTurnRead === controllerAbort) loop.pendingPreTurnRead = null;
				}
				if (generation !== loop.submitGeneration || loop.disposed) return;
				if (controllerAbort.signal.aborted) {
					await recordCanceledBeforeAdmission({
						userTurnId: reservedUserTurnId,
						continuation: options.requestContinuation === true,
						control: turnControlRecord,
						submittedAt,
					});
					return;
				}
			}
			// A skill the operator activated narrows the tools for the workflow
			// it started, and that workflow outlives the turn it began in. A
			// fresh /skill this turn replaces the armed surface; otherwise the
			// armed surface is what this turn runs under.
			const pendingSkillPolicy = withModelSkillActivation(
				createPendingSkillToolPolicy(pendingSkillRequests) ?? state.activeSkillSurface,
				state.currentTurnConstraints?.skills !== "disabled" && modelMayActivateSkills(),
			);
			if (pendingSkillPolicy) {
				pendingSkillPolicy.allowListAdvisory = (deps.getAutonomy?.() ?? deps.getSettings().safety.autonomy) === "yolo";
			}
			// What was already loaded when this turn started, so the settle-time
			// notice names the skills this turn activated and not the ones a
			// carried surface has been holding since an earlier message.
			const skillsLoadedBeforeTurn = new Set(pendingSkillPolicy?.loadedSkillNames ?? []);
			// Resolve the frozen session tool surface before turn_start so intent
			// middleware sees the exact tools this request can actually call.
			agentRuntime.agent.state.tools = resolveSessionTools(
				agentRuntime,
				deps.toolRegistry,
				currentToolInvokeOptions,
				turnRuntime.toolTelemetry,
				loop.sessionToolLimits,
			);
			const toolSignature = toolSignatureFromState(agentRuntime.agent.state.tools);
			const askUserPolicy = createAskUserToolPolicy(
				agentRuntime.agent.state.tools,
				deps.toolRegistry,
				state.currentTurnConstraints,
			);
			if (askUserPolicy) askUserPolicy.planOnly = isPlanOnlyRequest(text);
			if (options.yoloContinuation !== true && options.requestContinuation !== true) loop.promptInterview = undefined;
			else if (askUserPolicy && loop.promptInterview) askUserPolicy.closedEarlier = loop.promptInterview;
			// turn_start: the prompt is accepted; registrations may inject
			// context for this request. Accumulated reminders (turn_end
			// advisories from the previous turn plus anything turn_start just
			// emitted) flush into the request as one system-reminder block.
			// Like the skill preamble below, the block is plain visible text in
			// the user message: persisted in the ledger, no hidden prompt
			// machinery.
			middleware.fireTurnStart(
				agentRuntime,
				text,
				pendingSkillRequests.length,
				options.requestContinuation === true,
				reservedUserTurnId,
				awaitedTurnStart,
			);
			// The turn's scope is host-framed text in its own user message, kept
			// verbatim in history, never a recompile of the system prompt (#422).
			// Continuations repeat it so a mid-turn compaction cannot drop it.
			const turnScope = turnScopeGuidance(state.currentTurnConstraints);
			const scopeShapes = scopedCapabilityShapes(deps.toolRegistry, state.currentTurnConstraints?.allowedTools);
			// The prompt delta is read when the text is composed, after
			// ensureSessionPrompt below has compared the live inputs (#423).
			// Pinned extension blocks and the scope's argument shapes are read
			// then too, after any compaction, and go only when the context lacks them.
			const reminderProjection = middleware.takePendingReminderProjection(() =>
				[
					turnScope,
					scopeShapesDelta(scopeShapes, hostFramedTexts(agentRuntime.agent.state.messages)),
					context.sessionPromptDelta(),
					...context.pinnedContextDelta(agentRuntime),
				].filter((part) => part.length > 0),
			);
			// Pending skill requests are plain visible text in the user message
			// itself: persisted in the ledger, no hidden prompt machinery.
			const skillPreamble = pendingSkillRequestPreamble(pendingSkillRequests, agentRuntime.agent.state.tools);
			let taskMemoryHandoffSource = "";
			if (pendingSkillRequests.some((request) => request.name.trim() === "context-handoff")) {
				try {
					taskMemoryHandoffSource = deps.getTaskMemoryHandoffSource?.() ?? "";
				} catch {
					// Handoff export is supplemental; a snapshot failure must not block
					// the explicitly requested skill turn.
				}
			}
			const composeSubmittedText = () =>
				[reminderProjection(), turnControlBlock ?? "", skillPreamble, taskMemoryHandoffSource, text]
					.filter((part) => part.length > 0)
					.join("\n\n");
			const stepLead = stepStarts.begin(
				state.currentTurnConstraints,
				text,
				options.yoloContinuation === true || options.requestContinuation === true,
				{ sessionId: deps.session?.current()?.id ?? null, leafTurnId: state.lastTurnId },
			);
			if (stepLead !== null && stepCheckpointApplies(agentRuntime.runtimeResolution)) {
				try {
					await context.runStepCheckpoint(agentRuntime, stepLead, pendingSkillPolicy);
				} catch (err) {
					emitNotice(
						`[PanCode] step checkpoint failed: ${err instanceof Error ? err.message : String(err)}. This step turn keeps the full history.`,
						"warning",
					);
				}
			}
			let submittedText = composeSubmittedText();

			// 2. Pre-submit auto-compaction trigger. Its stage figures price the request this turn sends, so a runtime
			// a resume just built gets the session prompt first instead of the seeded fallback (bt-47 D1). Only such a
			// runtime compiles here, so a submit whose prompt is applied reads memory once; step 3 owns the fallback replay.
			if (context.sessionPromptPending?.(agentRuntime)) {
				await context.ensureSessionPrompt(agentRuntime, false, undefined, true);
				if (!admissionCurrent()) return;
			}
			const forceNow = process.env.PANCODE_FORCE_COMPACT === "1";
			const paintCompaction = prepareCompactionPaint();
			try {
				setTurnPreparation("compacting");
				await paintCompaction();
				if (!admissionCurrent()) return;
				await context.runAutoCompact(
					agentRuntime,
					forceNow,
					undefined,
					undefined,
					submittedText,
					pendingSkillPolicy,
					undefined,
					undefined,
					options.requestContinuation !== true,
					undefined,
					reservedUserTurnId,
				);
			} catch (err) {
				// A new session or a dispose since submit owns the transcript now; this turn's notice and outcome
				// row belong to the session it left, as on the turn-control and overflow paths.
				if (generation !== loop.submitGeneration || loop.disposed) return;
				const tokens = context.contextUsage().tokens;
				// The cheaper stages run before the summary and may have applied, so the size is stated, not "unchanged".
				const size = tokens !== null ? `; context at ${formatCount(tokens)} tokens` : "";
				const aborted = err instanceof Error && err.name === "AbortError";
				// Worded as the operator's /context compact failure is: the size, why in words, and the way on (HS14).
				// A failure here does not stop the turn, which goes out without a summary. A settled card already states a cancel.
				if (!aborted) {
					emitNotice(
						`[PanCode] auto-compaction failed${size}. ${compactionFailureReason(err)}. This turn goes on without it; ${compactCommandHint(deps.headless === true, deps.session?.current()?.id)} tries again; ${routeCommandHint(deps.headless === true)} picks another route to summarize on.`,
						"warning",
					);
				} else if (!context.lastCompactionCardSettled()) {
					emitNotice(`[PanCode] auto-compaction cancelled${size}`);
				}
				if (aborted) {
					await recordCanceledBeforeAdmission({
						userTurnId: reservedUserTurnId,
						continuation: options.requestContinuation === true,
						control: turnControlRecord,
						submittedAt,
					});
					return;
				}
			} finally {
				endPreparationCompaction();
			}

			if (!admissionCurrent()) return;

			// 3. Session prompt: recompiled only on an explicit event, otherwise the last compile
			markPreparationStep("compile");
			const compiledPrompt = await context.ensureSessionPrompt(agentRuntime, true, submittedText);
			if (!admissionCurrent()) return;
			submittedText = composeSubmittedText();

			// 4. Preflight overflow check, before the user turn is committed.
			// A blocked request must not leave a dangling user entry that the
			// next replay would treat as an unanswered turn.
			const compactionThreshold = deps.getSettings().context.compaction?.threshold ?? null;
			const captureTurnSnapshot = (turnId: string): ContextSnapshot =>
				context.captureRuntimeContextSnapshot(agentRuntime, turnId, compactionThreshold, {
					promptSegments: compiledPrompt
						? compiledPrompt.sections.map((s) => ({ id: s.id, tokenEstimate: s.tokenEstimate }))
						: undefined,
					pendingUserInput: submittedText,
					images,
					promptHash: compiledPrompt?.systemPromptHash,
					toolSignature,
				});

			let turnSnapshot = captureTurnSnapshot("pending");
			// The window-fit gate reads the A4 count, so a request Pi's clamp would refuse compacts first.
			const fitInput = (view: LiveBudgetView): number | null =>
				view.inputTokens === null
					? null
					: (context.overflowFitTokens?.(agentRuntime, submittedText, view.inputTokens) ?? view.inputTokens);
			// The publication and the fit count read one history, so the second matches the first's check by identity (SC-6).
			const admit = (): { view: LiveBudgetView; input: number | null } =>
				withSettledHistory(() => {
					const view = context.refreshLiveBudget(submittedText);
					return { view, input: fitInput(view) };
				});
			const first = admit();
			let admission = first.view;
			// A window too small for the request's fixed part is refused before any call; compaction cannot help it.
			const floorRefusal = context.contextFloorRefusal?.(agentRuntime, submittedText) ?? null;
			if (floorRefusal !== null) {
				emitAdmissionNotice(floorRefusal, "context-window-exceeded", "error");
				return;
			}
			// The output reserve shrinks as input grows, so it is resolved at the count the gate chose.
			const fitReserve = (input: number | null): number | null =>
				input === null ? null : resolveFitOutputReserve(agentRuntime, input);
			const firstInput = first.input;
			if (
				admission.effectiveWindow !== null &&
				!requestFits(firstInput, fitReserve(firstInput), admission.effectiveWindow)
			) {
				const paintOverflow = prepareCompactionPaint();
				setTurnPreparation("compacting");
				let failure: string | undefined;
				let canceled = false;
				await paintOverflow()
					.then(() => {
						if (!admissionCurrent()) return false;
						return context.runAutoCompact(
							agentRuntime,
							true,
							undefined,
							"overflow",
							submittedText,
							pendingSkillPolicy,
							undefined,
							undefined,
							options.requestContinuation !== true,
							undefined,
							reservedUserTurnId,
						);
					})
					.catch((error: unknown) => {
						canceled = error instanceof Error && error.name === "AbortError";
						failure = error instanceof Error ? error.message : String(error);
					})
					.finally(endPreparationCompaction);
				if (generation !== loop.submitGeneration || loop.disposed) return;
				// An operator cancel is not an admission failure: record it like the
				// pre-admission cancels above and leave no window-exceeded notice.
				// Stop aborts the submit owner too, so the owner check alone must
				// not skip the reserved turn's outcome.
				if (canceled || owner?.signal.aborted) {
					await recordCanceledBeforeAdmission({
						userTurnId: reservedUserTurnId,
						continuation: options.requestContinuation === true,
						control: turnControlRecord,
						submittedAt,
					});
					return;
				}
				if (!admissionCurrent()) return;
				submittedText = composeSubmittedText();
				const admitted = admit();
				admission = admitted.view;
				const admittedInput = admitted.input;
				const admittedReserve = fitReserve(admittedInput);
				if (admission.effectiveWindow !== null && !requestFits(admittedInput, admittedReserve, admission.effectiveWindow)) {
					const oversize = context.oversizedResult?.(agentRuntime, submittedText);
					emitAdmissionNotice(
						`[PanCode] Request exceeds the available context window (input ${admittedInput ?? "unknown"} + output ${admittedReserve ?? "unknown"}, window ${admission.effectiveWindow ?? "unknown"}).${failure ? ` ${failure}` : ""}${oversize ? ` ${oversize}` : ""} ${turnAdmissionRemedy(agentRuntime, admittedInput ?? 0)}`,
						"context-window-exceeded",
						"error",
					);
					return;
				}
				turnSnapshot = captureTurnSnapshot("pending");
			}

			if (!admissionCurrent()) return;

			if (options.machineTurn !== undefined) {
				if (!options.machineTurn.onStarting() || !admissionCurrent() || state.streaming) return;
			}

			// 5. Append the user turn, then stamp and persist the snapshot.
			// PendingSkillRequest is intent only; SkillActivation ledger entries
			// are recorded on skill-load success.
			const userTurnId = persistence.appendSubmittedUserTurn(
				agentRuntime,
				submittedText,
				options.images?.length ? options.images : undefined,
				options.requestContinuation === true,
				operatorText,
				options.display?.text,
				reservedUserTurnId,
				options.origin,
				options.operatorAuthored === true,
			);
			// A turn that may only answer and call no tool (`run --output-schema`'s repair) goes out text-only, tool_choice
			// none, with its tool list unchanged so the cached prefix holds (D8, #423). The append above reset the choice.
			if (state.currentTurnConstraints?.mode === "answer" && state.currentTurnConstraints.allowedTools?.length === 0)
				middlewareToolChoice.apply([{ kind: "lock_tools" }]);
			if (referencedPaths.length > 0) deps.labelReferencedPaths?.(referencedPaths);
			const turnIndex = operatorTurnIndex(userTurnId ?? undefined);
			// A continuation is a synthetic user turn, which the count skips.
			if (options.requestContinuation !== true) loop.operatorTurnsBefore = turnIndex + 1;
			context.installMemoryRestoration(agentRuntime, submittedText, userTurnId ?? undefined);
			context.commitMemoryTurn(agentRuntime);
			// An interrupt was submitted while a run was active, so no caller drew
			// it in the transcript; render it here, after the cancel notice and the
			// cancelled run's leftovers, which is the order the ledger has. A queued
			// entry sent from idle has no caller to draw it either.
			if (interrupted || (options.steering === "interrupt" && options.queued !== undefined))
				emit({
					type: "queued_user_turn",
					text: operatorText,
					kind: "interrupt",
					...(options.display ? { display: options.display } : {}),
					...(options.origin !== undefined ? { origin: options.origin } : {}),
				});
			// The first submit creates its session after capture; open its writer before session events land (#434).
			const landedSession = deps.session?.current();
			if (!turnLease && landedSession && deps.telemetry?.acquireTelemetrySession) {
				try {
					turnLease = await deps.telemetry.acquireTelemetrySession(landedSession, mainAgent(landedSession.id));
				} catch {
					// The writer reports its own failure; telemetry cannot abort a submitted turn (#434).
				}
			}
			context.logPromptCompileIfPending();
			if (turnControlRecord) {
				outcomeCollector.recordControl(turnControlRecord);
				if (deps.session?.current()) {
					try {
						deps.session.appendEntry({
							kind: "custom",
							customType: "turnControl",
							parentTurnId: state.lastTurnId,
							display: false,
							data: turnControlRecord,
						});
					} catch {
						/* S6: ledger recording is best effort and never costs the admitted turn. */
					}
				}
			}
			// #423: Pi's native effort and tool updates preserve the cached prefix on capable models.
			const cacheModel = agentRuntime.agent.state.model;
			const cacheCompat =
				cacheModel.api === "anthropic-messages" ? (cacheModel.compat as AnthropicMessagesCompat | undefined) : undefined;
			if (
				previousThinkingLevel !== undefined &&
				previousThinkingLevel !== agentRuntime.runtimeResolution.effectiveThinkingLevel &&
				!context.thinkingUsesConfigurationUpdate() &&
				cacheCompat?.supportsMidConvoEffort !== true
			) {
				context.noteColdReason("thinking_change");
			}
			if (
				typeof previousRunSnapshot?.toolSignature === "string" &&
				previousRunSnapshot.toolSignature !== toolSignature &&
				!(cacheCompat?.supportsMidConvoToolChanges === true && cacheCompat.supportsMidConvoSystemMessages === true)
			) {
				context.noteColdReason("tool_surface_change");
			}
			// A request on another target or wire model shares no cached prefix with the previous call's (#434).
			if (
				previousModel !== undefined &&
				(previousModel.targetId !== agentRuntime.targetId || previousModel.modelId !== agentRuntime.wireModelId)
			) {
				context.noteColdReason("model_changed");
			}
			turnSnapshot = { ...turnSnapshot, turnId: userTurnId ?? "unknown" };
			context.setCurrentSnapshot(turnSnapshot);
			context.persistContextSnapshot(turnSnapshot);
			const promptHash = compiledPrompt?.systemPromptHash ?? null;
			state.lastRunSnapshot = {
				targetId: agentRuntime.targetId,
				targetUrl: agentRuntime.runtimeResolution.target.url ?? null,
				runtimeId: agentRuntime.runtimeId,
				runtimeKind: agentRuntime.runtimeResolution.runtimeKind,
				wireModelId: agentRuntime.wireModelId,
				autonomy: deps.getSettings().safety.autonomy,
				pricedBy: agentRuntime.runtimeResolution.pricedBy,
				compiledPromptHash: promptHash,
				staticCompositionHash: promptHash,
				promptSignature: promptHash,
				toolSignature,
				runtimeResolution: runtimeTargetSnapshot(agentRuntime.runtimeResolution),
				sessionId: deps.session?.current()?.id ?? null,
				cwd: process.cwd(),
			};

			agentRuntime.agent.maxRetryDelayMs = retrySettings().maxDelayMs;
			state.toolProseAbortReason = null;
			state.toolProseAssessedChars = 0;
			state.repetitionAbortReason = null;
			clearActiveInterrupt(state);
			state.interruptedAssistantMessage = null;
			state.interruptedCall = null;

			// 6. Cache-disturbance honesty (T3.3)
			context.consumeExpectedColdReasons(agentRuntime.runtimeId);

			// 7. Run the prompt, then route the settled state through recovery.
			loop.boundaryStop = null;
			loop.budgetRoll = null;
			state.streaming = true;
			deps.autonomy?.turnStarted();
			const foregroundOn = (runtime: AgentRuntime): (() => void) => {
				const endpointKey = modelEndpointKey(runtime.runtimeResolution.target, runtime.wireModelId);
				return endpointKey === null ? () => {} : registerForegroundStream(endpointKey);
			};
			let releaseForeground = foregroundOn(agentRuntime);
			loop.moveForeground = (runtime) => {
				releaseForeground();
				releaseForeground = foregroundOn(runtime);
			};
			try {
				options.onAdmitted?.();
			} catch {
				// Admission observers are bookkeeping only and cannot affect the turn.
			}
			const runtimePromptText = submittedText;
			if (options.requestContinuation !== true && deps.readSessionEntries) {
				const prior = agentRuntime.agent.state.messages;
				const retired = retireActiveUserContextForNextOperator(prior, deps.readSessionEntries(), {
					...(state.lastTurnId ? { activeLeafTurnId: state.lastTurnId } : {}),
				});
				// Only an unsent block retires, so no request's history is rewritten (bt-40).
				if (retired.length < prior.length) replaceEngineMessages(agentRuntime.agent, retired);
			}
			loop.terminalTurnFailure = undefined;
			loop.turnRetryAttempts = 0;
			loop.providerRetryAttempts = 0;
			const evidence = state.runEvidence.beginSubmit();
			loop.stepTurnScope = { evidence, continuation: options.yoloContinuation === true };
			const priorPendingSkillPolicy = state.currentPendingSkillPolicy;
			const priorAskUserPolicy = state.currentAskUserPolicy;
			state.currentPendingSkillPolicy = pendingSkillPolicy;
			state.currentAskUserPolicy = askUserPolicy;
			try {
				if (!admissionCurrent()) return;
				await queues.markPersistedUserEcho(runtimePromptText, () => {
					if (!admissionCurrent()) return Promise.resolve();
					// A flushed queue rides Pi's opening poll, so it lands with this
					// prompt's first model call; a held queue waits for the first slot.
					promptStarted = true;
					loop.queueSessionId = loop.api.getSessionId();
					if (pathMessage) messagePath.prompted(pathMessage);
					queues.handOverBeforePrompt(agentRuntime.agent, {
						keepOperatorHold:
							options.machineTurn !== undefined || options.origin !== undefined || options.requestContinuation === true,
					});
					if (userTurnId) context.commitSessionPosture(agentRuntime, userTurnId);
					state.routeMoveSeat = true;
					return agentRuntime.agent.prompt(runtimePromptText, images);
				});
				state.routeMoveSeat = false;
				if (
					admissionCurrent() &&
					state.synthesisToolLock &&
					state.activeInterruptReason === null &&
					isLockedSynthesisFallbackOnly(agentRuntime.agent.state.messages.at(-1))
				) {
					// Deliver the pair atomically. The normal follow-up queue drains one
					// message at a time; queuing these separately creates an extra round
					// with an unanswered synthetic tool call.
					emitNotice("[PanCode] Recovering a final answer once; tools remain disabled.");
					const model = agentRuntime.agent.state.model;
					await agentRuntime.agent.prompt(
						recordRecovery(
							"synthesis-recovery",
							lockedSynthesisRepromptMessages(1, {
								provider: model.provider,
								api: model.api,
								model: model.id,
							}),
						),
					);
				}
				// The repetition check stopped a looping stream. The stopped reply is replaced by a nudge and the model
				// runs again, at most twice per operator turn (`repetitionRecoveryStage`): a plain nudge that keeps the
				// request, then, when that run is stopped too, a changed request with a firmer instruction and thinking one
				// step lower (SC-5). An operator's Esc in the same window wins. The stopped reply already carries the
				// reason (turn-runtime), so a stop with no recovery left ends the turn on it.
				for (
					let stage = repetitionRecoveryStage(state);
					stage !== null && admissionCurrent();
					stage = repetitionRecoveryStage(state)
				) {
					const turnId = state.activeUserTurnId;
					const stoppedFor = state.repetitionAbortReason;
					if (turnId === null || stoppedFor === null) break;
					state.repetitionRepromptStages = stage;
					state.repetitionRepromptTurnId = turnId;
					state.repetitionAbortReason = null;
					const last = agentRuntime.agent.state.messages.at(-1);
					// The looping reply is in the ledger; replaying it would resend the loop.
					const stopped =
						last?.role === "assistant" && (last as { stopReason?: unknown }).stopReason === "aborted" ? last : undefined;
					if (stopped) agentRuntime.agent.state.messages = agentRuntime.agent.state.messages.slice(0, -1);
					const priorLevel = agentRuntime.agent.state.thinkingLevel;
					const recoveryLevel =
						stage === 1 ? priorLevel : lowerThinkingLevel(priorLevel, agentRuntime.runtimeResolution.modelRuntime.thinking);
					emitNotice(
						stage === 1
							? "[PanCode] Asking the model to act or answer instead of repeating."
							: recoveryLevel === priorLevel
								? "[PanCode] The model repeated itself again; asking once more with a firmer instruction."
								: // The operator's level, not the route's clamp of it, as the thinking-length recovery says.
									`[PanCode] The model repeated itself again; asking once more with a firmer instruction, with thinking ${recoveryLevel} instead of ${agentRuntime.runtimeResolution.requestedThinkingLevel}.`,
						"warning",
						REPETITION_REPROMPT_NOTICE_KEY,
					);
					if (recoveryLevel !== priorLevel && !context.thinkingUsesConfigurationUpdate())
						context.noteColdReason("thinking_change");
					const model = agentRuntime.agent.state.model;
					agentRuntime.agent.state.thinkingLevel = recoveryLevel;
					try {
						await agentRuntime.agent.prompt(
							recordRecovery(
								"repetition-recovery",
								repetitionRepromptMessages({ provider: model.provider, api: model.api, model: model.id }, stoppedFor, stage),
								stopped,
							),
						);
					} finally {
						agentRuntime.agent.state.thinkingLevel = priorLevel;
					}
				}
				// The output cap ran out while the model was still thinking. Once per
				// operator turn the cut-off reply is replaced by a reminder and the
				// model runs again one thinking step lower; a second such stop ends
				// the turn naming the cause and the fix.
				if (
					admissionCurrent() &&
					state.activeInterruptReason === null &&
					isThinkingOnlyLengthStop(agentRuntime.agent.state.messages.at(-1))
				) {
					const turnId = state.activeUserTurnId;
					if (turnId !== null && state.thinkingLengthRecoveryTurnId !== turnId) {
						state.thinkingLengthRecoveryTurnId = turnId;
						// The cut-off reply is in the ledger; replaying it would resend the deliberation.
						const stopped = agentRuntime.agent.state.messages.at(-1);
						agentRuntime.agent.state.messages = agentRuntime.agent.state.messages.slice(0, -1);
						const priorLevel = agentRuntime.agent.state.thinkingLevel;
						const recoveryLevel = lowerThinkingLevel(priorLevel, agentRuntime.runtimeResolution.modelRuntime.thinking);
						emitNotice(
							recoveryLevel === priorLevel
								? "[PanCode] The model ran out of output while thinking; asking it once to act or answer."
								: // The operator's level, not the route's clamp of it: an on/off route runs "high" as "low".
									`[PanCode] The model ran out of output while thinking; asking it once to act or answer, with thinking ${recoveryLevel} instead of ${agentRuntime.runtimeResolution.requestedThinkingLevel}.`,
							"warning",
							THINKING_LENGTH_RECOVERY_NOTICE_KEY,
						);
						if (recoveryLevel !== priorLevel && !context.thinkingUsesConfigurationUpdate())
							context.noteColdReason("thinking_change");
						const model = agentRuntime.agent.state.model;
						agentRuntime.agent.state.thinkingLevel = recoveryLevel;
						try {
							await agentRuntime.agent.prompt(
								recordRecovery(
									"thinking-length-recovery",
									thinkingLengthRecoveryMessages({ provider: model.provider, api: model.api, model: model.id }),
									stopped,
								),
							);
						} finally {
							agentRuntime.agent.state.thinkingLevel = priorLevel;
						}
					}
					if (
						admissionCurrent() &&
						state.activeInterruptReason === null &&
						isThinkingOnlyLengthStop(agentRuntime.agent.state.messages.at(-1))
					)
						emitNotice(THINKING_LENGTH_STOP_REASON, "error", THINKING_LENGTH_STOP_NOTICE_KEY);
				}
				// pi-agent-core does NOT throw on provider failures:
				// it pushes an assistant message with stopReason="error" and
				// errorMessage="<provider text>" onto state.messages, sets
				// state.errorMessage, emits agent_end, and resolves normally.
				// The overflow-recovery heuristic must inspect the state after
				// a resolve, not only the catch arm.
				if (!admissionCurrent()) return;
				const overflowPostResolve = detectOverflowFromState(agentRuntime.agent);
				if (overflowPostResolve) {
					await recovery.runCompactAndRetry(agentRuntime, runtimePromptText, overflowPostResolve, images);
				} else {
					const settled = detectTerminalFailureFromState(agentRuntime.agent);
					if (settled) {
						if (state.toolProseAbortReason && settled.message) {
							(settled.message as { errorMessage?: string }).errorMessage = state.toolProseAbortReason;
						}
						// A stalled stream settles here, not in the catch arm: the engine's
						// runWithLifecycle swallows the abort and resolves with an aborted
						// assistant message. Reclassify before the ladder's gate so the
						// watchdog's abort retries and an operator cancel still does not.
						const failure = reclassifyStallAbort(state, settled);
						recovery.ensureFailureVisibleAndPersisted(failure);
						await recovery.runTransientRetryChain(agentRuntime, runtimePromptText, failure, state.runEvidence.attempt());
					}
				}
			} catch (err) {
				if (!admissionCurrent()) return;
				// Genuine throws (network, abort, pre-stream bugs) still land
				// here. The heuristic is the same so a thrown overflow from
				// an older pi-agent-core still routes through compact-retry.
				const overflow = toContextOverflowError(err);
				if (!overflow) {
					const message = state.toolProseAbortReason ?? (err instanceof Error ? err.message : String(err));
					const classification = classifyRecoveryFailure({
						message,
						runtimeId: agentRuntime.runtimeId,
						contextOverflow: false,
						hasAttemptOutput: recoveryAttemptHasOutput(state.runEvidence.attempt()),
						cause: err,
						...(typeof err === "object" && err !== null && "status" in err ? { status: err.status } : {}),
					});
					if (
						isRetryableRecoveryFailure(classification) ||
						classification.kind === "auth" ||
						recovery.waitsOutRateLimit(classification)
					) {
						const failureMessage = {
							role: "assistant",
							content: [{ type: "text", text: "" }],
							stopReason: "error",
							errorMessage: message,
							timestamp: Date.now(),
						} as AgentMessage;
						const handled = await recovery.runTransientRetryChain(
							agentRuntime,
							runtimePromptText,
							{
								stopReason: "error",
								errorMessage: message,
								message: failureMessage,
							},
							undefined,
							classification,
						);
						if (handled) return;
					}
					emitNotice(operatorFacingEngineError(message));
					return;
				}
				await recovery.runCompactAndRetry(agentRuntime, runtimePromptText, overflow, images);
			} finally {
				const overtaken = state.routeMove;
				state.routeMove = null;
				state.routeMoveSeat = false;
				loop.moveForeground = null;
				if (overtaken !== null) {
					state.streamStallReason = null;
					// The stop lost the race to the reply it was stopping, and that reply is the one on screen.
					if (generation === loop.submitGeneration && state.activeInterruptReason === null && !owner?.signal.aborted)
						emitNotice(
							`The answer arrived before the request could move, so ${overtaken.wireModelId} takes over from the next turn.`,
							"info",
							"route-move.overtaken",
						);
				}
				recovery.settleOpenForecast();
				const canceled = state.activeInterruptReason !== null && state.activeInterruptByOperator;
				const autonomyStopped = state.activeInterruptReason !== null && state.activeInterruptByAutonomy;
				const jobClockStopped = state.activeInterruptReason !== null && state.activeInterruptByJobClock;
				// Esc on an interview resolves it as cancelled and the tool ends the turn
				// itself, so no interrupt is raised and `canceled` stays false. The turn
				// still ended on the operator's say-so, which the outcome has to show.
				const interviewDismissed = askUserPolicy?.status === "cancelled";
				releaseForeground();
				deps.autonomy?.turnSettled();
				// biome-ignore lint/correctness/noUnsafeFinally: a superseded submit must not settle into the new generation; its error belongs to a turn nobody owns now.
				if (generation !== loop.submitGeneration) return;
				if (askUserPolicy) {
					try {
						await finalizeAskUserInterviewForHost(
							askUserPolicy,
							"turn_finished",
							currentToolInvokeOptions(),
							deps.onAskUserFinalized,
						);
					} catch (error) {
						emitNotice(
							`[PanCode] interview decisions could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
							`decision-ledger:${askUserPolicy.id}`,
						);
					}
				}
				// biome-ignore lint/correctness/noUnsafeFinally: a superseded submit must not settle into the new generation; its error belongs to a turn nobody owns now.
				if (generation !== loop.submitGeneration) return;
				// Only a submit that still owns this generation hands its interview on, so a turn superseded while the
				// decisions persisted never answers another session's continuation (C-25).
				if (askUserPolicy?.status === "complete" && askUserPolicy.rounds.length > 0) loop.promptInterview = askUserPolicy;
				// A turn that ended without its turn_end hook (a throw or an abort before any reply) ended here, while this
				// submit still owns the stream and its lease: a resubmit below can take ownership and return before its turn_start.
				if (promptStarted && loop.submitOwner === owner) outcomeCollector.endTurn();
				state.streaming = false;
				// A run that ended without reaching its tool boundary has nothing left to stop.
				loop.boundaryStop = null;
				if (state.activeInterruptReason !== null) {
					const reason = state.activeInterruptReason;
					state.activeInterruptReason = null;
					// A partial response already closed with the cancellation reason.
					// Only a hollow abort needs a synthetic assistant, after all tool
					// results have landed. Publish its notice after settlement too, so
					// it cannot split the entry the provider's message_end finalizes.
					if (state.interruptedAssistantMessage === null) {
						const closing = noticeMessage(reason);
						const interrupted = takeInterruptedCall(state);
						if (interrupted !== null) {
							Object.assign(closing, interrupted.message, noticeMessage(reason));
							delete (closing as { errorMessage?: string }).errorMessage;
						}
						persistence.appendAssistantTurn(closing, interrupted?.timing, undefined, {
							operatorCancel: state.activeInterruptByOperator,
						});
						emit({
							type: "notice",
							level: "warning",
							surface: "transcript",
							text: reason,
							key: "turn.interrupted",
							...(state.activeInterruptByOperator ? { operatorCancel: true as const } : {}),
							...(isRedirectReason(reason) || (loop.budgetRoll !== null && !state.activeInterruptByOperator)
								? { redirect: true as const }
								: {}),
						});
					}
					state.interruptedAssistantMessage = null;
					state.interruptedCall = null;
					clearActiveInterrupt(state);
				}
				// A continuation writes its outcome too: the streak that gates the next
				// turn's direction workflow resets on a turn that used a tool, and a
				// continuation is exactly where an answered interview does. Without its
				// row the streak stayed at the operator turn's value, in memory and on
				// resume.
				if (userTurnId !== null && deps.session?.current()) {
					try {
						const continuation = options.requestContinuation === true;
						const collected = outcomeCollector.take(userTurnId, state.activeUserTurnId);
						const finalMessage = [...agentRuntime.agent.state.messages]
							.reverse()
							.find((message) => message.role === "assistant");
						const finalEntry = deps.readSessionEntries?.().find((entry) => entry.turnId === state.lastTurnId);
						const finalPayload =
							finalEntry?.kind === "message" && finalEntry.role === "assistant"
								? (finalEntry.payload as { text?: unknown; stopReason?: unknown })
								: undefined;
						const finalAssistantText =
							typeof finalPayload?.text === "string" ? finalPayload.text : finalMessage ? extractText(finalMessage) : "";
						const workerRunIds = [...collected.dispatches.flatMap((item) => item.runIds), ...collected.harness.runIds];
						const missingReceipts = canceled ? await workerReceipts.awaitSeal(workerRunIds) : [];
						// biome-ignore lint/correctness/noUnsafeFinally: a superseded submit must not settle into the new generation; its error belongs to a turn nobody owns now.
						if (generation !== loop.submitGeneration) return;
						const failure = terminalFailureFromAssistantMessage(finalMessage)?.failure ?? currentTurnFailure();
						const record = reduceTurnOutcome({
							...collected,
							turnId: userTurnId,
							turnIndex,
							continuation,
							finalAssistantText,
							taskEstablished: deps.getTaskEstablished?.() ?? false,
							canceled,
							interviewDismissed,
							...(failure
								? { failure: { ...failure, retryAttempts: loop.turnRetryAttempts + loop.providerRetryAttempts } }
								: {}),
							tokens: {
								coordinator: persistence.turnUsage(userTurnId) ?? noOutcomeUsage(),
								workers: workerReceipts.usage(workerRunIds),
							},
							stopReason:
								typeof finalPayload?.stopReason === "string"
									? finalPayload.stopReason
									: typeof finalMessage?.stopReason === "string"
										? finalMessage.stopReason
										: canceled
											? "aborted"
											: "error",
							durationMs: Math.max(0, performance.now() - submittedAt),
						});
						// The reading every surface fails the run on, so why-stopped names it too (bt-session-res J1).
						const ending = canceled ? null : classifyTurnEnding(agentRuntime.agent.state.messages);
						await writeTurnOutcome(record, {
							stopReason: record.stopReason,
							retries: loop.turnRetryAttempts + loop.providerRetryAttempts,
							// The post-tool guard stops between calls, so no call carries its cause; the ledger reply does (CLI-3).
							// A loop-guard or turn-budget-roll stop is the guard's, read off the owner it aborted (C-10).
							cause: canceled
								? "operator_cancel"
								: autonomyStopped
									? "autonomy_stop"
									: jobClockStopped
										? "job_clock"
										: owner !== null && owner === loop.guardStoppedOwner
											? "loop_guard"
											: failure?.stage === "harness" && failure.errorClass === "oversized_tool_result"
												? "oversized_tool_result"
												: undefined,
							noAnswer: ending?.kind === "no_answer" ? ending.cause : undefined,
							runIds: workerRunIds,
							missing: missingReceipts,
						});
						// A continuation extends the operator turn it followed, so the gap the
						// next operator message reports runs from the end of the whole chain.
					} catch {
						// Measurement must not change turn settlement when a ledger or receipt is unavailable.
					}
				}
				state.currentPendingSkillPolicy = priorPendingSkillPolicy;
				state.currentAskUserPolicy = priorAskUserPolicy;
				armSkillSurface(pendingSkillPolicy, skillsLoadedBeforeTurn);
				// Safety net for thrown paths where agent_end never delivered;
				// no-op when the agent_end flush already ran.
				context.flushReconciledSnapshot();
				// The guard, not a person and not a newer submit, aborted this owner.
				const guardStopped =
					owner !== null &&
					owner === loop.guardStoppedOwner &&
					loop.submitOwner === owner &&
					!loop.disposed &&
					options.isAdmissionCurrent?.() !== false;
				// Runs on every exit path (normal settle, catch-arm returns) so
				// a steer the engine never drained still reaches the model.
				if (options.machineTurn !== undefined) {
					const messages = evidence.messages();
					const finalMessage = [...messages].reverse().find((message) => message.role === "assistant");
					const failure = detectTerminalFailureFromState(agentRuntime.agent);
					const usage = sumRunUsage(messages);
					// An exhausted ladder prunes its failure, so an earlier round's text must not read as success (#445).
					const stop = state.continuation.stop as { reason: string; retryAfterMs?: number } | null;
					// A failure stop outranks a budget crossing in the same turn, so a failing turn cannot escape the cap on one.
					const guardStop =
						stop !== null
							? undefined
							: guardStopped || state.synthesisToolLock
								? "loop_guard"
								: state.toolBudgetLock
									? "tool_budget"
									: undefined;
					options.machineTurn.onSettled({
						status:
							(!admissionCurrent() && !guardStopped) || canceled || interviewDismissed
								? "canceled"
								: failure || stop || guardStopped || !finalMessage
									? "failed"
									: "succeeded",
						turnId: userTurnId,
						...(failure || stop ? { reason: failure?.errorMessage ?? stop?.reason ?? "" } : {}),
						...(guardStop === undefined ? {} : { stoppedBy: guardStop }),
						...(stop?.retryAfterMs === undefined ? {} : { retryAfterMs: stop.retryAfterMs }),
						...(finalMessage ? { text: extractText(finalMessage) } : {}),
						usage: { tokens: usage.totals.totalTokens, cost: usage.cost },
					});
				}
				state.activeUserTurnId = null;
				const guardFailure = loop.loopGuardFailure;
				loop.loopGuardFailure = null;
				const stepStop = loop.stepPolicyStop;
				loop.stepPolicyStop = null;
				const stepPolicy = state.currentTurnConstraints?.turnPolicy;
				loop.stepTurnScope = null;
				const stepRun = stepPipeline.settle(
					stepPolicy?.stepTool,
					stepPolicy ? stepTurnOutcome(evidence.messages(), stepPolicy.stepTool) : null,
					options.yoloContinuation === true,
					userTurnId,
				);
				// Only a step turn that ended on its own text, or that its step policy ended, leaves a state summary
				// the next step can start from. A failed turn, a loop-guard stop or a real budget crossing stopped
				// mid-step, so its continuation keeps the full history (WTF-P 0.8.3 C5).
				// A submit a session reset superseded settles nothing: the chain now belongs to the new session.
				if (generation === loop.submitGeneration)
					stepStarts.settle(
						state.currentTurnConstraints,
						lastAssistantText(evidence.messages()),
						!canceled &&
							!interviewDismissed &&
							state.continuation.stop === null &&
							!guardStopped &&
							!state.synthesisToolLock &&
							(!state.toolBudgetLock || stepStop !== null) &&
							detectTerminalFailureFromState(agentRuntime.agent) === null,
						{ sessionId: deps.session?.current()?.id ?? null, leafTurnId: state.lastTurnId },
						userTurnId,
					);
				const continuation =
					options.machineTurn === undefined && !canceled && !interviewDismissed && (admissionCurrent() || guardStopped)
						? yoloContinuationDue(guardStopped, guardFailure, stepStop, stepRun)
						: null;
				loop.budgetRoll = null;
				if (options.machineTurn === undefined && generation === loop.submitGeneration && continuation === null) {
					const capSpent = state.continuation.yoloContinuations >= TURN_CONTINUATION_CAP;
					// A last turn that made no step call and ended on its own summary did not stop mid-pipeline (N1).
					const settledCleanly =
						!canceled &&
						!interviewDismissed &&
						state.continuation.stop === null &&
						!guardStopped &&
						!state.synthesisToolLock &&
						!state.toolBudgetLock;
					loop.lastStepPipeline =
						stepPolicy && stepRun !== null
							? stepPipelineEnd(
									stepPolicy,
									stepRun,
									capSpent,
									settledCleanly,
									canceled ? "cancel" : detectTerminalFailureFromState(agentRuntime.agent) !== null ? "failure" : null,
								)
							: null;
					const named = loop.lastStepPipeline?.template
						? `prompt template ${loop.lastStepPipeline.template}`
						: "this template";
					if (loop.lastStepPipeline?.stoppedBy === "cap")
						emitNotice(
							`The step pipeline of ${named} stopped at the continuation cap (${TURN_CONTINUATION_CAP}) with a step still running, before ${loop.lastStepPipeline.stepTool} said it was done.`,
							"warning",
							"step.incomplete",
						);
					else if (loop.lastStepPipeline?.stoppedBy === "unreported")
						emitNotice(
							`The step pipeline of ${named} ended on a turn that made no ${loop.lastStepPipeline.stepTool} call; the step tool never reported pipelineDone, so whether every step ran is not known.`,
							"info",
							"step.unreported",
						);
					if (loop.lastStepPipeline !== null && userTurnId !== null)
						await recordStepPipelineSettled(userTurnId, loop.lastStepPipeline);
				}
				if (
					!loop.disposed &&
					generation === loop.submitGeneration &&
					options.machineTurn === undefined &&
					!(await queues.resubmitStranded())
				) {
					if (state.continuation.requested) await queues.resubmitRequestContinuation();
					else if (continuation !== null) {
						// Read before the resubmit appends anything: the stopped turn's own last call.
						const lastToolCall = lastToolCallOf(evidence.messages());
						await continueStoppedTurn(continuation, generation, options.constraints, lastToolCall, userTurnId);
					}
				}
			}
		} finally {
			// Settlements land before the lease release flushes, and possibly seals, the session's journal.
			middleware.releaseTurnHolds(turnHolds);
			await turnLease?.release();
			returnUnstarted();
			if (pathMessage && !promptStarted && options.queued === undefined) messagePath.neverStarted(pathMessage);
			if (loop.submitOwner === owner) {
				loop.submitOwner = null;
				// Template bounds end with their turn; prewarm and jobs see only
				// the host's remaining prompt or session ceiling (#423).
				state.currentTurnConstraints = loop.promptToolLimits;
				if (!loop.disposed) queues.settleSubmit(promptStarted);
			}
		}
	};
}
