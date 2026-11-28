// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type * as AcpCommandsModule from "../../acp/commands.js";
import type { AcpHostReport } from "../../acp/commands.js";
import type {
	bindBoardActions,
	createHostToolEvents,
	followWorkerRuns,
	oracleBriefingFromEntries,
	runHostDispatch,
} from "../../acp/host-members.js";
import type * as AcpServerModule from "../../acp/server.js";
import type { AcpElicitationChannel, AcpHandoffControl, AcpInterviewChannel } from "../../acp/server-options.js";
import type { createStdioServerTransport } from "../../acp/transport.js";
import type { RunJsonMainSessionFrame } from "../../cli/modes/run-json-schema.js";
import type { PancodeSettings } from "../../core/config.js";
import type { DomainContractMap } from "../../core/domain-contracts.js";
import type { LoadResult } from "../../core/domain-loader.js";
import type { SessionOverrides } from "../../core/session-routing.js";
import type { StartupTimer } from "../../core/startup-timer.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { getTerminationCoordinator } from "../../core/termination.js";
import type { AgentsContract } from "../../domains/agents/contract.js";
import type { ConfigContract } from "../../domains/config/contract.js";
import type { RunBootstrapResult } from "../../domains/context/bootstrap-types.js";
import type { ContextContract } from "../../domains/context/contract.js";
import type { WorktreeBootRecovery } from "../../domains/dispatch/boot-recovery.js";
import type { DispatchContract } from "../../domains/dispatch/contract.js";
import type { ExtensionsContract } from "../../domains/extensions/contract.js";
import type { ExtensionRuntimeHookBridge } from "../../domains/extensions/runtime-hook-bridge.js";
import type { InteropContract } from "../../domains/interop/contract.js";
import type { GuardianStatePublisher } from "../../domains/memory/guardian-state.js";
import type { MemoryRuntime } from "../../domains/memory/index.js";
import type { MemoryInterventionRegistration } from "../../domains/memory/intervention/types.js";
import type { TaskMemoryBank } from "../../domains/memory/task-bank.js";
import type { TaskMemoryHandoffSeedOutcome } from "../../domains/memory/task-memory-handoff.js";
import type { HistoryReviewActivity } from "../../domains/memory/task-memory-status.js";
import type { MuxContract } from "../../domains/mux/contract.js";
import type { PanesOperations } from "../../domains/mux/operations.js";
import type { PluginSnapshot } from "../../domains/plugins/types.js";
import type { ProvidersContract } from "../../domains/providers/index.js";
import type { ReportSessionFacts } from "../../domains/report/environment.js";
import type { IdentitySettings } from "../../domains/report/scrub.js";
import type { ResourcesContract } from "../../domains/resources/contract.js";
import type { McpSubmitReader } from "../../domains/resources/submit-expansion.js";
import type { AutonomyHalt, AutonomyWindow } from "../../domains/safety/autonomy-window.js";
import type { GitHookDriftGuard } from "../../domains/safety/hook-drift.js";
import type { SessionContract, SessionMeta } from "../../domains/session/contract.js";
import type { DecisionBoardStore } from "../../domains/session/decision-board.js";
import type { SessionEntry } from "../../domains/session/entries.js";
import type { HandoffServiceDeps } from "../../domains/session/handoff-service.js";
import type { TaskBoardStore } from "../../domains/session/task-board.js";
import type { SystemOne } from "../../domains/system-one/types.js";
import type { TelemetryContract, TelemetryRunReaderBinder } from "../../domains/telemetry/contract.js";
import type { UserTasksStore } from "../../domains/user-tasks/store.js";
import type { releasePancodeLoadedModelsOnExit } from "../../engine/apis/residency.js";
import type * as InteractiveIndexModule from "../../interactive/index.js";
import type { BootInteractivity } from "../../interactive/terminal-lease.js";
import type { AutonomyLevel } from "../../lib/autonomy/autonomy.js";
import type { ChatLoop } from "../../session-control/chat-loop.js";
import type { answerExtensionLine, resolvePermission } from "../../session-control/index.js";
import type { subscribeLoopGuardStop } from "../../session-control/loop-guard-interrupt.js";
import type {
	buildModelReplayAgentMessagesFromTurns,
	continuityContextFromSession,
} from "../../session-control/model-session-replay.js";
import type { ReloadClassesController } from "../../session-control/reload-report.js";
import type { RunIo } from "../../session-control/slash-command-types.js";
import type { parseSlashCommand } from "../../session-control/slash-commands.js";
import type { AskUserHandler } from "../../tools/ask-user.js";
import type { ToolBootstrapHandle } from "../../tools/bootstrap.js";
import type { DispatchBackgroundRegistry } from "../../tools/dispatch-background.js";
import type { ToolRegistry } from "../../tools/registry/contract.js";
import type { BootOptions } from "../boot-options.js";
import type { ExtensionReloadOutcome } from "../extension-reload.js";
import type { createFlowLedger } from "../flow-ledger.js";
import type { createJobHost } from "../job-host.js";
import type { createSessionSettingsView } from "../session-settings-view.js";
import type { createSystemOneControl } from "../system-one-control.js";

