// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { resolve } from "node:path";
import { isNonSourcePath, isProsePath } from "../../core/test-paths.js";
import { ToolNames } from "../../core/tool-names.js";
import { sanitizeCallTargetText } from "../../lib/call-target/call-target.js";
import { redactSecretString } from "../../lib/secrets/redaction.js";
import type { DeclaredCheckSourceRef } from "../../tools/verify/catalog.js";
import { assessQualityPolicy, loadQualityPolicy, type QualityFinding } from "../../tools/verify/quality-policy.js";
import type { UserTaskAcceptance } from "../user-tasks/acceptance.js";
import { callVerdict } from "./check-classifier.js";
import type { DeclaredVerifierCommand } from "./declared-checks.js";
import {
	acceptanceCheckPassed,
	declaredVerifierCommands,
	isPancodeConfigurationPath,
	isWithinWorkspace,
} from "./declared-checks.js";
import {
	asRecord,
	capabilityEntries,
	DEFAULT_RECENT_ENTRY_LIMIT,
	latestUserText,
	operatorRequestedDeletion,
	recentEntries,
} from "./finish-entries.js";
import { changedFilesRunAfterEdit } from "./finish-executed-files.js";
import { collectLimitationEvidence, verifyFoundNoChecks } from "./finish-limitations.js";
import { mutatingReceipts } from "./finish-mutations.js";
import { collectValidationEvidence } from "./finish-validation-evidence.js";
import { type RunCheckFacts, runCheckFacts } from "./observed-checks.js";
import type { Rigor } from "./rigor.js";

export const FINISH_CONTRACT_ADVISORY_MESSAGE =
	"[PanCode] finish-contract advisory: you changed files this turn without recording validation evidence or a limitation receipt. Report the change as unverified. Run checks only within the operator's authorized scope; this advisory does not authorize tests, scripts, or additional tools.";

/**
 * Appended to the advisory when the workspace declares checks the turn did not
 * run in a form the contract can credit; the footer turns it into a `verify` hint.
 */
export const FINISH_CONTRACT_DECLARED_CHECKS_PREFIX = " Declared checks: ";

/** Appended for checks the caller declared for this run only (`run --verify`), which `verify` does not know. */
export const FINISH_CONTRACT_RUN_CHECKS_PREFIX = " Run checks: ";

/**
 * Appended for changed files a successful command ran after their last edit,
 * such as `python3 src/clean.py`. Running a file is not a check, so the change
 * stays unverified, but the footer must not say nothing ran.
 */
export const FINISH_CONTRACT_RAN_CHANGED_PREFIX = " Ran after the edit: ";

/**
 * Appended when checks passed in this turn but a later call that may change the tree (a commit and its hooks, a
 * write) came after them (FX-5): they no longer describe the tree, and one run after that call would.
 */
export const FINISH_CONTRACT_RETIRED_SUFFIX =
	" Checks passed earlier in this turn, but a later call that may change the tree came after them; run a check after the last change.";

/** The operator's words for passes a later change retired, shared by the footer and the assessed-done note (FX-5). */
export function retiredChecksNote(retired: { checks: ReadonlyArray<string>; change: string }): string {
	const [first = "a check"] = retired.checks;
	const more = retired.checks.length > 1 ? ` and ${retired.checks.length - 1} more` : "";
	return `${first}${more} passed before ${retired.change}, and no check ran after it`;
}

/** The longest failed-check label the operator sees; a longer observed command is cut with an ellipsis. */
const FAILED_CHECK_LABEL_MAX = 120;

export const FINISH_CONTRACT_COVERAGE_ADVISORY_MESSAGE =
	"[PanCode] finish-contract advisory: checks passed; behavior coverage unverified. Passing receipts establish the recorded checks, not every changed behavior. This is a reporting advisory; finish without automatically running additional checks. It grants no additional authority.";

