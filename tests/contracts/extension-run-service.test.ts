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
import type { Interview } from "@pancode/sdk/extension";
import {
	capabilityEnvelope,
	envelopeGrowth,
	parseExtensionOutputV2,
	parseExtensionRuntimeV2,
	RUNTIME_V2_LIMITS,
} from "@pancode/sdk/pack";
import { runHomes, runPackVerb } from "../../src/cli/extensions.js";
import type { RunCommandVectorOptions, SafeCommandResult } from "../../src/core/safe-exec.js";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { applyToolEnvControls, EXTENSION_RUN_DEPTH_ENV } from "../../src/core/tool-env-controls.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { extensionInvocation } from "../../src/domains/extensions/operator-commands.js";
import { OperatorExtensions } from "../../src/domains/extensions/operator-extensions.js";
import {
	createWriteRoots,
	PathGrantError,
	releaseCreatedRoots,
	resolvePathGrants,
} from "../../src/domains/extensions/path-grants.js";
import {
	assertPlainProjectDir,
	extensionProjectDir,
	prepareProjectDir,
} from "../../src/domains/extensions/runtime-sandbox.js";
import {
	createExtensionRunService,
	type ExtensionRunCeilings,
	type ExtensionRunError,
	type ExtensionRunHomes,
	type ExtensionRunServiceDeps,
} from "../../src/domains/extensions/services/runs.js";
import { createExtensionRequestScope } from "../../src/domains/extensions/services/scope.js";
import { disableExtension, installExtension } from "../../src/domains/extensions/state.js";
import {
	CLAUDE_AGENT_SDK_VERSION,
	ClaudeAgentSdkUnavailableError,
} from "../../src/domains/lifecycle/claude-sdk-install.js";
import {
	COPILOT_SDK_PACKAGE,
	COPILOT_SDK_VERSION,
	CopilotSdkUnavailableError,
	resolveCopilotSdkEntry,
} from "../../src/domains/lifecycle/copilot-sdk-install.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { foldRunDigest } from "../../src/domains/session/run-digest.js";
import { findPinnedTool, resolveVendoredBinary } from "../../src/domains/toolchain/index.js";
import { runParkedInterview } from "../../src/tools/extension-interview.js";
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
	extra: Partial<ExtensionRunServiceDeps> = {},
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
			place === "workspace"
				? { cwd: "/w", workspaceRoot: "/w" }
				: "path" in place
					? { cwd: place.path, workspaceRoot: place.path, envPolicy: { targets: [], passEnv: ["PLACE_ONLY"] } }
					: { cwd: `/t/${place.worktree}`, workspaceRoot: "/t" },
		tempRoot,
		...extra,
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

	it("keeps a run's PanCode data in a home inside a granted write root, and digests it once the run ended", async (t) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "run-home-")));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const read: Array<[string, string]> = [];
		const homes: ExtensionRunHomes = {
			writeRoots: [root],
			env: (home) => ({ PANCODE_DATA_DIR: join(home, "data") }),
			digest: (home, cwd) => {
				read.push([home, cwd]);
				const gates = { reached: [], interviews: 0, answered: 0, unscripted: 0, unanswered: 0 };
				return { sessionId: "s1", gates, refusals: { hookBlocks: 0, toolRefusals: 0 }, loopGuardBlocks: 0, tokens: null };
			},
		};
		const bare = harness();
		await assert.rejects(
			bare.service.start({ ...base, home: join(root, "a") }),
			/home needs a write root the operator granted/u,
		);
		bare.cleanup();
		const h = harness({}, null, false, { PLACE_ONLY: "p" }, { homes });
		await assert.rejects(h.service.start({ ...base, home: "rel" }), /home must be an absolute path/u);
		await assert.rejects(h.service.start({ ...base, home: tmpdir() }), /outside every path the operator granted/u);
		writeFileSync(join(root, "file"), "");
		await assert.rejects(h.service.start({ ...base, home: join(root, "file") }), /is not a directory/u);
		const project = join(root, "project");
		const home = join(root, "e1", "home");
		const { id } = await h.service.start({ ...base, cwd: { path: project }, home });
		for (const role of ["data", "state", "cache"]) assert.ok(existsSync(join(home, role)), role);
		const call = h.calls[0] as Call;
		assert.equal(call.args[call.args.indexOf("--cwd") + 1], project);
		assert.equal(call.options.env?.PANCODE_DATA_DIR, join(home, "data"));
		assert.equal(call.options.env?.PLACE_ONLY, "p", "a path place reads its own env allowlist");
		assert.equal((await h.service.wait(id)).outcome, "succeeded");
		assert.equal((await h.service.digest(id)).sessionId, "s1");
		assert.deepEqual(read, [[home, project]]);
		const plain = await h.service.start(base);
		await h.service.wait(plain.id);
		assert.equal(h.calls[1]?.options.env?.PLACE_ONLY, undefined);
		await assert.rejects(h.service.digest(plain.id), /started without a home/u);
		h.cleanup();
	});

	it("runs another extension's command only when declared, and counts it toward the run depth", async (t) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "run-command-")));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const homes: ExtensionRunHomes = {
			writeRoots: [root],
			env: (home) => ({ PANCODE_DATA_DIR: join(home, "data") }),
			digest: () => assert.fail("not read"),
		};
		const request = { extension: "desk", command: "status", timeoutSeconds: 30 };
		const undeclared = harness();
		await assert.rejects(undeclared.service.command(request), /does not declare runs\.commands/u);
		undeclared.cleanup();
		const h = harness({ commands: true }, null, false, {}, { homes });
		await assert.rejects(h.service.command({ ...request, extension: "--evil" }), /extension must be/u);
		await assert.rejects(h.service.command({ ...request, timeoutSeconds: 601 }), /timeoutSeconds/u);
		const home = join(root, "home");
		const answer = await h.service.command({ ...request, cwd: { path: root }, home });
		assert.equal(answer.exitCode, 0);
		assert.match(answer.stdout, /"type":"run_end"/u);
		const call = h.calls[0] as Call;
		assert.deepEqual(call.args, ["/pancode.js", "extensions", "run", "desk", "status", "--json"]);
		assert.equal(call.options.cwd, root);
		assert.equal(call.options.timeoutMs, 30_000);
		assert.equal(call.options.env?.PANCODE_DATA_DIR, join(home, "data"));
		assert.equal(call.options.env?.PANCODE_EXTENSION_RUN_DEPTH, "1");
		assert.equal(call.options.env?.SECRET_TOKEN, undefined);
		h.cleanup();
		const deep = harness({ commands: true }, null, false, { PANCODE_EXTENSION_RUN_DEPTH: "2" });
		await assert.rejects(deep.service.command(request), /runs\.command: .*2 extension runs deep/u);
		assert.equal(deep.calls.length, 0);
		deep.cleanup();
	});

	it("says why an answers text is no valid answers file before any run starts", async () => {
		const h = harness();
		assert.equal(await h.service.refusal({ answers: "answers: []\n" }), null);
		assert.match((await h.service.refusal({ answers: "answers: 5\n" })) ?? "", /answers/u);
		assert.match((await h.service.refusal({ answers: "x".repeat(65 * 1024) })) ?? "", /exceed 64 KiB/u);
		await assert.rejects(h.service.start({ ...base, answers: "x".repeat(65 * 1024) }), /exceed 64 KiB/u);
		assert.equal(h.calls.length, 0);
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

	it("declares a verb's path flags and runs.commands, and reports each as growth", () => {
		const verb = (paths: unknown, services: Record<string, unknown> = runs) =>
			runtime({ services, cli: [{ verb: "go", command: "drive", summary: "go", ...(paths ? { paths } : {}) }] });
		assert.deepEqual(verb([{ flag: "--out", access: "write" }]).cli?.[0]?.paths, [{ flag: "--out", access: "write" }]);
		assert.equal(verb(undefined).cli?.[0]?.paths, undefined);
		assert.throws(() => verb([{ flag: "--cwd", access: "read" }]), /cannot name a path grant/u);
		assert.throws(
			() =>
				verb([
					{ flag: "--a", access: "read" },
					{ flag: "--a", access: "write" },
				]),
			/repeats '--a'/u,
		);
		assert.throws(() => verb([{ flag: "out", access: "read" }]), /paths\[0\]\.flag/u);
		assert.throws(() => verb([{ flag: "--a", access: "exec" }]), /paths\[0\]\.access/u);
		assert.throws(() => verb(Array.from({ length: 9 }, (_, i) => ({ flag: `--f${i}`, access: "read" }))), /paths/u);
		const commands = { runs: { maxTimeoutSeconds: 600, commands: true } };
		assert.equal(verb(undefined, commands).services?.runs?.commands, true);
		const growth = envelopeGrowth(
			capabilityEnvelope(verb(undefined)),
			capabilityEnvelope(verb([{ flag: "--out", access: "write" }], commands)),
		);
		for (const expected of [/pancode go --out \(write\)/u, /installed extensions' commands/u])
			assert.ok(
				growth.some((line) => expected.test(line)),
				`${expected} in ${JSON.stringify(growth)}`,
			);
	});
});

describe("paths a verb's command line grants", () => {
	const declared = [
		{ flag: "--in", access: "read" as const },
		{ flag: "--out", access: "write" as const },
	];

	it("resolves each declared flag's value against the workspace, up to --", async (t) => {
		const env = await isolatePancodeEnv("pancode-grants-");
		t.after(env.restore);
		const ws = join(realpathSync(env.dir), "ws");
		mkdirSync(ws);
		writeFileSync(join(ws, "in.txt"), "");
		const grants = resolvePathGrants(declared, ["--in", "in.txt", "--json", "--out", "o", "--", "--in", "x"], ws);
		assert.deepEqual(
			grants.map(({ flag, access, path, exists }) => [flag, access, path, exists]),
			[
				["--in", "read", join(ws, "in.txt"), true],
				["--out", "write", join(ws, "o"), false],
			],
		);
		assert.deepEqual(resolvePathGrants(declared, ["--in"], ws), []);
		assert.deepEqual(resolvePathGrants(declared, ["--other", "/"], ws), []);
	});

	it("refuses the root, the home directory, PanCode's directories and a .pancode write root", async (t) => {
		const env = await isolatePancodeEnv("pancode-grants-");
		t.after(env.restore);
		const ws = join(realpathSync(env.dir), "ws");
		mkdirSync(join(ws, ".pancode"), { recursive: true });
		writeFileSync(join(ws, "file"), "");
		execFileSync("git", ["init", "-q"], { cwd: ws });
		mkdirSync(join(ws, "sub"));
		process.env.HOME = join(env.dir, "home");
		mkdirSync(process.env.HOME);
		const refusal = (argv: string[], from = ws): string => {
			try {
				resolvePathGrants(declared, argv, from);
			} catch (error) {
				assert.ok(error instanceof PathGrantError);
				return `${error.flag} ${error.value}: ${error.message}`;
			}
			return "granted";
		};
		assert.equal(refusal(["--in", "/"]), "--in /: cannot grant the filesystem root");
		assert.equal(refusal(["--in", process.env.HOME]), `--in ${process.env.HOME}: cannot grant the home directory itself`);
		assert.match(refusal(["--in", join(env.dir, "config", "x")]), /overlaps PanCode-managed path/u);
		assert.match(refusal(["--out", env.dir]), /overlaps PanCode-managed path/u, "a root holding PanCode's data");
		assert.equal(refusal(["--in", ".pancode"]), "granted", "the workspace's .pancode may be read");
		assert.match(refusal(["--out", ".pancode/out"]), /overlaps PanCode-managed path .*\.pancode$/u);
		assert.match(refusal(["--out", "../.pancode"], join(ws, "sub")), /overlaps PanCode-managed path/u);
		assert.equal(refusal(["--out", "file"]), "--out file: is not a directory");
	});

	it("creates an absent write root and releases it only while it is empty", async (t) => {
		const env = await isolatePancodeEnv("pancode-grants-");
		t.after(env.restore);
		const ws = join(realpathSync(env.dir), "ws");
		mkdirSync(ws);
		const grants = (out: string) => resolvePathGrants(declared, ["--out", out], ws);
		const created = createWriteRoots(grants("a/b"));
		assert.deepEqual(created, [join(ws, "a"), join(ws, "a", "b")]);
		releaseCreatedRoots(created);
		assert.equal(existsSync(join(ws, "a")), false);
		const kept = createWriteRoots(grants("c/d"));
		writeFileSync(join(ws, "c", "d", "result"), "");
		releaseCreatedRoots(kept);
		assert.ok(existsSync(join(ws, "c", "d", "result")));
		writeFileSync(join(ws, "e"), "");
		assert.throws(
			() => createWriteRoots(grants("e/f")),
			(error: unknown) => error instanceof PathGrantError && /ENOTDIR/u.test(error.message),
		);
	});
});

const driverSource = `export default (api) => {
	api.handle("drive", async (args, ctx) => {
		ctx.progress("starting " + args);
		const { id } = await ctx.runs.start({ prompt: args, target: "fixture", model: "chat", timeoutSeconds: 60 });
		const end = await ctx.runs.wait(id);
		ctx.progress("waited");
		ctx.progress("finished");
		return { text: end.outcome + " " + typeof ctx.storeDir, exitCode: end.outcome === "succeeded" ? 0 : 3 };
	});
	api.handle("plain", (args, ctx) => ({
		text: [typeof ctx.progress, typeof ctx.runs, args, ctx.argv && JSON.stringify(ctx.argv)].filter(Boolean).join(" "),
		...(ctx.argv ? { stderr: "plain: a note" } : {}),
		exitCode: 4,
	}));
	api.handle("grant", async (args, ctx) => {
		const { readFileSync, writeFileSync } = await import("node:fs");
		const named = Object.fromEntries((ctx.paths ?? []).map((grant) => [grant.flag, grant]));
		const text = readFileSync(named["--in"].path, "utf8");
		if (ctx.argv.includes("--keep")) writeFileSync(named["--out"].path + "/copy.yaml", text);
		const bad = await ctx.yaml("a: [").then(() => null, (error) => error.message);
		const paths = (ctx.paths ?? []).map((grant) => [grant.flag, grant.access]);
		return { text: JSON.stringify({ paths, doc: await ctx.yaml(text), bad: typeof bad }) };
	});
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
		assert.throws(() => extensionProjectDir(root, "../escape"), /invalid extension id/u);
		assert.throws(() => extensionProjectDir(root, "a/b"), /invalid extension id/u);
		assert.throws(() => extensionProjectDir(root, ".."), /invalid extension id/u);
		// Read-only validation allows absent directories without creating them.
		assert.doesNotThrow(() => assertPlainProjectDir(project));
		assert.equal(existsSync(join(root, ".pancode")), false);
		assert.deepEqual(prepareProjectDir(project), [
			join(root, ".pancode"),
			join(root, ".pancode", "data"),
			join(root, ".pancode", "data", "arena"),
		]);
		assert.deepEqual(prepareProjectDir(project), []);
		assert.doesNotThrow(() => assertPlainProjectDir(project));
		rmSync(join(root, ".pancode", "data"), { recursive: true });
		symlinkSync(tmpdir(), join(root, ".pancode", "data"));
		assert.throws(() => prepareProjectDir(project), /not a plain directory/u);
		assert.throws(() => assertPlainProjectDir(project), /not a plain directory/u);
	});

	it("isolates ctx.projectDir between two packs and enforces read-only sessions", async (t) => {
		const env = await isolatePancodeEnv("pancode-ext-proj-iso-");
		const previous = process.cwd();
		const cleanup: Array<() => Promise<void>> = [];
		t.after(async () => {
			for (const step of cleanup.reverse()) await step();
			process.chdir(previous);
			env.restore();
		});
		const repo = join(env.dir, "repo");
		const sub = join(repo, "sub");
		mkdirSync(sub, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: repo });
		process.env.HOME = env.dir;
		const makePack = (id: string, readWorkspace: boolean) => {
			const src = join(env.dir, `src-${id}`);
			mkdirSync(src);
			writeFileSync(
				join(src, "pancode-extension.json"),
				JSON.stringify({
					id,
					version: "1.0.0",
					description: `Pack ${id}`,
					runtime: {
						api: 2,
						entrypoint: "extension.mjs",
						state: { project: true },
						permissions: readWorkspace ? { fs: { read: ["workspace"] } } : {},
						commands: [{ name: "probe", description: "probe projectDir" }],
					},
				}),
			);
			writeFileSync(
				join(src, "extension.mjs"),
				`import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export default function (api) {
  api.handle("probe", (args, ctx) => {
    const [op, file, content] = args.split(" ");
    if (op === "write") {
      writeFileSync(join(ctx.projectDir, file), content);
      return { text: "wrote:" + ctx.projectDir };
    }
    if (op === "read") return { text: readFileSync(join(ctx.projectDir, file), "utf8") };
    if (op === "peek") {
      try {
        return { text: "leaked:" + readFileSync(file, "utf8") };
      } catch (e) {
        return { text: "blocked:" + (e && e.code ? e.code : String(e)) };
      }
    }
    return { text: String(ctx.projectDir) };
  });
}
`,
			);
			assert.ok(installExtension(src, { cwd: repo, scope: "user" }).extension?.loadable);
		};
		makePack("pack-alpha", false);
		makePack("pack-beta", true);
		process.chdir(repo);

		const writer = new OperatorExtensions({
			context: () => ({ workspace: repo, sessionId: "s1", mode: "interactive" }),
			isIdle: () => true,
		});
		cleanup.push(() => writer.dispose());
		assert.equal((await writer.reload("startup")).status, "committed");

		const wroteA = await writer.invoke(extensionInvocation("pack-alpha", "probe"), "write secret.txt alpha-secret");
		assert.match(wroteA.text, /^wrote:/);
		const alphaSecretPath = join(realpathSync(repo), ".pancode", "data", "pack-alpha", "secret.txt");
		assert.equal(readFileSync(alphaSecretPath, "utf8"), "alpha-secret");

		// Even with workspace read permission, pack-beta cannot read pack-alpha's projectDir.
		const peekB = await writer.invoke(extensionInvocation("pack-beta", "probe"), `peek ${alphaSecretPath}`);
		assert.match(peekB.text, /^blocked:/, `pack-beta unexpectedly read pack-alpha's file: ${peekB.text}`);

		// In a read-only session from a subdirectory, pack-alpha reads its own projectDir but cannot write to it.
		const reader = new OperatorExtensions({
			context: () => ({ workspace: sub, sessionId: "s2", mode: "interactive" }),
			isIdle: () => true,
			onlyId: "pack-alpha",
			readOnly: () => true,
		});
		cleanup.push(() => reader.dispose());
		assert.equal((await reader.reload("startup")).status, "committed");
		const readA = await reader.invoke(extensionInvocation("pack-alpha", "probe"), "read secret.txt");
		assert.equal(readA.text, "alpha-secret");
		await assert.rejects(
			() => reader.invoke(extensionInvocation("pack-alpha", "probe"), "write ro.txt nope"),
			/Access to this API has been restricted|EACCES|EROFS|ERR_ACCESS_DENIED/u,
		);

		// A symlink planted along .pancode/data/pack-alpha is refused even in a read-only session.
		await writer.dispose();
		await reader.dispose();
		rmSync(join(repo, ".pancode", "data", "pack-alpha"), { recursive: true });
		symlinkSync(tmpdir(), join(repo, ".pancode", "data", "pack-alpha"));
		const badReader = new OperatorExtensions({
			context: () => ({ workspace: repo, sessionId: "s3", mode: "interactive" }),
			isIdle: () => true,
			onlyId: "pack-alpha",
			readOnly: () => true,
		});
		cleanup.push(() => badReader.dispose());
		await badReader.reload("startup");
		await assert.rejects(
			() => badReader.invoke(extensionInvocation("pack-alpha", "probe"), "read secret.txt"),
			/not a plain directory/u,
		);
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
						{ name: "grant", description: "grant" },
					],
					permissions: { fs: { write: ["store"] } },
					services: { runs: { maxTimeoutSeconds: 600 } },
					cli: [
						{ verb: "drive-plain", command: "plain", summary: "a plain answer" },
						{
							verb: "drive-grant",
							command: "grant",
							summary: "reads and writes what it is granted",
							paths: [
								{ flag: "--in", access: "read" },
								{ flag: "--out", access: "write" },
							],
						},
					],
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
		// The rate limit may fold "waited" into "finished"; the last line still arrives before the answer.
		assert.equal(progress[0], "starting now");
		assert.equal(progress.at(-1), "finished");
		const heard = progress.length;
		const plain = await operator.invoke(extensionInvocation("driver", "plain"), "", [], signal, (text) =>
			progress.push(text),
		);
		assert.equal(plain.text, "undefined object");
		assert.equal(progress.length, heard);
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

	it("a verb reads and writes only the paths its command line grants, and parses YAML in the host", async (t) => {
		const { cwd } = await installDriver(t);
		writeFileSync(join(cwd, "in.yaml"), "a: [1, 2]\n");
		const out: string[] = [];
		const err: string[] = [];
		const write = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
		process.stdout.write = ((chunk: string) => out.push(String(chunk)) > 0) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string) => err.push(String(chunk)) > 0) as typeof process.stderr.write;
		try {
			assert.equal(await runPackVerb("drive-grant", ["--in", "in.yaml", "--out", "made/out", "--keep"]), 0);
			assert.equal(await runPackVerb("drive-grant", ["--in", "in.yaml", "--out", "released"]), 0);
			assert.equal(await runPackVerb("drive-grant", ["--in", "in.yaml", "--out", ".pancode/x"]), 2);
		} finally {
			process.stdout.write = write.out;
			process.stderr.write = write.err;
		}
		const answers = out.filter((chunk) => chunk.startsWith('{"paths"'));
		assert.deepEqual(JSON.parse(answers[0] ?? "null"), {
			paths: [
				["--in", "read"],
				["--out", "write"],
			],
			doc: { a: [1, 2] },
			bad: "string",
		});
		assert.equal(readFileSync(join(cwd, "made", "out", "copy.yaml"), "utf8"), "a: [1, 2]\n");
		assert.equal(existsSync(join(cwd, "released")), false, "an unused write root the runner made is removed");
		assert.match(
			err.join(""),
			/pancode drive-grant: --out \.pancode\/x: overlaps PanCode-managed path .*\nsee: pancode drive-grant --help\n/u,
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

describe("a run home's digest", () => {
	it("counts gates, extension refusals and loop-guard blocks from the ledger and journal", () => {
		const digest = foldRunDigest(
			"s1",
			[
				toolResult("gateway", {
					capability: "extension_wtfp__gate",
					interview: { outcome: "done", checkpoints: ["plan-introduction"] },
				}),
				toolResult(
					"extension_wtfp__gate",
					{ interview: { outcome: "cancelled", reason: "unscripted", checkpoints: ["results-acceptance"] } },
					true,
				),
				toolResult("gateway", { capability: "extension_wtfp__record" }, true),
				// The shape an extension tool's error reaches the ledger in through the gateway: owner stamped, details empty.
				{
					...toolResult("gateway", {}, true),
					payload: { toolName: "gateway", isError: true, owner: { kind: "extension", id: "wtfp" }, result: { details: {} } },
				} as SessionEntry,
				toolResult("gateway", { capability: "data" }, true),
			],
			[
				journalRecord("hook.ran", { origin: "extension", hook: "before_tool", effectKinds: ["block_tool"] }),
				journalRecord("hook.ran", { origin: "user", hook: "before_tool", effectKinds: ["block_tool"] }),
				journalRecord("middleware.fired", { ruleId: "guard.loop", effects: ["block_tool"], hook: "before_tool" }),
				journalRecord("middleware.fired", { ruleId: "guard.loop", effects: ["annotate_tool_result"], hook: "after_tool" }),
			],
			null,
		);
		assert.deepEqual(digest.gates, {
			reached: ["plan-introduction", "results-acceptance"],
			interviews: 2,
			answered: 1,
			unscripted: 1,
			unanswered: 0,
		});
		assert.deepEqual(digest.refusals, { hookBlocks: 1, toolRefusals: 2 });
		assert.equal(digest.loopGuardBlocks, 1);
		assert.equal(digest.tokens, null);
	});

	it("a parked interview names the checkpoints it put to the author", async () => {
		const interview: Interview = {
			id: "gate",
			title: "Gates",
			step: {
				key: "gate.one",
				questions: [
					{
						id: "choice",
						label: "Approve the plan?",
						kind: "single",
						checkpoint: "plan-introduction",
						options: [{ value: "approve", label: "Approve" }],
					},
				],
			},
		};
		const parked = await runParkedInterview(
			{ ask: async () => ({ answers: [{ question: "Approve the plan?", answer: "Approve", options: ["Approve"] }] }) },
			interview,
			{ extensionId: "desk", title: "Desk" },
			async () => ({ done: true, text: "sealed" }),
		);
		assert.deepEqual(parked.checkpoints, ["plan-introduction"]);
	});

	it("a run home reads the operator's installed SDK and vendored tools, and a missing SDK names the operator's directory", async (t) => {
		const env = await isolatePancodeEnv("pancode-run-home-components-");
		t.after(env.restore);
		delete process.env.PANCODE_CLAUDE_SDK_DIR;
		process.env.PANCODE_DATA_DIR = join(env.dir, "operator-data");
		resetXdgCache();
		const operatorComponents = join(env.dir, "operator-data", "components");
		const sdk = join(operatorComponents, "copilot-sdk", COPILOT_SDK_VERSION, "node_modules", COPILOT_SDK_PACKAGE);
		mkdirSync(sdk, { recursive: true });
		writeFileSync(
			join(sdk, "package.json"),
			JSON.stringify({ name: COPILOT_SDK_PACKAGE, version: COPILOT_SDK_VERSION, type: "module", exports: "./sdk.mjs" }),
		);
		writeFileSync(join(sdk, "sdk.mjs"), "export class CopilotClient {}\n");
		const operatorTools = join(env.dir, "operator-data", "tools");
		const herdr = findPinnedTool("herdr");
		assert.ok(herdr !== null);
		const herdrBinary = join(operatorTools, herdr.id, herdr.version, herdr.primaryBinary);
		mkdirSync(join(herdrBinary, ".."), { recursive: true });
		writeFileSync(herdrBinary, "#!/bin/sh\n");
		const config = process.env.PANCODE_CONFIG_DIR;
		const home = join(env.dir, "out", "01-luna", "home");
		Object.assign(process.env, (await runHomes()).env(home));
		resetXdgCache();
		assert.equal(process.env.PANCODE_CONFIG_DIR, config, "a run home keeps the operator's config");

		const entry = resolveCopilotSdkEntry();
		assert.ok(entry !== null, "the run resolves the operator's copilot-sdk");
		assert.equal(realpathSync(entry), realpathSync(join(sdk, "sdk.mjs")));
		// A vendored tool the operator installed resolves from their toolchain root, not the home's empty one.
		assert.equal(resolveVendoredBinary("herdr")?.binaryPath, herdrBinary);

		// Without the component, the install hint names the operator's directory, never the run's home.
		for (const [error, dir] of [
			[new CopilotSdkUnavailableError(), join(operatorComponents, "copilot-sdk", COPILOT_SDK_VERSION)],
			[new ClaudeAgentSdkUnavailableError(), join(operatorComponents, "claude-agent-sdk", CLAUDE_AGENT_SDK_VERSION)],
		] as const) {
			assert.ok(error.message.includes(`separate component at ${dir};`), error.message);
			assert.ok(!error.message.includes(home), error.message);
		}
		assert.deepEqual(readdirSync(operatorComponents), ["copilot-sdk"]);
		assert.equal(existsSync(join(home, "data", "components")), false);
		assert.equal(existsSync(join(home, "data", "tools")), false);
	});
});

function toolResult(toolName: string, details: Record<string, unknown>, isError = false): SessionEntry {
	return {
		kind: "message",
		role: "tool_result",
		turnId: `t-${Math.random()}`,
		parentTurnId: null,
		timestamp: "2026-11-16T00:00:00.000Z",
		payload: { toolCallId: "c", toolName, isError, result: { content: [], details } },
	} as SessionEntry;
}

function journalRecord(k: string, data: Record<string, unknown>): TelemetryRecord {
	return { k, t: "2026-11-16T00:00:00.000Z", ctx: { sessionId: "s1" }, data } as unknown as TelemetryRecord;
}
