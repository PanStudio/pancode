// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Fleet wire shapes: delegation results, the session jobs list, and the
 * `/fleet` preview and run results a client validates.
 */

import type { Static } from "typebox";
import { Type } from "typebox";
import { JOB_DELIVERY_STATES, JOB_OUTCOMES } from "../core/job-types.js";
import { literalUnion } from "../core/telemetry/enums.js";
import type { AgentMessage } from "../engine/types.js";
import { ACP_MAX_JOBS } from "./runtime.js";
import type { AcpInitializeResponse } from "./types.js";
import { closed } from "./types.js";

/** A provider quota or usage limit a peer hit, read from a source its ACP answer did not carry (agy's own store). */
export interface AcpUsageLimit {
	cause: "usage_limit_reached";
	reason: string;
	/** Bounded text PanCode wrote; never the provider's prose. */
	message: string;
	model?: string;
	/** ISO time the provider said the limit resets. */
	resetAt?: string;
	resetDelayMs?: number;
	retryAfterMs?: number;
}

/** Failures the adapter types: the peer needs sign-in, refused the requested model or thinking level, or its channel broke. */
export type AcpDelegationFailureCode =
	| "acp_auth_required"
	| "acp_model_unavailable"
	| "acp_thinking_unavailable"
	| "acp_transport_error";

/** How a post-settle window ran: how long it held the session, the updates it took, and why it closed. */
export interface AcpPostSettle {
	waitedMs: number;
	updates: number;
	ended: "idle" | "cap" | "aborted";
}

export interface AcpDelegationResult {
	messages: AgentMessage[];
	exitCode: number;
	stopReason: string;
	/** True when the turn request hit its configured timeout. */
	timedOut?: boolean;
	/** The peer needs its own sign-in before it opens a session; the operator runs `loginCommand` once. */
	authRequired?: { loginCommand: string };
	/** The peer's provider refused on quota; the run failed with `usageLimit.message`. */
	usageLimit?: AcpUsageLimit;
	failureMessage?: string;
	/** The typed cause of a failed delegation, when the adapter knows one; `failureMessage` says it in words. */
	failureCode?: AcpDelegationFailureCode;
	delegation: {
		acpSessionId: string | null;
		/** How the peer session opened: a new one, or an earlier one reopened by `session/resume` or `session/load`. */
		opened: "new" | "resume" | "load";
		/** History updates a `session/load` replayed before it answered, kept out of the run's events. */
		replayedUpdates?: number;
		/** The window the session stayed open after the prompt returned for the peer's background work. */
		postSettle?: AcpPostSettle;
		/** The peer session cannot take another turn; a later turn starts a fresh session. */
		nonResumable?: { reason: string };
		selectedModelId?: string;
		initialize: AcpInitializeResponse | null;
		toolCallsRequested: number;
		toolCallsApproved: number;
		toolCallsDenied: number;
	};
}

const jobIdentifier = Type.String({ maxLength: 128 });
const jobCount = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
const jobTime = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);
/**
 * One job as `_pancode/jobs/list` and `job.changed` carry it. Every figure is
 * the canonical record's own, bounded for the wire: counts, `nextDueAt` and
 * `deadlineAt` are never derived by a client, `costUsd` is null when the record
 * says pricing is unknown, and `last` is absent until a run settled. The exact
 * prompt and argv never cross; `taskPreview` is a bounded prefix. `revision` is
 * the record's own and rises with every committed change, so a client replaces a
 * job only by an equal or newer one. `turn` is true while a scheduled main turn
 * of this job streams `session/update` frames, which is the only bracket those
 * frames have because no `session/prompt` owns them.
 */
export const AcpJob = Type.Object(
	{
		jobId: jobIdentifier,
		revision: jobCount,
		state: Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("terminal")]),
		reason: Type.Union([
			Type.Literal("count"),
			Type.Literal("condition"),
			Type.Literal("stopped"),
			Type.Literal("canceled"),
			Type.Literal("deadline"),
			Type.Literal("failure"),
			Type.Null(),
		]),
		runner: Type.Union([Type.Literal("main"), Type.Literal("command"), Type.Literal("mcp_event")]),
		taskPreview: Type.String({ maxLength: 192 }),
		intervalMs: jobCount,
		count: jobCount,
		starts: jobCount,
		settled: jobCount,
		timeoutMs: jobCount,
		nextDueAt: jobTime,
		deadlineAt: jobTime,
		cancelRequested: Type.Boolean(),
		running: Type.Boolean(),
		turn: Type.Boolean(),
		pendingReason: Type.Union([Type.String({ maxLength: 320 }), Type.Null()]),
		consecutiveFailures: jobCount,
		last: Type.Union([
			Type.Object(
				{
					outcome: literalUnion(JOB_OUTCOMES),
					summary: Type.String({ maxLength: 320 }),
					truncated: Type.Boolean(),
				},
				closed,
			),
			Type.Null(),
		]),
		delivery: Type.Union([
			Type.Object(
				{
					kind: Type.Union([Type.Literal("notice"), Type.Literal("main_turn")]),
					state: literalUnion(JOB_DELIVERY_STATES),
				},
				closed,
			),
			Type.Null(),
		]),
		costUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
		costDisplay: Type.Optional(Type.String()),
		saved: Type.Boolean(),
		/** False while polling may have ended but an analysis delivery, cancel or cleanup is unresolved. */
		complete: Type.Boolean(),
	},
	closed,
);
export type AcpJob = Static<typeof AcpJob>;

export const AcpJobList = Type.Object({ jobs: Type.Array(AcpJob, { maxItems: ACP_MAX_JOBS }) }, closed);
export type AcpJobList = Static<typeof AcpJobList>;

