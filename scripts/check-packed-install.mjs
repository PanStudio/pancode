#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * pnpm run check:packed-install -- --tarball <akougkas-pancode-*.tgz> --prefix <dir>
 *
 * PanCode publishes one npm package, `@akougkas/pancode`. This proves its tarball (`npm pack`) is all an npm
 * user needs: every `bin` and `exports` target is in the tarball, it installs alone into an empty prefix with an
 * empty npm cache of its own and no `@pancode/*` package beside it, and from inside that prefix `pancode --version`,
 * `panstore --help`, `pankit list` and `pankit manifest` run and every `sdk/<subpath>` export imports. The
 * release checks follow: `panstore --version` prints the package version, `pankit list` names exactly the seven
 * PanKit servers and `pankit serve node` completes one MCP handshake and exits 0 (`scripts/release/installed-commands.mjs`). Then the
 * installed CLI scaffolds an extension outside the prefix and `pancode extensions test` runs its tests
 * against `pancode/sdk/testing`; when this checkout has TypeScript, the scaffold also type-checks against
 * the installed declarations. Third-party runtime dependencies come from the configured registry or mirror.
 *
 * `--prefix` must be absent or empty. The installed CLI runs with a scratch PanCode home.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { checkInstalledCommands, PACKAGE_NAME } from "./release/installed-commands.mjs";

const shell = process.platform === "win32";
const root = fileURLToPath(new URL("..", import.meta.url));

/** The commands the package installs. */
export const COMMANDS = ["pancode", "panstore", "pankit"];

/** The regular files in a gzipped tarball, as a map of path to contents. Reads ustar and pax headers. */
export function readTarball(bytes) {
	const tar = gunzipSync(bytes);
	const files = new Map();
	let longName;
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const field = (start, length) => header.toString("utf8", start, start + length).replace(/\0.*$/su, "");
		const size = Number.parseInt(field(124, 12).trim() || "0", 8);
		const type = field(156, 1) || "0";
		const body = tar.subarray(offset + 512, offset + 512 + size);
		const prefix = field(345, 155);
		const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
		longName = undefined;
		if (type === "x") longName = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(body.toString("utf8"))?.[1];
		else if (type === "L") longName = body.toString("utf8").replace(/\0.*$/su, "");
		else if (type === "0") files.set(name, body);
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return files;
}

/** Every string target in an `exports` value, at any condition depth. */
function exportTargets(value) {
	if (typeof value === "string") return [value];
	if (value === null || typeof value !== "object") return [];
	return Object.values(value).flatMap(exportTargets);
}

/** Problems with the packed root package: its name, its commands, and the files its bin and exports name. */
export function tarballProblems(files) {
	const raw = files.get("package/package.json");
	if (raw === undefined) return ["the tarball has no package/package.json"];
	const text = raw.toString("utf8");
	const manifest = JSON.parse(text);
	const problems = [];
	if (manifest.name !== PACKAGE_NAME)
		problems.push(`the packed name is ${manifest.name}; PanCode publishes only ${PACKAGE_NAME}`);
	if (text.includes("workspace:")) problems.push("the packed package.json still contains a workspace: specifier");
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies"])
		for (const name of Object.keys(manifest[field] ?? {}))
			if (name.startsWith("@pancode/")) problems.push(`package.json ${field} names ${name}, which is never published`);
	const bin = manifest.bin ?? {};
	for (const command of COMMANDS) if (!bin[command]) problems.push(`package.json bin has no ${command}`);
	for (const target of [...exportTargets(manifest.exports), ...Object.values(bin)]) {
		const inside = `package/${target.replace(/^\.\//u, "")}`;
		if (!files.has(inside)) problems.push(`${target} is named by exports or bin but missing from the tarball`);
	}
	for (const required of ["LICENSE", "NOTICE", "README.md"])
		if (!files.has(`package/${required}`)) problems.push(`${required} is missing from the tarball`);
	return problems;
}

function run(command, args, options) {
	const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell, ...options });
	if (result.error) throw new Error(`could not start ${command}: ${result.error.message}`);
	if (result.status !== 0)
		throw new Error(`${[command, ...args].join(" ")} failed (exit ${result.status}):\n${result.stdout}${result.stderr}`);
	return result.stdout;
}

/** The checkout's own `tsc`, or null when TypeScript is not installed here. */
function checkoutTsc() {
	try {
		const manifest = createRequire(join(root, "package.json")).resolve("typescript/package.json");
		const { bin } = JSON.parse(readFileSync(manifest, "utf8"));
		const target = typeof bin === "string" ? bin : (bin?.tsc ?? Object.values(bin ?? {})[0]);
		return target ? join(dirname(manifest), target) : null;
	} catch {
		// No TypeScript in this checkout: the scaffold is tested but not type-checked.
		return null;
	}
}

