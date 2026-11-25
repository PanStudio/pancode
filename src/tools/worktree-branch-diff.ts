// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { relativePathEscapes } from "../core/path-containment.js";
import type { MeasuredDiff } from "../domains/dispatch/evidence-packet.js";
import type { TaskWorktreeReceipt } from "./task-worktree.js";
import { LEFT_UNCOMMITTED_LIST_LIMIT } from "./worktree-commit.js";
import { git, gitBytes } from "./worktree-git.js";

/** The bounded account of new files a host commit left out, or undefined when it left none. */
export function leftUncommittedReport(paths: ReadonlyArray<string>): TaskWorktreeReceipt["leftUncommitted"] {
	return paths.length === 0 ? undefined : { count: paths.length, paths: paths.slice(0, LEFT_UNCOMMITTED_LIST_LIMIT) };
}

export function leftUncommittedField(paths: ReadonlyArray<string>): Pick<TaskWorktreeReceipt, "leftUncommitted"> {
	const report = leftUncommittedReport(paths);
	return report === undefined ? {} : { leftUncommitted: report };
}

export function worktreeBranchDiffStat(root: string, branch: string): string {
	try {
		return git(root, ["diff", "--shortstat", `HEAD...${branch}`]) || "no changes";
	} catch {
		return "diff unavailable";
	}
}

/** Git output a packet diff may read before the packet cuts it to its byte budget. */
const PACKET_DIFF_READ_BYTES = 8 * 1024 * 1024;

const UNTRACKED_FILE_READ_BYTES = 256 * 1024;

/** Bytes of untracked file bodies one packet diff inlines in all, about its share of the packet's diff budget. */
const UNTRACKED_INLINE_BUDGET_BYTES = 24_000;

/** A candidate branch's change against HEAD, as the judge's evidence packet carries it (M10); null when git cannot say. */
export function worktreeBranchDiff(root: string, branch: string): MeasuredDiff | null {
	try {
		const range = `HEAD...${branch}`;
		return {
			stat: git(root, ["diff", "--shortstat", range]) || "no changes",
			patch: gitBytes(root, ["diff", "--no-color", "--no-ext-diff", range], {
				maxBuffer: PACKET_DIFF_READ_BYTES,
			}).toString("utf8"),
			scope: "branch",
		};
	} catch {
		return null;
	}
}

/**
 * A builder's change as a reviewer's evidence packet carries it (M10), from the host's own record of it and never the
 * operator's whole working tree:
 * - a task worktree: its pinned commit against the base it was cut at, read from the checkout it was cut from, so a
 *   merged and removed worktree still has its diff; an uncommitted snapshot is the worktree's tree against that base;
 * - a subprocess run: the git-visible paths the host observed it change, resolved against the cwd they were read in;
 * - a native run: the paths its closed write record names, resolved against the workspace root's real path, so a
 *   builder in a subdirectory or under a symlinked home keeps its paths.
 * Null when none of these is available (an incomplete write record included) or git cannot say.
 */
export function builderChangeDiff(input: {
	cwd: string | undefined;
	worktree?: { path: string; root?: string; base?: string; commit?: string } | undefined;
	checkoutChanges?: { cwd: string; changedPaths: ReadonlyArray<string> } | undefined;
	/** The closed write record's paths, absolute or relative to the workspace root; null when the record is open. */
	recorded: ReadonlyArray<string> | null;
}): MeasuredDiff | null {
	try {
		const worktree = input.worktree;
		if (worktree !== undefined) {
			if (worktree.root === undefined || worktree.base === undefined) return null;
			if (worktree.commit !== undefined) {
				const range = `${worktree.base}..${worktree.commit}`;
				return {
					stat: git(worktree.root, ["diff", "--shortstat", range]) || "no changes",
					patch: gitBytes(worktree.root, ["diff", "--no-color", "--no-ext-diff", range], {
						maxBuffer: PACKET_DIFF_READ_BYTES,
					}).toString("utf8"),
					scope: "task-commit",
				};
			}
			if (!existsSync(worktree.path)) return null;
			return pathsDiff(realpathSync(worktree.path), null, worktree.base, "task-worktree");
		}
		if (input.checkoutChanges !== undefined) {
			const root = realpathSync(input.checkoutChanges.cwd);
			return pathsDiff(root, insidePaths(root, root, input.checkoutChanges.changedPaths), "HEAD", "observed-delta");
		}
		if (input.recorded === null || input.cwd === undefined) return null;
		const root = realpathSync(git(realpathSync(input.cwd), ["rev-parse", "--show-toplevel"]));
		return pathsDiff(root, insidePaths(root, root, input.recorded), "HEAD", "attributed-paths");
	} catch {
		return null;
	}
}

/** An absolute path with its existing ancestors resolved, so a symlinked alias names the same file as its real path. */
function canonicalPath(path: string): string {
	const tail: string[] = [];
	let head = path;
	for (;;) {
		try {
			return join(realpathSync(head), ...[...tail].reverse());
		} catch {
			const parent = dirname(head);
			if (parent === head) return path;
			tail.push(basename(head));
			head = parent;
		}
	}
}

