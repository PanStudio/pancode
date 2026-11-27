// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Static, TSchema } from "typebox";
import type { JobChangedPayload } from "../job-types.js";
import type { CaptureFlag } from "./capture.js";
import {
	CompactionSettledSchema,
	ContextBriefingClippedSchema,
	ContextFoldSchema,
	ContextPrunedSchema,
	ContextRecalledSchema,
	ContextResumedSchema,
	ContextSnapshottedSchema,
	ContextWarningRaisedSchema,
	PromptCompiledSchema,
	PromptPrefixCapturedSchema,
	PromptTextCapturedSchema,
} from "./context-schemas.js";
import type { ContentClass, Tier } from "./enums.js";
import { type EvidenceAssessed, EvidenceAssessedSchema } from "./evidence-schemas.js";
import type { Fact } from "./fact.js";
import {
	AuthRefreshedSchema,
	BusTracedSchema,
	CacheLaneFellBackSchema,
	ConfigChangedSchema,
	ConfigReloadFailedSchema,
	ConfigSnapshottedSchema,
	DomainFailedSchema,
	DomainLoadedSchema,
	HealthSampledSchema,
	HealthSamplesCapturedSchema,
	HookRanSchema,
	HubLifecycleSchema,
	PluginReloadedSchema,
	PrewarmDecidedSchema,
	PrewarmSettledSchema,
	ProcessBootedSchema,
	ProcessExitedSchema,
	ScopeSealedSchema,
	ShareSealedSchema,
	ShutdownRequestedSchema,
	SkillOfferSchema,
} from "./host-schemas.js";
import type {
	AgentStatusChangedPayload,
	AutonomyOpenDecisionPayload,
	BudgetAlertPayload,
	CompactionPayload,
	ConfigChangePayload,
	ConfigReloadFailedPayload,
	ConfigSessionChangePayload,
	ContextActivityPayload,
	ContextSourcesChangedPayload,
	ContextWarningPayload,
	DeclaredRuntimeNotice,
	DispatchCompletedPayload,
	DispatchEnqueuedPayload,
	DispatchFailedPayload,
	DispatchProgressPayload,
	DispatchScopeNoticePayload,
	DispatchStartedPayload,
	DomainFailedPayload,
	EvidenceAssessedPayload,
	ExtensionsLoadIssuePayload,
	ForeignApprovalChangedPayload,
	ForeignRunObservedPayload,
	GitHooksChangedPayload,
	InternalGitDriftPayload,
	JobClockResumedPayload,
	LoopBlockedPayload,
	MemoryGuardianChangedPayload,
	MiddlewareHookFailedPayload,
	PermissionRequestedPayload,
	PermissionResolvedPayload,
	ProviderHealthPayload,
	ReloadAppliedPayload,
	ResidencyMutationPayload,
	RunAbortedPayload,
	SafetyBlockedPayload,
	SessionEndPayload,
	SessionOpenedPayload,
	SessionParkedPayload,
	SessionReloadedPayload,
	SessionResumedPayload,
	SessionResumingPayload,
	SessionStartPayload,
	SessionTurnSwitchedPayload,
	ToolBudgetExceededPayload,
	TurnAbortedPayload,
	TurnContinuedPayload,
} from "./live-events.js";
import {
	MemoryGuardianChangedSchema,
	type MemoryObservationRecorded,
	MemoryObservationRecordedSchema,
	MemoryObservedSchema,
	MemoryStepCompletedSchema,
	MemoryStepDecidedSchema,
	MemoryTracedSchema,
} from "./memory-schemas.js";
import { checkRecordSchema } from "./record-check.js";
import {
	CodeStepSettledSchema,
	GateDecidedSchema,
	RouteDecidedSchema,
	RunAbortedSchema,
	RunEnqueuedSchema,
	RunFeedAppendedSchema,
	RunLinkedSchema,
	RunSettledSchema,
	RunStartedSchema,
	RunUsageSchema,
	WorkerChannelFailedSchema,
} from "./run-schemas.js";
import type { CallSettled, ObjectRef } from "./schemas.js";
import {
	BudgetCrossedSchema,
	BudgetHeldSchema,
	CallLinkedSchema,
	CallSettledSchema,
	CallStartedSchema,
	CallTimingCapturedSchema,
	ProviderHeadersCapturedSchema,
	QuotaReadSchema,
	RequestCapturedSchema,
} from "./schemas.js";
import {
	AgentStatusChangedSchema,
	AutonomyCapReachedSchema,
	AutonomyEndedSchema,
	AutonomyEnteredSchema,
	AutonomyOpenDecisionSchema,
	AutonomyResumedSchema,
	EmptySchema,
	JobClockResumedSchema,
	JournalGapSchema,
	JournalSegmentClosedSchema,
	type MessageStepped,
	MessageSteppedSchema,
	SessionClosedSchema,
	SessionForkedSchema,
	SessionResumedSchema,
	StepPipelineSettledSchema,
	TurnAbortedSchema,
	TurnContinuedSchema,
	TurnSettledSchema,
} from "./session-schemas.js";
import {
	MiddlewareFiredSchema,
	MiddlewareHookFailedSchema,
	SurfaceSettledSchema,
	SystemOneDecidedSchema,
} from "./surface-schemas.js";
import {
	ApprovalRequestedSchema,
	ApprovalResolvedSchema,
	CompletionEvaluatedSchema,
	LoopBlockedSchema,
	SafetyJudgedSchema,
	ToolBudgetExceededSchema,
	ToolDecidedSchema,
	ToolSettledSchema,
} from "./tool-schemas.js";

