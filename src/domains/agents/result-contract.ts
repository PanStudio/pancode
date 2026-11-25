// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import path from "node:path";
import { sha256Hex } from "../../core/hash.js";
import { isHoareAssurance } from "../../core/hoare.js";
import { INTERNAL_HELPER_RESULT_KINDS } from "../../worker/protocol.js";
import {
	parseResultSummaryMaxBytes,
	resultContractOutputBytes,
	STRUCTURED_HELPER_RESULT_MAX_BYTES,
} from "./result-contract-allowance.js";
import { validateArtifactReport, validateMutation } from "./result-contract-builder-report.js";
import { validateCodeReport } from "./result-contract-code-report.js";
import {
	COUNCIL_BALLOT_VERDICT_MAX_BYTES,
	isCouncilBallotOption,
	parseCouncilReport,
	validateCouncilBallot,
} from "./result-contract-council.js";
import { validateJudgeVerdict, validateVerifier } from "./result-contract-gate.js";
import {
	digest,
	failure,
	hasOnlyKeys,
	parseJson,
	resultContractSourceId,
	string,
	success,
	unexpectedResultKeyReason,
} from "./result-contract-payload.js";
import { groundDegradedScout, validateScout, validateScoutCitations } from "./result-contract-scout.js";
import type {
	DelegationPlanResult,
	DelegationPlanResultTask,
	InternalHelperResultKind,
	RecipeResultOutcome,
	ResultContract,
	ResultContractValidation,
	ResultContractValidationInput,
	StructuredHelperResult,
	ValidateRecipeResultInput,
} from "./result-contract-types.js";

export { INTERNAL_HELPER_RESULT_KINDS } from "../../worker/protocol.js";

/** Decode a helper value through exactly the ordinary contract and grounding checks. */
export function validateStructuredHelperResult(
	input: Omit<ResultContractValidationInput, "output"> & { data: unknown },
): { validation: ResultContractValidation; structured: StructuredHelperResult | null } {
	const reject = (reason: string) => ({ validation: failure(input.contract, "unmeasured", reason), structured: null });
	if (!(INTERNAL_HELPER_RESULT_KINDS as readonly string[]).includes(input.contract.kind))
		return reject("unsupported internal helper contract");
	if (input.data === null || typeof input.data !== "object" || Array.isArray(input.data))
		return reject("helper result must be a JSON object");
	let output: string;
	try {
		output = JSON.stringify(input.data, (_key, value) => {
			if (
				value === undefined ||
				typeof value === "function" ||
				typeof value === "symbol" ||
				(typeof value === "number" && !Number.isFinite(value))
			)
				throw new Error("non-JSON value");
			return value;
		});
	} catch {
		return reject("helper result must contain only JSON values");
	}
	const maxBytes = resultContractOutputBytes(input.contract) ?? STRUCTURED_HELPER_RESULT_MAX_BYTES;
	if (Buffer.byteLength(output, "utf8") > maxBytes) {
		return reject(`helper result exceeds ${maxBytes} UTF-8 bytes; shorten the result`);
	}
	const validation = validateResultContract({ ...input, output });
	if (validation.conformance !== "pass") return { validation, structured: null };
	let data = JSON.parse(output) as Record<string, unknown>;
	// Salvage is data-only: discard unknown fields and any split/control claims.
	// Preserve ungrounded observations without accidentally promoting their citations.
	if (validation.scout?.degradedReason !== undefined) {
		data = {
			findings: [...validation.scout.findings, ...(validation.scout.ungroundedClaims ?? []).map((claim) => ({ claim }))],
			needsSplit: false,
			proposedSubtasks: [],
		};
	}
	// Salvage adds canonical fields; its serialized result must fit too.
	if (Buffer.byteLength(JSON.stringify(data), "utf8") > maxBytes)
		return reject(`helper result exceeds ${maxBytes} UTF-8 bytes; shorten the result`);
	return { validation, structured: { version: 1, kind: input.contract.kind as InternalHelperResultKind, data } };
}

