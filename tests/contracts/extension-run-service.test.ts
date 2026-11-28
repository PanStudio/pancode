// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	capabilityEnvelope,
	envelopeGrowth,
	parseExtensionOutputV2,
	parseExtensionRuntimeV2,
	RUNTIME_V2_LIMITS,
} from "@pancode/sdk/pack";
import { runPackVerb } from "../../src/cli/extensions.js";
import type { RunCommandVectorOptions, SafeCommandResult } from "../../src/core/safe-exec.js";
import { applyToolEnvControls, EXTENSION_RUN_DEPTH_ENV } from "../../src/core/tool-env-controls.js";
import { extensionInvocation } from "../../src/domains/extensions/operator-commands.js";
import { OperatorExtensions } from "../../src/domains/extensions/operator-extensions.js";
import { extensionProjectDir, prepareProjectDir } from "../../src/domains/extensions/runtime-sandbox.js";
import {
	createExtensionRunService,
	type ExtensionRunCeilings,
	type ExtensionRunError,
} from "../../src/domains/extensions/services/runs.js";
import { createExtensionRequestScope } from "../../src/domains/extensions/services/scope.js";
import { disableExtension, installExtension } from "../../src/domains/extensions/state.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

interface Call {
	file: string;
	args: string[];
	options: RunCommandVectorOptions;
	answers: string | null;
}

function result(partial: Partial<SafeCommandResult>): SafeCommandResult {
	return {
		file: "pancode",
		args: [],
		cwd: "/w",
		stdout: "",
		stderr: "",
		exitCode: 0,
		signal: null,
		aborted: false,
		timedOut: false,
		outputCapped: false,
		durationMs: 1,
		...partial,
	};
}

function harness(
	ceilings: Partial<ExtensionRunCeilings> = {},
	yolo: string | null = null,
	readOnly = false,
	env: Record<string, string> = {},
) {
	const tempRoot = mkdtempSync(join(tmpdir(), "run-service-"));
	const calls: Call[] = [];
	const service = createExtensionRunService({
		ceilings: { maxConcurrent: 2, autonomy: ["default"], maxCostUsd: 2, maxTimeoutSeconds: 600, ...ceilings },
		launch: { file: "node", args: ["/pancode.js"], env: { PANCODE_SELF: "1" } },
		sourceEnv: { PATH: "/bin", SECRET_TOKEN: "x", ...env },
		envPolicy: { targets: [], passEnv: [] },
		yoloRefusal: () => yolo,
		...(readOnly ? { readOnly: () => true } : {}),
		resolvePlace: (place) =>
			place === "workspace" ? { cwd: "/w", workspaceRoot: "/w" } : { cwd: `/t/${place.worktree}`, workspaceRoot: "/t" },
		tempRoot,
		spawn: (file, args, options = {}) =>
			new Promise((resolve) => {
				const index = args.indexOf("--answers");
				const answers = index >= 0 ? readFileSync(args[index + 1] as string, "utf8") : null;
				calls.push({ file, args: [...args], options, answers });
				const emit = (text: string) => options.output?.onStdout?.(Buffer.from(text));
				const finish = (partial: Partial<SafeCommandResult>) => resolve(result(partial));
				const prompt = args.at(-1);
				if (prompt === "hang") {
					options.signal?.addEventListener("abort", () => finish({ aborted: true, exitCode: null }));
					return;
				}
				if (prompt === "flood") {
					for (let index = 0; index < 5000; index += 1) emit(`{"type":"tick","n":${index}}\n`);
					emit('{"type":"run_end","outcome":"succeeded","exitCode":0}\n');
					setImmediate(() => finish({}));
					return;
				}
				emit('{"type":"session","id":"s1"}\nnot json\n{"type":"turn_');
				setImmediate(() => {
					emit('end","text":"hi"}\n{"type":"run_end","outcome":"succeeded","exitCode":0}');
					finish({});
				});
			}),
	});
	return { service, calls, tempRoot, cleanup: () => rmSync(tempRoot, { recursive: true, force: true }) };
}

const base = { prompt: "do it", target: "openai-codex", model: "gpt-6-luna", timeoutSeconds: 60 };

