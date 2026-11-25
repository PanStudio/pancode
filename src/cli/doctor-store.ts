// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { statfsSync, statSync } from "node:fs";
import path from "node:path";
import {
	STORE_DEFAULT_ROOT_NAME,
	type StoreHostSettings,
	storePlacement,
	storeRoot,
	storeRootSpecs,
} from "../core/store-paths.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import { formatBytes } from "./lifecycle-presenter.js";

type StoreRoot = StoreHostSettings["roots"][number];

/** Free space where a store root is or would be: the nearest existing ancestor answers, and nothing is created. */
function storeRootFinding(root: StoreRoot, configured: boolean, primary: boolean): DoctorFinding {
	const name = configured ? `store root ${root.name}` : "store root";
	const facts = configured
		? [
				primary ? "primary" : null,
				root.durable ? null : "not durable",
				root.purge === null ? null : `purge: ${root.purge}`,
			]
				.filter((fact): fact is string => fact !== null)
				.map((fact) => `; ${fact}`)
				.join("")
		: "";
	// The primary is created on first write like the single root always was; any other root must already exist.
	if (configured && !primary && statSync(root.path, { throwIfNoEntry: false })?.isDirectory() !== true) {
		return {
			ok: false,
			name,
			detail: `${root.path} is missing or not a directory${facts}; tags placed there refuse until it is back`,
		};
	}
	let probe = root.path;
	for (;;) {
		try {
			const stats = statfsSync(probe);
			const free = formatBytes(Number(stats.bavail) * Number(stats.bsize));
			return {
				ok: true,
				name,
				detail:
					probe === root.path
						? `${root.path} (${free} free${facts})`
						: `${root.path} (not created yet; ${free} free at ${probe}${facts})`,
			};
		} catch {
			const parent = path.dirname(probe);
			if (parent === probe) {
				return { ok: true, level: "info", name, detail: `${root.path} (free space unknown${facts})` };
			}
			probe = parent;
		}
	}
}

/** Tags this workspace's placement map puts on a root settings no longer name. */
function orphanedPlacementFinding(cwd: string, roots: ReadonlyArray<StoreRoot>): DoctorFinding | null {
	const known = new Set(roots.map((root) => root.name));
	let tags: Readonly<Record<string, string>>;
	try {
		tags = storePlacement(cwd).tags;
	} catch {
		// No project here, or its map is unreadable; the store commands report the latter when used.
		return null;
	}
	const orphaned = Object.entries(tags).filter(([, root]) => !known.has(root));
	if (orphaned.length === 0) return null;
	const named = orphaned
		.slice(0, 5)
		.map(([tag, root]) => `${tag} (on ${root})`)
		.join(", ");
	const more = orphaned.length > 5 ? ` and ${orphaned.length - 5} more` : "";
	return {
		ok: false,
		name: "store placement",
		detail: `${named}${more} placed on a store root that is no longer configured; add the root back to store.roots to reach ${orphaned.length === 1 ? "it" : "them"}`,
	};
}

/** The store section: each root and its free space, then tags placed on a root no longer configured. */
export function storeFindings(cwd: string = process.cwd()): DoctorFinding[] {
	let roots: StoreRoot[];
	try {
		roots = storeRootSpecs();
	} catch (error) {
		return [{ ok: false, name: "store root", detail: error instanceof Error ? error.message : String(error) }];
	}
	const configured = roots.length > 1 || roots[0]?.name !== STORE_DEFAULT_ROOT_NAME || roots[0]?.path !== storeRoot();
	const findings = roots.map((root, index) => storeRootFinding(root, configured, index === 0));
	const orphaned = orphanedPlacementFinding(cwd, roots);
	return orphaned === null ? findings : [...findings, orphaned];
}
