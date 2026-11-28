// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { performance } from "node:perf_hooks";
import { startAcpDelegationRun } from "../../acp/adapter.js";
import type { DomainContext } from "../../core/domain-loader.js";
import { useMainCacheLaneStore } from "../../engine/ai.js";
import type { AgentsContract } from "../agents/contract.js";
import type { MiddlewareContract } from "../middleware/contract.js";
import type { PromptsContract } from "../prompts/contract.js";
import type { ProvidersContract } from "../providers/index.js";
import type { SafetyContract } from "../safety/contract.js";
import type { ProtectedArtifactState } from "../safety/protected-artifacts.js";
import type { SchedulingContract } from "../scheduling/contract.js";
import { AssignmentRegistry } from "./assignment.js";
import type { createAcpDelegation } from "./bundle-acp.js";
import type { createNativeAttempt } from "./bundle-attempt.js";
import type { createBudgetGate } from "./bundle-budget.js";
import type { createCapacityMachine } from "./bundle-capacity.js";
import type { createDispatchContractSurface } from "./bundle-contract.js";
import type { createControlRoots } from "./bundle-control.js";
import type { createDrainMachine } from "./bundle-drain.js";
import type { createGrantDesk } from "./bundle-grants.js";
import type { createHeartbeatWatch } from "./bundle-heartbeat.js";
import type { createDispatchHost } from "./bundle-host.js";
import type { createLifecycleResolver } from "./bundle-lifecycle.js";
import type { createRoutePreview } from "./bundle-preview.js";
import type { createQuotaPolling } from "./bundle-quota.js";
import type { createStartupRecovery } from "./bundle-recovery.js";
import type { createDispatchRequests } from "./bundle-request.js";
import type { createRetryMachine } from "./bundle-retry.js";
import type { createRetryRunner } from "./bundle-retry-run.js";
import type { createRouteSelection } from "./bundle-route.js";
import type { createRunTable } from "./bundle-runs.js";
import { DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_RESILIENCE_COOLDOWN_MS } from "./bundle-support.js";
import type { DispatchBundleOptions, ProbeClaim } from "./bundle-types.js";
import { mainCacheLaneStore } from "./capacity-lease.js";
import type { DispatchRequest } from "./contract.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import type { EffectiveSettings } from "./envelope-stage.js";
import { affectsTargetBreaker, type FailureClass } from "./failure-classification.js";
import { DEFAULT_HEARTBEAT_SPEC } from "./heartbeat.js";
import { createFleetPlacementPreviewResolver, createFleetPlacementResolver } from "./placement.js";
import { createRecordingJournal } from "./recording.js";
import { collectReproducibilityMetadata } from "./reproducibility.js";
import { createRouteObserver, type RouteObserver } from "./route-observer.js";
import { createTargetBreaker, type TargetBreakerBlock } from "./target-breaker.js";
import type { RunStatus } from "./types.js";
import { spawnNativeWorker } from "./worker-spawn.js";
import { frozenProtectedArtifactState } from "./worker-spec.js";

