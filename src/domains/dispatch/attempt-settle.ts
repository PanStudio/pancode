// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { gradeAttemptResult } from "./attempt-grade.js";
import { landAttemptWorktree } from "./attempt-land.js";
import { sealAttemptReceipt } from "./attempt-seal.js";
import type { AttemptSettlementState, FinalizingAttempt } from "./attempt-state.js";
import { verifyAttemptOnHost } from "./attempt-verify.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import type { RunResult } from "./types.js";

export async function startAttemptSettlement(rt: DispatchRuntime, attempt: FinalizingAttempt) {
	const {
		activeRun,
		attachRouteObservation,
		closeRunJournal,
		envelope,
		eventPump,
		finalPromise,
		finalizing,
		launch,
		ledgerRef,
		req,
		runningRowPersisted,
		timing,
	} = attempt;

	(async (): Promise<RunResult> => {
		try {
			// Filled phase by phase; each phase reads only what an earlier one set.
			const settling = {} as AttemptSettlementState;
			const gradedSettlement = Object.assign(settling, await gradeAttemptResult(rt, attempt, settling));
			const verifiedSettlement = Object.assign(gradedSettlement, await verifyAttemptOnHost(rt, attempt, gradedSettlement));
			const landedSettlement = Object.assign(
				verifiedSettlement,
				await landAttemptWorktree(rt, attempt, verifiedSettlement),
			);
			return await sealAttemptReceipt(rt, attempt, landedSettlement);
		} catch (error) {
			await rt.runs.failFinalization(
				finalizing,
				{
					ledger: ledgerRef,
					envelope,
					runJournal: attempt.runJournal,
					terminal: attempt.resolvedTerminal,
					timing,
					...(attempt.targetOutcomeRecorded ? { targetOutcomeRecorded: true } : {}),
					...(attempt.terminalEventEmitted ? { terminalEventEmitted: true } : {}),
					...(attempt.assignmentCompleted ? { assignmentCompleted: true } : {}),
				},
				error,
			);
			throw error;
		} finally {
			// A terminal seal that did not land fails the run, after its slot is released (#434).
			try {
				await closeRunJournal();
			} finally {
				attempt.unsubscribeAgentLedger?.();
				launch.release();
			}
		}
	})().then(attempt.resolveFinal, attempt.rejectFinal);

	rt.runs.active.set(envelope.id, activeRun);
	rt.capacity.stopIfCapacityLost(envelope.id, launch.lease.leaseId);
	rt.heartbeat.watchAssignmentDeadline(activeRun);
	// Same as the ACP path: return the handle once the running row is durable (#428).
	await runningRowPersisted;

	return attachRouteObservation({
		runId: envelope.id,
		events: eventPump.events,
		finalPromise,
		effectiveRequest: req,
	});
}
