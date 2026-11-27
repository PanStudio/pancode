// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * A store grant sent to a worker on another host. The dispatcher names the
 * project by its `store.projectId` key, each root by the id in its `root.json`
 * and each granted tag by its directory relative to that root; mount paths may
 * differ between hosts, so the ids decide. The receiving worker checks every
 * name against its own configuration before it starts and refuses on the first
 * mismatch, so a worker whose store is not the dispatcher's writes nothing.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { ensureStoreRootId, readStoreRootId, recordsTag, type StoreRootSpec } from "@pancode/store";
import { storeProjectIdFor, storeProjectKeyFor, storeProjectRoot, storeRootSpecs, storeTagDir } from "./store-paths.js";

export interface SharedStoreGrant {
	projectId: string;
	projectKey: string;
	roots: ReadonlyArray<{ id: string; name: string }>;
	/** `path` is the tag's directory relative to the root whose id is `rootId`. */
	tags: ReadonlyArray<{ tag: string; rootId: string; path: string }>;
}

function isUnder(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The configured root a tag directory lies under, the deepest when roots nest. */
function rootOf(roots: ReadonlyArray<StoreRootSpec>, dir: string): StoreRootSpec | undefined {
	return roots.filter((root) => isUnder(root.path, dir)).sort((a, b) => b.path.length - a.path.length)[0];
}

/**
 * The dispatcher's half: the grant's shared names for `tags` and the roots
 * they live on, the primary first. `sharedFsOf` answers the backend's facts
 * for a root; a root known to be local to this host is refused by name. Each
 * root's `root.json` is created here when it is absent.
 */
export async function prepareSharedStoreGrant(
	cwd: string,
	tags: ReadonlyArray<string>,
	sharedFsOf: (root: StoreRootSpec) => boolean | "unverified",
	nodeId: string,
): Promise<SharedStoreGrant> {
	const projectRoot = storeProjectRoot(cwd);
	const projectId = storeProjectIdFor(projectRoot);
	if (projectId === undefined)
		throw new Error(
			`dispatch: admission denied: node '${nodeId}' reaches this project's store only when the project's tracked .pancode/settings.yaml sets store.projectId`,
		);
	const roots = storeRootSpecs();
	const primary = roots[0] as StoreRootSpec;
	const placed: Array<{ tag: string; root: StoreRootSpec; dir: string }> = [];
	for (const tag of tags) {
		for (const name of [tag, recordsTag(tag)]) {
			const dir = storeTagDir(cwd, name);
			const root = rootOf(roots, dir) ?? primary;
			placed.push({ tag: name, root, dir });
		}
	}
	const used = [primary, ...roots.filter((root) => root !== primary && placed.some((entry) => entry.root === root))];
	const ids = new Map<StoreRootSpec, string>();
	for (const root of used) {
		if (sharedFsOf(root) === false)
			throw new Error(
				`dispatch: admission denied: store root '${root.name}' (${root.path}) is on a file system local to this host, so node '${nodeId}' cannot reach it; place the granted tags on a shared root or run this task on the local node`,
			);
		ids.set(root, await ensureStoreRootId(root.path));
	}
	return {
		projectId,
		projectKey: storeProjectKeyFor(projectRoot),
		roots: used.map((root) => ({ id: ids.get(root) as string, name: root.name })),
		tags: placed.map((entry) => ({
			tag: entry.tag,
			rootId: ids.get(entry.root) as string,
			path: path.relative(entry.root.path, entry.dir),
		})),
	};
}

function physical(target: string): string {
	try {
		return realpathSync(target);
	} catch {
		// A directory not made yet compares by its resolved name.
		return path.resolve(target);
	}
}

/**
 * The receiving worker's half. Answers this node's absolute tag directories
 * when every name matches, or throws one refusal naming what differed.
 */
export async function verifySharedStoreGrant(cwd: string, grant: SharedStoreGrant): Promise<string[]> {
	const projectRoot = storeProjectRoot(cwd);
	const projectKey = storeProjectKeyFor(projectRoot);
	if (projectKey !== grant.projectKey) {
		const local = storeProjectIdFor(projectRoot);
		throw new Error(
			`store grant refused: project id: this node's checkout ${projectRoot} keys the store ${projectKey} (${
				local === undefined ? "no store.projectId" : `store.projectId ${local}`
			}), the dispatcher's is ${grant.projectKey} (store.projectId ${grant.projectId})`,
		);
	}
	const roots = storeRootSpecs();
	const byId = new Map<string, StoreRootSpec>();
	for (const { id, name } of grant.roots) {
		const matches: StoreRootSpec[] = [];
		for (const root of roots) {
			let rootId: string | null;
			try {
				rootId = await readStoreRootId(root.path);
			} catch {
				// A root whose root.json cannot be read is not the root this grant names.
				rootId = null;
			}
			if (rootId === id) matches.push(root);
		}
		if (matches.length !== 1)
			throw new Error(
				`store grant refused: root ${name} id ${id} not found on this node${matches.length > 1 ? ` (${matches.length} roots carry it)` : ""}`,
			);
		byId.set(id, matches[0] as StoreRootSpec);
	}
	const dirs: string[] = [];
	for (const { tag, rootId, path: relative } of grant.tags) {
		const root = byId.get(rootId);
		const named = root === undefined ? null : path.resolve(root.path, relative);
		const own = storeTagDir(cwd, tag);
		if (root === undefined || named === null || !isUnder(root.path, named) || physical(named) !== physical(own))
			throw new Error(
				`store grant refused: tag ${tag} resolves elsewhere: the grant names ${named ?? `root id ${rootId}`}, this node's store has ${own}`,
			);
		dirs.push(`${own}/`);
	}
	return dirs;
}
