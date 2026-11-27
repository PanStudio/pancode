// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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

const s3Listings = new Map<string, { store: WorkspaceStore; retryAt: number }>();

function s3ListingKey(cwd: string): string {
	const s3 = storeS3Settings();
	return `${s3?.endpoint ?? ""}\0${s3?.bucket ?? ""}\0${s3?.prefix ?? ""}\0${storeProjectKeyFor(storeProjectRoot(cwd))}`;
}

export function invalidateS3TagList(cwd: string): void {
	s3Listings.delete(s3ListingKey(cwd));
}

/** Keep a successful listing until this process changes the project's tags. A turn never waits for S3. */
function s3WorkspaceStore(cwd: string): WorkspaceStore {
	const key = s3ListingKey(cwd);
	const entry = s3Listings.get(key) ?? { store: NO_STORE, retryAt: 0 };
	if (performance.now() < entry.retryAt) return entry.store;
	entry.retryAt = Number.POSITIVE_INFINITY;
	s3Listings.set(key, entry);
	void import("./backends/s3.js")
		.then(async ({ createS3StoreBackend }) => {
			const tags = (await createS3StoreBackend(cwd).listTags()).filter(
				(tag) => !isRecordsTag(tag) && validateTagName(tag) === null,
			);
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
	if (storeBackendKind() === "s3") return s3WorkspaceStore(cwd);
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
