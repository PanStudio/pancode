// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { attributeCommitMessage } from "../core/commit-attribution.js";
import { autonomousLandAuthorship } from "../core/git-commit-attribution.js";
import { withoutRepositoryEnv } from "../core/internal-git.js";
import { relativePathEscapes } from "../core/path-containment.js";
import type { TaskWorktreePreview } from "./task-worktree-preview.js";
import { configuredGitValue, git, gitBytes } from "./worktree-git.js";

/** Identity of commits the host makes on a task branch, and of worker commits when the repository names none. */
export const COMMIT_IDENTITY = "pancode-task";

/**
 * `-c` overrides for a commit the host makes on the operator's behalf. The
 * checkout's own identity authors it, the same identity the main agent's
 * commits carry; `identity` fills in only what is not configured, so a
 * merged task never lands under a synthetic author the operator did not pick.
 */
export function hostCommitIdentity(cwd: string, identity: string): string[] {
	const config: string[] = [];
	if (configuredGitValue(cwd, "user.name") === null) config.push("-c", `user.name=${identity}`);
	if (configuredGitValue(cwd, "user.email") === null) config.push("-c", `user.email=${identity}@local`);
	return config;
}

export interface GitIdent {
	name: string;
	email: string;
}

/**
 * The author and committer a host commit at `cwd` would record, spelled out for
 * a commit made elsewhere (an SSH node's worktree) that lands in this
 * checkout. Git resolves them with the `hostCommitIdentity` fill-ins, so
 * GIT_AUTHOR_* and GIT_COMMITTER_* environment, author.* and committer.*
 * config, and user.* config win exactly as they would for a local commit.
 */
export function hostCommitIdents(cwd: string, identity: string): { author: GitIdent; committer: GitIdent } {
	const fallback = { name: identity, email: `${identity}@local` };
	const resolveIdent = (kind: "GIT_AUTHOR_IDENT" | "GIT_COMMITTER_IDENT"): GitIdent => {
		try {
			const raw = git(cwd, [...hostCommitIdentity(cwd, identity), "-c", "user.useConfigOnly=true", "var", kind]);
			const match = /^(.+?) <([^<>]*)> \d+ [-+]\d{4}$/u.exec(raw);
			return match?.[1] !== undefined && match[2] !== undefined ? { name: match[1], email: match[2] } : fallback;
		} catch {
			return fallback;
		}
	};
	return { author: resolveIdent("GIT_AUTHOR_IDENT"), committer: resolveIdent("GIT_COMMITTER_IDENT") };
}

/** What a host commit of a worker's worktree took, and the new files it left out. */
export interface WorktreeCommit {
	committed: boolean;
	/** Files still untracked after the host commit, top-relative and sorted, excluding runtime state. */
	leftUncommitted: string[];
	/** Authored files the repository's ignore rules kept out of the commit; see `ignoredAuthoredPaths`. */
	ignoredAuthored: string[];
	/** The commit and stamps from that same post-commit listing, for guarded cleanup. */
	accounted: TaskWorktreePreview;
	/** With `mergeRoots`: what changed outside them and stays uncommitted, top-relative and sorted. */
	outsideRoots: string[];
}

/** How many left-out paths a receipt names; the count still covers all of them. */
export const LEFT_UNCOMMITTED_LIST_LIMIT = 20;

const GIT_PATHSPEC_BATCH = 256;

export function untrackedPaths(path: string): string[] {
	return nullDelimitedPaths(gitBytes(path, ["ls-files", "--others", "--exclude-standard", "-z"]));
}

/**
 * Files a run authored that the repository's ignore rules keep out of every
 * host commit. They are never forced into history and never copied into the
 * checkout, so they live only in the worktree, which must outlive the landing.
 * With no write record, every ignored path counts (collapsed per directory).
 */
