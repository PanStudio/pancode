// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processBirthToken } from "../../src/core/process-identity.js";
import { missingBuildFiles, staleRunningBuilds } from "../../src/core/running-build.js";
import { makeScratchHome } from "../harness/scratch-env.js";

function fixture() {
	const home = makeScratchHome("pancode-lifecycle-cleanup-");
	const state = join(home.dir, "state");
	const history = join(state, "session-fixture.json");
	const root = join(home.dir, "terminal-only-package");
	mkdirSync(join(state, "gui"), { recursive: true });
	mkdirSync(root);
	writeFileSync(join(root, "package.json"), '{"name":"pancode","version":"0.5.4"}');
	writeFileSync(history, "history must survive previews and failures");
	writeFileSync(join(state, "home.json"), "{}\n");
	function run(command: "reset" | "uninstall", args: string[]) {
		const functionName = command === "reset" ? "runResetCommand" : "runUninstallCommand";
		const argv = command === "reset" && !args.includes("--all") ? ["--state", ...args] : args;
		return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) =>
			execFile(
				process.execPath,
				[
					"--import",
					import.meta.resolve("tsx"),
					"--input-type=module",
					"-e",
					`
			import { ${functionName} } from ${JSON.stringify(new URL(`../../src/cli/${command}.ts`, import.meta.url).href)};
			process.exitCode = await ${functionName}(${JSON.stringify(argv)});`,
				],
				{
					env: {
						...process.env,
						...home.env,
						PANCODE_PACKAGE_ROOT: root,
						HOME: home.dir,
						XDG_DATA_HOME: join(home.dir, "desktop"),
					},
					encoding: "utf8",
					timeout: 20_000,
				},
				(error, stdout, stderr) =>
					resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
			),
		);
	}
	return { home, state, history, root, run };
}

test("reset refuses to orphan a background service when its ownership cannot be checked", async (t) => {
	const f = fixture();
	t.after(f.home.cleanup);
	const directory = join(f.state, "gui/background");
	mkdirSync(directory);
	writeFileSync(join(directory, "owner.json"), "{}");
	const preview = await f.run("reset", ["--all", "--dry-run", "--json"]);
	assert.equal(preview.status, 0, preview.stderr + preview.stdout);
	assert.ok(existsSync(f.history));
	const result = await f.run("reset", ["--all", "--yes", "--json"]);
	assert.equal(result.status, 1, result.stderr + result.stdout);
	assert.ok(existsSync(f.history));
	assert.ok(existsSync(join(directory, "owner.json")));
});

test("doctor detects missing checkout chunks and a live process from another build", async (t) => {
	const f = fixture();
	t.after(f.home.cleanup);
	const root = join(f.state, "checkout");
	mkdirSync(join(root, "dist"), { recursive: true });
	writeFileSync(join(root, "dist/build.json"), JSON.stringify({ id: "new-build", files: ["chunk.js"] }));
	assert.deepEqual(missingBuildFiles(root), ["dist/chunk.js"]);
	writeFileSync(join(root, "dist/chunk.js"), "export {};\n");
	assert.deepEqual(missingBuildFiles(root), []);
	const records = join(f.state, "running-builds");
	mkdirSync(records);
	writeFileSync(
		join(records, `${process.pid}.json`),
		JSON.stringify({
			pid: process.pid,
			host: hostname(),
			birth: processBirthToken(),
			root,
			build: "old-build",
			surface: "tui",
		}),
	);
	assert.ok(staleRunningBuilds(f.state).some((entry) => entry.pid === process.pid && entry.root === root));
	writeFileSync(
		join(records, `${process.pid}.json`),
		JSON.stringify({
			pid: process.pid,
			host: hostname(),
			birth: processBirthToken(),
			root,
			build: "new-build",
			surface: "tui",
		}),
	);
	assert.equal(
		staleRunningBuilds(f.state).some((entry) => entry.pid === process.pid),
		false,
	);
});
