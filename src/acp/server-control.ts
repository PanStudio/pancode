// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The ACP server's turn controls: cancel, steer, queue, and interrupt. */

import { isRecord } from "../core/type-guards.js";
import { ACP_CONTEXT_META_KEY } from "./context-ledger.js";
import { AcpRequestError, acpErrorMessage } from "./errors.js";
import { boundString, requireBoundedClientString } from "./server-bounds.js";
import { ACP_MAX_DISPATCH_ID_BYTES } from "./server-event-frames.js";
import { assertParamKeys } from "./server-guards.js";
import type { AcpQueuedEntryKind, PancodeAcpServerOptions } from "./server-options.js";
import type { AcpServerScope } from "./server-scope.js";
import type { AcpQueueEditOp, AcpSteeringMode } from "./server-session-input.js";
import {
	ACP_MAX_INTERRUPT_REASON_BYTES,
	ACP_MAX_QUEUE_ENTRY_ID_BYTES,
	ACP_MAX_RESTORED_MESSAGES,
	ACP_MAX_STEER_TEXT_BYTES,
	ACP_QUEUE_EDIT_OPS,
	ACP_STEERING_MODES,
	boundedQueueTexts,
	dispatchSteerReason,
	projectQueueEntries,
	requireSteerText,
	restorableWhole,
} from "./server-session-input.js";
import type { AcpServerSession } from "./server-tool-updates.js";
import {
	ACP_DISPATCH_STEER_METHOD,
	ACP_QUEUE_EDIT_METHOD,
	ACP_SESSION_CANCEL_METHOD,
	ACP_SESSION_INTERRUPT_METHOD,
	ACP_SESSION_QUEUE_CLEAR_METHOD,
	ACP_SESSION_QUEUE_METHOD,
	ACP_SESSION_SHELL_METHOD,
	ACP_SESSION_STEER_METHOD,
} from "./types.js";
import type {
	AcpInterruptResult,
	AcpQueueClearResult,
	AcpQueueEditResult,
	AcpQueueResult,
	AcpSteerResult,
} from "./types-session.js";

function contextCancellationId(params: unknown): string | undefined {
	if (!isRecord(params) || params._meta === undefined) return undefined;
	if (!isRecord(params._meta))
		throw new AcpRequestError(-32602, "cancel metadata must be an object", { code: "invalid_params" });
	if (!Object.hasOwn(params._meta, ACP_CONTEXT_META_KEY)) return undefined;
	const context = params._meta[ACP_CONTEXT_META_KEY];
	if (!isRecord(context))
		throw new AcpRequestError(-32602, "context cancellation requires operationId", { code: "invalid_params" });
	return requireBoundedClientString(context.operationId, "operationId", 128);
}

/**
 * Windows in which a steer must not be queued, or null when it may be.
 *
 * The engine resubmits a steer it never drained as a fresh prompt
 * (`resubmitStrandedSteers`). In a terminal that is the right answer; here it
 * is a prompt-shaped turn the client never requested, whose stop reason has
 * no request to ride home on. The two windows where stranding is certain are
 * knowable from the session, so the server refuses in them and says why,
 * rather than accepting a steer that would come back as an unrequested turn.
 */
function steerRefusal(options: PancodeAcpServerOptions, session: AcpServerSession): string | null {
	if (session.activePrompt === null) {
		return "no prompt is active on this session; send session/prompt instead of steering";
	}
	if (session.activePrompt.cancelled) {
		return "this prompt is cancelled and its queues are being cleared; prompt again once it returns";
	}
	// A steer the engine never drains is resubmitted as a fresh turn, and a scheduled turn has no request to carry that one home.
	if (session.activePrompt.scheduled !== undefined) {
		return "a scheduled job turn is running; cancel it, or prompt once it finishes";
	}
	if (!options.chat.isStreaming()) {
		return "the run is not streaming, so the engine has no slot to drain this steer into";
	}
	return null;
}

