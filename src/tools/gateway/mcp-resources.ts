// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * MCP resources and prompts at the gateway. A launch-trusted server that
 * declares `resources` serves two read-class capabilities beside its tools,
 * `mcp_<id>__:list_resources` and `mcp_<id>__:read_resource`; the `:` keeps
 * them out of every server tool's name. Prompts are not capabilities: they
 * become the operator's slash commands, listed here from the live server or
 * its recorded catalog. Both sit outside the tool surface digest, because a
 * resource list is data that changes, yet every read and every prompt needs
 * that surface approved, as a tool call does.
 */

import type { TSchema } from "typebox";
import { neutralizeFraming } from "../../core/reminder-framing.js";
import { type DynamicToolName, MCP_RESOURCE_CAPABILITIES, mcpToolName } from "../../core/tool-names.js";
import { isRecord } from "../../core/type-guards.js";
import type {
	McpCachedPrompt,
	McpClient,
	McpContentBlock,
	McpPromptDescriptor,
	McpResourceContents,
	McpResourceListing,
	McpServerCatalog,
	McpToolCallResult,
} from "../../domains/gateway/mcp/index.js";
import {
	DEFAULT_RESULT_TEXT_BYTES,
	isMcpAppResource,
	isMcpResourceNotFound,
	mcpPromptsStale,
	mcpToolActionClass,
	renderMcpContent,
	resourceLinkLine,
} from "../../domains/gateway/mcp/index.js";
import { acceptsImageInput } from "../../domains/providers/image-input.js";
import type { WorkerMcpAttestation } from "../../domains/safety/worker-permit.js";
import { readMaxBytes } from "../read.js";
import type { ToolResult, ToolSpec } from "../tool-spec.js";
import {
	boundedImageResult,
	errorMessage,
	imageBlocks,
	MCP_RESULT_CONTEXT_BYTES,
	mcpCallFailureText,
	offloadedBinaryText,
} from "./mcp-call-results.js";
import type { McpLaunchOptions, McpPromptCommand, McpSourceAnswer, ServerState } from "./mcp-capability-types.js";

/** How long a legacy server's resource list answers completion; a modern one says itself with ttlMs. */
const LEGACY_RESOURCE_LIST_FRESH_MS = 60_000;
/** One menu line of a server-written prompt title or description. */
const PROMPT_TEXT_CHARS = 200;
/** A prompt name that reads as one slash token after `/<id>:`. */
const PROMPT_COMMAND_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/u;

/** What the gateway lends this module: its discovery, its surface gate and its teardown. */
export interface McpResourceHost {
	admitted: WorkerMcpAttestation | undefined;
	discover(state: ServerState, signal?: AbortSignal): Promise<void>;
	surfaceRefusal(state: ServerState, name: string): string | null;
	/** Why a read-only turn may not start this server, or null. */
	launchRefusal(state: ServerState, options: McpLaunchOptions | undefined): string | null;
	closeClient(state: ServerState): Promise<unknown> | undefined;
	/** Write the catalog again after the prompt list changed. */
	publish(state: ServerState): void;
}

/** Whether the server's handshake declared this capability. */
export function declares(client: McpClient | null, primitive: "resources" | "prompts" | "completions"): boolean {
	return client !== null && isRecord(client.serverInfo()?.capabilities?.[primitive]);
}

function resourceCapabilityNames(id: string): { list: DynamicToolName; read: DynamicToolName } | null {
	const list = mcpToolName(id, MCP_RESOURCE_CAPABILITIES.list);
	const read = mcpToolName(id, MCP_RESOURCE_CAPABILITIES.read);
	return list === null || read === null ? null : { list, read };
}

/** The description and schema of one resource capability, the same live and from a recorded catalog. */
export function resourceCapabilityShape(
	id: string,
	which: "list" | "read",
): { description: string; parameters: Record<string, unknown> } {
	const names = resourceCapabilityNames(id);
	const listName = names?.list ?? `mcp_${id}__${MCP_RESOURCE_CAPABILITIES.list}`;
	if (which === "list") {
		return {
			description: `List the resources and resource templates MCP server ${id} serves, with uri, name, mime type and size. Listing and reading resources is class read.`,
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Keep only entries whose uri, name or title contains this text, ignoring case.",
					},
				},
				additionalProperties: false,
			},
		};
	}
	return {
		description: `Read one resource MCP server ${id} serves, by uri: one from ${listName}, a resource link in a tool result, or a template with its {variables} filled. Large text is offloaded with a preview, binary contents are offloaded with mime type and size, and images are attached. Class read.`,
		parameters: {
			type: "object",
			properties: { uri: { type: "string", description: "The resource's uri, exactly as listed or linked." } },
			required: ["uri"],
			additionalProperties: false,
		},
	};
}

