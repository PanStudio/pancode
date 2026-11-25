// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import path from "node:path";
import { sha256Hex } from "../../core/hash.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import {
	failure,
	hasOnlyKeys,
	parseJson,
	string,
	success,
	unexpectedResultKeyReason,
} from "./result-contract-payload.js";
import { RESULT_CONTRACT_KINDS } from "./result-contract-schema.js";
import type {
	ResultContract,
	ResultContractValidation,
	ResultContractValidationInput,
	ScoutCitation,
	ScoutFinding,
	ScoutResult,
	ScoutSubtask,
} from "./result-contract-types.js";
import { AGENT_AUTOMATION_AUTHORITIES, type AgentAutomationAuthority } from "./spec.js";

function parseFindings(value: unknown): ScoutFinding[] | null {
	if (!Array.isArray(value)) return null;
	const findings: ScoutFinding[] = [];
	for (const entry of value) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
		const finding = entry as Record<string, unknown>;
		const line = finding.line;
		if (
			!hasOnlyKeys(finding, ["claim", "path", "line"]) ||
			!string(finding.claim) ||
			!string(finding.path) ||
			typeof line !== "number" ||
			!Number.isSafeInteger(line) ||
			line < 1
		) {
			return null;
		}
		findings.push({ claim: finding.claim, path: finding.path, line });
	}
	return findings;
}

function parseSubtasks(value: unknown): ScoutSubtask[] | null {
	if (!Array.isArray(value) || value.length > 4) return null;
	const subtasks: ScoutSubtask[] = [];
	const ids = new Set<string>();
	for (const entry of value) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
		const subtask = entry as Record<string, unknown>;
		if (
			!hasOnlyKeys(subtask, ["id", "task", "dependencies", "expectedResultContract", "requestedAuthority"]) ||
			!string(subtask.id) ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(subtask.id) ||
			ids.has(subtask.id) ||
			!string(subtask.task) ||
			Buffer.byteLength(subtask.task, "utf8") > 4096 ||
			!Array.isArray(subtask.dependencies) ||
			subtask.dependencies.length > 4 ||
			subtask.dependencies.some((dependency) => !string(dependency)) ||
			new Set(subtask.dependencies).size !== subtask.dependencies.length ||
			!RESULT_CONTRACT_KINDS.includes(subtask.expectedResultContract as ResultContract["kind"]) ||
			!AGENT_AUTOMATION_AUTHORITIES.includes(subtask.requestedAuthority as AgentAutomationAuthority)
		) {
			return null;
		}
		ids.add(subtask.id);
		subtasks.push({
			id: subtask.id,
			task: subtask.task,
			dependencies: [...subtask.dependencies] as string[],
			expectedResultContract: subtask.expectedResultContract as ResultContract["kind"],
			requestedAuthority: subtask.requestedAuthority as AgentAutomationAuthority,
		});
	}
	for (const subtask of subtasks) {
		if (subtask.dependencies.some((dependency) => dependency === subtask.id || !ids.has(dependency))) return null;
	}
	const remaining = new Set(ids);
	const completed = new Set<string>();
	while (remaining.size > 0) {
		const ready = subtasks.filter(
			(subtask) => remaining.has(subtask.id) && subtask.dependencies.every((dependency) => completed.has(dependency)),
		);
		if (ready.length === 0) return null;
		for (const subtask of ready) {
			remaining.delete(subtask.id);
			completed.add(subtask.id);
		}
	}
	return subtasks;
}

/**
 * Everything a degraded Scout result still carries: the claims themselves,
 * split by whether a `path`/`line` came with them. Deliberately lenient where
 * `parseFindings` is strict, because this runs only after the strict parse has
 * already failed and the alternative to leniency is discarding the run.
 */
function salvageScoutClaims(value: unknown): { grounded: ScoutFinding[]; ungrounded: string[] } {
	const grounded: ScoutFinding[] = [];
	const ungrounded: string[] = [];
	if (!Array.isArray(value)) return { grounded, ungrounded };
	for (const entry of value) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		const finding = entry as Record<string, unknown>;
		if (!string(finding.claim)) continue;
		const line = finding.line;
		if (string(finding.path) && typeof line === "number" && Number.isSafeInteger(line) && line >= 1) {
			grounded.push({ claim: finding.claim, path: finding.path, line });
			continue;
		}
		ungrounded.push(finding.claim);
	}
	return { grounded, ungrounded };
}

