// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * MCP prompts and resources as operator syntax: `/<id>:<prompt> args` becomes
 * the server's prompt as one operator turn, and `@<id>:<uri>` inlines the
 * resource. Everything the server wrote stays inside an origin tag naming the
 * server, so the model never reads it as the operator's own words.
 */

import { neutralizeFraming } from "../../core/reminder-framing.js";
import { mcpToolName } from "../../core/tool-names.js";
import {
	isMcpAppResource,
	type McpContentBlock,
	type McpResourceContents,
	resourceLinkLine,
} from "../../domains/gateway/mcp/index.js";
import type {
	McpResourceCandidate,
	McpSubmitAnswer,
	McpSubmitReader,
} from "../../domains/resources/submit-expansion.js";
import { parseCommandArgs } from "../../engine/prompt-templates.js";
import type { ImageContent } from "../../engine/types.js";
import { prepareBoundedImage } from "../file-references.js";
import type { McpCapabilitySource, McpPromptCommand } from "./mcp-capability-types.js";

/** One resource's text in a turn; the rest is named, and the model reads it with the read capability. */
const RESOURCE_TEXT_BYTES = 64 * 1024;
/** A whole expanded prompt. */
const PROMPT_TEXT_BYTES = 256 * 1024;
/** The `@image` attachment bound. */
const IMAGE_BASE64_BYTES = 4.5 * 1024 * 1024;
/** Decoded image ceiling before resizing, bounding allocation on untrusted server blobs. */
const IMAGE_DECODE_MAX_BYTES = 20 * 1024 * 1024;
/** Maximum images one MCP prompt or mention may attach to a turn. */
const MAX_SUBMIT_IMAGES = 8;
const ATTACHABLE_IMAGE = /^image\/(png|jpe?g|gif|webp)$/iu;
const VALID_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

const PROMPT_LINE = /^\s*\/([a-z0-9][a-z0-9_-]*):(\S+)(?:\s+([\s\S]*))?$/u;

function attribute(value: string): string {
	return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");
}

/** Server text that cannot open or close a host frame or the origin tag around it. */
function serverText(text: string): string {
	return neutralizeFraming(text).replace(/<\s*\/\s*(mcp_resource|mcp_prompt)/giu, "<\\/$1");
}

function clipBytes(text: string, max: number): { text: string; clipped: number | null } {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= max) return { text, clipped: null };
	return {
		text: Buffer.from(text, "utf8")
			.subarray(0, max)
			.toString("utf8")
			.replace(/\uFFFD$/u, ""),
		clipped: bytes,
	};
}

function blobBytes(base64: string): number {
	return Math.floor((base64.replace(/=+$/u, "").length * 3) / 4);
}

async function attachImage(data: string, mimeType: string, images: ImageContent[]): Promise<ImageContent | null> {
	if (images.length >= MAX_SUBMIT_IMAGES || !ATTACHABLE_IMAGE.test(mimeType)) return null;
	const compact = data.replace(/\s+/gu, "");
	if (compact.length === 0 || compact.length % 4 !== 0 || !VALID_BASE64.test(compact)) return null;
	if (blobBytes(compact) > IMAGE_DECODE_MAX_BYTES) return null;
	const prepared = await prepareBoundedImage(Buffer.from(compact, "base64"), IMAGE_BASE64_BYTES);
	if (prepared === null) return null;
	images.push(prepared);
	return prepared;
}

/** One resource's contents inside its origin tag: text bounded, an image attached, other bytes named. */
async function resourceTag(
	serverId: string,
	entry: { uri: string; mimeType: string | null; text?: string; blob?: string },
	images: ImageContent[],
	canReadResources: boolean,
): Promise<string> {
	const read = mcpToolName(serverId, ":read_resource");
	const open = `<mcp_resource server="${serverId}" uri="${attribute(entry.uri)}"${entry.mimeType !== null ? ` mimeType="${attribute(entry.mimeType)}"` : ""}>`;
	let body: string;
	if (entry.text !== undefined) {
		const clipped = clipBytes(entry.text, RESOURCE_TEXT_BYTES);
		body = serverText(clipped.text);
		if (clipped.clipped !== null)
			body += `\n[truncated: the first ${RESOURCE_TEXT_BYTES} of ${clipped.clipped} bytes${canReadResources && read !== null ? `; read the rest with ${read}` : ""}]`;
	} else if (entry.blob !== undefined) {
		const size = blobBytes(entry.blob);
		const attached = entry.mimeType !== null ? await attachImage(entry.blob, entry.mimeType, images) : null;
		body =
			attached !== null
				? `[image ${attached.mimeType} attached, ${size} bytes]`
				: `[binary${entry.mimeType !== null ? ` ${attribute(entry.mimeType)}` : ""}, ${size} bytes; not attached]`;
	} else body = "[the server sent no contents for this resource]";
	return `${open}\n${body}\n</mcp_resource>`;
}

