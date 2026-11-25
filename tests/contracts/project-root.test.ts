// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ensureProjectIgnore, pancodeProjectRoot } from "../../src/core/project-root.js";
import { readLayeredSettings } from "../../src/core/settings-layers.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { loadProjectRules, selectActiveRules } from "../../src/domains/context/project-rules.js";
import { fdIgnoreArgs, rgIgnoreArgs } from "../../src/tools/ignore-policy.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

/** A repository with its `.git` marker as a file, the shape of a worktree, which the temp-root git guard allows. */
function repository(root: string): { repo: string; deep: string } {
	const repo = join(root, "repo");
	const deep = join(repo, "packages", "foo");
	mkdirSync(deep, { recursive: true });
	writeFileSync(join(repo, ".git"), "gitdir: /nowhere\n");
	return { repo, deep };
}

test("a project lookup walks to the repository root and no further", async (t) => {
	const env = await isolatePancodeEnv("project-root-");
	t.after(() => env.restore());
	const { repo, deep } = repository(env.dir);
	mkdirSync(join(env.dir, ".pancode", "skills"), { recursive: true });

	strictEqual(pancodeProjectRoot(deep, "skills"), repo, "a missing entry belongs at the repository root");

	mkdirSync(join(repo, ".pancode", "skills"), { recursive: true });
	strictEqual(pancodeProjectRoot(deep, "skills"), repo);

	// Generated files under the subdirectory must not hide the root's configuration.
	mkdirSync(join(deep, ".pancode", "runs"), { recursive: true });
	strictEqual(pancodeProjectRoot(deep, "skills"), repo);

	mkdirSync(join(deep, ".pancode", "skills"), { recursive: true });
	strictEqual(pancodeProjectRoot(deep, "skills"), deep, "the nearest entry wins");
});

test("a rule's paths stay rooted at the directory holding the rule", async (t) => {
	const env = await isolatePancodeEnv("project-root-");
	t.after(() => env.restore());
	const { repo, deep } = repository(env.dir);
	mkdirSync(join(repo, ".pancode", "rules"), { recursive: true });
	writeFileSync(join(repo, ".pancode", "rules", "foo.md"), '---\npaths: ["packages/foo/**"]\n---\nFoo rule.\n');
	const { rules } = loadProjectRules(deep);
	strictEqual(
		selectActiveRules(rules, ["src/index.ts"]).length,
		1,
		"a path under the session's cwd is under the rule's",
	);
	strictEqual(selectActiveRules(loadProjectRules(repo).rules, ["src/index.ts"]).length, 0);
});

test("the project ignore file shows Git what an operator authors and nothing else", async (t) => {
	const env = await isolatePancodeEnv("project-root-");
	t.after(() => env.restore());
	const repo = join(env.dir, "repo");
	mkdirSync(repo);
	const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	strictEqual(git("init", "--quiet").status, 0);
	ensureProjectIgnore(repo);
	const write = (entry: string) => {
		const file = join(repo, ".pancode", entry);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, "x\n");
	};
	for (const generated of ["runs/1/stdout.log", "codemap.json", "state.json", "exports/a.html", "some-new-thing.json"])
		write(generated);
	strictEqual(git("status", "--porcelain", "--untracked-files=all").stdout, "", "generated files are invisible");

	const authored = [
		"agents/a.md",
		"mcp.yaml",
		"quality.yaml",
		"rules/deep/r.md",
		"safety.yaml",
		"settings.yaml",
		"skills/s/SKILL.md",
		"validation.yaml",
	];
	for (const entry of [...authored, "settings.local.yaml", "rules/x.local.yaml"]) write(entry);
	deepStrictEqual(
		git("status", "--porcelain", "--untracked-files=all")
			.stdout.trim()
			.split("\n")
			.map((line) => line.slice(3).replace(".pancode/", ""))
			.sort(),
		authored,
	);

	// The ignore file hides these from Git, not from a search that asked for them.
	for (const args of [rgIgnoreArgs, fdIgnoreArgs]) {
		strictEqual(args(join(repo, ".pancode", "runs"), false).includes("--no-ignore"), true);
		strictEqual(args(repo, false).includes("--no-ignore"), false);
	}

	writeFileSync(join(repo, ".pancode", ".gitignore"), "# mine\n");
	ensureProjectIgnore(repo);
	strictEqual(readFileSync(join(repo, ".pancode", ".gitignore"), "utf8"), "# mine\n", "an existing file is kept");
});

test("outside a repository only the working directory counts", async (t) => {
	const env = await isolatePancodeEnv("project-root-");
	t.after(() => env.restore());
	const parent = join(env.dir, "plain");
	const child = join(parent, "child");
	mkdirSync(child, { recursive: true });
	mkdirSync(join(parent, ".pancode", "skills"), { recursive: true });
	strictEqual(pancodeProjectRoot(child, "skills"), child);
	strictEqual(pancodeProjectRoot(parent, "skills"), parent);
});

test("a subdirectory session reads the root's settings under the root's approval", async (t) => {
	const env = await isolatePancodeEnv("project-root-");
	t.after(() => env.restore());
	const { repo, deep } = repository(env.dir);
	mkdirSync(join(repo, ".pancode"), { recursive: true });
	writeFileSync(join(repo, ".pancode", "settings.yaml"), "interface:\n  exitSummary: off\n");

	const review = captureProjectSurface(repo, "settings");
	if (review.contentHash === null) throw new Error("the surface must hash");
	recordProjectSurfaceTrust(repo, "settings", review.contentHash);

	const fromSubdirectory = captureProjectSurface(deep, "settings");
	strictEqual(fromSubdirectory.workspaceRoot, realpathSync(repo));
	strictEqual(fromSubdirectory.verdict, "trusted");
	const layered = readLayeredSettings(deep);
	strictEqual(layered.settings.interface.exitSummary, "off");
	strictEqual(layered.sources["interface.exitSummary"], "project");
});
