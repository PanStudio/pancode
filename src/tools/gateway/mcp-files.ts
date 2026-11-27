// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The gateway side of the experimental MCP files extension: the files a call
 * names, as the reads admission judges and the egress the approval shows, and
 * their bytes turned into the `FileInput` values the server receives.
 */
import { realpathSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import {
	MCP_FILE_LIMITS,
	type McpFileArgument,
	type McpFileInput,
	type McpNamedFile,
	mcpFileAccepted,
	mcpFileInput,
	mcpNamedFiles,
	withMcpFileInputs,
} from "../../domains/gateway/mcp/index.js";
import { resolveToCwd } from "../path-utils.js";
import type { HostEffectCall, OutboundFile, ToolInvokeOptions } from "../registry-contract.js";
import { formatSize } from "../truncate.js";
import type { McpHeldFile } from "./mcp-file-transfer.js";
import {
	isStoreReference,
	type McpStoreAccess,
	parseStoreReference,
	type StoreReference,
	storeReferenceEffects,
} from "./mcp-store-references.js";

/** One file a call names: a host path PanCode reads, or a store blob it reads through a cache copy. */
export type McpFileSource =
	| { kind: "path"; named: McpNamedFile; path: string; spellings: string[] }
	| { kind: "store"; named: McpNamedFile; reference: StoreReference };

function argumentLabel(named: McpNamedFile): string {
	return named.index === null ? named.argument : `${named.argument}[${named.index}]`;
}

/**
 * The files a call's file arguments name, resolved against the session cwd
 * as PanCode's own read resolves a path, or why the arguments are refused.
 * A path is judged by the spelling given and the file it resolves to.
 */
export function mcpFileSources(
	fileArguments: ReadonlyArray<McpFileArgument>,
	args: Readonly<Record<string, unknown>>,
	cwd: string,
): McpFileSource[] | string {
	const named = mcpNamedFiles(fileArguments, args);
	if (typeof named === "string") return named;
	const sources: McpFileSource[] = [];
	for (const entry of named) {
		const label = argumentLabel(entry);
		if (isStoreReference(entry.value)) {
			const parsed = parseStoreReference(entry.value);
			if (typeof parsed === "string") return `file argument '${label}': ${parsed}`;
			sources.push({ kind: "store", named: entry, reference: { argument: label, access: "read", ...parsed } });
			continue;
		}
		const resolved = resolveToCwd(entry.value, cwd);
		let real = resolved;
		try {
			real = realpathSync(resolved);
		} catch {
			// A missing file is refused when the body reads it.
		}
		sources.push({ kind: "path", named: entry, path: resolved, spellings: [...new Set([resolved, real])] });
	}
	return sources;
}

/** Each named file as the read it is, so admission judges it as that read: secret and zero-access paths are refused. */
export function mcpFileEffects(
	sources: ReadonlyArray<McpFileSource>,
	cwd: string,
	store: McpStoreAccess | undefined,
): HostEffectCall[] {
	const references = sources.flatMap((source) => (source.kind === "store" ? [source.reference] : []));
	return [
		...sources.flatMap((source) =>
			source.kind === "path"
				? source.spellings.map((target) => ({
						label: `file argument '${argumentLabel(source.named)}' (${target})`,
						call: { tool: ToolNames.Read, args: { path: target } },
					}))
				: [],
		),
		...storeReferenceEffects(references, cwd, store),
	];
}

function shownPath(target: string, cwd: string): string {
	const relative = path.relative(cwd, target);
	return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative) ? `./${relative}` : target;
}

/** The files the call sends off the host: one approval line each, and the read whose labels the bytes carry. */
export function mcpOutboundFiles(
	sources: ReadonlyArray<McpFileSource>,
	serverId: string,
	cwd: string,
	store: McpStoreAccess | undefined,
): OutboundFile[] {
	const to = `to mcp server ${serverId} and storage it names`;
	return sources.map((source) => {
		if (source.kind === "store") {
			const { tag, blob } = source.reference;
			const [effect] = storeReferenceEffects([source.reference], cwd, store);
			return {
				consequence: `sends store:${tag}:${blob} ${to}`,
				source: effect?.call ?? { tool: ToolNames.Store, args: { op: "get", tag, blob } },
			};
		}
		let size = "";
		try {
			const info = statSync(source.path);
			if (info.isFile()) size = ` (${formatSize(info.size)})`;
		} catch {
			// A missing file is refused when the body reads it.
		}
		return {
			consequence: `sends ${shownPath(source.path, cwd)}${size} ${to}`,
			source: { tool: ToolNames.Read, args: { path: source.path } },
		};
	});
}

/** The server's files settings and whether this run may make out-of-band transfers. */
export interface McpFileSendingPolicy {
	upload: boolean;
	maxInlineBytes: number;
	transfers: boolean;
}

