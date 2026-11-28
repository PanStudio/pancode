// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Authenticated two-call Scout continuation protocol and the dependency plan runner it shares with model-authored DAGs. */

import type { ScoutResult } from "../domains/agents/result-contract-types.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import type { DispatchContract, DispatchPlanTaskResolution, DispatchRequest } from "../domains/dispatch/contract.js";
import type { ExecutionPlan } from "../domains/dispatch/execution-plan.js";
import { executePlan } from "../domains/dispatch/execution-scheduler.js";
import type { RunEnvelope, RunResult } from "../domains/dispatch/types.js";
import type { ResolvedDispatchPlanArtifact } from "./dispatch-plan.js";
import { validateScoutSource } from "./dispatch-scout-admission.js";
import { finishedRun } from "./worker-evidence.js";

export type ScoutTransitionDetail =
	| {
			kind: "settled";
			sourceRunId: string;
			sourceRunDigest: string;
			findings: ScoutResult["findings"];
	  }
	| {
			kind: "proposed";
			sourceRunId: string;
			sourceRunDigest: string;
			subtaskCount: number;
			continueWith: { from_scout: { run_id: string; run_digest: string } };
	  };

export function scoutTransitionDetail(input: {
	receipt: RunResult;
	envelope: RunEnvelope;
	agentSpecs: ReadonlyArray<AgentSpec>;
}): ScoutTransitionDetail | null {
	try {
		const source = validateScoutSource(finishedRun(input.receipt), input.envelope, input.agentSpecs);
		return source.scout.needsSplit
			? {
					kind: "proposed",
					sourceRunId: source.run.runId,
					sourceRunDigest: source.run.digest,
					subtaskCount: source.scout.proposedSubtasks.length,
					continueWith: {
						from_scout: { run_id: source.run.runId, run_digest: source.run.digest },
					},
				}
			: {
					kind: "settled",
					sourceRunId: source.run.runId,
					sourceRunDigest: source.run.digest,
					findings: source.scout.findings.map((finding) => ({ ...finding })),
				};
	} catch {
		return null;
	}
}

/** Every step of a sealed dependency plan, Scout continuation or model-authored batch, holds the grant it was approved under. */
export function dependencyPlanAuthorityGranted(
	artifact: ResolvedDispatchPlanArtifact,
	operatorApproved: boolean,
	yolo: boolean,
): boolean {
	return artifact.tasks.every(
		(task) =>
			task.authorityGrant !== null &&
			((task.authorityGrant.basis === "operator-plan-approval" && operatorApproved) ||
				(task.authorityGrant.basis === "yolo-policy" && yolo)),
	);
}

/**
 * The route a step's live preview must still resolve to: the shared resolver's selection for a Scout successor, the
 * task's own approved route for a model-authored dependency plan.
 */
function approvedRouteHolds(
	artifact: ResolvedDispatchPlanArtifact,
	task: ResolvedDispatchPlanArtifact["tasks"][number],
	resolution: DispatchPlanTaskResolution,
): boolean {
	const node = resolution.node;
	if (node.kind !== task.nodeKind || node.host !== task.nodeHost) return false;
	if (artifact.source?.kind !== "scout-transition") {
		return (
			resolution.agentId === task.agent &&
			resolution.targetId === task.target &&
			resolution.wireModelId === task.model &&
			node.id === task.node
		);
	}
	const approved = task.agentDecision?.selected;
	return (
		approved !== undefined &&
		resolution.agentId === approved.agentId &&
		resolution.specFingerprint === approved.specFingerprint &&
		resolution.targetId === approved.targetId &&
		resolution.wireModelId === approved.modelId &&
		resolution.runtimeId === approved.runtimeId &&
		node.id === approved.nodeId &&
		resolution.thinkingLevel === (approved.thinkingLevel ?? null) &&
		resolution.toolSignature === approved.toolSignature &&
		resolution.endpointIdentityHash === approved.endpointIdentityHash &&
		resolution.settingsFingerprint === approved.settingsFingerprint
	);
}

