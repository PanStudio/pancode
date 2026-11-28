// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The shared state of one native worker run.
 *
 * startWorkerRun builds one scope per run and hands it to the worker-run
 * modules. A module reads every value it does not own as `scope.x` at the use
 * site, so a read sees the same value at the same moment the closure it came
 * from did. Mutable run state lives here as plain fields; values the run
 * computes once are getters over the run's own bindings.
 */

import type { trackCallFetch } from "../../core/call-failure.js";
import type { StructuredHelperResult } from "../../domains/agents/result-contract-types.js";
import type { FlowRestrictionSet } from "../../domains/safety/information-flow.js";
import type { McpCapabilitySource } from "../../tools/gateway/index.js";
import type { createEngineAgent } from "../agent.js";
import type { createRunPhase } from "../run-phase.js";
import type { createWorkerCallTelemetry } from "../worker-call-telemetry.js";
import type { ActiveEscalation } from "../worker-escalation.js";
import type { WorkerEventEmit, WorkerRunInput } from "../worker-run-types.js";
import type { createThrashOutcome } from "../worker-thrash-outcome.js";
import type { createWorkerToolRegistry } from "../worker-tools.js";
import type { prepareNativeWorker } from "./spec.js";

export interface WorkerRunScope {
	readonly input: WorkerRunInput;
	readonly emit: WorkerEventEmit;
	readonly phase: ReturnType<typeof createRunPhase>;
	callTracking: ReturnType<typeof trackCallFetch> | null;
	callUsageReported: boolean;
	contextPressureWindow: number;
	contextPressureCrossed: boolean;
	readStreakEscalated: number;
	streakNoteOpen: boolean;
	// Last HTTP status a provider answered. Pi's error messages drop it on some
	// APIs (openai-codex keeps only the body text), and the dispatch retry policy
	// needs it to tell a rejected request from a transient failure.
	lastProviderHttpStatus: number | null;
	workerBoundAborted: boolean;
	abortWorkerForBound: (() => void) | null;
	// Who aborted the agent, so the call it cut off and the run's diagnostic name the same cause (cf1h-D3).
	workerStopCause: "loop_guard" | "parent_cancel" | "internal" | undefined;
	// Tool calls emitted by one provider response share this correlation. The
	// loop guard counts synthesis-lock noncompliance by model round, preventing
	// one wide parallel batch from consuming the entire denial backstop.
	workerModelRound: number;
	runFlow: FlowRestrictionSet | null;
	flowBlockReported: boolean;
	workerMcp: McpCapabilitySource | undefined;
	resultContractRepairsQueued: number;
	resultContractRepairsStarted: number;
	toolExecutionsStarted: number;
	evidenceRepairActive: boolean;
	acceptedHelperResult: StructuredHelperResult | null;
	helperExposedThisRound: boolean;
	helperTerminalRequest: boolean;
	helperTurnFailure: string | null;
	readonly observedReadRanges: Map<string, Array<readonly [number, number]>>;
	/**
	 * Lines a grep result showed, keyed like the read spans. They ground a
	 * citation but stay out of the repair anchors, which quote read spans back
	 * to the model and would grow by one entry per match.
	 */
	readonly observedGrepLines: Map<string, Set<number>>;
	/** What the run's observation pool is sized from, measured each round; tools a round calls read the latest. */
	runObservationWindow: { usableTokens: number; workShare: number; inputTokens: number } | undefined;
	contractResponseFormat: Record<string, unknown> | undefined;
	permissionFailure: boolean;
	activeEscalation: ActiveEscalation | null;
	readonly registry: ReturnType<typeof createWorkerToolRegistry>;
	readonly agent: ReturnType<typeof createEngineAgent>["agent"];
	readonly safety: ReturnType<typeof prepareNativeWorker>["safety"];
	readonly contractCwd: string;
	readonly helperForcedChoiceAvailable: boolean;
	readonly helperSchema: Record<string, unknown> | null;
	readonly unsubscribe: () => void;
	readonly inheritedCount: number;
	readonly synthesisTimer: ReturnType<typeof setTimeout> | undefined;
	readonly wallTimer: ReturnType<typeof setTimeout> | undefined;
	readonly clearActiveEscalation: () => void;
	readonly unsubscribePermission: () => void;
	readonly thrashOutcome: ReturnType<typeof createThrashOutcome>;
	readonly workerTelemetry: ReturnType<typeof createWorkerCallTelemetry> | undefined;
}
