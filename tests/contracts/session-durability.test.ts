// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import { newAttemptId, newCallId } from "../../src/core/telemetry/ids.js";
import { pancodeStateDir } from "../../src/core/xdg.js";
import {
	deferAppend,
	dropDeferredWrite,
	flushDeferredWrite,
	flushDeferredWrites,
} from "../../src/domains/dispatch/deferred-writes.js";
import { recoverAbandonedRuns } from "../../src/domains/dispatch/orphan-recovery.js";
import { appendRunFeed, flushRunFeed, readRunFeed, runFeedPath } from "../../src/domains/dispatch/run-feed.js";
import {
	openRunTelemetry,
	sealTerminalRunJournal,
	settleOrphanedRunJournal,
} from "../../src/domains/dispatch/run-telemetry.js";
import { openLedger } from "../../src/domains/dispatch/state.js";
import {
	appendTurn,
	persistSessionMeta,
	readCurrentEntries,
	resumeSessionState,
	startSession,
} from "../../src/domains/session/manager.js";
import {
	reconcilePendingProtectedArtifacts,
	stagePendingProtectedArtifact,
} from "../../src/domains/session/protected-artifact-journal.js";
import { callSettlementFromMessage } from "../../src/domains/telemetry/call-facts.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import {
	telemetryBundlePath,
	telemetryJournalPath,
	telemetryRunsDirectory,
} from "../../src/domains/telemetry/paths.js";
import { createSession, readSessionFileEntries, resumeSession, sessionPaths } from "../../src/engine/session.js";
import { type IsolatedPancodeEnv, isolatePancodeEnv } from "../harness/scratch-env.js";

