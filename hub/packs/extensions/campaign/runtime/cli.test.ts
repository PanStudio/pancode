import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type CampaignHost, CampaignUsageError, HELP, runCampaignCli } from "./cli.ts";
import { type CampaignInput, type CampaignResult, emptyDigest } from "./types.ts";

interface Setup {
	root: string;
	args: string[];
	host: (overrides?: Partial<CampaignHost>) => () => CampaignHost;
	runs: CampaignInput[];
}

function setup(): Setup {
	const root = mkdtempSync(join(tmpdir(), "campaign-cli-"));
	mkdirSync(join(root, "fixture"));
	writeFileSync(join(root, "roster.yaml"), JSON.stringify({ roster: [{ target: "t", model: "m" }] }));
	writeFileSync(join(root, "answers.yaml"), "answers: []\n");
	const args = [
		"run",
		"--fixture",
		join(root, "fixture"),
		"--roster",
		join(root, "roster.yaml"),
		"--answers",
		join(root, "answers.yaml"),
		"--prompt",
		"go",
		"--out",
		join(root, "out"),
	];
	const runs: CampaignInput[] = [];
	const host =
		(overrides: Partial<CampaignHost> = {}) =>
		(): CampaignHost => ({
			path: (flag) => {
				const index = args.indexOf(flag);
				return args[index + 1] as string;
			},
			readText: (file) => readFileSync(file, "utf8"),
			yaml: async (text) => JSON.parse(text),
			answersRefusal: async () => null,
			yoloRefusal: async () => null,
			run: async (input) => {
				runs.push(input);
				return result(input, ["completed", "failed"]);
			},
			interrupted: () => false,
			...overrides,
		});
	return { root, args, host, runs };
}

function result(input: CampaignInput, statuses: Array<CampaignResult["entries"][number]["status"]>): CampaignResult {
	return {
		schemaVersion: 2,
		fixture: input.fixture,
		answers: input.answersFile,
		prompt: input.prompt,
		out: input.out,
		timeoutSeconds: input.timeoutSeconds,
		repeat: 1,
		autonomy: input.autonomy,
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:01:00.000Z",
		canceled: false,
		entries: statuses.map((status, index) => ({
			schemaVersion: 2,
			index,
			repetition: 0,
			label: `e${index}`,
			target: "t",
			model: "m",
			thinking: null,
			status,
			exitCode: status === "completed" ? 0 : 1,
			startedAt: null,
			wallMs: 1500,
			dir: join(input.out, `0${index + 1}-e${index}`),
			metrics: { ...emptyDigest(), gates: { reached: ["c1"], interviews: 1, answered: 1, unscripted: 0, unanswered: 0 } },
			completion: { claimed: "done", assessed: "partly_done", facts: ["failed_check"] },
			verification: null,
			desk: null,
			error: status === "completed" ? null : "boom\nbang",
		})),
	};
}

const usage = (message: string): string => `error: campaign: ${message}\n  see pancode campaign --help\n`;

