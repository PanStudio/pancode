#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/*
 * Builds the standalone bundles: one archive per target holding the pinned Node.js and the packed PanCode
 * package with the production dependencies the lockfile names. An install unpacks one archive and runs it;
 * nothing is resolved or downloaded from a registry on the user's machine.
 *
 *   <bundle>/bin/node                      (Windows: <bundle>/node.exe)
 *   <bundle>/lib/node_modules/npm          (Windows: <bundle>/node_modules/npm)
 *   <bundle>/lib/node_modules/pancode      the npm tarball's files plus node_modules/
 *   <bundle>/bundle.json                   { version, target, node }
 *
 * The package tree is the same bytes in every bundle: its only native code is prebuilt for every platform
 * inside one dependency. Runs on Linux with GNU tar, gzip and unzip.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createReadStream,
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { pnpmArgv } from "../pnpm.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
export const runtime = JSON.parse(readFileSync(new URL("node-runtime.json", import.meta.url), "utf8"));
export const TARGETS = Object.keys(runtime.targets);

export const bundleName = (version, target) => `pancode-${version}-${target}.tar.gz`;

export async function sha256File(file) {
	const hash = createHash("sha256");
	await pipeline(createReadStream(file), hash);
	return hash.digest("hex");
}

/** The pinned Node archive for `target`, downloaded once into `cache` and checked against its pin on every use. */
async function nodeArchive(target, cache) {
	const { url, sha256 } = runtime.targets[target];
	const file = join(cache, basename(url));
	if (!existsSync(file)) {
		const response = await fetch(url);
		if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
		await pipeline(response.body, createWriteStream(`${file}.part`));
		renameSync(`${file}.part`, file);
	}
	if ((await sha256File(file)) !== sha256) {
		rmSync(file);
		throw new Error(`${file} does not match the SHA-256 pinned in scripts/release/node-runtime.json`);
	}
	return file;
}

/** Unpacks the parts of a Node archive a bundle carries: the binary, npm and the license. */
function extractNode(archive, target, into) {
	mkdirSync(into, { recursive: true });
	const top = basename(archive).replace(/\.(?:tar\.gz|zip)$/u, "");
	if (target.startsWith("win-")) {
		execFileSync("unzip", ["-q", archive, `${top}/node.exe`, `${top}/LICENSE`, `${top}/node_modules/npm/*`, "-d", into]);
		for (const name of ["node.exe", "LICENSE", "node_modules"]) renameSync(join(into, top, name), join(into, name));
		rmSync(join(into, top), { recursive: true });
		renameSync(join(into, "LICENSE"), join(into, "NODE-LICENSE"));
		return;
	}
	execFileSync("tar", [
		"-xzf",
		archive,
		"-C",
		into,
		"--strip-components=1",
		`${top}/bin/node`,
		`${top}/lib/node_modules/npm`,
		`${top}/LICENSE`,
	]);
	renameSync(join(into, "LICENSE"), join(into, "NODE-LICENSE"));
}

