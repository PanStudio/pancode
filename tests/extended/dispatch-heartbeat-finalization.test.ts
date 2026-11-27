// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { withStateFileLock } from "../../src/core/state-file-lock.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { newAttemptId, newCallId } from "../../src/core/telemetry/ids.js";
import type { DispatchCompletedPayload } from "../../src/core/telemetry/live-events.js";
import { getStoredAssignment } from "../../src/domains/dispatch/assignment-store.js";
import { declaredScopeIntent } from "../../src/domains/dispatch/intent.js";
import { emitSettledDispatchEvent } from "../../src/domains/dispatch/run-finish.js";
import { settleUnfinishedRun } from "../../src/domains/dispatch/run-settlement.js";
import { openRunTelemetry } from "../../src/domains/dispatch/run-telemetry.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import type { SpawnedWorker, SpawnedWorkerResult, WorkerSpec } from "../../src/domains/dispatch/worker-spawn.js";
import { verifyRunRecordReport } from "../../src/domains/session/view-artifacts.js";
import { callSettlementFromMessage } from "../../src/domains/telemetry/call-facts.js";
import { readSettledRun, readVerifiedRun, telemetryRunDirectory } from "../../src/domains/telemetry/index.js";
import {
	isolateDispatchState,
	makeDispatchBundle,
	observedReadEvents,
	restoreDispatchState,
} from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

beforeEach(async () => isolateDispatchState());
afterEach(() => restoreDispatchState());

function controlledWorker() {
	let finish!: (result: SpawnedWorkerResult) => void;
	let aborts = 0;
	const promise = new Promise<SpawnedWorkerResult>((resolve) => {
		finish = resolve;
	});
	const worker: SpawnedWorker = {
		pid: null,
		promise,
		heartbeatAt: { current: Date.now(), monotonic: 0 },
		events: (async function* () {
			await promise;
			// A read-scoped worker that executed no tool seals failed (FX-19).
			yield { type: "pancode_tool_finish", payload: { tool: "read", outcome: "ok" } };
			yield {
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "stop",
					content: JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] }),
				},
			};
		})(),
		abort() {
			aborts += 1;
			finish({ exitCode: null, signal: "SIGTERM" });
		},
	};
	return { worker, finish: () => finish({ exitCode: 0, signal: null }), aborts: () => aborts };
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		ok(Date.now() < deadline, "dispatch did not reach the expected persistence boundary");
		await sleep(5);
	}
}

const request = {
	agentId: "scout",
	task: "Inspect the fixture input and report available evidence.",
	executionRole: "explorer" as const,
	requestOrigin: "internal" as const,
	resultContractOverride: { kind: "provenance-report" as const },
};