async function promptBlock(
	serverId: string,
	block: McpContentBlock,
	images: ImageContent[],
	canReadResources: boolean,
): Promise<string> {
	switch (block.type) {
		case "text":
			return serverText(block.text);
		case "image": {
			const attached = await attachImage(block.data, block.mimeType, images);
			return attached !== null
				? `[image ${attached.mimeType} attached]`
				: `[image ${attribute(block.mimeType)}, ${blobBytes(block.data)} bytes; not attached]`;
		}
		case "audio":
			return `[audio ${attribute(block.mimeType)}, ${blobBytes(block.data)} bytes; not attached]`;
		case "resource":
			if (isMcpAppResource(block.uri, block.mimeType)) {
				return `[MCP Apps resource ${attribute(block.uri)}; not read]`;
			}
			return await resourceTag(
				serverId,
				{
					uri: block.uri,
					mimeType: block.mimeType ?? null,
					...(block.text !== undefined ? { text: block.text } : {}),
					...(block.blob !== undefined ? { blob: block.blob } : {}),
				},
				images,
				canReadResources,
			);
		case "resource_link": {
			const read = mcpToolName(serverId, ":read_resource");
			const follower =
				canReadResources && read !== null
					? `read it with ${read}`
					: `mcp server ${serverId} declares no resources, so it cannot be read`;
			return serverText(resourceLinkLine(block, follower));
		}
		default:
			return "[a content block PanCode does not read]";
	}
}

/**
 * Bind the typed arguments to the prompt's declared ones: `name=value` by name,
 * the rest in declared order. A prompt with one argument takes the whole line.
 */
function bindArguments(command: McpPromptCommand, line: string): Record<string, string> | string {
	const label = `/${command.serverId}:${command.name}`;
	const declared = command.arguments;
	const args: Record<string, string> = {};
	const trimmed = line.trim();
	const only = declared.length === 1 ? declared[0] : undefined;
	if (only !== undefined && trimmed.length > 0 && !trimmed.startsWith(`${only.name}=`)) {
		const tokens = parseCommandArgs(trimmed);
		args[only.name] = tokens.length === 1 ? (tokens[0] ?? "") : trimmed;
	} else {
		const positional: string[] = [];
		for (const token of parseCommandArgs(trimmed)) {
			const named = /^([^=\s]+)=([\s\S]*)$/u.exec(token);
			if (named?.[1] !== undefined && declared.some((entry) => entry.name === named[1])) args[named[1]] = named[2] ?? "";
			else positional.push(token);
		}
		const open = declared.filter((entry) => !(entry.name in args));
		if (positional.length > open.length) {
			return declared.length === 0
				? `${label} takes no arguments`
				: `${label} takes ${declared.length} argument${declared.length === 1 ? "" : "s"} (${declared.map((entry) => entry.name).join(", ")}); quote a value that holds spaces`;
		}
		positional.forEach((value, index) => {
			const entry = open[index];
			if (entry !== undefined) args[entry.name] = value;
		});
	}
	const missing = declared.filter((entry) => entry.required && !(entry.name in args));
	if (missing.length > 0) {
		return `${label} needs ${missing.map((entry) => `${entry.name}${entry.description ? ` (${entry.description})` : ""}`).join(", ")}; pass ${missing.map((entry) => `${entry.name}=...`).join(" ")}`;
	}
	return args;
}

