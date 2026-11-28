// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { AcpFleetPreview, AcpFleetStep } from "./types-fleet.js";

export { ACP_FLEET_META_KEY, ACP_FLEET_PREVIEW_METHOD, ACP_FLEET_RUN_METHOD } from "./types.js";
export type { AcpFleetPreview } from "./types-fleet.js";

/**
 * `_pancode/fleet/preview` and `_pancode/fleet/run`: the terminal's
 * `/fleet run <playbook>` approval, split so a client can show the plan and send
 * back the hash it approved.
 *
 * Preview compiles the playbook through the shared dispatch-domain compiler
 * and dispatches nothing. Run compiles it again and starts it only when the
 * fresh plan hashes to exactly what the client approved; a playbook, agent or
 * route that changed in between is refused before any step is dispatched.
 *
 * The projection carries what the terminal overlay shows a person: waves,
 * steps, routes, declared write boundaries, gates and the budget. The
 * compiled plan itself and the rendered task stay host-side.
 */

import type { TurnConstraints } from "../core/turn-constraints.js";
import { type FleetRunCard, fleetRunCard } from "../domains/dispatch/fleet-run-card.js";
import type { FleetRunPreview, FleetRunPreviewResult } from "../domains/dispatch/index.js";
import { boundedText } from "./server-bounds.js";

export const ACP_FLEET_MAX_STEPS = 64;
const MAX_TEXT_BYTES = 512;
/** A run's own refusal is dispatch-domain prose; it is bounded like a diagnostic. */
export const ACP_FLEET_MAX_REASON_BYTES = 1024;
const MAX_DIAGNOSTICS = 32;
const MAX_DIAGNOSTIC_BYTES = 1024;
const MAX_LIST = 16;

/** What the composition root binds; the server never compiles or dispatches a plan itself. */
export interface AcpFleetControl {
	/** `resume` names a prior root whose successful prefix the run replays; the compiler validates it. */
	preview(name: string, vars: Readonly<Record<string, string>>, resume?: string): FleetRunPreviewResult;
	/**
	 * Start an approved, freshly compiled plan. Settles when its first step is
	 * dispatched, or with the reason when the run ends before dispatching one:
	 * dispatch admission can refuse a step the compiler accepted, and a client
	 * told "started" would otherwise wait on a run that never began. A run
	 * refused while another is in flight never got a root of its own.
	 * `turnConstraints` are the session's standing limits; every worker the
	 * run starts carries them.
	 */
	run(
		preview: FleetRunPreview,
		turnConstraints?: TurnConstraints,
	): Promise<
		| { status: "started"; fleetRootId: string }
		| { status: "failed"; fleetRootId: string; reason: string }
		| { status: "refused"; reason: string }
	>;
}

export function projectFleetPreview(result: FleetRunPreviewResult): AcpFleetPreview {
	if (!result.ok) {
		return {
			status: "refused",
			name: boundedText(result.name, MAX_TEXT_BYTES),
			diagnostics: result.diagnostics.slice(0, MAX_DIAGNOSTICS).map((line) => boundedText(line, MAX_DIAGNOSTIC_BYTES)),
		};
	}
	return projectFleetCard(fleetRunCard(result.preview));
}

/**
 * The approval card on the wire, bounded: `_pancode/fleet/preview` answers with it and a permission ask for a
 * model-started playbook carries it under `pancode/fleet`, so a client approves the card the terminal shows.
 */
export function projectFleetCard(card: FleetRunCard): Extract<AcpFleetPreview, { status: "ready" }> {
	let budget = ACP_FLEET_MAX_STEPS;
	let truncated = false;
	const previewText = (text: string) => {
		if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) truncated = true;
		return boundedText(text, MAX_TEXT_BYTES);
	};
	const boundedList = (values: ReadonlyArray<string>) => {
		if (values.length > MAX_LIST) truncated = true;
		return values.slice(0, MAX_LIST).map((value) => previewText(value));
	};
	const waves = card.waves.map((wave) => {
		const kept = wave.steps.slice(0, Math.max(0, budget));
		if (kept.length < wave.steps.length) truncated = true;
		budget -= kept.length;
		return {
			index: wave.index,
			steps: kept.map(
				(step): AcpFleetStep => ({
					stepId: previewText(step.stepId),
					kind: step.kind,
					// A worktree-isolated run's writing step writes the task worktree, as the approval card and `playbook graph` say.
					scope: step.scopeText,
					...(step.agentId !== undefined ? { agentId: previewText(step.agentId) } : {}),
					...(step.commandId !== undefined ? { commandId: previewText(step.commandId) } : {}),
					...(step.argv !== undefined ? { argv: boundedList(step.argv) } : {}),
					writes: step.writes === null ? null : boundedList(step.writes),
					...(step.route !== undefined
						? {
								route: {
									targetId: previewText(step.route.targetId),
									model: previewText(step.route.model),
									nodeId: previewText(step.route.nodeId),
									...(step.route.endpoint !== undefined
										? { endpoint: { label: previewText(step.route.endpoint.label), limit: step.route.endpoint.limit } }
										: {}),
								},
							}
						: {}),
					...(step.loop !== undefined ? { loop: { ...step.loop, loopId: previewText(step.loop.loopId) } } : {}),
					...(step.gate !== undefined ? { gate: { path: previewText(step.gate.path) } } : {}),
					...(step.target !== undefined ? { target: previewText(step.target) } : {}),
					...(step.profile !== undefined ? { profile: previewText(step.profile) } : {}),
					...(step.replayed === true ? { replayed: true as const } : {}),
				}),
			),
		};
	});
	return {
		status: "ready",
		name: previewText(card.name),
		planHash: card.planHash,
		stepCount: card.stepCount,
		isolation: card.isolation,
		waves: waves.filter((wave) => wave.steps.length > 0),
		budget: {
			// The wire budget is closed; how the spend was priced reaches it only through currentDisplay.
			ceilingUsd: card.budget.ceilingUsd,
			currentUsd: card.budget.currentUsd,
			playbookUsd: card.budget.playbookUsd,
			ceilingDisplay: card.budget.ceilingDisplay,
			currentDisplay: card.budget.currentDisplay,
			...(card.budget.playbookDisplay !== null ? { playbookDisplay: card.budget.playbookDisplay } : {}),
		},
		truncated,
		...(card.resume !== undefined
			? {
					resume: {
						fromRunId: previewText(card.resume.fromRunId),
						replayed: card.resume.replayed.slice(0, ACP_FLEET_MAX_STEPS).map((id) => previewText(id)),
					},
				}
			: {}),
	};
}