/**
 * Every event the harness emits, declared once (#434). A `journal` event is written to the scope its telemetry
 * context names and delivered live; a `live` event reaches in-process subscribers only. The hub
 * (src/core/telemetry/hub.ts) is the one emit path for both.
 */
export interface JournalDefinition<S extends TSchema = TSchema> {
	readonly durability: "journal";
	readonly version: number;
	readonly schema: S;
	readonly tier: Tier;
	readonly cc: ContentClass;
	/** The research flag that admits a research-tier event; without one, research mode alone admits it (#434). */
	readonly capture?: CaptureFlag;
	/**
	 * The structural facts a journal keeps of a richer live payload. Live subscribers receive the payload as emitted;
	 * the producer applies this before enqueue, so card text and envelope ids never reach the journal (#434).
	 */
	readonly project?: (payload: never) => unknown;
	/**
	 * Where the record belongs regardless of how it was emitted. `process`: a fact about the process, always in the
	 * process journal. `session`: a fact about one session or run, which its seam names in the telemetry context; one
	 * emitted without a context is a gap, and one whose session writer closed idle reopens it (#434).
	 */
	readonly scope?: "process" | "session";
}

/** The payload exists only in the type system; live events carry no runtime schema. */
export interface LiveDefinition<P> {
	readonly durability: "live";
	readonly payload?: P;
}

function journal<
	S extends TSchema,
	const O extends {
		tier: Tier;
		cc: ContentClass;
		capture?: CaptureFlag;
		scope?: "process" | "session";
		// biome-ignore lint/suspicious/noExplicitAny: the projection's own annotation names the live payload type.
		project?: (payload: any) => Static<S>;
		/** The version a writer stamps; a reader skips any other version as unknown. */
		version?: number;
	},
>(schema: S, options: O): { durability: "journal"; version: number; schema: S } & O {
	return { durability: "journal", version: 1, schema, ...options };
}

/** Optional live fields arrive as `undefined`; a closed journal schema holds only the ones present. */
function definedFields(value: object): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

/** The defined fields of a live payload, so a projection never writes an explicit undefined (#434). */
function pick<T extends object, const K extends keyof T>(
	value: T,
	keys: readonly K[],
): { [P in K]: Exclude<T[P], undefined> } {
	const out: Partial<Record<K, unknown>> = {};
	for (const key of keys) if (value[key] !== undefined) out[key] = value[key];
	return out as { [P in K]: Exclude<T[P], undefined> };
}

const LIVE: LiveDefinition<never> = Object.freeze({ durability: "live" });
function live<P>(): LiveDefinition<P> {
	return LIVE as LiveDefinition<P>;
}

