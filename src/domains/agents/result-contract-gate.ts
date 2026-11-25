// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import {
	type HoareObligation,
	hoareEvidenceError,
	hoarePasses,
	isHoareAssurance,
	type ObservedProof,
	parseHoareObligation,
} from "../../core/hoare.js";
import { parseVerifierPayload } from "../../core/json-payload.js";
import {
	failure,
	hasOnlyKeys,
	parseJson,
	string,
	success,
	unexpectedResultKeyReason,
} from "./result-contract-payload.js";
import type {
	ResultContract,
	ResultContractValidation,
	VerifierCheck,
	VerifierResult,
} from "./result-contract-types.js";

/** The packet id a gate's example check cites: a diff when the packet has one, since that is what a gate judges. */
export function packetCiteExample(packet: ReadonlyArray<string>): string {
	return packet.find((id) => id.endsWith(".diff")) ?? packet[0] ?? "s1.diff";
}

export function packetCitesRule(packet: ReadonlyArray<string>): string {
	return `"cites" is required on every check: the evidence packet ids the check rests on, drawn only from ${packet.join(", ")}; a verdict whose checks cite none of them is exhausted and decides nothing`;
}

/** One gate check as a bound JSON schema: with a packet, `cites` is required and its items are the packet's ids. */
export function gateCheckSchema(packet: ReadonlyArray<string> | undefined): Record<string, unknown> {
	const text = { type: "string", minLength: 1 };
	const properties: Record<string, unknown> = { name: text, passed: { type: "boolean" }, evidence: text };
	if (packet !== undefined && packet.length > 0)
		properties.cites = { type: "array", items: { type: "string", enum: [...packet] } };
	return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

/**
 * The one citation repair a gate verdict gets (M10): when its contract carries the evidence packet and no check cites
 * a packet id, or a check cites an id the packet lacks, the worker asks once more and names exactly the ids that
 * exist. Null when the verdict cites the packet, when the contract has no packet, or when the answer does not parse
 * (the shape repair owns that). A second uncited verdict passes through to the grader, which seals it exhausted.
 */
export function gateCitationViolation(contract: ResultContract, output: string | null): string | null {
	const packet = contract.kind === "review-verdict" || contract.kind === "judge-verdict" ? contract.packet : undefined;
	if (packet === undefined || packet.length === 0) return null;
	const parsed = parseJson(output);
	if (!parsed.ok || !Array.isArray(parsed.value.checks)) return null;
	const cited: string[] = [];
	for (const entry of parsed.value.checks) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
		cited.push(...(parseGateCites((entry as Record<string, unknown>).cites) ?? []));
	}
	const known = new Set(packet);
	const unknown = [...new Set(cited.filter((id) => !known.has(id)))];
	if (cited.length > 0 && unknown.length === 0) return null;
	const head =
		unknown.length > 0
			? `the verdict cites ids its evidence packet does not hold (${unknown.join(", ")})`
			: "no check cites an evidence packet id";
	return `${head}. The packet holds exactly these ids: ${packet.join(", ")}. Give every check a "cites" array of the ids it rests on, for example {"name":"...","passed":true,"evidence":"...","cites":["${packetCiteExample(packet)}"]}; a verdict that cites none of them is exhausted and decides nothing.`;
}

/**
 * A gate check's `cites`: the evidence packet ids it rests on. Undefined when absent, null when malformed; the
 * grader's cited-evidence rule, not this shape check, holds the ids to the packet.
 */
export function parseGateCites(value: unknown): string[] | null | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > 64) return null;
	const cites: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string" || entry.trim().length === 0 || entry.length > 256) return null;
		cites.push(entry.trim());
	}
	return cites;
}

function verifierPayload(output: string | null): ReturnType<typeof parseJson> {
	const parsed = parseJson(output);
	if (output === null) return parsed;
	const report = parseVerifierPayload(output);
	if (report.ok) return report;
	return parsed.ok ? { ok: false, reason: "result carries more than one report" } : parsed;
}

