// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Context records: reductions, folds, recalls, compaction, snapshots and prompt captures (#434). */

import type { Static } from "typebox";
import { Type } from "typebox";
import { vocabulary } from "./enums.js";
import { CallIdSchema, ExistingId } from "./id-schemas.js";
import { closed, count, duration, ObjectRefSchema, sha256Hex, UtcSchema as utc } from "./schemas.js";

/** One context reduction: which stage ran, the tokens it moved, and what it removed (#434). */
export const ContextPrunedSchema = Type.Object(
	{
		stage: vocabulary(["superseded", "working_set", "llm_summary", "step_checkpoint"]),
		tokensBefore: count,
		tokensAfter: count,
		trigger: vocabulary(["auto", "force", "overflow", "step"]),
		snapshotIdBefore: Type.Union([ExistingId, Type.Null()]),
		snapshotIdAfter: ExistingId,
		at: duration,
		/** Used/window ratio at trigger time; working-set stages only. */
		pressure: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
		/** Working-set policy that selected an applied eviction event. */
		policyId: Type.Optional(ExistingId),
		/** Number of working-set units evicted by the event. */
		evictedItems: Type.Optional(count),
	},
	closed,
);
/**
 * A session history re-entered with a runtime (resume, fork, tree navigation): the figure the session was last
 * measured at beside the next request the resumed history projects, so a divergence between them is visible (CLI-P37).
 */
export const ContextResumedSchema = Type.Object(
	{
		/** The last persisted provider measurement of this session: its prompt tokens plus that call's output. */
		priorTokens: Type.Optional(count),
		/** The input the next request is budgeted at, the figure the footer, admission and the fold trigger read. */
		projectedTokens: count,
		/** The chars/4 figure of the same request. */
		estimatedTokens: Type.Optional(count),
		inputSource: vocabulary(["estimated", "anchored-plus-estimated-tail", "historical", "unknown"]),
	},
	closed,
);
/**
 * One fold checkpoint's decision (ContextFold CF-1): where it ran, what the route reports, and each stage it
 * reached with its outcome and the ledger record a commit wrote. A checkpoint under the trigger writes none.
 */
export const ContextFoldSchema = Type.Object(
	{
		checkpoint: vocabulary(["submit", "tool_batch", "overflow", "operator", "step"]),
		route: Type.Object(
			{
				modelTier: Type.Optional(vocabulary(["small", "standard", "frontier"])),
				promptCaching: Type.Optional(Type.Boolean()),
			},
			closed,
		),
		stages: Type.Array(
			Type.Object(
				{
					stage: vocabulary(["superseded", "working_set", "step_checkpoint", "llm_summary", "stop"]),
					outcome: vocabulary(["committed", "held", "none", "failed"]),
					/**
					 * A worker commit that took a protected read names it: `unseen_overflow` when any read the
					 * model had not answered left, otherwise `step_overflow` when any read it had seen did.
					 */
					reason: vocabulary([
						"evicted",
						"step_overflow",
						"unseen_overflow",
						"summarized",
						"step_boundary",
						"rearm_band",
						"paused",
						"disabled",
						"no_candidates",
						"unavailable",
						"no_gain",
						"below_floor",
						"protected_recent",
						"protected_skill",
						"repeat_no_gain",
						"nothing_to_summarize",
						"error",
					]),
					/** The turn id of the `contextEviction` or `compactionSummary` record a commit wrote. */
					recordId: Type.Optional(ExistingId),
				},
				closed,
			),
			{ minItems: 1, maxItems: 8 },
		),
		tokensBefore: count,
		tokensAfter: count,
		/** The expected cold-cache reason of the last stage that committed. */
		cause: Type.Optional(vocabulary(["observation_aging", "working_set_evict", "compaction", "step_checkpoint"])),
	},
	closed,
);
/**
 * One fleet briefing the byte cap shortened (ContextFold CF-10): the council seat or judge run it went to, the cap,
 * the bytes sent, and each part it clipped by kind and position with that part's bytes before and after.
 */
export const ContextBriefingClippedSchema = Type.Object(
	{
		runId: ExistingId,
		role: vocabulary(["member", "synthesis"]),
		group: ExistingId,
		round: count,
		capBytes: count,
		bytes: count,
		parts: Type.Array(
			Type.Object(
				{
					kind: vocabulary(["framing", "task", "evidence"]),
					index: count,
					bytesBefore: count,
					bytesAfter: count,
				},
				closed,
			),
			{ minItems: 1, maxItems: 16 },
		),
	},
	closed,
);
/** One working-set unit readmitted to context, by its unit ref (#434). */
export const ContextRecalledSchema = Type.Object(
	{
		ref: ExistingId,
		trigger: vocabulary(["tool", "operator", "reread"]),
		tokensReadmitted: count,
		at: duration,
	},
	closed,
);

/** The route's context-window warning starting or ending; its text stays on the live notice (#434). */
export const ContextWarningRaisedSchema = Type.Object({ state: vocabulary(["raised", "cleared"]) }, closed);

/**
 * Why a compaction settled `failed` (FX-6): stopped, its summary call failed or hit the output cap, its request did not
 * fit the summarizer's window, the validator refused the checkpoint, admission refused it, the session moved under it,
 * or the checkpoint could not be written.
 */
