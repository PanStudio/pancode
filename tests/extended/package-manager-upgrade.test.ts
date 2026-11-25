// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { doesNotMatch, match, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { makeScratchHome } from "../harness/scratch-env.js";

test("post-install upgrade previews the local refresh without registry lookup or package replacement", () => {
	const home = makeScratchHome("pancode-manager-upgrade-");
	try {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx"),
				"--input-type=module",
				"-e",
				`import { runUpgradeCommand } from ${JSON.stringify(new URL("../../src/cli/upgrade.ts", import.meta.url).href)};
			process.exitCode = await runUpgradeCommand(["--post-install", "--dry-run"], {
				lookUpAvailableVersion: async () => { throw new Error("post-install must not query the registry"); },
				runNpmInstall: async () => { throw new Error("post-install must not replace the package"); },
			});`,
			],
			{
				env: { ...process.env, ...home.env },
				encoding: "utf8",
				timeout: 10_000,
			},
		);
		strictEqual(result.status, 0, result.stderr);
		match(result.stdout, /Available version: not checked \(post-install checks\)/);
		match(result.stdout, /Would refresh state metadata/);
		doesNotMatch(result.stdout, /Would run: npm|99\.0\.0|npm global/);
	} finally {
		home.cleanup();
	}
});
