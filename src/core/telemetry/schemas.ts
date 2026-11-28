// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Telemetry record schemas for provider calls and their economics: usage, pricing, quota windows, call records and
 * captures, and the primitives every record family shares (#434).
 */

import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { SURFACE_IDS } from "../side-surfaces.js";
import { THINKING_LEVELS } from "../views/thinking-levels.js";
import { CACHE_VERDICTS } from "../views/usage-words.js";
import { WIRE_EFFORT_PATTERN } from "./call-effort.js";
import {
	CallEconomicsSchema,
	ChargeDiscrepancySchema,
	EconomyUnitSchema,
	OpaqueIdSchema,
	SafeCountSchema,
} from "./economy.js";
import {
	ConfigChangeSource,
	Disposition,
	FailureCause,
	RoundKind,
	StopReason,
	TransportKind,
	vocabulary,
} from "./enums.js";
import { EstimateMethod, FactSumSchema, factSchema } from "./fact.js";
import { AttemptIdSchema, CallIdSchema, ExistingId } from "./id-schemas.js";
import { CACHE_RECOVERY_OUTCOMES, COPILOT_SESSION_ORIGINS, QUOTA_STATUSES } from "./session-vocabulary.js";

export const closed = { additionalProperties: false };
/** Who bills a seat-billed call; a harness word, which a report bundle carries verbatim. */
export const BILLING_PROVIDERS = ["github-copilot"] as const;
export const count = SafeCountSchema;
const estimatedCount = Type.Object({ kind: Type.Literal("estimated"), value: count, method: EstimateMethod }, closed);
export const duration = Type.Number({ minimum: 0 });
export const text = Type.String({ maxLength: 4096 });
const utc = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
export const ObjectRefSchema = Type.Object(
	{
		label: vocabulary(["resolvable", "commitment"]),
		function: Type.Literal("sha256"),
		canonicalization: Type.Literal("json-sorted-v1"),
		subject: vocabulary([
			"prompt-structure",
			"tool-schemas",
			"config",
			"briefing",
			"steering",
			"request",
			"prompt-text",
			"memory-trace",
			"observation-trace",
			// The prompt cache key a request was sent under, as a commitment that never stores the key (#434).
			"prompt-cache-key",
			"run-result",
			"evidence-findings",
		]),
		id: Type.String({ pattern: "^obj_[0-9a-f]{64}$" }),
	},
	closed,
);
export type ObjectRef = Static<typeof ObjectRefSchema>;

export const UsageSchema = Type.Object(
	{
		input: factSchema(count),
		cacheRead: factSchema(count),
		cacheWrite: factSchema(count),
		cacheWrite1h: factSchema(count),
		output: factSchema(count),
		reasoning: factSchema(count),
		/** The provider's total, kept when it exceeds the breakdown it reported or a part of that breakdown is unknown (#434). */
		total: Type.Optional(factSchema(count)),
	},
	closed,
);
export type CallUsage = Static<typeof UsageSchema>;
/**
 * Which rule made a call free: the target declared `pricing: free`, the target's declared rates are all zero, or the
 * runtime is local by kind. Optional beside `pricedBy: free`: a sum whose free parts state different rules names none.
 */
export const FreeRuleSchema = vocabulary(["declared", "zero-rates", "local-native"]);
export type FreeRule = Static<typeof FreeRuleSchema>;
export const PricingSchema = Type.Object(
	{
		usd: factSchema(duration),
		pricedBy: vocabulary(["provider", "target-rates", "catalog", "free", "none"]),
		freeRule: Type.Optional(FreeRuleSchema),
		rateRef: Type.Optional(ObjectRefSchema),
	},
	closed,
);
/** One priced amount: the USD fact and who priced it. Every cost PanCode carries has this shape (#434). */
export type Pricing = Static<typeof PricingSchema>;
export type PricedBy = Pricing["pricedBy"];
/**
 * A run's spend as one fact per quantity: what run.settled states and what the run ledger, live run events and
 * surfaces carry while the run is open (#434). The read model's fold over the run's calls keeps the per-call coverage.
 */
export const RunUsageFactsSchema = Type.Object(
	{ usage: UsageSchema, totalTokens: factSchema(count), apiCalls: factSchema(count), pricing: PricingSchema },
	closed,
);
export type RunUsageFacts = Static<typeof RunUsageFactsSchema>;
/**
 * A run's spend as sums over its calls, what a total across runs adds: a run with one unpriced call keeps the priced
 * subtotal of the others, which its one fact per quantity cannot state (#434).
 */
export const RunSpendSumsSchema = Type.Object(
	{
		usage: Type.Object(
			{
				input: FactSumSchema,
				cacheRead: FactSumSchema,
				cacheWrite: FactSumSchema,
				cacheWrite1h: FactSumSchema,
				output: FactSumSchema,
				reasoning: FactSumSchema,
			},
			closed,
		),
		totalTokens: FactSumSchema,
		apiCalls: FactSumSchema,
		usd: FactSumSchema,
	},
	closed,
);
export type RunSpendSums = Static<typeof RunSpendSumsSchema>;
export const target = Type.Object(
	{
		targetId: ExistingId,
		runtimeId: ExistingId,
		api: ExistingId,
		requestedModel: ExistingId,
		reportedModel: factSchema(text),
	},
	closed,
);
const call = {
	// The compiled prompt and attached tool surface; wire transformations are separate facts (#434).
	objects: Type.Optional(
		Type.Object(
			{
				promptStructure: Type.Optional(ObjectRefSchema),
				toolSchemas: Type.Optional(ObjectRefSchema),
			},
			closed,
		),
	),
	callId: CallIdSchema,
	attemptId: AttemptIdSchema,
	attempt: count,
	target,
	roundKind: RoundKind,
	/** The side surface that made the call (`SIDE_SURFACES`); absent on a main, worker or coordinator call. */
	purpose: Type.Optional(vocabulary(SURFACE_IDS)),
	toolChoice: Type.Union([
		vocabulary(["auto", "none", "required", "unknown"]),
		Type.Object({ name: ExistingId }, closed),
	]),
	/** Present only when the request bound its reply to a JSON schema through `response_format`. */
	responseFormat: Type.Optional(vocabulary(["json-schema"])),
	/** The thinking level the call asked for, as PanCode names it; absent where the caller did not state one (FX-49). */
	thinkingLevel: Type.Optional(vocabulary(THINKING_LEVELS)),
};
const span = { start: duration, end: duration };
export const sha256Hex = Type.String({ pattern: "^[0-9a-f]{64}$" });

/**
 * A provider's deny status for a quota pool or window: `denied` only when the provider says the account cannot send
 * (a reached limit with no usable credits or overage), `allowed` when it says it can, `unknown` otherwise. A window
 * measured full is not a denial by itself.
 */
export const QUOTA_ACCESS = ["allowed", "denied", "unknown"] as const;
export type QuotaAccess = (typeof QUOTA_ACCESS)[number];
/** Whether the provider will bill past the included allowance (credits, overage), where it states so. */
export const QUOTA_OVERAGE = ["permitted", "refused", "unknown"] as const;
export type QuotaOverage = (typeof QUOTA_OVERAGE)[number];
/**
 * How far a window's quantities may be read: an `authoritative` budget supports a percentage, an `advisory` balance is
 * display-only, an `admission` verdict carries no post-charge balance, and `none` measures nothing.
 */
export const QUOTA_QUALIFICATION = ["authoritative", "advisory", "admission", "none"] as const;
export type QuotaQualification = (typeof QUOTA_QUALIFICATION)[number];
const QuotaWindowSchema = Type.Object(
	{
		key: ExistingId,
		label: Type.Optional(text),
		scope: Type.Optional(text),
		usedPct: factSchema(Type.Number({ minimum: 0, maximum: 100 })),
		resetsAt: Type.Optional(utc),
		/** The native unit the window's limit counts, as the provider reported it; absent when it named none. */
		unit: Type.Optional(EconomyUnitSchema),
		/** The window's length as the provider reported it, such as Codex `limit_window_seconds`; never inferred. */
		durationSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
		/** The provider's own allow or deny status for this window; absent when it states none for the window. */
		access: Type.Optional(vocabulary(QUOTA_ACCESS)),
		/** The provider reported no limit for this window: it keeps its unit and has no percentage. */
		unlimited: Type.Optional(Type.Literal(true)),
		/** How far the provider qualified the window's quantities; absent when it did not say. */
		qualification: Type.Optional(vocabulary(QUOTA_QUALIFICATION)),
	},
	closed,
);
const quotaSource = vocabulary(["response-headers", "stream-event", "poll"]);
const stop = Type.Object(
	{ reason: StopReason, failure: Type.Optional(FailureCause), detail: Type.Optional(text) },
	closed,
);
export const CallStartedSchema = Type.Object(call, closed);
export type CallStarted = Static<typeof CallStartedSchema>;
export const CallSettledSchema = Type.Object(
	{
		...call,
		/**
		 * The reasoning effort the request handed to the provider carried, in the provider's spelling, or `omitted`; absent
		 * when no request was seen (FX-49).
		 */
		wireEffort: Type.Optional(Type.String({ pattern: WIRE_EFFORT_PATTERN })),
		disposition: Disposition,
		stop,
		usage: Type.Union([UsageSchema, Type.Null()]),
		pricing: PricingSchema,
		/**
		 * The attempt's economics beside its route price: provider charge, marginal charge, seat credit estimate, energy,
		 * API equivalent and funding (`economy.ts`). Absent on an attempt never sent, which reads as not applicable, and on
		 * one whose economics failed their schema, which reads as not captured.
		 */
		economics: Type.Optional(CallEconomicsSchema),
		// Offsets from the attempt's start. TTFT is firstToken minus send.end; the session ledger's ttftMs counts from
		// send.start and so includes PanCode's request shaping (#434).
		stages: Type.Object(
			{
				admission: Type.Optional(
					Type.Object(
						{
							...span,
							waitedOn: Type.Optional(vocabulary(["budget", "capacity", "steering"])),
							/** The input count a main turn's window fit was decided on, and whether the route's provider-measured anchor priced it. */
							inputTokens: Type.Optional(count),
							anchored: Type.Optional(Type.Boolean()),
							/** The output reserve that fit was decided with, as resolved for that input on the route (CTX-2). */
							outputReserveTokens: Type.Optional(count),
						},
						closed,
					),
				),
				auth: Type.Optional(Type.Object({ ...span, refreshed: Type.Optional(Type.Boolean()) }, closed)),
				transform: Type.Optional(Type.Object(span, closed)),
				connect: Type.Optional(Type.Object({ ...span, reused: Type.Optional(Type.Boolean()) }, closed)),
				send: Type.Optional(Type.Object(span, closed)),
				firstByte: Type.Optional(duration),
				firstToken: Type.Optional(duration),
				settle: Type.Union([duration, Type.Null()]),
			},
			closed,
		),
		transport: Type.Object(
			{
				kind: TransportKind,
				continuation: factSchema(vocabulary(["delta", "full"])),
				requestBytes: factSchema(count),
				sessionPinnedToSse: factSchema(Type.Boolean()),
				/** Present only when the call's own connection counters were attributable to it (#434). */
				connectionReused: Type.Optional(factSchema(Type.Boolean())),
				/** The Copilot session a copilot-sdk call went to, from PanCode's own session pool (PV-2). */
				session: Type.Optional(factSchema(vocabulary(COPILOT_SESSION_ORIGINS))),
				/** WebSocket failures and SSE fallbacks inside this call, from the same attributable counters (#423). */
				websocketFailures: Type.Optional(factSchema(count)),
				sseFallbacks: Type.Optional(factSchema(count)),
				/** Why the session is pinned to SSE after this call, when it is (#423, #427). */
				pinReason: Type.Optional(vocabulary(["auth_rejection", "transport_failure", "post_stream_or_unknown_failure"])),
				recovery: Type.Optional(
					Type.Object(
						{
							action: vocabulary(["cooldown_reset", "auth_reset"]),
							outcome: vocabulary(CACHE_RECOVERY_OUTCOMES),
						},
						closed,
					),
				),
				promptCacheKey: Type.Optional(ObjectRefSchema),
			},
			closed,
		),
		cache: Type.Object(
			{
				/**
				 * Where this request first departs from the previous one on its cache key: a compiled prompt section id,
				 * "system-prompt" when no section can be named, "tools" or "messages". Null when it only extends it (#434).
				 */
				firstDivergentSection: factSchema(Type.Union([text, Type.Null()])),
				expectedColdReasons: Type.Array(
					vocabulary([
						"working_set_evict",
						"compaction",
						"dispatch",
						"residency",
						"thinking_change",
						"tool_surface_change",
						"prompt_recompiled",
						"system_prompt_changed",
						"background_memory",
						"model_changed",
						"transport_reset",
						"input_changed",
						"tool_choice_change",
						"observation_aging",
						"step_checkpoint",
					]),
				),
				/**
				 * An upper bound on the previous request's prompt this one prefilled again: the lesser of this request's
				 * uncached input plus cache writes and the previous prompt less this cache read. Both terms also count tokens
				 * this request added, so the true re-prefill is at most this figure, never more.
				 */
				rePrefilledTokens: factSchema(count),
				uncachedPrefillTokens: factSchema(count),
				/** rePrefilledTokens priced at the input rate less the cache-read rate, fixed at settle, so also an upper bound (#434). */
				bill: Type.Optional(PricingSchema),
				verdict: vocabulary(CACHE_VERDICTS),
				/**
				 * The request's structure as short digests, so a later process can name where a resumed request departs
				 * from the last one journaled on its route. `entries` are `role:digest` past the first `base` entries of
				 * this process's previous request on the route; with no `base`, the process had none and lists them all.
				 */
				structure: Type.Optional(
					Type.Object(
						{
							system: Type.String({ pattern: "^[0-9a-f]{16}$" }),
							tools: Type.String({ pattern: "^[0-9a-f]{16}$" }),
							base: Type.Optional(count),
							/** The attempt whose structure the first `base` entries are, so a reader can chain them (F14). */
							baseAttempt: Type.Optional(AttemptIdSchema),
							entries: Type.Array(Type.String({ pattern: "^[A-Za-z]{1,32}:[0-9a-f]{16}$" }), { maxItems: 65536 }),
						},
						closed,
					),
				),
				/**
				 * Cold attribution: the first rendered history element this request changed against the previous one on
				 * its cache key, by position and role. Absent when it only extends that request. Kept apart from
				 * rePrefilledTokens, which is the provider's shortfall, and named by `expectedColdReasons` (F14).
				 */
				firstChangedElement: Type.Optional(
					Type.Object({ index: count, role: vocabulary(["user", "assistant", "toolResult", "entry"]) }, closed),
				),
				/**
				 * What a main attempt sent, taken at send, so `context working-set --verify` can render the session at its
				 * cursor and owner and compare (ContextFold CF-9, F14). Its element digests are `structure`'s, chained
				 * through `structure.baseAttempt`. Opaque provider bytes stay out.
				 */
				receipt: Type.Optional(
					Type.Object(
						{
							cursor: Type.Object(
								{ hwm: Type.Union([ExistingId, Type.Null()]), leaf: Type.Union([ExistingId, Type.Null()]) },
								closed,
							),
							owner: Type.Optional(
								Type.Object(
									{
										sessionId: ExistingId,
										fork: Type.Optional(Type.Object({ parentSessionId: ExistingId, parentTurnId: ExistingId }, closed)),
									},
									closed,
								),
							),
							route: Type.Object(
								{
									modelTier: Type.Optional(vocabulary(["small", "standard", "frontier"])),
									promptCaching: Type.Optional(Type.Boolean()),
									images: Type.Boolean(),
									midConversation: Type.Boolean(),
								},
								closed,
							),
							/** The tool choice the attempt sent, as the cache fingerprint serializes it. */
							toolChoice: text,
							tail: vocabulary(["none", "synthesis_directive"]),
							/** The adapter's reason for replaying a native checkpoint portably. */
							fallback: Type.Optional(text),
							codex: Type.Optional(
								Type.Object(
									{
										initialEffort: ExistingId,
										updates: Type.Array(Type.Object({ position: ExistingId, effort: ExistingId }, closed), {
											maxItems: 65536,
										}),
									},
									closed,
								),
							),
							/** The clock the sent history's continuity was rendered at; the verifier renders at it, not at its own. */
							continuityAtMs: Type.Optional(count),
							/** The fold records (evictions, recalls, checkpoints) on the path the cursor renders. */
							records: Type.Array(ExistingId, { maxItems: 65536 }),
							/** Native checkpoint identities the request carried, as short digests. */
							checkpoints: Type.Array(Type.String({ pattern: "^[0-9a-f]{16}$" }), { maxItems: 256 }),
						},
						closed,
					),
				),
			},
			closed,
		),
		quota: Type.Optional(
			Type.Object({ provider: ExistingId, windows: Type.Array(QuotaWindowSchema), source: quotaSource }, closed),
		),
		responseId: Type.Optional(text),
		/**
		 * What a seat-billed call cost in the seat's own units, as its runtime reported them: GitHub Copilot premium
		 * requests (the model multiplier for a user-initiated step, zero for an agent continuation) and AI credits
		 * in nano-AIU. Kept apart from `pricing`, which stays in dollars and unknown for a seat.
		 */
		billing: Type.Optional(
			Type.Object(
				{
					provider: vocabulary(BILLING_PROVIDERS),
					premiumRequests: factSchema(Type.Number({ minimum: 0 })),
					nanoAiu: factSchema(Type.Number({ minimum: 0 })),
					modelCalls: factSchema(count),
					/** The seat reported a debit for a call on a route declared free (R1). */
					discrepancy: Type.Optional(ChargeDiscrepancySchema),
				},
				closed,
			),
		),
		/**
		 * What an interrupted call the provider never reported on is estimated to have spent: the prompt side from the
		 * turn's context accounting and the output from the text that arrived. A transcript shows it; no fold sums it,
		 * so the usage above stays the measured lower bound (#423, #430, #434).
		 */
		interruptedEstimate: Type.Optional(Type.Object({ input: estimatedCount, output: estimatedCount }, closed)),
	},
	closed,
);
export type CallSettled = Static<typeof CallSettledSchema>;

/** Upper bounds of the inter-delta gap histogram; one more bucket counts the gaps past the last (#434). */
export const DELTA_GAP_BOUNDS_MS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192] as const;
/**
 * The response headers research capture may keep: rate-limit and quota windows, request ids and server timing.
 * Anything else, cookies and auth echoes included, never reaches the journal (#434, §12.5).
 */
