// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * A finished run's outcome vocabularies, free of schema imports so the dispatch types that name them stay cheap to
 * load (#434).
 */
import { RUN_ROLES } from "../views/run-roles.js";

export const RUN_OUTCOMES = [
	"succeeded",
	"failed",
	"timed_out",
	"stalled",
	"canceled",
	"denied_by_policy",
	"spawn_failed",
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** Stable machine classifications for terminal conditions that drive policy. */
export const RUN_OUTCOME_CODES = [
	"vram_capacity_fit_failure",
	"worker_tool_call_cap_exhausted",
	"worker_context_exhausted",
	"worker_turn_timeout",
	/** The run's wall clock moved it to its handback round (fleet M8); the run seals timed_out. */
	"worker_run_timeout",
	"worker_output_cap_exhausted",
	"loop_guard_tools_disabled_exhausted",
	/** The read-streak decision gate refused two rounds of reads after every note (exploration design X7). */
	"exploration_stalled",
	"result_contract_exhausted",
	"result_contract_invalid",
	"worker_final_output_missing",
	"host_verification_rejected",
	/** The run left the obligation its role owes unmet (fleet design 4.8); the detail names the obligation. */
	"obligation_unmet",
	/** A builder declared its assignment unfinished, or asked for wider write roots, and changed nothing. */
	"worker_not_done",
	"worker_partial_work",
	"worker_mutation_blocked",
	"merge_withheld",
	"worker_removed_tests",
	/** A builder's assurance (fleet design 4.8) is compromised: the detail names the evidence that lowered it. */
	"assurance_compromised",
	"information_flow_blocked",
	"acp_auth_required",
	"acp_model_unavailable",
	"acp_thinking_unavailable",
	"acp_transport_error",
] as const;
export type RunOutcomeCode = (typeof RUN_OUTCOME_CODES)[number];

/** What evidence a run's result must rest on, resolved once from its role (fleet design 4.8). */
export const RUN_OBLIGATIONS = [
	"observed-evidence",
	"answer",
	"change-or-declared",
	"executed-checks",
	"cited-evidence",
] as const;
export type RunObligation = (typeof RUN_OBLIGATIONS)[number];

/** The grader's layers: V0 is enforced at admission and V5 by the gates, so it holds V1 to V4 and the landing (V6). */
export const GRADE_LAYERS = ["V1", "V2", "V3", "V4", "V6"] as const;
export type GradeLayer = (typeof GRADE_LAYERS)[number];

/** The grader's rules, in the order they are evaluated: the order is the precedence (fleet M9). */
export const GRADE_RULE_IDS = [
	"termination",
	"change-return",
	"worker-outcome-code",
	"finish-contract",
	"writes-blocked",
	"final-output",
	"result-contract",
	"obligation",
	"host-checks",
	"removed-tests",
	"assurance",
	"landing",
] as const;
export type GradeRuleId = (typeof GRADE_RULE_IDS)[number];

/** `not_reached`: an earlier rule already failed the run. `unknown`: the facts the rule needs were not observed. */
export const GRADE_RULE_STATUSES = ["pass", "fail", "unknown", "not_applicable", "not_reached"] as const;
export type GradeRuleStatus = (typeof GRADE_RULE_STATUSES)[number];

/** How far a run's result is backed (fleet design 4.8): the trust verdict of its own settled facts. */
export const RUN_ASSURANCES = ["reviewed", "grounded", "unverified", "compromised", "unknown"] as const;
export type RunAssurance = (typeof RUN_ASSURANCES)[number];

/**
 * How far a run's receipt is backed. Descriptive provenance, orthogonal to the execution outcome: it must never drive
 * retry, reroute, or finish gating.
 */
export const RECEIPT_VERIFICATION_STATES = ["verified", "unverified", "not_applicable", "unknown"] as const;
export type ReceiptVerificationState = (typeof RECEIPT_VERIFICATION_STATES)[number];

/** What a receipt's verification state rests on. */
export const RECEIPT_VERIFICATION_BASES = [
	"validation-tool",
	/** Only shell checks the host observed the worker run answered; no validation tool did. */
	"host-observed-command",
	"read-only-agent",
	"no-validation-tool",
	/** A check ran and passed, then a later change to the tree retired it; no pass judged the final tree. */
	"retired-by-change",
	/**
	 * The run ran no standing check of its own, and a dispatched worker's sealed run record passed with no later change
	 * by this run; `detail` names it as `run <id> agent <agent>`.
	 */
	"dispatch-run-record",
	"acp-external-unobserved",
	/** The host ran the declared checks after the worker finished, and their verdict outranks the worker's own. */
	"host-verification",
	/** No sealed receipt to read: it is missing, unreadable, or failed integrity. */
	"result-unavailable",
] as const;
export type ReceiptVerificationBasis = (typeof RECEIPT_VERIFICATION_BASES)[number];

/** The host's verdict on a run's declared checks, run after the worker finished. */
export const HOST_VERIFICATION_STATUSES = ["verified", "rejected", "skipped", "not_implicated"] as const;
export type HostVerificationStatus = (typeof HOST_VERIFICATION_STATUSES)[number];

/** Why a host verification check never started, so its exit code reports no run. */
export const HOST_CHECK_NOT_RUN_REASONS = [
	"refused",
	"unconfigured",
	"spawn-failed",
	"nothing-changed",
	"shutdown",
	"no-tests",
] as const;
export type HostCheckNotRunReason = (typeof HOST_CHECK_NOT_RUN_REASONS)[number];

/** How a run's claimed validation commands matched the commands it executed. */
export const VALIDATION_GROUNDING_BASES = [
	"grounded",
	"no-command-executed",
	"unmatched-command",
	"unattributable-status",
	"unobserved-lane",
] as const;
export type ValidationGroundingBasis = (typeof VALIDATION_GROUNDING_BASES)[number];

/** The cost/quality stance a route decision takes. `manual` is exact rather than adaptive. */
export const ROUTING_POSTURES = ["manual", "quality", "balanced", "latency", "economy"] as const;
export type RoutingPosture = (typeof ROUTING_POSTURES)[number];

/** Who asked for a dispatch. Harness runs start on the harness's own decision and are always read-only. */
export const DISPATCH_REQUEST_ORIGINS = ["user", "agent", "internal", "harness"] as const;
export type DispatchRequestOrigin = (typeof DISPATCH_REQUEST_ORIGINS)[number];

/** How a provider call ended as its engine reported it. */
export const CALL_STOP_REASONS = ["stop", "toolUse", "length", "error", "aborted"] as const;
export type CallStopReason = (typeof CALL_STOP_REASONS)[number];

/** Why a worker's bulk stdout lane failed, as the worker itself reports it. */
export const WORKER_STDOUT_FAILURES = [
	"write-failed",
	"oversize-frame",
	"unserializable-frame",
	"backlog-full",
	"undrained",
] as const;
export type WorkerStdoutFailure = (typeof WORKER_STDOUT_FAILURES)[number];

/** A worker channel failure: the worker's own report, or a frame the host could not read. */
export const WORKER_CHANNEL_FAILURES = [...WORKER_STDOUT_FAILURES, "invalid-frame"] as const;
export type WorkerChannelFailure = (typeof WORKER_CHANNEL_FAILURES)[number];

/** How each labelled hash a finished run carries was computed (`run-hashes.ts`, #434). */
export const RUN_HASH_CANONICALIZATIONS = [
	/** UTF-8 bytes of the text as given (trimmed where the subject says so). */
	"utf8-text",
	/** Non-empty trimmed parts joined with a blank line, then UTF-8. */
	"trimmed-parts-v1",
	/** Sorted-key JSON without a domain prefix. */
	"json-sorted-v1",
	/** A `pancode.<kind>:` domain prefix followed by sorted-key JSON. */
	"json-sorted-prefixed-v1",
	/** `JSON.stringify` in insertion order. */
	"json-insertion-order",
	/** Child content hashes joined with newlines. */
	"hash-lines-v1",
	/** `git diff` bytes for a committed task, or the streamed working-tree snapshot form. */
	"task-diff-v1",
	/** The referenced artifact's own integrity digest, copied. */
	"artifact-digest",
] as const;
export type RunHashCanonicalization = (typeof RUN_HASH_CANONICALIZATIONS)[number];

/** What each labelled hash a finished run carries is a hash of. */
export const RUN_HASH_SUBJECTS = [
	"worker-prompt",
	"compiled-system-prompt",
	"dynamic-messages",
	"tool-names",
	"tool-schemas",
	"briefing",
	"steering",
	"worker-context-snapshot",
	"worker-context-seed",
	"project-context",
	"plan-text",
	"execution-plan",
	"run-settlement",
	"validation-result",
	"response-schema",
	"result-contract",
	"safety-rule-pack",
	"project-safety-policy",
	"protected-artifacts",
	"worker-permit",
	"worker-envelope",
	"mcp-server",
	/** The tool surface an MCP server serves, as the operator approved it. */
	"mcp-surface",
	/** An MCP skill's uri, frontmatter and every file's uri, digest and size, as the operator approved it. */
	"mcp-skill-manifest",
	"checkout-tree",
	"check-payload",
	"task-diff",
	"route-decision",
	"agent-spec",
	"route-prompt-composition",
	"endpoint",
	"settings",
	"skill-file",
	"package-provenance",
	/** A gate decider's evidence packet as its provenance seals it (M10). */
	"evidence-packet",
] as const;
export type RunHashSubject = (typeof RUN_HASH_SUBJECTS)[number];

/**
 * The execution roles a run journals and route statistics key on (fleet DESIGN 4.2, M12): the role vocabulary plus
 * `recovery`, the population of every attempt after the first.
 */
export const EXECUTION_ROLE_VOCABULARY = [...RUN_ROLES, "recovery"] as const;

/**
 * The role a gate position fixes, whatever recipe sits in it (DESIGN 4.2): null for a builder, a candidate or no gate.
 * Here, beside the vocabulary, so the run ledger judges a recorded gate row without loading the recipe-class rules in
 * `src/domains/dispatch/obligation.ts`, which resolves every other role (row 363).
 */
export function gatePositionRole(gateRole: string | undefined): "reviewer" | "judge" | "seat" | null {
	if (gateRole === "reviewer") return "reviewer";
	if (gateRole === "judge" || gateRole === "synthesis") return "judge";
	if (gateRole === "member") return "seat";
	return null;
}
