// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The fleet result document (6.13) one fleet root persists at seal, whichever surface ran it: `pancode fleet run`, the
 * TUI's `/fleet run`, an ACP session, or the main agent's `dispatch(playbook=...)`. `fleet wait` and `monitor` read it.
 */

import { factKnownValue, usdAmountOrFact } from "../../core/telemetry/known.js";
import { renderCountSum, renderCountSumKnown, renderPricingSum } from "../../core/telemetry/render.js";
import type { FleetRunOutcome, FleetRunStepOutcome } from "./fleet-run-types.js";
import type { FleetKeptWorktree } from "./fleet-task-worktree.js";

export type FleetEndStepOutcome = "succeeded" | "failed" | "replayed";

export interface FleetEndStep {
	stepId: string;
	runId: string | null;
	outcome: FleetEndStepOutcome;
}

/** One fact about how the fleet ended, in the run envelope's cause shape. */
export type FleetEndCause = { readonly code: string; readonly message?: string } & Readonly<Record<string, unknown>>;

export interface FleetEndLimits {
	maxCostUsd: number | null;
	maxCostSource: "flag" | "playbook" | null;
	/** Only an enforced cap stops a running fleet; a playbook budgetUsd alone is a preflight check. */
	enforced: boolean;
	/** A step already in flight finishes its spend before the stop lands. */
	overshootPossible: boolean;
	timeoutMs: number | null;
}

/** What one fleet run learned on its way to its end. */
export interface FleetEndFacts {
	rootId: string | null;
	playbook: string;
	planHash: string | null;
	started: boolean;
	/** The run threw before it dispatched any step (a drained admission gate, a denied reservation), so nothing ran. */
	refusedBeforeStep: boolean;
	steps: ReadonlyArray<FleetEndStep>;
	stopCause: string | null;
	cleanRun: boolean | null;
	/** Steps the plan stopped before, so a mid-plan failure never reads as a plan that ran to its end. */
	notRunStepIds: ReadonlyArray<string>;
	totalCost: FleetRunOutcome["totalCost"] | null;
	totalUsage: FleetRunOutcome["totalUsage"] | null;
	/** The task worktree a `worktree` run kept for `fleet land`, with its work committed on the task branch. */
	worktree: FleetKeptWorktree | null;
	limits: FleetEndLimits;
}

/** One settled step's row: replayed steps name the run they replay, the rest the run (or code step) that settled them. */
export function fleetEndStep(step: FleetRunStepOutcome): FleetEndStep {
	if (step.replayed === true) {
		return { stepId: step.stepId, runId: step.result?.terminalRunId ?? null, outcome: "replayed" };
	}
	return {
		stepId: step.stepId,
		runId: step.codeStep?.runId ?? step.terminalRunId ?? null,
		outcome: step.succeeded ? "succeeded" : "failed",
	};
}

/** Why a failed step failed: the coordinator's reason, the run's own failure, or the code step's exit. */
export function fleetStepFailureReason(step: FleetRunStepOutcome): string | null {
	if (step.failureReason !== undefined) return step.failureReason;
	if (step.run !== undefined) return step.run.failureMessage ?? step.run.outcomeDetail ?? `run ${step.run.outcome}`;
	const code = step.codeStep;
	if (code !== undefined) {
		if (code.timedOut) return "the command timed out";
		return code.signal !== null ? `the command ended on ${code.signal}` : `the command exited ${code.exitCode}`;
	}
	return null;
}

/** The run_failed cause's message: each failed step with its reason, then the steps the plan stopped before. */
export function fleetRunFailedMessage(
	failures: ReadonlyArray<{ stepId: string; reason: string | null }>,
	notRunStepIds: ReadonlyArray<string>,
): string | null {
	const failed = failures.map(({ stepId, reason }) => `step ${stepId} failed${reason !== null ? `: ${reason}` : ""}`);
	if (notRunStepIds.length > 0) failed.push(`not run: ${notRunStepIds.join(", ")}`);
	return failed.length > 0 ? failed.join("; ") : null;
}

/** The fleet's tokens over its calls, naming once the calls whose tokens went unreported. */
function usageDisplay(usage: FleetRunOutcome["totalUsage"]): string {
	const gap = usage.total.unknownCount;
	const tokens = `${renderCountSumKnown(usage.total)} tokens over ${renderCountSum(usage.apiCalls)} calls`;
	return gap > 0 ? `${tokens}; ${gap} ${gap === 1 ? "call" : "calls"} unknown` : tokens;
}

