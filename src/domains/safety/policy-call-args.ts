// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { canonicalizeExistingPath, canonicalizePath } from "../../core/path-canonical.js";
import { isSameOrDescendant } from "../../core/path-containment.js";

/**
 * Sequencing and redirection operators. These defeat per-command allowlist
 * matching but hide nothing from the rule pack, which scans the full string.
 */
export function hasSequencingOperators(command: string): boolean {
	return /(\|\||&&|;|\||>>?|<|\n|\r)/.test(command);
}

/**
 * Content-hiding constructs: `$(...)`, backticks and process substitution
 * (`<(...)`, `>(...)`) execute text the net cannot see until runtime. Kept separate from sequencing (sd-01 M5) so they
 * can ask in default while yolo passes the ordinary confirmation.
 */
export function hasCommandSubstitution(command: string): boolean {
	// `<(...)` and `>(...)` run their script exactly as `$(...)` does.
	return /(`|\$\(|[<>]\()/.test(command);
}

/** Any shell operator at all; project policy entries with `shellOperators: deny` reject both kinds. */
export function hasShellOperators(command: string): boolean {
	return hasSequencingOperators(command) || hasCommandSubstitution(command);
}

/** A path that cannot be canonicalized is under nothing. */
export function isUnderOrSame(child: string, parent: string): boolean {
	const canonicalParent = canonicalizePath(path.resolve(parent));
	const canonicalChild = canonicalizePath(path.resolve(child));
	if (canonicalParent === null || canonicalChild === null) return false;
	return isSameOrDescendant(canonicalChild, canonicalParent);
}

export function commandArg(args: Record<string, unknown> | undefined): string | null {
	return typeof args?.command === "string" ? args.command : null;
}

/** The directory a bash call names for itself; relative deletes resolve from it. */
export function bashCwdArg(args: Record<string, unknown> | undefined): string | undefined {
	return typeof args?.cwd === "string" && args.cwd.length > 0 ? args.cwd : undefined;
}

export function pathArg(args: Record<string, unknown> | undefined): string | null {
	if (!args) return null;
	const candidate = args.path ?? args.file_path ?? args.filePath;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

export function cwdArg(args: Record<string, unknown> | undefined, fallback: string): string {
	const resolved = typeof args?.cwd === "string" && args.cwd.length > 0 ? path.resolve(fallback, args.cwd) : fallback;
	return canonicalizeExistingPath(resolved);
}
