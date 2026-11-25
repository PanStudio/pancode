// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Tool records and their governance: decisions, approvals, completion, safety and budgets (#434). */

import type { Static } from "typebox";
import { Type } from "typebox";
import { vocabulary } from "./enums.js";
import { CallIdSchema, ExistingId } from "./id-schemas.js";
import { closed, count, duration } from "./schemas.js";

/**
 * The file kinds a write or edit records by extension. Anything else is `other`, so the vocabulary stays closed and
 * an unusual extension cannot carry a name into the journal.
 */
export const TOOL_FILE_KINDS = [
	"md",
	"tex",
	"bib",
	"rst",
	"txt",
	"ipynb",
	"py",
	"r",
	"jl",
	"m",
	"c",
	"cpp",
	"h",
	"f90",
	"rs",
	"go",
	"java",
	"js",
	"ts",
	"sh",
	"csv",
	"tsv",
	"json",
	"yaml",
	"toml",
	"parquet",
	"h5",
	"nc",
	"npy",
	"other",
] as const;
export type ToolFileKind = (typeof TOOL_FILE_KINDS)[number];
/**
 * One tool call as the model's tool wrapper settled it; ctx names the session or run, turn, tool call and the model
 * call that asked for it. tool.decided keeps the safety decision itself (#434).
 */
export const ToolSettledSchema = Type.Object(
	{
		tool: ExistingId,
		outcome: vocabulary(["ok", "error", "blocked"]),
		/** The tool's own time on the local clock, without any wait for an operator's approval. */
		durationMs: duration,
		/** Present only when the call parked for approval. */
		parkedMs: Type.Optional(duration),
		/** Middleware hook time inside the call (before_tool and after_tool), kept out of `durationMs`; absent when it rounds to 0. */
		hookMs: Type.Optional(duration),
		/** UTF-8 bytes of the result text the model receives; absent when nothing ran. */
		resultBytes: Type.Optional(count),
		images: Type.Optional(Type.Integer({ minimum: 1 })),
		terminate: Type.Optional(Type.Literal(true)),
		/** Which refusal blocked it: a policy, an unapproved park, or a withheld duplicate of a succeeded call. */
		blocked: Type.Optional(vocabulary(["refused", "denied-park", "redundant-repeat"])),
		/** An `ok` call that returned a notice without running: the spent observation pool stopped it (C-17). */
		notExecuted: Type.Optional(vocabulary(["observation_budget"])),
		/**
		 * The kind of file a write or edit targeted, from its extension alone; the path and name never enter the record.
		 * `telemetry insights` reads it to tell prose from code and data work.
		 */
		fileExt: Type.Optional(vocabulary(TOOL_FILE_KINDS)),
		/** The declared kind of the check a verify call ran (`src/tools/verify/catalog.ts`). */
		checkKind: Type.Optional(vocabulary(["command", "numeric-compare", "perf-budget", "reproduce", "browser"])),
		/** The skill a context call loaded; an operator-chosen name, so a share anonymizes it like a rule id. */
		skill: Type.Optional(ExistingId),
		/** The capabilities a gateway call or chain invoked, so the tool mix sees `data` or `web_fetch` behind it. */
		capabilities: Type.Optional(Type.Array(ExistingId, { minItems: 1, maxItems: 32 })),
		/** A capability a gateway call or chain step ran under the model's call; see {@link countsAsToolCall} (C-9). */
		inner: Type.Optional(Type.Literal(true)),
	},
	closed,
);
export type ToolSettled = Static<typeof ToolSettledSchema>;
/**
 * Whether a tool.settled or tool.decided row is a call the model made. A gateway call's capability and each chain
 * step decide and settle as their own `inner` rows, so every decision has its settlement; counters count only the
 * model's call (C-9).
 */
export function countsAsToolCall(data: { inner?: true }): boolean {
	return data.inner !== true;
}
/**
 * One final safety disposition at a tool decision point, carrying its classification and policy facts. Commands,
 * arguments and policy prose stay out of the journal (#434).
 */
