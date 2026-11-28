// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Prompt input for ACP `session/prompt`: the client ceiling, prompt text,
 * embedded resources and image blocks, each validated and bounded before the
 * chat sees them.
 */

import { fileURLToPath } from "node:url";
import type { TurnConstraints } from "../core/turn-constraints.js";
import { snapshotTurnConstraints } from "../core/turn-constraints.js";
import { isRecord } from "../core/type-guards.js";
import { AcpRequestError } from "./errors.js";
import { boundString } from "./server-bounds.js";
import { ACP_CEILING_FIELDS, ACP_CEILING_META_KEY } from "./types.js";
import type { AcpCeiling } from "./types-capabilities.js";

const ACP_CEILING_FIELD_SET: ReadonlySet<string> = new Set(ACP_CEILING_FIELDS);

/**
 * The client ceiling in `params._meta["pancode/ceiling"]`, or undefined when
 * the request carries none. Anything malformed refuses the request: an ignored
 * ceiling would let work run wider than the client asked for (Z1).
 */
export function requestCeiling(params: unknown, source = "ACP session ceiling"): TurnConstraints | undefined {
	const meta = isRecord(params) ? params._meta : undefined;
	// A _meta that is not an object cannot carry a ceiling; whatever else it
	// means is another extension's to judge, so it fails nothing here.
	if (!isRecord(meta) || !Object.hasOwn(meta, ACP_CEILING_META_KEY)) return undefined;
	const raw = meta[ACP_CEILING_META_KEY];
	if (!isRecord(raw)) throw invalidCeiling("the ceiling must be an object");
	const unknown = Object.keys(raw).find((key) => !ACP_CEILING_FIELD_SET.has(key));
	if (unknown !== undefined) throw invalidCeiling(`unknown ceiling field ${JSON.stringify(unknown.slice(0, 64))}`);
	try {
		const constraints = snapshotTurnConstraints(raw as TurnConstraints);
		const surfaceSource = (tools: readonly string[]) => [
			{
				tools,
				source,
				remedy: `Ask the ACP client to widen its ${source === "ACP prompt ceiling" ? "prompt" : "session"} ceiling, then resubmit.`,
			},
		];
		return snapshotTurnConstraints({
			...constraints,
			...(constraints?.allowedTools !== undefined ? { toolSurfaceSources: surfaceSource(constraints.allowedTools) } : {}),
			...(constraints?.delegatedTools !== undefined
				? { delegatedToolSurfaceSources: surfaceSource(constraints.delegatedTools) }
				: {}),
		});
	} catch {
		throw invalidCeiling(
			"allowedTools and delegatedTools take capability names, delegation takes allowed or forbidden, readOnly takes true",
		);
	}
}

/** Whether any limit narrows what a turn may do; such limits bound commands too. */
export function ceilingBinds(limits: TurnConstraints | undefined): limits is TurnConstraints {
	return (
		limits !== undefined &&
		(limits.readOnly === true ||
			limits.delegation === "forbidden" ||
			limits.allowedTools !== undefined ||
			limits.delegatedTools !== undefined)
	);
}

function invalidCeiling(detail: string): AcpRequestError {
	return new AcpRequestError(-32602, `invalid ${ACP_CEILING_META_KEY}: ${detail}`, { code: "invalid_ceiling" });
}

/** The applied ceiling as echoed on the wire; `{}` means no limit applies. */
export function ceilingMeta(effective: TurnConstraints | undefined): { [ACP_CEILING_META_KEY]: AcpCeiling } {
	return {
		[ACP_CEILING_META_KEY]: {
			...(effective?.allowedTools !== undefined ? { allowedTools: [...effective.allowedTools] } : {}),
			...(effective?.delegatedTools !== undefined ? { delegatedTools: [...effective.delegatedTools] } : {}),
			...(effective?.delegation !== undefined ? { delegation: effective.delegation } : {}),
			...(effective?.readOnly === true ? { readOnly: true } : {}),
		},
	};
}

/**
 * The prompt text of one `session/prompt`. ACP v1 carries it as `params.prompt`,
 * an array of content blocks. Text and resource links are the baseline prompt
 * types in ACP v1; a link becomes a reference the model can see. Image blocks
 * are read by {@link promptImages} when the host expands prompts, and embedded
 * resources by {@link promptResources}; audio requires a capability this
 * server does not advertise.
 * Nothing else is accepted: tolerating
 * `params.content`, `params.message`, or a bare string meant this server
 * answered request shapes no ACP client sends and no schema describes, so a
 * client's own framing bug looked like a working prompt here and failed
 * against every other agent.
 */
