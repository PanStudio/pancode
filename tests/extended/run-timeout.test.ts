// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { doesNotMatch, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { runStatusForOutcome } from "../../src/domains/dispatch/outcome.js";
import { type HeadlessScratch, headlessScratch, runCli } from "../harness/headless-run.js";
import {
	closeServer,
	editSettingsFile,
	section,
	seedOpenAICompatToolOrchestrator,
} from "../harness/openai-compat-fixture.js";
import { readRunJournal } from "../harness/run-journal.js";

const RUN_DEADLINE_HOLD = new URL("../fixtures/run-deadline-hold.mjs", import.meta.url).href;

type Step = { kind: "tool"; name: string; arguments: Record<string, unknown> } | { kind: "stall" } | { kind: "text" };

/**
 * An OpenAI-compatible provider that walks `steps` by the number of tool
 * results already in the conversation. A `stall` step sends the stream headers,
 * writes the `stalled` file and then nothing, holding the response open until
 * the server closes; no timer is involved, so the test process is never kept
 * alive by it.
 */
async function scriptedProvider(
	steps: ReadonlyArray<Step>,
	stalled: string,
): Promise<{ server: Server; url: string; streams: number }> {
	const state = { streams: 0 };
	const server = createServer(async (request: IncomingMessage, response) => {
		if (request.method === "GET" && request.url === "/v1/models") {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
			return;
		}
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.statusCode = 404;
			response.end();
			return;
		}
		let body = "";
		request.setEncoding("utf8");
		for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body) as { stream?: boolean; messages?: Array<{ role?: string }> };
		if (payload.stream === false) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "probe" } }] }));
			return;
		}
		state.streams += 1;
		const step = steps[(payload.messages ?? []).filter((message) => message.role === "tool").length] ?? {
			kind: "text",
		};
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (step.kind === "stall") {
			response.flushHeaders();
			writeFileSync(stalled, "");
			return;
		}
		const delta =
			step.kind === "tool"
				? {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `call-${step.name}`,
								type: "function",
								function: { name: step.name, arguments: JSON.stringify(step.arguments) },
							},
						],
					}
				: { role: "assistant", content: "finished" };
		response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
		response.write(
			`data: ${JSON.stringify({
				choices: [{ index: 0, delta: {}, finish_reason: step.kind === "tool" ? "tool_calls" : "stop" }],
				usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
			})}\n\n`,
		);
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		server,
		url,
		get streams() {
			return state.streams;
		},
	};
}