describe("extension run service", () => {
	it("launches a headless stream-json run and pages its frames to run_end", async () => {
		const h = harness();
		const { id } = await h.service.start({ ...base, thinking: "high", answers: "yes\n", cwd: { worktree: "a1" } });
		const end = await h.service.wait(id);
		assert.equal(end.outcome, "succeeded");
		assert.equal(end.end?.type, "run_end");
		const call = h.calls[0] as Call;
		assert.deepEqual(call.args.slice(0, 6), ["/pancode.js", "run", "--cwd", "/t/a1", "--target", "openai-codex"]);
		assert.ok(call.args.includes("--max-cost-usd") && call.args[call.args.indexOf("--max-cost-usd") + 1] === "2");
		assert.deepEqual(call.args.slice(-4), ["--output-format", "stream-json", "--", "do it"]);
		assert.equal(call.answers, "yes\n");
		assert.equal(call.options.timeoutMs, 90_000);
		assert.equal(call.options.env?.SECRET_TOKEN, undefined);
		assert.equal(call.options.env?.PANCODE_SELF, "1");
		assert.equal(readdirSync(h.tempRoot).length, 0, "the answers file goes with its run");
		const page = await h.service.frames(id, { cursor: 0, limit: 2 });
		assert.deepEqual(
			page.frames.map((frame) => frame.type),
			["session", "turn_end"],
		);
		const rest = await h.service.frames(id, { cursor: page.next });
		assert.equal(rest.frames[0]?.type, "run_end");
		assert.equal(rest.done, true);
		h.cleanup();
	});

	it("refuses requests past the manifest's ceilings", async () => {
		const h = harness({ maxConcurrent: 1 });
		await assert.rejects(h.service.start({ ...base, autonomy: "yolo" }), (error: ExtensionRunError) => {
			return error.code === "refused";
		});
		await assert.rejects(h.service.start({ ...base, timeoutSeconds: 601 }), /timeoutSeconds/u);
		await assert.rejects(h.service.start({ ...base, target: "--evil" }), /target/u);
		const { id } = await h.service.start({ ...base, prompt: "hang", maxCostUsd: 50 });
		const call = h.calls[0] as Call;
		assert.equal(call.args[call.args.indexOf("--max-cost-usd") + 1], "2");
		await assert.rejects(h.service.start(base), (error: ExtensionRunError) => error.code === "busy");
		await h.service.cancel(id);
		assert.equal((await h.service.wait(id)).outcome, "canceled");
		h.cleanup();
	});

	it("passes the yolo gate's refusal through and pins contained yolo when allowed", async () => {
		const refused = harness({ autonomy: ["default", "yolo"] }, "yolo is not contained here");
		await assert.rejects(refused.service.start({ ...base, autonomy: "yolo" }), /not contained/u);
		refused.cleanup();
		const h = harness({ autonomy: ["default", "yolo"] });
		await h.service.wait((await h.service.start({ ...base, autonomy: "yolo" })).id);
		const call = h.calls[0] as Call;
		assert.ok(call.args.includes("yolo"));
		assert.equal(call.options.env?.PANCODE_YOLO_CONFINEMENT, "contained");
		h.cleanup();
	});

	it("refuses a run nested two extension runs deep and counts the depth into each run it starts", async () => {
		const nested = harness({}, null, false, { PANCODE_EXTENSION_RUN_DEPTH: "1" });
		await nested.service.wait((await nested.service.start(base)).id);
		assert.equal(nested.calls[0]?.options.env?.PANCODE_EXTENSION_RUN_DEPTH, "2");
		nested.cleanup();
		const deep = harness({}, null, false, { PANCODE_EXTENSION_RUN_DEPTH: "2" });
		await assert.rejects(
			deep.service.start(base),
			(error: ExtensionRunError) => error.code === "refused" && /2 extension runs deep/u.test(error.message),
		);
		assert.equal(deep.calls.length, 0);
		deep.cleanup();
		for (const bad of ["-5", "abc"]) {
			const malformed = harness({}, null, false, { PANCODE_EXTENSION_RUN_DEPTH: bad });
			await assert.rejects(
				malformed.service.start(base),
				(error: ExtensionRunError) =>
					error.code === "refused" && /invalid PANCODE_EXTENSION_RUN_DEPTH/u.test(error.message),
			);
			assert.equal(malformed.calls.length, 0);
			malformed.cleanup();
		}
	});

	it("preserves PANCODE_EXTENSION_RUN_DEPTH across tool-env-controls without allowing downgrades", () => {
		const previous = process.env[EXTENSION_RUN_DEPTH_ENV];
		try {
			delete process.env[EXTENSION_RUN_DEPTH_ENV];
			assert.equal(applyToolEnvControls({})[EXTENSION_RUN_DEPTH_ENV], undefined);
			assert.equal(applyToolEnvControls({ [EXTENSION_RUN_DEPTH_ENV]: "1" })[EXTENSION_RUN_DEPTH_ENV], "1");

			process.env[EXTENSION_RUN_DEPTH_ENV] = "1";
			assert.equal(applyToolEnvControls({})[EXTENSION_RUN_DEPTH_ENV], "1");
			assert.equal(applyToolEnvControls({ [EXTENSION_RUN_DEPTH_ENV]: "0" })[EXTENSION_RUN_DEPTH_ENV], "1");
			assert.equal(applyToolEnvControls({ [EXTENSION_RUN_DEPTH_ENV]: "2" })[EXTENSION_RUN_DEPTH_ENV], "2");
			assert.equal(applyToolEnvControls({ [EXTENSION_RUN_DEPTH_ENV]: "-5" })[EXTENSION_RUN_DEPTH_ENV], "2");

			process.env[EXTENSION_RUN_DEPTH_ENV] = "2";
			assert.equal(applyToolEnvControls({})[EXTENSION_RUN_DEPTH_ENV], "2");
			assert.equal(applyToolEnvControls({ [EXTENSION_RUN_DEPTH_ENV]: "1" })[EXTENSION_RUN_DEPTH_ENV], "2");
		} finally {
			if (previous === undefined) delete process.env[EXTENSION_RUN_DEPTH_ENV];
			else process.env[EXTENSION_RUN_DEPTH_ENV] = previous;
		}
	});

	it("ends a run when the starting request ends", async () => {
		const h = harness();
		const scope = createExtensionRequestScope();
		const { id } = await h.service.start({ ...base, prompt: "hang" }, scope);
		const waiting = h.service.frames(id, { cursor: Number.NaN, limit: Number.NaN, waitMs: 30_000 }, scope);
		await scope.end();
		const page = await waiting;
		assert.equal(page.next, 0);
		assert.equal(page.dropped, 0);
		assert.equal((await h.service.wait(id)).outcome, "canceled");
		h.cleanup();
	});

	it("answers in advance the refusal start would give, without starting a run", async () => {
		const defaultOnly = harness();
		assert.equal(await defaultOnly.service.refusal(), null);
		assert.match((await defaultOnly.service.refusal({ autonomy: "yolo" })) ?? "", /does not allow autonomy yolo/u);
		defaultOnly.cleanup();
		const gated = harness({ autonomy: ["default", "yolo"] }, "yolo is not contained here");
		assert.equal(await gated.service.refusal({ autonomy: "yolo" }), "yolo is not contained here");
		gated.cleanup();
		const readOnly = harness({}, null, true);
		assert.match((await readOnly.service.refusal()) ?? "", /read-only session/u);
		assert.equal(await readOnly.service.refusal({ readOnly: true }), null);
		readOnly.cleanup();
		const deep = harness({}, null, false, { PANCODE_EXTENSION_RUN_DEPTH: "2" });
		assert.match((await deep.service.refusal()) ?? "", /2 extension runs deep/u);
		assert.equal(deep.calls.length + readOnly.calls.length + gated.calls.length + defaultOnly.calls.length, 0);
		deep.cleanup();
	});

	it("refuses writable or yolo runs in a read-only session while allowing read-only runs", async () => {
		const h = harness({ autonomy: ["default", "yolo"] }, null, true);
		await assert.rejects(h.service.start(base), (error: ExtensionRunError) => error.code === "refused");
		await assert.rejects(
			h.service.start({ ...base, readOnly: true, autonomy: "yolo" }),
			(error: ExtensionRunError) => error.code === "refused",
		);
		const { id } = await h.service.start({ ...base, readOnly: true });
		assert.equal((await h.service.wait(id)).outcome, "succeeded");
		assert.ok((h.calls[0] as Call).args.includes("--read-only"));
		h.cleanup();
	});

	it("reports frames a slow reader lost to the window", async () => {
		const h = harness();
		const { id } = await h.service.start({ ...base, prompt: "flood" });
		await h.service.wait(id);
		const page = await h.service.frames(id, { cursor: 0, limit: 1 });
		assert.ok(page.dropped > 0);
		assert.equal(page.next, page.dropped + 1);
		h.cleanup();
	});
});

