#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Generates THIRD-PARTY-NOTICES.md: the license and NOTICE text of every
 * third-party package whose code or assets the build copies into dist/.
 *
 * The package set is computed, not listed. The Node bundles are re-resolved
 * with esbuild from the entries, defines, shims and externals in
 * tsup.config.ts (a package counts when any of its modules is part of an
 * output, which matches the list Vite writes for the client),
 * the GUI client the same way from apps/pancode-gui/client/main.tsx, the
 * grammar wasm from GRAMMAR_ASSETS, and the vendored GUI fonts from their
 * license files. Versions come from the installed node_modules, which the
 * frozen lockfile pins. The scientific-data readers fetched on first use are
 * listed too, from FETCHED_READERS checked against their pins.
 *
 *   --write  regenerate THIRD-PARTY-NOTICES.md
 *   --check  exit 1 when the committed file differs (run by `pnpm run lint`)
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT = "THIRD-PARTY-NOTICES.md";
const GUI = join(root, "apps/pancode-gui");

/** Packages that ship no license file of their own; the text PanCode keeps for them. */
const LICENSE_FALLBACKS = new Map([["@earendil-works/pi-tui", "src/engine/notices/pi-tui-LICENSE"]]);

/** Font files the GUI client serves from apps/pancode-gui/client/public/fonts, with the license each one carries. */
const VENDORED_FONTS = [
	{
		name: "Instrument Sans",
		license: "OFL-1.1",
		files: ["instrument-sans.woff2", "instrument-sans-italic.woff2"],
		text: "apps/pancode-gui/client/public/fonts/Instrument-Sans-OFL.txt",
	},
	{
		name: "IBM Plex Mono",
		license: "OFL-1.1",
		files: ["plex-400.woff2", "plex-500.woff2"],
		text: "apps/pancode-gui/client/public/fonts/IBM-Plex-Mono-OFL.txt",
	},
	{
		name: "Schibsted Grotesk",
		license: "OFL-1.1",
		files: ["schibsted-grotesk.woff2"],
		text: "apps/pancode-gui/client/public/fonts/Schibsted-Grotesk-OFL.txt",
	},
];

/**
 * The scientific-data readers PanCode fetches on first use (SCIENTIFIC_READERS in packages/scidata/src/assets.ts).
 * They are not in the package; their licenses are listed so a user can read them before the download. Each text is
 * the license file of the pinned registry tarball, copied byte for byte. A pin this list does not match fails the
 * run, so a version bump re-reads the license from the new tarball.
 */
const FETCHED_READERS = [
	{
		name: "h5wasm",
		version: "0.10.3",
		license: "NIST software notice, with the HDF5 license of The HDF Group",
		source: "https://github.com/usnistgov/h5wasm",
		document: "LICENSE.txt",
		text: "packages/scidata/notices/h5wasm-LICENSE.txt",
	},
	{
		name: "hyparquet",
		version: "1.31.5",
		license: "MIT",
		source: "https://github.com/hyparam/hyparquet",
		document: "LICENSE",
		text: "packages/scidata/notices/hyparquet-LICENSE",
	},
];
const FETCHED_SURFACE = "fetched on first use, not distributed";

const NOTICE_FILE = /^(?:licen[cs]e|copying|notice|copyright)(?:[-_][a-z0-9-]+)?(?:\.(?:md|markdown|txt))?$/iu;

const { values } = parseArgs({ options: { write: { type: "boolean" }, check: { type: "boolean" } } });
if (values.write === values.check) {
	process.stderr.write("usage: node scripts/third-party-notices.mjs --write | --check\n");
	process.exit(2);
}

const rootRequire = createRequire(join(root, "package.json"));
const { build } = await import(pathToFileURL(rootRequire.resolve("esbuild")).href);
const { tsImport } = await import(pathToFileURL(rootRequire.resolve("tsx/esm/api")).href);

/** tsup's rule: a string names a package and its subpaths, a RegExp tests the specifier. */
function matches(specifier, patterns) {
	return patterns.some((pattern) =>
		pattern instanceof RegExp ? pattern.test(specifier) : specifier === pattern || specifier.startsWith(`${pattern}/`),
	);
}

