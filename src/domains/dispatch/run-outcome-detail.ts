// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The detail a settled run carries about why it ended: which trusted outcome codes it keeps, whether an idle builder
 * produced anything durable, and the bounded worker-diagnostic and route-warning text merged into its outcome.
 */
import type { RunOutcomeCode, RunResultOutput } from "./types.js";
import type { SpawnedWorkerResult } from "./worker-spawn.js";

const OUTCOME_CODE_SPECIFICITY: ReadonlyArray<RunOutcomeCode> = [
	// The same restricted context meets the same target on every attempt.
	"information_flow_blocked",
	// The wall clock moved the run to handback; whatever it hit after that, it seals timed_out (fleet M8).
	"worker_run_timeout",
	"worker_context_exhausted",
	"worker_turn_timeout",
	"worker_output_cap_exhausted",
	"result_contract_exhausted",
	"loop_guard_tools_disabled_exhausted",
	"exploration_stalled",
	"worker_tool_call_cap_exhausted",
	"vram_capacity_fit_failure",
	"obligation_unmet",
	"worker_final_output_missing",
];

/** A builder that changed nothing and either left its obligation unmet or declared it unfinished keeps an idle tree. */
export function idleBuilderOutcome(code: RunOutcomeCode | null): boolean {
	return code === "obligation_unmet" || code === "worker_not_done";
}

export function hasDurableFinalOutput(output: RunResultOutput | undefined): boolean {
	return output?.state === "final" && output.text.trim().length > 0;
}

/**
 * Loop-degeneration family: any combination of these codes can accumulate on
 * one legitimately degenerating run. Observed live (run 2l89ughlrj4w): a
 * scout exhausts its corrective rounds (which emits its code without
 * aborting), then calls a tool again, so the loop-guard backstop emits its
 * code and aborts. The generic cap can likewise precede either sibling.
 */
const LOOP_DEGENERATION_CODES: ReadonlySet<RunOutcomeCode> = new Set([
	"result_contract_exhausted",
	"loop_guard_tools_disabled_exhausted",
	"exploration_stalled",
	"worker_tool_call_cap_exhausted",
]);

/**
 * Resolve trusted worker classifications independently of event order.
 * Multi-code combinations inside the loop-degeneration family are a
 * legitimate progression resolved by specificity. Combinations that cross
 * failure families are contradictory and are surfaced to diagnostics while
 * still choosing deterministically.
 */
export function resolveTrustedOutcomeCodes(codes: ReadonlySet<RunOutcomeCode>): {
	code: RunOutcomeCode | null;
	conflict: string | null;
} {
	const code = OUTCOME_CODE_SPECIFICITY.find((candidate) => codes.has(candidate)) ?? null;
	if (codes.size <= 1) return { code, conflict: null };
	if ([...codes].every((candidate) => LOOP_DEGENERATION_CODES.has(candidate))) return { code, conflict: null };
	// A run the wall clock moved to handback that then ends without an answer is one story, told at settle (fleet M8).
	if (code === "worker_run_timeout" && codes.size === 2 && codes.has("worker_final_output_missing"))
		return { code, conflict: null };
	return {
		code,
		conflict: `conflicting trusted outcome codes: ${[...codes].sort().join(", ")}`,
	};
}

const MAX_WORKER_DIAGNOSTIC_DETAIL_CHARS = 2048;

/** Bound on the adapter's failure words an ACP run's outcome detail carries (C-16). */
export const MAX_ACP_FAILURE_DETAIL_BYTES = 1024;

export const MAX_WORKER_OUTCOME_DETAIL_BYTES = 1024;

const MAX_WORKER_DIAGNOSTIC_FAILURE_CHARS = 4096;

export function compactDiagnosticText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateDiagnosticText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `...${value.slice(value.length - maxChars + 3)}`;
}

export function malformedWorkerStdoutLineCount(result: SpawnedWorkerResult): number {
	return typeof result.malformedStdoutLines === "number" && Number.isFinite(result.malformedStdoutLines)
		? Math.max(0, Math.floor(result.malformedStdoutLines))
		: 0;
}

function workerDiagnosticsText(result: SpawnedWorkerResult, maxChars: number, said = ""): string | null {
	const parts: string[] = [];
	const stderr = typeof result.stderrTail === "string" ? compactDiagnosticText(result.stderrTail) : "";
	// A worker that printed its failure words to stderr already said them in the detail; they are not repeated (fleet finding 6).
	const echoed = stderr.replace(/^\[worker\]\s*/u, "");
	if (stderr.length > 0 && !(echoed.length > 0 && compactDiagnosticText(said).includes(echoed))) {
		parts.push(`stderr: ${truncateDiagnosticText(stderr, maxChars)}`);
	}
	const malformedStdoutLines = malformedWorkerStdoutLineCount(result);
	if (malformedStdoutLines > 0) {
		parts.push(`malformed stdout lines: ${malformedStdoutLines}`);
	}
	if (result.signal) {
		// Keep the observed close signal beside contract failures, and at the
		// tail so bounded stderr diagnostics cannot truncate it away.
		parts.push(`worker process signal: ${result.signal}`);
	}
	if (parts.length === 0) return null;
	return truncateDiagnosticText(parts.join("; "), maxChars);
}

export function mergeWorkerDiagnosticDetail(
	base: string | null,
	result: SpawnedWorkerResult,
	include: boolean,
): string | null {
	if (!include) return base;
	const diagnostics = workerDiagnosticsText(result, MAX_WORKER_DIAGNOSTIC_DETAIL_CHARS, base ?? "");
	if (diagnostics === null) return base;
	return base !== null && base.length > 0 ? `${base}; ${diagnostics}` : diagnostics;
}

export function mergeWorkerDiagnosticFailure(
	base: string | undefined,
	result: SpawnedWorkerResult,
	include: boolean,
): string | undefined {
	if (!include) return base;
	const diagnostics = workerDiagnosticsText(result, MAX_WORKER_DIAGNOSTIC_FAILURE_CHARS, base ?? "");
	if (diagnostics === null) return base;
	return base !== undefined && base.length > 0 ? `${base}; ${diagnostics}` : diagnostics;
}

export function mergeRouteWarningDetail(routeWarning: string | undefined, base: string | null): string | null {
	if (!routeWarning) return base;
	return base !== null && base.length > 0 ? `${routeWarning}; ${base}` : routeWarning;
}