describe("pancode run --timeout", () => {
	const servers: Server[] = [];
	const scratches: HeadlessScratch[] = [];
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => closeServer(server)));
		for (const scratch of scratches.splice(0)) scratch.cleanup();
	});

	/**
	 * `holdDeadlineUntil` names a file under the scratch root, `model-stalled` or `project/started`, that the --timeout
	 * deadline waits for (tests/fixtures/run-deadline-hold.mjs): the budget counts from process start, and boot on a
	 * loaded host can spend it before the run reaches the state the row times out.
	 */
	async function headlessTurn(
		steps: ReadonlyArray<Step>,
		autonomy: string,
		flags: ReadonlyArray<string>,
		options: { sandbox?: "off"; holdDeadlineUntil?: string } = {},
	) {
		const { sandbox, holdDeadlineUntil } = options;
		const scratch = headlessScratch("pancode-run-timeout-");
		scratches.push(scratch);
		const provider = await scriptedProvider(steps, join(scratch.root, "model-stalled"));
		servers.push(provider.server);
		seedOpenAICompatToolOrchestrator(scratch.configDir, provider.url, autonomy);
		if (sandbox !== undefined) {
			editSettingsFile(join(scratch.configDir, "settings.yaml"), (settings) => {
				section(settings, "safety").sandbox = sandbox;
			});
		}
		const project = join(scratch.root, "project");
		mkdirSync(project);
		const signal = holdDeadlineUntil === undefined ? undefined : join(scratch.root, holdDeadlineUntil);
		const turn = await runCli(
			["--no-context-files", "--no-skills", "run", "--autonomy", autonomy, ...flags, "Apply the change."],
			{
				env: signal === undefined ? scratch.env : { ...scratch.env, RUN_DEADLINE_SIGNAL: signal },
				cwd: project,
				timeoutMs: 60_000,
				...(signal === undefined ? {} : { node: ["--import", RUN_DEADLINE_HOLD] }),
			},
		);
		if (signal !== undefined) ok(existsSync(`${signal}.held`), "the preload must hold the run deadline");
		return { turn, scratch, provider };
	}

	it("ends a stalled run with exit 124 and a sealed timed_out receipt, not a no-op under --fail-on-noop", async () => {
		// Hidden shell content asks in default for an uncontained shell, which makes a
		// headless run a no-op; the model then stalls, and the timeout is what ends it.
		// The sandbox is off so the ask holds on every host: a bwrap-contained shell
		// runs the command instead (287a523c0) and the run would not be a no-op.
		const { turn, scratch, provider } = await headlessTurn(
			[
				{
					kind: "tool",
					name: "bash",
					arguments: { command: "python3 -c \"print('hidden')\"" },
				},
				{ kind: "stall" },
			],
			"default",
			["--timeout", "2", "--fail-on-noop"],
			{ sandbox: "off", holdDeadlineUntil: "model-stalled" },
		);
		strictEqual(turn.code, 124, turn.stderr);
		ok(provider.streams >= 2, "the run must have been waiting on the model after the hidden ask");
		ok(turn.elapsedMs >= 2_000, `exited before the limit: ${turn.elapsedMs}ms`);
		match(turn.stderr, /timed out after 2s \(--timeout\)/);
		strictEqual(turn.stderr.split("\n").filter((line) => line.includes("--timeout")).length, 1);
		const runJournal = readRunJournal(scratch.stateDir);
		ok(runJournal);
		const envelope = [...runJournal.envelopes.values()][0];
		ok(envelope);
		strictEqual(envelope.outcome, "timed_out");
		strictEqual(envelope.exitCode, 124);
		// The status a dispatched worker's timed_out receipt seals with, which
		// orphan recovery re-derives from the outcome when it re-verifies.
		strictEqual(envelope.status, "failed");
		ok(envelope.outcome);
		strictEqual(envelope.status, runStatusForOutcome(envelope.outcome));
		match(envelope.outcomeDetail ?? "", /timed out after 2s \(--timeout\)/);
		notStrictEqual(envelope.outcomeDetail, "noop");
	});

	it("leaves a run that finishes inside the limit untouched and does not hold the process open", async () => {
		// runCli kills a child that outlives 60s, so exit 0 is the proof the 300s timer held nothing open.
		const { turn, scratch } = await headlessTurn([], "default", ["--timeout", "300"]);
		strictEqual(turn.code, 0, turn.stderr);
		const runJournal = readRunJournal(scratch.stateDir);
		ok(runJournal);
		const envelope = [...runJournal.envelopes.values()][0];
		ok(envelope);
		strictEqual(envelope.outcome, "succeeded");
		strictEqual(envelope.exitCode, 0);
	});

	it("disarms the deadline on an early usage-error return while the process is held open", async () => {
		// The CLI sets process.exitCode and lets the event loop drain. A preloaded
		// module holds the loop open past the deadline, standing in for any
		// lingering handle, so an armed timer would fire and exit 124 over the 2.
		const scratch = headlessScratch("pancode-run-timeout-early-");
		scratches.push(scratch);
		const hold = join(scratch.root, "hold-open.mjs");
		writeFileSync(hold, "setTimeout(() => {}, 2500);\n");
		const env = {
			...scratch.env,
			NODE_OPTIONS: `${scratch.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(hold).href}`.trim(),
		};
		const turn = await runCli(["run", "--timeout", "1", "--cwd", join(scratch.root, "nonexistent"), "task"], {
			env,
			cwd: scratch.root,
		});
		strictEqual(turn.code, 2, turn.stderr);
		match(turn.stderr, /--cwd is not a directory this process can enter/);
		doesNotMatch(turn.stderr, /timed out after 1s \(--timeout\)/);
		ok(turn.elapsedMs >= 2000, `the hold must keep the process alive past the deadline (${turn.elapsedMs}ms)`);
	});

	it("treats a missing, non-positive, or non-numeric value as a usage error", async () => {
		const scratch = headlessScratch("pancode-run-timeout-usage-");
		scratches.push(scratch);
		for (const value of ["0", "-3", "abc", "Infinity"]) {
			const turn = await runCli(["run", "--timeout", value, "task"], { env: scratch.env, cwd: scratch.root });
			strictEqual(turn.code, 2, `${value}: ${turn.stderr}`);
			match(turn.stderr, /--timeout: (duration must be greater than zero|expected a duration such as)/);
		}
		const missing = await runCli(["run", "--timeout"], { env: scratch.env, cwd: scratch.root });
		strictEqual(missing.code, 2, missing.stderr);
		match(missing.stderr, /--timeout requires a value/);
	});

	it("runs each --verify check after the turn and credits the agent's own run of it after its edit", async () => {
		const { turn } = await headlessTurn(
			[
				{ kind: "tool", name: "write", arguments: { path: "calc.txt", content: "5\n" } },
				{ kind: "tool", name: "bash", arguments: { command: "grep -qx 5 calc.txt && echo OK" } },
			],
			"default",
			[
				"--output-format",
				"stream-json",
				"--verify",
				"grep -qx 5 calc.txt",
				"--verify",
				"exit 3",
				"--verify-timeout",
				"30",
			],
		);
		strictEqual(turn.code, 0, turn.stderr);
		doesNotMatch(turn.stdout, /ran no check/);
		// The stream's verify frame: each check as the run ran it after the turn, in flag order.
		const frame = turn.stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type?: string; checks?: Array<Record<string, unknown>> })
			.find((event) => event.type === "verify");
		ok(frame, turn.stdout);
		const [accepted, failing] = frame.checks ?? [];
		ok(typeof accepted?.durationMs === "number");
		strictEqual(
			JSON.stringify({ ...accepted, durationMs: 0 }),
			JSON.stringify({
				id: "run-acceptance",
				command: "grep -qx 5 calc.txt",
				exitCode: 0,
				passed: true,
				durationMs: 0,
				timedOut: false,
				ranAfterLastEdit: true,
			}),
		);
		strictEqual(failing?.id, "run-acceptance-2");
		strictEqual(failing?.exitCode, 3);
		strictEqual(failing?.passed, false);
		strictEqual(failing?.ranAfterLastEdit, false);
	});

	it("--fail-on-verify turns a failed check into exit 1 with cause verify_failed under v2", async () => {
		const { turn } = await headlessTurn(
			[{ kind: "tool", name: "write", arguments: { path: "calc.txt", content: "5\n" } }],
			"default",
			["--output-format", "json", "--verify", "grep -qx 5 calc.txt", "--verify", "exit 3", "--fail-on-verify"],
		);
		strictEqual(turn.code, 1, turn.stderr);
		const envelope = JSON.parse(turn.stdout) as { causes?: Array<{ code?: string; checks?: string[] }> };
		strictEqual(envelope.causes?.[0]?.code, "verify_failed");
		strictEqual(JSON.stringify(envelope.causes?.[0]?.checks), JSON.stringify(["exit 3"]));
	});

	it("a deadline that expires while a --verify check runs aborts it: exit 124, check skipped for the deadline", async () => {
		// The marker proves the check started before the deadline, so this row exercises expiry during a check,
		// not the expiry before one that already skipped it (CLI-P6).
		const { turn, scratch } = await headlessTurn(
			[],
			"default",
			[
				"--output-format",
				"json",
				"--verify",
				"touch started && sleep 30 && touch waited",
				"--timeout",
				"4",
				"--fail-on-verify",
			],
			{ holdDeadlineUntil: "project/started" },
		);
		strictEqual(turn.code, 124, turn.stderr);
		ok(!existsSync(join(scratch.root, "project", "waited")), "the check must be cut off, not waited out");
		ok(existsSync(join(scratch.root, "project", "started")), "the check must have started before the deadline");
		const envelope = JSON.parse(turn.stdout) as {
			causes?: Array<{ code?: string }>;
			verify?: { checks?: Array<{ status?: string; reason?: string }> };
		};
		strictEqual(JSON.stringify(envelope.causes?.map((cause) => cause.code)), JSON.stringify(["deadline"]));
		const [check] = envelope.verify?.checks ?? [];
		strictEqual(check?.status, "skipped");
		strictEqual(check?.reason, "deadline");
	});

	// Under stream-json the verify frame lists the checks that finished; it still precedes run_end (CLI-P8).
	for (const cut of [
		{
			by: "a deadline",
			code: 124,
			check: "touch started && sleep 30",
			flags: ["--timeout", "4"],
			holdDeadlineUntil: "project/started",
		},
		{ by: "a SIGTERM", code: 143, check: "touch started && kill -TERM $PPID && sleep 30", flags: [] },
	]) {
		it(`stream-json: ${cut.by} during a --verify check writes the verify frame before run_end, nothing after`, async () => {
			const { turn, scratch } = await headlessTurn(
				[],
				"default",
				["--output-format", "stream-json", "--verify", "true", "--verify", cut.check, ...cut.flags],
				cut.holdDeadlineUntil === undefined ? {} : { holdDeadlineUntil: cut.holdDeadlineUntil },
			);
			strictEqual(turn.code, cut.code, turn.stderr);
			ok(existsSync(join(scratch.root, "project", "started")), "the second check must have started");
			const frames = turn.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type?: string; checks?: Array<{ command?: string; passed?: boolean }> });
			const types = frames.map((frame) => frame.type);
			strictEqual(types.at(-1), "run_end", turn.stdout);
			strictEqual(types.filter((type) => type === "run_end").length, 1, turn.stdout);
			const verify = frames.filter((frame) => frame.type === "verify");
			strictEqual(verify.length, 1, turn.stdout);
			ok(types.indexOf("verify") < types.indexOf("run_end"), turn.stdout);
			strictEqual(
				JSON.stringify(verify[0]?.checks?.map((check) => [check.command, check.passed])),
				JSON.stringify([["true", true]]),
			);
			// The seal keeps the check that finished and marks only the cut-off one as stopped by the shutdown.
			const record = readRunJournal(scratch.stateDir)?.runs[0];
			const summary = record?.settled.hostVerification;
			strictEqual(
				JSON.stringify([summary?.status, summary?.executed, summary?.skipped]),
				JSON.stringify(["skipped", 1, 1]),
			);
			const host = record?.result?.state === "resolved" ? record.result.value.hostVerification : undefined;
			strictEqual(
				JSON.stringify(host?.checks.map((check) => [check.check, check.exitCode, check.notRun ?? null])),
				JSON.stringify([
					["run-acceptance", 0, null],
					["run-acceptance-2", 1, "shutdown"],
				]),
			);
		});
	}
});
