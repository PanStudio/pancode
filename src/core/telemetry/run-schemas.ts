// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Run records: usage, feed, settlement, result objects, routing, gates and run lifecycle (#434). */

import type { Static } from "typebox";
import { Type } from "typebox";
import { RunEconomicsSchema } from "./economy.js";
import { RunBoundKind, RunOutcome, RunOutcomeCode, RunTerminalReason, vocabulary } from "./enums.js";
import { FactSumSchema, factSchema } from "./fact.js";
import { CallIdSchema, ExistingId } from "./id-schemas.js";
import {
	EXECUTION_ROLE_VOCABULARY,
	GRADE_LAYERS,
	GRADE_RULE_IDS,
	GRADE_RULE_STATUSES,
	RUN_ASSURANCES,
	RUN_HASH_CANONICALIZATIONS,
	RUN_HASH_SUBJECTS,
	RUN_OBLIGATIONS,
} from "./run-vocabulary.js";
import {
	closed,
	count,
	duration,
	FreeRuleSchema,
	nullable,
	ObjectRefSchema,
	PricingSchema,
	RunSpendSumsSchema,
	sha256Hex,
	target,
	text,
	UsageSchema,
	UtcSchema as utc,
} from "./schemas.js";
import { StepPipelineSettledSchema } from "./session-schemas.js";

/**
 * Aggregate snapshots describe a delegated scope, never an invented provider call (#434). Each quantity is a sum with
 * its coverage, so a scope with one unpriced or unreported call keeps the known subtotal of the others.
 */
export const RunUsageSchema = Type.Object(
	{
		source: vocabulary(["claude-sdk", "external-cli", "acp"]),
		scope: vocabulary(["run", "peer-session"]),
		/** Disjoint contribution within the scope; omission denotes its whole-scope snapshot (#434). */
		partId: Type.Optional(text),
		revision: count,
		coverage: vocabulary(["complete", "partial", "unknown"]),
		target,
		usage: RunSpendSumsSchema.properties.usage,
		totalTokens: FactSumSchema,
		apiCalls: FactSumSchema,
		unmeteredCalls: FactSumSchema,
		pricing: Type.Object(
			{
				usd: FactSumSchema,
				pricedBy: vocabulary(["provider", "target-rates", "catalog", "free", "none"]),
				freeRule: Type.Optional(FreeRuleSchema),
			},
			closed,
		),
	},
	closed,
);
export type RunUsage = Static<typeof RunUsageSchema>;

export const RUN_FEED_EVENTS = [
	"agent_start",
	"agent_end",
	"attempt_start",
	"message_end",
	"thinking",
	"route_warning",
	"pancode_tool_start",
	"pancode_tool_finish",
	"pancode_tool_observation",
	"pancode_permission_escalated",
	"pancode_permission_resolved",
	"pancode_run_outcome",
	"pancode_steer_received",
	"pancode_helper_result",
	"pancode_helper_result_rejected",
	"pancode_write_record_partial",
	// Worker lifecycle rows a run records once each; without them a trace shows a standard step as unclassified.
	"pancode_repair_rounds_started",
	"host_verification",
	"unknown",
] as const;
export const RUN_FEED_OUTCOMES = [
	"succeeded",
	"failed",
	"timed_out",
	"stalled",
	"canceled",
	"denied_by_policy",
	"spawn_failed",
	"unknown",
] as const;
const runFeedOutcome = vocabulary(RUN_FEED_OUTCOMES);
export const RunFeedBodySchema = Type.Union([
	Type.Object({ kind: Type.Literal("open"), runId: ExistingId, agentId: ExistingId }, closed),
	Type.Object(
		{
			kind: Type.Literal("event"),
			type: vocabulary(RUN_FEED_EVENTS),
			tool: Type.Optional(ExistingId),
			callId: Type.Optional(ExistingId),
			outcome: Type.Optional(vocabulary(["ok", "error", "blocked"])),
			durationMs: Type.Optional(duration),
		},
		closed,
	),
	Type.Object(
		{
			kind: Type.Literal("journal_truncated"),
			reason: Type.Literal("per-run size cap"),
			droppedFromSeq: Type.Integer({ minimum: 1 }),
		},
		closed,
	),
	Type.Object(
		{
			kind: Type.Literal("result"),
			outcome: runFeedOutcome,
			exitCode: Type.Union([Type.Integer(), Type.Null()]),
			attemptRunId: Type.Optional(ExistingId),
		},
		closed,
	),
	Type.Object({ kind: Type.Literal("terminal"), outcome: runFeedOutcome }, closed),
]);
export type StructuralRunFeedBody = Static<typeof RunFeedBodySchema>;