export const CompactionFailureCause = vocabulary([
	"aborted",
	"provider",
	"output_cap",
	"window",
	"checkpoint_format",
	"refused",
	"superseded",
	"persistence",
	"internal",
]);
export type CompactionFailureCause = Static<typeof CompactionFailureCause>;
/** What the checkpoint validator refused: no text, a tool call, a required heading missing or repeated, an open fence. */
export const CheckpointDefect = vocabulary(["empty", "tool_call", "heading_set", "unclosed_fence"]);
export type CheckpointDefect = Static<typeof CheckpointDefect>;
export const CompactionSettledSchema = Type.Object(
	{
		callIds: Type.Array(CallIdSchema, { minItems: 1, uniqueItems: true }),
		outcome: vocabulary(["committed", "discarded", "failed", "unresolved"]),
		checkpointTurnId: Type.Union([ExistingId, Type.Null()]),
		/** Tokens the committed context sits below the automatic trigger; 0 when the cut stayed at or above it. */
		headroomTokens: Type.Optional(count),
		/** Tokens a committed cut still sits above the automatic trigger; absent when it landed below. */
		overTriggerTokens: Type.Optional(count),
		/** The output reserve a request at the committed size is fitted with, resolved on the chat route. */
		fitReserveTokens: Type.Optional(count),
		/** The output cap the summary request was sent with, when PanCode bounded it. */
		summaryOutputCap: Type.Optional(count),
		/** The checkpoint room the summary request stated, when it stated one. */
		summaryRoomTokens: Type.Optional(count),
		/** Why a `failed` compaction failed; absent on every other outcome. */
		failureCause: Type.Optional(CompactionFailureCause),
		/** What the validator refused, when `failureCause` is `checkpoint_format`. */
		checkpointDefect: Type.Optional(CheckpointDefect),
	},
	closed,
);

/** The compiled system prompt's redacted text, linked to calls by the structure ref they carry (#434). */
export const PromptTextCapturedSchema = Type.Object(
	{ structure: Type.Optional(ObjectRefSchema), text: ObjectRefSchema, bytes: count },
	closed,
);

/**
 * The first request of this writer to cite a compiled prompt structure; ctx names that call. The structure object
 * holds the compile metadata, preload accounting, section ids and fragment hashes (#434).
 */
export const PromptCompiledSchema = Type.Object(
	{
		structure: ObjectRefSchema,
		/** PROMPT_MANIFEST_VERSION: the prompt's layout version. */
		layoutVersion: Type.Integer({ minimum: 1 }),
		tokenEstimate: count,
		sections: count,
		thinkingLevel: Type.Optional(ExistingId),
		contextWindow: Type.Optional(count),
		contextWindowSource: Type.Optional(ExistingId),
		/** When the prompt was compiled; outside the structure object so a byte-stable recompile keeps its id. */
		compiledAt: Type.Optional(utc),
		/** The prompt hash this compile replaced, null for a session's first; outside the structure object for the same reason. */
		previousHash: Type.Optional(Type.Union([sha256Hex, Type.Null()])),
	},
	closed,
);
/**
 * The persisted context snapshot's token split. ctx carries the real session and turn, and the call the snapshot was
 * reconciled against when it was (#434).
 */
export const ContextSnapshottedSchema = Type.Object(
	{
		snapshotId: ExistingId,
		providerId: Type.Union([ExistingId, Type.Null()]),
		runtimeId: Type.Union([ExistingId, Type.Null()]),
		modelId: Type.Union([ExistingId, Type.Null()]),
		promptSegments: Type.Optional(Type.Array(Type.Object({ id: ExistingId, tokenEstimate: count }, closed))),
		splits: Type.Record(Type.String(), vocabulary(["estimated", "exact", "reconciled"])),
		promptHash: Type.Optional(sha256Hex),
		toolSignature: Type.Optional(Type.String()),
		messageRange: Type.Optional(Type.Object({ start: count, end: count }, closed)),
		divergenceRatio: Type.Optional(Type.Number({ minimum: 0 })),
		categories: Type.Object(
			{
				system: count,
				tools: count,
				toolResults: Type.Optional(count),
				agents: count,
				skills: count,
				memory: count,
				project: count,
				messages: count,
				reserve: count,
				free: count,
				streaming: count,
			},
			closed,
		),
		window: Type.Object({ desired: count, effective: count, source: ExistingId }, closed),
		source: vocabulary(["estimated", "exact", "reconciled", "streaming"]),
		/** The chars/4 prompt-side total the snapshot was captured with. */
		estimatedTokens: Type.Optional(count),
		/** The provider's prompt tokens for the call it was reconciled against. */
		reconciledTokens: Type.Optional(count),
	},
	closed,
);

/**
 * The request's prefix as a list of block hashes, so a cache break can be placed on the block that moved. Each
 * hash commits to text the journal does not keep (#423, #434).
 */
export const PromptPrefixCapturedSchema = Type.Object(
	{
		label: Type.Literal("commitment"),
		function: Type.Literal("sha256"),
		/** A system section hashes its trimmed UTF-8 text; the tool set and each message hash their JSON. */
		canonicalization: Type.Literal("pancode-prefix-v1"),
		blocks: Type.Array(
			Type.Object(
				{
					kind: vocabulary(["system-section", "tools", "message"]),
					/** The section id or message role; absent for the tool set. */
					id: Type.Optional(ExistingId),
					hash: sha256Hex,
					tokens: count,
				},
				closed,
			),
			{ minItems: 1, maxItems: 4096 },
		),
		/** Blocks past the cap, which the list does not name. */
		omitted: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	closed,
);