it("keeps parallel receipts sealed while heartbeat ticks during contended final persistence", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const stateDir = process.env.PANCODE_STATE_DIR;
	ok(stateDir);
	// Beside PanCode's state root, not in it: host checks run in the main-session
	// sandbox, which keeps PanCode's own directories read-only and the workspace writable.
	const project = join(dirname(stateDir), "project");
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, "input.txt"), "expected\n");
	execFileSync("git", ["init", "-q", "-b", "main", project]);
	const checkLog = join(project, "check-runs.log");
	const check = {
		check: "test",
		argv: [
			process.execPath,
			"-e",
			`const fs = require('node:fs'); require('node:assert/strict').equal(fs.readFileSync('input.txt', 'utf8'), 'expected\\n'); fs.appendFileSync(${JSON.stringify(checkLog)}, 'checked\\n');`,
		],
		cwd: project,
		timeoutMs: 5_000,
	};
	const intent = declaredScopeIntent({ readRoots: ["input.txt"] });
	ok(intent.ok);
	const workers = [controlledWorker(), controlledWorker()];
	let spawned = 0;
	let monotonic = 0;
	// These workers stream nothing until the batch returns, so a shared-prefix hold would wait out its cap.
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.staggerSharedPrefix = false;
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
		spawnWorker: () => {
			const controlled = workers[spawned++];
			ok(controlled);
			return controlled.worker;
		},
		heartbeatIntervalMs: 10,
		heartbeatSpec: { windowMs: 10, graceMs: 10 },
		monotonicNow: () => monotonic,
	});
	let releaseLock: (() => void) | undefined;
	let lock: Promise<void> | undefined;
	await bundle.extension.start();
	try {
		const batch = await bundle.contract.dispatchBatch(
			workers.map(() => ({ ...request, cwd: project, intent: intent.intent, resolvedVerification: [check] })),
		);
		strictEqual(spawned, 2);
		const runIds = bundle.contract.listRuns().map((run) => run.id);
		let locked = false;
		lock = withStateFileLock(join(stateDir, "runs.json"), async () => {
			locked = true;
			await new Promise<void>((resolve) => {
				releaseLock = resolve;
			});
		});
		await waitFor(() => locked);
		for (const worker of workers) worker.finish();
		await waitFor(() =>
			runIds.every((id) => readSettledRun(stateDir, id) !== null && bundle.contract.getRun(id)?.status === "completed"),
		);
		const statuses = [];
		for (const age of [0, 15, 25]) {
			monotonic = age;
			t.mock.timers.tick(10);
			statuses.push(runIds.map((id) => bundle.contract.getRun(id)?.status));
		}
		releaseLock?.();
		await lock;
		const receipts = await batch.finalPromise;
		for (const id of runIds) ok(readVerifiedRun(stateDir, id));
		strictEqual(readFileSync(checkLog, "utf8"), "checked\n", "batch check actually ran once");
		for (const receipt of receipts) {
			strictEqual(receipt.outcome, "succeeded");
			strictEqual(receipt.hostVerification?.status, "verified");
			strictEqual(receipt.hostVerification?.strategy, "batch-settled");
			const verification = verifyRunRecordReport(stateDir, receipt.runId);
			ok(verification.ok, JSON.stringify(verification));
		}
		deepStrictEqual(
			statuses,
			Array.from({ length: 3 }, () => ["completed", "completed"]),
		);
		deepStrictEqual(
			workers.map((worker) => worker.aborts()),
			[0, 0],
		);
		const owner = receipts.find((receipt) => receipt.hostVerification?.checks[0]?.evidenceRunId === undefined);
		ok(owner);
		const sibling = receipts.find((receipt) => receipt.runId !== owner.runId);
		strictEqual(sibling?.hostVerification?.checks[0]?.evidenceRunId, owner.runId);
	} finally {
		releaseLock?.();
		await lock;
		for (const worker of workers) worker.finish();
		await bundle.extension.stop?.();
	}
});

it("still marks an unfinished worker stale and terminates it when its heartbeat dies", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const controlled = controlledWorker();
	let monotonic = 0;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
		spawnWorker: () => controlled.worker,
		heartbeatIntervalMs: 10,
		heartbeatSpec: { windowMs: 10, graceMs: 10 },
		monotonicNow: () => monotonic,
	});
	await bundle.extension.start();
	try {
		const run = await bundle.contract.dispatch(request);
		monotonic = 15;
		t.mock.timers.tick(10);
		strictEqual(bundle.contract.getRun(run.runId)?.status, "stale");
		monotonic = 25;
		t.mock.timers.tick(10);
		strictEqual(controlled.aborts(), 1);
		const receipt = await run.finalPromise;
		strictEqual(receipt.outcome, "stalled");
		strictEqual(bundle.contract.getRun(run.runId)?.status, "dead");
	} finally {
		controlled.finish();
		await bundle.extension.stop?.();
	}
});

