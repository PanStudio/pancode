// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
import { artifactBytes, buildVerbose, reportBuildStage } from "./scripts/build-output.js";
import { chunkMergePlugin } from "./scripts/chunk-merge.js";
import {
	FETCHED_GRAMMAR_PACKAGE,
	FETCHED_GRAMMARS,
	GRAMMAR_ASSETS,
	type GrammarAssetSource,
} from "./src/domains/context/codewiki/grammar-assets.js";

const require = createRequire(import.meta.url);
const buildStartedAt = performance.now();
/** Minted at each build's start, so every watch rebuild records an id that matches its own chunks. */
let buildId = randomUUID();
/** When the most recent esbuild run started, served beside its id (C-31). */
let buildAt = new Date().toISOString();
/** The dist-relative files the most recent esbuild run wrote, from its metafile. */
let lastBuildOutputs: string[] = [];

/** The build id module; only its chunk changes from one build to the next. */
const BUILD_ID_MODULE = /[\\/]src[\\/]core[\\/]build-id\.ts$/;

/**
 * Gives each esbuild run, watch rebuilds included, a fresh id and serves it as
 * the content of src/core/build-id.ts. A config-level `define` is evaluated once
 * when this file loads, which made every watch rebuild share one id.
 */
export const buildIdPlugin = {
	name: "pancode-build-id",
	setup(build: {
		onStart(callback: () => void): void;
		onLoad(options: { filter: RegExp }, callback: () => { contents: string; loader: "ts" }): void;
		onEnd?(callback: (result: { metafile?: { outputs: Record<string, unknown> } | undefined }) => void): void;
	}): void {
		build.onStart(() => {
			buildId = randomUUID();
			buildAt = new Date().toISOString();
		});
		build.onEnd?.((result) => {
			lastBuildOutputs = Object.keys(result.metafile?.outputs ?? {}).map((path) =>
				path.replaceAll("\\", "/").replace(/^(?:\.\/)?dist\//u, ""),
			);
		});
		build.onLoad({ filter: BUILD_ID_MODULE }, () => ({
			contents: `export const runningBuildId: string | null = ${JSON.stringify(buildId)};\nexport const runningBuildAt: string | null = ${JSON.stringify(buildAt)};\n`,
			loader: "ts",
		}));
	},
};

/** The id the most recent build carries; `onSuccess` writes it to dist/build.json. */
export function currentBuildId(): string {
	return buildId;
}

/** Older builds whose file lists stay beside dist/build.json so a prune can honor them. */
const RETAINED_BUILD_LISTS = 5;

/**
 * The `.js` files present in dist/ that the new build does not list and that
 * no build a live process still runs lists either. A rebuild no longer cleans
 * dist/, so a running process keeps the hashed chunks it has not loaded yet;
 * with no live holder the result is what a clean build would leave.
 */
export function filesToPrune(
	present: readonly string[],
	current: readonly string[],
	lists: ReadonlyMap<string, readonly string[]>,
	liveIds: ReadonlySet<string>,
): string[] {
	const keep = new Set(current);
	for (const id of liveIds) for (const file of lists.get(id) ?? []) keep.add(file);
	return present.filter((file) => file.endsWith(".js") && !keep.has(file));
}

/** Build ids that live processes registered as holds (src/core/running-build.ts); dead holds are removed. */
function liveHeldBuildIds(holds: string): Set<string> {
	const ids = new Set<string>();
	for (const name of existsSync(holds) ? readdirSync(holds) : []) {
		const path = join(holds, name);
		try {
			const hold = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; build?: unknown };
			if (!Number.isInteger(hold.pid) || typeof hold.build !== "string") throw new Error("malformed hold");
			process.kill(hold.pid as number, 0);
			ids.add(hold.build);
		} catch (error) {
			// EPERM means the process lives under another user; anything else is a dead or broken hold.
			if ((error as NodeJS.ErrnoException).code === "EPERM") continue;
			rmSync(path, { force: true });
		}
	}
	return ids;
}

/**
 * Records this build's file list under dist/builds/, keeps the newest lists,
 * and deletes every chunk neither this build nor a live holder's build lists.
 */
