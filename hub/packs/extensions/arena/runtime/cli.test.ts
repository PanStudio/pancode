import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionContextV2 } from "pancode/sdk/extension";
import { type ArenaHost, type ArenaRunRequest, runArenaCli } from "./cli.ts";
import { arenaHost } from "./runner.ts";
import { readMatch } from "./store.ts";

function fakeHost(overrides: Partial<ArenaHost> = {}): { host: () => ArenaHost; runs: ArenaRunRequest[] } {
	const runs: ArenaRunRequest[] = [];
	const host: ArenaHost = {
		root: join(mkdtempSync(join(tmpdir(), "arena-cli-")), "arena"),
		yoloRefusal: async () => null,
		run: async (request) => {
			runs.push(request);
			throw new Error("not in this test");
		},
		...overrides,
	};
	return { host: () => host, runs };
}

describe("arena argument parsing", () => {
	it("reads --help after -- as prompt text, not a request for help", async () => {
		const { host } = fakeHost();
		const prompt = await runArenaCli(["show", "--", "--help"], host);
		assert.notEqual(prompt.exitCode, 0);
		assert.doesNotMatch(prompt.stdout, /Usage:/);
		const help = await runArenaCli(["show", "--help", "--", "x"], host);
		assert.equal(help.exitCode, 0);
		assert.match(help.stdout, /Usage:/);
	});

	it("never takes the next flag as a value flag's value (I-21)", async () => {
		const { host, runs } = fakeHost();
		assert.equal((await runArenaCli(["run", "--contender", "--timeout", "p"], host)).exitCode, 2);
		assert.equal((await runArenaCli(["list", "--suite", "--reveal"], host)).exitCode, 2);
		assert.equal(runs.length, 0);
	});

	it("answers a usage error as one diagnostic, and as JSON under --json", async () => {
		const { host } = fakeHost();
		const result = await runArenaCli(["run", "--contender", "a/b", "--contender", "c/d", "--json"], host);
		assert.equal(result.exitCode, 2);
		assert.deepEqual(JSON.parse(result.stdout), {
			version: 1,
			ok: false,
			error: { code: "usage", message: "arena run needs a prompt" },
		});
		assert.equal(result.stderr, "pancode arena run: arena run needs a prompt\nsee: pancode arena run --help\n");
	});

	it("refuses a timeout or spend above the declared run ceilings before any run", async () => {
		const { host, runs } = fakeHost();
		const run = (...flags: string[]) =>
			runArenaCli(["run", "--contender", "a/b", "--contender", "c/d", ...flags, "--", "fix"], host);
		assert.match((await run("--timeout", "86401")).stderr, /--timeout takes at most 86400 seconds/);
		assert.match((await run("--max-cost-usd", "1000.5")).stderr, /--max-cost-usd takes at most 1000/);
		assert.equal(runs.length, 0);
		await run("--timeout", "86400", "--max-cost-usd", "1000");
		assert.deepEqual([runs[0]?.timeoutSeconds, runs[0]?.maxCostUsd, runs[0]?.prompt], [86400, 1000, "fix"]);
	});

	it("refuses yolo the host cannot contain as a usage error, before the match", async () => {
		const { host, runs } = fakeHost({ yoloRefusal: async () => "unconfined yolo is refused here" });
		const result = await runArenaCli(
			["run", "--contender", "a/b", "--contender", "c/d", "--autonomy", "yolo", "--", "fix"],
			host,
		);
		assert.equal(result.exitCode, 2);
		assert.match(result.stderr, /unconfined yolo is refused here/);
		assert.equal(runs.length, 0);
	});
});

interface Call {
	op: string;
	arg?: unknown;
}

