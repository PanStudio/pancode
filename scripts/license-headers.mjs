#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * SPDX license headers on PanCode's own source files.
 *
 * Every tracked .ts .tsx .mts .cts .js .mjs .cjs .py .sh and .css file in
 * scope opens with two comment lines, after a shebang, a Python coding cookie
 * or a CSS @charset:
 *
 *   // SPDX-License-Identifier: LicenseRef-PanCode-1.0
 *   // SPDX-FileCopyrightText: 2026 Anthony Kougkas
 *
 * Python and shell use `#`, CSS a pair of one-line block comments. A file
 * adapted from MIT-licensed upstream code keeps its upstream notice and
 * declares `LicenseRef-PanCode-1.0 AND MIT` (ADAPTED_MIT). Files under
 * packages/sdk/ declare `Apache-2.0`, the SDK package's license.
 *
 * Out of scope (EXCLUDED): vendored and generated files, fixtures, files whose
 * bytes another check pins by hash, and templates copied into user projects.
 *
 *   --check  exit 1 when a file in scope lacks the header, carries the wrong
 *            identifier or carries it out of place (the default; lint
 *            hygiene runs it)
 *   --write  insert or correct the header in place; a second run changes nothing
 *
 * The size and line budgets read sources through stripLicenseHeader and
 * packagedHeaderBytes so the header itself never counts against them.
 */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { brotliCompress, brotliDecompressSync, gzipSync, constants as zlibConstants } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));

export const LICENSE_ID = "LicenseRef-PanCode-1.0";
export const COPYRIGHT_TEXT = "2026 Anthony Kougkas";
const EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|py|sh|css)$/u;

/** Files adapted from MIT-licensed code, each with the upstream notice it must keep. */
export const ADAPTED_MIT = new Map([
	["src/engine/messages.ts", "pi-coding-agent"],
	["src/engine/prompt-templates.ts", "pi-coding-agent"],
	["src/engine/truncate.ts", "pi-coding-agent"],
	["src/core/views/tool-words.ts", "pi-coding-agent"],
	["src/interactive/export-html/ansi-to-html.ts", "pi-coding-agent"],
	["src/interactive/renderers/diff.ts", "pi-coding-agent"],
	["src/domains/session/compaction/cut-point.ts", "pi-coding-agent"],
	["src/session-control/slash-commands.ts", "pi-coding-agent"],
	["src/session-control/slash-command-types.ts", "pi-coding-agent"],
	["src/session-control/slash-reference.ts", "pi-coding-agent"],
	["src/session-control/slash-dispatch.ts", "pi-coding-agent"],
	["src/session-control/slash-handlers/usage-error.ts", "pi-coding-agent"],
	["src/session-control/slash-handlers/run.ts", "pi-coding-agent"],
	["src/session-control/slash-handlers/work.ts", "pi-coding-agent"],
	["src/session-control/slash-handlers/harness.ts", "pi-coding-agent"],
	["src/session-control/slash-handlers/context.ts", "pi-coding-agent"],
	["src/session-control/slash-handlers/fleet.ts", "pi-coding-agent"],
	["src/session-control/slash-handlers/memory.ts", "pi-coding-agent"],
	["src/session-control/slash-handlers/model.ts", "pi-coding-agent"],
	["src/session-control/slash-handlers/session.ts", "pi-coding-agent"],
]);

/** Files a generator writes; the generator's own source carries the header. */
const GENERATED = new Set([
	"src/engine/acp/upstream-schema.ts", // scripts/acp-schema.ts
	"site/css/brand.css", // site/tokens.mjs
	"apps/pancode-gui/client/design/brand.css", // apps/pancode-gui/scripts/sync-brand.mjs
]);

/** Inputs of the hashed media exports, read from the manifest so a new source is excluded with it. */
function mediaSources(base) {
	const manifest = JSON.parse(readFileSync(join(base, "assets/media-manifest.json"), "utf8"));
	return new Set([...manifest.assets, ...manifest.socialExports].flatMap((entry) => entry.sources ?? []));
}

/** Path rules that keep a file out of scope, each with its reason. */
export const EXCLUDED = [
	{ test: (path) => path.split("/").includes("node_modules"), reason: "installed dependency" },
	{ test: (path) => path.startsWith("site/vendor/"), reason: "vendored third-party code" },
	{ test: (path) => path.split("/").includes("fixtures"), reason: "test fixture, compared byte for byte" },
	{ test: (path) => GENERATED.has(path), reason: "generated file" },
	{
		test: (path) => path.startsWith("hub/"),
		reason: "PanHub pack, pinned by sha256 and licensed in its own plugin.json or SKILL.md",
	},
	{ test: (path) => path.startsWith("patches/"), reason: "dependency patch, applied byte for byte" },
	{
		test: (path) => path.startsWith("src/domains/extensions/authoring/templates/"),
		reason: "scaffold copied into user projects",
	},
];

