// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * What an MCP server says about its resources, resource templates and prompts,
 * read into PanCode's shapes (MCP 2026-07-28 server/resources, server/prompts,
 * server/utilities/completion; 2025-11-25 for the legacy era). Nothing here
 * touches a transport.
 */

import { isRecord } from "../../../core/type-guards.js";
import { JSON_RPC_INVALID_PARAMS, MCP_RESOURCE_NOT_FOUND, McpError } from "./protocol.js";
import { type McpContentBlock, normalizeContentBlock } from "./tool-results.js";

/** Resources plus resource templates one listing keeps; the rest is reported as truncated. */
export const MCP_RESOURCE_LIST_CAP = 500;
/** Prompts one listing keeps; a slash command list longer than this is not one an operator reads. */
export const MCP_PROMPT_LIST_CAP = 200;
/** The spec's own ceiling on one completion answer (server/utilities/completion). */
const MCP_COMPLETION_VALUES_CAP = 100;

export interface McpResourceDescriptor {
	uri: string;
	name: string;
	title: string | null;
	description: string;
	mimeType: string | null;
	/** Size in bytes, when the server states it. */
	size: number | null;
}

export interface McpResourceTemplateDescriptor {
	/** An RFC 6570 URI template. */
	uriTemplate: string;
	name: string;
	title: string | null;
	description: string;
	mimeType: string | null;
}

export interface McpResourceListing {
	resources: McpResourceDescriptor[];
	templates: McpResourceTemplateDescriptor[];
	/** True when the server offered more than MCP_RESOURCE_LIST_CAP or the page cap admits. */
	truncated: boolean;
	/** Modern era: the shortest freshness hint of every page; absent or negative reads as 0. */
	ttlMs?: number;
}

/** One entry of a `resources/read` answer: text, or base64 bytes. */
export type McpResourceContents =
	| { uri: string; mimeType: string | null; text: string }
	| { uri: string; mimeType: string | null; blob: string };

export interface McpResourceRead {
	contents: McpResourceContents[];
	ttlMs?: number;
}

export interface McpPromptArgument {
	name: string;
	title: string | null;
	description: string;
	required: boolean;
}

export interface McpPromptDescriptor {
	name: string;
	title: string | null;
	description: string;
	arguments: McpPromptArgument[];
}

export interface McpPromptListing {
	prompts: McpPromptDescriptor[];
	truncated: boolean;
	ttlMs?: number;
}

export interface McpPromptMessage {
	role: "user" | "assistant";
	content: McpContentBlock;
}

export interface McpPromptResult {
	description: string | null;
	messages: McpPromptMessage[];
}

export type McpCompletionReference = { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string };

export interface McpCompletion {
	values: string[];
	total: number | null;
	hasMore: boolean;
}

/**
 * An MCP Apps view (`ui://`, or the app profile of text/html). Apps are not a
 * PanCode surface, so these are never listed, mentioned or read.
 */
export function isMcpAppResource(uri: string, mimeType: string | null | undefined): boolean {
	return (
		uri.toLowerCase().startsWith("ui://") ||
		(typeof mimeType === "string" && /^text\/html\s*;\s*profile\s*=\s*"?mcp-app"?/iu.test(mimeType))
	);
}

/**
 * A server's answer that the resource does not exist: -32602 in 2026-07-28
 * and -32002 in earlier revisions, which a client still accepts
 * (server/resources, Error Handling).
 */
export function isMcpResourceNotFound(error: unknown): boolean {
	if (!(error instanceof McpError) || error.code !== "server" || !isRecord(error.data)) return false;
	return error.data.code === JSON_RPC_INVALID_PARAMS || error.data.code === MCP_RESOURCE_NOT_FOUND;
}

function stringOr(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function parseResourceDescriptor(value: unknown): McpResourceDescriptor | McpError {
	if (!isRecord(value) || typeof value.uri !== "string" || value.uri.length === 0) {
		return new McpError("protocol", "resources/list entry lacks a uri");
	}
	return {
		uri: value.uri,
		name: stringOr(value.name, value.uri),
		title: nullableString(value.title),
		description: stringOr(value.description, ""),
		mimeType: nullableString(value.mimeType),
		size: typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : null,
	};
}

export function parseResourceTemplate(value: unknown): McpResourceTemplateDescriptor | McpError {
	if (!isRecord(value) || typeof value.uriTemplate !== "string" || value.uriTemplate.length === 0) {
		return new McpError("protocol", "resources/templates/list entry lacks a uriTemplate");
	}
	return {
		uriTemplate: value.uriTemplate,
		name: stringOr(value.name, value.uriTemplate),
		title: nullableString(value.title),
		description: stringOr(value.description, ""),
		mimeType: nullableString(value.mimeType),
	};
}

export function parseResourceRead(value: unknown): McpResourceContents[] | McpError {
	if (!isRecord(value) || !Array.isArray(value.contents)) {
		return new McpError("protocol", "resources/read result lacks a contents array");
	}
	const contents: McpResourceContents[] = [];
	for (const entry of value.contents) {
		if (!isRecord(entry) || typeof entry.uri !== "string") {
			return new McpError("protocol", "resources/read contents entry lacks a uri");
		}
		const mimeType = nullableString(entry.mimeType);
		if (typeof entry.text === "string") contents.push({ uri: entry.uri, mimeType, text: entry.text });
		else if (typeof entry.blob === "string") contents.push({ uri: entry.uri, mimeType, blob: entry.blob });
		else return new McpError("protocol", "resources/read contents entry carries neither text nor blob");
	}
	return contents;
}

export function parsePromptDescriptor(value: unknown): McpPromptDescriptor | McpError {
	if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
		return new McpError("protocol", "prompts/list entry lacks a name");
	}
	const args: McpPromptArgument[] = [];
	for (const entry of Array.isArray(value.arguments) ? value.arguments : []) {
		if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.length === 0) {
			return new McpError("protocol", `prompts/list entry ${value.name} has an argument without a name`);
		}
		args.push({
			name: entry.name,
			title: nullableString(entry.title),
			description: stringOr(entry.description, ""),
			required: entry.required === true,
		});
	}
	return {
		name: value.name,
		title: nullableString(value.title),
		description: stringOr(value.description, ""),
		arguments: args,
	};
}

export function parsePromptResult(value: unknown): McpPromptResult | McpError {
	if (!isRecord(value) || !Array.isArray(value.messages)) {
		return new McpError("protocol", "prompts/get result lacks a messages array");
	}
	const messages: McpPromptMessage[] = [];
	for (const entry of value.messages) {
		if (!isRecord(entry) || (entry.role !== "user" && entry.role !== "assistant")) {
			return new McpError("protocol", "prompts/get message has no user or assistant role");
		}
		messages.push({ role: entry.role, content: normalizeContentBlock(entry.content) });
	}
	return { description: nullableString(value.description), messages };
}

export function parseCompletion(value: unknown): McpCompletion | McpError {
	const completion = isRecord(value) ? value.completion : undefined;
	if (!isRecord(completion) || !Array.isArray(completion.values)) {
		return new McpError("protocol", "completion/complete result lacks completion.values");
	}
	const values = completion.values
		.filter((entry): entry is string => typeof entry === "string")
		.slice(0, MCP_COMPLETION_VALUES_CAP);
	return {
		values,
		total: typeof completion.total === "number" && Number.isSafeInteger(completion.total) ? completion.total : null,
		hasMore: completion.hasMore === true || completion.values.length > values.length,
	};
}
