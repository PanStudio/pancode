// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** The live write and edit payload a running mutation streams, and a running command's live output. */
import { ToolNames } from "../../core/tool-names.js";
import { isRecord } from "../../core/type-guards.js";
import { formatSize } from "../../core/views/tool-words.js";
import type { LiveToolView } from "./live-tool-view.js";
import {
	BODY_INDENT_VISIBLE_WIDTH,
	detailsOf,
	RAIL_NORMAL,
	type ToolExecutionFinished,
	type ToolExecutionStart,
} from "./tool-call-model.js";
import { resultText, unwrapResultEnvelope } from "./tool-result-text.js";

/** One edit entry as far as the model has streamed it. */
interface LiveEdit {
	oldText?: string;
	newText?: string;
}

/**
 * A write or edit still in flight. Its payload is the part that streams, so it
 * renders as live rows under the action and never passes through the row's
 * identity, whose redaction and layout would otherwise read the whole file on
 * every frame.
 */
interface LivePayload {
	tool: "write" | "edit";
	path: string | undefined;
	content: string | undefined;
	edits: LiveEdit[];
}

const LIVE_PAYLOAD_TOOLS: ReadonlySet<string> = new Set([ToolNames.Write, ToolNames.Edit]);
const LIVE_PAYLOAD_FIELDS = ["content", "edits", "oldText", "newText"] as const;

export function livePayloadOf(call: ToolExecutionStart | ToolExecutionFinished): LivePayload | null {
	if ("result" in call || !LIVE_PAYLOAD_TOOLS.has(call.toolName) || !isRecord(call.args)) return null;
	const args = call.args;
	const path = typeof args.path === "string" && args.path.length > 0 ? args.path : undefined;
	if (call.toolName === ToolNames.Write) {
		return { tool: "write", path, content: typeof args.content === "string" ? args.content : undefined, edits: [] };
	}
	const entries: unknown[] = Array.isArray(args.edits) ? args.edits : [args];
	const edits: LiveEdit[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const edit: LiveEdit = {};
		if (typeof entry.oldText === "string") edit.oldText = entry.oldText;
		if (typeof entry.newText === "string") edit.newText = entry.newText;
		if (edit.oldText !== undefined || edit.newText !== undefined) edits.push(edit);
	}
	return { tool: "edit", path, content: undefined, edits };
}

export function withoutLivePayload<T extends ToolExecutionStart | ToolExecutionFinished>(call: T): T {
	if ("result" in call || !LIVE_PAYLOAD_TOOLS.has(call.toolName) || !isRecord(call.args)) return call;
	const args: Record<string, unknown> = { ...call.args };
	for (const key of LIVE_PAYLOAD_FIELDS) delete args[key];
	return { ...call, args };
}

function lineNoun(count: number): string {
	return `${count} ${count === 1 ? "line" : "lines"}`;
}

/**
 * Index what has streamed and state it for the row: `146 lines`, `3 edits`. An edit states no `+` and `-` counts
 * here: the old and new text's line counts are not its diff, so `preparing · +5 -3` sat above an applied `+3 -1`.
 * The applied row's diff is the only count.
 */
export function livePayloadFact(payload: LivePayload, view: LiveToolView): string | undefined {
	if (payload.tool === "write") {
		if (payload.content === undefined) return undefined;
		const tail = view.tail("content", payload.path);
		tail.update(payload.content);
		return tail.lineCount > 0 ? lineNoun(tail.lineCount) : undefined;
	}
	payload.edits.forEach((edit, index) => {
		if (edit.oldText !== undefined) view.tail(`${index}:old`, payload.path).update(edit.oldText);
		if (edit.newText !== undefined) view.tail(`${index}:new`, payload.path).update(edit.newText);
	});
	return payload.edits.length > 1 ? `${payload.edits.length} edits` : undefined;
}

/**
 * The newest streamed rows: a write's content, or the edit being written, its
 * replacement as `+` rows once that starts and the text it replaces as `-`
 * rows before.
 */
export function livePayloadRows(payload: LivePayload, view: LiveToolView, limit: number, width: number): string[] {
	const rail = { rail: RAIL_NORMAL(), railWidth: BODY_INDENT_VISIBLE_WIDTH };
	if (payload.tool === "write") {
		return payload.content === undefined ? [] : view.tail("content", payload.path).rows(limit, width, rail);
	}
	const index = payload.edits.length - 1;
	const edit = payload.edits[index];
	if (edit === undefined) return [];
	return edit.newText !== undefined
		? view.tail(`${index}:new`, payload.path).rows(limit, width, { ...rail, sign: "+" })
		: view.tail(`${index}:old`, payload.path).rows(limit, width, { ...rail, sign: "-" });
}

/** A running command's cumulative output as text, without reading it twice. */
export function liveCommandOutput(partial: unknown): { text: string; truncatedTotal?: string } | null {
	if (isRecord(partial) && Object.keys(partial).every((key) => key === "details")) return null;
	const unwrapped = unwrapResultEnvelope(partial);
	const text = typeof unwrapped === "string" ? unwrapped : resultText(unwrapped, Number.POSITIVE_INFINITY);
	const size = isRecord(partial) ? detailsOf(partial)?.resultSize : undefined;
	if (!isRecord(size) || size.truncated !== true) return { text };
	return typeof size.bytes === "number" ? { text, truncatedTotal: formatSize(size.bytes) } : { text };
}
