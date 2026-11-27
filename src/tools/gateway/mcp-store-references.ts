// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Store references in an MCP server's declared path arguments. A value
 * `store:<tag>:<blob>` names a blob instead of a file: on a read argument the
 * server is handed a read-only copy under the store cache, and on a write
 * argument a hidden temporary file in the tag's directory, whose bytes are
 * committed as the blob with a put record (actor `mcp`) only when the call
 * succeeded. Admission judges each reference as the `store` call it stands
 * for, so the store's own access rule decides who may write which tag.
 */
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { StoreBackend } from "@pancode/store";
import {
	isRecordsTag,
	STORE_REPLACES_ARG,
	storeBackendKind,
	storeWriteTarget,
	validateBlobName,
	validateTagName,
} from "../../core/store-paths.js";
import { ToolNames } from "../../core/tool-names.js";
import type { McpPathArgumentAccess } from "../../domains/gateway/mcp/index.js";
import type { HostEffectCall } from "../registry-contract.js";
import { prepareStoreAdmissionArguments, type StoreAccess, storeAccessRefusal } from "../store/surface.js";

/** What a session may write in the store: the shape the `store` tool and a worker grant use. */
export interface McpStoreAccess {
	writable: boolean;
	grant?: { tags: ReadonlyArray<string>; dispatchRunId?: string };
}

const REFERENCE_PREFIX = "store:";
const NO_ACCESS: McpStoreAccess = { writable: false };

/** One store reference a call names in a declared path argument. */
export interface StoreReference {
	argument: string;
	access: McpPathArgumentAccess;
	tag: string;
	blob: string;
}

/** Whether a declared path argument's value is a store reference rather than a file path. */
export function isStoreReference(value: unknown): value is string {
	return typeof value === "string" && value.startsWith(REFERENCE_PREFIX);
}

/**
 * The tag and blob `value` names, or why it is not a valid reference. The tag
 * is the text up to the next `:` and the blob is the rest; a records tag is
 * never a reference's tag.
 */
export function parseStoreReference(value: string): { tag: string; blob: string } | string {
	const rest = value.slice(REFERENCE_PREFIX.length);
	const colon = rest.indexOf(":");
	if (colon < 0) return `'${value}' is not a store reference: write store:<tag>:<blob>`;
	const tag = rest.slice(0, colon);
	const blob = rest.slice(colon + 1);
	const problem =
		validateTagName(tag) ??
		(isRecordsTag(tag) ? `tag '${tag}' holds the store's records, which only the store writes and reads.` : null) ??
		validateBlobName(blob);
	return problem === null ? { tag, blob } : `'${value}' is not a valid store reference: ${problem}`;
}

/**
 * The store references a call names in its declared path arguments, in
 * declaration order, or the refusal for a malformed one. An argument the
 * declaration does not name is never read, and a value that does not begin
 * with `store:` (`./store:a:b` included) is a file path judged elsewhere.
 */
export function namedStoreReferences(
	declared: Readonly<Record<string, McpPathArgumentAccess>>,
	args: Readonly<Record<string, unknown>>,
): StoreReference[] | string {
	const references: StoreReference[] = [];
	for (const [argument, access] of Object.entries(declared)) {
		const value = Object.hasOwn(args, argument) ? args[argument] : undefined;
		if (!isStoreReference(value)) continue;
		const parsed = parseStoreReference(value);
		if (typeof parsed === "string") return `${access} path argument '${argument}': ${parsed}`;
		references.push({ argument, access, ...parsed });
	}
	return references;
}

/** The admission arguments of a store put: the `store` tool's own, marked when it replaces a blob. */
function putAdmission(tag: string, blob: string | null, cwd: string, access: StoreAccess): Record<string, unknown> {
	const prepared = prepareStoreAdmissionArguments({ op: "put", tag, ...(blob !== null ? { blob } : {}) }, cwd, access);
	// The classifier looks for the blob from the process cwd; the replaced blob is found from the project's.
	// A shared folder keeps no blob at a path, so its write reference commits only a new blob.
	try {
		if (storeBackendKind() !== "local") return prepared;
		const target = storeWriteTarget(cwd, prepared);
		if (target !== null) {
			const info = lstatSync(target, { throwIfNoEntry: false });
			if (info?.isFile() === true) prepared[STORE_REPLACES_ARG] = info.size;
		}
	} catch {
		// An unresolvable store names no target; the body refuses the call before the server sees it.
	}
	return prepared;
}

/**
 * Each reference as the `store` call it stands for: a read reference is a
 * `get`, a write reference a `put`. So admission judges a read-only turn, an
 * ungranted worker, a write outside a worker's boundaries and a put over an
 * existing blob exactly as it judges the `store` tool.
 */
export function storeReferenceEffects(
	references: ReadonlyArray<StoreReference>,
	cwd: string,
	access: McpStoreAccess = NO_ACCESS,
): HostEffectCall[] {
	return references.map((reference) => ({
		label: `${reference.access} store reference '${reference.argument}' (store:${reference.tag}:${reference.blob})`,
		call: {
			tool: ToolNames.Store,
			args:
				reference.access === "read"
					? prepareStoreAdmissionArguments({ op: "get", tag: reference.tag, blob: reference.blob }, cwd, access)
					: putAdmission(reference.tag, reference.blob, cwd, access),
		},
	}));
}

