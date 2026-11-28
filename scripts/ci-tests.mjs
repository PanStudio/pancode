#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { pinGateEnv } from "./gate-env.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Every workspace package's own tests, packages/<name>/tests/*.test.ts, gated in the core tier as they appear. */
function packageTestFiles() {
	const packages = join(root, "packages");
	if (!existsSync(packages)) return [];
	return readdirSync(packages, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(packages, entry.name, "tests")))
		.map((entry) => entry.name)
		.sort()
		.flatMap((name) =>
			readdirSync(join(packages, name, "tests"))
				.filter((file) => file.endsWith(".test.ts"))
				.sort()
				.map((file) => `packages/${name}/tests/${file}`),
		);
}

// Keep the development gate small and source-only. Package, platform and
// historical regressions stay available through their explicit commands.
export const coreTests = [
	"node-tools-remedy-relay",
	"provider-oauth-apikey-env",
	"cost-ceiling-side-calls",
	"escalation-timeout-clamp",
	"telemetry-apikey-envvar-name",
	"run-agent-admission-frame",
	"run-memory-refusal",
	"run-project-targets-no-borrow",
	"run-exit-summary-no-usage",
	"copilot-worker-failure",
	"package-manager-launch",
	"release-clean-build",
	"stale-build-replaced",
	"arcade-egg",
	"check-lane-selection",
	"handbook-bench",
	"dispatch-plan-preview-newlines",
	"interactive-ticker-idle",
	"streamed-code-fence",
	"reload-prompts",
	"telemetry-share-linkability",
	"mcp-extension-secret-mask",
	"runtime-plugin-env-key",
	"memory-off-marker",
	"headless-observed",
	"prompt-preconditions",
	"prompt-tier-golden",
	"prompt-section-matrix",
	"prompt-peers-catalog",
	"memory-recall-hygiene",
	"memory-observation-envelope",
	"dispatch-memory-scope",
	"oracle-second-opinion",
	"verifiability-routing",
	"mux-private-host",
	"memory-route-redaction",
	"prior-session-hint",
	"auth-storage-durability",
	"bash-exec-settlement",
	"bash-output-cap",
	"damage-control-shell-segments",
	"damage-control-git-words",
	"internal-git-hooks",
	"safety-gates",
	"safety-gate-findings",
	"default-containment",
	"setup-status",
	"key-prefix",
	"configure-import",
	"setup-next",
	"contained-secrets",
	"true-yolo",
	"contained-yolo",
	"autonomy-window",
	"transcript-operator-grant",
	"yolo-script-sandbox",
	"verify-sandbox-trojan",
	"search-completeness",
	"tool-boundaries",
	"engine-utilities",
	"assistant-text-tool-order",
	"test-runner-vocabulary",
	"worker-check-bypass-hardening",
	"sandbox-daemon-socket-masks",
	"bootstrap-schema-retry-identity",
	"installed-package-ci",
	"release-boundary",
	"release-plan",
	"workflow-policy",
	"store-admission",
	"store-paths",
	"store-backend-conformance",
	"store-records",
	"store-tool",
	"store-cli",
	"store-tag-grants",
	"mcp-store-references",
	"dispatch-session-ownership",
	"detached-batch-wake",
	"run-script-store-inputs",
	"hub-skill-ranking",
	"hub-signature",
	"hub-trust",
	"hub-packs-plugin-servers",
	"prefix-stagger",
	"monitor-steer-tools",
	"dispatch-write-root-request",
	"gateway-authority",
	"gateway-corrections",
	"mutation-atomicity",
	"open-browser",
	"physical-dotdot",
	"proxy-env-bypass",
	"read-scope",
	"session-durability",
	"project-settings-save",
	"state-file-lock",
	"verification-slot",
	"symlink-escape",
	"turn-outcome-settlement",
	"worker-grant-broker",
	"worker-permit",
	"worker-refusal-limit",
	"worker-result-contract-enforcement",
	"job-admission",
	"job-tool",
	"monitor-collect",
	"judge-screen-park-surfaces",
	"acp-v1-basics",
	"acp-readouts",
	"acp-attended-remote",
	"configure-routing",
	"configure-pancode-tool",
	"settings-authority",
	"settings-controls",
	"mcp-config-trust",
	"project-trust-card",
	"url-userinfo-hold",
	"url-credential-surfaces",
	"bootstrap-grounding",
	"in-prefix-summary",
	"compaction-exact-facts",
	"stale-edit-guard",
	"replay-unsent-call-usage",
	"overflow-compaction-fit",
	"overflow-fit-pin",
	"compaction-summary-tool-results",
	"packed-source-directory",
	"eval-onboarding-rescore",
	"code-nav",
	"skill-frontmatter-cache",
	"codewiki-grammar-note",
	"read-only-user-files",
	"read-only-remedy",
	"sandbox-pancode-roots",
	"fleet-run-history-prime",
	"codewiki-worker-identity",
	"telemetry-multi-install",
	"approval-card-arguments",
	"footer-snapshot",
	"quota-tui",
	"quota-poll-loop",
	"tui-presentation-modes",
	"copilot-sdk-route",
	"copilot-keychain",
	"copilot-context-tier",
	"copilot-context-tier-setting",
	"web-read-taint",
	"doctor-unknown-runtime",
	"plugin-engine",
	"plugin-verified-tree",
	"claims-ledger",
	"arena",
	"research-campaign",
	"cli-leaf-help",
	"mux-platform-win32",
	"keyboard-model",
	"background-surfaces",
	"completed-worker-presentation",
	"gateway-prompt",
	"yolo-continuation",
	"host-verification-admission",
	"receipt-verify-latest-outcome",
	"verify-numeric",
	"verify-numeric-boundaries",
	"verify-reproduce",
	"verify-toolchain-checks",
	"verify-task-gates",
	"provider-error-presentation",
	"handbook-discovery",
	"report-share",
	"report-dataset",
	"typecheck-corpus",
	"anthropic-thread-idle",
	"store-put-identity",
	"upgrade-command",
	"hub-default-packs",
	"launcher-guard",
	"extension-hook-turn-origin",
	"extension-interview-answer",
	"extension-promoted-tools",
	"extension-test-tmpdir",
	"extension-validate-workspace",
	"gateway-scope-shapes",
	"loop-guard-scenarios",
	"middleware-required-tool-gateway",
	"repetition-detector",
	"tool-markup-reprompt-budget",
	"cache-read-unreported",
	"turn-scope-shell-note",
	"working-set-skill-protection",
	"json-payload-trailing-result",
	"verifier-review-verdict-label",
	"operator-local-date",
	"count-tool",
	"template-turn-step-policy",
	"model-tier-metadata",
	"extension-pinned-context",
	"run-answers-scripted",
	"continuation-last-tool-call",
	"telemetry-token-sources",
	"compact-tool-results",
	"observation-aging",
	"observation-aging-gate",
	"observation-aging-rebuild",
	"detail-ledger-resume",
	"step-compact-start",
	"extension-pinned-restart",
	"responses-pinned-round-tools",
	"campaign-run",
	"extension-ignorable-keys",
	"template-step-when",
	"context-fold-pins",
	"context-fold-witnesses",
	"extension-host-services",
]
	.map((name) => `tests/contracts/${name}.test.ts`)
	// Signature features whose guards live in the extended suite: the working
	// set, judged perf checks and sealed receipts under heartbeat contention.
	.concat(
		["working-set-core", "verify-perf", "dispatch-heartbeat-finalization"].map(
			(name) => `tests/extended/${name}.test.ts`,
		),
	)
	// The issue labeler runs on untrusted report bodies in GitHub Actions.
	.concat(".github/scripts/report-labels.test.mjs")
	.concat(packageTestFiles());

