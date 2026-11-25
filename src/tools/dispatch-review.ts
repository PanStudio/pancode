// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { TelemetryContext } from "../core/telemetry/context.js";
import type { DispatchRequest } from "../domains/dispatch/contract.js";
import { buildEvidencePacket, type EvidencePacket, packetProvenance } from "../domains/dispatch/evidence-packet.js";
import { reviewDeciderAgentId, withRunRole } from "../domains/dispatch/execution-role.js";
import {
	decideReviewGate,
	finalizePendingGateDecision,
	type GateDecisionArtifact,
	type GateDecisionDraft,
	materializePendingGateDecision,
	type PendingGateDecisionHandle,
	reviewerInspectionOf,
	stagePendingGateDecision,
	stagePendingGateOutput,
} from "../domains/dispatch/gate-decisions.js";
import { REVIEWER_GATE_PROMPT } from "../domains/dispatch/gate-role-prompts.js";
import { narrowDispatchIntentToReadOnly } from "../domains/dispatch/intent.js";
import { renderDispatchReviewerTask } from "../domains/dispatch/intent-requirements.js";
import type { RunGateProvenance, RunResult } from "../domains/dispatch/types.js";
import { newGateGroupId, PARENT_CANCEL, type RegisteredDispatchToolDeps } from "./dispatch-call.js";
import {
	consumeGateSensitiveDispatchEvents,
	dispatchRoleFacts,
	gateCorrelationOf,
	isPipelineStepFailure,
	judgeIntent,
	normalizedAssistantText,
	pipelineFailureReason,
	subjectRef,
} from "./dispatch-gate-runs.js";
import {
	type CompletedRun,
	completeRun,
	dispatchDetails,
	formatDispatchOutput,
	withNotRetried,
} from "./dispatch-output.js";
import { withResolvedPlanTaskPin } from "./dispatch-plan.js";
import type { DispatchResultForm, DispatchReviewSettings, DispatchToolDeps } from "./dispatch-types.js";
import type { ToolResult, ToolResultDetails } from "./tool-spec.js";
import { runResultPath } from "./worker-evidence.js";
import { builderChangeDiff } from "./worktree-branch-diff.js";

type ReviewGateSettings = DispatchReviewSettings;

/**
 * The reviewer's evidence packet (M10): the builder's handback, its change as the host recorded it (see
 * {@link builderChangeDiff}), and its host checks.
 */
function builderEvidencePacket(deps: DispatchToolDeps, builder: CompletedRun): EvidencePacket {
	const receipt = builder.receipt;
	const attribution = deps.dispatch.observedRunWriteAttribution?.(receipt.runId) ?? null;
	const diff = builderChangeDiff({
		cwd: receipt.cwd,
		worktree: receipt.worktree,
		checkoutChanges: receipt.checkoutChanges,
		recorded: attribution?.complete === true ? attribution.recorded : null,
	});
	return buildEvidencePacket([1], [{ ordinal: 1, receipt, resultPath: runResultPath(receipt), diff }]);
}

export const REVIEW_SINGLE_TASK_MESSAGE =
	"dispatch: review supports exactly one task; run the fan-out without review, then dispatch one integration task with review to gate the combined result";

interface GateRunOutcome {
	runs: CompletedRun[];
	decisions: Array<{ artifact: GateDecisionArtifact; path: string }>;
	verdict: "pass" | "fail" | null;
	cycles: number;
	/** Set when the gate ended without a pass/fail verdict and needs the operator. */
	needsDecision?: string;
}

/**
 * Reviewer-gated dispatch: the builder runs, a read-only reviewer evaluates
 * the workspace against the task, and a revise verdict re-runs the builder
 * with the findings threaded as input data. Bounded by maxCycles; exhaustion
 * (or an unparseable reviewer answer at the last cycle) surfaces as a
 * needs-decision outcome, never a silent failure. Receipts chain backward:
 * each reviewer references the builder it reviewed, each revise builder
 * references the reviewer whose findings it received.
 */
