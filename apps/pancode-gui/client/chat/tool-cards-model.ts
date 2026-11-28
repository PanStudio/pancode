// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// The tool rows' small output decisions; the rest of a row's presentation lives in tool-presentation.ts.
import type { AnsiSpan } from "../render/ansi.js";
import type { ToolPresentation } from "./tool-presentation.js";

/** The classes that draw one styled span of terminal output, or undefined for plain text. */
export function spanClass(span: AnsiSpan): string | undefined {
	const names = [
		span.color === null ? null : `ansi-${span.color}`,
		span.bold ? "ansi-bold" : null,
		span.dim ? "ansi-dim" : null,
		span.italic ? "ansi-italic" : null,
		span.underline ? "ansi-underline" : null,
	].filter(Boolean);
	return names.length > 0 ? names.join(" ") : undefined;
}

/** Lines the output well shows before it scrolls, from its 26em cap at the body leading. */
export const OUTPUT_VISIBLE_LINES = 16;

export function lineCountOf(text: string): number {
	let count = 1;
	for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count++;
	return text.endsWith("\n") ? count - 1 : count;
}

export function resultLabel(card: ToolPresentation): string {
	if (card.name === "read") return "View file contents";
	if (card.name === "ls") return "View directory listing";
	if (card.body === "fetch") return "View fetched content";
	if (card.body === "dispatch") return "View worker result";
	return "View result";
}