/** The chat loop's per-entry queue operations, bound, or a refusal when this build has none. */
function queueControl(options: PancodeAcpServerOptions) {
	const chat = options.chat;
	if (
		chat.queueEntries === undefined ||
		chat.removeQueuedEntry === undefined ||
		chat.moveQueuedEntry === undefined ||
		chat.setQueuedEntryKind === undefined
	) {
		throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
	}
	return {
		entries: chat.queueEntries.bind(chat),
		remove: chat.removeQueuedEntry.bind(chat),
		move: chat.moveQueuedEntry.bind(chat),
		setKind: chat.setQueuedEntryKind.bind(chat),
	};
}

export function createAcpServerControl(scope: AcpServerScope) {
	const { options } = scope;
	const cancelSession = (session: AcpServerSession, reason: string, operationId?: string): boolean => {
		if (operationId !== undefined) {
			if (session.id !== scope.boundSessionId) return false;
			const operation = scope.contextActivity?.operation;
			if (
				!operation ||
				operation.id !== operationId ||
				operation.sessionId !== session.id ||
				operation.cwd !== scope.canonicalCwd ||
				operation.outcome !== undefined
			)
				return false;
			if (
				operation.kind === "context-init" ||
				operation.kind === "context-refresh" ||
				operation.kind === "context-clear"
			) {
				if (options.cancelContextOperation?.(session.id, scope.canonicalCwd, operationId) !== true) return false;
			} else if (operation.kind !== "compaction" && operation.kind !== "context-recover") return false;
		} else if (session.id === scope.boundSessionId) options.cancelContextOperation?.(session.id, scope.canonicalCwd);
		// A shell line never runs beside a prompt, so this stops whichever of the two is running.
		if (scope.activeShell?.sessionId === session.id) scope.activeShell.abort.abort();
		if (scope.activeSessionId === session.id || scope.activeSessionId === null) scope.permission.cancelPending(reason);
		if ((scope.activeSessionId ?? scope.boundSessionId) === session.id) {
			options.interviews?.cancel();
			options.elicitation?.cancel();
		}
		if (!session.activePrompt) {
			if ((scope.contextCommandInFlight !== null || operationId !== undefined) && session.id === scope.boundSessionId)
				options.chat.cancel();
			return true;
		}
		session.activePrompt.cancelled = true;
		session.activePrompt.expansionAbort?.abort();
		options.chat.cancel();
		return true;
	};

	const cancel = (params: unknown): Record<string, unknown> => {
		scope.guards.requireInitialized();
		const operationId = contextCancellationId(params);
		const cancelled = cancelSession(scope.guards.getSession(params), "prompt cancelled", operationId);
		return operationId === undefined ? {} : { _meta: { [ACP_CONTEXT_META_KEY]: { operationId, cancelled } } };
	};
	// ACP defines session/cancel only as a notification; a client that waits for the stop, or for a context operation's
	// acknowledgement, asks through the extension method.
	options.transport.onRequest(ACP_SESSION_CANCEL_METHOD, cancel);
	// `$/cancel_request` naming a running prompt stops it as session/cancel does, and the prompt answers `cancelled`.
	const unsubscribePromptCancel =
		options.transport.onRequestCancel?.("session/prompt", (params) => {
			if (!scope.handshake.initialized || !isRecord(params) || typeof params.sessionId !== "string") return false;
			const session = scope.sessions.get(params.sessionId);
			if (session === undefined || session.activePrompt === null) return false;
			cancelSession(session, "prompt cancelled");
			return true;
		}) ?? (() => {});
	// `$/cancel_request` naming a running shell line kills it through its abort signal; the line then answers once with
	// `cancelled: true` and closes its tool call as failed, so it never finishes and records after a -32800.
	const unsubscribeShellCancel =
		options.transport.onRequestCancel?.(ACP_SESSION_SHELL_METHOD, (params) => {
			if (!scope.handshake.initialized || !isRecord(params) || typeof params.sessionId !== "string") return false;
			if (scope.activeShell === null || scope.activeShell.sessionId !== params.sessionId) return false;
			scope.activeShell.abort.abort();
			return true;
		}) ?? (() => {});
	options.transport.onNotification("session/cancel", (params) => {
		// A notification has no reply channel, so an ordering or identity error
		// has nowhere to go. Dropping it silently is the only conformant option.
		if (!scope.handshake.initialized) return;
		const id = isRecord(params) && typeof params.sessionId === "string" ? params.sessionId : null;
		const session = id === null ? undefined : scope.sessions.get(id);
		if (session) {
			try {
				cancelSession(session, "prompt cancelled", contextCancellationId(params));
			} catch {
				/* Malformed scoped notifications have no reply channel and must never become generic cancels. */
			}
		}
	});

	options.transport.onRequest(ACP_SESSION_STEER_METHOD, async (params): Promise<AcpSteerResult> => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "text", "mode"]));
		const session = scope.guards.getSession(request);
		const text = requireSteerText(request.text, "text", ACP_MAX_STEER_TEXT_BYTES);
		if (
			request.mode !== undefined &&
			(typeof request.mode !== "string" || !(ACP_STEERING_MODES as ReadonlyArray<string>).includes(request.mode))
		) {
			throw new AcpRequestError(-32602, "invalid steering mode", { code: "invalid_params" });
		}
		const mode = (request.mode ?? "next-slot") as AcpSteeringMode;
		const queue = mode === "next-slot" ? "steer" : "follow-up";
		const enqueue = mode === "next-slot" ? options.chat.steer : options.chat.queueFollowUp;
		if (enqueue === undefined) {
			return { accepted: false, queue, refusal: "this agent build does not expose the engine steering queues" };
		}
		const refusal = steerRefusal(options, session);
		if (refusal !== null) return { accepted: false, queue, refusal };
		if (options.chat.discoverOperatorEgg && (await options.chat.discoverOperatorEgg(text)))
			return { accepted: true, queue };
		// The engine's own admission is the last word: it refuses a steer whose
		// run stopped streaming between the check above and this call.
		if (!enqueue.call(options.chat, text)) {
			return { accepted: false, queue, refusal: "the engine refused the message; the run is no longer accepting input" };
		}
		return { accepted: true, queue };
	});

	options.transport.onRequest(ACP_SESSION_QUEUE_METHOD, (params): AcpQueueResult => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		scope.guards.getSession(request);
		// An empty pair of lists is a fact about the queues, so a build that
		// cannot read them refuses instead of reporting one it did not observe.
		if (options.chat.queuedMessages === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const queued = options.chat.queuedMessages();
		return {
			steer: boundedQueueTexts(queued.steer),
			followUp: boundedQueueTexts(queued.followUp),
			...(options.chat.queueEntries !== undefined ? { entries: projectQueueEntries(options.chat.queueEntries()) } : {}),
		};
	});

	options.transport.onRequest(ACP_SESSION_QUEUE_CLEAR_METHOD, (params): AcpQueueClearResult => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		scope.guards.getSession(request);
		if (options.chat.clearQueuedFollowUps === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		// Both queues drain together, exactly as the queue navigator's a does in the terminal: the
		// returned texts are what the client now owns and must re-send to deliver. A clear whose texts the
		// response could not carry whole is refused before anything drains, so no queued text is lost.
		const pending = options.chat.restorableQueuedTexts?.();
		if (pending !== undefined && !restorableWhole(pending)) {
			throw new AcpRequestError(
				-32602,
				`the queue holds more than ${ACP_MAX_RESTORED_MESSAGES} entries or ${ACP_MAX_STEER_TEXT_BYTES} bytes in one entry; remove entries one at a time`,
				{ code: "queue_too_large" },
			);
		}
		const restored = options.chat.clearQueuedFollowUps();
		return {
			restored: restored.slice(0, ACP_MAX_RESTORED_MESSAGES).map((text) => boundString(text, ACP_MAX_STEER_TEXT_BYTES)),
		};
	});

	options.transport.onRequest(ACP_QUEUE_EDIT_METHOD, (params): AcpQueueEditResult => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "id", "op", "delta", "kind"]));
		const session = scope.guards.getSession(request);
		const queue = queueControl(options);
		const id = requireBoundedClientString(request.id, "id", ACP_MAX_QUEUE_ENTRY_ID_BYTES);
		if (typeof request.op !== "string" || !(ACP_QUEUE_EDIT_OPS as ReadonlyArray<string>).includes(request.op)) {
			throw new AcpRequestError(-32602, `op must be one of ${ACP_QUEUE_EDIT_OPS.join(", ")}`, {
				code: "invalid_params",
			});
		}
		const op = request.op as AcpQueueEditOp;
		// Each operand belongs to one op. Accepting it on another would promise
		// an effect that op never has.
		if (
			(request.delta !== undefined) !== (op === "move") ||
			(op === "move" && request.delta !== -1 && request.delta !== 1)
		) {
			throw new AcpRequestError(-32602, "move takes delta -1 or 1, and no other op takes delta", {
				code: "invalid_params",
			});
		}
		if (
			(request.kind !== undefined) !== (op === "set_kind") ||
			(op === "set_kind" && request.kind !== "steer" && request.kind !== "follow-up")
		) {
			throw new AcpRequestError(-32602, "set_kind takes kind steer or follow-up, and no other op takes kind", {
				code: "invalid_params",
			});
		}
		// Every answer carries the queue as it now stands, so a client redraws
		// from the reply and never from its own guess at what the op did.
		const answer = (fields: Omit<AcpQueueEditResult, "entries">): AcpQueueEditResult => ({
			...fields,
			entries: projectQueueEntries(queue.entries()),
		});
		const stale = () => answer({ applied: false, reason: "stale-entry" });
		if (!queue.entries().some((entry) => entry.id === id)) return stale();
		switch (op) {
			case "remove":
				return queue.remove(id, "removed") === null ? stale() : answer({ applied: true });
			case "restore": {
				// The terminal's `e`: the entry leaves the queue and its text is the client's draft again.
				const taken = queue.remove(id, "to-editor");
				return taken === null
					? stale()
					: answer({ applied: true, text: boundString(taken.text, ACP_MAX_STEER_TEXT_BYTES) });
			}
			case "move":
				return queue.move(id, request.delta as -1 | 1)
					? answer({ applied: true })
					: answer({ applied: false, reason: "at-edge" });
			case "set_kind":
				return queue.setKind(id, request.kind as AcpQueuedEntryKind) ? answer({ applied: true }) : stale();
			case "send_now": {
				const active = session.activePrompt;
				if (active === null) return answer({ applied: false, reason: "no-active-prompt" });
				if (active.cancelled || !active.acceptsContinuation) return answer({ applied: false, reason: "prompt-ending" });
				if (!options.chat.isStreaming()) return answer({ applied: false, reason: "not-streaming" });
				const refusal = options.chat.interruptRefusal?.() ?? null;
				const taken = queue.remove(id, "sent-now");
				if (taken === null) return stale();
				// The navigator's Enter: the entry leaves the queue and is resubmitted
				// as an interrupt. The chat loop cancels the run, holds the rest of the
				// queue for the fresh prompt and starts it. When it refuses the
				// interrupt (an attached dispatch, a parked permission ask) it puts the
				// text at the head of the steering queue instead, with a notice.
				const run = options.chat.submit(taken.text, {
					steering: "interrupt",
					continuesMessage: { id: taken.id, enqueuedAt: taken.enqueuedAt },
					...(taken.display !== undefined ? { display: taken.display } : {}),
					...(taken.referencedPaths !== undefined && taken.referencedPaths.length > 0
						? { workingContextPaths: [...taken.referencedPaths] }
						: {}),
				});
				// Observed here so a rejection that lands before the prompt handler
				// reaches its continuation is not reported as unhandled; the handler
				// still awaits `run` and records the failure on the turn.
				run.catch(() => {});
				const previous = active.continuation;
				active.continuation = previous === null ? run : Promise.all([previous, run]).then(() => {});
				return answer({
					applied: true,
					delivery: refusal === null ? "interrupt" : "next-slot",
					text: boundString(taken.text, ACP_MAX_STEER_TEXT_BYTES),
					...(refusal !== null ? { refusal } : {}),
				});
			}
		}
	});

	options.transport.onRequest(ACP_SESSION_INTERRUPT_METHOD, (params): AcpInterruptResult => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "reason"]));
		const session = scope.guards.getSession(request);
		const reason =
			request.reason === undefined
				? null
				: requireBoundedClientString(request.reason, "reason", ACP_MAX_INTERRUPT_REASON_BYTES);
		if (session.activePrompt === null) {
			return { cancelled: false, refusal: "no prompt is active on this session" };
		}
		// An attached dispatch or a parked permission ask refuses the interrupt in
		// the terminal too. Honour that here instead of cancelling anyway: the
		// client gets the reason to show, and `session/cancel` remains the
		// unconditional stop for a client that means to pay the cost.
		const refusal = options.chat.interruptRefusal?.() ?? null;
		if (refusal !== null) return { cancelled: false, refusal };
		// Cancel only. The outstanding `session/prompt` returns
		// `stopReason: "cancelled"`, and the next prompt is the client's to send;
		// a server-side resubmit would start a turn with no request to answer.
		cancelSession(session, reason === null ? "prompt interrupted by client" : `client interrupt: ${reason}`);
		return { cancelled: true };
	});

	options.transport.onRequest(ACP_DISPATCH_STEER_METHOD, (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "runId", "action", "message"]));
		scope.guards.getSession(request);
		const runId = requireBoundedClientString(request.runId, "runId", ACP_MAX_DISPATCH_ID_BYTES);
		if (request.action !== "guide" && request.action !== "cancel") {
			throw new AcpRequestError(-32602, "action must be guide or cancel", { code: "invalid_params" });
		}
		if (request.action === "cancel" && request.message !== undefined) {
			// An abort carries no operator text anywhere in dispatch, so accepting
			// one here would promise the worker a message it never receives.
			throw new AcpRequestError(-32602, "cancel carries no message", { code: "invalid_params" });
		}
		const dispatch = options.dispatch;
		if (dispatch === undefined) return { accepted: false, reason: "dispatch-unavailable" };
		if (request.action === "cancel") {
			// `abort` reports nothing, so the fact has to be established before it
			// is claimed: an abort against an id this fleet never ran would poison
			// that control root for a future attempt and still answer "accepted".
			let live = false;
			try {
				const snapshot = dispatch.snapshot();
				live = snapshot.running.some((run) => run.runId === runId) || snapshot.retrying.some((run) => run.runId === runId);
			} catch {
				return { accepted: false, reason: "fleet-unavailable" };
			}
			if (!live) return { accepted: false, reason: "run-not-active" };
			try {
				dispatch.abort(runId);
			} catch {
				return { accepted: false, reason: "cancel-failed" };
			}
			return { accepted: true };
		}
		const message = requireSteerText(request.message, "message", ACP_MAX_STEER_TEXT_BYTES);
		try {
			dispatch.steer(runId, message);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			options.diagnostics?.(`dispatch steer refused: ${acpErrorMessage(detail)}`);
			return { accepted: false, reason: dispatchSteerReason(detail) };
		}
		// Queued, not delivered. The frame is on the worker's stdin; the worker
		// acknowledges acceptance later with `pancode_steer_received`, and that
		// ack's `sequence` never returns through this contract, so no sequence is
		// reported rather than a guessed one.
		return { accepted: true };
	});
	return { cancelSession, unsubscribePromptCancel, unsubscribeShellCancel };
}

export type AcpServerControl = ReturnType<typeof createAcpServerControl>;