export function validateVerifier(
	contract: ResultContract,
	output: string | null,
	ground = false,
	proofs?: ReadonlyMap<string, ObservedProof>,
): ResultContractValidation {
	const parsed = verifierPayload(output);
	if (!parsed.ok) return failure(contract, "fail", `Verifier result payload failed: ${parsed.reason}`);
	const value = parsed.value;
	const unknown = Object.keys(value).filter((key) => key !== "verdict" && key !== "checks" && key !== "assurance");
	if (unknown.length > 0) {
		return failure(
			contract,
			"fail",
			`Verifier result field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not legal; legal top-level fields are verdict, checks and optional assurance`,
		);
	}
	if (contract.kind === "review-verdict" && value.assurance !== undefined)
		return failure(contract, "fail", "Review verdict fields are verdict and checks; assurance is not legal");
	const requiredAssurance = contract.kind === "verifier-report" ? contract.assurance : undefined;
	if (
		(requiredAssurance !== undefined && value.assurance !== requiredAssurance) ||
		(value.assurance !== undefined && !isHoareAssurance(value.assurance))
	)
		return failure(
			contract,
			"fail",
			`Verifier assurance must be ${requiredAssurance ?? "argued, modeled or mechanized"}`,
		);
	const assurance = isHoareAssurance(value.assurance) ? value.assurance : undefined;
	if (assurance !== undefined && (output === null || Buffer.byteLength(output, "utf8") > 32_768))
		return failure(contract, "fail", "Verifier report with an assurance level must fit within 32768 UTF-8 bytes");
	if (value.verdict !== "pass" && value.verdict !== "fail") {
		return failure(contract, "fail", 'Verifier field "verdict" must be one of: pass | fail');
	}
	if (!Array.isArray(value.checks) || value.checks.length === 0) {
		return failure(
			contract,
			"fail",
			'Verifier field "checks" must be a non-empty array of {name, passed, evidence}; each checks[].passed value must be one of: true | false',
		);
	}
	const checks: VerifierCheck[] = [];
	const names = new Set<string>();
	if (assurance !== undefined && value.checks.length > 128)
		return failure(contract, "fail", "Verifier report with an assurance level must contain at most 128 checks");
	for (const [index, raw] of value.checks.entries()) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			return failure(contract, "fail", `Verifier field "checks[${index}]" must be an object`);
		}
		const check = raw as Record<string, unknown>;
		const legal =
			assurance !== undefined
				? ["name", "passed", "evidence", "obligation"]
				: contract.kind === "review-verdict"
					? ["name", "passed", "evidence", "cites"]
					: ["name", "passed", "evidence"];
		const checkUnknown = Object.keys(check).filter((key) => !legal.includes(key));
		if (checkUnknown.length > 0) {
			return failure(
				contract,
				"fail",
				`Verifier field "checks[${index}].${checkUnknown[0]}" is not legal; legal check fields are ${legal.join(", ")}`,
			);
		}
		if (!string(check.name)) {
			return failure(contract, "fail", `Verifier field "checks[${index}].name" must be a non-empty string`);
		}
		if (typeof check.passed !== "boolean") {
			return failure(contract, "fail", `Verifier field "checks[${index}].passed" must be one of: true | false`);
		}
		if (!string(check.evidence)) {
			return failure(contract, "fail", `Verifier field "checks[${index}].evidence" must be a non-empty string`);
		}
		const cites = parseGateCites(check.cites);
		if (cites === null)
			return failure(
				contract,
				"fail",
				`Review verdict field "checks[${index}].cites" must be an array of evidence packet ids (non-empty strings)`,
			);
		let obligation: HoareObligation | undefined;
		if (assurance !== undefined) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(check.name) || names.has(check.name))
				return failure(contract, "fail", `Verifier check name is invalid or duplicated: ${check.name}`);
			names.add(check.name);
			const parsedObligation = parseHoareObligation(check.obligation);
			if (parsedObligation instanceof Error)
				return failure(contract, "fail", `${check.name}: ${parsedObligation.message}`);
			obligation = parsedObligation;
			if (check.passed !== hoarePasses(assurance, obligation.status))
				return failure(
					contract,
					"fail",
					`${check.name}: passed must follow ${assurance} assurance for status ${obligation.status}`,
				);
			if (ground) {
				const reason = hoareEvidenceError(check.name, obligation, proofs);
				if (reason !== null) return failure(contract, "fail", reason);
			}
		}
		checks.push({
			name: check.name,
			passed: check.passed,
			evidence: check.evidence,
			...(obligation ? { obligation } : {}),
			...(cites !== undefined ? { cites } : {}),
		});
	}
	if ((value.verdict === "pass") !== checks.every((check) => check.passed)) {
		return failure(
			contract,
			"fail",
			'Verifier field "verdict" must agree with every checks[].passed value; verdict legal values are pass | fail and checks[].passed legal values are true | false',
		);
	}
	const verifier: VerifierResult = { verdict: value.verdict, checks, ...(assurance ? { assurance } : {}) };
	const evidence =
		ground && assurance !== undefined
			? checks.flatMap((check) => {
					const id = check.obligation?.check;
					const proof = id === undefined ? undefined : proofs?.get(id);
					return proof === undefined ? [] : [proof];
				})
			: [];
	return success(contract, value.verdict, evidence.length > 0 ? { verifier, evidence } : verifier, { verifier });
}