/** Checks passed, but a check's last outcome since the last change is red, as the receipt seals it (bt-44). */
export const FINISH_CONTRACT_FAILED_CHECK_ADVISORY_MESSAGE =
	"[PanCode] finish-contract advisory: a check failed after the last change; behavior coverage unverified. Its red outcome stands in the receipt beside any passing check. This is a reporting advisory; finish without automatically running additional checks. It grants no additional authority.";

export const FINISH_CONTRACT_EVIDENCE_SCOPE_ADVISORY_MESSAGE =
	"[PanCode] finish-contract advisory: validation evidence recorded; behavior coverage unverified. This is a reporting advisory; finish without automatically running additional checks. It grants no additional authority.";

export type FinishContractEvidenceKind =
	| "validation_command"
	| "protected_artifact"
	| "dispatch_run_record"
	| "limitation";

export interface ValidationExecutionEvidence {
	source?: DeclaredCheckSourceRef;
	cwd?: string;
	argv?: ReadonlyArray<string>;
	durationMs?: number;
}

export interface FinishContractEvidence extends ValidationExecutionEvidence {
	kind: FinishContractEvidenceKind;
	summary: string;
	check?: string;
	paths?: ReadonlyArray<string>;
	turnId?: string;
}

/** CLB-3: declared checks and freshness are useful evidence, but neither records runtime behavior coverage. */
export interface FinishContractVerificationScope {
	behaviorCoverage: "unknown";
	passedChecks: ReadonlyArray<string>;
	acceptance: ReadonlyArray<{ check: string; state: "passed" | "limited" | "unverified" }>;
	limitations: ReadonlyArray<FinishContractEvidence>;
}

/** Why the contract settled. Every branch is auditable from the ledger alone. */
export type FinishContractReason =
	| "no_mutation"
	| "no_net_mutation"
	| "deletion_only"
	| "prose_only"
	| "validation_evidence"
	| "explicit_limitation"
	| "no_checks_declared"
	| "unvalidated_mutation";

export type FinishContractAssessment =
	| {
			kind: "ok";
			reason:
				| "no_mutation"
				| "no_net_mutation"
				| "deletion_only"
				| "prose_only"
				| "validation_evidence"
				| "explicit_limitation"
				| "no_checks_declared";
			evidence: ReadonlyArray<FinishContractEvidence>;
			mutatedPaths: ReadonlyArray<string>;
			quality?: ReadonlyArray<QualityFinding>;
			verificationScope?: FinishContractVerificationScope;
			advisory?: string;
	  }
	| {
			kind: "engage";
			reason: "unvalidated_mutation";
			message: string;
			evidence: ReadonlyArray<FinishContractEvidence>;
			mutatedPaths: ReadonlyArray<string>;
			quality?: ReadonlyArray<QualityFinding>;
			verificationScope?: FinishContractVerificationScope;
			/**
			 * Checks that ran on the tree the last change left and came back red, as operator-safe labels (secrets
			 * redacted, one line, capped). Operator status only: never part of `message`, which reaches the model (CLI-P54).
			 */
			failedAfterEdit?: ReadonlyArray<string>;
			/**
			 * Passes this turn recorded that a later change retired, and that change, as operator-safe labels (FX-5). Operator
			 * status only, like `failedAfterEdit`; `message` says it without the labels.
			 */
			retiredBy?: { checks: ReadonlyArray<string>; change: string };
			/** The project quality policy could not be read, so `message` says why rather than naming checks. */
			policyUnassessable?: true;
	  };

/** A check declared for this session that has no project catalog entry, such as `run --verify`. */
export interface SessionVerifier {
	id: string;
	/** A shell command string, run through the platform shell. */
	command: string;
}