export const ToolDecidedSchema = Type.Object(
	{
		tool: ExistingId,
		actionClass: ExistingId,
		decision: vocabulary(["allowed", "blocked", "permission_requested", "denied"]),
		exposure: Type.Optional(Type.Literal("outward")),
		posture: Type.Optional(ExistingId),
		requestId: Type.Optional(ExistingId),
		ruleId: Type.Optional(ExistingId),
		reasonCode: Type.Optional(ExistingId),
		policySource: Type.Optional(ExistingId),
		policyHash: Type.Optional(ExistingId),
		/** The confirmation rule (for example slurm-allocation) that raised an ask, apart from the policy's own rule. */
		confirmationRuleId: Type.Optional(ExistingId),
		/** A capability a gateway call or chain step ran under the model's call; see {@link countsAsToolCall} (C-9). */
		inner: Type.Optional(Type.Literal(true)),
	},
	closed,
);
/** A parked call's approval ask. The card's summary, target, consequence and rejection text are live only (#434). */
export const ApprovalRequestedSchema = Type.Object(
	{
		tool: ExistingId,
		actionClass: ExistingId,
		requestId: Type.Optional(ExistingId),
		origin: Type.Optional(ExistingId),
		/** The worker run that asked; absent for a main-session ask. */
		requestedBy: Type.Optional(ExistingId),
		agentId: Type.Optional(ExistingId),
		axis: Type.Optional(ExistingId),
		posture: Type.Optional(ExistingId),
		ruleId: Type.Optional(ExistingId),
		reasonCode: Type.Optional(ExistingId),
		policySource: Type.Optional(ExistingId),
		timeoutMs: Type.Optional(duration),
		fallback: Type.Optional(vocabulary(["deny", "fail"])),
		escalation: Type.Optional(Type.Boolean()),
		approvalAuthority: Type.Optional(vocabulary(["main", "operator"])),
		forwardedByMain: Type.Optional(Type.Boolean()),
		reviewer: Type.Optional(Type.Literal("safety-judge")),
	},
	closed,
);
export const ApprovalResolvedSchema = Type.Object(
	{
		status: vocabulary(["granted", "denied", "expired"]),
		requestId: Type.Optional(ExistingId),
		origin: Type.Optional(ExistingId),
		decidedBy: Type.Optional(ExistingId),
		tool: Type.Optional(ExistingId),
		actionClass: Type.Optional(ExistingId),
		requestedBy: Type.Optional(ExistingId),
		fallback: Type.Optional(vocabulary(["deny", "fail"])),
		grant: Type.Optional(
			Type.Object(
				{
					attempt: count,
					authority: vocabulary(["main", "operator"]),
					issuer: Type.Optional(vocabulary(["main", "operator"])),
					execution: vocabulary(["not_executed", "executing", "executed", "unknown"]),
					state: ExistingId,
				},
				closed,
			),
		),
	},
	closed,
);

/** The finish contract's decision at turn end. Paths and finding prose are counted, never copied (#434). */
export const CompletionEvaluatedSchema = Type.Object(
	{
		decision: vocabulary(["ok", "engage"]),
		reason: vocabulary([
			"no_mutation",
			"no_net_mutation",
			"deletion_only",
			"prose_only",
			"validation_evidence",
			"explicit_limitation",
			"no_checks_declared",
			"unvalidated_mutation",
		]),
		rigor: vocabulary(["normal", "high"]),
		mutatedPaths: count,
		evidenceKinds: Type.Array(ExistingId),
		quality: Type.Optional(
			Type.Array(
				Type.Object(
					{
						rule: ExistingId,
						check: ExistingId,
						state: vocabulary(["passed", "failed", "stale", "missing", "limited", "unavailable"]),
					},
					closed,
				),
			),
		),
		/** The checks the decision counted as passed and the operator's acceptance per check; limitations stay out. */
		verification: Type.Optional(
			Type.Object(
				{
					passedChecks: Type.Array(ExistingId),
					acceptance: Type.Array(
						Type.Object({ check: ExistingId, state: vocabulary(["passed", "limited", "unverified"]) }, closed),
					),
				},
				closed,
			),
		),
	},
	closed,
);
/** The safety judge's review of a call that would have parked; its reason and detail prose stay out (#434). */
export const SafetyJudgedSchema = Type.Object(
	{
		tool: ExistingId,
		actionClass: ExistingId,
		verdict: vocabulary(["allow", "block", "none", "escalated"]),
		latencyMs: duration,
		workerRunId: Type.Optional(ExistingId),
		askRule: Type.Optional(ExistingId),
		toolDescriptionChars: Type.Optional(count),
		rule: Type.Optional(ExistingId),
		target: Type.Optional(ExistingId),
		model: Type.Optional(ExistingId),
		noVerdict: Type.Optional(ExistingId),
		operatorMessages: Type.Optional(count),
		screened: Type.Optional(vocabulary(["parked"])),
		unnamedEscape: Type.Optional(vocabulary(["parked"])),
		namedTarget: Type.Optional(vocabulary(["parked"])),
		/** The judge's own provider call; its tokens are journaled under that id with role `safety-judge`. */
		judgeCallId: Type.Optional(CallIdSchema),
		/** The call the judged tool call came from, which the row's context also names. */
		parentCallId: Type.Optional(CallIdSchema),
	},
	closed,
);

/** The loop guard blocked a verbatim-repeated call; `disposition` is how far it escalated (memory design 4.6). */
export const LoopBlockedSchema = Type.Object(
	{
		tool: ExistingId,
		repeatCount: count,
		blocksThisTurn: count,
		budget: count,
		disposition: vocabulary(["block", "lockout", "stop"]),
	},
	closed,
);
/** The loop guard counted a turn's calls past its soft budget, or its hard ceiling when `interrupted`. */
export const ToolBudgetExceededSchema = Type.Object(
	{
		tool: ExistingId,
		callsThisTurn: count,
		softBudget: count,
		hardCeiling: count,
		interrupted: Type.Boolean(),
		template: Type.Optional(ExistingId),
		stepTool: Type.Optional(ExistingId),
		rolled: Type.Optional(Type.Literal(true)),
	},
	closed,
);
