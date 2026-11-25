// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { relativePathEscapes } from "../core/path-containment.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import type { TaskWorktree } from "./task-worktree.js";
import type { TaskClaim } from "./task-worktree-claims.js";
import { assertOwnership, claimPathFor, replaceMarker } from "./task-worktree-ownership.js";
import { git } from "./worktree-git.js";

/** Tracked files PanCode wrote over in a task worktree for one run, with what to put back. */
export interface TaskWorktreeOverlay {
	worktree: TaskWorktree;
	path: string;
	files: ReadonlyArray<{ file: string; original: Buffer; written: Buffer; mode: number; parent: string }>;
}

function overlayTarget(path: string, file: string): string {
	const target = resolve(path, file);
	const rel = relative(resolve(path), target);
	if (rel.length === 0 || relativePathEscapes(rel)) throw new Error(`overlay path ${file} leaves the worktree`);
	return target;
}

/**
 * Write `files` (worktree-relative regular files Git tracks) over a task
 * worktree for one run. Each path is first marked skip-worktree in the
 * worktree's own index, so no host commit, diff or status sees what was
 * written and `git add` of it is refused: a run that dies before
 * `restoreTaskWorktreeOverlay` still cannot land it. The claim names the paths
 * first, so restart recovery puts back what a dead run left overlaid.
 */
export function overlayTaskWorktree(
	worktree: TaskWorktree,
	files: ReadonlyArray<{ file: string; content: string }>,
): TaskWorktreeOverlay {
	const path = worktree.path;
	const written: Array<TaskWorktreeOverlay["files"][number]> = [];
	try {
		for (const { file } of files) overlayTarget(path, file);
		recordOverlayOnClaim(
			worktree,
			files.map(({ file }) => file),
		);
		for (const { file, content } of files) {
			const target = overlayTarget(path, file);
			const stat = lstatSync(target);
			if (!stat.isFile()) throw new Error(`overlay path ${file} is not a regular file`);
			git(path, ["ls-files", "--error-unmatch", "--", `:(top,literal)${file}`]);
			const entry = {
				file,
				original: readFileSync(target),
				written: Buffer.from(content, "utf8"),
				mode: stat.mode & 0o777,
				parent: realpathSync(dirname(target)),
			};
			git(path, ["update-index", "--skip-worktree", "--", file]);
			try {
				safeResourceWrite(target, content, { mode: entry.mode });
			} catch (error) {
				// A file the write left as it was must be seen again, or a later edit to it would never land.
				if (readFileSync(target).equals(entry.original)) {
					git(path, ["update-index", "--no-skip-worktree", "--", file]);
				} else written.push(entry);
				throw error;
			}
			written.push(entry);
		}
	} catch (error) {
		try {
			restoreTaskWorktreeOverlay({ worktree, path, files: written });
		} catch {
			// What could not be put back keeps its mark; the write failure is the one to report.
		}
		throw error;
	}
	return { worktree, path, files: written };
}

/** Name the overlaid paths on the run's claim, or clear them with an empty list. */
function recordOverlayOnClaim(worktree: TaskWorktree, files: ReadonlyArray<string>): void {
	assertOwnership(worktree);
	const ownerPath = claimPathFor(worktree.root, worktree.runId);
	const { overlay: _previous, ...marker } = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
	replaceMarker(ownerPath, files.length > 0 ? { ...marker, overlay: [...files] } : marker);
}

/**
 * Put back what `overlayTaskWorktree` replaced, whatever the run did to those
 * paths, and return the paths the run changed from what was written: those
 * edits are gone. A path whose directory no longer resolves where it did is
 * left alone with its skip-worktree mark, so nothing is written outside the
 * worktree and the landing still drops it.
 */
export function restoreTaskWorktreeOverlay(overlay: TaskWorktreeOverlay): string[] {
	let failure: unknown;
	const discarded: string[] = [];
	for (const { file, original, written, mode, parent } of overlay.files) {
		try {
			const target = overlayTarget(overlay.path, file);
			if (realpathSync(dirname(target)) !== parent) throw new Error(`overlay path ${file} moved during the run`);
			let current: Buffer | null = null;
			try {
				current = readFileSync(target);
			} catch {
				// Removed during the run: that is an edit too.
			}
			if (current === null || !current.equals(written)) discarded.push(file);
			safeResourceWrite(target, original, { mode });
			git(overlay.path, ["update-index", "--no-skip-worktree", "--", file]);
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure !== undefined) throw failure;
	try {
		recordOverlayOnClaim(overlay.worktree, []);
	} catch {
		// Every file is back; a record left on the claim only makes recovery check them out again.
	}
	return discarded;
}

/**
 * Put back the files a dead run's claim says were overlaid: the index still
 * holds their base content under the skip-worktree mark. Git writes them, so
 * a path through a symlink is refused, not followed.
 */
export function restoreRecordedOverlay(claim: TaskClaim): void {
	const files = claim.marker.overlay;
	if (!Array.isArray(files)) return;
	if (existsSync(claim.path)) {
		for (const file of files) {
			if (typeof file !== "string") continue;
			overlayTarget(claim.path, file);
			// The content first, then the mark: a failed checkout leaves the compiled file hidden, never staged.
			git(claim.path, ["checkout", "--ignore-skip-worktree-bits", "--", `:(top,literal)${file}`]);
			git(claim.path, ["update-index", "--no-skip-worktree", "--", file]);
		}
	}
	const { overlay: _overlay, ...marker } = claim.marker;
	replaceMarker(claim.ownerPath, marker);
	claim.marker = marker;
}