/** Diagnostic text a finished run states about itself, clipped and redacted where it is built (#434). */
const diagnostic = Type.String({ maxLength: 1024 });
const digest = Type.String({ minLength: 1, maxLength: 256 });
/** An envelope digest or static head; a head is empty until the host compiles the worker's prompt. */
const envelopeDigest = Type.String({ maxLength: 256 });
/** One R7-labelled hash a finished run carries, named by the field it was computed for (`run-hashes.ts`, #434). */
const RunHashSchema = Type.Object(
	{
		field: Type.String({ minLength: 1, maxLength: 256 }),
		label: vocabulary(["commitment", "resolvable"]),
		function: Type.Literal("sha256"),
		canonicalization: vocabulary(RUN_HASH_CANONICALIZATIONS),
		subject: vocabulary(RUN_HASH_SUBJECTS),
		store: Type.Optional(vocabulary(["run-journals", "context-seeds"])),
		hash: digest,
	},
	closed,
);
export type RunHash = Static<typeof RunHashSchema>;
const SettledBlockedAttemptSchema = Type.Object(
	{
		tool: ExistingId,
		actionClass: nullable(ExistingId),
		ruleId: nullable(ExistingId),
		reasonCode: nullable(ExistingId),
	},
	closed,
);
/**
 * A finished run's one persisted record (#434). Version 1. What the run delivered (its output, failure text, worktree
 * and check commands) is content, kept in the run scope's `run-result` object that `result` names, so the seal covers
 * it and a share profile can drop it.
 */
