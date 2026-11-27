// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The store server's seven tools, over the project store the options name and
 * through `@pancode/store`'s public exports alone. Five read any tag of the
 * project; `store_put` and `store_note` write only into the tags named with
 * `--write-tag`, and every record they write names the actor `mcp`. No tool
 * removes anything.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { defineTool, type ToolResult } from "@pancode/sdk/tool";
import {
	appendRecord,
	createLocalStoreBackend,
	createSharedStoreBackend,
	currentState,
	driftOf,
	hashStoreFile,
	isRecordsTag,
	type RecordedPutResult,
	readBlobHistory,
	recordedPut,
	recordsTag,
	STORE_CLASS_XATTR,
	STORE_PUT_TAG_CLASS,
	type StoreBackend,
	type StoreRecord,
	StoreRefusal,
	type StoreRootSpec,
	summarizeRecords,
	validateBlobName,
	validateTagName,
} from "@pancode/store";
import { NO_ROOT_REASON, type StoreServerConfig, storeConfig, tagWritable } from "./options.js";

export const MAX_TAGS = 500;
export const MAX_BLOBS = 500;
export const MAX_HISTORY = 200;
const NOTE_MAX_CHARS = 4096;
const SOURCE_MAX_CHARS = 4096;
/** Records per page when a tag's history is listed. */
const RECORD_PAGE = 1000;
const RECORD_NAME = /^(.+)#\d{8}$/u;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The package's own name rules, stated as patterns a host can check before calling. */
const TAG_SCHEMA = {
	type: "string",
	pattern: "^[A-Za-z0-9._/-]+$",
	minLength: 1,
	maxLength: 200,
	description:
		"A tag name: letters, digits, '.', '_', '-' and '/', at most 200 bytes, no empty, '.' or '..' segment and no segment starting with '.'.",
} as const;
const BLOB_SCHEMA = {
	type: "string",
	pattern: "^[\\x20-\\x22\\x24-\\x5b\\x5d-\\x7e]+$",
	minLength: 1,
	maxLength: 480,
	description:
		"A blob name inside the tag: printable ASCII other than '#' and '\\', at most 480 bytes, no empty, '.' or '..' segment.",
} as const;

type Opened = { config: StoreServerConfig; backend: StoreBackend } | { error: string };

/**
 * The configured store, or the tool error saying why there is none. A read
 * also needs the primary root to exist, so a mistyped `--root` is never read
 * as an empty store; a write creates it, as `pancode store put` does.
 */
async function openStore(tool: string, forWrite: boolean): Promise<Opened> {
	const config = storeConfig();
	if (config === null) return { error: `${tool}: ${NO_ROOT_REASON}` };
	if (!forWrite || config.shared) {
		const problem = await primaryRootProblem(config);
		if (problem !== null) return { error: `${tool}: ${problem}` };
	}
	try {
		const project = {
			cacheDir: config.cacheDir,
			projectKey: config.projectKey,
			...(config.projectId !== undefined ? { projectId: config.projectId } : {}),
			projectRoot: config.projectRoot,
		};
		const backend = config.shared
			? createSharedStoreBackend({ root: (config.roots[0] as StoreRootSpec).path, ...project })
			: createLocalStoreBackend({ roots: config.roots, ...project });
		return { config, backend };
	} catch (error) {
		return { error: `${tool}: ${message(error)}` };
	}
}

/** Why the primary root cannot be read, or null when it is a directory. */
export async function primaryRootProblem(config: StoreServerConfig): Promise<string | null> {
	const primary = config.roots[0];
	if (primary === undefined) return NO_ROOT_REASON;
	try {
		if ((await stat(primary.path)).isDirectory()) return null;
		return `the primary store root ${primary.path} is not a directory`;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return `the primary store root ${primary.path} does not exist: nothing was stored there yet, or --root names the wrong directory (pancode store where prints the options for a project)`;
		}
		return `the primary store root ${primary.path} cannot be read: ${message(error)}`;
	}
}

/** A failed store call as a tool error: the package's message, and its reason when it refused. */
function failure(tool: string, error: unknown): ToolResult {
	if (error instanceof StoreRefusal) return { error: `${tool}: ${error.message} (${error.reason})` };
	return { error: `${tool}: ${message(error)}` };
}

function tagProblem(tool: string, tag: unknown): string | null {
	if (typeof tag !== "string") return `${tool}: tag must be a string`;
	const problem = validateTagName(tag);
	return problem === null ? null : `${tool}: ${problem}`;
}