type SessionSettingsView = ReturnType<typeof createSessionSettingsView>;

/**
 * The lets bootOrchestrator still assigns after a surface starts, read and written live through accessors: a
 * surface that copied one would miss the later writes of the closures that share it.
 */
export interface BootSurfaceCells {
	activeAcpSessionAutonomy: "default" | "yolo" | null;
	askUserHandler: AskUserHandler | null;
	readonly creditedRunChecks: ReadonlySet<string>;
	readonly lastAutonomyHalt: AutonomyHalt | null;
	reportReviewOpener: ((draftId: string) => void) | null;
	readonly resumedSessionAtBoot: boolean;
	readonly unsubscribeDispatchShutdown: (() => void) | undefined;
	readonly yoloHeldAtBoot: boolean;
}

/** What the surface tails (src/entry/boot/*-surface.ts) read from the wired session. */
export interface BootSurfaceInput {
	acpElicitationChannel: AcpElicitationChannel | undefined;
	acpInterviewChannel: AcpInterviewChannel | undefined;
	acpInterviews: boolean;
	acpWorkerPermissions: boolean;
	activePathEntries: () => readonly SessionEntry[];
	agents: AgentsContract | undefined;
	applySettingsBlob: SessionSettingsView["applySettingsBlob"];
	askUserBridge: AskUserHandler;
	autonomyWindow: AutonomyWindow;
	beforeShellEntryRecorded: () => void;
	beginChatSettlement: () => Promise<void>;
	bindAcpHandoff: (deps: HandoffServiceDeps) => AcpHandoffControl;
	bumpSessionState: SessionSettingsView["bump"];
	bus: TelemetryHub;
	captureRunIo: () => {
		io: { stdout: (text: string) => void; stderr: (text: string) => void };
		report: (fallback: string) => AcpHostReport;
	};
	chat: ChatLoop;
	chatIdle: () => boolean;
	clampAtScope: SessionSettingsView["clampAtScope"];
	commitAcpSafeSettings: SessionSettingsView["commitAcpSafeSettings"];
	commitExtensionHooks: () => ExtensionReloadOutcome;
	commitSetting: SessionSettingsView["commitSetting"];
	config: ConfigContract | undefined;
	contextDomain: ContextContract | undefined;
	createRoutedSession: SessionSettingsView["createRoutedSession"];
	decisionBoard: DecisionBoardStore;
	dispatch: DispatchContract;
	dispatchBackground: DispatchBackgroundRegistry;
	extensions: ExtensionsContract | undefined;
	flowLedger: ReturnType<typeof createFlowLedger>;
	getCurrentSettings: SessionSettingsView["getCurrentSettings"];
	getTaskMemorySeedOffer: () => { source: string; count: number } | null;
	guardianState: GuardianStatePublisher;
	headlessGitHelpers: {
		note(workspaceRoot: string, gitHelpers: boolean): void;
		read(workspaceRoot: string): boolean | undefined;
	};
	historyReviews: HistoryReviewActivity;
	hookDrift: GitHookDriftGuard;
	initialNotices: string[];
	interop: InteropContract | undefined;
	jobHost: ReturnType<typeof createJobHost>;
	mcpSubmit: McpSubmitReader | undefined;
	memoryIntervention: MemoryInterventionRegistration;
	memoryOwner: MemoryRuntime;
	mux: MuxContract | undefined;
	options: BootOptions;
	panes: PanesOperations | null;
	persistCurrentThinkingLevel: SessionSettingsView["persistCurrentThinkingLevel"];
	printJsonSessionHeader: (meta: SessionMeta | null, active: PancodeSettings["chat"]) => RunJsonMainSessionFrame | null;
	providers: ProvidersContract;
	readAcpSafeSettings: SessionSettingsView["readAcpSafeSettings"];
	readCurrentSessionEntries: () => ReadonlyArray<SessionEntry>;
	readSessionEntriesForCompact: (sessionId: string) => SessionEntry[];
	recordBoot: (interactivity?: BootInteractivity) => void;
	reloadClasses: ReloadClassesController;
	reloadPlugins: () => PluginSnapshot;
	reportSession: {
		stateDir: string;
		cwd: () => string;
		session: () => { id: string; cwd: string; facts: ReportSessionFacts } | null;
		identitySettings: () => IdentitySettings;
	};
	resolveBaselineAutonomy: () => AutonomyLevel;
	resolveEffectiveAutonomy: () => AutonomyLevel;
	resources: ResourcesContract | undefined;
	result: LoadResult<DomainContractMap>;
	routingGestures: SessionSettingsView["routingGestures"];
	runContextInit: (
		options: {
			preview?: boolean;
			adopt?: boolean;
			applyPancodeMd?: boolean;
			rewritePancodeMd?: boolean;
			proposePancodeMd?: boolean;
			includeGlobalImports?: boolean;
			heuristic?: boolean;
			depth?: "quick" | "standard" | "deep";
			accept?: boolean;
			acceptRef?: string;
		},
		runIo?: RunIo,
	) => Promise<{ ok: true; proposalPath: string; handbookPath: string } | RunBootstrapResult>;
	runtimeHooks: ExtensionRuntimeHookBridge;
	seedCurrentTaskMemoryFromHandoff: () => TaskMemoryHandoffSeedOutcome;
	selectAtScope: SessionSettingsView["selectAtScope"];
	session: SessionContract | undefined;
	settingOrigin: SessionSettingsView["settingOrigin"];
	startSessionExtensionHost: (
		mode: "headless" | "acp",
		ask?: AskUserHandler,
	) => Promise<import("../extension-host.js").ExtensionHost | null>;
	startupOverrides: SessionOverrides;
	systemOne: SystemOne;
	systemOneControl: ReturnType<typeof createSystemOneControl>;
	taskBoard: TaskBoardStore;
	taskMemoryBank: TaskMemoryBank;
	taskMemoryTier: () => "llm" | "rules";
	telemetry: TelemetryContract;
	telemetryRunReaders: TelemetryRunReaderBinder | undefined;
	termination: ReturnType<typeof getTerminationCoordinator>;
	timer: StartupTimer;
	toolBootstrap: ToolBootstrapHandle;
	toolRegistry: ToolRegistry;
	unsubscribeChatShutdown: () => void;
	userTasks: UserTasksStore;
	withPanes: typeof import("../with-panes.js") | null;
	worktreeRecovery: WorktreeBootRecovery;
	yoloRefusal: string | null;
	cells: BootSurfaceCells;
}

