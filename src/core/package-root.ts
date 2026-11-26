// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The name PanCode is published under on npm. The command, and the package directory inside a bundle, are `pancode`. */
export const PACKAGE_NAME = "@akougkas/pancode";

let cached: string | null = null;
let cachedPancodeVersion: string | null = null;

export function resolvePackageRoot(metaUrl = import.meta.url): string {
	if (cached) return cached;
	const override = process.env.PANCODE_PACKAGE_ROOT?.trim();
	if (override) {
		cached = resolve(override);
		return cached;
	}
	let dir = resolve(dirname(fileURLToPath(metaUrl)));
	while (true) {
		if (existsSync(join(dir, "package.json"))) {
			cached = dir;
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(`Could not find package.json above ${dir}`);
		}
		dir = parent;
	}
}

interface PartialPackageJson {
	version?: string;
	dependencies?: Record<string, string>;
}

function readPackageJson(): PartialPackageJson {
	const root = resolvePackageRoot();
	const raw = readFileSync(join(root, "package.json"), "utf8");
	return JSON.parse(raw) as PartialPackageJson;
}

export function readPancodeVersion(): string {
	if (cachedPancodeVersion) return cachedPancodeVersion;
	const pkg = readPackageJson();
	cachedPancodeVersion = pkg.version ?? "0.0.0";
	return cachedPancodeVersion;
}
