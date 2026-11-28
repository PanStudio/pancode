// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ChatLoopPreparationState, TurnPreparationPhase, TurnPreparationStep } from "../turn-state.js";

/**
 * The consumed prompt's preparation window: the phase the composer renders between Enter and admission, the
 * observers that render it, and the refcount of submits holding it open. `preparingSubmits` reads the refcount.
 */
export function createTurnPreparation(state: ChatLoopPreparationState) {
	const preparationListeners = new Set<(phase: TurnPreparationPhase) => void>();
	/**
	 * Move the consumed prompt to a new preparation phase and tell everything
	 * that renders it. Idempotent, so the two compaction sites and the two
	 * clearing sites (admission and settlement, because a refusal never reaches
	 * admission) can all set the phase they mean without ordering rules.
	 */
	const setTurnPreparation = (phase: TurnPreparationPhase): void => {
		if (state.turnPreparation === phase) return;
		// `since` is the age of the whole window, not of its current sub-state:
		// what the operator is judging is how long ago they pressed Enter.
		if (state.turnPreparation === "idle") state.turnPreparationSince = Date.now();
		if (phase === "idle") {
			state.turnPreparationSince = 0;
			state.turnPreparationStage = null;
		}
		state.turnPreparation = phase;
		for (const listener of preparationListeners) {
			try {
				listener(phase);
			} catch {
				// Preparation observers are presentation only and cannot fail a turn.
			}
		}
	};

	const markPreparationStep = (step: TurnPreparationStep): void => {
		state.turnPreparationStage = { step, since: Date.now() };
	};

	/**
	 * Submits currently holding a consumed prompt. The FIFO gate lets a second
	 * submit open its window while the first is still settling, so the phase is
	 * refcounted rather than owned: the last one out turns the light off.
	 */
	let preparingSubmits = 0;
	const enterPreparation = (): void => {
		preparingSubmits += 1;
		// Opening a window never narrows one that is already open: a second submit
		// arriving while the first is compacting must not flip the composer from
		// COMPACTING back to PREPARING while the compaction is still running.
		if (state.turnPreparation === "idle") setTurnPreparation("preparing");
	};
	const leavePreparation = (): void => {
		preparingSubmits = Math.max(0, preparingSubmits - 1);
		if (preparingSubmits === 0) setTurnPreparation("idle");
	};
	/**
	 * Return to the plain preparing state after a compaction inside the window.
	 * Refcount-aware, because two submits share the window and the slower one's
	 * compaction can finish after the window has already closed; restoring
	 * `preparing` there would re-open it with nothing left to prepare.
	 */
	const endPreparationCompaction = (): void => {
		setTurnPreparation(preparingSubmits > 0 ? "preparing" : "idle");
	};
	return {
		preparationListeners,
		setTurnPreparation,
		markPreparationStep,
		enterPreparation,
		leavePreparation,
		endPreparationCompaction,
		preparingSubmits: (): number => preparingSubmits,
	};
}
