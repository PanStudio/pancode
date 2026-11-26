// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { readMarkCuts } from "./client/shell/mark-cuts.js";
import { stagedClient } from "./scripts/staged-client.js";

// The bundle carries the PanCode version it was built from, which /api/meta's `pancode` reads from the same file, so
// an open window can tell when the server it talks to has moved on.
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
	version: string;
};
// The canonical mark's three cuts, read and checked once per build so the GUI draws the exact paths of assets/brand
// without copying them: the full cut, its light-ground colours, and the flat cut for 24 px and below.
const brand = (file: string) => ({
	file,
	svg: readFileSync(new URL(`../../assets/brand/${file}.svg`, import.meta.url), "utf8"),
});
const markCuts = readMarkCuts(brand("pancode-mark"), brand("pancode-mark-light"), brand("pancode-mark-small"));
// The display name for the opening stage, drawn as an image so its outlines and the for-all sign stay the artwork's.
const svgImage = (svg: string) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
const displayName = {
	dark: svgImage(brand("pancode-display").svg),
	light: svgImage(brand("pancode-display-light").svg),
};

export default defineConfig({
	define: {
		__PANCODE_BUNDLE_VERSION__: JSON.stringify(version),
		__PANCODE_MARK_CUTS__: JSON.stringify(markCuts),
		__PANCODE_DISPLAY_NAME__: JSON.stringify(displayName),
	},
	logLevel: process.env.PANCODE_BUILD_VERBOSE === "1" ? "info" : "warn",
	root: fileURLToPath(new URL("./client", import.meta.url)),
	plugins: [react(), stagedClient(fileURLToPath(new URL("./dist/client", import.meta.url)))],
	build: {
		// stagedClient builds this into dist/client.next and renames it into place, so a served GUI never sees it empty.
		outDir: "../dist/client",
		emptyOutDir: true,
		license: { fileName: "THIRD_PARTY_LICENSES.md" },
		// Mermaid's lazily loaded shared core is one 662 kB upstream chunk; every other chunk stays under the default 500 kB.
		chunkSizeWarningLimit: 700,
		rolldownOptions: {
			output: {
				codeSplitting: {
					groups: [
						{ name: "framework", test: /node_modules[\\/](react|react-dom|react-router|scheduler|@tanstack)[\\/]/ },
						// The app's own first-paint code ships as one chunk. Left alone, the bundler splits each module a lazy
						// route also imports into its own preloaded file, and the small files compress worse than one.
						{ name: "app", tags: ["$initial"], test: (id) => !/node_modules/.test(id) },
					],
				},
			},
		},
	},
	server: {
		port: 4318,
		strictPort: true,
		proxy: {
			// Vite serves client/api/*.ts as source modules. Proxy only backend API paths;
			// otherwise those imports get a 401 and the development page stays blank.
			"^/api(?:/|$)(?!.*\\.tsx?(?:\\?|$))": {
				target: "http://127.0.0.1:4317",
				changeOrigin: true,
				configure(proxy) {
					proxy.on("proxyReq", (request, incoming) => {
						if (incoming.headers.origin === `http://${incoming.headers.host}`)
							request.setHeader("Origin", "http://127.0.0.1:4317");
					});
				},
			},
		},
	},
});
