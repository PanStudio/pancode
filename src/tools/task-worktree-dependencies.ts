// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { TaskWorktree } from "./task-worktree.js";
import { assertOwnership } from "./task-worktree-ownership.js";
import { git, gitBytes, isCanonicalWorktreePathInside } from "./worktree-git.js";

const MANIFEST_PATHSPECS = [
	":(glob)**/package.json",
	":(glob)**/.npmrc",
	":(glob)**/pnpm-workspace.yaml",
	":(exclude,glob)**/node_modules/**",
];

/**
 * Whether the task worktree's package manifests or package-manager config
 * differ from its base: committed, staged, unstaged, untracked or ignored.
 * Any Git failure counts as changed.
 */
export function taskWorktreeManifestsChanged(worktree: Pick<TaskWorktree, "path" | "base">): boolean {
	try {
		const tracked = gitBytes(worktree.path, ["diff", "--name-only", worktree.base, "--", ...MANIFEST_PATHSPECS]);
		if (tracked.length > 0) return true;
		const added = gitBytes(worktree.path, ["ls-files", "--others", "--", ...MANIFEST_PATHSPECS]);
		return added.length > 0;
	} catch {
		return true;
	}
}

const DEPENDENCY_INPUTS = {
	node_modules: [
		"package.json",
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		"package-lock.json",
		"yarn.lock",
		"bun.lock",
		"bun.lockb",
		".npmrc",
	],
	".venv": [
		"pyproject.toml",
		"uv.lock",
		"poetry.lock",
		"Pipfile",
		"Pipfile.lock",
		"requirements.txt",
		"setup.py",
		"setup.cfg",
	],
};

function dependencyInput(path: string): Buffer | null {
	try {
		return readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** Workspace package directories (relative, never "."), from pnpm-workspace.yaml or package.json workspaces. */
function workspacePackageDirs(root: string): string[] {
	const patterns: string[] = [];
	const yaml = dependencyInput(join(root, "pnpm-workspace.yaml"));
	if (yaml !== null) {
		let inPackages = false;
		for (const line of yaml.toString("utf8").split(/\r?\n/)) {
			if (/^packages:\s*$/.test(line)) {
				inPackages = true;
				continue;
			}
			if (!inPackages) continue;
			const item = /^\s+-\s*["']?([^"'#]+?)["']?\s*(#.*)?$/.exec(line);
			if (item?.[1] !== undefined) patterns.push(item[1]);
			else if (line.trim().length > 0 && !line.trimStart().startsWith("#")) inPackages = false;
		}
	}
	const manifest = dependencyInput(join(root, "package.json"));
	if (manifest !== null) {
		try {
			const parsed = JSON.parse(manifest.toString("utf8")) as { workspaces?: unknown };
			const workspaces = Array.isArray(parsed.workspaces)
				? parsed.workspaces
				: (parsed.workspaces as { packages?: unknown } | undefined)?.packages;
			if (Array.isArray(workspaces)) {
				for (const entry of workspaces) if (typeof entry === "string") patterns.push(entry);
			}
		} catch {
			// A malformed manifest names no workspace packages.
		}
	}
	const dirs = new Set<string>();
	for (const raw of patterns) {
		const pattern = raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
		if (pattern.length === 0 || pattern === "." || pattern.startsWith("!") || pattern.includes("..")) continue;
		if (pattern.endsWith("/*") && !pattern.slice(0, -2).includes("*")) {
			const parent = pattern.slice(0, -2);
			let entries: string[];
			try {
				entries = readdirSync(join(root, parent));
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (existsSync(join(root, parent, entry, "package.json"))) dirs.add(`${parent}/${entry}`);
			}
		} else if (!pattern.includes("*") && existsSync(join(root, pattern, "package.json"))) {
			dirs.add(pattern);
		}
	}
	return [...dirs].sort();
}

/** Reuse installed environments only when the caller enforces these returned roots as read-only. */
export function shareTaskWorktreeDependencies(worktree: TaskWorktree): string[] {
	if (isCanonicalWorktreePathInside(worktree.root, worktree.path)) return [];
	assertOwnership(worktree);
	const readOnlyRoots = new Set<string>();
	const targets: Array<{ name: string; inputs: string[] }> = Object.entries(DEPENDENCY_INPUTS).map(([name, inputs]) => ({
		name,
		inputs,
	}));
	// A workspace package's node_modules resolves through the root install, so the root inputs gate it too.
	for (const dir of workspacePackageDirs(worktree.root)) {
		targets.push({ name: `${dir}/node_modules`, inputs: [...DEPENDENCY_INPUTS.node_modules, `${dir}/package.json`] });
	}
	for (const { name, inputs } of targets) {
		let source: string;
		try {
			source = realpathSync(join(worktree.root, name));
			if (!lstatSync(source).isDirectory()) continue;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		// An environment may link workspace packages beside it; protect that checkout too.
		const sourceRoot = dirname(source);
		if (sourceRoot === worktree.path || isCanonicalWorktreePathInside(sourceRoot, worktree.path)) continue;
		if (
			!inputs.every((name) => {
				const parent = dependencyInput(join(worktree.root, name));
				const task = dependencyInput(join(worktree.path, name));
				return parent === null ? task === null : task !== null && parent.equals(task);
			})
		) {
			continue;
		}
		try {
			git(worktree.path, ["check-ignore", "-q", "--", `${name}/`]);
		} catch (error) {
			if ((error as { status?: number }).status === 1) continue;
			throw error;
		}
		const destination = join(worktree.path, name);
		if (!existsSync(destination)) {
			if (!existsSync(dirname(destination))) continue;
			// A real ignored directory keeps links out of commits even with a `node_modules/` rule.
			mkdirSync(destination);
			try {
				for (const entry of readdirSync(source)) symlinkSync(join(source, entry), join(destination, entry));
			} catch (error) {
				rmSync(destination, { recursive: true, force: true });
				throw error;
			}
		}
		readOnlyRoots.add(worktree.root);
		readOnlyRoots.add(sourceRoot);
	}
	return [...readOnlyRoots];
}
