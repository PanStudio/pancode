// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { CampaignResult } from "../../hub/packs/extensions/campaign/runtime/types.ts";
import { type HeadlessScratch, headlessScratch } from "../harness/headless-run.js";
import {
	closeServer,
	hasToolExchange,
	type OpenAICompatFixture,
	seedOpenAICompatToolOrchestrator,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";

const CAMPAIGN_PACK = fileURLToPath(new URL("../../hub/packs/extensions/campaign", import.meta.url));

const DESK_MANIFEST = {
	id: "desk",
	name: "desk",
	version: "1.0.0",
	description: "A desk with one gate",
	runtime: {
		api: 2,
		entrypoint: "extension.mjs",
		tools: [
			{ name: "gate", description: "Ask the author a gate", actionClass: "execute", inputSchema: { type: "object" } },
		],
		ui: ["interview"],
	},
};
const DESK_SOURCE = `export default (api) => {
	api.tool("gate", () => ({ text: "asking", interview: { id: "gate", title: "Gate", step: { key: "s1", questions: [
		{ id: "choice", label: "Approve the introduction plan?", kind: "single", checkpoint: "plan-introduction",
			options: [{ value: "approve", label: "Approve" }, { value: "keep", label: "Keep" }] } ] } } }));
	api.interview("gate", () => ({ done: true, text: "sealed" }));
};
`;

const ENTRY = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));