function parseDelegationPlanResult(output: string | null): DelegationPlanResult | null {
	const parsed = parseJson(output);
	if (
		!parsed.ok ||
		!hasOnlyKeys(parsed.value, ["tasks"]) ||
		!Array.isArray(parsed.value.tasks) ||
		parsed.value.tasks.length === 0
	)
		return null;
	const tasks: DelegationPlanResultTask[] = [];
	for (const raw of parsed.value.tasks) {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
		const task = raw as Record<string, unknown>;
		if (
			!hasOnlyKeys(task, ["id", "agent", "description", "depends_on", "writes", "mode"]) ||
			!string(task.id) ||
			!string(task.agent) ||
			!string(task.description) ||
			!Array.isArray(task.depends_on) ||
			task.depends_on.some((entry) => !string(entry)) ||
			!Array.isArray(task.writes) ||
			task.writes.some((entry) => !string(entry)) ||
			(task.mode !== undefined && task.mode !== "sequential" && task.mode !== "parallel")
		)
			return null;
		tasks.push({
			id: task.id,
			agent: task.agent,
			description: task.description,
			depends_on: [...task.depends_on] as string[],
			writes: [...task.writes] as string[],
			...(task.mode !== undefined ? { mode: task.mode as "sequential" | "parallel" } : {}),
		});
	}
	return { tasks };
}

/**
 * Parsed `oracle-report` payload. `/oracle` renders these four fields into the
 * operator note it hands the main agent, so the shape is the answer shape.
 */
export interface OracleResult {
	verdict: string;
	challenge: string;
	changesMyMind: string;
	citedDecisions: ReadonlyArray<string>;
}

function contextHandbookReason(value: Record<string, unknown>): string | null {
	const unexpected = unexpectedResultKeyReason("Context handbook result", value, [
		"projectName",
		"identity",
		"conventions",
		"invariants",
		"sections",
	]);
	if (unexpected !== null) return unexpected;
	for (const key of ["projectName", "identity"] as const) {
		if (!string(value[key])) return `Context handbook result ${key} must be a non-empty string`;
	}
	for (const key of ["conventions", "invariants"] as const) {
		const entries = value[key];
		if (!Array.isArray(entries) || entries.some((entry) => !string(entry))) {
			return `Context handbook result ${key} must be an array of non-empty strings`;
		}
	}
	if (!Array.isArray(value.sections))
		return "Context handbook result sections must be an array of {title, body} objects";
	for (const [index, entry] of value.sections.entries()) {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			return `Context handbook result sections[${index}] must be an object`;
		}
		const section = entry as Record<string, unknown>;
		const sectionUnexpected = unexpectedResultKeyReason(`Context handbook result sections[${index}]`, section, [
			"title",
			"body",
		]);
		if (sectionUnexpected !== null) return sectionUnexpected;
		for (const key of ["title", "body"] as const) {
			if (!string(section[key])) return `Context handbook result sections[${index}].${key} must be a non-empty string`;
		}
	}
	return null;
}

/**
 * The handbook payload conforms or it does not. Quality stays unmeasured: a
 * well-formed handbook is a shape, not evidence that the repository was read
 * correctly, and routing statistics must not treat it as a correctness signal.
 */
function validateContextHandbook(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "fail", parsed.reason);
	const reason = contextHandbookReason(parsed.value);
	if (reason !== null) return failure(contract, "fail", reason);
	return success(contract, "unmeasured", parsed.value);
}

/**
 * An advisory opinion is never a correctness signal about the route that
 * produced it, so conformance is judged on the shape alone and quality stays
 * `unmeasured`. `citedDecisions` may be empty: an honest advisor that found no
 * settled decision bearing on the question must be able to say so.
 */
