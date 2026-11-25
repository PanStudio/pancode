// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The store's command line: argument parsing, the verbs, their text and `--json` output and exit codes. A host
 * runs it with a context naming what only the host knows: the roots, the cache directory, the project and the
 * actor its records carry. `pancode store` and `panstore` are two hosts of this one module.
 */
import { constants as fsConstants } from "node:fs";
import { copyFile, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { StoreBackend } from "../backend/backend.js";
import { type StoreBackendFacts, type StoreBlobPut, type StoreBlobStat, StoreRefusal } from "../backend/types.js";
import { safeResourceWriteAsync } from "../durable-write.js";
import { readStoreRootId } from "../identity.js";
import { openStoreIndex, type StoreIndex } from "../index-db/index.js";
import { createLocalStoreBackend } from "../local.js";
import { breakStoreLock, listStoreLocks, readStoreLock, type StoreLockInfo } from "../lock.js";
import {
	recordsTag,
	STORE_PUT_TAG_CLASS,
	type StorePlacementRules,
	type StoreRootSpec,
	storeProjectDir,
	storeProjectKey,
	storeRootOption,
	validateBlobName,
	validateTagName,
} from "../paths/index.js";
import { recordedPut, recordedRemove, type StorePutRecordFields } from "../recorded.js";
import {
	currentState,
	driftOf,
	readBlobHistory,
	type StoreRecord,
	type StoreRecordProducer,
	summarizeRecords,
} from "../records.js";
import { allStoreBlobs, type StoreVerifyResult, verifyStoreTag } from "../verify.js";

/** What a `put` hands the host's provenance finder: the stored bytes and where they came from. */
export interface StoreCliPutInput {
	backend: StoreBackend;
	tag: string;
	blob: string;
	/** Absolute path of the file the blob was put from. */
	sourceAbs: string;
	/** The put's own stat of the bytes it stored. */
	stored: StoreBlobPut;
	note?: string;
}

export interface StoreCliContext {
	/** Where relative file arguments resolve. */
	cwd: string;
	/** Non-empty; the first is the primary. */
	roots: ReadonlyArray<StoreRootSpec>;
	placement?: StorePlacementRules;
	cacheDir: string;
	/** The project's main checkout. */
	projectRoot: string;
	/** `storeProjectKeyForId(projectId)` when the project has an id, else `storeProjectKey(projectRoot)`. */
	projectKey: string;
	/** The project id its tracked settings give it; absent when it has none. */
	projectId?: string;
	/** Who the records this command writes name as their producer. */
	actor: StoreRecordProducer;
	/** How the command is invoked, for help, diagnostics and hints: `panstore` or `pancode store`. */
	command: string;
	/** A blob larger than this is recorded without its sha256 unless `verify --hash-large` asks; default no limit. */
	hashMaxBytes?: number;
	/** The provenance a put records; default the stored bytes' identity, the source path and the note. */
	provenance?: (input: StoreCliPutInput) => StorePutRecordFields | Promise<StorePutRecordFields>;
	/** Asked before `rm` and `rm-tag` without `--yes`; default ask on a terminal, else preview. */
	confirm?: (question: string) => Promise<boolean>;
	/** Default `createLocalStoreBackend` over the roots above. */
	openBackend?: () => Promise<StoreBackend>;
}

export class StoreCliUsageError extends Error {}

const VERBS = [
	"tags",
	"ls",
	"stat",
	"history",
	"verify",
	"put",
	"get",
	"rm",
	"rm-tag",
	"adopt",
	"where",
	"usage",
	"locks",
];

export function storeCliHelp(command: string): string {
	return `${command} <command>

The store visible from the current directory: this project's tags and blobs,
the same from the main checkout and every task worktree of it.

Commands:
  ${command} tags [--json]
  ${command} ls <tag> [pattern] [--json]
  ${command} stat <tag>:<blob> [--json]
  ${command} history <tag>:<blob> [--json]
  ${command} verify <tag> [pattern] [--hash-large] [--record-unrecorded] [--json]
  ${command} put <tag> <file> [--blob <name>] [--note <text>] [--link] [--json]
  ${command} get <tag>:<blob> [--to <path>] [--json]
  ${command} rm <tag>:<blob> --yes [--json]
  ${command} rm-tag <tag> --yes [--json]
  ${command} adopt [<projectKey>] [--json]
  ${command} where [--json]
  ${command} usage [tag] [--json]
  ${command} locks [--json]
  ${command} locks break <id> --yes [--json]

pattern is a regular expression matched against the whole blob name.
verify compares each recorded blob's size and mtime with its record, and its
sha256 when the record holds one; --hash-large also hashes blobs whose record
omitted the hash and records the digest as a note. --record-unrecorded appends
a put record, marked recovered, for each blob stored without one, from its
bytes as they are now. Exit 1 unless every blob is ok or recorded.
put creates the tag (class input) when it does not exist. put --link shares the
file's blocks by a reflink where the file system supports it and copies
otherwise; the output says which.
usage counts blobs and bytes per tag and per store root by walking the store,
with each root's file system free space (not a quota).
rm and rm-tag without --yes delete nothing, print what they would delete and
exit 0; a missing tag or blob exits 1.
adopt without a key lists store directories whose project root no longer
exists and that carry no project id; with a key it moves that store to this
project, refusing when this project already has one.
where prints the store's locations, each root's id and the panstore command
line that reaches it. A project id keys the store by that id instead of the
main checkout's path; where then names a store left under the path key, which
adopt moves.
locks lists the project's store locks with each holder's key, pid, host and
time, and its state: live (this host, pid alive, same boot), dead (this host,
pid gone or another boot), remote (another host) or unreadable. A writer takes
over only a dead lock; locks break removes any lock that is not live, and
without --yes prints what it would remove and exits 0. It never touches a blob
or a record.
Exit codes: 0 success; 1 operational failure or verify not ok; 2 invalid usage.
`;
}

function open(context: StoreCliContext): Promise<StoreBackend> {
	if (context.openBackend !== undefined) return context.openBackend();
	return Promise.resolve(
		createLocalStoreBackend({
			roots: context.roots,
			...(context.placement !== undefined ? { placement: context.placement } : {}),
			cacheDir: context.cacheDir,
			projectKey: context.projectKey,
			...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
			projectRoot: context.projectRoot,
		}),
	);
}

const NO_INDEX: StoreIndex = { tags: async () => null, blobs: async () => null, history: async () => null };

/**
 * The host-local index over the store `context` names, for listing and history display only (N8). Each answer is
 * null when the index cannot give it, and the verb then scans the store as before. Its freshness is a stat of the
 * local roots, so another kind of backend is never indexed.
 */
function storeIndex(context: StoreCliContext, backend: StoreBackend): StoreIndex {
	if (backend.kind !== "local") return NO_INDEX;
	return openStoreIndex({ backend, roots: context.roots, cacheDir: context.cacheDir, projectKey: context.projectKey });
}

function primaryRoot(context: StoreCliContext): string {
	const primary = context.roots[0];
	if (primary === undefined) throw new StoreCliUsageError("no store root");
	return primary.path;
}

function bytesLabel(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

function formatColumns(rows: ReadonlyArray<ReadonlyArray<string>>): string {
	const widths: number[] = [];
	for (const row of rows) {
		for (let i = 0; i < row.length; i += 1) widths[i] = Math.max(widths[i] ?? 0, row[i]?.length ?? 0);
	}
	return rows
		.map((row) =>
			row
				.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd((widths[index] ?? cell.length) + 2)))
				.join("")
				.trimEnd(),
		)
		.join("\n");
}