export type AcpFleetStep = {
	stepId: string;
	kind: "agent" | "code";
	scope: "readonly" | "workspace" | "worktree";
	agentId?: string;
	commandId?: string;
	argv?: string[];
	/** Declared write boundary; null is no claim, an empty list is the claim "changes nothing". */
	writes: string[] | null;
	route?: { targetId: string; model: string; nodeId: string; endpoint?: { label: string; limit: number } };
	loop?: { loopId: string; role: "check" | "repair"; attempt: number };
	gate?: { path: string };
	target?: string;
	profile?: string;
	/** A resumed run replays this step's prior sealed result instead of dispatching it. */
	replayed?: true;
};

export type AcpFleetPreview =
	| {
			status: "ready";
			name: string;
			planHash: string;
			stepCount: number;
			/** Where the run writes: one task worktree cut from HEAD, or the operator's checkout. */
			isolation: "worktree" | "workspace";
			waves: Array<{ index: number; steps: AcpFleetStep[] }>;
			budget: {
				ceilingUsd: number;
				currentUsd: number;
				playbookUsd: number | null;
				ceilingDisplay?: string;
				currentDisplay?: string;
				playbookDisplay?: string;
			};
			/** True when steps, lists or displayed text were cut at the wire bounds. */
			truncated: boolean;
			/** Present when the run resumes a prior root: the steps it replays, in plan order. */
			resume?: { fromRunId: string; replayed: string[] };
	  }
	| { status: "refused"; name: string; diagnostics: string[] };

const wireFleetRunText = Type.String({ maxLength: 520 });

const wireFleetRunHash = Type.String({ pattern: "^[0-9a-f]{64}$" });

const wireFleetRunStep = Type.Object(
	{
		stepId: wireFleetRunText,
		kind: Type.Union([Type.Literal("agent"), Type.Literal("code")]),
		scope: Type.Union([Type.Literal("readonly"), Type.Literal("workspace"), Type.Literal("worktree")]),
		agentId: Type.Optional(wireFleetRunText),
		commandId: Type.Optional(wireFleetRunText),
		argv: Type.Optional(Type.Array(wireFleetRunText, { maxItems: 16 })),
		writes: Type.Union([Type.Array(wireFleetRunText, { maxItems: 16 }), Type.Null()]),
		route: Type.Optional(
			Type.Object(
				{
					targetId: wireFleetRunText,
					model: wireFleetRunText,
					nodeId: wireFleetRunText,
					endpoint: Type.Optional(Type.Object({ label: wireFleetRunText, limit: Type.Integer({ minimum: 0 }) }, closed)),
				},
				closed,
			),
		),
		loop: Type.Optional(
			Type.Object(
				{
					loopId: wireFleetRunText,
					role: Type.Union([Type.Literal("check"), Type.Literal("repair")]),
					attempt: Type.Integer({ minimum: 0 }),
				},
				closed,
			),
		),
		gate: Type.Optional(Type.Object({ path: wireFleetRunText }, closed)),
		target: Type.Optional(wireFleetRunText),
		profile: Type.Optional(wireFleetRunText),
		replayed: Type.Optional(Type.Literal(true)),
	},
	closed,
);

const wireFleetRunRefused = Type.Object(
	{
		status: Type.Literal("refused"),
		name: wireFleetRunText,
		diagnostics: Type.Array(Type.String({ maxLength: 1100 }), { maxItems: 32 }),
	},
	closed,
);

export const AcpFleetPreviewSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("ready"),
			name: wireFleetRunText,
			planHash: wireFleetRunHash,
			stepCount: Type.Integer({ minimum: 0 }),
			isolation: Type.Union([Type.Literal("worktree"), Type.Literal("workspace")]),
			waves: Type.Array(
				Type.Object({ index: Type.Integer({ minimum: 0 }), steps: Type.Array(wireFleetRunStep, { maxItems: 64 }) }, closed),
				{
					maxItems: 64,
				},
			),
			budget: Type.Object(
				{
					ceilingUsd: Type.Number({ minimum: 0 }),
					ceilingDisplay: Type.Optional(Type.String()),
					currentDisplay: Type.Optional(Type.String()),
					playbookDisplay: Type.Optional(Type.String()),
					currentUsd: Type.Number({ minimum: 0 }),
					playbookUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
				},
				closed,
			),
			truncated: Type.Boolean(),
			resume: Type.Optional(
				Type.Object(
					{
						fromRunId: wireFleetRunText,
						replayed: Type.Array(wireFleetRunText, { maxItems: 64 }),
					},
					closed,
				),
			),
		},
		closed,
	),
	wireFleetRunRefused,
]);

export const AcpFleetRunResultSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("started"),
			name: wireFleetRunText,
			planHash: wireFleetRunHash,
			fleetRootId: Type.String({ maxLength: 128 }),
			stepCount: Type.Integer({ minimum: 0 }),
		},
		closed,
	),
	Type.Object(
		{
			status: Type.Literal("changed"),
			name: wireFleetRunText,
			planHash: wireFleetRunHash,
			reason: Type.String({ maxLength: 512 }),
		},
		closed,
	),
	/** The run ended before its first step: dispatch admission refused what the compiler accepted. */
	Type.Object(
		{
			status: Type.Literal("failed"),
			name: wireFleetRunText,
			planHash: wireFleetRunHash,
			fleetRootId: Type.String({ maxLength: 128 }),
			reason: Type.String({ maxLength: 1100 }),
		},
		closed,
	),
	wireFleetRunRefused,
]);
