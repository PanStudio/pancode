// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { createAcpElicitationChannel, createAcpInterviewChannel } from "../../acp/host-members.js";
import type { PancodeSettings } from "../../core/config.js";
import type { OutputStyle } from "../../core/defaults.js";
import { type LoadResult, loadDomains } from "../../core/domain-loader.js";
import type { StartupTimer } from "../../core/startup-timer.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import { type getTerminationCoordinator, resolveShutdownHookBudgetMs } from "../../core/termination.js";
import { createAgentsDomainModule } from "../../domains/agents/module.js";
import { ConfigDomainModule, createConfigDomainModule } from "../../domains/config/module.js";
import { createContextDomainModule } from "../../domains/context/module.js";
import type { WorktreeBootRecovery } from "../../domains/dispatch/boot-recovery.js";
import { createDispatchDomainModule } from "../../domains/dispatch/module.js";
import { ExtensionsDomainModule } from "../../domains/extensions/module.js";
import { InteropDomainModule } from "../../domains/interop/module.js";
import { withDispatchMemory } from "../../domains/memory/dispatch-section.js";
import { MemoryRuntime } from "../../domains/memory/index.js";
import type { CapabilityGate } from "../../domains/middleware/capability-gate.js";
import { createMiddlewareDomain } from "../../domains/middleware/module.js";
import { PluginsDomainModule } from "../../domains/plugins/module.js";
import { createPromptsDomainModule } from "../../domains/prompts/module.js";
import { createProvidersDomainModule } from "../../domains/providers/module.js";
import { createResourcesDomainModule } from "../../domains/resources/module.js";
import { loadSkills } from "../../domains/resources/skills/loader.js";
import type { SafetyContract } from "../../domains/safety/contract.js";
import type { GitHookDriftGuard } from "../../domains/safety/hook-drift.js";
import { EMPTY_INFORMATION_FLOW_POLICY, type FlowRestrictionSet } from "../../domains/safety/index.js";
import { workerFlowPolicyInput } from "../../domains/safety/information-flow.js";
import { SafetyDomainModule } from "../../domains/safety/module.js";
import type { ProtectedArtifactState } from "../../domains/safety/protected-artifacts.js";
import type { SafetyJudgeSeat } from "../../domains/safety/safety-judge.js";
import { unattendedWindowMs } from "../../domains/safety/unattended.js";
import { createSchedulingDomainModule } from "../../domains/scheduling/module.js";
import { SessionDomainModule } from "../../domains/session/module.js";
import { createTelemetryDomain } from "../../domains/telemetry/module.js";
import type { AutonomyLevel } from "../../lib/autonomy/autonomy.js";
import type { BUILTIN_SLASH_COMMANDS } from "../../session-control/slash-commands.js";
import type { AskUserHandler } from "../../tools/ask-user.js";
import type { BootOptions } from "../boot-options.js";
import { resolvePanesEnablement } from "../panes-activation.js";
import { retentionPruners } from "../retention-pruners.js";

/**
 * bootOrchestrator's lets and the names it declares after this stage, read and written live: a copy would miss
 * the later writes, and a name built later is read only once it exists.
 */
export interface BootDomainsCells {
	readonly askUserBridge: AskUserHandler;
	readonly effectiveSettingsForDispatch: (() => Readonly<PancodeSettings>) | null;
	readonly flowRestrictionsForDispatch: (() => FlowRestrictionSet | null) | null;
	readonly getCurrentSettings: () => PancodeSettings;
	readonly protectedArtifactStateForDispatch: (() => ProtectedArtifactState) | null;
	readonly registryState: {
		askUserHandler: AskUserHandler | null;
		reportReviewOpener: ((draftId: string) => void) | null;
	};
	readonly safety: SafetyContract | undefined;
	readonly sessionOriginForDispatch:
		| (() => { id: string; cwdHash: string; parentSessionId?: string | null } | null)
		| null;
	readonly workerAskJudgeForDispatch: {
		seat: () => SafetyJudgeSeat;
		autonomy: () => AutonomyLevel;
		operatorAutonomy: () => AutonomyLevel;
		hookDrift: () => GitHookDriftGuard;
	} | null;
}

