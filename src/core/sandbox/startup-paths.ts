// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { SandboxBackend, SandboxMaskedPath } from "./types.js";

/**
 * Editor and agent configuration a host program loads, and may run code from, when it opens a writable root:
 * VS Code tasks and settings, JetBrains, Cursor and Zed project files, dev containers, husky hooks, Claude Code,
 * Codex and Gemini project config, direnv, project MCP servers, submodules, git and ripgrep config.
 */
export const PROTECTED_STARTUP_NAMES = [
	".vscode",
	".idea",
	".cursor",
	".zed",
	".devcontainer",
	".husky",
	".claude",
	".codex",
	".gemini",
	".envrc",
	".mcp.json",
	".gitmodules",
	".gitconfig",
	".ripgreprc",
] as const;

/** Shell startup files, protected when a writable root is the home directory. */
export const PROTECTED_HOME_NAMES = [".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile"] as const;

export interface StartupPathProtection {
	/** Startup paths that exist, bound read-only; under seatbelt the absent ones too, which it refuses to create. */
	readOnlyPaths: string[];
	/**
	 * Bubblewrap only: each absent startup path as an empty read-only tmpfs. Its mount point is an empty directory,
	 * which git does not list, so a command's `git add -A` stages nothing; {@link holdStartupMountPoints} removes it.
	 */
	masks: SandboxMaskedPath[];
}

/** Mount points of absent startup paths that a launch in this process may still hold. */
const held = new Map<string, number>();

function isDirectory(entry: string): boolean {
	try {
		return statSync(entry).isDirectory();
	} catch {
		return false;
	}
}

function present(entry: string): boolean {
	try {
		lstatSync(entry);
		return true;
	} catch {
		return false;
	}
}

/**
 * Impure: the startup paths in each writable directory root, present or absent. A root that is not a directory
 * yet is skipped: bubblewrap leaves it unwritable, and a mount point under it could not be created.
 */
export function startupPathProtection(
	roots: ReadonlyArray<string>,
	backend: SandboxBackend,
	home: string = homedir(),
): StartupPathProtection {
	let realHome: string;
	try {
		realHome = realpathSync(home);
	} catch {
		realHome = home;
	}
	const readOnlyPaths: string[] = [];
	const masks: SandboxMaskedPath[] = [];
	for (const root of new Set(roots)) {
		if (!isDirectory(root)) continue;
		const names =
			root === home || root === realHome ? [...PROTECTED_STARTUP_NAMES, ...PROTECTED_HOME_NAMES] : PROTECTED_STARTUP_NAMES;
		for (const name of names) {
			const entry = path.join(root, name);
			// A mount point another launch here planted is still absent as far as the operator knows.
			if ((present(entry) && !held.has(entry)) || backend !== "bwrap") readOnlyPaths.push(entry);
			else masks.push({ path: entry, kind: "directory", readOnly: true });
		}
	}
	return { readOnlyPaths, masks };
}

/** Decodes the octal escapes mountinfo writes for space, tab, newline and backslash. */
function mountinfoPath(field: string): string {
	return field.replace(/\\([0-7]{3})/gu, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 8)));
}

/**
 * Impure: which of `paths` another mount namespace of this account still has a mount on: another PanCode process's
 * sandbox, or a worker's. Removing such a mount point on the host would detach that sandbox's mount and let its
 * command create the path writable.
 */
function mountedElsewhere(paths: ReadonlyArray<string>): Set<string> {
	const wanted = new Set(paths);
	const busy = new Set<string>();
	let own: string | null = null;
	try {
		own = readlinkSync("/proc/self/ns/mnt");
	} catch {
		return busy;
	}
	const seen = new Set<string>([own]);
	let pids: string[];
	try {
		pids = readdirSync("/proc");
	} catch {
		return busy;
	}
	for (const pid of pids) {
		if (!/^\d+$/u.test(pid)) continue;
		let ns: string;
		let info: string;
		try {
			ns = readlinkSync(`/proc/${pid}/ns/mnt`);
			if (seen.has(ns)) continue;
			seen.add(ns);
			info = readFileSync(`/proc/${pid}/mountinfo`, "utf8");
		} catch {
			continue;
		}
		for (const line of info.split("\n")) {
			const point = line.split(" ")[4];
			if (point !== undefined && wanted.has(mountinfoPath(point))) busy.add(mountinfoPath(point));
		}
	}
	return busy;
}

/**
 * Hold the mount points a launch's startup masks create, and return what removes them once the launch exits. A
 * mount point stays while another launch in this process or a sandbox elsewhere still mounts it, and when it is no
 * longer an empty directory (the operator made one there meanwhile).
 */
export function holdStartupMountPoints(masks: ReadonlyArray<SandboxMaskedPath>): () => void {
	const points = masks.filter((mask) => mask.readOnly === true).map((mask) => mask.path);
	for (const point of points) held.set(point, (held.get(point) ?? 0) + 1);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const free: string[] = [];
		for (const point of points) {
			const count = (held.get(point) ?? 1) - 1;
			if (count > 0) held.set(point, count);
			else {
				held.delete(point);
				if (isDirectory(point)) free.push(point);
			}
		}
		if (free.length === 0) return;
		const busy = mountedElsewhere(free);
		for (const point of free) {
			if (busy.has(point)) continue;
			try {
				rmdirSync(point);
			} catch {
				// Runs from a child's exit listener; a directory that is not empty is the operator's and stays.
			}
		}
	};
}