/** How a tool result's resource link names the capability that reads it. */
export function resourceLinkFollower(
	state: ServerState,
): (block: Extract<McpContentBlock, { type: "resource_link" }>) => string {
	const read = resourceCapabilityNames(state.declaration.id)?.read;
	return (block) =>
		read !== undefined && state.registered.includes(read)
			? resourceLinkLine(block, `read it with ${read}`)
			: resourceLinkLine(block, `mcp server ${state.declaration.id} declares no resources, so it cannot be read`);
}

function oneLine(text: string, chars: number): string {
	const flat = neutralizeFraming(text).replace(/\s+/gu, " ").trim();
	return flat.length <= chars ? flat : `${flat.slice(0, chars - 3)}...`;
}

function resourceFacts(entry: { mimeType: string | null; size?: number | null }): string {
	const facts = [
		...(entry.mimeType !== null ? [entry.mimeType] : []),
		...(entry.size !== undefined && entry.size !== null ? [`${entry.size} bytes`] : []),
	];
	return facts.length > 0 ? ` (${facts.join(", ")})` : "";
}

/** A listing without the MCP Apps views PanCode does not serve. */
export function visibleResources(listing: McpResourceListing): McpResourceListing {
	return {
		...listing,
		resources: listing.resources.filter((entry) => !isMcpAppResource(entry.uri, entry.mimeType)),
		templates: listing.templates.filter((entry) => !isMcpAppResource(entry.uriTemplate, entry.mimeType)),
	};
}

function renderResourceListing(id: string, readName: string, listing: McpResourceListing, query: string): string {
	const needle = query.trim().toLowerCase();
	const matches = (...fields: Array<string | null>): boolean =>
		needle.length === 0 || fields.some((field) => field?.toLowerCase().includes(needle) === true);
	const resources = listing.resources.filter((entry) => matches(entry.uri, entry.name, entry.title));
	const templates = listing.templates.filter((entry) => matches(entry.uriTemplate, entry.name, entry.title));
	const label = (name: string, title: string | null, description: string): string => {
		const words = [title ?? "", description].filter((part) => part.trim().length > 0).join(": ");
		return `${JSON.stringify(oneLine(name, 120))}${words.length > 0 ? ` ${oneLine(words, PROMPT_TEXT_CHARS)}` : ""}`;
	};
	const lines = [
		`MCP server ${id}: ${resources.length} resource${resources.length === 1 ? "" : "s"}, ${templates.length} template${templates.length === 1 ? "" : "s"}${needle.length > 0 ? ` matching ${JSON.stringify(query.trim())}` : ""}${listing.truncated ? "; the server offers more than PanCode lists" : ""}.`,
		...resources.map(
			(entry) => `resource ${entry.uri}${resourceFacts(entry)} ${label(entry.name, entry.title, entry.description)}`,
		),
		...templates.map(
			(entry) =>
				`template ${entry.uriTemplate}${resourceFacts(entry)} ${label(entry.name, entry.title, entry.description)}`,
		),
	];
	if (resources.length + templates.length > 0) {
		lines.push(`Read one with ${readName} and its uri; fill a template's {variables} to form one.`);
	}
	return lines.join("\n");
}

/** Resource contents as content blocks: text, an image, or a blob the result path offloads. */
function resourceContentBlocks(contents: ReadonlyArray<McpResourceContents>): McpContentBlock[] {
	return contents.flatMap((entry): McpContentBlock[] => {
		const mime = entry.mimeType ?? undefined;
		if ("text" in entry)
			return [{ type: "resource", uri: entry.uri, text: entry.text, ...(mime ? { mimeType: mime } : {}) }];
		if (mime?.startsWith("image/") === true) {
			return [
				{ type: "text", text: `[resource ${entry.uri}]` },
				{ type: "image", mimeType: mime, data: entry.blob },
			];
		}
		return [{ type: "resource", uri: entry.uri, blob: entry.blob, ...(mime ? { mimeType: mime } : {}) }];
	});
}

/**
 * The connected client for one use of the server, or why there is none. A
 * trusted server is started here, as a tool call starts it; using it needs
 * its listed tool surface approved.
 */