function blobProblem(tool: string, blob: unknown): string | null {
	if (typeof blob !== "string") return `${tool}: blob must be a string`;
	const problem = validateBlobName(blob);
	return problem === null ? null : `${tool}: ${problem}`;
}

/** The refusal for a write into `tag`, or null when this server may write it. */
function writeRefusal(tool: string, config: StoreServerConfig, tag: string): string | null {
	if (config.writeTags.length === 0) {
		return `${tool}: this server was started without --write-tag, so it writes into no tag; start it with --write-tag <tag> to let it write that tag and the tags nested under it`;
	}
	if (tagWritable(config, tag)) return null;
	const allowed = config.writeTags.map((name) => `${name} (and ${name}/...)`).join(", ");
	return `${tool}: tag ${tag} is not writable by this server; it may write only ${allowed}, the tags named with --write-tag when it was started`;
}

function isoTime(ms: number): string {
	return new Date(ms).toISOString();
}

/** The root a tag is placed on, through the package's usage walk of that one tag. */
async function rootOfTag(backend: StoreBackend, tag: string): Promise<string> {
	const usage = await backend.usage(tag);
	const entry = usage.tags.find((row) => row.tag === tag);
	if (entry === undefined) throw new StoreRefusal("not-found", `The store has no tag named ${tag}.`);
	return entry.root;
}

/** A record as a result shows it: who, when and what, without the backend's receipt. */
function recordView(record: StoreRecord) {
	return {
		kind: record.kind,
		tag: record.tag,
		blob: record.blob,
		seq: record.seq,
		at: record.at,
		actor: record.producedBy.actor,
		note: record.note ?? null,
		bytes: record.identity?.bytes ?? null,
		sha256: record.identity?.sha256 ?? null,
		...(record.recovered === true ? { recovered: true } : {}),
	};
}

const storeTags = defineTool({
	name: "store_tags",
	title: "Store tags",
	description: `Returns the project store's tags (at most ${MAX_TAGS}) with each tag's blob count, total bytes and the store root it is placed on. Prefer it over running pancode store tags or listing the store directory: one call answers in structured fields and says when the list was cut.`,
	input: { type: "object", properties: {} },
	actionClass: "read",
	idempotent: true,
	async run() {
		const opened = await openStore("store_tags", false);
		if ("error" in opened) return { error: opened.error };
		const { config, backend } = opened;
		try {
			const usage = await backend.usage();
			const tags = usage.tags
				.filter((row) => !isRecordsTag(row.tag))
				.map((row) => ({ tag: row.tag, blobs: row.blobs, bytes: row.bytes, root: row.root }));
			return {
				json: {
					project: { root: config.projectRoot, key: config.projectKey },
					roots: config.roots.map((root) => ({ name: root.name, path: root.path })),
					tags: tags.slice(0, MAX_TAGS),
					total: tags.length,
					cap: MAX_TAGS,
					truncated: tags.length > MAX_TAGS,
					writeTags: config.writeTags,
				},
			};
		} catch (error) {
			return failure("store_tags", error);
		}
	},
});

