#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/*
 * Builds everything a release publishes, once, into one directory:
 *
 *   <out>/assets/   the GitHub release assets: the npm tarball, one bundle per target, the installers
 *                   and SHA256SUMS over all of them
 *   <out>/site/     the website for this commit
 *   <out>/release.json, release-notes.md and metafile-esm.json
 *
 * CI runs it on every push and tests what it wrote; a release publishes those same files. Locally,
 * `pnpm run release:build` writes one bundle for this machine.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pnpmArgv } from "../pnpm.mjs";
import { buildBundles, hostTarget, runtime, TARGETS } from "./bundle.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const INSTALLERS = ["install.sh", "install.ps1", "install.cmd"];
const STABLE = /^\d+\.\d+\.\d+$/u;
const PRERELEASE = /^\d+\.\d+\.\d+-rc\.\d+$/u;

const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });
const read = (command, args, options = {}) =>
	execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options }).trim();
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The channel a version publishes to, or null for a development version, which is built and tested but never published. */
export function releaseChannel(version) {
	if (STABLE.test(version)) return "latest";
	if (PRERELEASE.test(version)) return "beta";
	return null;
}

/** The first CHANGELOG.md section's body: the notes of the version being built. */
function releaseNotes() {
	const section = readFileSync(join(root, "CHANGELOG.md"), "utf8").split(/^## /mu)[1] ?? "";
	return `${section.slice(section.indexOf("\n") + 1).trim()}\n`;
}

/**
 * The website as it is served for `commit`, built in a scratch worktree so the docs snapshot it takes of
 * that commit never touches this checkout.
 */
function buildSite(out, commit, version) {
	const scratch = mkdtempSync(join(tmpdir(), "pancode-site-"));
	const checkout = join(scratch, "source");
	try {
		run("git", ["worktree", "add", "--quiet", "--detach", checkout, commit]);
		const site = join(checkout, "site");
		const product = JSON.parse(readFileSync(join(site, "product.json"), "utf8"));
		writeFileSync(
			join(site, "product.json"),
			`${JSON.stringify({ ...product, version, publishedVersion: version }, null, "\t")}\n`,
		);
		run("python3", ["site/sync-docs.py", "--snapshot-ref", commit], { cwd: checkout });
		run(process.execPath, ["site/deployment-check.mjs"], { cwd: checkout });
		run(process.execPath, ["site/policy.mjs"], { cwd: checkout });
		run(process.execPath, ["site/build.mjs", "--out", out, "--revision", commit], { cwd: checkout });
		run("python3", ["site/check.py", out], { cwd: checkout });
		// The builder's ownership marker holds this machine's output path; the published site does not carry it.
		rmSync(join(out, ".pancode-site-build"), { force: true });
	} finally {
		if (existsSync(checkout)) run("git", ["worktree", "remove", "--force", checkout]);
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Every manifest that carries the product version; a release bumps them together. */
function versionProblems(version) {
	const manifests = [
		"apps/pancode-gui/package.json",
		"assets/acp-registry/agent.json",
		...readdirSync(join(root, "packages")).map((name) => `packages/${name}/package.json`),
	];
	return manifests
		.filter((file) => existsSync(join(root, file)))
		.map((file) => [file, JSON.parse(readFileSync(join(root, file), "utf8")).version])
		.filter(([, found]) => found !== version)
		.map(([file, found]) => `${file} is ${found}, package.json is ${version}`);
}

export async function buildRelease({ out, targets, site }) {
	const commit = read("git", ["rev-parse", "HEAD"]);
	const dirty = read("git", ["status", "--porcelain", "--untracked-files=normal"]) !== "";
	if (dirty && process.env.GITHUB_ACTIONS) throw new Error("the checkout has uncommitted changes; CI builds a commit");
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const disagree = versionProblems(pkg.version);
	if (disagree.length) throw new Error(`versions disagree:\n  ${disagree.join("\n  ")}`);
	const assets = join(out, "assets");
	rmSync(out, { recursive: true, force: true });
	mkdirSync(assets, { recursive: true });

	// A clean build, so no chunk a development build retained for a running process ships.
	const [pnpm, buildArgs] = pnpmArgv(["run", "build:release"]);
	run(pnpm, buildArgs);
	const [report] = JSON.parse(read("npm", ["pack", "--json", "--pack-destination", assets]));
	const tarball = join(assets, report.filename);
	const reportPath = join(out, "pack-report.json");
	writeFileSync(reportPath, JSON.stringify(report));
	run(process.execPath, ["scripts/check-release.mjs", "--tarball", tarball, "--report", reportPath]);
	rmSync(reportPath);

	// Build metadata the Stage 0 budget test reads; it describes the tarball's chunks and is not published.
	writeFileSync(join(out, "metafile-esm.json"), readFileSync(join(root, "dist", "metafile-esm.json")));

	for (const name of INSTALLERS)
		writeFileSync(
			join(assets, name),
			execFileSync("tar", ["-xzOf", tarball, `package/scripts/${name}`], { maxBuffer: 16 * 1024 * 1024 }),
		);
	const mtime = Number(read("git", ["log", "-1", "--format=%ct"]));
	const bundles = await buildBundles({
		tarball,
		out: assets,
		targets,
		cache: join(tmpdir(), "pancode-node-cache"),
		mtime,
	});

	const names = [report.filename, ...bundles, ...INSTALLERS].sort();
	writeFileSync(join(assets, "SHA256SUMS"), names.map((name) => `${sha256(join(assets, name))}  ${name}\n`).join(""));
	writeFileSync(join(out, "release-notes.md"), releaseNotes());
	if (site) {
		const staged = join(out, "site.staging");
		buildSite(staged, commit, pkg.version);
		renameSync(staged, join(out, "site"));
	}
	const release = {
		schema: 1,
		name: pkg.name,
		version: pkg.version,
		commit,
		dirty,
		channel: releaseChannel(pkg.version),
		node: runtime.version,
		tarball: report.filename,
		integrity: report.integrity,
		targets,
		assets: [...names, "SHA256SUMS"],
	};
	writeFileSync(join(out, "release.json"), `${JSON.stringify(release, null, "\t")}\n`);
	return release;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({
		// `pnpm run release:build -- --out <dir>` hands the separator through.
		args: process.argv.slice(2).filter((argument) => argument !== "--"),
		options: {
			out: { type: "string" },
			targets: { type: "string", default: "host" },
			"no-site": { type: "boolean", default: false },
		},
	});
	if (!values.out) {
		console.error("usage: build.mjs --out <dir> [--targets host|all|<target>,<target>] [--no-site]");
		process.exit(2);
	}
	const targets =
		values.targets === "all" ? TARGETS : values.targets === "host" ? [hostTarget()] : values.targets.split(",");
	const release = await buildRelease({ out: resolve(values.out), targets, site: !values["no-site"] });
	console.log(
		`Built ${release.name}@${release.version} from ${release.commit.slice(0, 12)}${release.dirty ? " (uncommitted changes)" : ""}: ${release.assets.length} assets in ${join(resolve(values.out), "assets")}`,
	);
}
