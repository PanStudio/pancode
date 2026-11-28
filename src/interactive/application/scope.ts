// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The state one `createInteractiveApplication` call shares across its stages. Fields are read where
 * they are used, never copied, so every stage sees the current value; a binding a stage reads before
 * the stage that builds it runs is a getter, read at call time, and each stage's output is a getter.
 */

import type { PanesWatchController } from "../../domains/mux/operations.js";
import type { ChatLoopEvent } from "../../session-control/chat-loop.js";
import type { WorkerEntryState } from "../../session-control/worker-stream.js";
import type { ApplicationController } from "../application-controller.js";
import type { ArcadeSession } from "../arcade-overlay.js";
import type { createDetachedBatchWake } from "../detached-batch-wake.js";
import type { EditorSubmitController } from "../editor-submit.js";
import type { createExitSummaryCollector } from "../exit-summary-collector.js";
import type { InteractiveDeps } from "../interactive-deps.js";
import type { InteractivePresentation } from "../interactive-presentation.js";
import type { createProcessInteractiveShell } from "../interactive-shell.js";
import type { InteractiveSlashRuntime } from "../interactive-slash-runtime.js";
import type { OverlayLifecycleController } from "../overlay-lifecycle.js";
import type { createSessionFileRecorder } from "../session-file.js";
import type { SessionTranscript } from "../session-transcript.js";
import type { TerminalLease } from "../terminal-lease.js";
import type { WorkspaceFacts } from "../workspace-facts.js";
import type { createAppExtensions } from "./extensions.js";
import type { createAppPresentation } from "./presentation.js";
import type { createAppProjection } from "./projection.js";

type ApplicationShell = ReturnType<typeof createProcessInteractiveShell>;

export interface ApplicationScope {
	readonly deps: InteractiveDeps;
	readonly terminal: ApplicationShell["terminal"];
	readonly tui: ApplicationShell["tui"];
	readonly shell: ApplicationShell;
	readonly lease: TerminalLease | undefined;
	readonly visibleEventIngress: WeakMap<
		object,
		{ sequence: number; traceSequence: number; generation: number; ingressAt: number }
	>;
	readonly workspaceFacts: WorkspaceFacts;
	readonly sessionTranscript: SessionTranscript;
	readonly readStructuredEntries: SessionTranscript["readStructuredEntries"];
	readonly recordChatEventIngress: (event: ChatLoopEvent) => void;
	readonly exitSummary: ReturnType<typeof createExitSummaryCollector>;
	readonly sessionFile: ReturnType<typeof createSessionFileRecorder> | null;
	readonly refreshLiveWorkspaceGit: WorkspaceFacts["refreshLiveWorkspaceGit"];
	refreshPresentationFooter: () => void;

	/**
	 * Ctrl+G armed the leader and is waiting for the next key. Owned here because
	 * the footer reads it and the input runtime that flips it is built later.
	 */
	leaderArmed: boolean;
	/**
	 * A Ctrl+C armed the double tap and its APPLICATION_DOUBLE_TAP_MS (3 s) window is still open. Owned
	 * here for the same reason as the leader flag above.
	 */
	/** False, or the armed line the footer shows while a second Ctrl+C would quit. */
	shutdownArmed: string | false;
	updateTimer: ReturnType<typeof setTimeout> | undefined;
	updateMonitor: ReturnType<typeof import("../update-monitor.js").startUpdateMonitor> | undefined;
	upgradeFlow: ReturnType<typeof import("../interactive-upgrade.js").createInteractiveUpgradeFlow> | undefined;
	refreshOperatorUi: () => void;
	scheduleOperatorMaintenance: () => void;
	operatorTimer: ReturnType<typeof setTimeout> | undefined;
	finishExtensionStartup: () => void;
	lastSlashCommand: string | null;
	// The worker fold is built with the subscriptions below; a replay before then has no live run to adopt.
	adoptLiveWorker: (runId: string) => WorkerEntryState | undefined;
	watchPaneRef: PanesWatchController | null;
	// The arcade egg owns every key while it is open; closing it hands the TUI back as it was. An approval or an
	// ask_user card puts it away with the board kept, and the trigger phrase brings it back where it stopped.
	arcade: ArcadeSession | null;

	readonly overlayLifecycle: OverlayLifecycleController;
	readonly keybindings: InteractivePresentation["keybindings"];
	readonly chatPanel: InteractivePresentation["chatPanel"];
	readonly notifications: InteractivePresentation["notifications"];
	readonly notify: InteractivePresentation["notify"];
	readonly editor: InteractivePresentation["editor"];
	readonly chatRenderer: InteractivePresentation["chatRenderer"];
	readonly slashRuntime: InteractiveSlashRuntime;
	readonly editorSubmit: EditorSubmitController;
	readonly interactiveRestart: (continuation?: string, chain?: number) => void;
	readonly showMachineTurn: (text: string, origin: string) => void;
	readonly watchPane: PanesWatchController | null;

	readonly appExtensions: ReturnType<typeof createAppExtensions>;
	readonly appPresentation: ReturnType<typeof createAppPresentation>;
	readonly applicationController: ApplicationController;
	readonly detachedBatchWake: ReturnType<typeof createDetachedBatchWake>;
	readonly appProjection: ReturnType<typeof createAppProjection>;
}