/**
 * A degraded acceptance. The strict contract is the goal, not the point: on a
 * small local model the `{claim, path, line}` shape is close to a coin flip,
 * and the E19 drive lost an entire 51k-token reconnaissance run because two
 * bounded repair rounds could not land it. Nothing about the evidence was
 * wrong; only the envelope was, and failing the run threw the evidence away
 * with it.
 *
 * So a result that still carries usable claims conforms, and the claims reach
 * the parent. Quality is `unmeasured`, never `pass`: a shape this validator had
 * to repair is not correctness evidence, and routing statistics must not
 * inherit one. `degradedReason` marks it for every consumer that needs the
 * strict data, and `parseScoutResult` refuses it outright, so a degraded run
 * can never become a `from_scout` continuation source.
 */
function degradedScout(
	contract: ResultContract,
	value: Record<string, unknown>,
	reason: string,
): ResultContractValidation | null {
	const salvaged = salvageScoutClaims(value.findings);
	if (salvaged.grounded.length === 0 && salvaged.ungrounded.length === 0) return null;
	const degradedReason = `${reason} (accepted as a degraded reconnaissance result; findings are leads, not validation evidence)`;
	// needsSplit is forced false and subtasks dropped: a subtask is control-plane
	// data a coordinator acts on, so a malformed one is never repaired here.
	const scout: ScoutResult = {
		findings: salvaged.grounded,
		citations: salvaged.grounded.map(({ path: citedPath, line }) => ({ path: citedPath, line })),
		needsSplit: false,
		proposedSubtasks: [],
		ungroundedClaims: salvaged.ungrounded,
		degradedReason,
	};
	return success(contract, "unmeasured", scout, { scout, reason: degradedReason });
}

export function validateScout(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	// Nothing to salvage from bytes that are not a JSON object.
	if (!parsed.ok) return failure(contract, "fail", parsed.reason);
	const value = parsed.value;
	// Every strict rejection below falls through to `degrade`, which returns the
	// strict failure unchanged when the result carries no usable claim either.
	const degrade = (reason: string): ResultContractValidation =>
		degradedScout(contract, value, reason) ?? failure(contract, "fail", reason);
	const unexpected = unexpectedResultKeyReason("Scout result", value, ["findings", "needsSplit", "proposedSubtasks"]);
	if (unexpected !== null) return degrade(unexpected);
	const findings = parseFindings(value.findings);
	const proposedSubtasks = parseSubtasks(value.proposedSubtasks);
	if (findings === null) {
		return degrade(
			"Scout result findings must be an array of {claim, path, line} objects with non-empty strings and positive integer lines",
		);
	}
	if (typeof value.needsSplit !== "boolean") return degrade("Scout result needsSplit must be a boolean");
	if (proposedSubtasks === null) {
		return degrade("Scout result proposedSubtasks must be an array of 0..4 valid typed subtasks");
	}
	if (value.needsSplit !== proposedSubtasks.length > 0) {
		return degrade("Scout needsSplit must agree with proposedSubtasks");
	}
	// A grounded report needs at least one cited claim. A split recommendation
	// is the explicit exception: it reports that the task did not fit, so it
	// carries subtasks instead of findings.
	if (findings.length === 0 && !value.needsSplit) {
		return degrade(SCOUT_NO_FINDING_REASON);
	}
	if (value.needsSplit && findings.length > 0) {
		return degrade("Scout split recommendations carry typed subtasks instead of findings");
	}
	const scout: ScoutResult = {
		findings,
		citations: findings.map(({ path: citedPath, line }) => ({ path: citedPath, line })),
		needsSplit: value.needsSplit,
		proposedSubtasks,
	};
	return success(contract, "pass", scout, { scout });
}

type ScoutCitationEvidence = ScoutCitation & { contentDigest: string };

