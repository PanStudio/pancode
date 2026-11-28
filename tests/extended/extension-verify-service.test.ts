// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PancodeSettings } from "../../src/core/config.js";
import { HYPOTHESIS_SLATE_SCHEMA, readClaims } from "../../src/domains/claims/index.js";
import {
	createExtensionClaimsService,
	type ExtensionClaimsError,
} from "../../src/domains/extensions/services/claims.js";
import { createExtensionRequestScope } from "../../src/domains/extensions/services/scope.js";
import {
	createExtensionCheckReceipts,
	createExtensionVerifyService,
} from "../../src/domains/extensions/services/verify.js";
import { createExtensionWorktreeService } from "../../src/domains/extensions/services/worktrees.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

const check = (id: string, command: string[], extra: Record<string, unknown> = {}) => ({
	id,
	description: id,
	kind: "command",
	command,
	cwd: ".",
	timeoutMs: 30_000,
	tags: [],
	...extra,
});

function project(launchArgs: string[] = ["-e", "process.exit(9)"]) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "verify-service-")));
	const repo = join(root, "repo");
	const files: Record<string, string> = {
		"value.txt": "100\n",
		"score.js": "process.stdout.write(JSON.stringify({score:Number(require('fs').readFileSync('value.txt','utf8'))}))\n",
		"fail.js": "process.stdout.write('broken'); process.exit(3)\n",
		"ref.json": '{"score":100}\n',
		"package.json": '{"name":"fixture","scripts":{"test":"node fail.js"}}\n',
		".pancode/verifiers.yaml": JSON.stringify({
			version: 2,
			checks: [
				check("score", ["node", "score.js"]),
				check("fail", ["node", "fail.js"]),
				check("sane", ["node", "score.js"], {
					kind: "numeric-compare",
					reference: "ref.json",
					tolerance: { absolute: 0 },
				}),
			],
		}),
	};
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	}
	git(repo, "init", "-q", "-b", "main");
	git(repo, "add", "-A");
	git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "base");
	const receipts = createExtensionCheckReceipts();
	const verify = createExtensionVerifyService({
		settings: () => ({ safety: { sandbox: "off" } }) as unknown as Pick<PancodeSettings, "safety" | "connections">,
		resolvePlace: async () => ({ cwd: repo, root: repo }),
		receipts,
		launch: { file: process.execPath, args: launchArgs, env: {} },
		sourceEnv: {},
		envPolicy: { targets: [], passEnv: [] },
	});
	return { repo, receipts, verify, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("extension verify service", () => {
	it("lists the declared checks with the inputs each names", async () => {
		const { verify, cleanup } = project();
		try {
			const checks = await verify.list();
			assert.deepEqual(checks.map((entry) => entry.id).sort(), ["fail", "sane", "score"]);
			const sane = checks.find((entry) => entry.id === "sane");
			assert.ok(sane?.inputs.includes("score.js"));
			assert.ok(sane?.inputs.includes("ref.json"));
		} finally {
			cleanup();
		}
	});

	it("resolves a check with the uncommitted files it names, and refuses one the project cannot run", async () => {
		const { repo, verify, cleanup } = project();
		try {
			const declared = await verify.resolve("sane");
			assert.deepEqual(declared.ok && { kind: declared.kind, inputs: declared.inputs, run: declared.run }, {
				kind: "catalog",
				inputs: [".pancode/verifiers.yaml"],
				run: undefined,
			});
			assert.equal(declared.ok && (declared.check?.numeric as { reference?: string } | undefined)?.reference, "ref.json");
			assert.deepEqual(declared.ok && declared.check?.command, ["node", "score.js"]);
			writeFileSync(join(repo, "ref.json"), '{"score":99}\n');
			writeFileSync(join(repo, "value.txt"), "99\n");
			const sane = await verify.resolve("sane");
			assert.deepEqual(sane.ok && sane.inputs, [".pancode/verifiers.yaml", "ref.json"]);
			const unknown = await verify.resolve("nope/never");
			assert.equal(unknown.ok, false);
		} finally {
			cleanup();
		}
	});

	it("resolves one run of a sweep to the declared check with the run directory on its argv", async () => {
		const { repo, verify, cleanup } = project();
		try {
			const reading = ["node", "-e", "process.stdout.write('{}')"];
			writeFileSync(
				join(repo, ".pancode/verifiers.yaml"),
				JSON.stringify({ version: 2, checks: [check("sweep", reading, { runs: "runs" })] }),
			);
			mkdirSync(join(repo, "runs/a"), { recursive: true });
			const run = await verify.resolve("sweep/a");
			assert.equal(run.ok && run.run, "runs/a");
			assert.deepEqual(run.ok && run.check?.command, [...reading, "runs/a"]);
			assert.equal(run.ok && run.check?.id, "sweep");
			assert.equal(run.ok && run.check?.runs, "runs");
			const derived = await verify.resolve("test");
			assert.equal(derived.ok && derived.kind, "package");
			assert.equal(derived.ok && derived.check, undefined);
		} finally {
			cleanup();
		}
	});

	it("runs a check, keeps its result behind a receipt, and refuses a check the project does not declare", async () => {
		const { verify, receipts, cleanup } = project();
		try {
			const passed = await verify.check("score");
			assert.equal(passed.ok, true);
			assert.equal(passed.execution, "succeeded");
			assert.equal(passed.exitCode, 0);
			assert.match(passed.text, /"score":100/u);
			assert.equal(receipts.get(passed.receipt)?.check, "score");

			const failed = await verify.check("fail");
			assert.equal(failed.ok, false);
			assert.equal(failed.exitCode, 3);
			assert.notEqual(failed.receipt, passed.receipt);

			const unknown = await verify.check("nope/never");
			assert.equal(unknown.ok, false);
			assert.equal(unknown.execution, "not-run");
		} finally {
			cleanup();
		}
	});

	it("reports the judgement the production verify path gives a package check", async () => {
		const document = {
			version: 1,
			check: "test",
			ok: false,
			error: "verify: exited with code 1",
			judgement: { execution: "failed", validation: "exit-code" },
		};
		const { verify, cleanup } = project([
			"-e",
			`console.log(${JSON.stringify(JSON.stringify(document))}); process.exit(1)`,
		]);
		try {
			const failed = await verify.check("test");
			assert.equal(failed.ok, false);
			assert.equal(failed.execution, "failed");
			assert.equal(failed.validation, "exit-code");
		} finally {
			cleanup();
		}
	});

	it("measures a metric from a check's JSON payload, and reports a missing key or an aborted run", async () => {
		const { verify, cleanup } = project();
		try {
			const measured = await verify.measure("score", "score");
			assert.equal(measured.ok && measured.value, 100);
			const missing = await verify.measure("score", "speed");
			assert.equal(missing.ok, false);
			const scope = createExtensionRequestScope();
			scope.end();
			const aborted = await verify.measure("score", "score", "workspace", scope);
			assert.equal(!aborted.ok && aborted.reason, "aborted");
		} finally {
			cleanup();
		}
	});
});

describe("extension claims service", () => {
	it("records a slate's hypotheses, binds them to a run, and tests them with the claim a receipt holds", async (t) => {
		const env = await isolatePancodeEnv("pancode-ext-claims-");
		t.after(() => env.restore());
		const { repo, verify, receipts, cleanup } = project();
		t.after(cleanup);
		const claims = createExtensionClaimsService({ extensionId: "research", workspace: repo, sessionId: null, receipts });
		const slate = `${JSON.stringify({
			schema: HYPOTHESIS_SLATE_SCHEMA,
			hypotheses: [
				{
					id: "H1",
					statement: "the score stays at its reference",
					prediction: "sane agrees",
					status: "proposed",
					experiment: { successCriterion: { kind: "verify", verifyId: "sane", statement: "sane agrees" } },
				},
			],
		})}\n`;
		const ids = await claims.hypotheses("campaign/one", slate);
		const h1 = ids.H1;
		assert.ok(typeof h1 === "string");

		const bindings = await claims.begin("run-1", ["sane"]);
		assert.deepEqual(bindings.sane, [h1]);
		const result = await verify.check("sane");
		assert.equal(result.ok, true, result.text);
		const recorded = await claims.finish("run-1", [{ check: "sane", receipt: result.receipt }]);
		assert.ok(typeof recorded.sane === "string");
		// A receipt already finished cannot be replayed on a later run.
		await assert.rejects(
			claims.finish("run-1-replay", [{ check: "sane", receipt: result.receipt }]),
			(error: ExtensionClaimsError) => error.code === "unknown_receipt",
		);

		const log = readClaims(realpathSync(repo));
		const claim = log.records.find((record) => record.id === recorded.sane);
		assert.equal(claim?.verdict, "agrees");
		const test = log.hypothesisTests.find((entry) => entry.hypothesis === h1);
		assert.equal(test?.claim, recorded.sane);
		assert.equal(test?.outcome, "supported");

		const read = await claims.read({ types: ["hypothesis-test"], limit: 5 });
		assert.equal(read.length, 1);
		// Non-finite limits fall back to the bounded default instead of slicing from 0.
		const bounded = await claims.read({ types: ["hypothesis-test"], limit: Number.NaN });
		assert.equal(bounded.length, 1);
		// A read-only session refuses ledger writes while allowing reads.
		const roClaims = createExtensionClaimsService({
			extensionId: "research",
			workspace: repo,
			sessionId: null,
			receipts,
			readOnly: () => true,
		});
		await assert.rejects(roClaims.begin("run-ro", ["sane"]), (error: ExtensionClaimsError) => error.code === "refused");
		assert.equal((await roClaims.read({ types: ["hypothesis-test"], limit: 5 })).length, 1);
	});

	it("refuses an outcome whose receipt it never issued or that names another check", async (t) => {
		const env = await isolatePancodeEnv("pancode-ext-claims-");
		t.after(() => env.restore());
		const { repo, verify, receipts, cleanup } = project();
		t.after(cleanup);
		const claims = createExtensionClaimsService({ extensionId: "research", workspace: repo, sessionId: null, receipts });
		const code = (expected: string) => (error: ExtensionClaimsError) => error.code === expected;
		await assert.rejects(claims.finish("run-2", [{ check: "sane", receipt: "forged" }]), code("unknown_receipt"));
		const score = await verify.check("score");
		await assert.rejects(claims.finish("run-2", [{ check: "sane", receipt: score.receipt }]), code("unknown_receipt"));
		await assert.rejects(claims.hypotheses("../escape", "{}"), code("invalid"));
		assert.equal(readClaims(realpathSync(repo)).records.length, 0);
	});

	it("tests a hypothesis on a measurement's own run, and on a run stopped before judging, never with a claim", async (t) => {
		const env = await isolatePancodeEnv("pancode-ext-claims-");
		t.after(() => env.restore());
		const { repo, verify, receipts, cleanup } = project();
		t.after(cleanup);
		const claims = createExtensionClaimsService({ extensionId: "research", workspace: repo, sessionId: null, receipts });
		const slate = `${JSON.stringify({
			schema: HYPOTHESIS_SLATE_SCHEMA,
			hypotheses: [
				{
					id: "H1",
					statement: "the score improves",
					prediction: "score rises",
					status: "proposed",
					experiment: { successCriterion: { kind: "verify", verifyId: "score", statement: "score rises" } },
				},
			],
		})}\n`;
		const h1 = (await claims.hypotheses("campaign/measure", slate)).H1;
		assert.ok(typeof h1 === "string");
		const tests = () => readClaims(realpathSync(repo)).hypothesisTests.filter((entry) => entry.hypothesis === h1);

		await claims.begin("run-m1", ["score"]);
		const measured = await verify.measure("score", "score");
		assert.ok(measured.ok);
		assert.deepEqual(await claims.finish("run-m1", [{ check: "score", receipt: measured.receipt }]), {});
		const missing = await verify.measure("score", "speed");
		assert.ok(!missing.ok && typeof missing.receipt === "string");
		await claims.begin("run-m2", ["score"]);
		await claims.finish("run-m2", [{ check: "score", receipt: missing.receipt as string }]);
		await claims.begin("run-m3", ["score"]);
		assert.deepEqual(await claims.finish("run-m3", [{ check: "score", execution: "aborted" }]), {});
		assert.deepEqual(
			tests().map((entry) => [entry.execution, entry.outcome, entry.claim]),
			[
				["succeeded", "tested", undefined],
				["failed", "tested", undefined],
				["aborted", "tested", undefined],
			],
		);
		assert.equal(readClaims(realpathSync(repo)).records.length, 0);
		await assert.rejects(
			claims.finish("run-m4", [
				{ check: "score", execution: "succeeded" } as unknown as { check: string; receipt: string },
			]),
			(error: ExtensionClaimsError) => error.code === "invalid",
		);
	});

	it("claims a check run in an extension worktree for the project, naming the worktree it ran in", async (t) => {
		const env = await isolatePancodeEnv("pancode-ext-claims-");
		t.after(() => env.restore());
		const { repo, receipts, cleanup } = project();
		t.after(cleanup);
		const worktrees = createExtensionWorktreeService({
			extensionId: "research",
			workspace: repo,
		});
		t.after(() => worktrees.dispose());
		const verify = createExtensionVerifyService({
			settings: () => ({ safety: { sandbox: "off" } }) as unknown as Pick<PancodeSettings, "safety" | "connections">,
			resolvePlace: (place) => worktrees.resolvePlace(place),
			receipts,
			launch: { file: process.execPath, args: ["-e", "process.exit(9)"], env: {} },
			sourceEnv: {},
			envPolicy: { targets: [], passEnv: [] },
		});
		const claims = createExtensionClaimsService({ extensionId: "research", workspace: repo, sessionId: null, receipts });
		const tree = await worktrees.create();
		writeFileSync(join(tree.path, "value.txt"), "50\n");
		const measured = await verify.measure("score", "score", { worktree: tree.id });
		assert.equal(measured.ok && measured.value, 50);
		const result = await verify.check("sane", { worktree: tree.id });
		assert.equal(result.ok, false);
		await claims.begin("run-3", ["sane"]);
		const recorded = await claims.finish("run-3", [{ check: "sane", receipt: result.receipt }]);
		const claim = readClaims(realpathSync(repo)).records.find((record) => record.id === recorded.sane);
		assert.equal(claim?.verdict, "disagrees");
		assert.equal(claim?.project, realpathSync(repo));
		assert.equal(claim?.worktree, realpathSync(tree.path));
	});
});