/**
 * Values from the trees the Stage 0 closure sits on. Only src/entry/orchestrator.ts may import them (rule6,
 * STAGE0_SEAMS), so it hands them to the surfaces; each `load*` is that module's `import()`, still run on its own path.
 */
export interface BootSurfaceSeams {
	answerExtensionLine: typeof answerExtensionLine;
	bindBoardActions: typeof bindBoardActions;
	buildModelReplayAgentMessagesFromTurns: typeof buildModelReplayAgentMessagesFromTurns;
	continuityContextFromSession: typeof continuityContextFromSession;
	createHostToolEvents: typeof createHostToolEvents;
	createStdioServerTransport: typeof createStdioServerTransport;
	followWorkerRuns: typeof followWorkerRuns;
	loadAcpCommands: () => Promise<typeof AcpCommandsModule>;
	loadAcpServer: () => Promise<typeof AcpServerModule>;
	loadInteractiveIndex: () => Promise<typeof InteractiveIndexModule>;
	oracleBriefingFromEntries: typeof oracleBriefingFromEntries;
	parseSlashCommand: typeof parseSlashCommand;
	releasePancodeLoadedModelsOnExit: typeof releasePancodeLoadedModelsOnExit;
	resolvePermission: typeof resolvePermission;
	runHostDispatch: typeof runHostDispatch;
	subscribeLoopGuardStop: typeof subscribeLoopGuardStop;
}
