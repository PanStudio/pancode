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
import type { ModelRouteRefusal } from "../../core/response-model-id.js";
import type { CallSettled } from "../../core/telemetry/schemas.js";
import type { CacheBaseline } from "../../domains/telemetry/cache-physics.js";
import type { EngineModel } from "../../engine/types.js";
import type { ToolFinishEvent } from "../../tools/agent-tools.js";
import type { ExpectedColdReason } from "../turn-context.js";
import type { RunningCallWait, TurnRuntime, TurnRuntimeDeps } from "../turn-runtime-types.js";
import type { ChatLoopTarget } from "../turn-state.js";

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