const storeList = defineTool({
	name: "store_list",
	title: "List a store tag",
	description: `Returns the blobs of one tag (at most ${MAX_BLOBS}, sorted by name, optionally only those whose name starts with prefix) with each blob's bytes, when it was stored and whether it has a record. Prefer it over running pancode store ls or listing the store directory: sizes are bytes, times are ISO 8601, and the result says when the list was cut.`,
	input: {
		type: "object",
		properties: {
			tag: TAG_SCHEMA,
			prefix: {
				...BLOB_SCHEMA,
				description: "Only blobs whose name starts with this literal text (printable ASCII other than '#' and '\\').",
			},
		},
		required: ["tag"],
	},
	actionClass: "read",
	idempotent: true,
	async run(args: { tag: string; prefix?: string }) {
		const bad = tagProblem("store_list", args.tag);
		if (bad !== null) return { error: bad };
		if (args.prefix !== undefined) {
			if (typeof args.prefix !== "string" || !/^[\x20-\x22\x24-\x5b\x5d-\x7e]+$/u.test(args.prefix)) {
				return { error: "store_list: prefix must be printable ASCII other than '#' and '\\'" };
			}
		}
		const opened = await openStore("store_list", false);
		if ("error" in opened) return { error: opened.error };
		const { backend } = opened;
		try {
			if (!(await backend.tagExists(args.tag))) {
				return { error: `store_list: The store has no tag named ${args.tag}. (not-found)` };
			}
			const { names, hasMore } = await backend.listBlobs(args.tag, {
				...(args.prefix !== undefined ? { prefix: args.prefix } : {}),
				offset: 0,
				limit: MAX_BLOBS,
			});
			const summary = await summarizeRecords(backend, args.tag, names);
			const blobs = [];
			for (const name of names) {
				const info = await backend.statBlob(args.tag, name);
				const recorded = summary.get(name)?.recorded ?? null;
				blobs.push({
					blob: name,
					bytes: info?.bytes ?? null,
					storedAt: info === null ? null : isoTime(info.modifiedMs),
					recorded,
					...(info === null
						? { unavailable: { bytes: "the blob was removed while the tag was listed", storedAt: "the same" } }
						: recorded === null
							? { unavailable: { recorded: "the tag has more records than one listing reads" } }
							: {}),
				});
			}
			return {
				json: {
					tag: args.tag,
					prefix: args.prefix ?? null,
					blobs,
					cap: MAX_BLOBS,
					truncated: hasMore,
				},
			};
		} catch (error) {
			return failure("store_list", error);
		}
	},
});

const storeStat = defineTool({
	name: "store_stat",
	title: "Store blob details",
	description:
		"Returns one blob's bytes, SHA-256, the store root its tag is placed on, whether the stored bytes still match their record (drift), and the record of its last put (actor, time, note) with the notes added since. Prefer it over running pancode store stat or sha256sum on the store: it reports what was recorded and whether the bytes changed since.",
	input: { type: "object", properties: { tag: TAG_SCHEMA, blob: BLOB_SCHEMA }, required: ["tag", "blob"] },
	actionClass: "read",
	idempotent: true,
	async run(args: { tag: string; blob: string }) {
		const bad = tagProblem("store_stat", args.tag) ?? blobProblem("store_stat", args.blob);
		if (bad !== null) return { error: bad };
		const opened = await openStore("store_stat", false);
		if ("error" in opened) return { error: opened.error };
		const { backend } = opened;
		const { tag, blob } = args;
		try {
			const info = await backend.statBlob(tag, blob);
			const { records } = await readBlobHistory(backend, tag, blob);
			const state = currentState(records);
			if (info === null && state.put === null) {
				const removed = state.removed ? "; it was removed and its records remain" : "";
				return { error: `store_stat: ${tag}:${blob} is not in the store${removed}. (not-found)` };
			}
			const drift = driftOf(state.put, info);
			const unavailable: Record<string, string> = {};
			const recordedSha = state.put?.identity?.sha256 ?? null;
			let sha256: string | null = null;
			if (state.put === null) unavailable.sha256 = "the blob has no put record, so no SHA-256 was recorded";
			else if (drift !== "none") unavailable.sha256 = `the stored bytes no longer match their record (drift ${drift})`;
			else if (recordedSha === null) {
				unavailable.sha256 = `its put record holds no SHA-256 (${state.put.identity?.hashOmitted ?? "not recorded"})`;
			} else sha256 = recordedSha;
			if (info === null) unavailable.bytes = "the blob's bytes are missing from the store";
			const put = state.put;
			return {
				json: {
					tag,
					blob,
					bytes: info?.bytes ?? null,
					storedAt: info === null ? null : isoTime(info.modifiedMs),
					sha256,
					root: await rootOfTag(backend, tag),
					drift,
					lastPut:
						put === null
							? null
							: { actor: put.producedBy.actor, at: put.at, note: put.note ?? null, bytes: put.identity?.bytes ?? null },
					notes: state.notes.map((record) => ({ actor: record.producedBy.actor, at: record.at, note: record.note ?? null })),
					unavailable,
				},
			};
		} catch (error) {
			return failure("store_stat", error);
		}
	},
});