/** The package tree every bundle shares: the tarball's files with the lockfile's production dependencies inside. */
function packageTree(tarball, work) {
	const tree = join(work, "package");
	const pkg = join(tree, "lib", "node_modules", "pancode");
	mkdirSync(pkg, { recursive: true });
	execFileSync("tar", ["-xzf", tarball, "-C", pkg, "--strip-components=1"]);
	const { name } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
	const deploy = join(work, "deploy");
	const [command, args] = pnpmArgv([
		"--filter",
		name,
		"deploy",
		"--prod",
		"--legacy",
		"--config.node-linker=hoisted",
		deploy,
	]);
	execFileSync(command, args, { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
	renameSync(join(deploy, "node_modules"), join(pkg, "node_modules"));
	rmSync(deploy, { recursive: true });
	// pnpm's bookkeeping and command links; nothing at runtime reads them.
	execFileSync("find", [
		join(pkg, "node_modules"),
		"(",
		"-name",
		".bin",
		"-o",
		"-name",
		".modules.yaml",
		"-o",
		"-name",
		".pnpm*",
		")",
		"-prune",
		"-exec",
		"rm",
		"-rf",
		"{}",
		"+",
	]);
	return tree;
}

/** One reproducible archive of several trees: sorted names, no owner, one timestamp. */
function archive(file, trees, mtime) {
	return new Promise((done, fail) => {
		const tar = spawn(
			"tar",
			[
				"--sort=name",
				"--owner=0",
				"--group=0",
				"--numeric-owner",
				`--mtime=@${mtime}`,
				"-cf",
				"-",
				...trees.flatMap((tree) => ["-C", tree, "."]),
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		const gzip = spawn("gzip", ["-n", "-9"], { stdio: ["pipe", "pipe", "inherit"] });
		tar.stdout.pipe(gzip.stdin);
		gzip.stdout.pipe(createWriteStream(file));
		let pending = 2;
		for (const [name, child] of [
			["tar", tar],
			["gzip", gzip],
		]) {
			child.once("error", fail);
			child.once("close", (code) => {
				if (code !== 0) fail(new Error(`${name} exited ${code} while writing ${file}`));
				else if (--pending === 0) done();
			});
		}
	});
}

/**
 * Writes `pancode-<version>-<target>.tar.gz` into `out` for each target and returns their names.
 * `mtime` is the timestamp every archived file carries, in seconds.
 */
export async function buildBundles({ tarball, out, targets = TARGETS, cache, mtime }) {
	const work = join(out, ".bundle-work");
	rmSync(work, { recursive: true, force: true });
	mkdirSync(work, { recursive: true });
	mkdirSync(cache, { recursive: true });
	try {
		const tree = packageTree(tarball, work);
		const { version } = JSON.parse(readFileSync(join(tree, "lib", "node_modules", "pancode", "package.json"), "utf8"));
		const queue = [...targets];
		const built = [];
		const worker = async () => {
			for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
				if (!runtime.targets[target]) throw new Error(`unknown bundle target ${target}; known: ${TARGETS.join(", ")}`);
				const node = join(work, `node-${target}`);
				extractNode(await nodeArchive(target, cache), target, node);
				writeFileSync(join(node, "bundle.json"), `${JSON.stringify({ version, target, node: runtime.version })}\n`);
				await archive(join(out, bundleName(version, target)), [node, tree], mtime);
				rmSync(node, { recursive: true });
				built.push(bundleName(version, target));
			}
		};
		await Promise.all(Array.from({ length: Math.min(targets.length, availableParallelism()) }, worker));
		return built.sort();
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** The bundle target of this machine, as scripts/install.sh detects it. */
export function hostTarget() {
	const arch = { x64: "x64", arm64: "arm64" }[process.arch];
	if (!arch) throw new Error(`no bundle for ${process.arch}`);
	if (process.platform === "darwin") return `darwin-${arch}`;
	if (process.platform === "win32") return `win-${arch}`;
	if (process.platform !== "linux") throw new Error(`no bundle for ${process.platform}`);
	const glibc = process.report.getReport().header.glibcVersionRuntime;
	if (!glibc) return `linux-${arch}-musl`;
	const [major, minor] = glibc.split(".").map(Number);
	return major === 2 && minor < 28 && arch === "x64" ? "linux-x64-glibc-217" : `linux-${arch}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [tarball, out, ...targets] = process.argv.slice(2);
	if (!tarball || !out) {
		console.error(
			"usage: bundle.mjs <package.tgz> <output dir> [target...]   (targets default to all; `host` names this machine's)",
		);
		process.exit(2);
	}
	const mtime = Number(execFileSync("git", ["log", "-1", "--format=%ct"], { cwd: root, encoding: "utf8" }));
	const built = await buildBundles({
		tarball: resolve(tarball),
		out: resolve(out),
		cache: join(resolve(out), ".node-cache"),
		mtime,
		...(targets.length ? { targets: targets.map((target) => (target === "host" ? hostTarget() : target)) } : {}),
	});
	for (const name of built) console.log(`${await sha256File(join(resolve(out), name))}  ${name}`);
}
