// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Run finish helpers shared by native and ACP dispatch: the published lineage, the terminal bus event,
 * the finish-contract verdict and its audit, and the task worktree receipt (unapplied snapshot, applied
 * cleanup and merge notice). Lifted from createDispatchBundle; the bundle passes its context and safety.
 */
import type { DomainContext } from "../../core/domain-loader.js";
import type { DispatchCompletedPayload } from "../../core/telemetry/live-events.js";
import { rawDurationMs } from "../../core/timers.js";
import { cleanupAccountedTaskWorktree, snapshotTaskWorktree } from "../../tools/task-worktree.js";
import { receiptWithDrift, type TaskWorktreePreview } from "../../tools/task-worktree-preview.js";
import type { AgentAudience } from "../agents/spec.js";
import type { SafetyContract } from "../safety/contract.js";
import type { FinishContractAssessment } from "../safety/finish-contract.js";
import { assessFinishContract } from "../safety/finish-contract.js";
import type { Rigor } from "../safety/rigor.js";
import { parseRigorOverride, resolveRigor } from "../safety/rigor.js";
import type { DispatchPreparationOptions, DispatchRequest } from "./contract.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import type { DispatchRequestOrigin, RunKind, RunLineage, RunOutcome, RunResult, RunResultDraft } from "./types.js";
import { workerMergedNotice } from "./workspace-mutation.js";

export interface DispatchFinishContractSnapshot {
	assessment: FinishContractAssessment;
	rigor: Rigor;
}

/** The run a finalizer settles, as its terminal events and target outcome name it. Only a native run has an audience. */
export interface FinalizingRun {
	runId: string;
	req: DispatchRequest;
	agentAudience?: AgentAudience;
	requestOrigin: DispatchRequestOrigin;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
	lineage: RunLineage;
	hostRun: DispatchPreparationOptions["hostRun"] | undefined;
}

export interface RunFinishScope {
	context: DomainContext;
	safety: SafetyContract;
}

export function publishedLineage(lineage: RunLineage, hostRun: DispatchPreparationOptions["hostRun"]): RunLineage {
	if (hostRun === undefined) return { ...lineage };
	return {
		parentRunId: lineage.attempt === 0 ? hostRun.runId : lineage.parentRunId,
		rootRunId: hostRun.lineage.rootRunId,
		depth: hostRun.lineage.depth + 1,
		attempt: lineage.attempt,
	};
}

/** Publishes a sealed run's terminal event: run.completed on success, run.failed with the outcome otherwise. */
export function emitTerminalDispatchEvent(
	{ context }: Pick<RunFinishScope, "context">,
	run: FinalizingRun,
	receipt: RunResult,
	outcome: RunOutcome,
): void {
	const startMs = Date.parse(receipt.startedAt);
	const endMs = Date.parse(receipt.endedAt);
	const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, rawDurationMs(startMs, endMs)) : 0;
	const payload: DispatchCompletedPayload = {
		runId: run.runId,
		agentId: run.req.agentId,
		task: run.req.task,
		...(run.agentAudience !== undefined ? { agentAudience: run.agentAudience } : {}),
		requestOrigin: run.requestOrigin,
		targetId: run.targetId,
		wireModelId: run.wireModelId,
		runtimeId: run.runtimeId,
		runtimeKind: run.runtimeKind,
		outcome,
		outcomeCode: receipt.outcomeCode ?? null,
		outcomeDetail: receipt.outcomeDetail ?? null,
		lineage: publishedLineage(run.lineage, run.hostRun),
		sessionId: receipt.sessionId,
		spend: receipt.spend,
		durationMs,
		exitCode: receipt.exitCode,
		toolActivity: receipt.toolActivity ?? null,
		...(receipt.hostVerification !== undefined ? { hostVerification: receipt.hostVerification.status } : {}),
		...(receipt.skillActivations && receipt.skillActivations.length > 0
			? { skillActivations: [...receipt.skillActivations] }
			: {}),
		...(receipt.safety?.flowRestrictions !== undefined ? { flowRestrictions: receipt.safety.flowRestrictions } : {}),
	};
	if (outcome === "succeeded") {
		context.bus.emit("run.completed", payload);
		return;
	}
	context.bus.emit("run.failed", { ...payload, reason: outcome });
}

