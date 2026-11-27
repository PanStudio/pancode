// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { isRecord } from "../../core/type-guards.js";
import { sanitizeCallTargetText, sanitizeMultilineDisplayText } from "../../lib/call-target/call-target.js";
import { redactSecretString, redactToolArgs } from "../../lib/secrets/redaction.js";
import type { ResolvedToolRow } from "../../tools/presentation.js";
/** Tool argument rows: the inline argument pairs, the argument body, and the preview's argument facts. */
import { cardRows } from "../card.js";
import { factRows, GLYPH } from "../theme/index.js";
import { shellCommandInk } from "./code-ink.js";
import { highlightJsonLine } from "./structured.js";
import {
	BODY_INDENT_VISIBLE_WIDTH,
	detailsOf,
	isEmptyArgs,
	observationOf,
	RAIL_ERROR,
	RAIL_NORMAL,
	SEP,
	stringField,
	type ToolExecutionFinished,
	type ToolExecutionStart,
	theme,
	toolMeta,
} from "./tool-call-model.js";
import { lineRange } from "./tool-facts.js";
import { displayText, objectDisplay, resolveRow } from "./tool-subline.js";

/** The longest argument value a row states inline rather than as a `key ›` row. */
const INLINE_ARG_LIMIT = 40;

/**
 * One scalar argument as the row states it: `context 2`, `glob *.ts`,
 * `query "flaky retry test"`. Long, multiline and structured values are not
 * inline; they stay `key ›` rows under the action.
 */
function inlineArgValue(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "boolean") return String(value);
	if (typeof value !== "string" || /[\r\n\t]/u.test(value)) return null;
	const clean = sanitizeCallTargetText(redactSecretString(value)).trim();
	if (clean.length === 0 || clean.length > INLINE_ARG_LIMIT) return null;
	return /\s/u.test(clean) ? JSON.stringify(clean) : clean;
}

/**
 * Argument fields a settled row's facts already state, beyond the ones its
 * object consumes: the format a fetch returned, the window a read asked for
 * when the row states the range it got.
 */
function factConsumedFields(row: ResolvedToolRow, finished: ToolExecutionFinished | null): readonly string[] {
	if (finished === null || finished.isError || finished.outcome !== undefined) return [];
	if (row.spec.class === "network" && stringField(detailsOf(finished.result), "format") !== null) return ["format"];
	const observation = observationOf(finished);
	if (observation !== null && lineRange(finished, observation) !== null) return ["offset", "limit"];
	return [];
}

/**
 * Mutation payloads. A settled change is described by its diff (Standard and
 * Detailed) or its `+N -M` change facts (Compact); the raw replacement text is
 * inspection material. A failed mutation keeps its payload visible, bounded,
 * because the text that did not match is the diagnosis.
 */
const MUTATION_PAYLOAD_FIELDS = ["edits", "oldText", "newText", "content"] as const;

/** Scalar arguments the row states inline, as `key value`, in argument order. */
function inlineArgs(row: ResolvedToolRow, finished: ToolExecutionFinished | null): string[] {
	// A call whose worker card sits under it leaves the run's facts, its route
	// included, to the card: the row reads `◆ delegated to scout · 38s`.
	if (row.context.cardAttached === true) return [];
	const skip = new Set<string>([...row.spec.consumes, ...factConsumedFields(row, finished)]);
	if (row.spec.class === "mutate") for (const key of MUTATION_PAYLOAD_FIELDS) skip.add(key);
	const out: string[] = [];
	for (const [key, value] of Object.entries(row.args)) {
		if (skip.has(key) || value === undefined || value === null) continue;
		if (row.spec.dropsUnknownArgs === true) continue;
		const shown = inlineArgValue(value);
		// A flag that is on reads as its name (`ignore_case`, `detach`).
		if (shown !== null)
			out.push(value === true ? sanitizeCallTargetText(key) : `${sanitizeCallTargetText(key)} ${shown}`);
	}
	return out;
}

function isScalarList(value: unknown): value is Array<string | number | boolean> {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(item) =>
				(typeof item === "string" && !/[\r\n]/u.test(item)) || typeof item === "number" || typeof item === "boolean",
		)
	);
}

/** Full redacted arguments are retained for inspection; transcript callers budget rows. */
function dispatchIntentSummary(intent: Record<string, unknown>): string | null {
	const parts: string[] = [];
	for (const [key, label] of [
		["read_roots", "read"],
		["write_roots", "write"],
		["relevant_paths", "context"],
		["expected_outputs", "outputs"],
		["verification", "checks"],
	] as const) {
		const values = intent[key];
		if (!Array.isArray(values) || values.length === 0) continue;
		// A read root that is only the workspace is the default, so the row omits it.
		if (key === "read_roots" && values.every((value) => value === "." || value === "./")) continue;
		const names = values
			.slice(0, 3)
			.map((value) =>
				typeof value === "string" ? value : isRecord(value) && typeof value.check === "string" ? value.check : "check",
			);
		parts.push(`${label}: ${names.join(", ")}${values.length > 3 ? ` (+${values.length - 3})` : ""}`);
	}
	if (parts.length === 0) return null;
	const text = sanitizeCallTargetText(parts.join("; "));
	return text.length > 240 ? `${text.slice(0, 240 - GLYPH.ellipsis.length)}${GLYPH.ellipsis}` : text;
}

