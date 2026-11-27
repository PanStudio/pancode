// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The store backend both multi-host kinds share: every change is one transition of the fenced log the medium
 * keeps. A tag's blobs are a manifest page, a blob's records a history page, the project's tags a table page;
 * payloads and pages are immutable and a change writes new ones before it proposes the root that names them.
 * Locks are leases in the log's root: a change made under one is refused once the lease was taken over.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { StoreBackend } from "../backend/backend.js";
import {
	compileBlobPattern,
	type StoreBackendFacts,
	type StoreBackendKind,
	type StoreBlobPut,
	type StoreLockInfo,
	type StorePutMode,
	StoreRefusal,
	type StoreUsage,
} from "../backend/types.js";
import { writeCacheCopy } from "../cache-copy.js";
import { storeLockId } from "../lock.js";
import {
	decodeTagSegment,
	encodeTagSegment,
	isRecordsTag,
	recordsTag,
	STORE_DEFAULT_ROOT_NAME,
	storeCacheDir,
	validateBlobName,
	validateTagName,
} from "../paths/index.js";
import { storeBlobLockKey } from "../recorded.js";
import { currentState, type StoreRecord, type StoreRecordBody } from "../records.js";
import { type LogCommitPlan, LogMachine, type LogMedium, type LogTip, randomId, serialized } from "./machine.js";
import type {
	LogBlobEntry,
	LogDecision,
	LogHistoryPage,
	LogLease,
	LogManifestPage,
	LogProjectBinding,
	LogRoot,
	LogTablePage,
	LogTagEntry,
	StoreLog,
} from "./types.js";

export interface LogStoreOptions {
	kind: StoreBackendKind;
	/** Where the project's store lives, as an operator names it. */
	location: string;
	/** The log's own name: one per log, the same for every backend of it in this process. */
	logName: string;
	medium: LogMedium;
	cacheDir: string;
	projectKey: string;
	projectId?: string;
	projectRoot: string;
	facts(): Promise<StoreBackendFacts>;
	/** Refuse a source this kind cannot store, by its size. */
	checkSource?(source: string, bytes: number): void;
}

const LEASE_RENEW_MS = 10 * 1000;
const LOCK_WAIT_MS = 30 * 1000;
const LOCK_POLL_MS = 500;
const XATTR_KEY_MAX_BYTES = 255;
const XATTR_VALUE_MAX_BYTES = 64 * 1024;
const RECORD_MAX_BYTES = 64 * 1024;
const RECORD_NAME = /^(.+)#(\d{8})$/u;

interface HeldLease {
	machine: LogMachine;
	lease: string;
	key: string;
	epoch: number;
	controller: AbortController;
	lost: boolean;
}

/** The leases held by the writer running in this async context, outermost first. */
const heldLeases = new AsyncLocalStorage<HeldLease[]>();

interface ProjectView {
	binding: LogProjectBinding | null;
	table: LogTablePage;
}

const EMPTY_TABLE: LogTablePage = { v: 1, tags: {} };
const EMPTY_MANIFEST: LogManifestPage = { v: 1, blobs: {} };

function checkTag(tag: string): void {
	const problem = validateTagName(tag, { allowRecords: true });
	if (problem !== null) throw new StoreRefusal("invalid-name", problem);
}

function checkBlob(tag: string, blob: string): void {
	const record = isRecordsTag(tag) ? RECORD_NAME.exec(blob) : null;
	const problem = validateBlobName(record?.[1] ?? blob);
	if (problem !== null) throw new StoreRefusal("invalid-name", problem);
}

function checkLockId(id: string): void {
	if (!/^[0-9a-f]{32}$/u.test(id))
		throw new StoreRefusal("invalid-name", `'${id}' is not a lock id: it is 32 hex characters.`);
}

/** A lock key as a message shows it: `blob<NUL>tag<NUL>name` reads as `blob tag name`. */
function keyText(key: string): string {
	return key.replaceAll("\0", " ");
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof StoreRefusal) throw error;
		throw new StoreRefusal("io", messageOf(error));
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function relativePathEscapes(relative: string): boolean {
	return (
		relative === ".." || relative.startsWith("../") || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
	);
}

function lostRefusal(key: string): StoreRefusal {
	return new StoreRefusal(
		"io",
		`The store lock for ${key} was lost while it was held (it was taken over or broken); the change it guarded was not made.`,
	);
}

/** The base tag a records tag names, or null for a plain tag. */
function baseOfRecords(tag: string): string | null {
	return isRecordsTag(tag) ? tag.slice(0, tag.length - recordsTag("").length) : null;
}

function recordName(blob: string, seq: number): string {
	return `${blob}#${String(seq).padStart(8, "0")}`;
}

function liveBlobs(manifest: LogManifestPage): string[] {
	return Object.keys(manifest.blobs)
		.filter((name) => manifest.blobs[name]?.payload !== null)
		.sort();
}