function checkTagArg(tag: string | undefined): string {
	if (tag === undefined) throw new StoreCliUsageError("missing <tag>");
	const problem = validateTagName(tag);
	if (problem !== null) throw new StoreCliUsageError(problem);
	return tag;
}

function parseRef(ref: string | undefined): { tag: string; blob: string } {
	if (ref === undefined) throw new StoreCliUsageError("missing <tag>:<blob>");
	const colon = ref.indexOf(":");
	if (colon <= 0 || colon === ref.length - 1) throw new StoreCliUsageError(`expected <tag>:<blob>, got '${ref}'`);
	const tag = checkTagArg(ref.slice(0, colon));
	const blob = ref.slice(colon + 1);
	const problem = validateBlobName(blob);
	if (problem !== null) throw new StoreCliUsageError(problem);
	return { tag, blob };
}

async function requireTag(backend: StoreBackend, tag: string): Promise<void> {
	if (!(await backend.tagExists(tag))) throw new StoreRefusal("not-found", `The store has no tag named ${tag}.`);
}

async function tagTotals(backend: StoreBackend, tag: string): Promise<{ blobs: number; bytes: number }> {
	let bytes = 0;
	const names = await allStoreBlobs(backend, tag);
	for (const name of names) bytes += (await backend.statBlob(tag, name))?.bytes ?? 0;
	return { blobs: names.length, bytes };
}

export async function storeCliTags(context: StoreCliContext) {
	const backend = await open(context);
	const indexed = await storeIndex(context, backend).tags();
	if (indexed !== null) {
		const tags = indexed.map((entry) => ({
			tag: entry.tag,
			class: entry.xattrs["pancode.class"] ?? null,
			description: entry.xattrs["pancode.description"] ?? null,
			blobs: entry.blobs,
			bytes: entry.bytes,
		}));
		return { tags, backend: await backend.facts() };
	}
	const tags = [];
	for (const tag of await backend.listTags()) {
		if (validateTagName(tag) !== null) continue;
		const xattrs = await backend.getTagXattrs(tag);
		tags.push({
			tag,
			class: xattrs["pancode.class"] ?? null,
			description: xattrs["pancode.description"] ?? null,
			...(await tagTotals(backend, tag)),
		});
	}
	return { tags, backend: await backend.facts() };
}

