// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { HoareAssurance, HoareObligation, ObservedProof } from "../../core/hoare.js";
import type { INTERNAL_HELPER_RESULT_KINDS } from "../../lib/worker-wire/protocol.js";
import type { AgentAutomationAuthority } from "./spec.js";

export type ResultContract =
	| { kind: "architect-plan"; path: string }
	| { kind: "scout-report" }
	| { kind: "verifier-report"; assurance?: HoareAssurance }
	/**
	 * A reviewer's verdict on one subject: the review gate's own shape,
	 * `{verdict, checks}`, declared by the builtin `reviewer` so a direct review
	 * run is validated against the answer the gate asks for. No assurance level:
	 * a review judges a subject, it does not mechanize proofs.
	 */
	| { kind: "review-verdict"; packet?: string[] }
	/**
	 * A judge's verdict (fleet design 4.8, M9): the gate's own answer, so V2 conformance applies to judges as it does
	 * to reviewers. With `candidates` it is a compete judge's `{winner, checks}`, the winner one of that many subjects;
	 * without, a council synthesis's `{verdict, text}`. Only the coordinator assigns it, never a recipe.
	 */
	| { kind: "judge-verdict"; candidates?: number; packet?: string[] }
	| { kind: "council-report" }
	/**
	 * One council member's ballot under `synthesis: "vote"`.
	 *
	 * The vote is a strict majority over the members' `verdict` fields, computed
	 * by the coordinator with no model call. Nothing asked a member for that
	 * field before this kind existed, and nothing could: an unnamed council
	 * seats the builtin `researcher`, whose `research-report` accepts only
	 * `source` and `findings`, so a member that emitted a verdict failed its own
	 * postcondition and a member that obeyed its postcondition emitted no
	 * verdict. Every vote therefore resolved to `no_verdict_field` with an empty
	 * tally, on every input (#230).
	 *
	 * The ballot is the coordinator's postcondition for that slot, not the
	 * recipe's, in the same way `reviewer` and the compete `judge` answer the
	 * gate that dispatched them. It rides in as a `resultContractOverride` on
	 * the member request, so the seated recipe keeps its persona and any recipe
	 * can be voted with. No recipe may declare it: `parseResultContract` rejects
	 * the kind, and a Scout subtask may not request it, because it is a
	 * topology's ballot rather than an agent's work product.
	 *
	 * `options` is set when the question listed its answers (as `/poll
	 * --options` does): the verdict must then be one of them, matched without
	 * regard to case, so a member that copies an example token instead gets a
	 * repair round that names the options rather than a spoiled vote.
	 */
	| { kind: "council-ballot"; options?: string[] }
	| { kind: "debugger-report" }
	| { kind: "research-report" }
	| { kind: "world-knowledge-report" }
	/**
	 * A work product plus its evidence. `maxSummaryBytes` is the allowance for
	 * the inline `summary` deliverable, declared by the recipe and overridable
	 * per dispatch; absent means `RESULT_SUMMARY_DEFAULT_MAX_BYTES`. It is a
	 * separate bound from the commit message because the two carry different
	 * things: a commit subject is one line, a requested explanation is not.
	 */
	| { kind: "mutation-report"; maxSummaryBytes?: number }
	| { kind: "provenance-report" }
	| { kind: "delegation-plan" }
	/**
	 * The advisory answer `/oracle` asks for. It exists as its own kind because
	 * the answer shape is the whole point of the command: a verdict, the
	 * strongest challenge the advisor can mount, the evidence that would change
	 * its mind, and the prior decisions it read. Folding it onto
	 * `research-report` would ask for claims and evidence instead, and the
	 * challenge and the reversal condition would have nowhere to go.
	 */
	| { kind: "oracle-report" }
	| { kind: "external-delegation" }
	/**
	 * A non-builder's prose answer: any final text is the result, and nothing in it is validated (fleet design 4.8,
	 * M9). Fleet proposals, a non-builder gate author and imported read-only recipes hand back text; they borrowed
	 * `artifact-report` until that became a builder report with a required typed completion.
	 */
	| { kind: "text-report" }
	/**
	 * The run's postcondition is the artifact it left on disk, so its terminal
	 * text carries no claim to validate. A caller may bind a workspace-relative
	 * path to check readability and nonempty content during terminal repair.
	 * Recipes remain unbound and leave
	 * artifact validation to the caller. Neither check establishes freshness,
	 * writer authorship, citations, or semantic accuracy. A writer asked for a
	 * typed report instead has to invent one: a small model handed
	 * `mutation-report` for a
	 * documentation pass routinely seals a fabricated passing `npm test` entry,
	 * which is a false correctness signal produced purely to satisfy a shape.
	 * Recipes may declare this kind; Scout subtasks may not request it, because
	 * a subtask's result is consumed as data by its dependents.
	 */
	| { kind: "artifact-report"; path?: string }
	/**
	 * The PANCODE.md handbook payload `pancode context init` parses. It exists as its
	 * own kind because the alternative was dispatching Scout and telling it in
	 * prose to ignore its own recipe: the recipe body and the repair directive
	 * both name the findings shape, so a model that obeys the recipe returns
	 * reconnaissance and the bootstrap parser rejects every run. A contract is
	 * the wrong thing to override with a sentence in a task prompt.
	 * Scout subtasks may not request it; it is a command's payload, not a
	 * dependency edge.
	 */
	| { kind: "context-handbook" }
	/**
	 * A deterministic command's structured result. No agent recipe may declare
	 * it (`parseResultContract` rejects the kind) and no Scout subtask may
	 * request it: it is authored by the code-step runner, never by a model. It
	 * lives in this union so a code step's terminal result is validated, sealed,
	 * and handed across plan edges through exactly the same door an agent's
	 * report uses.
	 */
	| { kind: "code-report" };

