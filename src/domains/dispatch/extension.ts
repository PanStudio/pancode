// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainBundle, DomainContext } from "../../core/domain-loader.js";
import { createAcpDelegation } from "./bundle-acp.js";
import { createNativeAttempt } from "./bundle-attempt.js";
import { createBudgetGate } from "./bundle-budget.js";
import { createCapacityMachine } from "./bundle-capacity.js";
import { createDispatchContractSurface } from "./bundle-contract.js";
import { createControlRoots } from "./bundle-control.js";
import { createDrainMachine } from "./bundle-drain.js";
import { createGrantDesk } from "./bundle-grants.js";
import { createHeartbeatWatch } from "./bundle-heartbeat.js";
import { createDispatchHost } from "./bundle-host.js";
import { createLifecycleResolver } from "./bundle-lifecycle.js";
import { createRoutePreview } from "./bundle-preview.js";
import { createQuotaPolling } from "./bundle-quota.js";
import { createStartupRecovery } from "./bundle-recovery.js";
import { createDispatchRequests } from "./bundle-request.js";
import { createRetryMachine } from "./bundle-retry.js";
import { createRetryRunner } from "./bundle-retry-run.js";
import { createRouteSelection } from "./bundle-route.js";
import { createRunTable } from "./bundle-runs.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { createDispatchCore } from "./bundle-runtime.js";
import type { DispatchBundleOptions } from "./bundle-types.js";
import type { DispatchContract } from "./contract.js";

export { UNKNOWN_PRICING_ADMISSION_ESTIMATE_USD } from "./bundle-support.js";
export type { ActiveRun, DispatchBundleOptions, DispatchNodePlacement } from "./bundle-types.js";

/**
 * The dispatch domain, composed of one machine per piece of state (bundle-*.ts), each built over one DispatchRuntime.
 * Machines read each other through `rt` at call time, so the order here matters only where a machine uses another
 * while it is built: the write-root park in the retry machine answers through the grant broker, so the grant desk
 * comes first.
 */
export function createDispatchBundle(
	context: DomainContext,
	options?: DispatchBundleOptions,
): DomainBundle<DispatchContract> {
	// Every handle is bound below before the bundle returns, and no machine reads a handle it was built before.
	const rt = { context, options } as DispatchRuntime;
	rt.core = createDispatchCore(context, options);
	rt.runs = createRunTable(rt);
	rt.grants = createGrantDesk(rt);
	rt.capacity = createCapacityMachine(rt);
	rt.budget = createBudgetGate(rt);
	rt.quota = createQuotaPolling(rt);
	rt.retry = createRetryMachine(rt);
	rt.retryRun = createRetryRunner(rt);
	rt.control = createControlRoots(rt);
	rt.heartbeat = createHeartbeatWatch(rt);
	rt.drain = createDrainMachine(rt);
	rt.recovery = createStartupRecovery(rt);
	rt.preview = createRoutePreview(rt);
	rt.route = createRouteSelection(rt);
	rt.lifecycle = createLifecycleResolver(rt);
	rt.request = createDispatchRequests(rt);
	rt.acp = createAcpDelegation(rt);
	rt.attempt = createNativeAttempt(rt);
	rt.host = createDispatchHost(rt);
	rt.contract = createDispatchContractSurface(rt);
	return { extension: rt.host.extension, contract: rt.contract.contract };
}
