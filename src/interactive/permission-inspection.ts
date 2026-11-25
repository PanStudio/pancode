// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The permission card's reading views: the standing approval terms behind the terms key, and the mutation preview
 * behind the inspect key with its window over the rows.
 */

import { wrapTextWithAnsi } from "../engine/tui.js";
import type { ApprovalRequestView } from "../session-control/approval-request-view.js";
import { MUTATION_PREVIEW_VISIBLE_ROWS, type MutationPreview, mutationFactsLine } from "./mutation-preview.js";
import { fitRow, windowRows } from "./overlay-frame.js";
import { CARD_FACT_ROWS, identityRow, targetBlock } from "./permission-card-rows.js";
import { MUTATION_PREVIEW_KEY, permissionKeyLabel } from "./permission-hint.js";
import {
	actionConsequence,
	permissionDecisionPresentation,
	permissionRiskTone,
	taskRowValue,
} from "./permission-overlay-model.js";
import type { Fact, PancodeTheme } from "./theme/index.js";
import { factRows, GLYPH, pancodeTheme, positionRow, sectionRule } from "./theme/index.js";

/**
 * Hard wrap for mutation text. Prose wraps on words; a proposed file line and a
 * diff row do not, because the column a character sits in is part of what the
 * operator is reading. The continuation marker says the row was folded rather
 * than cut, which is the difference between a wrap and unmarked truncation.
 */
function wrapMutationLine(value: string, max: number): string[] {
	if (max <= 1) return [value];
	if (value.length <= max) return [value];
	const lines: string[] = [];
	let remaining = value;
	while (remaining.length > max) {
		lines.push(`${remaining.slice(0, max - 1)}${GLYPH.codeWrap}`);
		remaining = remaining.slice(max - 1);
	}
	lines.push(remaining);
	return lines;
}

/** A diff row in its sign's tone, so an edit's additions and removals read apart. */
function paintMutationRow(theme: PancodeTheme, row: string, diff: boolean): string {
	if (!diff) return row;
	if (row.startsWith("+")) return theme.fg("success", row);
	if (row.startsWith("-")) return theme.fg("error", row);
	if (row.startsWith("@@")) return theme.fg("annotation", row);
	return row;
}

/**
 * The standing terms of the decision, one sentence each. The authorization
 * sentence already opens with "Approval", so it carries no label of its own.
 */
export function permissionTermsRows(theme: PancodeTheme, view: ApprovalRequestView, width: number): string[] {
	const presentation = permissionDecisionPresentation(view);
	const wrapTerm = (text: string): string[] => wrapTextWithAnsi(theme.fg("decisionExplanation", text), width);
	return [
		...(view.task !== undefined ? wrapTerm(`Task: ${taskRowValue(view.task)}`) : []),
		...wrapTerm(presentation.authorizationCopy),
		...wrapTerm(`Consequence: ${presentation.consequenceCopy}`),
		...wrapTerm(presentation.reversibilityCopy),
		...wrapTerm(`Deny: ${actionConsequence(presentation, "deny")}`),
		...wrapTerm(`Stop: ${actionConsequence(presentation, "stop")}`),
		...wrapTerm("Hard-blocked actions remain blocked."),
	];
}

/**
 * The card with the mutation open. The identity, target and digest stay at the
 * top so the bytes on screen remain tied to the call they belong to, and the
 * choices give way to the mutation itself: the operator opened this to read
 * what changes, and the keys that answer the ask are on the rail throughout.
 * The window takes the rows the frame has, so the frame never has to cut it.
 */
/** The fewest diff rows a window should open with before the facts above it give way. */
const MIN_INSPECTION_ROWS = 4;