export function ignoredAuthoredPaths(
	path: string,
	authoredPaths: Iterable<string> | null,
	excludedPaths: ReadonlyArray<string> = [],
): string[] {
	const listing = ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"];
	const excluded = new Set(excludedPaths);
	if (authoredPaths === null) {
		return nullDelimitedPaths(gitBytes(path, [...listing, "--directory"]))
			.map((entry) => entry.replace(/\/$/u, ""))
			.filter((entry) => !excluded.has(entry))
			.sort();
	}
	const authored = [...worktreeRelativePaths(path, authoredPaths)].filter((entry) => !excluded.has(entry));
	const ignored = new Set<string>();
	for (let index = 0; index < authored.length; index += GIT_PATHSPEC_BATCH) {
		const batch = authored.slice(index, index + GIT_PATHSPEC_BATCH);
		for (const entry of nullDelimitedPaths(
			gitBytes(path, [...listing, "--", ...batch.map((entry) => `:(top,literal)${entry}`)]),
		))
			ignored.add(entry);
	}
	return [...ignored].sort();
}

/** Top-relative POSIX spellings of the absolute `paths` that sit inside the worktree at `path`. */
function worktreeRelativePaths(path: string, paths: Iterable<string>): Set<string> {
	const roots = new Set([resolve(path)]);
	try {
		roots.add(realpathSync(path));
	} catch {
		// A worktree that cannot be canonicalized is matched by its given spelling only.
	}
	const inside = new Set<string>();
	for (const candidate of paths) {
		for (const root of roots) {
			const rel = relative(root, resolve(candidate));
			if (rel.length === 0 || relativePathEscapes(rel)) continue;
			inside.add(rel.split(sep).join("/"));
		}
	}
	return inside;
}

/**
 * Commit a worker's worktree as the host. The commit takes changes to tracked
 * files, whatever the worker staged through the git capability, and the
 * untracked files in `authoredPaths`, which are the host-observed targets of the
 * run's own successful mutation calls. Every other new file is a byproduct
 * (`__pycache__`, object files, build outputs) that the worker never chose to
 * ship, so it stays out and is reported instead: committed, it lands beside the
 * fix and collides with the destination's own untracked copies at merge.
 *
 * `authoredPaths: null` means the host holds no complete write record for the
 * run, so it cannot tell an authored file from a byproduct and takes every
 * untracked file.
 */
