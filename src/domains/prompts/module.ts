// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createPromptsBundle, type PromptsBundleOptions } from "./extension.js";
import { PromptsManifest } from "./manifest.js";

/**
 * Build a `PromptsDomainModule` with bundle options closed over the factory
 * call. Used by the orchestrator and `pancode run` to thread the global
 * `--no-context-files` startup flag into the prompts domain without
 * restructuring the domain loader.
 */
export function createPromptsDomainModule(options: PromptsBundleOptions = {}): DomainModule<"prompts"> {
	return {
		manifest:
			options.noContextFiles === true
				? {
						...PromptsManifest,
						dependsOn: PromptsManifest.dependsOn.filter((name) => name !== "context"),
					}
				: PromptsManifest,
		createExtension: (context) => createPromptsBundle(context, options),
	};
}