function runSettledSchema<const R extends readonly string[]>(roles: R) {
	return Type.Object(
		{
			version: Type.Literal(1),
			agentId: ExistingId,
			executionRole: vocabulary(roles),
			requestOrigin: nullable(vocabulary(["user", "agent", "internal", "harness"])),
			identity: nullable(
				Type.Object({ host: Type.String({ maxLength: 256 }), user: Type.String({ maxLength: 256 }) }, closed),
			),
			route: Type.Object(
				{
					targetId: ExistingId,
					wireModelId: ExistingId,
					runtimeId: ExistingId,
					runtimeKind: vocabulary(["http", "sdk", "subprocess", "acp-delegation"]),
				},
				closed,
			),
			node: nullable(Type.Object({ id: ExistingId, kind: vocabulary(["local", "ssh"]) }, closed)),
			/**
			 * The route decision the run executed under, as route history and readiness fold it; null when none was observed.
			 * `executed` is the executed route's whole identity, hashes only, so the fold keys and drift-checks it from this
			 * record alone (#434).
			 */
			routeDecision: nullable(
				Type.Object(
					{
						decisionHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
						mode: vocabulary(["fixed", "shadow", "active"]),
						durationMs: duration,
						constraintsValid: Type.Boolean(),
						executed: Type.Object(
							{
								agentId: ExistingId,
								specFingerprint: digest,
								executionRole: vocabulary(roles),
								targetId: ExistingId,
								modelId: ExistingId,
								runtimeId: ExistingId,
								nodeId: ExistingId,
								thinkingLevel: nullable(ExistingId),
								toolSignature: digest,
								promptCompositionHash: digest,
								endpointIdentityHash: digest,
								settingsFingerprint: digest,
							},
							closed,
						),
					},
					closed,
				),
			),
			/** The run's retry attempt within its assignment, 0 for the first (`RunLineage.attempt`). */
			attempt: count,
			/** Queue wait and user-observed end-to-end time from the run's phase marks; null where a mark is missing. */
			phaseTiming: Type.Object({ queueWaitMs: nullable(duration), totalEndToEndMs: nullable(duration) }, closed),
			/** The routing request the run was admitted under, which a continuation it seeds inherits. */
			routingIntent: Type.Object(
				{
					posture: vocabulary(["manual", "quality", "balanced", "latency", "economy"]),
					maxCostUsd: nullable(Type.Number({ minimum: 0 })),
					deadlineMs: nullable(duration),
					minimumQuality: nullable(Type.Number()),
					requiredCapabilities: Type.Array(ExistingId, { maxItems: 64 }),
					locality: vocabulary(["local-only", "prefer-local", "any"]),
					failover: vocabulary(["none", "approved"]),
				},
				closed,
			),
			startedAt: utc,
			endedAt: utc,
			outcome: RunOutcome,
			outcomeCode: nullable(RunOutcomeCode),
			/** Null when the host settled a run whose worker never reported an exit. */
			exitCode: nullable(Type.Integer()),
			outcomeDetail: nullable(diagnostic),
			failureMessage: nullable(diagnostic),
			terminalReason: RunTerminalReason,
			/** Null when no call telemetry reached the host: unknown, never zero calls (R1, #434). */
			callIds: Type.Union([Type.Array(CallIdSchema), Type.Null()]),
			processExitCode: Type.Union([Type.Integer(), Type.Null()]),
			boundKind: Type.Optional(RunBoundKind),
			/** How the run's step pipeline ended; absent for a run without a step template. */
			stepPipeline: Type.Optional(StepPipelineSettledSchema),
			/** Only the worker's repair loop can count its rounds; the host never infers zero (#425). */
			repairRounds: factSchema(count),
			frameType: Type.Union([text, Type.Null()]),
			/** The run's own spend as one fact per quantity; the read model folds the calls for coverage (#434). */
			usage: UsageSchema,
			totalTokens: factSchema(count),
			apiCalls: factSchema(count),
			pricing: PricingSchema,
			/** The run's economics beside its route price (`economy.ts`); absent in a share, which leaves funding metadata out. */
			economics: Type.Optional(RunEconomicsSchema),
			toolCalls: count,
			/**
			 * Calls per tool and how they ended, by tool name; a tool's arguments and results are never kept here. `asked`
			 * counts the permission asks that were refused without an answer, apart from `blocked`, and `withheld` the calls
			 * the spent observation pool answered with a notice instead of running (C-17), so a row sums; each is absent when
			 * there were none.
			 */
			tools: Type.Array(
				Type.Object(
					{
						tool: ExistingId,
						calls: count,
						ok: count,
						errors: count,
						blocked: count,
						asked: Type.Optional(count),
						withheld: Type.Optional(count),
					},
					closed,
				),
				{ maxItems: 256 },
			),
			/** The skills the run loaded, in activation order, and who asked for each; never a skill's path or body. */
			skills: Type.Array(
				Type.Object({ name: ExistingId, requestSource: nullable(vocabulary(["recipe", "model", "operator"])) }, closed),
				{ maxItems: 256 },
			),
			/** The run's tool calls as the finalizer classified them; null for a run with no tool telemetry. */
			toolActivity: nullable(
				Type.Object(
					{
						calls: count,
						succeeded: count,
						failed: count,
						blocked: count,
						mutatingSucceeded: Type.Boolean(),
						/** The worker wrote at least one blob into a granted store tag; absent when it wrote none. */
						storeWritten: Type.Optional(Type.Boolean()),
						/** Calls that started and never finished, so a sealed reader shows them too (FL-6); absent when none. */
						unfinished: Type.Optional(count),
						/** Calls the spent observation pool answered without running them (C-17); absent when none. */
						withheld: Type.Optional(count),
					},
					closed,
				),
			),
			/** A read-only recipe admitted against a task that needs a write; null when the pairing was sound. */
			capabilityMismatch: nullable(
				Type.Object(
					{ agentId: ExistingId, capabilityClass: ExistingId, taskType: ExistingId, suggestedAgentId: nullable(ExistingId) },
					closed,
				),
			),
			/** The tool budget the run ran under, worded as dispatch words it; null when it had none. */
			budget: nullable(Type.Object({ policy: text, requested: text, effective: text, reasons: text }, closed)),
			/** What context the run was sent, by size; the hashes are in `hashes`, the content is never kept. */
			context: Type.Object(
				{
					briefingBytes: nullable(count),
					worker: nullable(
						Type.Object({ mode: vocabulary(["fork", "splice"]), estimatedTokens: count, omittedMessages: count }, closed),
					),
					project: nullable(
						Type.Object(
							{
								tier: vocabulary(["none", "bounded"]),
								chars: nullable(count),
								sections: Type.Array(ExistingId, { maxItems: 64 }),
							},
							closed,
						),
					),
				},
				closed,
			),
			/** What the provider reported about the model and gateway route of the run's calls, each distinct one once. */
			upstream: Type.Object({ responseModelIds: nullable(text), gatewayRoutes: nullable(text) }, closed),
			/** Tool calls safety refused, by tool, class and rule; the call's arguments and reason prose are not kept. */
			blockedAttempts: Type.Array(SettledBlockedAttemptSchema, { maxItems: 64 }),
			/** Tool calls a tool guard held back, in the same shape; absent when none was. */
			guardBlockedAttempts: Type.Optional(Type.Array(SettledBlockedAttemptSchema, { maxItems: 64 })),
			/** Asks the run refused without an answer, in the same shape; absent when none was. */
			permissionRequestedAttempts: Type.Optional(Type.Array(SettledBlockedAttemptSchema, { maxItems: 64 })),
			/** Permission escalations the run asked for and how they ended; null when none was asked. */
			escalations: nullable(Type.Object({ requested: count, approved: count, denied: count, timedOut: count }, closed)),
			/** Information-flow restrictions the run's context carried, which its consumers must keep (`flow-restrictions.ts`). */
			flowRestrictions: nullable(
				Type.Object(
					{
						version: Type.Literal(1),
						restrictions: Type.Array(
							Type.Object(
								{
									ruleId: ExistingId,
									policyHash: Type.String({ maxLength: 256 }),
									sourceRef: text,
									recipients: Type.Array(ExistingId, { maxItems: 256 }),
								},
								closed,
							),
							{ maxItems: 256 },
						),
						advisory: Type.Optional(Type.Array(text, { maxItems: 64 })),
					},
					closed,
				),
			),
			/** Who governed an external peer's tools; null for a run PanCode's own tool loop drove. */
			toolGovernance: nullable(vocabulary(["pancode-policy", "agent-managed", "deny-all"])),
			verification: Type.Object(
				{
					state: vocabulary(["verified", "unverified", "not_applicable", "unknown"]),
					basis: vocabulary([
						"validation-tool",
						"host-observed-command",
						"read-only-agent",
						"no-validation-tool",
						"retired-by-change",
						"dispatch-run-record",
						"acp-external-unobserved",
						"host-verification",
						"result-unavailable",
					]),
					detail: Type.Optional(text),
				},
				closed,
			),
			/** Null when the run settled before its result could be judged. */
			quality: nullable(
				Type.Object(
					{
						typedValidations: Type.Array(
							Type.Object({ sourceId: text, validatorDigest: digest, passed: Type.Boolean() }, closed),
							{ maxItems: 256 },
						),
						responseSchema: Type.Object(
							{
								sourceId: nullable(text),
								schemaDigest: nullable(digest),
								runtimeEnforceable: Type.Boolean(),
								enforcementPassed: nullable(Type.Boolean()),
							},
							closed,
						),
						resultContract: nullable(
							Type.Object(
								{
									sourceId: text,
									validatorDigest: digest,
									conformance: vocabulary(["pass", "fail", "not-reached"]),
									quality: vocabulary(["pass", "fail", "unmeasured"]),
								},
								closed,
							),
						),
					},
					closed,
				),
			),
			validationGrounding: nullable(
				Type.Object(
					{
						claimed: count,
						grounded: count,
						ungrounded: Type.Array(text, { maxItems: 64 }),
						basis: vocabulary([
							"grounded",
							"no-command-executed",
							"unmatched-command",
							"unattributable-status",
							"unobserved-lane",
						]),
					},
					closed,
				),
			),
			/**
			 * Calls the check classifier could not read that ran after the run's oldest standing check outcome, or ran and
			 * failed (x8-2), as the receipt discloses them: the count and up to 5 redacted commands. Absent when none ran.
			 */
			unclassifiedAfterLastCheck: Type.Optional(
				Type.Object({ count, commands: Type.Array(diagnostic, { maxItems: 5 }) }, closed),
			),
			/**
			 * The warnings dispatch resolved the run's route with, such as a thinking level the model could not run, so a
			 * sealed reader names them as the dispatch result did (FL-6). Absent when there were none.
			 */
			routeWarnings: Type.Optional(Type.Array(diagnostic, { maxItems: 16 })),
			/**
			 * Bytes of the run's answer its parent sees at sync, collect and record, fixed at dispatch and told to the
			 * worker (M3). Absent on a run settled unfinished, which reads as a lone run's budget.
			 */
			answerBudgetBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
			/**
			 * The grader's verdict (fleet M9): the obligation the run owed, each rule's result in layer order with the code
			 * a failing rule set, and the run's assurance. Absent on a run settled unfinished.
			 */
			verdict: Type.Optional(
				Type.Object(
					{
						version: Type.Literal(1),
						obligation: vocabulary(RUN_OBLIGATIONS),
						rules: Type.Array(
							Type.Object(
								{
									id: vocabulary(GRADE_RULE_IDS),
									layer: vocabulary(GRADE_LAYERS),
									status: vocabulary(GRADE_RULE_STATUSES),
									code: Type.Optional(RunOutcomeCode),
								},
								closed,
							),
							{ maxItems: 32 },
						),
						assurance: vocabulary(RUN_ASSURANCES),
					},
					closed,
				),
			),
			/**
			 * The capability envelope the run ran under (fleet M7) as its receipt sealed it, `staticHead` included, so an audit
			 * reads what a run was allowed after the fact (M-18). Absent for a run with no envelope.
			 */
			envelope: Type.Optional(
				Type.Object(
					{
						version: count,
						digest: envelopeDigest,
						permitDigest: envelopeDigest,
						role: ExistingId,
						skills: Type.Object({ bound: Type.Array(ExistingId, { maxItems: 1024 }), discovery: ExistingId }, closed),
						read: Type.Object(
							{ roots: Type.Array(text, { maxItems: 1024 }), outside: Type.Array(text, { maxItems: 1024 }) },
							closed,
						),
						write: Type.Object(
							{ mode: ExistingId, roots: Type.Array(text, { maxItems: 1024 }), commandsBounded: Type.Boolean() },
							closed,
						),
						exec: Type.Object({ shell: ExistingId, checks: ExistingId }, closed),
						network: Type.Object(
							{
								shell: Type.Boolean(),
								tools: Type.Array(ExistingId, { maxItems: 1024 }),
								mcp: Type.Array(ExistingId, { maxItems: 1024 }),
							},
							closed,
						),
						approval: Type.Object({ autonomy: ExistingId, asks: ExistingId }, closed),
						sandbox: Type.Object(
							{ backend: ExistingId, confinesWrites: Type.Boolean(), unconfined: Type.Optional(Type.Literal(true)) },
							closed,
						),
						withheld: Type.Array(
							Type.Object({ capability: ExistingId, reason: ExistingId, remedy: Type.Optional(text) }, closed),
							{ maxItems: 1024 },
						),
						/** Empty when the host never compiled the worker's prompt. */
						staticHead: envelopeDigest,
					},
					closed,
				),
			),
			/** The isolated writer checkout's verdict; its path, branch and changed paths are in the result object. */
			worktree: nullable(
				Type.Object(
					{
						apply: vocabulary(["merge", "preserve"]),
						applied: Type.Boolean(),
						snapshot: nullable(vocabulary(["working-tree", "unavailable"])),
					},
					closed,
				),
			),
			/** Orchestrator-run declared checks; their commands and output tails are in the result object. */
			hostVerification: nullable(
				Type.Object(
					{
						status: vocabulary(["verified", "rejected", "skipped", "not_implicated"]),
						strategy: vocabulary(["single", "batch-settled"]),
						checks: count,
						failed: count,
						/** Failing checks that also failed on the task base, so they cannot show the change caused them. */
						failedOnBase: count,
						/**
						 * How the checks were answered: run for this run, a pass reused from another run's memo, or not run.
						 * Only a verdict every check of which executed validates the run. Absent on runs settled before them.
						 */
						executed: Type.Optional(count),
						reused: Type.Optional(count),
						skipped: Type.Optional(count),
					},
					closed,
				),
			),
			/**
			 * Whether the briefing, worker context and project context the run was sent were recorded consistently, judged
			 * when the run settled; their hashes are in `hashes`, their text is never kept.
			 */
			contextProvenance: vocabulary(["recorded", "invalid", "not_applicable", "unknown"]),
			hashes: Type.Array(RunHashSchema, { maxItems: 512 }),
			result: ObjectRefSchema,
		},
		closed,
	);
}
/** `run.settled` version 2: the record a run writes, naming its execution role in the fleet role vocabulary (M12). */
export const RunSettledSchema = runSettledSchema(EXECUTION_ROLE_VOCABULARY);
export type RunSettled = Static<typeof RunSettledSchema>;

