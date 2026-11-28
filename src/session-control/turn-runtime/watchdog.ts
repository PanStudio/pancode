// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * An agent build's stall watchdog: the timer that aborts a wedged stream, and what the running call waits on.
 */

import { performance } from "node:perf_hooks";
import { type RetrySettings, recordFirstTokenMs, routeFirstTokenSamples } from "../../domains/session/retry.js";
import { firstTokenStallLimitMs } from "../chat-loop-policy.js";
import type { RunningCallWait } from "../turn-runtime-types.js";
import { stallAbortReason } from "../turn-runtime-wait.js";
import type { AgentBuildScope } from "./scope.js";

// Stall watchdog. `agent_start` arms a timer for `retry.streamStallMs`;
// every later engine event counts as progress and pushes the deadline
// out. When the deadline passes with nothing from the stream, the
// backend is presumed wedged (the server answers /health while its slot
// is dead) and the run is aborted through the same `agent.abort()` call
// Esc uses. `state.streamStallReason` is what tells the two aborts apart
// once the run settles: `turn-recovery.reclassifyStallAbort` reads it and
// hands the failure to the transient retry ladder, while an operator
// cancel still ends the turn.
//
// Idle is measured on `performance.now()`. Wall time is not a duration:
// a forward step of one threshold or more (NTP correcting a node that
// booted without an RTC battery, a laptop resuming from suspend) would
// otherwise make a healthy stream look silent and abort it through the
// operator-cancel path.
//
// `toolsInFlight` and `stallSuspendDepth` cover the windows where silence
// is expected and the stream is not the thing we are waiting on: a tool
// executing (a `npm run ci` that takes ten minutes is not a stalled
// stream), the post-tool continuation guard, whose auto-compaction is its
// own model call, and a paid request parked at the session cost ceiling
// (#423). The watchdog re-arms instead of firing while either
// is above zero. They are counted apart because only the tool half can
// leak: the guard's depth is a try/finally around one await, while a
// `tool_execution_end` that never arrives would disable the watchdog for
// the rest of the run. The engine settles an entire tool batch before it
// emits `turn_end`, so that event bounds the tool suspension.
export function createStallWatchdog(scope: AgentBuildScope) {
	const { deps, state } = scope.rt;

	const clearStallTimer = (): void => {
		if (scope.stallTimer === null) return;
		clearTimeout(scope.stallTimer);
		scope.stallTimer = null;
	};
	// The silence the route's first token may keep: adaptive on a calibrated hosted route, unless the round's output is
	// held until it completes (MD11).
	const firstTokenLimitMs = (retry: RetrySettings): number | null =>
		firstTokenStallLimitMs(
			retry,
			deps.providers.getRuntime(scope.localRuntime.runtimeId)?.tier,
			scope.outputHeld ? [] : routeFirstTokenSamples(scope.localRuntime.targetId, scope.localRuntime.wireModelId),
		);
	const callWait = (): RunningCallWait =>
		!scope.currentRun() || state.runtime !== scope.localRuntime || scope.localRuntime.agent.signal?.aborted
			? "elsewhere"
			: scope.toolsInFlight > 0
				? "tool"
				: scope.apiCallStartedAt === null || scope.stallSuspendDepth > 0
					? "elsewhere"
					: scope.apiCallFirstDeltaAt === null
						? "first-output"
						: "output";
	const armStallTimer = (delayMs: number): void => {
		if (scope.rt.disposed || !scope.currentRun() || scope.localRuntime.agent.signal?.aborted) return;
		scope.stallTimer = setTimeout(
			() => {
				scope.stallTimer = null;
				const retry = deps.retrySettings();
				// Zero disables the escalation; an operator who wants a stream to
				// hang forever keeps that by setting `retry.streamStallMs: 0`.
				if (retry.streamStallMs <= 0) return;
				if (scope.stallSuspendDepth > 0 || scope.toolsInFlight > 0) {
					armStallTimer(retry.streamStallMs);
					return;
				}
				// Silence before a call's first delta is not silence mid-stream. A
				// local server that slept reloads the model and prefills cold before
				// it can emit anything, which is minutes of healthy quiet; a stream
				// that already produced output and stops is a wedged slot.
				const awaitingFirstToken = scope.apiCallStartedAt !== null && scope.apiCallFirstDeltaAt === null;
				const firstTokenMs = awaitingFirstToken ? firstTokenLimitMs(retry) : null;
				if (awaitingFirstToken && firstTokenMs === null) {
					armStallTimer(retry.streamStallMs);
					return;
				}
				const stallMs = firstTokenMs ?? retry.streamStallMs;
				const idleMs = performance.now() - scope.lastActivityAt;
				if (idleMs < stallMs) {
					armStallTimer(stallMs - idleMs);
					return;
				}
				state.streamStallStage = scope.apiCallStartedAt === null ? scope.preInvocationStage : null;
				const stallReason = stallAbortReason(
					scope.localRuntime.targetId,
					idleMs,
					state.streamStallStage,
					awaitingFirstToken,
				);
				state.streamStallReason = stallReason;
				// A request that never started is ended here, not by its provider, so nothing it sends later reaches the turn.
				if (awaitingFirstToken) {
					scope.retiredThrough = scope.requestSerial;
					scope.cutStalledRequest?.(stallReason);
				}
				scope.cutStalledRequest = null;
				scope.localRuntime.agent.abort();
			},
			Math.max(1, delayMs),
		);
		// The in-flight request already holds the event loop open; this timer
		// must not keep a settled headless run alive on its own.
		scope.stallTimer.unref?.();
	};

	// A call's first output delta.
	const noteFirstOutput = (eventClock: number): void => {
		scope.apiCallFirstDeltaAt = eventClock;
		scope.modelCall?.mark("firstToken");
		// The route's first-token limit adapts to what this process has seen it do (MD11).
		if (scope.apiCallStartedAt !== null && !scope.outputHeld)
			recordFirstTokenMs(scope.localRuntime.targetId, scope.localRuntime.wireModelId, eventClock - scope.apiCallStartedAt);
		// The timer may be armed for the longer first-token window; the
		// stream is live now, so the mid-stream window applies from here.
		const stallMs = deps.retrySettings().streamStallMs;
		clearStallTimer();
		if (stallMs > 0) armStallTimer(stallMs);
	};

	// The running call's time to its first output, once it has one.
	const firstOutputMs = (): number | null =>
		scope.apiCallStartedAt === null || scope.apiCallFirstDeltaAt === null
			? null
			: Math.round(Math.max(0, scope.apiCallFirstDeltaAt - scope.apiCallStartedAt));

	return { clearStallTimer, firstTokenLimitMs, armStallTimer, callWait, noteFirstOutput, firstOutputMs };
}
