// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "@github/copilot-sdk";
import { SETTINGS_FIELD_NAMES } from "../../src/core/settings-fields.js";
import { validateSettings } from "../../src/core/settings-validate.js";
import { copilotContextTierLabel, copilotContextTierOf } from "../../src/domains/providers/index.js";
import { copilotTierCapabilities } from "../../src/domains/providers/runtimes/copilot/copilot-sdk.js";
import { copilotModelRow } from "../../src/engine/copilot/client.js";

// A listing row shaped like the runtime's: limits describe the long-context tier, the default tier's prompt
// budget sits in billing.tokenPrices and the long-context tier's in billing.tokenPrices.longContext.
const listingRow = {
	id: "claude-opus-5.5",
	name: "Claude Opus 5.5",
	capabilities: {
		supports: { vision: true, reasoningEffort: true },
		limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 1_000_000, max_output_tokens: 64_000 },
	},
	billing: {
		multiplier: 1,
		tokenPrices: {
			inputPrice: 5,
			outputPrice: 25,
			cacheReadPrice: 0.5,
			cacheWritePrice: 6.25,
			batchSize: 1_000_000,
			maxPromptTokens: 200_000,
			longContext: {
				inputPrice: 10,
				outputPrice: 37.5,
				cacheReadPrice: 1,
				cacheWritePrice: 12.5,
				maxPromptTokens: 1_000_000,
			},
		},
	},
} as unknown as ModelInfo;

test("the default tier reads the default prompt budget and prices", () => {
	const row = copilotModelRow(listingRow);
	strictEqual(row.contextTier, "default");
	strictEqual(row.contextWindow, 200_000);
	deepStrictEqual(row.prices, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, batchSize: 1_000_000 });
});

test("long_context reads longContext.maxPromptTokens and the longContext prices", () => {
	const row = copilotModelRow(listingRow, "long_context");
	strictEqual(row.contextTier, "long_context");
	strictEqual(row.contextWindow, 1_000_000);
	deepStrictEqual(row.prices, { input: 10, output: 37.5, cacheRead: 1, cacheWrite: 12.5, batchSize: 1_000_000 });
});

test("a listed row carries the long-context tier and a target reads it only when it opts in", () => {
	const row = copilotModelRow(listingRow);
	strictEqual(row.longContext?.contextWindow, 1_000_000);
	strictEqual(copilotTierCapabilities(row, { runtime: "copilot-sdk" }).contextWindow, 200_000);
	strictEqual(copilotTierCapabilities(row, { runtime: "copilot-sdk", contextTier: "default" }).contextWindow, 200_000);
	strictEqual(
		copilotTierCapabilities(row, { runtime: "copilot-sdk", contextTier: "long_context" }).contextWindow,
		1_000_000,
	);
});

test("a model without a long-context tier keeps its default budget and prices under long_context", () => {
	const plain = {
		...listingRow,
		billing: { multiplier: 1, tokenPrices: { inputPrice: 2, outputPrice: 8, maxPromptTokens: 128_000 } },
	} as unknown as ModelInfo;
	const row = copilotModelRow(plain, "long_context");
	strictEqual(row.contextWindow, 128_000);
	strictEqual(row.prices?.input, 2);
	strictEqual(row.longContext, undefined);
	strictEqual(
		copilotTierCapabilities(copilotModelRow(plain), { runtime: "copilot-sdk", contextTier: "long_context" })
			.contextWindow,
		128_000,
	);
});

function settingsWith(target: Record<string, unknown>): unknown {
	return { version: 2, targets: [target] };
}

test("targets[].contextTier round-trips through validateSettings for a copilot-sdk target", () => {
	ok((SETTINGS_FIELD_NAMES as readonly string[]).includes("contextTier"));
	const first = validateSettings(settingsWith({ id: "gh", runtime: "copilot-sdk", contextTier: "long_context" }));
	deepStrictEqual(first.issues, []);
	strictEqual(first.settings.targets[0]?.contextTier, "long_context");
	const second = validateSettings(JSON.parse(JSON.stringify(first.settings)));
	deepStrictEqual(second.issues, []);
	deepStrictEqual(second.settings.targets, first.settings.targets);
	strictEqual(copilotContextTierOf(second.settings.targets[0]), "long_context");
	strictEqual(copilotContextTierLabel(second.settings.targets[0]), "long context");
});

test("an absent contextTier stays absent and means the default tier", () => {
	const result = validateSettings(settingsWith({ id: "gh", runtime: "copilot-sdk" }));
	deepStrictEqual(result.issues, []);
	strictEqual("contextTier" in (result.settings.targets[0] ?? {}), false);
	strictEqual(copilotContextTierOf(result.settings.targets[0]), "default");
	strictEqual(copilotContextTierLabel(result.settings.targets[0]), null);
});

test("contextTier rejects unknown values and non-copilot targets", () => {
	const bad = validateSettings(settingsWith({ id: "gh", runtime: "copilot-sdk", contextTier: "huge" }));
	strictEqual(bad.issues.length, 1);
	strictEqual(bad.issues[0]?.path, "targets[0].contextTier");
	match(bad.issues[0]?.message ?? "", /default \| long_context/);
	const other = validateSettings(settingsWith({ id: "oa", runtime: "openai", contextTier: "long_context" }));
	strictEqual(other.issues.length, 1);
	strictEqual(other.issues[0]?.path, "targets[0].contextTier");
	strictEqual(other.settings.targets[0]?.contextTier, undefined);
});