export async function runReviewGated(
	deps: RegisteredDispatchToolDeps,
	base: DispatchRequest,
	review: ReviewGateSettings,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
	gateTelemetry: TelemetryContext | undefined,
): Promise<GateRunOutcome> {
	const group = newGateGroupId("review");
	const runs: CompletedRun[] = [];
	const decisions: Array<{ artifact: GateDecisionArtifact; path: string }> = [];
	const recordDecision = async (
		draft: GateDecisionDraft,
		pending?: PendingGateDecisionHandle,
	): Promise<{ artifact: GateDecisionArtifact; path: string }> => {
		const decision = pending
			? await finalizePendingGateDecision(pending, draft)
			: await materializePendingGateDecision(
					stagePendingGateDecision(draft, { ...(gateTelemetry === undefined ? {} : { telemetry: gateTelemetry }) }),
				);
		decisions.push(decision);
		return decision;
	};
	let expired = false;
	let activeRunId: string | null = null;
	const abortActive = (bySignal: boolean): void => {
		expired = true;
		if (activeRunId !== null) {
			deps.dispatch.abort(
				activeRunId,
				bySignal ? PARENT_CANCEL : { cause: "timeout", detail: `timed out after ${timeoutMs}ms` },
			);
		}
	};
	const onSignalAbort = (): void => abortActive(true);
	const timer = timeoutMs !== undefined ? setTimeout(() => abortActive(false), timeoutMs) : null;
	signal?.addEventListener("abort", onSignalAbort, { once: true });

	const runOne = async (request: DispatchRequest): Promise<CompletedRun> => {
		if (expired || signal?.aborted) {
			throw new Error(
				`review dispatch stopped after ${runs.length} run(s): ${signal?.aborted ? "aborted" : `timed out after ${timeoutMs}ms`}`,
			);
		}
		const handle = await deps.dispatch.dispatch(request);
		activeRunId = handle.runId;
		const summary = await consumeGateSensitiveDispatchEvents(deps, handle.runId, request.agentId, handle.events);
		let pendingGate: PendingGateDecisionHandle | undefined;
		if (request.gate?.role === "reviewer") {
			try {
				pendingGate = stagePendingGateOutput({
					...(gateTelemetry === undefined ? {} : { telemetry: gateTelemetry }),
					group: request.gate.group,
					topology: "review",
					cycle: request.gate.cycle,
					subjects: request.gate.subjects ?? [],
					deciderRunId: summary.terminalAttemptRunId,
					finalOutput: normalizedAssistantText(summary),
					terminalCycle: request.gate.cycle === review.maxCycles,
				});
			} catch (error) {
				try {
					deps.dispatch.abort(handle.runId);
				} catch {
					// The receipt barrier below still observes the admitted process.
				}
				await Promise.allSettled([handle.finalPromise]);
				activeRunId = null;
				throw error;
			}
		}
		let receipt: RunResult;
		try {
			receipt = await handle.finalPromise;
		} finally {
			activeRunId = null;
		}
		const completed = completeRun(deps, receipt, summary, pendingGate);
		runs.push(completed);
		return completed;
	};

	try {
		let findings: { reviewer: CompletedRun; text: string } | null = null;
		for (let cycle = 1; cycle <= review.maxCycles; cycle += 1) {
			const builderGate: RunGateProvenance = {
				role: "builder",
				group,
				cycle,
				...(findings !== null ? { subjects: [subjectRef(findings.reviewer.receipt)], verdict: "revise" } : {}),
			};
			const builderRequest: DispatchRequest = withRunRole(
				{
					...base,
					gate: builderGate,
					...(findings !== null
						? { pipelineInput: { fromRunId: findings.reviewer.receipt.runId, position: cycle, text: findings.text } }
						: {}),
				},
				dispatchRoleFacts(deps),
			);
			const builder = await runOne(
				withResolvedPlanTaskPin(
					builderRequest,
					review.resolvedTasks?.find((task) => task.role === "builder" && task.position === cycle),
				),
			);
			if (isPipelineStepFailure(builder.receipt)) {
				await recordDecision({
					group,
					topology: "review",
					cycle,
					outcome: "exhausted",
					subjects: [subjectRef(builder.receipt)],
					detail: `builder ended ${pipelineFailureReason(builder.receipt)}`,
				});
				return {
					runs,
					decisions,
					verdict: null,
					cycles: cycle,
					needsDecision: `builder run ${builder.receipt.runId} ended ${pipelineFailureReason(builder.receipt)} in cycle ${cycle}`,
				};
			}
			const packet = builderEvidencePacket(deps, builder);
			const reviewerRequest: DispatchRequest = {
				agentId: reviewDeciderAgentId(review.reviewer, (id) => deps.getAgentSpecs().some((spec) => spec.id === id)),
				...(base.budget === undefined ? {} : { budget: base.budget }),
				...(base.record === undefined ? {} : { record: base.record }),
				executionRole: "reviewer",
				task: renderDispatchReviewerTask(base.task, builder.receipt.runId, cycle, base.intent, packet),
				systemPrompt: REVIEWER_GATE_PROMPT,
				readOnly: true,
				// The packet names the builder's run result by its absolute state-dir path, and a request with no intent infers
				// its scope from the task text, which refuses an absolute token (scope_path_absolute). The reviewer takes
				// the read-only builder scope a compete judge takes (M1).
				intent: judgeIntent(
					narrowDispatchIntentToReadOnly(
						base.intent ?? {
							version: 2,
							readRoots: [],
							writeRoots: [],
							relevantPaths: [],
							pathProvenance: [],
							expectedOutputs: [],
							verification: [],
						},
					),
				),
				gate: {
					role: "reviewer",
					group,
					cycle,
					subjects: [subjectRef(builder.receipt)],
					packet: packetProvenance(packet),
				},
				pipelineInput: {
					fromRunId: builder.receipt.runId,
					position: cycle,
					text: normalizedAssistantText(builder.summary),
				},
				...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
				...(review.node !== undefined ? { node: review.node } : {}),
				...(review.model !== undefined ? { model: review.model } : {}),
				...(review.target !== undefined ? { target: review.target } : {}),
				...(base.plan !== undefined ? { plan: base.plan } : {}),
				...(base.parentToolCallId !== undefined ? { parentToolCallId: base.parentToolCallId } : {}),
				...(base.rootRequestOrigin !== undefined ? { rootRequestOrigin: base.rootRequestOrigin } : {}),
				...(base.decisionRefs !== undefined ? { decisionRefs: base.decisionRefs } : {}),
				...(base.reservation !== undefined
					? { reservation: { ownerId: base.reservation.ownerId, memberId: base.reservation.memberId } }
					: {}),
			};
			const reviewer = await runOne(
				withResolvedPlanTaskPin(
					reviewerRequest,
					review.resolvedTasks?.find((task) => task.role === "reviewer" && task.position === cycle),
					{ pinTask: false },
				),
			);
			if (isPipelineStepFailure(reviewer.receipt)) {
				// A verdict citing none of its evidence packet is not a verdict (M10): the gate says why it is exhausted.
				const uncited = reviewerInspectionOf(reviewer.receipt).obligationUnmet
					? (reviewer.receipt.outcomeDetail ?? "obligation cited-evidence unmet")
					: null;
				await recordDecision(
					{
						group,
						topology: "review",
						cycle,
						outcome: "exhausted",
						subjects: [subjectRef(builder.receipt)],
						decider: subjectRef(reviewer.receipt),
						correlation: gateCorrelationOf(builder.receipt, reviewer.receipt),
						detail: uncited ?? `reviewer ended ${pipelineFailureReason(reviewer.receipt)}`,
					},
					reviewer.pendingGate,
				);
				return {
					runs,
					decisions,
					verdict: null,
					cycles: cycle,
					needsDecision:
						uncited !== null
							? `review gate exhausted in cycle ${cycle}: reviewer run ${reviewer.receipt.runId} ${uncited}`
							: `reviewer run ${reviewer.receipt.runId} ended ${pipelineFailureReason(reviewer.receipt)} in cycle ${cycle}`,
				};
			}
			const decided = decideReviewGate({
				group,
				cycle,
				terminalCycle: cycle === review.maxCycles,
				subjects: [subjectRef(builder.receipt)],
				decider: subjectRef(reviewer.receipt),
				correlation: gateCorrelationOf(builder.receipt, reviewer.receipt),
				output: normalizedAssistantText(reviewer.summary),
				reviewer: reviewerInspectionOf(reviewer.receipt),
			});
			await recordDecision(decided.draft, reviewer.pendingGate);
			if (decided.findings === null) {
				return {
					runs,
					decisions,
					verdict: decided.verdict,
					cycles: cycle,
					...(decided.needsDecision !== null ? { needsDecision: decided.needsDecision } : {}),
				};
			}
			findings = { reviewer, text: decided.findings };
		}
		throw new Error("review gate exhausted without terminal decision evidence");
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
	}
}