/** The journal keeps counts and identities from observation decisions, never envelopes or rendered copy (#434). */
function projectMemoryObservation(payload: {
	event: string;
	facts: Record<string, unknown>;
}): MemoryObservationRecorded {
	const input = payload.facts;
	const facts: Record<string, unknown> = {};
	for (const key of [
		"count",
		"bytes",
		"grounded",
		"ungrounded",
		"rejected",
		"offered",
		"offerable",
		"units",
		"incompleteUnits",
		"attempts",
		"timeoutMs",
		"operations",
		"dropped",
		"extracted",
		"candidates",
		"accepted",
		"entries",
		"splitEntries",
		"revision",
		"priorObservationRevision",
		"batchId",
		"digest",
		"sourceDigest",
		"sourceSessionId",
		"commitId",
		"reason",
		"phase",
		"id",
		"by",
		"filing",
		"final",
		"answered",
		"unavailable",
		"split",
		"ids",
		"retainedIds",
		"turnId",
		"selection",
		"route",
		"outcomes",
		"decision",
		"proven",
		"window",
	])
		if (input[key] !== undefined) facts[key] = input[key];
	for (const key of ["sourceTokens", "noteTokens", "originalInputTokens", "substitutedInputTokens", "proposed", "raw"])
		if (typeof input[key] === "number") facts[key] = { kind: "estimated", value: input[key], method: "chars/4" };
	if (typeof input.durationMs === "number")
		facts.durationMs = { kind: "measured", value: input.durationMs, source: "local-clock" };
	// A memory step's usage is the call's own facts (`TaskMemoryStepUsage`), copied as they are: measured where the
	// provider reported a value, unknown with its reason otherwise, never an invented zero.
	const usage = input.usage as
		| {
				input?: Fact<number>;
				output?: Fact<number>;
				cacheRead?: Fact<number>;
				cacheWrite?: Fact<number>;
				cacheWrite1h?: Fact<number>;
				reasoning?: Fact<number>;
				totalTokens?: Fact<number>;
				callId?: string;
				attemptId?: string;
		  }
		| null
		| undefined;
	if (usage) {
		const token = (value: Fact<number> | undefined): Fact<number> => value ?? { kind: "unknown", reason: "not-observed" };
		facts.usage = {
			input: token(usage.input),
			output: token(usage.output),
			cacheRead: token(usage.cacheRead),
			cacheWrite: token(usage.cacheWrite),
			cacheWrite1h: token(usage.cacheWrite1h),
			reasoning: token(usage.reasoning),
			total: token(usage.totalTokens),
		};
		if (usage.callId && usage.attemptId) facts.call = { callId: usage.callId, attemptId: usage.attemptId };
	}
	const receipt = input.receipt as { offerId?: string; batches?: { id: string }[] } | undefined;
	if (receipt?.offerId) facts.offerId = receipt.offerId;
	if (receipt?.batches) facts.batchIds = receipt.batches.map(({ id }) => id);
	if (Array.isArray(input.inputs)) facts.inputIds = input.inputs.map((entry: { id: string }) => entry.id);
	if (Array.isArray(input.offers)) facts.offerIds = input.offers.map((entry: { id: string }) => entry.id);
	return { event: payload.event, facts } as MemoryObservationRecorded;
}

/** Admission facts only: the task text, budget and board copy stay on the live payload (#434). */
function projectRunEnqueued(payload: DispatchEnqueuedPayload): Static<typeof RunEnqueuedSchema> {
	return {
		runId: payload.runId,
		agentId: payload.agentId,
		requestOrigin: payload.requestOrigin ?? null,
		targetId: payload.targetId,
		wireModelId: payload.wireModelId,
		runtimeId: payload.runtimeId,
		runtimeKind: payload.runtimeKind,
		...(payload.node !== undefined ? { node: payload.node } : {}),
		...(payload.endpoint !== undefined && Number.isSafeInteger(payload.endpoint.limit) && payload.endpoint.limit >= 0
			? { endpointLimit: payload.endpoint.limit }
			: {}),
		...(payload.gate !== undefined ? { gate: { role: payload.gate.role, cycle: payload.gate.cycle } } : {}),
		...(payload.rerouteCount !== undefined ? { rerouteCount: payload.rerouteCount } : {}),
	};
}

/** Start facts only: identity the envelope carries and the spawned command stay on the live payload (#434). */
/** The run id is the record's own context; only live subscribers, which see no context, are handed it (#434). */
function projectEvidenceAssessed({ runId: _runId, ...assessment }: EvidenceAssessedPayload): EvidenceAssessed {
	return assessment;
}

function projectRunStarted(payload: DispatchStartedPayload): Static<typeof RunStartedSchema> {
	return { pid: payload.pid, assignmentId: payload.assignmentId, attempt: payload.attempt };
}

/**
 * Names are `subject.past_participle`. Where a live signal and a journal record mark the same moment but carry
 * different facts, they are two events: the live `session.created`, `session.reattached` and `compaction.ended` feed
 * the subscribers that open journals and repaint, the journal `session.opened`, `session.resumed` and
 * `compaction.settled` are what the scope keeps (#434).
 */
