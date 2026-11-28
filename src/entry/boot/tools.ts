// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { AcpElicitationChannel } from "../../acp/server-options.js";
import { type PancodeSettings, readSettings } from "../../core/config.js";
import type { DomainContractMap } from "../../core/domain-contracts.js";
import type { LoadResult } from "../../core/domain-loader.js";
import { readPancodeVersion } from "../../core/package-root.js";
import type { CatalogRanker } from "../../core/precomputed-rank.js";
import { protectedResidencyModels } from "../../core/residency-protection.js";
import { mainSandboxEnvPolicy } from "../../core/sandbox/env-scrub.js";
import { sessionTelemetryContext } from "../../core/telemetry/context.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { getTerminationCoordinator } from "../../core/termination.js";
import { pancodeDataDir } from "../../core/xdg.js";
import { renderAgentCatalogSectionsFromSpecs } from "../../domains/agents/catalog.js";
import type { AgentsContract } from "../../domains/agents/contract.js";
import type { ConfigContract } from "../../domains/config/contract.js";
import { createSessionRereadPort } from "../../domains/context/working-set/session-reread.js";
import type { DispatchContract } from "../../domains/dispatch/contract.js";
import { agentRoleFactsResolver } from "../../domains/dispatch/execution-role.js";
import {
	canonicalMemoryRepositoryIdentity,
	loadMemoryRecordsSync,
	type MemoryRuntime,
	seedTaskMemoryFromNewestHandoff,
	type TaskMemoryHandoffSnapshot,
	taskMemoryHandoffSeedOffer,
} from "../../domains/memory/index.js";
import { createMemoryPromptReader } from "../../domains/memory/prompt-cache.js";
import type { TaskMemoryBank } from "../../domains/memory/task-bank.js";
import type { CapabilityGate } from "../../domains/middleware/capability-gate.js";
import type { MuxContract } from "../../domains/mux/contract.js";
import type { PanesOperations } from "../../domains/mux/operations.js";
import { agentRoleToolWarnings } from "../../domains/providers/agent-role-warnings.js";
import type { ProvidersContract } from "../../domains/providers/index.js";
import type { ReportSessionFacts } from "../../domains/report/environment.js";
import type { IdentitySettings } from "../../domains/report/scrub.js";
import type { SafetyContract } from "../../domains/safety/contract.js";
import { type FlowRestrictionSet, mergeFlowRestrictions } from "../../domains/safety/index.js";
import type { SessionCodeConsent } from "../../domains/safety/session-code-consent.js";
import type { SessionContract } from "../../domains/session/contract.js";
import type { DecisionBoardStore } from "../../domains/session/decision-board.js";
import type { TaskBoardStore } from "../../domains/session/task-board.js";
import { latestUserImages } from "../../domains/session/vision-images.js";
import type { SystemOne } from "../../domains/system-one/types.js";
import type { TelemetryContract } from "../../domains/telemetry/contract.js";
import type { UserTasksStore } from "../../domains/user-tasks/store.js";
import type { setProtectedModelsProvider } from "../../engine/apis/residency.js";
import type {
	detectPlatformKeybindingWarnings,
	detectTerminalKeySupport,
	formatInvalidKeybindingNotice,
	formatPlatformKeybindingNotice,
	validateKeybindings,
} from "../../interactive/keybinding-manager.js";
import type { AutonomyLevel } from "../../lib/autonomy/autonomy.js";
import type { ChatLoop } from "../../session-control/chat-loop.js";
import type { AskUserHandler } from "../../tools/ask-user.js";
import { registerAllTools } from "../../tools/bootstrap.js";
import type { DispatchBackgroundRegistry } from "../../tools/dispatch-background.js";
import { dispatchSchemaCompositionFor } from "../../tools/dispatch-schema.js";
import type { ToolRegistry } from "../../tools/registry/contract.js";
import { createVisionSidecar } from "../../tools/vision-sidecar.js";
import type { BootOptions } from "../boot-options.js";
import type { ExtensionReloadCoordinator } from "../extension-reload.js";
import { admitHandoffSeedFlow, type createFlowLedger } from "../flow-ledger.js";
import { createJobHost } from "../job-host.js";
import type { createSessionSettingsView } from "../session-settings-view.js";

type SessionSettingsView = ReturnType<typeof createSessionSettingsView>;

/**
 * bootOrchestrator's lets and the names it declares after this stage, read and written live: a copy would miss
 * the later writes, and a name built later is read only once it exists.
 */