/** A number as a judged report writes it: JSON has no spelling for NaN or the infinities, so they are named. */
const reportedNumber = Type.Union([Type.Number(), vocabulary(["NaN", "Infinity", "-Infinity"])]);
/** Keys and failed keys a sealed judged report keeps; `keyCount` and `failedKeyCount` say how many there were. */
export const SEALED_CHECK_REPORT_KEYS_MAX = 64;
/**
 * The bounded verdict of a numeric-compare, perf-budget or reproduce check as the run's sealed result keeps it: the
 * rule and tolerance it judged by, the digests of the reference and payload it read, and each key's worst deviation.
 * Perf-budget has no keys; it carries its measurement and bound instead.
 */
const SealedCheckReportSchema = Type.Object(
	{
		kind: vocabulary(["numeric-compare", "perf-budget", "reproduce"]),
		passed: Type.Boolean(),
		rule: text,
		tolerance: Type.Object(
			{
				relative: Type.Optional(Type.Number()),
				absolute: Type.Optional(Type.Number()),
				ulp: Type.Optional(Type.Number()),
				combine: Type.Optional(text),
				nonFinite: Type.Optional(text),
			},
			closed,
		),
		/** The reference (perf-budget: the baseline) the judgement read; null when it read none. */
		reference: nullable(Type.Object({ path: nullable(Type.String()), sha256: Type.String() }, closed)),
		/** Digest of the payload text extracted from the command's stdout; null when there is none. */
		payloadSha256: nullable(Type.String()),
		keyCount: count,
		failedKeyCount: count,
		failedKeys: Type.Array(text, { maxItems: SEALED_CHECK_REPORT_KEYS_MAX }),
		/** Failing keys first, each with its worst deviation; null where a deviation is undefined or nothing compared. */
		keys: Type.Array(
			Type.Object(
				{
					key: text,
					passed: Type.Boolean(),
					absolute: nullable(reportedNumber),
					relative: nullable(reportedNumber),
					ulp: nullable(reportedNumber),
				},
				closed,
			),
			{ maxItems: SEALED_CHECK_REPORT_KEYS_MAX },
		),
		measuredMs: Type.Optional(duration),
		budgetMs: Type.Optional(duration),
		/** Declared input files and their digests before the run; absent when none was declared. */
		inputs: Type.Optional(
			Type.Array(Type.Object({ path: Type.String(), sha256: Type.String() }, closed), {
				maxItems: SEALED_CHECK_REPORT_KEYS_MAX,
			}),
		),
		/** Declared provenance probes as they ran; absent when none was declared. */
		probes: Type.Optional(
			Type.Array(
				Type.Object(
					{
						argv: Type.Array(text, { maxItems: 64 }),
						exitCode: nullable(Type.Integer()),
						sha256: nullable(Type.String()),
						version: nullable(text),
					},
					closed,
				),
				{ maxItems: 8 },
			),
		),
		/** Untracked files git does not ignore in the checkout a reproduce check ran from; absent for other kinds. */
		untracked: Type.Optional(count),
		/** Runs of a numeric-compare or reproduce check; 1 left determinism unchecked. Absent when the check recorded no repeat. */
		runs: Type.Optional(count),
		/** 1-based runs whose judgement failed. */
		failedRuns: Type.Optional(Type.Array(count, { maxItems: 8 })),
		/** Per key, the largest max-minus-min across runs, widest first; null when the runs cannot be lined up. */
		spread: Type.Optional(
			Type.Array(Type.Object({ key: text, spread: nullable(Type.Number({ minimum: 0 })) }, closed), {
				maxItems: SEALED_CHECK_REPORT_KEYS_MAX,
			}),
		),
	},
	closed,
);
export type SealedCheckReport = Static<typeof SealedCheckReportSchema>;