export const EVENTS = {
	"call.started": journal(CallStartedSchema, { tier: "accountability", cc: "content-free" }),
	"call.settled": journal(CallSettledSchema, { tier: "accountability", cc: "content-free" }),
	"call.linked": journal(CallLinkedSchema, { tier: "accountability", cc: "content-free" }),
	"compaction.settled": journal(CompactionSettledSchema, { tier: "accountability", cc: "content-free" }),
	"journal.gap": journal(JournalGapSchema, { tier: "accountability", cc: "content-free" }),
	"session.opened": journal(EmptySchema, { tier: "accountability", cc: "content-free" }),
	"session.resumed": journal(SessionResumedSchema, { tier: "accountability", cc: "content-free" }),
	"session.forked": journal(SessionForkedSchema, { tier: "accountability", cc: "content-free" }),
	"session.closed": journal(SessionClosedSchema, { tier: "accountability", cc: "content-free" }),
	"journal.segment_closed": journal(JournalSegmentClosedSchema, { tier: "accountability", cc: "content-free" }),
	"turn.settled": journal(TurnSettledSchema, { tier: "accountability", cc: "content-free" }),
	"step_pipeline.settled": journal(StepPipelineSettledSchema, { tier: "accountability", cc: "content-free" }),
	"run.settled": journal(RunSettledSchema, { tier: "accountability", cc: "content-free", version: 2 }),
	"evidence.assessed": journal(EvidenceAssessedSchema, {
		tier: "accountability",
		cc: "content-free",
		project: projectEvidenceAssessed,
	}),
	"message.stepped": journal(MessageSteppedSchema, { tier: "accountability", cc: "content-free", scope: "session" }),
	"run.feed_appended": journal(RunFeedAppendedSchema, { tier: "operational", cc: "structural" }),
	"run.usage_reported": journal(RunUsageSchema, { tier: "accountability", cc: "structural" }),
	"run.linked": journal(RunLinkedSchema, { tier: "accountability", cc: "content-free" }),
	"run.enqueued": journal(RunEnqueuedSchema, {
		tier: "accountability",
		cc: "content-free",
		project: projectRunEnqueued,
	}),
	"run.started": journal(RunStartedSchema, { tier: "accountability", cc: "content-free", project: projectRunStarted }),
	"route.decided": journal(RouteDecidedSchema, { tier: "operational", cc: "content-free", version: 2 }),
	"gate.decided": journal(GateDecidedSchema, { tier: "accountability", cc: "content-free" }),
	"code_step.settled": journal(CodeStepSettledSchema, { tier: "accountability", cc: "content-free" }),
	"process.started": journal(EmptySchema, { tier: "accountability", cc: "content-free" }),
	"process.exited": journal(ProcessExitedSchema, { tier: "accountability", cc: "content-free" }),
	"bus.traced": journal(BusTracedSchema, { tier: "research", cc: "structural", capture: "busTrace" }),
	"process.booted": journal(ProcessBootedSchema, { tier: "operational", cc: "structural", scope: "process" }),
	"prewarm.decided": journal(PrewarmDecidedSchema, { tier: "operational", cc: "structural", scope: "process" }),
	"prewarm.settled": journal(PrewarmSettledSchema, { tier: "operational", cc: "structural", scope: "process" }),
	// The journal writer itself appends a seal as the last line of a closing scope; nothing emits one (#434).
	"run.sealed": journal(ScopeSealedSchema, { tier: "accountability", cc: "content-free" }),
	"session.sealed": journal(ScopeSealedSchema, { tier: "accountability", cc: "content-free" }),
	"process.sealed": journal(ScopeSealedSchema, { tier: "accountability", cc: "content-free" }),
	// `telemetry share` writes this as the last line of each scope it filters into an archive; nothing emits one (#434).
	"share.sealed": journal(ShareSealedSchema, { tier: "accountability", cc: "content-free" }),
	"prompt.text_captured": journal(PromptTextCapturedSchema, {
		tier: "research",
		cc: "content-bearing",
		capture: "content",
	}),
	"quota.read": journal(QuotaReadSchema, { tier: "operational", cc: "content-free", scope: "process" }),
	"budget.crossed": journal(BudgetCrossedSchema, { tier: "accountability", cc: "content-free" }),
	"budget.held": journal(BudgetHeldSchema, { tier: "accountability", cc: "content-free" }),
	"config.snapshotted": journal(ConfigSnapshottedSchema, { tier: "operational", cc: "structural" }),
	"config.changed": journal(ConfigChangedSchema, { tier: "operational", cc: "structural" }),
	"memory.traced": journal(MemoryTracedSchema, { tier: "research", cc: "content-bearing", capture: "content" }),
	"memory.observed": journal(MemoryObservedSchema, { tier: "research", cc: "content-bearing", capture: "content" }),
	"health.sampled": journal(HealthSampledSchema, { tier: "operational", cc: "content-free", scope: "process" }),
	"health.samples_captured": journal(HealthSamplesCapturedSchema, {
		tier: "research",
		cc: "content-free",
		scope: "process",
	}),
	"tool.settled": journal(ToolSettledSchema, { tier: "operational", cc: "content-free" }),
	"tool.decided": journal(ToolDecidedSchema, { tier: "accountability", cc: "content-free", scope: "session" }),
	"approval.requested": journal(ApprovalRequestedSchema, {
		tier: "accountability",
		cc: "content-free",
		scope: "session",
		project: (p: PermissionRequestedPayload) =>
			pick(p, [
				"tool",
				"actionClass",
				"requestId",
				"origin",
				"requestedBy",
				"agentId",
				"axis",
				"posture",
				"ruleId",
				"reasonCode",
				"policySource",
				"timeoutMs",
				"fallback",
				"escalation",
				"approvalAuthority",
				"forwardedByMain",
			]),
	}),
	"approval.resolved": journal(ApprovalResolvedSchema, {
		tier: "accountability",
		cc: "content-free",
		scope: "session",
		project: (p: PermissionResolvedPayload) => ({
			...pick(p, ["status", "requestId", "origin", "decidedBy", "tool", "actionClass", "requestedBy", "fallback"]),
			...(p.grant ? { grant: pick(p.grant, ["attempt", "authority", "issuer", "execution", "state"]) } : {}),
		}),
	}),
	"run.aborted": journal(RunAbortedSchema, {
		tier: "accountability",
		cc: "content-free",
		project: (p: RunAbortedPayload) => pick(p, ["source", "runId", "startedAt", "elapsedMs"]),
	}),
	"turn.aborted": journal(TurnAbortedSchema, {
		tier: "accountability",
		cc: "content-free",
		scope: "session",
		project: (p: TurnAbortedPayload) => ({ source: p.source }),
	}),
	"agent.status_changed": journal(AgentStatusChangedSchema, {
		tier: "accountability",
		cc: "content-free",
		scope: "session",
		project: (p: AgentStatusChangedPayload) => ({
			...pick(p, ["phase", "prevPhase", "watchdogTier"]),
			elapsedFromStart: Math.max(0, p.elapsedFromStart),
			...(p.metadata?.toolName !== undefined ? { toolName: p.metadata.toolName } : {}),
			...(p.metadata?.attempt !== undefined ? { attempt: p.metadata.attempt } : {}),
			...(p.metadata?.agentName !== undefined ? { agentName: p.metadata.agentName } : {}),
			...(p.metadata?.reason !== undefined ? { stopReason: p.metadata.reason } : {}),
		}),
	}),
	"completion.evaluated": journal(CompletionEvaluatedSchema, {
		tier: "accountability",
		cc: "content-free",
		scope: "session",
	}),
	"safety.judged": journal(SafetyJudgedSchema, { tier: "accountability", cc: "content-free", scope: "session" }),
	"prompt.compiled": journal(PromptCompiledSchema, { tier: "operational", cc: "structural" }),
	"context.snapshotted": journal(ContextSnapshottedSchema, { tier: "operational", cc: "content-free" }),
	"call.timing_captured": journal(CallTimingCapturedSchema, {
		tier: "research",
		cc: "content-free",
		capture: "deltas",
	}),
	"prompt.prefix_captured": journal(PromptPrefixCapturedSchema, { tier: "research", cc: "structural" }),
	"auth.refreshed": journal(AuthRefreshedSchema, { tier: "operational", cc: "content-free" }),
	"cache.lane_fell_back": journal(CacheLaneFellBackSchema, { tier: "operational", cc: "content-free" }),
	"middleware.fired": journal(MiddlewareFiredSchema, { tier: "operational", cc: "content-free" }),
	"surface.settled": journal(SurfaceSettledSchema, { tier: "operational", cc: "content-free" }),
	"system_one.decided": journal(SystemOneDecidedSchema, { tier: "operational", cc: "content-free", version: 2 }),
	"worker.channel_failed": journal(WorkerChannelFailedSchema, { tier: "operational", cc: "content-free" }),
	"request.captured": journal(RequestCapturedSchema, { tier: "research", cc: "content-bearing", capture: "content" }),
	"provider.headers_captured": journal(ProviderHeadersCapturedSchema, {
		tier: "research",
		cc: "content-free",
		capture: "providerHeaders",
	}),
	"hook.ran": journal(HookRanSchema, { tier: "operational", cc: "structural", scope: "session" }),
	"hub.installed": journal(HubLifecycleSchema, { tier: "accountability", cc: "structural", scope: "process" }),
	"skill.offer": journal(SkillOfferSchema, { tier: "operational", cc: "structural" }),
	"hub.updated": journal(HubLifecycleSchema, { tier: "accountability", cc: "structural", scope: "process" }),
	"hub.enabled": journal(HubLifecycleSchema, { tier: "accountability", cc: "structural", scope: "process" }),
	"hub.disabled": journal(HubLifecycleSchema, { tier: "accountability", cc: "structural", scope: "process" }),
	"hub.removed": journal(HubLifecycleSchema, { tier: "accountability", cc: "structural", scope: "process" }),
	"hub.registered": journal(HubLifecycleSchema, {
		tier: "accountability",
		cc: "structural",
		scope: "process",
	}),
	"hub.imported": journal(HubLifecycleSchema, { tier: "accountability", cc: "structural", scope: "process" }),
	"hub.share_imported": journal(HubLifecycleSchema, {
		tier: "accountability",
		cc: "structural",
		scope: "process",
	}),
	"job.changed": live<JobChangedPayload>(),
	"job.clock_resumed": journal(JobClockResumedSchema, {
		tier: "accountability",
		cc: "content-free",
		scope: "session",
		project: (p: JobClockResumedPayload) => pick(p, ["jobId", "boundMs"]),
	}),
	"turn.continued": journal(TurnContinuedSchema, {
		tier: "accountability",
		cc: "content-free",
		scope: "session",
		// `continues` rides only this event's payload, so it is declared here rather than on the shared live type.
		project: (p: TurnContinuedPayload & { continues?: string }) =>
			pick(p, ["cause", "attempt", "cap", "jobId", "continues"]),
	}),
	"autonomy.entered": journal(AutonomyEnteredSchema, { tier: "accountability", cc: "content-free", scope: "session" }),
	"autonomy.open_decision": journal(AutonomyOpenDecisionSchema, {
		tier: "accountability",
		cc: "content-free",
		scope: "session",
		project: (p: AutonomyOpenDecisionPayload) => pick(p, ["tool", "kind", "rule", "seq"]),
	}),
	"autonomy.cap_reached": journal(AutonomyCapReachedSchema, {
		tier: "accountability",
		cc: "content-free",
		scope: "session",
	}),
	"autonomy.resumed": journal(AutonomyResumedSchema, { tier: "accountability", cc: "content-free", scope: "session" }),
	"autonomy.ended": journal(AutonomyEndedSchema, { tier: "accountability", cc: "content-free", scope: "session" }),
	"session.eggs_changed": live<{ sessionId: string | null; active: readonly string[] }>(),
	"session.started": live<SessionStartPayload>(),
	"session.ended": live<SessionEndPayload>(),
	"session.created": live<SessionOpenedPayload>(),
	"session.parked": journal(SessionClosedSchema, {
		tier: "accountability",
		cc: "content-free",
		scope: "session",
		project: (p: SessionParkedPayload) => ({ reason: p.reason }),
	}),
	"session.resume_started": live<SessionResumingPayload>(),
	"session.reattached": live<SessionResumedPayload>(),
	"session.turn_switched": live<SessionTurnSwitchedPayload>(),
	"domain.loaded": journal(DomainLoadedSchema, { tier: "operational", cc: "structural", scope: "process" }),
	"domain.failed": journal(DomainFailedSchema, {
		tier: "operational",
		cc: "structural",
		scope: "process",
		project: ({ name }: DomainFailedPayload) => ({ name }),
	}),
	"config.hot_reloaded": live<ConfigChangePayload>(),
	"config.next_turn_scheduled": live<ConfigChangePayload>(),
	"config.restart_required": live<ConfigChangePayload>(),
	"config.reload_failed": journal(ConfigReloadFailedSchema, {
		tier: "operational",
		cc: "content-free",
		scope: "process",
		project: ({ message }: ConfigReloadFailedPayload) => ({ state: message === null ? "recovered" : "rejected" }),
	}),
	"config.session_changed": live<ConfigSessionChangePayload>(),
	"safety.blocked": live<SafetyBlockedPayload>(),
	// Journaled so a loop guard settlement has its facts on disk; the live payload keeps its text fields (memory design 4.6).
	"safety.loop_blocked": journal(LoopBlockedSchema, {
		tier: "operational",
		cc: "content-free",
		project: (p: LoopBlockedPayload) => pick(p, ["tool", "repeatCount", "blocksThisTurn", "budget", "disposition"]),
	}),
	"safety.tool_budget_exceeded": journal(ToolBudgetExceededSchema, {
		tier: "operational",
		cc: "content-free",
		project: (p: ToolBudgetExceededPayload) =>
			pick(p, ["tool", "callsThisTurn", "softBudget", "hardCeiling", "interrupted", "template", "stepTool", "rolled"]),
	}),
	"safety.git_hooks_changed": live<GitHooksChangedPayload>(),
	"safety.internal_git_drifted": live<InternalGitDriftPayload>(),
	"provider.health_changed": live<ProviderHealthPayload>(),
	"runtime.notice_raised": live<DeclaredRuntimeNotice>(),
	"residency.mutated": live<ResidencyMutationPayload>(),
	"run.scope_notice_raised": live<DispatchScopeNoticePayload>(),
	"run.progressed": live<DispatchProgressPayload>(),
	"run.completed": live<DispatchCompletedPayload>(),
	"run.failed": live<DispatchFailedPayload>(),
	"run.foreign_observed": live<ForeignRunObservedPayload>(),
	"approval.foreign_changed": live<ForeignApprovalChangedPayload>(),
	"compaction.started": live<CompactionPayload>(),
	"compaction.ended": live<CompactionPayload>(),
	"middleware.hook_failed": journal(MiddlewareHookFailedSchema, {
		tier: "operational",
		cc: "structural",
		project: ({ at: _at, message: _message, ...facts }: MiddlewareHookFailedPayload) =>
			definedFields(facts) as Static<typeof MiddlewareHookFailedSchema>,
	}),
	"plugin.reloaded": journal(PluginReloadedSchema, { tier: "operational", cc: "structural", scope: "process" }),
	"extension.load_failed": journal(EmptySchema, {
		tier: "operational",
		cc: "content-free",
		scope: "process",
		project: (_issue: ExtensionsLoadIssuePayload) => ({}),
	}),
	"reload.applied": live<ReloadAppliedPayload>(),
	"session.reloaded": live<SessionReloadedPayload>(),
	"context.activity_changed": live<ContextActivityPayload>(),
	"context.sources_changed": live<ContextSourcesChangedPayload>(),
	/** `/reload prompts`: re-read fragments, recipes and session prompt sources now. */
	"prompts.reload_requested": live<{ cwd: string; failures?: string[] }>(),
	"context.warning_raised": journal(ContextWarningRaisedSchema, {
		tier: "operational",
		cc: "content-free",
		scope: "session",
		project: ({ warning }: ContextWarningPayload) => ({ state: warning === null ? "cleared" : "raised" }),
	}),
	"context.pruned": journal(ContextPrunedSchema, { tier: "operational", cc: "structural", scope: "session" }),
	"context.fold": journal(ContextFoldSchema, { tier: "operational", cc: "structural", scope: "session" }),
	"context.resumed": journal(ContextResumedSchema, { tier: "operational", cc: "content-free", scope: "session" }),
	"context.recalled": journal(ContextRecalledSchema, { tier: "operational", cc: "structural", scope: "session" }),
	"context.briefing_clipped": journal(ContextBriefingClippedSchema, {
		tier: "operational",
		cc: "structural",
		scope: "session",
	}),
	"memory.step_completed": journal(MemoryStepCompletedSchema, { tier: "operational", cc: "structural" }),
	"memory.step_decided": journal(MemoryStepDecidedSchema, { tier: "accountability", cc: "structural" }),
	"memory.observation_recorded": journal(MemoryObservationRecordedSchema, {
		tier: "accountability",
		cc: "structural",
		project: projectMemoryObservation,
	}),
	"memory.guardian_changed": journal(MemoryGuardianChangedSchema, {
		tier: "operational",
		cc: "content-free",
		project: (payload: MemoryGuardianChangedPayload) => ({ state: payload.state }),
	}),
	"budget.alerted": live<BudgetAlertPayload>(),
	"shutdown.requested": journal(ShutdownRequestedSchema, {
		tier: "operational",
		cc: "content-free",
		scope: "process",
	}),
	"shutdown.drained": journal(EmptySchema, { tier: "operational", cc: "content-free", scope: "process" }),
	"shutdown.terminated": journal(EmptySchema, { tier: "operational", cc: "content-free", scope: "process" }),
	"shutdown.persisted": journal(EmptySchema, { tier: "operational", cc: "content-free", scope: "process" }),
} as const;

