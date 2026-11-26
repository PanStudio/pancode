// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"backend/index": "src/backend/index.ts",
		"cli/index": "src/cli/index.ts",
		"paths/index": "src/paths/index.ts",
		"testing/index": "src/testing/index.ts",
	},
	format: ["esm"],
	target: "node22",
	platform: "node",
	outDir: "dist",
	clean: true,
	sourcemap: false,
	// Keep `node:test`, which has no bare `test` form.
	removeNodeProtocol: false,
	// tsup injects `baseUrl`, which TypeScript 6 rejects as deprecated.
	dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
});