export function promptText(params: unknown, resourceLinks = true): string {
	if (!isRecord(params) || !Array.isArray(params.prompt)) return "";
	const parts: string[] = [];
	for (const block of params.prompt) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		if (
			resourceLinks &&
			block.type === "resource_link" &&
			typeof block.name === "string" &&
			typeof block.uri === "string"
		) {
			parts.push(`Resource: ${block.name} (${block.uri})`);
		}
	}
	return parts.join("\n").trim();
}

/** At most this many embedded resources ride one prompt, each at most this many UTF-8 bytes. */
const ACP_MAX_PROMPT_RESOURCES = 8;
const ACP_MAX_PROMPT_RESOURCE_BYTES = 256 * 1024;
const ACP_MAX_RESOURCE_NAME_BYTES = 512;

/**
 * The name a resource is shown to the model under. A `file:` URI names its
 * path, and a GUI attachment (`attachment:<name>`) names the file the operator
 * picked; anything else is shown as its URI. Quotes and control characters are
 * dropped so the name cannot close the `<file name="…">` attribute early.
 */
function resourceName(uri: string): string {
	let name = uri;
	try {
		if (uri.startsWith("file://")) name = decodeURIComponent(new URL(uri).pathname);
		else if (uri.startsWith("attachment:")) name = decodeURIComponent(uri.slice("attachment:".length));
	} catch {
		// A malformed escape leaves the URI as it was sent, which still names the resource.
	}
	let safe = "";
	for (const character of name) {
		const code = character.codePointAt(0) ?? 0;
		if (code > 0x1f && code !== 0x7f && character !== '"') safe += character;
	}
	return boundString(safe, ACP_MAX_RESOURCE_NAME_BYTES) || "resource";
}

/**
 * The embedded text resources of one `session/prompt`, rendered in the
 * `<file name>` shape an `@path` reference expands to. They are appended after
 * the host's expansion, never passed through it: a `@path` or `/name` inside a
 * file the client attached is that file's content, not operator syntax, and
 * expanding it would let an attached file make the host read other files.
 * Binary (`blob`) resources are refused rather than dropped, so a client never
 * believes the model saw a file it did not.
 */
export function promptResources(params: unknown): { rendered: string; names: string[]; paths: string[] } {
	if (!isRecord(params) || !Array.isArray(params.prompt)) return { rendered: "", names: [], paths: [] };
	const files: string[] = [];
	const names: string[] = [];
	const paths: string[] = [];
	for (const block of params.prompt) {
		if (!isRecord(block) || block.type !== "resource") continue;
		const resource = isRecord(block.resource) ? block.resource : {};
		if (typeof resource.blob === "string")
			throw new AcpRequestError(-32602, "binary resources are not accepted; embed text", { code: "invalid_params" });
		if (typeof resource.uri !== "string" || resource.uri.length === 0 || typeof resource.text !== "string")
			throw new AcpRequestError(-32602, "an embedded resource needs a uri and text", { code: "invalid_params" });
		if (Buffer.byteLength(resource.text, "utf8") > ACP_MAX_PROMPT_RESOURCE_BYTES)
			throw new AcpRequestError(
				-32602,
				`an embedded resource is larger than ${ACP_MAX_PROMPT_RESOURCE_BYTES / 1024} KiB`,
				{ code: "invalid_params" },
			);
		const name = resourceName(resource.uri);
		names.push(name);
		const local = resourcePath(resource.uri);
		if (local !== null) paths.push(local);
		files.push(`<file name="${name}">\n${neutralizeFileFrames(resource.text)}\n</file>`);
	}
	if (files.length > ACP_MAX_PROMPT_RESOURCES)
		throw new AcpRequestError(-32602, `a prompt carries at most ${ACP_MAX_PROMPT_RESOURCES} embedded resources`, {
			code: "invalid_params",
		});
	return { rendered: files.join("\n"), names, paths };
}

/** The local path a `file://` resource names, which is flow-labelled like an `@path` reference; null otherwise. */
function resourcePath(uri: string): string | null {
	if (!uri.startsWith("file://")) return null;
	try {
		return fileURLToPath(uri);
	} catch {
		return null;
	}
}

/** A resource body cannot open or close a `<file>` block: `<file` and `</file` (any case) become `<\file`, `<\/file`. */
function neutralizeFileFrames(text: string): string {
	return text.replace(/<\s*(\/?)\s*(file)(?![\w-])/giu, (_, slash: string, tag: string) => `<\\${slash}${tag}`);
}

export function attachedNote(names: ReadonlyArray<string>): string {
	return `attached ${names.length} ${names.length === 1 ? "file" : "files"}: ${names.join(", ")}`;
}