function retainAndPrune(id: string, files: string[]): void {
	const builds = join("dist", "builds");
	mkdirSync(builds, { recursive: true });
	writeFileSync(join(builds, `${id}.json`), `${JSON.stringify({ id, files })}\n`);
	const lists = new Map<string, string[]>();
	const recorded = readdirSync(builds)
		.filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name))
		.map((name) => ({ name, at: statSync(join(builds, name)).mtimeMs }))
		.sort((a, b) => b.at - a.at);
	for (const [index, { name }] of recorded.entries()) {
		if (index >= RETAINED_BUILD_LISTS) {
			rmSync(join(builds, name), { force: true });
			continue;
		}
		try {
			const list = JSON.parse(readFileSync(join(builds, name), "utf8")) as { files?: unknown };
			if (Array.isArray(list.files)) lists.set(name.slice(0, -".json".length), list.files.map(String));
		} catch {
			// An unreadable list holds no files.
		}
	}
	const present = distFiles((name) => name.endsWith(".js"));
	for (const file of filesToPrune(present, files, lists, liveHeldBuildIds(join(builds, "holds"))))
		rmSync(join("dist", file), { force: true });
}

/** Files under dist/ relative to it, outside the GUI client (replaced as a unit) and the retained lists. */
function distFiles(match: (name: string) => boolean): string[] {
	return readdirSync("dist", { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && match(entry.name))
		.map((entry) => join(entry.parentPath, entry.name).slice("dist/".length).replaceAll("\\", "/"))
		.filter((file) => !file.startsWith("builds/") && !file.startsWith("gui/client."));
}

/**
 * Commit and dirty flag of the checkout being bundled, injected as constants so
 * no process runs git at runtime (src/core/build-info.ts reads them). A build
 * outside a git checkout, such as from a tarball, defines nothing and shows the
 * plain version.
 */
function buildProvenanceDefines(): Record<string, string> {
	const git = (...args: string[]): string =>
		execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	try {
		const commit = git("rev-parse", "--short=7", "HEAD");
		const dirty = git("status", "--porcelain").length > 0;
		return { __PANCODE_BUILD_COMMIT__: JSON.stringify(commit), __PANCODE_BUILD_DIRTY__: String(dirty) };
	} catch {
		// No git binary or no repository: the version label simply carries no commit.
		return {};
	}
}

/** Where each grammar package keeps its wasm files, resolved from the checkout's devDependencies. */
const GRAMMAR_SOURCE_DIRS: Record<GrammarAssetSource, string> = {
	"@vscode/tree-sitter-wasm": dirname(require.resolve("@vscode/tree-sitter-wasm")),
	"tree-sitter-wasms": join(dirname(require.resolve("tree-sitter-wasms/package.json")), "out"),
};

/** Notices that travel with the vendored wasm; each lands beside the grammars under its package name. */
const GRAMMAR_NOTICES: Record<GrammarAssetSource, string[]> = {
	"@vscode/tree-sitter-wasm": ["LICENSE", "cgmanifest.json"],
	"tree-sitter-wasms": ["LICENSE"],
};

/** Pi TUI and its markdown dependencies are bundled (noExternal), so their license texts ship beside dist. */
function vendorTuiNotices(): void {
	const target = join("dist", "assets", "tui-notices");
	mkdirSync(target, { recursive: true });
	const piRequire = createRequire(require.resolve("@earendil-works/pi-tui"));
	cpSync("src/engine/notices/pi-tui-LICENSE", join(target, "pi-tui-LICENSE"));
	cpSync(join(dirname(piRequire.resolve("marked/package.json")), "LICENSE"), join(target, "marked-LICENSE"));
	cpSync(
		join(dirname(piRequire.resolve("marked-cjk-friendly/package.json")), "LICENSE"),
		join(target, "marked-cjk-friendly-LICENSE"),
	);
	cpSync(
		join(dirname(piRequire.resolve("get-east-asian-width")), "license"),
		join(target, "get-east-asian-width-LICENSE"),
	);
}

/**
 * Vendor the ten wasm files the codewiki indexer loads from the package into
 * dist/assets/grammars/ so the package needs neither grammar collection at
 * install time. The fetched grammars stay out; their pins are checked here
 * against the installed devDependency so a version bump cannot leave PanCode
 * fetching a grammar built for another runtime.
 */
function vendorGrammars(): void {
	const vscodeDir = GRAMMAR_SOURCE_DIRS["@vscode/tree-sitter-wasm"];
	const installed = (JSON.parse(readFileSync(join(dirname(vscodeDir), "package.json"), "utf8")) as { version: string })
		.version;
	if (installed !== FETCHED_GRAMMAR_PACKAGE.version) {
		throw new Error(
			`FETCHED_GRAMMAR_PACKAGE pins ${FETCHED_GRAMMAR_PACKAGE.name}@${FETCHED_GRAMMAR_PACKAGE.version} but ${installed} is installed; re-pin grammar-assets.ts`,
		);
	}
	for (const grammar of FETCHED_GRAMMARS) {
		const actual = createHash("sha256")
			.update(readFileSync(join(vscodeDir, grammar.file)))
			.digest("hex");
		if (actual !== grammar.sha256) throw new Error(`${grammar.file} sha256 ${actual} does not match its pin`);
	}
	const target = join("dist", "assets", "grammars");
	rmSync(target, { recursive: true, force: true });
	mkdirSync(target, { recursive: true });
	for (const asset of GRAMMAR_ASSETS) {
		cpSync(join(GRAMMAR_SOURCE_DIRS[asset.from], asset.file), join(target, asset.file));
	}
	for (const [source, notices] of Object.entries(GRAMMAR_NOTICES) as Array<[GrammarAssetSource, string[]]>) {
		const packageDir = dirname(require.resolve(`${source}/package.json`));
		const noticeDir = join(target, "notices", source.replace("/", "__"));
		mkdirSync(noticeDir, { recursive: true });
		for (const notice of notices) cpSync(join(packageDir, notice), join(noticeDir, notice));
	}
}

/** Bundled CommonJS dependencies call `require`; every output file gets one bound to its own location. */
const REQUIRE_BANNER =
	'import { createRequire as __pancodeCreateRequire } from "node:module"; const require = __pancodeCreateRequire(import.meta.url);';

/** Prepended to every file under dist/sdk/: the extension API is Apache-2.0, like its source in packages/sdk/ (NOTICE). */
const SDK_LICENSE_HEADER = "// SPDX-License-Identifier: Apache-2.0\n// SPDX-FileCopyrightText: 2026 Anthony Kougkas\n";

/** Puts the Apache-2.0 header on each emitted dist/sdk/ module that does not carry it yet. */
function headSdkModules(): void {
	const sdk = join("dist", "sdk");
	for (const name of existsSync(sdk) ? readdirSync(sdk) : []) {
		if (!name.endsWith(".js")) continue;
		const path = join(sdk, name);
		const text = readFileSync(path, "utf8");
		if (!text.startsWith(SDK_LICENSE_HEADER)) writeFileSync(path, SDK_LICENSE_HEADER + text);
	}
}

const entries = {
	"cli/index": "src/cli/index.ts",
	// The public `pancode/sdk/<subpath>` modules (package.json exports), built from packages/sdk/ alone.
	"sdk/extension": "packages/sdk/src/extension/index.ts",
	"sdk/pack": "packages/sdk/src/pack/index.ts",
	"sdk/testing": "packages/sdk/src/testing/index.ts",
	"sdk/tool": "packages/sdk/src/tool/index.ts",
	"sdk/mcp-server": "packages/sdk/src/mcp-server/index.ts",
	// `pancode extensions test` sends `pancode/sdk/testing` here: the SDK host with the harness's own loader.
	"extensions/test-harness": "src/domains/extensions/authoring/test-harness.ts",
	"gui/server": "apps/pancode-gui/server/main.ts",
	"gui/reads-worker": "apps/pancode-gui/server/worker/reads-main.ts",
	"gui/ops-worker": "apps/pancode-gui/server/worker/ops-main.ts",
	"worker/entry": "src/worker/entry.ts",
	"codewiki/build-worker": "src/domains/context/codewiki/build-worker.ts",
	"context/handbook-compile-worker": "src/domains/context/handbook-compile-worker.ts",
	"context/sister-compile-worker": "src/domains/context/sister-compile-worker.ts",
	"data/scientific-worker": "packages/scidata/src/worker/index.ts",
	"browser/driver": "src/tools/browser/driver.ts",
};

export default defineConfig({
	entry: entries,
	define: { __PANCODE_GUI_BUNDLED__: "true", ...buildProvenanceDefines() },
	// The merge rewrites the build result, so it runs before the build id plugin reads the output list. It adds
	// about eight seconds, so a watch rebuild skips it and keeps esbuild's chunks: same code, slower module loading.
	esbuildPlugins: [...(process.argv.includes("--watch") ? [] : [chunkMergePlugin(REQUIRE_BANNER)]), buildIdPlugin],
	format: ["esm"],
	target: "node22",
	platform: "node",
	// Code splitting is what makes cli/index.ts's dynamic `await import("./x.js")`
	// per-subcommand loading pay off: each command module (and its transitive
	// heavy externals) lands in its own chunk, loaded only when that subcommand
	// runs. Without splitting, esbuild inlines everything into one chunk and the
	// external imports still execute eagerly, so `pancode --version` would pay the
	// full module-load tax.
	splitting: true,
	sourcemap: false,
	metafile: true,
	// A rebuild keeps the hashed chunks of the previous build so a running
	// process can still load the ones it has not imported yet; onSuccess prunes
	// every chunk no live process needs. `scripts/build.ts --clean` restores a
	// full clean.
	clean: false,
	// The `pancode/sdk/<subpath>` types ship as self-contained bundled
	// declarations, so a scaffolded extension type-checks against the install
	// without the loose src/ graph or PanCode's bundled devDependencies. The
	// scaffold's tsconfig paths name these files and test-register.mjs sends
	// the testing import to dist/extensions/test-harness.js. tsup injects `baseUrl`, which
	// TypeScript 6 rejects as deprecated. The entries live under packages/, so
	// the root's `rootDir: ./src` widens to the checkout.
	dts: {
		entry: {
			"sdk/extension": "packages/sdk/src/extension/index.ts",
			"sdk/pack": "packages/sdk/src/pack/index.ts",
			"sdk/testing": "packages/sdk/src/testing/index.ts",
			"sdk/tool": "packages/sdk/src/tool/index.ts",
			"sdk/mcp-server": "packages/sdk/src/mcp-server/index.ts",
		},
		banner: SDK_LICENSE_HEADER,
		compilerOptions: { ignoreDeprecations: "6.0", rootDir: "." },
	},
	// The web-tree-sitter runtime (bundled from @vscode/tree-sitter-wasm) is a
	// UMD that probes `__filename` at module scope; the ESM shim supplies it.
	shims: true,
	// Whitespace and syntax minification only. Identifiers are never mangled
	// and keepNames pins every function and class `.name`, so field stack
	// traces still name real symbols (#64, #65). PanCode reads its own installed
	// code from src/, which ships unminified, never from dist/.
	minifyWhitespace: true,
	minifySyntax: true,
	minifyIdentifiers: false,
	keepNames: true,
	// Node 22.19 ships `node:sqlite`; retaining the protocol prevents tsup from
	// turning that newer builtin into a lookup for the nonexistent `sqlite` package.
	removeNodeProtocol: false,
	outDir: "dist",
	// The pure-JS tail is bundled and tree-shaken into dist/ so an install does
	// not pull these packages; they live in devDependencies.
	noExternal: [
		"hono",
		"@hono/node-server",
		"chalk",
		"diff",
		"uuid",
		"yaml",
		"typebox",
		"@vscode/tree-sitter-wasm",
		/^@earendil-works\/pi-tui(?:\/|$)/,
		"marked",
		"marked-cjk-friendly",
		"get-east-asian-width",
		// Workspace packages resolve to their source through tsconfig paths and are bundled like src/.
		/^@pancode\//,
	],
	// The shebang comes from the hashbang line in each entry source file;
	// esbuild hoists it above this banner on the entry chunks and never puts
	// one on a shared chunk.
	banner: { js: REQUIRE_BANNER },
	async onSuccess() {
		reportBuildStage(
			"Node bundles",
			buildStartedAt,
			artifactBytes("dist", (file) => file.endsWith(".js")),
		);
		const appRequire = createRequire(join(process.cwd(), "apps/pancode-gui/package.json"));
		const { build: buildClient } = await import(pathToFileURL(appRequire.resolve("vite")).href);
		const clientStartedAt = performance.now();
		// Built beside the live directory and swapped in, so a GUI request during
		// the build never sees a half-written client.
		const client = join(process.cwd(), "dist/gui/client");
		const nextClient = `${client}.next`;
		const oldClient = `${client}.old`;
		await buildClient({
			configFile: "apps/pancode-gui/vite.config.ts",
			configLoader: "runner",
			logLevel: buildVerbose() ? "info" : "warn",
			build: { outDir: nextClient, emptyOutDir: true },
		});
		rmSync(oldClient, { recursive: true, force: true });
		if (existsSync(client)) renameSync(client, oldClient);
		renameSync(nextClient, client);
		rmSync(oldClient, { recursive: true, force: true });
		reportBuildStage("GUI client", clientStartedAt, artifactBytes("dist/gui/client"));
		const assetsStartedAt = performance.now();
		headSdkModules();
		vendorGrammars();
		vendorTuiNotices();
		const notices = join("dist", "assets", "gui-notices");
		mkdirSync(notices, { recursive: true });
		for (const name of ["hono", "@hono/node-server"]) {
			let directory = dirname(appRequire.resolve(name));
			while (!existsSync(join(directory, "LICENSE"))) {
				const parent = dirname(directory);
				if (parent === directory) throw new Error(`Missing license for ${name}`);
				directory = parent;
			}
			cpSync(join(directory, "LICENSE"), join(notices, `${name.replace("/", "__")}-LICENSE`));
		}
		const sanitizerEntry = appRequire.resolve("dompurify");
		const sanitizerPackage = JSON.parse(readFileSync(join(dirname(sanitizerEntry), "..", "package.json"), "utf8"));
		writeFileSync(
			join(notices, "dompurify.json"),
			`${JSON.stringify(
				{
					name: sanitizerPackage.name,
					version: sanitizerPackage.version,
					source: `https://registry.npmjs.org/dompurify/-/dompurify-${sanitizerPackage.version}.tgz`,
					sourceSha256: createHash("sha256").update(readFileSync(sanitizerEntry)).digest("hex"),
					license: sanitizerPackage.license,
					notices: "../../gui/client/THIRD_PARTY_LICENSES.md",
				},
				null,
				"\t",
			)}\n`,
		);
		reportBuildStage("Runtime assets", assetsStartedAt, artifactBytes("dist/assets"));
		// The new build's own outputs come from the esbuild metafile, which leaves
		// out chunks kept from earlier builds; without one every file counts.
		const written = new Set(lastBuildOutputs);
		const files = distFiles((name) => /\.(?:js|wasm|html)$/.test(name)).filter(
			(file) => !file.endsWith(".js") || file.startsWith("gui/client/") || written.size === 0 || written.has(file),
		);
		writeFileSync("dist/build.json", `${JSON.stringify({ id: buildId, files })}\n`);
		retainAndPrune(buildId, files);
	},
	// tsup already externalizes every package.json `dependencies` entry, so the
	// runtime deps need no listing here. The Claude Agent SDK and the Copilot SDK
	// are devDependencies, which tsup bundles by default, so both need the
	// explicit entry: without it esbuild would bundle them into dist/ and
	// reintroduce the hard requirement that #258 removed. External keeps the lazy
	// `await import()` in src/engine/claude/sdk-module.ts and
	// src/engine/copilot/sdk-module.ts real runtime imports.
	// The builtin entry is for removeNodeProtocol above.
	external: ["node:sqlite", "@anthropic-ai/claude-agent-sdk", "@github/copilot-sdk"],
});
