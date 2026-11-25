// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { readJsonObjectFile } from "./json-file.js";

export interface PancodeRepoAwareness {
	isPancodeRepo: boolean;
	repoRoot: string | null;
}

interface PackageJsonShape {
	name?: unknown;
	repository?: unknown;
}

const PANCODE_PACKAGE_NAME = "pancode";

/** Only these authoring skills become native discovery in PanCode's own checkout. */
export const PANCODE_SELF_DEVELOPMENT_SKILLS = ["pancode-dev", "pancode-test"] as const;

const SOURCE_MARKERS = [
	"src/entry/orchestrator.ts",
	"src/worker/entry.ts",
	"src/domains/prompts/fragments/identity/pancode.md",
] as const;

function isFile(filePath: string): boolean {
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function readPackageJson(root: string): PackageJsonShape | null {
	return readJsonObjectFile(path.join(root, "package.json")) as PackageJsonShape | null;
}

function repositoryMatches(value: unknown): boolean {
	if (typeof value === "string") return value.includes("akougkas/pancode");
	if (!value || typeof value !== "object") return false;
	const url = (value as { url?: unknown }).url;
	return typeof url === "string" && url.includes("akougkas/pancode");
}

function hasGitMarker(root: string): boolean {
	return existsSync(path.join(root, ".git"));
}

function hasSourceMarkers(root: string): boolean {
	return SOURCE_MARKERS.every((marker) => isFile(path.join(root, marker)));
}

function isPancodeRepoRoot(root: string): boolean {
	const pkg = readPackageJson(root);
	if (pkg?.name !== PANCODE_PACKAGE_NAME) return false;
	if (!repositoryMatches(pkg.repository)) return false;
	if (!hasGitMarker(root)) return false;
	return hasSourceMarkers(root);
}

export function detectPancodeRepo(cwd = process.cwd()): PancodeRepoAwareness {
	let current = path.resolve(cwd);
	for (;;) {
		if (isPancodeRepoRoot(current)) {
			return { isPancodeRepo: true, repoRoot: current };
		}
		// The session's own repository wins: the walk ends at the first git
		// root, so a project nested under a pancode checkout never
		// inherits the source-tree awareness fragment.
		if (hasGitMarker(current)) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return { isPancodeRepo: false, repoRoot: null };
}
