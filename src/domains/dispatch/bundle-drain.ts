// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { AdmissionCanceledError } from "./admission-error.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import type { DispatchAdmissionObserver, DispatchPreparationOptions, DispatchRequest } from "./contract.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import type { BatchVerificationGate } from "./host-verification.js";

export function createDrainMachine(rt: DispatchRuntime) {
	let draining = false;
	const drainController = new AbortController();
	const dispatching = new Set<Promise<unknown>>();
	let drainPromise: Promise<void> | null = null;

	function dispatch(
		req: DispatchRequest,
		observer?: DispatchAdmissionObserver,
		preparation?: DispatchPreparationOptions,
		settlement?: BatchVerificationGate,
	): ReturnType<typeof rt.request.dispatchRequest> {
		if (draining) return Promise.reject(new AdmissionCanceledError());
		const operation = rt.request.dispatchRequest(
			req,
			observer,
			{
				...preparation,
				signal: preparation?.signal
					? AbortSignal.any([preparation.signal, drainController.signal])
					: drainController.signal,
			},
			settlement,
		);
		dispatching.add(operation);
		operation
			.finally(() => dispatching.delete(operation))
			.catch(() => {
				// The original admission promise retains its error for the caller.
			});
		return operation;
	}

	function drain(): Promise<void> {
		if (drainPromise !== null) return drainPromise;
		let resolveDrain!: () => void;
		let rejectDrain!: (error: unknown) => void;
		drainPromise = new Promise<void>((resolve, reject) => {
			resolveDrain = resolve;
			rejectDrain = reject;
		});
		draining = true;
		drainController.abort(new AdmissionCanceledError());
		rt.capacity.capacityAdmission.drain();
		rt.heartbeat.stopHeartbeatWatchdog();
		void (async () => {
			rt.retry.settleQueuedAssignmentsForShutdown();
			const canceled = new Set<string>();
			while (rt.runs.active.size > 0 || dispatching.size > 0) {
				const runs = Array.from(rt.runs.active.values());
				for (const run of runs) {
					if (canceled.has(run.runId)) continue;
					canceled.add(run.runId);
					rt.runs.emitRunAborted(run, "dispatch_drain");
					run.aborted = true;
					rt.grants.grantBroker.revokeRun(run.runId, "the owning session is shutting down");
					try {
						run.abort();
					} catch {
						// Await finalization even when the runtime's abort throws.
					}
				}
				await Promise.allSettled([...dispatching, ...runs.map((run) => run.finalPromise)]);
			}
			while (rt.control.memberWork.size > 0) {
				await Promise.allSettled([...rt.control.memberWork.values()].flatMap((work) => [...work]));
			}
			await rt.runs.flushDurableWrites();
			// Non-fatal so stop() still releases leases, flushes and closes the
			// journal bridge; the rows stay dirty for any later persist (#428).
			if (rt.runs.ledger) {
				try {
					await rt.runs.ledger.persist();
				} catch (error) {
					reportDispatchDiagnostic("persist ledger at drain", error);
				}
			}
		})().then(
			// Concurrent callers share one drain; a call after it settled runs
			// again, so a ledger change made since then is still persisted. The
			// slot clears before waiters resume so their next call starts fresh.
			() => {
				drainPromise = null;
				resolveDrain();
			},
			(error: unknown) => {
				drainPromise = null;
				rejectDrain(error);
			},
		);
		return drainPromise;
	}

	return {
		dispatch,
		drain,
		get draining() {
			return draining;
		},
	};
}
