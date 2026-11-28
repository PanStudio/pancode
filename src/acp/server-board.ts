// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The ACP server's board methods: the session board, jobs, fleet preview and run, decisions, and memory proposals. */

import { ToolNames } from "../core/tool-names.js";
import { turnAllowsTool } from "../core/turn-constraints.js";
import { jobIsComplete } from "../domains/scheduling/index.js";
import { ACP_BOARD_METHOD, projectSessionBoard } from "./board.js";
import { AcpRequestError, acpErrorMessage } from "./errors.js";
import type { AcpFleetControl } from "./fleet-run.js";
import {
	ACP_FLEET_MAX_REASON_BYTES,
	ACP_FLEET_PREVIEW_METHOD,
	ACP_FLEET_RUN_METHOD,
	projectFleetPreview,
} from "./fleet-run.js";
import { ACP_MAX_JOBS } from "./runtime.js";
import { boundedText, boundString, requireBoundedClientString } from "./server-bounds.js";
import { jobEventPayload } from "./server-event-frames.js";
import { compileFleet, fleetName, fleetResume, fleetVars, requireFleet } from "./server-fleet.js";
import { assertParamKeys } from "./server-guards.js";
import type { AcpBoardActions, PancodeAcpServerOptions } from "./server-options.js";
import type { AcpServerScope } from "./server-scope.js";
import { ACP_DECISION_SUPERSEDE_METHOD, ACP_JOBS_LIST_METHOD, ACP_MEMORY_PROPOSE_METHOD } from "./types.js";
import type { AcpJob } from "./types-fleet.js";
import type { AcpDecisionSupersedeResult, AcpMemoryProposeResult } from "./types-session.js";

const ACP_MAX_CORRECTION_BYTES = 2048;

function requireBoardActions(options: PancodeAcpServerOptions): AcpBoardActions {
	if (options.boardActions === undefined || options.board === undefined) {
		throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
	}
	return options.boardActions;
}

