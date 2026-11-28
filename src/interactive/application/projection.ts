// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The interactive application's projection stage: the chat event projection, the tool registry and
 * interop surface, submit expansions, the arcade egg and the interactive restart.
 */

import { GLYPH } from "../../core/glyphs.js";
import { scheduleHarnessFeature } from "../../core/harness-profile.js";
import { firePendingModelRestart } from "../../core/restart-request.js";
import { getTerminationCoordinator } from "../../core/termination.js";
import { isArcadeTrigger } from "../../domains/session/easter-eggs.js";
import { ARCADE_PAUSED_NOTICE, openArcadeOverlay } from "../arcade-overlay.js";
import { appendNotice } from "../command-output.js";
import { dockTop } from "../dock.js";
import { expandInteractiveSubmitAsync, type InteractiveSubmitExpansion } from "../interactive-deps.js";
import { createInteractiveEventProjection } from "../interactive-event-projection.js";
import { createInteractiveRestart, interactiveRestartBusyReason } from "../interactive-restart.js";
import { interopOverlaySurface } from "../overlays/interop.js";
import { processAutoPacingAllowed } from "../stream-pacing-policy.js";
import type { ApplicationScope } from "./scope.js";

export function createAppProjection(scope: ApplicationScope) {
	const { deps, terminal, tui, shell, exitSummary, sessionFile, recordChatEventIngress, refreshLiveWorkspaceGit } =
		scope;
	const { operatorExtensions, turnUsage, turnObservations, devSession } = scope.appExtensions;
	const {
		keybindings,
		editor,
		notify,
		statusController,
		presentation,
		chatRenderer,
		followUpQueuePanel,
		agentProgress,
		desktopNotifications,
		staleBuildNotice,
		footer,
		notifications,
		busNoticeSink,
	} = scope.appPresentation;
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
		isAskUserWaiting: () => scope.overlayLifecycle.isAskUserWaiting(),
		closeAskUserSession: () => scope.overlayLifecycle.closeAskUserSession(),
		resetAskUserCancellation: () => scope.overlayLifecycle.resetAskUserCancellation(),
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
			scope.detachedBatchWake.poke();
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
		refreshSettingsOverlay: () => scope.overlayLifecycle.refreshSettingsOverlay(),
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
		if (feature.startsWith("/")) scope.lastSlashCommand = feature;
		else if (feature.startsWith("key:")) scope.lastSlashCommand = null;
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
	const arcadeNeedsOperator = (): boolean =>
		scope.overlayLifecycle?.getState() === "permission-confirm" || dockTop(tui)?.frame.dockAwaitingInput?.() === true;
	const noticeArcadePaused = (): void => {
		notifications.add({ level: "info", key: "arcade:paused", text: ARCADE_PAUSED_NOTICE, ttlMs: 6_000 });
	};
	const openArcadeEgg = (text: string): boolean => {
		if (!isArcadeTrigger(text) || scope.arcade?.isOpen()) return false;
		if (scope.arcade?.isPaused()) {
			if (!scope.arcade.resume())
				notifications.add({
					level: "info",
					key: "arcade:paused",
					text: "Ms. PanCode waits until PanCode's question is answered",
					ttlMs: 4_000,
				});
			return true;
		}
		scope.arcade = openArcadeOverlay(tui, { needsOperator: arcadeNeedsOperator, onPause: noticeArcadePaused });
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
				editorBash: scope.editorSubmit.hasActiveEditorBash(),
				reloading: deps.reloadClasses?.active === true,
				shuttingDown: scope.shutdownArmed !== false || getTerminationCoordinator().getPhase() !== "idle",
			}),
		settle: () => deps.chat.whenSettled(),
		armHandoff: () => deps.armRestartHandoff?.(),
		shutdown: () => scope.applicationController.shutdown(),
		notify,
	});

	return {
		eventProjection,
		toolRegistry,
		interopSurface,
		recordFeature,
		expandSubmitCancellable,
		cancelSubmitExpansions,
		noticeArcadePaused,
		openArcadeEgg,
		interactiveRestart,
	};
}
