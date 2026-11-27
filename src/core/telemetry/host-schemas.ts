// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Host process records: boot, health, prewarm, sealing, sharing, config, extensions, auth and shutdown (#434). */

import type { Static } from "typebox";
import { Type } from "typebox";
import { ConfigChangeScope, ConfigChangeSource, vocabulary } from "./enums.js";
import { ExistingId } from "./id-schemas.js";
import { closed, count, duration, ObjectRefSchema, sha256Hex, text, UtcSchema as utc } from "./schemas.js";

/**
 * The settings digest worker specs and route decisions carry, declared as R7 asks and as the receipt hash set declares
 * it. A commitment: it confirms the settings document a config record's object reference stores, but resolves through
 * no store of its own, because that copy is canonicalized without the domain prefix this digest covers (#434).
 */
const SettingsFingerprintSchema = Type.Object(
	{
		label: Type.Literal("commitment"),
		function: Type.Literal("sha256"),
		/** `pancode.settings:` followed by the sorted-key JSON of the effective settings (settings-fingerprint.ts). */
		canonicalization: Type.Literal("json-sorted-prefixed-v1"),
		subject: Type.Literal("settings"),
		hash: sha256Hex,
	},
	closed,
);
type SettingsFingerprint = Static<typeof SettingsFingerprintSchema>;

export function settingsFingerprintCommitment(hash: string): SettingsFingerprint {
	return {
		label: "commitment",
		function: "sha256",
		canonicalization: "json-sorted-prefixed-v1",
		subject: "settings",
		hash,
	};
}

const lagPercentiles = Type.Array(Type.Object({ p: Type.Number({ minimum: 0, maximum: 100 }), ms: duration }, closed), {
	maxItems: 64,
});

export const DomainLoadedSchema = Type.Object({ name: ExistingId }, closed);
/** One user or extension hook execution, under the session, run and turn it ran for (#434). */
export const HookRanSchema = Type.Object(
	{
		hookId: ExistingId,
		origin: vocabulary(["extension", "user", "project", "project.local"]),
		sourceId: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
		hash: ExistingId,
		hook: vocabulary(["before_tool", "after_tool", "turn_start", "turn_end", "on_compaction", "prompt_submit"]),
		kind: vocabulary(["command", "prompt", "effect", "runtime"]),
		outcome: vocabulary([
			"emitted",
			"command-ok",
			"command-failed",
			"command-timeout",
			"skipped",
			"failed",
			"runtime-ok",
			"runtime-failed",
			"runtime-timeout",
		]),
		effectKinds: Type.Optional(Type.Array(ExistingId, { maxItems: 32 })),
		durationMs: Type.Optional(duration),
		/** One record for this many effect-free runs in a turn; `durationMs` is their total. */
		runs: Type.Optional(count),
		maxDurationMs: Type.Optional(duration),
		timeoutMs: Type.Optional(duration),
		exitCode: Type.Optional(Type.Integer()),
		outputChars: Type.Optional(count),
		tool: Type.Optional(ExistingId),
		extension: Type.Optional(
			Type.Object(
				{
					id: ExistingId,
					version: Type.Optional(ExistingId),
					scope: ExistingId,
					contentDigest: ExistingId,
					generation: count,
				},
				closed,
			),
		),
	},
	closed,
);
/**
 * One run of an extension's pinned program outside the sandbox, or its refusal: which pin ran, for which kind of
 * request, and how it ended. Arguments stay in the session's activity ledger, clipped and redacted (#434).
 */
export const ExtensionBinaryRanSchema = Type.Object(
	{
		extension: Type.Object(
			{
				id: ExistingId,
				version: ExistingId,
				scope: ExistingId,
				contentDigest: Type.Optional(ExistingId),
			},
			closed,
		),
		binary: ExistingId,
		version: ExistingId,
		/** The pinned download for this platform; absent when the declaration pins none here. */
		sha256: Type.Optional(sha256Hex),
		via: vocabulary(["run", "pane"]),
		parent: vocabulary(["command", "action", "tool", "observe", "hook", "interview"]),
		outcome: vocabulary(["ok", "failed", "timeout", "refused"]),
		reasonCode: Type.Optional(vocabulary(["background-request", "read-only", "not-installed"])),
		exitCode: Type.Optional(Type.Integer()),
		argCount: count,
		durationMs: Type.Optional(duration),
	},
	closed,
);
/** One PanHub lifecycle operation on a pack: what changed, at which digests, and who confirmed it (#434). */
export const HubLifecycleSchema = Type.Object(
	{
		operationId: ExistingId,
		kind: ExistingId,
		id: ExistingId,
		version: Type.Union([ExistingId, Type.Null()]),
		contentDigest: Type.Union([ExistingId, Type.Null()]),
		envelopeDigest: Type.Union([ExistingId, Type.Null()]),
		scope: ExistingId,
		sourceId: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
		actor: vocabulary(["operator", "model-confirmed", "upgrade"]),
	},
	closed,
);
export const DomainFailedSchema = Type.Object({ name: ExistingId }, closed);
/**
 * One marketplace skill offer and each outcome it reached (FX-28): `offered` when it reached the model as an ask
 * (`ask`, bound by `offerId`) or a plain mention with no ask (`mention`); `ignored` when the offer's turn ended with no
 * bound answer; `accepted` or `declined` when the operator's tagged answer arrived. A deferred answer can follow an
 * `ignored` record, so the last record for an `offerId` is its outcome.
 */
