// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";

/**
 * Declared write boundaries: the repository paths a fleet step may change. A step that may run a command can write
 * anywhere that command reaches, so PanCode settles the claim after the step by diffing the workspace
 * (`src/domains/dispatch/write-boundary.ts`). An entry is repository-relative and POSIX-separated: `docs/` covers that
 * subtree, `src/a.ts` exactly that file. An absolute path, a `..` or `.` segment, a backslash or a glob character is
 * refused at parse time rather than interpreted, because an allowlist that means something other than it says is
 * worse than none.
 */

/** A boundary is a statement an operator has to read; a step needing more of the tree declares `workspace`. */
export const PATH_BOUNDARY_MAX_ENTRIES = 32;

/** A normalized allowlist. Empty means the step changes nothing (`readonly`). */
export type PathBoundary = ReadonlyArray<string>;

type PathBoundaryErrorCode = "empty" | "separator" | "glob" | "absolute" | "parent" | "dot";

export class PathBoundaryError extends Error {
	readonly code: PathBoundaryErrorCode;

	constructor(code: PathBoundaryErrorCode, message: string) {
		super(message);
		this.name = "PathBoundaryError";
		this.code = code;
	}
}

const GLOB_CHARACTERS = /[*?[\]{}]/u;

/** Normalize one repository-relative boundary entry. */
export function normalizePathBoundaryEntry(entry: string): string {
	const raw = entry.trim();
	if (raw.length === 0) throw new PathBoundaryError("empty", "write boundary: entry must be a non-empty path");
	if (raw.includes("\\")) {
		throw new PathBoundaryError("separator", `write boundary: entry '${entry}' must use '/' separators`);
	}
	if (GLOB_CHARACTERS.test(raw)) {
		throw new PathBoundaryError("glob", `write boundary: entry '${entry}' looks like a glob, which v1 does not support`);
	}
	if (raw.startsWith("/") || /^[A-Za-z]:/u.test(raw)) {
		throw new PathBoundaryError("absolute", `write boundary: entry '${entry}' must be repository-relative, not absolute`);
	}
	const subtree = raw.endsWith("/");
	const segments = raw.split("/").filter((segment) => segment.length > 0);
	if (segments.length === 0) {
		throw new PathBoundaryError("empty", `write boundary: entry '${entry}' must name a path inside the repository`);
	}
	for (const segment of segments) {
		if (segment === "..") {
			throw new PathBoundaryError("parent", `write boundary: entry '${entry}' must not contain '..'`);
		}
		if (segment === ".") {
			throw new PathBoundaryError("dot", `write boundary: entry '${entry}' must not contain '.' segments`);
		}
	}
	const joined = segments.join("/");
	return subtree ? `${joined}/` : joined;
}

/** Normalize, deduplicate, and sort a boundary declaration. */
export function normalizePathBoundary(entries: ReadonlyArray<string>): string[] {
	if (entries.length > PATH_BOUNDARY_MAX_ENTRIES) {
		throw new Error(`write boundary: at most ${PATH_BOUNDARY_MAX_ENTRIES} entries may be declared`);
	}
	return [...new Set(entries.map(normalizePathBoundaryEntry))].sort();
}

/** Operator-facing rendering, used verbatim in violation messages. */
export function describePathBoundary(boundary: PathBoundary): string {
	return boundary.length === 0 ? "(nothing: readonly)" : boundary.join(", ");
}

function toPosixBoundaryPath(value: string): string {
	return value.split("\\").join("/");
}

function isDirectoryPathBoundary(entry: string): boolean {
	return toPosixBoundaryPath(entry).endsWith("/");
}

/** Convert a path to the subtree form spoken by the boundary grammar. */
export function asDirectoryPathBoundary(entry: string): string {
	const normalized = toPosixBoundaryPath(entry);
	return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

/** Resolve a repository-relative boundary while retaining exact or subtree meaning. */
export function resolvePathBoundary(cwd: string, entry: string): string {
	const directory = isDirectoryPathBoundary(entry);
	const withoutMarker = directory ? entry.slice(0, -1) : entry;
	const resolved = toPosixBoundaryPath(path.resolve(cwd, withoutMarker));
	return directory ? asDirectoryPathBoundary(resolved) : resolved;
}

/** Whether one boundary entry contains another exact path or subtree. */
export function pathBoundaryEntryCovers(outer: string, inner: string): boolean {
	const normalizedOuter = toPosixBoundaryPath(outer);
	const normalizedInner = toPosixBoundaryPath(inner);
	return normalizedOuter.endsWith("/")
		? normalizedInner.startsWith(normalizedOuter)
		: !normalizedInner.endsWith("/") && normalizedInner === normalizedOuter;
}

/** Whether any entry in a boundary contains the candidate. */
export function pathBoundaryCovers(boundary: PathBoundary, candidate: string): boolean {
	return boundary.some((entry) => pathBoundaryEntryCovers(entry, candidate));
}

/**
 * Whether any write root contains the candidate. A write root names a directory
 * whether or not it carries the trailing slash, so an entry without one covers
 * both itself (an exact file root still admits that file) and its subtree. The
 * generic boundary grammar keeps exact-file meaning; write roots never did, and
 * three of the four resolvers already treated them as directories (D2).
 */
export function writeRootsCover(roots: PathBoundary, candidate: string): boolean {
	return roots.some(
		(root) =>
			pathBoundaryEntryCovers(root, candidate) || pathBoundaryEntryCovers(asDirectoryPathBoundary(root), candidate),
	);
}

/** Whether two boundary declarations share any possible path. */
export function pathBoundariesOverlap(left: PathBoundary, right: PathBoundary): boolean {
	return left.some((entry) =>
		right.some((other) => pathBoundaryEntryCovers(entry, other) || pathBoundaryEntryCovers(other, entry)),
	);
}
