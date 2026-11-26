#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/*
 * Installs this machine's bundle the way a user does and takes it through its whole life, in a throwaway
 * home, against a local mirror of the release:
 *
 *   install (the release's install.sh or install.ps1) -> the three commands answer -> `pancode upgrade` to a
 *   next version -> `pancode upgrade --rollback` -> `pancode uninstall`
 *
 * The next version is this bundle with its version raised, so the upgrade runs the installed product's own
 * update path end to end. CI runs this on every target it has a runner for, on every push.
 *
 *   node scripts/release/smoke.mjs <assets dir>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { hostTarget } from "./bundle.mjs";

const windows = process.platform === "win32";
const TAR = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

function step(label, action) {
	const started = Date.now();
	const value = action();
	console.log(`ok ${label} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
	return value;
}

function run(command, args, env) {
	const result = spawnSync(command, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: env.HOME });
	if (result.error) throw new Error(`could not start ${command}: ${result.error.message}`);
	if (result.status !== 0)
		throw new Error(`${[command, ...args].join(" ")} exited ${result.status}\n${result.stdout}${result.stderr}`);
	return result.stdout;
}

/** A release directory holding this bundle as the next patch version, with its checksum list. */
function nextRelease(bundle, version, target, scratch, mirror) {
	const [major, minor, patch] = version.split("-")[0].split(".").map(Number);
	const next = `${major}.${minor}.${patch + 1}`;
	const tree = join(scratch, "next");
	mkdirSync(tree);
	execFileSync(TAR, ["-xzf", bundle, "-C", tree]);
	for (const file of [join(tree, "lib", "node_modules", "pancode", "package.json"), join(tree, "bundle.json")]) {
		const value = JSON.parse(readFileSync(file, "utf8"));
		writeFileSync(file, `${JSON.stringify({ ...value, version: next }, null, "\t")}\n`);
	}
	const directory = join(mirror, `v${next}`);
	mkdirSync(directory);
	const name = `pancode-${next}-${target}.tar.gz`;
	execFileSync(TAR, ["-czf", join(directory, name), "-C", tree, "."]);
	rmSync(tree, { recursive: true });
	const sha256 = createHash("sha256")
		.update(readFileSync(join(directory, name)))
		.digest("hex");
	writeFileSync(join(directory, "SHA256SUMS"), `${sha256}  ${name}\n`);
	return next;
}

/**
 * Serves `directory` on a loopback port from a worker thread; the installers and the product's update check
 * read the mirror over HTTP while this thread waits in spawnSync.
 */
function serve(directory) {
	const source = `
		const { createServer } = require("node:http");
		const { existsSync, readFileSync } = require("node:fs");
		const { join, resolve } = require("node:path");
		const { parentPort, workerData } = require("node:worker_threads");
		const server = createServer((request, response) => {
			const file = join(workerData, decodeURIComponent(new URL(request.url, "http://localhost").pathname));
			if (!resolve(file).startsWith(resolve(workerData)) || !existsSync(file)) return response.writeHead(404).end();
			response.writeHead(200).end(readFileSync(file));
		});
		server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
	`;
	return new Promise((ready, fail) => {
		const worker = new Worker(source, { eval: true, workerData: directory });
		worker.once("error", fail);
		worker.once("message", (port) => ready({ port, close: () => worker.terminate() }));
	});
}

const assets = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(join(assets, "SHA256SUMS"))) {
	console.error("usage: smoke.mjs <assets dir written by scripts/release/build.mjs>");
	process.exit(2);
}
const target = process.env.PANCODE_TARGET || hostTarget();
const bundleFile = readdirSync(assets).find((name) => name.endsWith(`-${target}.tar.gz`));
if (!bundleFile) throw new Error(`${assets} holds no ${target} bundle`);
const version = bundleFile.slice("pancode-".length, -`-${target}.tar.gz`.length);

// A short path: the sandbox and browser sockets a session opens under its home fail past 107 characters.
const scratch = mkdtempSync(join(tmpdir(), "pcs-"));
const home = join(scratch, "home");
const mirror = join(scratch, "mirror");
mkdirSync(join(mirror, "channel"), { recursive: true });
mkdirSync(home);
cpSync(assets, join(mirror, `v${version}`), { recursive: true });
writeFileSync(join(mirror, "channel", "latest"), `${version}\n`);
const next = nextRelease(join(assets, bundleFile), version, target, scratch, mirror);
const server = await serve(mirror);

const bin = join(home, "bin");
const root = join(home, "install");
const env = {
	HOME: home,
	USERPROFILE: home,
	PATH: [bin, process.env.PATH].join(windows ? ";" : ":"),
	TMPDIR: scratch,
	TEMP: scratch,
	TMP: scratch,
	PANCODE_HOME: join(home, "pancode"),
	PANCODE_INSTALL_GUI: "0",
	PANCODE_RELEASE_MIRROR: `http://127.0.0.1:${server.port}`,
	...(process.env.PANCODE_TARGET ? { PANCODE_TARGET: process.env.PANCODE_TARGET } : {}),
	...(windows
		? {
				SystemRoot: process.env.SystemRoot,
				APPDATA: join(home, "AppData", "Roaming"),
				LOCALAPPDATA: join(home, "AppData", "Local"),
			}
		: {}),
};
const command = (name) => join(bin, windows && name !== "pancode" ? `${name}.cmd` : windows ? "pancode.exe" : name);
const installed = () => run(command("pancode"), ["--version"], env).split("\n")[0].trim();
const expectVersion = (wanted) => {
	const line = installed();
	if (line !== `PanCode ${wanted}`) throw new Error(`pancode --version printed "${line}"; expected PanCode ${wanted}`);
};

let failed = false;
try {
	step(`install ${version} (${target})`, () => {
		if (windows)
			run(
				"powershell.exe",
				[
					"-NoProfile",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					join(assets, "install.ps1"),
					"-InstallDir",
					root,
					"-BinDir",
					bin,
					"-NoModifyPath",
				],
				env,
			);
		else run("sh", [join(assets, "install.sh"), "--install-dir", root, "--bin-dir", bin], env);
		expectVersion(version);
	});
	step("panstore and pankit answer", () => {
		const store = run(command("panstore"), ["--version"], env).trim();
		if (store !== version) throw new Error(`panstore --version printed "${store}"; expected ${version}`);
		if (!run(command("pankit"), ["list"], env).trim()) throw new Error("pankit list printed nothing");
	});
	step("doctor reads an installer install", () => {
		const result = spawnSync(command("pancode"), ["doctor", "--json"], { env, encoding: "utf8", cwd: home });
		const method = JSON.parse(result.stdout).findings.find((finding) => finding.name === "install method");
		if (!method?.detail.startsWith("installer ")) throw new Error(`doctor reports install method: ${method?.detail}`);
	});
	step(`upgrade to ${next}`, () => {
		writeFileSync(join(mirror, "channel", "latest"), `${next}\n`);
		run(command("pancode"), ["upgrade"], env);
		expectVersion(next);
	});
	step(`rollback to ${version}`, () => {
		run(command("pancode"), ["upgrade", "--rollback"], env);
		expectVersion(version);
	});
	step("uninstall", () => {
		run(command("pancode"), ["uninstall", "--yes"], env);
		for (const left of [root, command("pancode"), command("panstore")])
			if (existsSync(left)) throw new Error(`uninstall left ${left}`);
	});
	console.log(`SMOKE_OK ${target} ${version} node ${process.version}`);
} catch (error) {
	failed = true;
	console.error(`smoke: ${error.message}`);
} finally {
	await server.close();
	rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);
