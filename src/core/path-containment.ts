// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";

/**
 * True when a `path.relative` result leaves its base: exactly `..`, a `..`
 * segment followed by a separator, or another root. A child named `..x` stays
 * inside. Pass `path.posix` when the relative path came from `path.posix`.
 */
export function relativePathEscapes(relative: string, pathImpl: path.PlatformPath = path): boolean {
	return (
		relative === ".." ||
		relative.startsWith("../") ||
		relative.startsWith(`..${pathImpl.sep}`) ||
		pathImpl.isAbsolute(relative)
	);
}

/** Whether `candidate` is `root` or lies beneath it, compared lexically after both resolve. */
export function isSameOrDescendant(candidate: string, root: string, pathImpl: path.PlatformPath = path): boolean {
	return !relativePathEscapes(pathImpl.relative(root, candidate), pathImpl);
}

/** Whether `candidate` lies beneath `root` and is not `root` itself. */
export function isStrictDescendant(candidate: string, root: string, pathImpl: path.PlatformPath = path): boolean {
	const relative = pathImpl.relative(root, candidate);
	return relative !== "" && !relativePathEscapes(relative, pathImpl);
}

/** `candidate` relative to `root` (empty for `root` itself), or null when it lies outside. */
export function relativeWithin(candidate: string, root: string, pathImpl: path.PlatformPath = path): string | null {
	const relative = pathImpl.relative(root, candidate);
	return relativePathEscapes(relative, pathImpl) ? null : relative;
}

/**
 * {@link isSameOrDescendant} for two paths that are already resolved. A hot
 * loop testing thousands of targets pays for two `path.resolve` calls and a
 * `path.relative` per pair; a string prefix does the same job on resolved paths.
 */
export function isSameOrDescendantResolved(candidate: string, root: string): boolean {
	// path.relative compares case-insensitively on Windows; a string prefix does not.
	if (process.platform === "win32") return isSameOrDescendant(candidate, root);
	if (candidate === root) return true;
	return candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}
