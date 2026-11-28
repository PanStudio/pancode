// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomUUID } from "node:crypto";
import { commitSubmittedTurn } from "./chat-loop/submit-commit.js";
import { fitSubmittedTurn } from "./chat-loop/submit-fit.js";
import { prepareSubmittedTurn } from "./chat-loop/submit-prepare.js";
import { runSubmittedTurn } from "./chat-loop/submit-run.js";
import { settleSubmittedTurn } from "./chat-loop/submit-settle.js";
import { INTERRUPT_CANCEL_REASON, type SubmitTurn, TRIAGE_INTERRUPT_REASON } from "./chat-loop/submit-turn.js";
import type { ChatLoop, ChatSubmitOptions } from "./chat-loop.js";
import type { ChatLoopScope } from "./chat-loop-scope.js";
import { DEFAULT_STEERING_MODE, type SteeringMode } from "./turn-queues.js";
import type { ChatLoopSubmitState } from "./turn-state.js";
import { isWorkerShareNote } from "./worker-share.js";

/** The chat loop's `submit`: runs one submitted turn from admission to settlement. */
export function createChatLoopSubmit(loop: ChatLoopScope, state: ChatLoopSubmitState): ChatLoop["submit"] {
	const {
		context,
		deps,
		emitAdmissionNotice,
		emitNotice,
		interruptRefusalReason,
		messagePath,
		middleware,
		operatorMemory,
		queuedForTriage,
		queues,
	} = loop;
	return async function submit(text: string, options: ChatSubmitOptions = {}): Promise<void> {
		let owner: AbortController | null = null;
		// Until the prompt runs there is no foreground stream to release.
		const turn: SubmitTurn = { promptStarted: false, releaseForeground: () => {}, turnLease: undefined };
		const generation = loop.submitGeneration;
		const admissionCurrent = (): boolean =>
			!loop.disposed &&
			generation === loop.submitGeneration &&
			!owner?.signal.aborted &&
			options.isAdmissionCurrent?.() !== false;
		const returnUnstarted = (): void => {
			if (options.queued === undefined || turn.promptStarted || loop.disposed) return;
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
		/**
		 * What this submit holds for its requests (the taken buffer, an armed tool choice, a flushed continuation, the
		 * awaited gate's effects); a return before a request carries them suppresses their firings.
		 */
		const turnHolds = middleware.beginTurnHolds();
		try {
			const prepared = await prepareSubmittedTurn(loop, state, turn, {
				options,
				text,
				owner,
				generation,
				admissionCurrent,
				submittedAt,
			});
			if (prepared === null) return;
			const {
				previousRunSnapshot,
				previousThinkingLevel,
				previousModel,
				agentRuntime,
				reservedUserTurnId,
				operatorText,
				images,
				referencedPaths,
				turnControlRecord,
				pendingSkillPolicy,
				skillsLoadedBeforeTurn,
				toolSignature,
				askUserPolicy,
				composeSubmittedText,
			} = prepared;
			let { submittedText } = prepared;

			const fitted = await fitSubmittedTurn(loop, {
				options,
				owner,
				generation,
				admissionCurrent,
				submittedAt,
				agentRuntime,
				reservedUserTurnId,
				images,
				turnControlRecord,
				pendingSkillPolicy,
				toolSignature,
				composeSubmittedText,
				submittedText,
			});
			if (fitted === null) return;
			submittedText = fitted.submittedText;
			const { compiledPrompt, turnSnapshot } = fitted;

			const committed = await commitSubmittedTurn(loop, state, turn, {
				options,
				admissionCurrent,
				agentRuntime,
				interrupted,
				previousRunSnapshot,
				previousThinkingLevel,
				previousModel,
				reservedUserTurnId,
				operatorText,
				referencedPaths,
				turnControlRecord,
				pendingSkillPolicy,
				toolSignature,
				askUserPolicy,
				submittedText,
				compiledPrompt,
				turnSnapshot,
			});
			if (committed === null) return;
			const { userTurnId, turnIndex, runtimePromptText, evidence, priorPendingSkillPolicy, priorAskUserPolicy } =
				committed;
			try {
				await runSubmittedTurn(loop, state, turn, {
					options,
					admissionCurrent,
					pathMessage,
					agentRuntime,
					userTurnId,
					runtimePromptText,
					images,
				});
			} finally {
				const superseded = await settleSubmittedTurn(loop, state, turn, {
					options,
					owner,
					generation,
					admissionCurrent,
					submittedAt,
					agentRuntime,
					askUserPolicy,
					userTurnId,
					turnIndex,
					priorPendingSkillPolicy,
					priorAskUserPolicy,
					pendingSkillPolicy,
					skillsLoadedBeforeTurn,
					evidence,
				});
				// biome-ignore lint/correctness/noUnsafeFinally: a superseded submit must not settle into the new generation; its error belongs to a turn nobody owns now.
				if (superseded) return;
			}
		} finally {
			// Settlements land before the lease release flushes, and possibly seals, the session's journal.
			middleware.releaseTurnHolds(turnHolds);
			await turn.turnLease?.release();
			returnUnstarted();
			if (pathMessage && !turn.promptStarted && options.queued === undefined) messagePath.neverStarted(pathMessage);
			if (loop.submitOwner === owner) {
				loop.submitOwner = null;
				// Template bounds end with their turn; prewarm and jobs see only
				// the host's remaining prompt or session ceiling (#423).
				state.currentTurnConstraints = loop.promptToolLimits;
				if (!loop.disposed) queues.settleSubmit(turn.promptStarted);
			}
		}
	};
}
