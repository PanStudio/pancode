// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The ask_user interview's model: each question's state, the option items and the answer recorded from them, and
 * the question and option rows the card draws. The overlay in `ask-user.ts` owns the keyboard and the layout.
 */

import { escapeTerminalControls } from "../../core/terminal-controls.js";
import { type SelectItem, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import type { AskUserQuestion } from "../../tools/ask-user.js";
import { fitRow } from "../overlay-frame.js";
import { GLYPH, pancodeTheme, positionRow } from "../theme/index.js";

/** The fact separator of the plain rows this card measures before painting. */
export const SEP = ` ${GLYPH.sep} `;

const CONTINUATION_INDENT = "    ";
const TEXT_ASKING_DESCRIPTION = "opens a text field for your answer";

export const OTHER_POINTER = "[t] type an answer";

/**
 * One way to spend the body's rows. The question and its choices are what the
 * operator acts on, so the rows around them go first: blank spacing, then the
 * header rows, then the key legend. An option's description is its consequence,
 * so it is part of the decision and never gives way at any tier or size; a list
 * that cannot show every option whole windows instead.
 */
export interface BodyFit {
	spacing: boolean;
	headers: boolean;
	legend: boolean;
}

export const FULL_FIT: BodyFit = { spacing: true, headers: true, legend: true };
export const TIGHT_FIT: BodyFit = { ...FULL_FIT, spacing: false };
const HEADERLESS_FIT: BodyFit = { ...TIGHT_FIT, headers: false };
export const BARE_FIT: BodyFit = { ...HEADERLESS_FIT, legend: false };
export const BODY_FITS: ReadonlyArray<BodyFit> = [FULL_FIT, TIGHT_FIT, HEADERLESS_FIT, BARE_FIT];

export type Mode = "select" | "text";

export interface QuestionState {
	mode: Mode;
	selected: Set<number>;
	committedSelected: Set<number>;
	/** The choices as they stood when the text field opened; Esc from the field puts them back. */
	selectedBeforeText: Set<number> | null;
	customAnswer: string;
	inputValue: string;
	answer: string;
	/**
	 * The operator's typed text exactly as submitted, empty when they typed
	 * nothing. `answer` is the one-line rendering of the whole decision and gets
	 * trimmed and joined; this is the record of what they actually typed, and
	 * losing it is what made an interview re-ask for the same figures three times
	 * (issue #228).
	 */
	rawValue: string;
	focusedValue?: string;
}

export function questionHasOptions(question: AskUserQuestion): boolean {
	return (question.options?.length ?? 0) > 0;
}

export function initialMode(question: AskUserQuestion): Mode {
	return questionHasOptions(question) ? "select" : "text";
}

export function createQuestionState(
	question: AskUserQuestion,
	initial?: { selected?: readonly number[]; text?: string },
): QuestionState {
	const preferred = question.defaultOption;
	const focusable = preferred !== undefined && question.options?.[preferred] !== undefined;
	return {
		mode: initialMode(question),
		selected: new Set(initial?.selected),
		committedSelected: new Set(initial?.selected),
		selectedBeforeText: null,
		customAnswer: "",
		inputValue: initial?.text ?? "",
		answer: "",
		rawValue: "",
		// defaultOption sets focus; harness drafts still need the operator's submission.
		...(focusable ? { focusedValue: `option:${preferred}` } : {}),
	};
}

function normalizedLabel(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9']+/g, " ")
		.trim();
}

export function isOtherOption(label: string): boolean {
	const normalized = normalizedLabel(label);
	return (
		normalized === "other" ||
		normalized === "custom" ||
		normalized === "something else" ||
		normalized.startsWith("other ")
	);
}

/**
 * An option whose label says the operator is about to type.
 *
 * wtf-MS interviews offer "Provided details" beside "help me explore"; the
 * candidates round offers "Combine or edit; I'll describe". Choosing such an
 * option used to record the bare label, and the model then had a route with no
 * details on it and asked again. Enter on one of these opens the text field
 * with the label kept, the same path `t` takes.
 */
export function optionAsksForText(label: string): boolean {
	if (isOtherOption(label)) return true;
	const normalized = normalizedLabel(label);
	return /\b(provided? details|i'?ll (describe|type|explain|specify|provide|write)|i (will|can) (describe|type|explain|specify|provide|write)|let me (describe|type|explain|specify)|type (it|my|the)|describe (it|my|the|below))\b/u.test(
		normalized,
	);
}

export function optionItems(question: AskUserQuestion, selected: ReadonlySet<number>, draft = ""): SelectItem[] {
	const options = question.options ?? [];
	const explicitOtherIndex = options.findIndex((option) => isOtherOption(option.label));
	const items: SelectItem[] = [];
	for (let index = 0; index < options.length; index += 1) {
		const option = options[index];
		if (!option) continue;
		const isExplicitOther = index === explicitOtherIndex;
		const label =
			question.multi_select === true && !isExplicitOther
				? `${selected.has(index) ? "[x]" : "[ ]"} ${escapeTerminalControls(option.label)}`
				: escapeTerminalControls(option.label);
		const item: SelectItem = {
			value: isExplicitOther ? "other" : `option:${index}`,
			label,
		};
		if (option.description) item.description = option.description;
		else if (optionAsksForText(option.label)) item.description = TEXT_ASKING_DESCRIPTION;
		items.push(item);
	}
	if (explicitOtherIndex === -1 && question.fixedChoices !== true) {
		// The implicit choice is one word on screen; its description says what it
		// does, and the tool's longer label is what the answer records.
		items.push({
			value: "other",
			label: question.multi_select === true ? "[ ] Other" : "Other",
			// A draft left with Esc waits here, and the row says so, so backing out of the field reads as keeping it.
			description:
				draft.trim().length > 0 ? `your draft, kept: ${draft.trim().replace(/\s+/gu, " ")}` : "type your answer",
		});
	}
	return items;
}

export function optionIndexFromValue(value: string): number | null {
	if (!value.startsWith("option:")) return null;
	const index = Number(value.slice("option:".length));
	return Number.isInteger(index) && index >= 0 ? index : null;
}

/** The labels the operator chose, in list order. */
export function selectedOptionLabels(question: AskUserQuestion, selected: ReadonlySet<number>): string[] {
	const labels: string[] = [];
	for (const index of [...selected].sort((a, b) => a - b)) {
		const label = question.options?.[index]?.label;
		if (label) labels.push(label);
	}
	return labels;
}

export function answerText(question: AskUserQuestion, selected: ReadonlySet<number>, customAnswer: string): string {
	const parts = selectedOptionLabels(question, selected);
	const custom = customAnswer.trim();
	if (custom.length > 0) parts.push(custom);
	return parts.join("; ");
}

/** Wrap a prose value inside the columns left by its one-time row label. */
export function wrapLabeledValue(prefix: string, value: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const prefixWidth = visibleWidth(prefix);
	const valueWidth = Math.max(1, safeWidth - prefixWidth);
	return wrapTextWithAnsi(value, valueWidth).map(
		(line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`,
	);
}

export function compactTitle(question: AskUserQuestion): string {
	return escapeTerminalControls(question.header ?? question.question)
		.replace(/\s+/g, " ")
		.trim();
}

const BOLD_SPAN = /\*\*([^*\n]+?)\*\*/gu;
const LIST_MARKER = /^(\s*)(\d{1,2}[.)]|[-*•])\s+(.*)$/u;

function inlineMarkdown(text: string): string {
	const theme = pancodeTheme();
	return text.replace(BOLD_SPAN, (_match, inner: string) => theme.fg("boldEmphasis", inner));
}

/**
 * The question, wrapped to the width and never cut.
 *
 * A model writes a question the way it writes prose: `**Domain**` for emphasis
 * and `1.` lists for the parts it wants answered. The old body rendered the
 * asterisks literally and wrapped a list item's second row back to column zero,
 * where it read as a new paragraph. Bold spans render bold, list items hang
 * under their marker, and blank lines survive one deep so paragraphs stay apart.
 */
export function formatAskUserQuestion(text: string, width: number): string[] {
	const safeWidth = Math.max(4, width);
	const lines: string[] = [];
	let previousBlank = true;
	for (const raw of escapeTerminalControls(text).replace(/\r\n?/g, "\n").split("\n")) {
		const line = raw.replace(/\t/g, "    ").trimEnd();
		if (line.trim().length === 0) {
			if (!previousBlank) lines.push("");
			previousBlank = true;
			continue;
		}
		previousBlank = false;
		const list = LIST_MARKER.exec(line);
		if (list) {
			const lead = list[1] ?? "";
			const marker = (list[2] ?? "").replace(/^[-*]$/u, GLYPH.bullet);
			const rest = list[3] ?? "";
			const prefix = `${lead}${marker} `;
			const indent = " ".repeat(visibleWidth(prefix));
			const wrapped = wrapTextWithAnsi(inlineMarkdown(rest), Math.max(4, safeWidth - indent.length));
			wrapped.forEach((part, index) => {
				lines.push(`${index === 0 ? prefix : indent}${part}`);
			});
			continue;
		}
		// An indented line is a continuation the author laid out by hand, such as
		// the "In: … · Out: …" row under a candidate; its wrapped rows keep the
		// indent so they read as part of it rather than as a new paragraph.
		const lead = /^\s*/u.exec(line)?.[0] ?? "";
		const wrapped = wrapTextWithAnsi(inlineMarkdown(line.slice(lead.length)), Math.max(4, safeWidth - lead.length));
		lines.push(...wrapped.map((part) => `${lead}${part}`));
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

interface OptionRowLayout {
	/** Rows per item, in item order. */
	rows: string[][];
}

/** Full-width labels and explanations; every option's explanation shows whole, focused or not. */
export function layoutOptionRows(
	items: ReadonlyArray<SelectItem>,
	focusedIndex: number,
	width: number,
	recommendedIndex = -1,
	otherPointer: string | null = null,
): OptionRowLayout {
	const theme = pancodeTheme();
	const safeWidth = Math.max(8, width);
	return {
		rows: items.map((item, index) => {
			const focused = index === focusedIndex;
			// Set off from the label, so `Fast recommended` cannot read as the option's name.
			const tag = index === recommendedIndex ? `${theme.fg("divider", SEP)}${theme.fg("annotation", "recommended")}` : "";
			// The free-text key, on the row it belongs to, when neither rail nor legend has room for it.
			const pointer = otherPointer !== null && item.value === "other" ? ` ${theme.fg("keyboardHint", otherPointer)}` : "";
			const label = `${theme.fg("menuOption", item.label, focused ? "selected" : "normal")}${tag}${pointer}`;
			const prefix = focused ? theme.fg("selectedOption", `${GLYPH.cursor} `) : "  ";
			const labels = wrapTextWithAnsi(label, safeWidth - 2).map((line, at) => `${at === 0 ? prefix : "  "}${line}`);
			const description = item.description?.trim();
			const explanation = description
				? formatAskUserQuestion(description, Math.max(4, safeWidth - CONTINUATION_INDENT.length)).map(
						(line) => `${CONTINUATION_INDENT}${theme.base("decisionConsequence", line)}`,
					)
				: [];
			return [...labels, ...explanation];
		}),
	};
}

/**
 * The rows of a windowed list: every option when they fit, otherwise a run of
 * whole options around the focused one, with a position row (`2–3 of 5 options`).
 * An option is never split across the window edge, so a description is read
 * whole or not at all, and one arrow key brings any hidden option back.
 */
export function windowOptionRows(
	layout: OptionRowLayout,
	focusedIndex: number,
	rowBudget: number,
	width: number,
	/** Where the free-text row sits when its key has nowhere else to be named, or -1. */
	otherIndex = -1,
): string[] {
	const theme = pancodeTheme();
	const total = layout.rows.reduce((sum, rows) => sum + rows.length, 0);
	if (total <= rowBudget) return layout.rows.flat();
	const budget = Math.max(1, rowBudget - 1);
	const focusedRows = layout.rows[focusedIndex]?.length ?? 1;
	let start = focusedIndex;
	let end = focusedIndex + 1;
	let used = focusedRows;
	// Grow around the focus, later options first so the reading order continues
	// downward, then earlier ones.
	let grew = true;
	while (grew) {
		grew = false;
		const after = layout.rows[end]?.length;
		if (after !== undefined && used + after <= budget) {
			used += after;
			end += 1;
			grew = true;
		}
		const before = layout.rows[start - 1]?.length;
		if (before !== undefined && used + before <= budget) {
			used += before;
			start -= 1;
			grew = true;
		}
	}
	const visible = layout.rows.slice(start, end).flat();
	const otherHidden = otherIndex >= 0 && (otherIndex < start || otherIndex >= end);
	// The rail names the arrows that move, so the row states only where the window sits, and the free-text key when
	// the row that would have named it is out of view; the key gives way whole on a narrow card, never cut.
	const room = Math.max(1, width - 2);
	const range = { start: start + 1, end, total: layout.rows.length, unit: "options" };
	const bare = positionRow(theme, range, room);
	const pointed = otherHidden ? positionRow(theme, { ...range, keys: [OTHER_POINTER] }, Number.POSITIVE_INFINITY) : bare;
	const position = visibleWidth(pointed) <= room ? pointed : bare;
	return [...visible, fitRow(`  ${position}`, width)];
}
