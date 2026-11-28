// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolvePackageRoot } from "../package-root.js";
import { isSameOrDescendant, isStrictDescendant } from "../path-containment.js";
import { wslKind } from "./availability.js";
import { HOME_READ_TOOLCHAIN_PATHS, type HomeReadsSetting, listedHomePaths } from "./home-read-roots.js";
import { windowsDriveMounts, withMountAliases } from "./mount-aliases.js";
import type { HomeReadList, SandboxBackend, SandboxMaskedPath, SandboxReadRestriction } from "./types.js";

function realOrNull(entry: string): string | null {
	try {
		return realpathSync(entry);
	} catch {
		return null;
	}
}

/**
 * PanCode's own files a contained command runs: the Node binary running
 * PanCode and its package, which the browser driver and the egress setup load
 * inside the sandbox. Both are read-only to every sandbox already.
 */
function pancodeOwnPaths(): string[] {
	const own: string[] = [];
	for (const entry of [process.execPath, safePackageRoot()]) {
		const physical = entry === null ? null : realOrNull(entry);
		if (physical !== null) own.push(physical);
	}
	return own;
}

function safePackageRoot(): string | null {
	try {
		return resolvePackageRoot();
	} catch {
		return null;
	}
}

export interface HomeReadPlanInput {
	list: HomeReadList;
	/** Only bubblewrap reads Linux's mount table, for WSL's drives and other mounts of the hidden trees. */
	backend: SandboxBackend;
	/**
	 * Physical roots the sandbox gives the command on its own: the workspace,
	 * writable, readable and Git roots and PanCode's own files it needs.
	 */
	admitted: ReadonlyArray<string>;
	/** The command's physical working directory, which must show. */
	cwd: string;
	/** The home to hide; the process's own when absent. */
	home?: string;
	mountinfo?: string;
	/** Whether this is a WSL host, whose Windows drive mounts are hidden too; probed when absent. */
	wsl?: boolean;
}

export interface HomeReadPlan {
	restriction: SandboxReadRestriction;
	/** Files that reach the hidden trees through another mount, masked like secrets. */
	masks: SandboxMaskedPath[];
}

/**
 * Impure: what a `listed` sandbox hides and shows back on this host. Hidden
 * are the physical home, WSL's Windows drive mounts and every other mount that
 * reaches into them. Shown back, read-only unless a later bind makes them
 * writable, are the admitted roots, PanCode's own files and the listed roots
 * and toolchain paths that exist, each at its physical path; a listed root that
 * is a link is recreated at its own spelling. A link inside a shown root is
 * never followed to show more.
 *
 * The plan refuses rather than widen: an Error when the mount table cannot be
 * read, when an admitted or listed root holds a hidden tree, or when the
 * working directory is hidden and outside everything shown back.
 */