// Every top-level GUI test file. tests/real drives a real browser or a live agent and keeps its own commands.
export const guiTests = readdirSync(join(root, "apps/pancode-gui/tests"))
	.filter((name) => /\.test\.tsx?$/u.test(name))
	.sort()
	.map((name) => `tests/${name}`);

export const packageTests = [
	"tests/smoke/installed-package.test.ts",
	"tests/smoke/native-call-timing.test.ts",
	"tests/contracts/instant-shell-import-graph.test.ts",
	"tests/extended/dogfood-doctor-readonly.test.ts",
];

export const fullTests = ["contracts", "extended", "smoke", "extended-smoke"].flatMap((suite) =>
	readdirSync(join(root, "tests", suite))
		.filter((name) => name.endsWith(".test.ts"))
		.sort()
		.map((name) => `tests/${suite}/${name}`),
);

// Qualification runs the core, GUI and package tiers at once. Core at four
// (da71294f7) was measured alone on 24 CPUs; on a 4-vCPU hosted runner the
// combined eight test processes pushed timing-bound ACP, idle-exit and RPC
// deadline tests past their limits in ci (22), so small hosts keep two.
const rootConcurrency = availableParallelism() >= 8 ? 4 : 2;

/** `skipped`, when given, receives the tier's skipped-test count: skips are how a missing tool or sandbox hides. */
export async function runTests(tier, { skipped } = {}) {
	const gui = tier === "gui";
	const cwd = gui ? join(root, "apps/pancode-gui") : root;
	const files = { core: coreTests, gui: guiTests, package: packageTests, full: fullTests }[tier];
	if (!files) throw new Error(`Unknown test tier: ${tier}`);
	// Headless-run contracts spawn the built CLI and dispatched workers start dist/worker/entry.js, so a checkout that
	// was never built fails them; qualification extracts dist/ from the candidate before it gets here. The code-map
	// contracts do not need it: tree-sitter.ts falls back to the grammar devDependencies.
	if (
		(tier === "core" || tier === "full") &&
		!["dist/cli/index.js", "dist/worker/entry.js"].every((file) => existsSync(join(root, file)))
	)
		throw new Error(
			`${tier} tests spawn dist/cli/index.js and dist/worker/entry.js; run \`pnpm run build\` once in this checkout first`,
		);
	const preloads = [join(root, "tests/harness/tmp-root.ts"), ...(gui ? ["./tests/harness/no-network.ts"] : [])];
	// GUI tests that launch the server use the client build the tier already has: the app's own build, or the package's
	// dist/gui/client that qualification extracts from the tarball. With neither, the tier supplies one static fixture for
	// its whole run, so no test process creates or removes a shared client directory under another.
	const fixtureClient =
		gui && !["apps/pancode-gui/dist/client", "dist/gui/client"].some((dir) => existsSync(join(root, dir, "index.html")))
			? join(cwd, "dist/client")
			: null;
	if (fixtureClient) {
		mkdirSync(fixtureClient, { recursive: true });
		writeFileSync(join(fixtureClient, "index.html"), "<h1>Fixture client</h1>");
	}
	const started = performance.now();
	const results = await runFiles(files, {
		cwd,
		preloads,
		concurrency: tier === "core" || tier === "full" ? rootConcurrency : 2,
	}).finally(() => {
		if (fixtureClient) rmSync(fixtureClient, { recursive: true, force: true });
	});
	const total = Object.fromEntries(summaryFields.map((name) => [name, 0]));
	for (const result of results) for (const name of summaryFields) total[name] += result.summary[name] ?? 0;
	const failed = results.filter((result) => result.code !== 0);
	if (failed.length) {
		console.log(`\n✖ ${failed.length} failing ${failed.length === 1 ? "file" : "files"}:`);
		for (const result of failed)
			console.log(result.overrun ? `${result.file}: killed after the ${fileBoundMs} ms file bound` : result.file);
	}
	for (const name of summaryFields) console.log(`ℹ ${name} ${total[name]}`);
	console.log(`ℹ duration_ms ${Math.round(performance.now() - started)}`);
	const count = total.tests;
	if (count < 1) throw new Error(`Missing ${tier} test count`);
	const skips = total.skipped;
	if (skipped) skipped[tier] = skips;
	if (process.env.PANCODE_TEST_SUMMARY)
		appendFileSync(
			process.env.PANCODE_TEST_SUMMARY,
			`${JSON.stringify({ tier, tests: count, skipped: skips, passed: failed.length === 0, files: files.length })}\n`,
		);
	if (failed.length) throw new Error(`${tier} tests failed (${failed.length} of ${files.length} files)`);
	return count;
}

