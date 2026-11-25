// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { execFileSync } from "node:child_process";
import { relative } from "node:path";
import { internalGitArgv } from "../../core/internal-git.js";
import type { AdoptionScanResult } from "./adoption.js";

export function gitOutput(cwd: string, args: ReadonlyArray<string>): string | null {
	try {
		return execFileSync("git", internalGitArgv(args, cwd), {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch {
		return null;
	}
}

/**
 * Project context sources Git does not track, when the handbook itself will
 * be committed. Those sources are private to this checkout (a gitignored
 * `.claude/CLAUDE.md`, an untracked personal `AGENTS.md`), and folding them
 * into a tracked PANCODE.md published one maintainer's machine paths, hosts
 * and private routing to every contributor. An ignored handbook stays local
 * and may still draw on them; outside Git nothing is shared, so nothing is withheld.
 */
export function uncommittedContextSources(cwd: string, adoption: AdoptionScanResult): string[] {
	const project = adoption.sources.filter((source) => source.scope === "project");
	if (project.length === 0) return [];
	const top = gitOutput(cwd, ["rev-parse", "--show-toplevel"])?.trim();
	if (!top) return [];
	// `check-ignore` prints the path when a rule ignores it; an ignored handbook is not shared.
	if ((gitOutput(cwd, ["check-ignore", "--", "PANCODE.md"]) ?? "").trim().length > 0) return [];
	const listed = gitOutput(top, ["ls-files", "-z", "--full-name"]);
	if (listed === null) return [];
	const tracked = new Set(listed.split("\0").filter((path) => path.length > 0));
	return project
		.map((source) => source.path)
		.filter((path) => {
			const rel = relative(top, path).split("\\").join("/");
			return rel.startsWith("../") || !tracked.has(rel);
		});
}

export function gitStatus(cwd: string): string {
	try {
		return execFileSync("git", internalGitArgv(["status", "--short"], cwd), {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return "";
	}
}

export function countStatusLines(status: string): number {
	return status
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean).length;
}