export function renderToolArguments(
	args: unknown,
	width: number,
	isError = false,
	maxRows = Number.POSITIVE_INFINITY,
	joinScalarLists = false,
	syntax?: "shell",
): string[] {
	if (isEmptyArgs(args)) return [];
	const safeArgs = redactToolArgs(args);
	const out: string[] = [];
	const entries = isRecord(safeArgs) ? Object.entries(safeArgs) : [["input", safeArgs] as const];
	for (const [key, rawValue] of entries) {
		const value = joinScalarLists && key === "intent" && isRecord(rawValue) ? dispatchIntentSummary(rawValue) : rawValue;
		if (value === null) continue;
		// In the transcript a list of short scalars reads as one row (`paths ›
		// a.ts · b.ts`), not as the multi-row JSON array it would pretty-print
		// to. Inspection and approval keep the exact JSON.
		const text =
			typeof value === "string"
				? value
				: joinScalarLists && isScalarList(value)
					? value.map((item) => String(item)).join(SEP)
					: JSON.stringify(value, null, 2);
		const full = String(text ?? value);
		const chars = Number.isFinite(maxRows) ? Math.max(1, maxRows * Math.max(1, width) * 4) : full.length;
		// Verbatim: an argument is what runs, so no byte of it may vanish from view.
		const source = sanitizeMultilineDisplayText(full.slice(0, chars), true).text;
		const lines =
			typeof value === "string" && key === "command" && syntax === "shell" ? shellCommandInk(source) : source.split("\n");
		const argumentLine = (line: string): string => {
			if (typeof value === "string" && key === "command" && syntax === "shell") return line;
			const safe = sanitizeMultilineDisplayText(line).text;
			return typeof value === "string"
				? theme.fg("toolArgument", safe)
				: joinScalarLists && isScalarList(value)
					? theme.fg("toolArgument", safe)
					: highlightJsonLine(safe);
		};
		out.push(
			...cardRows(
				`${theme.fg("toolArgumentName", sanitizeCallTargetText(key))} ${toolMeta(GLYPH.crumb)} ${argumentLine(lines[0] ?? "")}`,
				width,
				isError,
			),
		);
		for (const line of lines.slice(1)) {
			if (out.length > maxRows) break;
			out.push(...cardRows(`  ${argumentLine(line)}`, width, isError));
		}
		if (out.length > maxRows || full.length > chars) {
			return [
				...out.slice(0, Math.max(0, maxRows - 1)),
				...cardRows(toolMeta(`${GLYPH.ellipsis} more arguments${SEP}/view`), width, isError),
			];
		}
	}
	return out;
}

/**
 * The arguments a row's body lists as `key ›` rows: only what the row could
 * not state. The object and scope fields, the scalars that rode inline and the
 * fields the facts state never repeat here, except an object the row had to
 * shorten, which keeps its whole value (a URL never: the row names its host and
 * path). A gateway call lists its capability's own arguments. A settled
 * mutation's payload is inspection material; a failed one keeps it, bounded,
 * because the text that did not match is the diagnosis.
 */
export function previewArguments(
	call: ToolExecutionStart | ToolExecutionFinished,
	width: number,
	livePayload = false,
	argRow = false,
): Record<string, unknown> {
	const row = resolveRow(call);
	const finished = "result" in call ? call : null;
	const failed = finished !== null && (finished.isError || finished.outcome !== undefined);
	// Scalars never ride the header. Where no `args` row states them, a failed call keeps them in its body: what it
	// was asked to do is part of why it failed.
	const keepScalars = failed && !argRow;
	const consumed = new Set<string>([...row.spec.consumes, ...factConsumedFields(row, finished)]);
	const display = objectDisplay(row, width);
	const rest: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row.args)) {
		if (value === undefined || value === null) continue;
		const payload = (MUTATION_PAYLOAD_FIELDS as readonly string[]).includes(key) && row.spec.class === "mutate";
		if (payload) {
			if (failed || livePayload) rest[key] = key === "edits" ? flattenSingleEdit(value) : value;
			continue;
		}
		if (consumed.has(key)) {
			if (typeof value === "string" && cutFromRow(value, display)) rest[key] = value;
			continue;
		}
		if (row.spec.dropsUnknownArgs === true || (inlineArgValue(value) !== null && !keepScalars)) continue;
		rest[key] = value;
	}
	return rest;
}

/**
 * Whether the row lost part of a field it states in its object: the length
 * limit cut it, or the one-line row flattened a multiline value. A field the
 * row shows whole, a URL (the row names its host and path by design), and a
 * field that is not part of the object at all never repeat.
 */
function cutFromRow(value: string, display: ReturnType<typeof objectDisplay>): boolean {
	if (display === null || display.style === "url") return false;
	const field = displayText(value, display.style);
	if (field.length === 0 || !display.full.includes(field)) return false;
	return /[\r\n\t]/u.test(value.trim()) || !display.shown.includes(field);
}

/** One edit states its two texts as two rows; several stay the list they are. */
function flattenSingleEdit(value: unknown): unknown {
	if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) return value;
	return value[0];
}

/**
 * The arguments a row does not consume, as the card's first body row (`args   limit 30 · related`). The header never
 * carries them; the tier that shows arguments states them here.
 */
export function argumentFactRows(
	row: ResolvedToolRow,
	finished: ToolExecutionFinished | null,
	width: number,
	failure: boolean,
): string[] {
	const scalars = inlineArgs(row, finished);
	if (scalars.length === 0) return [];
	const rail = failure ? RAIL_ERROR() : RAIL_NORMAL();
	return factRows(
		theme,
		[{ label: "args", value: theme.fg("toolArgument", scalars.join(` ${GLYPH.dot} `)) }],
		Math.max(1, width - BODY_INDENT_VISIBLE_WIDTH),
	).map((line) => `${rail}${line}`);
}
