// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** A store backend kind: `local`, `shared` and `s3` ship. */
export type StoreBackendKind = string;

export type StoreTagClass = "input" | "output" | "cache" | "archive";

/** One configured root as a backend reports it. */
export interface StoreRootFacts {
	name: string;
	/** The id in the root's `root.json`, or null before anything was made there or on a backend whose roots carry none. */
	id: string | null;
	durable: boolean;
	/**
	 * false only for a file system known to be local to this host; true for a root every host reaches by
	 * configuration (an object store bucket); never guessed.
	 */
	sharedFs: boolean | "unverified";
	/** The site's purge policy as configured, or null. */
	purge: string | null;
	/** File system free space under the root as statfs reports it; not a quota and not a reservation. */
	freeBytes: number | null;
}

export interface StoreBackendFacts {
	kind: StoreBackendKind;
	/** One sentence: what a tag and a blob are on this backend. */
	mapping: string;
	/** false with one root; otherwise each root in configuration order, the primary scored highest. */
	tiers: false | ReadonlyArray<{ name: string; score: number; freeBytes: number | null }>;
	multiNode: boolean;
	durable: boolean;
	conditionalPut: "if-absent" | "if-absent-and-version";
	blobVersions: boolean;
	/** File system free space under the primary root as statfs reports it; not a quota and not a reservation. */
	freeBytes: number | null;
	roots: ReadonlyArray<StoreRootFacts>;
	/** What `put --link` does on the primary root: `reflink` where the file system clones files, else `copy`. */
	links: "reflink" | "copy";
}

/**
 * `live`: its holder may still run: on this host with its pid alive and the same boot, or, for a lease, renewed
 * within its expiry. `dead`: its holder is gone: on this host with its pid gone or another boot, or a lease not
 * renewed within its expiry. `remote`: a lock file from another host, whose holder cannot be checked.
 */
export type StoreLockState = "live" | "dead" | "remote" | "unreadable";

export interface StoreLockInfo {
	/** The lock's name: `storeLockId` of its key. */
	id: string;
	/** Where the lock lives: its file on a local root, its object on an object store. */
	file: string;
	state: StoreLockState;
	key: string | null;
	pid: number | null;
	host: string | null;
	at: string | null;
}

/** Bytes are the sizes of stored blobs; file system free space is the root's statfs answer, not a quota. */
export interface StoreUsage {
	tags: ReadonlyArray<{ tag: string; root: string; blobs: number; bytes: number }>;
	roots: ReadonlyArray<{ name: string; tags: number; blobs: number; bytes: number; freeBytes: number | null }>;
}

export interface StoreBlobStat {
	bytes: number;
	modifiedMs: number;
	version: number | null;
}

/** `copy` writes the bytes; `link` shares them with the source by a reflink where the file system can, else copies. */
export type StorePutMode = "copy" | "link";

/**
 * What one put stored, observed by the put itself: the size and sha256 of the
 * bytes it streamed and the stat of its own copy before it took the blob's
 * name, so a concurrent writer's bytes never stand in for this put's.
 */
export interface StoreBlobPut extends StoreBlobStat {
	sha256: string;
	/** How the bytes got into the store: a reflink shares the source's blocks, a copy wrote them. */
	link: "reflink" | "copy";
	/** The backend's own name for the blob: the absolute path on the local backend. */
	key: string;
}

export type StoreRefusalReason =
	| "invalid-name"
	| "not-found"
	| "exists"
	| "not-a-file"
	| "is-link"
	| "no-space"
	| "unavailable"
	| "io";

/** The one error a backend throws for an expected failure. */
export class StoreRefusal extends Error {
	readonly reason: StoreRefusalReason;

	constructor(reason: StoreRefusalReason, message: string) {
		super(message);
		this.name = "StoreRefusal";
		this.reason = reason;
	}
}

/** Longest blob-name pattern a listing accepts; patterns come from the model and the CLI. */
export const STORE_PATTERN_MAX_LENGTH = 256;

/** The quantifier starting at `i`, if any: `*`, `+`, `?` or an open-ended `{n,}` / `{n,m}`. */
function quantifierAt(pattern: string, i: number): boolean {
	const ch = pattern[i];
	if (ch === "*" || ch === "+" || ch === "?") return true;
	return ch === "{" && /^\{\d+,\d*\}/.test(pattern.slice(i));
}

/**
 * True when a quantified group contains a quantifier at any depth, such as `(a+)+`, `((a+))+` or
 * `(a(b+))*`: the shape that backtracks exponentially on a near-miss name. Escapes and character
 * classes are skipped, so `[(]a+` is not a group.
 */
function hasNestedQuantifier(pattern: string): boolean {
	const open: boolean[] = [];
	let inClass = false;
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (inClass) {
			if (ch === "]") inClass = false;
			continue;
		}
		if (ch === "[") {
			inClass = true;
		} else if (ch === "(") {
			open.push(false);
			if (pattern[i + 1] === "?") i++;
		} else if (ch === ")") {
			const inner = open.pop() ?? false;
			const quantified = quantifierAt(pattern, i + 1);
			if (inner && quantified) return true;
			if ((inner || quantified) && open.length > 0) open[open.length - 1] = true;
		} else if (quantifierAt(pattern, i) && open.length > 0) {
			open[open.length - 1] = true;
		}
	}
	return false;
}
const BACKREFERENCE = /\\(?:[1-9]|k<)/;

/**
 * Compile a blob-name pattern anchored to the whole name, refusing (`invalid-name`) one that
 * is too long, uses a backreference or nests quantifiers, so a listing cannot hang on it.
 */
export function compileBlobPattern(pattern: string): RegExp {
	if (pattern.length > STORE_PATTERN_MAX_LENGTH) {
		throw new StoreRefusal("invalid-name", `Invalid blob pattern: longer than ${STORE_PATTERN_MAX_LENGTH} characters`);
	}
	if (BACKREFERENCE.test(pattern)) {
		throw new StoreRefusal("invalid-name", "Invalid blob pattern: backreferences are not allowed");
	}
	if (hasNestedQuantifier(pattern)) {
		throw new StoreRefusal("invalid-name", "Invalid blob pattern: a quantified group may not contain another quantifier");
	}
	try {
		return new RegExp(`^(?:${pattern})$`);
	} catch (error) {
		throw new StoreRefusal(
			"invalid-name",
			`Invalid blob pattern: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
