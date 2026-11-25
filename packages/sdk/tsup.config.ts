// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"extension/index": "src/extension/index.ts",
		"pack/index": "src/pack/index.ts",
		"testing/index": "src/testing/index.ts",
		"tool/index": "src/tool/index.ts",
		"mcp-server/index": "src/mcp-server/index.ts",
	},
	format: ["esm"],
	target: "node22",
	platform: "node",
	outDir: "dist",
	clean: true,
	sourcemap: false,
	// tsup injects `baseUrl`, which TypeScript 6 rejects as deprecated.
	dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
});
