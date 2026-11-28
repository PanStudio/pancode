// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import path from "node:path";
import { CHAIN_OUTPUT_TRUNCATED_MARKER, type GatewayChainReceipt } from "../core/tool-surface.js";
import type { ObservedReadRanges } from "../domains/agents/result-contract-types.js";

export interface ReadCitationRequest {
	path: string;
	offset: number | null;
	tail: boolean;
}

/** What a read call asked for, as a citation span is later built from it. */
export function readCitationRequest(args: Record<string, unknown> | undefined): ReadCitationRequest | null {
	const readPath = typeof args?.path === "string" ? args.path.trim() : "";
	if (readPath.length === 0) return null;
	const offset =
		typeof args?.offset === "number" && Number.isFinite(args.offset) && args.offset > 0 ? Math.floor(args.offset) : null;
	return { path: readPath, offset, tail: args?.tail !== undefined };
}

/**
 * The text of a chain step the model actually saw, when the chain cut it to
 * the step's share of the aggregate; null when the step reached the model
 * whole. A cut step grounds only what survived the cut.
 */
export function chainStepVisibleText(child: GatewayChainReceipt): string | null {
	if (child.truncated !== true) return null;
	const content = child.result.content;
	const first = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined) : undefined;
	const text = typeof first?.text === "string" ? first.text : "";
	return text.endsWith(CHAIN_OUTPUT_TRUNCATED_MARKER) ? text.slice(0, -CHAIN_OUTPUT_TRUNCATED_MARKER.length) : text;
}

/**
 * Keys `<rendered path>\0<line>` for every grep line the visible text shows in
 * full. Grep renders a match as `path:line: text` and context as
 * `path-line- text`; the last line of a cut text may be partial and is dropped.
 */
function visibleGrepLineKeys(text: string): Set<string> {
	const keys = new Set<string>();
	const lines = text.split("\n");
	lines.pop();
	for (const line of lines) {
		for (const match of line.matchAll(/([:-])(\d+)\1 /gu)) {
			keys.add(`${line.slice(0, match.index)}\0${match[2]}`);
		}
	}
	return keys;
}

/** Whether a rendered grep path (relative to the search root, or a basename) names this absolute file. */
function grepLineVisible(keys: ReadonlySet<string>, file: string, line: number): boolean {
	const parts = file.split(path.sep).filter((part) => part.length > 0);
	for (let start = parts.length - 1; start >= 0; start -= 1) {
		if (keys.has(`${parts.slice(start).join("/")}\0${line}`)) return true;
	}
	return keys.has(`${file}\0${line}`);
}

export const groundingRanges = (
	observedReadRanges: Map<string, Array<readonly [number, number]>>,
	observedGrepLines: Map<string, Set<number>>,
): ObservedReadRanges => {
	if (observedGrepLines.size === 0) return observedReadRanges;
	const merged = new Map<string, Array<readonly [number, number]>>(observedReadRanges);
	for (const [key, lines] of observedGrepLines) {
		merged.set(key, [...(merged.get(key) ?? []), ...[...lines].map((line) => [line, line] as const)]);
	}
	return merged;
};

/**
 * Fold one successful read into the observed spans. The request says where
 * the model aimed; the result says how many lines it actually received.
 * Only their combination is an honest span, because a byte-capped or
 * end-of-file read returns less than the window that was asked for.
 */
export const recordObservedRead = (
	contractCwd: string,
	observedReadRanges: Map<string, Array<readonly [number, number]>>,
	request: ReadCitationRequest,
	result: unknown,
	visibleText: string | null = null,
): void => {
	const observation = (result as { details?: { observation?: Record<string, unknown> } } | null)?.details?.observation;
	if (!observation) return;
	const returned = observation.shownCount;
	const total = observation.totalCount;
	if (typeof returned !== "number" || !Number.isFinite(returned) || returned <= 0) return;
	// A chain that cut the step showed the model its first complete lines
	// only: one output line per file line, so the newlines before the cut
	// count them, and a partial last line is not seen.
	const shown = visibleText === null ? returned : Math.min(returned, visibleText.split("\n").length - 1);
	if (shown <= 0) return;
	// A tail read lands at the end of the file, so it can only be placed once
	// the total line count is known; without it the span is dropped rather
	// than guessed, which costs a citation but never invents grounding.
	let start: number;
	if (request.tail) {
		if (typeof total !== "number" || !Number.isFinite(total)) return;
		start = Math.max(1, Math.floor(total) - returned + 1);
	} else {
		start = request.offset ?? 1;
	}
	const key = path.resolve(contractCwd, request.path);
	const spans = observedReadRanges.get(key) ?? [];
	spans.push([start, start + shown - 1] as const);
	observedReadRanges.set(key, spans);
};

/**
 * Fold the lines a grep result showed into the grounding set. `visibleText`
 * is the part of a chain-cut step the model saw; only lines shown there in
 * full count.
 */
export const recordObservedGrep = (
	observedGrepLines: Map<string, Set<number>>,
	details: unknown,
	visibleText: string | null = null,
): void => {
	const shown = (details as { observedLines?: unknown } | null)?.observedLines;
	if (shown === null || typeof shown !== "object" || Array.isArray(shown)) return;
	const visible = visibleText === null ? null : visibleGrepLineKeys(visibleText);
	for (const [file, lines] of Object.entries(shown as Record<string, unknown>)) {
		if (!Array.isArray(lines) || !path.isAbsolute(file)) continue;
		const bucket = observedGrepLines.get(file) ?? new Set<number>();
		for (const line of lines) {
			if (!Number.isInteger(line) || line <= 0) continue;
			if (visible !== null && !grepLineVisible(visible, file, line)) continue;
			bucket.add(line);
		}
		if (bucket.size > 0) observedGrepLines.set(file, bucket);
	}
};

/** Spans quoted back to the model, as `path:start-end`. */
export const observedReadAnchors = (
	contractCwd: string,
	observedReadRanges: Map<string, Array<readonly [number, number]>>,
): string[] =>
	[...observedReadRanges.entries()].flatMap(([key, spans]) =>
		spans.map(([start, end]) => `${path.relative(contractCwd, key) || key}:${start}-${end}`),
	);