async function storeList(context: StoreCliContext, tag: string, pattern?: string) {
	const backend = await open(context);
	// Whether the tag exists is decided by the store itself, never by the index.
	await requireTag(backend, tag);
	const indexed = await storeIndex(context, backend).blobs(tag, pattern);
	if (indexed !== null) {
		const blobs = indexed.map((entry) => ({
			blob: entry.blob,
			bytes: entry.bytes,
			modified: entry.modifiedMs === null ? null : new Date(entry.modifiedMs).toISOString(),
			recorded: entry.recorded,
		}));
		return { tag, blobs };
	}
	const names = await allStoreBlobs(backend, tag, pattern);
	const summary = await summarizeRecords(backend, tag, names);
	const blobs = [];
	for (const name of names) {
		const info = await backend.statBlob(tag, name);
		blobs.push({
			blob: name,
			bytes: info?.bytes ?? null,
			modified: info === null ? null : new Date(info.modifiedMs).toISOString(),
			recorded: summary.get(name)?.recorded ?? null,
		});
	}
	return { tag, blobs };
}

/** The store tool's `stat` shape, plus the blob's path: the operator may open it. */
async function storeStat(context: StoreCliContext, tag: string, blob: string) {
	const backend = await open(context);
	const info = await backend.statBlob(tag, blob);
	const state = currentState((await readBlobHistory(backend, tag, blob)).records);
	if (info === null && state.put === null) {
		const removed = state.removed ? "; it was removed and its records remain" : "";
		throw new StoreRefusal("not-found", `${tag}:${blob} is not in the store${removed}.`);
	}
	const facts = await backend.facts();
	return {
		path: info === null ? null : (await backend.getBlobAsPath(tag, blob)).path,
		...statPayload(facts, tag, blob, info, state),
	};
}

function statPayload(
	facts: StoreBackendFacts,
	tag: string,
	blob: string,
	info: StoreBlobStat | null,
	state: ReturnType<typeof currentState>,
) {
	const put = state.put;
	return {
		ref: `${tag}:${blob}`,
		bytes: info?.bytes ?? null,
		modified: info === null ? null : new Date(info.modifiedMs).toISOString(),
		drift: driftOf(put, info),
		identity: put?.identity ?? null,
		generatedBy: put?.generatedBy ?? "no producing run on record",
		used: put?.used ?? [],
		producedBy: put?.producedBy ?? null,
		notes: state.notes.map((record) => ({
			at: record.at,
			...(record.note !== undefined ? { note: record.note } : {}),
			...(record.used !== undefined ? { used: record.used } : {}),
		})),
		receipt: put?.receipt ?? null,
		...(state.removed ? { removed: true } : {}),
		backend: {
			kind: facts.kind,
			tier: null,
			reason: facts.tiers === false ? "this backend has no storage tiers" : "tier placement is not reported yet",
		},
	};
}

async function storeHistory(context: StoreCliContext, tag: string, blob: string) {
	const backend = await open(context);
	const { records, skipped } =
		(await storeIndex(context, backend).history(tag, blob)) ?? (await readBlobHistory(backend, tag, blob));
	return { ref: `${tag}:${blob}`, records, skipped };
}

/**
 * Compare every blob the tag holds or its records name with its latest `put` record: size and mtime, then sha256
 * when the record holds one. A blob whose last record is a `remove` and whose bytes are gone is not reported.
 */
export async function storeCliVerify(
	context: StoreCliContext,
	tag: string,
	options: { pattern?: string; hashLarge?: boolean; recordUnrecorded?: boolean; signal?: AbortSignal } = {},
): Promise<StoreVerifyResult> {
	const backend = await open(context);
	return verifyStoreTag(backend, tag, {
		...options,
		actor: context.actor,
		...(context.hashMaxBytes !== undefined ? { hashMaxBytes: context.hashMaxBytes } : {}),
		command: context.command,
	});
}

function defaultProvenance(context: StoreCliContext, input: StoreCliPutInput): StorePutRecordFields {
	const { stored } = input;
	const hashed = stored.bytes <= (context.hashMaxBytes ?? Number.POSITIVE_INFINITY);
	const relative = path.relative(path.resolve(context.cwd), input.sourceAbs);
	const inside = relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
	return {
		identity: {
			bytes: stored.bytes,
			modifiedMs: stored.modifiedMs,
			...(hashed ? { sha256: stored.sha256 } : { sha256: null, hashOmitted: "too-large" as const }),
		},
		...(inside ? { source: { path: relative.split(path.sep).join("/") } } : {}),
		...(input.note !== undefined ? { note: input.note } : {}),
	};
}