async function connectedClient(
	host: McpResourceHost,
	state: ServerState,
	name: string,
	options: McpLaunchOptions | undefined,
): Promise<McpClient | string> {
	const { declaration } = state;
	if (declaration.trust.status !== "trusted") {
		return `${name}: mcp server ${declaration.id} is ${declaration.trust.status}; it is never launched until trusted: run pancode mcp trust ${declaration.id}`;
	}
	if (state.client === null) {
		const refusal = host.launchRefusal(state, options);
		if (refusal !== null) return `${name}: ${refusal}`;
	}
	await host.discover(state, options?.signal);
	const client = state.client as McpClient | null;
	if (client === null || client.state().status !== "ready") {
		return `${name}: mcp server ${declaration.id} is not connected${state.failure ? `: ${state.failure}` : ""}; the next use starts it again`;
	}
	return host.surfaceRefusal(state, name) ?? client;
}

/** A failed request as its cause and next step; a client that died with it is closed, as after a tool call. */
async function failureText(
	host: McpResourceHost,
	state: ServerState,
	client: McpClient,
	name: string,
	error: unknown,
): Promise<string> {
	const stopped = client.state().status === "failed" || client.state().status === "closed";
	if (stopped) {
		state.failure = errorMessage(error);
		await host.closeClient(state);
	}
	return `${name}: ${neutralizeFraming(mcpCallFailureText(state.declaration, error, stopped))}`;
}

function notFoundText(state: ServerState, name: string, uri: string): string {
	const list = resourceCapabilityNames(state.declaration.id)?.list ?? "";
	return `${name}: mcp server ${state.declaration.id} has no resource ${uri}; list what it serves with ${list}`;
}

/** A worker uses a resource capability only when its recipe named it, as with any MCP tool. */
function admissionRefusal(host: McpResourceHost, state: ServerState, tool: string, name: string): string | null {
	if (host.admitted === undefined) return null;
	const admitted = host.admitted.tools.some((entry) => entry.serverId === state.declaration.id && entry.tool === tool);
	return admitted
		? null
		: `${name}: this run was not admitted for ${name}; name it in the agent's tools and dispatch again`;
}

/** The two resource capabilities of one connected server, or none when it declares no resources. */
export function resourceCapabilitySpecs(host: McpResourceHost, state: ServerState): ToolSpec[] {
	const { declaration } = state;
	const names = resourceCapabilityNames(declaration.id);
	if (names === null || !declares(state.client, "resources")) return [];
	const actionClass = mcpToolActionClass(declaration, { name: MCP_RESOURCE_CAPABILITIES.read, annotations: null });
	const base = (which: "list" | "read", name: DynamicToolName) => {
		const shape = resourceCapabilityShape(declaration.id, which);
		return {
			name,
			description: shape.description,
			parameters: shape.parameters as TSchema,
			baseActionClass: actionClass,
			executionMode: "sequential" as const,
			placement: "gateway" as const,
			sourceInfo: { path: declaration.path, scope: "domain" as const },
		};
	};
	const listSpec: ToolSpec = {
		...base("list", names.list),
		metadata: {
			objective: `list MCP server ${declaration.id}'s resources`,
			uiLabel: `${declaration.id}/${MCP_RESOURCE_CAPABILITIES.list}`,
			repeatableRead: true,
			resultSizePolicy: {
				kind: "bounded",
				maxBytes: MCP_RESULT_CONTEXT_BYTES,
				followUpHint: "Call again with a query that narrows the list, or read the offloaded file in windows.",
			},
		},
		async run(args, invokeOptions): Promise<ToolResult> {
			const refused = admissionRefusal(host, state, MCP_RESOURCE_CAPABILITIES.list, names.list);
			if (refused !== null) return { kind: "error", message: refused };
			const client = await connectedClient(host, state, names.list, invokeOptions);
			if (typeof client === "string") return { kind: "error", message: client };
			let listing: McpResourceListing;
			try {
				listing = await client.listResources(invokeOptions?.signal);
			} catch (error) {
				return { kind: "error", message: await failureText(host, state, client, names.list, error) };
			}
			state.resourceList = { listing, atMs: Date.now() };
			const visible = visibleResources(listing);
			const query = typeof args.query === "string" ? args.query : "";
			return {
				kind: "ok",
				output: renderResourceListing(declaration.id, names.read, visible, query),
				details: {
					server: declaration.id,
					tool: MCP_RESOURCE_CAPABILITIES.list,
					resources: visible.resources.length,
					templates: visible.templates.length,
					truncated: listing.truncated,
				},
			};
		},
	};
	const readSpec: ToolSpec = {
		...base("read", names.read),
		metadata: {
			objective: `read a resource from MCP server ${declaration.id}`,
			uiLabel: `${declaration.id}/${MCP_RESOURCE_CAPABILITIES.read}`,
			repeatableRead: true,
			resultSizePolicy: {
				kind: "bounded",
				maxBytes: MCP_RESULT_CONTEXT_BYTES,
				imageMaxBytes: readMaxBytes(),
				followUpHint: "Read the offloaded file in windows.",
			},
		},
		async run(args, invokeOptions): Promise<ToolResult> {
			const refused = admissionRefusal(host, state, MCP_RESOURCE_CAPABILITIES.read, names.read);
			if (refused !== null) return { kind: "error", message: refused };
			const uri = typeof args.uri === "string" ? args.uri.trim() : "";
			if (uri.length === 0) return { kind: "error", message: `${names.read}: name the resource's uri` };
			if (isMcpAppResource(uri, null)) {
				return { kind: "error", message: `${names.read}: ${uri} is an MCP Apps view, which PanCode does not read` };
			}
			const client = await connectedClient(host, state, names.read, invokeOptions);
			if (typeof client === "string") return { kind: "error", message: client };
			let contents: McpResourceContents[];
			try {
				contents = (await client.readResource(uri, invokeOptions?.signal ? { signal: invokeOptions.signal } : {})).contents;
			} catch (error) {
				const message = isMcpResourceNotFound(error)
					? notFoundText(state, names.read, uri)
					: await failureText(host, state, client, names.read, error);
				return { kind: "error", message, details: { server: declaration.id, tool: MCP_RESOURCE_CAPABILITIES.read, uri } };
			}
			const readable = contents.filter((entry) => !isMcpAppResource(entry.uri, entry.mimeType));
			if (readable.length === 0) {
				return {
					kind: "error",
					message: `${names.read}: mcp server ${declaration.id} returned no readable contents for ${uri}`,
				};
			}
			const blocks = resourceContentBlocks(readable);
			const rendered = renderMcpContent(blocks, DEFAULT_RESULT_TEXT_BYTES);
			const result: McpToolCallResult = {
				content: blocks,
				isError: false,
				text: rendered.text,
				textTruncated: rendered.truncated,
			};
			const shown = offloadedBinaryText(result, invokeOptions) ?? rendered;
			const details: Record<string, unknown> = {
				server: declaration.id,
				tool: MCP_RESOURCE_CAPABILITIES.read,
				uri,
				contents: readable.map((entry) => ({
					uri: entry.uri,
					mimeType: entry.mimeType,
					kind: "text" in entry ? "text" : "blob",
				})),
				textTruncated: shown.truncated,
			};
			const output = neutralizeFraming(shown.text);
			const images = imageBlocks(result);
			if (images.length > 0 && acceptsImageInput({ vision: invokeOptions?.supportsImages }))
				return await boundedImageResult(names.read, output, details, images, invokeOptions);
			return { kind: "ok", output, details };
		},
	};
	return [listSpec, readSpec];
}