export interface FinishContractInput {
	sessionEntries?: ReadonlyArray<unknown>;
	/** Checks declared for this session only (`run --verify`); they join the project catalog's. */
	sessionVerifiers?: ReadonlyArray<SessionVerifier>;
	assistantTurnId?: string | null;
	recentEntryLimit?: number;
	/**
	 * The user row a step pipeline began at (bt-12 #4): the window runs from it to the assistant turn, past the
	 * continuation rows in between and past `recentEntryLimit`, so the turn that ends the pipeline sees every step.
	 */
	windowStartTurnId?: string;
	rigor?: Rigor;
	activeAcceptance?: UserTaskAcceptance;
	/** Owning session workspace, supplied by the finish registration. */
	workspaceRoot?: string;
	/**
	 * Mutation targets whose state at turn end matches what it was before the
	 * turn first touched them: a create-then-delete probe changed nothing.
	 */
	unchangedPaths?: ReadonlySet<string>;
	/** The run's one git helper answer at `workspaceRoot` (`gitRunsConfiguredHelpers`); absent, the replay reads it. */
	readGitHelpers?: () => boolean;
}

export interface ToolCallEvidenceCandidate {
	turnId?: string;
	toolCallId: string;
	command: string;
	check?: string;
	paths?: string[];
	execution?: ValidationExecutionEvidence;
}

export interface MutationCandidate {
	toolCallId: string;
	paths: string[];
	/** Targets the call wrote or created, as opposed to only removed. */
	writes: string[];
	/** Writes that stand even when the call exits nonzero ({@link heredocDataWriteTargets}). */
	settledWrites: string[];
	/** The targets are a shell command's, read from its text rather than named by a tool. */
	shell: boolean;
}

/**
 * Action-scoped completion contract. The engine keys off what the turn actually
 * DID, not how the prompt was phrased: it engages only when the recent window
 * mutated workspace state and then settled (turn_end) without recording
 * validation evidence or a limitation receipt. The turn settling is itself
 * the completion signal, so the model never has to type "done" to be gated, and
 * a work request phrased as a question cannot bypass the gate.
 *
 * Decision order (pure function of ledger receipts):
 *   1. no mutating receipt in the window        -> ok/no_mutation
 *   2. validation evidence present              -> ok/validation_evidence, with bounded scope advisory
 *   3. successful `limitation` receipt present  -> ok/explicit_limitation
 *      or verify reported no declared check     -> ok/no_checks_declared
 *   4. only prose written, or only non-source removed -> ok/prose_only or ok/deletion_only
 *   5. otherwise                                -> engage/unvalidated_mutation
 *
 * The assistant's prose never enters the decision. A limitation counts only
 * as a `limitation` tool_call paired with a non-error tool_result inside the
 * same window the mutation scan uses, so a run cannot satisfy the contract by
 * wording alone and a real limitation is never missed for its phrasing.
 */
export function assessFinishContract(input: FinishContractInput): FinishContractAssessment {
	const scope = assessmentScope(input);
	const assessment = assessMutationFinishContract(input, scope);
	if (
		assessment.mutatedPaths.length === 0 ||
		assessment.reason === "deletion_only" ||
		assessment.reason === "prose_only"
	)
		return assessment;
	const limitations = assessment.evidence.filter((item) => item.kind === "limitation");
	const passedChecks = [
		...assessment.evidence.filter((item) => item.kind === "validation_command").map((item) => item.check ?? item.summary),
		...(assessment.quality?.filter((finding) => finding.state === "passed").map((finding) => finding.check) ?? []),
	];
	const limited = new Set(limitations.flatMap((item) => item.paths ?? []));
	const verificationScope: FinishContractVerificationScope = {
		behaviorCoverage: "unknown",
		passedChecks: [...new Set(passedChecks)],
		acceptance: (input.activeAcceptance?.verification ?? []).map((required) => ({
			check: required.check,
			state: assessment.evidence.some((item) => acceptanceCheckPassed(item, required, input.workspaceRoot))
				? "passed"
				: limited.has(required.check)
					? "limited"
					: "unverified",
		})),
		limitations,
	};
	// CLB-3: an OK decision permits completion; it is not a correctness verdict.
	// No current receipt describes runtime behavior coverage, including a fresh
	// quality snapshot or a pass for an explicitly requested acceptance check.
	const hasPassedChecks = passedChecks.length > 0;
	const hasEvidence = hasPassedChecks || assessment.evidence.some((item) => item.kind !== "limitation");
	return {
		...assessment,
		verificationScope,
		...(assessment.kind === "ok" && hasEvidence
			? {
					advisory: !hasPassedChecks
						? FINISH_CONTRACT_EVIDENCE_SCOPE_ADVISORY_MESSAGE
						: checkFailedSinceLastChange(input, scope)
							? FINISH_CONTRACT_FAILED_CHECK_ADVISORY_MESSAGE
							: FINISH_CONTRACT_COVERAGE_ADVISORY_MESSAGE,
				}
			: {}),
	};
}

