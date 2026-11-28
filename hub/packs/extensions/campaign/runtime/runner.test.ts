import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
	ExtensionRunCommandRequest,
	ExtensionRunEnd,
	ExtensionRunRequest,
	ExtensionRuns,
} from "pancode/sdk/extension";
import { entryDirName, readProbe, readRunEnd, runCampaign, statusOf } from "./runner.ts";
import { type CampaignInput, emptyDigest } from "./types.ts";

const end = (overrides: Partial<ExtensionRunEnd> = {}): ExtensionRunEnd => ({
	exitCode: 0,
	outcome: "succeeded",
	end: null,
	stderrTail: "",
	...overrides,
});

const RUN_END = {
	type: "run_end",
	schemaVersion: 3,
	outcome: "succeeded",
	completion: { claimed: "done", assessed: "partly_done", facts: ["failed_check", 3] },
	causes: [{ code: "c.one" }, "skip"],
	verify: { checks: [{ command: "npm test", status: "passed" }, { command: 1 }] },
};

describe("campaign entry status", () => {
	it("maps the run's end the way the core command mapped its exit", () => {
		assert.equal(statusOf(end(), false), "completed");
		assert.equal(statusOf(end(), true), "canceled");
		assert.equal(statusOf(end({ outcome: "canceled", exitCode: null }), false), "canceled");
		assert.equal(statusOf(end({ exitCode: 124, outcome: "timed_out" }), false), "timed-out");
		assert.equal(statusOf(end({ exitCode: null, outcome: "timed_out" }), false), "timed-out");
		assert.equal(statusOf(end({ exitCode: null, outcome: "error" }), false), "error");
		assert.equal(statusOf(end({ exitCode: 5, outcome: "failed" }), false), "unscripted");
		assert.equal(statusOf(end({ exitCode: 1, outcome: "failed" }), false), "failed");
	});

	it("reads completion and verification from a schema 3 run_end frame only", () => {
		assert.deepEqual(readRunEnd(RUN_END), {
			completion: { claimed: "done", assessed: "partly_done", facts: ["failed_check"] },
			verification: {
				outcome: "succeeded",
				outcomeDetail: null,
				causes: ["c.one"],
				checks: [{ command: "npm test", status: "passed" }],
			},
		});
		assert.deepEqual(readRunEnd({ ...RUN_END, schemaVersion: 2 }), { completion: null, verification: null });
		assert.deepEqual(readRunEnd(null), { completion: null, verification: null });
	});

	it("keeps the probe's --json answer, or why there is none", () => {
		const probe = { extension: "desk", command: "status" };
		const ok = readProbe(probe, {
			exitCode: 0,
			stdout: '{"output":{"text":" ready \\n","data":{"n":1}}}',
			stderrTail: "",
		});
		assert.deepEqual(ok, { ...probe, exitCode: 0, text: "ready", data: { n: 1 }, error: null });
		const failed = readProbe(probe, { exitCode: 1, stdout: "", stderrTail: "a\nerror: b\nerror: c\nerror: d\n" });
		assert.equal(failed.error, "b\nc\nd");
		assert.equal(readProbe(probe, { exitCode: null, stdout: "", stderrTail: "", error: "stopped" }).error, "stopped");
		assert.match(
			readProbe(probe, { exitCode: 0, stdout: "nope", stderrTail: "" }).error ?? "",
			/^unreadable --json result: /,
		);
	});

	it("names entry directories by position and label, with the pass when the roster repeats", () => {
		assert.equal(entryDirName(0, "t/m@high", 0, 1), "01-t-m-high");
		assert.equal(entryDirName(11, "x", 1, 3), "12-x-r2");
	});
});

interface FakeRuns {
	runs: ExtensionRuns;
	starts: ExtensionRunRequest[];
	commands: ExtensionRunCommandRequest[];
	canceled: string[];
}

function fakeRuns(ends: ExtensionRunEnd[]): FakeRuns {
	const starts: ExtensionRunRequest[] = [];
	const commands: ExtensionRunCommandRequest[] = [];
	const canceled: string[] = [];
	const runs: ExtensionRuns = {
		async start(request) {
			starts.push(request);
			return { id: String(starts.length - 1) };
		},
		async frames(id, options) {
			const cursor = options?.cursor ?? 0;
			if (cursor > 0) return { frames: [], next: cursor, dropped: 0, done: true };
			return { frames: [{ type: "system", id }, { ...RUN_END }], next: 2, dropped: 0, done: false };
		},
		async wait(id) {
			return ends[Number(id)] ?? end();
		},
		async cancel(id) {
			canceled.push(id);
		},
		async refusal() {
			return null;
		},
		async digest(id) {
			return { ...emptyDigest(), sessionId: `s${id}` };
		},
		async command(request) {
			commands.push(request);
			return { exitCode: 0, stdout: '{"output":{"text":"desk ok"}}', stderrTail: "" };
		},
	};
	return { runs, starts, commands, canceled };
}