function validateOracle(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", parsed.reason);
	const value = parsed.value;
	const unexpected = unexpectedResultKeyReason("Oracle result", value, [
		"verdict",
		"challenge",
		"changesMyMind",
		"citedDecisions",
	]);
	if (unexpected !== null) return failure(contract, "unmeasured", unexpected);
	for (const key of ["verdict", "challenge", "changesMyMind"] as const) {
		if (!string(value[key])) return failure(contract, "unmeasured", `Oracle result ${key} must be a non-empty string`);
	}
	if (!Array.isArray(value.citedDecisions) || value.citedDecisions.some((entry) => !string(entry))) {
		return failure(contract, "unmeasured", "Oracle result citedDecisions must be an array of non-empty strings");
	}
	return success(contract, "unmeasured", value);
}

/** Parse an oracle answer under the same schema its recipe contract enforces. */
export function parseOracleResult(output: string | null): OracleResult | null {
	const validation = validateOracle({ kind: "oracle-report" }, output);
	if (validation.conformance !== "pass") return null;
	const parsed = parseJson(output);
	if (!parsed.ok) return null;
	return {
		verdict: String(parsed.value.verdict),
		challenge: String(parsed.value.challenge),
		changesMyMind: String(parsed.value.changesMyMind),
		citedDecisions: (parsed.value.citedDecisions as ReadonlyArray<string>).map((entry) => String(entry)),
	};
}

function validateDebugger(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", `Debugger result payload failed: ${parsed.reason}`);
	const value = parsed.value;
	const unknown = Object.keys(value).filter(
		(key) => key !== "diagnosis" && key !== "reproduction" && key !== "evidence",
	);
	if (unknown.length > 0) {
		return failure(
			contract,
			"unmeasured",
			`Debugger result field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not legal; legal top-level fields are diagnosis, reproduction, and evidence`,
		);
	}
	if (!string(value.diagnosis)) {
		return failure(contract, "unmeasured", 'Debugger field "diagnosis" must be a non-empty string');
	}
	if (
		value.reproduction !== "reproduced" &&
		value.reproduction !== "not-reproduced" &&
		value.reproduction !== "unknown"
	) {
		return failure(
			contract,
			"unmeasured",
			'Debugger field "reproduction" must be one of: reproduced | not-reproduced | unknown',
		);
	}
	if (!Array.isArray(value.evidence)) {
		return failure(contract, "unmeasured", 'Debugger field "evidence" must be an array of strings');
	}
	const malformedEvidence = value.evidence.findIndex((entry) => !string(entry));
	if (malformedEvidence >= 0) {
		return failure(contract, "unmeasured", `Debugger field "evidence[${malformedEvidence}]" must be a non-empty string`);
	}
	return success(contract, "unmeasured", value);
}

function validateResearch(
	contract: ResultContract,
	output: string | null,
	networkAllowed: boolean,
): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", `Research result payload failed: ${parsed.reason}`);
	const value = parsed.value;
	const unknown = Object.keys(value).filter((key) => key !== "source" && key !== "findings");
	if (unknown.length > 0) {
		return failure(
			contract,
			"unmeasured",
			`Research result field${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not legal; legal top-level fields are source and findings`,
		);
	}
	if (value.source !== "local" && value.source !== "external") {
		return failure(contract, "unmeasured", 'Research field "source" must be one of: local | external');
	}
	if (!Array.isArray(value.findings)) {
		return failure(contract, "unmeasured", 'Research field "findings" must be an array of {claim, evidence} objects');
	}
	if (value.source === "external" && !networkAllowed) {
		return failure(
			contract,
			"unmeasured",
			'Research field "source" is external but the run has no allowed network posture: give the recipe web_fetch or web_read, or an MCP tool whose server has network trust (pancode mcp trust <id> --network, or network: true in a user declaration); use source local for workspace-only evidence',
		);
	}
	for (const [index, finding] of value.findings.entries()) {
		if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
			return failure(contract, "unmeasured", `Research field "findings[${index}]" must be an object`);
		}
		const record = finding as Record<string, unknown>;
		const findingUnknown = Object.keys(record).filter((key) => key !== "claim" && key !== "evidence");
		if (findingUnknown.length > 0) {
			return failure(
				contract,
				"unmeasured",
				`Research field "findings[${index}].${findingUnknown[0]}" is not legal; legal finding fields are claim and evidence`,
			);
		}
		if (!string(record.claim)) {
			return failure(contract, "unmeasured", `Research field "findings[${index}].claim" must be a non-empty string`);
		}
		if (!string(record.evidence)) {
			return failure(contract, "unmeasured", `Research field "findings[${index}].evidence" must be a non-empty string`);
		}
	}
	return success(contract, "unmeasured", value);
}

