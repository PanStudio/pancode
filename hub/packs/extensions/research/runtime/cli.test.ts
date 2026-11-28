// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ResearchHost, runResearchCli } from "./cli.ts";

function fakeHost(overrides: Partial<ResearchHost> = {}): {
	host: () => ResearchHost;
	opened: number;
	lines: string[];
} {
	const project = mkdtempSync(join(tmpdir(), "research-cli-"));
	const state = { opened: 0, lines: [] as string[] };
	const host: ResearchHost = {
		root: join(project, ".pancode", "data", "research"),
		project,
		yoloRefusal: async () => null,
		open: async () => {
			state.opened += 1;
			throw new Error("check 'nope' is not declared in .pancode/verifiers.yaml (declared: score)");
		},
		run: async () => {
			throw new Error("not in this test");
		},
		resume: async () => {
			throw new Error("not in this test");
		},
		progress: (line) => state.lines.push(line),
		...overrides,
	};
	return {
		host: () => host,
		get opened() {
			return state.opened;
		},
		lines: state.lines,
	};
}

const start = ["start", "--check", "score", "--metric", "score", "--direction", "min", "--max-iterations", "1"];

describe("research usage", () => {
	it("answers a usage error as one diagnostic and a pointer to help, and as JSON under --json", async () => {
		const { host } = fakeHost();
		const missing = await runResearchCli(["start", "--check", "score", "--json"], host);
		strictEqual(missing.exitCode, 2);
		deepStrictEqual(JSON.parse(missing.stdout), {
			version: 1,
			ok: false,
			error: { code: "usage", message: "--metric <key> is required" },
		});
		strictEqual(
			missing.stderr,
			"pancode research start: --metric <key> is required\nsee: pancode research start --help\n",
		);
		const verb = await runResearchCli(["frob", "--json"], host);
		strictEqual(verb.exitCode, 2);
		strictEqual(JSON.parse(verb.stdout).error.code, "unknown_command");
		strictEqual(verb.stderr, "pancode research: unknown subcommand 'frob'\nsee: pancode research --help\n");
		const flag = await runResearchCli(["list", "--wide"], host);
		strictEqual(flag.stdout, "");
		strictEqual(flag.stderr, "pancode research list: unknown flag: --wide\nsee: pancode research list --help\n");
		const id = await runResearchCli(["status", "r-nope"], host);
		strictEqual(
			id.stderr.split("\n")[0],
			"pancode research status: 'r-nope' is not a campaign id (r<yyyymmdd>-<hhmmss>-<hex>)",
		);
		strictEqual((await runResearchCli(["resume"], host)).exitCode, 2);
		strictEqual((await runResearchCli(["report"], host)).exitCode, 2);
	});

	it("never takes the next flag as a value, and names target and model together", async () => {
		const { host } = fakeHost();
		const value = await runResearchCli(["start", "--check", "--metric", "score"], host);
		strictEqual(value.stderr.split("\n")[0], "pancode research start: --check needs a value");
		const pair = await runResearchCli([...start, "--target", "openai"], host);
		strictEqual(pair.exitCode, 2);
		ok(pair.stderr.includes("--target and --model go together"), pair.stderr);
		const trials = await runResearchCli([...start, "--trials", "1"], host);
		ok(trials.stderr.includes("--trials needs at least 2 pairs for an interval"), trials.stderr);
	});

	it("prints help for any verb and lists an empty project", async () => {
		const { host } = fakeHost();
		const help = await runResearchCli(["start", "--help"], host);
		strictEqual(help.exitCode, 0);
		ok(help.stdout.startsWith("Usage:\n  pancode research start"));
		ok(help.stdout.includes(".pancode/data/research/<id>/"));
		const resolved = host();
		strictEqual((await runResearchCli([], host)).stdout, `no research campaigns in ${resolved.project}\n`);
		deepStrictEqual(JSON.parse((await runResearchCli(["list", "--json"], host)).stdout), {
			project: resolved.project,
			campaigns: [],
		});
		deepStrictEqual(JSON.parse((await runResearchCli(["status", "--json"], host)).stdout), {
			project: resolved.project,
			campaign: null,
		});
	});
});

describe("research start", () => {
	it("reports a campaign that cannot open on stderr alone, exit 1, even under --json", async () => {
		const fake = fakeHost();
		const result = await runResearchCli([...start, "--json"], fake.host);
		strictEqual(result.exitCode, 1);
		strictEqual(result.stdout, "");
		strictEqual(
			result.stderr,
			"error: research start: check 'nope' is not declared in .pancode/verifiers.yaml (declared: score)\n",
		);
		strictEqual(fake.opened, 1);
	});

	it("refuses unconfined yolo with exit 2 before anything opens", async () => {
		const fake = fakeHost({ yoloRefusal: async () => "yolo here is unconfined; contained yolo runs it" });
		const result = await runResearchCli([...start, "--autonomy", "yolo"], fake.host);
		strictEqual(result.exitCode, 2);
		strictEqual(result.stderr, "error: research start: yolo here is unconfined; contained yolo runs it\n");
		strictEqual(fake.opened, 0);
	});

	it("answers a refused resume as a research error, exit 1", async () => {
		const busy = new Error(
			"campaign r20260101-000000-abcd is already running (since 2026-01-01T00:00:00.000Z); stop it first",
		);
		busy.name = "ResearchResumeError";
		const fake = fakeHost({
			open: async () =>
				({
					id: "r20260101-000000-abcd",
					base: "0123456789abcdef",
					ref: "refs/heads/pancode/research/r20260101-000000-abcd",
					agent: { autonomy: "default" },
				}) as never,
			run: async () => {
				throw busy;
			},
		});
		const result = await runResearchCli(start, fake.host);
		strictEqual(result.exitCode, 1);
		strictEqual(result.stderr, `error: research: ${busy.message}\n`);
		deepStrictEqual(fake.lines, [
			"r20260101-000000-abcd: opened at 0123456789ab on pancode/research/r20260101-000000-abcd, agent autonomy default",
		]);
	});
});
