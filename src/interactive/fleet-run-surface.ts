// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The terminal's view of every fleet run the session starts: the operator's `/fleet run` and the main agent's
 * `dispatch(playbook=...)` alike reach the board, the footer notices and the settled plan card.
 */

import type { PancodeSettings } from "../core/config.js";
import { GLYPH } from "../core/glyphs.js";
import { renderPricingSum } from "../core/telemetry/render.js";
import type { NotificationLevel } from "../core/views/notice-words.js";
import type { FleetRunSurface, FleetRunWatch } from "../domains/dispatch/fleet-run-launcher.js";
import { WriterSetBusyError } from "../domains/dispatch/index.js";
import { planWithWorkerRows } from "./dispatch-board-store.js";
import { planWarnedStepCount, renderFleetPlanCard } from "./dispatch-plan-card.js";
import type { DispatchBoardRow } from "./dispatch-row-model.js";
import type { FleetPlanRuns, FleetPlanRunView } from "./fleet-plan-runs.js";
import { progressNoticeKeys } from "./footer/notifications.js";

export interface FleetRunBoardSurfaceDeps {
	readonly fleetPlans?: FleetPlanRuns;
	readonly setFleetRunPhase?: (runId: string, phase: { wave: number; stepId: string }) => void;
	readonly notify: (level: NotificationLevel, text: string, key?: string) => void;
	readonly dismissNotification?: (key: string) => void;
	readonly stdout?: (text: string) => void;
	readonly stderr: (text: string) => void;
	readonly appendBlock?: (render: (width: number) => string[]) => void;
	readonly getDispatchRows?: () => ReadonlyArray<DispatchBoardRow>;
	readonly getSettings?: () => Readonly<PancodeSettings>;
	readonly terminal: { columns: number };
}

export function fleetRunBoardSurface(deps: FleetRunBoardSurfaceDeps): FleetRunSurface {
	return ({ rootId, preview, origin }): FleetRunWatch => {
		const name = preview.name;
		// The settled card reads each step beside its worker's own row, and draws at the width of each paint.
		const appendPlanCard = (settled: FleetPlanRunView): FleetPlanRunView => {
			const view = planWithWorkerRows(settled, deps.getDispatchRows?.() ?? []);
			const render = (width: number) =>
				renderFleetPlanCard(view, width, deps.getSettings?.().interface.outputDetail ?? "standard");
			if (deps.appendBlock !== undefined) deps.appendBlock(render);
			else deps.stderr(`${render(deps.terminal.columns).join("\n")}\n`);
			return view;
		};
		return {
			started: (run) => {
				deps.fleetPlans?.start(rootId, preview, origin === "model" ? "model" : undefined);
				// The board's cancel reaches the runner through this, which stops the running step's process (J2-F02).
				deps.fleetPlans?.bindStop(rootId, () => run.stop("operator"));
				// Counted from the waves, as the approval card counts them, so a resumed run names only what it runs. Only the
				// first wave starts now; the rest wait on it, so the notice says how many run at once rather than all of them.
				const steps = preview.waves.reduce((total, wave) => total + wave.steps.length, 0);
				const first = preview.waves[0]?.steps.length ?? 0;
				const shape =
					first >= steps ? `${steps} ${steps === 1 ? "step" : "steps"} running` : `${first} of ${steps} steps running`;
				deps.notify(
					"info",
					`plan ${name} started ${GLYPH.sep} ${shape} ${GLYPH.sep} /fleet follows it`,
					"fleet-run:started",
				);
			},
			stepDispatched: (_rootId, event) => {
				deps.setFleetRunPhase?.(event.assignmentId, { wave: event.waveIndex, stepId: event.stepId });
				deps.fleetPlans?.stepDispatched(rootId, event);
			},
			stepSettled: (_rootId, outcome) => deps.fleetPlans?.stepSettled(rootId, outcome),
			// A gate notice (a loop decision or checkpoint) is progress, not a failure; a write-boundary breach and the rest stay errors.
			notice: (text, kind) => (kind === "gate" ? (deps.stdout ?? deps.stderr) : deps.stderr)(`plan ${name}: ${text}\n`),
			settled: (settlement) => {
				deps.dismissNotification?.("fleet-run:started");
				// A stop asked for from the board, and a refusal that said this plan runs, are over once it settles.
				for (const key of [...progressNoticeKeys(rootId), "fleet-run:in-flight"]) deps.dismissNotification?.(key);
				if (settlement.ok) {
					const { outcome } = settlement;
					const plan = deps.fleetPlans?.settle(rootId, outcome);
					const warned = plan ? planWarnedStepCount(appendPlanCard(plan)) : 0;
					if (plan?.state === "cancelled") {
						deps.notify(
							"info",
							`plan ${name}: canceled ${GLYPH.sep} ${outcome.succeededStepCount}/${outcome.requiredStepCount} steps succeeded before the stop`,
							"fleet-run:settled",
						);
						return;
					}
					deps.notify(
						outcome.cleanRun && warned === 0 ? "success" : "warning",
						// An unpriced run keeps the total a lower bound, never a measured $0.00 nobody put a number on. Steps whose
						// worker finished with a warning say so, as their rows on the card do.
						`plan ${name}: ${outcome.succeededStepCount}/${outcome.requiredStepCount} steps ${warned === 0 ? "succeeded" : `finished, ${warned} with warnings`}, ${plan?.loops === undefined ? "" : `${plan.loops.resolved}/${plan.loops.total} ${plan.loops.total === 1 ? "loop" : "loops"} resolved, `}${plan?.costText === null ? "no model calls" : `cost ${renderPricingSum(outcome.totalCost)}`}`,
						"fleet-run:settled",
					);
					return;
				}
				const { error } = settlement;
				const message = error instanceof Error ? error.message : String(error);
				const failed = deps.fleetPlans?.fail(rootId, message);
				if (failed?.state === "cancelled") {
					appendPlanCard(failed);
					deps.notify("info", `plan ${name}: canceled before every step settled`, "fleet-run:settled");
					return;
				}
				if (error instanceof WriterSetBusyError) {
					deps.notify("warning", `plan ${name}: ${message}`, "fleet-run:refused");
					return;
				}
				deps.notify("error", `plan ${name}: ${message}`, "fleet-run:failed");
			},
		};
	};
}
