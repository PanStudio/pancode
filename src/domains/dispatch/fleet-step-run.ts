// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { EventPayload } from "../../core/telemetry/events.js";
import { freeClaim, type PricingSum, sumFacts, sumRunSpend } from "../../core/telemetry/pricing.js";
import { pancodeStateDir } from "../../core/xdg.js";
import { readVerifiedRun } from "../telemetry/run-record.js";
import type { CodeStepRecord } from "./code-step.js";
import type { ExecutionPlan } from "./execution-plan.js";
import { gateRouteCorrelation } from "./execution-role.js";
import { type GateDecisionCorrelation, type ReviewerInspection, reviewerInspectionOf } from "./gate-decisions.js";
import { type DispatchIntent, declaredScopeIntent } from "./intent.js";
import type { RunResult } from "./types.js";

/** Sealed independence facts between the work under review and its reviewer. */
/**
 * What later steps read of a finished agent step: its identity, route, changed paths and spend. A step that ran in
 * this process carries its result; a replayed one is read back from its sealed run scope, cited by the step's digest.
 */
export interface StepRun {
	runId: string;
	digest: string;
	agentId: string;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	nodeId: string;
	changedPaths: ReadonlyArray<string>;
	pricing: PricingSum;
	inspection: ReviewerInspection;
}

export function stepRunOf(result: RunResult): StepRun {
	return {
		runId: result.runId,
		digest: result.digest,
		agentId: result.agentId,
		targetId: result.targetId,
		wireModelId: result.wireModelId,
		runtimeId: result.runtimeId,
		nodeId: result.node?.id ?? "local",
		changedPaths: [...(result.worktree?.changedPaths ?? []), ...(result.checkoutChanges?.changedPaths ?? [])],
		pricing: sumRunSpend([result]),
		inspection: reviewerInspectionOf(result),
	};
}

/** A replayed step's run from its sealed scope; null when it never settled under the digest the fleet recorded. */
export function replayedStepRun(runId: string, digest: string): StepRun | null {
	const record = readVerifiedRun(pancodeStateDir(), runId, digest);
	if (record === null) return null;
	const settled = record.settled;
	const delivered = record.result?.state === "resolved" ? record.result.value : null;
	// The run's folded spend keeps a measured subtotal its settled fact collapses to unknown once any call is (#434).
	const usd = record.row.usd.fact;
	return {
		runId,
		digest: settled.digest,
		agentId: settled.agentId,
		targetId: settled.route.targetId,
		wireModelId: settled.route.wireModelId,
		runtimeId: settled.route.runtimeId,
		nodeId: settled.node?.id ?? "local",
		changedPaths: [...(delivered?.worktree?.changedPaths ?? []), ...(delivered?.checkoutChanges?.changedPaths ?? [])],
		pricing: {
			usd: "unknownCount" in usd ? usd : sumFacts([usd]),
			...freeClaim(settled.pricing.pricedBy === "free", settled.pricing.freeRule),
		},
		inspection: reviewerInspectionOf({ outcomeCode: settled.outcomeCode, verdict: settled.verdict ?? null }),
	};
}

export function fleetGateCorrelation(subject: StepRun, decider: StepRun): GateDecisionCorrelation {
	const facts = (run: StepRun) => ({
		agentId: run.agentId,
		targetId: run.targetId,
		wireModelId: run.wireModelId,
		runtimeId: run.runtimeId,
		nodeId: run.nodeId,
	});
	const { agent, target, modelFamily, runtime, node, independent } = gateRouteCorrelation(
		facts(subject),
		facts(decider),
	);
	return { agent, target, modelFamily, runtime, node, independent };
}

/**
 * Typed scope for one fleet step, drawn from the boundary its playbook already
 * declared. Returns null when the playbook declared nothing for this position,
 * which is every step of a playbook below version 4 and every readonly step: those keep
 * the prose inference path rather than being handed an empty declaration that
 * would silently switch off path-scoped rule selection for them.
 *
 * A playbook whose declared paths do not survive the boundary grammar is a
 * compile-time authoring bug, not a dispatch-time one, so a malformed entry
 * falls back to inference here rather than aborting a run mid-wave; the
 * playbook loader is the surface that refuses it.
 */
export function fleetStepIntent(writes: ReadonlyArray<string> | undefined): DispatchIntent | null {
	if (writes === undefined || writes.length === 0) return null;
	const built = declaredScopeIntent({ relevantPaths: writes });
	return built.ok ? built.intent : null;
}

/**
 * A code step's record as `code_step.settled` carries it: every command it ran, the primary one included, by exit
 * code and duration. Argv, cwd and output stay out of the journal (#434); code-step-commands.ts keeps the argv.
 */
export function codeStepSettledFacts(record: CodeStepRecord): EventPayload<"code_step.settled"> {
	return {
		runId: record.runId,
		stepId: record.stepId,
		commandId: record.commandId,
		startedAt: record.startedAt,
		durationMs: record.durationMs,
		timeoutMs: record.timeoutMs,
		exitCode: record.exitCode,
		signal: record.signal,
		timedOut: record.timedOut,
		commands: (record.commandRuns ?? [record]).map((run) => ({ exitCode: run.exitCode, durationMs: run.durationMs })),
		outputBytes: record.outputBytes,
		outputTruncated: record.outputTruncated,
		outputDigest: record.outputDigest,
		reportDigest: record.reportDigest,
		...(record.confinement !== undefined ? { confinement: record.confinement } : {}),
	};
}

export function fleetPlanWaveIndex(plan: ExecutionPlan, stepId: string): number {
	return plan.waves.findIndex((wave) => wave.includes(stepId));
}
