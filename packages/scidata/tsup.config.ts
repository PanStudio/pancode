// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"worker/index": "src/worker/index.ts",
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
