// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { registerHooks } from "node:module";

// Only this import is redirected. The absolute preload belongs to the CLI's install, never the package's dependencies or PATH.
const kit = new URL("../../../../dist/extensions/test-kit.js", import.meta.url).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "pancode/sdk/testing") return { url: kit, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
