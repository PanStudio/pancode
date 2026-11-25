// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedText } from "../../contracts/session-projection.js";
import type { TimelineItem } from "../../contracts/sessions.js";
import { ACP_ADMISSION_META_KEY, ACP_SHELL_META_KEY, ACP_TOOL_TIMING_META_KEY } from "../../contracts/wire.js";
import { record } from "./client.js";

/**
 * The text of an ACP tool-call content array, or undefined when the frame
 * carries none. Only `{type:"content", content:{type:"text"}}` entries are
 * read: a diff or a terminal entry is structure, not a progress snapshot, and
 * flattening one into a string would show a client something it cannot act on.
 */
function toolProgressText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts = content.flatMap((value) => {
		const entry = record(value);
		if (entry.type !== "content") return [];
		const inner = record(entry.content);
		return inner.type === "text" && typeof inner.text === "string" ? [inner.text] : [];
	});
	return parts.length === 0 ? undefined : parts.join("");
}

/** Image types a tool card draws; anything else (SVG included, which can carry script) is dropped. */
const TOOL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
type ToolImage = NonNullable<TimelineItem["images"]>[number];
const toolImageType = (value: unknown): value is ToolImage["mimeType"] =>
	typeof value === "string" && TOOL_IMAGE_TYPES.has(value);
const TOOL_IMAGES_MAX = 4;
const TOOL_IMAGE_DATA_MAX = 1_048_576;
/**
 * All of one call's image data together stays inside half the timeline's 2 MiB retention bound, as one long
 * message does (session-projection.ts STREAM_LIMIT): four full-size images in one row would evict the rest
 * of the conversation from the snapshot.
 */
const TOOL_IMAGES_TOTAL_MAX = 1_048_576;
const TOOL_IMAGE_LINK_MAX = 4096;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** An image block, bare (`rawOutput.result.content`) or wrapped as ACP tool content (`{type:"content", content}`). */
function imageBlock(value: unknown): Record<string, unknown> | undefined {
	const entry = record(value);
	const inner = entry.type === "content" ? record(entry.content) : entry;
	return inner.type === "image" ? inner : undefined;
}

/** The drawable images of a content array: allow-listed types, base64 data, bounded in count and size. */
function toolImages(content: unknown): ToolImage[] {
	if (!Array.isArray(content)) return [];
	const images: ToolImage[] = [];
	let total = 0;
	for (const value of content) {
		if (images.length >= TOOL_IMAGES_MAX) break;
		const block = imageBlock(value);
		if (block === undefined || !toolImageType(block.mimeType)) continue;
		const data = block.data;
		if (typeof data !== "string" || data.length > TOOL_IMAGE_DATA_MAX || total + data.length > TOOL_IMAGES_TOTAL_MAX)
			continue;
		if (!BASE64.test(data)) continue;
		total += data.length;
		images.push({ mimeType: block.mimeType, data });
	}
	return images;
}

/** Screenshot file paths sent as `resource_link` entries beside the image blocks: local `file:` URIs only. */
function toolImageLinks(content: unknown): Array<{ path: string; name: string }> {
	if (!Array.isArray(content)) return [];
	const links: Array<{ path: string; name: string }> = [];
	for (const value of content) {
		if (links.length >= TOOL_IMAGES_MAX) break;
		const entry = record(value);
		const inner = entry.type === "content" ? record(entry.content) : entry;
		if (inner.type !== "resource_link" || typeof inner.uri !== "string") continue;
		if (!toolImageType(inner.mimeType)) continue;
		if (inner.uri.length > TOOL_IMAGE_LINK_MAX || !inner.uri.startsWith("file:")) continue;
		let path: string;
		try {
			path = fileURLToPath(inner.uri);
		} catch {
			continue;
		}
		const name = typeof inner.name === "string" && inner.name.length > 0 ? inner.name : basename(path);
		links.push({ path: boundedText(path, TOOL_IMAGE_LINK_MAX), name: boundedText(name, 1024) });
	}
	return links;
}

/**
 * A content array with every image's bytes replaced by `{type:"image", mimeType, omitted:true}`. The bytes
 * ride on `TimelineItem.images`; left in `rawOutput` they would push the record past `raw`'s 32 KiB cap and
 * turn the whole result into a truncated snippet.
 */
function withoutImageData(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content.map((value) => {
		const block = imageBlock(value);
		if (block === undefined) return value;
		const omitted = {
			type: "image",
			...(typeof block.mimeType === "string" ? { mimeType: boundedText(block.mimeType, 128) } : {}),
			omitted: true,
		};
		return record(value).type === "content" ? { ...record(value), content: omitted } : omitted;
	});
}