export interface BootToolsCells {
	readonly askUserHandler: AskUserHandler | null;
	readonly chat: ChatLoop;
	readonly deferredWatchdogNoticeSink: ((text: string) => void) | null;
	readonly reportReviewOpener: ((draftId: string) => void) | null;
}

/** What registerBootTools reads from the names bootOrchestrator built before it. */
export interface BootToolsInput {
	acpElicitationChannel: AcpElicitationChannel | undefined;
	acpInterviews: boolean;
	acpMode: boolean;
	agents: AgentsContract | undefined;
	askUserBridge: AskUserHandler;
	bootStderr: (text: string) => void;
	bus: TelemetryHub;
	capabilityGate: CapabilityGate;
	config: ConfigContract | undefined;
	createRoutedSession: SessionSettingsView["createRoutedSession"];
	decisionBoard: DecisionBoardStore;
	detectPlatformKeybindingWarnings: typeof detectPlatformKeybindingWarnings;
	detectTerminalKeySupport: typeof detectTerminalKeySupport;
	dispatch: DispatchContract;
	dispatchBackground: DispatchBackgroundRegistry;
	extensionReload: ExtensionReloadCoordinator;
	flowLedger: ReturnType<typeof createFlowLedger>;
	flowPort: {
		carried: () => FlowRestrictionSet | null;
		refusal: () => string | null;
		absorb: (set: FlowRestrictionSet, origin: { tool?: string; toolCallId?: string }) => void;
	};
	formatInvalidKeybindingNotice: typeof formatInvalidKeybindingNotice;
	formatPlatformKeybindingNotice: typeof formatPlatformKeybindingNotice;
	getCurrentSettings: SessionSettingsView["getCurrentSettings"];
	initialNotices: string[];
	interactive: boolean;
	memoryEnabledNow: () => boolean;
	memoryOwner: MemoryRuntime;
	memoryWorkspaceRoot: () => string;
	mux: MuxContract | undefined;
	options: BootOptions;
	panes: PanesOperations | null;
	persistSavedMutation: SessionSettingsView["persistSavedMutation"];
	providers: ProvidersContract;
	reportSession: {
		stateDir: string;
		cwd: () => string;
		session: () => { id: string; cwd: string; facts: ReportSessionFacts } | null;
		identitySettings: () => IdentitySettings;
	};
	resolveAdmissionAutonomy: () => AutonomyLevel;
	resolvedSettings: Readonly<PancodeSettings>;
	resolveEffectiveAutonomy: () => AutonomyLevel;
	restoreResumedRoute: SessionSettingsView["restoreResumedRoute"];
	result: LoadResult<DomainContractMap>;
	resumedSessionAtBoot: boolean;
	routeProvenance: SessionSettingsView["routeProvenance"];
	safety: SafetyContract;
	session: SessionContract | undefined;
	sessionCodeConsent: SessionCodeConsent;
	setProtectedModelsProvider: typeof setProtectedModelsProvider;
	systemOne: SystemOne;
	taskBoard: TaskBoardStore;
	taskMemoryBank: TaskMemoryBank;
	telemetry: TelemetryContract;
	termination: ReturnType<typeof getTerminationCoordinator>;
	toolRegistry: ToolRegistry;
	userTasks: UserTasksStore;
	validateKeybindings: typeof validateKeybindings;
	cells: BootToolsCells;
}

/**
 * Stage P10b: the memory prompt reader, catalog ranker, vision sidecar and job host, every tool registered over them,
 * then the task-memory handoff seed, the protected-model and keybinding notices, and a resumed headless route.
 */
