// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { isRecord } from "../core/type-guards.js";
import { pancodeStateDir } from "../core/xdg.js";
import { durableAssistantTextFromEvent } from "../domains/dispatch/event-pump.js";
import {
	type AgentRoleFactsResolver,
	agentRoleFactsResolver,
	gateRouteCorrelation,
	type RouteCorrelationFacts,
} from "../domains/dispatch/execution-role.js";
import {
	decideReviewGate,
	type GateDecisionCorrelation,
	type GateDecisionDraft,
	materializePendingGateDecision,
	type PendingGateDecisionHandle,
	parseCompeteGateResult,
	preflightPendingGateDecisionMaterialization,
	preparePendingGateDecisionRecovery,
	type ReviewerInspection,
	readGateDecisionArtifacts,
	resolvePendingGateDecision,
	reviewerInspectionOf,
	verdictCitesDetail,
} from "../domains/dispatch/gate-decisions.js";
import type { DispatchIntent } from "../domains/dispatch/intent.js";
import { dispatchOwnerOf, dispatchOwnership } from "../domains/dispatch/ownership.js";
import type { RunGateSubjectRef, RunResult } from "../domains/dispatch/types.js";
import { readVerifiedRun } from "../domains/telemetry/index.js";
import {
	competeBranchForCandidate,
	protectedPathsChangedByCompeteBranch,
	settleRecoveredCompeteDecision,
} from "./compete-worktrees.js";
import { fallbackProgressBus, type RegisteredDispatchToolDeps } from "./dispatch-call.js";
import type { EventSummary } from "./dispatch-output.js";
import type { DispatchToolDeps } from "./dispatch-types.js";

/** The recipe facts a gate builder's role is resolved from (DESIGN 4.2). */
export function dispatchRoleFacts(
	deps: Pick<DispatchToolDeps, "getAgentSpecs" | "getAgentRoleFacts">,
): AgentRoleFactsResolver {
	return (
		deps.getAgentRoleFacts ?? agentRoleFactsResolver((id) => deps.getAgentSpecs().find((spec) => spec.id === id) ?? null)
	);
}

function rawAssistantTextFromEvent(event: unknown): string {
	return durableAssistantTextFromEvent(event);
}

export function normalizedAssistantText(summary: EventSummary): string {
	return summary.lastAssistantText.trim();
}

/**
 * Gate-sensitive coordinator drain. Review and compete must finish this drain
 * and stage pending decision output before awaiting the receipt-facing final
 * promise; the ordinary registry's concurrent join cannot provide that edge.
 */
export async function consumeGateSensitiveDispatchEvents(
	deps: RegisteredDispatchToolDeps,
	runId: string,
	agentId: string,
	events: AsyncIterableIterator<unknown>,
): Promise<EventSummary> {
	const summary: EventSummary = { count: 0, types: [], lastAssistantText: "", terminalAttemptRunId: runId };
	const bus = fallbackProgressBus(deps);
	for await (const event of events) {
		summary.count += 1;
		const type = isRecord(event) && typeof event.type === "string" ? event.type : "unknown";
		summary.types.push(type);
		if (type === "attempt_start" && isRecord(event) && typeof event.runId === "string" && event.runId.length > 0) {
			summary.terminalAttemptRunId = event.runId;
		}
		const text = rawAssistantTextFromEvent(event);
		if (text.trim().length > 0) summary.lastAssistantText = text;
		deps.runEvents.recordEvent(runId, agentId, event);
		if (type !== "heartbeat") bus?.emit("run.progressed", { runId, agentId, event });
	}
	return summary;
}

export function subjectRef(receipt: Pick<GateRunFacts, "runId" | "digest">): RunGateSubjectRef {
	return { runId: receipt.runId, digest: receipt.digest };
}

/**
 * Sealed correlation between a decider route and the subject route it graded.
 * Reported on every decision, including when no independent route exists.
 */
export function gateCorrelationOf(subject: GateRunFacts, decider: GateRunFacts): GateDecisionCorrelation {
	const facts = (receipt: GateRunFacts): RouteCorrelationFacts => ({
		agentId: receipt.agentId,
		targetId: receipt.targetId,
		wireModelId: receipt.wireModelId,
		runtimeId: receipt.runtimeId,
		nodeId: receipt.node?.id ?? "local",
	});
	const { agent, target, modelFamily, runtime, node, independent } = gateRouteCorrelation(
		facts(subject),
		facts(decider),
	);
	return { agent, target, modelFamily, runtime, node, independent };
}

/** A compete judge's intent declares no check of its own; a compete with no check keeps its intent object as is. */
export function judgeIntent(intent: DispatchIntent): DispatchIntent {
	return intent.verification.length === 0 ? intent : { ...intent, verification: [] };
}

