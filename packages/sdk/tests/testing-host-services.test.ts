// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionCompletionRequest } from "../src/extension/index.js";
import { createExtensionTestHost } from "../src/testing/index.js";

/** A package whose command reports what the test host's context gave it. */
function writePackage(services: Record<string, unknown> | undefined): string {
	const root = mkdtempSync(path.join(tmpdir(), "sdk-host-services-"));
	writeFileSync(
		path.join(root, "pancode-extension.json"),
		JSON.stringify({
			id: "scribe",
			version: "1.0.0",
			description: "Writes with a model",
			runtime: { api: 2, entrypoint: "extension.mjs", commands: [{ name: "go", description: "Go" }], services },
		}),
	);
	writeFileSync(
		path.join(root, "extension.mjs"),
		`export default (api) => {
	api.handle("go", async (args, ctx) => {
		if (args === "members") return { text: [typeof ctx.complete, typeof ctx.blobs].join(" ") };
		if (args === "write") {
			const done = await ctx.blobs.put("drafts", "a.md", "a.md", { note: "first" });
			return { text: String(done.bytes) };
		}
		if (args === "steal") return { text: String((await ctx.blobs.get("secrets", "k")) === null) };
		const reply = await ctx.complete({ system: "be brief", messages: [{ role: "user", text: args }], maxOutputTokens: 50 });
		return { text: reply.text + " " + reply.stopReason + " " + reply.usage.outputTokens };
	});
};
`,
	);
	return root;
}

test("the test host gives a package only the services its manifest declares", async (t) => {
	const root = writePackage(undefined);
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const host = await createExtensionTestHost(root, {
		complete: () => ({ text: "x", stopReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }),
	});
	t.after(() => host.dispose());
	assert.equal((await host.command("go", "members")).text, "undefined undefined");
});

test("the test host's fake model and store see validated requests limited to the declared tags", async (t) => {
	const root = writePackage({
		model: { sessionTokens: 1000, maxOutputTokens: 100 },
		store: { read: [], write: ["drafts"] },
	});
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const seen: ExtensionCompletionRequest[] = [];
	const puts: string[] = [];
	const host = await createExtensionTestHost(root, {
		complete: (request) => {
			seen.push(request);
			return { text: "short", stopReason: "length", usage: { inputTokens: 4, outputTokens: 50 } };
		},
		blobs: {
			list: async () => ({ names: [], hasMore: false }),
			stat: async () => null,
			get: async () => null,
			put: async (tag, blob, _source, options) => {
				puts.push(`${tag}:${blob}:${options?.note}`);
				return { bytes: 3, sha256: "0".repeat(64) };
			},
		},
	});
	t.after(() => host.dispose());
	assert.equal((await host.command("go", "members")).text, "function object");
	assert.equal((await host.command("go", "hello")).text, "short length 50");
	assert.deepEqual(seen, [{ system: "be brief", messages: [{ role: "user", text: "hello" }], maxOutputTokens: 50 }]);
	assert.equal((await host.command("go", "write")).text, "3");
	assert.deepEqual(puts, ["drafts:a.md:first"]);
	await assert.rejects(host.command("go", "steal"), /not approved/u);
});

test("a declared service with no fake rejects naming the missing fake", async (t) => {
	const root = writePackage({ model: { sessionTokens: 1000, maxOutputTokens: 100 } });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const host = await createExtensionTestHost(root);
	t.after(() => host.dispose());
	await assert.rejects(host.command("go", "hello"), /no complete fake/u);
});