function missingTag(tag: string): string {
	return `tag '${tag}' does not exist; create it with the store tool's op=create or pancode store put, then call again`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function defaultOpenStoreBackend(cwd: string): Promise<StoreBackend> {
	const { openStoreBackend } = await import("../../domains/store/index.js");
	return openStoreBackend(cwd);
}

/** An s3 store has no local path a server could write a blob to, so a write reference is refused by name. */
const S3_WRITE_REFERENCE_LIMIT =
	"an s3 store takes no write store references: a server has no local path to write the blob to; put its output with the store tool";

/**
 * Why a call's store references are refused, or null: a malformed write the
 * session may not make, a missing tag, a missing read blob. Nothing here needs
 * the server, so the call is refused before it starts.
 */
export async function storeReferencesRefusal(input: {
	references: ReadonlyArray<StoreReference>;
	access: McpStoreAccess | undefined;
	backend: () => Promise<StoreBackend>;
}): Promise<string | null> {
	const access = input.access ?? NO_ACCESS;
	for (const reference of input.references) {
		const named = `${reference.access} store reference '${reference.argument}' (store:${reference.tag}:${reference.blob})`;
		if (reference.access === "write") {
			if (storeBackendKind() === "s3") return `${named}: ${S3_WRITE_REFERENCE_LIMIT}`;
			const refused = storeAccessRefusal({ op: "put", tag: reference.tag }, access);
			if (refused !== null) return `${named}: ${refused}`;
		}
		try {
			const backend = await input.backend();
			if (!(await backend.tagExists(reference.tag))) return `${named}: ${missingTag(reference.tag)}`;
			if (reference.access === "read" && (await backend.statBlob(reference.tag, reference.blob)) === null) {
				return `${named}: tag '${reference.tag}' has no blob named '${reference.blob}'`;
			}
		} catch (error) {
			return `${named}: ${messageOf(error)}`;
		}
	}
	return null;
}

/** A read reference resolved for the call, as the put record's `used` names it. */
interface ResolvedRead {
	tag: string;
	blob: string;
	bytes: number;
	sha256: string | null;
}

/** A write reference the server writes to `temp`, committed as `tag:blob` after a successful call. */
interface PendingWrite {
	argument: string;
	tag: string;
	blob: string;
	temp: string;
}

/** One committed write, as the result lists it. */
export interface StoredReference {
	argument: string;
	tag: string;
	blob: string;
	bytes: number;
	sha256: string;
}

export interface PreparedStoreReferences {
	/** A copy of the call's arguments with each reference replaced by the path the server gets. */
	args: Record<string, unknown>;
	reads: ResolvedRead[];
	writes: PendingWrite[];
}

/**
 * The hidden sibling the server writes for `tag:blob`: `.<name>.<pid>.<12 hex>.tmp`, the shape the
 * backend's own temporaries have, so a listing never shows it. It lies in the blob's directory when
 * that exists, else in the nearest existing directory of the tag's blobs; nothing is created. In a
 * shared folder that directory is the tag's staging directory, which the caller creates.
 */
function temporaryPath(cwd: string, tag: string, blob: string): string {
	const target = storeWriteTarget(cwd, { op: "put", tag, blob });
	if (target === null) throw new Error(`store:${tag}:${blob} names no store path`);
	const blobs = path.join(target, ...blob.split("/").map(() => ".."));
	let dir = path.dirname(target);
	while (dir !== blobs && dir.startsWith(`${blobs}${path.sep}`) && !existsSync(dir)) dir = path.dirname(dir);
	return path.join(dir, `.${path.posix.basename(blob)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
}

/**
 * Resolve each reference right before the call: the access and existence
 * checks repeated, a read copied into the cache, a write given its temporary
 * path. Returns the refusal when one fails; nothing has been created then.
 */
export async function prepareStoreReferences(input: {
	references: ReadonlyArray<StoreReference>;
	args: Readonly<Record<string, unknown>>;
	cwd: string;
	access: McpStoreAccess | undefined;
	backend: () => Promise<StoreBackend>;
	signal?: AbortSignal;
}): Promise<PreparedStoreReferences | string> {
	const access = input.access ?? NO_ACCESS;
	const args: Record<string, unknown> = { ...input.args };
	const reads: ResolvedRead[] = [];
	const writes: PendingWrite[] = [];
	for (const reference of input.references) {
		const named = `${reference.access} store reference '${reference.argument}' (store:${reference.tag}:${reference.blob})`;
		if (reference.access === "write") {
			if (storeBackendKind() === "s3") return `${named}: ${S3_WRITE_REFERENCE_LIMIT}`;
			const refused = storeAccessRefusal({ op: "put", tag: reference.tag }, access);
			if (refused !== null) return `${named}: ${refused}`;
		}
		try {
			const backend = await input.backend();
			if (!(await backend.tagExists(reference.tag))) return `${named}: ${missingTag(reference.tag)}`;
			if (reference.access === "write") {
				const temp = temporaryPath(input.cwd, reference.tag, reference.blob);
				if (storeBackendKind() === "shared") await mkdir(path.dirname(temp), { recursive: true });
				writes.push({ argument: reference.argument, tag: reference.tag, blob: reference.blob, temp });
				args[reference.argument] = temp;
				continue;
			}
			const stat = await backend.statBlob(reference.tag, reference.blob);
			if (stat === null) return `${named}: tag '${reference.tag}' has no blob named '${reference.blob}'`;
			const { currentState, readBlobHistory } = await import("@pancode/store");
			const { put } = currentState((await readBlobHistory(backend, reference.tag, reference.blob)).records);
			const copy = await backend.getBlobAsPath(reference.tag, reference.blob, input.signal);
			reads.push({ tag: reference.tag, blob: reference.blob, bytes: stat.bytes, sha256: put?.identity?.sha256 ?? null });
			args[reference.argument] = copy.path;
		} catch (error) {
			return `${named}: ${messageOf(error)}`;
		}
	}
	return { args, reads, writes };
}

/** Remove every temporary path the call was given, whatever happened to it. */
export async function removeTemporaries(prepared: PreparedStoreReferences): Promise<void> {
	await Promise.all(prepared.writes.map((write) => rm(write.temp, { force: true, recursive: true })));
}

export interface StoreCommitResult {
	stored: StoredReference[];
	/** Why the commit stopped, naming what it stored before; absent when every write committed. */
	error?: string;
}

function storedLine(entry: StoredReference): string {
	return `stored ${entry.tag}:${entry.blob} (${entry.bytes} bytes, sha256 ${entry.sha256})`;
}

/** One `stored` line per committed write, as the result shows them. */
export function storedLines(stored: ReadonlyArray<StoredReference>): string {
	return stored.map(storedLine).join("\n");
}

/**
 * Commit each write of a call that succeeded, in declaration order, with a put
 * record naming actor `mcp`, the server as its client and the call's read
 * references as `used`. Every temporary must be a regular file the server
 * wrote before any is committed. A write that fails to commit stops the
 * commit and leaves the ones before it stored; the error names them.
 */
export async function commitStoreReferences(input: {
	prepared: PreparedStoreReferences;
	serverId: string;
	backend: () => Promise<StoreBackend>;
	ids: { sessionId?: string; turnId?: string; dispatchRunId?: string };
	signal?: AbortSignal;
}): Promise<StoreCommitResult> {
	const { prepared } = input;
	for (const write of prepared.writes) {
		const info = await lstat(write.temp).catch(() => null);
		if (info?.isFile() !== true) {
			return {
				stored: [],
				error: `write store reference '${write.argument}' (store:${write.tag}:${write.blob}): the server answered without writing a regular file at ${write.temp}, so nothing was stored`,
			};
		}
	}
	const [{ recordedPut }, { putHashObservation }] = await Promise.all([
		import("@pancode/store"),
		import("../../domains/store/provenance.js"),
	]);
	const stored: StoredReference[] = [];
	const committed = (): string =>
		stored.length === 0
			? "nothing was stored"
			: `stored before it: ${stored.map((s) => `${s.tag}:${s.blob}`).join(", ")}`;
	const used = prepared.reads.map((read) => ({ ...read }));
	for (const write of prepared.writes) {
		const named = `write store reference '${write.argument}'`;
		try {
			const backend = await input.backend();
			const result = await recordedPut(backend, {
				tag: write.tag,
				blob: write.blob,
				source: write.temp,
				mode: "link",
				// Admission judged a shared folder's write as a new blob, so it may not replace one.
				...(backend.kind === "local" ? {} : { ifAbsent: true }),
				actor: { actor: "mcp", client: input.serverId, ...input.ids },
				...(input.signal !== undefined ? { signal: input.signal } : {}),
				record: (put) => {
					const hash = putHashObservation(put);
					return {
						identity: {
							bytes: put.bytes,
							modifiedMs: put.modifiedMs,
							sha256: hash.sha256,
							...(hash.hashOmitted !== undefined ? { hashOmitted: hash.hashOmitted } : {}),
						},
						...(used.length > 0 ? { used } : {}),
					};
				},
			});
			if (!result.recorded) {
				return {
					stored,
					error:
						`store: put stored the bytes the server wrote for '${write.argument}' as ${write.tag}:${write.blob} but could not record them (${result.reason}). ` +
						`The blob is in the store without a record, so stat shows drift "unrecorded"; ` +
						`put the same file again to record it, or remove ${write.tag}:${write.blob} to drop it. ${committed()}`,
				};
			}
			stored.push({
				argument: write.argument,
				tag: write.tag,
				blob: write.blob,
				bytes: result.put.bytes,
				sha256: result.put.sha256,
			});
		} catch (error) {
			return {
				stored,
				error: `${named}: the commit of ${write.tag}:${write.blob} failed (${messageOf(error)}); ${committed()}`,
			};
		}
	}
	return { stored };
}
