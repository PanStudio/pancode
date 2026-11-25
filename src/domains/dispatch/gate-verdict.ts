// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * A settled run's own report and the gate verdict it carries, read from the fields a live receipt and a run's settled
 * record share, so `run --agent`'s exit and cause and `fleet view` word one run from one reading. A leaf: the headless
 * run reads it before boot.
 */

import { parseJsonObjectPayload, parseVerifierPayload } from "../../core/json-payload.js";

/** The fields of a sealed result the readers below need: a receipt's, or a settled record's with its result object. */
export interface SealedResultFields {
	exitCode: number | null;
	output?: {
		state: string;
		text: string;
		truncated: boolean;
		structured?: { kind: string; data: Record<string, unknown> };
	} | null;
	quality: { resultContract: { conformance: string; sourceId: string } | null } | null;
	verdict?: { assurance: string } | null;
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item),
			)
		: [];
}

/**
 * Failed checks as lines. `ran` selects a code-report's executed failures (true) or its checks that never started
 * (false), counting a check sealed without `ran` as not started; omitted, it selects every failure. A mutation report's
 * baseline entry ran before the change, so it is never a failure here.
 */
export function failedChecks(value: unknown, ran?: boolean): string[] {
	return records(value).flatMap((check) =>
		check.passed === false &&
		check.baseline !== true &&
		typeof check.name === "string" &&
		(ran === undefined || (ran ? check.ran === true : check.ran !== true))
			? [`${check.name}: ${typeof check.evidence === "string" ? check.evidence : "did not pass"}`]
			: [],
	);
}

/** The run's sealed typed report, or null for a partial, truncated or untyped answer. */
export function sealedReport(result: SealedResultFields): { kind: string; data: Record<string, unknown> } | null {
	const output = result.output;
	if (output?.state !== "final" || output.truncated) return null;
	const fact = result.quality?.resultContract ?? null;
	// Verifier and debugger reports seal typed JSON without the helper envelope.
	const kind = output.structured?.kind ?? (fact?.conformance === "pass" ? fact.sourceId.split(":")[1] : undefined);
	if (kind === undefined) return null;
	const parsed = output.structured
		? { ok: true as const, value: output.structured.data }
		: kind === "verifier-report"
			? parseVerifierPayload(output.text)
			: parseJsonObjectPayload(output.text);
	return parsed.ok ? { kind, data: parsed.value } : null;
}

/** Reports whose verdict is the run's deliverable: a verifier's and a reviewer's. */
const GATE_REPORT_KINDS: ReadonlySet<string> = new Set(["verifier-report", "review-verdict"]);

/**
 * A verifier's or reviewer's own verdict and the checks it found failing. A gate that found a failure did its job, so
 * the run settles succeeded; only the process exit status says the gate failed. Other reports keep their semantics.
 */
export function gateVerdict(result: SealedResultFields): { verdict: string; failedChecks: string[] } | null {
	const report = sealedReport(result);
	if (report === null || !GATE_REPORT_KINDS.has(report.kind) || typeof report.data.verdict !== "string") return null;
	return { verdict: report.data.verdict, failedChecks: failedChecks(report.data.checks) };
}

/**
 * A run that settled succeeded with its assurance compromised (fleet design 4.8): a gate's fail verdict, a check seen
 * failing after the last edit, a validation claimed and never run. Its outcome stays succeeded and `run --agent` exits
 * 1 on it, so a script's `&& deploy` stops; `message` says why in the words both surfaces print. Null for any other run.
 */
export function compromisedSuccess(
	result: SealedResultFields,
): { verdict: string | null; failedChecks: string[]; message: string } | null {
	if (result.exitCode !== 0 || result.verdict?.assurance !== "compromised") return null;
	const gate = gateVerdict(result);
	const checks = gate?.failedChecks ?? [];
	const named = checks.length > 0 ? `; failed checks: ${checks.join("; ")}` : "";
	const message =
		gate !== null
			? `the run succeeded with verdict ${gate.verdict}${named}`
			: "the run succeeded with its assurance compromised: a check failed after its last edit or a claimed validation never ran";
	return { verdict: gate?.verdict ?? null, failedChecks: checks, message };
}