export async function storeCliPut(
	context: StoreCliContext,
	tag: string,
	file: string,
	options: { blob?: string; note?: string; link?: boolean; signal?: AbortSignal } = {},
) {
	const sourceAbs = path.resolve(context.cwd, file);
	const blob = options.blob ?? path.basename(sourceAbs);
	const problem = validateBlobName(blob);
	if (problem !== null) throw new StoreCliUsageError(problem);
	const backend = await open(context);
	const { created } = await backend.getOrCreateTag(tag, { class: STORE_PUT_TAG_CLASS });
	if (created) {
		await backend.setTagXattr(tag, "pancode.description", "");
		await backend.setTagXattr(tag, "pancode.class", STORE_PUT_TAG_CLASS);
		await backend.setTagXattr(tag, "pancode.createdAt", new Date().toISOString());
	}
	const facts = await backend.facts();
	// The store tool's put and rm take the same lock, so a put and its record are never split by another writer.
	const result = await recordedPut(backend, {
		tag,
		blob,
		source: sourceAbs,
		actor: context.actor,
		...(options.link === true ? { mode: "link" as const } : {}),
		...(options.signal !== undefined ? { signal: options.signal } : {}),
		record: (stored) => {
			const input: StoreCliPutInput = {
				backend,
				tag,
				blob,
				sourceAbs,
				stored,
				...(options.note !== undefined ? { note: options.note } : {}),
			};
			return context.provenance !== undefined ? context.provenance(input) : defaultProvenance(context, input);
		},
	});
	if (!result.recorded) {
		throw new StoreRefusal(
			"io",
			`${tag}:${blob} is stored without a record (stat shows drift unrecorded): ${result.reason}; ` +
				`${context.command} verify ${tag} --record-unrecorded records it from the stored bytes.`,
		);
	}
	return {
		...statPayload(facts, tag, blob, result.put, { put: result.record, notes: [], removed: false }),
		createdTag: created,
		replaced: result.replaced,
		source: { path: sourceAbs },
		...(options.link === true ? { link: result.put.link } : {}),
	};
}

async function storeGet(context: StoreCliContext, tag: string, blob: string, to?: string) {
	const backend = await open(context);
	const got = await backend.getBlobAsPath(tag, blob);
	if (to === undefined) return { ref: `${tag}:${blob}`, path: got.path, copied: got.copied };
	const target = path.resolve(context.cwd, to);
	try {
		await copyFile(got.path, target, fsConstants.COPYFILE_EXCL);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new StoreRefusal("exists", `${target} already exists; choose another --to path.`);
		}
		throw error;
	}
	return { ref: `${tag}:${blob}`, path: target, copied: true };
}

/** Removes one blob and records the removal, as the store tool's remove does; without yes it only reports. */
async function storeRemoveBlob(context: StoreCliContext, tag: string, blob: string, yes: boolean) {
	const backend = await open(context);
	const info = await backend.statBlob(tag, blob);
	if (info === null) throw new StoreRefusal("not-found", `${tag}:${blob} is not in the store.`);
	if (yes) {
		const removed = await recordedRemove(backend, { tag, blob, actor: context.actor });
		if (!removed.recorded) {
			throw new StoreRefusal("io", `${tag}:${blob} is deleted but its removal is not recorded: ${removed.reason}`);
		}
	}
	return { ref: `${tag}:${blob}`, bytes: info.bytes, deleted: yes };
}

export async function storeCliRemoveTag(context: StoreCliContext, tag: string, yes: boolean) {
	const backend = await open(context);
	const hasTag = await backend.tagExists(tag);
	const hasRecords = await backend.tagExists(recordsTag(tag));
	if (!hasTag && !hasRecords) throw new StoreRefusal("not-found", `The store has no tag named ${tag}.`);
	const totals = hasTag ? await tagTotals(backend, tag) : { blobs: 0, bytes: 0 };
	if (yes) {
		await backend.delTag(recordsTag(tag));
		await backend.delTag(tag);
	}
	return { tag, ...totals, records: hasRecords, deleted: yes };
}

interface StoreDirInfo {
	key: string;
	dir: string;
	root: string | null;
	/** The project id its `project.json` names; such a directory is not keyed by its root path. */
	projectId: string | null;
}

