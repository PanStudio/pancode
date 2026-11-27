// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * What an MCP server says about its tools and what a tool call returns, read
 * into PanCode's shapes: tool descriptors, content blocks, the bounded plain
 * rendering the model reads, and the check of `structuredContent` against the
 * tool's `outputSchema`. Nothing here touches a transport.
 */

import { isRecord } from "../../../core/type-guards.js";
import { McpError, structuredContentJson } from "./protocol.js";

export const DEFAULT_RESULT_TEXT_BYTES = 1024 * 1024;
/** Serialized size of an outputSchema PanCode will evaluate. */
const OUTPUT_SCHEMA_MAX_BYTES = 256 * 1024;
/** Nesting depth and subschema count of an outputSchema PanCode will evaluate (2026-07-28 basic, composition bounds). */
const OUTPUT_SCHEMA_MAX_DEPTH = 64;
const OUTPUT_SCHEMA_MAX_SUBSCHEMAS = 4096;
/** Mismatches one tool error names. */
const OUTPUT_SCHEMA_ERRORS_SHOWN = 3;
/** JSON Schema dialects whose keywords the shipped validator evaluates; no `$schema` means 2020-12. */
const VALIDATED_DIALECTS: ReadonlySet<string> = new Set(
	[
		"https://json-schema.org/draft/2020-12/schema",
		"https://json-schema.org/draft/2019-09/schema",
		"http://json-schema.org/draft-07/schema",
		"http://json-schema.org/draft-06/schema",
		"http://json-schema.org/draft-04/schema",
	].flatMap((uri) => [uri, `${uri}#`]),
);

export interface McpToolDescriptor {
	name: string;
	title: string | null;
	description: string;
	inputSchema: Record<string, unknown>;
	/** The JSON Schema the tool's structuredContent conforms to, when it declares one. */
	outputSchema?: Record<string, unknown>;
	/** Server-declared hints; advisory defaults, overridden by operator policy. */
	annotations: Record<string, unknown> | null;
}

export type McpContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; mimeType: string; data: string }
	| { type: "audio"; mimeType: string; data: string }
	| { type: "resource"; uri: string; text?: string; blob?: string; mimeType?: string }
	| { type: "other"; raw: unknown };

export interface McpToolCallResult {
	content: McpContentBlock[];
	isError: boolean;
	/** JSON-safe values; numeric tokens that do not round-trip use {$literal: source}. */
	structuredContent?: unknown;
	/** Normalized structured JSON retaining numeric source tokens, bounded by the incoming-line cap. */
	structuredContentJson?: string;
	/** Why structuredContent does not match, or cannot be checked against, the tool's outputSchema; isError is set with it. */
	outputSchemaMismatch?: string;
	/** Bounded plain rendering of the content blocks. */
	text: string;
	textTruncated: boolean;
}

/** Cut a string at a UTF-8 byte boundary at or below `maxBytes`. */
export function cutUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const bytes = Buffer.from(text, "utf8");
	let cut = Math.max(0, maxBytes);
	while (cut > 0) {
		const byte = bytes[cut];
		if (byte === undefined || (byte & 0xc0) !== 0x80) break;
		cut -= 1;
	}
	return bytes.subarray(0, cut).toString("utf8");
}

export function parseToolDescriptor(value: unknown): McpToolDescriptor | McpError {
	if (!isRecord(value)) return new McpError("protocol", "tools/list entry is not an object");
	if (typeof value.name !== "string" || value.name.length === 0) {
		return new McpError("protocol", "tools/list entry lacks a name");
	}
	const inputSchema = isRecord(value.inputSchema) ? value.inputSchema : { type: "object" };
	return {
		name: value.name,
		title: typeof value.title === "string" ? value.title : null,
		description: typeof value.description === "string" ? value.description : "",
		inputSchema,
		...(isRecord(value.outputSchema) ? { outputSchema: value.outputSchema } : {}),
		annotations: isRecord(value.annotations) ? value.annotations : null,
	};
}