/** What gate decisions read of a finished run: its identity, route and verdict. A run in memory and a sealed run both carry it. */
type GateRunFacts = Pick<
	RunResult,
	"runId" | "digest" | "agentId" | "targetId" | "wireModelId" | "runtimeId" | "outcome"
> & {
	exitCode: number | null;
	node?: { id: string };
	inspection?: ReviewerInspection;
};

/** A finished run read back from its sealed run scope for gate recovery; null when it has not settled under a verified seal. */
function readVerifiedGateRun(deps: DispatchToolDeps, runId: string): GateRunFacts | null {
	if (deps.dispatch.getRun(runId) === null) return null;
	const run = readVerifiedRun(pancodeStateDir(), runId);
	if (run === null) return null;
	const settled = run.settled;
	return {
		runId,
		digest: settled.digest,
		agentId: settled.agentId,
		targetId: settled.route.targetId,
		wireModelId: settled.route.wireModelId,
		runtimeId: settled.route.runtimeId,
		outcome: settled.outcome,
		exitCode: settled.exitCode,
		...(settled.node ? { node: { id: settled.node.id } } : {}),
		inspection: reviewerInspectionOf({ outcomeCode: settled.outcomeCode, verdict: settled.verdict ?? null }),
	};
}

function recoveredCorrelation(
	deps: DispatchToolDeps,
	subjects: ReadonlyArray<RunGateSubjectRef>,
	decider: GateRunFacts,
): GateDecisionCorrelation {
	const first = subjects[0];
	const subject = first === undefined ? null : readVerifiedGateRun(deps, first.runId);
	if (subject === null) throw new Error("recovered gate decision has no verified subject run for correlation");
	return gateCorrelationOf(subject, decider);
}

function settlePendingCompeteResource(handle: PendingGateDecisionHandle, draft: GateDecisionDraft): void {
	if (
		draft.topology !== "compete" ||
		(draft.outcome !== "winner" && draft.outcome !== "no-winner" && draft.outcome !== "exhausted")
	)
		return;
	const root = handle.record.resourceRoot ?? process.cwd();
	settleRecoveredCompeteDecision(root, draft.group, draft.outcome === "winner" ? (draft.winner?.index ?? null) : null);
}

/**
 * Whether this session owns a run by id: null when this process's ledger
 * mirror has no row for it, which covers a sibling's run started after this
 * process opened the ledger.
 */
function gateRunOwnership(deps: DispatchToolDeps): (runId: string) => boolean | null {
	const ownership = dispatchOwnership(dispatchOwnerOf(deps.dispatch));
	return (runId) => {
		const run = deps.dispatch.getRun(runId);
		return run === null ? null : ownership.ownsRun(run);
	};
}

/**
 * Rebuild decisions whose reviewer/judge output crossed the WAL boundary but
 * whose coordinator died before parsing or materialization. Receipt integrity
 * is verified before the output protocol is trusted. Every resolved record is
 * collision-checked before compete worktrees move to their recovered state.
 *
 * Only this session's records and decisions are recovered. The journal and
 * the decision artifacts are machine-wide, and this runs before every
 * dispatch, so recovering a sibling's records failed this session's dispatch
 * on the sibling's live compete coordinator or its not-yet-sealed receipts.
 */
