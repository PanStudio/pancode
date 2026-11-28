// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The ACP server's chat observer and the lease that shows a scheduled main turn in the bound session as a prompt would. */

import type {
	MachineTurnProjectionAdmission,
	MachineTurnProjectionRequest,
} from "../session-control/job-turn-types.js";
import { safeStoredIdentifier } from "./server-bounds.js";
import { ACP_MAX_DISPATCH_ID_BYTES } from "./server-event-frames.js";
import type { AcpServerEvent } from "./server-options.js";
import type { AcpServerScope } from "./server-scope.js";
import type { ActivePrompt } from "./server-tool-updates.js";
import {
	createActivePromptState,
	flushChunkCredentials,
	handleChatEvent,
	observeTelemetry,
	settleOpenToolCalls,
} from "./server-tool-updates.js";

export function createAcpServerMachine(scope: AcpServerScope) {
	const { options } = scope;
	/** Streams a turn's chat events as frames. A prompt and a scheduled main turn share it, so neither forks the projection. */
	const attachTurnObserver = (sessionId: string, active: ActivePrompt): (() => void) => {
		const onTurnEvent = (event: AcpServerEvent) => {
			handleChatEvent(event, options.transport, sessionId, active, scope.canonicalCwd, options.diagnostics, () => {
				scope.permission.cancelPending("tool call limit exceeded");
				options.toolRegistry?.cancelParkedCalls("tool call limit exceeded");
				options.chat.cancel();
			});
			observeTelemetry(scope.telemetry, event, active);
		};
		const unsubscribeChat = options.chat.onEvent(onTurnEvent);
		const unsubscribeHost = options.hostToolEvents?.onEvent(onTurnEvent);
		return () => {
			unsubscribeChat();
			unsubscribeHost?.();
		};
	};

	/**
	 * A scheduled main turn has no `session/prompt` request to own its frames, its approvals or its
	 * end. The chat loop asks here, synchronously, before it prepares one, and gets the same prompt
	 * state a prompt installs (`ActivePrompt`, the chat observer, the permission binding) or a
	 * deferral it reports back to the job controller. Nothing here runs a turn or answers a request:
	 * the bracket the client sees is `job.changed` with `turn` true from the first frame to the release.
	 * Every check is the same one that refuses a second prompt, so a lease and an operator turn can
	 * never hold the state together, and a release clears only what its own lease installed (#411).
	 */
	const acquireMachineTurn = (request: MachineTurnProjectionRequest): MachineTurnProjectionAdmission => {
		const deferred = (reason: string): MachineTurnProjectionAdmission => ({ status: "deferred", reason });
		const session = scope.boundSessionId === null ? undefined : scope.sessions.get(scope.boundSessionId);
		const jobId = safeStoredIdentifier(request.jobId, ACP_MAX_DISPATCH_ID_BYTES);
		if (!scope.handshake.initialized || session === undefined || jobId === null) {
			return deferred("This ACP connection has no bound session to show a scheduled turn in.");
		}
		if (
			request.sessionId !== session.id ||
			request.cwd !== scope.canonicalCwd ||
			options.session === undefined ||
			options.session.current()?.id !== session.id
		) {
			return deferred("The scheduled turn's session or workspace is not the one this client is bound to.");
		}
		if (request.signal.aborted) return deferred("The occurrence was cancelled before its turn could be shown.");
		if (
			scope.machineLease !== null ||
			session.activePrompt !== null ||
			scope.activePromptState !== null ||
			scope.contextCommandInFlight !== null ||
			scope.activeShell !== null ||
			scope.handoffPreparing ||
			options.chat.isStreaming()
		) {
			return deferred("The conversation is busy; the job keeps its pending delivery.");
		}
		const active = createActivePromptState({ enabled: scope.handshake.toolProgressEnabled, now: scope.now });
		// A queue send-now would resubmit through this lease and strand the successor with no observer.
		active.acceptsContinuation = false;
		const scheduled: NonNullable<ActivePrompt["scheduled"]> = {
			jobId,
			opened: false,
			open: () => {
				scheduled.opened = true;
				scope.events.forwardJobTurn(jobId);
			},
		};
		active.scheduled = scheduled;
		const lease = { jobId, active };
		scope.machineLease = lease;
		session.activePrompt = active;
		scope.activePromptState = active;
		scope.activeSessionId = session.id;
		// A reviewed document describes the conversation as it stood; a scheduled turn moves it too.
		scope.pendingHandoff = null;
		scope.promptSerial++;
		let settle: () => void = () => {};
		const settled = new Promise<void>((resolveSettled) => {
			settle = resolveSettled;
		});
		scope.promptSettled = settled;
		options.onActiveSessionAutonomyChange?.(session.autonomy);
		scope.telemetry.turnStarted(active.turn);
		const detach = attachTurnObserver(session.id, active);
		let released = false;
		return {
			status: "ready",
			release: () => {
				if (released) return;
				released = true;
				active.acceptsContinuation = false;
				detach();
				if (request.signal.aborted) active.cancelled = true;
				flushChunkCredentials(options.transport, session.id, active, false);
				settleOpenToolCalls(
					options.transport,
					session.id,
					active,
					active.permissionExpired ? "permission approval expired" : active.cancelled ? "cancelled" : "turn ended",
				);
				// The last meter frame precedes the bracket that closes the turn; the state stays held until it lands.
				void scope.telemetry
					.turnSettled()
					.catch(() => options.diagnostics?.("a scheduled turn's final telemetry frame failed"))
					.then(() => {
						if (scope.machineLease === lease) scope.machineLease = null;
						if (session.activePrompt === active) session.activePrompt = null;
						if (scope.activePromptState === active) scope.activePromptState = null;
						if (scope.activeSessionId === session.id && scope.activePromptState === null) {
							scope.activeSessionId = null;
							options.onActiveSessionAutonomyChange?.(null);
						}
						if (scope.promptSettled === settled) scope.promptSettled = null;
						if (scheduled.opened) scope.events.forwardJobTurn(jobId);
						settle();
					});
			},
		};
	};
	const unbindMachineTurns = options.chat.bindMachineTurnProjection?.({ acquire: acquireMachineTurn });
	return { attachTurnObserver, unbindMachineTurns };
}

export type AcpServerMachine = ReturnType<typeof createAcpServerMachine>;