/** A host context whose services record each call; every run streams one frame and then waits for the signal. */
function fakeContext(options: { abortAfterStart?: boolean; resolve?: unknown } = {}) {
	const calls: Call[] = [];
	const controller = new AbortController();
	const projectDir = mkdtempSync(join(tmpdir(), "arena-run-"));
	let worktree = 0;
	let started = 0;
	const ctx = {
		projectDir,
		signal: controller.signal,
		snapshot: { workspace: "/work" },
		progress: (text: string) => calls.push({ op: "progress", arg: text }),
		runs: {
			refusal: async () => null,
			start: async (request: { model: string }) => {
				calls.push({ op: "start", arg: request });
				started++;
				if (options.abortAfterStart === true && started === 2) queueMicrotask(() => controller.abort());
				return { id: `run-${request.model}` };
			},
			frames: async (id: string, { cursor }: { cursor: number }) => {
				if (cursor > 0) {
					if (!controller.signal.aborted && options.abortAfterStart === true)
						await new Promise((done) => controller.signal.addEventListener("abort", done, { once: true }));
					return { frames: [], next: cursor, done: true };
				}
				return {
					frames: [
						{ type: "session", id: `sess-${id}` },
						{ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: `did ${id}` }] } },
					],
					next: 2,
					done: false,
				};
			},
			wait: async (id: string) => {
				calls.push({ op: "wait", arg: id });
				return controller.signal.aborted
					? { exitCode: 130, outcome: "canceled", stderrTail: "" }
					: { exitCode: 0, outcome: "succeeded", stderrTail: "" };
			},
			cancel: async (id: string) => {
				calls.push({ op: "cancel", arg: id });
			},
		},
		worktrees: {
			git: async (_place: unknown, args: string[]) => {
				calls.push({ op: "git", arg: args });
				if (args[0] === "rev-parse")
					return { exitCode: 0, stdout: args.includes("HEAD") ? "base\n" : "/repo\n", stderr: "" };
				return { exitCode: 0, stdout: args.includes("--numstat") ? "1\t0\tanswer.txt\n" : "+answer\n", stderr: "" };
			},
			create: async (request: unknown) => {
				calls.push({ op: "create", arg: request });
				return { id: `t-${++worktree}` };
			},
			copy: async (id: string, files: unknown) => {
				calls.push({ op: "copy", arg: [id, files] });
			},
			commit: async (id: string, message: string) => {
				calls.push({ op: "commit", arg: [id, message] });
				return { head: `${id}-${message.replace(" ", "-")}` };
			},
			remove: async (id: string) => {
				calls.push({ op: "remove", arg: id });
			},
		},
		verify: {
			resolve: async () =>
				options.resolve ?? { ok: true, kind: "catalog", inputs: [".pancode/verifiers.yaml", "ref.json"] },
			check: async (id: string, place: unknown) => {
				calls.push({ op: "check", arg: [id, place] });
				return { exitCode: 0, text: `check ${id} passed\n` };
			},
		},
	};
	return { ctx: ctx as unknown as ExtensionContextV2, calls, projectDir };
}

const REQUEST: ArenaRunRequest = {
	prompt: "fix it",
	contenders: [
		{ target: "a", model: "m1" },
		{ target: "b", model: "m2" },
	],
	seed: 1,
	suite: null,
	timeoutSeconds: 60,
	maxCostUsd: null,
	check: "unit",
	readOnly: false,
	autonomy: "default",
};

describe("arena runner", () => {
	it("runs each contender in its own worktree, copies the check inputs twice, and diffs from the inputs commit", async () => {
		const { ctx, calls, projectDir } = fakeContext();
		const host = arenaHost(ctx);
		const match = await host.run(REQUEST);
		assert.equal(match.status, "complete", match.error ?? "");
		assert.equal(match.isolation, "worktree");
		assert.equal(match.baselineSha, "base");
		assert.deepEqual(
			calls.filter((call) => call.op === "create").map((call) => call.arg),
			[{ base: "base" }, { base: "base" }],
		);
		assert.equal(calls.filter((call) => call.op === "copy").length, 4, "before the contender and before its check");
		const diffs = calls
			.filter((call) => call.op === "git" && (call.arg as string[])[0] === "diff")
			.map((call) => call.arg as string[]);
		assert.ok(diffs.every((args) => /^t-\d-arena-inputs$/.test(args[args.indexOf("--") - 2] as string)));
		assert.deepEqual(diffs[0]?.slice(-3), ["--", ":/", ":(top,exclude).pancode"]);
		assert.deepEqual(
			calls.filter((call) => call.op === "remove").map((call) => call.arg),
			["t-1", "t-2"],
		);
		const saved = readMatch(projectDir, match.id);
		assert.equal(saved?.status, "complete");
		const first = saved?.contenders[0]?.facts;
		assert.deepEqual([first?.writes, first?.check?.tail, first?.diff?.files], [1, "check unit passed", 1]);
		assert.equal(readFileSync(join(projectDir, match.id, "contender-1.diff"), "utf8"), "+answer\n");
		assert.match(readFileSync(join(projectDir, match.id, "contender-1.ndjson"), "utf8"), /"sess-run-m1"/);
	});

	it("cancels every run on interrupt, records the match as failed and still removes the worktrees", async () => {
		const { ctx, calls, projectDir } = fakeContext({ abortAfterStart: true });
		const match = await arenaHost(ctx).run(REQUEST);
		assert.equal(match.status, "failed");
		assert.equal(match.error, "canceled before every contender finished");
		assert.deepEqual(
			calls
				.filter((call) => call.op === "cancel")
				.map((call) => call.arg)
				.sort(),
			["run-m1", "run-m2"],
		);
		assert.equal(calls.filter((call) => call.op === "check").length, 0, "no check runs after the interrupt");
		assert.equal(calls.filter((call) => call.op === "remove").length, 2);
		assert.equal(readMatch(projectDir, match.id)?.contenders[0]?.facts?.check?.tail, "canceled before the check ran");
	});

	it("refuses a check the project cannot resolve before any worktree or run", async () => {
		const { ctx, calls } = fakeContext({ resolve: { ok: false, message: "no check 'unit'" } });
		const result = await runArenaCli(
			["run", "--contender", "a/m1", "--contender", "b/m2", "--check", "unit", "--", "x"],
			() => arenaHost(ctx),
		);
		assert.equal(result.exitCode, 1);
		assert.equal(result.stderr, "error: arena --check unit: no check 'unit'\n");
		assert.deepEqual(
			calls.filter((call) => call.op !== "progress"),
			[],
		);
	});
});
