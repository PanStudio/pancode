// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { ChatLoop, RouteMoveFit } from "../chat-loop.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";
import type { TurnRuntime } from "../turn-runtime-types.js";
import type { ChatLoopRouteMoveState } from "../turn-state.js";

/**
 * The route-move surface: whether the running request fits another route, whether moving it leaves the
 * provider cache, and the move of a request still waiting on its first output.
 */
export function createChatLoopRouteMove(
	loop: ChatLoopScope,
	state: ChatLoopRouteMoveState,
): Pick<ChatLoop, "routeMoveFit" | "routeLeavesCache" | "moveWaitingRequest"> {
	const { recovery, routeFit, routeMoveWait, turnRuntime } = loop;
	return {
		routeMoveFit(route) {
			try {
				const candidate = turnRuntime.previewRoute(route);
				return candidate ? routeFit(candidate) : { kind: "unresolved", reason: "no route is configured" };
			} catch (err) {
				return { kind: "unresolved", reason: err instanceof Error ? err.message : String(err) };
			}
		},

		routeLeavesCache(route) {
			try {
				const candidate = turnRuntime.previewRoute(route);
				if (!candidate) return false;
				const runtime = state.runtime;
				// A session resumed with nothing sent yet has no runtime; the route it would run on is the one it left off with.
				const current = runtime
					? { targetId: runtime.targetId, wireModelId: runtime.wireModelId }
					: (() => {
							const resolved = turnRuntime.previewRoute();
							return resolved ? { targetId: resolved.target.target.id, wireModelId: resolved.target.wireModelId } : null;
						})();
				return (
					current === null ||
					current.targetId !== candidate.target.target.id ||
					current.wireModelId !== candidate.target.wireModelId
				);
			} catch {
				// An unresolvable route has no cost to state; the rest of the dialog and the pick itself report it.
				return false;
			}
		},

		moveWaitingRequest() {
			const wait = routeMoveWait();
			if (wait === "idle") return { kind: "idle" };
			let fit: RouteMoveFit;
			let candidate: ReturnType<TurnRuntime["previewRoute"]> = null;
			try {
				candidate = turnRuntime.previewRoute();
				fit = candidate ? routeFit(candidate) : { kind: "unresolved", reason: "no route is configured" };
			} catch (err) {
				fit = { kind: "unresolved", reason: err instanceof Error ? err.message : String(err) };
			}
			if (fit.kind === "same") return { kind: "same" };
			if (wait !== "first-output" && wait !== "retry-wait") return { kind: "next-turn", wait };
			if (fit.kind !== "fits" || candidate === null) {
				return { kind: "next-turn", wait, ...(fit.kind === "fits" ? {} : { fit }) };
			}
			const inFlight = state.runtime;
			const alreadyStopped = state.routeMove !== null;
			state.routeMove = candidate.target;
			if (wait === "retry-wait") recovery.cancelRetryCountdown();
			else if (!alreadyStopped && inFlight) {
				// The stall path's seam, because this is the same event to everything below it: PanCode aborted a silent call
				// with no operator stop behind it, and the run goes on. The reason stays in the ledger for /view.
				state.streamStallReason = `aborted to move this request to ${candidate.target.target.id}/${candidate.target.wireModelId}: no output had arrived from ${inFlight.targetId}/${inFlight.wireModelId}`;
				state.streamStallStage = null;
				turnRuntime.cancelRunWatchdog();
				inFlight.agent.abort();
			}
			return { kind: "moved", wait };
		},
	};
}