export const SkillOfferSchema = Type.Object(
	{
		offerId: ExistingId,
		skill: ExistingId,
		version: Type.Union([ExistingId, Type.Null()]),
		outcome: vocabulary(["offered", "accepted", "declined", "ignored"]),
		mode: vocabulary(["ask", "mention"]),
		/** How the request named the skill's domain: an authored trigger phrase or the skill's own name. */
		basis: vocabulary(["trigger", "name"]),
		score: count,
		scope: Type.Optional(vocabulary(["user", "project"])),
		choice: Type.Optional(vocabulary(["not_now", "never", "other"])),
		/** On `accepted`: whether the install succeeded. */
		installed: Type.Optional(Type.Boolean()),
	},
	closed,
);
/** A settings reload the watcher rejected, keeping the last good settings, or the reload that ended the rejection. */
export const ConfigReloadFailedSchema = Type.Object({ state: vocabulary(["rejected", "recovered"]) }, closed);

/** A plugin resource reload: the generation it committed and the snapshot's content identity (#434). */
export const PluginReloadedSchema = Type.Object(
	{ generation: count, previousGeneration: count, changed: Type.Boolean(), digest: ExistingId },
	closed,
);
export const ShutdownRequestedSchema = Type.Object(
	{ phase: vocabulary(["idle", "draining", "terminating", "persisting", "exiting"]) },
	closed,
);

export const ProcessExitedSchema = Type.Object({ exitCode: Type.Integer() }, closed);
/**
 * One boot, once its surface answers: the boot timer's phases as offsets from the timer's start, and on the TUI how
 * long the Stage 0 shell could not answer input. The writer header already names the build (#434).
 */
export const ProcessBootedSchema = Type.Object(
	{
		surface: vocabulary(["tui", "run", "acp"]),
		node: Type.String({ minLength: 1, maxLength: 64 }),
		platform: Type.String({ minLength: 1, maxLength: 64 }),
		totalMs: duration,
		phases: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }), atMs: duration }, closed), {
			maxItems: 64,
		}),
		interactivity: Type.Optional(
			Type.Object({ stage0Ms: duration, hydratedMs: duration, inputBlockedMaxMs: duration }, closed),
		),
	},
	closed,
);
/** A live event the hub delivered, journaled only under research mode's bus-trace flag: its name, never its payload (#434). */
export const BusTracedSchema = Type.Object({ event: Type.String({ minLength: 1, maxLength: 128 }) }, closed);
const prewarmLabel = Type.String({ minLength: 1, maxLength: 128 });
/**
 * Whether a cache pre-warm was admitted: the chat route's prompt warm on a latency surface, or a startup worker warm
 * that its deployment refused. A run that went ahead settles as prewarm.settled (#434).
 */
export const PrewarmDecidedSchema = Type.Object(
	{
		round: vocabulary(["prompt", "worker"]),
		trigger: Type.Optional(prewarmLabel),
		targetId: Type.Optional(ExistingId),
		model: Type.Optional(ExistingId),
		ran: Type.Boolean(),
		reason: Type.Optional(prewarmLabel),
		detail: Type.Optional(prewarmLabel),
		durationMs: Type.Optional(duration),
	},
	closed,
);
/** One pre-warm round that reached its provider; its spend, when any, is the call it journaled (#434). */
export const PrewarmSettledSchema = Type.Object(
	{
		round: vocabulary(["prompt", "model-wake", "worker"]),
		targetId: ExistingId,
		model: ExistingId,
		trigger: Type.Optional(prewarmLabel),
		ttftMs: Type.Union([duration, Type.Null()]),
		apiMs: duration,
		promptTokens: Type.Optional(count),
		aborted: Type.Boolean(),
		detached: Type.Optional(Type.Boolean()),
		failed: Type.Boolean(),
	},
	closed,
);
/**
 * A scope's seal (#434): `head` is the journal's hash chain head before the seal line, `records` the number of chained
 * lines (segment headers included) that head covers, and the file lists name every journal segment and object of the
 * scope at that moment. The live segment's entry covers its bytes before the seal line.
 */
