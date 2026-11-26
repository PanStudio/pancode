// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `pnpm kit:manifest` writes packages/kit/servers.json, the policy PanCode
 * ships for its built-in MCP servers, from the kit's server registry; `pnpm kit:check` fails when
 * the tracked file is not what the registry generates. The file is formatted
 * the way `biome check` wants it, so lint and the check agree.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { kitManifest, manifestText } from "../packages/kit/src/manifest.js";

const root = path.resolve(import.meta.dirname, "..");
const relativeDestination = "packages/kit/servers.json";
const destination = path.join(root, relativeDestination);
const checkMode = process.argv.includes("--check");

const biome = path.join(
	path.dirname(createRequire(import.meta.url).resolve("@biomejs/biome/package.json")),
	"bin",
	"biome",
);
const formatted = spawnSync(process.execPath, [biome, "format", `--stdin-file-path=${relativeDestination}`], {
	cwd: root,
	input: manifestText(await kitManifest()),
	encoding: "utf8",
	maxBuffer: 64 * 1024 * 1024,
});
if (formatted.error !== undefined || formatted.status !== 0) {
	process.stderr.write(`kit-manifest: could not format the manifest: ${formatted.error?.message ?? formatted.stderr}\n`);
	process.exit(1);
}
const content = formatted.stdout;
const servers = (JSON.parse(content) as { servers: unknown[] }).servers.length;

if (checkMode) {
	if (!existsSync(destination) || readFileSync(destination, "utf8") !== content) {
		process.stderr.write(`${relativeDestination} is stale; run pnpm kit:manifest and commit the result.\n`);
		process.exit(1);
	}
	process.stdout.write(`Verified ${relativeDestination}: ${servers} built-in MCP servers.\n`);
} else {
	writeFileSync(destination, content);
	process.stdout.write(`Wrote ${relativeDestination}: ${servers} built-in MCP servers.\n`);
}
