// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Session and turn records: lifecycle, journal segments, autonomy, agent status and message steps (#434). */

import type { Static } from "typebox";
import { Type } from "typebox";
import { FailureCause, StopReason, TurnNoAnswerCause, vocabulary } from "./enums.js";
import { AttemptIdSchema, CallIdSchema, ExistingId } from "./id-schemas.js";
import { closed, count, duration, text } from "./schemas.js";

/**
 * session.opened and session.resumed are written when the session itself opens or resumes, beside meta.json's
 * reopen, and never when a writer reopens after an idle close: the read model reads either one newer than a ledger
 * close as the session reopening (#434 §6.1).
 */
export const EmptySchema = Type.Object({}, closed);

export const JournalGapSchema = Type.Object(
	{
		sink: ExistingId,
		reason: vocabulary([
			"torn-tail",
			"writer-drop",
			"writer-error",
			"unknown-kind",
			"unknown-version",
			"invalid-record",
			"rotation",
			// The segment's mode or capture flags no longer admitted a record queued before a change (#434).
			"mode-filtered",
			// The session's research capture reached its byte cap; accountability records continue (#434).
			"research-cap",
			// A damaged interior line retired the segment named by `sink`; `count` is its damaged lines.
			"interior-corruption",
		]),
		count: Type.Integer({ minimum: 1 }),
	},
	closed,
);
export const SessionForkedSchema = Type.Object(
	{
		parentSessionId: ExistingId,
		parentCwdHash: ExistingId,
		parentTurnId: ExistingId,
		parentTurnAt: text,
	},
	closed,
);
/** Why the session stopped being current: the park reason, or `shutdown` when the process ended with it open (#434). */
export const SessionCloseReason = vocabulary([
	"create_new",
	"resume_other",
	"fork",
	"switch_branch",
	"close",
	"shutdown",
]);
export const SessionClosedSchema = Type.Object({ reason: SessionCloseReason }, closed);
export const SessionResumedSchema = Type.Object({ via: vocabulary(["resume", "switch_branch"]) }, closed);
export const JournalSegmentClosedSchema = Type.Object(
	{ reason: vocabulary(["rotation", "mode-change", "shutdown"]) },
	closed,
);
export const TurnSettledSchema = Type.Object(
	{
		stopReason: StopReason,
		terminal: Type.Object(
			{
				cause: Type.Union([FailureCause, Type.Null()]),
				// The last stage the turn's final call reached: `streaming` once it produced output. Null when a stop with a
				// cause landed after that call ended, as a cap does at the tool boundary (bt-26 N2f).
				stage: Type.Union([vocabulary(["transform", "auth", "admission", "send", "streaming"]), Type.Null()]),
				retries: count,
				/**
				 * The turn's calls settled by turn end. A call settling later stays journaled under the same ctx.turnId
				 * and counts in every total; a reader finds it as a matching turn id missing from this list (#434).
				 */
				callIds: Type.Array(CallIdSchema),
				/**
				 * Set when the turn stopped normally yet answered nothing, so the run failed: why, as every surface reads
				 * it. Absent on a turn that answered and in journals before bt-session-res J1.
				 */
				noAnswer: Type.Optional(TurnNoAnswerCause),
			},
			closed,
		),
		/**
		 * Attended finish calls this user turn refused because their response carried no reply text (FX-40, CLI-P50), so
		 * the rate per model is readable from the journal. Absent when none was refused and in journals before CLI-P50.
		 */
		bareFinishRefusals: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	closed,
);
/**
 * How a step template's pipeline ended (`StepPipelineEnd`, bt-15): `done` when its step tool reported `pipelineDone`,
 * otherwise `stoppedBy` names the continuation cap, a cancel, a terminal failure, the end of a turn nothing continued, or a last turn that made no
 * step call (`unreported`). Journaled after the fact so a reader need not have watched the `run --json` stream (bt-20).
 */
export const StepPipelineSettledSchema = Type.Object(
	{
		stepTool: ExistingId,
		template: Type.Optional(ExistingId),
		done: Type.Boolean(),
		stoppedBy: Type.Optional(vocabulary(["cap", "turn", "cancel", "failure", "unreported"])),
	},
	closed,
);

/** A main turn's stream stopped by the operator, the loop guard, a job's clock or a yolo pause; no dispatch run is involved (#434, #445). */
export const TurnAbortedSchema = Type.Object(
	{ source: vocabulary(["stream_cancel", "loop_guard", "job_clock", "autonomy", "triage"]) },
	closed,
);
/** A job continued past its default clock, the one automatic continuation a turn gets (#445). */
export const JobClockResumedSchema = Type.Object({ jobId: ExistingId, boundMs: duration }, closed);
export const TurnContinuedSchema = Type.Object(
	{
		cause: vocabulary([
			"clock",
			"failure",
			"tool_budget",
			"step",
			"loop_guard",
			"retries_exhausted",
			"compaction",
			"job_exhausted",
			"job_deadline",
			"polls_failing",
		]),
		attempt: count,
		cap: count,
		jobId: Type.Optional(ExistingId),
		/** The user turn this continuation continues, as its records name it in `ctx.turnId` (memory design 4.6). */
		continues: Type.Optional(ExistingId),
	},
	closed,
);
/** Contained yolo's audit (ob-yolo D7): what ran on its own, what it left for the operator, and why it stopped. */
const autonomyUsage = { toolCalls: count, activeMs: duration, tokens: count };
export const AutonomyHaltKind = vocabulary(["calls", "minutes", "tokens", "judge", "exploration"]);
export const AutonomyOpenDecisionKind = vocabulary(["judge-block", "no-verdict", "operator-only", "outward-unnamed"]);
export const AutonomyEndReason = vocabulary([
	"autonomous-cap",
	"judge-streak",
	"exploration_stalled",
	"shutdown",
	"left-yolo",
	"session-changed",
]);
export const AutonomyEnteredSchema = Type.Object(
	{
		confinement: vocabulary(["contained", "unconfined"]),
		capToolCalls: count,
		capMinutes: count,
		capTokens: count,
	},
	closed,
);
/** A call yolo refused because it needed the operator; the command stays live only. */
export const AutonomyOpenDecisionSchema = Type.Object(
	{
		tool: ExistingId,
		kind: AutonomyOpenDecisionKind,
		rule: Type.Optional(ExistingId),
		seq: count,
	},
	closed,
);
export const AutonomyCapReachedSchema = Type.Object(
	{ kind: AutonomyHaltKind, limit: Type.Optional(count), ...autonomyUsage, openDecisions: count },
	closed,
);
export const AutonomyResumedSchema = Type.Object({ cleared: AutonomyHaltKind }, closed);
export const AutonomyEndedSchema = Type.Object(
	{
		reason: AutonomyEndReason,
		...autonomyUsage,
		openDecisions: count,
	},
	closed,
);
const StatusPhase = vocabulary([
	"idle",
	"preparing",
	"waiting_model",
	"thinking",
	"writing",
	"tool_running",
	"tool_blocked",
	"retrying",
	"compacting",
	"dispatching",
	"stuck",
	"cancelling",
	"ended",
]);
export const AgentStatusChangedSchema = Type.Object(
	{
		phase: StatusPhase,
		prevPhase: StatusPhase,
		elapsedFromStart: duration,
		watchdogTier: Type.Integer({ minimum: 0, maximum: 4 }),
		toolName: Type.Optional(ExistingId),
		attempt: Type.Optional(count),
		agentName: Type.Optional(ExistingId),
		stopReason: Type.Optional(ExistingId),
	},
	closed,
);

export const MESSAGE_STEP = vocabulary([
	"submitted",
	"queued",
	"lane-changed",
	"held",
	"released",
	"handed-over",
	"returned",
	"carried",
	"removed",
]);
export const MESSAGE_LANE = vocabulary(["prompt", "steer", "follow-up"]);
export const MESSAGE_BY = vocabulary(["operator", "machine"]);
export const MESSAGE_LANE_CHANGED_BY = vocabulary(["operator", "producer"]);
/** Why a held message waits, or why a message handed to the engine came back. */
export const MESSAGE_WAIT_WHY = vocabulary([
	"operator-stop",
	"interrupt",
	"prompt-not-started",
	"session-move",
	"run-cancelled",
]);
export const MESSAGE_SLOT = vocabulary(["finish-turn", "prepare-next-turn", "prompt"]);
export const MESSAGE_REMOVAL = vocabulary([
	"removed",
	"sent-now",
	"to-editor",
	"restored",
	"cancelled",
	"resubmitted",
	"not-started",
]);
/**
 * One step of an operator message's path from submit to the provider call that carried it. The id is minted by the
 * host and never enters the request, so recording a path cannot change the prefix a provider caches. Lengths and
 * points only: the text stays in the session ledger. A send-now or a resubmit keeps the id of the entry it took.
 */
export const MessageSteppedSchema = Type.Object(
	{
		messageId: ExistingId,
		step: MESSAGE_STEP,
		/** Epoch milliseconds the message was submitted, so any reader gets its wait from the record's own time. */
		submittedAt: count,
		by: Type.Optional(MESSAGE_BY),
		/** The submitted text's length in UTF-16 code units. */
		chars: Type.Optional(count),
		lane: Type.Optional(MESSAGE_LANE),
		changedBy: Type.Optional(MESSAGE_LANE_CHANGED_BY),
		why: Type.Optional(MESSAGE_WAIT_WHY),
		slot: Type.Optional(MESSAGE_SLOT),
		reason: Type.Optional(MESSAGE_REMOVAL),
		callId: Type.Optional(CallIdSchema),
		attemptId: Type.Optional(AttemptIdSchema),
		attempt: Type.Optional(count),
	},
	closed,
);
export type MessageStepped = Static<typeof MessageSteppedSchema>;
