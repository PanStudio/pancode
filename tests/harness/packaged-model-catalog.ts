// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { join } from "node:path";
import { resolvePackageRoot } from "../../src/core/package-root.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/index.js";
import {
	createProfileKnowledgeBase,
	type ProfileKnowledgeBase,
} from "../../src/domains/providers/profile-knowledge.js";
import type { ModelRow } from "../../src/interactive/overlays/model-selector-model.js";

/**
 * The model catalog the package ships, alone: packaged profiles and their substring fallback tier, with no
 * `model-catalog.d` overlay and no operator profile file, so an overlay on the machine running the suite
 * cannot change an answer.
 */
export function packagedModelCatalog(): ProfileKnowledgeBase {
	return createProfileKnowledgeBase({
		overlayRoots: [],
		userPath: join(resolvePackageRoot(), "models", "operator-profiles-not-read.yaml"),
	});
}

/** One ready, chat-and-tools-capable model-picker row on a configured local target. */
export function selectableModelRow(): ModelRow {
	const caps = { ...EMPTY_CAPABILITIES, chat: true, tools: true };
	return {
		value: "next-target/next-model",
		target: "next-target",
		model: "next-model",
		runtimeName: "Contract runtime",
		runtimeShortName: "Contract",
		runtimeId: "contract-runtime",
		apiFamily: "openai-completions",
		bucket: "local",
		source: "configured",
		authText: "ready",
		available: true,
		reason: "",
		healthToken: "success",
		healthText: "healthy",
		caps,
		capabilityDecisions: {
			chat: true,
			tools: true,
			reasoning: false,
			vision: false,
			streaming: true,
			contextWindow: 32768,
			maxTokens: 8192,
		},
		thinking: "off",
		streaming: true,
		badges: "T",
		context: "32kctx",
		maxTokens: "8k",
		active: false,
		scoped: false,
		visibleByDefault: true,
		selectable: true,
	};
}