async function storeProjectDirs(storeRoot: string): Promise<StoreDirInfo[]> {
	const projects = path.join(storeRoot, "projects");
	let keys: string[];
	try {
		keys = await readdir(projects);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const out: StoreDirInfo[] = [];
	for (const key of keys.sort()) {
		const dir = path.join(projects, key);
		let root: string | null = null;
		let projectId: string | null = null;
		try {
			const parsed = JSON.parse(await readFile(path.join(dir, "project.json"), "utf8")) as {
				root?: unknown;
				projectId?: unknown;
			};
			if (typeof parsed.root === "string") root = parsed.root;
			if (typeof parsed.projectId === "string") projectId = parsed.projectId;
		} catch {
			// No readable project.json: the directory's project is unknown, so it is not offered for adoption.
		}
		out.push({ key, dir, root, projectId });
	}
	return out;
}

async function exists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * Bare: store directories on the primary root whose recorded project root is gone. With a key: move that store
 * to this project.
 */
export async function storeCliAdopt(context: StoreCliContext, key?: string) {
	const root = context.projectRoot;
	const storeRoot = primaryRoot(context);
	const currentKey = context.projectKey;
	const target = storeProjectDir(storeRoot, currentKey);
	if (key === undefined) {
		const orphans = [];
		for (const entry of await storeProjectDirs(storeRoot)) {
			// A directory keyed by a project id is not orphaned when the root it was first written from is gone.
			if (entry.key === currentKey || entry.root === null || entry.projectId !== null) continue;
			if (!(await exists(entry.root))) orphans.push({ key: entry.key, root: entry.root, dir: entry.dir });
		}
		return { adopted: false as const, project: { key: currentKey, root }, orphans };
	}
	if (!/^[0-9a-f]{16}$/u.test(key)) {
		throw new StoreCliUsageError(`'${key}' is not a store project key (16 hex digits)`);
	}
	if (key === currentKey) throw new StoreRefusal("exists", `${key} is already this project's store.`);
	const source = path.join(storeRoot, "projects", key);
	const entry = (await storeProjectDirs(storeRoot)).find((candidate) => candidate.key === key);
	if (entry === undefined) throw new StoreRefusal("not-found", `No store directory for key ${key} under ${storeRoot}.`);
	if (await exists(target)) {
		throw new StoreRefusal(
			"exists",
			`This project already has a store at ${target}; adopting ${key} would overwrite it. Remove or move it first.`,
		);
	}
	await rename(source, target);
	// The moved store now belongs to this root; without the rewrite it would be offered for adoption again.
	await safeResourceWriteAsync(
		path.join(target, "project.json"),
		`${JSON.stringify({
			v: 1,
			root,
			...(context.projectId !== undefined ? { projectId: context.projectId } : {}),
			createdAt: new Date().toISOString(),
			adoptedFrom: { key, root: entry.root },
		})}\n`,
		{ mode: 0o600 },
	);
	return {
		adopted: true as const,
		from: { key, root: entry.root, dir: source },
		to: { key: currentKey, root, dir: target },
	};
}

function shellWord(word: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** The `panstore` command line that reaches the store `context` names, from any directory. */
export function panstoreInvocation(context: StoreCliContext): string {
	const words = ["panstore"];
	context.roots.forEach((root, index) => {
		words.push("--root", storeRootOption(root, index === 0));
	});
	words.push("--cache", context.cacheDir, "--project", context.projectRoot);
	if (context.projectId !== undefined) words.push("--project-id", context.projectId);
	return words.map(shellWord).join(" ");
}

/**
 * Where the store is. It reads each root's id and never creates one. With a project id, `previousKey` is the
 * path key when its directory still exists on the primary: that store is moved only by `adopt`.
 */
export async function storeCliWhere(context: StoreCliContext) {
	const storeRoot = primaryRoot(context);
	const roots = [];
	for (const root of context.roots)
		roots.push({ name: root.name, path: root.path, id: await readStoreRootId(root.path) });
	const pathKey = storeProjectKey(context.projectRoot);
	const previousKey =
		context.projectId !== undefined &&
		pathKey !== context.projectKey &&
		(await exists(storeProjectDir(storeRoot, pathKey)))
			? pathKey
			: null;
	return {
		storeRoot,
		projectRoot: context.projectRoot,
		projectId: context.projectId ?? null,
		projectKey: context.projectKey,
		projectDir: storeProjectDir(storeRoot, context.projectKey),
		...(previousKey !== null ? { previousKey } : {}),
		roots,
		panstore: panstoreInvocation(context),
	};
}

function lockView(lock: StoreLockInfo) {
	return { id: lock.id, key: lock.key, pid: lock.pid, host: lock.host, at: lock.at, state: lock.state };
}

interface ParsedArgs {
	positional: string[];
	json: boolean;
	yes: boolean;
	hashLarge: boolean;
	recordUnrecorded: boolean;
	link: boolean;
	values: Map<string, string>;
}

const VALUE_FLAGS = new Set(["--blob", "--note", "--to"]);
const BOOL_FLAGS = new Set(["--json", "--yes", "--hash-large", "--record-unrecorded", "--link"]);

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
	const parsed: ParsedArgs = {
		positional: [],
		json: false,
		yes: false,
		hashLarge: false,
		recordUnrecorded: false,
		link: false,
		values: new Map(),
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (VALUE_FLAGS.has(arg)) {
			const value = argv[i + 1];
			if (value === undefined) throw new StoreCliUsageError(`${arg} needs a value`);
			parsed.values.set(arg.slice(2), value);
			i++;
		} else if (BOOL_FLAGS.has(arg)) {
			if (arg === "--json") parsed.json = true;
			else if (arg === "--yes") parsed.yes = true;
			else if (arg === "--record-unrecorded") parsed.recordUnrecorded = true;
			else if (arg === "--link") parsed.link = true;
			else parsed.hashLarge = true;
		} else if (arg.startsWith("-") && arg.length > 1) {
			throw new StoreCliUsageError(`unknown flag: ${arg}`);
		} else {
			parsed.positional.push(arg);
		}
	}
	return parsed;
}

function modifiedLabel(iso: string | null): string {
	return iso === null ? "-" : iso.replace("T", " ").replace(/\.\d+Z$/u, "Z");
}

/** Who wrote a record, as `history` and `stat` print it: the actor and, when recorded, the extension or MCP client. */
function producerLabel(producer: StoreRecordProducer): string {
	const detail = producer.extensionId ?? producer.client;
	return detail !== undefined ? `${producer.actor} (${detail})` : producer.actor;
}

function recordLine(record: StoreRecord): string {
	const parts = [String(record.seq).padStart(4), record.at, record.kind, `by ${producerLabel(record.producedBy)}`];
	if (record.identity !== undefined) {
		parts.push(
			bytesLabel(record.identity.bytes),
			record.identity.sha256 ?? `sha256 omitted (${record.identity.hashOmitted ?? "none"})`,
		);
	}
	if (record.generatedBy !== undefined) parts.push(`run ${record.generatedBy.runId}`);
	if (record.source !== undefined) parts.push(`from ${record.source.path}`);
	// A note record's kind already says note; its text follows without a second label.
	if (record.note !== undefined) parts.push(record.kind === "note" ? record.note : `note: ${record.note}`);
	return parts.join("  ");
}

async function askOnTerminal(question: string): Promise<boolean> {
	if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) return false;
	const reader = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return /^y(?:es)?$/iu.test((await reader.question(`${question} [y/N] `)).trim());
	} finally {
		reader.close();
	}
}