export async function reviewGateResult(
	deps: DispatchToolDeps,
	gated: GateRunOutcome,
	maxOutputBytes: number,
	form: DispatchResultForm,
): Promise<ToolResult> {
	const outcome = { ...gated, runs: await withNotRetried(deps, gated.runs) };
	const body = formatDispatchOutput(
		"review",
		outcome.runs,
		maxOutputBytes,
		null,
		form,
		deps.dispatch.agentTraits?.bind(deps.dispatch),
	);
	const details: ToolResultDetails = {
		...dispatchDetails(deps, "review", outcome.runs),
		gate: {
			verdict: outcome.verdict,
			cycles: outcome.cycles,
			decisions: outcome.decisions.map(({ artifact, path }) => ({
				id: artifact.id,
				outcome: artifact.outcome,
				path,
				digest: artifact.integrity.digest,
			})),
			...(outcome.needsDecision !== undefined ? { needsDecision: outcome.needsDecision } : {}),
		},
	};
	if (outcome.verdict === "pass") {
		return { kind: "ok", output: `review gate passed after ${outcome.cycles} cycle(s)\n\n${body}`, details };
	}
	if (outcome.verdict === "fail") {
		return { kind: "error", message: `dispatch: review gate failed (reviewer verdict fail)\n\n${body}`, details };
	}
	return {
		kind: "error",
		message: `dispatch: review gate needs an operator decision: ${outcome.needsDecision ?? "no verdict"}\n\n${body}`,
		details,
	};
}
