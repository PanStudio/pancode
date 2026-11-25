// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";

const planModule = "../../scripts/release/plan.mjs";
const receiptModule = "../../scripts/release/receipt.mjs";
const publishModule = "../../scripts/release-publish.mjs";
const preflightModule = "../../scripts/preflight.mjs";
const budgetsModule = "../../scripts/release-budgets.mjs";
const gateEnvModule = "../../scripts/gate-env.mjs";
const registryModule = "../../scripts/release/registry.mjs";
const commit = "a".repeat(40);

describe("release decisions", () => {
	it("refuses the shared /tmp and socket-breaking TMPDIR lengths", async () => {
		const { tmpdirProblem } = await import(planModule);
		ok(tmpdirProblem("/tmp"));
		ok(tmpdirProblem("/tmp/pancode"));
		ok(tmpdirProblem(`/home/${"x".repeat(40)}`));
		strictEqual(tmpdirProblem("/home/u/.cache/cr"), null);
	});

	it("lets only release tooling differ between the candidate and the finishing head", async () => {
		const { toolingOnly } = await import(planModule);
		ok(toolingOnly(["scripts/release-publish.mjs", ".github/workflows/release.yml", "scripts/release/plan.mjs"]));
		ok(!toolingOnly(["scripts/release-publish.mjs", "src/cli.ts"]));
		ok(!toolingOnly([".github/workflows/ci.yml"]));
		ok(!toolingOnly([]));
	});

	it("accepts the version branch of a two-digit patch or minor", async () => {
		const { isVersionBranch } = await import(planModule);
		ok(isVersionBranch("v071") && isVersionBranch("v0710") && isVersionBranch("v0100"));
		ok(!isVersionBranch("v07") && !isVersionBranch("main") && !isVersionBranch("v071-x"));
	});

	it("pins a stale draft to the candidate before publishing it", async () => {
		const { draftAction } = await import(planModule);
		strictEqual(draftAction({ release: null, tagCommit: null }, commit).action, "create");
		strictEqual(
			draftAction({ release: { draft: true, target_commitish: "main" }, tagCommit: null }, commit).action,
			"retarget",
		);
		strictEqual(
			draftAction({ release: { draft: true, target_commitish: commit }, tagCommit: null }, commit).action,
			"publish",
		);
		strictEqual(draftAction({ release: { draft: false }, tagCommit: commit }, commit).action, "verify");
		strictEqual(draftAction({ release: null, tagCommit: "b".repeat(40) }, commit).action, "stop");
	});

	it("finishes only a version npm serves from an ancestor of the branch head, never publishing", async () => {
		const { finishGate } = await import(publishModule);
		const scratch = mkdtempSync(join(tmpdir(), "pancode-finish-"));
		try {
			const tarball = join(scratch, "pancode-0.7.1.tgz");
			writeFileSync(tarball, "qualified bytes");
			const integrity = `sha512-${createHash("sha512").update("qualified bytes").digest("base64")}`;
			const receipt = { name: "pancode", version: "0.7.1", commit, tarball };
			const head = "b".repeat(40);
			const calls: string[] = [];
			const served = { name: receipt.name, version: receipt.version, dist: { integrity } };
			const deps = (published: unknown, ancestor: boolean) => ({
				registry: async (name: string, version: string) => {
					calls.push(`registry ${name}@${version}`);
					return published;
				},
				isAncestor: (a: string, b: string) => {
					calls.push(`ancestor ${a} ${b}`);
					return ancestor;
				},
			});
			await rejects(finishGate({ receipt, commit, branchHead: head }, deps(null, true)), /needs npm to serve/u);
			await rejects(
				finishGate({ receipt, commit, branchHead: head }, deps({ ...served, dist: { integrity: "sha512-x" } }, true)),
				/different bytes/u,
			);
			await rejects(finishGate({ receipt, commit, branchHead: head }, deps(served, false)), /not an ancestor/u);
			strictEqual(await finishGate({ receipt, commit, branchHead: head }, deps(served, true)), commit);
			ok(calls.every((call) => call.startsWith("registry ") || call.startsWith("ancestor ")));
			// The only npm publish in the publisher is the rehearsal's dry run.
			const source = readFileSync(new URL("../../scripts/release-publish.mjs", import.meta.url), "utf8");
			deepStrictEqual(
				source.match(/\[\s*"publish"[^\]]*/gu)?.map((args) => args.includes("--dry-run")),
				[true],
			);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("release setup", () => {
	const app = { actor_id: 5919481, actor_type: "Integration", bypass_mode: "always" };
	const ruleset = (target: string, include: string[], types: string[], bypass: unknown[] = []) => ({
		target,
		enforcement: "active",
		conditions: { ref_name: { include, exclude: [] } },
		rules: types.map((type) =>
			type === "required_status_checks"
				? { type, parameters: { required_status_checks: [{ context: "ci (22)" }, { context: "ci (24)" }] } }
				: { type },
		),
		bypass_actors: bypass,
	});
	const ready = () => ({
		visibility: "public",
		environment: {
			protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "akougkas" } }] }],
			deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
		},
		policies: [
			{ name: "v*", type: "tag" },
			{ name: "v[0-9][0-9][0-9]", type: "branch" },
		],
		variable: { name: "RELEASE_APP_ID", value: "5919481" },
		secret: { name: "RELEASE_APP_PRIVATE_KEY" },
		rulesets: [
			ruleset("branch", ["refs/heads/main"], ["deletion", "non_fast_forward"]),
			ruleset("branch", ["refs/heads/main"], ["pull_request", "required_status_checks"], [app]),
			ruleset("tag", ["refs/tags/v*"], ["creation"], [app]),
			ruleset("tag", ["refs/tags/v*"], ["update", "deletion"]),
		],
	});

	it("accepts the configured repository and refuses a release environment without the owner's review", async () => {
		const { releaseSetupProblems } = await import(planModule);
		deepStrictEqual(releaseSetupProblems(ready()), []);
		const unreviewed = { ...ready(), environment: { ...ready().environment, protection_rules: [] } };
		deepStrictEqual(releaseSetupProblems(unreviewed), [
			"the release environment has no required reviewer akougkas, so release.yml would publish unapproved",
		]);
		const missing = releaseSetupProblems({
			visibility: "private",
			environment: null,
			policies: [],
			variable: null,
			secret: null,
			rulesets: [],
		});
		ok(missing.includes("the repository is private, where GitHub does not enforce the release environment's reviewer"));
		ok(missing.includes("the release environment does not exist"));
		ok(missing.includes("no ruleset requires ci (22) and ci (24) on main"));
	});

	it("refuses an App bypass of published-tag immutability", async () => {
		const { releaseSetupProblems } = await import(planModule);
		const setup = ready();
		setup.rulesets[2] = ruleset("tag", ["refs/tags/v*"], ["creation", "update", "deletion"], [app]);
		setup.rulesets.pop();
		deepStrictEqual(releaseSetupProblems(setup), [
			"no tag ruleset makes published v* tags immutable for everyone",
			"the release App bypasses a ruleset that protects published tags; keep v* creation in its own ruleset",
		]);
	});
});