export type EventName = keyof typeof EVENTS;
type Definition<N extends EventName> = (typeof EVENTS)[N];
/** What `emit` takes and subscribers receive: a projected journal event's live payload, else its record data. */
export type EventPayload<N extends EventName> =
	Definition<N> extends { durability: "journal"; project: (payload: infer P) => unknown }
		? P
		: Definition<N> extends { durability: "journal"; schema: infer S extends TSchema }
			? Static<S>
			: Definition<N> extends LiveDefinition<infer P>
				? P
				: never;
/** The events a scope journals. */
export type JournalEventName = {
	[N in EventName]: Definition<N> extends { durability: "journal" } ? N : never;
}[EventName];
/** The data a journal record of this kind carries, after any projection. */
export type JournalPayload<N extends JournalEventName> = Static<Definition<N>["schema"]>;

/**
 * Journal events whose content the writer stores in `objects/` and cites as `content`, with its size as `bytes`,
 * so consent, the research cap, export, prune and GC reach it through the writer alone (#434).
 */
export const PREIMAGE_SUBJECTS = {
	"memory.traced": "memory-trace",
	"memory.observed": "observation-trace",
	"request.captured": "request",
} as const satisfies Partial<Record<JournalEventName, ObjectRef["subject"]>>;
export type PreimageEventName = keyof typeof PREIMAGE_SUBJECTS;
export type PreimageData<N extends PreimageEventName> = Omit<JournalPayload<N>, "content" | "bytes">;

