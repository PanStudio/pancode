// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { ownerTelemetryContext } from "../../core/telemetry/context.js";
import type { ChatCancelOptions, ChatLoop } from "../chat-loop.js";
import { isOperatorCancelReason, OPERATOR_CANCEL_REASON } from "../chat-loop-messages.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";
import type { ChatLoopCancelState } from "../turn-state.js";
import { isRedirectReason } from "./submit-turn.js";

/**
 * The operator's, a guard's or a machine's stop of the running turn: at the tool boundary when asked, otherwise
 * now, with the interrupt cause recorded so the settling turn reports who stopped it.
 */
export function createChatLoopCancel(loop: ChatLoopScope, state: ChatLoopCancelState): Pick<ChatLoop, "cancel"> {
	const { context, continuity, deps, emitFooterNotice, emitNotice, queues, recovery, turnRuntime } = loop;
	return {
		cancel(options?: ChatCancelOptions): void {
			if (options?.atToolBoundary === true) {
				const { atToolBoundary: _deferred, ...stop } = options;
				// Mid-run the stop waits for the round's tool batch; finishTurn lands it
				// before the next model request. Between runs nothing is in flight.
				if (state.streaming && state.runtime?.agent.signal?.aborted !== true) {
					loop.boundaryStop ??= stop;
					return;
				}
				loop.api.cancel(stop);
				return;
			}
			// A stop now supersedes one still waiting for the tool boundary.
			loop.boundaryStop = null;
			const machineCancellation = loop.pendingMachineCancellation;
			loop.pendingMachineCancellation = null;
			const preserveQueue = machineCancellation !== null && machineCancellation === loop.machineTurnRunning;
			// An operator who already stopped this turn keeps it stopped: a guard
			// stop racing in after the Esc must not read as the guard's, or yolo
			// would continue the turn (R2-safety-secrets-20).
			const wasCanceledByOperator = state.activeInterruptReason !== null && state.activeInterruptByOperator;
			loop.guardStoppedOwner = options?.source === "loop_guard" && !wasCanceledByOperator ? loop.submitOwner : null;
			loop.submitOwner?.abort();
			turnRuntime.cancelRunWatchdog();
			continuity.cancel();
			loop.pendingPreTurnRead?.abort();
			loop.pendingVisionSidecar?.abort();
			loop.pendingCompactionPaint?.abort();
			const wasStreaming = state.streaming;
			context.cancelCompaction();
			recovery.cancelRetryCountdown();
			// Settle the queue before the abort settles the in-flight prompt: a
			// cancelled run must not deliver queued messages on its own. An
			// interrupt holds them for the prompt it is about to send, and an operator
			// stop holds them until the operator acts (#447). A guard stop was not the
			// operator's choice, and a job cancellation has successors to protect
			// (#411), so both leave the entries to the ordinary settlement path.
			queues.onRunCancelled({
				hold: isRedirectReason(options?.reason),
				preserve: preserveQueue,
				settle: options?.source === "loop_guard" || options?.source === "autonomy",
			});
			const requestedReason = options?.reason?.trim();
			if (wasStreaming && !wasCanceledByOperator) {
				// Keep immediate feedback in the footer. A transcript notice here
				// would split the streamed entry before message_end can finalize it.
				// The reason is carried by the provider's aborted assistant, or by
				// one synthetic closing record after an empty abort settles.
				state.activeInterruptReason =
					requestedReason && requestedReason.length > 0 ? requestedReason : OPERATOR_CANCEL_REASON;
				state.activeInterruptByOperator = (options?.source ?? "stream_cancel") === "stream_cancel";
				state.activeInterruptByTriage = options?.source === "triage";
				state.activeInterruptByAutonomy = options?.source === "autonomy";
				state.activeInterruptByJobClock = options?.source === "job_clock";
				state.activeInterruptByLoopGuard = options?.source === "loop_guard";
				// An Esc is reported once, by the turn's Cancelled outcome. The footer
				// carries only an interruption the operator did not ask for.
				if (!isOperatorCancelReason(state.activeInterruptReason))
					emitFooterNotice("warning", state.activeInterruptReason, "turn.interrupted");
			}
			state.runtime?.agent.abort();
			if (wasStreaming && !wasCanceledByOperator && (options?.source ?? "stream_cancel") === "stream_cancel") {
				const sessionId = loop.api.getSessionId();
				const settled = loop.api.whenSettled();
				// #425: publish after stream closure so the notice cannot split the aborted assistant entry.
				void import("../../domains/dispatch/batch-store.js")
					.then(async ({ listDetachedBatches }) => {
						await settled;
						if (loop.disposed || loop.api.getSessionId() !== sessionId) return;
						const batches = listDetachedBatches().filter(
							(batch) => batch.sessionId === sessionId && (sessionId !== null || batch.cwd === process.cwd()),
						);
						if (batches.length === 0) return;
						emitNotice(
							`Main turn cancelled. Detached batches continue independently: ${batches.map((batch) => batch.id).join(", ")}. ` +
								'Collect with monitor(mode="collect", batch_id="<batch-id>"); abort a worker with steer(action="cancel", run_id="<run-id>"). ' +
								"Collect existing results or explicitly re-run failed assignments before replacing their work.",
							"info",
							"dispatch.detached-continues",
						);
					})
					.catch((error: unknown) => {
						process.stderr.write(
							`[dispatch] cancel notice failed: ${error instanceof Error ? error.message : String(error)}\n`,
						);
					});
			}
			if (wasStreaming && deps.bus) {
				// A keypress cancels outside the turn's async context, so the record names its session itself (#434).
				deps.bus.emit(
					"turn.aborted",
					{
						source: options?.source ?? "stream_cancel",
						at: Date.now(),
						reason: options?.auditReason ?? (requestedReason ? "loop guard stopped a runaway turn" : "user cancelled stream"),
					},
					ownerTelemetryContext({ sessionId: loop.api.getSessionId(), turnId: state.activeUserTurnId ?? undefined }),
				);
			}
		},
	};
}