/** The `run-result` object a run.settled names: what the run delivered, redacted when it is stored (#434). */
/** A count with the first paths it covers, the bound a worktree receipt keeps its file lists to. */
const boundedPathList = Type.Object({ count: Type.Integer({ minimum: 0 }), paths: Type.Array(Type.String()) }, closed);
export const RunResultObjectSchema = Type.Object(
	{
		version: Type.Literal(1),
		output: nullable(
			Type.Object(
				{
					state: vocabulary(["final", "partial"]),
					text: Type.String(),
					bytes: count,
					truncated: Type.Boolean(),
					/** The host-validated internal handoff; `text` holds the same payload as canonical JSON. */
					structured: Type.Optional(
						Type.Object(
							{ version: Type.Literal(1), kind: ExistingId, data: Type.Record(Type.String(), Type.Unknown()) },
							closed,
						),
					),
				},
				closed,
			),
		),
		failureMessage: nullable(Type.String()),
		outcomeDetail: nullable(Type.String()),
		worktree: nullable(
			Type.Object(
				{
					path: Type.String(),
					branch: Type.String(),
					root: Type.Optional(Type.String()),
					base: Type.Optional(Type.String()),
					diffHash: nullable(Type.String()),
					changedPaths: Type.Optional(Type.Array(Type.String())),
					deletedPaths: Type.Optional(Type.Array(Type.String())),
					commit: Type.Optional(Type.String()),
					reason: Type.Optional(Type.String()),
					detail: Type.Optional(Type.String()),
					leftUncommitted: Type.Optional(boundedPathList),
					changedAfterCommit: Type.Optional(boundedPathList),
				},
				closed,
			),
		),
		checkoutChanges: nullable(
			Type.Object(
				{ cwd: Type.String(), changedPaths: Type.Array(Type.String()), attribution: Type.Literal("observed-delta") },
				closed,
			),
		),
		hostVerification: nullable(
			Type.Object(
				{
					reason: nullable(Type.String()),
					checks: Type.Array(
						Type.Object(
							{
								check: Type.String(),
								argv: Type.Array(Type.String()),
								cwd: Type.String(),
								exitCode: Type.Integer(),
								durationMs: duration,
								memo: Type.Boolean(),
								outputTail: Type.String(),
								evidenceRunId: nullable(Type.String()),
								/** Why the check ran nothing (refused, unconfigured, or its executable never started); absent when it ran. */
								notRun: Type.Optional(
									vocabulary(["refused", "unconfigured", "spawn-failed", "nothing-changed", "shutdown", "no-tests"]),
								),
								/** The same check replayed on the task base; null when it was not compared. */
								baseComparison: nullable(
									Type.Object(
										{
											status: vocabulary(["passed", "failed", "not_compared"]),
											base: Type.Optional(Type.String()),
											exitCode: Type.Optional(Type.Integer()),
											reason: Type.Optional(Type.String()),
										},
										closed,
									),
								),
								/** The judged verdict, bounded; absent for a command check. */
								report: Type.Optional(SealedCheckReportSchema),
								/** The checkout the verdict judged; absent outside Git. */
								tree: Type.Optional(
									Type.Object(
										{
											head: Type.String(),
											fingerprint: Type.String(),
											/** Untracked files git does not ignore in that checkout; absent when git could not count them. */
											untracked: Type.Optional(count),
										},
										closed,
									),
								),
							},
							closed,
						),
					),
				},
				closed,
			),
		),
	},
	closed,
);
export type RunResultObject = Static<typeof RunResultObjectSchema>;