/** The window one assessment reads, with its declared checks and the shared fold over it, each read at most once. */
interface AssessmentScope {
	window: ReadonlyArray<unknown>;
	declared(): ReadonlyArray<DeclaredVerifierCommand>;
	/** The shared classifier's replay of the window, run once per assessment for every consumer (x8-6). */
	facts(): RunCheckFacts;
}

function assessmentScope(input: FinishContractInput): AssessmentScope {
	const window = recentEntries(
		input.sessionEntries ?? [],
		input.assistantTurnId ?? null,
		input.recentEntryLimit ?? DEFAULT_RECENT_ENTRY_LIMIT,
		input.windowStartTurnId,
	);
	let declared: DeclaredVerifierCommand[] | undefined;
	let facts: RunCheckFacts | undefined;
	const scope: AssessmentScope = {
		window,
		declared: () => {
			declared ??= declaredVerifierCommands(input.workspaceRoot, input.sessionVerifiers);
			return declared;
		},
		facts: () => {
			const root = resolve(input.workspaceRoot ?? ".");
			facts ??= runCheckFacts(
				window,
				root,
				[...scope.declared(), ...acceptanceScriptChecks(input, root)],
				input.readGitHelpers?.(),
			);
			return facts;
		},
	};
	return scope;
}

/**
 * The package scripts only the operator's acceptance admits as checks (`npm run custom`), declared to the fold so
 * their freshness is read with every other check's.
 */
function acceptanceScriptChecks(input: FinishContractInput, root: string): DeclaredVerifierCommand[] {
	return (input.activeAcceptance?.verification ?? []).flatMap(({ check }) => {
		const words = ["npm", "run", check];
		if (!/^[a-z0-9][a-z0-9._:-]*$/u.test(check) || callVerdict(ToolNames.Bash, { command: words.join(" ") }) === "check")
			return [];
		return [{ id: check, segments: [words], cwd: root, session: true }];
	});
}

/**
 * Whether a check's last outcome since the run's last change is red, read by the shared classifier's replay as the
 * run-effects recorder seals it, so the notice never says checks passed beside a red the receipt keeps (bt-44).
 */
/** Whether a check's last outcome is red with no change since it ran: a declared `done` over it is `partly_done`. */
export function standingFailedCheck(input: FinishContractInput): boolean {
	return checkFailedSinceLastChange(input, assessmentScope(input));
}

function checkFailedSinceLastChange(input: FinishContractInput, scope: AssessmentScope): boolean {
	if (input.workspaceRoot === undefined) return false;
	// Only a failed result can seal a red, so an all-green window skips the replay's reads.
	if (!capabilityEntries(scope.window).some(failedResult)) return false;
	return scope.facts().failing.length > 0;
}

/** The reds that ran on the tree the last change left, as labels safe for an operator surface. */
function failedAfterEditLabels(input: FinishContractInput, scope: AssessmentScope): string[] {
	if (input.workspaceRoot === undefined || !capabilityEntries(scope.window).some(failedResult)) return [];
	return [...new Set(scope.facts().failedAfterChange.map(operatorLabel))].filter((label) => label.length > 0);
}

/** One check or command as a label safe for an operator surface: secrets redacted, one line, capped. */
function operatorLabel(text: string): string {
	const label = sanitizeCallTargetText(redactSecretString(text)).trim();
	return label.length > FAILED_CHECK_LABEL_MAX ? `${label.slice(0, FAILED_CHECK_LABEL_MAX - 1)}…` : label;
}

