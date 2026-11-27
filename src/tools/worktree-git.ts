// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { withoutRepositoryEnv } from "../core/internal-git.js";
import { gitExecFileSync } from "../core/internal-git-run.js";
import { isStrictDescendant } from "../core/path-containment.js";
import { dropHostTerminalEnv, TOOL_SESSION_SPAWN } from "../core/tool-env-controls.js";

interface GitOptions {
	env?: NodeJS.ProcessEnv;
	maxBuffer?: number;
}

export function gitBytes(root: string, args: string[], options: GitOptions = {}): Buffer {
	return gitExecFileSync(["-C", root, ...args], {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
		...options,
		// A checkout or commit still runs the repository's filters and signing program: away from the TUI's terminal and its pane host (M-12).
		...TOOL_SESSION_SPAWN,
		env: dropHostTerminalEnv(withoutRepositoryEnv(options.env)),
	});
}

export function git(root: string, args: string[], options: GitOptions = {}): string {
	return gitBytes(root, args, options).toString("utf8").trim();
}

export function gitErrorOutput(error: unknown, stream: "stdout" | "stderr"): string {
	if (error === null || typeof error !== "object") return "";
	const output = (error as { stdout?: unknown; stderr?: unknown })[stream];
	return typeof output === "string" ? output : Buffer.isBuffer(output) ? output.toString("utf8") : "";
}

export function gitFailureReason(error: unknown, fallback: string): string {
	const lines = gitErrorOutput(error, "stderr").split(/\r?\n/);
	const stderr = lines.find((line) => line.trim().length > 0)?.trim();
	if (stderr !== undefined) {
		// Git names the paths it refuses over on tab-indented lines after the message.
		const paths = lines.filter((line) => line.startsWith("\t")).map((line) => line.trim());
		if (paths.length === 0) return stderr;
		return `${stderr} ${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ` and ${paths.length - 10} more` : ""}`;
	}
	const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
	if (typeof code !== "string") return fallback;
	const cause =
		code === "ENOENT"
			? "Git executable was not found."
			: code === "ETIMEDOUT"
				? "Git exceeded its subprocess timeout."
				: code === "ENOBUFS"
					? "Git exceeded its subprocess output buffer."
					: fallback;
	return `${code}: ${cause}`;
}

export function isCanonicalWorktreePathInside(parent: string, candidate: string): boolean {
	let canonicalParent: string;
	let canonicalCandidate: string;
	try {
		canonicalParent = realpathSync(parent);
	} catch {
		canonicalParent = resolve(parent);
	}
	try {
		canonicalCandidate = realpathSync(candidate);
	} catch {
		canonicalCandidate = resolve(candidate);
	}
	return isStrictDescendant(canonicalCandidate, canonicalParent);
}

/** The checkout's configured value for `key`, or null when it is unset. */
export function configuredGitValue(cwd: string, key: string): string | null {
	try {
		const value = git(cwd, ["config", "--get", key]);
		return value.length > 0 ? value : null;
	} catch {
		// `git config --get` exits 1 for an unset key.
		return null;
	}
}
