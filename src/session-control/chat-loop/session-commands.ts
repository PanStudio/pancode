// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { evaluateSkillToolSurface, skillSurfaceNames } from "../../core/skill-activation.js";
import { narrowTurnConstraints, snapshotTurnConstraints, toolSurfaceSources } from "../../core/turn-constraints.js";
import type { WorkerContextSnapshot } from "../../domains/context/worker/contract.js";
import { captureWorkerContext } from "../../domains/context/worker/snapshot.js";
import type { ChatLoop } from "../chat-loop.js";
import type { ChatLoopScope } from "../chat-loop-scope.js";
import type { ChatLoopSessionCommandsState } from "../turn-state.js";

/**
 * The operator's session commands on the loop: resuming a paused yolo, clearing the skill surface, capturing
 * the worker context, and the tool ceiling with the job constraints it yields.
 */
export function createChatLoopSessionCommands(
	loop: ChatLoopScope,
	state: ChatLoopSessionCommandsState,
): Pick<
	ChatLoop,
	"resumeAutonomy" | "clearSkillSurface" | "captureWorkerContext" | "setToolCeiling" | "toolLimits" | "jobConstraints"
> {
	const { armSkillSurface, deps, operatorToolLimits } = loop;
	return {
		resumeAutonomy: () => {
			const autonomy = deps.autonomy;
			if (autonomy === undefined || autonomy.halted() === null) return false;
			if (loop.disposed || state.streaming || state.activeUserTurnId !== null) return false;
			autonomy.operatorSpoke();
			void loop.api.submit(
				"[PanCode] The operator resumed yolo after it paused. Continue from where the previous turn stopped, and if the work is already finished, say so and stop.",
				{ origin: "yolo resume", yoloContinuation: true },
			);
			return true;
		},
		clearSkillSurface: () => {
			const cleared = skillSurfaceNames(state.activeSkillSurface);
			armSkillSurface(undefined, undefined, true);
			return cleared;
		},
		captureWorkerContext(): WorkerContextSnapshot | null {
			const meta = deps.session?.current();
			if (!meta) return null;
			return captureWorkerContext(
				{ sessionId: meta.id, leafTurnId: state.lastTurnId, cwd: meta.cwd },
				state.runtime?.agent.state.messages ?? state.replayedContextMessages,
				deps.readSessionEntries?.(),
			);
		},
		setToolCeiling(ceilings, lifetime = "session") {
			const limits = snapshotTurnConstraints(
				ceilings.reduce(narrowTurnConstraints, lifetime === "session" ? operatorToolLimits : loop.sessionToolLimits),
			);
			if (lifetime === "session") loop.sessionToolLimits = limits;
			loop.promptToolLimits = limits;
			// A run in flight keeps the scope it was admitted under (#423).
			if (!state.streaming) state.currentTurnConstraints = loop.promptToolLimits;
			return limits;
		},
		toolLimits: () => loop.promptToolLimits,
		jobConstraints: () => {
			const constraints = state.currentTurnConstraints;
			const policy = state.currentPendingSkillPolicy ?? state.activeSkillSurface;
			if (!policy) return snapshotTurnConstraints(constraints);
			const allowedTools = (deps.toolRegistry?.listAll() ?? [])
				.map((tool) => tool.name)
				.filter(
					(name) =>
						evaluateSkillToolSurface(policy, name) === null &&
						(constraints?.allowedTools === undefined || constraints.allowedTools.includes(name)),
				);
			// The skill surface narrows the job, so a refusal must name it rather than
			// blame a wider scope that still admits the tool.
			return snapshotTurnConstraints({
				...constraints,
				allowedTools,
				toolSurfaceSources: [
					...toolSurfaceSources(constraints),
					{
						tools: allowedTools,
						source: `active skill tool surface (${skillSurfaceNames(policy).join(", ")})`,
						remedy: "Unload the narrowing skill or widen its allowed-tools, then recreate the job.",
					},
				],
			});
		},
	};
}
