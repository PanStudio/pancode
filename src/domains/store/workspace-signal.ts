// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StoreBackend } from "@pancode/store";
import {
	decodeTagSegment,
	isRecordsTag,
	storeBackendKind,
	storePlacement,
	storeProjectDir,
	storeProjectKeyFor,
	storeProjectRoot,
	storeRoot,
	storeRootSpecs,
	storeS3Settings,
	validateTagName,
} from "../../core/store-paths.js";
import { ToolNames } from "../../core/tool-names.js";

const tagDirs = new Map<string, string>();
interface WorkspaceStore {
	readonly signals: ReadonlyArray<string>;
	readonly tags: ReadonlyArray<string>;
}

const NO_STORE: WorkspaceStore = { signals: [], tags: [] };
const answers = new Map<string, { key: number; store: WorkspaceStore }>();

function modified(path: string): number {
	return statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? -1;
}

/**
 * The capabilities this workspace itself points at, whatever a turn's words: a
 * project whose store holds a tag keeps its data there, so store and data.
 */
export function workspaceCapabilitySignals(cwd: string): ReadonlyArray<string> {
	return workspaceStore(cwd).signals;
}

/** The project's store tags, sorted, records tags left out. */
export function workspaceStoreTags(cwd: string): ReadonlyArray<string> {
	return workspaceStore(cwd).tags;
}

const logListings = new Map<string, { store: WorkspaceStore; retryAt: number }>();

function logListingKey(cwd: string): string {
	const s3 = storeS3Settings();
	const where =
		storeBackendKind() === "s3"
			? `${s3?.endpoint ?? ""}\0${s3?.bucket ?? ""}\0${s3?.prefix ?? ""}`
			: (storeRootSpecs()[0]?.path ?? "");
	return `${storeBackendKind()}\0${where}\0${storeProjectKeyFor(storeProjectRoot(cwd))}`;
}

/** `backend` forgetting the project's tag listing whenever this process creates or deletes a tag through it. */
export function invalidatingTagList(cwd: string, backend: StoreBackend): StoreBackend {
	return {
		...backend,
		async getOrCreateTag(tag, options) {
			const result = await backend.getOrCreateTag(tag, options);
			if (result.created) logListings.delete(logListingKey(cwd));
			return result;
		},
		async delTag(tag) {
			await backend.delTag(tag);
			logListings.delete(logListingKey(cwd));
		},
	};
}

/**
 * An s3 or shared store keeps its tags in its log. Keep a successful listing until this process changes
 * the project's tags. A turn never waits for the store.
 */
function logWorkspaceStore(cwd: string): WorkspaceStore {
	const key = logListingKey(cwd);
	const entry = logListings.get(key) ?? { store: NO_STORE, retryAt: 0 };
	if (performance.now() < entry.retryAt) return entry.store;
	entry.retryAt = Number.POSITIVE_INFINITY;
	logListings.set(key, entry);
	const open =
		storeBackendKind() === "s3"
			? import("./backends/s3.js").then(({ createS3StoreBackend }) => createS3StoreBackend(cwd))
			: import("./backends/local.js").then(({ createSharedStoreBackend }) => createSharedStoreBackend(cwd));
	void open
		.then(async (backend) => {
			const tags = (await backend.listTags()).filter((tag) => !isRecordsTag(tag) && validateTagName(tag) === null);
			entry.store = tags.length > 0 ? { signals: [ToolNames.Store, ToolNames.Data], tags: tags.sort() } : NO_STORE;
		})
		.catch(() => {
			entry.retryAt = performance.now() + 30_000;
		});
	return entry.store;
}

/**
 * Runs on every turn, so the answer is kept until the project's tag list
 * changes: one stat a turn, and a directory read only then. The primary root's
 * `tags` directory is the clock for every root: the store moves its time when it
 * makes or removes a tag elsewhere, and `placement.json` names those tags.
 */
function workspaceStore(cwd: string): WorkspaceStore {
	if (storeBackendKind() !== "local") return logWorkspaceStore(cwd);
	const root = storeRootSpecs()[0]?.path ?? storeRoot();
	const project = `${root}\0${cwd}`;
	let tags = tagDirs.get(project);
	if (tags === undefined) {
		tags = join(storeProjectDir(cwd), "tags");
		tagDirs.set(project, tags);
	}
	const key = modified(tags);
	const cached = answers.get(project);
	if (cached?.key === key) return cached.store;
	const store = readStore(tags, cwd);
	answers.set(project, { key, store });
	return store;
}

function readStore(tagsDir: string, cwd: string): WorkspaceStore {
	let entries: string[];
	try {
		entries = readdirSync(tagsDir);
	} catch {
		return NO_STORE;
	}
	const elsewhere = otherRootTags(cwd);
	const onPrimary = entries
		.flatMap((segment) => {
			try {
				return [decodeTagSegment(segment)];
			} catch {
				return [];
			}
		})
		.filter((tag) => validateTagName(tag) === null);
	const tags = [...new Set([...onPrimary, ...elsewhere])].sort();
	return tags.length > 0 ? { signals: [ToolNames.Store, ToolNames.Data], tags } : NO_STORE;
}

/** Tags `placement.json` puts on a configured root other than the primary. */
function otherRootTags(cwd: string): string[] {
	const roots = storeRootSpecs();
	if (roots.length === 1) return [];
	const others = new Set(roots.slice(1).map((root) => root.name));
	return Object.entries(storePlacement(cwd).tags)
		.filter(([tag, root]) => others.has(root) && !isRecordsTag(tag) && validateTagName(tag) === null)
		.map(([tag]) => tag);
}
