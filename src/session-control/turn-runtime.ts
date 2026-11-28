// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * Turn runtime ownership: orchestrator target resolution, model synthesis,
 * live-agent construction and model hot-swap, thinking-level reconciliation,
 * capability/reasoning probes, and the run-event pipeline that enriches
 * engine events with timing, observability, persistence, and honesty facts.
 */

import type { CacheRequestStructure } from "../core/cache-telemetry.js";
import type { CallSettled } from "../core/telemetry/schemas.js";
import type { CacheBaseline } from "../domains/telemetry/cache-physics.js";
import { cleanupEngineSessionResources } from "../engine/ai.js";
import type { ToolTelemetry } from "../tools/agent-tools.js";
import { ensureRuntime as ensureTurnRuntime } from "./turn-runtime/build.js";
import { createRouteControl } from "./turn-runtime/route.js";
import type { SettledToolOutcome, TurnRuntimeScope } from "./turn-runtime/scope.js";
import type { TurnRuntime, TurnRuntimeDeps } from "./turn-runtime-types.js";
import type { AgentRuntime } from "./turn-state.js";

export { TurnAdmissionError } from "./turn-runtime/errors.js";

export function createTurnRuntime(deps: TurnRuntimeDeps): TurnRuntime {
	const { state, context, persistence, middleware, middlewareToolChoice } = deps;

	/**
	 * Authoritative admission outcome per call, keyed by the engine's
	 * `toolCallId`, recorded as the registry settles and consumed when the
	 * matching `tool_execution_end` arrives. Entries are deleted on consumption;
	 * a call whose end event never arrives leaves at most one stale entry, which
	 * the next run with the same id would overwrite.
	 */
	const toolOutcomes = new Map<string, SettledToolOutcome>();
	/** Calls of a response the output token limit cut off: the engine fails each unrun, so they are flagged as not run (bt-39 a). */
	const cutOffToolCalls = new Set<string>();
	/**
	 * Finish calls the completion protocol refused (no reply text, or not the only call): the model retries them, so
	 * the transcript drops their rows while the session record and the model's context keep the refusal (R2-F15).
	 */
	const protocolRetryCalls = new Set<string>();
	/** Each started call's label until it settles; a call that ran without error joins `turnCallsDone`. */
	const startedCallLabels = new Map<string, string>();
	const toolTelemetry: ToolTelemetry = {
		onFinish(event) {
			if (event.toolCallId === undefined) return;
			toolOutcomes.set(event.toolCallId, {
				outcome: event.outcome,
				...(event.reason === undefined ? {} : { reason: event.reason }),
				durationMs: event.durationMs,
				...(event.actionClass === undefined ? {} : { actionClass: event.actionClass }),
				...(event.decision === undefined ? {} : { decision: event.decision }),
				...(event.deniedPark === true ? { deniedPark: true } : {}),
				...(event.redundantRepeat === true ? { redundantRepeat: true } : {}),
				...(event.ruleId === undefined ? {} : { ruleId: event.ruleId }),
				...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
				...(event.policySource === undefined ? {} : { policySource: event.policySource }),
				...(event.autoApproved === undefined ? {} : { autoApproved: event.autoApproved }),
				...(event.denial === undefined ? {} : { denial: event.denial }),
				...(event.unresolved === true ? { unresolved: true as const } : {}),
			});
		},
	};

	const turnCalls = new Map<string, CallSettled[]>();
	// Bare attended finishes refused per user turn (FX-40), journaled on that turn's turn.settled (CLI-P50).
	const bareFinishRefusals = new Map<string, number>();
	// A turn id a delivered steer moved a run to, mapped to the turn the run settles under (bt-26 N2h).
	const steeredTurns = new Map<string, string>();
	// The last request sent on each cache key, kept across runtime rebuilds and dropped whenever turn-context restarts
	// cache comparison, so the journal compares within one context generation as #423 does (#434).
	const cacheBaselines = new Map<string, CacheBaseline>();
	// The last structure journaled on each session and cache key in this process, never reset, so each request
	// journals only what it appended to it and a later process can rebuild the transcript the provider saw.
	const journaledStructures = new Map<string, { structure: CacheRequestStructure; attemptId?: string }>();
	// Sessions already told that a capped route's spend is estimated because its calls report no usage.
	const unreportedUsageSessions = new Set<string>();
	const rt: TurnRuntimeScope = {
		deps,
		state,
		context,
		persistence,
		middleware,
		middlewareToolChoice,
		disposed: false,
		coldAtProbe: null,
		runtimeTargetSettings: null,
		toolOutcomes,
		cutOffToolCalls,
		protocolRetryCalls,
		startedCallLabels,
		turnCalls,
		bareFinishRefusals,
		steeredTurns,
		cacheBaselines,
		cacheBaselineGeneration: undefined,
		journaledStructures,
		carriedColdReasons: [],
		unreportedUsageSessions,
		clearCurrentWatchdog: () => {},
		callWait: () => "elsewhere",
		get cleanupSessionResources() {
			return cleanupSessionResources;
		},
		get ensureRuntime() {
			return ensureRuntime;
		},
		get readTarget() {
			return readTarget;
		},
		get modelOfferRefusal() {
			return modelOfferRefusal;
		},
		get synthesizeModel() {
			return synthesizeModel;
		},
		get ensureReasoningProbe() {
			return ensureReasoningProbe;
		},
		get emitThinkingClampNotice() {
			return emitThinkingClampNotice;
		},
	};
	const {
		readTarget,
		ensureLiveCapabilitiesForSelectedModel,
		modelOfferRefusal,
		synthesizeModel,
		ensureReasoningProbe,
		emitThinkingClampNotice,
		previewRoute,
		rebindRoute,
	} = createRouteControl(rt);

	const TARGET_PROBE_POLL_MS = 5_000;
	const selectedRoutePoll = setInterval(() => {
		if (state.streaming) return;
		void ensureLiveCapabilitiesForSelectedModel({ silent: true }).catch(() => {});
	}, TARGET_PROBE_POLL_MS);
	selectedRoutePoll.unref();

	const cleanupSessionResources = (sessionId: string | undefined): void => {
		try {
			cleanupEngineSessionResources(sessionId);
		} catch (err) {
			deps.emitNotice(`[PanCode] session resource cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	const ensureRuntime = (options?: { silent?: boolean }): AgentRuntime | null => {
		return ensureTurnRuntime(rt, options);
	};

	return {
		callWait: () => rt.callWait(),
		previewRoute,
		rebindRoute,
		ensureRuntime,
		ensureLiveCapabilitiesForSelectedModel,
		dispose: () => {
			rt.disposed = true;
			rt.clearCurrentWatchdog();
			clearInterval(selectedRoutePoll);
		},
		cancelRunWatchdog: () => rt.clearCurrentWatchdog(),
		cleanupSessionResources,
		toolTelemetry,
		takeSettledCalls(userTurnId) {
			const calls = turnCalls.get(userTurnId) ?? [];
			turnCalls.delete(userTurnId);
			steeredTurns.clear();
			// Any other turn's calls but the running one's settled after their own turn.settled was written. Each still
			// carries its turn id in the journal, so releasing them here only bounds this map (#434).
			for (const turnId of turnCalls.keys()) if (turnId !== state.activeUserTurnId) turnCalls.delete(turnId);
			return calls;
		},
		takeBareFinishRefusals(userTurnId) {
			const count = bareFinishRefusals.get(userTurnId) ?? 0;
			// Only the running turn can still refuse; any other entry belongs to a turn that already settled.
			for (const turnId of bareFinishRefusals.keys())
				if (turnId === userTurnId || turnId !== state.activeUserTurnId) bareFinishRefusals.delete(turnId);
			return count;
		},
	};
}