function input(overrides: Partial<CampaignInput> = {}): CampaignInput {
	const root = mkdtempSync(join(tmpdir(), "campaign-run-"));
	mkdirSync(join(root, "fixture"));
	writeFileSync(join(root, "fixture", "a.txt"), "seed");
	return {
		fixture: join(root, "fixture"),
		roster: [
			{ target: "t", model: "m", thinking: "high", label: "one" },
			{ target: "t", model: "n", thinking: null, label: "two" },
		],
		answersFile: join(root, "answers.yaml"),
		answers: "answers: []\n",
		prompt: "go",
		out: join(root, "out"),
		repeat: 1,
		timeoutSeconds: 600,
		autonomy: "default",
		probe: null,
		...overrides,
	};
}

describe("campaign run", () => {
	it("runs each entry in its own copy and home, and folds what the services report", async () => {
		const fake = fakeRuns([
			end({ end: RUN_END }),
			end({ exitCode: 1, outcome: "failed", stderrTail: "x\nerror: broke\n" }),
		]);
		const campaign = input({ probe: { extension: "desk", command: "status" } });
		const progress: string[] = [];
		const result = await runCampaign(fake.runs, new AbortController().signal, campaign, (line) => progress.push(line));
		const dir = join(campaign.out, "01-one");
		assert.deepEqual(fake.starts[0], {
			prompt: "go",
			target: "t",
			model: "m",
			thinking: "high",
			cwd: { path: join(dir, "project") },
			home: join(dir, "home"),
			autonomy: "default",
			answers: "answers: []\n",
			timeoutSeconds: 600,
		});
		assert.equal(readFileSync(join(dir, "project", "a.txt"), "utf8"), "seed");
		assert.equal(readFileSync(join(dir, "run.stdout.log"), "utf8").split("\n").length, 3);
		assert.deepEqual(fake.commands[0], {
			extension: "desk",
			command: "status",
			cwd: { path: join(dir, "project") },
			home: join(dir, "home"),
			timeoutSeconds: 120,
		});
		const [first, second] = result.entries;
		assert.equal(first?.status, "completed");
		assert.equal(first?.metrics.sessionId, "s0");
		assert.equal(first?.completion?.assessed, "partly_done");
		assert.equal(first?.desk?.text, "desk ok");
		assert.equal(second?.status, "failed");
		assert.equal(second?.error, "x\nbroke");
		assert.equal(readFileSync(join(campaign.out, "02-two", "run.stderr.log"), "utf8"), "x\nerror: broke\n");
		assert.equal(JSON.parse(readFileSync(join(campaign.out, "02-two", "entry.json"), "utf8")).status, "failed");
		assert.deepEqual(progress, ["entry 1/2 one: running", progress[1], "entry 2/2 two: running", progress[3]]);
		assert.match(progress[1] ?? "", /^entry 1\/2 one: completed in \d+\.\ds$/);
		assert.equal(result.timeoutSeconds, 600);
		assert.equal(result.canceled, false);
	});

	it("records an entry the runs service refuses as an error and goes on", async () => {
		const fake = fakeRuns([]);
		const start = fake.runs.start;
		let calls = 0;
		fake.runs.start = async (request) => {
			calls++;
			if (calls === 1) throw new Error("runs.start: runs nested too deep");
			return start(request);
		};
		const result = await runCampaign(fake.runs, new AbortController().signal, input(), () => undefined);
		assert.equal(result.entries[0]?.status, "error");
		assert.equal(result.entries[0]?.error, "runs.start: runs nested too deep");
		assert.equal(result.entries[1]?.status, "completed");
	});

	it("cancels the running entry on a stop and starts none after it", async () => {
		const fake = fakeRuns([end({ exitCode: null, outcome: "canceled" })]);
		const controller = new AbortController();
		const frames = fake.runs.frames;
		fake.runs.frames = async (id, options) => {
			controller.abort();
			return frames(id, options);
		};
		const campaign = input({ repeat: 2 });
		const result = await runCampaign(fake.runs, controller.signal, campaign, () => undefined);
		assert.deepEqual(fake.canceled, ["0"]);
		assert.equal(fake.starts.length, 1);
		assert.deepEqual(
			result.entries.map((entry) => [entry.status, entry.error]),
			[
				["canceled", null],
				["canceled", "canceled before it started"],
				["canceled", "canceled before it started"],
				["canceled", "canceled before it started"],
			],
		);
		assert.ok(existsSync(join(campaign.out, "02-two-r2", "entry.json")));
		assert.equal(result.canceled, true);
	});
});