/** The resource listing completion offers, within the server's ttlMs and dropped on its list_changed. */
export async function listResourcesFor(
	host: McpResourceHost,
	state: ServerState,
	options: McpLaunchOptions | undefined,
): Promise<McpSourceAnswer<McpResourceListing>> {
	const name = `@${state.declaration.id}:`;
	const client = await connectedClient(host, state, name, options);
	if (typeof client === "string") return { ok: false, error: client };
	if (!declares(client, "resources"))
		return { ok: false, error: `${name} mcp server ${state.declaration.id} declares no resources` };
	if (client.listChanged("resources")) {
		client.acknowledgeListChanged("resources");
		delete state.resourceList;
	}
	const cached = state.resourceList;
	const freshMs = cached?.listing.ttlMs ?? LEGACY_RESOURCE_LIST_FRESH_MS;
	if (cached !== undefined && Date.now() - cached.atMs < freshMs)
		return { ok: true, value: visibleResources(cached.listing) };
	try {
		const listing = await client.listResources(options?.signal);
		state.resourceList = { listing, atMs: Date.now() };
		host.publish(state);
		return { ok: true, value: visibleResources(listing) };
	} catch (error) {
		return { ok: false, error: await failureText(host, state, client, name, error) };
	}
}

/** One resource read for a mention, under the read capability's gates. */
export async function readResourceFor(
	host: McpResourceHost,
	state: ServerState,
	uri: string,
	options: McpLaunchOptions | undefined,
): Promise<McpSourceAnswer<{ contents: McpResourceContents[] }>> {
	const name = `@${state.declaration.id}:${uri}`;
	if (isMcpAppResource(uri, null)) return { ok: false, error: `${name}: an MCP Apps view, which PanCode does not read` };
	const client = await connectedClient(host, state, name, options);
	if (typeof client === "string") return { ok: false, error: client };
	if (!declares(client, "resources"))
		return { ok: false, error: `${name}: mcp server ${state.declaration.id} declares no resources` };
	try {
		const read = await client.readResource(uri, options?.signal ? { signal: options.signal } : {});
		const contents = read.contents.filter((entry) => !isMcpAppResource(entry.uri, entry.mimeType));
		if (contents.length === 0)
			return { ok: false, error: `${name}: mcp server ${state.declaration.id} returned no readable contents` };
		return { ok: true, value: { contents } };
	} catch (error) {
		return {
			ok: false,
			error: isMcpResourceNotFound(error)
				? notFoundText(state, name, uri)
				: await failureText(host, state, client, name, error),
		};
	}
}

