// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { contextResetPreview } from "../../domains/context/reset-paths.js";
import { type Component, type OverlayHandle, type TUI, wrapTextWithAnsi } from "../../engine/tui.js";
import type { ContextClearCommandOptions } from "../../session-control/slash-command-types.js";
import { buildHint, createChoiceList, FocusBox, showPancodeOverlayFrame } from "../overlay-frame.js";
import { pancodeTheme } from "../theme/index.js";

export const CONTEXT_RESET_OVERLAY_WIDTH = 72;
export type ContextResetMutationChoice = "preserve-pancode-md" | "delete-pancode-md";

export interface OpenContextResetOverlayDeps {
	/** Called only for one of the two mutating choices. */
	onReset: (choice: ContextResetMutationChoice) => void;
	/** Called for both the explicit Cancel row and Esc. */
	onCancel: () => void;
	/** The project the reset applies to; the chooser names what is on disk there. Defaults to the process cwd. */
	cwd?: string;
}

/**
 * The files the choice touches, named before it is made. "Remove generated
 * context" alone left the operator to guess which files that was, and whether
 * a project with none of them would change at all.
 */
function previewLines(preview: ReturnType<typeof contextResetPreview>): string[] {
	return [
		preview.removes.length === 0
			? "PanCode has generated no project context here yet, so Preserve changes no file."
			: `Both choices remove what PanCode generated: ${preview.removes.join(", ")}.`,
		preview.handbook
			? "Delete also removes PANCODE.md, the handbook you or PanCode wrote for this project."
			: "There is no PANCODE.md here, so Delete removes the same files as Preserve.",
		`${preview.keeps.length > 0 ? `Kept: ${preview.keeps.join(", ")}. ` : ""}Nothing else in the project is touched.`,
	];
}

/** Translate one confirmed chooser action into the existing context-domain contract. */
export function contextResetOptions(choice: ContextResetMutationChoice): ContextClearCommandOptions {
	return choice === "delete-pancode-md" ? { all: true, confirmed: true, confirmedAll: true } : { confirmed: true };
}

/**
 * Three intentional outcomes, ordered with the least destructive action first.
 * Each row says what it changes in this project, so a choice that changes
 * nothing reads that way on the row the operator is about to press.
 */
function choices(preview: ReturnType<typeof contextResetPreview>) {
	const generated = preview.removes.length > 0;
	return [
		{
			value: "preserve-pancode-md",
			label: "Preserve PANCODE.md",
			description: generated
				? "remove generated context and keep the project handbook"
				: "changes no file here: there is no generated context to remove",
		},
		{
			value: "delete-pancode-md",
			label: "Delete PANCODE.md",
			description: preview.handbook
				? generated
					? "remove generated context and the project handbook"
					: "remove the project handbook"
				: generated
					? "remove generated context; there is no handbook here"
					: "changes no file here: there is no handbook or generated context",
		},
		{ value: "cancel", label: "Cancel", description: "close without changing any files" },
	] as const;
}

/** Open the `/context reset` choice dialog. Cancel paths never reach onReset. */
export function openContextResetOverlay(tui: TUI, deps: OpenContextResetOverlayDeps): OverlayHandle {
	const state = contextResetPreview(deps.cwd ?? process.cwd());
	const items = choices(state);
	const list = createChoiceList({
		items,
		// When Preserve would change no file, the focus starts on Cancel: the only
		// row left that changes anything deletes the handbook, and Enter must
		// never land on that unasked.
		initialIndex: state.removes.length > 0 ? 0 : 2,
		onSelect: (item) => {
			if (item.value === "preserve-pancode-md" || item.value === "delete-pancode-md") {
				deps.onReset(item.value);
				return;
			}
			deps.onCancel();
		},
		onCancel: () => deps.onCancel(),
	});
	const lines = previewLines(state);
	const preview: Component = {
		render(width) {
			const theme = pancodeTheme();
			const room = Math.max(1, width);
			return [...lines.flatMap((line) => wrapTextWithAnsi(theme.fg("annotation", line), room)), ""];
		},
		invalidate() {},
	};
	return showPancodeOverlayFrame(tui, new FocusBox([preview, list], { inputTarget: list }), {
		anchor: "center",
		width: CONTEXT_RESET_OVERLAY_WIDTH,
		markerId: "context-reset",
		title: "Reset project context",
		footerHint: buildHint([{ key: "Enter", verb: "select" }]),
	});
}