export type ResultContractQuality = "pass" | "fail" | "unmeasured";
export type InternalHelperResultKind = (typeof INTERNAL_HELPER_RESULT_KINDS)[number];

export interface StructuredHelperResult {
	version: 1;
	kind: InternalHelperResultKind;
	/** Validated task content, never an authority grant or a host verification claim. */
	data: Record<string, unknown>;
}

export interface ResultContractValidation {
	/** Whether the declared postcondition itself was met. */
	conformance: "pass" | "fail";
	/** Only correctness-bearing contracts can produce a routing-quality label. */
	quality: ResultContractQuality;
	sourceId: string;
	validatorDigest: string;
	/** Parsed Scout data for the model-facing dispatch projection. */
	scout?: ScoutResult;
	/** Parsed Verifier data for the dispatch review-gate projection. */
	verifier?: VerifierResult;
	delegationPlan?: DelegationPlanResult;
	reason?: string;
}

export interface ResultContractFilesystem {
	readFile(path: string): string | null;
	/**
	 * Whether anything exists at this location. Optional because most contracts
	 * only ever need a file's bytes; a mutation report needs presence, since a
	 * run legitimately creates directories and writes through channels no tool
	 * event enumerates. Absent means presence is unobservable here, and the
	 * mutation grounding below degrades to the quality label rather than
	 * calling an unreadable path fabricated.
	 */
	pathExists?(path: string): boolean;
	/**
	 * Whether this location is a directory. Optional for the same reason as
	 * `pathExists`: a contract that only needs a file's bytes never asks. A
	 * Scout citation does, because a survey task cites directories, and a
	 * directory has no bytes to read and no line to ground. Absent means the
	 * distinction is unobservable here, so an unreadable location stays
	 * unreadable rather than being assumed to be a directory.
	 */
	isDirectory?(path: string): boolean;
}

/**
 * Inclusive `[start, end]` line spans a run actually observed, by absolute
 * path. Grounding is only checkable where this evidence exists, which is the
 * worker that made the reads.
 */
export type ObservedReadRanges = ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;

/**
 * The write-side counterpart of `ObservedReadRanges`: what this run's own tool
 * calls show it changed and ran. Both are recorded by the layer that watched
 * the tool stream (`domains/safety/run-effects.ts`).
 */
export interface ObservedRunEffects {
	proofs?: ReadonlyMap<string, ObservedProof>;
	/** Absolute paths the run's successful tool calls aimed a mutation at. */
	mutatedPaths: ReadonlySet<string>;
	/** Absolute paths whose only mutation attempt came back blocked or errored. */
	failedMutationPaths: ReadonlySet<string>;
	/** Canonical validation commands the run ran to a clean exit since its last observed mutation. */
	validationCommands: ReadonlySet<string>;
	checksAllBlocked?: boolean;
	/** Observed failures and final passes since the last mutation, keyed by `observedValidationCommand`. */
	validationOutcomes?: ReadonlyMap<string, boolean>;
	/** `validationOutcomes` joined by verify-call outcomes under check id and resolved command; read in its place. */
	checkOutcomes?: ReadonlyMap<string, boolean>;
	/** Checks whose latest verify receipt sealed could-not-run, under the same keys; see `RunEffects.notRunChecks`. */
	notRunChecks?: ReadonlySet<string>;
	/** Whether the run made an observed workspace mutation; absent reads as unknown. */
	mutationObserved?: boolean;
}