describe("runs, long commands and verbs in a manifest", () => {
	const runtime = (extra: Record<string, unknown>) =>
		parseExtensionRuntimeV2({
			api: 2,
			entrypoint: "extension.mjs",
			commands: [{ name: "drive", description: "drive" }],
			...extra,
		});
	const runs = { runs: { maxTimeoutSeconds: 600 } };

	it("refuses a capability declared without the one it needs", () => {
		const long = { commands: [{ name: "drive", description: "drive", long: true, timeoutMs: 3_600_000 }] };
		assert.throws(() => runtime(long), /long.*needs runtime\.services\.runs/u);
		assert.equal(runtime({ ...long, services: runs }).commands[0]?.timeoutMs, 3_600_000);
		assert.throws(
			() => runtime({ commands: [{ name: "drive", description: "drive", timeoutMs: 3_600_000 }] }),
			/timeoutMs/u,
		);
		assert.equal(runtime({ services: { worktrees: true } }).services?.worktrees, true);
		assert.throws(() => runtime({ services: { claims: true } }), /claims.*services\.verify/u);
		assert.throws(() => runtime({ cli: [{ verb: "go", command: "missing", summary: "go" }] }), /runtime\.cli/u);
		assert.throws(() => runtime({ cli: [{ verb: "Go", command: "drive", summary: "go" }] }), /runtime\.cli\[0\]\.verb/u);
		assert.deepEqual(runtime({ services: runs }).services?.runs?.autonomy, ["default"]);
	});

	it("lets only a command answer the operator past the limits a model-bound answer keeps", () => {
		const declaration = runtime({});
		const long = "x".repeat(40_000);
		assert.equal(parseExtensionOutputV2({ text: long, stderr: "note" }, declaration, "command").text, long);
		for (const origin of ["tool", "observation", "action"] as const) {
			assert.throws(() => parseExtensionOutputV2({ text: long }, declaration, origin), /text/u, origin);
			assert.throws(() => parseExtensionOutputV2({ text: "ok", stderr: "note" }, declaration, origin), /only a command/u);
		}
		assert.throws(
			() => parseExtensionOutputV2({ text: "y".repeat(RUNTIME_V2_LIMITS.commandTextChars + 1) }, declaration, "command"),
			/text/u,
		);
	});

	it("reports runs, worktrees, long commands and verbs as envelope growth", () => {
		const base = capabilityEnvelope(runtime({}));
		const grown = capabilityEnvelope(
			runtime({
				commands: [{ name: "drive", description: "drive", long: true }],
				services: { ...runs, worktrees: true },
				cli: [{ verb: "drive-it", command: "drive", summary: "drive" }],
			}),
		);
		const growth = envelopeGrowth(base, grown);
		for (const expected of [/headless PanCode runs/u, /git worktrees/u, /long-running commands: drive/u, /drive-it/u])
			assert.ok(
				growth.some((line) => expected.test(line)),
				`${expected} in ${JSON.stringify(growth)}`,
			);
		assert.deepEqual(envelopeGrowth(grown, grown), []);
	});
});

