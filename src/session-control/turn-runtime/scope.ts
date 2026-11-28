// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The shared state of one turn runtime.
 *
 * createTurnRuntime builds one scope per chat loop and hands it to the turn-runtime modules. A module reads every
 * value it does not own as `rt.x` at the use site, so a read sees the same value at the same moment the closure it
 * came from did. Mutable runtime state lives here as plain fields; functions the runtime defines later are getters
 * over its own bindings.
 */

import type { CacheRequestStructure } from "../../core/cache-telemetry.js";
import type { trackCallFetch } from "../../core/call-failure.js";
import type { ModelRouteRefusal } from "../../core/response-model-id.js";
import type { FailureCause } from "../../core/telemetry/enums.js";
import type { TelemetryCall } from "../../core/telemetry/producer.js";
import type { CallSettled } from "../../core/telemetry/schemas.js";
import type { CacheBaseline } from "../../domains/telemetry/cache-physics.js";
import type { TelemetrySessionLease } from "../../domains/telemetry/session-journals.js";
import type { createRequestStructures } from "../../engine/request-structure.js";
import type { EngineModel } from "../../engine/types.js";
import type { ToolFinishEvent } from "../../tools/agent-tools.js";
import type { AttemptReceipt, RequestCursor } from "../attempt-receipt.js";
import type { ExpectedColdReason } from "../turn-context.js";
import type { RunningCallWait, TurnRuntime, TurnRuntimeDeps } from "../turn-runtime-types.js";
import type { AgentRuntime, ChatLoopTarget, PreInvocationStage } from "../turn-state.js";

/** The admission outcome the tool registry settled for one call, kept until the call's end event. */
export type SettledToolOutcome = Pick<
	ToolFinishEvent,
	| "outcome"
	| "reason"
	| "durationMs"
	| "actionClass"
	| "decision"
	| "deniedPark"
	| "redundantRepeat"
	| "ruleId"
	| "reasonCode"
	| "policySource"
	| "autoApproved"
	| "denial"
	| "unresolved"
>;

export interface TurnRuntimeScope {
	readonly deps: TurnRuntimeDeps;
	readonly state: TurnRuntimeDeps["state"];
	readonly context: TurnRuntimeDeps["context"];
	readonly persistence: TurnRuntimeDeps["persistence"];
	readonly middleware: TurnRuntimeDeps["middleware"];
	readonly middlewareToolChoice: TurnRuntimeDeps["middlewareToolChoice"];
	disposed: boolean;
	/** The last probe's word on the selected model when it was not serving, until the target answers a request on it. */
	coldAtProbe: { targetId: string; modelId: string; state: "absent" | "loading" } | null;
	// A target id/model names the selection, not its current URL, auth, pricing
	// or cache policy. Keep the constructed descriptor identity across calls.
	runtimeTargetSettings: string | null;
	readonly toolOutcomes: Map<string, SettledToolOutcome>;
	readonly cutOffToolCalls: Set<string>;
	readonly protocolRetryCalls: Set<string>;
	readonly startedCallLabels: Map<string, string>;
	readonly turnCalls: Map<string, CallSettled[]>;
	readonly bareFinishRefusals: Map<string, number>;
	readonly steeredTurns: Map<string, string>;
	readonly cacheBaselines: Map<string, CacheBaseline>;
	cacheBaselineGeneration: number | undefined;
	readonly journaledStructures: Map<string, { structure: CacheRequestStructure; attemptId?: string }>;
	// Disturbances owed to the next request that leaves: those taken for one that never left, and a Codex auth reset
	// that closed the socket after its call, so the next call sends the recovery frame (#434).
	carriedColdReasons: ExpectedColdReason[];
	readonly unreportedUsageSessions: Set<string>;
	clearCurrentWatchdog: () => void;
	callWait: () => RunningCallWait;
	readonly cleanupSessionResources: TurnRuntime["cleanupSessionResources"];
	readonly ensureRuntime: TurnRuntime["ensureRuntime"];
	readonly readTarget: (route?: { target: string; model: string }) => ChatLoopTarget | null;
	readonly modelOfferRefusal: (
		targetId: string,
		modelId: string,
		signal: AbortSignal | undefined,
	) => Promise<ModelRouteRefusal | null>;
	readonly synthesizeModel: (target: ChatLoopTarget) => EngineModel;
	readonly ensureReasoningProbe: (target: ChatLoopTarget) => void;
	readonly emitThinkingClampNotice: (resolution: ChatLoopTarget["runtimeResolution"]) => void;
}

