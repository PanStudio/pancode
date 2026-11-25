// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Which files under src/ and each workspace package's packages/<name>/src/ ship
 * loose and which ship inside dist/assets/source.pack. Paths are package-root
 * relative (`src/core/x.ts`, `packages/store/src/local.ts`).
 *
 * Loose: every file that is not `.ts` (prompt fragments, recipes, playbooks,
 * the extension child `.mjs` files, yazi assets, notices) and the extension
 * scaffold templates (copied as a directory). Everything else packs. The
 * public extension types need no loose source: the scaffold's tsconfig paths
 * name the bundled declarations under dist/sdk/, which tsup builds
 * (tsup.config.ts `dts`).
 *
 * Shared by scripts/build-source-pack.ts, which writes the pack and the
 * .npmignore in each source root that keeps packed files out of the tarball, and by
 * scripts/check-release.mjs, which holds the tarball against this plan.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const TEMPLATES_PREFIX = "src/domains/extensions/authoring/templates/";

function toPosix(path) {
	return path.split("\\").join("/");
}

/** The package-relative source roots: `src` and every `packages/<name>/src`, sorted. */
export function sourceRoots(root) {
	const packages = join(root, "packages");
	const workspace = existsSync(packages)
		? readdirSync(packages, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && existsSync(join(packages, entry.name, "src")))
				.map((entry) => `packages/${entry.name}/src`)
		: [];
	return ["src", ...workspace].sort();
}

function listSourceFiles(root) {
	return sourceRoots(root)
		.flatMap((sourceRoot) =>
			readdirSync(join(root, sourceRoot), { recursive: true, withFileTypes: true })
				.filter((entry) => entry.isFile() && entry.name !== ".npmignore")
				.map((entry) => toPosix(relative(root, join(entry.parentPath, entry.name)))),
		)
		.sort();
}

export function planSourcePack(root) {
	const loose = [];
	const packed = [];
	for (const file of listSourceFiles(root)) {
		if (!file.endsWith(".ts") || file.startsWith(TEMPLATES_PREFIX)) loose.push(file);
		else packed.push(file);
	}
	return { loose, packed };
}

/** The member paths of a built pack, parsed the way src/core/source-pack.ts reads it. */
export function readSourcePackMembers(packFile) {
	const bytes = readFileSync(packFile);
	if (bytes.toString("latin1", 0, 8) !== "PANSRC01") throw new Error(`not a source pack: ${packFile}`);
	const indexLength = bytes.readUInt32LE(8);
	const index = JSON.parse(bytes.toString("utf8", 12, 12 + indexLength));
	return index.files.map((entry) => entry.path);
}
