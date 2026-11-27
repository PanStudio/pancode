#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/*
 * Publishes what scripts/release/build.mjs wrote, in this order, and nothing else:
 *
 *   1. npm: the tarball, under the version's dist-tag
 *   2. GitHub: the tag and a release holding every asset
 *   3. main: fast-forwarded to the released commit (stable only)
 *   4. gh-pages: the website (stable only) and the channel file the installers read
 *
 * The channel file moves last, so no installer or update check is told about a version before its bundle
 * can be downloaded. Every step first reads what is already published: a rerun after a failure completes
 * the open steps, and bytes that differ from what an earlier run published stop it.
 *
 * It runs in the `publish` job of .github/workflows/ci.yml after the owner approves the `release`
 * environment. `--registry` and `--remote` point it at a loopback registry and a local repository for a
 * rehearsal, which skips the GitHub release because only GitHub can hold one.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { releaseVersionErrors } from "../release-version-policy.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const REPOSITORY = "PanStudio/pancode";
const REGISTRY = "https://registry.npmjs.org/";

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function capture(command, args, options = {}) {
	return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

/** The command's output, or null when it fails with `absent` in its error text. Any other failure throws. */
function captureUnless(absent, command, args, options) {
	try {
		return capture(command, args, options);
	} catch (error) {
		if (absent.test(`${error.stderr ?? ""}${error.stdout ?? ""}`)) return null;
		throw new Error(`${command} ${args.join(" ")} failed: ${(error.stderr || error.message).trim()}`);
	}
}

/** The release in `directory`, refused unless it is publishable; `commit` is the commit the caller's run checked out. */
export function readRelease(directory, commit, changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8")) {
	const release = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
	const problems = [];
	if (release.channel === null)
		problems.push(`${release.version} is a development version; only x.y.z and x.y.z-rc.N are published`);
	if (release.dirty) problems.push("the release was built from a checkout with uncommitted changes");
	if (commit && commit !== release.commit)
		problems.push(`the release was built from ${release.commit}, not this run's commit ${commit}`);
	problems.push(
		...releaseVersionErrors({
			version: release.version,
			changelog,
			releaseContext: true,
		}),
	);
	const sums = new Map(
		readFileSync(join(directory, "assets", "SHA256SUMS"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split(/\s+/u).reverse()),
	);
	for (const name of release.assets.filter((asset) => asset !== "SHA256SUMS"))
		if (sums.get(name) !== sha256(join(directory, "assets", name))) problems.push(`${name} does not match SHA256SUMS`);
	const integrity = `sha512-${createHash("sha512")
		.update(readFileSync(join(directory, "assets", release.tarball)))
		.digest("base64")}`;
	if (integrity !== release.integrity)
		problems.push(`${release.tarball} does not match the integrity release.json records`);
	if (problems.length) throw new Error(`Not publishable:\n  ${problems.join("\n  ")}`);
	return { ...release, sums };
}

async function publishNpm(release, directory, registry) {
	const spec = `${release.name}@${release.version}`;
	const served = () =>
		captureUnless(/E404|404 Not Found/u, "npm", ["view", spec, "dist.integrity", "--registry", registry]);
	const before = served();
	if (before === release.integrity) return console.log(`npm: ${spec} is already published with these bytes`);
	if (before) throw new Error(`npm serves ${spec} with integrity ${before}, not the ${release.integrity} built here`);
	execFileSync(
		"npm",
		[
			"publish",
			join(directory, "assets", release.tarball),
			"--tag",
			release.channel,
			"--access",
			"public",
			"--registry",
			registry,
		],
		{ stdio: "inherit" },
	);
	// npm took 13 minutes to serve 0.9.0 and 16 to serve 0.9.1 after accepting them.
	for (let attempt = 0; attempt < 180; attempt++) {
		if (served() === release.integrity) return console.log(`npm: published ${spec} under ${release.channel}`);
		await sleep(10_000);
	}
	throw new Error(`npm accepted ${spec} but does not serve it after 30 minutes; rerun the job to continue`);
}

function publishGitHubRelease(release, directory) {
	const tag = `v${release.version}`;
	const gh = (...args) => capture("gh", args, { cwd: root });
	const existing = JSON.parse(gh("api", `repos/${REPOSITORY}/releases`, "--paginate", "--slurp"))
		.flat()
		.find((entry) => entry.tag_name === tag);
	if (existing && !existing.draft) {
		const published = new Map(existing.assets.map((asset) => [asset.name, asset.digest]));
		for (const name of release.assets) {
			const expected = `sha256:${name === "SHA256SUMS" ? sha256(join(directory, "assets", name)) : release.sums.get(name)}`;
			if (published.get(name) !== expected)
				throw new Error(
					`GitHub release ${tag} holds ${name} as ${published.get(name) ?? "nothing"}, not the ${expected} built here`,
				);
		}
		return console.log(`GitHub: release ${tag} is already published with these assets`);
	}
	const kind = release.channel === "latest" ? ["--latest"] : ["--prerelease", "--latest=false"];
	if (!existing)
		gh(
			"release",
			"create",
			tag,
			"--repo",
			REPOSITORY,
			"--draft",
			"--target",
			release.commit,
			"--title",
			`PanCode ${release.version}`,
			"--notes-file",
			join(directory, "release-notes.md"),
			...kind,
		);
	gh(
		"release",
		"upload",
		tag,
		"--repo",
		REPOSITORY,
		"--clobber",
		...release.assets.map((name) => join(directory, "assets", name)),
	);
	// Publishing the draft creates the tag at the target commit and, with release immutability on, seals the assets.
	gh("release", "edit", tag, "--repo", REPOSITORY, "--draft=false", ...kind);
	const tagged = JSON.parse(gh("api", `repos/${REPOSITORY}/git/ref/tags/${tag}`)).object.sha;
	if (tagged !== release.commit)
		throw new Error(`tag ${tag} is at ${tagged}, not the released commit ${release.commit}`);
	console.log(`GitHub: published release ${tag} with ${release.assets.length} assets`);
}

function promoteMain(release, remote) {
	const main = capture("git", ["ls-remote", remote, "refs/heads/main"], { cwd: root }).split(/\s/u)[0];
	if (main === release.commit) return console.log("main: already at the released commit");
	// A plain push: git refuses anything but a fast-forward.
	execFileSync("git", ["push", remote, `${release.commit}:refs/heads/main`], { cwd: root, stdio: "inherit" });
	console.log(`main: fast-forwarded to ${release.commit.slice(0, 12)}`);
}

/**
 * gh-pages holds the website and `channel/<latest|beta>`, one line each naming a version. A stable release
 * replaces the site and moves both channels, since it is newer than every pre-release before it; a
 * pre-release moves only `channel/beta` and leaves the site as it is.
 */
function deployPages(release, directory, remote) {
	const scratch = mkdtempSync(join(tmpdir(), "pancode-pages-"));
	const git = (...args) => capture("git", ["-C", scratch, ...args]);
	try {
		git("init", "--quiet", "--initial-branch=gh-pages");
		if (capture("git", ["ls-remote", remote, "refs/heads/gh-pages"], { cwd: root })) {
			git("fetch", "--quiet", "--depth=1", remote, "gh-pages");
			git("reset", "--quiet", "--hard", "FETCH_HEAD");
		}
		const stable = release.channel === "latest";
		if (stable) {
			for (const name of readdirSync(scratch))
				if (name !== ".git") rmSync(join(scratch, name), { recursive: true, force: true });
			cpSync(join(directory, "site"), scratch, { recursive: true });
		}
		mkdirSync(join(scratch, "channel"), { recursive: true });
		for (const channel of stable ? ["latest", "beta"] : ["beta"])
			writeFileSync(join(scratch, "channel", channel), `${release.version}\n`);
		git("add", "--all");
		if (!git("status", "--porcelain")) return console.log("gh-pages: already serves this release");
		git(
			"-c",
			"user.name=pancode-release[bot]",
			"-c",
			"user.email=pancode-release[bot]@users.noreply.github.com",
			"commit",
			"--quiet",
			"-m",
			`deploy: PanCode ${release.version} from ${release.commit.slice(0, 12)}`,
		);
		execFileSync("git", ["-C", scratch, "push", "--quiet", remote, "HEAD:refs/heads/gh-pages"], { stdio: "inherit" });
		console.log(
			`gh-pages: ${stable ? "deployed the website and " : ""}moved channel ${stable ? "latest and beta" : "beta"} to ${release.version}`,
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { values, positionals } = parseArgs({
		options: { registry: { type: "string" }, remote: { type: "string" } },
		allowPositionals: true,
	});
	try {
		if (!positionals[0])
			throw new Error("usage: publish.mjs <release dir> [--registry <loopback url> --remote <local repository>]");
		const rehearsal = values.registry !== undefined || values.remote !== undefined;
		if (rehearsal) {
			if (process.env.GITHUB_ACTIONS)
				throw new Error("--registry and --remote rehearse locally; CI publishes to npm and GitHub");
			if (!values.registry || !values.remote) throw new Error("a rehearsal names both --registry and --remote");
			const host = new URL(values.registry).hostname;
			if (!["127.0.0.1", "localhost"].includes(host))
				throw new Error(`--registry must be a loopback registry, not ${host}`);
			if (!existsSync(values.remote)) throw new Error(`--remote ${values.remote} is not a local repository`);
		}
		const directory = resolve(positionals[0]);
		const release = readRelease(directory, process.env.GITHUB_SHA);
		const remote = values.remote ? resolve(values.remote) : `https://github.com/${REPOSITORY}.git`;
		console.log(
			`Publishing ${release.name}@${release.version} (${release.channel}) from ${release.commit}${rehearsal ? " as a rehearsal" : ""}`,
		);
		await publishNpm(release, directory, values.registry ?? REGISTRY);
		if (rehearsal)
			console.log(
				`GitHub: skipped in a rehearsal (would publish release v${release.version} with ${release.assets.length} assets)`,
			);
		else publishGitHubRelease(release, directory);
		if (release.channel === "latest") promoteMain(release, remote);
		deployPages(release, directory, remote);
		console.log(`Published PanCode ${release.version}.`);
	} catch (error) {
		console.error(`publish: ${error.message}`);
		process.exitCode = 1;
	}
}