const summaryFields = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];
// A file whose tests all settle but which leaves a live handle (a lane, a child, a server) never exits, and
// --test-timeout bounds tests, never the file: one such file stalled test:gui with no end. Each file runs as
// its own `node --test` in its own process group; one still running past this bound is killed with
// everything it started and failed, and the tier goes on. Generous: the slowest file under a loaded host
// takes a few minutes.
const fileBoundMs = Number(process.env.PANCODE_TEST_FILE_BOUND_MS) || 15 * 60_000;
const liveGroups = new Set();
const killGroup = (pid) => {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {}
};
// Each file's group is its own, so a terminal's Ctrl-C never reaches it: the runner passes it on.
const interrupted = (signal) => {
	for (const pid of liveGroups) killGroup(pid);
	process.exit(128 + (signal === "SIGINT" ? 2 : 15));
};

/** Runs each file in its own process group, `concurrency` at a time, printing each file's report whole as it ends. */
async function runFiles(files, { cwd, preloads, concurrency }) {
	const queue = [...files],
		results = [];
	const worker = async () => {
		for (let file = queue.shift(); file !== undefined; file = queue.shift())
			results.push(await runFile(file, { cwd, preloads }));
	};
	for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, interrupted);
	try {
		await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
	} finally {
		for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, interrupted);
	}
	return results;
}