export const RunFeedAppendedSchema = Type.Object(
	{ seq: Type.Integer({ minimum: 1 }), body: RunFeedBodySchema },
	closed,
);
export const RunLinkedSchema = Type.Object({ runId: ExistingId }, closed);

/** A dispatch run cancelled or drained. `runId` names the target, which a queued run's own journal may not hold. */
export const RunAbortedSchema = Type.Object(
	{
		source: vocabulary(["dispatch_abort", "dispatch_drain"]),
		runId: ExistingId,
		startedAt: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
		elapsedMs: Type.Union([duration, Type.Null()]),
	},
	closed,
);

/** A worker channel failure as the host saw it, in the run's journal (#425). */
export const WorkerChannelFailedSchema = Type.Object(
	{
		/** stdin carries control frames to the worker; stdout is the worker's NDJSON lane. */
		lane: vocabulary(["stdin", "stdout"]),
		/** The control frame whose write failed; null when no frame was being written. */
		frameType: Type.Union([Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }), Type.Null()]),
		/** The system error code, such as EPIPE; null when the failure was not a system error. */
		errno: Type.Union([Type.String({ pattern: "^E[A-Z0-9]{1,31}$" }), Type.Null()]),
		/** The worker process had already exited when the failure happened. */
		afterExit: Type.Boolean(),
		failure: vocabulary([
			"write-failed",
			"oversize-frame",
			"unserializable-frame",
			"backlog-full",
			"undrained",
			"invalid-frame",
		]),
	},
	closed,
);

