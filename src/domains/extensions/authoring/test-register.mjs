// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { registerHooks } from "node:module";

// Only this import is redirected. The absolute preload belongs to the CLI's install, never the package's dependencies or PATH.
const harness = new URL("../../../../dist/extensions/test-harness.js", import.meta.url).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "pancode/sdk/testing") return { url: harness, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