function validateWorldKnowledge(
	contract: ResultContract,
	output: string | null,
	externalSourcesAllowed: boolean,
): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", `World-knowledge payload failed: ${parsed.reason}`);
	const value = parsed.value;
	const legal = ["discovery", "facts", "synthesis", "uncertainties", "followUpVerification"];
	const unknown = Object.keys(value).filter((key) => !legal.includes(key));
	if (unknown.length > 0) {
		return failure(contract, "unmeasured", `World-knowledge field '${unknown[0]}' is not legal`);
	}
	if (
		value.discovery !== "performed" &&
		value.discovery !== "caller-supplied-only" &&
		value.discovery !== "unavailable"
	) {
		return failure(
			contract,
			"unmeasured",
			'World-knowledge field "discovery" must be one of: performed | caller-supplied-only | unavailable',
		);
	}
	if (value.discovery === "performed" && !externalSourcesAllowed) {
		return failure(
			contract,
			"unmeasured",
			'World-knowledge field "discovery" is performed but this run had no external-source posture',
		);
	}
	if (!Array.isArray(value.facts)) {
		return failure(contract, "unmeasured", 'World-knowledge field "facts" must be an array');
	}
	for (const [index, finding] of value.facts.entries()) {
		if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
			return failure(contract, "unmeasured", `World-knowledge field "facts[${index}]" must be an object`);
		}
		const fact = finding as Record<string, unknown>;
		const factUnknown = Object.keys(fact).filter((key) => !["claim", "evidence", "sources"].includes(key));
		if (factUnknown.length > 0) {
			return failure(contract, "unmeasured", `World-knowledge field "facts[${index}].${factUnknown[0]}" is not legal`);
		}
		for (const key of ["claim", "evidence"] as const) {
			if (!string(fact[key])) {
				return failure(contract, "unmeasured", `World-knowledge field "facts[${index}].${key}" must be a non-empty string`);
			}
		}
		if (!Array.isArray(fact.sources)) {
			return failure(
				contract,
				"unmeasured",
				`World-knowledge field "facts[${index}].sources" must be an array of strings`,
			);
		}
		if (fact.sources.some((source) => !string(source))) {
			return failure(contract, "unmeasured", `World-knowledge field "facts[${index}].sources" must contain strings`);
		}
	}
	for (const field of ["synthesis", "uncertainties", "followUpVerification"] as const) {
		const entries = value[field];
		if (!Array.isArray(entries) || entries.some((entry) => !string(entry))) {
			return failure(contract, "unmeasured", `World-knowledge field "${field}" must be an array of non-empty strings`);
		}
	}
	return success(contract, "unmeasured", value);
}

function validateProvenance(contract: ResultContract, output: string | null): ResultContractValidation {
	const parsed = parseJson(output);
	if (!parsed.ok) return failure(contract, "unmeasured", parsed.reason);
	const value = parsed.value;
	const keys = ["confirmedFacts", "missingEvidence", "nextInspections"] as const;
	const unexpected = unexpectedResultKeyReason("Provenance result", value, keys);
	if (unexpected !== null) return failure(contract, "unmeasured", unexpected);
	for (const key of keys) {
		const entries = value[key];
		if (!Array.isArray(entries) || !entries.every((entry) => string(entry))) {
			return failure(contract, "unmeasured", `Provenance result ${key} must be an array of non-empty strings`);
		}
	}
	return success(contract, "unmeasured", value);
}