function confirmed(context: StoreCliContext, question: string): Promise<boolean> {
	return (context.confirm ?? askOnTerminal)(question);
}

export interface StoreCliOutput {
	code: number;
	data: unknown;
	text: string;
}

/** One verb's exit code and output, from argv that starts at the verb. Usage mistakes throw `StoreCliUsageError`. */
export async function storeCliResult(
	argv: ReadonlyArray<string>,
	context: StoreCliContext,
	signal: AbortSignal = new AbortController().signal,
): Promise<StoreCliOutput> {
	const args = parseArgs(argv);
	return execute(args.positional[0] ?? "", args, context, signal);
}

async function execute(
	sub: string,
	args: ParsedArgs,
	context: StoreCliContext,
	signal: AbortSignal,
): Promise<StoreCliOutput> {
	const [first, second] = args.positional.slice(1);
	switch (sub) {
		case "tags": {
			const data = await storeCliTags(context);
			const rows = data.tags.map((t) => [
				t.tag,
				t.class ?? "-",
				String(t.blobs),
				bytesLabel(t.bytes),
				t.description ?? "",
			]);
			const free = data.backend.freeBytes === null ? "unknown" : bytesLabel(data.backend.freeBytes);
			const text = [
				data.tags.length === 0
					? "No tags in this project's store."
					: formatColumns([["TAG", "CLASS", "BLOBS", "BYTES", "DESCRIPTION"], ...rows]),
				`backend: ${data.backend.kind} (${data.backend.mapping}); tiers ${data.backend.tiers === false ? "none" : "yes"}; multi-node ${data.backend.multiNode}; durable ${data.backend.durable}; conditional put ${data.backend.conditionalPut}; blob versions ${data.backend.blobVersions}; free ${free}`,
			].join("\n");
			return { code: 0, data, text };
		}
		case "ls": {
			const data = await storeList(context, checkTagArg(first), second);
			const rows = data.blobs.map((b) => [
				b.blob,
				b.bytes === null ? "-" : bytesLabel(b.bytes),
				modifiedLabel(b.modified),
				b.recorded === null ? "unknown" : b.recorded ? "yes" : "no",
			]);
			const text =
				data.blobs.length === 0
					? `No blobs in ${data.tag}.`
					: formatColumns([["BLOB", "BYTES", "MODIFIED", "RECORDED"], ...rows]);
			return { code: 0, data, text };
		}
		case "stat": {
			const { tag, blob } = parseRef(first);
			const data = await storeStat(context, tag, blob);
			const lines = [
				`ref       ${data.ref}`,
				`path      ${data.path ?? "-"}`,
				`bytes     ${data.bytes ?? "-"}`,
				`modified  ${modifiedLabel(data.modified)}`,
				`drift     ${data.drift}`,
				`sha256    ${data.identity?.sha256 ?? (data.identity?.hashOmitted ? `omitted (${data.identity.hashOmitted})` : "-")}`,
				`generated ${typeof data.generatedBy === "string" ? data.generatedBy : `run ${data.generatedBy.runId} (${data.generatedBy.script.path}, ${data.generatedBy.outcome})`}`,
				...(data.producedBy !== null ? [`put by    ${producerLabel(data.producedBy)}`] : []),
				...data.used.map((u) => `used      ${u.tag !== undefined ? `${u.tag}:${u.blob}` : (u.path ?? "?")}`),
				...data.notes.map((n) => `note      ${n.at} ${n.note ?? ""}`.trimEnd()),
				`backend   ${data.backend.kind}`,
			];
			return { code: 0, data, text: lines.join("\n") };
		}
		case "history": {
			const { tag, blob } = parseRef(first);
			const data = await storeHistory(context, tag, blob);
			const lines = data.records.length === 0 ? [`No records for ${data.ref}.`] : data.records.map(recordLine);
			if (data.skipped > 0) lines.push(`${data.skipped} unreadable record(s) skipped`);
			return { code: 0, data, text: lines.join("\n") };
		}
		case "verify": {
			const data = await storeCliVerify(context, checkTagArg(first), {
				...(second !== undefined ? { pattern: second } : {}),
				hashLarge: args.hashLarge,
				recordUnrecorded: args.recordUnrecorded,
				signal,
			});
			const lines = (["ok", "changed", "missing", "unrecorded"] as const).map((status) => {
				const names = data.blobs.filter((b) => b.status === status).map((b) => b.blob);
				return `${status.padEnd(10)} ${data.counts[status]}${status !== "ok" && names.length > 0 ? `  ${names.join(", ")}` : ""}`;
			});
			for (const b of data.blobs) {
				if (b.recordedHash !== undefined) lines.push(`hashed     ${b.blob} sha256 ${b.recordedHash}`);
				if (b.recovered !== undefined) lines.push(`recorded   ${b.blob} from its stored bytes (record ${b.recovered})`);
			}
			if (data.interrupted) lines.push("interrupted: blobs after the last one listed were not checked");
			const allOk = !data.interrupted && data.blobs.every((b) => b.status === "ok" || b.recovered !== undefined);
			return { code: allOk ? 0 : 1, data, text: lines.join("\n") };
		}
		case "put": {
			const tag = checkTagArg(first);
			if (second === undefined) throw new StoreCliUsageError("missing <file>");
			const blobName = args.values.get("blob");
			const note = args.values.get("note");
			const data = await storeCliPut(context, tag, second, {
				...(blobName !== undefined ? { blob: blobName } : {}),
				...(note !== undefined ? { note } : {}),
				...(args.link ? { link: true } : {}),
				signal,
			});
			const verb = data.replaced ? "replaced" : "stored";
			const how = data.link !== undefined ? ` (${data.link})` : "";
			return {
				code: 0,
				data,
				text: `${verb} ${data.ref} (${bytesLabel(data.bytes ?? 0)}) from ${data.source.path}${how}`,
			};
		}
		case "get": {
			const { tag, blob } = parseRef(first);
			const data = await storeGet(context, tag, blob, args.values.get("to"));
			return { code: 0, data, text: data.path };
		}
		case "rm": {
			const { tag, blob } = parseRef(first);
			const yes = args.yes || (await confirmed(context, `Delete ${tag}:${blob} from the store?`));
			const data = await storeRemoveBlob(context, tag, blob, yes);
			const what = `${data.ref} (${bytesLabel(data.bytes)})`;
			if (!data.deleted) return { code: 0, data, text: `Would delete ${what}. Nothing deleted; rerun with --yes.` };
			return { code: 0, data, text: `Deleted ${what}; its records remain.` };
		}
		case "rm-tag": {
			const tag = checkTagArg(first);
			const yes = args.yes || (await confirmed(context, `Delete tag ${tag} and every blob in it?`));
			const data = await storeCliRemoveTag(context, tag, yes);
			const what = `tag ${data.tag}: ${data.blobs} blob(s), ${bytesLabel(data.bytes)}${data.records ? ", and its records" : ""}`;
			if (!data.deleted) return { code: 0, data, text: `Would delete ${what}. Nothing deleted; rerun with --yes.` };
			return { code: 0, data, text: `Deleted ${what}.` };
		}
		case "adopt": {
			const data = await storeCliAdopt(context, first);
			if (!data.adopted) {
				const lines =
					data.orphans.length === 0
						? ["No store directory has a missing project root."]
						: [
								"Store directories whose project root no longer exists:",
								formatColumns([["KEY", "OLD ROOT"], ...data.orphans.map((o) => [o.key, o.root])]),
								`Adopt one into ${data.project.root} with: ${context.command} adopt <key>`,
							];
				return { code: 0, data, text: lines.join("\n") };
			}
			const text = [
				`from ${data.from.key}  ${data.from.root ?? "(unknown root)"}`,
				`to   ${data.to.key}  ${data.to.root}`,
				`Moved ${data.from.dir} to ${data.to.dir}.`,
			].join("\n");
			return { code: 0, data, text };
		}
		case "usage": {
			const tag = first === undefined ? undefined : checkTagArg(first);
			const data = await (await open(context)).usage(tag);
			const rows = data.tags.map((t) => [t.tag, t.root, String(t.blobs), bytesLabel(t.bytes)]);
			const lines = [
				data.tags.length === 0
					? "No tags in this project's store."
					: formatColumns([["TAG", "ROOT", "BLOBS", "BYTES"], ...rows]),
				...data.roots.map(
					(r) =>
						`root ${r.name}: ${r.tags} tag(s), ${r.blobs} blob(s), ${bytesLabel(r.bytes)}; file system free space ${
							r.freeBytes === null ? "unknown" : bytesLabel(r.freeBytes)
						}`,
				),
			];
			return { code: 0, data, text: lines.join("\n") };
		}
		case "locks": {
			const projectDir = storeProjectDir(primaryRoot(context), context.projectKey);
			if (first === undefined) {
				const locks = (await listStoreLocks(projectDir)).map(lockView);
				const text =
					locks.length === 0
						? "No store locks in this project."
						: formatColumns([
								["ID", "STATE", "KEY", "PID", "HOST", "SINCE"],
								...locks.map((l) => [l.id, l.state, l.key ?? "-", String(l.pid ?? "-"), l.host ?? "-", l.at ?? "-"]),
							]);
				return { code: 0, data: { locks }, text };
			}
			if (first !== "break") throw new StoreCliUsageError(`unknown locks command '${first}'`);
			if (second === undefined) throw new StoreCliUsageError("locks break needs a lock id");
			const found = await readStoreLock(projectDir, second);
			if (found === null) throw new StoreRefusal("not-found", `No store lock ${second} in this project.`);
			if (found.state === "live") await breakStoreLock(projectDir, second);
			const what = `lock ${found.id} (${found.state}): ${
				found.state === "unreadable"
					? "its file cannot be read"
					: `${found.key}, pid ${found.pid} on ${found.host} since ${found.at}`
			}`;
			const yes = args.yes || (await confirmed(context, `Remove ${what}?`));
			if (!yes) {
				const data = { ...lockView(found), broken: false };
				return { code: 0, data, text: `Would remove ${what}. Nothing removed; rerun with --yes.` };
			}
			const data = { ...lockView(await breakStoreLock(projectDir, second)), broken: true };
			return { code: 0, data, text: `Removed ${what}.` };
		}
		case "where": {
			const data = await storeCliWhere(context);
			const text = [
				`store root   ${data.storeRoot}`,
				`project root ${data.projectRoot}`,
				`project id   ${data.projectId ?? "(none)"}`,
				`project key  ${data.projectKey}`,
				`project dir  ${data.projectDir}`,
				...data.roots.map((root) => `root ${root.name}  ${root.path}  id ${root.id ?? "(none yet)"}`),
				`panstore     ${data.panstore}`,
				...(data.previousKey !== undefined
					? [
							`previous key ${data.previousKey}`,
							`The store under the path key ${data.previousKey} stays where it is; move it to this project id with: ${context.command} adopt ${data.previousKey}`,
						]
					: []),
			].join("\n");
			return { code: 0, data, text };
		}
		default:
			if (sub === "") throw new StoreCliUsageError("name a subcommand");
			throw new StoreCliUsageError(`unknown store command '${sub}'`);
	}
}

