// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { admitAcpDelegation } from "./acp-attempt-admit.js";
import { openAcpRun } from "./acp-attempt-run.js";
import { settleAcpRun } from "./acp-attempt-settle.js";
import { spawnAcpPeer } from "./acp-attempt-spawn.js";
import type { AcpDelegationState } from "./acp-attempt-state.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import type { ProbeClaim } from "./bundle-types.js";
import type { DispatchAdmissionObserver, DispatchPreparationOptions, DispatchRequest } from "./contract.js";
import type { EffectiveSettings } from "./envelope-stage.js";
import type { RouteDecisionV1 } from "./route-decision.js";
import type { RunPhaseMarks, RunResult } from "./types.js";

export function createAcpDelegation(rt: DispatchRuntime) {
	async function dispatchAcpDelegation(
		req: DispatchRequest,
		settings: EffectiveSettings,
		timing: RunPhaseMarks,
		routeDecision: RouteDecisionV1,
		probeClaims: ProbeClaim[],
		observer?: DispatchAdmissionObserver,
		hostRun?: DispatchPreparationOptions["hostRun"],
		signal?: AbortSignal,
	): Promise<{
		runId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunResult>;
	}> {
		// Filled phase by phase; each phase reads only what an earlier one set.
		const delegation = {} as AcpDelegationState;
		const admittedDelegation = Object.assign(
			delegation,
			await admitAcpDelegation(
				rt,
				delegation,
				req,
				settings,
				timing,
				routeDecision,
				probeClaims,
				observer,
				hostRun,
				signal,
			),
		);
		const spawnedDelegation = Object.assign(admittedDelegation, await spawnAcpPeer(rt, admittedDelegation));
		const runningDelegation = Object.assign(spawnedDelegation, await openAcpRun(rt, spawnedDelegation));
		return await settleAcpRun(rt, runningDelegation);
	}

	return {
		dispatchAcpDelegation,
	};
}