export interface ResultContractValidationInput {
	contract: ResultContract;
	output: string | null;
	cwd: string;
	networkAllowed: boolean;
	filesystem: ResultContractFilesystem;
	/**
	 * Line spans this run read. When supplied, a cited line must fall inside
	 * one, which turns "this line exists in the file" into "this run looked at
	 * this line". Absent means grounding is not observable at this layer and
	 * only the weaker existence check applies.
	 */
	observedReadRanges?: ObservedReadRanges;
	/**
	 * What this run did to the workspace. When supplied, a mutation report is
	 * measured against it instead of being believed. Absent means the effects
	 * are not observable at this layer and the report's own word stands, which
	 * is what every caller got before grounding existed.
	 */
	observedRunEffects?: ObservedRunEffects;
	/**
	 * Whether the sealed output was clipped by the run's capture bound. A clipped
	 * result cannot parse, and "result must be valid JSON" would send the model
	 * after a formatting problem it does not have; the reason names the bound.
	 */
	outputTruncated?: boolean;
}

/**
 * Receipt-ready projection of the typed result validator.
 *
 * `not-reached` is the third conformance state and is not a soft failure. A
 * declared postcondition is only an applicable check once the run got far
 * enough to produce a terminal result. A worker that crashed before its first
 * token, a target that could not load the model, an operator abort, and an
 * engine loop-guard abort all leave the contract unevaluated. Recording those
 * as `fail` invents correctness evidence out of infrastructure noise, so they
 * seal `not-reached` and stay out of the routing quality denominator.
 */
export interface ResultContractFact {
	sourceId: string;
	validatorDigest: string;
	conformance: "pass" | "fail" | "not-reached";
	quality: ResultContractQuality;
}

export interface ValidateRecipeResultInput {
	contract: ResultContract | null;
	output: string | null;
	cwd: string;
	networkAllowed: boolean;
	filesystem: ResultContractFilesystem;
	/**
	 * Whether the run reached the point where its terminal result was due. The
	 * caller owns this judgement because only it knows how the attempt ended.
	 */
	reachedTerminalResult: boolean;
	/** What the run's tool calls show it changed and ran, when observed. */
	observedRunEffects?: ObservedRunEffects;
	/** Whether the capture bound clipped `output`; see ResultContractValidationInput. */
	outputTruncated?: boolean;
}

/**
 * A declared contract that never got to run. `applicable: false` carries the
 * contract's identity so offline replay still knows which postcondition was in
 * force, while contributing no correctness label.
 */
export type RecipeResultOutcome =
	| { applicable: true; validation: ResultContractValidation; fact: ResultContractFact }
	| { applicable: false; fact: ResultContractFact };

export interface ScoutCitation {
	path: string;
	line: number;
}

/** One reconnaissance claim and the live-read location that grounds it. */
export interface ScoutFinding extends ScoutCitation {
	claim: string;
}

export interface ScoutResult {
	findings: ReadonlyArray<ScoutFinding>;
	/** Grounding locations projected from findings, in reported order. */
	citations: ReadonlyArray<ScoutCitation>;
	needsSplit: boolean;
	proposedSubtasks: ReadonlyArray<ScoutSubtask>;
	/**
	 * Claims salvaged from a degraded result that carry no citation this run can
	 * ground. They are leads, never evidence, and they exist so a small model's
	 * observations survive a terminal shape it could not emit. Absent on a
	 * strictly conforming result.
	 */
	ungroundedClaims?: ReadonlyArray<string>;
	/**
	 * The validator's own reason for accepting a degraded shape. Its presence is
	 * the flag: any consumer that needs strict Scout data checks for it. Absent
	 * on a strictly conforming result.
	 */
	degradedReason?: string;
}

/** Strict Scout-authored data. Every execution/control field is coordinator-owned. */
export interface ScoutSubtask {
	id: string;
	task: string;
	dependencies: ReadonlyArray<string>;
	expectedResultContract: ResultContract["kind"];
	requestedAuthority: AgentAutomationAuthority;
}

export interface VerifierCheck {
	name: string;
	passed: boolean;
	evidence: string;
	obligation?: HoareObligation;
	/** A gate verdict's references to its evidence packet's ids (M10); only review-verdict and judge-verdict carry them. */
	cites?: string[];
}

/** Parsed `verifier-report` payload, for callers that need the verdict itself. */
export interface VerifierResult {
	verdict: "pass" | "fail";
	checks: ReadonlyArray<VerifierCheck>;
	assurance?: HoareAssurance;
}

export function isHoareResultContract(contract: ResultContract | undefined | null): boolean {
	return contract?.kind === "verifier-report" && contract.assurance !== undefined;
}

export interface DelegationPlanResultTask {
	id: string;
	agent: string;
	description: string;
	depends_on: ReadonlyArray<string>;
	writes: ReadonlyArray<string>;
	mode?: "sequential" | "parallel";
}

export interface DelegationPlanResult {
	tasks: ReadonlyArray<DelegationPlanResultTask>;
}