/**
 * A directory citation carries no bytes and no line, so its evidence digest is
 * bound to the location instead. Prefixed so it can never collide with the
 * content digest of a file that happens to hold the same text.
 */
function directoryCitationDigest(cwd: string, citedPath: string): string {
	const relative = path.relative(cwd, citedPath);
	return sha256Hex(`directory:${relative === "" ? "." : relative}`);
}

/** One citation against the workspace and, where known, against this run's own reads. */
function validateScoutCitation(
	input: ResultContractValidationInput,
	citation: ScoutCitation,
): { ok: true; evidence: ScoutCitationEvidence } | { ok: false; reason: string } {
	const cwd = path.resolve(input.cwd);
	const citedPath = path.resolve(cwd, citation.path);
	// The root itself is contained: a directory-survey Scout cites `.` for what it surveyed.
	if (!isSameOrDescendant(citedPath, cwd)) {
		return { ok: false, reason: `Scout citation path escapes the workspace: ${citation.path}` };
	}
	// A directory is a legal reconnaissance location. Existence is the whole
	// check available: there is no content to digest, no line count to bound the
	// cited line against, and no read span to ground it in, because a survey
	// lists a directory rather than reading it. Requiring a live read here would
	// reject the correct answer to every directory-survey task.
	if (input.filesystem.isDirectory?.(citedPath) === true) {
		return { ok: true, evidence: { ...citation, contentDigest: directoryCitationDigest(cwd, citedPath) } };
	}
	const content = input.filesystem.readFile(citedPath);
	if (content === null) return { ok: false, reason: `Scout citation cannot be read: ${citation.path}` };
	const lineCount =
		content.length === 0 ? 0 : content.split(/\r\n|\r|\n/u).length - (/(?:\r\n|\r|\n)$/u.test(content) ? 1 : 0);
	if (citation.line > lineCount) {
		return {
			ok: false,
			reason: `Scout citation is past end of file: ${citation.path}:${citation.line}; current file has ${lineCount} lines (${lineCount > 0 ? `valid lines 1-${lineCount}` : "no source lines"}). Re-read the supporting source or remove the citation; do not move it to the last line just to pass.`,
		};
	}
	// Grounding: a line that exists is not a line anyone looked at. Where the
	// run's own read spans are known, the cited line has to fall inside one,
	// so an approximated or inferred line number cannot pass as observation.
	if (input.observedReadRanges !== undefined) {
		const spans = input.observedReadRanges.get(citedPath) ?? [];
		if (!spans.some(([start, end]) => citation.line >= start && citation.line <= end)) {
			const observed =
				spans.length === 0
					? "this run never read that file"
					: `this run read only ${spans.map(([start, end]) => `${start}-${end}`).join(", ")}`;
			return {
				ok: false,
				reason: `${SCOUT_UNGROUNDED_REASON}: ${citation.path}:${citation.line} (${observed})`,
			};
		}
	}
	return {
		ok: true,
		evidence: { ...citation, contentDigest: sha256Hex(content) },
	};
}

/** How many refused citations one repair message names before it counts the rest. */
const SCOUT_CITATION_REFUSALS_NAMED = 8;

const SCOUT_NO_FINDING_REASON = "Scout result must carry at least one cited finding, or set needsSplit";
const SCOUT_UNGROUNDED_REASON = "Scout citation is not grounded in a live read";

/**
 * Explorer reports held to the observed-evidence obligation: their findings are only as good as what the run read.
 * One that arrives before any tool ran is refused at the worker, where the run can still read, instead of being sealed
 * failed by the dispatch obligation after the run is over (M-31).
 */
const OBSERVED_EXPLORER_KINDS: ReadonlySet<string> = new Set([
	"scout-report",
	"provenance-report",
	"research-report",
	"context-handbook",
]);
const UNOBSERVED_REPORT_REASON =
	"This report was submitted before any tool ran, so none of it rests on anything this run observed";

