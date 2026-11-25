// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { helpContent } from "../client/interaction/help-model.js";
import { PUBLIC_GUIDES, PUBLIC_HELP, publicGuideUrl } from "../client/interaction/public-help.js";
import { harness } from "./harness/app.js";

(globalThis as { React?: typeof React }).React = React;
register(
	`data:text/javascript,${encodeURIComponent('export async function load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); }')}`,
);
const { HelpReferenceBody, HelpEntries } = await import("../client/interaction/HelpDialog.js");

test("Help links only the guides the website publishes", async () => {
	const catalog = JSON.parse(await readFile(new URL("../../../site/public-docs.json", import.meta.url), "utf8")) as {
		path: string;
	}[];
	assert.deepEqual(
		PUBLIC_GUIDES.map((name) => `guide/${name}.md`).sort(),
		catalog
			.map((page) => page.path)
			.filter((path) => path !== "README.md")
			.sort(),
	);
	// Every page the site renders links to the URL site/build.mjs gives it.
	for (const name of PUBLIC_GUIDES)
		assert.equal(publicGuideUrl(name), `https://pancode.dev/docs/guide/${name}.html`, name);
	assert.equal(publicGuideUrl("missing"), PUBLIC_HELP);
});

test("Help opens with its guide, keeps shortcuts one view away and offline retrieval in Documentation", () => {
	const opening = renderToStaticMarkup(<HelpReferenceBody bundledDocsPath="/installed/pancode/docs" />);
	// Topics are tabs: one tab stop on the selected topic, the rest reached with the arrow keys.
	assert.match(opening, /role="tablist" aria-label="Help topics"/u);
	assert.match(opening, /role="tab" aria-selected="true"[^>]*tabindex="0"[^>]*>Using PanCode/u);
	assert.match(opening, /role="tab" aria-selected="false"[^>]*tabindex="-1"[^>]*>Shortcuts/u);
	assert.match(opening, /role="tabpanel" aria-labelledby=/u);
	assert.ok(
		helpContent("", "shortcuts").shortcuts.some((group) => group.bindings.some((binding) => binding.id === "palette")),
	);
	assert.doesNotMatch(opening, /\/installed\/pancode\/docs|pancode_docs/u);
	const documentation = helpContent("", "documentation").sections.find((match) => match.section.id === "documentation");
	assert.ok(documentation);
	const html = renderToStaticMarkup(<HelpEntries match={documentation} bundledDocsPath="/installed/pancode/docs" />);
	assert.match(html, /href="https:\/\/pancode\.dev\/docs\.html"/u);
	assert.match(html, /rel="noopener noreferrer"/u);
	assert.match(html, /referrerPolicy="no-referrer"/iu);
	assert.match(html, /\/installed\/pancode\/docs/u);
	assert.match(html, /pancode_docs/u);
	assert.doesNotMatch(html, /iframe|\/api\/docs|#token=/u);
});

test("meta names the bundled docs directory for offline reading", async (t) => {
	const h = await harness();
	t.after(h.close);
	const meta = await (await h.request("/api/meta")).json();
	assert.match(meta.bundledDocsPath, /[/\\]docs$/u);
});

test("Help prints the terminal's Alt chords and every terminal name the app answers", () => {
	const shortcuts = helpContent("", "shortcuts").shortcuts.flatMap((group) => group.bindings);
	for (const [id, keys] of [
		["hub", "Alt + L"],
		["overview", "Alt + U"],
		["workers", "Alt + W"],
		["mentionFile", "Alt + E"],
		["queue", "Alt + Q"],
		["newLine", "Ctrl/Cmd + J"],
	])
		assert.ok(
			shortcuts.some((row) => row.id === id && row.keys === keys),
			`${keys} is missing from the Shortcuts view`,
		);
	const commands = helpContent("", "guide").sections.find((match) => match.section.id === "commands");
	assert.ok(commands);
	const terms = commands.entries.map((entry) => entry.term).join(" ");
	for (const name of ["/btw [question]", "/draft [request]", "/reload", "/view", "/files", "/trust", "/restart"])
		assert.ok(terms.includes(name), `${name} is missing from the command reference`);
	const html = renderToStaticMarkup(<HelpEntries match={commands} bundledDocsPath="/installed/pancode/docs" />);
	assert.match(html, /\/music/u);
});