export interface McpPreparedFiles {
	/** The call's arguments with each named file replaced by its `FileInput`. */
	args: Record<string, unknown>;
	/** Ids of the files sent without `data`, which the server may ask to upload. */
	pending: Set<string>;
	held: Map<string, McpHeldFile>;
}

/**
 * Read each named file and build the call's `FileInput` values. Every file
 * goes inline while the call's inline total stays within the server's
 * `maxInlineBytes`; the rest wait for `upload_required`, which needs the
 * server's `upload` and this run's transfers. Refused when a file cannot be
 * read here, breaks its argument's `accept` or `maxSize`, or cannot travel.
 */
export async function prepareMcpFiles(input: {
	fileArguments: ReadonlyArray<McpFileArgument>;
	args: Readonly<Record<string, unknown>>;
	sources: ReadonlyArray<McpFileSource>;
	/** Where each store source's cache copy lies, by its reference's argument label. */
	storeCopies: ReadonlyMap<string, string>;
	policy: McpFileSendingPolicy;
	invokeOptions: ToolInvokeOptions | undefined;
}): Promise<McpPreparedFiles | string> {
	const { sources, policy } = input;
	const files: Array<{ named: McpNamedFile; input: McpFileInput }> = [];
	const held = new Map<string, McpHeldFile>();
	const pending = new Set<string>();
	let total = 0;
	let inline = 0;
	for (const [index, source] of sources.entries()) {
		const label = `file argument '${argumentLabel(source.named)}'`;
		let readPath: string;
		let name: string;
		if (source.kind === "path") {
			const refused = source.spellings.find((target) => input.invokeOptions?.allowsObservationPath?.(target) === false);
			if (refused !== undefined) return `${label} names ${refused}, which this run may not read`;
			readPath = source.path;
			name = path.basename(source.path);
		} else {
			const copy = input.storeCopies.get(source.reference.argument);
			if (copy === undefined) return `${label}: the store blob could not be read`;
			readPath = copy;
			name = path.posix.basename(source.reference.blob);
		}
		const argument = input.fileArguments.find((entry) => entry.name === source.named.argument);
		let bytes: Uint8Array<ArrayBuffer>;
		try {
			const info = await stat(readPath);
			if (!info.isFile()) return `${label} names ${source.named.value}, which is not a regular file`;
			if (argument?.maxSize != null && info.size > argument.maxSize) {
				return `${label} names a file of ${formatSize(info.size)}; the tool takes at most ${argument.maxSize} bytes per file`;
			}
			if (total + info.size > MCP_FILE_LIMITS.uploadBytesPerCall) {
				return `the call's files pass PanCode's bound of ${formatSize(MCP_FILE_LIMITS.uploadBytesPerCall)} per call`;
			}
			bytes = await readFile(readPath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			return `${label} names ${source.named.value}, which could not be read${typeof code === "string" ? ` (${code})` : ""}`;
		}
		if (argument?.maxSize != null && bytes.byteLength > argument.maxSize) {
			return `${label} names a file of ${formatSize(bytes.byteLength)}; the tool takes at most ${argument.maxSize} bytes per file`;
		}
		if (total + bytes.byteLength > MCP_FILE_LIMITS.uploadBytesPerCall) {
			return `the call's files pass PanCode's bound of ${formatSize(MCP_FILE_LIMITS.uploadBytesPerCall)} per call`;
		}
		total += bytes.byteLength;
		const fileInput = mcpFileInput(`file-${index + 1}`, name, bytes);
		if (!mcpFileAccepted(argument?.accept ?? null, name, fileInput.mimeType)) {
			return `${label} names a ${fileInput.mimeType} file; the tool accepts ${(argument?.accept ?? []).join(", ")}`;
		}
		if (bytes.byteLength > 0) {
			if (inline + bytes.byteLength <= policy.maxInlineBytes) {
				inline += bytes.byteLength;
				fileInput.data = Buffer.from(bytes).toString("base64");
			} else {
				if (!policy.upload) {
					return `${label} names a file of ${formatSize(bytes.byteLength)}, more than the server takes inline (${formatSize(policy.maxInlineBytes)} per call), and the server takes no out-of-band uploads`;
				}
				if (!policy.transfers) {
					return `${label} names a file of ${formatSize(bytes.byteLength)}, more than the server takes inline (${formatSize(policy.maxInlineBytes)} per call), and this run makes no out-of-band transfers: its admission granted the server no network`;
				}
				pending.add(fileInput.id);
			}
		}
		files.push({ named: source.named, input: fileInput });
		held.set(fileInput.id, { input: fileInput, bytes });
	}
	return { args: withMcpFileInputs(input.args, files, input.fileArguments), pending, held };
}