export function createDispatchCore(context: DomainContext, options?: DispatchBundleOptions) {
	const maybeSafety = context.getContract("safety");
	const maybeAgents = context.getContract("agents");
	const maybeProviders = context.getContract("providers");
	const maybeMiddleware = context.getContract("middleware");
	const maybeScheduling = context.getContract("scheduling");
	const maybePrompts = context.getContract("prompts");
	if (!maybeSafety) throw new Error("dispatch domain requires 'safety' contract");
	if (!maybeAgents) throw new Error("dispatch domain requires 'agents' contract");
	if (!maybeProviders) throw new Error("dispatch domain requires 'providers' contract");
	if (!maybeMiddleware) throw new Error("dispatch domain requires 'middleware' contract");
	if (!maybeScheduling) throw new Error("dispatch domain requires 'scheduling' contract");
	if (!maybePrompts) throw new Error("dispatch domain requires 'prompts' contract");
	const safety: SafetyContract = maybeSafety;
	const agents: AgentsContract = maybeAgents;
	const providers: ProvidersContract = maybeProviders;
	const middleware: MiddlewareContract = maybeMiddleware;
	const scheduling: SchedulingContract = maybeScheduling;
	const prompts: PromptsContract = maybePrompts;
	// Main sessions claim their cache lanes in the admission store beside the workers' leases (M-11).
	useMainCacheLaneStore(mainCacheLaneStore);
	const config = context.getContract("config");
	const getEffectiveSettings = (): EffectiveSettings => options?.getSettings?.() ?? config?.get();
	/**
	 * Notices that are process facts, raised once however many dispatches meet them: the judge-withheld notice, each
	 * unhooked-runtime notice, and each stale peer-instructions notice. Keyed by kind and text.
	 */
	const onceNotices = new Set<string>();
	const firstNotice = (key: string): boolean => {
		if (onceNotices.has(key)) return false;
		onceNotices.add(key);
		return true;
	};
	// The settings with the operator's live level in place of the configured one,
	// for the autonomy reads alone: an ACP session's mode can differ from settings.
	// The live level is the dispatch ceiling. A dispatcher with no live source (a
	// headless fleet, bootstrap or wiki run) was never granted yolo, so it reads
	// default; settings.yaml alone never lifts a worker above its dispatcher.
	const withLiveAutonomy = <S extends EffectiveSettings | undefined | null>(settings: S): S => {
		const live = options?.operatorAutonomy?.() ?? "default";
		if (!settings || live === settings.safety.autonomy) return settings;
		return { ...settings, safety: { ...settings.safety, autonomy: live } } as S;
	};

	const getProtectedArtifactState = (): ProtectedArtifactState =>
		frozenProtectedArtifactState(options?.getProtectedArtifactState?.());
	// Optional: absent in minimal test bundles. Workers just get no project
	// message when the context domain is not loaded.
	const projectContext = context.getContract("context");
	const spawnWorker = options?.spawnWorker ?? spawnNativeWorker;
	const fleetRegistry = scheduling.fleet;
	const resolveNode =
		options?.resolveNode ??
		createFleetPlacementResolver({
			getSettings: getEffectiveSettings,
			getSessionId: options?.getSessionId,
			fleet: fleetRegistry,
		});
	const previewNode =
		options?.previewNode ??
		createFleetPlacementPreviewResolver({
			getSettings: getEffectiveSettings,
			getSessionId: options?.getSessionId,
			fleet: fleetRegistry,
		});
	const startAcpRun = options?.startAcpDelegationRun ?? startAcpDelegationRun;
	const collectReproducibility = options?.collectReproducibility ?? collectReproducibilityMetadata;
	const heartbeatSpec = options?.heartbeatSpec ?? DEFAULT_HEARTBEAT_SPEC;
	const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
	const getResilienceCooldownMs = (): number => {
		if (options?.resilienceCooldownMs !== undefined) return options.resilienceCooldownMs;
		const settingsVal = getEffectiveSettings()?.fleet?.retry.routeCooldownMs;
		if (settingsVal !== undefined && settingsVal >= 0) return settingsVal;
		return DEFAULT_RESILIENCE_COOLDOWN_MS;
	};
	const now = options?.now ?? (() => Date.now());
	const monotonicNow = options?.monotonicNow ?? (() => performance.now());
	const targetBreaker = createTargetBreaker({
		monotonicNow,
		cooldownMs: getResilienceCooldownMs,
		threshold: () => getEffectiveSettings()?.fleet?.retry.breakerThreshold ?? 1,
	});
	// Durable evidence owner used by shadow observation and active readiness.
	const routeObserver: RouteObserver = options?.routeObserver ?? createRouteObserver({});

	const assignments = new AssignmentRegistry({
		onStreamError: (error) => reportDispatchDiagnostic("assignment event stream", error),
	});

	function cooldownKey(targetId: string, runtimeId: string, wireModelId: string): string {
		return `${targetId}\0${runtimeId}\0${wireModelId}`;
	}

	function describeTargetBlock(targetId: string, block: TargetBreakerBlock | null): string | null {
		if (block === null) return null;
		if (block.kind === "probing") {
			return `target '${targetId}' is cooling down while one probe run tests it after ${block.reason}`;
		}
		return `target '${targetId}' is cooling down for ${Math.ceil(block.remainingMs / 1000)}s after ${block.reason}`;
	}

	/** Read-only cooldown view for route planning; it never claims a half-open probe. */
	function targetCooldownReason(targetId: string, runtimeId: string, wireModelId: string): string | null {
		return describeTargetBlock(targetId, targetBreaker.blocked(cooldownKey(targetId, runtimeId, wireModelId)));
	}

	/**
	 * Admission gate for a top-level run. A half-open route admits this run as
	 * its probe; the claim goes into probeClaims so a dispatch that fails before
	 * its run starts can hand the probe back.
	 */
	function assertTargetNotCoolingDown(
		req: DispatchRequest,
		targetId: string,
		runtimeId: string,
		wireModelId: string,
		probeClaims: ProbeClaim[],
	): void {
		if (req.lineage !== undefined) return;
		const key = cooldownKey(targetId, runtimeId, wireModelId);
		const owner = req.runIdHint;
		const block = owner === undefined ? targetBreaker.blocked(key) : targetBreaker.admit(key, owner);
		const reason = describeTargetBlock(targetId, block);
		if (reason !== null) throw new Error(`dispatch: ${reason}`);
		if (owner !== undefined) probeClaims.push({ key, owner });
	}

	function recordTargetOutcome(
		runId: string,
		targetId: string,
		runtimeId: string,
		wireModelId: string,
		status: RunStatus,
		exitCode: number,
		failureClass: FailureClass,
	): void {
		const outcome =
			status === "completed" && exitCode === 0 ? "success" : affectsTargetBreaker(failureClass) ? "failure" : "neutral";
		targetBreaker.record(cooldownKey(targetId, runtimeId, wireModelId), runId, outcome, failureClass);
	}

	const recordingJournal = createRecordingJournal();

	return {
		agents,
		assertTargetNotCoolingDown,
		assignments,
		collectReproducibility,
		config,
		cooldownKey,
		firstNotice,
		fleetRegistry,
		getEffectiveSettings,
		getProtectedArtifactState,
		heartbeatIntervalMs,
		heartbeatSpec,
		maybeAgents,
		middleware,
		monotonicNow,
		now,
		previewNode,
		projectContext,
		prompts,
		providers,
		recordTargetOutcome,
		recordingJournal,
		resolveNode,
		routeObserver,
		safety,
		scheduling,
		spawnWorker,
		startAcpRun,
		targetBreaker,
		targetCooldownReason,
		withLiveAutonomy,
	};
}

