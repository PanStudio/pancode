// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { admitAttemptRoute, delegateToAcpPeer, openAttemptAdmission } from "./attempt-admit.js";
import { createAttemptFold } from "./attempt-fold.js";
import { prepareAttemptWorker } from "./attempt-prepare.js";
import { createAttemptReceiptDraft } from "./attempt-receipt.js";
import { openAttemptRun } from "./attempt-run.js";
import { startAttemptSettlement } from "./attempt-settle.js";
import { spawnAttemptWorker } from "./attempt-spawn.js";
import type { NativeAttemptState } from "./attempt-state.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import type { ProbeClaim } from "./bundle-types.js";
import type { DispatchAdmissionObserver, DispatchPreparationOptions, DispatchRequest } from "./contract.js";
import type { BatchVerificationGate } from "./host-verification.js";
import type { RunResult } from "./types.js";

export function createNativeAttempt(rt: DispatchRuntime) {
	async function admitDispatchAttempt(
		req: DispatchRequest,
		probeClaims: ProbeClaim[],
		observer?: DispatchAdmissionObserver,
		preparation?: DispatchPreparationOptions,
		settlement?: BatchVerificationGate,
	): Promise<{
		runId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunResult>;
		effectiveRequest: DispatchRequest;
	}> {
		// Filled phase by phase; each phase reads only what an earlier one set.
		const attempt = {} as NativeAttemptState;
		const openedAttempt = Object.assign(
			attempt,
			openAttemptAdmission(rt, attempt, req, probeClaims, observer, preparation, settlement),
		);
		const delegated = await delegateToAcpPeer(rt, openedAttempt);
		if (delegated !== undefined) return delegated;
		const admittedAttempt = Object.assign(openedAttempt, await admitAttemptRoute(rt, openedAttempt));
		const preparedAttempt = Object.assign(admittedAttempt, await prepareAttemptWorker(rt, admittedAttempt));
		const spawnedAttempt = Object.assign(preparedAttempt, await spawnAttemptWorker(rt, preparedAttempt));
		const foldingAttempt = Object.assign(spawnedAttempt, createAttemptFold(rt, spawnedAttempt));
		const runningAttempt = Object.assign(foldingAttempt, await openAttemptRun(rt, foldingAttempt));
		const finalizingAttempt = Object.assign(runningAttempt, createAttemptReceiptDraft(rt, runningAttempt));
		return await startAttemptSettlement(rt, finalizingAttempt);
	}

	return {
		admitDispatchAttempt,
	};
}
