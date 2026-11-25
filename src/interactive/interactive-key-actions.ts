// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** Keybinding dispatch: which action a matched key runs, and the harness feature it records. */
import type { PancodeKeybinding } from "../domains/config/keybindings.js";

export interface KeyBindingDeps {
	/**
	 * Keybinding lookup injected by startInteractive. Defaults come from
	 * PANCODE_KEYBINDINGS; user overrides from settings.interface.keybindings. Tests may
	 * substitute a narrower matcher via createKeybindingManagerForTesting.
	 */
	matches: (data: string, id: PancodeKeybinding) => boolean;
	/** App exit follows pi's editor rule: Ctrl+D exits only when the editor is empty. */
	canExit?: () => boolean;
	cycleThinking: () => void;
	requestShutdown: () => void;
	suspendProcess?: () => void;
	toggleStatus: () => void;
	toggleDispatchBoard: () => void;
	/** `/files` as a key: open the files pane when closed, close it when open. */
	toggleFilesPane: () => void;
	/** `/music` as a key: open and play when closed, stop and close when open. */
	toggleMusic?: () => void;
	openTasks: () => void;
	openDecisions: () => void;
	backgroundDispatch: () => void;
	openModelSelector: () => void;
	openHub: () => void;
	openTree: () => void;
	cycleScopedModelForward: () => void;
	cycleScopedModelBackward: () => void;
	dismissNotifications: () => void;
	cycleOutputStyle: () => void;
	toggleAutonomy?: () => void;
	/** Note a harness feature the operator used, for demo guidance. */
	recordFeature?: (feature: string) => void;
	openExternalEditor: () => void;
	/** Empty the composer; false when there is no draft to clear. */
	clearDraft?: () => boolean;
	interruptWithMessage: () => void;
	restoreQueuedFollowUps: () => void;
	openQueueNavigator: () => void;
}

const ACTION_FEATURES: Partial<Record<PancodeKeybinding, string>> = {
	"pancode.output.cycle": "output-style",
	"pancode.model.select": "/model",
	"pancode.session.tree": "/tree",
	"pancode.dispatchBoard.toggle": "/fleet",
	"pancode.tasks.open": "/tasks",
	"pancode.thinking.cycle": "/thinking",
	"pancode.message.interrupt": "steer",
};

export function dispatchInteractiveAction(id: PancodeKeybinding, deps: KeyBindingDeps): boolean {
	const feature = ACTION_FEATURES[id];
	if (feature !== undefined) deps.recordFeature?.(feature);
	// A key the operator pressed retires the demo tip that would teach it.
	deps.recordFeature?.(`key:${id}`);
	switch (id) {
		case "pancode.suspend":
			if (!deps.suspendProcess) return false;
			deps.suspendProcess();
			return true;
		case "pancode.output.cycle":
			deps.cycleOutputStyle();
			return true;
		case "pancode.autonomy.toggle":
			if (!deps.toggleAutonomy) return false;
			deps.toggleAutonomy();
			return true;
		case "pancode.notifications.dismiss":
			deps.dismissNotifications();
			return true;
		case "pancode.editor.external":
			deps.openExternalEditor();
			return true;
		case "pancode.editor.clear":
			return deps.clearDraft?.() ?? false;
		case "pancode.message.interrupt":
			deps.interruptWithMessage();
			return true;
		case "pancode.message.dequeue":
			deps.restoreQueuedFollowUps();
			return true;
		case "pancode.queue.open":
			deps.openQueueNavigator();
			return true;
		case "pancode.status.toggle":
			deps.toggleStatus();
			return true;
		case "pancode.thinking.cycle":
			deps.cycleThinking();
			return true;
		case "pancode.session.tree":
			deps.openTree();
			return true;
		case "pancode.dispatchBoard.toggle":
			deps.toggleDispatchBoard();
			return true;
		case "pancode.files.toggle":
			deps.toggleFilesPane();
			return true;
		case "pancode.music.toggle":
			if (!deps.toggleMusic) return false;
			deps.toggleMusic();
			return true;
		case "pancode.tasks.open":
			deps.openTasks();
			return true;
		case "pancode.decisions.open":
			deps.openDecisions();
			return true;
		case "pancode.dispatch.background":
			deps.backgroundDispatch();
			return true;
		case "pancode.model.select":
			deps.openModelSelector();
			return true;
		case "pancode.hub.toggle":
			deps.openHub();
			return true;
		case "pancode.model.cycleBackward":
			deps.cycleScopedModelBackward();
			return true;
		case "pancode.model.cycleForward":
			deps.cycleScopedModelForward();
			return true;
		case "pancode.exit":
			if (deps.canExit && !deps.canExit()) return false;
			deps.requestShutdown();
			return true;
		case "pancode.leader":
			return false;
	}
}