export function permissionInspectionLines(
	view: ApprovalRequestView,
	preview: MutationPreview,
	width: number,
	scroll: number,
	bodyRows: number,
): { lines: string[]; wrappedLineCount: number; visibleRows: number } {
	const theme = pancodeTheme();
	const content = Math.max(8, Math.floor(width));
	const presentation = permissionDecisionPresentation(view);
	const risk = permissionRiskTone(view.actionClass, view.exposure);
	const diff = preview.heading.startsWith("Effective diff") || preview.heading.startsWith("Requested replacements");
	const wrapped = preview.body
		.flatMap((line) => wrapMutationLine(line, content))
		.map((row) => paintMutationRow(theme, row, diff));
	const notes: string[] = [];
	if (preview.neutralized) notes.push(`control characters shown as ${GLYPH.sep}`);
	if (preview.tabsExpanded) notes.push("tabs shown as spaces");
	const identity = identityRow(theme, view, presentation, content);
	const target =
		view.target !== undefined && view.target.length > 0 ? targetBlock(theme, view.target, risk, content) : [];
	const fullHead = [
		...identity.rows,
		...target,
		...factRows(
			theme,
			[
				...(identity.ruleFact === null ? [] : [identity.ruleFact]),
				...(view.netReason !== undefined && view.netReason.length > 0
					? [{ label: "why", value: view.netReason } satisfies Fact]
					: []),
				{ label: "mutation", value: mutationFactsLine(preview.facts) },
			],
			content,
			CARD_FACT_ROWS,
		),
		sectionRule(theme, content, previewLabel(preview.heading), {
			meta: `Esc or ${permissionKeyLabel(MUTATION_PREVIEW_KEY)} hides`,
		}),
		...previewReason(theme, preview.heading, content),
	];
	const tail =
		notes.length > 0 ? [fitRow(theme.fg("annotation", `Rendered safely: ${notes.join(", ")}.`), content)] : [];
	// A short dock cut the facts' rows and the whole diff with them, and no key reached it. The card
	// just stated those facts, so the diff keeps the rows and only the call's name stays above it.
	const compact = bodyRows > 0 && fullHead.length + tail.length + 1 + MIN_INSPECTION_ROWS > bodyRows;
	const head = compact
		? [
				...identity.rows.slice(0, 1),
				...target.slice(0, 1),
				sectionRule(theme, content, previewLabel(preview.heading), {
					meta: `Esc or ${permissionKeyLabel(MUTATION_PREVIEW_KEY)} hides`,
				}),
			]
		: fullHead;
	const visibleRows = compact
		? Math.max(1, bodyRows - head.length - tail.length - 1)
		: inspectionWindowRows(bodyRows, head.length + tail.length);
	const pane = windowRows(wrapped, scroll, visibleRows);
	const lines = [
		...head,
		...pane.window,
		...(pane.position === null
			? []
			: [positionRow(theme, { ...pane.position, unit: "lines", keys: [`${GLYPH.upDown} scroll`] }, content)]),
		...tail,
	];
	return { lines, wrappedLineCount: wrapped.length, visibleRows };
}

/**
 * The preview's own name for what it shows, without the path the target block
 * above already carries: `Proposed content`, `Effective diff`, `Requested
 * replacements`, or the whole heading when it names no file.
 */
function previewLabel(heading: string): string {
	const at = heading.indexOf(" for ");
	return at === -1 ? heading : heading.slice(0, at);
}

/** A heading's parenthesised reason (`the file could not be read: …`), on its own wrapped rows. */
function previewReason(theme: PancodeTheme, heading: string, width: number): string[] {
	const open = heading.indexOf(" (");
	if (open === -1 || !heading.endsWith(")")) return [];
	return wrapTextWithAnsi(theme.fg("warning", heading.slice(open + 2, -1)), width);
}

/**
 * Rows an inspection window may use: the frame's budget less the rows around
 * it and the position row, never under four, and the fixed preview height
 * when the budget is not known yet.
 */
export function inspectionWindowRows(bodyRows: number, surroundingRows: number): number {
	if (bodyRows <= 0) return MUTATION_PREVIEW_VISIBLE_ROWS;
	return Math.max(4, bodyRows - surroundingRows - 1);
}