function normalizeContentBlock(value: unknown): McpContentBlock {
	if (!isRecord(value) || typeof value.type !== "string") return { type: "other", raw: value };
	switch (value.type) {
		case "text":
			return typeof value.text === "string" ? { type: "text", text: value.text } : { type: "other", raw: value };
		case "image":
		case "audio":
			if (typeof value.data === "string" && typeof value.mimeType === "string") {
				return { type: value.type, mimeType: value.mimeType, data: value.data };
			}
			return { type: "other", raw: value };
		case "resource": {
			const resource = value.resource;
			if (!isRecord(resource) || typeof resource.uri !== "string") return { type: "other", raw: value };
			return {
				type: "resource",
				uri: resource.uri,
				...(typeof resource.text === "string" ? { text: resource.text } : {}),
				...(typeof resource.text !== "string" && typeof resource.blob === "string" ? { blob: resource.blob } : {}),
				...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
			};
		}
		case "resource_link":
			if (typeof value.uri !== "string") return { type: "other", raw: value };
			return {
				type: "resource",
				uri: value.uri,
				...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
			};
		default:
			return { type: "other", raw: value };
	}
}

/** The bracketed line a binary block renders as; `pointer` says where its bytes were written. */
function binaryLine(label: string, mimeType: string | undefined, base64: string, pointer: string | null): string {
	const described = `${label}${mimeType !== undefined ? ` ${mimeType}` : ""}, ${Buffer.byteLength(base64, "base64")} bytes`;
	return pointer === null ? `[${described}]` : `[${described}; base64 ${pointer}]`;
}

function renderContentBlock(block: McpContentBlock, pointerOf: (block: McpContentBlock) => string | null): string {
	switch (block.type) {
		case "text":
			return block.text;
		case "image":
		case "audio":
			return binaryLine(block.type, block.mimeType, block.data, pointerOf(block));
		case "resource":
			if (block.blob !== undefined)
				return binaryLine(`resource ${block.uri}`, block.mimeType, block.blob, pointerOf(block));
			return block.text === undefined ? `[resource ${block.uri}]` : `[resource ${block.uri}]\n${block.text}`;
		case "other": {
			const type = isRecord(block.raw) && typeof block.raw.type === "string" ? block.raw.type : "unknown";
			return `[unsupported content type ${type}]`;
		}
	}
}

/**
 * Render every block as plain text and bound the whole rendering. A binary
 * block (an image, audio, or an embedded resource blob) renders as its type,
 * mime type and size; `pointerOf` names where its bytes were offloaded.
 */
export function renderMcpContent(
	blocks: ReadonlyArray<McpContentBlock>,
	maxBytes: number = DEFAULT_RESULT_TEXT_BYTES,
	pointerOf: (block: McpContentBlock) => string | null = () => null,
): { text: string; truncated: boolean } {
	const joined = blocks.map((block) => renderContentBlock(block, pointerOf)).join("\n");
	if (Buffer.byteLength(joined, "utf8") <= maxBytes) return { text: joined, truncated: false };
	const marker = `\n[mcp result text truncated at ${maxBytes} bytes]`;
	const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
	return { text: `${cutUtf8(joined, budget)}${marker}`, truncated: true };
}

export function parseToolCallResult(value: unknown, maxTextBytes: number): McpToolCallResult | McpError {
	if (!isRecord(value)) return new McpError("protocol", "tools/call result is not an object");
	if (!Array.isArray(value.content)) return new McpError("protocol", "tools/call result.content must be an array");
	if (value.isError !== undefined && typeof value.isError !== "boolean") {
		return new McpError("protocol", "tools/call result.isError must be a boolean");
	}
	const hasStructured = Object.hasOwn(value, "structuredContent") && value.structuredContent !== undefined;
	const content = value.content.map(normalizeContentBlock);
	const structuredText = structuredContentJson(value);
	// Use transport-retained numeric tokens, not reserialized JS numbers.
	// The evidence object uses explicit $literal tags for non-round-trips.
	const rendered = renderMcpContent(
		content.length === 0 && hasStructured
			? [{ type: "text", text: structuredText ?? JSON.stringify(value.structuredContent) }]
			: content,
		maxTextBytes,
	);
	const result: McpToolCallResult = {
		content,
		isError: value.isError === true,
		text: rendered.text,
		textTruncated: rendered.truncated,
	};
	if (hasStructured) result.structuredContent = value.structuredContent;
	if (structuredText !== undefined) result.structuredContentJson = structuredText;
	return result;
}

