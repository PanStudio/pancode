// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { stripAuthoredTrailers } from "../../core/commit-message.js";
import { type CompletionDeclaration, parseCompletionDeclaration } from "../../core/completion.js";
import { observedValidationCommand } from "../safety/protected-artifacts.js";
import {
	RESULT_COMMIT_MESSAGE_MAX_BYTES,
	resultContractOutputBytes,
	resultSummaryMaxBytes,
} from "./result-contract-allowance.js";
import { parseChecks } from "./result-contract-code-report.js";
import { failure, parseJson, string, success, unexpectedResultKeyReason } from "./result-contract-payload.js";
import { MUTATION_FAILURE_RULE } from "./result-contract-schema.js";
import type {
	ObservedRunEffects,
	ResultContract,
	ResultContractFilesystem,
	ResultContractValidation,
	ResultContractValidationInput,
} from "./result-contract-types.js";

/** Authored prose a work-product contract may carry beside its evidence. */
export interface ResultAuthorship {
	/** The agent's proposed commit message for the work it just produced. */
	commitMessage: string | null;
	/** One-line description, used to build a deterministic fallback message. */
	summary: string | null;
}

const AUTHORSHIP_FIELDS: ReadonlyArray<keyof ResultAuthorship> = ["commitMessage", "summary"];

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code === 0x7f) return true;
		if (code < 0x20 && character !== "\n" && character !== "\r" && character !== "\t") return true;
	}
	return false;
}

function normalizeAuthored(value: string): string {
	return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").trim();
}

/**
 * Optional authored fields, checked only for shape. Code owns committing; the
 * agent only supplies the sentence, so the sentence is bounded and free of the
 * control characters that would make a commit log unreadable.
 */
function validateAuthorship(value: Record<string, unknown>, summaryMaxBytes: number): string | null {
	for (const field of AUTHORSHIP_FIELDS) {
		const maxBytes = field === "summary" ? summaryMaxBytes : RESULT_COMMIT_MESSAGE_MAX_BYTES;
		const raw = value[field];
		// Absent, null, and blank are three spellings of the same thing: nothing
		// was authored. `ResultAuthorship` types the field `string | null` and
		// `resultContractAuthorship` already normalizes a blank to null, so
		// failing here on a spelling this contract's own reader accepts ends a
		// finished run over an optional field the agent correctly left empty.
		if (raw === undefined || raw === null) continue;
		if (typeof raw !== "string") return `${field} must be a string when present`;
		if (raw.trim().length === 0) continue;
		const bytes = Buffer.byteLength(raw, "utf8");
		if (bytes > maxBytes) return `${field} must be at most ${maxBytes} UTF-8 bytes (${bytes} given)`;
		// Tab, newline, and carriage return are the only control bytes a message
		// may carry; anything else would corrupt the log it lands in.
		if (hasControlCharacters(raw)) return `${field} must not contain control characters`;
	}
	return null;
}

/**
 * Read the authored commit message and summary from a terminal result.
 *
 * Only work-product contracts carry them: `mutation-report` validates them
 * strictly as optional fields, and `architect-plan` reads them from a JSON
 * answer if one was given, because that contract's postcondition is the plan
 * artifact and its final text has never been constrained. Anything unreadable
 * is simply absent, which the caller turns into its deterministic fallback
 * rather than into a failed commit.
 */
export function resultContractAuthorship(contract: ResultContract, output: string | null): ResultAuthorship {
	const empty: ResultAuthorship = { commitMessage: null, summary: null };
	if (contract.kind !== "mutation-report" && contract.kind !== "architect-plan") return empty;
	const parsed = parseJson(output);
	if (!parsed.ok || validateAuthorship(parsed.value, resultSummaryMaxBytes(contract)) !== null) return empty;
	const read = (field: keyof ResultAuthorship): string | null => {
		const raw = parsed.value[field];
		if (typeof raw !== "string") return null;
		const normalized = normalizeAuthored(raw);
		// Only PanCode's managed prepare-commit-msg hook writes trailers. A worker
		// typing `PanCode-Evidence:` or `Co-authored-by:` must not reach the log.
		const authored = field === "commitMessage" ? stripAuthoredTrailers(normalized) : normalized;
		return authored.length === 0 ? null : authored;
	};
	return { commitMessage: read("commitMessage"), summary: read("summary") };
}

