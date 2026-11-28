// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildCustomizationGraph } from "../../src/cli/config-inspect.js";
import { settingsPath, updateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { initializePancodeHome } from "../../src/core/init.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

test("config inspection includes effective safety limits for defaults and configured values", async () => {
	const scratch = await isolatePancodeEnv("pancode-inspect-limits-");
	try {
		const workspace = join(scratch.dir, "workspace");
		mkdirSync(workspace);
		const limits = () => buildCustomizationGraph(workspace).entries.find((entry) => entry.id === "safety.limits");
		const defaults = limits();
		ok(defaults);
		deepStrictEqual(defaults.detail, DEFAULT_SETTINGS.safety.limits);
		strictEqual(defaults.reloadClass, "next-turn");
		updateSettings((settings) => {
			settings.safety.limits.workerResponseSeconds = 321;
			return settings;
		});
		const configured = JSON.parse(JSON.stringify(limits()));
		strictEqual(configured.detail.workerResponseSeconds, 321);
		strictEqual(configured.detail.readBytesPerCall, DEFAULT_SETTINGS.safety.limits.readBytesPerCall);
	} finally {
		scratch.restore();
	}
});

test("config inspection says what a worker thinking level of off does, and lists it only where a layer set it (bt-20)", async () => {
	const scratch = await isolatePancodeEnv("pancode-inspect-thinking-");
	try {
		const workspace = join(scratch.dir, "workspace");
		mkdirSync(workspace);
		const thinkingRow = () =>
			buildCustomizationGraph(workspace).settings.find((entry) => entry.key === "fleet.default.thinkingLevel");
		// Setup seeds only the version, so the built-in off is no layer's setting.
		initializePancodeHome();
		strictEqual(thinkingRow(), undefined);
		writeFileSync(settingsPath(), "version: 2\nfleet:\n  default:\n    thinkingLevel: off\n");
		const row = thinkingRow();
		strictEqual(row?.value, "off");
		strictEqual(row.source, "user");
		const note = row.note ?? "";
		ok(note.includes("a route that cannot turn thinking off runs at its default or lowest level"), note);
		ok(note.includes("built-in default"), note);
	} finally {
		scratch.restore();
	}
});

test("config inspection lists the keys a layer set, not the merged section around them (bt-deep 7)", async () => {
	const scratch = await isolatePancodeEnv("pancode-inspect-provenance-");
	try {
		const workspace = join(scratch.dir, "workspace");
		mkdirSync(workspace);
		mkdirSync(join(settingsPath(), ".."), { recursive: true });
		writeFileSync(settingsPath(), "version: 1\nchat:\n  target: openai-codex\n  model: gpt-6-luna\n");
		const rows = buildCustomizationGraph(workspace).settings;
		deepStrictEqual(
			rows.filter((row) => row.key.startsWith("chat")).map((row) => [row.key, row.source]),
			[
				["chat.model", "user"],
				["chat.target", "user"],
			],
		);
	} finally {
		scratch.restore();
	}
});