function externalsPlugin(external, noExternal) {
	return {
		name: "third-party-notices-externals",
		setup(probe) {
			probe.onResolve({ filter: /^[^./]/ }, (args) => {
				if (/^[A-Za-z]:[\\/]/u.test(args.path)) return undefined;
				if (matches(args.path, noExternal)) return undefined;
				if (args.path.startsWith("node:") || matches(args.path, external)) return { path: args.path, external: true };
				return undefined;
			});
		},
	};
}

/** The package directory an esbuild input path sits in, or undefined for PanCode's own files. */
function packageDirOf(base, input) {
	const path = input.replaceAll("\\", "/");
	if (path.includes(":") && !/^[A-Za-z]:\//u.test(path)) return undefined;
	const at = path.lastIndexOf("node_modules/");
	if (at < 0) return undefined;
	const [first, second] = path.slice(at + "node_modules/".length).split("/");
	const name = first?.startsWith("@") ? `${first}/${second}` : first;
	return join(base, path.slice(0, at + "node_modules/".length), name ?? "");
}

function bundledPackageDirs(base, metafile) {
	const dirs = new Set();
	for (const output of Object.values(metafile.outputs)) {
		for (const input of Object.keys(output.inputs)) {
			const dir = packageDirOf(base, input);
			if (dir) dirs.add(dir);
		}
	}
	return dirs;
}

async function nodeBundlePackages() {
	const { default: config } = await tsImport(pathToFileURL(join(root, "tsup.config.ts")).href, import.meta.url);
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const external = [
		...Object.keys(pkg.dependencies ?? {}),
		...Object.keys(pkg.peerDependencies ?? {}),
		...(config.external ?? []),
	];
	const tsupDir = dirname(rootRequire.resolve("tsup/package.json"));
	const result = await build({
		absWorkingDir: root,
		entryPoints: config.entry,
		bundle: true,
		splitting: config.splitting,
		format: "esm",
		platform: "node",
		target: config.target,
		mainFields: ["module", "main"],
		define: config.define,
		inject: config.shims ? [join(tsupDir, "assets/esm_shims.js")] : [],
		outdir: join(root, "dist"),
		write: false,
		metafile: true,
		logLevel: "silent",
		plugins: [externalsPlugin(external, config.noExternal ?? [])],
	});
	return bundledPackageDirs(root, result.metafile);
}

async function guiClientPackages() {
	const result = await build({
		absWorkingDir: GUI,
		entryPoints: [join(GUI, "client/main.tsx")],
		tsconfig: join(GUI, "tsconfig.client.json"),
		bundle: true,
		splitting: true,
		format: "esm",
		platform: "browser",
		jsx: "automatic",
		define: { "process.env.NODE_ENV": '"production"', __PANCODE_BUNDLE_VERSION__: '"0.0.0"' },
		loader: { ".css": "empty", ".svg": "empty", ".png": "empty", ".webp": "empty", ".woff2": "empty" },
		external: ["/fonts/*"],
		outdir: join(GUI, "dist/client"),
		write: false,
		metafile: true,
		logLevel: "silent",
	});
	return bundledPackageDirs(GUI, result.metafile);
}

async function grammarPackages() {
	const { GRAMMAR_ASSETS } = await tsImport(
		pathToFileURL(join(root, "src/domains/context/codewiki/grammar-assets.ts")).href,
		import.meta.url,
	);
	return new Set(
		GRAMMAR_ASSETS.map((asset) => dirname(rootRequire.resolve(`${asset.from}/package.json`)).replaceAll("\\", "/")),
	);
}

async function fetchedReaderPins() {
	const { SCIENTIFIC_READERS } = await tsImport(
		pathToFileURL(join(root, "packages/scidata/src/assets.ts")).href,
		import.meta.url,
	);
	return new Set(
		Object.values(SCIENTIFIC_READERS).flatMap((reader) =>
			[reader.main, ...reader.deps].map((pkg) => `${pkg.name}@${pkg.version}`),
		),
	);
}

function readText(path) {
	return `${readFileSync(path, "utf8")
		.replace(/^\uFEFF/u, "")
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim()}\n`;
}

/** The body of a README's License section, for packages that put their license text only there. */
function readmeLicenseSection(text) {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => /^#{1,6}\s+licen[cs]e\b/iu.test(line));
	if (start < 0) return undefined;
	const level = /^#+/u.exec(lines[start])?.[0].length ?? 1;
	const end = lines.findIndex((line, index) => index > start && new RegExp(`^#{1,${level}}\\s`, "u").test(line));
	const body = lines
		.slice(start + 1, end < 0 ? undefined : end)
		.join("\n")
		.trim();
	return body ? `${body}\n` : undefined;
}

function licenseOf(pkg) {
	if (typeof pkg.license === "string") return pkg.license;
	if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
	if (Array.isArray(pkg.licenses)) return pkg.licenses.map((entry) => entry.type ?? entry).join(" OR ");
	return "not declared, see text";
}

function sourceOf(pkg) {
	const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
	const url = repository ?? pkg.homepage;
	if (!url) return undefined;
	return url
		.replace(/^git\+/u, "")
		.replace(/^git:\/\//u, "https://")
		.replace(/^github:/u, "https://github.com/")
		.replace(/^(?!https?:)([\w.-]+\/[\w.-]+)$/u, "https://github.com/$1")
		.replace(/\.git$/u, "");
}

function describePackage(dir, surface) {
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	const documents = readdirSync(dir)
		.filter((name) => NOTICE_FILE.test(name) && statSync(join(dir, name)).isFile())
		.sort()
		.map((name) => ({ name, text: readText(join(dir, name)) }));
	const fallback = LICENSE_FALLBACKS.get(pkg.name);
	if (documents.length === 0 && fallback) documents.push({ name: "LICENSE", text: readText(join(root, fallback)) });
	if (documents.length === 0) {
		const readme = readdirSync(dir).find((name) => /^readme(?:\.md)?$/iu.test(name));
		const section = readme ? readmeLicenseSection(readText(join(dir, readme))) : undefined;
		if (section) documents.push({ name: `${readme} (License section)`, text: section });
	}
	return {
		key: `${pkg.name}@${pkg.version}`,
		title: `${pkg.name} ${pkg.version}`,
		license: licenseOf(pkg),
		source: sourceOf(pkg),
		surfaces: new Set([surface]),
		documents,
	};
}

function fence(text) {
	const longest = Math.max(2, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
	return "`".repeat(longest + 1);
}

function render(components) {
	const lines = [
		"# Third-party notices",
		"",
		"PanCode's npm package includes the third-party code and assets below in `dist/`. Each component remains under",
		"its own license, reproduced here with any upstream NOTICE text. PanCode itself is under the PanCode License 1.0",
		"in LICENSE, except the extension API (pancode/sdk), which is under the Apache License 2.0 alone; NOTICE says which",
		"code is which and carries PanCode's own attributions.",
		"",
		`Rows marked "${FETCHED_SURFACE}" are not in the package: PanCode downloads that pinned npm`,
		"tarball the first time a tool reads the format, accepts it only when its sha256 matches the pin, and keeps it in",
		"the host's cache. Their license text is reproduced from the pinned tarball.",
		"",
		"Generated by `node scripts/third-party-notices.mjs --write`; do not edit by hand.",
		"",
		"| Component | License | Included in |",
		"| --- | --- | --- |",
		...components.map(
			(component) => `| ${component.title} | ${component.license} | ${[...component.surfaces].sort().join(", ")} |`,
		),
	];
	for (const component of components) {
		lines.push("", `## ${component.title}`, "", `License: ${component.license}`);
		if (component.source) lines.push(`Source: ${component.source}`);
		lines.push(`Included in: ${[...component.surfaces].sort().join(", ")}`);
		for (const document of component.documents) {
			const marker = fence(document.text);
			lines.push("", `### ${document.name}`, "", `${marker}text`, document.text.trimEnd(), marker);
		}
	}
	return `${lines.join("\n")}\n`;
}

const components = new Map();
const add = (dir, surface) => {
	const component = describePackage(dir, surface);
	const existing = components.get(component.key);
	if (existing) existing.surfaces.add(surface);
	else components.set(component.key, component);
};
const [nodePackages, clientPackages, grammars, readerPins] = await Promise.all([
	nodeBundlePackages(),
	guiClientPackages(),
	grammarPackages(),
	fetchedReaderPins(),
]);
for (const dir of nodePackages) add(dir, "Node bundles");
for (const dir of clientPackages) add(dir, "GUI client");
for (const dir of grammars) add(dir, "grammar assets");
for (const font of VENDORED_FONTS) {
	components.set(`font:${font.name}`, {
		key: `font:${font.name}`,
		title: `${font.name} font`,
		license: font.license,
		source: undefined,
		surfaces: new Set([`GUI fonts (${font.files.join(", ")})`]),
		documents: [{ name: basename(font.text), text: readText(join(root, font.text)) }],
	});
}

const recordedReaders = new Set(FETCHED_READERS.map((reader) => `${reader.name}@${reader.version}`));
const unrecordedReaders = [...readerPins].filter((pin) => !recordedReaders.has(pin));
const unpinnedReaders = [...recordedReaders].filter((pin) => !readerPins.has(pin));
if (unrecordedReaders.length > 0 || unpinnedReaders.length > 0) {
	process.stderr.write(
		`third-party-notices: FETCHED_READERS is out of date with packages/scidata/src/assets.ts (pinned but not recorded: ${unrecordedReaders.join(", ") || "none"}; recorded but not pinned: ${unpinnedReaders.join(", ") || "none"}); copy the license file from each pinned tarball\n`,
	);
	process.exit(1);
}
const noticeText = readFileSync(join(root, "NOTICE"), "utf8");
const unnoticedReaders = FETCHED_READERS.filter((reader) => !noticeText.includes(`${reader.name} ${reader.version} (`));
if (unnoticedReaders.length > 0) {
	process.stderr.write(
		`third-party-notices: NOTICE does not name ${unnoticedReaders.map((reader) => `${reader.name} ${reader.version}`).join(", ")} under "Scientific-data readers fetched on first use"\n`,
	);
	process.exit(1);
}
for (const reader of FETCHED_READERS) {
	components.set(`${reader.name}@${reader.version}`, {
		key: `${reader.name}@${reader.version}`,
		title: `${reader.name} ${reader.version}`,
		license: reader.license,
		source: reader.source,
		surfaces: new Set([FETCHED_SURFACE]),
		documents: [{ name: reader.document, text: readText(join(root, reader.text)) }],
	});
}

const fontDir = join(GUI, "client/public/fonts");
const listedFonts = new Set(VENDORED_FONTS.flatMap((font) => font.files));
const unlistedFonts = readdirSync(fontDir).filter((name) => name.endsWith(".woff2") && !listedFonts.has(name));
const missingFonts = [...listedFonts].filter((name) => !existsSync(join(fontDir, name)));
if (unlistedFonts.length > 0 || missingFonts.length > 0) {
	process.stderr.write(
		`third-party-notices: VENDORED_FONTS is out of date (unlisted: ${unlistedFonts.join(", ") || "none"}; missing: ${missingFonts.join(", ") || "none"})\n`,
	);
	process.exit(1);
}

const sorted = [...components.values()].sort((a, b) => a.title.localeCompare(b.title, "en"));
const missing = sorted.filter((component) => component.documents.length === 0).map((component) => component.title);
if (missing.length > 0) {
	process.stderr.write(
		`third-party-notices: no license text found for ${missing.join(", ")}; add a LICENSE_FALLBACKS entry\n`,
	);
	process.exit(1);
}
const text = render(sorted);
const target = join(root, OUTPUT);
if (values.write) {
	writeFileSync(target, text);
	process.stdout.write(`third-party-notices: wrote ${OUTPUT} (${sorted.length} components)\n`);
} else if (!existsSync(target) || readFileSync(target, "utf8") !== text) {
	process.stderr.write(`third-party-notices: ${OUTPUT} is stale; run node scripts/third-party-notices.mjs --write\n`);
	process.exit(1);
}