/** Typed text, then the embedded files after a blank line. */
export function withResources(text: string, resources: { rendered: string }): string {
	if (resources.rendered === "") return text;
	return text === "" ? resources.rendered : `${text}\n\n${resources.rendered}`;
}

/** At most this many image blocks ride one prompt; the stdio line bounds their bytes. */
export const ACP_MAX_PROMPT_IMAGES = 4;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/** Refuse the whole prompt before extraction can silently drop client content (Y4 finding 5). */
export function validatePromptBlocks(params: unknown): void {
	if (!isRecord(params) || !Array.isArray(params.prompt))
		throw new AcpRequestError(-32602, "prompt text is required as an array of content blocks", {
			code: "invalid_params",
		});
	let images = 0;
	let resources = 0;
	for (const [index, block] of params.prompt.entries()) {
		const invalid = (message: string): never => {
			throw new AcpRequestError(-32602, `prompt block ${index}: ${message}`, { code: "invalid_params" });
		};
		if (!isRecord(block)) {
			invalid("a content block must be an object");
			continue;
		}
		const stringKeys =
			block.type === "resource_link" ? ["uri", "mimeType", "title", "description"] : block.type === "image" ? ["uri"] : [];
		for (const key of stringKeys) {
			if (block[key] != null && typeof block[key] !== "string") invalid(`${key} must be a string`);
		}
		if (block._meta !== undefined && !isRecord(block._meta)) invalid("_meta must be an object");
		if (block.annotations != null) {
			const annotations = block.annotations;
			if (!isRecord(annotations)) invalid("annotations must be an object");
			if (isRecord(annotations)) {
				if (
					annotations.audience != null &&
					(!Array.isArray(annotations.audience) ||
						annotations.audience.some((role) => role !== "user" && role !== "assistant"))
				)
					invalid("annotations.audience must contain user or assistant roles");
				if (annotations.priority != null && typeof annotations.priority !== "number")
					invalid("annotations.priority must be a number");
				if (annotations.lastModified != null && typeof annotations.lastModified !== "string")
					invalid("annotations.lastModified must be a string");
			}
		}
		try {
			switch (block.type) {
				case "text":
					if (typeof block.text !== "string") invalid("a text block needs string text");
					break;
				case "resource_link":
					if (typeof block.name !== "string" || typeof block.uri !== "string")
						invalid("a resource link needs a name and uri");
					if (block.size != null && (typeof block.size !== "number" || !Number.isSafeInteger(block.size) || block.size < 0))
						invalid("resource size must be a non-negative integer");
					break;
				case "image":
					promptImages({ prompt: [block] });
					if (++images > ACP_MAX_PROMPT_IMAGES) invalid(`a prompt carries at most ${ACP_MAX_PROMPT_IMAGES} images`);
					break;
				case "resource":
					promptResources({ prompt: [block] });
					if (isRecord(block.resource) && block.resource.mimeType != null && typeof block.resource.mimeType !== "string")
						invalid("resource mimeType must be a string");
					if (++resources > ACP_MAX_PROMPT_RESOURCES)
						invalid(`a prompt carries at most ${ACP_MAX_PROMPT_RESOURCES} embedded resources`);
					break;
				default:
					invalid("unsupported content type; expected text, image, resource or resource_link");
			}
		} catch (error) {
			if (error instanceof AcpRequestError && !error.message.startsWith(`prompt block ${index}:`)) invalid(error.message);
			throw error;
		}
	}
}

/**
 * The image blocks of one `session/prompt`, checked for shape only. The host's
 * prompt expander decides from the bytes whether each is an image it accepts,
 * so a client's `mimeType` is carried but never trusted.
 */
export function promptImages(params: unknown): Array<{ type: "image"; mimeType: string; data: string }> {
	if (!isRecord(params) || !Array.isArray(params.prompt)) return [];
	const images: Array<{ type: "image"; mimeType: string; data: string }> = [];
	for (const block of params.prompt) {
		if (!isRecord(block) || block.type !== "image") continue;
		if (typeof block.mimeType !== "string" || typeof block.data !== "string" || !BASE64.test(block.data))
			throw new AcpRequestError(-32602, "an image block needs a mimeType and base64 data", { code: "invalid_params" });
		images.push({ type: "image", mimeType: block.mimeType.slice(0, 64), data: block.data });
	}
	if (images.length > ACP_MAX_PROMPT_IMAGES)
		throw new AcpRequestError(-32602, `a prompt carries at most ${ACP_MAX_PROMPT_IMAGES} images`, {
			code: "invalid_params",
		});
	return images;
}