export const PROVIDER_HEADER_PATTERN =
	"^(?:x-codex-(?:primary|secondary|credits)-[a-z0-9-]{1,48}|x-ratelimit-[a-z0-9-]{1,48}|anthropic-ratelimit-[a-z0-9-]{1,48}|retry-after|retry-after-ms|openai-processing-ms|openai-version|x-request-id|request-id|cf-ray)$";

export const CallLinkedSchema = Type.Object({ runId: ExistingId, callId: CallIdSchema }, closed);
export const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

// One provider's quota windows, journaled at a turn's first reading and whenever they change (#434).
export const QuotaReadSchema = Type.Object(
	{
		provider: ExistingId,
		targetId: ExistingId,
		source: quotaSource,
		/** When the provider took the reading, which can precede the record by a stream's length. */
		observedAt: utc,
		windows: Type.Array(QuotaWindowSchema),
		displayName: text,
		status: vocabulary(QUOTA_STATUSES),
		plan: Type.Optional(text),
		credits: Type.Optional(
			Type.Object(
				{
					display: text,
					usedPct: factSchema(Type.Number({ minimum: 0, maximum: 100 })),
					/** The native unit of the balance `display` states; absent when the provider named none. */
					unit: Type.Optional(EconomyUnitSchema),
				},
				closed,
			),
		),
		message: Type.Optional(text),
		retryAfterSeconds: Type.Optional(duration),
		stale: Type.Optional(Type.Boolean()),
		/** The provider reported that this account cannot send now. */
		limitReached: Type.Optional(Type.Boolean()),
		/** Opaque digest of the provider account a call's reading came from; never the account id itself. */
		account: Type.Optional(Type.String({ pattern: "^[0-9a-f]{16}$" })),
		/**
		 * The local pseudonym of the provider's stable billing identity that keys a funding pool: a keyed hash under a
		 * per-install key, never a raw account or selection id nor a rotating credential digest. Opaque here; who
		 * derives it and how is the quota domain's. `account` above separates logins within one process journal.
		 */
		accountPseudonym: Type.Optional(OpaqueIdSchema),
		/**
		 * The reading carries only the provider's allow or deny status (`limitReached`) and no window, so it is kept
		 * rather than dropped for having no percentage. Absent on readings with windows.
		 */
		limitOnly: Type.Optional(Type.Literal(true)),
		/**
		 * The provider's deny status for the whole pool, with any usable credits or overage taken into account. A denial
		 * stands on its own even when no window says which limit binds; `unknown` when the provider stated none.
		 */
		access: vocabulary(QUOTA_ACCESS),
		/** Whether the provider will bill past the included allowance, as it stated; `unknown` when it stated none. */
		overage: vocabulary(QUOTA_OVERAGE),
		/** The pool-wide reset the provider reported, apart from any window's own reset. */
		resetsAt: Type.Optional(utc),
		/** Until when the reading counts as fresh: its acquisition time plus the freshness window that read it. */
		validUntil: Type.Optional(utc),
	},
	closed,
);
// Admission found the session's priced spend at or over a ceiling, once per ceiling; ctx names the call it held (#424).
export const BudgetCrossedSchema = Type.Object(
	{
		level: vocabulary(["at", "over"]),
		/** Spend so far; the cost admission counted ahead of its settlement is `projectedUsd` (#434). */
		spendUsd: duration,
		projectedUsd: Type.Optional(duration),
		ceilingUsd: duration,
		/** Estimated input tokens of the held request, which is what each further call re-sends (#423). */
		contextTokens: Type.Optional(count),
	},
	closed,
);
// One paid request held at the ceiling, recorded when the hold ends; ctx names the held call (#424).
export const BudgetHeldSchema = Type.Object(
	{
		level: vocabulary(["at", "over"]),
		spendUsd: duration,
		projectedUsd: Type.Optional(duration),
		ceilingUsd: duration,
		contextTokens: Type.Optional(count),
		/**
		 * raised: a higher ceiling released it. removed: the ceiling was cleared to none. cleared: spend fell under
		 * the ceiling it held at. refused: the caller could not wait. aborted: the request was cancelled first.
		 */
		outcome: vocabulary(["raised", "removed", "cleared", "refused", "aborted"]),
		waitedMs: duration,
		raisedToUsd: Type.Optional(duration),
		/** Who changed the ceiling, when a settings change during the wait set the one that released it. */
		raisedBy: Type.Optional(ConfigChangeSource),
	},
	closed,
);
/** One call's inter-delta gaps as a histogram, never a row per delta; ctx names the call (#428, #434). */
export const CallTimingCapturedSchema = Type.Object(
	{
		deltas: Type.Integer({ minimum: 1 }),
		/** Counts per DELTA_GAP_BOUNDS_MS bucket, then the gaps past the last bound. */
		gapCounts: Type.Array(count, {
			minItems: DELTA_GAP_BOUNDS_MS.length + 1,
			maxItems: DELTA_GAP_BOUNDS_MS.length + 1,
		}),
		maxGapMs: duration,
		/** First delta to last, on the local monotonic clock. */
		spanMs: duration,
	},
	closed,
);
/** The redacted request body a call sent, stored as a `request` object under content capture (#434, P4). */
export const RequestCapturedSchema = Type.Object(
	{
		/** UTF-8 bytes of the serialized body before the cap. */
		bodyBytes: count,
		truncated: Type.Boolean(),
		content: ObjectRefSchema,
		bytes: count,
	},
	closed,
);
/** The allowlisted headers of the call's last 2xx response (#434, §12.5). */
export const ProviderHeadersCapturedSchema = Type.Object(
	{
		status: Type.Integer({ minimum: 200, maximum: 299 }),
		headers: Type.Record(Type.String({ pattern: PROVIDER_HEADER_PATTERN }), Type.String({ maxLength: 256 }), {
			additionalProperties: false,
		}),
	},
	closed,
);
export { utc as UtcSchema };