const storeGet = defineTool({
	name: "store_get",
	title: "Get a store blob",
	description:
		"Returns the path of a read-only copy of one blob, with its bytes and SHA-256; it never returns the content, which the host's own read tool reads from that path. Prefer it over reading the store directory: writing the copy cannot change the stored blob.",
	input: { type: "object", properties: { tag: TAG_SCHEMA, blob: BLOB_SCHEMA }, required: ["tag", "blob"] },
	actionClass: "read",
	idempotent: true,
	async run(args: { tag: string; blob: string }, context) {
		const bad = tagProblem("store_get", args.tag) ?? blobProblem("store_get", args.blob);
		if (bad !== null) return { error: bad };
		const opened = await openStore("store_get", false);
		if ("error" in opened) return { error: opened.error };
		const { backend } = opened;
		try {
			const got = await backend.getBlobAsPath(args.tag, args.blob, context.signal);
			const bytes = (await stat(got.path)).size;
			const sha256 = await hashStoreFile(got.path, context.signal);
			return { json: { tag: args.tag, blob: args.blob, path: got.path, readOnly: true, bytes, sha256 } };
		} catch (error) {
			return failure("store_get", error);
		}
	},
});

/** Every record of a tag, newest first, at most `limit`: each blob's newest `limit`, merged. */
async function tagHistory(
	backend: StoreBackend,
	tag: string,
	limit: number,
): Promise<{ records: StoreRecord[]; skipped: number }> {
	const blobs = new Set<string>();
	if (await backend.tagExists(recordsTag(tag))) {
		for (let offset = 0; ; offset += RECORD_PAGE) {
			const page = await backend.listBlobs(recordsTag(tag), { offset, limit: RECORD_PAGE });
			for (const name of page.names) {
				const blob = RECORD_NAME.exec(name)?.[1];
				if (blob !== undefined) blobs.add(blob);
			}
			if (!page.hasMore) break;
		}
	}
	const records: StoreRecord[] = [];
	let skipped = 0;
	for (const blob of blobs) {
		const history = await readBlobHistory(backend, tag, blob, { limit });
		records.push(...history.records);
		skipped += history.skipped;
	}
	return { records, skipped };
}

const storeHistory = defineTool({
	name: "store_history",
	title: "Store tag history",
	description: `Returns the records of one blob, or of every blob of a tag when blob is left out, newest first (at most ${MAX_HISTORY}): each put, note and removal with its actor, time, note, bytes and SHA-256. Prefer it over running pancode store history: it covers a whole tag in one call and says when the list was cut.`,
	input: { type: "object", properties: { tag: TAG_SCHEMA, blob: BLOB_SCHEMA }, required: ["tag"] },
	actionClass: "read",
	idempotent: true,
	async run(args: { tag: string; blob?: string }) {
		const bad =
			tagProblem("store_history", args.tag) ?? (args.blob !== undefined ? blobProblem("store_history", args.blob) : null);
		if (bad !== null) return { error: bad };
		const opened = await openStore("store_history", false);
		if ("error" in opened) return { error: opened.error };
		const { backend } = opened;
		try {
			const hasTag = await backend.tagExists(args.tag);
			if (!hasTag && !(await backend.tagExists(recordsTag(args.tag)))) {
				return { error: `store_history: The store has no tag named ${args.tag}. (not-found)` };
			}
			const read =
				args.blob !== undefined
					? await readBlobHistory(backend, args.tag, args.blob, { limit: MAX_HISTORY + 1 })
					: await tagHistory(backend, args.tag, MAX_HISTORY + 1);
			const ordered = [...read.records].sort((a, b) =>
				a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.blob !== b.blob ? (a.blob < b.blob ? -1 : 1) : b.seq - a.seq,
			);
			return {
				json: {
					tag: args.tag,
					blob: args.blob ?? null,
					records: ordered.slice(0, MAX_HISTORY).map(recordView),
					cap: MAX_HISTORY,
					truncated: ordered.length > MAX_HISTORY,
					unreadableRecords: read.skipped,
				},
			};
		} catch (error) {
			return failure("store_history", error);
		}
	},
});

