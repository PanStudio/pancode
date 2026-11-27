// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RunCommandVectorOptions, SafeCommandResult } from "../../src/core/safe-exec.js";
import {
	createExtensionRunService,
	type ExtensionRunCeilings,
	type ExtensionRunError,
} from "../../src/domains/extensions/services/runs.js";

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
		const request = new AbortController();
		const { id } = await h.service.start({ ...base, prompt: "hang" }, request.signal);
		request.abort();
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
