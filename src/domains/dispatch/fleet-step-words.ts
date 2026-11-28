// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** A settled plan's step counts, from one source: the plan card's view in the TUI, the run outcome in the CLI. */
export interface FleetStepCounts {
	/** Steps that settled, replayed ones included. */
	ran: number;
	/** Every step the plan declared, loop cycles a resolved loop never needed included. */
	planned: number;
	/** Required steps (unconditional, outside any loop) that succeeded. */
	succeeded: number;
	required: number;
	loops?: { resolved: number; total: number };
}

/**
 * The step count a settled plan's notice, card and CLI line share. A plan with loops counts the steps that ran of those
 * it planned: its required count leaves the loop steps out, so `1/1 steps succeeded` beside a card reading `2/4` hid
 * the review that ran and said a different number for the same run. A plan without loops counts its required steps.
 */
export function fleetStepCountText(counts: FleetStepCounts, verb = "succeeded"): string {
	return counts.loops !== undefined
		? `${counts.ran} of ${counts.planned} planned steps ran`
		: `${counts.succeeded}/${counts.required} steps ${verb}`;
}

/** `1/1 loop resolved`. */
export function fleetLoopText(loops: { resolved: number; total: number }): string {
	return `${loops.resolved}/${loops.total} ${loops.total === 1 ? "loop" : "loops"} resolved`;
}