/**
 * Parse a Verifier structured result under the same schema its recipe contract
 * enforces. The review gate needs the verdict itself, not just its conformance
 * label, so this exposes the parsed payload the way `parseScoutResult` does for
 * reconnaissance. It defines no new schema.
 */
export function parseVerifierResult(output: string | null): VerifierResult | null {
	const validation = validateVerifier({ kind: "verifier-report" }, output);
	return validation.verifier ?? null;
}

/** Parse a reviewer gate's answer under its `review-verdict` contract, whose checks may cite packet ids (M10). */
export function parseReviewVerdict(output: string | null): VerifierResult | null {
	const validation = validateVerifier({ kind: "review-verdict" }, output);
	return validation.verifier ?? null;
}

const REVIEW_CONTRACT_KINDS = ["review-verdict", "verifier-report"] as const;

/**
 * What a review found: the failed checks of a conforming `fail` verdict under a review or verifier contract, named by
 * the run's settled contract source id. A failing verdict is the review's result, not a failure of the run that gave
 * it. Null for any other contract, answer or verdict.
 */
export function reviewFindings(contractSourceId: string | undefined, output: string | null): VerifierCheck[] | null {
	const kind = REVIEW_CONTRACT_KINDS.find((candidate) =>
		contractSourceId?.startsWith(`agent-result-contract:${candidate}:`),
	);
	if (kind === undefined) return null;
	const parsed = validateVerifier({ kind }, output).verifier;
	if (parsed?.verdict !== "fail") return null;
	return parsed.checks.filter((check) => !check.passed);
}

/** A judge's answer: a compete winner with typed checks, or a council synthesis's verdict and text. */
export function validateJudgeVerdict(
	contract: Extract<ResultContract, { kind: "judge-verdict" }>,
	output: string | null,
): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", `Judge verdict payload failed: ${parsed.reason}`);
	const value = parsed.value;
	if (contract.candidates === undefined) {
		const unexpected = unexpectedResultKeyReason("Synthesis verdict", value, ["verdict", "text"]);
		if (unexpected !== null) return failure(contract, "unmeasured", unexpected);
		if (!string(value.verdict) || !string(value.text))
			return failure(contract, "unmeasured", 'Synthesis verdict needs a non-empty "verdict" and a non-empty "text"');
		return success(contract, "unmeasured", value);
	}
	const unexpected = unexpectedResultKeyReason("Judge verdict", value, ["winner", "checks"]);
	if (unexpected !== null) return failure(contract, "unmeasured", unexpected);
	const winner = value.winner;
	if (typeof winner !== "number" || !Number.isSafeInteger(winner) || winner < 1 || winner > contract.candidates)
		return failure(contract, "unmeasured", `Judge verdict winner must be an integer 1..${contract.candidates}`);
	const checks = Array.isArray(value.checks) ? value.checks : null;
	if (
		checks === null ||
		checks.length === 0 ||
		checks.some((entry) => {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return true;
			const check = entry as Record<string, unknown>;
			return (
				!hasOnlyKeys(check, ["name", "passed", "evidence", "cites"]) ||
				!string(check.name) ||
				typeof check.passed !== "boolean" ||
				!string(check.evidence) ||
				parseGateCites(check.cites) === null
			);
		})
	)
		return failure(
			contract,
			"unmeasured",
			'Judge verdict "checks" must be a non-empty array of {name, passed, evidence, cites}; cites lists evidence packet ids',
		);
	return success(contract, "unmeasured", value);
}