function validateArchitect(
	contract: Extract<ResultContract, { kind: "architect-plan" }>,
	input: ResultContractValidationInput,
): ResultContractValidation {
	const artifactPath = path.resolve(input.cwd, contract.path);
	const content = input.filesystem.readFile(artifactPath);
	if (content === null || content.trim().length === 0) {
		return failure(contract, "unmeasured", `required plan artifact is missing or empty: ${contract.path}`);
	}
	return success(contract, "unmeasured", {
		path: contract.path,
		artifactDigest: sha256Hex(content),
	});
}

export function validateResultContract(input: ResultContractValidationInput): ResultContractValidation {
	switch (input.contract.kind) {
		case "architect-plan":
			return validateArchitect(input.contract, input);
		case "scout-report": {
			const validation = validateScout(input.contract, input.output);
			if (validation.scout === undefined) return validation;
			const degradedReason = validation.scout.degradedReason;
			if (degradedReason !== undefined) {
				return groundDegradedScout(input.contract, input, validation.scout, degradedReason);
			}
			const citations = validateScoutCitations(input, validation.scout.citations);
			return citations.ok
				? success(
						input.contract,
						"pass",
						{ scout: validation.scout, evidence: citations.evidence },
						{ scout: validation.scout },
					)
				: failure(input.contract, "fail", citations.reason);
		}
		case "verifier-report":
			if (input.outputTruncated)
				return failure(input.contract, "fail", "Verifier report was truncated; shorten the report");
			return validateVerifier(input.contract, input.output, true, input.observedRunEffects?.proofs);
		case "judge-verdict":
			return validateJudgeVerdict(input.contract, input.output);
		case "review-verdict":
			if (input.outputTruncated)
				return failure(input.contract, "fail", "Review verdict was truncated; shorten the report");
			return validateVerifier(input.contract, input.output);
		case "council-report": {
			const report = parseCouncilReport(input.output);
			return report === null
				? failure(input.contract, "fail", "council-report is malformed")
				: success(input.contract, "unmeasured", { council: report });
		}
		case "council-ballot":
			return validateCouncilBallot(input.contract, input.output);
		case "debugger-report":
			return validateDebugger(input.contract, input.output);
		case "research-report":
			return validateResearch(input.contract, input.output, input.networkAllowed);
		case "world-knowledge-report":
			return validateWorldKnowledge(input.contract, input.output, input.networkAllowed);
		case "mutation-report":
			return validateMutation(input.contract, input);
		case "provenance-report":
			return validateProvenance(input.contract, input.output);
		case "delegation-plan": {
			const plan = parseDelegationPlanResult(input.output);
			return plan === null
				? failure(
						input.contract,
						"fail",
						"delegation-plan must carry tasks with id, agent, description, depends_on, writes, and optional mode",
					)
				: success(input.contract, "unmeasured", plan, { delegationPlan: plan });
		}
		case "oracle-report":
			return validateOracle(input.contract, input.output);
		case "external-delegation":
			return success(input.contract, "unmeasured", { external: true });
		case "text-report":
			return success(input.contract, "unmeasured", { text: true });
		case "artifact-report":
			return validateArtifactReport(input.contract, input);
		case "context-handbook":
			return validateContextHandbook(input.contract, input.output);
		case "code-report":
			return validateCodeReport(input.contract, input.output);
	}
}