export interface StoreCliStreams {
	stdout: { write(text: string): unknown };
	stderr: { write(text: string): unknown };
}

/**
 * Run one command line, from argv that starts at the verb, and return its exit code: 0 success, 1 an operational
 * failure or a verify that is not ok, 2 a usage mistake, 130 interrupted. A failure prints one diagnostic on stderr,
 * plus a pointer at the help for a usage mistake; with `--json` stdout also gets a failure document.
 */
export async function runStoreCli(
	argv: ReadonlyArray<string>,
	context: StoreCliContext,
	streams: StoreCliStreams = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		streams.stdout.write(storeCliHelp(context.command));
		return 0;
	}
	if (argv.length === 0) {
		// The bare group is a usage error: its help goes to stderr with the same exit 2.
		streams.stderr.write(storeCliHelp(context.command));
		return 2;
	}
	const json = argv.includes("--json");
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.once("SIGINT", interrupt);
	try {
		const result = await storeCliResult(argv, context, controller.signal);
		streams.stdout.write(json ? `${JSON.stringify(result.data, null, 2)}\n` : `${result.text}\n`);
		return controller.signal.aborted ? 130 : result.code;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const usage = error instanceof StoreCliUsageError;
		const sub = argv.find((arg) => !arg.startsWith("-"));
		const name = sub !== undefined && VERBS.includes(sub) ? `${context.command} ${sub}` : context.command;
		const slug = message.startsWith("unknown flag")
			? "unknown_flag"
			: message.startsWith("unknown store command")
				? "unknown_command"
				: usage
					? "usage"
					: "io";
		streams.stderr.write(usage ? `${name}: ${message}\nsee: ${name} --help\n` : `${name}: ${message}\n`);
		if (json) {
			const reason = error instanceof StoreRefusal ? { reason: error.reason } : {};
			const document = { version: 1, ok: false, message, ...reason, error: { code: slug, message } };
			streams.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
		}
		return usage ? 2 : 1;
	} finally {
		process.removeListener("SIGINT", interrupt);
	}
}