/** A blob cannot nest under another blob, nor take the name other blobs are stored under. */
function refuseNameConflict(manifest: LogManifestPage, tag: string, blob: string): void {
	const segments = blob.split("/");
	for (let index = 1; index < segments.length; index++) {
		const prefix = segments.slice(0, index).join("/");
		if ((manifest.blobs[prefix]?.payload ?? null) !== null)
			throw new StoreRefusal(
				"exists",
				`Refusing blob ${blob} in tag ${tag}: it would nest under the existing blob ${prefix}.`,
			);
	}
	const inside = liveBlobs(manifest).find((name) => name.startsWith(`${blob}/`));
	if (inside !== undefined)
		throw new StoreRefusal(
			"exists",
			`Refusing blob ${blob} in tag ${tag}: existing blobs are stored under that name (for example ${inside}).`,
		);
}

/** Cache path segments for a blob: S3-era names can have components longer than NAME_MAX; '#' cannot start one. */
function cacheSegments(tag: string, blob: string): string[] {
	return [encodeTagSegment(tag), ...blob.split("/")].flatMap((name) => {
		const parts: string[] = [];
		while (name.length > 255) {
			parts.push(`#${name.slice(0, 128)}`);
			name = name.slice(128);
		}
		return [...parts, name];
	});
}

