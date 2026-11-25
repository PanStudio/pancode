// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { parseJsonObjectPayload } from "../../core/json-payload.js";
import {
	failure,
	hasOnlyKeys,
	parseJson,
	string,
	success,
	unexpectedResultKeyReason,
} from "./result-contract-payload.js";
import type { ResultContract, ResultContractValidation } from "./result-contract-types.js";

/**
 * Parsed `code-report` payload. `passed` restates `exitCode === 0` so a
 * downstream reader never has to know a runner's exit conventions, and
 * `outputExcerpt` is the command's own bytes so a builder repairs from what
 * the command printed rather than from someone's summary of it.
 */
/**
 * One code-step check. `ran` is false when the check never started (a refusal, a spawn failure, a runner that needs
 * provisioning), so a reader can tell an executed failure from a gap; reports sealed before it existed omit it.
 */
export interface CodeReportCheck {
	name: string;
	passed: boolean;
	evidence: string;
	ran?: boolean;
	/**
	 * Mutation reports only: a deliberate run before the change (a red TDD baseline). It is reported evidence, but
	 * quality judges the checks run after the change, so a baseline failure is not a failure of the work. A failing
	 * entry must state it either way: the report cannot be read until the worker says which red it reports.
	 */
	baseline?: boolean;
}

export interface CodeReportResult {
	passed: boolean;
	exitCode: number;
	checks: ReadonlyArray<CodeReportCheck>;
	artifactPaths: ReadonlyArray<string>;
	outputExcerpt: string;
}

/** `codeReport` admits the optional `ran` a code step records; a model-authored report's checks never carry it. */
export function parseChecks(value: unknown, codeReport = false): CodeReportCheck[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const checks: CodeReportCheck[] = [];
	for (const entry of value) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
		const check = entry as Record<string, unknown>;
		if (
			!hasOnlyKeys(
				check,
				codeReport ? ["name", "passed", "evidence", "ran"] : ["name", "passed", "evidence", "baseline"],
			) ||
			!string(check.name) ||
			typeof check.passed !== "boolean" ||
			!string(check.evidence) ||
			(check.ran !== undefined && typeof check.ran !== "boolean") ||
			(check.baseline !== undefined && typeof check.baseline !== "boolean")
		) {
			return null;
		}
		checks.push({
			name: check.name,
			passed: check.passed,
			evidence: check.evidence,
			...(typeof check.ran === "boolean" ? { ran: check.ran } : {}),
			...(check.baseline === true ? { baseline: true } : {}),
		});
	}
	return checks;
}

/**
 * A code step's result is always `unmeasured` for routing quality. A red suite
 * is evidence about the repository, not about the route that ran the command,
 * and code steps are not routes: they never reach route history or the routing
 * quality reducer. Conformance here judges the shape alone, so a failing
 * command still produces a conformant report that crosses its outgoing edges.
 */
export function validateCodeReport(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", parsed.reason);
	const value = parsed.value;
	const unexpected = unexpectedResultKeyReason("Code result", value, [
		"passed",
		"exitCode",
		"checks",
		"artifactPaths",
		"outputExcerpt",
	]);
	if (unexpected !== null) return failure(contract, "unmeasured", unexpected);
	if (typeof value.passed !== "boolean") {
		return failure(contract, "unmeasured", "Code result passed must be a boolean");
	}
	if (typeof value.exitCode !== "number" || !Number.isSafeInteger(value.exitCode)) {
		return failure(contract, "unmeasured", "Code result exitCode must be a safe integer");
	}
	if (typeof value.outputExcerpt !== "string") {
		return failure(contract, "unmeasured", "Code result outputExcerpt must be a string");
	}
	if (!Array.isArray(value.artifactPaths) || value.artifactPaths.some((entry) => !string(entry))) {
		return failure(contract, "unmeasured", "Code result artifactPaths must be an array of non-empty path strings");
	}
	const checks = parseChecks(value.checks, true);
	if (checks === null) return failure(contract, "unmeasured", "Code result must carry typed checks");
	if (value.passed !== (value.exitCode === 0) || value.passed !== checks.every((check) => check.passed)) {
		return failure(contract, "unmeasured", "Code result passed must agree with its exit code and every check");
	}
	return success(contract, "unmeasured", value);
}

/** Parse a `code-report` payload for callers that need the structured result. */
export function parseCodeReport(output: string | null): CodeReportResult | null {
	const validation = validateCodeReport({ kind: "code-report" }, output);
	if (validation.conformance !== "pass" || output === null) return null;
	// The same reader the validator used, so a fenced payload that passed
	// validation cannot fail here on a re-parse of the raw text.
	const parsed = parseJsonObjectPayload(output);
	if (!parsed.ok) return null;
	const value = parsed.value as unknown as CodeReportResult;
	return {
		passed: value.passed,
		exitCode: value.exitCode,
		checks: value.checks.map((check) => ({ ...check })),
		artifactPaths: [...value.artifactPaths],
		outputExcerpt: value.outputExcerpt,
	};
}
