// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { sanitizeCallTargetText } from "../safety/call-target.js";
import { CODE_STEP_EXCERPT_MAX_BYTES } from "./code-step.js";
import type { ReviewGateDecision } from "./gate-decisions.js";

export function gateBaselineFailure(passed: boolean): "gate_not_discriminating" | null {
	return passed ? "gate_not_discriminating" : null;
}

export function gateFailureLines(output: string): string {
	const lines = output
		.split("\n")
		.filter((line) => line.startsWith("FAIL"))
		.join("\n");
	if (Buffer.byteLength(lines, "utf8") <= CODE_STEP_EXCERPT_MAX_BYTES) return lines;
	return Buffer.from(lines, "utf8").subarray(0, CODE_STEP_EXCERPT_MAX_BYTES).toString("utf8");
}

/**
 * A loop cycle's gate line, then each check the reviewer failed in its own words, so a `revise` or `fail` says why
 * where it is announced instead of only in `fleet view` (R2-F17). The reviewer's text is model output, so it is
 * neutralized to one line.
 */
export function loopGateNotice(
	loopId: string,
	cycle: number,
	decided: Pick<ReviewGateDecision, "draft" | "failedChecks">,
	decisionPath: string,
): string {
	const detail = decided.draft.detail === undefined ? "" : ` (${decided.draft.detail})`;
	return [
		`loop ${loopId} cycle ${cycle}: ${decided.draft.outcome}${detail} decision=${decisionPath}`,
		...decided.failedChecks.map(
			(check) => `  failed check ${sanitizeCallTargetText(check.name)}: ${sanitizeCallTargetText(check.evidence)}`,
		),
	].join("\n");
}