/** What loadBootDomains reads from the names bootOrchestrator built before it. */
export interface BootDomainsInput {
	bootPhaseBoundary: (() => Promise<void>) | undefined;
	bootStderr: (text: string) => void;
	BUILTIN_SLASH_COMMANDS: typeof BUILTIN_SLASH_COMMANDS;
	bus: TelemetryHub;
	capabilityGate: CapabilityGate;
	createAcpElicitationChannel: typeof createAcpElicitationChannel;
	createAcpInterviewChannel: typeof createAcpInterviewChannel;
	options: BootOptions;
	termination: ReturnType<typeof getTerminationCoordinator>;
	timer: StartupTimer;
	worktreeRecovery: WorktreeBootRecovery;
	cells: BootDomainsCells;
}

/**
 * Stage P1: the ACP handshake channels, the panes rung, the memory runtime and the owned middleware and telemetry
 * domains, the domain load itself, and the dispatch contract with its shutdown and persist hooks.
 */
export async function loadBootDomains(input: BootDomainsInput) {
	const {
		bootPhaseBoundary,
		bootStderr,
		BUILTIN_SLASH_COMMANDS,
		bus,
		capabilityGate,
		createAcpElicitationChannel,
		createAcpInterviewChannel,
		options,
		termination,
		timer,
		worktreeRecovery,
	} = input;
	const { cells } = input;
	// Panes are an interactive-surface projection. Headless, ACP, and worker boots
	// gate detection off so they never resolve a socket path or open a descriptor.
	// This mirrors the `interactive` predicate computed after the domains load.
	const muxInteractive = !options.headless && options.acp === undefined && process.env.PANCODE_INTERACTIVE === "1";
	// An ACP client counts as attended only when it advertised so at initialize.
	// The deferred front answers initialize before this boot, so the handshake is
	// already settled here; a plain client advertises nothing and keeps the
	// unattended behavior (no ask_user, no merge card, worker asks denied at once).
	const acpHandshake = options.acp?.handshake;
	const acpInterviews = acpHandshake?.initialized === true && acpHandshake.interviewsEnabled;
	const acpWorkerPermissions = acpHandshake?.initialized === true && acpHandshake.workerPermissionsEnabled;
	const acpElicitationChannel =
		acpHandshake?.initialized === true && acpHandshake.elicitationEnabled ? createAcpElicitationChannel() : undefined;
	const acpInterviewChannel = acpInterviews
		? createAcpInterviewChannel({
				unattendedWindowMs: () => unattendedWindowMs(cells.getCurrentSettings().safety.unattendedAfterMs),
			})
		: undefined;
	// The rung is settled once, before the config contract loads, off the
	// `--with-panes` flag and whether this process runs in a pane host. An
	// inactive rung loads nothing: the whole extension, mux domain included,
	// lives behind the dynamic import below.
	const muxEnablement = resolvePanesEnablement(options.panes);
	const withPanes = muxInteractive && muxEnablement !== "off" ? await import("../with-panes.js") : null;
	// Session-only output style toggles, reported to PanCode's pane host so its chrome follows.
	const outputStyleListeners = new Set<(style: OutputStyle) => void>();

	// Assigned once the extension reload coordinator exists, after the domains
	// load; a worker dispatched before that carries no extension hooks.
	let workerHookSource: import("../extension-reload.js").ExtensionReloadCoordinator["workerHooks"] | null = null;
	const memoryOwner = new MemoryRuntime();
	// The loader publishes only the query contract; this root keeps the right to register hooks.
	const middlewareDomain = createMiddlewareDomain();
	const telemetryDomain = createTelemetryDomain({ retention: retentionPruners });
	// Annotated: the module options close over contracts read from this result.
	const result: LoadResult = await loadDomains(
		[
			options.startupSettings
				? createConfigDomainModule(options.startupSettings, { holdReloads: bootPhaseBoundary !== undefined })
				: ConfigDomainModule,
			ExtensionsDomainModule,
			PluginsDomainModule,
			InteropDomainModule,
			createResourcesDomainModule({
				reservedPromptNames: new Set(BUILTIN_SLASH_COMMANDS.map((entry) => entry.name)),
				skills: () => ({
					disableDiscovery: options.noSkills === true || options.headless?.noSkills === true,
					...(options.skillPaths && options.skillPaths.length > 0
						? { explicitSkillPaths: options.skillPaths }
						: options.headless?.skillPaths && options.headless.skillPaths.length > 0
							? { explicitSkillPaths: options.headless.skillPaths }
							: {}),
				}),
			}),
			createContextDomainModule({
				noContextFiles: options.noContextFiles === true,
				startupHintHost: {
					// ACP advertises `context`, so clients can send the same slash form as the TUI.
					initCommand: options.headless ? "pancode context init" : "/context init",
					// Scripted runs keep suggestions off stderr; malformed-file warnings still flow.
					suggest: options.headless === undefined || (options.headless.mode !== "json" && process.stderr.isTTY === true),
					// TUI and ACP consume the stored hints on their own notice surfaces.
					...(options.acp === undefined && !muxInteractive ? { sink: (hint) => bootStderr(`pancode: ${hint.text}\n`) } : {}),
				},
			}),
			// Live probes exercise this session's chat model once the effective view
			// exists (wired in orchestrator.ts alongside dispatch); until then, the shared snapshot.
			createProvidersDomainModule({ getSettings: () => cells.effectiveSettingsForDispatch?.() }),
			SafetyDomainModule,
			createPromptsDomainModule({
				noContextFiles: options.noContextFiles === true,
				noSkills: options.noSkills === true || options.headless?.noSkills === true,
			}),
			createAgentsDomainModule({ loadSkills }),
			middlewareDomain.module,
			{
				manifest: { name: "memory", dependsOn: [] },
				createExtension: () => ({
					contract: memoryOwner.contract,
					extension: { start: () => {}, stop: () => memoryOwner.dispose() },
				}),
			},
			SessionDomainModule,
			telemetryDomain.module,
			// Budget alerts and the plan baseline read the ceiling through the
			// session's effective view, where `--max-cost-usd` sets it.
			createSchedulingDomainModule({ getSettings: () => cells.effectiveSettingsForDispatch?.() }),
			...(withPanes
				? [
						withPanes.createMuxDomainModule({
							enabled: muxEnablement,
							log: (level, message) => {
								if (level === "warning") bootStderr(`[mux] ${message}\n`);
							},
							onSessionOutputStyle: (listener) => outputStyleListeners.add(listener),
						}),
					]
				: []),
			// Dispatch resolves worker targets through the session's effective
			// settings view once it exists (wired in orchestrator.ts after the config
			// contract loads); until then it falls back to the shared snapshot.
			createDispatchDomainModule({
				getCapabilityGate: () => capabilityGate,
				budgetWaitForRaise: !options.headless && !options.acp,
				// Only an operator surface answers worker escalations (F9): the TUI
				// overlay, or an ACP client that advertised it forwards them to a person.
				workerPermissionResponder: !options.headless && (!options.acp || acpWorkerPermissions),
				// A headless steer channel reaches the main session only.
				workerSteering: !options.headless,
				// Under fleet.permissions.mode=judge the main session's safety judge
				// reviews native workers' ordinary asks in this process.
				operatorAutonomy: () => cells.workerAskJudgeForDispatch?.operatorAutonomy(),
				workerAskJudge: {
					seat: () => cells.workerAskJudgeForDispatch?.seat(),
					autonomy: () => cells.workerAskJudgeForDispatch?.autonomy() ?? "default",
					hookDrift: () => cells.workerAskJudgeForDispatch?.hookDrift(),
				},
				// The merge card rides the same attended gate, and asks through
				// whichever ask_user handler the TUI or the ACP client has by then.
				...(!options.headless && (!options.acp || acpInterviews)
					? {
							operatorAsk: {
								available: () => cells.registryState.askUserHandler !== null,
								ask: (q, o) => cells.askUserBridge(q, o),
							},
						}
					: {}),
				getSettings: () => cells.effectiveSettingsForDispatch?.(),
				// A native worker's tool calls reach this session's extension hooks.
				workerHooks: {
					declarations: () => workerHookSource?.declarations() ?? [],
					dropped: () => workerHookSource?.dropped() ?? [],
					evaluate: async (request, run) => (await workerHookSource?.evaluate(request, run)) ?? [],
					notify: (message) => workerHookSource?.notify(message),
				},
				getProtectedArtifactState: () => cells.protectedArtifactStateForDispatch?.() ?? { artifacts: [] },
				getFlowRestrictions: () => cells.flowRestrictionsForDispatch?.() ?? null,
				getFlowPolicy: () =>
					workerFlowPolicyInput(cells.safety?.policy?.informationFlow?.() ?? EMPTY_INFORMATION_FLOW_POLICY),
				// Stamps every run with the session that dispatched it, which is what
				// keeps a sibling PanCode process's runs and batches out of this one.
				getSessionId: () => cells.sessionOriginForDispatch?.()?.id ?? null,
				getSessionParentId: () => cells.sessionOriginForDispatch?.()?.parentSessionId ?? null,
				getSessionOrigin: () => cells.sessionOriginForDispatch?.() ?? null,
				// The domain owns the durable journal here, not the dispatch
				// tool's event registry: `/run`, a watchdog run, and a model
				// dispatch all have to leave the same transcript behind, and only
				// the last of the three ever reaches that registry.
				journalRunEvents: true,
				bootRecovery: worktreeRecovery,
			}),
		],
		{ diagnostic: bootStderr, ...(bootPhaseBoundary ? { beforeEach: bootPhaseBoundary } : {}) },
	);
	timer.mark(`domains loaded (${result.loaded.length})`);

	const dispatch = withDispatchMemory(result.getContract("dispatch"), () => cells.effectiveSettingsForDispatch?.());
	let unsubscribeDispatchShutdown: (() => void) | undefined;
	if (dispatch) {
		let dispatchDrain: Promise<void> | undefined;
		const beginDispatchDrain = (): Promise<void> => (dispatchDrain ??= dispatch.drain());
		unsubscribeDispatchShutdown = bus.subscribe("shutdown.requested", () => {
			// Admission closes before sequential drain hooks can wait on another resource.
			void beginDispatchDrain().catch(() => {
				// The awaited drain hook reports this same rejection.
			});
		});
		termination.onDrain(
			async () => {
				unsubscribeDispatchShutdown?.();
				await beginDispatchDrain();
			},
			{
				timeoutMs: Math.min(2 ** 31 - 1, (dispatch.drainAllowanceMs?.() ?? 0) + resolveShutdownHookBudgetMs()),
			},
		);
	}
	// The loader caps each domain separately. The outer hook must allow the
	// whole sequence to finish, including cleanup after a timed-out domain and
	// the dispatch stop's own allowance for its async durable writes (#428).
	termination.onPersist(
		(signal) => {
			// The coordinator's status is set before any hook runs (130 on SIGINT, 143 on SIGTERM); process.exited
			// records it (#434).
			result.getContract("telemetry")?.setExitStatus?.(termination.getExitCode());
			return result.stop(signal);
		},
		{
			timeoutMs: Math.min(
				2 ** 31 - 1,
				(result.loaded.length + 1) * resolveShutdownHookBudgetMs() + (dispatch?.drainAllowanceMs?.() ?? 0),
			),
		},
	);
	return {
		acpElicitationChannel,
		acpInterviewChannel,
		acpInterviews,
		acpWorkerPermissions,
		dispatch,
		memoryOwner,
		middlewareDomain,
		outputStyleListeners,
		result,
		telemetryDomain,
		withPanes,
		domainsState: {
			get unsubscribeDispatchShutdown() {
				return unsubscribeDispatchShutdown;
			},
			get workerHookSource() {
				return workerHookSource;
			},
			set workerHookSource(value: typeof workerHookSource) {
				workerHookSource = value;
			},
		},
	};
}