/** Tracked files the header applies to, relative to `base`. */
export function filesInScope(base = root) {
	const media = mediaSources(base);
	return execFileSync("git", ["ls-files", "-z"], { cwd: base, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
		.split("\0")
		.filter((path) => EXTENSIONS.test(path) && !media.has(path) && !EXCLUDED.some((rule) => rule.test(path)))
		.sort();
}

const styleOf = (path) => (/\.(?:py|sh)$/u.test(path) ? "hash" : path.endsWith(".css") ? "css" : "slash");

function comment(style, text) {
	if (style === "hash") return `# ${text}`;
	if (style === "css") return `/* ${text} */`;
	return `// ${text}`;
}

/** The SDK package ships under Apache-2.0 so extension and pack authors can build on it freely. */
const SDK_LICENSE_ID = "Apache-2.0";

/** The header `path` must open with. */
export function expectedHeader(path) {
	const style = styleOf(path);
	const id = path.startsWith("packages/sdk/")
		? SDK_LICENSE_ID
		: ADAPTED_MIT.has(path)
			? `${LICENSE_ID} AND MIT`
			: LICENSE_ID;
	return `${comment(style, `SPDX-License-Identifier: ${id}`)}\n${comment(style, `SPDX-FileCopyrightText: ${COPYRIGHT_TEXT}`)}\n`;
}

const LINE = /[^\n]*(?:\n|$)/gu;
const COOKIE = /^[ \t\f]*#.*?coding[:=][ \t]*[-\w.]+/u;
const HEADER =
	/^(?:\/\/ |# |\/\* )SPDX-License-Identifier: [^\n]*?(?: \*\/)?\n(?:\/\/ |# |\/\* )SPDX-FileCopyrightText: [^\n]*?(?: \*\/)?(?:\n|$)/u;

/** Offset where the header belongs: after a shebang, a coding cookie on line 1 or 2, or a leading @charset. */
export function headerOffset(text) {
	const lines = text.slice(0, 4096).match(LINE) ?? [];
	let offset = 0;
	let index = 0;
	if (lines[0]?.startsWith("#!")) offset += lines[index++].length;
	if (index < 2 && lines[index] !== undefined && COOKIE.test(lines[index])) offset += lines[index++].length;
	if (index === 0 && lines[0]?.startsWith("@charset ")) offset += lines[0].length;
	return offset;
}

/** The header's `[start, end)` byte range in `text` (UTF-16 offsets), or undefined when it has none in place. */
export function licenseHeaderSpan(text) {
	const start = headerOffset(text);
	const match = HEADER.exec(text.slice(start, start + 1024));
	return match ? [start, start + match[0].length] : undefined;
}

/** `text` without its header, for the budgets that must not count it. */
export function stripLicenseHeader(text) {
	const span = licenseHeaderSpan(text);
	return span ? text.slice(0, span[0]) + text.slice(span[1]) : text;
}

/** A header block anywhere in the first lines, for telling a misplaced header from a missing one. */
function strayHeader(text) {
	const head = text.split("\n").slice(0, 40).join("\n");
	const match =
		/^(?:\/\/ |# |\/\* )SPDX-License-Identifier: [^\n]*\n(?:\/\/ |# |\/\* )SPDX-FileCopyrightText: [^\n]*\n/mu.exec(head);
	return match ? [match.index, match.index + match[0].length] : undefined;
}

/** The file's text with the expected header in place, the old one (in place or stray) removed. */
export function withLicenseHeader(path, text) {
	const span = licenseHeaderSpan(text) ?? strayHeader(text);
	const body = span ? text.slice(0, span[0]) + text.slice(span[1]) : text;
	const offset = headerOffset(body);
	const before = body.slice(0, offset);
	return `${before}${before && !before.endsWith("\n") ? "\n" : ""}${expectedHeader(path)}${body.slice(offset)}`;
}

/** One problem per file in scope whose header is missing, wrong or out of place, plus map entries gone stale. */
export function headerProblems(base = root) {
	const files = filesInScope(base);
	const scope = new Set(files);
	const problems = [];
	for (const [path, upstream] of ADAPTED_MIT) {
		if (!scope.has(path)) problems.push(`${path}: listed in ADAPTED_MIT but not a file in scope`);
		else if (!readFileSync(join(base, path), "utf8").includes(upstream))
			problems.push(`${path}: adapted file lost its ${upstream} notice`);
	}
	for (const path of files) {
		const text = readFileSync(join(base, path), "utf8");
		const span = licenseHeaderSpan(text);
		if (span) {
			if (text.slice(span[0], span[1]).replace(/\n?$/u, "\n") !== expectedHeader(path))
				problems.push(`${path}: header does not read ${JSON.stringify(expectedHeader(path))}`);
		} else problems.push(`${path}: ${strayHeader(text) ? "header out of place" : "no license header"}`);
	}
	return { files, problems };
}

const brotli = promisify(brotliCompress);

/** Reads the start of a file, enough to hold a shebang and the header. */
function readHead(file) {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(4096);
		return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
	} catch {
		return "";
	} finally {
		closeSync(fd);
	}
}

/**
 * Bytes the license headers add to a package, so the size budgets can leave them out. `files` is
 * the npm pack report's list; `packageRoot` holds the same paths. A loose file is credited its raw
 * header bytes. The source pack is credited, per member, the brotli bytes its header costs: the
 * member is decompressed, stripped and recompressed with build-source-pack's encoder settings
 * (the pack index's size digits stay counted).
 * The tarball credit adds the source-pack credit to each loose file's gzip delta compressed on its
 * own, an approximation of what the header costs inside the tarball's single gzip stream.
 *
 * Returns `discounts` (path to unpacked bytes, the shape classifySizes takes), `unpacked` (their
 * sum) and `tarball`.
 */
export async function packagedHeaderBytes(packageRoot, files, { sourcePack } = {}) {
	const discounts = new Map();
	let tarball = 0;
	for (const { path } of files) {
		if (path === sourcePack) {
			const credit = await sourcePackHeaderBytes(join(packageRoot, path));
			if (credit > 0) discounts.set(path, credit);
			tarball += credit;
			continue;
		}
		if (!EXTENSIONS.test(path)) continue;
		const file = join(packageRoot, path);
		if (!existsSync(file)) continue;
		const head = readHead(file);
		const span = licenseHeaderSpan(head);
		if (!span) continue;
		const bytes = Buffer.byteLength(head.slice(span[0], span[1]));
		discounts.set(path, bytes);
		const text = readFileSync(file);
		tarball += Math.max(
			0,
			gzipSync(text).length - gzipSync(Buffer.from(stripLicenseHeader(text.toString("utf8")))).length,
		);
	}
	const unpacked = [...discounts.values()].reduce((total, bytes) => total + bytes, 0);
	return { discounts, unpacked, tarball };
}

/** The brotli bytes the headers of the source pack's members take, measured against build-source-pack's encoding. */
async function sourcePackHeaderBytes(packFile) {
	const bytes = readFileSync(packFile);
	if (bytes.toString("latin1", 0, 8) !== "PANSRC01") throw new Error(`not a source pack: ${packFile}`);
	const indexLength = bytes.readUInt32LE(8);
	const index = JSON.parse(bytes.toString("utf8", 12, 12 + indexLength));
	const base = 12 + indexLength;
	const credits = await Promise.all(
		index.files.map(async (entry) => {
			const blob = bytes.subarray(base + entry.offset, base + entry.offset + entry.length);
			const text = brotliDecompressSync(blob).toString("utf8");
			if (!licenseHeaderSpan(text)) return 0;
			const stripped = Buffer.from(stripLicenseHeader(text));
			const recompressed = await brotli(stripped, {
				params: {
					[zlibConstants.BROTLI_PARAM_QUALITY]: 11,
					[zlibConstants.BROTLI_PARAM_SIZE_HINT]: stripped.length,
				},
			});
			return Math.max(0, blob.length - recompressed.length);
		}),
	);
	return credits.reduce((total, credit) => total + credit, 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({ options: { write: { type: "boolean" }, check: { type: "boolean" } } });
	if (values.write) {
		let changed = 0;
		const files = filesInScope();
		for (const path of files) {
			const file = join(root, path);
			const text = readFileSync(file, "utf8");
			const next = withLicenseHeader(path, text);
			if (next !== text) {
				writeFileSync(file, next);
				changed++;
			}
		}
		process.stdout.write(`license-headers: wrote ${changed} of ${files.length} files\n`);
	}
	const { files, problems } = headerProblems();
	if (problems.length > 0) {
		for (const problem of problems.slice(0, 20)) process.stderr.write(`license-headers: ${problem}\n`);
		if (problems.length > 20) process.stderr.write(`license-headers: ... and ${problems.length - 20} more\n`);
		process.stderr.write(
			`license-headers: ${problems.length} problems in ${files.length} files; run node scripts/license-headers.mjs --write\n`,
		);
		process.exit(1);
	}
	if (!values.write) process.stdout.write(`license-headers: ok (${files.length} files)\n`);
}