/** The passes a later change retired, with that change, as operator-safe labels; null when none did (FX-5). */
function retiredLabels(
	input: FinishContractInput,
	scope: AssessmentScope,
): { checks: string[]; change: string } | null {
	const retired = input.workspaceRoot === undefined ? undefined : scope.facts().retired;
	if (retired === undefined) return null;
	const checks = [...new Set(retired.checks.map(operatorLabel))].filter((label) => label.length > 0);
	const change = operatorLabel(retired.change);
	return checks.length > 0 && change.length > 0 ? { checks, change } : null;
}

function failedResult(entry: unknown): boolean {
	const record = asRecord(entry);
	if (record?.kind === "bashExecution") return typeof record.exitCode === "number" && record.exitCode !== 0;
	if (record?.kind !== "message" || record.role !== "tool_result") return false;
	const payload = asRecord(record.payload);
	const result = asRecord(payload?.result);
	const details = asRecord(result?.details);
	return (
		payload?.isError === true ||
		payload?.error === true ||
		result?.kind === "error" ||
		details?.kind === "error" ||
		(typeof details?.exitCode === "number" && details.exitCode !== 0) ||
		asRecord(details?.chainAdmission)?.outcome === "error" ||
		payload?.outcome === "error"
	);
}

function assessMutationFinishContract(input: FinishContractInput, scope: AssessmentScope): FinishContractAssessment {
	const sessionEntries = input.sessionEntries ?? [];
	const assistantTurnId = input.assistantTurnId ?? null;
	const { window } = scope;

	const { paths: touchedPaths, written } = mutatingReceipts(
		window,
		input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : undefined,
	);
	if (touchedPaths.length === 0) {
		return { kind: "ok", reason: "no_mutation", evidence: [], mutatedPaths: touchedPaths };
	}
	const unchanged = input.unchangedPaths;
	// The contract guards workspace state. A note written outside the workspace
	// is not a code change that needs validation evidence.
	const inWorkspace = input.workspaceRoot
		? touchedPaths.filter((path) => isWithinWorkspace(path, input.workspaceRoot as string))
		: touchedPaths;
	const mutatedPaths = inWorkspace.filter(
		(path) => !unchanged?.has(path) && !isPancodeConfigurationPath(path, input.workspaceRoot),
	);
	if (mutatedPaths.length === 0) {
		return { kind: "ok", reason: "no_net_mutation", evidence: [], mutatedPaths };
	}

	const acceptanceChecks = new Set(input.activeAcceptance?.verification.map((item) => item.check) ?? []);
	const declared = scope.declared();
	const evidence = collectValidationEvidence(
		window,
		acceptanceChecks,
		input.workspaceRoot,
		declared,
		scope.facts().passCalls,
	);
	const limitations = collectLimitationEvidence(window);
	let quality: QualityFinding[] = [];
	if (input.workspaceRoot) {
		const loaded = loadQualityPolicy(input.workspaceRoot);
		if (!loaded.ok)
			return {
				kind: "engage",
				reason: "unvalidated_mutation",
				message: `[PanCode] quality policy cannot be assessed: ${loaded.reason}. Report the change as unverified; this notice grants no additional authority.`,
				evidence: [...evidence, ...limitations],
				mutatedPaths,
				policyUnassessable: true,
			};
		if (loaded.policy)
			quality = assessQualityPolicy(input.workspaceRoot, loaded.policy, mutatedPaths, capabilityEntries(window));
		const outstanding = quality.filter((finding) => finding.state !== "passed" && finding.state !== "limited");
		if (outstanding.length)
			return {
				kind: "engage",
				reason: "unvalidated_mutation",
				message: `[PanCode] project quality policy has outstanding checks: ${outstanding.map((finding) => `${finding.rule}/${finding.check}: ${finding.state} (${finding.message})`).join("; ")}. Run checks only within the operator's authorized scope; this notice grants no additional authority.`,
				evidence: [...evidence, ...limitations],
				mutatedPaths,
				quality,
			};
	}
	const required = input.rigor === "high" ? (input.activeAcceptance?.verification ?? []) : [];
	if (required.length > 0) {
		const passes = new Set(
			required.filter((check) => evidence.some((item) => acceptanceCheckPassed(item, check, input.workspaceRoot))),
		);
		const limited = new Set(limitations.flatMap((item) => item.paths ?? []));
		const missing = [
			...new Set(required.filter((check) => !passes.has(check) && !limited.has(check.check)).map((item) => item.check)),
		];
		if (missing.length > 0)
			return {
				kind: "engage",
				reason: "unvalidated_mutation",
				message: `[PanCode] High-rigor finish gate: operator acceptance still requires passing validation for: ${missing.join(", ")}. Run each named check or include its exact id in limitation.paths.`,
				evidence: [...evidence, ...limitations],
				mutatedPaths,
				...(quality.length ? { quality } : {}),
			};
		return {
			kind: "ok",
			reason: passes.size === required.length ? "validation_evidence" : "explicit_limitation",
			evidence: [...evidence, ...limitations],
			mutatedPaths,
			...(quality.length ? { quality } : {}),
		};
	}
	if (quality.length > 0)
		return {
			kind: "ok",
			reason: quality.every((finding) => finding.state === "passed") ? "validation_evidence" : "explicit_limitation",
			evidence: [...evidence, ...limitations],
			mutatedPaths,
			quality,
		};
	if (evidence.length > 0) {
		return { kind: "ok", reason: "validation_evidence", evidence: [...evidence, ...limitations], mutatedPaths };
	}

	if (limitations.length > 0) {
		return { kind: "ok", reason: "explicit_limitation", evidence: limitations, mutatedPaths };
	}
	// A workspace with no check to run is a fact the verify receipt states, not a gap the turn left open.
	if (declared.length === 0 && verifyFoundNoChecks(window)) {
		return { kind: "ok", reason: "no_checks_declared", evidence: [], mutatedPaths };
	}
	// A handoff note, a spec or a Mermaid diagram has no check to run, so
	// writing only prose is not an unverified change.
	if (mutatedPaths.every((path) => isProsePath(path))) {
		return { kind: "ok", reason: "prose_only", evidence: [], mutatedPaths };
	}
	// Removing tests or docs leaves nothing to check (D2-t2-b). Removing source
	// can break imports or the build, so it still earns the advisory unless the
	// operator's own message asked for that removal (F-Y1); quality and
	// acceptance gates above applied either way.
	const request = latestUserText(sessionEntries, assistantTurnId);
	if (
		mutatedPaths.every(
			(path) => !written.has(path) && (isNonSourcePath(path) || operatorRequestedDeletion(path, request)),
		)
	) {
		return { kind: "ok", reason: "deletion_only", evidence: [], mutatedPaths };
	}

	const named = (prefix: string, session: boolean) => {
		const ids = [...new Set(declared.filter((check) => check.session === session).map((check) => check.id))];
		return ids.length > 0 ? `${prefix}${ids.join(", ")}.` : "";
	};
	const ran = changedFilesRunAfterEdit(window, mutatedPaths, input.workspaceRoot);
	const failedAfterEdit = failedAfterEditLabels(input, scope);
	const retiredBy = retiredLabels(input, scope);
	return {
		kind: "engage",
		reason: "unvalidated_mutation",
		message: `${FINISH_CONTRACT_ADVISORY_MESSAGE}${named(FINISH_CONTRACT_DECLARED_CHECKS_PREFIX, false)}${named(FINISH_CONTRACT_RUN_CHECKS_PREFIX, true)}${ran.length > 0 ? `${FINISH_CONTRACT_RAN_CHANGED_PREFIX}${ran.join(", ")}.` : ""}${retiredBy !== null ? FINISH_CONTRACT_RETIRED_SUFFIX : ""}`,
		evidence: [],
		mutatedPaths,
		...(failedAfterEdit.length > 0 ? { failedAfterEdit } : {}),
		...(retiredBy !== null ? { retiredBy } : {}),
	};
}
