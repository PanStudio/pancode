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

test("the project's repository URL is allowed; another repository URL and the operator's name are refused", () => {
	assert.deepEqual(privacyHits("filed at https://github.com/PanStudio/pancode/issues/12", ["akougkas"]), []);
	assert.ok(privacyHits("filed at https://github.com/akougkas/pancode/issues/12")[0]?.startsWith("a URL"));
	assert.deepEqual(privacyHits("Uses your GitHub Copilot subscription as akougkas on github.com", ["akougkas"]), [
		"an operator secret or path",
	]);
});