/** Validate a recipe's final result and project it into receipt-safe facts. */
export function validateRecipeResult(input: ValidateRecipeResultInput): RecipeResultOutcome | null {
	if (input.contract === null) return null;
	if (!input.reachedTerminalResult) {
		return {
			applicable: false,
			fact: {
				sourceId: resultContractSourceId(input.contract),
				validatorDigest: digest({ contract: input.contract, reached: false }),
				conformance: "not-reached",
				quality: "unmeasured",
			},
		};
	}
	const validation = validateResultContract({
		contract: input.contract,
		output: input.output,
		cwd: input.cwd,
		networkAllowed: input.networkAllowed,
		filesystem: input.filesystem,
		...(input.observedRunEffects !== undefined ? { observedRunEffects: input.observedRunEffects } : {}),
		...(input.outputTruncated !== undefined ? { outputTruncated: input.outputTruncated } : {}),
	});
	return {
		applicable: true,
		validation,
		fact: {
			sourceId: validation.sourceId,
			validatorDigest: validation.validatorDigest,
			conformance: validation.conformance,
			quality: validation.quality,
		},
	};
}

/** Kinds an agent recipe may declare in its frontmatter. */
const RECIPE_DECLARABLE_KINDS = [
	"scout-report",
	"verifier-report",
	"review-verdict",
	"council-report",
	"debugger-report",
	"research-report",
	"world-knowledge-report",
	"mutation-report",
	"provenance-report",
	"oracle-report",
	"external-delegation",
	"artifact-report",
	"text-report",
	"context-handbook",
	"delegation-plan",
] as const;

/**
 * Kinds the coordinator authors and hands to a worker on the wire, which no
 * recipe may declare. A council ballot is the topology's postcondition for a
 * vote member's slot, so it arrives as a `resultContractOverride` on the
 * request and never out of frontmatter.
 */
const COORDINATOR_AUTHORED_KINDS = ["council-ballot", "judge-verdict"] as const;

