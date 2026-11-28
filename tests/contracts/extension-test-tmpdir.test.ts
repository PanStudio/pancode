// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { equal, notEqual, ok } from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { scaffoldExtension } from "../../src/domains/extensions/authoring/scaffold.js";
import { testExtensionPackage } from "../../src/domains/extensions/authoring/test-runner.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

test("extensions test gives package tests a temp directory the run owns and removes", async (t) => {
	const env = await isolatePancodeEnv("pancode-extension-test-tmpdir-");
	t.after(() => env.restore());
	const root = path.join(env.dir, "pkg");
	mkdirSync(root);
	const record = path.join(env.dir, "seen-tmpdir.txt");
	writeFileSync(
		path.join(root, "tmp.test.ts"),
		[
			'import { writeFileSync, existsSync } from "node:fs";',
			'import { test } from "node:test";',
			'test("tmpdir", () => {',
			"\tconst dir = process.env.TMPDIR ?? '';",
			"\tif (!existsSync(dir)) throw new Error('no TMPDIR');",
			`\twriteFileSync(${JSON.stringify(record)}, dir);`,
			"});",
			"",
		].join("\n"),
	);
	equal(await testExtensionPackage(root), 0);
	const seen = readFileSync(record, "utf8");
	ok(seen.startsWith(path.join(tmpdir(), "pancode-extension-test-")), seen);
	notEqual(seen, tmpdir());
	equal(existsSync(seen), false);
});

/** Package directories under `parent` that carry their own `*.test.ts` runtime tests. */
function packagesWithTests(parent: string): string[] {
	return readdirSync(parent, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(parent, entry.name))
		.filter((dir) =>
			readdirSync(dir, { recursive: true, withFileTypes: true }).some(
				(entry) => entry.isFile() && entry.name.endsWith(".test.ts"),
			),
		);
}

test("the hub extension packs, examples and scaffold templates pass their own tests", {
	concurrency: true,
}, async (t) => {
	const env = await isolatePancodeEnv("pancode-extension-package-tests-");
	t.after(() => env.restore());
	const root = resolvePackageRoot();
	const packages = [
		...packagesWithTests(path.join(root, "hub/packs/extensions")),
		...packagesWithTests(path.join(root, "examples/extensions")),
		...readdirSync(path.join(root, "src/domains/extensions/authoring/templates")).map((template) =>
			scaffoldExtension(`template-${template}`, { template, dir: path.join(env.dir, template), workspace: env.dir }),
		),
	];
	ok(packages.length >= 8, packages.join(", "));
	await Promise.all(
		packages.map((dir) =>
			t.test(
				path.relative(env.dir, dir).startsWith("..") ? path.relative(root, dir) : `template ${path.basename(dir)}`,
				async () => equal(await testExtensionPackage(dir), 0),
			),
		),
	);
});