export const ScopeSealedSchema = Type.Object(
	{
		head: sha256Hex,
		records: count,
		segments: Type.Array(
			Type.Object(
				{ name: Type.String({ pattern: "^journal(\\.[0-9]{10})?\\.jsonl$" }), sha256: sha256Hex, bytes: count },
				closed,
			),
		),
		objects: Type.Array(
			Type.Object({ id: Type.String({ pattern: "^obj_[0-9a-f]{64}$" }), sha256: sha256Hex, bytes: count }, closed),
		),
	},
	closed,
);
export type ScopeSealed = Static<typeof ScopeSealedSchema>;
/** The share profiles an operator picks from; what each admits is declared in src/domains/telemetry/share.ts (#434). */
export const ShareProfileSchema = vocabulary(["content-free", "report", "structural", "research"]);
/**
 * The seal of a shared scope (#434): a scope's seal over the filtered journal a share archive carries, naming the
 * profile that filtered it. Its fields mean what a scope seal's do, over the shared bytes instead of the source's.
 */
export const ShareSealedSchema = Type.Object({ ...ScopeSealedSchema.properties, profile: ShareProfileSchema }, closed);

// The effective settings when a session's writer opens, so every later record reads against known settings (#434).
export const ConfigSnapshottedSchema = Type.Object(
	{ settings: ObjectRefSchema, settingsFingerprint: SettingsFingerprintSchema },
	closed,
);
// One settings change: the paths it touched by when they take effect, and both documents (#434).
export const ConfigChangedSchema = Type.Object(
	{
		source: ConfigChangeSource,
		/** The layer the change landed in; absent for a file reload, which cannot tell which file changed. */
		scope: Type.Optional(ConfigChangeScope),
		paths: Type.Object(
			{
				hotReload: Type.Array(text),
				nextTurn: Type.Array(text),
				restartRequired: Type.Array(text),
			},
			closed,
		),
		before: ObjectRefSchema,
		after: ObjectRefSchema,
		/** The digest a worker spec and route decision carry for the new settings, so they resolve here. */
		settingsFingerprint: SettingsFingerprintSchema,
	},
	closed,
);

// One window of this process's health, written to each open session writer, so the loop-lag budget is measured
// in the field and not only in tests (#428, #434).
export const HealthSampledSchema = Type.Object(
	{
		/** The span the lag samples cover; the first window after the sampler starts is shorter. */
		windowMs: duration,
		/** Event-loop delay past the sampler's resolution; absent when no sample landed in the window. */
		loopLag: Type.Optional(
			Type.Object({ samples: Type.Integer({ minimum: 1 }), p50Ms: duration, p99Ms: duration, maxMs: duration }, closed),
		),
		rssBytes: count,
		/** Every journal writer the process holds open: records queued now, and records they dropped since opening. */
		writer: Type.Object({ queueDepth: count, dropped: count }, closed),
	},
	closed,
);
/** The same window's full lag distribution and heap, which research mode keeps beside health.sampled (#428, #434). */
export const HealthSamplesCapturedSchema = Type.Object(
	{
		windowMs: duration,
		/** The lag sampler's percentile curve; empty when no sample landed in the window. */
		lagPercentiles,
		/** The share of the window the event loop spent running callbacks, 0 to 1. */
		eventLoopUtilization: Type.Number({ minimum: 0, maximum: 1 }),
		heapUsedBytes: count,
		externalBytes: count,
	},
	closed,
);

/** One OAuth credential refresh under the storage lock; no token material is ever recorded (#427). */
export const AuthRefreshedSchema = Type.Object(
	{
		provider: ExistingId,
		/** expiry: the stored token was inside the skew margin. rejected: the provider refused the key in use. */
		trigger: vocabulary(["expiry", "rejected"]),
		/** Whether this process called the provider's refresh endpoint. */
		attempted: Type.Boolean(),
		/**
		 * refreshed: this process minted the new credential. adopted: another writer had already replaced it under
		 * the lock. failed: no usable credential came back. cancelled: the request ended first.
		 */
		outcome: vocabulary(["refreshed", "adopted", "failed", "cancelled"]),
		/** The process that wrote the credential now in use; null when another process wrote it. */
		writerPid: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
		/** The stored credential's updatedAt when this process read it, and after the refresh. */
		updatedAtBefore: Type.Optional(utc),
		updatedAtAfter: Type.Optional(utc),
		durationMs: duration,
	},
	closed,
);
/**
 * A main session's prompt cache lane came from this process's own lanes because the cross-process lane store could
 * not take the claim (M-11), so a concurrent PanCode process may route to the same id.
 */
export const CacheLaneFellBackSchema = Type.Object(
	{
		/** lock-timeout: another holder kept the admission lock past the claim's bound. store-failed: any other error. */
		reason: vocabulary(["lock-timeout", "store-failed"]),
		/** The lock budget that ran out; null for a store failure. */
		timeoutMs: Type.Union([count, Type.Null()]),
		/** The in-process lane the conversation took instead. */
		lane: count,
	},
	closed,
);