/** What a mutation report says about checks, read from the parsed result. */
export interface MutationReportChecks {
	/** Checks the worker named but did not run, in report order. */
	declaredChecks: string[];
	/** True when at least one executed validation entry reports passed. */
	validationPassed: boolean;
}

export function mutationReportPaths(contract: ResultContract, output: string | null): string[] {
	if (contract.kind !== "mutation-report") return [];
	const parsed = parseJson(output);
	if (!parsed.ok || !Array.isArray(parsed.value.mutatedPaths)) return [];
	return parsed.value.mutatedPaths.filter((entry): entry is string => string(entry));
}

/**
 * Read `declaredChecks` and whether any validation passed from a mutation
 * report. Anything unreadable or of another kind reads as no claim, so the
 * caller never withholds work over a report it could not parse.
 */
export function mutationReportChecks(contract: ResultContract, output: string | null): MutationReportChecks {
	const none: MutationReportChecks = { declaredChecks: [], validationPassed: false };
	if (contract.kind !== "mutation-report") return none;
	const parsed = parseJson(output);
	if (!parsed.ok) return none;
	const declared = parsed.value.declaredChecks;
	const validations = parsed.value.validations;
	return {
		declaredChecks: Array.isArray(declared) ? declared.filter((entry): entry is string => string(entry)) : [],
		validationPassed:
			Array.isArray(validations) &&
			validations.some(
				(entry) =>
					entry !== null &&
					typeof entry === "object" &&
					(entry as Record<string, unknown>).passed === true &&
					!isBaselineValidation(entry),
			),
	};
}

/**
 * Whether a reported validation entry is a baseline, a deliberate run before the change. Quality judges only the
 * checks run on the changed tree, so every reader of a report's validations applies this one rule: a baseline may be
 * shown as a baseline, never counted as a pass or a failure of the work (bt-17).
 */
export function isBaselineValidation(entry: unknown): boolean {
	return entry !== null && typeof entry === "object" && (entry as Record<string, unknown>).baseline === true;
}

/**
 * Whether a reported failure names a check whose latest verify receipt sealed could-not-run, matched by that receipt's
 * check id or resolved command: a usage or startup error ran nothing, so it is never a failed validation (L10).
 */
function reportedNotRun(name: string, notRunChecks: ReadonlySet<string> | undefined): boolean {
	// A verify spelling matches as written; only a command reading drops shell output plumbing.
	return notRunChecks?.has(name.trim()) === true || notRunChecks?.has(observedValidationCommand(name)) === true;
}

/**
 * Named failures in the worker's mutation report, without inferring unreported checks. A failure on a check the run's
 * own receipt sealed could-not-run is left out, so the worker's word cannot hold a merge on it alone (L10).
 */
export function mutationReportFailures(
	contract: ResultContract | null,
	output: string | null,
	notRunChecks?: ReadonlySet<string>,
): string[] {
	if (contract?.kind !== "mutation-report") return [];
	const parsed = parseJson(output);
	if (!parsed.ok || !Array.isArray(parsed.value.validations)) return [];
	return parsed.value.validations.flatMap((entry: unknown) => {
		if (entry === null || typeof entry !== "object") return [];
		const check = entry as Record<string, unknown>;
		return check.passed === false &&
			!isBaselineValidation(check) &&
			string(check.name) &&
			!reportedNotRun(check.name as string, notRunChecks)
			? [check.name as string]
			: [];
	});
}