function cli(
	args: ReadonlyArray<string>,
	options: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), ENTRY, ...args], {
			cwd: options.cwd,
			env: { ...options.env, NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

describe("the campaign pack folds one fixture across a roster", { timeout: 300_000 }, () => {
	let scratch: HeadlessScratch;
	let chat: OpenAICompatFixture;
	let fixture: string;

	before(async () => {
		scratch = headlessScratch("pancode-campaign-");
		// The model asks the desk's gate once, then answers; the answers file approves it.
		chat = await startOpenAICompatFixture("Done.", {
			toolCall: (request) =>
				hasToolExchange(request)
					? null
					: { name: "gateway", arguments: { op: "call", capability: "extension_desk__gate", args: {} } },
		});
		seedOpenAICompatToolOrchestrator(scratch.configDir, chat.url);
		const desk = join(scratch.root, "desk");
		mkdirSync(desk);
		writeFileSync(join(desk, "pancode-extension.json"), JSON.stringify(DESK_MANIFEST));
		writeFileSync(join(desk, "extension.mjs"), DESK_SOURCE);
		for (const source of [desk, CAMPAIGN_PACK]) {
			const installed = await cli(["extensions", "install", source, "--user"], { env: scratch.env, cwd: scratch.root });
			strictEqual(installed.status, 0, installed.stderr);
		}
		fixture = join(scratch.root, "fixture");
		mkdirSync(join(fixture, ".planning"), { recursive: true });
		writeFileSync(join(fixture, ".planning", "state.json"), '{"phase":"outline"}\n');
		writeFileSync(join(fixture, "README.md"), "# paper\n");
		writeFileSync(
			join(scratch.root, "roster.yaml"),
			"roster:\n  - target: mock-chat\n    model: mock-model\n    label: mock\n  - target: absent-target\n    model: nope\n    thinking: low\n",
		);
		writeFileSync(join(scratch.root, "answers.yaml"), "answers:\n  - id: plan-introduction\n    choice: Approve\n");
	});

	after(async () => {
		await closeServer(chat.server);
		scratch.cleanup();
	});

	it("reports a row per entry with every metric field, a failing entry as failed, and leaves the fixture alone", async () => {
		const out = join(scratch.root, "out");
		const credentialsFile = join(scratch.configDir, "credentials.yaml");
		const readCredentials = () => (existsSync(credentialsFile) ? readFileSync(credentialsFile, "utf8") : null);
		const credentials = readCredentials();
		const result = await cli(
			[
				"campaign",
				"run",
				"--fixture",
				fixture,
				"--roster",
				join(scratch.root, "roster.yaml"),
				"--answers",
				join(scratch.root, "answers.yaml"),
				"--prompt",
				"say done",
				"--out",
				out,
				"--timeout",
				"120",
				"--json",
			],
			{ env: scratch.env, cwd: scratch.root },
		);
		strictEqual(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
		const campaign = JSON.parse(result.stdout) as CampaignResult & {
			completion: { state: string };
			verdict: { aggregate: string; entries: Array<{ label: string; status: string }> };
		};
		strictEqual(campaign.entries.length, 2);
		deepStrictEqual([campaign.completion.state, campaign.verdict.aggregate], ["completed", "partial"]);
		deepStrictEqual(
			campaign.verdict.entries.map((entry) => entry.status),
			["completed", "failed"],
		);
		const [mock, broken] = campaign.entries;
		ok(mock && broken);

		strictEqual(mock.label, "mock");
		strictEqual(mock.status, "completed", JSON.stringify(mock));
		strictEqual(mock.exitCode, 0);
		ok(typeof mock.metrics.sessionId === "string", "the completed entry names its session");
		ok(mock.metrics.tokens !== null, "the completed entry carries C2's totals");
		ok(mock.metrics.tokens.calls >= 1);
		deepStrictEqual(mock.metrics.gates, {
			reached: ["plan-introduction"],
			interviews: 1,
			answered: 1,
			unscripted: 0,
			unanswered: 0,
		});
		ok(typeof mock.metrics.tokens.output === "number");

		strictEqual(broken.label, "absent-target/nope@low");
		strictEqual(broken.status, "failed");
		ok(broken.exitCode !== 0 && broken.exitCode !== null);
		ok(broken.error !== null, "a failed entry says why");

		for (const entry of campaign.entries) {
			deepStrictEqual(Object.keys(entry.metrics).sort(), ["gates", "loopGuardBlocks", "refusals", "sessionId", "tokens"]);
			ok(Array.isArray(entry.metrics.gates.reached));
			strictEqual(typeof entry.metrics.refusals.hookBlocks, "number");
			strictEqual(typeof entry.metrics.refusals.toolRefusals, "number");
			strictEqual(typeof entry.metrics.loopGuardBlocks, "number");
			strictEqual(typeof entry.wallMs, "number");
			const saved = JSON.parse(readFileSync(join(entry.dir, "entry.json"), "utf8")) as { label: string; status: string };
			deepStrictEqual([saved.label, saved.status], [entry.label, entry.status]);
			ok(existsSync(join(entry.dir, "project", "README.md")), "each entry works in its own fixture copy");
			ok(!existsSync(join(entry.dir, "home", "config")), "no copy of the operator's config is kept under --out");
		}
		deepStrictEqual(readdirSync(out).sort(), ["01-mock", "02-absent-target-nope-low"]);
		deepStrictEqual(readdirSync(fixture).sort(), [".planning", "README.md"]);
		strictEqual(readCredentials(), credentials);
		const operatorSessions = existsSync(join(scratch.stateDir, "sessions"))
			? readdirSync(join(scratch.stateDir, "sessions"), { recursive: true }).filter((name) =>
					String(name).endsWith("meta.json"),
				)
			: [];
		deepStrictEqual(operatorSessions, [], "no entry wrote a session into the operator's state");

		const campaignArgs = (roster: string, answers: string, into: string): string[] => [
			"campaign",
			"run",
			"--fixture",
			fixture,
			"--roster",
			join(scratch.root, roster),
			"--answers",
			join(scratch.root, answers),
			"--prompt",
			"say done",
			"--out",
			into,
		];
		const reused = await cli(campaignArgs("roster.yaml", "answers.yaml", out), { env: scratch.env, cwd: scratch.root });
		strictEqual(reused.status, 2, "a used --out is refused before anything runs");

		// A gate the answers file does not script ends the run as unscripted, and the gate still counts as reached.
		writeFileSync(join(scratch.root, "only-mock.yaml"), "roster:\n  - target: mock-chat\n    model: mock-model\n");
		writeFileSync(
			join(scratch.root, "other-answers.yaml"),
			"answers:\n  - id: results-acceptance\n    choice: Approve\n",
		);
		const stopped = await cli(
			[...campaignArgs("only-mock.yaml", "other-answers.yaml", join(scratch.root, "out2")), "--json"],
			{
				env: scratch.env,
				cwd: scratch.root,
			},
		);
		strictEqual(stopped.status, 0, stopped.stderr);
		const [unscripted] = (JSON.parse(stopped.stdout) as CampaignResult).entries;
		ok(unscripted);
		deepStrictEqual([unscripted.status, unscripted.exitCode], ["unscripted", 5]);
		deepStrictEqual(unscripted.metrics.gates, {
			reached: ["plan-introduction"],
			interviews: 1,
			answered: 0,
			unscripted: 1,
			unanswered: 0,
		});
		strictEqual((JSON.parse(stopped.stdout) as { verdict: { aggregate: string } }).verdict.aggregate, "fail");

		// --exit-code lets the verdict reach the exit code: a roster where no entry completed exits 1 (C19).
		writeFileSync(join(scratch.root, "only-broken.yaml"), "roster:\n  - target: absent-target\n    model: nope\n");
		const gated = await cli(
			[...campaignArgs("only-broken.yaml", "answers.yaml", join(scratch.root, "out3")), "--json", "--exit-code"],
			{ env: scratch.env, cwd: scratch.root },
		);
		strictEqual(gated.status, 1, gated.stderr);
		strictEqual((JSON.parse(gated.stdout) as { verdict: { aggregate: string } }).verdict.aggregate, "fail");
	});

	it("--repeat runs the roster once per pass, and each entry keeps its run's completion and verification", async () => {
		writeFileSync(
			join(scratch.root, "repeat.yaml"),
			"roster:\n  - target: mock-chat\n    model: mock-model\n    label: mock\n",
		);
		const out = join(scratch.root, "out-repeat");
		const result = await cli(
			[
				"campaign",
				"run",
				"--fixture",
				fixture,
				"--roster",
				join(scratch.root, "repeat.yaml"),
				"--answers",
				join(scratch.root, "answers.yaml"),
				"--prompt",
				"say done",
				"--out",
				out,
				"--repeat",
				"2",
				"--json",
			],
			{ env: scratch.env, cwd: scratch.root },
		);
		strictEqual(result.status, 0, result.stderr);
		const campaign = JSON.parse(result.stdout) as CampaignResult;
		deepStrictEqual([campaign.schemaVersion, campaign.repeat], [2, 2]);
		deepStrictEqual(readdirSync(out).sort(), ["01-mock-r1", "01-mock-r2"]);
		deepStrictEqual(
			campaign.entries.map((entry) => [entry.index, entry.repetition, entry.status]),
			[
				[0, 0, "completed"],
				[0, 1, "completed"],
			],
		);
		for (const entry of campaign.entries) {
			const saved = JSON.parse(readFileSync(join(entry.dir, "entry.json"), "utf8")) as CampaignResult["entries"][number];
			strictEqual(saved.repetition, entry.repetition);
			// The mock model never calls finish: an undeclared claim the host assesses as unknown, on a run that succeeded.
			deepStrictEqual(saved.completion, { claimed: null, assessed: "unknown", facts: [] });
			deepStrictEqual(saved.verification, { outcome: "succeeded", outcomeDetail: null, causes: [], checks: [] });
		}
	});
});