describe("release ownership", () => {
	it("admits one operator, takes over from a dead holder, and lets spawned steps inherit", async () => {
		const { acquireLock, LockHeld } = await import(receiptModule);
		const state = mkdtempSync(join(tmpdir(), "pancode-release-lock-"));
		try {
			const first = acquireLock(state, "release", { pid: 101, host: "h", isAlive: () => true });
			throws(() => acquireLock(state, "release", { pid: 102, host: "h", isAlive: () => true }), LockHeld);
			const child = acquireLock(state, "qualify", {
				pid: 103,
				host: "h",
				isAlive: () => true,
				inherit: true,
				env: { PANCODE_RELEASE_LOCK_PID: "101" },
			});
			child.release();
			ok(existsSync(join(state, "lock")));
			const next = acquireLock(state, "release", { pid: 104, host: "h", isAlive: () => false });
			strictEqual(next.takeover.pid, 101);
			first.release();
			ok(existsSync(join(state, "lock")));
			next.release();
			ok(!existsSync(join(state, "lock")));
			writeFileSync(join(state, "lock"), JSON.stringify({ host: "other", pid: 1 }));
			throws(() => acquireLock(state, "release", { pid: 105, host: "h", isAlive: () => false }), LockHeld);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});

	it("lets only one of two operators take over a dead holder's lock", async () => {
		const { acquireLock, LockHeld } = await import(receiptModule);
		const state = mkdtempSync(join(tmpdir(), "pancode-release-lock-"));
		const lock = join(state, "lock");
		try {
			writeFileSync(lock, JSON.stringify({ host: "h", pid: 101, startedAt: "t0" }));
			// While this operator decides pid 101 is dead, another one completes its takeover.
			const isAlive = (pid: number) => {
				if (pid !== 101) return true;
				writeFileSync(lock, JSON.stringify({ host: "h", pid: 200, startedAt: "t1" }));
				return false;
			};
			throws(() => acquireLock(state, "release", { pid: 300, host: "h", isAlive }), LockHeld);
			strictEqual(JSON.parse(readFileSync(lock, "utf8")).pid, 200);
			// A takeover already in progress is never second-guessed.
			writeFileSync(lock, JSON.stringify({ host: "h", pid: 101, startedAt: "t0" }));
			writeFileSync(join(state, "lock.takeover"), JSON.stringify({ host: "h", pid: 400 }));
			throws(() => acquireLock(state, "release", { pid: 301, host: "h", isAlive: () => false }), LockHeld);
			strictEqual(JSON.parse(readFileSync(lock, "utf8")).pid, 101);
		} finally {
			rmSync(state, { recursive: true, force: true });
		}
	});
});

describe("release preflight", () => {
	const changelog = (heading: string, notes = "- A change.") =>
		`# Changelog\n\n## ${heading}\n\n${notes}\n\n## 0.7.0 - 2026-01-01\n`;
	const input = { version: "0.7.1", guiVersion: "0.7.1", release: true };

	it("refuses before any build what the publisher refuses after CI", async () => {
		const { versionProblems } = await import(preflightModule);
		deepStrictEqual(versionProblems({ ...input, changelog: changelog("0.7.1 - 2026-02-03") }), []);
		ok(/Unreleased/u.test(versionProblems({ ...input, changelog: changelog("Unreleased") }).join("\n")));
		ok(/no notes/u.test(versionProblems({ ...input, changelog: changelog("0.7.1 - 2026-02-03", "") }).join("\n")));
		ok(
			/versions disagree/u.test(
				versionProblems({ ...input, guiVersion: "0.7.0", changelog: changelog("0.7.1 - 2026-02-03") })[0],
			),
		);
		deepStrictEqual(
			versionProblems({
				...input,
				packages: [
					{ file: "packages/sdk/package.json", version: "0.7.1" },
					{ file: "packages/kit/package.json", version: "0.7.0" },
				],
				changelog: changelog("0.7.1 - 2026-02-03"),
			}),
			["versions disagree: package.json 0.7.1, packages/kit/package.json 0.7.0"],
		);
		const long = versionProblems({ ...input, changelog: changelog("0.7.1 - 2026-02-03", "x".repeat(125_000)) });
		ok(/GitHub accepts 125000/u.test(long.join("\n")), "notes GitHub would refuse fail before qualification");
		// A development tree keeps Unreleased notes and still qualifies.
		deepStrictEqual(versionProblems({ ...input, release: false, changelog: changelog("Unreleased", "") }), []);
	});

	it("judges a source-decided size class before the build and names one that is nearly full", async () => {
		const { classifySizes, SIZE_BUDGETS } = await import(budgetsModule);
		const docs = SIZE_BUDGETS.find((budget: { class: string }) => budget.class === "docs").maxBytes;
		const sized = (size: number) => classifySizes([{ path: "docs/guide/a.md", size }], { only: ["docs"] });
		deepStrictEqual([sized(1).errors, sized(1).warnings], [[], []]);
		strictEqual(sized(docs + 1).errors.length, 1);
		strictEqual(sized(docs - 1).warnings.length, 1);
		// Built classes are not judged from a tree that has no build yet.
		deepStrictEqual(classifySizes([{ path: "dist/cli/index.js", size: 10 ** 9 }], { only: ["docs"] }).errors, []);
	});

	it("gives every gate process one zone and locale, with a named override for sweeps", async () => {
		const { pinGateEnv } = await import(gateEnvModule);
		deepStrictEqual(
			pinGateEnv({ TZ: "America/Chicago", LANG: "de_DE.UTF-8", LANGUAGE: "de", LC_TIME: "de_DE" }, "linux"),
			{
				TZ: "UTC",
				LANG: "C.UTF-8",
				LC_ALL: "C.UTF-8",
			},
		);
		strictEqual(pinGateEnv({ PANCODE_TEST_TZ: "Pacific/Kiritimati" }, "linux").TZ, "Pacific/Kiritimati");
		deepStrictEqual(pinGateEnv({ LANG: "de_DE.UTF-8" }, "win32"), { TZ: "UTC", LANG: "de_DE.UTF-8" });
	});

	it("names npm's registry unless a local rehearsal names a loopback one, never in Actions", async () => {
		const { REGISTRY, registryArgs, releaseRegistry } = await import(registryModule);
		strictEqual(releaseRegistry({}), "https://registry.npmjs.org/");
		strictEqual(releaseRegistry({ GITHUB_ACTIONS: "true" }), REGISTRY);
		strictEqual(releaseRegistry({ PANCODE_RELEASE_REGISTRY: "http://127.0.0.1:4873" }), "http://127.0.0.1:4873/");
		deepStrictEqual(registryArgs({ PANCODE_RELEASE_REGISTRY: "http://localhost:4873/" }), [
			"--registry",
			"http://localhost:4873/",
		]);
		for (const url of [
			"https://registry.npmjs.org/",
			"http://10.0.0.2:4873/",
			"http://localhost.example.com:4873/",
			"https://127.0.0.1:4873/",
			"http://127.0.0.1/",
			"http://127.0.0.1:4873/mirror/",
			"http://user:secret@127.0.0.1:4873/",
			"127.0.0.1:4873",
		])
			throws(() => releaseRegistry({ PANCODE_RELEASE_REGISTRY: url }), /PANCODE_RELEASE_REGISTRY/u, url);
		throws(
			() => releaseRegistry({ PANCODE_RELEASE_REGISTRY: "http://127.0.0.1:4873/", GITHUB_ACTIONS: "true" }),
			/GitHub Actions/u,
		);
		for (const script of ["scripts/release.mjs", "scripts/release-publish.mjs"])
			ok(!readFileSync(script, "utf8").includes("registry.npmjs.org"), `${script} reads the registry from registry.mjs`);
	});
});

describe("release workflows", () => {
	it("keeps package mirrors off the test path and hands both test jobs the pinned search tools", () => {
		const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
		type Step = { run?: string; uses?: string; with?: Record<string, string> };
		ok(workflow.jobs.prepare.steps.some((step: Step) => step.run?.includes("scripts/ci-tools.mjs")));
		for (const key of ["ci", "runtime-compatibility"]) {
			const steps: Step[] = workflow.jobs[key].steps;
			// The userns sysctl step (row 106) needs sudo but installs nothing; package managers stay off the test path.
			ok(
				!steps.some((step) => /apt-get|\bapt\s+install|sudo\s+(?!sysctl\b)/u.test(step.run ?? "")),
				`${key} installs nothing at test time`,
			);
			ok(
				steps.some((step) => step.with?.name === "search-tools" && step.with.path === `\${{ runner.temp }}/search-tools`),
			);
		}
	});

	it("tests the candidate on Node 24 as well as Node 22", () => {
		const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
		const steps: Array<{ run?: string; with?: Record<string, string> }> = workflow.jobs["runtime-compatibility"].steps;
		ok(
			steps.some((step) => step.run?.includes("release-candidate.mjs test") && step.run.includes("test-results-24.json")),
		);
		ok(steps.some((step) => step.with?.name === `results24-\${{ inputs.sha }}`));
		ok(workflow.jobs.prepare.steps.some((step: { run?: string }) => step.run?.includes("rehearse/*")));
	});

	it("boots macOS with platforms and Windows only when asked", () => {
		const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
		const matrix: string = workflow.jobs.platform.strategy.matrix.os;
		const inputs = workflow.on.workflow_dispatch.inputs;
		strictEqual(inputs.windows.default, true, "the old release flow keeps both boots");
		const choose = (windows: boolean) =>
			JSON.parse(matrix.match(windows ? /'(\[[^']*windows[^']*\])'/u : /\|\| '(\[[^']*\])'/u)?.[1] ?? "[]");
		deepStrictEqual(choose(true), ["windows-latest", "macos-latest"]);
		deepStrictEqual(choose(false), ["macos-latest"]);
	});

	it("lets a descendant finish, waits for npm, and never publishes from a check run", () => {
		const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
		ok(!JSON.stringify(workflow.jobs.preflight.steps).includes('test \\"$CANDIDATE_SHA\\" = \\"$GITHUB_SHA\\"'));
		ok(workflow.jobs.release["timeout-minutes"] >= 40);
		strictEqual(workflow.jobs.release.if, `\${{ inputs.mode != 'check' }}`);
		ok(workflow.on.workflow_dispatch.inputs.mode.options.includes("check"));
	});

	it("writes to GitHub only with the release App's token", () => {
		const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
		deepStrictEqual(workflow.on.workflow_dispatch.inputs.mode.options, ["release", "check", "finish"]);
		const steps: Array<{ id?: string; if?: string; uses?: string; env?: Record<string, string> }> =
			workflow.jobs.release.steps;
		const token = steps.find((step) => step.uses?.startsWith("actions/create-github-app-token@"));
		strictEqual(token?.id, "publisher");
		strictEqual(token?.if, undefined);
		const publish = steps.at(-1);
		strictEqual(publish?.env?.GH_TOKEN, `\${{ steps.publisher.outputs.token }}`);
		strictEqual(publish?.env?.RELEASE_APP_SLUG, `\${{ steps.publisher.outputs.app-slug }}`);
	});
});