type RequestStructures = ReturnType<typeof createRequestStructures>;

/** What one attempt handed Pi, digested only at settle so the hashing stays off the send path (#434). */
export interface AttemptRequest {
	/** The ledger as admission prepared this request (SPEC §1.1), or as a portable fallback rewrote it. */
	cursor: RequestCursor | null;
	model: Parameters<RequestStructures>[0];
	context: Parameters<RequestStructures>[1];
	compiled: Parameters<RequestStructures>[2];
	coldReasons: ExpectedColdReason[];
	receipt: Pick<AttemptReceipt, "toolChoice" | "tail" | "fallback" | "codex">;
}

/**
 * The shared state of one agent build.
 *
 * buildAgentRuntime builds one scope per agent and hands it to the modules that define the agent's hooks. The same
 * rules hold as for TurnRuntimeScope: mutable build state lives here as plain fields, read and written as `scope.x`
 * at the use site, and consts the builder declares later are getters over its own bindings.
 */
export interface AgentBuildScope {
	readonly rt: TurnRuntimeScope;
	modelCall: TelemetryCall | undefined;
	journalLease: TelemetrySessionLease | undefined;
	settledAttempts: CallSettled[];
	attemptRequest: AttemptRequest | undefined;
	/** The harness cause of a clean stop the post-tool guard threw, read once by the failure it produced. */
	guardStopCause: FailureCause | null;
	// The user turn the run started under, so a call a steer moved to its own entry settles with it (bt-26 N2h).
	runTurnId: string | null;
	// message_start can follow response headers. Keep each invocation's
	// monotonic anchor before that wait, including custom stream delegates.
	apiCallStartedAt: number | null;
	apiCallFirstDeltaAt: number | null;
	// Ends the request in flight on the first-token watchdog's verdict; set per request, cleared when it settles (MD11).
	cutStalledRequest: ((reason: string) => void) | null;
	// Each provider request's serial; the cut retires every request built up to it, so their callbacks go unheard (MD11).
	requestSerial: number;
	retiredThrough: number;
	// The request in flight is a compliance-first tool round the payload layer holds whole until it completes, so the
	// turn sees no first token while the provider streams; it keeps the mid-stream window and gives no sample (MD11).
	outputHeld: boolean;
	// Where a request is before `onStreamInvocation`. A watchdog abort while
	// `apiCallStartedAt` is null names this step, because no request has
	// reached the provider it would otherwise blame (#423).
	preInvocationStage: PreInvocationStage;
	/** The stall watchdog's last sign of progress, on `performance.now()`; the builder stamps it once it is built. */
	lastActivityAt: number;
	toolsInFlight: number;
	stallSuspendDepth: number;
	stallTimer: ReturnType<typeof setTimeout> | null;
	callTracking: ReturnType<typeof trackCallFetch> | null;
	admittedCursor: RequestCursor | null;
	// The input admission passed on after an overflow fold; the provider-bound copy pins it.
	pinnedInputTokens: number | null;
	// The last request carried the local placeholder key, so an endpoint that refuses it was sent no credential at all.
	placeholderKeySent: boolean;
	readonly requestStructure: RequestStructures;
	readonly currentRun: () => boolean;
	readonly localRuntime: AgentRuntime;
}
