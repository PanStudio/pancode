#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/*
 * The gate, with one definition for a developer's machine and for CI (.github/workflows/ci.yml):
 *
 *   pnpm run ci                           check, build, test and install this checkout on this machine's Node
 *   node scripts/ci.mjs check             typecheck, lint, GUI check, hub check
 *   node scripts/ci.mjs test <release>    the test tiers and the npm install check against a built release
 *
 * A release is the directory scripts/release/build.mjs writes. The tests run against the dist/ inside its npm
 * tarball, so what passes here is what gets published.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackedInstall } from "./check-packed-install.mjs";
import { runTests } from "./ci-tests.mjs";
import { ensureSearchTools, withSearchTools } from "./ci-tools.mjs";
import { pinGateEnv } from "./gate-env.mjs";
import { pnpmArgv } from "./pnpm.mjs";
import { buildRelease } from "./release/build.mjs";
import { hostTarget } from "./release/bundle.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// lint holds the PanHub pins (check-hygiene runs `pin-hub.ts --check`).
const CHECKS = ["typecheck:compare", "lint", "check:gui"];

function pnpmScript(script) {
	return new Promise((done, fail) => {
		const [command, args] = pnpmArgv(["run", script]);
		const child = spawn(command, args, { cwd: root, stdio: "inherit" });
		child.once("error", fail);
		child.once("close", (code) => (code === 0 ? done() : fail(new Error(`${script} failed (exit ${code})`))));
	});
}

/** The checks read src/, tests/, apps/ and hub/ and never dist/, so they run beside each other and beside a build. */
async function check() {
	const failed = (await Promise.allSettled(CHECKS.map(pnpmScript))).filter((outcome) => outcome.status === "rejected");
	if (failed.length) throw new Error(failed.map((outcome) => outcome.reason.message).join("\n"));
}

async function test(directory) {
	const release = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
	const tarball = join(directory, "assets", release.tarball);
	rmSync(join(root, "dist"), { recursive: true, force: true });
	execFileSync("tar", ["-xzf", tarball, "--strip-components=1", "-C", root, "package/dist"]);
	writeFileSync(join(root, "dist", "metafile-esm.json"), readFileSync(join(directory, "metafile-esm.json")));
	process.env.PANCODE_RELEASE_TARBALL = tarball;
	// The same rg and fd on every machine: a missing one skips the search contracts without failing.
	const tools = await ensureSearchTools(join(tmpdir(), "pancode-search-tools"));
	process.env.PATH = withSearchTools(process.env, tools).PATH;
	const tiers = ["core", "gui", "package"];
	const skipped = {};
	const outcomes = await Promise.allSettled(tiers.map((tier) => runTests(tier, { skipped })));
	for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
	const counts = Object.fromEntries(outcomes.map((outcome, index) => [tiers[index], outcome.value]));
	// The tarball installed alone into a fresh prefix, as an npm user gets it.
	const scratch = mkdtempSync(join(tmpdir(), "pancode-ci-install-"));
	try {
		const report = await checkPackedInstall({ tarball, prefix: join(scratch, "prefix") });
		for (const line of report.lines) console.log(`check-packed-install: ${line}`);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	// Skips are how an environment difference hides: compare this line between a local run and its CI job.
	console.log(
		`Tests: ${JSON.stringify(counts)}, skipped ${JSON.stringify(skipped)}, Node ${process.version}, rg ${tools.versions.rg}, fd ${tools.versions.fd} (${tools.source}), TZ ${process.env.TZ}`,
	);
}

async function all() {
	const started = Date.now();
	const out = mkdtempSync(join(tmpdir(), "pancode-ci-"));
	try {
		// The checks overlap the build; either failing fails the gate once both have ended.
		const checking = check().then(
			() => null,
			(error) => error,
		);
		const release = await buildRelease({ out, targets: [hostTarget()], site: true });
		const checkFailure = await checking;
		if (checkFailure) throw checkFailure;
		await test(out);
		execFileSync(process.execPath, [join(root, "scripts", "release", "smoke.mjs"), join(out, "assets")], {
			stdio: "inherit",
		});
		console.log(
			`PASSED ${release.commit.slice(0, 12)}${release.dirty ? " with uncommitted changes" : ""} on Node ${process.version} (${hostTarget()}) in ${Math.round((Date.now() - started) / 1000)} s`,
		);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

// Checks, tests and the install smoke all run under one zone and locale, here and in CI.
pinGateEnv();
try {
	const [mode, directory] = process.argv.slice(2);
	if (mode === undefined) await all();
	else if (mode === "check") await check();
	else if (mode === "test" && directory) await test(resolve(directory));
	else throw new Error("usage: ci.mjs [check | test <release dir>]");
} catch (error) {
	console.error(`ci: ${error.message}`);
	process.exitCode = 1;
}