function parseContract(
	value: unknown,
	sourcePath: string,
	kinds: ReadonlyArray<string>,
	callerBoundArtifacts = false,
): ResultContract {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`agent recipe: ${sourcePath}: resultContract must be an object`);
	}
	const record = value as Record<string, unknown>;
	if (typeof record.kind !== "string") throw new Error(`agent recipe: ${sourcePath}: resultContract.kind is required`);
	const keys = Object.keys(record);
	const only = (...allowed: string[]): boolean => keys.every((key) => allowed.includes(key));
	if (record.kind === "architect-plan") {
		if (!only("kind", "path") || !string(record.path)) {
			throw new Error(`agent recipe: ${sourcePath}: architect-plan requires only non-empty path`);
		}
		if (path.isAbsolute(record.path) || record.path.split(/[\\/]/u).includes("..")) {
			throw new Error(`agent recipe: ${sourcePath}: architect-plan path must be workspace-relative`);
		}
		return { kind: "architect-plan", path: record.path };
	}
	if (record.kind === "artifact-report" && callerBoundArtifacts) {
		if (!only("kind", "path")) {
			throw new Error(`agent recipe: ${sourcePath}: artifact-report admits only kind and path`);
		}
		if (record.path === undefined) return { kind: "artifact-report" };
		if (!string(record.path) || record.path.includes("\0")) {
			throw new Error(`agent recipe: ${sourcePath}: artifact-report requires a non-empty path without NUL`);
		}
		if (
			path.posix.isAbsolute(record.path) ||
			path.win32.isAbsolute(record.path) ||
			/^[a-z]:/iu.test(record.path) ||
			record.path.split(/[\\/]/u).includes("..")
		) {
			throw new Error(`agent recipe: ${sourcePath}: artifact-report path must be workspace-relative`);
		}
		return { kind: "artifact-report", path: record.path };
	}
	if (record.kind === "council-ballot" && kinds.includes("council-ballot") && record.options !== undefined) {
		const options = record.options;
		if (
			!only("kind", "options") ||
			!Array.isArray(options) ||
			options.length === 0 ||
			!options.every((option): option is string => typeof option === "string" && isCouncilBallotOption(option))
		) {
			throw new Error(
				`agent recipe: ${sourcePath}: council-ballot options must be a non-empty list of single-line verdicts of at most ${COUNCIL_BALLOT_VERDICT_MAX_BYTES} UTF-8 bytes`,
			);
		}
		return { kind: "council-ballot", options: [...options] };
	}
	if (record.kind === "mutation-report") {
		if (!only("kind", "maxSummaryBytes")) {
			throw new Error(`agent recipe: ${sourcePath}: mutation-report admits only kind and maxSummaryBytes`);
		}
		if (record.maxSummaryBytes === undefined) return { kind: "mutation-report" };
		try {
			return {
				kind: "mutation-report",
				maxSummaryBytes: parseResultSummaryMaxBytes(record.maxSummaryBytes, "maxSummaryBytes"),
			};
		} catch (error) {
			throw new Error(`agent recipe: ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// A gate's packet ids are coordinator-authored (M10): a WorkerSpec may carry them, a recipe may not.
	const packetIds = (): string[] | null | undefined => {
		const packet = record.packet;
		if (packet === undefined) return undefined;
		if (
			!callerBoundArtifacts ||
			!Array.isArray(packet) ||
			packet.length === 0 ||
			packet.length > 256 ||
			!packet.every((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256)
		)
			return null;
		return [...packet];
	};
	if (record.kind === "review-verdict" && kinds.includes(record.kind) && record.packet !== undefined) {
		const packet = packetIds();
		if (!only("kind", "packet") || packet === null || packet === undefined)
			throw new Error(`agent recipe: ${sourcePath}: review-verdict accepts only kind, and a WorkerSpec's packet ids`);
		return { kind: "review-verdict", packet };
	}
	if (record.kind === "judge-verdict" && kinds.includes(record.kind)) {
		const candidates = record.candidates;
		const packet = packetIds();
		if (
			!only("kind", "candidates", "packet") ||
			packet === null ||
			(candidates !== undefined &&
				(typeof candidates !== "number" || !Number.isSafeInteger(candidates) || candidates < 1 || candidates > 64))
		)
			throw new Error(
				`agent recipe: ${sourcePath}: judge-verdict accepts only kind, candidates (1..64) and a WorkerSpec's packet ids`,
			);
		return {
			kind: "judge-verdict",
			...(candidates !== undefined ? { candidates } : {}),
			...(packet !== undefined ? { packet } : {}),
		};
	}
	if (record.kind === "verifier-report" && kinds.includes(record.kind)) {
		if (!only("kind", "assurance") || (record.assurance !== undefined && !isHoareAssurance(record.assurance)))
			throw new Error(
				`agent recipe: ${sourcePath}: verifier-report accepts only kind and assurance (argued, modeled, mechanized)`,
			);
		return { kind: "verifier-report", ...(record.assurance !== undefined ? { assurance: record.assurance } : {}) };
	}
	if (!kinds.includes(record.kind) || !only("kind")) {
		throw new Error(`agent recipe: ${sourcePath}: resultContract.kind is unsupported or has unknown keys`);
	}
	return {
		kind: record.kind as Exclude<ResultContract["kind"], "architect-plan" | "mutation-report" | "judge-verdict">,
	};
}

/** Strict frontmatter parser for the one recipe result-contract schema. */
export function parseResultContract(value: unknown, sourcePath: string): ResultContract {
	return parseContract(value, sourcePath, RECIPE_DECLARABLE_KINDS);
}

/**
 * The same parser for a contract that arrived on a WorkerSpec. It admits what a
 * recipe may declare plus what the coordinator may author, because a dispatch
 * request can override the seated recipe's postcondition and the worker has to
 * be able to read the contract it will be validated against. Keeping the recipe
 * parser strict is the point: a recipe still cannot claim a coordinator's kind.
 */
export function parseWorkerResultContract(value: unknown, sourcePath: string): ResultContract {
	return parseContract(value, sourcePath, [...RECIPE_DECLARABLE_KINDS, ...COORDINATOR_AUTHORED_KINDS], true);
}
