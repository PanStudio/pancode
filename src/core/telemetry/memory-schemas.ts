// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Task memory records: traces, observations, step decisions and the guardian (#434). */

import type { Static } from "typebox";
import { Type } from "typebox";
import { vocabulary } from "./enums.js";
import { factSchema } from "./fact.js";
import { AttemptIdSchema, CallIdSchema, ExistingId } from "./id-schemas.js";
import { closed, count, duration, ObjectRefSchema, text, UsageSchema, UtcSchema as utc } from "./schemas.js";
import { MEMORY_GUARDIAN_STATES } from "./session-vocabulary.js";

/** A task-memory step's prompt and reply in a consented research object (#434). */
export const MemoryTracedSchema = Type.Object(
	{
		decision: Type.String({ minLength: 1, maxLength: 64 }),
		reason: Type.String({ minLength: 1, maxLength: 64 }),
		bankOperations: count,
		droppedOperations: count,
		responseChars: count,
		userPromptChars: count,
		systemPromptChars: count,
		content: ObjectRefSchema,
		bytes: count,
	},
	closed,
);
/** One memory or compaction observation event and its facts in a consented research object (#434). */
export const MemoryObservedSchema = Type.Object(
	{ event: Type.String({ minLength: 1, maxLength: 64 }), content: ObjectRefSchema, bytes: count },
	closed,
);

