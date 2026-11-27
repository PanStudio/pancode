// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { capabilityEnvelope, envelopeGrowth, parseExtensionRuntimeV2 } from "@pancode/sdk/pack";
import { runPackVerb } from "../../src/cli/extensions.js";
import type { RunCommandVectorOptions, SafeCommandResult } from "../../src/core/safe-exec.js";
import { extensionInvocation } from "../../src/domains/extensions/operator-commands.js";
import { OperatorExtensions } from "../../src/domains/extensions/operator-extensions.js";
import {
	createExtensionRunService,
	type ExtensionRunCeilings,
	type ExtensionRunError,
} from "../../src/domains/extensions/services/runs.js";
import { createExtensionRequestScope } from "../../src/domains/extensions/services/scope.js";
import { installExtension } from "../../src/domains/extensions/state.js";
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

function harness(ceilings: Partial<ExtensionRunCeilings> = {}, yolo: string | null = null) {
	const tempRoot = mkdtempSync(join(tmpdir(), "run-service-"));
	const calls: Call[] = [];
	const service = createExtensionRunService({
		ceilings: { maxConcurrent: 2, autonomy: ["default"], maxCostUsd: 2, maxTimeoutSeconds: 600, ...ceilings },
		launch: { file: "node", args: ["/pancode.js"], env: { PANCODE_SELF: "1" } },
		sourceEnv: { PATH: "/bin", SECRET_TOKEN: "x" },
		envPolicy: { targets: [], passEnv: [] },
		yoloRefusal: () => yolo,
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
					emit('{"type":"run_end","outcome":"ok","exitCode":0}\n');
					setImmediate(() => finish({}));
					return;
				}
				emit('{"type":"session","id":"s1"}\nnot json\n{"type":"turn_');
				setImmediate(() => {
					emit('end","text":"hi"}\n{"type":"run_end","outcome":"ok","exitCode":0}');
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
		assert.equal(end.outcome, "ok");
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

	it("ends a run when the starting request ends", async () => {
		const h = harness();
		const scope = createExtensionRequestScope();
		const { id } = await h.service.start({ ...base, prompt: "hang" }, scope);
		await scope.end();
		assert.equal((await h.service.wait(id)).outcome, "canceled");
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
		assert.throws(() => runtime({ services: { worktrees: true } }), /worktrees.*fs\.write store/u);
		assert.throws(() => runtime({ services: { claims: true } }), /claims.*services\.verify/u);
		assert.throws(() => runtime({ cli: [{ verb: "go", command: "missing", summary: "go" }] }), /runtime\.cli/u);
		assert.throws(() => runtime({ cli: [{ verb: "Go", command: "drive", summary: "go" }] }), /runtime\.cli\[0\]\.verb/u);
		assert.deepEqual(runtime({ services: runs }).services?.runs?.autonomy, ["default"]);
	});

	it("reports runs, worktrees, long commands and verbs as envelope growth", () => {
		const base = capabilityEnvelope(runtime({}));
		const grown = capabilityEnvelope(
			runtime({
				commands: [{ name: "drive", description: "drive", long: true }],
				services: { ...runs, worktrees: true },
				permissions: { fs: { write: ["store"] } },
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
		return { text: end.outcome + " " + typeof ctx.storeDir, exitCode: end.outcome === "ok" ? 0 : 3 };
	});
	api.handle("plain", (_args, ctx) => ({ text: [typeof ctx.progress, typeof ctx.runs].join(" "), exitCode: 4 }));
};
`;

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
			'process.stdout.write(JSON.stringify({ type: "run_end", outcome: "ok", exitCode: 0 }) + "\\n");\n',
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
		assert.deepEqual(output, { text: "ok string", exitCode: 0 });
		assert.deepEqual(progress, ["starting now"]);
		const plain = await operator.invoke(extensionInvocation("driver", "plain"), "", [], signal, (text) =>
			progress.push(text),
		);
		assert.equal(plain.text, "undefined object");
		assert.equal(progress.length, 1);
	});

	it("a declared verb runs its command headlessly and exits with the command's code", async (t) => {
		await installDriver(t);
		const written: string[] = [];
		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			assert.equal(await runPackVerb("drive-plain", ["--json"]), 4);
			assert.equal(await runPackVerb("not-a-verb", []), null);
		} finally {
			process.stdout.write = write;
		}
		// The test reporter shares stdout; the verb's answer is the one line that is its JSON.
		const printed = JSON.parse(written.find((chunk) => chunk.startsWith('{"extensionId"')) ?? "null");
		assert.equal(printed.extensionId, "driver");
		assert.deepEqual(printed.output, { text: "undefined object", exitCode: 4 });
	});
});