const driverSource = `export default (api) => {
	api.handle("drive", async (args, ctx) => {
		ctx.progress("starting " + args);
		const { id } = await ctx.runs.start({ prompt: args, target: "fixture", model: "chat", timeoutSeconds: 60 });
		const end = await ctx.runs.wait(id);
		return { text: end.outcome + " " + typeof ctx.storeDir, exitCode: end.outcome === "succeeded" ? 0 : 3 };
	});
	api.handle("plain", (args, ctx) => ({
		text: [typeof ctx.progress, typeof ctx.runs, args, ctx.argv && JSON.stringify(ctx.argv)].filter(Boolean).join(" "),
		...(ctx.argv ? { stderr: "plain: a note" } : {}),
		exitCode: 4,
	}));
};
`;

describe("an extension's project directory", () => {
	it("sits under the repository root's .pancode/data, and refuses a component that is not a plain directory", (t) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "ext-project-")));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		execFileSync("git", ["-C", root, "init", "-q"]);
		mkdirSync(join(root, "sub"));
		const project = extensionProjectDir(join(root, "sub"), "arena");
		assert.deepEqual(project, { root, dir: join(root, ".pancode", "data", "arena") });
		assert.deepEqual(prepareProjectDir(project), [
			join(root, ".pancode"),
			join(root, ".pancode", "data"),
			join(root, ".pancode", "data", "arena"),
		]);
		assert.deepEqual(prepareProjectDir(project), []);
		rmSync(join(root, ".pancode", "data"), { recursive: true });
		symlinkSync(tmpdir(), join(root, ".pancode", "data"));
		assert.throws(() => prepareProjectDir(project), /not a plain directory/u);
	});
});

