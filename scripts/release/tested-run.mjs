#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/*
 * A release publishes the files that the push run of .github/workflows/ci.yml built and tested for the same
 * commit; it builds and tests nothing itself. The `tested run` and `publish` jobs of a release dispatch run:
 *
 *   tested-run.mjs find                     the newest push run of ci.yml for GITHUB_SHA on GITHUB_REF_NAME
 *                                           that completed with every job passed and still holds its `release`
 *                                           artifact; writes `run-id` to GITHUB_OUTPUT
 *   tested-run.mjs check <dir> [--sums <sha256>]
 *                                           that artifact, downloaded to <dir>, held against its SHA256SUMS and
 *                                           GITHUB_SHA; writes the SHA-256 of SHA256SUMS to GITHUB_OUTPUT as
 *                                           `sums`, and with --sums refuses a SHA256SUMS other than that one
 *
 * A commit with no such run is refused with the reason, within seconds of the dispatch.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readRelease } from "./publish.mjs";

const WORKFLOW = "ci.yml";
const ARTIFACT = "release";
/** The jobs only a release dispatch runs; a push run skips them. */
const RELEASE_JOBS = new Set(["tested run", "publish"]);
/** Gate jobs that every push run of ci.yml must run and pass. */
const REQUIRED_JOBS = ["check", "build", "ci (22)", "ci (24)"];

const ghPages = (path, field) =>
	JSON.parse(
		execFileSync("gh", ["api", "--paginate", "--slurp", path], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}),
	).flatMap((page) => page[field] ?? []);

function env(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set; this runs in a release dispatch of ${WORKFLOW}`);
	return value;
}

function output(name, value) {
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
	console.log(`${name}=${value}`);
}

function find() {
	const repository = env("GITHUB_REPOSITORY");
	const commit = env("GITHUB_SHA");
	const branch = env("GITHUB_REF_NAME");
	if (process.env.GITHUB_REF_TYPE && process.env.GITHUB_REF_TYPE !== "branch")
		throw new Error(`releases dispatch from a version branch, not ${process.env.GITHUB_REF_TYPE} ${branch}`);
	const query = new URLSearchParams({ event: "push", head_sha: commit, branch, per_page: "100" });
	const runs = ghPages(`repos/${repository}/actions/workflows/${WORKFLOW}/runs?${query}`, "workflow_runs")
		.filter(
			(entry) =>
				entry.event === "push" &&
				entry.head_sha === commit &&
				entry.head_branch === branch &&
				entry.path === `.github/workflows/${WORKFLOW}`,
		)
		.sort((a, b) => b.id - a.id);
	if (!runs.length)
		throw new Error(
			`no push run of ${WORKFLOW} built ${commit} on ${branch}. Push the commit to ${branch}, let its run pass, then dispatch the release again.`,
		);
	const run = runs.find((entry) => entry.status === "completed" && entry.conclusion === "success");
	if (!run) {
		const [newest] = runs;
		if (newest.status !== "completed")
			throw new Error(
				`the push run for ${commit} on ${branch} is ${newest.status}: ${newest.html_url}. Dispatch the release again once it passes.`,
			);
		throw new Error(
			`the push run for ${commit} on ${branch} concluded ${newest.conclusion}: ${newest.html_url}. Fix the cause, push, and dispatch the release at the new commit.`,
		);
	}
	const jobs = ghPages(`repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, "jobs");
	const unproven = jobs.filter(
		(job) =>
			job.status !== "completed" ||
			(job.conclusion !== "success" && !(RELEASE_JOBS.has(job.name) && job.conclusion === "skipped")),
	);
	if (unproven.length)
		throw new Error(
			`push run ${run.html_url} did not pass ${unproven.map((job) => `${job.name} (${job.conclusion ?? job.status})`).join(", ")}`,
		);
	const passed = jobs.filter((job) => job.status === "completed" && job.conclusion === "success");
	const passedNames = new Set(passed.map((job) => job.name));
	const missing = REQUIRED_JOBS.filter((name) => !passedNames.has(name));
	if (missing.length) throw new Error(`push run ${run.html_url} is missing required jobs: ${missing.join(", ")}`);
	const artifact = ghPages(
		`repos/${repository}/actions/runs/${run.id}/artifacts?name=${ARTIFACT}&per_page=100`,
		"artifacts",
	)
		.filter((entry) => entry.name === ARTIFACT)
		.sort((a, b) => b.id - a.id)[0];
	if (!artifact || artifact.expired)
		throw new Error(
			`push run ${run.html_url} no longer holds its ${ARTIFACT} artifact. Rerun it with \`gh run rerun ${run.id} --repo ${repository}\`, then dispatch the release again.`,
		);
	console.log(
		`Releasing the ${ARTIFACT} artifact (${artifact.size_in_bytes} bytes, expires ${artifact.expires_at}) of push run ${run.html_url}, where ${passed.length} jobs passed`,
	);
	output("run-id", run.id);
}

function check(directory, expectedSums) {
	const release = readRelease(directory, env("GITHUB_SHA"));
	const sums = createHash("sha256")
		.update(readFileSync(join(directory, "assets", "SHA256SUMS")))
		.digest("hex");
	if (expectedSums !== undefined && sums !== expectedSums)
		throw new Error(`SHA256SUMS hashes to ${sums}, not the ${expectedSums || "(empty)"} the tested run checked`);
	console.log(
		`${release.name}@${release.version} (${release.channel}) from ${release.commit}: ${release.assets.length} assets match SHA256SUMS`,
	);
	output("sums", sums);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const { values, positionals } = parseArgs({ options: { sums: { type: "string" } }, allowPositionals: true });
		const [command, directory] = positionals;
		if (command === "find" && positionals.length === 1 && values.sums === undefined) find();
		else if (command === "check" && positionals.length === 2 && directory) check(resolve(directory), values.sums);
		else throw new Error("usage: tested-run.mjs find | tested-run.mjs check <release dir> [--sums <sha256>]");
	} catch (error) {
		console.error(`tested-run: ${error.message}`);
		process.exitCode = 1;
	}
}