it("never rewrites runs.json for a live worker's spend; a heartbeat transition does (FL-24)", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const stateDir = process.env.PANCODE_STATE_DIR;
	ok(stateDir);
	const queue: Array<"call" | "end"> = [];
	let wake: (() => void) | null = null;
	const push = (item: "call" | "end") => {
		queue.push(item);
		wake?.();
	};
	let monotonic = 0;
	const bundle = makeDispatchBundle(dispatchStubContext(), {
		spawnWorker: (spec: WorkerSpec): SpawnedWorker => {
			let settle!: (result: SpawnedWorkerResult) => void;
			const promise = new Promise<SpawnedWorkerResult>((resolve) => {
				settle = resolve;
			});
			return {
				pid: null,
				promise,
				heartbeatAt: { current: Date.now(), monotonic: 0 },
				abort: () => push("end"),
				events: (async function* () {
					for (let call = 0; ; call += 1) {
						while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
						if (queue.shift() === "end") break;
						const context = spec.telemetryContext;
						ok(context);
						const callId = newCallId();
						const attemptId = newAttemptId();
						const message = {
							role: "assistant",
							stopReason: "toolUse",
							content: [],
							usage: { input: 1000, output: 100, totalTokens: 1100, cost: { total: 0.01 } },
						};
						const data = {
							...{ callId, attemptId, attempt: 0, roundKind: "normal" as const, toolChoice: "auto" as const },
							target: {
								...{ targetId: "fixture", runtimeId: "fixture", api: "fixture", requestedModel: "fixture" },
								reportedModel: { kind: "unknown" as const, reason: "not-observed" as const },
							},
							stages: { settle: 1 },
							...callSettlementFromMessage(message, "target-rates"),
						};
						yield {
							type: "pancode_telemetry",
							record: {
								...makeTelemetryRecord(
									"call.settled",
									data,
									{ ...context, callId, attemptId },
									{
										t: new Date().toISOString(),
										mono: call,
									},
								),
								origin: { host: "local-worker", pid: 42, birthToken: "fixture", monoEpochWallMs: 0 },
							},
						};
					}
					// A provenance report carries the observed-evidence obligation (fleet design 4.8).
					for (const event of observedReadEvents()) yield event;
					const content = JSON.stringify({ confirmedFacts: [], missingEvidence: [], nextInspections: [] });
					yield { type: "message_end", message: { role: "assistant", stopReason: "stop", content } };
					settle({ exitCode: 0, signal: null });
				})(),
			};
		},
		heartbeatIntervalMs: 10,
		heartbeatSpec: { windowMs: 1_000, graceMs: 3_600_000 },
		monotonicNow: () => monotonic,
	});
	await bundle.extension.start();
	try {
		const run = await bundle.contract.dispatch(request);
		const ledgerFile = () => readFileSync(join(stateDir, "runs.json"), "utf8");
		const rowOnDisk = () =>
			(JSON.parse(ledgerFile()) as Array<{ id: string; status: string; spend: unknown }>).find(
				(row) => row.id === run.runId,
			);
		const spendIn = (rows: ReadonlyArray<{ id: string; spend: unknown }>) =>
			JSON.stringify(rows.find((row) => row.id === run.runId)?.spend ?? null);
		const onDisk = () => spendIn(JSON.parse(ledgerFile()));
		const inMemory = () => spendIn(bundle.contract.listRuns());
		const meterMoves = async (from: string) => {
			await waitFor(() => {
				t.mock.timers.tick(10);
				return inMemory() !== from;
			});
		};
		await waitFor(() => rowOnDisk()?.status === "running");
		const running = ledgerFile();
		const unspent = inMemory();
		push("call");
		await meterMoves(unspent);
		const spent = inMemory();
		push("call");
		await meterMoves(spent);
		// Long enough for any write a spend change started to land.
		for (let tick = 0; tick < 20; tick += 1) {
			t.mock.timers.tick(10);
			await sleep(10);
		}
		strictEqual(ledgerFile(), running, "spend changes stay in memory and the run's journal");
		monotonic = 5_000;
		t.mock.timers.tick(10);
		await waitFor(() => rowOnDisk()?.status === "stale");
		strictEqual(onDisk(), inMemory(), "the transition write carries the meter's spend along");
		push("end");
		strictEqual((await run.finalPromise).outcome, "succeeded");
	} finally {
		push("end");
		await bundle.extension.stop?.();
	}
});