export function createLogStoreBackend(options: LogStoreOptions): StoreBackend & { log: StoreLog } {
	const machine = new LogMachine(options.logName, options.medium);
	const medium = options.medium;
	const project = options.projectKey;
	const leaseOf = (key: string) => `${project}:${storeLockId(key)}`;

	function heldHere(): HeldLease[] {
		return (heldLeases.getStore() ?? []).filter((held) => held.machine === machine);
	}

	/** The leases a change is made under, refused when one is already known lost or is gone from the tip. */
	function heldPlan(tip: LogTip): LogCommitPlan["held"] {
		const plan: LogCommitPlan["held"] = [];
		for (const held of heldHere()) {
			const lease = tip.root.leases[held.lease];
			if (held.lost || lease === undefined || lease.epoch !== held.epoch || lease.owner.token !== machine.owner.token) {
				markLost(held);
				throw lostRefusal(held.key);
			}
			plan.push({ lease: held.lease, epoch: held.epoch });
		}
		return plan;
	}

	function markLost(held: HeldLease): void {
		if (held.lost) return;
		held.lost = true;
		held.controller.abort();
	}

	/** `signal`, also aborted when a lease this writer holds is lost. */
	function fencedSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
		const signals = [...(signal !== undefined ? [signal] : []), ...heldHere().map((held) => held.controller.signal)];
		return signals.length === 0 ? undefined : AbortSignal.any(signals);
	}

	function rejection(decision: LogDecision): StoreRefusal {
		if (decision.reason === "lost") {
			for (const held of heldHere()) markLost(held);
			return lostRefusal(heldHere()[0]?.key ?? "this change");
		}
		return new StoreRefusal("io", `The store's log refused the change (${decision.reason ?? "unknown"}).`);
	}

	async function view(root: LogRoot): Promise<ProjectView> {
		const binding = root.projects[project] ?? null;
		const table = binding?.table != null ? await machine.page<LogTablePage>(binding.table, "table") : EMPTY_TABLE;
		return { binding, table };
	}

	async function currentView(): Promise<ProjectView> {
		return view((await machine.tip()).root);
	}

	function manifestOf(entry: LogTagEntry): Promise<LogManifestPage> {
		return entry.manifest === null
			? Promise.resolve(EMPTY_MANIFEST)
			: machine.page<LogManifestPage>(entry.manifest, "manifest");
	}

	async function historyOf(entry: LogBlobEntry | undefined): Promise<StoreRecord[]> {
		if (entry?.history == null) return [];
		return (await machine.page<LogHistoryPage>(entry.history, "history")).records;
	}

	function liveTag(table: LogTablePage, tag: string): LogTagEntry | null {
		const entry = table.tags[tag];
		return entry !== undefined && entry.removed !== true ? entry : null;
	}

	function requireLive(table: LogTablePage, tag: string): LogTagEntry {
		const entry = liveTag(table, tag);
		if (entry === null) throw new StoreRefusal("not-found", `The store has no tag named ${tag}.`);
		return entry;
	}

	async function withManifest(entry: LogTagEntry, manifest: LogManifestPage): Promise<LogTagEntry> {
		return { ...entry, manifest: Object.keys(manifest.blobs).length === 0 ? null : await machine.writePage(manifest) };
	}

	/**
	 * Commit one change to this project's tags: `edit` returns the new table built against the tip it is given,
	 * or null when nothing changes. Made under every lease this writer holds.
	 */
	async function change(edit: (current: ProjectView) => Promise<LogTablePage | null>): Promise<void> {
		const decision = await machine.commit(async (tip) => {
			const held = heldPlan(tip);
			const current = await view(tip.root);
			const table = await edit(current);
			if (table === null) return null;
			const tableId = Object.keys(table.tags).length === 0 ? null : await machine.writePage(table);
			const binding: LogProjectBinding = current.binding
				? { ...current.binding, table: tableId }
				: {
						incarnation: randomId(),
						table: tableId,
						root: options.projectRoot,
						...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
						createdAt: new Date().toISOString(),
					};
			return { ops: [{ op: "project", key: project, binding }], held };
		});
		if (decision !== null && !decision.accepted) throw rejection(decision);
	}

	function tableWith(table: LogTablePage, tag: string, entry: LogTagEntry | null): LogTablePage {
		const tags = { ...table.tags };
		if (entry === null) delete tags[tag];
		else tags[tag] = entry;
		return { v: 1, tags };
	}

	function holderRefusal(key: string, lease: LogLease): StoreRefusal {
		return new StoreRefusal(
			"unavailable",
			`The store lock for ${keyText(key)} is held by pid ${lease.owner.pid} on ${lease.owner.host} since ${lease.at} and was still renewed after ${LOCK_WAIT_MS / 1000} s of waiting; try again once it is released.`,
		);
	}

	/** Take the lease for `key`, waiting while another writer renews it; answers the epoch granted. */
	async function acquire(lease: string, key: string): Promise<number> {
		const started = performance.now();
		for (;;) {
			const tip = await machine.tip();
			const current = tip.root.leases[lease];
			let waiting = current !== undefined && current.owner.token !== machine.owner.token;
			if (waiting && current !== undefined) waiting = (await machine.witness()).lo < current.deadline;
			if (!waiting) {
				const decision = await machine.commit(async () => ({
					ops: [{ op: "acquire", lease, project, key }],
					held: [],
				}));
				if (decision?.accepted) return decision.slot;
				if (decision?.reason !== "held") throw new StoreRefusal("io", `The store's log refused the lock for ${key}.`);
			}
			if (performance.now() - started > LOCK_WAIT_MS) {
				const holder = (await machine.tip()).root.leases[lease];
				if (holder !== undefined) throw holderRefusal(key, holder);
			}
			await delay(LOCK_POLL_MS);
		}
	}

	async function renew(held: HeldLease): Promise<void> {
		if (held.lost) return;
		const decision = await machine.commit(async (tip) => {
			const lease = tip.root.leases[held.lease];
			if (lease === undefined || lease.epoch !== held.epoch || lease.owner.token !== machine.owner.token) {
				markLost(held);
				return null;
			}
			return { ops: [], held: [{ lease: held.lease, epoch: held.epoch }] };
		});
		if (decision !== null && !decision.accepted) markLost(held);
	}

	async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const lease = leaseOf(key);
		const outer = heldLeases.getStore() ?? [];
		if (outer.some((held) => held.machine === machine && held.lease === lease)) return fn();
		// One writer per lease in this process; others wait here rather than polling the log.
		return serialized(`${options.logName}\0${machine.owner.token}\0${lease}`, async () => {
			const epoch = await acquire(lease, key);
			const held: HeldLease = { machine, lease, key, epoch, controller: new AbortController(), lost: false };
			let renewing: Promise<void> = Promise.resolve();
			const timer = setInterval(() => {
				// A renewal that cannot reach the store is tried again; the lease lapses only by the store's clock.
				renewing = renewing.then(() => renew(held)).catch(() => undefined);
			}, LEASE_RENEW_MS);
			timer.unref();
			try {
				return await heldLeases.run([...outer, held], fn);
			} catch (error) {
				if (held.lost) throw lostRefusal(key);
				throw error;
			} finally {
				clearInterval(timer);
				await renewing;
				if (!held.lost)
					await machine
						.commit(async (tip) => {
							const current = tip.root.leases[lease];
							if (current === undefined || current.epoch !== held.epoch || current.owner.token !== machine.owner.token)
								return null;
							return { ops: [{ op: "release", lease, epoch: held.epoch }], held: [] };
						})
						.catch(() => undefined);
			}
		});
	}

	/** Run fn under the blob's lock unless this writer already holds it. */
	function blobLocked<T>(tag: string, blob: string, fn: () => Promise<T>): Promise<T> {
		return withLock(storeBlobLockKey(tag, blob), fn);
	}

	async function sourceSize(source: string): Promise<number> {
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(source);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new StoreRefusal("not-found", `No file at ${source}.`);
			throw error;
		}
		if (!info.isFile()) throw new StoreRefusal("not-a-file", `${source} is not a regular file.`);
		options.checkSource?.(source, info.size);
		return info.size;
	}

	interface Admitted {
		incarnation: string;
		tag: string;
		payload: string | null;
	}

	/** What a change to `tag:blob` was admitted against: the project, the tag's incarnation and the blob's bytes. */
	async function admit(tag: string, blob: string): Promise<Admitted & { manifest: LogManifestPage }> {
		const current = await currentView();
		const entry = requireLive(current.table, tag);
		const manifest = await manifestOf(entry);
		return {
			incarnation: current.binding?.incarnation ?? "",
			tag: entry.incarnation,
			payload: manifest.blobs[blob]?.payload ?? null,
			manifest,
		};
	}

	/** The tag and blob as they are at the tip, refused unless they are still what the change was admitted against. */
	async function readmit(
		current: ProjectView,
		admitted: Admitted,
		tag: string,
		blob: string,
	): Promise<{ entry: LogTagEntry; manifest: LogManifestPage; blobEntry: LogBlobEntry | undefined }> {
		const entry = liveTag(current.table, tag);
		if (current.binding?.incarnation !== admitted.incarnation)
			throw new StoreRefusal("not-found", `This project's store was moved or recreated while ${tag}:${blob} was changed.`);
		if (entry === null || entry.incarnation !== admitted.tag)
			throw new StoreRefusal("not-found", `Tag ${tag} was deleted or recreated while ${tag}:${blob} was changed.`);
		const manifest = await manifestOf(entry);
		const blobEntry = manifest.blobs[blob];
		if ((blobEntry?.payload ?? null) !== admitted.payload)
			throw new StoreRefusal("exists", `${tag}:${blob} changed before this change committed; inspect it before retrying.`);
		return { entry, manifest, blobEntry };
	}

	/** Stage the source's bytes, then publish them, with a record from `record` when given. */
	async function publishPut(
		tag: string,
		blob: string,
		source: string,
		putOptions: { mode?: StorePutMode; ifAbsent?: boolean; signal?: AbortSignal },
		record?: (stored: StoreBlobPut) => Promise<StoreRecordBody>,
	): Promise<{ put: StoreBlobPut; replaced: boolean; record: StoreRecord | null }> {
		checkTag(tag);
		checkBlob(tag, blob);
		if (isRecordsTag(tag))
			throw new StoreRefusal("invalid-name", `${tag} is a records tag; blobs are put in ${baseOfRecords(tag)}.`);
		const admitted = await admit(tag, blob);
		const replaced = admitted.payload !== null;
		if (replaced && putOptions.ifAbsent)
			throw new StoreRefusal("exists", `${tag}:${blob} exists; submit the put again to have the replacement admitted.`);
		await sourceSize(source);
		refuseNameConflict(admitted.manifest, tag, blob);
		const aborted = () => new StoreRefusal("io", `The put of ${blob} into ${tag} was aborted.`);
		if (putOptions.signal?.aborted) throw aborted();
		const fenced = fencedSignal(putOptions.signal);
		let staged: Awaited<ReturnType<LogMedium["stagePayload"]>>;
		try {
			staged = await medium.stagePayload(source, {
				...(fenced !== undefined ? { signal: fenced } : {}),
				...(putOptions.mode !== undefined ? { mode: putOptions.mode } : {}),
			});
		} catch (error) {
			if (putOptions.signal?.aborted) throw aborted();
			const lost = heldHere().find((held) => held.lost);
			if (lost !== undefined) throw lostRefusal(lost.key);
			throw error;
		}
		const put: StoreBlobPut = {
			bytes: staged.bytes,
			modifiedMs: Date.now(),
			version: null,
			sha256: staged.sha256,
			link: staged.link,
			key: medium.payloadKey(staged.id),
		};
		const body = record === undefined ? null : await record(put);
		let written: StoreRecord | null = null;
		await change(async (current) => {
			const { entry, manifest, blobEntry } = await readmit(current, admitted, tag, blob);
			refuseNameConflict(manifest, tag, blob);
			let history = blobEntry?.history ?? null;
			let seq = blobEntry?.seq ?? 0;
			if (body !== null) {
				const records = await historyOf(blobEntry);
				written = { v: 1, ...body, seq: records.length + 1, at: new Date().toISOString() };
				if (Buffer.byteLength(JSON.stringify(written)) > RECORD_MAX_BYTES)
					throw new StoreRefusal("io", `A record for ${tag}/${blob} exceeds ${RECORD_MAX_BYTES} bytes.`);
				history = await machine.writePage({ v: 1, records: [...records, written] } satisfies LogHistoryPage);
				seq = written.seq;
			}
			const blobs = {
				...manifest.blobs,
				[blob]: { payload: staged.id, bytes: put.bytes, modifiedMs: put.modifiedMs, sha256: put.sha256, history, seq },
			};
			return tableWith(current.table, tag, await withManifest(entry, { v: 1, blobs }));
		});
		return { put, replaced, record: written };
	}

	/** Remove the blob's bytes, keeping its records, with a remove record from `body` when given. */
	async function publishRemove(
		tag: string,
		blob: string,
		body?: (lastPut: StoreRecord | null) => StoreRecordBody,
	): Promise<{ removed: boolean; record: StoreRecord | null }> {
		checkTag(tag);
		checkBlob(tag, blob);
		const admitted = await admit(tag, blob);
		if (admitted.payload === null) return { removed: false, record: null };
		let written: StoreRecord | null = null;
		await change(async (current) => {
			const { entry, manifest, blobEntry } = await readmit(current, admitted, tag, blob);
			const blobs = { ...manifest.blobs };
			let history = blobEntry?.history ?? null;
			let seq = blobEntry?.seq ?? 0;
			if (body !== undefined) {
				const records = await historyOf(blobEntry);
				written = { v: 1, ...body(currentState(records).put), seq: records.length + 1, at: new Date().toISOString() };
				history = await machine.writePage({ v: 1, records: [...records, written] } satisfies LogHistoryPage);
				seq = written.seq;
			}
			if (seq === 0) delete blobs[blob];
			else blobs[blob] = { payload: null, bytes: 0, modifiedMs: 0, sha256: null, history, seq };
			return tableWith(current.table, tag, await withManifest(entry, { v: 1, blobs }));
		});
		return { removed: true, record: written };
	}

	function lockInfo(id: string, lease: LogLease, lo: number): StoreLockInfo {
		return {
			id,
			file: options.location,
			state: lo < lease.deadline ? "live" : "dead",
			key: lease.key,
			pid: lease.owner.pid,
			host: lease.owner.host,
			at: lease.at,
		};
	}

	async function projectLeases(): Promise<Array<{ id: string; name: string; lease: LogLease }>> {
		const tip = await machine.tip();
		const prefix = `${project}:`;
		return Object.entries(tip.root.leases)
			.filter(([name]) => name.startsWith(prefix))
			.map(([name, lease]) => ({ id: name.slice(prefix.length), name, lease }))
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	}

	async function tagList(): Promise<string[]> {
		const { table } = await currentView();
		const tags: string[] = [];
		for (const [tag, entry] of Object.entries(table.tags)) {
			if (entry.removed !== true) tags.push(tag);
			const manifest = await manifestOf(entry);
			if (Object.values(manifest.blobs).some((blob) => blob.seq > 0)) tags.push(recordsTag(tag));
		}
		return tags.sort();
	}

	/** The history of `base:blob` for a records tag lookup, or null when the tag or blob has none. */
	async function recordsFor(base: string, blob: string): Promise<StoreRecord[] | null> {
		const { table } = await currentView();
		const entry = table.tags[base];
		if (entry === undefined) return null;
		const blobEntry = (await manifestOf(entry)).blobs[blob];
		return blobEntry === undefined || blobEntry.seq === 0 ? null : historyOf(blobEntry);
	}

	async function reachable(root: LogRoot): Promise<{ pages: Set<string>; payloads: Set<string> }> {
		const pages = new Set<string>();
		const payloads = new Set<string>();
		for (const binding of Object.values(root.projects)) {
			if (binding.table === null) continue;
			pages.add(binding.table);
			const table = await machine.page<LogTablePage>(binding.table, "table");
			for (const entry of Object.values(table.tags)) {
				if (entry.manifest === null) continue;
				pages.add(entry.manifest);
				for (const blob of Object.values((await manifestOf(entry)).blobs)) {
					if (blob.history !== null) pages.add(blob.history);
					if (blob.payload !== null) payloads.add(blob.payload);
				}
			}
		}
		return { pages, payloads };
	}

	const log: StoreLog = {
		recordedPut: (put) =>
			guarded(() =>
				blobLocked(put.tag, put.blob, async () => {
					const result = await publishPut(
						put.tag,
						put.blob,
						put.source,
						{
							...(put.mode !== undefined ? { mode: put.mode } : {}),
							...(put.ifAbsent ? { ifAbsent: true } : {}),
							...(put.signal !== undefined ? { signal: put.signal } : {}),
						},
						put.record,
					);
					return { put: result.put, replaced: result.replaced, record: result.record as StoreRecord };
				}),
			),

		recordedRemove: (remove) =>
			guarded(() =>
				blobLocked(remove.tag, remove.blob, async () => {
					const result = await publishRemove(remove.tag, remove.blob, remove.body);
					if (!result.removed) throw new StoreRefusal("not-found", `${remove.tag}:${remove.blob} is not in the store.`);
					return result.record as StoreRecord;
				}),
			),

		projectIncarnation: () => guarded(async () => (await currentView()).binding?.incarnation ?? null),

		projects: () =>
			guarded(async () =>
				Object.entries((await machine.tip()).root.projects)
					.map(([key, binding]) => ({ key, root: binding.root, projectId: binding.projectId ?? null }))
					.sort((a, b) => (a.key < b.key ? -1 : 1)),
			),

		adopt: (fromKey) =>
			guarded(async () => {
				let from: LogProjectBinding | undefined;
				const decision = await machine.commit(async (tip) => {
					from = tip.root.projects[fromKey];
					if (from === undefined)
						throw new StoreRefusal("not-found", `No store is bound to key ${fromKey} in ${options.location}.`);
					if (tip.root.projects[project] !== undefined)
						throw new StoreRefusal(
							"exists",
							`This project already has a store under key ${project}; adopting ${fromKey} would overwrite it.`,
						);
					const binding: LogProjectBinding = {
						...from,
						incarnation: randomId(),
						root: options.projectRoot,
						createdAt: new Date().toISOString(),
						adoptedFrom: { key: fromKey, root: from.root },
					};
					if (options.projectId !== undefined) binding.projectId = options.projectId;
					else delete binding.projectId;
					// The old key's leases go with it; a live one refuses the whole move.
					const breaks = Object.entries(tip.root.leases)
						.filter(([, lease]) => lease.project === fromKey)
						.map(([name, lease]) => ({ op: "break" as const, lease: name, epoch: lease.epoch }));
					return {
						ops: [...breaks, { op: "project", key: project, binding }, { op: "project", key: fromKey, binding: null }],
						held: [],
					};
				});
				if (decision?.reason === "live")
					throw new StoreRefusal(
						"unavailable",
						`A writer holds a lock in the store under ${fromKey}; adopt it once it is done.`,
					);
				if (decision === null || !decision.accepted || from === undefined)
					throw new StoreRefusal("io", "The store's log refused the adoption.");
				return { from: { key: fromKey, root: from.root }, to: { key: project, root: options.projectRoot } };
			}),

		reclaim: (apply) =>
			guarded(async () => {
				const tip = await machine.tip();
				const leases = Object.entries(tip.root.leases);
				if (leases.length > 0) {
					const [name, lease] = leases[0] as [string, LogLease];
					const id = name.slice(lease.project.length + 1);
					throw new StoreRefusal(
						"unavailable",
						`${leases.length} store lock(s) are held; reclaim runs only when none is. Lock ${id} of project ${lease.project} is held by pid ${lease.owner.pid} on ${lease.owner.host} for ${keyText(lease.key)} since ${lease.at}; once that writer is gone, break it with pancode store locks break ${id} --yes from that project, or adopt that project's store if its checkout is gone.`,
					);
				}
				const { pages, payloads } = await reachable(tip.root);
				const garbage: Array<{ kind: "page" | "payload"; id: string; bytes: number }> = [];
				// Anything written since the tip was decided may belong to a change still being built.
				for await (const item of medium.listStored()) {
					if (!Number.isFinite(item.modifiedMs) || item.modifiedMs >= tip.decidedAt) continue;
					if (item.kind === "page" ? pages.has(item.id) : payloads.has(item.id)) continue;
					garbage.push(item);
				}
				if (apply) for (const item of garbage) await medium.deleteStored(item.kind, item.id);
				return {
					pages: garbage.filter((item) => item.kind === "page").length,
					payloads: garbage.filter((item) => item.kind === "payload").length,
					bytes: garbage.reduce((sum, item) => sum + item.bytes, 0),
					deleted: apply,
				};
			}),
	};

	const backend: StoreBackend & { log: StoreLog } = {
		kind: options.kind,
		location: options.location,
		log,

		facts: () => guarded(() => options.facts()),

		withLock: (key, fn) => withLock(key, fn),

		listLocks: () =>
			guarded(async () => {
				const leases = await projectLeases();
				if (leases.length === 0) return [];
				const { lo } = await machine.witness();
				return leases.map(({ id, lease }) => lockInfo(id, lease, lo));
			}),

		readLock: (id) =>
			guarded(async () => {
				checkLockId(id);
				const found = (await projectLeases()).find((entry) => entry.id === id);
				if (found === undefined) return null;
				return lockInfo(id, found.lease, (await machine.witness()).lo);
			}),

		breakLock: (id) =>
			guarded(async () => {
				checkLockId(id);
				const found = (await projectLeases()).find((entry) => entry.id === id);
				if (found === undefined) throw new StoreRefusal("not-found", `No store lock ${id} in this project.`);
				let target = found.lease;
				const decision = await machine.commit(async (tip) => {
					const current = tip.root.leases[found.name];
					if (current === undefined) throw new StoreRefusal("not-found", `No store lock ${id} in this project.`);
					target = current;
					return {
						ops: [{ op: "break", lease: found.name, epoch: current.epoch }],
						held: [],
					};
				});
				if (decision !== null && !decision.accepted)
					throw new StoreRefusal(
						"unavailable",
						`Store lock ${id} is held by pid ${target.owner.pid} on ${target.owner.host} with a live lease; it is not broken while its writer runs.`,
					);
				return lockInfo(id, target, decision?.witness.lo ?? target.deadline);
			}),

		usage: (tag) =>
			guarded(async (): Promise<StoreUsage> => {
				const { table } = await currentView();
				const names =
					tag === undefined
						? Object.keys(table.tags)
								.filter((name) => liveTag(table, name) !== null)
								.sort()
						: [tag];
				const tags: Array<{ tag: string; root: string; blobs: number; bytes: number }> = [];
				for (const name of names) {
					checkTag(name);
					const manifest = await manifestOf(requireLive(table, name));
					const live = liveBlobs(manifest);
					const bytes = live.reduce((sum, blob) => sum + (manifest.blobs[blob]?.bytes ?? 0), 0);
					tags.push({ tag: name, root: STORE_DEFAULT_ROOT_NAME, blobs: live.length, bytes });
				}
				return {
					tags,
					roots: [
						{
							name: STORE_DEFAULT_ROOT_NAME,
							tags: tags.length,
							blobs: tags.reduce((sum, entry) => sum + entry.blobs, 0),
							bytes: tags.reduce((sum, entry) => sum + entry.bytes, 0),
							freeBytes: (await options.facts()).freeBytes,
						},
					],
				};
			}),

		getOrCreateTag: (tag) =>
			guarded(async () => {
				checkTag(tag);
				const base = baseOfRecords(tag);
				if (base !== null) {
					// A records tag is the history its tag's blobs carry: it exists while its tag does.
					if ((await currentView()).table.tags[base] === undefined)
						throw new StoreRefusal("not-found", `The store has no tag named ${base}.`);
					return { created: false };
				}
				let created = false;
				await change(async (current) => {
					const entry = current.table.tags[tag];
					created = entry === undefined || entry.removed === true;
					if (!created) return null;
					return tableWith(current.table, tag, {
						incarnation: randomId(),
						xattrs: {},
						createdAt: new Date().toISOString(),
						// A tag made again over a removed one picks up the records its blobs left.
						manifest: entry?.manifest ?? null,
					});
				});
				return { created };
			}),

		tagExists: (tag) =>
			guarded(async () => {
				checkTag(tag);
				const base = baseOfRecords(tag);
				if (base === null) return liveTag((await currentView()).table, tag) !== null;
				const entry = (await currentView()).table.tags[base];
				return entry !== undefined && Object.values((await manifestOf(entry)).blobs).some((blob) => blob.seq > 0);
			}),

		listTags: () => guarded(tagList),

		delTag: (tag) =>
			guarded(async () => {
				checkTag(tag);
				const base = baseOfRecords(tag);
				await change(async (current) => {
					const entry = current.table.tags[base ?? tag];
					if (entry === undefined) return null;
					const manifest = await manifestOf(entry);
					const blobs: Record<string, LogBlobEntry> = {};
					for (const [name, blob] of Object.entries(manifest.blobs)) {
						// Deleting the records tag drops every blob's history; deleting the tag drops every blob's bytes.
						if (base !== null) {
							if (blob.payload !== null) blobs[name] = { ...blob, history: null, seq: 0 };
						} else if (blob.seq > 0) blobs[name] = { ...blob, payload: null, bytes: 0, modifiedMs: 0, sha256: null };
					}
					const removed = base !== null ? entry.removed === true : true;
					if (removed && Object.keys(blobs).length === 0) return tableWith(current.table, base ?? tag, null);
					const next = await withManifest(entry, { v: 1, blobs });
					return tableWith(current.table, base ?? tag, removed ? { ...next, xattrs: {}, removed: true } : next);
				});
			}),

		setTagXattr: (tag, key, value) =>
			guarded(async () => {
				checkTag(tag);
				if (key.length === 0 || Buffer.byteLength(key, "utf8") > XATTR_KEY_MAX_BYTES)
					throw new StoreRefusal("invalid-name", `A tag attribute key must be 1 to ${XATTR_KEY_MAX_BYTES} bytes.`);
				if (Buffer.byteLength(value, "utf8") > XATTR_VALUE_MAX_BYTES)
					throw new StoreRefusal("invalid-name", `A tag attribute value must be at most ${XATTR_VALUE_MAX_BYTES} bytes.`);
				await change(async (current) => {
					const entry = requireLive(current.table, tag);
					if (entry.xattrs[key] === value) return null;
					return tableWith(current.table, tag, { ...entry, xattrs: { ...entry.xattrs, [key]: value } });
				});
			}),

		getTagXattrs: (tag) =>
			guarded(async () => {
				checkTag(tag);
				return { ...requireLive((await currentView()).table, tag).xattrs };
			}),

		putBlobFromFile: (tag, blob, source, signal, putOptions) =>
			guarded(() =>
				blobLocked(tag, blob, async () => {
					const result = await publishPut(tag, blob, source, {
						...(putOptions?.mode !== undefined ? { mode: putOptions.mode } : {}),
						...(putOptions?.ifAbsent ? { ifAbsent: true } : {}),
						...(signal !== undefined ? { signal } : {}),
					});
					return result.put;
				}),
			),

		getBlobAsPath: (tag, blob, signal) =>
			guarded(async () => {
				checkTag(tag);
				checkBlob(tag, blob);
				const entry = liveTag((await currentView()).table, tag);
				const payload = entry === null ? null : ((await manifestOf(entry)).blobs[blob]?.payload ?? null);
				if (payload === null) throw new StoreRefusal("not-found", `Tag ${tag} has no blob named ${blob}.`);
				return writeCacheCopy(options.cacheDir, options.projectKey, cacheSegments(tag, blob), (temp) =>
					medium.readPayload(payload, temp, signal),
				);
			}),

		putRecordIfAbsent: (tag, name, data) =>
			guarded(async () => {
				checkTag(tag);
				checkBlob(tag, name);
				const base = baseOfRecords(tag);
				const parsedName = RECORD_NAME.exec(name);
				if (base === null || parsedName === null)
					throw new StoreRefusal(
						"invalid-name",
						`Records are kept only in a records tag, as <blob>#<seq>; not ${tag}:${name}.`,
					);
				if (data.byteLength > RECORD_MAX_BYTES)
					throw new StoreRefusal("invalid-name", `A record must be at most ${RECORD_MAX_BYTES} bytes.`);
				const blob = parsedName[1] as string;
				const seq = Number(parsedName[2]);
				let record: StoreRecord;
				try {
					record = JSON.parse(Buffer.from(data).toString("utf8")) as StoreRecord;
				} catch {
					throw new StoreRefusal("io", `The record ${tag}:${name} is not valid JSON.`);
				}
				if (record?.seq !== seq || record.blob !== blob || record.tag !== base)
					throw new StoreRefusal("io", `The record ${tag}:${name} does not name ${base}:${blob} at seq ${seq}.`);
				return blobLocked(base, blob, async () => {
					let outcome: "written" | "exists" = "exists";
					await change(async (current) => {
						const entry = current.table.tags[base];
						if (entry === undefined) throw new StoreRefusal("not-found", `The store has no tag named ${base}.`);
						const manifest = await manifestOf(entry);
						const blobEntry = manifest.blobs[blob];
						const records = await historyOf(blobEntry);
						if (seq <= records.length) {
							outcome = "exists";
							return null;
						}
						if (seq !== records.length + 1)
							throw new StoreRefusal(
								"io",
								`${base}:${blob} has ${records.length} record(s); record ${seq} would leave a gap.`,
							);
						outcome = "written";
						const history = await machine.writePage({ v: 1, records: [...records, record] } satisfies LogHistoryPage);
						const next: LogBlobEntry = blobEntry
							? { ...blobEntry, history, seq }
							: { payload: null, bytes: 0, modifiedMs: 0, sha256: null, history, seq };
						return tableWith(
							current.table,
							base,
							await withManifest(entry, { v: 1, blobs: { ...manifest.blobs, [blob]: next } }),
						);
					});
					return outcome;
				});
			}),

		getRecord: (tag, name) =>
			guarded(async () => {
				checkTag(tag);
				checkBlob(tag, name);
				const base = baseOfRecords(tag);
				const parsedName = RECORD_NAME.exec(name);
				if (base === null || parsedName === null) return null;
				const records = await recordsFor(base, parsedName[1] as string);
				const record = records?.[Number(parsedName[2]) - 1];
				return record === undefined ? null : new Uint8Array(Buffer.from(JSON.stringify(record), "utf8"));
			}),

		statBlob: (tag, blob) =>
			guarded(async () => {
				checkTag(tag);
				checkBlob(tag, blob);
				const base = baseOfRecords(tag);
				if (base !== null) {
					const parsedName = RECORD_NAME.exec(blob);
					const record =
						parsedName === null ? undefined : (await recordsFor(base, parsedName[1] as string))?.[Number(parsedName[2]) - 1];
					return record === undefined
						? null
						: { bytes: Buffer.byteLength(JSON.stringify(record)), modifiedMs: Date.parse(record.at), version: null };
				}
				const entry = liveTag((await currentView()).table, tag);
				const found = entry === null ? undefined : (await manifestOf(entry)).blobs[blob];
				if (found === undefined || found.payload === null) return null;
				return { bytes: found.bytes, modifiedMs: found.modifiedMs, version: null };
			}),

		listBlobs: (tag, q) =>
			guarded(async () => {
				checkTag(tag);
				const base = baseOfRecords(tag);
				const { table } = await currentView();
				let names: string[];
				if (base === null) names = liveBlobs(await manifestOf(requireLive(table, tag)));
				else {
					const entry = table.tags[base];
					if (entry === undefined) throw new StoreRefusal("not-found", `The store has no tag named ${tag}.`);
					const blobs = (await manifestOf(entry)).blobs;
					names = Object.keys(blobs)
						.flatMap((blob) => Array.from({ length: blobs[blob]?.seq ?? 0 }, (_, index) => recordName(blob, index + 1)))
						.sort();
				}
				const matcher = q.pattern !== undefined ? compileBlobPattern(q.pattern) : null;
				const prefix = q.prefix ?? "";
				const matches = names.filter((name) => name.startsWith(prefix) && (matcher === null || matcher.test(name)));
				const offset = Math.max(0, Math.floor(q.offset));
				const limit = Math.max(0, Math.floor(q.limit));
				return { names: matches.slice(offset, offset + limit), hasMore: matches.length > offset + limit };
			}),

		delBlob: (tag, blob) => guarded(() => blobLocked(tag, blob, async () => (await publishRemove(tag, blob)).removed)),

		blobRefOfPath: async (realPath) => {
			// Only a copy `get` handed out is local: <cache>/store/<projectKey>/<encoded tag>/<blob>, while its blob is stored.
			const resolved = await realpath(storeCacheDir(options.cacheDir, options.projectKey)).catch(() => null);
			if (resolved === null) return null;
			const relative = path.relative(resolved, realPath);
			if (relative === "" || relativePathEscapes(relative)) return null;
			const segments: string[] = [];
			let head = "";
			for (const part of relative.split(path.sep)) {
				if (part.startsWith("#")) head += part.slice(1);
				else {
					segments.push(head + part);
					head = "";
				}
			}
			if (head !== "") return null;
			const [encodedTag, ...rest] = segments;
			if (encodedTag === undefined || rest.length === 0) return null;
			try {
				const ref = { tag: decodeTagSegment(encodedTag), blob: rest.join("/") };
				return (await backend.statBlob(ref.tag, ref.blob)) !== null ? ref : null;
			} catch {
				// A malformed escape, a name the store refuses or an unreachable store names no blob of ours.
				return null;
			}
		},
	};
	return backend;
}
