// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { GLYPH } from "../core/glyphs.js";
import type { PancodeKeybinding } from "../domains/config/keybindings.js";
/** Why a protected exit was refused: the work in the way and the key that deals with each thing. */
import type { OperatorExtensions } from "../domains/extensions/operator-extensions.js";
import type { EditorSubmitController } from "./editor-submit.js";
import type { InteractiveDeps } from "./interactive-deps.js";
import type { InteractivePresentation } from "./interactive-presentation.js";
import { actionKeyLabel } from "./keybinding-manager.js";

const keyLabel = (id: PancodeKeybinding, fallback: string): string => actionKeyLabel(id) ?? fallback;

/** Answers a refused exit with what is in the way and the key that deals with each thing. */
export const explainProtectedExit = (
	deps: InteractiveDeps,
	editorSubmit: EditorSubmitController,
	operatorExtensions: OperatorExtensions | undefined,
	notify: InteractivePresentation["notify"],
	pressed = "Ctrl+D",
): void => {
	const running = deps.dispatch.snapshot().running;
	const queue = deps.chat.queuedMessages();
	const queued = queue.steer.length + queue.followUp.length;
	const reasons: string[] = [];
	const actions: string[] = [];
	if (running.length > 0) {
		reasons.push(
			running.length === 1 ? `${running[0]?.agentId ?? "a worker"} is running` : `${running.length} workers are running`,
		);
		actions.push(`${keyLabel("pancode.dispatchBoard.toggle", "/fleet")} shows ${running.length === 1 ? "it" : "them"}`);
	}
	if (queued > 0) {
		reasons.push(`${queued} message${queued === 1 ? " is" : "s are"} queued`);
		actions.push(`${keyLabel("pancode.queue.open", "the queue")} then a restores ${queued === 1 ? "it" : "them"}`);
	}
	if (editorSubmit.hasActiveEditorBash()) {
		reasons.push("a shell command is running");
		actions.push("Esc stops it");
	}
	if (deps.chat.isStreaming() || deps.chat.turnPreparation().phase !== "idle") {
		reasons.push("a turn is running");
		actions.push("Esc cancels it");
	}
	if (operatorExtensions?.busy) reasons.push("an extension is busy");
	const why = reasons.length > 0 ? reasons.join(", ") : "work is still running";
	notify(
		"info",
		`${pressed}: not exiting, ${why}. ${[...actions, "/quit stops everything and exits"].join(` ${GLYPH.sep} `)}`,
		"keyboard:exit",
	);
};