describe("an installed extension's work services", () => {
	async function installDriver(t: { after(fn: () => unknown): void }) {
		const env = await isolatePancodeEnv("pancode-ext-runs-");
		const previous = process.cwd();
		const cleanup: Array<() => Promise<void>> = [];
		t.after(async () => {
			for (const step of cleanup.reverse()) await step();
			process.chdir(previous);
			env.restore();
		});
		const root = join(env.dir, "source");
		const cwd = join(env.dir, "workspace");
		process.env.HOME = env.dir;
		mkdirSync(root);
		mkdirSync(cwd);
		writeFileSync(
			join(root, "pancode-extension.json"),
			JSON.stringify({
				id: "driver",
				version: "1.0.0",
				description: "Drives headless runs",
				runtime: {
					api: 2,
					entrypoint: "extension.mjs",
					commands: [
						{ name: "drive", description: "drive", long: true, timeoutMs: 120_000 },
						{ name: "plain", description: "plain" },
					],
					permissions: { fs: { write: ["store"] } },
					services: { runs: { maxTimeoutSeconds: 600 } },
					cli: [{ verb: "drive-plain", command: "plain", summary: "a plain answer" }],
				},
			}),
		);
		writeFileSync(join(root, "extension.mjs"), driverSource);
		assert.ok(installExtension(root, { cwd, scope: "user" }).extension?.loadable);
		process.chdir(cwd);
		// Stands in for \`pancode run --output-format stream-json\`: one run_end frame, whatever it was asked.
		const fakeRun = join(env.dir, "fake-run.mjs");
		writeFileSync(
			fakeRun,
			'process.stdout.write(JSON.stringify({ type: "run_end", outcome: "succeeded", exitCode: 0 }) + "\\n");\n',
		);
		return { cwd, cleanup, launch: { file: process.execPath, args: [fakeRun] } };
	}

	it("a long command reports progress and waits on a run it started; others get no progress", async (t) => {
		const { cleanup, launch } = await installDriver(t);
		const operator = new OperatorExtensions({
			context: () => ({ workspace: process.cwd(), sessionId: "attended", mode: "interactive" }),
			isIdle: () => true,
			onlyId: "driver",
			work: { launch, env: { PATH: process.env.PATH ?? "" } },
		});
		cleanup.push(() => operator.dispose());
		assert.equal((await operator.reload("startup")).status, "committed");
		const progress: string[] = [];
		const signal = new AbortController().signal;
		const output = await operator.invoke(extensionInvocation("driver", "drive"), "now", [], signal, (text) =>
			progress.push(text),
		);
		assert.deepEqual(output, { text: "succeeded string", exitCode: 0 });
		assert.deepEqual(progress, ["starting now"]);
		const plain = await operator.invoke(extensionInvocation("driver", "plain"), "", [], signal, (text) =>
			progress.push(text),
		);
		assert.equal(plain.text, "undefined object");
		assert.equal(progress.length, 1);
	});

	it("a declared verb passes its arguments as given and prints the answer verbatim", async (t) => {
		const { cwd } = await installDriver(t);
		const out: string[] = [];
		const err: string[] = [];
		const write = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
		process.stdout.write = ((chunk: string) => out.push(String(chunk)) > 0) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string) => err.push(String(chunk)) > 0) as typeof process.stderr.write;
		try {
			assert.equal(await runPackVerb("drive-plain", ["sub", "--help", "--cwd", cwd, "--", "-x y"]), 4);
			assert.equal(await runPackVerb("drive-plain", [], "--no-skills is not honored"), 2);
			assert.equal(await runPackVerb("drive-plain", ["--cwd", join(cwd, "absent")]), 2);
			assert.equal(await runPackVerb("not-a-verb", []), null);
			assert.equal(disableExtension("driver", { cwd, scope: "user" }).extension?.enabled, false);
			assert.equal(await runPackVerb("drive-plain", []), 2);
		} finally {
			process.stdout.write = write.out;
			process.stderr.write = write.err;
		}
		// The test reporter shares stdout; the verb's answer is the chunk its handler wrote.
		const argv = ["sub", "--help", "--cwd", cwd, "--", "-x y"];
		assert.deepEqual(
			out.filter((chunk) => chunk.startsWith("undefined object")),
			[`undefined object ${argv.join(" ")} ${JSON.stringify(argv)}\n`],
		);
		assert.equal(err[0], "plain: a note\n");
		assert.ok(err.some((line) => line.includes("--no-skills is not honored")));
		assert.ok(
			err.includes(
				`pancode drive-plain: --cwd ${join(cwd, "absent")}: not a directory\nsee: pancode drive-plain --help\n`,
			),
			err.join(""),
		);
		assert.equal(
			err.at(-1),
			"pancode drive-plain: extension:driver is disabled; pancode extensions enable driver enables it\n",
		);
	});

	it("a verb the bundled index lists names the pack to install when it is absent", async () => {
		const env = await isolatePancodeEnv("pancode-ext-absent-");
		const err: string[] = [];
		const write = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string) => err.push(String(chunk)) > 0) as typeof process.stderr.write;
		try {
			assert.equal(await runPackVerb("arena", ["list"]), 2);
		} finally {
			process.stderr.write = write;
			env.restore();
		}
		assert.deepEqual(err, [
			"pancode arena: extension:arena is not installed; pancode hub install extension:arena installs it\n",
		]);
	});

	it("transient worktrees created by a command are removed before invoke resolves", async (t) => {
		const env = await isolatePancodeEnv("ext-scope-cleanup-");
		const priorCwd = process.cwd();
		const cleanup: Array<() => Promise<void> | void> = [];
		t.after(async () => {
			for (const fn of cleanup.reverse()) await fn();
			process.chdir(priorCwd);
			env.restore();
		});
		const root = join(env.dir, "pack");
		const repo = join(env.dir, "repo");
		process.env.HOME = env.dir;
		mkdirSync(root);
		mkdirSync(repo);
		const git = (args: string[]): void => {
			execFileSync("git", args, {
				cwd: repo,
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "Test",
					GIT_AUTHOR_EMAIL: "test@example.com",
					GIT_COMMITTER_NAME: "Test",
					GIT_COMMITTER_EMAIL: "test@example.com",
				},
				stdio: "ignore",
			});
		};
		git(["init", "-q"]);
		writeFileSync(join(repo, "f.txt"), "hello\n");
		git(["add", "f.txt"]);
		git(["commit", "-q", "-m", "init"]);
		writeFileSync(
			join(root, "pancode-extension.json"),
			JSON.stringify({
				id: "wt-scope",
				version: "1.0.0",
				description: "Creates a transient worktree and returns its path",
				runtime: {
					api: 2,
					entrypoint: "extension.mjs",
					commands: [{ name: "make", description: "make" }],
					services: { worktrees: true },
				},
			}),
		);
		writeFileSync(
			join(root, "extension.mjs"),
			`export default (api) => {
				api.handle("make", async (_args, ctx) => {
					const wt = await ctx.worktrees.create({ base: "HEAD" });
					return { text: wt.path };
				});
			};`,
		);
		assert.ok(installExtension(root, { cwd: repo, scope: "user" }).extension?.loadable);
		process.chdir(repo);
		const operator = new OperatorExtensions({
			context: () => ({ workspace: repo, sessionId: "attended", mode: "interactive" }),
			isIdle: () => true,
			onlyId: "wt-scope",
		});
		cleanup.push(() => operator.dispose());
		assert.equal((await operator.reload("startup")).status, "committed");
		const output = await operator.invoke(extensionInvocation("wt-scope", "make"), "", [], new AbortController().signal);
		assert.ok(output.text);
		assert.equal(existsSync(output.text), false);
	});
});