/** Paths this run wrote, as workspace-relative names, for a validator reason. */
function describeWriteSet(effects: ObservedRunEffects, cwd: string): string {
	if (effects.mutatedPaths.size === 0) return "this run wrote nothing";
	const written = [...effects.mutatedPaths]
		.map((target) => path.relative(cwd, target) || target)
		.sort()
		.slice(0, MUTATION_WRITE_SET_REASON_LIMIT);
	const more = effects.mutatedPaths.size - written.length;
	return `this run wrote ${written.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

/** Written paths quoted back in one validator reason before it is truncated. */
const MUTATION_WRITE_SET_REASON_LIMIT = 8;

/**
 * Whether anything is at this location. Without a presence check the validator
 * cannot tell a fabricated path from a directory or an unreadable file, so it
 * answers yes and lets the quality label carry the doubt.
 */
function pathIsPresent(filesystem: ResultContractFilesystem, target: string): boolean {
	if (filesystem.pathExists === undefined) return true;
	return filesystem.pathExists(target);
}

/** One `validations` entry, quoted by every reason that rejects the array. */
const MUTATION_VALIDATION_EXAMPLE = '{"name":"npm test","passed":true,"evidence":"exit 0"}';

/**
 * Why a `validations` array was refused, in terms the model can act on. Naming
 * the requirement was not enough for a small local model (#74): a run that
 * emitted `"validations":[]` read the reason as satisfied, spent both repair
 * rounds re-emitting the same empty array, and failed `result_contract_exhausted`.
 * The two ways to get this wrong need different corrections, so each reason
 * says which one happened and shows the entry that would have passed.
 */
function mutationValidationsReason(): string {
	return `Mutation result must carry executed validation results: every validations entry is shaped like ${MUTATION_VALIDATION_EXAMPLE}, with a string name, a boolean passed, a string evidence, a boolean baseline on every passed:false entry (optional on a pass), and no other keys. ${MUTATION_FAILURE_RULE} Use validations:[] when no check executed. Put source reads and edit observations in observations, and checks not run in declaredChecks; neither carries passed.`;
}

/**
 * The first failing validation that does not say whether it is a baseline. Quality cannot tell a deliberate red run
 * before the change from a failure of the changed tree without the worker's word, and guessing either way is wrong:
 * one fails finished work, the other clears a real red. So the report is refused and repaired instead.
 */
function unmarkedFailureReason(validations: ReadonlyArray<unknown>): string | null {
	// parseChecks already admitted every entry as an object, so each reads as a record here.
	const entry = (validations as ReadonlyArray<Record<string, unknown>>).find(
		(check) => check.passed === false && check.baseline === undefined,
	);
	if (entry === undefined) return null;
	const name = string(entry.name) ? ` ${JSON.stringify((entry.name as string).slice(0, 120))}` : "";
	return `Mutation result validations entry${name} has passed:false without baseline. ${MUTATION_FAILURE_RULE}`;
}

/**
 * A tool route validates a schema-coerced copy of its arguments, so a "true", 1 or null baseline would reach the
 * contract as a boolean and could clear a real red. The submitted arguments must carry a JSON boolean; anything else
 * is refused with the same rule, so the bounded repair asks again.
 */
export function nonBooleanBaselineReason(submitted: unknown): string | null {
	if (submitted === null || typeof submitted !== "object" || Array.isArray(submitted)) return null;
	const validations = (submitted as Record<string, unknown>).validations;
	if (!Array.isArray(validations)) return null;
	const entry = validations.find(
		(check): check is Record<string, unknown> =>
			check !== null && typeof check === "object" && "baseline" in check && typeof check.baseline !== "boolean",
	);
	if (entry === undefined) return null;
	const name = string(entry.name) ? ` ${JSON.stringify((entry.name as string).slice(0, 120))}` : "";
	return `Mutation result validations entry${name} has a baseline that is not a JSON boolean. ${MUTATION_FAILURE_RULE}`;
}

/**
 * A mutation report states what the run changed and what it validated. Shape
 * alone cannot tell either claim from an invention, and the shape example this
 * module prints ends up echoed verbatim by small models, so a run that touched
 * nothing has sealed `mutatedPaths: ["src/file.ts"]` as conforming fact.
 *
 * Where the run's own effects were observed, each reported path is measured
 * against them:
 *   - in the write set                   -> the run did this, and it is verified
 *   - its only attempt came back refused -> the run's own tool result says the
 *     write did not land, so the claim is false however the file looks on disk
 *   - absent from it but present on disk -> the run may have written it through
 *     a channel no tool event enumerates, so this is not a failure, but it is
 *     not verified either
 *   - absent from both                   -> nothing this run did could have
 *     produced it, which is a failed postcondition, not a quality signal
 *
 * Quality follows the same rule as conformance. A reported validation the run
 * never ran is not correctness evidence, so it seals `unmeasured` (the label
 * this module already uses for "nothing here can be measured") instead of
 * pass. A self-reported failure still seals `fail`: an agent reporting against
 * its own interest is the one claim here that needs no corroboration.
 */
/** Why a builder report's required `completion` field is missing or malformed, or null when it declares (DESIGN 4.3). */
function completionFieldReason(label: string, value: Record<string, unknown>): string | null {
	if (value.completion === undefined)
		return `${label} must carry completion: {"state":"done|partly_done|not_done","limitations":[{"what":"...","why":"..."}],"unverified":["..."]}`;
	const parsed = parseCompletionDeclaration(value.completion);
	return parsed.ok ? null : `${label} ${parsed.reason}`;
}

/** The report kinds a builder hands back, each of which must declare its completion (DESIGN 4.3). */
function isBuilderReportKind(kind: string | null | undefined): boolean {
	return kind === "mutation-report" || kind === "artifact-report";
}

/**
 * The completion a builder report declares, or null when the contract is not a builder report or the output does not
 * carry a valid declaration. The grader reads this typed field and never the report's prose.
 */
export function builderReportCompletion(
	contract: ResultContract | null,
	output: string | null,
): CompletionDeclaration | null {
	if (contract === null || !isBuilderReportKind(contract.kind)) return null;
	const parsed = parseJson(output);
	if (!parsed.ok) return null;
	const completion = parseCompletionDeclaration(parsed.value.completion);
	return completion.ok ? completion.completion : null;
}

export function validateArtifactReport(
	contract: Extract<ResultContract, { kind: "artifact-report" }>,
	input: ResultContractValidationInput,
): ResultContractValidation {
	const parsed = parseJson(input.output);
	if (!parsed.ok) return failure(contract, "unmeasured", parsed.reason);
	const unexpected = unexpectedResultKeyReason("Artifact result", parsed.value, ["completion", "summary"]);
	if (unexpected !== null) return failure(contract, "unmeasured", unexpected);
	const completion = completionFieldReason("Artifact result", parsed.value);
	if (completion !== null) return failure(contract, "unmeasured", completion);
	const summary = parsed.value.summary;
	if (summary !== undefined && summary !== null && typeof summary !== "string")
		return failure(contract, "unmeasured", "Artifact result summary must be a string when present");
	if (contract.path !== undefined) {
		const content = input.filesystem.readFile(path.resolve(input.cwd, contract.path));
		if (content === null) {
			return failure(
				contract,
				"unmeasured",
				`Required artifact is missing or unreadable: ${JSON.stringify(contract.path)}`,
			);
		}
		if (content.trim().length === 0) {
			return failure(contract, "unmeasured", `Required artifact is empty: ${JSON.stringify(contract.path)}`);
		}
	}
	// A preexisting seed can satisfy the path check; correctness and freshness remain the caller's responsibility.
	return success(contract, "unmeasured", { artifact: true });
}

export function validateMutation(
	contract: ResultContract,
	input: ResultContractValidationInput,
): ResultContractValidation {
	// A clipped result is incomplete whatever its head happens to parse as; the
	// bound is named so the repair is about length, not JSON.
	if (input.outputTruncated === true && input.output !== null) {
		const bound = resultContractOutputBytes(contract) ?? Buffer.byteLength(input.output, "utf8");
		return failure(
			contract,
			"unmeasured",
			`result exceeded the sealed output bound of ${bound} bytes and was truncated; keep summary within ${resultSummaryMaxBytes(contract)} UTF-8 bytes or state the limitation`,
		);
	}
	const parsed = parseJson(input.output);
	if (!parsed.ok) return failure(contract, "unmeasured", parsed.reason);
	const value = parsed.value;
	const unexpected = unexpectedResultKeyReason("Mutation result", value, [
		"mutatedPaths",
		"validations",
		"observations",
		"declaredChecks",
		"commitMessage",
		"summary",
		"completion",
	]);
	if (unexpected !== null) return failure(contract, "unmeasured", unexpected);
	const completion = completionFieldReason("Mutation result", value);
	if (completion !== null) return failure(contract, "unmeasured", completion);
	if (!Array.isArray(value.mutatedPaths) || value.mutatedPaths.some((entry) => !string(entry))) {
		return failure(contract, "unmeasured", "Mutation result mutatedPaths must be an array of non-empty path strings");
	}
	for (const key of ["observations", "declaredChecks"] as const) {
		const entries = value[key];
		if (entries !== undefined && (!Array.isArray(entries) || !entries.every((entry) => string(entry)))) {
			return failure(
				contract,
				"unmeasured",
				`Mutation result ${key} must be an array of non-empty strings${typeof entries === "string" ? ", not a string" : ""}`,
			);
		}
	}
	const authorship = validateAuthorship(value, resultSummaryMaxBytes(contract));
	if (authorship !== null) return failure(contract, "unmeasured", authorship);
	const reported =
		Array.isArray(value.validations) && value.validations.length === 0 ? [] : parseChecks(value.validations);
	if (reported === null) return failure(contract, "unmeasured", mutationValidationsReason());
	const unmarked = unmarkedFailureReason(value.validations as ReadonlyArray<unknown>);
	if (unmarked !== null) return failure(contract, "unmeasured", unmarked);
	// A baseline ran before the change, so quality judges only the checks run on the changed tree (bt-17).
	const validations = reported.filter((check) => !isBaselineValidation(check));
	// Settle a historical failure only with a matching observed final pass.
	// Missing evidence keeps old, potentially nonchronological reports conservative.
	// Verify calls count as bash checks do: a green claim against a red latest verify is a failure (bt-27).
	const outcomes = input.observedRunEffects?.checkOutcomes ?? input.observedRunEffects?.validationOutcomes;
	const effectsNotRun = input.observedRunEffects?.notRunChecks;
	// A reported baseline excuses its own observed red only while no mutation was observed: after one, every
	// standing outcome judged the changed tree, and calling it a baseline cannot clear a real failure (bt-27).
	const baselines = new Set(
		input.observedRunEffects?.mutationObserved === false
			? reported.filter(isBaselineValidation).map((check) => observedValidationCommand(check.name))
			: [],
	);
	const reportedFailure =
		validations.some((check) => {
			if (check.passed) return false;
			const observed = outcomes?.get(observedValidationCommand(check.name));
			return observed !== true && !(observed === undefined && reportedNotRun(check.name, effectsNotRun));
		}) || [...(outcomes ?? [])].some(([name, passed]) => !passed && !baselines.has(name));
	const effects = input.observedRunEffects;
	if (effects === undefined)
		return success(contract, reportedFailure ? "fail" : validations.length > 0 ? "pass" : "unmeasured", value);
	const cwd = path.resolve(input.cwd);
	let unverifiedMutation = false;
	for (const reported of value.mutatedPaths as ReadonlyArray<string>) {
		const target = path.resolve(cwd, reported);
		if (effects.mutatedPaths.has(target)) continue;
		if (effects.failedMutationPaths.has(target)) {
			return failure(
				contract,
				"unmeasured",
				`Mutation result names a path whose only write this run attempted was refused: ${reported} (${describeWriteSet(effects, cwd)})`,
			);
		}
		if (pathIsPresent(input.filesystem, target)) {
			unverifiedMutation = true;
			continue;
		}
		return failure(
			contract,
			"unmeasured",
			`Mutation result names a path this run never wrote and that does not exist: ${reported} (${describeWriteSet(effects, cwd)})`,
		);
	}
	if (reportedFailure) return success(contract, "fail", value);
	const measured = validations.length > 0 && !unverifiedMutation && effects.validationCommands.size > 0;
	return success(contract, measured ? "pass" : "unmeasured", value);
}