function isEventName(name: string): name is EventName {
	return Object.hasOwn(EVENTS, name);
}

export function isJournalEvent(name: string): name is JournalEventName {
	return isEventName(name) && EVENTS[name].durability === "journal";
}

export function journalDefinition(name: JournalEventName): JournalDefinition {
	return EVENTS[name];
}

/** The facts each step of a message's path states, and only those. */
const MESSAGE_STEP_FIELDS: Readonly<
	Record<MessageStepped["step"], ReadonlyArray<Exclude<keyof MessageStepped, "messageId" | "step" | "submittedAt">>>
> = {
	submitted: ["by", "chars", "lane"],
	queued: ["by", "chars", "lane"],
	"lane-changed": ["lane", "changedBy"],
	held: ["why"],
	released: [],
	"handed-over": ["slot", "lane"],
	returned: ["why"],
	carried: ["callId", "attemptId", "attempt"],
	removed: ["reason"],
};

/** Schema validation plus the cross-field invariants that JSON Schema cannot express (#434). */
export function validPayload<K extends JournalEventName>(kind: K, data: unknown): data is JournalPayload<K> {
	if (!checkRecordSchema(journalDefinition(kind).schema, data)) return false;
	if (kind === "prompt.text_captured") {
		const prompt = data as EventPayload<"prompt.text_captured">;
		return (
			prompt.text.subject === "prompt-text" &&
			prompt.text.label === "resolvable" &&
			(prompt.structure === undefined || prompt.structure.subject === "prompt-structure")
		);
	}
	if (Object.hasOwn(PREIMAGE_SUBJECTS, kind)) {
		const content = (data as JournalPayload<PreimageEventName>).content;
		return content.subject === PREIMAGE_SUBJECTS[kind as PreimageEventName] && content.label === "resolvable";
	}
	if (kind === "message.stepped") {
		const { messageId: _id, step, submittedAt: _at, ...facts } = data as MessageStepped;
		const expected = MESSAGE_STEP_FIELDS[step];
		return Object.keys(facts).length === expected.length && expected.every((field) => facts[field] !== undefined);
	}
	if (kind === "compaction.settled") {
		const outcome = data as EventPayload<"compaction.settled">;
		return (
			(outcome.outcome !== "committed" || outcome.checkpointTurnId !== null) &&
			(outcome.failureCause === undefined || outcome.outcome === "failed") &&
			(outcome.checkpointDefect === undefined || outcome.failureCause === "checkpoint_format")
		);
	}
	if (kind === "tool.settled") {
		const tool = data as EventPayload<"tool.settled">;
		return (
			(tool.outcome === "blocked") === (tool.blocked !== undefined) &&
			(tool.outcome !== "blocked" || tool.resultBytes === undefined)
		);
	}
	if (kind === "auth.refreshed") {
		const auth = data as EventPayload<"auth.refreshed">;
		if (auth.outcome === "refreshed") return auth.attempted && auth.writerPid !== null;
		return auth.outcome !== "adopted" || !auth.attempted;
	}
	if (kind === "call.timing_captured") {
		const timing = data as EventPayload<"call.timing_captured">;
		return timing.gapCounts.reduce((sum, value) => sum + value, 0) === timing.deltas - 1;
	}
	if (kind !== "call.settled") return true;
	const call = data as CallSettled;
	if ((call.disposition === "never_sent") !== (call.usage === null)) return false;
	if (call.disposition === "never_sent" && (call.pricing.usd.kind !== "absent" || call.pricing.pricedBy !== "none"))
		return false;
	if (call.disposition === "settled" && !Object.values(call.usage ?? {}).some((fact) => fact.kind === "measured"))
		return false;
	// A sent_unsettled call may carry the counts its provider reported before the response ended (#434).
	if (
		call.disposition === "settled_no_usage" &&
		Object.values(call.usage ?? {}).some((fact) => fact.kind === "measured")
	)
		return false;
	const settledAt = call.stages.settle;
	if (settledAt === null) return Object.keys(call.stages).length === 1;
	return Object.values(call.stages).every(
		(value) =>
			value !== null &&
			(typeof value === "number" ? value <= settledAt : value.end >= value.start && value.end <= settledAt),
	);
}