export function commitWorktreePath(
	path: string,
	identity: string,
	message: string,
	scope: {
		authoredPaths: Iterable<string> | null;
		excludedPaths?: ReadonlyArray<string>;
		/**
		 * Absolute write boundaries the commit is limited to (fleet M7): changes outside them stay in the worktree,
		 * uncommitted. Absent, or a root that is the worktree itself, takes the whole tree.
		 */
		mergeRoots?: ReadonlyArray<string>;
	},
): WorktreeCommit {
	const excludedPaths = scope.excludedPaths ?? [];
	const roots = mergeRootSpecs(path, scope.mergeRoots);
	const inRoots = (entry: string): boolean =>
		roots === null || roots.some((root) => entry === root || entry.startsWith(`${root}/`));
	// Runtime state can already be staged by a worker. Reset only these exact
	// index entries, leaving their working files and every authored path intact.
	if (excludedPaths.length > 0) {
		git(path, ["reset", "-q", "HEAD", "--", ...excludedPaths.map((entry) => `:(top,literal)${entry}`)]);
	}
	// A worker may have staged a path outside its roots; only the roots merge back, so it leaves the index.
	if (roots !== null)
		git(path, ["reset", "-q", "HEAD", "--", ":(top).", ...roots.map((root) => `:(top,exclude,literal)${root}`)]);
	const addSpecs = roots === null ? ["."] : roots.map((root) => `:(top,literal)${root}`);
	git(path, ["add", "-u", "--", ...addSpecs, ...excludedPaths.map((entry) => `:(top,exclude,literal)${entry}`)]);
	const excluded = new Set(excludedPaths);
	const untracked = untrackedPaths(path).filter((entry) => !excluded.has(entry));
	const authored = scope.authoredPaths === null ? new Set(untracked) : worktreeRelativePaths(path, scope.authoredPaths);
	const take = untracked.filter((entry) => authored.has(entry) && inRoots(entry));
	for (let index = 0; index < take.length; index += GIT_PATHSPEC_BATCH) {
		const batch = take.slice(index, index + GIT_PATHSPEC_BATCH);
		git(path, ["add", "--", ...batch.map((entry) => `:(top,literal)${entry}`)]);
	}
	const committed = git(path, ["diff", "--cached", "--name-only", "-z"]).length > 0;
	if (committed) {
		// Landing dispatched work is autonomous: under `auto` PanCode authors it and the human co-authors.
		const authorship = autonomousLandAuthorship(path);
		const attributed =
			authorship === null ? message : attributeCommitMessage(message, {}, true, { pancodeAuthorFor: authorship.human });
		git(
			path,
			[...hostCommitIdentity(path, identity), "commit", "-m", attributed, "--no-verify"],
			authorship === null ? {} : { env: { ...withoutRepositoryEnv(), ...authorship.env } },
		);
	}
	const leftUncommitted = untrackedPaths(path).filter((entry) => !excluded.has(entry));
	const ignoredAuthored = ignoredAuthoredPaths(path, scope.authoredPaths, excludedPaths);
	// What the run meant to change outside its roots: tracked edits, and files it authored there. A byproduct
	// (a cache, a build output) stays the leftUncommitted it always was.
	const outsideRoots =
		roots === null
			? []
			: [
					...new Set([
						...nullDelimitedPaths(gitBytes(path, ["diff", "--name-only", "-z", "HEAD"])),
						...leftUncommitted.filter((entry) => authored.has(entry) && !inRoots(entry)),
					]),
				].sort();
	const outside = new Set(outsideRoots);
	// An authored file outside the roots is left out of what cleanup accounted for, so the worktree holding it is
	// kept rather than removed; tracked edits keep it as uncommitted changes already.
	const { stamps } = untrackedState(
		path,
		leftUncommitted.filter((entry) => !outside.has(entry)),
	);
	return {
		committed,
		leftUncommitted: leftUncommitted.filter((entry) => !outside.has(entry)),
		ignoredAuthored,
		accounted: {
			commit: git(path, ["rev-parse", "HEAD"]),
			untracked: stamps,
			...(ignoredAuthored.length > 0 ? { ignored: ignoredAuthored } : {}),
		},
		outsideRoots,
	};
}

/** Top-relative spellings of the roots inside the worktree, or null when a root covers the whole tree. */
function mergeRootSpecs(path: string, mergeRoots: ReadonlyArray<string> | undefined): string[] | null {
	if (mergeRoots === undefined || mergeRoots.length === 0) return null;
	const specs = [
		...worktreeRelativePaths(
			path,
			mergeRoots.map((root) => root.replace(/\/+$/u, "")),
		),
	];
	const whole = mergeRoots.some((root) => {
		const rel = relative(resolve(path), resolve(root));
		return rel.length === 0;
	});
	return whole || specs.length === 0 ? null : specs.map((spec) => spec.replace(/\/+$/u, "")).sort();
}

export function nullDelimitedPaths(bytes: Buffer): string[] {
	return bytes.toString("utf8").split("\0").filter(Boolean).sort();
}

export const GONE_STAMP = "gone";

/**
 * Each untracked file's inode stamp. ctime moves on every write, rename and
 * chmod and cannot be set back, so an equal stamp means the file did not change.
 * Directory stamps cannot detect edits to descendants, so directories prevent
 * destructive cleanup. Ignored files stay out, as they do from every host commit.
 */
export function untrackedState(
	path: string,
	paths = untrackedPaths(path),
): { stamps: Map<string, string>; directories: string[] } {
	const stamps = new Map<string, string>();
	const directories: string[] = [];
	for (const entry of paths) {
		let stamp = GONE_STAMP;
		try {
			const stat = lstatSync(join(path, entry), { bigint: true });
			if (stat.isDirectory()) directories.push(entry);
			stamp = `${stat.mode}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
		} catch (error) {
			// Only a vanished file is safe to omit from destructive cleanup.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		stamps.set(entry, stamp);
	}
	return { stamps, directories };
}