export function registerAcpServerBoard(scope: AcpServerScope): void {
	const { options } = scope;
	options.transport.onRequest(ACP_BOARD_METHOD, (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.board === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		scope.guards.getSession(request);
		return projectSessionBoard(options.board());
	});

	// The jobs the bound session owns now. Events carry only changes, so a client that binds or
	// resumes reads this once and folds `job.changed` after it.
	options.transport.onRequest(ACP_JOBS_LIST_METHOD, (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const listJobs = options.commands?.jobs;
		if (listJobs === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const session = scope.guards.getSession(request);
		if (session.id !== scope.boundSessionId) {
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		}
		// Live jobs first, then the newest finished ones, so the cap drops history rather than work in flight.
		const ranked = [...listJobs()].sort(
			(left, right) =>
				Number(right.state !== "terminal") - Number(left.state !== "terminal") || right.updatedAt - left.updatedAt,
		);
		const jobs: AcpJob[] = [];
		for (const job of ranked) {
			if (jobs.length >= ACP_MAX_JOBS) break;
			const projected = jobEventPayload(
				job,
				jobIsComplete(job),
				scope.events.jobTurnOpen(job.id),
				options.commands?.jobSpend?.(job.id) ?? null,
			);
			if (projected !== null) jobs.push(projected);
		}
		return { jobs };
	});

	// Compile a named playbook for review. Nothing is dispatched, reserved or written.
	options.transport.onRequest(ACP_FLEET_PREVIEW_METHOD, (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "name", "vars", "resume"]));
		const control = requireFleet(options);
		scope.guards.getSession(request);
		return projectFleetPreview(
			compileFleet(options, control, fleetName(request.name), fleetVars(request.vars), fleetResume(request.resume)),
		);
	});

	// Start the plan the client approved, and only that plan: it is compiled
	// again here and refused before any dispatch when its hash moved.
	options.transport.onRequest(ACP_FLEET_RUN_METHOD, async (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "name", "vars", "planHash", "resume"]));
		const control = requireFleet(options);
		const bound = scope.guards.getSession(request);
		// Refused, never queued: an approved plan describes the workspace as it
		// stands, and a turn still in flight is about to change it.
		scope.guards.requireIdle(bound, "start a fleet run");
		const name = fleetName(request.name);
		const vars = fleetVars(request.vars);
		if (typeof request.planHash !== "string" || !/^[0-9a-f]{64}$/u.test(request.planHash)) {
			throw new AcpRequestError(-32602, "planHash is invalid", { code: "invalid_params" });
		}
		// A playbook starts workers outside any tool call, so the session's limits
		// screen it as they screen /run, and every worker it starts carries them (Z1).
		const limits = scope.standingLimits;
		if (limits?.readOnly === true || !turnAllowsTool(limits, ToolNames.Dispatch)) {
			throw new AcpRequestError(
				-32602,
				limits?.readOnly === true
					? "a fleet run starts workers that write and the ceiling is read-only. Nothing was dispatched"
					: "a fleet run starts workers and the ceiling withholds dispatch. Nothing was dispatched",
				{ code: "ceiling_refused" },
			);
		}
		const result = compileFleet(options, control, name, vars, fleetResume(request.resume));
		if (!result.ok) return projectFleetPreview(result);
		if (result.preview.planHash !== request.planHash) {
			return {
				status: "changed" as const,
				name: projectFleetPreview(result).name,
				planHash: result.preview.planHash,
				reason: "the plan changed since it was previewed; review it again. Nothing was dispatched",
			};
		}
		let started: Awaited<ReturnType<AcpFleetControl["run"]>>;
		try {
			started = await control.run(result.preview, limits);
		} catch (error) {
			options.diagnostics?.(`fleet run failed to start: ${acpErrorMessage(error)}`);
			throw new AcpRequestError(-32603, "fleet run failed to start", { code: "internal_error" });
		}
		if (started.status === "refused") {
			return {
				status: "refused" as const,
				name,
				diagnostics: [boundedText(started.reason, ACP_FLEET_MAX_REASON_BYTES)],
			};
		}
		const fleetRootId = boundString(started.fleetRootId, 128);
		if (started.status === "failed") {
			return {
				status: "failed" as const,
				name,
				planHash: result.preview.planHash,
				fleetRootId,
				reason: boundedText(started.reason, ACP_FLEET_MAX_REASON_BYTES),
			};
		}
		return {
			status: "started" as const,
			name,
			planHash: result.preview.planHash,
			fleetRootId,
			stepCount: result.preview.plan.steps.length,
		};
	});

	// The /decisions overlay's `s` and `c`. The record keeps the decision,
	// marked superseded; a correction's turn is returned for the client to send,
	// so it lands in the conversation as the terminal's does.
	options.transport.onRequest(ACP_DECISION_SUPERSEDE_METHOD, (params): AcpDecisionSupersedeResult => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "interviewId", "key", "correction"]));
		const actions = requireBoardActions(options);
		const bound = scope.guards.getSession(request);
		scope.guards.requireIdle(bound, "revise a decision");
		const interviewId = requireBoundedClientString(request.interviewId, "interviewId", 256);
		const key = requireBoundedClientString(request.key, "key", 1024);
		const correction =
			request.correction === undefined
				? undefined
				: requireBoundedClientString(request.correction, "correction", ACP_MAX_CORRECTION_BYTES).trim();
		if (correction !== undefined && correction.length === 0) {
			throw new AcpRequestError(-32602, "a correction needs the new direction", { code: "invalid_params" });
		}
		// Superseding writes the board's decision record, which a read-only ceiling denies.
		if (scope.standingLimits?.readOnly === true) {
			throw new AcpRequestError(-32602, "superseding a decision writes the board and the ceiling is read-only", {
				code: "ceiling_refused",
			});
		}
		try {
			const outcome = actions.supersedeDecision(interviewId, key, correction);
			return {
				status: outcome.status,
				...(outcome.correctionTurn !== undefined ? { correctionTurn: boundString(outcome.correctionTurn, 4096) } : {}),
			};
		} catch (error) {
			return { status: "refused" as const, reason: boundString(acpErrorMessage(error), 1024) };
		}
	});

	// The /memory overlay's `p` and `g`. A proposal is a candidate for review,
	// never an approval; global scope broadens where a lesson applies, so it is
	// refused until the client says the operator acknowledged that.
	options.transport.onRequest(ACP_MEMORY_PROPOSE_METHOD, async (params): Promise<AcpMemoryProposeResult> => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "entryId", "scope", "acknowledgeGlobal"]));
		const actions = requireBoardActions(options);
		scope.guards.getSession(request);
		const entryId = requireBoundedClientString(request.entryId, "entryId", 256);
		if (request.scope !== "repo" && request.scope !== "global") {
			throw new AcpRequestError(-32602, "scope must be repo or global", { code: "invalid_params" });
		}
		// A proposal writes a memory record, which a read-only ceiling denies.
		if (scope.standingLimits?.readOnly === true) {
			throw new AcpRequestError(-32602, "a memory proposal writes a record and the ceiling is read-only", {
				code: "ceiling_refused",
			});
		}
		if (request.scope === "global" && request.acknowledgeGlobal !== true) {
			return {
				status: "needs_acknowledgement" as const,
				reason: "global scope broadens where this lesson applies; acknowledge it to propose",
			};
		}
		try {
			const outcome = await actions.proposeMemory(entryId, request.scope);
			return { status: outcome.created ? ("proposed" as const) : ("existing" as const), recordId: outcome.recordId };
		} catch (error) {
			return { status: "refused" as const, reason: boundString(acpErrorMessage(error), 1024) };
		}
	});
}