/**
 * Installs `tarball` into the empty `prefix` and runs every check above. Returns the report lines and what the
 * release checks read (`installed`), which qualification records in its test results.
 */
export async function checkPackedInstall({ tarball, prefix }) {
	const files = readTarball(readFileSync(tarball));
	const problems = tarballProblems(files);
	if (problems.length > 0) throw new Error(problems.join("\n"));
	const manifest = JSON.parse(files.get("package/package.json").toString("utf8"));
	if (existsSync(prefix) && readdirSync(prefix).length > 0) throw new Error(`--prefix ${prefix} is not empty`);
	mkdirSync(prefix, { recursive: true });
	const cache = mkdtempSync(join(tmpdir(), "pancode-npm-cache-"));
	const home = mkdtempSync(join(tmpdir(), "pancode-packed-home-"));
	const authoring = mkdtempSync(join(tmpdir(), "pancode-packed-extension-"));
	try {
		run("npm", ["install", "--prefix", prefix, "--no-save", "--cache", cache, "--no-audit", "--no-fund", tarball], {
			cwd: prefix,
		});
		const scoped = join(prefix, "node_modules", "@pancode");
		if (existsSync(scoped)) throw new Error(`${scoped} exists; the tarball must install with no @pancode/*`);
		const env = {
			...process.env,
			PANCODE_HOME: home,
			PANCODE_DATA_DIR: join(home, "data"),
			PANCODE_CONFIG_DIR: join(home, "config"),
			PANCODE_STATE_DIR: join(home, "state"),
			PANCODE_CACHE_DIR: join(home, "cache"),
			PANCODE_INTEROP_HOME: "none",
			PANCODE_REQUIRE_HOME_PREFIX: "1",
			PANCODE_PACKAGE_ROOT: "",
			XDG_CACHE_HOME: join(home, "xdg-cache"),
		};
		const bin = (command) => join(prefix, "node_modules", ".bin", shell ? `${command}.cmd` : command);
		const lines = [`pancode --version: ${run(bin("pancode"), ["--version"], { cwd: prefix, env }).split("\n")[0]}`];
		run(bin("panstore"), ["--help"], { cwd: prefix, env });
		lines.push("panstore --help ok");
		const listed = run(bin("pankit"), ["list"], { cwd: prefix, env }).trim();
		const kitManifest = JSON.parse(run(bin("pankit"), ["manifest"], { cwd: prefix, env }));
		lines.push(`pankit: list ${listed.split("\n").length} servers, manifest ${kitManifest.servers.length} servers`);
		const installed = await checkInstalledCommands({ prefix, env, version: manifest.version });
		lines.push(
			`panstore --version ${installed.panstoreVersion}; pankit list ${installed.pankitServers.join(", ")}; pankit serve node handshake ${installed.pankitServeNode.serverInfo.name} in ${installed.pankitServeNode.ms} ms`,
		);
		const specifiers = Object.keys(manifest.exports ?? {})
			.filter((key) => key.startsWith("./sdk/"))
			.map((key) => `${manifest.name}/${key.slice(2)}`);
		if (specifiers.length === 0) throw new Error("package.json exports no sdk/<subpath>");
		const script = `Promise.all(${JSON.stringify(specifiers)}.map((s) => import(s))).catch((e) => { console.error(e); process.exit(1); })`;
		run(process.execPath, ["--input-type=module", "-e", script], { cwd: prefix, shell: false });
		lines.push(`import ok: ${specifiers.join(", ")}`);
		const extension = join(authoring, "packed-probe");
		run(bin("pancode"), ["extensions", "init", "packed-probe", "--dir", extension], { cwd: authoring, env });
		const tsc = checkoutTsc();
		if (tsc !== null) {
			run(process.execPath, [tsc, "-p", extension], { cwd: extension, shell: false });
			lines.push("scaffolded extension type-checks against pancode/sdk");
		} else lines.push("scaffolded extension not type-checked: no TypeScript in this checkout");
		run(bin("pancode"), ["extensions", "test", extension], { cwd: authoring, env });
		lines.push("scaffolded extension tests pass against pancode/sdk/testing");
		return { lines, installed };
	} finally {
		rmSync(cache, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
		rmSync(authoring, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const { values } = parseArgs({
			args: process.argv.slice(2).filter((argument) => argument !== "--"),
			options: { tarball: { type: "string" }, prefix: { type: "string" } },
		});
		if (!values.tarball || !values.prefix) throw new Error("usage: --tarball <akougkas-pancode-*.tgz> --prefix <dir>");
		const { lines } = await checkPackedInstall({ tarball: resolve(values.tarball), prefix: resolve(values.prefix) });
		for (const line of lines) console.log(`check-packed-install: ${line}`);
		console.log("check-packed-install: ok");
	} catch (error) {
		console.error(`check-packed-install: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