/** `rawOutput` with the image bytes in `result.content` omitted, as `withoutImageData` does for `content`. */
function rawOutputWithoutImageData(rawOutput: unknown): Record<string, unknown> {
	const output = record(rawOutput);
	const result = record(output.result);
	return Array.isArray(result.content)
		? { ...output, result: { ...result, content: withoutImageData(result.content) } }
		: output;
}

/** A tool record kept whole up to 32 KiB; past that only a bounded snippet of its JSON stays. */
function raw(value: unknown) {
	const text = JSON.stringify(value);
	return Buffer.byteLength(text) <= 32768 ? record(value) : { truncated: true, snippet: boundedText(text, 32000) };
}

/** One `tool_call` or `tool_call_update` frame projected onto the row it updates (`previous`, when the turn has one). */
export function projectToolCall(
	update: Record<string, unknown>,
	toolCallId: string,
	meta: Record<string, unknown>,
	previous: TimelineItem | undefined,
	turnId: string,
	origin: TimelineItem["origin"],
	provenance: TimelineItem["provenance"],
): TimelineItem {
	const item: TimelineItem = {
		...previous,
		id: `${turnId}:tool:${toolCallId}`,
		turnId,
		sequence: previous?.sequence ?? 0,
		kind: "tool",
		text: boundedText(typeof update.title === "string" ? update.title : (previous?.text ?? "Tool")),
		status: typeof update.status === "string" ? update.status : (previous?.status ?? "pending"),
		origin,
		title: boundedText(typeof update.title === "string" ? update.title : (previous?.title ?? "Tool"), 4096),
		toolCallId,
		...(typeof update.name === "string" ? { toolName: boundedText(update.name, 128) } : {}),
		...(typeof update.kind === "string" ? { toolKind: update.kind } : {}),
		...(provenance ? { provenance } : {}),
	};
	if (Array.isArray(update.locations))
		item.locations = update.locations
			.flatMap((value) => {
				const location = record(value);
				return typeof location.path === "string"
					? [
							{
								path: boundedText(location.path, 4096),
								...(typeof location.line === "number" && Number.isInteger(location.line) ? { line: location.line } : {}),
							},
						]
					: [];
			})
			.slice(0, 64);
	if (update.rawInput) item.rawInput = raw(update.rawInput);
	// A tool-progress frame is non-terminal and its content is the whole
	// output so far, so it REPLACES the partial text rather than appending.
	// The terminal frame drops it: from then on `rawOutput` is the answer,
	// and leaving a stale snapshot beside it would show two versions of the
	// same output in the same row.
	const settled = item.status === "completed" || item.status === "failed";
	const timing = record(meta[ACP_TOOL_TIMING_META_KEY]).durationMs;
	if (settled && typeof timing === "number" && Number.isSafeInteger(timing) && timing >= 0) item.durationMs = timing;
	// The engine puts the judge's hold on the update's own `_meta`; the frame's `_meta` is read too, so either works.
	const admission = record(record(update._meta)[ACP_ADMISSION_META_KEY] ?? meta[ACP_ADMISSION_META_KEY]);
	if (settled || admission.state === "admitted") delete item.admission;
	else if (admission.state === "judging" && typeof admission.display === "string")
		item.admission = boundedText(admission.display, 128);
	const partial = settled ? undefined : toolProgressText(update.content);
	if (partial !== undefined) item.partialOutput = boundedText(partial, 16384);
	else if (settled) delete item.partialOutput;
	// A settled call's images come from its content, or from the result's own blocks when the content has none.
	if (settled) {
		const fromContent = toolImages(update.content);
		const images = fromContent.length > 0 ? fromContent : toolImages(record(record(update.rawOutput).result).content);
		if (images.length > 0) item.images = images;
		else delete item.images;
		const links = toolImageLinks(update.content);
		if (links.length > 0) item.imageLinks = links;
		else delete item.imageLinks;
	}
	const content = withoutImageData(update.content);
	// A shell line's terminal frame has its facts in `rawOutput` and its output only in `content`.
	if (update.rawOutput && settled && content && meta[ACP_SHELL_META_KEY] !== undefined)
		item.rawOutput = raw({ ...rawOutputWithoutImageData(update.rawOutput), content });
	else if (update.rawOutput) item.rawOutput = raw(rawOutputWithoutImageData(update.rawOutput));
	else if (settled && content) item.rawOutput = raw({ content });
	return item;
}