it("preserves session, verification and flow restrictions on post-settle live events and avoids duplicate emission", async () => {
	const stateDir = process.env.PANCODE_STATE_DIR;
	ok(stateDir);
	const context = dispatchStubContext();
	const completed: DispatchCompletedPayload[] = [];
	const failed: unknown[] = [];
	context.bus.subscribe("run.completed", (payload) => {
		completed.push(payload);
	});
	context.bus.subscribe("run.failed", (payload) => {
		failed.push(payload);
	});

	const flowRestrictions = {
		version: 1 as const,
		restrictions: [
			{
				ruleId: "secret-rule",
				policyHash: "hash-1",
				sourceRef: "env:SECRET",
				recipients: ["local-only"],
			},
		],
	};
	const ledger = openLedger({ maxRuns: 10 });
	const row = ledger.create({
		agentId: "scout",
		executionRole: "explorer",
		task: "check",
		targetId: "t1",
		wireModelId: "m1",
		runtimeId: "r1",
		runtimeKind: "http",
		sessionId: "sess-42",
		cwd: process.cwd(),
	});
	const settled = settleUnfinishedRun(row, {
		terminal: { terminalReason: "completed" },
		outcome: "succeeded",
		detail: "done",
		endedAt: new Date().toISOString(),
		processExitCode: 0,
	});
	settled.facts.flowRestrictions = flowRestrictions;
	settled.facts.hostVerification = {
		status: "verified",
		strategy: "single",
		checks: 1,
		failed: 0,
		failedOnBase: 0,
		executed: 1,
		reused: 0,
		skipped: 0,
	};
	emitSettledDispatchEvent(
		{ context },
		{
			runId: row.id,
			req: { agentId: "scout", executionRole: "explorer", task: "check", ownerSessionId: "sess-42" },
			requestOrigin: "internal",
			targetId: "t1",
			wireModelId: "m1",
			runtimeId: "r1",
			runtimeKind: "http",
			lineage: { parentRunId: null, rootRunId: row.id, depth: 0, attempt: 0 },
			hostRun: undefined,
		},
		settled.facts,
	);
	strictEqual(completed.length, 1);
	strictEqual(failed.length, 0);
	strictEqual(completed[0]?.sessionId, "sess-42");
	strictEqual(completed[0]?.hostVerification, "verified");
	deepStrictEqual(completed[0]?.flowRestrictions, flowRestrictions);

	// Throwing after run.completed is emitted must not emit a duplicate terminal event.
	const controlled = controlledWorker();
	let threwOnce = false;
	const ctx2 = dispatchStubContext();
	let runCompletedCount = 0;
	let runFailedCount = 0;
	ctx2.bus.subscribe("run.completed", () => {
		runCompletedCount += 1;
	});
	ctx2.bus.subscribe("run.failed", () => {
		runFailedCount += 1;
	});
	const bundle = makeDispatchBundle(ctx2, {
		spawnWorker: () => controlled.worker,
	});
	await bundle.extension.start();
	const originalEmit = ctx2.bus.emit.bind(ctx2.bus);
	ctx2.bus.emit = ((topic: Parameters<typeof ctx2.bus.emit>[0], payload: unknown, ...rest: unknown[]) => {
		originalEmit(topic, payload as never, ...(rest as []));
		if (topic === "run.completed" && !threwOnce) {
			threwOnce = true;
			throw new Error("subscriber failed after publish");
		}
	}) as typeof ctx2.bus.emit;
	try {
		const run = await bundle.contract.dispatch(request);
		controlled.finish();
		await rejects(run.finalPromise, /subscriber failed after publish/);
		strictEqual(runCompletedCount, 1);
		strictEqual(runFailedCount, 0);
		strictEqual(bundle.contract.getRun(run.runId)?.status, "completed");
		strictEqual(bundle.contract.getRun(run.runId)?.outcome, "succeeded");
	} finally {
		await bundle.extension.stop?.();
	}
});