/** Execute one already-authenticated dependency plan through the shared scheduler. */
export async function runDependencyPlan<T, S>(input: {
	dispatch: Pick<DispatchContract, "abort" | "dispatch" | "preview" | "reservations">;
	plan: ExecutionPlan;
	artifact: ResolvedDispatchPlanArtifact;
	requests: ReadonlyArray<DispatchRequest>;
	reservationOwnerId: string;
	signal?: AbortSignal;
	register(
		handle: Awaited<ReturnType<DispatchContract["dispatch"]>>,
		agentId: string,
	): Promise<{ receipt: RunResult; summary: S }>;
	complete(receipt: RunResult, summary: S): { value: T; integrityValid: boolean };
}): Promise<{ runs: T[]; skipped: ReadonlyArray<string> }> {
	const assignmentDeadlineAt = input.artifact.deadlineMs === null ? undefined : Date.now() + input.artifact.deadlineMs;
	const completedByStep = new Map<string, T>();
	const byStep = new Map(
		input.artifact.tasks.map((task, index) => [task.stepId, { task, request: input.requests[index] }]),
	);
	const result = await executePlan(
		input.plan,
		{
			preflight(step) {
				const bound = byStep.get(step.id);
				if (bound?.request === undefined) throw new Error(`plan step '${step.id}' has no trusted request`);
				const resolution = input.dispatch.preview?.(bound.request);
				if (resolution === undefined) throw new Error(`plan step '${step.id}' cannot be preflighted`);
				if (!approvedRouteHolds(input.artifact, bound.task, resolution)) {
					throw new Error(`plan step '${step.id}' drifted from its approved route`);
				}
				return { step, costUpperBoundUsd: resolution.costUpperBoundUsd, nodeId: resolution.node.id };
			},
			reserve(_plan, admissions) {
				const cost = admissions.reduce((sum, admission) => sum + admission.costUpperBoundUsd, 0);
				const ceilingUsd = input.artifact.costCeilingUsd;
				if (!Number.isFinite(cost) || (ceilingUsd > 0 && cost > ceilingUsd)) {
					throw new Error("dependency plan drifted above its approved cost ceiling");
				}
				return { ownerId: input.reservationOwnerId };
			},
			async run(step, handoffs, reservation, ledger) {
				const bound = byStep.get(step.id);
				if (bound?.request === undefined) throw new Error(`plan step '${step.id}' has no trusted request`);
				const request: DispatchRequest = {
					...bound.request,
					predecessorHandoffs: handoffs,
					reservation,
					...(assignmentDeadlineAt === undefined ? {} : { assignmentDeadlineAt }),
					...(ledger !== undefined ? { ledger } : {}),
				};
				const handle = await input.dispatch.dispatch(request);
				return {
					assignmentId: handle.runId,
					result: input.register(handle, request.agentId).then(({ receipt, summary }) => {
						const completed = input.complete(receipt, summary);
						completedByStep.set(step.id, completed.value);
						return {
							stepId: step.id,
							assignmentId: handle.runId,
							terminalRunId: receipt.runId,
							runDigest: receipt.digest,
							output: receipt.output?.state === "final" ? receipt.output.text : "",
							succeeded: receipt.exitCode === 0 && (receipt.outcome === undefined || receipt.outcome === "succeeded"),
							integrityValid: completed.integrityValid,
						};
					}),
				};
			},
			cancel: (assignmentId) => input.dispatch.abort(assignmentId),
			release: (ownerId) => input.dispatch.reservations?.release(ownerId),
			releaseUnconsumed: (ownerId) => input.dispatch.reservations?.rollbackUnconsumed(ownerId),
		},
		input.signal,
	);
	return {
		runs: input.plan.steps.flatMap((step) => {
			const completed = completedByStep.get(step.id);
			return completed === undefined ? [] : [completed];
		}),
		skipped: result.skipped,
	};
}
