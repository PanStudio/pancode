// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ChatSubmitOptions } from "../chat-loop.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";
import type { QueuedChatMessage } from "../turn-queues.js";
import { DEFAULT_STEERING_MODE, type SteeringMode } from "../turn-queues.js";
import type { ChatLoopSubmitState } from "../turn-state.js";
import { isWorkerShareNote } from "../worker-share.js";
import { INTERRUPT_CANCEL_REASON, TRIAGE_INTERRUPT_REASON } from "./submit-turn.js";

/** What `submit` hands its streaming path: the submitted text and how to give back an unstarted queued message. */
export interface SubmitStreamingInput {
	options: ChatSubmitOptions;
	text: string;
	continuedMessage: Pick<QueuedChatMessage, "id" | "enqueuedAt"> | undefined;
	admissionCurrent: () => boolean;
	returnUnstarted: () => void;
}

/**
 * Delivers a submission that arrives while a run streams: it steers, queues or interrupts the active run, or is
 * refused. Resolves true when an interrupt cancelled the run and settled, so `submit` goes on as a fresh prompt;
 * false when the submission was delivered or refused here and `submit` returns.
 */
export async function submitWhileStreaming(
	loop: ChatLoopScope,
	state: ChatLoopSubmitState,
	input: SubmitStreamingInput,
): Promise<boolean> {
	const { context, deps, emitAdmissionNotice, emitNotice, interruptRefusalReason, queuedForTriage, queues } = loop;
	const { options, text, continuedMessage, admissionCurrent, returnUnstarted } = input;
	let interrupted = false;
	if (options.machineTurn !== undefined) return false;
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
				return false;
			}
			if (!state.streaming) {
				interrupted = true;
			} else {
				// Something restarted a run while the cancel settled (a
				// continuation resubmit); do not fight it, deliver at the next slot.
				if (!constrained)
					emitNotice("[PanCode] a run restarted before the interrupt landed. Queued for the next slot instead.", "warning");
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
			if (queuedForTriage(entry)) return false;
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
			return false;
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
			return false;
		}
		emitNotice("[PanCode] response already in progress. Press Esc to cancel the active run.");
		return false;
	}
	return interrupted;
}