export function registerBootTools(input: BootToolsInput) {
	const {
		acpElicitationChannel,
		acpInterviews,
		acpMode,
		agents,
		askUserBridge,
		bootStderr,
		bus,
		capabilityGate,
		config,
		createRoutedSession,
		decisionBoard,
		detectPlatformKeybindingWarnings,
		detectTerminalKeySupport,
		dispatch,
		dispatchBackground,
		extensionReload,
		flowLedger,
		flowPort,
		formatInvalidKeybindingNotice,
		formatPlatformKeybindingNotice,
		getCurrentSettings,
		initialNotices,
		interactive,
		memoryEnabledNow,
		memoryOwner,
		memoryWorkspaceRoot,
		mux,
		options,
		panes,
		persistSavedMutation,
		providers,
		reportSession,
		resolveAdmissionAutonomy,
		resolvedSettings,
		resolveEffectiveAutonomy,
		restoreResumedRoute,
		result,
		resumedSessionAtBoot,
		routeProvenance,
		safety,
		session,
		sessionCodeConsent,
		setProtectedModelsProvider,
		systemOne,
		taskBoard,
		taskMemoryBank,
		telemetry,
		termination,
		toolRegistry,
		userTasks,
		validateKeybindings,
	} = input;
	const { cells } = input;
	let lastMemoryPromptRuntimeId: string | undefined;
	const memoryReader = createMemoryPromptReader({
		getDataDir: pancodeDataDir,
		onSelection: (selection) => memoryOwner.recordPromptSelection(selection),
		relevanceGate: { demoted: () => memoryOwner.delivery.demoted() },
		delivery: memoryOwner.delivery,
	});
	// The turn's own words, for a listing asked for without a query and for triage.
	let operatorTask = "";
	// The session's lexical capability gate orders a listing the model asked for. It never shortens one.
	const catalogRanker =
		(kind: "skills" | "capabilities"): CatalogRanker =>
		(request) => {
			const ranked = capabilityGate.rank({
				kind,
				task: request.need || operatorTask,
				candidates: request.candidates.map((candidate) => ({ id: candidate.id, description: candidate.summary })),
				limit: 10,
			});
			return ranked.length > 0
				? { scores: Object.fromEntries(ranked.map((hit) => [hit.id, hit.score])), source: "capability gate" }
				: null;
		};
	const visionSidecar = createVisionSidecar({ getSettings: () => getCurrentSettings(), providers, telemetry, session });
	const jobHost = createJobHost({
		registry: toolRegistry,
		bus,
		...(session ? { session } : {}),
		telemetry: () => telemetry?.read?.live() ?? null,
		cwd: process.cwd(),
		attended: options.headless === undefined,
		safety,
		autonomy: resolveEffectiveAutonomy,
		admissionAutonomy: resolveAdmissionAutonomy,
		sandboxEnv: () => mainSandboxEnvPolicy(getCurrentSettings()),
		confine: () => getCurrentSettings().safety.confine,
		sessionCodeConsentPending: () => sessionCodeConsent.pending(),
		untilStoppedDefault: () => getCurrentSettings().chat.loopsUntilStopped,
		createSession: createRoutedSession,
		mcpEvents: () => toolBootstrap.mcpCapabilities ?? null,
		notice: (text) => {
			(cells.deferredWatchdogNoticeSink ?? ((msg: string) => bootStderr(`${msg}\n`)))(text);
		},
	});
	const toolBootstrap = registerAllTools(toolRegistry, {
		jobTool: jobHost.tool,
		jobs: jobHost.operations,
		flow: flowPort,
		...(resolvedSettings.fleet.profiles.vision?.target
			? {
					visionSidecar,
					getRecentVisionImages: () => {
						const meta = session?.current();
						if (!session || !meta) return [];
						const leaf = session?.leafId(meta.id) ?? undefined;
						return latestUserImages(session.readEntries(), leaf);
					},
				}
			: {}),
		// Discovery shares the pre-turn gate; optional calibrated rankings arrive from its nonblocking cache.
		rankSkills: catalogRanker("skills"),
		rankCapabilities: catalogRanker("capabilities"),
		onSkillLoaded: (name) => capabilityGate.used("skills", name),
		onCapabilityCalled: (name) => capabilityGate.used("capabilities", name),
		// consult exists only when a route is named at startup, so an operator who
		// never named one keeps the registry, tool signature and prompt they had. A
		// route removed mid-session answers "no usable answer". bound() reads the
		// effective settings view built earlier by buildBootSettings.
		...(systemOne.bound()
			? {
					consult: {
						systemOne,
						cwd: () => process.cwd(),
						// The evidence files consult reads itself never pass a read tool, so
						// they are labeled here before the request; the runner's flow check
						// then judges the labels. A throw makes consult send nothing.
						flowFor: (files) => {
							// Neither an unusable policy nor an unusable ledger may let evidence leave.
							const refusal = flowLedger.policy().refusal ?? flowLedger.refusal();
							if (refusal !== null) throw new Error(refusal);
							const labels = flowLedger.labelPaths(files, process.cwd(), "consult");
							const unlabeled = labels === null ? null : flowLedger.refusal();
							if (unlabeled !== null) throw new Error(unlabeled);
							return mergeFlowRestrictions(labels, flowLedger.current());
						},
					},
				}
			: {}),
		getContextBudget: () => cells.chat.inspectLiveBudget(),
		...(dispatch?.budgetEconomics ? { getBudgetEconomics: dispatch.budgetEconomics } : {}),
		requestSelfCompact: (note, toolCallId, signal) => cells.chat.requestSelfCompact(note, toolCallId, signal),
		// Read-only recall over the stores the main prompt draws from, under the
		// same repository and runtime gates; the agent scope stays with workers.
		memoryRecall: {
			enabled: memoryEnabledNow,
			onRecall: (ids) => memoryOwner.recordRecall(ids),
			bank: () => taskMemoryBank.snapshot(),
			records: () => loadMemoryRecordsSync(pancodeDataDir()),
			eligibility: () => {
				// The session header keeps the target the session was created with;
				// routing changed in the TUI or over ACP only appends ledger entries.
				// The prompt path reports the runtime it actually compiled for.
				const settingsTarget = getCurrentSettings().chat.target;
				const runtimeId =
					lastMemoryPromptRuntimeId ?? (settingsTarget ? providers.getTarget(settingsTarget)?.runtime : undefined);
				return {
					// The session's workspace, which a GUI or resumed session need not share with the process.
					activeRepository: canonicalMemoryRepositoryIdentity(memoryWorkspaceRoot()),
					activeRuntime: runtimeId === undefined ? null : { kind: "runtime", key: runtimeId },
					activeAgent: null,
				};
			},
		},
		...memoryOwner.noteTool(),
		getSettings: () => getCurrentSettings(),
		getRouteProvenance: routeProvenance,
		termination,
		captureWorkerContext: () => cells.chat.captureWorkerContext?.() ?? null,
		...(session
			? {
					session,
					readSessionEntries: () => {
						const meta = session.current();
						return meta ? session.readEntries() : [];
					},
					onContextRecalled: (payload) =>
						bus.emit("context.recalled", payload, sessionTelemetryContext(session.current()?.id)),
					readRecall: createSessionRereadPort(session, bus),
				}
			: {}),
		taskBoard,
		decisionBoard,
		getDecisionBoard: () => decisionBoard.snapshot(),
		userTasks,
		dispatch,
		bus,
		...(interactive || acpInterviews || options.headless?.answers ? { askUser: askUserBridge } : {}),
		...(interactive
			? { mcpElicitation: "ask_user" as const }
			: acpElicitationChannel
				? { mcpElicitation: acpElicitationChannel.elicit }
				: {}),
		// R-12: the agent drafts or offers a PanCode report; the host keeps the budget and never sends.
		report: {
			...reportSession,
			version: readPancodeVersion(),
			surface: interactive ? "tui" : acpMode ? "acp" : "headless",
			offers: () => getCurrentSettings().report?.offers ?? "ask",
			writeOffersOff: () =>
				persistSavedMutation((settings) => {
					settings.report = { ...settings.report, offers: "off" };
				}, "settings-ui"),
			...(interactive || acpInterviews ? { askUser: askUserBridge } : {}),
			attended: () => cells.askUserHandler !== null,
			openReview: () => cells.reportReviewOpener,
		},
		...(agents ? { getAgentCatalog: () => renderAgentCatalogSectionsFromSpecs(agents.listSpecs()).stable } : {}),
		...(agents ? { getAgentSpecs: () => agents.listSpecs() } : {}),
		...(agents ? { getAgentRoleFacts: agentRoleFactsResolver((id: string) => agents.getSpec(id)) } : {}),
		// ask_user, configure_pancode and dispatch read the operator's level, so
		// either yolo runs a dispatch plan without the plan stop; steer reads the
		// level admission runs at, so the main agent's grants to workers agree
		// with the approval surface (contained yolo reads as default there).
		getAutonomy: resolveEffectiveAutonomy,
		getAdmissionAutonomy: resolveAdmissionAutonomy,
		...(interactive ? { dispatchBackground } : {}),
		...(mux ? { competeMuxWorktrees: mux } : {}),
		// Registered only when a pane host answered detection, so the tool is
		// absent from the prompt on a machine with none rather than present and
		// always refusing.
		...(panes && mux?.mode !== "none" ? { panes } : {}),
		getCostCeilingUsd: () => result.getContract("scheduling")?.ceilingUsd() ?? 0,
		...(config ? { getWorkerRosters: () => config.get().fleet.rosters } : {}),
		...(config ? { getDispatchSchemaComposition: () => dispatchSchemaCompositionFor(config.get().fleet) } : {}),
		getSkillLoaderOptions: () => ({
			trustProjectCompatRoots: config?.get().integrations.projectResources.trustProjectImports === true,
			disableDiscovery: options.noSkills === true || options.headless?.noSkills === true,
			...(options.skillPaths && options.skillPaths.length > 0
				? { explicitSkillPaths: options.skillPaths }
				: options.headless?.skillPaths && options.headless.skillPaths.length > 0
					? { explicitSkillPaths: options.headless.skillPaths }
					: {}),
		}),
	});
	// Runtime tools are served after the core and command tools hold their
	// names; the gateway keeps the provider schema set unchanged as each
	// generation swaps them.
	extensionReload.attachRuntimeTools(toolRegistry);

	const getTaskMemorySeedOffer = (): { source: string; count: number } | null => {
		return taskMemoryHandoffSeedOffer(process.cwd(), getCurrentSettings().context.memory.enabled);
	};
	const admitHandoffSeed = (snapshot: TaskMemoryHandoffSnapshot) =>
		admitHandoffSeedFlow(
			{
				ledger: flowLedger,
				ensureSession: () => {
					if (!session || session.current()) return;
					createRoutedSession();
					taskBoard.snapshot();
				},
				hasSourceRules: flowLedger.hasSourceRules,
			},
			snapshot.source.sessionId,
		);
	const seedCurrentTaskMemoryFromHandoff = () => {
		return seedTaskMemoryFromNewestHandoff(
			taskMemoryBank,
			process.cwd(),
			getCurrentSettings().context.memory.enabled,
			admitHandoffSeed,
		);
	};
	if (resumedSessionAtBoot) {
		const offer = getTaskMemorySeedOffer();
		if (offer && offer.count > 0) {
			initialNotices.push(
				`task memory: ${offer.count} handoff entr${offer.count === 1 ? "y" : "ies"} available from ${offer.source}; run /memory seed to import`,
			);
		}
	}
	for (const warning of agentRoleToolWarnings(providers, getCurrentSettings())) {
		if (interactive) initialNotices.push(warning);
		else process.stderr.write(`${warning}\n`);
	}
	// Residency protection follows the live effective settings: the models the
	// operator's config references (orchestrator, worker default/profiles,
	// target defaults) may never be evicted by another PanCode stream, and a
	// routing change updates the set on the next read.
	setProtectedModelsProvider(() => protectedResidencyModels(getCurrentSettings()));

	const validatedKeybindings = validateKeybindings((config?.get() ?? readSettings()).interface.keybindings ?? {});
	const invalidBindings = validatedKeybindings.invalid;
	if (invalidBindings.length > 0) {
		const notice = formatInvalidKeybindingNotice(invalidBindings);
		if (interactive) initialNotices.push(notice);
		else process.stderr.write(notice);
	}
	const platformWarnings = process.stdin.isTTY
		? detectPlatformKeybindingWarnings(validatedKeybindings.valid, detectTerminalKeySupport(process.env))
		: [];
	if (platformWarnings.length > 0) {
		const notice = formatPlatformKeybindingNotice(platformWarnings);
		if (interactive) initialNotices.push(notice);
		else process.stderr.write(notice);
	}
	// A headless `--session`/`--continue` resumed before the route was seeded;
	// restore it now, letting an explicit --target/--model/--thinking win.
	if (resumedSessionAtBoot) {
		const notice = restoreResumedRoute({
			route: options.headless?.target !== undefined || options.headless?.model !== undefined,
			thinking: options.headless?.thinking !== undefined,
		});
		if (notice !== null) bootStderr(`PanCode: ${notice}\n`);
	}
	return {
		getTaskMemorySeedOffer,
		jobHost,
		memoryReader,
		seedCurrentTaskMemoryFromHandoff,
		toolBootstrap,
		visionSidecar,
		toolState: {
			get lastMemoryPromptRuntimeId() {
				return lastMemoryPromptRuntimeId;
			},
			set lastMemoryPromptRuntimeId(value: typeof lastMemoryPromptRuntimeId) {
				lastMemoryPromptRuntimeId = value;
			},
			get operatorTask() {
				return operatorTask;
			},
			set operatorTask(value: typeof operatorTask) {
				operatorTask = value;
			},
		},
	};
}
