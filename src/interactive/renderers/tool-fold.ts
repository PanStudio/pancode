// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { isRecord } from "../../core/type-guards.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { visibleWidth } from "../../engine/tui.js";
import { CLASS_NOUNS, type ToolClass } from "../../tools/presentation.js";
/** Compact transcript grouping: which settled calls fold together, the folded group row, and the body test. */
import { cardHead, cardRows } from "../card.js";
import { joinFacts } from "../theme/index.js";
import { previewRows } from "./preview.js";
import {
	ARG_PREVIEW_LIMIT,
	BODY_INDENT_VISIBLE_WIDTH,
	detailsOf,
	green,
	presentedCall,
	RAIL_ERROR,
	RAIL_NORMAL,
	red,
	SEP,
	STATUS_OK_GLYPH,
	type ToolExecutionFinished,
	type ToolExecutionStart,
	theme,
	toolMeta,
	truncate,
} from "./tool-call-model.js";
import { isTruncatedResult, offloadPathOf, skillLoadFacts } from "./tool-facts.js";
import { changeStat } from "./tool-result-text.js";
import { classMark, resolveRow, rowObject, styledVerb } from "./tool-subline.js";

/**
 * Whether rendered action rows include a nested body (arguments, output, a
 * diff, approval facts, or a preview hint) rather than only the action row and
 * its wrapped continuation. The transcript stacks body-less actions and puts a
 * gap around the rest.
 */
export function hasToolBody(lines: readonly string[]): boolean {
	return lines.some((line) => line.startsWith(RAIL_NORMAL()) || line.startsWith(RAIL_ERROR()));
}

/** Whether a call changed files or ran a command: what `/view` lists under Diffs & checks, ahead of the rest of the transcript. */
export function isChangeOrCheckCall(wire: ToolExecutionStart | ToolExecutionFinished): boolean {
	const toolClass = resolveRow(wire).spec.class;
	return toolClass === "mutate" || toolClass === "execute";
}

/** Which Compact fold a settled call can join: explorations, knowledge lookups, or changes. */
export type ToolFoldFamily = "explore" | "knowledge" | "mutate";

/**
 * The fold a settled call joins in Compact, by class. Observations and
 * searches fold together, knowledge lookups fold, changes fold; commands,
 * fetches, delegations and questions never do. A failure, a skill load, and a
 * call whose result was cut, offloaded or evicted keep their own rows: each
 * has a fact the folded row cannot carry.
 */
export function toolFoldFamily(wire: ToolExecutionFinished): ToolFoldFamily | null {
	const call = presentedCall(wire);
	if (call.isError || call.outcome !== undefined || call.evictedReason !== undefined || call.autoApproved !== undefined)
		return null;
	if (isTruncatedResult(call) || offloadPathOf(call) !== null || skillLoadFacts(call) !== null) return null;
	const toolClass = resolveRow(call).spec.class;
	if (toolClass === "observe" || toolClass === "search") return "explore";
	if (toolClass === "knowledge") return "knowledge";
	if (toolClass === "mutate") return "mutate";
	return null;
}

function countNouns(calls: readonly ToolExecutionFinished[]): string {
	const counts = new Map<string, { singular: string; plural: string; count: number }>();
	for (const wire of calls) {
		const row = resolveRow(presentedCall(wire));
		const [singular, plural] = row.spec.nouns ?? CLASS_NOUNS[row.spec.class];
		const entry = counts.get(singular) ?? { singular, plural, count: 0 };
		entry.count += 1;
		counts.set(singular, entry);
	}
	return [...counts.values()]
		.map((entry) => `${entry.count} ${entry.count === 1 ? entry.singular : entry.plural}`)
		.join(", ");
}

/**
 * A run of settled calls of one fold family, in Compact: one row that counts
 * them, and their targets nested beneath it. Changes keep each file's change
 * facts, since those are what a change is. Durations and byte counts stay in
 * `/view`.
 */
export function renderFoldedGroup(
	family: ToolFoldFamily,
	calls: readonly ToolExecutionFinished[],
	width: number,
	maxRows: number,
): string[] {
	const targets: string[] = [];
	let added = 0;
	let removed = 0;
	let complete = true;
	for (const wire of calls) {
		const call = presentedCall(wire);
		const row = resolveRow(call);
		const scope = row.spec.scope?.(row.args, row.context) ?? null;
		const target = `${rowObject(row, call, width)}${scope === null ? "" : ` in ${truncate(sanitizeCallTargetText(scope), ARG_PREVIEW_LIMIT)}`}`;
		if (family !== "mutate") {
			// A call whose spec names no single object (a multi-path read) adds nothing, rather than a bare separator.
			if (visibleWidth(target) > 0) targets.push(target);
			continue;
		}
		const stat = changeStat(call.result);
		if (stat === null) complete = false;
		else {
			added += stat.added;
			removed += stat.removed;
		}
		const file = detailsOf(call.result)?.file;
		const created = isRecord(file) && "before" in file && file.before === null;
		targets.push(
			`${target}${stat === null ? "" : ` ${green(`+${stat.added}`)} ${red(`-${stat.removed}`)}`}${created ? toolMeta(" new") : ""}`,
		);
	}
	const toolClass: ToolClass = family === "explore" ? "observe" : family;
	const verb = family === "explore" ? "explored" : family === "knowledge" ? "consulted" : "edited";
	const totals = family === "mutate" && complete ? `${toolMeta(SEP)}${green(`+${added}`)} ${red(`-${removed}`)}` : "";
	const head = `${classMark(toolClass)}${styledVerb(verb)} ${theme.fg("toolSummary", countNouns(calls))}${totals} ${green(STATUS_OK_GLYPH)}`;
	const body = cardRows(joinFacts(targets, toolMeta), width, false);
	return [
		...cardHead(head, "", width),
		...previewRows(body, maxRows, width, false, RAIL_NORMAL(), BODY_INDENT_VISIBLE_WIDTH),
	];
}