// Memory outcomes are structural; raw prompts and replies use the research object events (#434).
const memoryClassDelta = Type.Object({ added: count, updated: count, deleted: count }, closed);
const memoryRoute = Type.Object({ targetId: ExistingId, modelId: ExistingId }, closed);
export const MemoryStepDecidedSchema = Type.Object(
	{
		triggerReasons: Type.Array(
			vocabulary([
				"interval",
				"tool_error_streak",
				"loop_signal",
				"repeated_failure",
				"durable_lesson",
				"durable_lesson_variant",
				"durable_lesson_verify",
				"durable_lesson_subject",
				"durable_lesson_task",
				"turn_end",
				"post_compaction",
				"idle_review",
				"manual",
			]),
			{ minItems: 1, uniqueItems: true },
		),
		tier: vocabulary(["rules", "llm"]),
		bankDelta: Type.Object(
			{ status: memoryClassDelta, knowledge: memoryClassDelta, procedural: memoryClassDelta },
			closed,
		),
		decision: vocabulary(["silent", "injected", "gated", "timeout", "malformed", "dropped"]),
		reason: vocabulary([
			"intervened",
			"model_silent",
			"duplicate_reminder",
			"suppressed",
			"uncited",
			"invalid_path",
			"resolved_failure",
			"no_lost_context",
			"over_budget",
			"invalid_reminder",
			"unparseable",
			"all_operations_invalid",
			"deadline",
			"timed_out",
			"endpoint_busy",
			"endpoint_preempted",
			"cost_ceiling",
			"quota_unknown",
			"quota_window",
			"quota_retry",
			"time_budget",
			"side_share",
			"client_error",
			"information_flow_blocked",
			"no_client",
			"no_consumer",
			"step_in_flight",
			"llm_timeout_backoff",
			"no_repeated_failure",
			"bank_empty",
			"scope_changed",
		]),
		bankOperations: count,
		droppedOperations: count,
		citedEntries: count,
		inputTokens: factSchema(count),
		outputTokens: factSchema(count),
		latencyMs: factSchema(duration),
		unmeteredCalls: Type.Optional(count),
		calls: Type.Optional(Type.Array(Type.Object({ callId: CallIdSchema, attemptId: AttemptIdSchema }, closed))),
		route: Type.Optional(memoryRoute),
		resumeAt: Type.Optional(utc),
	},
	closed,
);
export const MemoryStepCompletedSchema = Type.Object({ endpointKey: text, targetId: ExistingId }, closed);
export const MemoryGuardianChangedSchema = Type.Object({ state: vocabulary(MEMORY_GUARDIAN_STATES) }, closed);
export const MemoryObservationRecordedSchema = Type.Object(
	{
		event: vocabulary([
			"artifacts-retired",
			"batch-ready",
			"checkpoint-committed",
			"consumption-recovered",
			"durable-lessons-held",
			"durable-lessons-submitted",
			"history-candidates-replayed",
			"history-lessons-filed",
			"invalidated",
			"lesson-approved",
			"lesson-candidates-rejected",
			"lesson-candidates-restored",
			"lesson-candidates-revalidated",
			"lesson-demoted",
			"lesson-extraction-abstained",
			"lesson-extraction-completed",
			"lesson-extraction-deferred",
			"lesson-extraction-settled",
			"lesson-extraction-skipped",
			"lesson-extraction-started",
			"lesson-judgment",
			"lesson-judgment-gated",
			"lesson-retention-deferred",
			"lesson-retention-orphan",
			"lesson-retention-restored",
			"lesson-withheld",
			"lessons-retained",
			"memory-recall-results",
			"memory-reminders-submitted",
			"memory-section-selected",
			"memory-section-submitted",
			"notes-rejected",
			"offer-declined",
			"offer-used",
			"preparation-failed",
			"preparation-settled",
			"reflection-ready",
			"reminder-entries-submitted",
			"reminder-outcomes",
			"restoration-delivered",
			"restoration-inherited",
		]),
		facts: Type.Object(
			{
				count: Type.Optional(count),
				/** Admitted reminder bytes, on `memory-reminders-submitted`. */
				bytes: Type.Optional(count),
				grounded: Type.Optional(count),
				ungrounded: Type.Optional(count),
				rejected: Type.Optional(count),
				offered: Type.Optional(count),
				offerable: Type.Optional(count),
				units: Type.Optional(count),
				incompleteUnits: Type.Optional(count),
				attempts: Type.Optional(count),
				timeoutMs: Type.Optional(count),
				operations: Type.Optional(count),
				dropped: Type.Optional(count),
				extracted: Type.Optional(count),
				candidates: Type.Optional(count),
				accepted: Type.Optional(count),
				entries: Type.Optional(count),
				splitEntries: Type.Optional(count),
				revision: Type.Optional(Type.Union([text, Type.Null()])),
				priorObservationRevision: Type.Optional(Type.Union([text, Type.Null()])),
				batchId: Type.Optional(Type.Union([text, Type.Null()])),
				digest: Type.Optional(Type.Union([text, Type.Null()])),
				sourceDigest: Type.Optional(Type.Union([text, Type.Null()])),
				sourceSessionId: Type.Optional(Type.Union([text, Type.Null()])),
				commitId: Type.Optional(Type.Union([text, Type.Null()])),
				reason: Type.Optional(Type.Union([text, Type.Null()])),
				phase: Type.Optional(Type.Union([text, Type.Null()])),
				id: Type.Optional(Type.Union([text, Type.Null()])),
				by: Type.Optional(Type.Union([text, Type.Null()])),
				filing: Type.Optional(Type.Union([text, Type.Null()])),
				final: Type.Optional(Type.Boolean()),
				answered: Type.Optional(Type.Boolean()),
				unavailable: Type.Optional(Type.Boolean()),
				split: Type.Optional(Type.Boolean()),
				ids: Type.Optional(Type.Array(ExistingId)),
				retainedIds: Type.Optional(Type.Array(ExistingId)),
				/** The turn a `memory-section-selected` decision prepared for; null for a prewarm read. */
				turnId: Type.Optional(Type.Union([text, Type.Null()])),
				/** Each eligible record's decision on `memory-section-selected`, bounded; `dropped` counts the rest. */
				selection: Type.Optional(
					Type.Array(
						Type.Object(
							{
								id: ExistingId,
								decision: vocabulary(["selected", "withheld"]),
								reason: vocabulary([
									"selected",
									"check-command",
									"token-budget",
									"item-limit",
									"not-relevant",
									"delivery-refused",
								]),
							},
							closed,
						),
					),
				),

				sourceTokens: Type.Optional(factSchema(count)),
				noteTokens: Type.Optional(factSchema(count)),
				originalInputTokens: Type.Optional(factSchema(count)),
				substitutedInputTokens: Type.Optional(factSchema(count)),
				proposed: Type.Optional(factSchema(count)),
				raw: Type.Optional(factSchema(count)),
				window: Type.Optional(count),
				durationMs: Type.Optional(factSchema(duration)),
				route: Type.Optional(Type.Union([memoryRoute, Type.Null()])),
				outcomes: Type.Optional(
					Type.Array(
						Type.Object({ kind: vocabulary(["held", "contradicted", "unresolved"]), ids: Type.Array(ExistingId) }, closed),
					),
				),
				offerId: Type.Optional(ExistingId),
				batchIds: Type.Optional(Type.Array(ExistingId)),
				inputIds: Type.Optional(Type.Array(ExistingId)),
				offerIds: Type.Optional(Type.Array(ExistingId)),
				decision: Type.Optional(vocabulary(["silent", "injected", "gated", "timeout", "malformed"])),
				proven: Type.Optional(Type.Array(vocabulary(["trap_fix", "read_run"]))),
				usage: Type.Optional(UsageSchema),
				call: Type.Optional(Type.Object({ callId: CallIdSchema, attemptId: AttemptIdSchema }, closed)),
			},
			closed,
		),
	},
	closed,
);
export type MemoryObservationRecorded = Static<typeof MemoryObservationRecordedSchema>;