const storePut = defineTool({
	name: "store_put",
	title: "Put a file in the store",
	description:
		"Puts the file at source into tag as blob (default the file's name) and records the put with actor mcp, returning the store's result unchanged, including a put whose bytes are stored but whose record could not be written; a tag the server was not started with --write-tag for is refused. Prefer it over copying into the store directory: the put is atomic, hashed and recorded.",
	input: {
		type: "object",
		properties: {
			tag: TAG_SCHEMA,
			source: {
				type: "string",
				minLength: 1,
				maxLength: SOURCE_MAX_CHARS,
				description: "The file to store; a relative path resolves from the server's working directory.",
			},
			blob: BLOB_SCHEMA,
			note: { type: "string", maxLength: NOTE_MAX_CHARS, description: "A note kept in the put's record." },
		},
		required: ["tag", "source"],
	},
	actionClass: "execute",
	pathArguments: { source: "read" },
	async run(args: { tag: string; source: string; blob?: string; note?: string }, context) {
		const bad = tagProblem("store_put", args.tag);
		if (bad !== null) return { error: bad };
		const config = storeConfig();
		if (config === null) return { error: `store_put: ${NO_ROOT_REASON}` };
		const refused = writeRefusal("store_put", config, args.tag);
		if (refused !== null) return { error: refused };
		if (typeof args.source !== "string" || args.source.length === 0 || args.source.length > SOURCE_MAX_CHARS) {
			return { error: `store_put: source must be a path of 1 to ${SOURCE_MAX_CHARS} characters` };
		}
		if (args.note !== undefined && (typeof args.note !== "string" || args.note.length > NOTE_MAX_CHARS)) {
			return { error: `store_put: note must be text of at most ${NOTE_MAX_CHARS} characters` };
		}
		const sourceAbs = path.resolve(args.source);
		const blob = args.blob ?? path.basename(sourceAbs);
		const badBlob = blobProblem("store_put", blob);
		if (badBlob !== null) return { error: badBlob };
		const opened = await openStore("store_put", true);
		if ("error" in opened) return { error: opened.error };
		const { backend } = opened;
		try {
			const { created } = await backend.getOrCreateTag(args.tag, { class: STORE_PUT_TAG_CLASS });
			if (created) {
				await backend.setTagXattr(args.tag, "pancode.description", "");
				await backend.setTagXattr(args.tag, STORE_CLASS_XATTR, STORE_PUT_TAG_CLASS);
				await backend.setTagXattr(args.tag, "pancode.createdAt", new Date().toISOString());
			}
			const relative = path.relative(config.projectRoot, sourceAbs);
			const inside = relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
			const result: RecordedPutResult = await recordedPut(backend, {
				tag: args.tag,
				blob,
				source: sourceAbs,
				actor: { actor: "mcp" },
				signal: context.signal,
				record: {
					...(inside ? { source: { path: relative.split(path.sep).join("/") } } : {}),
					...(args.note !== undefined ? { note: args.note } : {}),
				},
			});
			return { json: result };
		} catch (error) {
			return failure("store_put", error);
		}
	},
});

const storeNote = defineTool({
	name: "store_note",
	title: "Add a store note",
	description:
		"Adds a note to one blob's records with actor mcp, as PanCode's own store tool records a note, and returns the record written; a tag the server was not started with --write-tag for is refused. Prefer it over keeping notes beside the store: the note joins the blob's history, which store_stat and store_history show.",
	input: {
		type: "object",
		properties: {
			tag: TAG_SCHEMA,
			blob: BLOB_SCHEMA,
			note: { type: "string", minLength: 1, maxLength: NOTE_MAX_CHARS, description: "The note." },
		},
		required: ["tag", "blob", "note"],
	},
	actionClass: "execute",
	async run(args: { tag: string; blob: string; note: string }) {
		const bad = tagProblem("store_note", args.tag);
		if (bad !== null) return { error: bad };
		const config = storeConfig();
		if (config === null) return { error: `store_note: ${NO_ROOT_REASON}` };
		const refused = writeRefusal("store_note", config, args.tag);
		if (refused !== null) return { error: refused };
		const badBlob = blobProblem("store_note", args.blob);
		if (badBlob !== null) return { error: badBlob };
		if (typeof args.note !== "string" || args.note.length === 0 || args.note.length > NOTE_MAX_CHARS) {
			return { error: `store_note: note must be text of 1 to ${NOTE_MAX_CHARS} characters` };
		}
		const opened = await openStore("store_note", false);
		if ("error" in opened) return { error: opened.error };
		const { backend } = opened;
		try {
			if ((await backend.statBlob(args.tag, args.blob)) === null) {
				return { error: `store_note: ${args.tag}:${args.blob} is not in the store. (not-found)` };
			}
			const record = await appendRecord(backend, {
				kind: "note",
				tag: args.tag,
				blob: args.blob,
				producedBy: { actor: "mcp" },
				note: args.note,
			});
			return { json: { noted: record } };
		} catch (error) {
			return failure("store_note", error);
		}
	},
});

export const STORE_TOOLS = [storeTags, storeList, storeStat, storeGet, storeHistory, storePut, storeNote];
