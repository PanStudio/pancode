// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { statfsSync, statSync } from "node:fs";
import path from "node:path";
import {
	STORE_DEFAULT_ROOT_NAME,
	type StoreHostSettings,
	storeBackendKind,
	storePlacement,
	storeRoot,
	storeRootSpecs,
	storeS3Settings,
} from "../core/store-paths.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import { openAuthStorage } from "../domains/providers/auth/index.js";
import { STORE_S3_CREDENTIAL_ID } from "../domains/store/backends/s3.js";
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

/** An s3 store's bucket and whether its secret key is stored; the bucket itself is not contacted. */
function s3StoreFinding(): DoctorFinding {
	const bucket = storeS3Settings();
	if (bucket === null) return { ok: false, name: "store backend", detail: "s3 with no store.s3 bucket set" };
	const where = `s3 ${bucket.endpoint} bucket ${bucket.bucket}${bucket.prefix === "" ? "" : ` prefix ${bucket.prefix}`}`;
	return openAuthStorage().get(STORE_S3_CREDENTIAL_ID)?.type === "api_key"
		? { ok: true, name: "store backend", detail: `${where}; secret key for ${bucket.accessKeyId} stored` }
		: {
				ok: false,
				name: "store backend",
				detail: `${where}; no secret key stored for ${bucket.accessKeyId}; run pancode store login`,
			};
}

/** A shared store's folder: present and its free space, or missing on this host. */
function sharedStoreFinding(root: StoreRoot): DoctorFinding {
	if (statSync(root.path, { throwIfNoEntry: false })?.isDirectory() !== true)
		return {
			ok: false,
			name: "store backend",
			detail: `shared folder ${root.path} is missing or not a directory; mount it on this host`,
		};
	const stats = statfsSync(root.path);
	return {
		ok: true,
		name: "store backend",
		detail: `shared folder ${root.path} (${formatBytes(Number(stats.bavail) * Number(stats.bsize))} free)`,
	};
}

/**
 * The store section: each root and its free space, then tags placed on a root no longer configured; for a
 * shared store, its folder; for an s3 store, its bucket and credential.
 */
export function storeFindings(cwd: string = process.cwd()): DoctorFinding[] {
	let roots: StoreRoot[];
	try {
		if (storeBackendKind() === "s3") return [s3StoreFinding()];
		roots = storeRootSpecs();
		if (storeBackendKind() === "shared") return [sharedStoreFinding(roots[0] as StoreRoot)];
	} catch (error) {
		return [{ ok: false, name: "store root", detail: error instanceof Error ? error.message : String(error) }];
	}
	const configured = roots.length > 1 || roots[0]?.name !== STORE_DEFAULT_ROOT_NAME || roots[0]?.path !== storeRoot();
	const findings = roots.map((root, index) => storeRootFinding(root, configured, index === 0));
	const orphaned = orphanedPlacementFinding(cwd, roots);
	return orphaned === null ? findings : [...findings, orphaned];
}
