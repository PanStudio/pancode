// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { DomainExtension } from "../../core/domain-loader.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { ROUTE_HISTORY_WARM_DELAY_MS } from "./bundle-support.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { sweepDispatchReservationsAtStartup } from "./reservation-store.js";

export function createDispatchHost(rt: DispatchRuntime) {
	const { options } = rt;
	const { now, routeObserver } = rt.core;
	let stopPromise: Promise<void> | null = null;
	let routeHistoryWarmTimer: ReturnType<typeof setTimeout> | null = null;

	function warmRouteHistory(): void {
		if (routeHistoryWarmTimer !== null || rt.drain.draining || stopPromise !== null) return;
		// After boot's own burst, so the first keystrokes do not contend with it.
		routeHistoryWarmTimer = setTimeout(() => {
			void routeObserver
				.warmHistory?.(() => rt.drain.draining || stopPromise !== null)
				.catch((error) => {
					reportDispatchDiagnostic("warm route history", error);
				});
		}, ROUTE_HISTORY_WARM_DELAY_MS);
		routeHistoryWarmTimer.unref?.();
	}

	const extension: DomainExtension = {
		// Stop drains again and flushes leases, assignments and the ledger, which
		// now wait on fsync off the main thread; give it the drain's allowance (#428).
		stopAllowanceMs: () => rt.contract.contract.drainAllowanceMs?.() ?? 0,
		async start() {
			// The journal subscribes before anything can dispatch. It rides the
			// domain's own progress and terminal channels, so it covers a run
			// whose caller iterates the handle itself (every operator path) as
			// well as one drained by the dispatch tool's event registry.
			rt.runs.attachJournalBridge();
			// Phase D revocation: a pending grant never outlives its owner. A
			// session that parks or ends and a main turn the operator cancels
			// revoke what they hold; a run's own exit and abort revoke at the run.
			rt.grants.subscribeGrantRevocation();
			// No in-memory executor survives a process restart, so every active
			// side-store lease from an earlier bundle is orphaned and must expire. Boot never waits on the admission lock
			// for it (M-35): a held lock leaves the sweep to the first plan admission.
			sweepDispatchReservationsAtStartup(now());
			const runLedger = rt.runs.openRunLedger();
			const recovered = rt.recovery.beginStartupRecovery(runLedger);
			if (!options?.bootRecovery) await recovered;
			rt.heartbeat.startHeartbeatWatchdog();
			rt.capacity.probeEndpointsAtDefaultBound();
		},
		stop() {
			if (stopPromise !== null) return stopPromise;
			if (routeHistoryWarmTimer !== null) clearTimeout(routeHistoryWarmTimer);
			let resolveStop!: () => void;
			let rejectStop!: (error: unknown) => void;
			stopPromise = new Promise<void>((resolve, reject) => {
				resolveStop = resolve;
				rejectStop = reject;
			});
			void (async () => {
				// A recovery already under way finishes before the drain and the final
				// ledger flush; one boot never started stays for the next boot.
				if (options?.bootRecovery?.started !== false) await rt.recovery.startupRecovery;
				// Shutdown is process-local. The durable machine-wide drain belongs to
				// the operator: setting it here would deny admission in every sibling
				// PanCode process, and a crash before the clearing write would wedge the
				// machine.
				await rt.drain.drain();
				await rt.capacity.releaseCapacityAtStop();
				rt.lifecycle.publishedPathScopeRoots.clear();
				await rt.runs.flushDurableWrites();
				rt.runs.detachJournalBridge();
				rt.grants.disposeGrants();
			})().then(resolveStop, rejectStop);
			return stopPromise;
		},
	};

	return {
		extension,
		warmRouteHistory,
	};
}
