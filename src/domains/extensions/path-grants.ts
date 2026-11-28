// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { lstatSync, mkdirSync, rmdirSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionPathGrant } from "@pancode/sdk/extension";
import type { ExtensionCliPathDeclaration } from "@pancode/sdk/pack";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { repositoryRoot } from "../../core/project-root.js";
import { workspaceTrustDirectory } from "../../core/workspace-trust.js";
import { pancodeConfigDir, resolvePancodeDirs } from "../../core/xdg.js";

/**
 * A path the operator granted one `pancode <verb>` invocation, with its physical form: the sandbox binds and the
 * Node permission flags name both, and a run place or home is checked against the physical one.
 */
export interface ResolvedPathGrant extends ExtensionPathGrant {
	canonical: string;
	/** A read path that exists; an absent one is granted to the Node flags only, so the command sees it missing. */
	exists: boolean;
}

export class PathGrantError extends Error {
	readonly flag: string;
	readonly value: string;
	constructor(flag: string, value: string, reason: string) {
		super(reason);
		this.flag = flag;
		this.value = value;
	}
}

/**
 * The paths the operator named for the verb's declared path flags: each `--flag <value>` before `--`, resolved against
 * the workspace. Only the operator's command line grants a path; a flag given twice grants both values and the command
 * refuses the repeat itself. No grant reaches the filesystem root, the home directory itself or a PanCode-managed
 * directory (config, data, state, cache, workspace trust), in either direction; a write root also never reaches the
 * workspace's or its repository's `.pancode`, and must be a directory, created when absent (see `createWriteRoots`).
 */
export function resolvePathGrants(
	declared: ReadonlyArray<ExtensionCliPathDeclaration>,
	argv: ReadonlyArray<string>,
	workspace: string,
): ResolvedPathGrant[] {
	const access = new Map(declared.map((entry) => [entry.flag, entry.access]));
	const grants: ResolvedPathGrant[] = [];
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i] as string;
		if (flag === "--") break;
		const kind = access.get(flag);
		const value = argv[i + 1];
		if (kind === undefined || value === undefined || value.trim().length === 0) continue;
		i++;
		grants.push(checkedGrant(flag, value, kind, workspace));
	}
	return grants;
}

function checkedGrant(flag: string, value: string, access: "read" | "write", workspace: string): ResolvedPathGrant {
	const resolved = path.resolve(workspace, value);
	const canonical = canonicalizeExistingPath(resolved);
	const refuse = (reason: string): never => {
		throw new PathGrantError(flag, value, reason);
	};
	if (canonical === path.parse(canonical).root) refuse("cannot grant the filesystem root");
	if (canonical === canonicalizeExistingPath(homedir())) refuse("cannot grant the home directory itself");
	const managed = managedDirectories(workspace, access);
	const hit = managed.find((dir) => isSameOrDescendant(canonical, dir) || isSameOrDescendant(dir, canonical));
	if (hit !== undefined) refuse(`overlaps PanCode-managed path ${hit}`);
	let stat: Stats | undefined;
	try {
		stat = statSync(canonical, { throwIfNoEntry: false });
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error));
	}
	if (access === "write" && stat !== undefined && !stat.isDirectory()) refuse("is not a directory");
	return { flag, access, path: resolved, canonical, exists: stat !== undefined };
}

function managedDirectories(workspace: string, access: "read" | "write"): string[] {
	const dirs = resolvePancodeDirs();
	const managed = [pancodeConfigDir(), dirs.data, dirs.state, dirs.cache, workspaceTrustDirectory()];
	if (access === "write") {
		managed.push(path.join(workspace, ".pancode"));
		const repository = repositoryRoot(workspace);
		if (repository !== null) managed.push(path.join(repository, ".pancode"));
	}
	return managed.map((entry) => canonicalizeExistingPath(path.resolve(entry)));
}

/**
 * Create the absent write roots one component at a time from the nearest existing ancestor, refusing a component
 * that is not a plain directory, so the sandbox binds exactly the root. Returns the directories it created, for
 * `releaseCreatedRoots`; on a refusal the ones already created are removed again.
 */
export function createWriteRoots(grants: ReadonlyArray<ResolvedPathGrant>): string[] {
	const created: string[] = [];
	try {
		for (const grant of grants) {
			if (grant.access !== "write" || grant.exists) continue;
			const missing: string[] = [];
			let existing = grant.canonical;
			while (statSync(existing, { throwIfNoEntry: false }) === undefined) {
				missing.unshift(path.basename(existing));
				existing = path.dirname(existing);
			}
			let current = existing;
			for (const segment of missing) {
				current = path.join(current, segment);
				try {
					mkdirSync(current, { mode: 0o755 });
					created.push(current);
				} catch (error) {
					// An entry that appeared meanwhile is checked below like any other.
					if ((error as NodeJS.ErrnoException).code !== "EEXIST")
						throw new PathGrantError(grant.flag, grant.path, error instanceof Error ? error.message : String(error));
				}
				if (!lstatSync(current).isDirectory())
					throw new PathGrantError(grant.flag, grant.path, `passes through ${current}, which is not a plain directory`);
			}
		}
	} catch (error) {
		releaseCreatedRoots(created);
		throw error;
	}
	return created;
}

/** Remove the write roots `createWriteRoots` made that are still empty, deepest first; content is never removed. */
export function releaseCreatedRoots(created: ReadonlyArray<string>): void {
	for (const directory of [...created].reverse()) {
		try {
			rmdirSync(directory);
		} catch {
			/* Not empty, already gone, or replaced: leave it. */
		}
	}
}