/** The refusal for an explorer report submitted before the run executed a tool, or null when none applies. */
export function unobservedExplorerReportReason(kind: string, toolsExecuted: number): string | null {
	return toolsExecuted === 0 && OBSERVED_EXPLORER_KINDS.has(kind) ? UNOBSERVED_REPORT_REASON : null;
}

/**
 * Whether a refusal says the result lacks evidence the run could still gather by reading (M-31): an explorer report
 * submitted before anything ran, no cited finding at all, or a citation outside every span the run read. A repair for
 * one of these keeps the read tools; every other refusal is about the result's form.
 */
export function resultContractEvidenceShortfall(reason: string): boolean {
	return (
		reason.includes(UNOBSERVED_REPORT_REASON) ||
		reason.includes(SCOUT_NO_FINDING_REASON) ||
		reason.includes(SCOUT_UNGROUNDED_REASON)
	);
}

/**
 * Every citation on a strictly conforming result has to ground. One that does
 * not is a fabricated location on a report claiming `pass`, so it fails the
 * whole result; this check is the only thing standing between an invented
 * `path:line` and a quality label the router believes. The refusal names every
 * citation that failed, because a report of eighteen findings rejected one
 * citation per submission cost a live scout three full resubmissions.
 */
export function validateScoutCitations(
	input: ResultContractValidationInput,
	citations: ReadonlyArray<ScoutCitation>,
): { ok: true; evidence: ReadonlyArray<ScoutCitationEvidence> } | { ok: false; reason: string } {
	const evidence: ScoutCitationEvidence[] = [];
	const refusals: string[] = [];
	for (const citation of citations) {
		const checked = validateScoutCitation(input, citation);
		if (checked.ok) evidence.push(checked.evidence);
		else refusals.push(checked.reason);
	}
	if (refusals.length === 0) return { ok: true, evidence };
	const named = refusals.slice(0, SCOUT_CITATION_REFUSALS_NAMED).join("; ");
	const rest = refusals.length - SCOUT_CITATION_REFUSALS_NAMED;
	return { ok: false, reason: rest > 0 ? `${named}; and ${rest} more citations were refused` : named };
}

/**
 * Ground a degraded result without ever failing it. On a strict result an
 * ungrounded citation is fabrication and fails the run; here the result already
 * carries no correctness label, so a citation that does not ground is simply
 * dropped and its claim demoted to an ungrounded lead. The parent gets what the
 * run actually observed, correctly labeled, instead of nothing.
 */
export function groundDegradedScout(
	contract: ResultContract,
	input: ResultContractValidationInput,
	scout: ScoutResult,
	degradedReason: string,
): ResultContractValidation {
	const grounded: ScoutFinding[] = [];
	const evidence: ScoutCitationEvidence[] = [];
	const demoted: string[] = [];
	for (const finding of scout.findings) {
		const checked = validateScoutCitation(input, { path: finding.path, line: finding.line });
		if (checked.ok) {
			grounded.push(finding);
			evidence.push(checked.evidence);
			continue;
		}
		demoted.push(finding.claim);
	}
	const degraded: ScoutResult = {
		findings: grounded,
		citations: grounded.map(({ path: citedPath, line }) => ({ path: citedPath, line })),
		needsSplit: false,
		proposedSubtasks: [],
		ungroundedClaims: [...(scout.ungroundedClaims ?? []), ...demoted],
		degradedReason,
	};
	return success(contract, "unmeasured", { scout: degraded, evidence }, { scout: degraded, reason: degradedReason });
}

/**
 * Validate one terminal result under its recipe's typed contract. The caller
 * supplies filesystem access so this module stays deterministic and testable.
 */
/**
 * Parse the Scout structured result for model-facing task decomposition.
 * Strict on purpose: this feeds the `from_scout` continuation, where a subtask
 * becomes a real dispatch, so a degraded result is rejected here even though it
 * conforms as a terminal result. Degraded reconnaissance is readable evidence,
 * never a control-plane input.
 */
export function parseScoutResult(output: string): ScoutResult | null {
	const validation = validateScout({ kind: "scout-report" }, output);
	if (validation.conformance !== "pass" || validation.scout === undefined) return null;
	return validation.scout.degradedReason === undefined ? validation.scout : null;
}
