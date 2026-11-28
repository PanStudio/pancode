// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readBuildProvenance, runningBuildId } from "../core/build-info.js";
import type { PancodeSettings } from "../core/config.js";
import { nextOutputStyle } from "../core/defaults.js";
import { installDiagnosticSink } from "../core/diagnostics.js";
import { GLYPH } from "../core/glyphs.js";
import { flushHarnessProfile, hydrateHarnessProfile, scheduleHarnessFeature } from "../core/harness-profile.js";
import { readPancodeVersion } from "../core/package-root.js";
import { consumeRestartContinuation, restartContinuationMessage } from "../core/restart-intent.js";
import { firePendingModelRestart, nextModelRestartChain, setRestartHost } from "../core/restart-request.js";
import { isRestartHandoff } from "../core/restart-status.js";
import { getTerminationCoordinator } from "../core/termination.js";
import { immediateSequence } from "../core/timers.js";
import { pancodeStateDir } from "../core/xdg.js";
import {
	createChatTurnUsage,
	createTurnObservations,
	subscribeExtensionObservations,
} from "../domains/extensions/bus-observations.js";
import { createExtensionHostServices } from "../domains/extensions/host-services.js";
import { type PromptRef, promptRefs } from "../domains/extensions/operator-commands.js";
import { OperatorExtensions } from "../domains/extensions/operator-extensions.js";
import { bindExtensionOwnerNames, extensionOwnerLabel } from "../domains/extensions/owner-label.js";
import { openDetachedBatchViews } from "../domains/middleware/index.js";
import type { PanesWatchController } from "../domains/mux/operations.js";
import { holdExitSummaryForLauncher } from "../domains/mux/workspace/exit-summary-handoff.js";
import type { ThinkingLevel } from "../domains/providers/index.js";
import { isArcadeTrigger } from "../domains/session/easter-eggs.js";
import { setDiffusionFramesEnabled } from "../engine/apis/diffusion-frames.js";
import { createAgentProgress, TuiAltScreen } from "../engine/tui.js";
import { createDockKeyGate } from "../lib/panes/dock-keys.js";
import type { ChatLoopEvent } from "../session-control/chat-loop.js";
import { reportLoopChanges } from "../session-control/loop-command.js";
import { BUILTIN_SLASH_NAMES } from "../session-control/slash-commands.js";
import { readWorkerRunResultFacts } from "../session-control/worker-run-results.js";
import type { WorkerEntryState } from "../session-control/worker-stream.js";
import { runParkedInterview } from "../tools/extension-interview.js";
import type { ApplicationController } from "./application-controller.js";
import {
	ARCADE_PAUSED_NOTICE,
	type ArcadeSession,
	createArcadePhraseScreen,
	openArcadeOverlay,
} from "./arcade-overlay.js";
import { createAttachController } from "./attach-host.js";
import { warmTranscriptRender } from "./chat-panel.js";
import { emitCommandNotice } from "./command-fallbacks.js";
import { appendNotice, appendOperatorAside, OPERATOR_COMMAND_ENTRY, TURN_TIMING_ENTRY } from "./command-output.js";
import { presentContextCommands } from "./context-command-presentation.js";
import { dispatchCouncilThroughRegistry } from "./council-dispatch.js";
import { createDetachedBatchWake, detachedBatchDecisions } from "./detached-batch-wake.js";
import { createDispatchSteering } from "./dispatch-steering.js";
import { dockTop } from "./dock.js";
import { createEditorSubmitController, EDITOR_BASH_SHUTDOWN_MS, RESTORED_DRAFT_NOTICE } from "./editor-submit.js";
import { renderExitSummary, renderExitWithoutConversation } from "./exit-summary.js";
import { createExitSummaryCollector } from "./exit-summary-collector.js";
import { createExtensionDevSession, type ExtensionDevSession } from "./extension-dev-session.js";
import { createInteractiveDesktopNotifications } from "./footer/notifications.js";
import {
	expandInteractiveSubmitAsync,
	type InteractiveDeps,
	type InteractiveSubmitExpansion,
} from "./interactive-deps.js";
import { type DockKeyOrigin, pressFilesKey } from "./interactive-dock-keys.js";
import { createInteractiveEventProjection } from "./interactive-event-projection.js";
import { explainProtectedExit } from "./interactive-exit-explanation.js";
import { createInteractiveInputRuntime } from "./interactive-input-runtime.js";
import { dispatchInteractiveAction } from "./interactive-key-actions.js";
import { createInteractivePresentation } from "./interactive-presentation.js";
import { appendReloadReport, createInteractiveReload } from "./interactive-reload.js";
import { createInteractiveRestart, interactiveRestartBusyReason } from "./interactive-restart.js";
import { createProcessInteractiveShell, getActiveRenderTrace } from "./interactive-shell.js";
import { createInteractiveSlashRuntime, resolveAvailableThinkingLevels } from "./interactive-slash-runtime.js";
import { createInteractiveSubscriptions } from "./interactive-subscriptions.js";
import { createInteractiveTickers } from "./interactive-tickers.js";
import { formatKeyLabel } from "./keybinding-manager.js";
import { releaseRegularDock, returnToLiveEdge } from "./layout.js";
import { createOverlayLifecycle, type OverlayLifecycleController } from "./overlay-lifecycle.js";
import { openAskUserOverlay } from "./overlays/ask-user.js";
import { interopOverlaySurface } from "./overlays/interop.js";
import { paneWatchDecision } from "./pane-policy.js";
import { describePanesLeftBehind } from "./panes-runtime.js";
import { slashDraftUnderApprovalNotice } from "./permission-hint.js";
import { suspendProcessUntilContinued } from "./process-suspend.js";
import { projectShadowNotice } from "./project-shadow-notice.js";
import { createProjectTrustSession } from "./project-trust-session.js";
import { writeInputWedgeDump } from "./render-trace.js";
import { renderContextOperationResult } from "./renderers/context-operation.js";
import { hydrateResumedSessionPresentation } from "./resumed-session-presentation.js";
import { createSessionFileRecorder, sessionFileOutcomeForExitCode } from "./session-file.js";
import { settleChatBeforeSessionSwitch } from "./session-switch-settlement.js";
import { createSessionTranscript } from "./session-transcript.js";
import { createStaleBuildNotice } from "./stale-build.js";
import { createSteerReceipts } from "./steer-receipts.js";
import { processAutoPacingAllowed } from "./stream-pacing-policy.js";
import {
	ambientDrawingPlace,
	createAmbientSurfaces,
	hasExtensionDrawing,
	opensOwnSurface,
} from "./surfaces/ambient.js";
import { createExtensionPaneKeys } from "./surfaces/extension-pane-keys.js";
import { createWorkspaceSurfaces, WORKSPACE_LEAVE_KEY } from "./surfaces/registry.js";
import { renderView } from "./surfaces/view-renderer.js";
import { followTerminalColors } from "./terminal-color-follow.js";
import { workersDockHiddenNotice } from "./watch-pane.js";
import { WORKER_SETTLED_ENTRY } from "./worker-replay.js";
import { createWorkspaceFacts } from "./workspace-facts.js";
import { createYoloActivation } from "./yolo-activation.js";

/** The report offer's notice key; dismissing it records a no (R-11). */
const REPORT_OFFER_NOTICE_KEY = "report-offer";
/** At yolo, an operator with no keypress for this long is away and is not offered a report. */
const REPORT_OFFER_AWAY_MS = 2 * 60_000;
/** The offer fades like any notice, a little slower so it can be read; it stays answerable through /report. */
const REPORT_OFFER_TTL_MS = 60_000;

function availableInteractiveThinkingLevels(deps: InteractiveDeps): ReadonlyArray<ThinkingLevel> {
	const settings = deps.getSettings?.();
	return settings ? resolveAvailableThinkingLevels(deps.providers, settings) : ["off"];
}

function livePrompts(resources: InteractiveDeps["resources"]): PromptRef[] {
	return promptRefs(resources?.promptsForDisplay(process.cwd()).items ?? []);
}

function isChatReadOnly(chat: InteractiveDeps["chat"]): boolean {
	return chat.toolLimits?.()?.readOnly === true || chat.currentTurnConstraints?.()?.readOnly === true;
}

function frozenExtensionTools(registry: NonNullable<InteractiveDeps["toolRegistry"]>) {
	return registry.listAll().flatMap((tool) => (tool.sourceInfo?.extension ? [tool.sourceInfo.extension] : []));
}