describe("campaign command line", () => {
	it("prints help for no command, --help and -h anywhere", async () => {
		const { host } = setup();
		for (const args of [[], ["--help"], ["run", "-h"], ["run", "--fixture", "x", "--help"]]) {
			const answer = await runCampaignCli(args, host());
			assert.equal(answer.exitCode, 0);
			assert.equal(answer.stdout, `${HELP}\n`);
		}
	});

	it("words usage errors as the core command did, in its order", async () => {
		const { args, host, root } = setup();
		const cases: Array<[string[], string]> = [
			[["frob"], "unknown campaign command: frob"],
			[["run"], "campaign run needs --fixture"],
			[["run", "--fixture", "f"], "campaign run needs --out"],
			[[...args, "--bogus"], "unknown option: --bogus"],
			[[...args, "stray"], "unexpected argument: stray"],
			[[...args, "--out", "o2"], "--out given more than once"],
			[[...args, "--timeout"], "--timeout needs a value"],
			[[...args, "--probe", "nocolon"], "--probe takes <extension>:<command>, got 'nocolon'"],
			[[...args, "--timeout", "0"], "--timeout takes a positive whole number of seconds"],
			[[...args, "--timeout", "86401"], "--timeout takes at most 86400 seconds"],
			[[...args, "--repeat", "x"], "--repeat takes a positive whole number"],
			[[...args, "--autonomy", "wild"], "--autonomy takes default or yolo"],
			[[...args.slice(0, 8), "  ", ...args.slice(9)], "campaign run needs --prompt"],
		];
		for (const [argv, message] of cases) {
			const answer = await runCampaignCli(argv, host());
			assert.equal(answer.stderr, usage(message), argv.join(" "));
			assert.equal(answer.exitCode, 2);
		}
		const missingFixture = args.map((arg) => (arg === join(root, "fixture") ? join(root, "nofix") : arg));
		const answer = await runCampaignCli(
			missingFixture,
			setup().host({ path: (flag) => missingFixture[missingFixture.indexOf(flag) + 1] as string }),
		);
		assert.equal(answer.stderr, usage(`--fixture ${join(root, "nofix")} does not exist`));
	});

	it("takes a value flag's next argument as its value even when it starts with --", async () => {
		const { args, host } = setup();
		const answer = await runCampaignCli([...args.slice(0, 8), "--json", ...args.slice(9)], host());
		assert.equal(answer.exitCode, 0);
	});

	it("prefixes the file to roster, answers and path refusals", async () => {
		const { args, host, root } = setup();
		writeFileSync(join(root, "bad.yaml"), JSON.stringify({ roster: [{ target: "t" }] }));
		const roster = await runCampaignCli(
			args,
			host({ readText: (file) => (file.endsWith("roster.yaml") ? JSON.stringify({ roster: [{ target: "t" }] }) : "") }),
		);
		assert.equal(
			roster.stderr,
			usage(`--roster ${join(root, "roster.yaml")}: roster[0].model: expected a non-empty string`),
		);
		const unreadable = await runCampaignCli(
			args,
			host({
				readText: () => {
					throw new Error("ENOENT: gone");
				},
			}),
		);
		assert.equal(unreadable.stderr, usage(`--roster ${join(root, "roster.yaml")}: cannot read the file: ENOENT: gone`));
		const answers = await runCampaignCli(args, host({ answersRefusal: async () => "answers: expected a list" }));
		assert.equal(answers.stderr, usage(`--answers ${join(root, "answers.yaml")}: answers: expected a list`));
		const inside = args.map((arg) => (arg === join(root, "out") ? join(root, "fixture", "sub") : arg));
		const nested = await runCampaignCli(inside, host({ path: (flag) => inside[inside.indexOf(flag) + 1] as string }));
		assert.equal(
			nested.stderr,
			usage(`--out ${join(root, "fixture", "sub")} is inside the fixture; the fixture is copied whole`),
		);
		mkdirSync(join(root, "out"));
		writeFileSync(join(root, "out", "x"), "");
		const full = await runCampaignCli(args, host());
		assert.equal(full.stderr, usage(`--out ${join(root, "out")} already holds files; name an absent or empty directory`));
	});

	it("refuses a path no grant opened, and yolo the host cannot contain", async () => {
		const { args, host } = setup();
		const ungranted = await runCampaignCli(
			args,
			host({
				path: (flag) => {
					throw new CampaignUsageError(`${flag} not granted`);
				},
			}),
		);
		assert.equal(ungranted.stderr, usage("--fixture not granted"));
		const yolo = await runCampaignCli([...args, "--autonomy", "yolo"], host({ yoloRefusal: async () => "no sandbox" }));
		assert.equal(yolo.stderr, usage("no sandbox"));
	});

	it("runs with the answers text and the longest timeout by default", async () => {
		const { args, host, runs } = setup();
		const answer = await runCampaignCli([...args, "--json"], host());
		assert.equal(answer.exitCode, 0);
		assert.equal(runs[0]?.answers, "answers: []\n");
		assert.equal(runs[0]?.timeoutSeconds, 86_400);
		const document = JSON.parse(answer.stdout);
		assert.deepEqual(document.completion, { state: "completed", stopReason: null });
		assert.equal(document.verdict.aggregate, "partial");
		assert.equal((await runCampaignCli([...args, "--exit-code"], host())).exitCode, 1);
	});

	it("renders the table with its notes", async () => {
		const { args, host, root } = setup();
		const answer = await runCampaignCli(args, host());
		const lines = answer.stdout.split("\n");
		assert.match(
			lines[0] ?? "",
			/^ENTRY {2}STATUS +EXIT {2}DONE +GATES {2}REFUSALS h\/t {2}LOOP {2}INPUT {2}FRESH {2}CACHED {2}OUTPUT {2}WALL {2}DESK$/,
		);
		assert.match(lines[1] ?? "", /^e0 +completed +0 +done>partly_done +1 +0\/0 +0 +- +- +- +- +1\.5s +-$/);
		assert.ok(answer.stdout.includes("e1: boom / bang"));
		assert.ok(answer.stdout.includes("e0: completion facts failed_check"));
		assert.ok(answer.stdout.endsWith(`\nentries and logs under ${join(root, "out")}\n`));
	});

	it("reports any other failure with exit 1", async () => {
		const { args, host } = setup();
		const answer = await runCampaignCli(
			args,
			host({
				run: async () => {
					throw new Error("no runs service");
				},
			}),
		);
		assert.equal(answer.stderr, "error: campaign: no runs service\n");
		assert.equal(answer.exitCode, 1);
	});
});
