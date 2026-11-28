// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { realpathSync } from "node:fs";
import { enterAutonomousCommitScope } from "../../core/git-commit-attribution.js";
import { JobClockExpired } from "../../core/job-types.js";
import type { ChatLoop } from "../chat-loop.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";
import type {
	MachineTurnProjectionAdmission,
	MachineTurnProjectionHost,
	MachineTurnResult,
} from "../job-turn-types.js";
import type { AgentRuntime, ChatLoopMachineTurnState } from "../turn-state.js";

/**
 * The machine turn: a scheduled job's turn admitted through the ordinary submit when the conversation is idle,
 * projected into the attended host when one is bound, and cancelled with the job occurrence that owns it.
 */
export function createChatLoopMachineTurn(
	loop: ChatLoopScope,
	state: ChatLoopMachineTurnState,
): Required<Pick<ChatLoop, "bindMachineTurnProjection" | "machineTurnAvailable" | "submitMachineTurn">> {
	const { context, deps, emit, emitNotice, preparingSubmits, queues } = loop;
	let machineTurnOwner: object | null = null;
	let machineProjectionBinding: { host: MachineTurnProjectionHost } | null = null;
	let machineProjectionRequired = false;
	const bindMachineTurnProjection: NonNullable<ChatLoop["bindMachineTurnProjection"]> = (host) => {
		const binding = { host };
		machineProjectionRequired = true;
		machineProjectionBinding = binding;
		return () => {
			if (machineProjectionBinding === binding) machineProjectionBinding = null;
		};
	};
	const machineTurnAvailable: NonNullable<ChatLoop["machineTurnAvailable"]> = () =>
		!loop.machineHostDisposed &&
		(!machineProjectionRequired || machineProjectionBinding !== null) &&
		machineTurnOwner === null &&
		!state.streaming &&
		preparingSubmits() === 0 &&
		!loop.turnActive &&
		!state.currentAskUserPolicy?.inFlight &&
		deps.toolRegistry?.hasParkedCalls() !== true &&
		queues.entries().length === 0;
	const submitMachineTurn: NonNullable<ChatLoop["submitMachineTurn"]> = async (request) => {
		const refused = (reason: string): MachineTurnResult => ({ status: "refused", turnId: null, reason });
		if (machineProjectionRequired && machineProjectionBinding === null)
			return refused(
				"The attended turn projection is detached; delivery remains with its job controller until the host is available.",
			);
		const paused = deps.autonomy?.halted() ?? null;
		if (paused !== null)
			return refused(`YOLO is paused for the operator (${paused.detail}); delivery remains with its job controller.`);
		if (!loop.api.machineTurnAvailable?.())
			return refused("The main conversation is busy; delivery remains with its job controller.");
		const current = (): boolean =>
			!loop.machineHostDisposed &&
			!request.signal.aborted &&
			request.sessionId === loop.api.getSessionId() &&
			request.isAdmissionCurrent();
		if (!current()) return refused("The job's originating session or generation is no longer current.");
		const token = {};
		machineTurnOwner = token;
		let settled: MachineTurnResult | null = null;
		let ownedUserTurnId: string | null = null;
		let ownedRuntime: AgentRuntime | null = null;
		let projectionLease: Extract<MachineTurnProjectionAdmission, { status: "ready" }> | null = null;
		// A scheduled job's turn is autonomous: its commits name PanCode as author under `auto`.
		const autonomousCommits: { release: (() => void) | null } = { release: null };
		const cancel = (): void => {
			if (
				machineTurnOwner === token &&
				loop.machinePreparation?.token === token &&
				!state.streaming &&
				state.activeUserTurnId === null
			) {
				// This preparation still owns the FIFO slot; cancel its ports without aborting a successor runtime (#411).
				loop.pendingPreTurnRead?.abort();
				loop.pendingVisionSidecar?.abort();
				loop.pendingCompactionPaint?.abort();
				if (loop.machinePreparation.runtime !== null && state.runtime === loop.machinePreparation.runtime)
					context.cancelCompaction();
				return;
			}
			if (
				loop.machineTurnRunning === token &&
				ownedUserTurnId !== null &&
				state.activeUserTurnId === ownedUserTurnId &&
				state.runtime === ownedRuntime &&
				request.sessionId === loop.api.getSessionId()
			) {
				loop.pendingMachineCancellation = token;
				// The controller's abort reason says what ended it; a timed-out occurrence is not a cancelled one (#445).
				const cause = request.signal.reason;
				const ended = cause instanceof Error ? cause.message : String(cause);
				try {
					loop.api.cancel({
						reason: `Scheduled job occurrence ended: ${ended}.`,
						auditReason: `job occurrence ended: ${ended}`,
						...(cause instanceof JobClockExpired ? { source: "job_clock" as const } : {}),
					});
				} finally {
					loop.pendingMachineCancellation = null;
				}
			}
		};
		request.signal.addEventListener("abort", cancel, { once: true });
		try {
			const binding = machineProjectionBinding;
			if (binding !== null) {
				const meta = deps.session?.current();
				if (!meta || meta.id !== request.sessionId)
					return refused("The projection's conversation is no longer bound to this machine turn.");
				const projection = binding.host.acquire({
					jobId: request.jobId,
					executionId: request.executionId,
					text: request.text,
					origin: request.origin,
					sessionId: request.sessionId,
					cwd: realpathSync(meta.cwd),
					signal: request.signal,
				});
				if (projection.status === "deferred") return refused(projection.reason);
				projectionLease = projection;
				if (!current() || machineProjectionBinding !== binding)
					return refused("The attended projection host changed during machine-turn admission.");
			}
			await loop.api.submit(request.text, {
				origin: request.origin,
				...(request.operatorAuthored === true ? { operatorAuthored: true } : {}),
				...(request.constraints === undefined ? {} : { constraints: request.constraints }),
				isAdmissionCurrent: current,
				machineTurn: {
					preparationToken: token,
					onStarting: request.onStarting,
					onSettled: (result) => {
						settled = result;
						if (loop.machineTurnRunning === token) loop.machineTurnRunning = null;
					},
				},
				onAdmitted: () => {
					if (loop.machinePreparation?.token === token) loop.machinePreparation = null;
					loop.machineTurnRunning = token;
					autonomousCommits.release ??= enterAutonomousCommitScope();
					ownedUserTurnId = state.activeUserTurnId;
					ownedRuntime = state.runtime;
					emit({
						type: "queued_user_turn",
						text: request.text,
						kind: "follow-up",
						origin: request.origin,
					});
					if (request.notice !== undefined) emitNotice(request.notice, "warning", "job.clock-resumed");
					if (request.signal.aborted) cancel();
				},
			});
			return (
				settled ??
				refused(
					request.signal.aborted
						? "Scheduled delivery canceled before execution."
						: "The fresh turn was refused during ordinary admission.",
				)
			);
		} catch (error) {
			return {
				status: request.signal.aborted ? "canceled" : "failed",
				turnId: null,
				reason: error instanceof Error ? error.message : String(error),
			};
		} finally {
			request.signal.removeEventListener("abort", cancel);
			autonomousCommits.release?.();
			if (loop.machineTurnRunning === token) loop.machineTurnRunning = null;
			try {
				projectionLease?.release();
			} catch (error) {
				emitNotice(
					`Machine turn projection release failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			if (machineTurnOwner === token) machineTurnOwner = null;
			// Successor prompts have their own lifetime and must never extend this occurrence (#411).
			if (settled !== null && !loop.machineHostDisposed)
				void queues
					.resubmitStranded()
					.then(async (submitted) => {
						if (!submitted) await queues.resubmitRequestContinuation();
					})
					.catch((error: unknown) => emitNotice(error instanceof Error ? error.message : String(error), "error"));
		}
	};
	return { bindMachineTurnProjection, machineTurnAvailable, submitMachineTurn };
}