it("startup recovery settles abandoned journals before persisting and reconciles canceled assignments", async () => {
	const stateDir = process.env.PANCODE_STATE_DIR;
	ok(stateDir);
	const ledger = openLedger({ maxRuns: 10 });
	// 1) Abandoned run with an open journal: start() must persist run.settled before returning.
	const abandoned = ledger.create({
		agentId: "scout",
		executionRole: "explorer",
		task: "abandoned run",
		targetId: "t1",
		wireModelId: "m1",
		runtimeId: "r1",
		runtimeKind: "http",
		sessionId: null,
		cwd: process.cwd(),
	});
	ledger.update(abandoned.id, { status: "running", pid: 999_999 });
	const abandonedJournal = await openRunTelemetry(
		{ sessionId: null, runId: abandoned.id, agent: { role: "worker", id: abandoned.id } },
		telemetryRunDirectory(stateDir, abandoned.id),
	);
	abandonedJournal.feed({ kind: "open", runId: abandoned.id, agentId: "scout" }, 1_000_000);
	await abandonedJournal.close();

	// 2) Canceled run settled in its journal whose assignment was orphaned in running.
	const canceled = ledger.create({
		agentId: "scout",
		executionRole: "explorer",
		task: "canceled run",
		targetId: "t1",
		wireModelId: "m1",
		runtimeId: "r1",
		runtimeKind: "http",
		sessionId: null,
		cwd: process.cwd(),
	});
	ledger.update(canceled.id, { status: "running", pid: 999_998 });
	const canceledJournal = await openRunTelemetry(
		{ sessionId: null, runId: canceled.id, agent: { role: "worker", id: canceled.id } },
		telemetryRunDirectory(stateDir, canceled.id),
	);
	await canceledJournal.settle(
		settleUnfinishedRun(canceled, {
			terminal: { terminalReason: "cancelled_by_operator" },
			outcome: "canceled",
			detail: "canceled by operator",
			endedAt: new Date().toISOString(),
			processExitCode: null,
		}),
	);
	await canceledJournal.close();
	await ledger.persist();

	// 3) Canceled ledger row without a journal record whose assignment was orphaned in running.
	const rowCanceled = ledger.create({
		agentId: "scout",
		executionRole: "explorer",
		task: "row-only canceled run",
		targetId: "t1",
		wireModelId: "m1",
		runtimeId: "r1",
		runtimeKind: "http",
		sessionId: null,
		cwd: process.cwd(),
	});
	ledger.update(rowCanceled.id, {
		status: "interrupted",
		outcome: "canceled",
		endedAt: new Date().toISOString(),
		exitCode: 1,
	});
	await ledger.persist();
	writeFileSync(
		join(stateDir, "assignments.json"),
		JSON.stringify(
			{
				version: 1,
				assignments: [
					{
						assignmentId: canceled.id,
						attempts: [canceled.id],
						terminalRunId: null,
						status: "running",
						processOwner: { pid: 999_998, processBirthToken: "dead-owner", acquiredAt: new Date().toISOString() },
					},
					{
						assignmentId: rowCanceled.id,
						attempts: [rowCanceled.id],
						terminalRunId: null,
						status: "running",
						processOwner: { pid: 999_997, processBirthToken: "dead-owner", acquiredAt: new Date().toISOString() },
					},
				],
			},
			null,
			2,
		),
	);

	const bundle = makeDispatchBundle(dispatchStubContext());
	await bundle.extension.start();
	try {
		const abandonedSettled = readSettledRun(stateDir, abandoned.id);
		ok(abandonedSettled !== null, "abandoned run.settled landed before start() returned");
		strictEqual(abandonedSettled.settled.outcome, "stalled");
		strictEqual(bundle.contract.getRun(abandoned.id)?.status, "dead");
		strictEqual(bundle.contract.getRun(canceled.id)?.status, "interrupted");
		strictEqual(bundle.contract.getRun(canceled.id)?.outcome, "canceled");
		strictEqual(getStoredAssignment(canceled.id)?.status, "canceled");
		strictEqual(getStoredAssignment(rowCanceled.id)?.status, "canceled");
	} finally {
		await bundle.extension.stop?.();
	}
});
