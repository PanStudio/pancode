// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The interactive application's presentation stage: the project trust card, the presentation and its
 * parts, the setting actions, the yazi bridge, the notice sinks and the attach controller.
 */

import { openDetachedBatchViews, uncollectedFleetRootViews } from "../../domains/dispatch/nudges/dispatch-nudge.js";
import { type PromptRef, promptRefs } from "../../domains/extensions/operator-commands.js";
import { setDiffusionFramesEnabled } from "../../engine/apis/diffusion-frames.js";
import { createAgentProgress } from "../../engine/tui.js";
import { createDockKeyGate } from "../../lib/panes/dock-keys.js";
import { reportLoopChanges } from "../../session-control/loop-command.js";
import { createAttachController } from "../attach-host.js";
import { appendNotice, TURN_TIMING_ENTRY } from "../command-output.js";
import { createInteractiveDesktopNotifications } from "../footer/notifications.js";
import type { InteractiveDeps } from "../interactive-deps.js";
import { pressFilesKey } from "../interactive-dock-keys.js";
import { createInteractivePresentation } from "../interactive-presentation.js";
import { createProjectTrustSession } from "../project-trust-session.js";
import { hydrateResumedSessionPresentation } from "../resumed-session-presentation.js";
import { createStaleBuildNotice } from "../stale-build.js";
import { followTerminalColors } from "../terminal-color-follow.js";
import { createYoloActivation } from "../yolo-activation.js";
import type { ApplicationScope } from "./scope.js";

function livePrompts(resources: InteractiveDeps["resources"]): PromptRef[] {
	return promptRefs(resources?.promptsForDisplay(process.cwd()).items ?? []);
}

export function createAppPresentation(scope: ApplicationScope) {
	const {
		deps,
		terminal,
		tui,
		shell,
		lease,
		visibleEventIngress,
		workspaceFacts,
		sessionTranscript,
		readStructuredEntries,
	} = scope;
	const { operatorExtensions, workspaceSurfaces } = scope.appExtensions;
	// The in-session trust card: `/trust`, a `/reload` that finds new project configuration, and the header reminder.
	const projectTrust = createProjectTrustSession({
		cwd: () => process.cwd(),
		openCard: (model, done) => scope.overlayLifecycle.openProjectTrustState(model, done),
		restart: () => scope.interactiveRestart(),
		notice: (level, text) => notify(level === "warn" ? "warning" : "info", text, "project-trust"),
		onChange: () => tui.requestRender(),
	});
	const presentation = createInteractivePresentation({
		adoptLiveWorker: (runId) => scope.adoptLiveWorker(runId),
		getLastCommand: () => scope.lastSlashCommand,
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
		getLifecycleHint: () => scope.updateMonitor?.text() ?? null,
		getLeaderArmed: () => scope.leaderArmed,
		extensionCommands: () => operatorExtensions?.commands(livePrompts(deps.resources)) ?? [],
		...(workspaceSurfaces ? { workspaceSurfaces } : {}),
		// Extension statuses reach the footer once, through the workspace surfaces' status facts, which
		// also drop an owner name the text repeats. A second feed here printed each one twice (tui-verify 16).
		getShutdownArmed: () => scope.shutdownArmed,
		isAwaitingApproval: () => scope.overlayLifecycle?.getState() === "permission-confirm",
		getOverlayState: () => scope.overlayLifecycle?.getState() ?? "closed",
		isWatchPaneVisible: () => scope.watchPaneRef?.visibility() === "visible",
		getPermissionInspection: () => {
			if (scope.overlayLifecycle === undefined || scope.overlayLifecycle === null) return "none";
			if (!scope.overlayLifecycle.canInspectMutation()) return "none";
			return scope.overlayLifecycle.isInspectingMutation() ? "open" : "closed";
		},
		getPermissionTerms: () => (scope.overlayLifecycle?.isShowingPermissionTerms() === true ? "open" : "closed"),
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
					ask: (questions, options) => scope.overlayLifecycle.openTransientAskUserOverlayState(questions, options),
					prepareScreen: () => {
						const state = scope.overlayLifecycle.getState();
						if (state !== "closed" && state !== "ask-user") scope.overlayLifecycle.closeOverlay();
					},
					notify: (level, text, key) => notify(level, text, key),
					afterCommit: () => {
						presentation.announceSettingChanges();
						if (scope.watchPane?.refreshPresentation?.() === false)
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
	scope.refreshPresentationFooter = () => footer.refresh();
	scope.refreshOperatorUi = () => {
		scope.scheduleOperatorMaintenance();
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
		getOpenBatches: () => [...openDetachedBatchViews(deps.dispatch), ...uncollectedFleetRootViews(deps.fleetRuns)],
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
		cards: () => scope.overlayLifecycle.permissionCards(),
		notice: (level, text) => appendNotice(level, text, busNoticeSink),
		showTurn: (text, origin) => scope.showMachineTurn(text, origin),
	});

	return {
		projectTrust,
		presentation,
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
		yoloActivation,
		settingActions,
		dockKeys,
		yaziBridge,
		detachYaziBridge,
		agentProgress,
		terminalColors,
		staleBuildNotice,
		desktopNotifications,
		busNoticeSink,
		loopJobs,
		attachController,
	};
}
