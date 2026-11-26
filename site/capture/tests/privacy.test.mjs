// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { plain, privacyHits, scanChunks } from "../privacy.mjs";

const fixture = JSON.parse(readFileSync(new URL("privacy-stream.json", import.meta.url), "utf8"));
const scan = (chunks) => [...scanChunks(chunks), ...scanChunks(chunks.map(plain))];

test("a strict prefix of the sandbox home that ends a chunk is allowed", () => {
	for (const chunks of fixture.allowed) assert.deepEqual(scan(chunks), [], JSON.stringify(chunks));
});

test("every other home path is refused", () => {
	for (const { why, chunks } of fixture.refused)
		assert.ok(
			scan(chunks).some((hit) => hit.startsWith("a home path")),
			why,
		);
});

test("the former repository URL and the operator's name are refused", () => {
	assert.ok(privacyHits("filed at https://github.com/akougkas/pancode/issues/12")[0]?.startsWith("a URL"));
	assert.deepEqual(privacyHits("plugin:wtfp  0.9.0  available  bundled  akougkas verified MIT", ["akougkas"]), [
		"an operator secret or path",
	]);
	assert.deepEqual(privacyHits("Uses your GitHub Copilot subscription as akougkas on github.com", ["akougkas"]), [
		"an operator secret or path",
	]);
});

test("the project's repository URL is allowed; other GitHub URLs are refused", () => {
	assert.deepEqual(privacyHits("see https://github.com/PanStudio/pancode/issues/new", []), []);
	assert.deepEqual(privacyHits("see https://github.com/someone/else", []), [
		'a URL ("https://github.com/someone/else")',
	]);
});
