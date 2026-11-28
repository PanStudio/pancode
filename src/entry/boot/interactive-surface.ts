// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { mcpLiveStatuses } from "../../cli/mcp.js";
import { formatBootTrace } from "../../core/boot-trace.js";
import { armRestartHandoff } from "../../core/restart-handoff.js";
import { resolveMemoryRoute } from "../../core/session-routing.js";
import { pancodeDataDir, pancodeStateDir } from "../../core/xdg.js";
import { readTaskMemorySpendSummary, taskMemoryBankSize } from "../../domains/memory/index.js";
import { MEMORY_INTERVENTION_ACTIVITY_LIMIT } from "../../domains/memory/intervention/telemetry.js";
import { projectTaskMemoryActivity } from "../../domains/memory/task-memory-status.js";
import { pluginSnapshotFor } from "../../domains/plugins/index.js";
import { shareArchiver } from "../../domains/share/index.js";
import type { BootInteractivity } from "../../interactive/terminal-lease.js";
import type { RunIo } from "../../session-control/slash-command-types.js";
import type { BootResult } from "../orchestrator.js";
import type { BootSurfaceInput, BootSurfaceSeams } from "./surface.js";

/** The interactive terminal: the last surface bootOrchestrator reaches, started once the session core is wired. */
export async function runInteractiveSurface(surface: BootSurfaceInput, seams: BootSurfaceSeams): Promise<BootResult> {
	const {
		agents,
		applySettingsBlob,
		autonomyWindow,
		beforeShellEntryRecorded,
		bus,
		chat,
		clampAtScope,
		commitExtensionHooks,
		commitSetting,
		config,
		contextDomain,
		createRoutedSession,
		decisionBoard,
		dispatch,
		dispatchBackground,
		extensions,
		flowLedger,
		getCurrentSettings,
		getTaskMemorySeedOffer,
		guardianState,
		historyReviews,
		hookDrift,
		initialNotices,
		interop,
		jobHost,
		mcpSubmit,
		memoryIntervention,
		memoryOwner,
		mux,
		options,
		panes,
		providers,
		readCurrentSessionEntries,
		recordBoot,
		reloadClasses,
		reloadPlugins,
		resources,
		result,
		routingGestures,
		runContextInit,
		runtimeHooks,
		seedCurrentTaskMemoryFromHandoff,
		selectAtScope,
		session,
		settingOrigin,
		systemOne,
		systemOneControl,
		taskBoard,
		taskMemoryTier,
		telemetry,
		telemetryRunReaders,
		termination,
		timer,
		toolBootstrap,
		toolRegistry,
		userTasks,
		withPanes,
		worktreeRecovery,
		yoloRefusal,
	} = surface;
	const { cells } = surface;
	if (options.terminalLease) {
		for (const diagnostic of options.terminalLease.takeDiagnostics()) {
			const text = diagnostic.text.trimEnd();
			if (text.length > 0) initialNotices.push(text);
		}
	}

	const activePluginIds = () =>
		pluginSnapshotFor(process.cwd())
			.packages.filter((p) => p.loadable && (p.kind === undefined || p.kind === "plugin"))
			.map((p) => p.id);
	let dashboardPlugins = activePluginIds();
	const unsubscribeDashboardPlugins = bus.subscribe("plugin.reloaded", () => {
		dashboardPlugins = activePluginIds();
	});
	termination.onTerminate(() => unsubscribeDashboardPlugins());
	const { startInteractive } = await seams.loadInteractiveIndex();
	await startInteractive({
		jobs: jobHost.operations,
		getConnections: () => ({
			mcp: toolBootstrap.mcpCapabilities?.connectedIds({ readyOnly: true }) ?? [],
			plugins: dashboardPlugins,
		}),
		...(mcpSubmit ? { mcpSubmit } : {}),
		bus,
		providers,
		dispatch,
		...(agents ? { agents } : {}),
		...(() => {
			const scheduling = result.getContract("scheduling");
			return scheduling ? { scheduling } : {};
		})(),
		systemOne,
		systemOneControl,
		telemetry,
		...(telemetryRunReaders ? { telemetryRunReaders } : {}),
		chat,
		...(options.sessionFile === undefined ? {} : { sessionFile: options.sessionFile }),
		...(options.terminalLease
			? {
					terminalLease: options.terminalLease,
					onHydratedFrameCommit: (frameId: number | null, interactivity: BootInteractivity) => {
						timer.mark("Stage 1 hydration", frameId === null ? undefined : `frameId=${frameId}`);
						const line = formatBootTrace("Stage 0 input blocked", `max=${interactivity.inputBlockedMaxMs.toFixed(1)}ms`);
						if (line) options.terminalLease?.deferDiagnostic("stderr", line);
						recordBoot(interactivity);
						// Every reload subscriber exists now; a settings write held
						// during hydration reloads here.
						config?.releaseReloads?.();
						void worktreeRecovery.start();
					},
				}
			: {
					onFirstFrameCommit: () => {
						timer.mark("first TUI paint");
						recordBoot();
						void worktreeRecovery.start();
					},
				}),
		...(initialNotices.length > 0 ? { initialNotices } : {}),
		yoloRefusal,
		...(cells.yoloHeldAtBoot ? { yoloHeldAtBoot: true } : {}),
		...(resources ? { resources } : {}),
		...(extensions ? { extensions } : {}),
		runtimeHooks,
		reloadExtensions: commitExtensionHooks,
		reloadPlugins,
		...(toolBootstrap.mcpCapabilities
			? { mcpStatuses: () => mcpLiveStatuses(toolBootstrap.mcpCapabilities?.catalog().servers ?? []) }
			: {}),
		reloadClasses,
		armRestartHandoff: () => armRestartHandoff(pancodeStateDir(), termination),
		...(interop ? { interop } : {}),
		share: shareArchiver,
		...(mux ? { mux } : {}),
		...(panes ? { panes } : {}),
		...(panes ? { attachYaziBridge: (bridge) => panes.attachYazi(bridge) } : {}),
		// The interactive surface never imports the panes glue itself; the
		// factories arrive only on an active boot, through the same dynamic
		// import that loaded the mux domain.
		...(withPanes
			? {
					createMuxBridge: withPanes.createMuxBridge,
					createPeerInbox: withPanes.createPeerInbox,
					createYaziBridge: withPanes.createYaziBridge,
					createWatchPane: withPanes.createWatchPaneController,
				}
			: {}),
		...(panes ? { attachWatchPane: (controller) => panes.attachWatch(controller) } : {}),
		toolRegistry,
		...(session ? { session } : {}),
		...(session ? { readSessionEntries: readCurrentSessionEntries } : {}),
		gitHookChanges: () => hookDrift.sessionChanges(),
		autonomy: () => autonomyWindow.report(),
		labelOperatorCommand: flowLedger.labelCommand,
		beforeShellEntryRecorded,
		getTaskBoard: () => taskBoard.cachedSnapshot(),
		getDecisionBoard: () => decisionBoard.snapshot(),
		absorbFlow: (set) => flowLedger.absorb(set, { tool: "handoff" }),
		sessionFlowRestricted: (sessionId) => flowLedger.isRestricted(sessionId),
		supersedeDecision: (interviewId, key, correction) => decisionBoard.supersede(interviewId, key, correction),
		userTasks,
		getTaskMemoryStatus: () => {
			const settings = getCurrentSettings();
			const bank = memoryOwner.contract.taskSnapshot();
			return {
				enabled: settings.context.memory.enabled,
				tier: taskMemoryTier(),
				route: resolveMemoryRoute(settings),
				size: taskMemoryBankSize(bank),
				bank,
				...projectTaskMemoryActivity(
					memoryOwner.contract.interventionStatus(),
					historyReviews.recent(session?.current()?.id ?? null),
					MEMORY_INTERVENTION_ACTIVITY_LIMIT,
				),
				stepInFlight: memoryIntervention.stepInFlight(),
				guardian: guardianState.current(),
				observations: memoryOwner.contract.observationStatus(),
				retention: memoryOwner.contract.retentionStatus(),
				promptSelection: memoryOwner.contract.promptSelection?.() ?? null,
				// Fold retained memory decisions and call facts across the telemetry journals (#434).
				// Lazy because the footer composes this status on every refresh and never reads
				// spend: any journal write misses the fold's fingerprint, so an eager read rescanned
				// every retained journal on the input thread several times per turn.
				get spend() {
					return readTaskMemorySpendSummary(pancodeStateDir());
				},
			};
		},
		getTaskMemorySeedOffer,
		seedTaskMemory: seedCurrentTaskMemoryFromHandoff,
		stateDir: pancodeStateDir(),
		dataDir: pancodeDataDir(),
		registerReportReviewOpener: (open) => {
			cells.reportReviewOpener = open;
			return () => {
				if (cells.reportReviewOpener === open) cells.reportReviewOpener = null;
			};
		},
		registerAskUserHandler: (handler) => {
			cells.askUserHandler = handler;
			return () => {
				if (cells.askUserHandler === handler) cells.askUserHandler = null;
			};
		},
		getSettings: getCurrentSettings,
		getFleetNodes: () => result.getContract("scheduling")?.fleet?.list() ?? [],
		getRouteBreakers: () => result.getContract("dispatch")?.routeBreakers?.() ?? [],
		onBackgroundDispatch: () => dispatchBackground.backgroundNewest(),
		// A boot-time resume opens onto an existing conversation, so the welcome
		// header starts collapsed rather than offering fresh-start onboarding.
		...(cells.resumedSessionAtBoot ? { startsResumed: true } : {}),
		...(options.resume?.kind === "picker" ? { opensResumePicker: true } : {}),
		...(session ? { getSessionId: () => session.current()?.id ?? null } : {}),
		...(contextDomain
			? {
					getContextState: (cwd?: string) => contextDomain.contextState(cwd),
					onInit: runContextInit,
					onContextClear: async (options: { all?: boolean; confirmed?: boolean; confirmedAll?: boolean }, runIo?: RunIo) => {
						await contextDomain.runContextClear({
							cwd: process.cwd(),
							all: options.all === true,
							...(runIo ? { io: runIo } : {}),
							confirmContext: () => options.confirmed === true,
							confirmAll: () => options.confirmedAll === true,
						});
					},
					onContextRefresh: async (runIo?: RunIo) => {
						await contextDomain.runContextRefresh({
							cwd: process.cwd(),
							...(runIo ? { io: runIo } : {}),
						});
					},
				}
			: {}),
		// An unscoped caller gets the scope that cannot outlive this session.
		onSetThinkingLevel: (level, scope, source) =>
			clampAtScope({ thinkingLevel: level }, scope ?? "session", source ?? "settings-ui"),
		onCycleThinking: () => routingGestures.cycleThinking(),
		onSelectModel: ({ target, model }, scope, source) => selectAtScope({ target, model }, scope, source ?? "settings-ui"),
		// An edit names its surface; one that names none came from an overlay.
		writeSettings: (next) => applySettingsBlob(next, "settings-ui"),
		commitSetting: (id, next, scope, source) => commitSetting(id, next, scope, source ?? "settings-ui"),
		settingOrigin,
		...(session
			? {
					onResumeSession: (sessionId) => {
						try {
							session.resume(sessionId);
							taskBoard.snapshot();
						} catch (err) {
							process.stderr.write(
								`[/resume] failed to resume ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`,
							);
						}
					},
					onNewSession: () => {
						createRoutedSession();
						taskBoard.snapshot();
					},
					onForkSession: (parentTurnId) => {
						try {
							session.fork(parentTurnId);
							taskBoard.snapshot();
						} catch (err) {
							process.stderr.write(
								`[/fork] failed at turn ${parentTurnId}: ${err instanceof Error ? err.message : String(err)}\n`,
							);
						}
					},
					onRecoverHandoff: (handoffId, action) => chat.recoverHandoff(handoffId, action),
					onCompact: async (instructions) => {
						await chat.compact(instructions);
					},
				}
			: {}),
		onCycleScopedModelForward: () => routingGestures.cycleScopedModel("forward"),
		onCycleScopedModelBackward: () => routingGestures.cycleScopedModel("backward"),
		onShutdown: async () => {
			await termination.shutdown(0);
		},
	});
	return { exitCode: 0, bootTimeMs: timer.snapshot().totalMs };
}