export function mcpSubmitReader(
	source: McpCapabilitySource,
	options: { readOnly?: () => boolean } = {},
): McpSubmitReader {
	const launch = (signal: AbortSignal | undefined) => ({
		...(signal ? { signal } : {}),
		...(options.readOnly?.() ? { readOnly: true } : {}),
	});
	return {
		promptCommands() {
			return source.promptCommands();
		},
		async resourceCandidates(serverId, signal) {
			const answer = await source.listResources(serverId, launch(signal));
			if (!answer.ok) return [];
			const line = (text: string): string => neutralizeFraming(text.replace(/\s+/gu, " ").trim()).slice(0, 160);
			return [
				...answer.value.resources.map(
					(entry): McpResourceCandidate => ({
						uri: entry.uri,
						template: false,
						label: line(entry.title ?? entry.name),
						description: line([entry.mimeType, entry.description].filter(Boolean).join("; ")),
					}),
				),
				...answer.value.templates.map(
					(entry): McpResourceCandidate => ({
						uri: entry.uriTemplate,
						template: true,
						label: line(entry.title ?? entry.name),
						description: line(`template; fill its {variables}${entry.description ? `; ${entry.description}` : ""}`),
					}),
				),
			];
		},
		async completeArgument(serverId, prompt, argument, context, signal) {
			const answer = await source.complete(
				serverId,
				{ type: "ref/prompt", name: prompt },
				argument,
				Object.keys(context).length > 0 ? { ...context } : undefined,
				signal,
			);
			return answer?.values ?? [];
		},
		async completeTemplate(serverId, template, variable, context, signal) {
			const answer = await source.complete(
				serverId,
				{ type: "ref/resource", uri: template },
				variable,
				Object.keys(context).length > 0 ? { ...context } : undefined,
				signal,
			);
			return answer?.values ?? [];
		},
		async expandPrompt(text, signal): Promise<McpSubmitAnswer | null> {
			const match = PROMPT_LINE.exec(text);
			if (match === null) return null;
			const [, serverId = "", name = "", rest = ""] = match;
			const command = source.promptCommands().find((entry) => entry.serverId === serverId && entry.name === name);
			if (command === undefined) return null;
			const args = bindArguments(command, rest);
			if (typeof args === "string") return { ok: false, error: args };
			const answer = await source.getPrompt(serverId, name, args, launch(signal));
			if (!answer.ok) return answer;
			const images: ImageContent[] = [];
			const canReadResources = source.resourceServerIds().includes(serverId);
			const parts: string[] = [];
			for (const message of answer.value.messages) {
				const body = await promptBlock(serverId, message.content, images, canReadResources);
				parts.push(message.role === "assistant" ? `[assistant] ${body}` : body);
			}
			const clipped = clipBytes(parts.join("\n\n"), PROMPT_TEXT_BYTES);
			const body = `${clipped.text}${clipped.clipped !== null ? `\n[truncated: the first ${PROMPT_TEXT_BYTES} of ${clipped.clipped} bytes]` : ""}`;
			const count = answer.value.messages.length;
			return {
				ok: true,
				// The operator chose this prompt, so its messages are this turn's request; the tag keeps their origin visible.
				text: `I ran /${serverId}:${name}. The messages MCP server ${serverId} returned for it are my request for this turn:\n<mcp_prompt server="${serverId}" name="${attribute(name)}">\n${body}\n</mcp_prompt>`,
				images,
				note: `expanded MCP prompt ${serverId}:${name} (${count} message${count === 1 ? "" : "s"}${images.length > 0 ? `, ${images.length} image${images.length === 1 ? "" : "s"} attached` : ""})`,
			};
		},
		mentionServers() {
			return new Set(source.resourceServerIds());
		},
		async readMention(serverId, uri, signal): Promise<McpSubmitAnswer> {
			const answer = await source.readResource(serverId, uri, launch(signal));
			if (!answer.ok) return answer;
			const images: ImageContent[] = [];
			const tags: string[] = [];
			for (const entry of answer.value.contents as McpResourceContents[]) {
				tags.push(await resourceTag(serverId, entry, images, true));
			}
			const safeUri = neutralizeFraming(uri.replace(/\s+/gu, " ").trim()).slice(0, 200);
			return { ok: true, text: tags.join("\n"), images, note: `read @${serverId}:${safeUri}` };
		},
	};
}
