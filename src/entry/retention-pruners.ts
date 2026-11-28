// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { pruneWorkerObservations } from "../domains/context/worker/observation-retention.js";
import { pruneWorkerContextSeeds } from "../domains/context/worker/store.js";
import { readContextSeedEnds, readRunEnds } from "../domains/dispatch/state.js";
import { pruneOrphanedObservations } from "../domains/memory/observation-store.js";
import type { RetentionPruners } from "../domains/telemetry/index.js";

/** The retention passes every composition that loads telemetry hands its daily sweep. */
export const retentionPruners: RetentionPruners = {
	/**
	 * Evicted worker observations age out with the run journals, keyed on the run that wrote them (D1-5), and worker
	 * context seeds with them, keyed on the runs that used them (FL-8). A ledger that cannot be read says nothing about
	 * which runs are still live, so nothing is removed that day.
	 */
	async workerArtifacts(stateDir, { nowMs, retentionMs, stopped }) {
		let runEnds: ReadonlyMap<string, number | null>;
		let seedEnds: ReadonlyMap<string, number | null>;
		try {
			runEnds = readRunEnds(stateDir);
			seedEnds = readContextSeedEnds(stateDir);
		} catch {
			return;
		}
		await pruneWorkerObservations(stateDir, { nowMs, retentionMs, runEnds, stopped }).catch(() => {
			// A failed pass removes nothing it could not prove safe; the next day tries again.
		});
		await pruneWorkerContextSeeds(stateDir, { nowMs, retentionMs, seedEnds, stopped }).catch(() => {});
	},
	orphanedObservations: (stateDir, stopped) => pruneOrphanedObservations(stateDir, stopped),
};
