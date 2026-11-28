// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The bounds of a native worker run: the handback a share or the wall clock triggers, the
 * refusals whose reason is a run bound, and the host timers that lock tools at the synthesis
 * deadline and move the run to handback near its wall clock.
 */

import { isWorkerToolCallCapExceededReason, isWorkerToolCallCapSynthesisReason } from "../../core/guardrails.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import { WALL_HANDBACK_SHARE } from "../../domains/dispatch/handback.js";
import { isLoopGuardSynthesisBackstopReason } from "../loop-guard-reasons.js";
import type { HandbackTrigger } from "../run-phase.js";
import type { WorkerRunScope } from "./scope.js";

export function createWorkerBounds(scope: WorkerRunScope) {
	const { input, emit, phase, workerBudget, deliveryTools } = scope;
	/** The run's next round is its handback round; the bound that triggered it is journaled as its kind (M3). */
	const enterHandback = (bound: HandbackTrigger): void => {
		phase.lockTools(bound);
		process.stderr.write(
			`[worker] handback: ${bound} reached the ${input.role ?? "run"}'s share; the next round reports\n`,
		);
		if (input.telemetryContext)
			telemetryHub().emit(
				"middleware.fired",
				{
					hook: "turn_start",
					phase: "sync",
					ruleId: "worker.handback",
					effects: ["lock_tools"],
					severity: "info",
					evidence: `bound:${bound}@worker`,
				},
				input.telemetryContext,
			);
	};
	/**
	 * A refusal whose reason is a run bound. Direct calls reach this through
	 * their blocked finish; a chain child the bound refused reaches it through
	 * the chain's receipt, because the aggregate settles as an ordinary error
	 * and its own finish cannot carry the child's verdict.
	 */
	const observeBoundReason = (reason: string): void => {
		// Lifetime-cap lockout ends tool use before the final report. Writers
		// retain the exhausted outcome; reporting workers can seal their synthesis.
		if (isWorkerToolCallCapSynthesisReason(reason)) {
			if (workerBudget.synthesis && deliveryTools.length === 0) {
				// DF-10: a reporting recipe's cap ends tool use; its sealed synthesis is the product.
				phase.lockTools("tools");
				process.stderr.write(`[worker] ${reason}\n`);
				return;
			}
			emit({ type: "pancode_run_outcome", payload: { outcomeCode: "worker_tool_call_cap_exhausted" } });
			if (phase.sealedBy === null) {
				phase.seal(reason);
				process.stderr.write(`[worker] ${reason}\n`);
			}
			return;
		}
		// Hard bounds: the immediate cap abort (lockout not wired) and
		// the synthesis backstop for a model that keeps emitting tool calls
		// after the lock. Both end the run; the first recorded bound wins the
		// receipt diagnostic.
		if (isWorkerToolCallCapExceededReason(reason) || isLoopGuardSynthesisBackstopReason(reason)) {
			emit({
				type: "pancode_run_outcome",
				payload: {
					outcomeCode: isLoopGuardSynthesisBackstopReason(reason)
						? "loop_guard_tools_disabled_exhausted"
						: "worker_tool_call_cap_exhausted",
				},
			});
			if (scope.workerBoundAborted) return;
			scope.workerBoundAborted = true;
			phase.seal(reason);
			process.stderr.write(`[worker] ${reason}\n`);
			scope.abortWorkerForBound?.();
		}
	};

	const startTimers = () => {
		// Qwopus 3.8 explored context init's whole 240 s ceiling one read at a time and was
		// aborted before submitting. A host deadline ends exploration while the terminal round fits.
		const synthesisTimer =
			input.synthesisAt === undefined
				? undefined
				: setTimeout(
						() => {
							phase.lockTools("synthesis");
						},
						Math.max(0, input.synthesisAt - Date.now()),
					);
		synthesisTimer?.unref();
		// DESIGN 4.5: at 85% of the wall clock the next round is the handback round, and the host stops the run at the
		// wall. A run the wall clock moved to handback seals timed_out with what it reports (fleet M8).
		const wallLimits = input.limits?.time;
		const wallTimer =
			wallLimits === undefined
				? undefined
				: setTimeout(
						() => {
							if (phase.sealedBy !== null) return;
							enterHandback("time");
							emit({
								type: "pancode_run_outcome",
								payload: {
									outcomeCode: "worker_run_timeout",
									detail: `worker_run_timeout: the run reached ${Math.round(WALL_HANDBACK_SHARE * 100)}% of its ${Math.round(wallLimits.wallMs / 1000)} s wall clock; its tools are withdrawn and its next round is its report`,
								},
							});
						},
						Math.max(0, wallLimits.handbackAt - Date.now()),
					);
		wallTimer?.unref();
		return { synthesisTimer, wallTimer };
	};

	return { enterHandback, observeBoundReason, startTimers };
}