/** Judges the worker's last turn against the finish contract and audits the verdict; null when it said nothing. */
export function assessDispatchFinishContract(
	{ safety }: Pick<RunFinishScope, "safety">,
	input: {
		req: DispatchRequest;
		runId: string;
		cwd: string;
		entries: unknown[];
		assistantText: string;
		assistantTurnId: string | null;
	},
): DispatchFinishContractSnapshot | null {
	if (input.assistantText.trim().length === 0) return null;
	const rigor = resolveRigor({ cwd: input.cwd, override: parseRigorOverride(process.env.PANCODE_RIGOR) });
	const assessment = assessFinishContract({
		sessionEntries: input.entries,
		assistantTurnId: input.assistantTurnId,
		workspaceRoot: input.cwd,
		rigor,
	});
	try {
		safety.decisions.recordCompletionContract?.({
			...(input.req.ownerSessionId ? { sessionId: input.req.ownerSessionId } : {}),
			runId: input.runId,
			turnId: input.assistantTurnId,
			decision: assessment.kind,
			reason: assessment.reason,
			rigor,
			mutatedPaths: assessment.mutatedPaths,
			evidenceKinds: Array.from(new Set(assessment.evidence.map((item) => item.kind))),
			...(assessment.quality ? { quality: assessment.quality } : {}),
			...(assessment.verificationScope ? { verificationScope: assessment.verificationScope } : {}),
		});
	} catch {
		// Audit must not destabilize dispatch finalization.
	}
	return { assessment, rigor };
}

/** The receipt of a task worktree no apply pass settled; a snapshot that fails still names the branch. */
export function snapshotUnappliedTaskWorktree(
	worktree: NonNullable<DispatchRequest["taskWorktree"]>,
	apply: NonNullable<DispatchRequest["apply"]>,
): NonNullable<RunResultDraft["worktree"]> {
	try {
		return snapshotTaskWorktree(worktree, apply);
	} catch (snapshotError) {
		reportDispatchDiagnostic(`snapshot failed task worktree ${worktree.runId}`, snapshotError);
		return {
			path: worktree.path,
			branch: worktree.branch,
			diffHash: null,
			snapshot: "unavailable",
			apply,
			applied: false,
		};
	}
}

/**
 * Finishes an applied worktree's cleanup before its preservation paths are sealed, puts the worktree on the
 * receipt draft, and tells the operator's transcript that a merge landed. Returns the worktree as sealed.
 */
export function sealTaskWorktreeReceipt(
	{ context }: Pick<RunFinishScope, "context">,
	req: DispatchRequest,
	runId: string,
	worktree: RunResultDraft["worktree"],
	accounted: TaskWorktreePreview | undefined,
	receiptDraft: RunResultDraft,
): RunResultDraft["worktree"] {
	let sealed = worktree;
	if (sealed?.applied === true && req.taskWorktree !== undefined) {
		try {
			// The merge is durable; finish cleanup before sealing its preservation paths.
			const kept = cleanupAccountedTaskWorktree(req.taskWorktree, accounted);
			if (kept !== null) sealed = receiptWithDrift(sealed, req.taskWorktree, kept);
		} catch (cleanupError) {
			reportDispatchDiagnostic(`clean applied task worktree ${req.taskWorktree.runId}`, cleanupError);
		}
	}
	// The checkout and base the worktree was cut from, so a reviewer's packet can diff the task commit after cleanup.
	if (sealed !== undefined && req.taskWorktree !== undefined)
		sealed = { ...sealed, root: req.taskWorktree.root, base: req.taskWorktree.base };
	if (sealed !== undefined) receiptDraft.worktree = sealed;
	// A merge needs no card at default autonomy, so the operator's transcript says it landed.
	const mergedNotice = workerMergedNotice(req.agentId, req.taskWorktree?.runId ?? runId, sealed);
	if (mergedNotice !== null) context.bus.emit("run.scope_notice_raised", mergedNotice);
	return sealed;
}
