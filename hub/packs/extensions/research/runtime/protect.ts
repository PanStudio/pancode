// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * What a candidate may not change and how it is measured: the files a check names (protected from the agent), whether
 * a changed path reaches one, the environment fingerprint taken around an agent run, and interleaved measurement.
 * Everything here reads a worktree this pack's worktree service created, under the read grant the host gives it.
 */
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type { DeclaredCheck } from "./types.ts";

/** One objective value, or why the run produced none. */
export type ObjectiveValue = { ok: true; value: number } | { ok: false; reason: string };

/** Whether a relative path leaves its base. */
function relativePathEscapes(rel: string): boolean {
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

interface CheckFiles {
	command?: ReadonlyArray<string>;
	cwd?: string;
	numeric?: { reference?: string; inputs?: ReadonlyArray<string> };
	perf?: { baseline?: string };
}

/** `target` as a repository-relative posix path under `rootReal`, or null when it lies outside. */
function insideRoot(rootReal: string, target: string): string | null {
	const rel = relative(rootReal, target);
	if (relativePathEscapes(rel)) return null;
	return rel.split(sep).join("/");
}

/** How many links one path's resolution may follow, as a kernel bounds it; a longer chain is a loop. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Every symlink inside the repository that resolving `path` passes through, repository-relative: links on the path's
 * own components and, recursively, links on the components of each link's target. Retargeting any of them would
 * redirect the path, so each is protected. Resolution stops after `MAX_SYMLINK_HOPS` links.
 */
function symlinksResolving(rootReal: string, path: string): string[] {
	const links = new Set<string>();
	const pending = path.split("/");
	let current = rootReal;
	let hops = 0;
	while (pending.length > 0) {
		const part = pending.shift() as string;
		if (part === "" || part === ".") continue;
		if (part === "..") {
			current = dirname(current);
			continue;
		}
		const next = join(current, part);
		let link: string;
		try {
			if (!lstatSync(next).isSymbolicLink()) {
				current = next;
				continue;
			}
			link = readlinkSync(next);
		} catch {
			break;
		}
		if (++hops > MAX_SYMLINK_HOPS) break;
		const rel = insideRoot(rootReal, next);
		if (rel !== null && rel.length > 0) links.add(rel);
		if (isAbsolute(link)) current = sep;
		pending.unshift(...link.split(sep));
	}
	return [...links];
}

/**
 * Repository-relative files a check's argv names, as they exist in `root`: those are protected from the agent. Every
 * argv entry counts, the executable included, so a repo-local `./bench.py` is protected as much as `python3 bench.py`.
 * Every symlink that resolving a named path passes through (its own components, and recursively the components of each
 * link's target) is protected as a link, and the path's
 * resolved target inside the repository is protected too, so neither the link nor what it reaches can be swapped.
 */
export function filesNamedByCheck(declared: DeclaredCheck, root: string): string[] {
	const check = declared as CheckFiles;
	const named = new Set<string>();
	const rootReal = realpathSync(root);
	const base = check.cwd === undefined || check.cwd === "." || check.cwd.length === 0 ? "" : check.cwd;
	const candidates = [...(check.command ?? [])];
	if (check.numeric?.reference !== undefined) candidates.push(check.numeric.reference);
	candidates.push(...(check.numeric?.inputs ?? []));
	if (check.perf?.baseline !== undefined) candidates.push(check.perf.baseline);
	for (const arg of candidates) {
		if (arg.startsWith("-") || arg.includes("\0")) continue;
		for (const relative of [posix.normalize(posix.join(base, arg)), posix.normalize(arg)]) {
			if (relative.startsWith("../") || posix.isAbsolute(relative) || relative === ".") continue;
			const full = join(root, relative);
			if (!existsSync(full)) continue;
			named.add(relative);
			for (const link of symlinksResolving(rootReal, relative)) named.add(link);
			const resolved = insideRoot(rootReal, realpathSync(full));
			if (resolved !== null && resolved.length > 0) named.add(resolved);
		}
	}
	return [...named].sort();
}

/** Whether `path`, normalized, is or lies under a protected path. */
function touchesProtected(path: string, protectedPaths: ReadonlyArray<string>): boolean {
	const normalized = posix.normalize(path);
	return protectedPaths.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

/**
 * Whether a changed path reaches a protected file. `path` comes from the diff of the base tree against the candidate
 * with renames split, so a deletion, replacement or rename of a protected path shows up under its base name. It
 * reaches one when it is or lies under a protected path, when it is a parent component of one (a directory or link
 * replaced on the way to it), or when in `worktree` it is a symlink whose target (as written, and as resolved) is,
 * contains or lies under a protected path, or leaves the worktree.
 */
export function changeReachesProtected(worktree: string, path: string, protectedPaths: ReadonlyArray<string>): boolean {
	if (touchesProtected(path, protectedPaths)) return true;
	const normalized = posix.normalize(path);
	if (protectedPaths.some((entry) => entry.startsWith(`${normalized}/`))) return true;
	const full = join(worktree, posix.normalize(path));
	let link: string;
	try {
		if (!lstatSync(full).isSymbolicLink()) return false;
		link = readlinkSync(full);
	} catch {
		return false;
	}
	const rootReal = realpathSync(worktree);
	const targets = [resolve(realpathSync(dirname(full)), link)];
	try {
		targets.push(realpathSync(full));
	} catch {
		// A dangling link is judged by what it names.
	}
	return targets.some((target) => {
		const rel = insideRoot(rootReal, target);
		if (rel === null || rel.length === 0) return true;
		return touchesProtected(rel, protectedPaths) || protectedPaths.some((entry) => entry.startsWith(`${rel}/`));
	});
}

/**
 * Interleaved pairs: base then candidate, `trials` times, so drift in the machine falls on both sides alike. Stops at
 * the first run that produced no value and returns its reason.
 */
export async function measurePairs(
	trials: number,
	measure: (side: "base" | "candidate") => Promise<ObjectiveValue>,
	/** Checked before every run: true ends the measurement there (an operator stop or the wall deadline). */
	stop: () => boolean = () => false,
): Promise<{ ok: true; pairs: Array<{ base: number; candidate: number }> } | { ok: false; reason: string }> {
	const pairs: Array<{ base: number; candidate: number }> = [];
	for (let trial = 0; trial < trials; trial++) {
		if (stop()) return { ok: false, reason: `stopped before base run ${trial + 1}` };
		const base = await measure("base");
		if (!base.ok) return { ok: false, reason: `base run ${trial + 1}: ${base.reason}` };
		if (stop()) return { ok: false, reason: `stopped before candidate run ${trial + 1}` };
		const candidate = await measure("candidate");
		if (!candidate.ok) return { ok: false, reason: `candidate run ${trial + 1}: ${candidate.reason}` };
		pairs.push({ base: base.value, candidate: candidate.value });
	}
	return { ok: true, pairs };
}

/** Whether an untracked file is one of `entries` or lies in a `dir/` entry. */
export function withinEntries(path: string, entries: ReadonlySet<string>): boolean {
	if (entries.has(path)) return true;
	for (const entry of entries) if (entry.endsWith("/") && path.startsWith(entry)) return true;
	return false;
}

/**
 * A fingerprint of every file under `entries` (relative path, type, size, mtime in nanoseconds and a link's target),
 * read with lstat and never following a link. Taken before and after the agent run, it shows whether the agent touched
 * the environment a candidate keeps.
 */
export function fingerprintEntries(worktree: string, entries: ReadonlyArray<string>): Map<string, string> {
	const prints = new Map<string, string>();
	const visit = (relativePath: string): void => {
		const path = join(worktree, relativePath);
		const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
		if (stat === undefined) return;
		if (stat.isDirectory()) {
			prints.set(`${relativePath}/`, "dir");
			for (const name of readdirSync(path).sort()) visit(`${relativePath}/${name}`);
			return;
		}
		const kind = stat.isSymbolicLink() ? `link:${readlinkSync(path)}` : stat.isFile() ? "file" : "other";
		prints.set(relativePath, `${kind}:${stat.size}:${stat.mtimeNs}`);
	};
	for (const entry of entries) visit(entry.endsWith("/") ? entry.slice(0, -1) : entry);
	return prints;
}

/** Paths added, removed or changed between two fingerprints, sorted. */
export function fingerprintChanges(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
	const changed = new Set<string>();
	for (const [path, print] of before) if (after.get(path) !== print) changed.add(path);
	for (const path of after.keys()) if (!before.has(path)) changed.add(path);
	return [...changed].sort();
}