/**
 * List the server's prompts again, once at a time, and record them. Best
 * effort: a server whose prompts/list fails keeps the last list it gave.
 */
export function refreshPrompts(host: McpResourceHost, state: ServerState): Promise<void> {
	const client = state.client;
	if (client === null || !declares(client, "prompts")) {
		delete state.prompts;
		return Promise.resolve();
	}
	state.promptsListing ??= (async () => {
		// A change announced while prompts/list runs stays set for the next refresh.
		client.acknowledgeListChanged("prompts");
		try {
			const prompts = await client.listPrompts();
			if (state.client !== client) return;
			state.prompts = prompts;
			host.publish(state);
		} catch {
			// The slash menu keeps the last list; invoking a prompt reports the server's own failure.
		}
	})().finally(() => {
		delete state.promptsListing;
	});
	return state.promptsListing;
}

/** The first resource listing of a connection, recorded so `/mcp` can count it without a launch. Best effort. */
export async function refreshResources(host: McpResourceHost, state: ServerState): Promise<void> {
	const client = state.client;
	if (client === null || !declares(client, "resources") || state.resourceList !== undefined) return;
	client.acknowledgeListChanged("resources");
	try {
		const listing = await client.listResources();
		if (state.client !== client || state.resourceList !== undefined) return;
		state.resourceList = { listing, atMs: Date.now() };
		host.publish(state);
	} catch {
		// A failed listing is reported when the model or the operator asks for one.
	}
}

function promptCommand(
	serverId: string,
	prompt: McpPromptDescriptor | McpCachedPrompt,
	stale: boolean,
): McpPromptCommand | null {
	if (!PROMPT_COMMAND_NAME.test(prompt.name)) return null;
	const title = prompt.title ?? null;
	return {
		serverId,
		name: prompt.name,
		title: title === null ? null : oneLine(title, PROMPT_TEXT_CHARS),
		description: oneLine(prompt.description, PROMPT_TEXT_CHARS),
		arguments: prompt.arguments.map((entry) => ({
			name: entry.name,
			description: oneLine(entry.description, PROMPT_TEXT_CHARS),
			required: entry.required,
		})),
		...(stale ? { stale: true as const } : {}),
	};
}

/** One trusted server's prompt commands: the live list once it has one, else the recorded catalog's. */
export function promptCommandsOf(
	host: McpResourceHost,
	state: ServerState,
	catalog: McpServerCatalog | null,
): McpPromptCommand[] {
	if (state.declaration.trust.status !== "trusted") return [];
	const client = state.client;
	if (client?.listChanged("prompts")) void refreshPrompts(host, state);
	const live = client !== null ? state.prompts : undefined;
	if (live !== undefined) {
		return live.prompts.flatMap((prompt) => promptCommand(state.declaration.id, prompt, false) ?? []);
	}
	if (client !== null && !declares(client, "prompts")) return [];
	const recorded = catalog?.prompts;
	if (catalog === null || recorded === undefined) return [];
	const stale = mcpPromptsStale(catalog);
	return recorded.prompts.flatMap((prompt) => promptCommand(state.declaration.id, prompt, stale) ?? []);
}

/** `prompts/get` for a slash command, under launch trust and the approved surface. */
export async function getPromptFor(
	host: McpResourceHost,
	state: ServerState,
	name: string,
	args: Record<string, string>,
	options: McpLaunchOptions | undefined,
) {
	const label = `/${state.declaration.id}:${name}`;
	const client = await connectedClient(host, state, label, options);
	if (typeof client === "string") return { ok: false as const, error: client };
	if (!declares(client, "prompts"))
		return { ok: false as const, error: `${label}: mcp server ${state.declaration.id} declares no prompts` };
	try {
		const value = await client.getPrompt(name, args, options?.signal ? { signal: options.signal } : {});
		return { ok: true as const, value };
	} catch (error) {
		return { ok: false as const, error: await failureText(host, state, client, label, error) };
	}
}