/**
 * Closed routing vocabularies (#434). The dispatch domain maps its decision onto them, and a code or filter it does
 * not know reads as `unknown`, so a renamed reason surfaces instead of passing as free text.
 */
export const ROUTE_HARD_FILTERS = [
	"manual-pins",
	"approved-envelope",
	"audience",
	"authority",
	"required-tools",
	"required-skills",
	"result-contract",
	"response-schema-support",
	"locality",
	"authentication",
	"network-policy",
	"endpoint-reachability",
	"model-context",
	"resource-fit",
	"capacity-lease-availability",
	"budget",
	"deadline",
	"cooldown",
	"routing-intent",
	"fixed-executed-route",
	"unknown",
] as const;
export const ROUTE_REASONS = [
	"hard-filter-rejected",
	"active-readiness-excluded",
	"posture-floor-excluded",
	"posture-floors-unsatisfiable",
	"manual-posture-exact-route",
	"no-admissible-candidate",
	"executed-route-not-admissible",
	"shadow-advisory-only",
	"shadow-differs-from-executed",
	"observer-failure-fixed-route",
	"unknown",
] as const;
function routeTuple<const R extends readonly string[]>(roles: R) {
	return Type.Object(
		{
			agentId: ExistingId,
			executionRole: vocabulary(roles),
			targetId: ExistingId,
			modelId: ExistingId,
			runtimeId: ExistingId,
			nodeId: ExistingId,
		},
		closed,
	);
}
const finiteOrNull = Type.Union([Type.Number(), Type.Null()]);
/**
 * One routing decision, in the journal of the session or run that asked (#434). Candidates, verdicts and reasons
 * are the decision's own; prompts, specs and settings appear only through the decision hash.
 */
