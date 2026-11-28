// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The state one `createInteractiveApplication` call shares across its stages. Fields are read where
 * they are used, never copied, so every stage sees the current value; a binding a stage reads before
 * the stage that builds it runs is a getter, read at call time, and each stage's output is a getter.
 */

import type { EditorSubmitController } from "../editor-submit.js";
import type { InteractiveDeps } from "../interactive-deps.js";
import type { InteractivePresentation } from "../interactive-presentation.js";
import type { createProcessInteractiveShell } from "../interactive-shell.js";
import type { InteractiveSlashRuntime } from "../interactive-slash-runtime.js";
import type { OverlayLifecycleController } from "../overlay-lifecycle.js";
import type { createAppExtensions } from "./extensions.js";

type ApplicationShell = ReturnType<typeof createProcessInteractiveShell>;

export interface ApplicationScope {
	readonly deps: InteractiveDeps;
	readonly terminal: ApplicationShell["terminal"];
	readonly tui: ApplicationShell["tui"];

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

	readonly overlayLifecycle: OverlayLifecycleController;
	readonly keybindings: InteractivePresentation["keybindings"];
	readonly chatPanel: InteractivePresentation["chatPanel"];
	readonly notifications: InteractivePresentation["notifications"];
	readonly notify: InteractivePresentation["notify"];
	readonly editor: InteractivePresentation["editor"];
	readonly chatRenderer: InteractivePresentation["chatRenderer"];
	readonly slashRuntime: InteractiveSlashRuntime;
	readonly editorSubmit: EditorSubmitController;

	readonly appExtensions: ReturnType<typeof createAppExtensions>;
}
