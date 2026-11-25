// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const site = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(site, "hub-catalog.mjs");
const index = readFileSync(join(site, "..", "hub", "index.yaml"), "utf8");
const catalog = readFileSync(join(site, "content", "hub-catalog.json"), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "hub-catalog-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function run(...args) {
	const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
function fixture(name, text) {
	const file = join(scratch, name);
	writeFileSync(file, text);
	return file;
}

test("the committed catalog lists every row of the bundled index and --check passes", () => {
	const rows = JSON.parse(catalog).rows;
	const names = [...index.matchAll(/^ {2}- kind: (\S+)\n {4}publisher: \S+\n {4}name: (\S+)$/gm)]
		.map(([, kind, name]) => `${kind}:${name}`)
		.sort();
	assert.ok(names.length > 0);
	assert.deepEqual(rows.map((row) => `${row.kind}:${row.name}`).sort(), names);
	for (const row of rows) assert.equal(row.install, `pancode hub install ${row.kind}:${row.name}`);
	const result = run("--check");
	assert.equal(result.status, 0, result.output);
});

test("--check fails when the catalog or the index changes", () => {
	const edited = fixture("edited.json", catalog.replace(/"version": "[^"]+"/, '"version": "9.9.9"'));
	const catalogResult = run("--check", "--catalog", edited);
	assert.equal(catalogResult.status, 1);
	assert.match(catalogResult.output, /hub-catalog: refused: .*differs from hub\/index\.yaml/);
	const moved = fixture("moved.yaml", index.replace(/^( {4}version: )\S+/m, "$19.9.9"));
	const indexResult = run("--check", "--index", moved);
	assert.equal(indexResult.status, 1);
	assert.match(indexResult.output, /differs from hub\/index\.yaml/);
});

test("a row the PanHub validator rejects is refused by name", () => {
	const foreign = fixture(
		"foreign.yaml",
		index.replace("    publisher: pancode\n    name: architecture\n", "    publisher: someone\n    name: architecture\n"),
	);
	const output = join(scratch, "never.json");
	const result = run("--index", foreign, "--catalog", output);
	assert.equal(result.status, 1);
	assert.match(result.output, /^hub-catalog: refused: .*architecture/m);
	assert.throws(() => readFileSync(output));
});

test("a revoked digest leaves the catalog", () => {
	const sha = index.match(/name: architecture\n[\s\S]*?sha256: ([0-9a-f]{64})/)[1];
	const revoked = fixture(
		"revoked.yaml",
		index.replace(/^revoked: \[\]$/m, `revoked:\n  - sha256: ${sha}\n    reason: test\n    date: 2026-01-01`),
	);
	const output = join(scratch, "revoked.json");
	const result = run("--index", revoked, "--catalog", output);
	assert.equal(result.status, 0, result.output);
	const derived = JSON.parse(readFileSync(output, "utf8"));
	assert.equal(derived.source.revoked, 1);
	assert.ok(!derived.rows.some((row) => row.name === "architecture" && row.kind === "skill"));
});