/** `paths`, each absolute or relative to `base`, as paths relative to the real `root`; those outside it are dropped. */
function insidePaths(root: string, base: string, paths: ReadonlyArray<string>): string[] {
	return [
		...new Set(
			paths.flatMap((path) => {
				const rel = relative(root, canonicalPath(isAbsolute(path) ? path : resolve(base, path)));
				return rel.length > 0 && !relativePathEscapes(rel) ? [rel] : [];
			}),
		),
	];
}

/**
 * An untracked file's bytes, at most `limit`, or a note saying why none were read. Only a regular file is read: a
 * symlink could name a secret outside the checkout and a device or FIFO could never end. The file is opened without
 * following a final symlink and checked again through the handle, so a swap after the first look reads nothing.
 */
function readUntrackedBody(file: string, limit: number): Buffer | string {
	if (!lstatSync(file).isFile()) return "not shown: not a regular file\n";
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) return "not shown: not a regular file\n";
		if (stat.size > limit) return `not shown: ${stat.size} bytes, over the packet's diff budget\n`;
		const buffer = Buffer.alloc(limit);
		let length = 0;
		while (length < limit) {
			const read = readSync(fd, buffer, length, limit - length, null);
			if (read === 0) break;
			length += read;
		}
		return buffer.subarray(0, length);
	} finally {
		closeSync(fd);
	}
}

/**
 * The diff of `paths` (all of `root` when null) against `against`, with each new untracked file shown as added. Untracked
 * bodies share one byte budget, and a file is sized before it is read: one over what is left is named, never read.
 */
function pathsDiff(
	root: string,
	paths: ReadonlyArray<string> | null,
	against: string,
	scope: MeasuredDiff["scope"],
): MeasuredDiff {
	if (paths !== null && paths.length === 0) return { stat: "no changes", patch: "", scope };
	const spec = paths === null ? [] : ["--", ...paths.map((path) => `:(literal)${path}`)];
	const tracked = gitBytes(root, ["diff", "--no-color", "--no-ext-diff", against, ...spec], {
		maxBuffer: PACKET_DIFF_READ_BYTES,
	}).toString("utf8");
	const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z", ...spec])
		.split("\0")
		.filter((path) => path.length > 0);
	let remaining = UNTRACKED_INLINE_BUDGET_BYTES;
	const added = untracked.map((path) => {
		const file = resolve(root, path);
		let body: string;
		try {
			const bytes = readUntrackedBody(file, Math.min(remaining, UNTRACKED_FILE_READ_BYTES));
			if (typeof bytes === "string") {
				body = bytes;
			} else {
				remaining -= bytes.byteLength;
				body = bytes.includes(0)
					? `Binary file (${bytes.byteLength} bytes) not shown\n`
					: `${bytes
							.toString("utf8")
							.split("\n")
							.map((line) => `+${line}`)
							.join("\n")}\n`;
			}
		} catch {
			body = "unreadable\n";
		}
		return `diff --git a/${path} b/${path}\nnew untracked file\n--- /dev/null\n+++ b/${path}\n${body}`;
	});
	const trackedStat = git(root, ["diff", "--shortstat", against, ...spec]);
	const stat = [trackedStat, untracked.length > 0 ? `${untracked.length} untracked file(s) added` : ""]
		.filter((part) => part.length > 0)
		.join(", ");
	return { stat: stat || "no changes", patch: `${tracked}${added.join("")}`, scope };
}

export function protectedPathsChangedByWorktreeBranch(
	root: string,
	branch: string,
	protectedPaths: ReadonlyArray<string>,
): string[] {
	return protectedPathsChangedByDiff(root, [`HEAD...${branch}`], protectedPaths);
}

/** The protected paths a landing from commit `from` to tree or commit `to` changes, for a check on what actually lands. */
export function protectedPathsChangedBetween(
	root: string,
	from: string,
	to: string,
	protectedPaths: ReadonlyArray<string>,
): string[] {
	return protectedPathsChangedByDiff(root, [from, to], protectedPaths);
}

function protectedPathsChangedByDiff(
	root: string,
	range: ReadonlyArray<string>,
	protectedPaths: ReadonlyArray<string>,
): string[] {
	const canonical = realpathSync(root);
	const protectedInside = protectedPaths
		.map((path) => resolve(path))
		.filter((path) => {
			const rel = relative(canonical, path);
			return rel.length > 0 && !relativePathEscapes(rel);
		});
	if (protectedInside.length === 0) return [];
	const changed = git(canonical, ["diff", "--name-only", "-z", "--no-renames", ...range])
		.split("\0")
		.filter((path) => path.length > 0)
		.map((path) => resolve(canonical, path));
	const blocked = new Set<string>();
	for (const candidate of changed) {
		for (const protectedPath of protectedInside) {
			const rel = relative(protectedPath, candidate);
			if (candidate === protectedPath || (rel.length > 0 && !relativePathEscapes(rel))) {
				blocked.add(protectedPath);
			}
		}
	}
	return [...blocked].sort();
}