function routeDecidedSchema<const R extends readonly string[]>(roles: R) {
	const route = routeTuple(roles);
	return Type.Object(
		{
			policyVersion: ExistingId,
			mode: vocabulary(["fixed", "shadow", "active"]),
			posture: vocabulary(["manual", "quality", "balanced", "latency", "economy"]),
			decisionHash: ExistingId,
			decisionDurationMs: duration,
			confidence: finiteOrNull,
			selected: route,
			executed: route,
			fallbacks: Type.Array(route),
			recommendedAgentId: ExistingId,
			candidates: Type.Array(
				Type.Object(
					{
						route: route,
						rejection: Type.Union([vocabulary(ROUTE_HARD_FILTERS), Type.Null()]),
						/** Null for a rejected candidate, which is never scored. */
						score: finiteOrNull,
						dominated: Type.Boolean(),
						samples: count,
						ready: Type.Boolean(),
					},
					closed,
				),
			),
			reasons: Type.Array(Type.Object({ code: vocabulary(ROUTE_REASONS), count: Type.Optional(count) }, closed)),
			/** Whether the policy would have run another route, and whether the route that ran passed every hard filter. */
			verdict: Type.Object({ differs: Type.Boolean(), executedAdmissible: Type.Boolean() }, closed),
		},
		closed,
	);
}
/** `route.decided` version 2, its routes naming execution roles in the fleet role vocabulary (M12). */
export const RouteDecidedSchema = routeDecidedSchema(EXECUTION_ROLE_VOCABULARY);
const sha256OrNull = Type.Union([sha256Hex, Type.Null()]);
const gateSubject = Type.Object({ runId: ExistingId, digest: sha256OrNull }, closed);
/** A decided review or compete gate, in the journal of the run the gate's group belongs to (#434). */
export const GateDecidedSchema = Type.Object(
	{
		decisionId: ExistingId,
		group: ExistingId,
		topology: vocabulary(["review", "compete"]),
		cycle: count,
		outcome: vocabulary([
			"pass",
			"fail",
			"revise",
			"exhausted",
			"winner",
			"no-winner",
			"operator-confirmed",
			"yolo-applied",
		]),
		subjects: Type.Array(gateSubject),
		decider: Type.Optional(gateSubject),
		/** Whether the decider's route was independent of the subjects it graded; present whenever a decider is. */
		independent: Type.Optional(Type.Boolean()),
		winner: Type.Optional(Type.Object({ index: count, runId: ExistingId }, closed)),
		confirms: Type.Optional(ExistingId),
		digest: sha256Hex,
	},
	closed,
);
/** A settled deterministic code step of a fleet run; its output stays in the step's artifact log (#434). */
export const CodeStepSettledSchema = Type.Object(
	{
		runId: ExistingId,
		stepId: ExistingId,
		commandId: ExistingId,
		startedAt: utc,
		durationMs: duration,
		timeoutMs: duration,
		exitCode: Type.Integer(),
		signal: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
		timedOut: Type.Boolean(),
		commands: Type.Array(Type.Object({ exitCode: Type.Integer(), durationMs: duration }, closed)),
		outputBytes: count,
		outputTruncated: Type.Boolean(),
		outputDigest: sha256Hex,
		reportDigest: sha256Hex,
	},
	closed,
);
const runtimeKind = vocabulary(["http", "sdk", "subprocess", "acp-delegation"]);
/**
 * A run admitted to dispatch. It lands in the run's journal when the run already has one (a retry or fleet step at
 * spawn), else in the asker's, which is why it names its run (#434).
 */
export const RunEnqueuedSchema = Type.Object(
	{
		runId: ExistingId,
		agentId: ExistingId,
		requestOrigin: Type.Union([vocabulary(["user", "agent", "internal", "harness"]), Type.Null()]),
		targetId: ExistingId,
		wireModelId: ExistingId,
		runtimeId: ExistingId,
		runtimeKind,
		node: Type.Optional(ExistingId),
		endpointLimit: Type.Optional(count),
		gate: Type.Optional(Type.Object({ role: ExistingId, cycle: count }, closed)),
		rerouteCount: Type.Optional(count),
	},
	closed,
);
/** A run's worker is live; the run's journal holds it, so the envelope names the run (#434). */
export const RunStartedSchema = Type.Object(
	{
		pid: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
		assignmentId: ExistingId,
		attempt: count,
	},
	closed,
);
