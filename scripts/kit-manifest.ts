// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `pnpm kit:manifest` writes packages/kit/servers.json, the PanKit policy
 * PanCode ships, from the kit's server registry, and each server's entry as
 * hub/packs/servers/<id>/server.json, the core server pack PanHub lists.
 * `pnpm kit:check` fails when a tracked file is not what the registry
 * generates. The files are formatted the way `biome check` wants them, so lint
 * and the check agree.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { kitManifest, manifestText } from "../packages/kit/src/manifest.js";

const root = path.resolve(import.meta.dirname, "..");
const checkMode = process.argv.includes("--check");
const serverPacks = "hub/packs/servers";

const biome = path.join(
	path.dirname(createRequire(import.meta.url).resolve("@biomejs/biome/package.json")),
	"bin",
	"biome",
);
function format(relative: string, text: string): string {
	const formatted = spawnSync(process.execPath, [biome, "format", `--stdin-file-path=${relative}`], {
		cwd: root,
		input: text,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (formatted.error !== undefined || formatted.status !== 0) {
		process.stderr.write(`kit-manifest: could not format ${relative}: ${formatted.error?.message ?? formatted.stderr}\n`);
		process.exit(1);
	}
	return formatted.stdout;
}

const manifest = await kitManifest();
const files = new Map<string, string>([
	["packages/kit/servers.json", format("packages/kit/servers.json", manifestText(manifest))],
]);
for (const server of manifest.servers) {
	const relative = `${serverPacks}/${server.id}/server.json`;
	files.set(relative, format(relative, `${JSON.stringify(server, null, "\t")}\n`));
}

const problems: string[] = [];
const ids = new Set(manifest.servers.map((server) => server.id));
for (const id of existsSync(path.join(root, serverPacks)) ? readdirSync(path.join(root, serverPacks)) : [])
	if (!ids.has(id)) problems.push(`${serverPacks}/${id} is not a server in the PanKit registry; remove it`);
for (const id of ids)
	if (!existsSync(path.join(root, serverPacks, id, "plugin.json")))
		problems.push(`${serverPacks}/${id}/plugin.json is missing; write it by hand beside server.json`);

if (checkMode) {
	for (const [relative, content] of files) {
		const destination = path.join(root, relative);
		if (!existsSync(destination) || readFileSync(destination, "utf8") !== content)
			problems.push(`${relative} is stale; run pnpm kit:manifest and commit the result`);
	}
} else {
	for (const [relative, content] of files) {
		mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
		writeFileSync(path.join(root, relative), content);
	}
}
for (const problem of problems) process.stderr.write(`kit-manifest: ${problem}\n`);
if (problems.length > 0) process.exit(1);
process.stdout.write(
	`${checkMode ? "Verified" : "Wrote"} packages/kit/servers.json and ${ids.size} ${serverPacks}/<id>/server.json: ${manifest.servers.length} PanKit servers.\n`,
);
