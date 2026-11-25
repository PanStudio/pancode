// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The composer's completion facts: the slice of Pi's suggestion engine PanCode reads, the edits that leave the list
 * behind, how many rows the list and its detail panel may take, and where the cursor stands for the next suggestion.
 */

import type { Editor } from "../engine/tui.js";

/**
 * The slice of Pi's Editor the suggestion list needs and keeps private. Pi
 * requests suggestions asynchronously and leaves the previous list in place
 * until the new one lands, so PanCode reads the list to tell whether it still
 * describes the line.
 */
export interface SuggestionEngine {
	autocompleteList?: { getSelectedItem(): unknown };
	autocompleteState: unknown;
	updateAutocomplete?(): void;
	tryTriggerAutocomplete?(): void;
	cancelAutocomplete?(): void;
}

/**
 * Pi's edits that remove text without asking the suggestion list to follow.
 * Insertion, Backspace and Delete already refresh it.
 */
export const KILL_ACTIONS = [
	"tui.editor.deleteToLineStart",
	"tui.editor.deleteToLineEnd",
	"tui.editor.deleteWordBackward",
	"tui.editor.deleteWordForward",
] as const;

/** Rows the suggestion detail panel may take: the breadcrumb and one description line. */
export const SUGGESTION_PANEL_ROWS = 2;
/** Most list rows the suggestion popup shows at once; the count row pages the rest. */
export const SUGGESTION_MAX_LIST_ROWS = 8;
/** Fewest list rows kept visible when the panel has to share a short dock. */
export const SUGGESTION_MIN_LIST_ROWS = 3;

/** A one-line slash command whose cursor sits after a space, ready for the next argument. */
export function cursorAwaitsSlashArgument(editor: Editor): boolean {
	const lines = editor.getLines();
	const cursor = editor.getCursor();
	const line = lines[0] ?? "";
	return lines.length === 1 && cursor.line === 0 && cursor.col === line.length && /^\s*\/\S*\s(?:.*\s)?$/u.test(line);
}

export function cursorEndsDirectoryPath(editor: Editor): boolean {
	const cursor = editor.getCursor();
	const line = editor.getLines()[cursor.line] ?? "";
	return line.slice(0, cursor.col).endsWith("/");
}
