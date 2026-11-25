// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { MARKER } from "../core/glyphs.js";

export interface EditorBashCommand {
	command: string;
	excludeFromContext: boolean;
}

/**
 * Invisible one-shot envelope used only between PancodeEditor and its submit
 * callback. Pi trims submitted text before invoking that callback, so a
 * whitespace guard would disappear and re-arm a pasted `!` command. The
 * controller removes this envelope before routing the text as an ordinary
 * prompt; it is never persisted or sent to a model.
 */
export const PASTED_EDITOR_OPERATOR_GUARD = MARKER.pastedOperatorGuard;

export function guardPastedEditorOperator(text: string): string {
	return `${PASTED_EDITOR_OPERATOR_GUARD}${text}`;
}

export function unguardPastedEditorOperator(text: string): string {
	return text.startsWith(PASTED_EDITOR_OPERATOR_GUARD) ? text.slice(PASTED_EDITOR_OPERATOR_GUARD.length) : text;
}

export function parseEditorBashCommand(text: string): EditorBashCommand | null {
	// Commands are an editor-line operator, not a shell-script paste surface.
	// The paste guard also makes a bracketed-pasted one-liner literal until it
	// has crossed the editor submit boundary and been routed as a normal prompt.
	if (text.startsWith(PASTED_EDITOR_OPERATOR_GUARD) || text.includes("\n") || text.includes("\r")) return null;
	if (!text.startsWith("!")) return null;
	const excludeFromContext = text.startsWith("!!");
	const command = (excludeFromContext ? text.slice(2) : text.slice(1)).trim();
	if (command.length === 0) return null;
	return { command, excludeFromContext };
}

export function remapPastedBangOffsets(
	before: string,
	after: string,
	offsets: ReadonlySet<number>,
	markInsertedAsPasted: boolean,
): Set<number> {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
	let beforeEnd = before.length;
	let afterEnd = after.length;
	while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1] === after[afterEnd - 1]) {
		beforeEnd -= 1;
		afterEnd -= 1;
	}

	const next = new Set<number>();
	const shift = afterEnd - prefix - (beforeEnd - prefix);
	for (const offset of offsets) {
		if (offset < prefix) next.add(offset);
		else if (offset >= beforeEnd) next.add(offset + shift);
	}
	if (markInsertedAsPasted) {
		for (let offset = prefix; offset < afterEnd; offset += 1) {
			if (after[offset] === "!") next.add(offset);
		}
	}
	return next;
}

export function startsWithPastedOperator(text: string, pastedBangOffsets: ReadonlySet<number>): boolean {
	const first = text.search(/\S/u);
	return first >= 0 && text[first] === "!" && pastedBangOffsets.has(first);
}
