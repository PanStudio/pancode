// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Middleware firing and side surface records: effects, settlements and System One decisions (#434). */

import type { Static } from "typebox";
import { Type } from "typebox";
import { vocabulary } from "./enums.js";
import { CallIdSchema, ExistingId } from "./id-schemas.js";
import { closed, count, duration } from "./schemas.js";

export const MIDDLEWARE_EFFECTS = vocabulary([
	"inject_reminder",
	"annotate_tool_result",
	"block_tool",
	"protect_path",
	"request_continuation",
	"require_tool",
	"lock_tools",
	"notify_operator",
	"rewrite_tool_input",
	"request_approval",
]);
export const SYSTEM_ONE_OUTCOME = vocabulary([
	"answered",
	"failed",
	"timeout",
	"canceled",
	"overflow",
	"breaker-open",
	"unsupported",
	"flow-denied",
	"busy",
]);

/** A middleware hook that threw, overran its budget, or lost its id to another registration (#434). */
export const MiddlewareHookFailedSchema = Type.Object(
	{
		kind: vocabulary(["hook_failed", "budget_exceeded", "registration_conflict"]),
		registrationId: ExistingId,
		hook: vocabulary(["before_tool", "after_tool", "turn_start", "turn_end", "on_compaction"]),
		elapsedMs: Type.Optional(duration),
		budgetMs: Type.Optional(duration),
		steadyStateWarn: Type.Optional(Type.Boolean()),
		p50Ms: Type.Optional(duration),
		p95Ms: Type.Optional(duration),
		overCount: Type.Optional(count),
		windowSamples: Type.Optional(count),
	},
	closed,
);

/**
 * A firing's id: `fir_`, the drawing process's token and its sequence number, monotonic per session (or per run in a
 * worker) within a process and unique across the processes a resumed session spans (memory design 4.1).
 */
const FiringIdSchema = Type.String({ pattern: "^fir_[0-9a-f]{8}_[1-9][0-9]{0,15}$" });
/** One middleware rule that emitted effects at a hook; ctx names the session or run, turn and tool call (#431). */
export const MiddlewareFiredSchema = Type.Object(
	{
		/**
		 * Present when an effect is one that settles (`request_continuation`, `block_tool`, `lock_tools`) or the rule
		 * settles every firing (`nudge.read-streak`, `nudge.scout-survey`, `worker.thrash`; exploration design 3.4).
		 */
		firingId: Type.Optional(FiringIdSchema),
		hook: vocabulary(["before_tool", "after_tool", "turn_start", "turn_end", "on_compaction"]),
		phase: vocabulary(["sync", "async", "awaited"]),
		ruleId: ExistingId,
		effects: Type.Array(MIDDLEWARE_EFFECTS, { minItems: 1, maxItems: 32 }),
		/** The strongest severity among its reminders. */
		severity: Type.Optional(vocabulary(["info", "advisory", "warn", "hard-block"])),
		/** What the rule matched, as `matcher:subject@scope`, for example `regex:PLAN_REQUEST@operator-request`. */
		evidence: Type.Optional(
			Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_.-]{1,64}(?:@[a-z][a-z0-9-]{0,31})?$" }),
		),
		tool: Type.Optional(ExistingId),
	},
	closed,
);
/** The closed vocabulary a firing settles with (memory design 4.1). */
const SURFACE_OUTCOMES = [
	"used",
	"acted",
	"recovered",
	"held",
	"contradicted",
	"declined",
	"ignored",
	"moot",
	"expired",
	"exhausted",
	"suppressed",
] as const;
export type SurfaceOutcome = (typeof SURFACE_OUTCOMES)[number];
/** The typed fact a settlement rests on; `none` when nothing followed. */
const SETTLEMENT_FACT_KINDS = ["receipt", "declaration", "fold", "retry", "scope-end", "none"] as const;
/**
 * A firing's one settlement: the request that carried its text or effect (null when none did), its outcome, and the
 * terminal fact it rests on, `ref` naming that fact's tool call, check or event. `surface` is a `SIDE_SURFACES` id or
 * a middleware rule's registration id (memory design 4.1, 4.6).
 */
export const SurfaceSettledSchema = Type.Object(
	{
		firingId: FiringIdSchema,
		surface: ExistingId,
		admittedIn: Type.Union([CallIdSchema, Type.Null()]),
		outcome: vocabulary(SURFACE_OUTCOMES),
		fact: Type.Object({ kind: vocabulary(SETTLEMENT_FACT_KINDS), ref: Type.Optional(ExistingId) }, closed),
	},
	closed,
);
export type SurfaceSettled = Static<typeof SurfaceSettledSchema>;

/** One System One decision: what each engine answered, against which deadline, and its breaker (#429). */
export const SystemOneDecidedSchema = Type.Object(
	{
		/** The decision point and its question-set version, which is what a later outcome groups by. */
		point: ExistingId,
		set: ExistingId,
		/** Join key for a later outcome, such as a tool call id. */
		ref: Type.Optional(ExistingId),
		askId: ExistingId,
		outcome: SYSTEM_ONE_OUTCOME,
		engineKind: Type.Optional(ExistingId),
		profile: Type.Optional(ExistingId),
		build: Type.Optional(ExistingId),
		readout: Type.Optional(ExistingId),
		latencyMs: duration,
		deadlineMs: duration,
		tokens: Type.Optional(Type.Object({ input: count, output: count }, closed)),
		asked: count,
		abstained: count,
		routes: Type.Array(
			Type.Object(
				{
					engine: ExistingId,
					kind: ExistingId,
					profile: ExistingId,
					outcome: SYSTEM_ONE_OUTCOME,
					roundTripMs: Type.Optional(duration),
					/** opened: this timeout opened the cooldown. probe: the half-open probe went out. closed: an answer reset a counting breaker. */
					breaker: Type.Optional(vocabulary(["opened", "probe", "closed"])),
				},
				closed,
			),
			{ minItems: 1, maxItems: 16 },
		),
		/** The journal calls the decision's model requests opened. */
		callIds: Type.Array(CallIdSchema, { uniqueItems: true }),
	},
	closed,
);