export function planHomeReads(input: HomeReadPlanInput): HomeReadPlan | Error {
	const home = input.home ?? homedir();
	const realHome = realOrNull(home);
	if (realHome === null || realHome === "/")
		return new Error(`could not resolve the home directory ${home} to hide it; the command was not run`);
	const linux = input.backend === "bwrap";
	const wsl = linux && (input.wsl ?? wslKind() !== null);
	const drives = wsl ? windowsDriveMounts(input.mountinfo) : [];
	if (drives instanceof Error) return drives;
	const candidates = [realHome, ...drives.map(realOrNull)].filter(
		(entry): entry is string => entry !== null && entry !== "/",
	);
	const primary = [...new Set(candidates)].filter(
		(entry) => !candidates.some((other) => other !== entry && isStrictDescendant(entry, other)),
	);
	const insideHidden = (entry: string) => primary.some((dir) => isStrictDescendant(entry, dir));
	const holdingHidden = (entry: string) => primary.find((dir) => isSameOrDescendant(dir, entry));
	const exposed = new Set<string>();
	for (const root of input.admitted) {
		const held = holdingHidden(root);
		if (held !== undefined)
			return new Error(`${root} holds ${held}, which safety.homeReads hides; the command was not run`);
		if (insideHidden(root)) exposed.add(root);
	}
	for (const own of pancodeOwnPaths()) if (insideHidden(own) && holdingHidden(own) === undefined) exposed.add(own);
	const named: Array<{ spelled: string; physical: string }> = [];
	for (const entry of listedHomePaths(input.list, home)) {
		// An absent root shows nothing; a dangling link the same.
		if (lstatSync(entry, { throwIfNoEntry: false }) === undefined) continue;
		const physical = realOrNull(entry);
		if (physical === null) continue;
		const held = holdingHidden(physical);
		if (held !== undefined)
			return new Error(
				`safety.homeReads root ${entry} resolves to ${physical}, which holds ${held}; the command was not run`,
			);
		if (insideHidden(physical)) exposed.add(physical);
		const parent = realOrNull(path.dirname(entry));
		if (parent !== null) named.push({ spelled: path.join(parent, path.basename(entry)), physical });
	}
	const shown = [...exposed].filter((entry) => ![...exposed].some((other) => isStrictDescendant(entry, other)));
	const seenLinks = new Set<string>();
	const links = named.filter(({ spelled, physical }) => {
		if (spelled === physical || !insideHidden(spelled) || shown.some((root) => isSameOrDescendant(spelled, root)))
			return false;
		if (seenLinks.has(spelled)) return false;
		seenLinks.add(spelled);
		return true;
	});
	const cwdHeld = holdingHidden(input.cwd);
	if (cwdHeld !== undefined)
		return new Error(
			`the working directory ${input.cwd} holds ${cwdHeld}, which safety.homeReads hides; the command was not run`,
		);
	if (insideHidden(input.cwd) && !shown.some((root) => isSameOrDescendant(input.cwd, root)))
		return new Error(
			`the working directory ${input.cwd} is under a directory safety.homeReads hides and outside every root it shows; the command was not run`,
		);
	const hiddenDirs = primary.map((dir) => ({ path: dir, kind: "directory" as const }));
	const aliased = linux
		? withMountAliases(hiddenDirs, input.mountinfo, [input.cwd, ...input.admitted, ...shown])
		: hiddenDirs;
	if (aliased instanceof Error) return aliased;
	return {
		restriction: {
			hidden: aliased.filter((mask) => mask.kind === "directory").map((mask) => mask.path),
			exposed: shown,
			links: links.map(({ spelled, physical }) => ({ path: spelled, target: physical })),
		},
		masks: aliased.filter((mask) => mask.kind === "file"),
	};
}

/**
 * One line for doctor: each caller's mode and, when one is listed, what the
 * main session's commands in `workspace` would see on this host.
 */
export function homeReadsLine(setting: HomeReadsSetting, plan: HomeReadPlan | Error | null): string {
	const modes = `main ${setting.main}, workers ${setting.workers}`;
	if (setting.main !== "listed" && setting.workers !== "listed") return `${modes}: sandboxed commands read your home`;
	const listed = [
		...setting.roots,
		...setting.toolchains.map((name) => `${name} (${HOME_READ_TOOLCHAIN_PATHS[name].map((p) => `~/${p}`).join(", ")})`),
	];
	const parts = [modes];
	if (plan instanceof Error) parts.push(`main session commands refused here: ${plan.message}`);
	else if (plan !== null) {
		parts.push(`hidden: ${plan.restriction.hidden.join(", ")}`);
		parts.push(`shown back: ${plan.restriction.exposed.length > 0 ? plan.restriction.exposed.join(", ") : "none"}`);
	}
	parts.push(`listed roots: ${listed.length > 0 ? listed.join(", ") : "none"}`);
	if (!setting.roots.some((root) => root === "~/.gitconfig" || root.endsWith("/.gitconfig")))
		parts.push(
			"~/.gitconfig stays hidden, so git in the sandbox has no identity unless the repository sets one or roots lists ~/.gitconfig",
		);
	parts.push("~/.ssh stays masked in every mode, so SSH remotes work only from commands that leave the sandbox");
	return parts.join("; ");
}
