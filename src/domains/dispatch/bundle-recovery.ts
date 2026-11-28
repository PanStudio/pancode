// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { existsSync } from "node:fs";
import { pancodeStateDir } from "../../core/xdg.js";
import {
	readSettledRun,
	telemetryBundlePath,
	telemetryJournalPath,
	telemetryRunDirectory,
} from "../telemetry/index.js";
import { reconcileOrphanAssignments } from "./assignment-reconcile.js";
import { assignmentProcessOwnerAlive, listStoredAssignments, settleStoredAssignment } from "./assignment-store.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { recoverAbandonedRuns } from "./orphan-recovery.js";
import { assignmentStatusForOutcome } from "./outcome.js";
import { sealTerminalRunJournal, settleOrphanedRunJournal } from "./run-telemetry.js";
import type { Ledger } from "./state.js";

export function createStartupRecovery(rt: DispatchRuntime) {
	const { options } = rt;
	// The ledger scan and assignment reconcile, after restart worktree recovery (start()).
	let startupRecovery: Promise<void> = Promise.resolve();
	let startupRecovered = false;

	/** Starts a boot recovery not yet started and settles once restart recovery has finished. */
	async function awaitStartupRecovery(): Promise<void> {
		if (startupRecovered) return;
		void options?.bootRecovery?.start();
		await startupRecovery;
	}

	async function recoverStartupRuns(runLedger: Ledger): Promise<void> {
		// The ledger was read before the first frame; a sibling may have settled
		// a run since, and a scan or reconcile against that stale copy would
		// settle the run, or the assignment it answers, as abandoned. A ledger
		// that no longer reads skips both.
		try {
			runLedger.reload();
		} catch (error) {
			reportDispatchDiagnostic("ledger recovery", error);
			return;
		}
		// Symphony P10: restart recovery from durable artifacts. A row whose
		// host died settles from its run's journal, or closes as stalled.
		try {
			const recovery = recoverAbandonedRuns(runLedger, {
				journalUnsealed: (runId) => {
					const directory = telemetryRunDirectory(pancodeStateDir(), runId);
					return existsSync(telemetryJournalPath(directory)) && !existsSync(telemetryBundlePath(directory));
				},
			});
			// Each abandoned run's record lands before its terminal row does, as a live run's does.
			await Promise.all(
				recovery.unsettled.map(({ runId, settlement }) =>
					rt.runs
						.trackDurableWrite(settleOrphanedRunJournal(telemetryRunDirectory(pancodeStateDir(), runId), settlement))
						.catch((error) => reportDispatchDiagnostic(`settle the journal of run ${runId}`, error)),
				),
			);
			// A terminal row persisted before its journal's seal landed gets that seal now, and one whose run.settled never
			// landed gets the correcting record the row states before it (#434).
			for (const { runId, settlement } of recovery.unsealed)
				void rt.runs
					.trackDurableWrite(sealTerminalRunJournal(telemetryRunDirectory(pancodeStateDir(), runId), settlement))
					.catch((error) => reportDispatchDiagnostic(`seal the journal of run ${runId}`, error));
			if (recovery.abandoned > 0 || recovery.sealed > 0) {
				await runLedger.persist();
				if (process.env.PANCODE_INTERACTIVE !== "1") {
					process.stderr.write(`[dispatch] ledger recovery: sealed=${recovery.sealed} abandoned=${recovery.abandoned}\n`);
				}
			}
		} catch (error) {
			// Recovery is best-effort; a failed scan never blocks startup.
			reportDispatchDiagnostic("ledger recovery", error);
		}
		// Reconcile durable assignments orphaned in `running` by a crash: the
		// in-memory registry and retry queue do not survive restart, so an
		// orphan can never settle without this pass. Resolves each against
		// durable ledger evidence so wait/collect never hang on it.
		try {
			const reconciled = await reconcileOrphanAssignments({
				listRunning: () => listStoredAssignments().filter((record) => record.status === "running"),
				ownerAlive: assignmentProcessOwnerAlive,
				lookupAttempt: (runId) => {
					// The run's record decides, as it does for a live run's assignment; the row only when none landed.
					const settled = readSettledRun(pancodeStateDir(), runId)?.settled;
					if (settled !== undefined)
						return {
							runId,
							terminal: true,
							succeeded: settled.outcome === "succeeded",
							terminalStatus: assignmentStatusForOutcome(settled.outcome),
						};
					const envelope = runLedger.get(runId) ?? null;
					if (!envelope) return null;
					return {
						runId,
						terminal: envelope.status !== "running",
						succeeded: envelope.outcome === "succeeded",
						...(envelope.outcome !== null && envelope.outcome !== undefined
							? { terminalStatus: assignmentStatusForOutcome(envelope.outcome) }
							: {}),
					};
				},
				settle: (assignmentId, terminalRunId, status, owner) =>
					settleStoredAssignment(assignmentId, terminalRunId, status, owner),
			});
			if ((reconciled.recovered > 0 || reconciled.abandoned > 0) && process.env.PANCODE_INTERACTIVE !== "1") {
				process.stderr.write(
					`[dispatch] assignment reconcile: recovered=${reconciled.recovered} abandoned=${reconciled.abandoned}\n`,
				);
			}
		} catch {
			// Reconciliation is best-effort; a failure never blocks startup.
		}
	}

	/** Boot starts its worktree recovery after the first frame; the scan follows it, so abandoned rows observe the workers it terminated. */
	function beginStartupRecovery(runLedger: Ledger): Promise<void> {
		const bootRecovery = options?.bootRecovery;
		startupRecovery = bootRecovery
			? bootRecovery.settled.then(() => recoverStartupRuns(runLedger))
			: recoverStartupRuns(runLedger);
		void startupRecovery.then(() => {
			startupRecovered = true;
		});
		return startupRecovery;
	}

	return {
		awaitStartupRecovery,
		beginStartupRecovery,
		get startupRecovery() {
			return startupRecovery;
		},
	};
}