export async function createInteractiveApplication(host: InteractiveDeps): Promise<number> {
	const deps = presentContextCommands(host);
	const initialInterface = deps.getSettings?.().interface;
	const initialSmoothStreaming = initialInterface?.smoothStreaming ?? "off";
	const initialAutoPacingAllowed = processAutoPacingAllowed(false);
	const lease = deps.terminalLease;
	let removeDiagnosticSink = () => {};
	const shell =
		lease?.shell ??
		createProcessInteractiveShell({
			tuiMode: deps.getSettings?.().interface.mode ?? "regular",
			streamPacingActive:
				initialSmoothStreaming === "on" || (initialSmoothStreaming === "auto" && initialAutoPacingAllowed),
			...(deps.onFirstFrameCommit ? { onFirstFrameCommit: deps.onFirstFrameCommit } : {}),
		});
	const { terminal, tui } = shell;
	const liveEdge = (): void => returnToLiveEdge(tui);
	const renderTrace = getActiveRenderTrace();
	// SIGTERM is the kill an operator reaches for when a pane stops answering, so
	// it is where the always-on input-wedge ring has to land (#224). It writes
	// synchronously from its own listener rather than from a termination hook: a
	// session wedged badly enough to be killed may never reach the coordinator's
	// asynchronous drain, and this dump has to survive that.
	const dumpInputWedgeOnTerminate = renderTrace
		? (): void => {
				try {
					writeInputWedgeDump(pancodeStateDir(), renderTrace.snapshotInputWedge());
				} catch {
					// Best effort. The process is ending either way.
				}
			}
		: null;
	if (dumpInputWedgeOnTerminate) process.on("SIGTERM", dumpInputWedgeOnTerminate);
	const visibleEventIngress = new WeakMap<
		object,
		{ sequence: number; traceSequence: number; generation: number; ingressAt: number }
	>();
	let visibleEventSequence = 0;
	let visibleEventGeneration = 0;
	// isStreaming() holds until the submit settles, about 80 ms after agent_end
	// painted the reply and its "Done" line; the exit guard waits that tail out.
	let agentRunEnded = true;
	const recordChatEventIngress = (event: ChatLoopEvent): void => {
		if (event.type === "agent_end") agentRunEnded = true;
		if (event.type === "agent_start") {
			agentRunEnded = false;
			visibleEventGeneration += 1;
			renderTrace?.beginGeneration();
			return;
		}
		if (event.type !== "text_delta" && event.type !== "thinking_delta") return;
		visibleEventSequence += 1;
		const ingress = {
			sequence: visibleEventSequence,
			traceSequence: visibleEventSequence,
			generation: visibleEventGeneration,
			ingressAt: performance.now(),
		};
		visibleEventIngress.set(event, ingress);
		if (renderTrace) {
			ingress.traceSequence = renderTrace.recordVisibleEvent({
				kind: event.type === "text_delta" ? "text" : "thinking",
				contentIndex: event.contentIndex,
				delta: event.delta,
			});
		}
	};
	let applicationController: ApplicationController;
	const workspaceFacts = createWorkspaceFacts({
		cwd: process.cwd(),
		getSessionWorkspace: () => deps.session?.current()?.workspace ?? null,
		// The workspace probe lands after first paint now; ask for the frame that
		// shows the branch chip once it does. The footer keeps the text it last
		// composed until it is refreshed, so a frame alone repainted the old
		// branch, or `no Git branch`, until the next five-second tick composed it.
		onRefreshed: () => {
			refreshPresentationFooter();
			tui.requestRender();
		},
		...(deps.extensions ? { extensions: deps.extensions } : {}),
	});
	const { refreshLiveWorkspaceGit } = workspaceFacts;
	let refreshPresentationFooter = (): void => {};
	const sessionTranscript = createSessionTranscript({
		...(deps.session ? { session: deps.session } : {}),
		...(deps.getSessionId ? { getSessionId: deps.getSessionId } : {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		...(deps.readSessionEntries ? { readSessionEntries: deps.readSessionEntries } : {}),
		chat: deps.chat,
		refreshStatus: () => refreshPresentationFooter(),
	});
	const { readStructuredEntries, recordSubmittedTurn } = sessionTranscript;
	const exitSummary = createExitSummaryCollector({
		bus: deps.bus,
		telemetry: deps.telemetry,
		dispatch: deps.dispatch,
		...(deps.session ? { session: deps.session } : {}),
		getTurns: sessionTranscript.liveSessionTurns,
		getToolCounts: () => presentation.toolCounts(),
		...(deps.readSessionEntries ? { readSessionEntries: deps.readSessionEntries } : {}),
		...(deps.gitHookChanges !== undefined ? { gitHookChanges: deps.gitHookChanges } : {}),
		...(deps.autonomy !== undefined ? { autonomy: deps.autonomy } : {}),
		readRunResult: (runId) => readWorkerRunResultFacts(runId, deps.stateDir),
		undeliveredTurns: () => undeliveredMessages().length,
		getModel: () => {
			const settings = deps.getSettings?.();
			return settings?.chat.target && settings.chat.model
				? { target: settings.chat.target, model: settings.chat.model }
				: null;
		},
	});
	const sessionFile = deps.sessionFile
		? createSessionFileRecorder({ path: deps.sessionFile, snapshot: () => exitSummary.snapshot(), cwd: process.cwd() })
		: null;
	if (sessionFile) {
		// The live record follows the permission card the operator sees; chat events reach it through the ingress below.
		deps.bus.subscribe("approval.requested", (payload) => sessionFile.observeApprovalRequested(payload));
		deps.bus.subscribe("approval.resolved", () => sessionFile.observeApprovalResolved());
		// A clean exit records first with what ended it; a signal records in the drain while the session is still
		// readable; anything else that ends the process records at exit. /restart hands the record to its child.
		const recordAt = (code: number): void => {
			if (getTerminationCoordinator().hasExitHandoff() || isRestartHandoff()) return;
			sessionFile.record(sessionFileOutcomeForExitCode(code), code);
		};
		getTerminationCoordinator().onDrain(() => recordAt(getTerminationCoordinator().getExitCode()));
		process.once("exit", (code) => recordAt(code));
	}
	/**
	 * Ctrl+G armed the leader and is waiting for the next key. Owned here because
	 * the footer reads it and the input runtime that flips it is built later.
	 */
	let leaderArmed = false;
	/**
	 * A Ctrl+C armed the double tap and its APPLICATION_DOUBLE_TAP_MS (3 s) window is still open. Owned
	 * here for the same reason as the leader flag above.
	 */
	/** False, or the armed line the footer shows while a second Ctrl+C would quit. */
	let shutdownArmed: string | false = false;
	const updateAbort = new AbortController();
	let updateTimer: ReturnType<typeof setTimeout> | undefined;
	let updateMonitor: ReturnType<typeof import("./update-monitor.js").startUpdateMonitor> | undefined;
	let upgradeFlow: ReturnType<typeof import("./interactive-upgrade.js").createInteractiveUpgradeFlow> | undefined;
	// One deferred package-manager update per session, armed by the update
	// monitor or by /upgrade, whichever comes first (#436). The package manager
	// replaces the install in place, so it runs only after this process has left
	// persist. A /restart keeps this process alive as the new child's guardian,
	// so a wrapper started then would wait on both for its full window.
	let deferredUpdateArmed = false;
	const armDeferredUpdate = (start: () => boolean): boolean => {
		if (deferredUpdateArmed) return false;
		deferredUpdateArmed = true;
		getTerminationCoordinator().onPersist(() => {
			if (!getTerminationCoordinator().hasExitHandoff()) start();
		});
		return true;
	};
	/**
	 * Assigned after the presentation because it renders into it. The composer
	 * rail reads it through the optional chain before then as "no prompt".
	 */
	let overlayLifecycle: OverlayLifecycleController;
	let refreshOperatorUi = (): void => {};
	let scheduleOperatorMaintenance = (): void => {};
	let operatorTimer: ReturnType<typeof setTimeout> | undefined;
	// The startup reload starts runtimes after the first frame, so a prompt
	// submitted as soon as the editor takes keys ran its prompt_submit and
	// before_tool hooks against no runtime and they failed open. Hook and tool
	// calls wait for that reload, as the headless and ACP host does
	// (extension-host.ts), and the reload counts the session as idle meanwhile:
	// nothing runs yet that it could swap out, and a turn parked on a hook
	// must not hold back the generation it waits for.
	let extensionStartupPending = true;
	let extensionsAwaitGeneration = (): boolean => false;
	let finishExtensionStartup = (): void => {};
	const extensionStartup = new Promise<void>((resolve) => {
		finishExtensionStartup = () => {
			extensionStartupPending = false;
			resolve();
		};
	});
	const extensionPane = createExtensionPaneKeys({
		mux: deps.extensions ? deps.mux : undefined,
		operator: () => operatorExtensions,
		keybindings: () => keybindings,
		notify: (level, text, key) => notify(level, text, key),
	});
	const operatorExtensions = deps.extensions
		? new OperatorExtensions({
				...(extensionPane.pane ? { pane: extensionPane.pane } : {}),
				builtinCommandNames: () => BUILTIN_SLASH_NAMES,
				services: createExtensionHostServices({
					providers: deps.providers,
					telemetry: deps.telemetry,
					session: deps.session,
					ask: (questions) => overlayLifecycle.openTransientAskUserOverlayState(questions),
				}),
				sandboxUnixSockets: () => deps.getSettings?.().safety.sandboxUnixSockets ?? "block",
				readOnly: () => isChatReadOnly(deps.chat),
				context: () => ({
					workspace: process.cwd(),
					sessionId: deps.session?.current()?.id ?? deps.getSessionId?.() ?? null,
					mode: "interactive",
				}),
				isIdle: () =>
					extensionStartupPending ||
					extensionsAwaitGeneration() ||
					(!deps.chat.isStreaming() &&
						deps.chat.turnPreparation().phase === "idle" &&
						(overlayLifecycle?.getState() ?? "closed") === "closed" &&
						!editorSubmit?.hasActiveEditorBash()),
				list: (cwd) => deps.extensions?.list(cwd, { all: true }) ?? [],
				...(deps.reloadExtensions ? { commitHooks: deps.reloadExtensions } : {}),
				onChange: () => refreshOperatorUi(),
				...(deps.toolRegistry ? { frozenTools: frozenExtensionTools(deps.toolRegistry) } : {}),
				onDiagnostic: (message) => {
					if (!deps.reloadClasses?.captureIssue(message)) notify("warning", message, "operator-extensions:observation");
				},
				// A mute fences the runtime at once; the reload that unloads it waits for idle.
				admits: (extensionId): boolean => devSession?.isMuted(extensionId) !== true,
				onReload: (result, reason) => {
					extensionPane.bindings();
					if (deps.reloadClasses?.active) return;
					if (result.status === "deferred") return;
					const failed = result.status === "rejected" || result.degraded === undefined;
					const degraded = (result.degraded ?? 0) > 0;
					if (reason !== "reload" && !failed && !degraded) return;
					notify(failed ? "error" : degraded ? "warning" : "info", result.message, "operator-extensions:reload");
				},
			})
		: undefined;
	// Every extension surface names its owner by the installed package's name. The
	// inventory is read from disk, so the names are re-read at most every two
	// seconds rather than on every painted frame.
	let ownerNames: { at: number; names: Map<string, string> } = { at: 0, names: new Map() };
	bindExtensionOwnerNames(
		deps.extensions
			? (extensionId) => {
					const now = Date.now();
					if (now - ownerNames.at > 2000) {
						const list = deps.extensions?.list(process.cwd(), { all: true }) ?? [];
						ownerNames = {
							at: now,
							names: new Map(list.filter((entry) => entry.effective).map((entry) => [entry.id, entry.name])),
						};
					}
					return ownerNames.names.get(extensionId);
				}
			: undefined,
	);
	const turnObservations = operatorExtensions
		? createTurnObservations((observation) => operatorExtensions.observeV2(observation))
		: undefined;
	// A turn_end carries the provider-reported usage every session host folds alike; the turn summary says how it ended.
	const turnUsage = turnObservations ? createChatTurnUsage() : undefined;
	// The dev scope is a terminal concept: only this surface sets the overlay,
	// so headless runs, ACP and workers never load a package under development.
	const devSession: ExtensionDevSession | undefined =
		operatorExtensions && deps.extensions
			? createExtensionDevSession({
					extensions: deps.extensions,
					operator: operatorExtensions,
					cwd: () => process.cwd(),
					isIdle: () =>
						!deps.chat.isStreaming() &&
						deps.chat.turnPreparation().phase === "idle" &&
						(overlayLifecycle?.getState() ?? "closed") === "closed" &&
						!editorSubmit?.hasActiveEditorBash(),
					ask: (questions, options) => overlayLifecycle.openTransientAskUserOverlayState(questions, options),
					notify: (level, text) => notify(level, text, "operator-extensions:dev"),
				})
			: undefined;
	if (operatorExtensions) extensionsAwaitGeneration = () => operatorExtensions.v2.awaitingGeneration;
	const extensionsSettled = <T>(run: () => Promise<T>): Promise<T> =>
		extensionStartup.then(() => operatorExtensions?.v2.whenLive()).then(run, run);
	if (operatorExtensions)
		deps.runtimeHooks?.bind({
			hook: (extensionId, event, timeoutMs, signal) =>
				extensionsSettled(() => operatorExtensions.hook(extensionId, event, timeoutMs, signal)),
			notify: (message) => notify("warning", message, "operator-extensions:hook"),
			advise: (message, key) => notify("info", message, `operator-extensions:advice:${key}`),
			observeTurnStart: (text) => turnObservations?.turnStart(text),
			tool: (extensionId, name, input, signal) =>
				extensionsSettled(() => operatorExtensions.tool(extensionId, name, input, signal)),
			// A tool's interview is asked like the model's own question, so a
			// permission card preempts it and it resumes afterwards.
			interview: (extensionId, interview, signal) =>
				runParkedInterview(
					{
						ask: (questions, options) => overlayLifecycle.openAskUserOverlayState(questions, options),
						renderIntro: (view, width) => renderView(view, width).lines,
					},
					interview,
					{ extensionId, title: extensionId },
					// The closing cancel still reaches the handler after an abort.
					(answer) => operatorExtensions.interview(extensionId, answer, answer.nav === "cancel" ? undefined : signal),
					signal,
				),
		});
	const workspaceSurfaces = operatorExtensions
		? createWorkspaceSurfaces({
				model: operatorExtensions.surface,
				tui,
				skinFor: (active) => operatorExtensions.skinFor(active.extensionId, active.workspaceId),
				// Read at render time only while a workspace is active, after the presentation exists.
				leaveHint: () => {
					const leader = keybindings.getKeys("pancode.leader")[0];
					return leader ? `${formatKeyLabel(leader, "")} ${WORKSPACE_LEAVE_KEY} or /extensions leave` : "/extensions leave";
				},
				terminalRows: () => terminal.rows,
				press: (extensionId, action, source = "leader") => extensionPane.press(extensionId, { id: action, source }),
				leaderLabel: () => {
					const leader = keybindings.getKeys("pancode.leader")[0];
					return leader ? formatKeyLabel(leader, "") : null;
				},
				leave: () => {
					operatorExtensions.leaveWorkspace();
				},
				focusBoard: (extensionId, title, view) => {
					if (!ambientSurfaces?.focusRegion(extensionId, title, view, "board"))
						notify("info", "Close the open panel first; the board opens over the composer.");
				},
			})
		: undefined;
	const ambientSurfaces = operatorExtensions
		? createAmbientSurfaces({
				operator: operatorExtensions,
				tui,
				dock: extensionPane.viewDock({
					mux: deps.mux ?? null,
					stateDir: deps.stateDir,
					sessionId: () => deps.session?.current()?.id ?? deps.getSessionId?.() ?? null,
					log: (message) => notify("warning", message, "operator-extensions:dock"),
				}),
				overlay: () => overlayLifecycle,
				notice: (notice) => notifications.add(notice),
				appendCard: (render) => chatRenderer.mutate(() => chatPanel.appendReplayBlock(render), "extension-card"),
				showText: (owner, text) =>
					slashRuntime.context.showReference?.({ command: owner, source: extensionOwnerLabel(owner), kind: "result", text }),
				fill: (text) => editor.setLiteralText(text),
				submit: (text) => {
					editor.setLiteralText(text);
					editor.onSubmit?.(text);
				},
			})
		: undefined;
	let lastSlashCommand: string | null = null;
	// The in-session trust card: `/trust`, a `/reload` that finds new project configuration, and the header reminder.
	const projectTrust = createProjectTrustSession({
		cwd: () => process.cwd(),
		openCard: (model, done) => overlayLifecycle.openProjectTrustState(model, done),
		restart: () => interactiveRestart(),
		notice: (level, text) => notify(level === "warn" ? "warning" : "info", text, "project-trust"),
		onChange: () => tui.requestRender(),
	});
	// The worker fold is built with the subscriptions below; a replay before then has no live run to adopt.
	let adoptLiveWorker: (runId: string) => WorkerEntryState | undefined = () => undefined;
	let watchPaneRef: PanesWatchController | null = null;
	const presentation = createInteractivePresentation({
		adoptLiveWorker: (runId) => adoptLiveWorker(runId),
		getLastCommand: () => lastSlashCommand,
		getProjectConfigReminder: () => projectTrust.reminder(),
		commandUnavailable: (command) =>
			command === "panes" && deps.panes === undefined ? "needs a pane host; this session has none" : undefined,
		...(deps.jobs ? { jobs: deps.jobs } : {}),
		workersDockAvailable: () =>
			deps.mux !== undefined && deps.mux.mode !== "none" && deps.createWatchPane !== undefined && deps.mux.available(),
		getQueuedMessageCount: () => {
			const queue = deps.chat.queuedMessages();
			return queue.steer.length + queue.followUp.length;
		},
		recordTurnTiming: (fields) => {
			try {
				if (!deps.session?.current()) return;
				deps.session.appendEntry({
					kind: "custom",
					customType: TURN_TIMING_ENTRY,
					parentTurnId: deps.session.leafId() ?? null,
					display: false,
					data: fields,
				});
			} catch {
				// Best effort; a resumed receipt then measures between its ledger rows, without the split.
			}
		},
		bus: deps.bus,
		getLifecycleHint: () => updateMonitor?.text() ?? null,
		getLeaderArmed: () => leaderArmed,
		extensionCommands: () => operatorExtensions?.commands(livePrompts(deps.resources)) ?? [],
		...(workspaceSurfaces ? { workspaceSurfaces } : {}),
		// Extension statuses reach the footer once, through the workspace surfaces' status facts, which
		// also drop an owner name the text repeats. A second feed here printed each one twice (tui-verify 16).
		getShutdownArmed: () => shutdownArmed,
		isAwaitingApproval: () => overlayLifecycle?.getState() === "permission-confirm",
		getOverlayState: () => overlayLifecycle?.getState() ?? "closed",
		isWatchPaneVisible: () => watchPaneRef?.visibility() === "visible",
		getPermissionInspection: () => {
			if (overlayLifecycle === undefined || overlayLifecycle === null) return "none";
			if (!overlayLifecycle.canInspectMutation()) return "none";
			return overlayLifecycle.isInspectingMutation() ? "open" : "closed";
		},
		getPermissionTerms: () => (overlayLifecycle?.isShowingPermissionTerms() === true ? "open" : "closed"),
		resolveVisibleEventSequence: (event) => visibleEventIngress.get(event)?.traceSequence ?? null,
		resolveStreamIngress: (event) => visibleEventIngress.get(event) ?? null,
		commitFrame: (reason) => shell.commitCurrentFrame(reason === "teardown" ? 300 : 30_000),
		hasObservedBackpressure: () => shell.hasObservedBackpressure(),
		onSmoothStreamingMode: (_mode, pacingActive) => shell.setStreamPacingActive(pacingActive),
		providers: deps.providers,
		dispatch: deps.dispatch,
		telemetry: deps.telemetry,
		...(deps.telemetryRunReaders ? { telemetryRunReaders: deps.telemetryRunReaders } : {}),
		chat: deps.chat,
		workspaceFacts,
		sessionTranscript,
		tui,
		terminal,
		...(!lease ? { mount: (root, editor) => shell.mount(root, editor) } : {}),
		...(lease
			? {
					editor: lease.editor,
					keybindings: lease.keybindings,
					bootPending: lease.pending,
				}
			: {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		...(deps.getConnections ? { getConnections: deps.getConnections } : {}),
		...(deps.resources ? { resources: deps.resources } : {}),
		...(deps.mcpSubmit ? { mcpSubmit: deps.mcpSubmit } : {}),
		...(deps.agents ? { agents: deps.agents } : {}),
		...(deps.session ? { session: deps.session } : {}),
		...(deps.getSessionId ? { getSessionId: deps.getSessionId } : {}),
		...(deps.getTaskBoard ? { getTaskBoard: deps.getTaskBoard } : {}),
		...(deps.scheduling?.localCapacity ? { getLocalCapacity: () => deps.scheduling?.localCapacity?.() ?? null } : {}),
		...(deps.userTasks ? { userTasks: deps.userTasks } : {}),
		...(deps.getTaskMemoryStatus ? { getTaskMemoryStatus: deps.getTaskMemoryStatus } : {}),
		...(deps.getTaskMemorySeedOffer ? { getTaskMemorySeedOffer: deps.getTaskMemorySeedOffer } : {}),
		...(deps.getContextState ? { getContextState: deps.getContextState } : {}),
		...(deps.startsResumed === true ? { startsResumed: true } : {}),
	});
	const {
		keybindings,
		chatPanel,
		followUpQueuePanel,
		statusController,
		dispatchBoardStore,
		contextActivityStore,
		footer,
		notifications,
		notify,
		dismissContextBootstrapNotices,
		announceTaskMemorySeedOffer,
		editor,
		dispatchBoard,
		chatRenderer,
		io,
	} = presentation;
	if (deps.startsResumed && deps.session)
		hydrateResumedSessionPresentation(deps.session, chatPanel, readStructuredEntries, presentation.setLastTurnSummary);
	// Every operator entry point reports the effective state after a successful
	// change. One observer keeps shortcuts, slash commands, and forms consistent.
	const withSettingFeedback =
		<Args extends unknown[], Result>(action: (...args: Args) => Result) =>
		(...args: Args): Result => {
			const result = action(...args);
			presentation.announceSettingChanges();
			return result;
		};
	// Turning yolo on is gated: refused as root outside a container, and the
	// first activation shows the acceptance card (#407).
	const commitSetting = deps.commitSetting;
	const yoloActivation =
		commitSetting === undefined
			? undefined
			: createYoloActivation({
					getSettings: () => deps.getSettings?.(),
					refusal: deps.yoloRefusal ?? null,
					commitSetting,
					ask: (questions, options) => overlayLifecycle.openTransientAskUserOverlayState(questions, options),
					prepareScreen: () => {
						const state = overlayLifecycle.getState();
						if (state !== "closed" && state !== "ask-user") overlayLifecycle.closeOverlay();
					},
					notify: (level, text, key) => notify(level, text, key),
					afterCommit: () => {
						presentation.announceSettingChanges();
						if (watchPane?.refreshPresentation?.() === false)
							notify("warning", "Could not update the workers pane's output detail; reopen it to retry.");
						footer.refresh();
						tui.requestRender();
					},
				});
	const settingActions = {
		...(yoloActivation ? { commitSetting: withSettingFeedback(yoloActivation.commit) } : {}),
		...(deps.writeSettings ? { writeSettings: withSettingFeedback(deps.writeSettings) } : {}),
		...(deps.onSetThinkingLevel ? { onSetThinkingLevel: withSettingFeedback(deps.onSetThinkingLevel) } : {}),
		...(deps.onSelectModel ? { onSelectModel: withSettingFeedback(deps.onSelectModel) } : {}),
		...(deps.onCycleThinking ? { onCycleThinking: withSettingFeedback(deps.onCycleThinking) } : {}),
		...(deps.onCycleScopedModelForward
			? { onCycleScopedModelForward: withSettingFeedback(deps.onCycleScopedModelForward) }
			: {}),
		...(deps.onCycleScopedModelBackward
			? { onCycleScopedModelBackward: withSettingFeedback(deps.onCycleScopedModelBackward) }
			: {}),
	};
	// The dock keys. A first tap shows or hides at once and a second inside the
	// window ends the process. A tap can also arrive from inside the dock (Alt+E in
	// Yazi), where PanCode's own key handler is not the one that hears it; those
	// hide the pane and hand the keyboard back to PanCode.
	const dockKeys = createDockKeyGate();
	// The factory arrives only from an active `--with-panes` boot (or a test); a
	// plain session has no deps.panes and no factory, and loads no yazi code.
	const yaziBridge =
		deps.panes && deps.createYaziBridge
			? deps.createYaziBridge({
					...(deps.mux ? { mux: deps.mux } : {}),
					getDraft: () => editor.getText(),
					setDraft: (text) => editor.setText(text),
					requestRender: () => tui.requestRender(),
					notice: (level, text) => notify(level, text, `files:${level}`),
					getCwd: () => process.cwd(),
					getSettings: () =>
						deps.getSettings?.().interface.panes.files ?? {
							mode: "companion",
							profile: "managed",
							followCwd: true,
						},
					stopUi: () => tui.stop(),
					startUi: () => {
						tui.start();
						tui.requestRender(true);
						terminalColors.refresh();
					},
					onDockKey: () => pressFilesKey(deps, notify, dockKeys, "dock"),
				})
			: null;
	const detachYaziBridge = yaziBridge ? deps.attachYaziBridge?.(yaziBridge) : undefined;
	refreshPresentationFooter = () => footer.refresh();
	refreshOperatorUi = () => {
		scheduleOperatorMaintenance();
		footer.refresh();
		tui.requestRender();
	};
	const agentProgress = createAgentProgress(terminal);
	const terminalColors = followTerminalColors(tui);
	// Only the interactive surface asks a diffusion provider for whole-response
	// frames; it is the one consumer that can show noise settling into text.
	setDiffusionFramesEnabled(process.stdout.isTTY === true);
	// Desktop notifications are a protocol write on the terminal owner, issued
	// outside any render transaction, so the sequence carries frameId null and
	// never lands inside a frame. A non-TTY process never emits one even when
	// `PANCODE_INTERACTIVE=1` forced the interactive surface on.
	const staleBuildNotice = createStaleBuildNotice((notice) => notifications.add(notice));
	const desktopNotifications = createInteractiveDesktopNotifications({
		write: (data) => terminal.write(data),
		enabled: () => deps.getSettings?.().interface.desktopNotifications ?? false,
		interactiveTty: () => process.stdout.isTTY === true,
		getOpenBatches: () => openDetachedBatchViews(deps.dispatch),
	});
	const busNoticeSink = {
		appendReplayBlock: (renderBlock: Parameters<typeof chatPanel.appendReplayBlock>[0]) =>
			chatRenderer.mutate(() => chatPanel.appendReplayBlock(renderBlock), "bus-notice"),
		requestRender: () => {},
	};
	// Job transitions (a pause, an ended job, a matched condition) reach the transcript
	// once each; a command's own result is reported by the command, never again here.
	const loopJobs = deps.jobs
		? reportLoopChanges(deps.jobs, ({ level, text }) => appendNotice(level, text, busNoticeSink))
		: undefined;
	// `/attach`: a second terminal watches this session, answers its card, or pairs.
	const attachController = createAttachController({
		bus: deps.bus,
		chat: deps.chat,
		...(deps.session ? { session: deps.session } : {}),
		cards: () => overlayLifecycle.permissionCards(),
		notice: (level, text) => appendNotice(level, text, busNoticeSink),
		showTurn: (text, origin) => showMachineTurn(text, origin),
	});
	const eventProjection = createInteractiveEventProjection({
		heldQueueNotice: (count) =>
			`${count === 1 ? "1 queued message is" : `${count} queued messages are`} held and nothing was sent. ${keybindings.actionLabel("pancode.message.interrupt")} sends the queue in order, ${keybindings.actionLabel("pancode.queue.open")} then a restores it to the composer, and a new prompt takes it at its first slot.`,
		restoreDroppedQueue: (texts) => {
			const current = editor.getExpandedText();
			editor.setLiteralText([texts.join("\n\n"), current].filter((part) => part.trim().length > 0).join("\n\n"));
			notify(
				"info",
				`${texts.length === 1 ? "1 message" : `${texts.length} messages`} queued behind the old session ${texts.length === 1 ? "was" : "were"} put back in the editor`,
				"session:queue",
			);
		},
		isReloadReporting: () => deps.reloadClasses?.active === true,
		bus: deps.bus,
		chat: deps.chat,
		status: statusController,
		...(deps.initialNotices ? { initialNotices: deps.initialNotices } : {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		getTerminalColumns: () => terminal.columns,
		onChatEventIngress: (event) => {
			turnUsage?.observe(event);
			exitSummary.observeChat(event);
			sessionFile?.observeChat(event);
			recordChatEventIngress(event);
			presentation.recordChatEvent(event);
		},
		applyChatEvent: (event) => chatRenderer.applyEvent(event),
		setFollowUpMessages: (messages) => {
			followUpQueuePanel.setMessages(messages);
			// A navigator on screen stays open when the run drains the queue under it and
			// says so, because closing it handed the next key, meant for a message, to the
			// composer. One drained behind an approval card is put away when the card closes
			// (`restorable` in the overlay lifecycle).
		},
		isAskUserWaiting: () => overlayLifecycle.isAskUserWaiting(),
		closeAskUserSession: () => overlayLifecycle.closeAskUserSession(),
		resetAskUserCancellation: () => overlayLifecycle.resetAskUserCancellation(),
		recordToolStart: (toolName, toolCallId) => {
			presentation.recordToolStart(toolCallId, toolName);
			turnObservations?.toolStart(toolCallId);
		},
		recordToolEnd: (toolName, toolCallId, isError, truncated, settledAsSteps) => {
			presentation.recordToolEnd({ toolCallId, isError, truncated, ...(settledAsSteps ? { settledAsSteps } : {}) });
			turnObservations?.toolEnd(toolName, toolCallId, isError);
		},
		setLastTurnSummary: (summary) => {
			presentation.setLastTurnSummary(summary);
			if (summary && turnUsage)
				turnObservations?.turnEnd({
					...turnUsage.current(),
					modelId: summary.modelId,
					targetId: summary.targetId,
					stopReason: summary.stopReason,
				});
		},
		startTerminalProgress: () => agentProgress.start(),
		stopTerminalProgress: () => agentProgress.stop(),
		onTurnEnded: () => {
			desktopNotifications.turnEnded();
			detachedBatchWake.poke();
			devSession?.poke();
			staleBuildNotice();
			firePendingModelRestart();
		},
		refreshLiveWorkspaceGit: (force) => void refreshLiveWorkspaceGit(force),
		refreshFooter: () => {
			presentation.announceSettingChanges();
			footer.refresh();
		},
		requestRender: () => tui.requestRender(),
		notify,
		dismissNotification: (key) => notifications.dismiss(key),
		supersedeWorkNotifications: () => notifications.supersede("work"),
		appendTranscriptNotice: (level, text, source) => appendNotice(level, text, busNoticeSink, source),
		refreshSettingsOverlay: () => overlayLifecycle.refreshSettingsOverlay(),
		onConfigHotReload: (settings) => {
			keybindings.reload(settings.interface.keybindings ?? {});
			presentation.announceSettingChanges();
			footer.refresh();
			tui.requestRender();
			const mode = settings.interface.smoothStreaming;
			const autoAllowed = processAutoPacingAllowed(shell.hasObservedBackpressure());
			chatRenderer.setSmoothStreamingMode(mode);
			shell.setStreamPacingActive(mode === "on" || (mode === "auto" && autoAllowed));
		},
	});
	// The overlay reads the report this process already produced at boot; it
	// never probes on a keystroke.
	const interop = deps.interop;
	// `/council` reaches execution only through the tool registry, so the
	// approval overlay this application already installs on it is the same one an
	// operator-typed council parks.
	const toolRegistry = deps.toolRegistry;
	const interopSurface = interop ? interopOverlaySurface(interop, (level, text) => notify(level, text)) : null;
	// What the operator uses themselves retires the matching demo guidance tip.
	// Off with interface.demo: no profile read or write while guidance is off.
	// The profile write is synchronous and durable, and it runs on the Enter path of
	// any `@` or slash submit: it held the acknowledging frame 10 to 20 ms. The frame
	// goes out on the next tick, ahead of this immediate.
	const recordFeature = (feature: string): void => {
		if (feature.startsWith("/")) lastSlashCommand = feature;
		else if (feature.startsWith("key:")) lastSlashCommand = null;
		const settings = deps.getSettings?.();
		if (settings && settings.interface.demo !== false) scheduleHarnessFeature(feature);
	};
	// Every submit expansion in flight owns its controller, so a second submit
	// never orphans the first. A huge `@file.pdf` could otherwise hold Enter for
	// two 60 s poppler timeouts with no way out; Esc, Ctrl+C and shutdown abort
	// it, and the status line names the file while it is read.
	const submitExpansions = new Set<AbortController>();
	const SUBMIT_EXPANSION_STATUS = "submit:expanding";
	const expandSubmitCancellable = async (text: string): Promise<InteractiveSubmitExpansion> => {
		const controller = new AbortController();
		submitExpansions.add(controller);
		try {
			const expansion = await expandInteractiveSubmitAsync(text, deps.resources, process.cwd(), {
				signal: controller.signal,
				...(deps.mcpSubmit ? { mcp: deps.mcpSubmit } : {}),
				onExtract: (shortPath) =>
					notifications.add({
						level: "info",
						text: `Reading ${shortPath} ${GLYPH.sep} Esc cancels and keeps your message`,
						key: SUBMIT_EXPANSION_STATUS,
						ttlMs: 0,
					}),
			});
			// A cancel that lands after the last read still wins; the operator asked for nothing to be sent.
			controller.signal.throwIfAborted();
			return expansion;
		} finally {
			submitExpansions.delete(controller);
			if (submitExpansions.size === 0) notifications.dismiss(SUBMIT_EXPANSION_STATUS);
		}
	};
	const cancelSubmitExpansions = (): boolean => {
		if (submitExpansions.size === 0) return false;
		for (const controller of submitExpansions) controller.abort();
		return true;
	};
	// The arcade egg owns every key while it is open; closing it hands the TUI back as it was. An approval or an
	// ask_user card puts it away with the board kept, and the trigger phrase brings it back where it stopped.
	let arcade: ArcadeSession | null = null;
	const arcadeNeedsOperator = (): boolean =>
		overlayLifecycle?.getState() === "permission-confirm" || dockTop(tui)?.frame.dockAwaitingInput?.() === true;
	const noticeArcadePaused = (): void => {
		notifications.add({ level: "info", key: "arcade:paused", text: ARCADE_PAUSED_NOTICE, ttlMs: 6_000 });
	};
	const openArcadeEgg = (text: string): boolean => {
		if (!isArcadeTrigger(text) || arcade?.isOpen()) return false;
		if (arcade?.isPaused()) {
			if (!arcade.resume())
				notifications.add({
					level: "info",
					key: "arcade:paused",
					text: "Ms. PanCode waits until PanCode's question is answered",
					ttlMs: 4_000,
				});
			return true;
		}
		arcade = openArcadeOverlay(tui, { needsOperator: arcadeNeedsOperator, onPause: noticeArcadePaused });
		return true;
	};

	// `restart_session` asks for a restart during a turn; it runs once that turn has settled.
	const interactiveRestart = createInteractiveRestart({
		...(deps.session ? { session: deps.session } : {}),
		stateDir: deps.stateDir,
		saveWorkspace: () => operatorExtensions?.saveWorkspace(),
		busyReason: () =>
			interactiveRestartBusyReason({
				chat: deps.chat,
				dispatch: deps.dispatch,
				operator: operatorExtensions,
				editorBash: editorSubmit.hasActiveEditorBash(),
				reloading: deps.reloadClasses?.active === true,
				shuttingDown: shutdownArmed !== false || getTerminationCoordinator().getPhase() !== "idle",
			}),
		settle: () => deps.chat.whenSettled(),
		armHandoff: () => deps.armRestartHandoff?.(),
		shutdown: () => applicationController.shutdown(),
		notify,
	});
	const slashRuntime = createInteractiveSlashRuntime({
		recordFeature,
		...(deps.telemetry.read ? { getTelemetry: () => deps.telemetry.read?.live() ?? null } : {}),
		keyboardActions: {
			menuLabel: (letter) => {
				const target = keybindings.leaderTargets().find((candidate) => candidate.key === letter);
				return target
					? `${keybindings.actionLabel(target.id)} (${keybindings.getLabel(target.id)})`
					: `Ctrl+G ${letter.toUpperCase()}`;
			},
		},
		...(operatorExtensions ? { operatorExtensions } : {}),
		...(devSession ? { extensionDev: devSession.command } : {}),
		...(ambientSurfaces ? { showExtensionCard: (card) => ambientSurfaces.showCard(card) } : {}),
		showExtensionOutput: (invocation, output, id) => {
			const generation = operatorExtensions?.entries().find((entry) => entry.id === id)?.generation;
			const valid = () =>
				operatorExtensions
					?.entries()
					.some((entry) => entry.id === id && entry.state === "ready" && entry.generation === generation) ?? false;
			if (!valid()) {
				slashRuntime.context.notice(
					"warn",
					`/${invocation}: extension ${id} reloaded before its result arrived, so nothing was shown. Run it again.`,
				);
				return;
			}
			// An operator who typed the command is owed a visible answer. Surface events
			// and persistent entries draw the result, but a footer status or band can
			// change by nothing, or not at all, so the text still reaches the transcript
			// unless the result opened something of its own.
			if (output.text && !opensOwnSurface(output))
				slashRuntime.context.showReference?.({
					command: invocation,
					source: extensionOwnerLabel(id),
					kind: "result",
					text: output.text,
				});
			else if (!output.text && !hasExtensionDrawing(output))
				slashRuntime.context.notice("info", `/${invocation} ran and returned nothing to show.`);
			else if (!output.text && !opensOwnSurface(output))
				slashRuntime.context.notice("info", `/${invocation} ran; its result is in ${ambientDrawingPlace(output)}.`);
		},
		io,
		bus: deps.bus,
		dispatch: deps.dispatch,
		...(deps.getDecisionBoard ? { getDecisionBoard: deps.getDecisionBoard } : {}),
		...(deps.session ? { session: deps.session } : {}),
		providers: deps.providers,
		chat: deps.chat,
		chatPanel: {
			appendReplayBlock: (...args) => chatRenderer.mutate(() => chatPanel.appendReplayBlock(...args), "slash-output"),
			appendUser: (text, status) => chatRenderer.mutate(() => chatPanel.appendUser(text, status), "user-submit"),
		},
		beforeSemanticSubmit: () => chatRenderer.flush(),
		returnToLiveEdge: liveEdge,
		// A `/run` or `/delegate` echo is recorded like the run it starts, so a
		// resumed session states the command above its card. Best effort, and
		// never model context.
		recordOperatorCommand: (text) => {
			try {
				sessionTranscript.ensureSessionForLocalEntry();
				if (!deps.session?.current()) return;
				deps.session.appendEntry({
					kind: "custom",
					customType: OPERATOR_COMMAND_ENTRY,
					parentTurnId: deps.session.leafId() ?? null,
					data: { text },
				});
			} catch {
				// Best effort; the live echo already rendered.
			}
		},
		settleVisibleFrame: (reason) => chatRenderer.flushAndCommit(reason),
		...(deps.resources ? { resources: deps.resources } : {}),
		...(deps.mcpSubmit
			? {
					mcpPromptClaims: (token: string) =>
						deps.mcpSubmit?.promptCommands().some((row) => `${row.serverId}:${row.name}` === token) === true,
				}
			: {}),
		...(deps.extensions ? { extensions: deps.extensions } : {}),
		...(deps.reloadExtensions ? { reloadExtensions: deps.reloadExtensions } : {}),
		...(deps.reloadPlugins ? { reloadPlugins: deps.reloadPlugins } : {}),
		...(deps.mcpStatuses ? { mcpStatuses: deps.mcpStatuses } : {}),
		...(interopSurface ? { interop: interopSurface } : {}),
		...(deps.agents ? { agents: deps.agents } : {}),
		...(deps.share ? { share: deps.share } : {}),
		...(deps.userTasks ? { userTasks: deps.userTasks } : {}),
		...(deps.getSettings ? { getSettings: deps.getSettings } : {}),
		...settingActions,
		...(deps.onCompact ? { onCompact: deps.onCompact } : {}),
		...(deps.onRecoverHandoff ? { onRecoverHandoff: deps.onRecoverHandoff } : {}),
		...(deps.onInit ? { onInit: deps.onInit } : {}),
		...(deps.onContextClear ? { onContextClear: deps.onContextClear } : {}),
		...(deps.onContextRefresh ? { onContextRefresh: deps.onContextRefresh } : {}),
		stateDir: deps.stateDir,
		shutdown: () => applicationController.shutdown(),
		reloadClasses: createInteractiveReload(
			deps.reloadClasses,
			operatorExtensions,
			(level, text) => slashRuntime.notice(level, text),
			(report) => appendReloadReport(report, busNoticeSink),
			() => openExtensionsOverlayState(),
			() => projectTrust.reloaded(),
		),
		restart: interactiveRestart,
		openProjectTrust: () => projectTrust.open(),
		startUpgrade: () => {
			// Keep package-manager and lifecycle code out of boot. The footer does
			// no more than point at /upgrade; this graph loads only after the operator
			// explicitly asks to review it.
			void import("./interactive-upgrade.js")
				.then(({ createInteractiveUpgradeFlow }) => {
					upgradeFlow ??= createInteractiveUpgradeFlow({
						runningVersion: readPancodeVersion(),
						openAskUser: (questions, options) => openTransientAskUserOverlayState(questions, options),
						notify,
						record: (level, text) => appendNotice(level, text, busNoticeSink),
						isIdle: () => {
							const queue = deps.chat.queuedMessages();
							return (
								overlayLifecycle.getState() === "closed" &&
								editor.getText().length === 0 &&
								!leaderArmed &&
								!shutdownArmed &&
								!operatorExtensions?.busy &&
								!editorSubmit.hasActiveEditorBash() &&
								!deps.chat.isStreaming() &&
								deps.chat.turnPreparation().phase === "idle" &&
								deps.dispatch.snapshot().running.length === 0 &&
								queue.steer.length + queue.followUp.length === 0
							);
						},
						dismissUpdateHint: () => updateMonitor?.dismiss(),
						shutdown: () => {
							void applicationController.shutdown();
						},
						signal: updateAbort.signal,
						cwd: process.cwd(),
						armDeferredUpdate,
					});
					upgradeFlow.start();
				})
				.catch((error) =>
					notify(
						"error",
						`Upgrade controls could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
						"lifecycle:upgrade-load-failed",
					),
				);
		},
		requestRender: () => tui.requestRender(),
		refreshFooter: () => footer.refresh(),
		dismissContextBootstrapNotices,
		recordSubmittedTurn,
		readStructuredEntries,
		expandSubmit: expandSubmitCancellable,
		...(renderTrace ? { onSubmitPhase: (seq, phase) => renderTrace.recordSubmitPhase(seq, phase) } : {}),
		openAskUser: (questions, options) => openAskUserOverlayState(questions, options),
		openTransientAskUser: (questions, options) => openTransientAskUserOverlayState(questions, options),
		arcadeEgg: openArcadeEgg,
		openSkillsHub: (request) => openSkillsHubState(request),
		openUsage: (tab) => openUsageOverlayState(tab),
		openSideQuestion: (question) => openSideQuestionOverlayState(question),
		openDraft: (request, count) => openDraftOverlayState(request, count),
		startHandoff: (goal) => startHandoffState(goal),
		openReport: (request) => openReportState(request),
		showReportStatus: () => showReportStatusState(),
		forgetReport: (id) => forgetReportState(id),
		startFleetRun: (name, vars, options) => startFleetRunState(name, vars, options),
		openFleetRuns: () => toggleDispatchBoardOverlay(),
		...(toolRegistry
			? {
					runCouncilDispatch: (args, turnConstraints) => dispatchCouncilThroughRegistry(toolRegistry, args, turnConstraints),
				}
			: {}),
		openContextView: () => openContextViewOverlayState(),
		openTasks: () => openTasksOverlayState(),
		openDecisions: () => openDecisionsOverlayState(),
		openMemory: () => openMemoryOverlayState(),
		...(deps.seedTaskMemory ? { seedTaskMemory: deps.seedTaskMemory } : {}),
		openView: (filter) => openViewOverlayState(filter),
		...(deps.panes ? { panes: deps.panes } : {}),
		attach: attachController,
		...(loopJobs ? { jobs: loopJobs.jobs } : {}),
		openModel: () => openModelOverlayState(),
		applyModelSession: (ref) => applyModelSessionState(ref),
		openSettings: (area) => {
			if (!area) return openSettingsOverlayState();
			openSettingsOverlayState(area);
		},
		openResume: (target) => openResumeOverlayState(target),
		startNewSession: () => void startNewSession(),
		openTree: () => openTreeOverlayState(),
		openRewind: () => openRewindOverlayState(),
		openMessagePicker: (name) => openMessagePickerOverlayState(name),
		openHelp: (query) => openHelpOverlayState(query),
		openExtensions: () => openExtensionsOverlayState(),
		openInterop: () => openInteropOverlayState(),
		openContextReset: () => openContextResetOverlayState(),
		openThinkingLevel: (choices, current, onPick) => openThinkingLevelOverlayState(choices, current, onPick),
		setEditorText: (text) => editor.setText(text),
		restoreRefusedDraft: (text) => {
			if (editor.getText().trim().length === 0) editor.setLiteralText(text);
		},
		// What the operator can share is what the operator can see: the panel's
		// blocks, live or replayed, rather than the reducer's routing table.
		listWorkerRuns: () => chatPanel.workerStates(),
	});

	const steerReceipts = createSteerReceipts({
		bus: deps.bus,
		append: (render, isLive) => chatRenderer.mutate(() => chatPanel.appendReplayBlock(render, isLive), "steer-receipt"),
		requestRender: () => tui.requestRender(),
	});
	const editorSubmit = createEditorSubmitController({
		onSteerSent: (run, text) => steerReceipts.sent(run, text),
		onLocalEntry: exitSummary.observeLocalEntry,
		recordFeature,
		onLocalBashRunning: (running, command, settled) => {
			// A shell line is the newest history entry, so ↑ recalls it and not a failed turn's prompt above it.
			if (running) chatRenderer.mutate(() => chatPanel.forgetPromptRecall(), "prompt-recall");
			presentation.setLocalBashRunning(running, command, settled);
		},
		onLocalBashCancelling: presentation.setLocalBashCancelling,
		returnToLiveEdge: liveEdge,
		editor,
		ui: tui,
		io,
		chat: deps.chat,
		dispatch: deps.dispatch,
		...(deps.session ? { session: deps.session } : {}),
		sessionTranscript,
		chatPanel: {
			appendReplayBlock: (...args) =>
				chatRenderer.mutate(() => chatPanel.appendReplayBlock(...args), "editor-command-output"),
		},
		beforeSemanticBoundary: () => chatRenderer.flush(),
		settleVisibleFrame: (reason) => chatRenderer.flushAndCommit(reason),
		dispatchCommand: slashRuntime.dispatchCommand,
		dispatchCommandAsync: slashRuntime.admitCommand,
		collapseLaunchpadBeforeSubmit: () => presentation.collapseWelcomeDashboard(),
		expandSubmit: expandSubmitCancellable,
		notify,
		askEgg: (questions, options) => openTransientAskUserOverlayState(questions, options),
		arcadeEgg: openArcadeEgg,
		askSendNow: async (runningTools) => {
			const stop = "Stop it and send now";
			const wait = "Send after it finishes";
			const result = await overlayLifecycle.openTransientAskUserOverlayState([
				{
					header: "Send now",
					// A typed answer has no meaning here, and anything but the wait choice stops the tool.
					fixedChoices: true,
					question: `${runningTools === 1 ? "A tool call is" : `${runningTools} tool calls are`} still running. Deliver your message now?`,
					options: [
						{
							label: stop,
							description: "Cancel the run the way Esc does, seal its results, then send this as a fresh prompt.",
						},
						{
							label: wait,
							description: "Let the tool finish; the message goes ahead of the queue and lands before the next model call.",
						},
					],
				},
			]);
			if (result.cancelled === true) return "cancelled";
			return result.answers[0]?.options?.[0] === wait ? "wait" : "stop";
		},
		...(deps.labelOperatorCommand ? { labelOperatorCommand: deps.labelOperatorCommand } : {}),
		...(deps.beforeShellEntryRecorded ? { beforeShellEntryRecorded: deps.beforeShellEntryRecorded } : {}),
	});
	// The lease drains the terminal; operator shell ownership outlives that
	// surface and must settle before the session domain stops, on every exit.
	getTerminationCoordinator().onDrain(() => editorSubmit.shutdownEditorBash(), { timeoutMs: EDITOR_BASH_SHUTDOWN_MS });
	getTerminationCoordinator().onDrain(() => {
		cancelSubmitExpansions();
	});
	editor.onSubmit = (submitted) => {
		const text = editor.addressSubmission(submitted);
		if (upgradeFlow?.isRunning()) {
			// Pi clears the composer before invoking onSubmit. Package replacement
			// must not race a new turn, so restore the draft exactly and leave it for
			// the restarted (or still-current) process.
			editor.setText(text);
			notify(
				"info",
				"Finish or cancel the in-session upgrade before submitting another command or turn; your draft was preserved.",
				"lifecycle:upgrade-submit-blocked",
			);
			tui.requestRender();
			return;
		}
		editorSubmit.submitEditorText(text);
	};
	setRestartHost((text) => {
		const chain = nextModelRestartChain();
		void deps.chat.whenSettled().then(() => interactiveRestart(text, chain));
	});
	// `/restart <text>`: the restarted session continues the task on the new build.
	const restartSessionId = deps.startsResumed ? deps.session?.current()?.id : undefined;
	const restartContinuation = restartSessionId ? consumeRestartContinuation(deps.stateDir, restartSessionId) : undefined;
	if (restartContinuation)
		setImmediate(() =>
			editorSubmit.submitEditorText(
				restartContinuationMessage(
					restartContinuation,
					runningBuildId ?? null,
					((b) => (b ? `${b.commit}${b.dirty ? "-dirty" : ""}` : null))(readBuildProvenance()),
				),
			),
		);

	const interactiveTickers = createInteractiveTickers({
		tui,
		dispatchBoardStore,
		contextActivityStore,
		getOverlayState: () => overlayLifecycle?.getState() ?? "closed",
		isFooterExpanded: () => footer.isExpanded(),
		...(deps.getTaskBoard ? { getTaskBoard: deps.getTaskBoard } : {}),
	});
	/**
	 * The one transcript reset. The chat panel and the worker fold are two views
	 * of one session, so a session change (/new, /resume, /tree, /fork) clears
	 * them together: a late event for a run of the old session then finds no
	 * entry unless the new transcript replays that run's card, and bare /share
	 * cannot select the old session's result. Read lazily
	 * because the subscriptions that own the fold are built below.
	 */
	const resetTranscript = (): void => {
		chatRenderer.reset(() => {
			chatPanel.reset();
			interactiveSubscriptions.workers.reset();
		});
	};
	/**
	 * The same reset, plus the header collapse that adopting an existing
	 * conversation implies. `/resume`, `/tree`, `/fork` and `/handoff` all rebuild
	 * the transcript from a session that already has turns, so the launchpad's
	 * fresh-start onboarding must not survive above it. `/new` deliberately calls
	 * the bare reset above and re-expands the launchpad instead.
	 *
	 * Collapsing here rather than at each overlay call site keeps one seam for
	 * all four paths; `collapseToSessionHeader` is idempotent, so a resume that is
	 * immediately submitted to cannot produce a second transition.
	 */
	const adoptExistingConversation = (): void => {
		presentation.resetForNewSession();
		exitSummary.sessionChanged();
		presentation.collapseWelcomeDashboard();
		resetTranscript();
	};
	const suspendTerminalAsync = async <T>(run: () => Promise<T>, preserveScreen = false): Promise<T> => {
		try {
			tui.stop(preserveScreen ? { preserveScreen: true } : {});
			return await run();
		} finally {
			tui.start();
			tui.requestRender(true);
			terminalColors.refresh();
		}
	};
	// R-11: the report offer watcher loads after the first frame; until then nothing can be offered.
	let reportOffers: import("../domains/report/extension.js").ReportOfferWatcher | null = null;
	let lastOperatorInputAt = Date.now();
	overlayLifecycle = createOverlayLifecycle({
		// While the game is paused for a card, its phrase is held back from the card.
		openAskUserOverlay: (host, card) =>
			openAskUserOverlay(host, {
				...card,
				screenKeys: createArcadePhraseScreen({ active: () => arcade?.isPaused() === true, onPhrase: noticeArcadePaused }),
			}),
		lastOperatorInputAt: () => lastOperatorInputAt,
		dismissNotification: (key) => notifications.dismiss(key),
		takeReportOffer: () => {
			const offer = reportOffers?.take() ?? null;
			if (offer !== null) notifications.dismiss(REPORT_OFFER_NOTICE_KEY);
			return offer;
		},
		onToolResumed: (toolCallId) => statusController.noteToolResumed(toolCallId),
		onToolJudging: (toolCallId) => statusController.noteToolJudging(toolCallId),
		onOverlayClosed: () => ambientSurfaces?.refresh(),
		getDispatchRows: () => dispatchBoardStore.workerRows(),
		app: { ...deps, ...settingActions },
		tui,
		footer,
		interactiveTickers,
		busNoticeSink,
		chatRenderer,
		notify,
		terminal,
		dispatchBoard,
		setFleetRunPhase: (runId, phase) => {
			dispatchBoardStore.setFleetPhase(runId, phase);
			// The step's worker card names its step too, so two steps sharing an agent and a task read apart.
			interactiveSubscriptions.tagPlanStep(runId, phase.stepId);
		},
		fleetPlans: dispatchBoardStore.plans,
		chatPanel,
		resetTranscript: adoptExistingConversation,
		io,
		readStructuredEntries,
		announceTaskMemorySeedOffer,
		setLastTurnSummary: (summary) => presentation.setLastTurnSummary(summary),
		keybindings,
		editor,
		queueNavigator: {
			toEditor: (entry) => {
				if (deps.chat.removeQueuedEntry(entry.id, "to-editor") === null) return;
				const current = editor.getExpandedText();
				// A queued template turn returns as the line typed, not its expanded body.
				const restored = entry.constraints !== undefined ? (entry.display?.text ?? entry.text) : entry.text;
				editor.setRestoredText([restored, current].filter((part) => part.trim().length > 0).join("\n\n"));
				notify("info", RESTORED_DRAFT_NOTICE, "queue:restored");
			},
			sendNow: (entry) => editorSubmit.interruptFromEditor(entry.text, entry),
			restoreAll: () => editorSubmit.restoreQueuedFollowUpsToEditor(),
		},
		getSlashContext: () => slashRuntime.context,
		// One terminal owner, so the external editor a handoff review opens gets
		// the screen the same way the composer's own `$EDITOR` opener does.
		suspendTerminal: (run) => {
			try {
				tui.stop();
				return run();
			} finally {
				tui.start();
				tui.requestRender(true);
				terminalColors.refresh();
			}
		},
		suspendTerminalAsync,
		onOperatorParked: () => desktopNotifications.approvalParked(),
	});
	const {
		closeOverlay,
		openAskUserOverlayState,
		openTransientAskUserOverlayState,
		openUsageOverlayState,
		openSideQuestionOverlayState,
		openDraftOverlayState,
		startHandoffState,
		openReportState,
		showReportStatusState,
		forgetReportState,
		startFleetRunState,
		openContextViewOverlayState,
		openContextResetOverlayState,
		openThinkingLevelOverlayState,
		openTasksOverlayState,
		openDecisionsOverlayState,
		openMemoryOverlayState,
		openViewOverlayState,
		openModelOverlayState,
		applyModelSessionState,
		openSettingsOverlayState,
		openResumeOverlayState,
		openTreeOverlayState,
		openRewindOverlayState,
		openMessagePickerOverlayState,
		openHelpOverlayState,
		openSkillsHubState,
		openExtensionsOverlayState,
		openInteropOverlayState,
		toggleDispatchBoardOverlay,
	} = overlayLifecycle;

	const dispatchSteering = createDispatchSteering({
		getSelectedRow: () => dispatchBoard.selectedRow(),
		notify,
		abortDispatch: (runId) => deps.dispatch.abort(runId),
		cancelPlan: (rootId) => dispatchBoardStore.plans.cancel(rootId),
		editor,
		closeOverlay,
		requestRender: () => tui.requestRender(),
	});
	const { cancelSelectedDispatch, steerSelectedDispatch } = dispatchSteering;

	const cancelActiveRun = (): void => {
		operatorExtensions?.cancel();
		// The stop holds the queue as separate entries and announces it once the run settles (#447).
		chatRenderer.flush();
		notifications.dismiss("keyboard:escape");
		deps.chat.cancel();
		deps.toolRegistry?.cancelParkedCalls("run cancelled by operator");
		footer.refresh();
		tui.requestRender();
	};

	const startNewSession = async (): Promise<void> => {
		if (!deps.onNewSession) {
			emitCommandNotice(slashRuntime.notice, "error", "new", "session contract unavailable");
			return;
		}
		// A busy /new cancels the run first. Say so, and give back any message typed
		// meanwhile: resetForSession drops the queues, so it vanished silently (p7/A2).
		const wasBusy = deps.chat.isStreaming();
		if (wasBusy) notify("info", "/new: cancelling the active run before starting a new session", "session:new");
		const unsent = wasBusy ? deps.chat.clearQueuedFollowUps() : [];
		const settlement = settleChatBeforeSessionSwitch(deps.chat);
		if (settlement) await settlement;
		unsent.push(...deps.chat.clearQueuedFollowUps());
		deps.onNewSession();
		presentation.resetForNewSession();
		exitSummary.sessionChanged();
		resetTranscript();
		deps.chat.resetForSession(null);
		if (unsent.length > 0) {
			const current = editor.getExpandedText();
			editor.setLiteralText([unsent.join("\n\n"), current].filter((part) => part.trim().length > 0).join("\n\n"));
			notify("info", "a message queued behind the old run was put back in the editor", "session:new");
		}
		footer.refresh();
		tui.requestRender();
	};
	/**
	 * Explicit model-cycle bindings with nothing to step to. The help center documents both
	 * keys, so a keypress that changes no pixel reads as a broken binding rather
	 * than as an empty set; the set itself is chosen under Quick switch in `/settings models`.
	 */
	const announceEmptyScopedSet = (): void => {
		notify(
			"info",
			"scoped models: nothing to cycle to; choose the cycle set under Quick switch in /settings models",
			"scoped-models:empty",
		);
	};
	/**
	 * Ctrl+G d / /background. The dispatch tool owns the conversion and answers with
	 * the line to show, so the refusal a review-gated or compete call returns is
	 * rendered verbatim rather than restated here.
	 */
	const backgroundActiveDispatch = (): void => {
		const outcome = deps.onBackgroundDispatch?.() ?? {
			ok: false,
			message: "background: dispatch backgrounding is unavailable in this session",
		};
		notify(outcome.ok ? "success" : "info", outcome.message, "dispatch:background");
	};
	// Built only when a pane host answered detection, so a session with no
	// panes subscribes to nothing and the bus handlers do not exist at all.
	// The factories arrive from the `--with-panes` composition root (or a
	// test); a plain session loads none of the bridge code.
	const mux = deps.mux;
	const muxBridge =
		mux && mux.mode !== "none" && deps.createMuxBridge
			? deps.createMuxBridge({
					bus: deps.bus,
					mux,
					notificationsPolicy: () => deps.getSettings?.().interface.panes.notifications ?? "failures",
					log: (level, message) => {
						if (level === "warning") notify("warning", message, "mux:bridge");
					},
					notice: (level, text) => appendNotice(level, text, busNoticeSink),
				})
			: null;
	// Another PanCode that opened this one in a pane reaches it here, as a turn on
	// the queue rather than as keys in the terminal.
	const showMachineTurn = (text: string, origin: string): void => {
		chatRenderer.mutate(() => chatPanel.appendUser(text), "user-submit");
		appendOperatorAside(origin, {
			appendReplayBlock: (renderBlock) =>
				chatRenderer.mutate(() => chatPanel.appendReplayBlock(renderBlock), "slash-output"),
			requestRender: () => tui.requestRender(),
		});
		tui.requestRender();
	};
	const peerInbox =
		mux && mux.mode === "guest" && deps.createPeerInbox
			? deps.createPeerInbox({
					bus: deps.bus,
					mux,
					chat: deps.chat,
					stateDir: pancodeStateDir(),
					showTurn: showMachineTurn,
				})
			: null;
	// A detached batch that settles, or stops on a decision for the main agent,
	// after its turn ended starts a turn of its own once the operator is not
	// mid-draft, so its results never wait for someone to type.
	const detachedBatchWake = createDetachedBatchWake({
		openBatches: () => openDetachedBatchViews(deps.dispatch),
		pendingDecisions: () => detachedBatchDecisions(deps.dispatch),
		chat: deps.chat,
		operatorIdle: () =>
			overlayLifecycle.getState() === "closed" &&
			editor.getText().length === 0 &&
			!leaderArmed &&
			!shutdownArmed &&
			!operatorExtensions?.busy &&
			!editorSubmit.hasActiveEditorBash(),
		showTurn: showMachineTurn,
	});
	// The workers dock: the workers dashboard beside PanCode, opened and hidden by
	// the workers key, taken over for one run by `w` in the Fleet Runs board,
	// `/panes show` and the panes tool through the shared operations object.
	const watchPane =
		mux && mux.mode !== "none" && deps.createWatchPane
			? deps.createWatchPane({
					mux,
					getOutputStyle: () => deps.getSettings?.().interface.outputDetail ?? "standard",
					getCwd: () => process.cwd(),
					getWorkersRatio: () => deps.getSettings?.().interface.panes.workers.ratio ?? 0.34,
					getSessionId: () => deps.session?.current()?.id ?? deps.getSessionId?.() ?? null,
					onVisibilityChange: () => {
						presentation.harnessFacts.bump();
						footer.refresh();
						tui.requestRender();
					},
				})
			: null;
	watchPaneRef = watchPane;
	const detachWatchPane = watchPane ? deps.attachWatchPane?.(watchPane) : undefined;
	// The workers key. With a pane host it drives the workers dock the way the
	// files key drives its own, and Alt+W or q pressed inside the
	// dashboard arrive through its tap file. Without one it opens the Fleet Runs
	// board, which `/fleet` and the left arrow on an empty composer also reach.
	const pressWorkersKey = (origin: DockKeyOrigin): void => {
		const workers = watchPane;
		if (!workers || !mux?.available()) {
			if (origin === "composer") toggleDispatchBoardOverlay();
			return;
		}
		void dockKeys.press("workers", {
			single: async () => {
				const result = await workers.toggle();
				if (result.status === "hidden") {
					if (origin === "dock") await mux.focusSelf();
					notify("info", workersDockHiddenNotice(deps.dispatch.snapshot().running.length), "workers:hide");
				} else if (result.status === "unavailable") {
					// A dock that would not open or show (a pane too narrow, a refusing host)
					// falls back to the Fleet Runs board, the workers surface without a dock.
					const fallback =
						origin === "composer" && workers.visibility() !== "visible" && overlayLifecycle.getState() === "closed";
					if (fallback) toggleDispatchBoardOverlay();
					notify("warning", fallback ? `Fleet Runs board shown; ${result.reason}` : result.reason, "workers:refused");
				}
			},
			double: async () => {
				await workers.close();
				await mux.focusSelf();
				notify("info", "workers dock closed", "workers:close");
			},
		});
	};
	// Alt+O from the composer, a focused card, and the workers dock pane: one tier cycle (FX-13).
	const cycleOutputStyle = (): void => {
		const settings = deps.getSettings?.();
		if (!settings || !deps.commitSetting) return;
		presentation.changeOutputStyle(() => {
			const next = structuredClone(settings) as PancodeSettings;
			next.interface.outputDetail = nextOutputStyle(next.interface.outputDetail);
			settingActions.commitSetting?.("interface.outputDetail", next, "session", "keybinding");
		});
		footer.refresh();
	};
	const detachWorkersDockKey = watchPane?.onDockKey((key) => {
		if (key === "tier") {
			cycleOutputStyle();
			return;
		}
		if (key === "key") {
			pressWorkersKey("dock");
			return;
		}
		// q in the dashboard: park it and hand the keyboard back, without arming
		// a double tap on the workers key.
		void watchPane.hide().then(() => mux?.focusSelf());
	});
	// Boot composition per `interface.panes.layout`: `workers` opens the workers
	// dock on its board; `cockpit` adds the files dock. Fire and
	// forget, and only against a live pane host: a boot must never fall through
	// to the in-terminal chooser or block the first paint on socket traffic.
	{
		const bootSettings = deps.getSettings?.();
		const layout = bootSettings?.interface.panes.layout ?? "off";
		if (layout !== "off" && mux?.available()) {
			void watchPane?.ensureOpen();
			if (layout === "cockpit" && bootSettings?.interface.panes.files.enabled) void yaziBridge?.open();
		}
	}
	const selectedWatchableRun = (): { runId: string; agentId: string } | null => {
		if (!watchPane) return null;
		const row = dispatchBoard.selectedRow();
		if (!row || row.plan !== undefined) return null;
		const decision = paneWatchDecision({ source: "workers-view", runStatus: row.status });
		return decision.open ? { runId: row.runId, agentId: row.agentId } : null;
	};
	if (watchPane) {
		dispatchBoard.setWatchable(
			(row) => row.plan === undefined && paneWatchDecision({ source: "workers-view", runStatus: row.status }).open,
		);
	}
	/**
	 * `w` in the workers view. True means the watch pane took the key; false
	 * means panes are off or nothing selected is watchable under the policy.
	 */
	const watchSelectedDispatch = (): boolean => {
		const selected = selectedWatchableRun();
		if (!watchPane || !selected) return false;
		void watchPane.watch(selected.runId).then((result) => {
			if (result.status === "watching") {
				if (result.opened) {
					notify("success", `Watching ${selected.agentId} in a pane`, "panes:watch");
				}
			} else {
				notify("warning", result.reason, "panes:watch");
			}
			tui.requestRender();
		});
		return true;
	};
	/** Arrow keys: the watch pane follows the cursor, but only once it exists. */
	const followBoardSelection = (): void => {
		if (!watchPane?.isOpen()) return;
		const selected = selectedWatchableRun();
		if (selected) watchPane.follow(selected.runId);
	};
	const interactiveSubscriptions = createInteractiveSubscriptions({
		bus: deps.bus,
		agentTraits: (agentId) => deps.agents?.getSpec(agentId)?.traits ?? [],
		supersedeNotices: (scope) => notifications.supersede(scope),
		dismissNotice: (key) => {
			notifications.dismiss(key);
		},
		getSessionId: () => deps.chat.getSessionId(),
		contextResult: (operation) => {
			chatRenderer.mutate(
				() => chatPanel.appendReplayBlock((width) => renderContextOperationResult(operation, width)),
				"context-result",
			);
		},
		readWorkerRunResult: (runId) => {
			const receipt = readWorkerRunResultFacts(runId, deps.stateDir);
			exitSummary.observeRunResult(runId, receipt);
			return receipt;
		},
		refreshFooter: () => footer.refresh(),
		fleetOwnsLiveProgress: () => presentation.fleetOwnsLiveProgress(),
		renderTaskIsland: interactiveTickers.renderTaskIsland,
		renderContextIsland: interactiveTickers.renderContextIsland,
		requestRender: () => tui.requestRender(),
		notify,
		onDispatchSettled: () => {
			desktopNotifications.dispatchSettled();
			detachedBatchWake.poke();
		},
		// The reducer mutates one state object per assignment, so the panel is
		// handed that object rather than a copy: a streamed delta reaches the
		// screen by invalidating a cached render, not by rebuilding the entry.
		applyWorkerState: (state) => chatRenderer.mutate(() => chatPanel.applyWorkerState(state), "worker-state"),
		recordWorkerRun: (fields) => {
			// A `/run` is an operator action that produced durable state, so it
			// opens a session the same way a local `!bash` line does. Persistence
			// is best effort: a failure here costs the block on the next resume,
			// and must not cost the block on screen now.
			try {
				sessionTranscript.ensureSessionForLocalEntry();
				if (!deps.session?.current()) return;
				deps.session.appendEntry({ ...fields, parentTurnId: deps.session.leafId() ?? null });
			} catch {
				// Best effort; the live block already rendered.
			}
		},
		recordWorkerSettled: (fields) => {
			try {
				if (!deps.session?.current()) return;
				deps.session.appendEntry({
					kind: "custom",
					customType: WORKER_SETTLED_ENTRY,
					parentTurnId: deps.session.leafId() ?? null,
					display: false,
					data: fields,
				});
			} catch {
				// Best effort; a resumed card then omits the context fact.
			}
		},
	});
	adoptLiveWorker = (runId) => interactiveSubscriptions.workers.adopt(runId);
	const exitBlocker = (): "editor" | "work" | "settling" | null => {
		if (editor.getText().length > 0) return "editor";
		const queue = deps.chat.queuedMessages();
		if (
			deps.chat.turnPreparation().phase !== "idle" ||
			deps.dispatch.snapshot().running.length > 0 ||
			editorSubmit.hasActiveEditorBash() ||
			operatorExtensions?.busy ||
			queue.steer.length + queue.followUp.length > 0
		)
			return "work";
		if (deps.chat.isStreaming()) return agentRunEnded ? "settling" : "work";
		return null;
	};
	// A Ctrl+D in the settle tail exits once the turn settles instead of being
	// refused with nothing visible left. The bound keeps a stuck settle from
	// holding the exit; the guard runs again afterwards, so the wait never
	// exits past work that started meanwhile.
	let exitAwaitingSettle = false;
	const exitAfterSettle = (): void => {
		if (exitAwaitingSettle) return;
		exitAwaitingSettle = true;
		let bound: ReturnType<typeof setTimeout> | undefined;
		void Promise.race([
			deps.chat.whenSettled(),
			new Promise<void>((resolve) => {
				bound = setTimeout(resolve, 2_000);
				bound.unref?.();
			}),
		]).then(() => {
			clearTimeout(bound);
			exitAwaitingSettle = false;
			const blocker = exitBlocker();
			if (blocker === null) void applicationController.shutdown();
			else if (blocker !== "editor") explainProtectedExit(deps, editorSubmit, operatorExtensions, notify);
		});
	};

	let queueAtDispose: readonly string[] | null = null;
	// What the operator typed, not its expansion; a peer's prompt is not theirs to resend.
	const undeliveredMessages = (): readonly string[] =>
		queueAtDispose ??
		deps.chat
			.queueEntries()
			.filter((entry) => entry.origin === undefined)
			.map((entry) => entry.display?.text ?? entry.text);
	applicationController = createInteractiveInputRuntime({
		tui,
		...extensionPane.inputHooks(() => workspaceSurfaces?.leaderTargets() ?? []),
		hasQueuedMessages: () => {
			const queue = deps.chat.queuedMessages();
			return queue.steer.length + queue.followUp.length > 0;
		},
		explainProtectedExit: () => explainProtectedExit(deps, editorSubmit, operatorExtensions, notify, "Ctrl+C"),
		explainEscapeGuard: () =>
			notifications.add({
				level: "info",
				key: "keyboard:escape",
				text: editorSubmit.hasActiveEditorBash()
					? `Command still going ${GLYPH.sep} Esc again stops it`
					: `Run still going ${GLYPH.sep} Esc again cancels`,
				ttlMs: 2_500,
			}),
		hasActiveEditorBash: () => editorSubmit.hasActiveEditorBash(),
		noteDraftCleared: (undoKey) =>
			notifications.add({
				level: "info",
				key: "keyboard:draft-cleared",
				text: `Draft cleared ${GLYPH.sep} ${undoKey} brings it back`,
				ttlMs: 4_000,
			}),
		explainDraftUnderApproval: (draft) => {
			const notice = slashDraftUnderApprovalNotice(draft);
			if (notice !== null) notify("info", notice, "permission:slash-draft");
		},
		cancelSteerDraft: () => {
			const agent = editor.dropSteerTarget();
			if (agent === null) return false;
			notify(
				"info",
				`Steer to ${agent} not sent. ${editor.getText().length > 0 ? "Your text stays as a draft; Enter now sends it to PanCode." : ""}`.trim(),
				"steer:cancelled",
			);
			tui.requestRender();
			return true;
		},
		explainThinkingUnavailable: () => notify("info", "Thinking is not adjustable on this model", "keyboard:thinking"),
		explainSearchUnavailable: () =>
			notify("info", "PanCode transcript search requires fullscreen; use your terminal's Find", "keyboard:search"),
		keybindings,
		dispatchAction: dispatchInteractiveAction,
		actions: {
			suspendProcess: () => {
				if (process.platform === "win32") {
					notify("info", "Suspend is not supported on Windows.", "keyboard:suspend");
					return;
				}
				// Fullscreen leaves the alternate screen as it found the shell's: stopping
				// otherwise reprints the whole transcript, draft included, into the shell's
				// scrollback on every Ctrl+Z. Inline mode moves below its frame first.
				void suspendTerminalAsync(suspendProcessUntilContinued, tui instanceof TuiAltScreen).then(
					(suspended) => {
						if (!suspended) {
							notify("info", "Ctrl+Z needs PanCode started from an interactive shell with job control", "keyboard:suspend");
						}
					},
					(err: unknown) => {
						notify("error", `Could not suspend: ${err instanceof Error ? err.message : String(err)}`, "keyboard:suspend");
					},
				);
			},
			canExit: () => {
				const blocker = exitBlocker();
				if (blocker === "settling") exitAfterSettle();
				else if (blocker === "work") explainProtectedExit(deps, editorSubmit, operatorExtensions, notify);
				return blocker === null;
			},
			recordFeature,
			openQueueNavigator: () => overlayLifecycle.openQueueNavigatorState(),
			cycleOutputStyle,
			toggleAutonomy: () => {
				const settings = deps.getSettings?.();
				if (!settings || !settingActions.commitSetting) return;
				const next = structuredClone(settings) as PancodeSettings;
				next.safety.autonomy = settings.safety.autonomy === "yolo" ? "default" : "yolo";
				settingActions.commitSetting("safety.autonomy", next, "session", "keybinding");
				footer.refresh();
				tui.requestRender();
			},
			availableThinkingLevels: () => availableInteractiveThinkingLevels(deps),
			onCycleThinking: () => settingActions.onCycleThinking?.(),
			cycleScopedModelForward: () => {
				if (settingActions.onCycleScopedModelForward?.() === false) announceEmptyScopedSet();
			},
			cycleScopedModelBackward: () => {
				if (settingActions.onCycleScopedModelBackward?.() === false) announceEmptyScopedSet();
			},
			backgroundActiveDispatch,
			toggleFilesPane: () => pressFilesKey(deps, notify, dockKeys, "composer"),
			toggleWorkersDock: () => pressWorkersKey("composer"),
		},
		overlay: overlayLifecycle,
		refreshFooter: () => footer.refresh(),
		onLeaderStateChange: (pending) => {
			leaderArmed = pending;
		},
		onShutdownArmedChange: (armed, detail) => {
			const workers = armed ? deps.dispatch.snapshot().running.length : 0;
			shutdownArmed = !armed
				? false
				: [
						// The draft stays while the window is open; quitting prints it and saves nothing.
						...(detail?.draftKept === true ? ["draft kept, printed on quit"] : []),
						// Quitting drains the fleet, which is not obvious from a composer with nothing in it.
						...(workers > 0 ? [`${workers} worker${workers === 1 ? "" : "s"} will stop`] : []),
						`Ctrl+C again to quit${detail ? ` (${detail.secondsLeft}s)` : ""}`,
					].join(` ${GLYPH.sep} `);
			// The footer caches its composed text, and arming only requested a frame.
			// Without a recompose the hint showed when some other refresh happened
			// to land and the expiry left it standing, so it was never tied to the
			// double-tap window it announces.
			footer.refresh();
		},
		dispatchBoard: {
			selectPrevious: () => {
				dispatchBoard.selectPrevious();
				followBoardSelection();
			},
			selectNext: () => {
				dispatchBoard.selectNext();
				followBoardSelection();
			},
			toggleDetail: () => dispatchBoard.toggleDetail(),
			scrollDetail: (direction) => dispatchBoard.scrollDetail(direction),
			// Without this the Esc router read every detail as closed, so the rail's `[Esc] hide` closed the whole board.
			detailExpanded: () => dispatchBoard.detailExpanded(),
			cancelArmed: () => dispatchBoard.cancelArmed(),
			armCancel: (on) => dispatchBoard.armCancel(on),
		},
		watchSelectedDispatch,
		steerSelectedDispatch,
		cancelSelectedDispatch,
		// The same Esc and Ctrl+C that stop a local command stop an attachment read.
		cancelActiveEditorBash: () => editorSubmit.cancelActiveEditorBash() || cancelSubmitExpansions(),
		isStreaming: () =>
			deps.chat.isStreaming() ||
			deps.chat.turnPreparation().phase !== "idle" ||
			(operatorExtensions?.busy ?? false) ||
			(upgradeFlow?.isRunning() ?? false),
		cancelActiveRun,
		editor,
		editorSubmit,
		requestRender: () => tui.requestRender(),
		// These are the operator's dismissals; dismissing the report offer is a no to its fingerprint.
		notifications: {
			...notifications,
			dismiss: (idOrKey) => {
				const offer = notifications.list().find((entry) => entry.key === REPORT_OFFER_NOTICE_KEY);
				if (offer !== undefined && (offer.id === idOrKey || offer.key === idOrKey)) reportOffers?.decline();
				return notifications.dismiss(idOrKey);
			},
			dismissAll: () => {
				updateMonitor?.dismiss();
				if (notifications.list().some((entry) => entry.key === REPORT_OFFER_NOTICE_KEY)) reportOffers?.decline();
				notifications.dismissAll();
			},
		},
		shutdown: {
			stopTickers: presentation.stopTickers,
			disposeInteractiveTickers: interactiveTickers.dispose,
			disposeBeforeStatus: presentation.disposeBeforeStatus,
			disposeProjectionPrimary: eventProjection.disposePrimary,
			disposeStatus: presentation.disposeStatus,
			disposeProjectionRemaining: eventProjection.disposeRemaining,
			disposeOverlay: overlayLifecycle.dispose,
			stopAgentProgress: agentProgress.stop,
			disposeChat: () => {
				// Disposing empties the queues, and the exit screen still has to name what was in them.
				queueAtDispose = undeliveredMessages();
				deps.chat.dispose();
			},
			disposeSubscriptions: () => {
				clearTimeout(updateTimer);
				updateAbort.abort();
				clearTimeout(operatorTimer);
				for (const unsubscribe of operatorSubscriptions) unsubscribe();
				void ambientSurfaces?.dispose();
				devSession?.dispose();
				void operatorExtensions?.dispose();
				loopJobs?.dispose();
				terminalColors.dispose();
				detachYaziBridge?.();
				yaziBridge?.dispose();
				detachWorkersDockKey?.();
				detachWatchPane?.();
				watchPane?.dispose();
				muxBridge?.dispose();
				peerInbox?.dispose();
				attachController.dispose();
				detachedBatchWake.dispose();
				interactiveSubscriptions.dispose();
				exitSummary.dispose();
				steerReceipts.dispose();
				flushHarnessProfile();
			},
		},
		beforeStopUi: (() => {
			let settlement: Promise<void> | null = null;
			return () => {
				settlement ??= chatRenderer
					.flushAndCommit("teardown")
					.finally(() => chatRenderer.dispose())
					.then(async () => {
						// The regular screen's last frame stays in scrollback above the exit summary.
						if (releaseRegularDock(presentation.root)) await shell.commitCurrentFrame(300);
					});
				return settlement;
			};
		})(),
		stopUi: () => {
			removeDiagnosticSink();
			if (lease) void lease.close();
			else shell.stop();
		},
		cancelParkedCalls: (reason) => deps.toolRegistry?.cancelParkedCalls(reason),
		onCleanExit: (trigger) => {
			if (sessionFile && !getTerminationCoordinator().hasExitHandoff()) {
				sessionFile.record(trigger === "interrupt" ? "interrupted" : "quit", 0);
			}
			const ui = deps.getSettings?.().interface;
			const snapshot = exitSummary.snapshot();
			// A terminal may take a column back (a scrollbar) once the alternate screen closes, after the summary has
			// read the old width, so a fullscreen exit leaves the last column free (tui-verify 17).
			const exitColumns = Math.max(1, (process.stdout.columns ?? 80) - (tui.mode === "fullscreen" ? 1 : 0));
			const lines =
				snapshot === null
					? renderExitWithoutConversation(ui?.exitSummary ?? "on", process.stdout.isTTY === true)
					: renderExitSummary(
							snapshot,
							ui?.exitSummary ?? "on",
							exitColumns,
							process.stdout.isTTY === true,
							ui?.outputDetail ?? "standard",
							process.stdout.rows ?? 48,
						);
			if (lines.length === 0) return;
			const text = `${lines.join("\n")}\n`;
			process.stdout.write(text);
			// In PanCode's private pane host this pane closes with the workspace, so the
			// exit marker also carries the summary to the operator's own terminal.
			holdExitSummaryForLauncher(text);
		},
		onShutdown: async () => {
			// The terminal is already stopped here and the domains have not, so this
			// is the one moment a plain line about the pane host can both be read
			// and still see the registry that shutdown is about to forget.
			const leftBehind = mux && mux.mode !== "none" && mux.available() ? describePanesLeftBehind(mux) : null;
			if (leftBehind !== null) process.stderr.write(`${leftBehind}\n`);
			try {
				if (dumpInputWedgeOnTerminate) process.off("SIGTERM", dumpInputWedgeOnTerminate);
				await operatorExtensions?.dispose();
				// Finish terminal release before the exit handoff can start another reader.
				if (lease) await lease.close();
				else await shell.settle();
				await deps.onShutdown();
			} finally {
				if (lease) await lease.close();
				else await shell.settle();
			}
		},
		registerInputListener: (listener) => {
			const handleInput: typeof listener = (data) => {
				if (arcade?.isOpen()) {
					arcade.handleInput(data);
					return { consume: true };
				}
				lastOperatorInputAt = Date.now();
				reportOffers?.poke();
				const overlayState = overlayLifecycle.getState();
				try {
					return listener(data);
				} catch (error) {
					if (overlayState === "closed") throw error;
					overlayLifecycle.closeOverlay();
					notify(
						"error",
						`Overlay closed after an input error: ${error instanceof Error ? error.message : String(error)}`,
						"overlay:input-error",
					);
					return { consume: true };
				}
			};
			if (lease) lease.registerApplicationInput(handleInput);
			else tui.setApplicationInputPolicy(handleInput);
		},
		...(lease
			? {
					signals: lease.applicationSignals,
					// The lease registered its exactly-once drain before hydration.
					registerTerminalTeardown: () => {},
				}
			: {}),
		...(renderTrace
			? {
					onInputIngress: (action, data) =>
						renderTrace.recordInputIngress(action, Buffer.byteLength(data, "utf8"), action !== "no-visual-change"),
				}
			: {}),
	});

	const operatorSubscriptions = operatorExtensions
		? (["session.started", "session.ended", "session.parked", "session.reattached", "session.turn_switched"] as const)
				.map((channel) =>
					deps.bus.subscribe(channel, () => operatorExtensions.invalidateContext(channel === "session.reattached")),
				)
				.concat(subscribeExtensionObservations(deps.bus, (observation) => operatorExtensions.observeV2(observation)))
		: [];
	scheduleOperatorMaintenance = () => {
		clearTimeout(operatorTimer);
		const delay = operatorExtensions?.maintenanceDelayMs;
		if (delay === undefined || delay === null) return;
		operatorTimer = setTimeout(() => {
			operatorExtensions?.maintenance();
			scheduleOperatorMaintenance();
		}, delay);
		operatorTimer.unref();
	};
	getTerminationCoordinator().onDrain(
		async () => {
			clearTimeout(operatorTimer);
			for (const unsubscribe of operatorSubscriptions) unsubscribe();
			deps.runtimeHooks?.bind(null);
			devSession?.dispose();
			await operatorExtensions?.dispose();
			workspaceSurfaces?.dispose();
			await ambientSurfaces?.dispose();
		},
		{ timeoutMs: 6500 },
	);
	if (lease) {
		const adopted = lease.adopt({
			root: presentation.root,
			editorChrome: presentation.editorChrome,
			admitSubmission: (submission) => editorSubmit.admitCapturedText(submission.rawText, lease.abortSignal),
			undeliveredMessages,
			notice: (text) => {
				notifications.add({ level: "warning", text, key: "build:missing-module" });
				tui.requestRender();
			},
			onHydratedFrame: (frameId, interactivity) => {
				void hydrateHarnessProfile();
				deps.onHydratedFrameCommit?.(frameId, interactivity);
			},
		});
		if (!adopted) void applicationController.shutdown();
	} else {
		void shell.nextCommittedFrame().then(() => {
			void hydrateHarnessProfile();
		});
	}

	const unregisterReportReview = deps.registerReportReviewOpener?.((draftId) => {
		notifications.add({ level: "info", text: `PanCode drafted a report; /report send ${draftId} reviews it` });
		tui.requestRender();
	});
	if (unregisterReportReview) getTerminationCoordinator().onDrain(unregisterReportReview);
	void import("../domains/report/extension.js")
		.then(({ startReportOfferWatcher }) => {
			if (getTerminationCoordinator().getPhase() !== "idle") return;
			reportOffers = startReportOfferWatcher({
				stateDir: deps.stateDir,
				version: readPancodeVersion(),
				sessionId: () => deps.session?.current()?.id ?? null,
				offers: () => deps.getSettings?.().report?.offers ?? "ask",
				turnRunning: () => deps.chat.isStreaming() || deps.chat.turnPreparation().phase !== "idle",
				// At yolo the operator may have walked away; an offer waits for a key pressed in the last two minutes.
				attended: () =>
					deps.getSettings?.().safety.autonomy !== "yolo" || Date.now() - lastOperatorInputAt < REPORT_OFFER_AWAY_MS,
				show: (candidate) => {
					// An offer and a tip never stand after the same turn: the offer takes the tip's place.
					for (const entry of notifications.list()) if (entry.key?.startsWith("guidance.")) notifications.dismiss(entry.id);
					notifications.add({
						level: "info",
						text: candidate.text,
						key: REPORT_OFFER_NOTICE_KEY,
						ttlMs: REPORT_OFFER_TTL_MS,
					});
					tui.requestRender();
				},
			});
			getTerminationCoordinator().onDrain(() => reportOffers?.dispose());
		})
		.catch(() => {
			// The offer is optional; a watcher that cannot load leaves the session as it was.
		});

	const startupAbort = new AbortController();
	// A startup that never reaches its reload must not park hook calls forever.
	startupAbort.signal.addEventListener("abort", () => finishExtensionStartup(), { once: true });
	if (!operatorExtensions) finishExtensionStartup();
	const startupWorkspace = process.cwd();
	const startupSession = deps.session?.current() ?? null;
	let startupTimer: ReturnType<typeof setTimeout> | undefined;
	const prepareStartup = () => {
		const startupConfiguration = JSON.stringify(deps.getSettings?.());
		const isBusy = () =>
			startupAbort.signal.aborted ||
			process.cwd() !== startupWorkspace ||
			JSON.stringify(deps.getSettings?.()) !== startupConfiguration ||
			overlayLifecycle.getState() !== "closed" ||
			editorSubmit.hasActiveEditorBash() ||
			(deps.session?.current()?.id ?? null) !== (startupSession?.id ?? null) ||
			editor.getText().length > 0 ||
			deps.chat.isStreaming() ||
			deps.chat.turnPreparation().phase !== "idle" ||
			deps.dispatch.snapshot().running.length > 0;
		if (isBusy()) return;
		void deps.interop?.detect({ cwd: startupWorkspace }).catch(() => {});
		const settings = deps.getSettings?.();
		if (settings)
			void import("./startup-background.js")
				.then(({ prepareWorkerTargets }) =>
					prepareWorkerTargets({
						settings,
						providers: deps.providers,
						signal: startupAbort.signal,
						isBusy,
						callJournal: (targetId, runtimeId, pricedBy) => {
							const acquire = deps.telemetry.acquireTelemetrySession;
							if (!acquire) return undefined;
							return {
								origin: startupSession ?? null,
								acquire,
								role: "prewarm",
								targetId,
								runtimeId,
								pricedBy,
							};
						},
					}),
				)
				.catch(() => {});
	};
	void shell.nextCommittedFrame().then((frame) => {
		if (startupAbort.signal.aborted) return;
		// One task per loop iteration, so a key typed after the first frame waits for one of them at most.
		const afterPaint = immediateSequence();
		// The startup reload starts operator extension runtimes and commits the
		// next extension and hook generation, walking every installed plugin
		// again. Boot already committed a paired generation from the same
		// inventory, so running it after the first committed frame only starts
		// runtimes one frame later and takes the walk off the path to that frame.
		// A shell that reports no frames still reloads.
		if (operatorExtensions)
			afterPaint(() => {
				if (startupAbort.signal.aborted) return;
				// Dev copies are taken before the startup reload lists packages.
				devSession?.start();
				void operatorExtensions.reload("startup").finally(finishExtensionStartup);
			});
		if (deps.opensResumePicker)
			afterPaint(() => {
				if (!startupAbort.signal.aborted) openResumeOverlayState();
			});
		if (frame === null) return;
		// Project agents and playbooks load without trust; a copy that replaces
		// the operator's or a built-in one by name is said once, after paint.
		afterPaint(() => {
			if (startupAbort.signal.aborted) return;
			const shadows = projectShadowNotice(process.cwd());
			if (shadows !== null) notify("warning", shadows, "project-shadow");
		});
		// Read only the saved target snapshot after paint; never probe for upgrade advice (#416).
		afterPaint(() => {
			if (startupAbort.signal.aborted) return;
			void Promise.all([
				import("../domains/providers/model-recency.js"),
				import("../domains/providers/target-model-cache.js"),
			])
				.then(([{ newerModelNotice }, { readTargetModelSnapshot }]) => {
					if (startupAbort.signal.aborted) return;
					const settings = deps.getSettings?.();
					const model = settings?.chat.model;
					const target = settings?.targets.find((entry) => entry.id === settings.chat.target);
					if (!model || !target) return;
					const snapshot = readTargetModelSnapshot(target);
					if (!snapshot) return;
					const notice = newerModelNotice(target.id, model, snapshot.models, snapshot.modelCreatedAt);
					if (notice !== null) appendNotice("info", notice, busNoticeSink);
				})
				.catch(() => {
					// Upgrade advice is optional when cached metadata cannot be read (#416).
				});
		});
		// A session started at yolo before the operator ever accepted it holds at
		// default and asks once, now that the screen can show the card (#407).
		if (deps.yoloHeldAtBoot === true && yoloActivation !== undefined) {
			afterPaint(() => {
				if (!startupAbort.signal.aborted) void yoloActivation.requestHeldAtBoot();
			});
		}
		// A second terminal in this folder gets its own session; say so when another
		// one is live here, so a shared folder never reads as a shared session (#420).
		afterPaint(() => {
			if (startupAbort.signal.aborted) return;
			void import("../domains/session/history.js")
				.then(({ liveSessionsElsewhere }) => {
					if (startupAbort.signal.aborted) return;
					const currentId = deps.session?.current()?.id;
					const live = liveSessionsElsewhere(process.cwd()).filter((session) => session.id !== currentId);
					const first = live[0];
					if (!first) return;
					appendNotice(
						"info",
						`${live.length === 1 ? "Another PanCode session is" : `${live.length} other PanCode sessions are`} open in this folder. This terminal keeps its own conversation, and ${live.length === 1 ? "both" : "all of them"} work on the same files.`,
						busNoticeSink,
					);
				})
				// The notice is advisory; a failed scan leaves the transcript as it was.
				.catch(() => {});
		});
		// Docks are prepared hidden only now that the first frame is out: pane
		// host traffic and a Yazi boot never sit in front of the paint.
		// A failure stays silent; the key that wants the dock finds it absent and
		// reports the reason itself.
		afterPaint(() => {
			if (startupAbort.signal.aborted) return;
			const settings = deps.getSettings?.();
			void (async () => {
				// Parked orphans first: a crashed session's hidden pane must not keep
				// running beside the pane this session is about to prepare.
				await mux?.reapParkedOrphans().catch(() => 0);
				if (startupAbort.signal.aborted) return;
				if (yaziBridge && mux?.available() && settings?.interface.panes.files.enabled) {
					void yaziBridge.open({ hidden: true }).catch(() => undefined);
				}
			})();
		});
		if (process.env.PANCODE_UPDATE_CHECK !== "0" && !process.env.NO_UPDATE_NOTIFIER && !process.env.CI) {
			// No import, disk probe, subprocess or registry request belongs on the boot path.
			const runningVersion = readPancodeVersion();
			updateTimer = setTimeout(() => {
				if (updateAbort.signal.aborted) return;
				// The reply check reads only reports whose reporter ticked it, at most once a day (R-14).
				void import("../domains/report/index.js")
					.then(({ runReplyCheck }) => runReplyCheck(deps.stateDir))
					.then((lines) => {
						if (updateAbort.signal.aborted) return;
						for (const [index, text] of lines.entries())
							notifications.add({ level: "info", key: `report:reply:${index}`, text });
					})
					.catch(() => {});
				void import("./update-monitor.js")
					.then(({ startUpdateMonitor }) => {
						if (updateAbort.signal.aborted) return;
						updateMonitor = startUpdateMonitor({
							runningVersion,
							signal: updateAbort.signal,
							autoUpdate: () => deps.getSettings?.().interface.autoUpdate ?? true,
							onDeferredUpdate: (start) => {
								armDeferredUpdate(start);
							},
							onChange: () => {
								footer.refresh();
								tui.requestRender();
							},
							isIdle: () => {
								const queue = deps.chat.queuedMessages();
								return (
									overlayLifecycle.getState() === "closed" &&
									editor.getText().length === 0 &&
									!leaderArmed &&
									!shutdownArmed &&
									!operatorExtensions?.busy &&
									!(upgradeFlow?.isRunning() ?? false) &&
									!editorSubmit.hasActiveEditorBash() &&
									!deps.chat.isStreaming() &&
									deps.chat.turnPreparation().phase === "idle" &&
									deps.dispatch.snapshot().running.length === 0 &&
									queue.steer.length + queue.followUp.length === 0 &&
									notifications.count() === 0
								);
							},
						});
					})
					.catch(() => {});
			}, 5000);
			updateTimer.unref();
		}
		// Pay the transcript renderers' first-use cost now, between the hydrated
		// frame and the first answer, rather than in the middle of that answer.
		afterPaint(() => {
			if (!startupAbort.signal.aborted && !deps.chat.isStreaming()) warmTranscriptRender(terminal.columns);
		});
		startupTimer = setTimeout(prepareStartup, 1000);
		startupTimer.unref();
	});

	removeDiagnosticSink = installDiagnosticSink((text, level) => {
		const message = text.trim();
		if (message) notify(level, message, `diagnostic:${message}`);
	});
	try {
		return await applicationController.run;
	} finally {
		clearTimeout(updateTimer);
		updateAbort.abort();
		clearTimeout(startupTimer);
		startupAbort.abort();
		removeDiagnosticSink();
	}
}