/** Why a schema cannot be evaluated safely, or null. Network references are never fetched (2026-07-28 basic, $ref resolution). */
function outputSchemaRefusal(schema: Record<string, unknown>): string | null {
	let serialized: string;
	try {
		serialized = JSON.stringify(schema);
	} catch {
		return "it cannot be serialized";
	}
	if (Buffer.byteLength(serialized, "utf8") > OUTPUT_SCHEMA_MAX_BYTES) {
		return `it is larger than ${OUTPUT_SCHEMA_MAX_BYTES} bytes`;
	}
	const dialect = schema.$schema;
	if (dialect !== undefined && (typeof dialect !== "string" || !VALIDATED_DIALECTS.has(dialect))) {
		return `it declares the JSON Schema dialect ${JSON.stringify(dialect)}, which PanCode does not validate`;
	}
	const resolves = (pointer: string): boolean => {
		let node: unknown = schema;
		for (const raw of pointer.split("/").slice(1)) {
			const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
			if (Array.isArray(node)) node = node[Number(key)];
			else if (isRecord(node) && Object.hasOwn(node, key)) node = node[key];
			else return false;
		}
		return node !== undefined;
	};
	let subschemas = 0;
	const walk = (node: unknown, depth: number): string | null => {
		if (Array.isArray(node)) {
			for (const item of node) {
				const refused = walk(item, depth + 1);
				if (refused !== null) return refused;
			}
			return null;
		}
		if (!isRecord(node)) return null;
		subschemas += 1;
		if (depth > OUTPUT_SCHEMA_MAX_DEPTH) return `it nests deeper than ${OUTPUT_SCHEMA_MAX_DEPTH} levels`;
		if (subschemas > OUTPUT_SCHEMA_MAX_SUBSCHEMAS) return `it has more than ${OUTPUT_SCHEMA_MAX_SUBSCHEMAS} subschemas`;
		for (const keyword of ["$ref", "$dynamicRef"]) {
			const ref = node[keyword];
			if (typeof ref !== "string") continue;
			if (!ref.startsWith("#")) return `it refers to ${JSON.stringify(ref)}, which PanCode does not fetch`;
			if (ref.startsWith("#/") && !resolves(ref.slice(1))) return `its ${keyword} ${JSON.stringify(ref)} does not resolve`;
		}
		for (const value of Object.values(node)) {
			const refused = walk(value, depth + 1);
			if (refused !== null) return refused;
		}
		return null;
	};
	return walk(schema, 0);
}

/** The value a validator sees: a {$literal} tag stands for the number its source token spells. */
function literalNumbers(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(literalNumbers);
	if (!isRecord(value)) return value;
	const keys = Object.keys(value);
	if (keys.length === 1 && keys[0] === "$literal" && typeof value.$literal === "string") return Number(value.$literal);
	return Object.fromEntries(keys.map((key) => [key, literalNumbers(value[key])]));
}

/**
 * Check one result's structuredContent against the tool's outputSchema with
 * the JSON Schema validator PanCode ships. Null means it conforms; otherwise
 * the reason names the failing paths, or why the schema could not be used,
 * since a schema that cannot be evaluated is not treated as permissive.
 */
export async function outputSchemaMismatch(schema: Record<string, unknown>, value: unknown): Promise<string | null> {
	const refused = outputSchemaRefusal(schema);
	if (refused !== null) return `its outputSchema cannot be checked: ${refused}`;
	const { Value } = await import("typebox/value");
	const candidate = literalNumbers(value);
	try {
		if (Value.Check(schema as never, candidate)) return null;
		const failures: string[] = [];
		for (const error of Value.Errors(schema as never, candidate)) {
			failures.push(`at ${error.instancePath === "" ? "(root)" : error.instancePath}: ${error.message}`);
			if (failures.length >= OUTPUT_SCHEMA_ERRORS_SHOWN) break;
		}
		return `structuredContent does not match its outputSchema: ${failures.length > 0 ? failures.join("; ") : "rejected"}`;
	} catch (error) {
		return `its outputSchema cannot be checked: ${error instanceof Error ? error.message : String(error)}`;
	}
}