export async function recoverPendingGateEvidence(deps: DispatchToolDeps): Promise<void> {
	const ownsRun = gateRunOwnership(deps);
	const recovery = preparePendingGateDecisionRecovery(undefined, { ownsRun });
	const resolved: PendingGateDecisionHandle[] = [];
	for (const handle of recovery.unresolved) {
		if (handle.record.kind !== "output") continue;
		const record = handle.record;
		const deciderReceipt = readVerifiedGateRun(deps, record.deciderRunId);
		if (deciderReceipt === null) {
			throw new Error(
				`pending ${record.topology} decision ${record.id} has no verified decider receipt for ${record.deciderRunId}`,
			);
		}
		const decider = subjectRef(deciderReceipt);
		let draft: GateDecisionDraft;
		if (record.topology === "review") {
			if (isPipelineStepFailure(deciderReceipt)) {
				draft = {
					group: record.group,
					topology: "review",
					cycle: record.cycle,
					outcome: "exhausted",
					subjects: record.subjects,
					decider,
					correlation: recoveredCorrelation(deps, record.subjects, deciderReceipt),
					detail: `reviewer ended ${pipelineFailureReason(deciderReceipt)}`,
				};
			} else {
				draft = decideReviewGate({
					group: record.group,
					cycle: record.cycle,
					terminalCycle: record.terminalCycle === true,
					subjects: record.subjects,
					decider,
					correlation: recoveredCorrelation(deps, record.subjects, deciderReceipt),
					output: record.finalOutput,
					reviewer: deciderReceipt.inspection ?? { obligationUnmet: false },
				}).draft;
			}
			resolved.push(resolvePendingGateDecision(handle, draft));
			continue;
		}

		const judged = isPipelineStepFailure(deciderReceipt)
			? null
			: parseCompeteGateResult(record.finalOutput, record.subjects.length);
		const pick = judged?.ok ? judged.result.winner : null;
		const pickedSubject = pick === null ? undefined : record.subjects[pick - 1];
		const candidateReceipt = pickedSubject === undefined ? null : readVerifiedGateRun(deps, pickedSubject.runId);
		const root = record.resourceRoot ?? process.cwd();
		const pickedBranch = pick === null ? null : competeBranchForCandidate(root, record.group, pick);
		if (pickedSubject !== undefined && candidateReceipt === null) {
			throw new Error(
				`pending compete decision ${record.id} has no verified candidate receipt for ${pickedSubject.runId}`,
			);
		}
		let blockedProtected: string[] = [];
		if (pick !== null && pickedSubject !== undefined && candidateReceipt !== null) {
			const protectedPaths = deps.dispatch.protectedArtifactState?.().artifacts.map((artifact) => artifact.path) ?? [];
			blockedProtected = protectedPathsChangedByCompeteBranch(
				root,
				pickedBranch ?? `pancode/compete/${record.group}/${pick}`,
				protectedPaths,
			);
		}
		const validWinner =
			pick !== null &&
			pickedSubject !== undefined &&
			candidateReceipt !== null &&
			!isPipelineStepFailure(candidateReceipt) &&
			blockedProtected.length === 0;
		if (validWinner && pick !== null && pickedSubject !== undefined && pickedBranch !== null) {
			draft = {
				group: record.group,
				topology: "compete",
				cycle: record.cycle,
				outcome: "winner",
				subjects: record.subjects,
				decider,
				correlation: recoveredCorrelation(deps, record.subjects, deciderReceipt),
				winner: {
					index: pick,
					subject: pickedSubject,
					branch: pickedBranch,
				},
				...(judged?.ok === true ? { detail: verdictCitesDetail(judged.result.checks) } : {}),
			};
		} else {
			// A judge that left its cited-evidence obligation unmet exhausts the gate; the operator decides (M10).
			const exhausted = isPipelineStepFailure(deciderReceipt) && deciderReceipt.inspection?.obligationUnmet === true;
			draft = {
				group: record.group,
				topology: "compete",
				cycle: record.cycle,
				outcome: exhausted ? "exhausted" : "no-winner",
				subjects: record.subjects,
				decider,
				correlation: recoveredCorrelation(deps, record.subjects, deciderReceipt),
				detail: isPipelineStepFailure(deciderReceipt)
					? `judge ended ${pipelineFailureReason(deciderReceipt)}`
					: judged !== null && !judged.ok
						? judged.reason
						: blockedProtected.length > 0
							? `judge-selected candidate ${pick} changes protected artifact(s): ${blockedProtected.join(", ")}`
							: `judge picked failed or missing candidate ${pick}`,
			};
		}
		resolved.push(resolvePendingGateDecision(handle, draft));
	}

	const ready = [...recovery.ready, ...resolved];
	preflightPendingGateDecisionMaterialization(ready);
	for (const handle of ready) {
		if (handle.record.kind !== "decision") continue;
		settlePendingCompeteResource(handle, handle.record.decision);
		await materializePendingGateDecision(handle);
	}

	// A process may have died after the final winner artifact was written but
	// before the worktree manifest moved to winner-preserved. Restore that safe
	// decision point even though no pending WAL remains.
	const durable = readGateDecisionArtifacts();
	const confirmedGroups = new Set(
		durable
			.filter(
				({ artifact }) =>
					artifact.topology === "compete" &&
					(artifact.outcome === "operator-confirmed" || artifact.outcome === "yolo-applied"),
			)
			.map(({ artifact }) => artifact.group),
	);
	for (const { artifact } of durable) {
		if (
			artifact.topology !== "compete" ||
			artifact.outcome !== "winner" ||
			artifact.winner === undefined ||
			confirmedGroups.has(artifact.group) ||
			artifact.decider === undefined ||
			ownsRun(artifact.decider.runId) !== true
		) {
			continue;
		}
		settleRecoveredCompeteDecision(process.cwd(), artifact.group, artifact.winner.index);
	}
}

/** A pipeline step failed when its worker exited nonzero or its outcome is not success. */
export function isPipelineStepFailure(receipt: Pick<GateRunFacts, "exitCode" | "outcome">): boolean {
	if (receipt.exitCode !== 0) return true;
	return receipt.outcome !== undefined && receipt.outcome !== "succeeded";
}

export function pipelineFailureReason(receipt: Pick<GateRunFacts, "exitCode" | "outcome">): string {
	if (receipt.outcome !== undefined && receipt.outcome !== "succeeded") return `outcome=${receipt.outcome}`;
	return `exit=${receipt.exitCode}`;
}