describe("session durability boundary", () => {
	let scratch: IsolatedPancodeEnv;

	beforeEach(async () => {
		scratch = await isolatePancodeEnv("pancode-session-contract-");
	});

	afterEach(() => scratch.restore());

	it("makes atomic appends immediately visible and recovers a torn tail on reopen", () => {
		const { meta, writer } = createSession({ cwd: scratch.dir });
		writer.append({
			id: "t1",
			parentId: null,
			at: "2026-06-11T00:00:00.000Z",
			kind: "user",
			payload: { text: "before crash" },
		});
		const path = sessionPaths(meta).current;
		strictEqual(readSessionFileEntries(path).length, 2);
		writeFileSync(path, `${readFileSync(path, "utf8")}{"kind":"mess`, "utf8");

		const resumed = resumeSession(meta.id);
		resumed.writer.append({
			id: "t2",
			parentId: "t1",
			at: "2026-06-11T00:00:01.000Z",
			kind: "user",
			payload: { text: "after crash" },
		});
		const warnings: string[] = [];
		const entries = readSessionFileEntries(path, { onWarning: (warning) => warnings.push(warning.message) });
		strictEqual(warnings.length, 1);
		strictEqual((entries[1] as { turnId?: string }).turnId, "t1");
		strictEqual((entries[2] as { turnId?: string }).turnId, "t2");
	});

	it("writes canonical session provenance", async () => {
		const { meta, writer } = createSession({ cwd: scratch.dir });
		const metaPath = sessionPaths(meta).meta;
		await writer.close();
		const canonical = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
		strictEqual(typeof canonical.pancodeVersion, "string");
	});

	it("writes canonical protected-artifact seals and reconciles them", () => {
		const handle = stagePendingProtectedArtifact("protection-session", {
			kind: "protect",
			artifact: {
				path: join(scratch.dir, "REPORT.md"),
				protectedAt: "2026-09-01T00:00:00.000Z",
				reason: "verified",
				source: "validation",
				validationCommand: "npm test",
				validationExitCode: 0,
			},
			toolName: "verify",
			turnId: "turn-1",
		});
		const record = JSON.parse(readFileSync(handle.path, "utf8")) as typeof handle.record;
		const payload = (contract: string) => ({
			contract,
			version: record.version,
			id: record.id,
			sessionId: record.sessionId,
			artifact: {
				path: record.artifact.path,
				protectedAt: record.artifact.protectedAt,
				reason: record.artifact.reason,
				source: record.artifact.source,
				validationCommand: record.artifact.validationCommand,
				validationExitCode: record.artifact.validationExitCode,
			},
			context: {
				parentTurnId: record.context.parentTurnId,
				toolName: record.context.toolName,
			},
			createdAt: record.createdAt,
		});
		const digest = (contract: string): string =>
			createHash("sha256")
				.update(JSON.stringify(payload(contract)), "utf8")
				.digest("hex");
		strictEqual(record.integrity.digest, digest("pancode.protectedArtifact.pending"));

		let appended = 0;
		const reconciled = reconcilePendingProtectedArtifacts({
			current: () => ({ id: record.sessionId }),
			appendEntry: () => {
				appended += 1;
				return {};
			},
			flushAppends: () => {},
		} as never);
		strictEqual(reconciled, 1);
		strictEqual(appended, 1);
		strictEqual(existsSync(handle.path), false);
	});

	it("persists a selected branch across close and resumes appends from that leaf", async () => {
		const first = startSession({ cwd: scratch.dir });
		const u1 = appendTurn(first, { id: "u1", parentId: null, kind: "user", payload: { text: "u1" } });
		const a1 = appendTurn(first, { id: "a1", parentId: u1.id, kind: "assistant", payload: { text: "a1" } });
		appendTurn(first, { id: "u2", parentId: a1.id, kind: "user", payload: { text: "abandoned" } });
		first.meta.pinnedLeafTurnId = a1.id;
		persistSessionMeta(first);
		await first.writer.close();

		const reopened = resumeSessionState(first.meta.id).state;
		strictEqual(reopened.meta.pinnedLeafTurnId, a1.id);
		const alternate = appendTurn(reopened, {
			id: "u3",
			parentId: a1.id,
			kind: "user",
			payload: { text: "alternate" },
		});
		strictEqual(alternate.parentId, a1.id);
		await reopened.writer.close();
	});

	it("indexes a long ledger without holding its bytes and still catches in-place prefix edits", async () => {
		const state = startSession({ cwd: scratch.dir });
		const filler = "x".repeat(1500);
		let parentId: string | null = null;
		for (let turn = 0; turn < 200; turn++) {
			parentId = appendTurn(state, {
				id: `t${turn}`,
				parentId,
				kind: "user",
				payload: { text: `turn ${turn} ${filler}` },
			}).id;
			readCurrentEntries(state);
		}
		const path = sessionPaths(state.meta).current;
		ok(statSync(path).size > 250_000);
		// Every ArrayBuffer reachable from the index: a byte copy of the ledger would pin at least its size.
		const buffers = new Set<ArrayBufferLike>();
		const seen = new Set<object>();
		const stack: unknown[] = [state.entriesIndex];
		while (stack.length > 0) {
			const value = stack.pop();
			if (typeof value !== "object" || value === null || seen.has(value)) continue;
			seen.add(value);
			if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
			else if (value instanceof ArrayBuffer) buffers.add(value);
			else for (const key of Reflect.ownKeys(value)) stack.push((value as Record<PropertyKey, unknown>)[key]);
		}
		strictEqual(
			[...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0),
			0,
		);

		// External growth that keeps the prefix folds only the new line.
		const line = (turnId: string, text: string) =>
			`${JSON.stringify({ kind: "message", turnId, parentTurnId: parentId, timestamp: "2026-06-11T00:00:00.000Z", role: "user", payload: { text } })}\n`;
		const before = readCurrentEntries(state);
		appendFileSync(path, line("external", "appended"));
		const appended = readCurrentEntries(state);
		strictEqual(appended.length, before.length + 1);
		strictEqual(appended[0], before[0]);
		// Same inode, grown, first entry rewritten: the index must reparse instead of trusting the old prefix.
		writeFileSync(path, `${readFileSync(path, "utf8").replace("turn 0 ", "TURN 0 ")}${line("grown", "after edit")}`);
		const rewritten = readCurrentEntries(state);
		strictEqual(rewritten.length, appended.length + 1);
		ok(JSON.stringify(rewritten[0]).includes("TURN 0 "));
		await state.writer.close();
	});

	it("keeps the current session open when a resume target cannot be opened", async () => {
		const current = startSession({ cwd: scratch.dir });
		appendTurn(current, { id: "current", parentId: null, kind: "user", payload: { text: "current" } });
		const broken = startSession({ cwd: scratch.dir });
		await broken.writer.close();
		const brokenMeta = sessionPaths(broken.meta).meta;
		const document = JSON.parse(readFileSync(brokenMeta, "utf8")) as Record<string, unknown>;
		document.sessionFormatVersion = 2;
		writeFileSync(brokenMeta, JSON.stringify(document));

		throws(() => resumeSessionState(broken.meta.id), /unsupported format version/u);
		appendTurn(current, {
			id: "still-current",
			parentId: "current",
			kind: "user",
			payload: { text: "still writable" },
		});
		const entries = readSessionFileEntries(sessionPaths(current.meta).current);
		strictEqual((entries.at(-1) as { turnId?: string }).turnId, "still-current");
		strictEqual(current.meta.endedAt, null);
		await current.writer.close();
	});

	it("closes an abandoned run deterministically during restart recovery", async () => {
		const ledger = openLedger({ maxRuns: 10 });
		const run = ledger.create({
			agentId: "coder",
			executionRole: "builder",
			task: "interrupted work",
			targetId: "local",
			wireModelId: "model",
			runtimeId: "openai",
			runtimeKind: "http",
			sessionId: null,
			cwd: scratch.dir,
		});
		ledger.update(run.id, { status: "running", pid: 999_999, heartbeatAt: run.startedAt });
		await ledger.persist();
		const directory = join(telemetryRunsDirectory(pancodeStateDir()), run.id);
		const journal = await openRunTelemetry(
			{ sessionId: null, runId: run.id, agent: { role: "worker", id: run.id } },
			directory,
		);
		journal.feed({ kind: "open", runId: run.id, agentId: "coder" }, 1_000_000);
		await journal.close();

		const reopened = openLedger({ maxRuns: 10 });
		const recovered = recoverAbandonedRuns(reopened);
		strictEqual(recovered.abandoned, 1);
		strictEqual(reopened.get(run.id)?.status, "dead");
		strictEqual(reopened.get(run.id)?.outcome, "stalled");
		ok(reopened.get(run.id)?.endedAt !== null);
		// The run's journal gets the settlement its dead host never wrote, so no reader waits on it.
		const [unsettled] = recovered.unsettled;
		strictEqual(unsettled?.runId, run.id);
		if (unsettled) await settleOrphanedRunJournal(directory, unsettled.settlement);
		const settled = (await readCallJournal(directory)).records.filter(({ record }) => record.k === "run.settled");
		strictEqual(settled.length, 1);
		strictEqual((settled[0]?.record.data as { terminalReason?: string }).terminalReason, "stalled");
	});

	it("gives a terminal run whose run.settled never landed the correcting record its row states, heard once on disk", async () => {
		const ledger = openLedger({ maxRuns: 10 });
		const run = ledger.create({
			agentId: "coder",
			executionRole: "builder",
			task: "finalization failed",
			targetId: "local",
			wireModelId: "model",
			runtimeId: "openai",
			runtimeKind: "http",
			sessionId: null,
			cwd: scratch.dir,
		});
		ledger.update(run.id, { status: "failed", outcome: "failed", endedAt: new Date().toISOString() });
		await ledger.persist();
		const directory = join(telemetryRunsDirectory(pancodeStateDir()), run.id);
		const journal = await openRunTelemetry(
			{ sessionId: null, runId: run.id, agent: { role: "worker", id: run.id } },
			directory,
		);
		journal.feed({ kind: "open", runId: run.id, agentId: "coder" }, 1_000_000);
		await journal.close();

		const recovered = recoverAbandonedRuns(openLedger({ maxRuns: 10 }), { journalUnsealed: () => true });
		const [unsealed] = recovered.unsealed;
		strictEqual(unsealed?.runId, run.id);
		ok(unsealed?.settlement);
		const heard: Array<{ runId: unknown; outcome: unknown; onDisk: boolean }> = [];
		const unsubscribe = telemetryHub().subscribe("run.settled", (data, ctx) => {
			heard.push({
				runId: ctx?.runId,
				outcome: data.outcome,
				onDisk: readFileSync(telemetryJournalPath(directory), "utf8").includes('"run.settled"'),
			});
		});
		try {
			await sealTerminalRunJournal(directory, unsealed.settlement);
		} finally {
			unsubscribe();
		}
		deepStrictEqual(heard, [{ runId: run.id, outcome: "failed", onDisk: true }]);
		const settled = (await readCallJournal(directory)).records.filter(({ record }) => record.k === "run.settled");
		strictEqual((settled[0]?.record.data as { outcome?: string }).outcome, "failed");
		ok(existsSync(telemetryBundlePath(directory)), "the corrected journal is sealed");
	});

	it("closes an abandoned run at its journal's call fold, a call it never settled unknown (FL-24)", async () => {
		const ledger = openLedger({ maxRuns: 10 });
		const run = ledger.create({
			agentId: "coder",
			executionRole: "builder",
			task: "interrupted work",
			targetId: "local",
			wireModelId: "model",
			runtimeId: "openai",
			runtimeKind: "http",
			sessionId: null,
			cwd: scratch.dir,
		});
		ledger.update(run.id, { status: "running", pid: 999_999, heartbeatAt: run.startedAt });
		await ledger.persist();
		const directory = join(telemetryRunsDirectory(pancodeStateDir()), run.id);
		const context = { sessionId: null, runId: run.id, agent: { role: "worker" as const, id: run.id } };
		const journal = await openRunTelemetry(context, directory);
		const frame = (kind: "call.started" | "call.settled", data: object, ids: object, mono: number) => ({
			type: "pancode_telemetry",
			record: {
				...makeTelemetryRecord(kind, data as never, { ...context, ...ids }, { t: new Date().toISOString(), mono }),
				origin: { host: "local-worker", pid: 42, birthToken: "fixture", monoEpochWallMs: 0 },
			},
		});
		const call = (ids: { callId: string; attemptId: string }) => ({
			...ids,
			...{ attempt: 0, roundKind: "normal" as const, toolChoice: "auto" as const },
			target: {
				...{ targetId: "local", runtimeId: "openai", api: "openai", requestedModel: "model" },
				reportedModel: { kind: "unknown" as const, reason: "not-observed" as const },
			},
		});
		const message = {
			role: "assistant",
			stopReason: "toolUse",
			content: [],
			usage: { input: 1000, output: 100, totalTokens: 1100, cost: { total: 0.01 } },
		};
		const settledIds = { callId: newCallId(), attemptId: newAttemptId() };
		const openIds = { callId: newCallId(), attemptId: newAttemptId() };
		ok(journal.worker(frame("call.started", call(settledIds), settledIds, 1)));
		const settledData = {
			...call(settledIds),
			stages: { settle: 1 },
			...callSettlementFromMessage(message, "target-rates"),
		};
		ok(journal.worker(frame("call.settled", settledData, settledIds, 2)));
		ok(journal.worker(frame("call.started", call(openIds), openIds, 3)));
		// The host last saw the worker after the row's heartbeat, so that display row bounds the run's end.
		while (Date.now() <= Date.parse(run.startedAt)) await sleep(1);
		journal.feed({ kind: "open", runId: run.id, agentId: "coder" }, 1_000_000);
		await journal.close();

		const reopened = openLedger({ maxRuns: 10 });
		const recovered = recoverAbandonedRuns(reopened);
		strictEqual(recovered.abandoned, 1);
		const row = reopened.get(run.id);
		const [unsettled] = recovered.unsettled;
		ok(row?.endedAt && unsettled);
		ok(Date.parse(row.endedAt) > Date.parse(run.startedAt), "the end is the journal's last display row");
		const { usage, totalTokens, apiCalls, pricing, callIds, endedAt } = unsettled.settlement.facts;
		// The row closes at the spend run.settled records, and both name every call the journal saw.
		deepStrictEqual(row.spend, { usage, totalTokens, apiCalls, pricing });
		strictEqual(endedAt, row.endedAt);
		deepStrictEqual(callIds, [settledIds.callId, openIds.callId].sort());
		// The settled call's $0.01 stays counted; the one it never settled leaves the sum partial, never zero.
		const usd = row.spendSums.usd;
		ok(
			Math.abs(usd.measured + usd.estimated - 0.01) < 1e-9,
			`priced part ${usd.measured + usd.estimated} (abs tol 1e-9)`,
		);
		strictEqual(usd.unknownCount, 1);
		await settleOrphanedRunJournal(directory, unsettled.settlement);
		const journaled = (await readCallJournal(directory)).records.find(({ record }) => record.k === "run.settled");
		deepStrictEqual((journaled?.record.data as { callIds?: unknown }).callIds, callIds);
	});

	it("bounds deferred append handles, finishes mid-flush appends, retires dropped handles, and rejects symlinked directories", async () => {
		const fdCount = () => (existsSync("/proc/self/fd") ? readdirSync("/proc/self/fd").length : null);
		await flushDeferredWrites();
		const baseline = fdCount();

		const burstDir = join(scratch.dir, "burst");
		const paths = Array.from({ length: 100 }, (_, i) => join(burstDir, `f-${i}.jsonl`));
		for (const [i, path] of paths.entries()) {
			deferAppend(path, `row-${i}\n`, { mkdirMode: 0o700 });
		}
		// Wait for natural setImmediate draining without flushing handles closed yet.
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline && !paths.every((p) => existsSync(p) && readFileSync(p, "utf8").endsWith("\n"))) {
			await sleep(10);
		}
		for (const [i, path] of paths.entries()) strictEqual(readFileSync(path, "utf8"), `row-${i}\n`);
		const afterBurst = fdCount();
		if (baseline !== null && afterBurst !== null) {
			ok(afterBurst - baseline <= 68, `open FD delta ${afterBurst - baseline} exceeded 64-handle cap`);
		}
		await flushDeferredWrites();
		const afterFlush = fdCount();
		if (baseline !== null && afterFlush !== null) {
			ok(afterFlush - baseline <= 4, `open FD delta ${afterFlush - baseline} leaked handles after flush`);
		}

		// flushDeferredWrite must land lines queued while an earlier batch for the same path is in flight.
		const midFlush = join(scratch.dir, "mid-flush.jsonl");
		deferAppend(midFlush, "first\n");
		const flushing = flushDeferredWrite(midFlush);
		deferAppend(midFlush, "second\n");
		await flushing;
		strictEqual(readFileSync(midFlush, "utf8"), "first\nsecond\n");

		// dropDeferredWrite while a write is in flight must close the handle once the write completes so a recreated path is written.
		const rotated = join(scratch.dir, "rotated.jsonl");
		deferAppend(rotated, "v1\n");
		const waitV1 = Date.now() + 2_000;
		while (Date.now() < waitV1 && (!existsSync(rotated) || readFileSync(rotated, "utf8") !== "v1\n")) {
			await sleep(5);
		}
		deferAppend(rotated, "v2\n");
		const inFlightFlush = flushDeferredWrite(rotated);
		dropDeferredWrite(rotated);
		await inFlightFlush;
		unlinkSync(rotated);
		deferAppend(rotated, "v3\n");
		await flushDeferredWrite(rotated);
		strictEqual(readFileSync(rotated, "utf8"), "v3\n");

		// A symlinked directory listed in plainDirectories must be rejected asynchronously without creating the target file.
		const realDir = join(scratch.dir, "real-dir");
		const linkDir = join(scratch.dir, "link-dir");
		mkdirSync(realDir);
		symlinkSync(realDir, linkDir);
		let rejected: unknown = null;
		const blocked = join(linkDir, "blocked.jsonl");
		deferAppend(blocked, "secret\n", {
			plainDirectories: [linkDir],
			onError: (error) => {
				rejected = error;
			},
		});
		await flushDeferredWrite(blocked);
		ok(rejected !== null);
		strictEqual(existsSync(join(realDir, "blocked.jsonl")), false);
	});

	it("starts a resumed run feed append on a new line when the file ended mid-line", async () => {
		const runId = "run-torn-tail";
		const path = runFeedPath(runId);
		mkdirSync(dirname(path), { recursive: true });
		const openRow = JSON.stringify({ v: 1, seq: 1, at: "2026-06-11T00:00:00.000Z", kind: "open", runId, agentId: "a" });
		writeFileSync(path, `${openRow}\n{"v":1,"seq":2,"kind":"eve`, "utf8");

		appendRunFeed(runId, { kind: "event", type: "pancode_tool_start", tool: "read", callId: "c1" });
		await flushRunFeed(runId);

		const read = readRunFeed(runId);
		strictEqual(read.lines.length, 2);
		strictEqual(read.lines[0]?.kind, "open");
		strictEqual(read.lines[1]?.kind, "event");
		strictEqual(read.lines[1]?.seq, 2);
	});
});
