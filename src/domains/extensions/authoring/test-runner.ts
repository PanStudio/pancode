// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePackageRoot } from "../../../core/package-root.js";
import { runCommandVector } from "../../../core/safe-exec.js";
import { pancodeCacheDir, pancodeConfigDir, pancodeDataDir, pancodeStateDir } from "../../../core/xdg.js";

export async function testExtensionPackage(root: string): Promise<number> {
	const path = realpathSync(root);
	const files = readdirSync(path, { recursive: true, withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() &&
				entry.name.endsWith(".test.ts") &&
				!join(entry.parentPath, entry.name)
					.slice(path.length + 1)
					.split(/[\\/]/)
					.some((part) => part === "node_modules" || part === ".git"),
		)
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
	if (files.length === 0) throw new Error(`no **/*.test.ts files in ${path}`);
	// Package tests get a temp directory this run owns and removes, so a test
	// that reads TMPDIR works where the caller's environment has none, and no
	// run leaves files in a shared temp root.
	const scratch = mkdtempSync(join(tmpdir(), "pancode-extension-test-"));
	try {
		return await runPackageTests(path, files, scratch);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

async function runPackageTests(path: string, files: ReadonlyArray<string>, scratch: string): Promise<number> {
	const result = await runCommandVector(
		process.execPath,
		[
			"--experimental-strip-types",
			"--import",
			join(resolvePackageRoot(), "src/domains/extensions/authoring/test-register.mjs"),
			"--test",
			...files,
		],
		{
			cwd: path,
			workspaceRoot: path,
			timeoutMs: 120000,
			env: {
				TMPDIR: scratch,
				TMP: scratch,
				TEMP: scratch,
				PANCODE_CONFIG_DIR: pancodeConfigDir(),
				PANCODE_DATA_DIR: pancodeDataDir(),
				PANCODE_STATE_DIR: pancodeStateDir(),
				PANCODE_CACHE_DIR: pancodeCacheDir(),
				...(process.env.PANCODE_HOME === undefined ? {} : { PANCODE_HOME: process.env.PANCODE_HOME }),
			},
			output: { onStdout: (chunk) => process.stdout.write(chunk), onStderr: (chunk) => process.stderr.write(chunk) },
		},
	);
	if (result.failure || result.timedOut || result.aborted || result.sinkError) {
		process.stderr.write(
			`extension tests did not complete: ${result.failure ?? result.sinkError ?? (result.timedOut ? "timed out" : "aborted")}\n`,
		);
	}
	return result.exitCode ?? 1;
}