function runFile(file, { cwd, preloads }) {
	return new Promise((resolve, reject) => {
		const started = performance.now();
		const child = spawn(
			process.execPath,
			["--import", "tsx", ...preloads.flatMap((preload) => ["--import", preload]), "--test", "--test-reporter=spec", file],
			// A test child's default locale is fixed when it starts, so the runner that spawns it starts pinned.
			{ cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: pinGateEnv({ ...process.env }) },
		);
		liveGroups.add(child.pid);
		let transcript = "",
			overrun = false;
		const bound = setTimeout(() => {
			overrun = true;
			killGroup(child.pid);
		}, fileBoundMs);
		for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => (transcript += chunk));
		child.once("error", reject);
		child.once("close", (status) => {
			clearTimeout(bound);
			// Whatever the file left behind in its group goes with it.
			killGroup(child.pid);
			liveGroups.delete(child.pid);
			const seconds = ((performance.now() - started) / 1000).toFixed(1);
			process.stdout.write(`\n${file} (${seconds} s)\n${transcript}`);
			if (overrun) process.stdout.write(`✖ ${file} still running after the ${fileBoundMs} ms file bound; killed\n`);
			const plain = stripVTControlCharacters(transcript);
			// The file's own summary is its last one. A contract that starts a nested `node --test` prints a
			// summary too, and reading the first one recorded the core tier as 1 test instead of its 1762.
			const summary = Object.fromEntries(
				summaryFields.map((name) => [
					name,
					Number([...plain.matchAll(new RegExp(`(?:ℹ|#) ${name} (\\d+)`, "gu"))].at(-1)?.[1] ?? 0),
				]),
			);
			const code = overrun ? 1 : (status ?? 1);
			resolve({ file, code, overrun, summary });
		});
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv[2] === "list") {
			for (const [tier, dir, selected] of [
				["core", "tests/contracts", coreTests],
				["gui", "apps/pancode-gui/tests", guiTests.map((path) => `apps/pancode-gui/${path}`)],
			]) {
				console.log(`\n${tier}: default behavior checks\n${selected.join("\n")}`);
				const omitted = readdirSync(join(root, dir))
					.filter((name) => /\.test\.tsx?$/u.test(name))
					.map((name) => `${dir}/${name}`)
					.filter((name) => !selected.includes(name));
				console.log(`\n${tier}: full investigation only\n${omitted.join("\n")}`);
			}
		} else await runTests(process.argv[2]);
	} catch (error) {
		console.error(`ci-tests: ${error.message}`);
		process.exitCode = 1;
	}
}