export function fleetEndDocument(
	facts: FleetEndFacts,
	exitCode: number,
	causes: ReadonlyArray<FleetEndCause>,
): Record<string, unknown> {
	const completionState =
		!facts.started || facts.refusedBeforeStep
			? "refused"
			: facts.stopCause !== null ||
					causes.some((cause) => cause.code === "interrupted") ||
					(facts.cleanRun === false && facts.notRunStepIds.length > 0)
				? "stopped"
				: "completed";
	const stopReason =
		completionState !== "stopped"
			? null
			: (facts.stopCause ?? (causes.some((cause) => cause.code === "interrupted") ? "signal" : "step_failed"));
	const succeeded = facts.steps.filter((step) => step.outcome !== "failed").length;
	const aggregate = facts.cleanRun === true && exitCode === 0 ? "pass" : succeeded === 0 ? "fail" : "partial";
	return {
		type: "fleet_end",
		schemaVersion: 1,
		rootId: facts.rootId,
		playbook: facts.playbook,
		planHash: facts.planHash,
		exitCode,
		completion: { state: completionState, stopReason },
		verdict: { aggregate, steps: facts.steps },
		// The step counts, and the settled runs' calls and tokens as sums the coordinator folded (never summed here).
		usage: {
			steps: facts.steps.length,
			succeededSteps: succeeded,
			...(facts.totalUsage !== null
				? {
						apiCalls: facts.totalUsage.apiCalls,
						tokens: {
							input: facts.totalUsage.input,
							cacheRead: facts.totalUsage.cacheRead,
							cacheWrite: facts.totalUsage.cacheWrite,
							output: facts.totalUsage.output,
							total: facts.totalUsage.total,
						},
						display: usageDisplay(facts.totalUsage),
					}
				: {}),
		},
		cost:
			facts.totalCost === null
				? null
				: {
						// An unpriced total is null, never a measured 0 (row 362); the schema has always allowed it.
						usd: typeof usdAmountOrFact(facts.totalCost.usd) === "number" ? factKnownValue(facts.totalCost.usd) : null,
						measuredUsd: facts.totalCost.usd.measured,
						estimatedUsd: facts.totalCost.usd.estimated,
						unknownCount: facts.totalCost.usd.unknownCount,
						display: renderPricingSum(facts.totalCost),
					},
		causes,
		limits: facts.limits,
		...(facts.worktree !== null ? { worktree: facts.worktree } : {}),
	};
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: null;
}

function textOf(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** The run each step settled as, in verdict order; a step that never ran names none. */
export function fleetEndStepRuns(
	document: Readonly<Record<string, unknown>>,
): Array<{ readonly stepId: string; readonly runId: string }> {
	const steps = recordOf(document.verdict)?.steps;
	if (!Array.isArray(steps)) return [];
	return steps.flatMap((value) => {
		const step = recordOf(value);
		const runId = textOf(step?.runId);
		return step !== null && runId !== null ? [{ stepId: String(step.stepId), runId }] : [];
	});
}

/**
 * A persisted fleet_end document as the lines a model or operator reads: how it ended, each step's verdict and run,
 * the causes, the kept worktree and the cost. Read back from disk, so every field is checked rather than trusted.
 */
export function fleetEndLines(document: Readonly<Record<string, unknown>>): string[] {
	const completion = recordOf(document.completion);
	const verdict = recordOf(document.verdict);
	const stopReason = textOf(completion?.stopReason);
	const lines = [
		`fleet ${String(document.playbook)} root=${String(document.rootId)}: ${String(completion?.state ?? "unknown")}${stopReason !== null ? ` (${stopReason})` : ""} verdict=${String(verdict?.aggregate ?? "none")} exit=${String(document.exitCode)}`,
	];
	const steps = Array.isArray(verdict?.steps) ? verdict.steps.map(recordOf).filter((step) => step !== null) : [];
	if (steps.length > 0) {
		const succeeded = steps.filter((step) => step.outcome !== "failed").length;
		lines.push(`steps (${succeeded} of ${steps.length} succeeded):`);
		for (const step of steps) {
			const runId = textOf(step.runId);
			lines.push(`- ${String(step.stepId)} ${String(step.outcome)}${runId !== null ? ` run=${runId}` : ""}`);
		}
	}
	const causes = Array.isArray(document.causes) ? document.causes.map(recordOf).filter((cause) => cause !== null) : [];
	for (const cause of causes) {
		const message = textOf(cause.message);
		lines.push(`cause ${String(cause.code)}${message !== null ? `: ${message}` : ""}`);
	}
	const worktree = recordOf(document.worktree);
	if (worktree !== null) {
		lines.push(
			`worktree kept: ${String(worktree.path)} on ${String(worktree.branch)}; preview: ${String(worktree.preview)}; land: ${String(worktree.land)}`,
		);
	}
	const cost = recordOf(document.cost);
	lines.push(`cost: ${textOf(cost?.display) ?? "unknown"}`);
	const usage = textOf(recordOf(document.usage)?.display);
	if (usage !== null) lines.push(`usage: ${usage}`);
	return lines;
}