export type DispatchCore = ReturnType<typeof createDispatchCore>;

/**
 * What every dispatch machine is built over: the bundle's context and options, the core (contracts, clocks, the
 * resolved option seams, the target breaker), and a handle to each machine. A machine owns its own state and reads
 * another machine only through its handle, at call time, so a handle is bound before any of them runs.
 */
export interface DispatchRuntime {
	readonly context: DomainContext;
	readonly options: DispatchBundleOptions | undefined;
	core: DispatchCore;
	runs: ReturnType<typeof createRunTable>;
	grants: ReturnType<typeof createGrantDesk>;
	capacity: ReturnType<typeof createCapacityMachine>;
	budget: ReturnType<typeof createBudgetGate>;
	quota: ReturnType<typeof createQuotaPolling>;
	retry: ReturnType<typeof createRetryMachine>;
	retryRun: ReturnType<typeof createRetryRunner>;
	control: ReturnType<typeof createControlRoots>;
	heartbeat: ReturnType<typeof createHeartbeatWatch>;
	drain: ReturnType<typeof createDrainMachine>;
	recovery: ReturnType<typeof createStartupRecovery>;
	preview: ReturnType<typeof createRoutePreview>;
	route: ReturnType<typeof createRouteSelection>;
	lifecycle: ReturnType<typeof createLifecycleResolver>;
	request: ReturnType<typeof createDispatchRequests>;
	acp: ReturnType<typeof createAcpDelegation>;
	attempt: ReturnType<typeof createNativeAttempt>;
	host: ReturnType<typeof createDispatchHost>;
	contract: ReturnType<typeof createDispatchContractSurface>;
}
