// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AssignmentRegistry } from "../../src/domains/dispatch/assignment.js";
import { reconcileOrphanAssignments } from "../../src/domains/dispatch/assignment-reconcile.js";
import {
	cancelStoredAssignment,
	failQueuedAssignment,
	getStoredAssignment,
	recordAssignmentAttempt,
	registerAssignment,
	settleStoredAssignment,
} from "../../src/domains/dispatch/assignment-store.js";
import type { CapacityLease } from "../../src/domains/dispatch/capacity-lease.js";
import { acquireLaunch } from "../../src/domains/dispatch/launch-acquisition.js";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";

import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { clearScratchPancodeHome, newScratchPancodeHome } from "../harness/scratch-env.js";

describe("dispatch assignment lifecycle", () => {
	let scratch: string | null = null;
	afterEach(() => {
		if (scratch !== null) clearScratchPancodeHome(scratch);
		scratch = null;
	});

	it("deduplicates opens and attempts, then finalizes the attached terminal", async () => {
		const registry = new AssignmentRegistry();
		const policy = { maxRetries: 1, failover: "approved" as const, allowedCandidates: [] };
		const opened = registry.open("run-root", policy);
		strictEqual(registry.open("run-root", policy).terminal, opened.terminal);
		registry.recordAttempt(opened.id, {
			runId: "run-root",
			attempt: 0,
			outcome: "failed",
			node: { id: "local", kind: "local" },
			runDigest: "digest-0",
			retryReason: "worker-runtime",
		});
		registry.recordAttempt(opened.id, {
			runId: "run-root",
			attempt: 0,
			outcome: "failed",
			node: null,
			runDigest: "duplicate",
			retryReason: null,
		});
		registry.recordAttempt(opened.id, {
			runId: "run-retry",
			attempt: 1,
			outcome: "succeeded",
			node: { id: "mini", kind: "ssh", host: "mini.lan" },
			runDigest: "digest-1",
			retryReason: null,
		});
		const envelope = fixtureEnvelope("run-retry");
		const receipt = finishRunResult(fixtureReceiptDraft(envelope), envelope, {
			terminal: { terminalReason: "completed" },
			processExitCode: envelope.exitCode,
			frameType: null,
			usage: undefined,
		}).result;
		registry.settle(opened.id, receipt, "succeeded");
		strictEqual((await opened.terminal).runId, "run-retry");
		const final = registry.get(opened.id);
		strictEqual(final?.status, "succeeded");
		deepStrictEqual(
			final?.attempts.map(({ runId }) => runId),
			["run-root", "run-retry"],
		);
	});

	it("keeps detached lifecycle state durable and transition-idempotent", async () => {
		scratch = await newScratchPancodeHome("pancode-dispatch-lifecycle-");
		const started = await registerAssignment("assignment-1");
		strictEqual(started.status, "running");
		strictEqual(started.processOwner?.pid, process.pid);
		await recordAssignmentAttempt("assignment-1", "attempt-1");
		await recordAssignmentAttempt("assignment-1", "attempt-1");
		await recordAssignmentAttempt("assignment-1", "attempt-2");
		const settled = await settleStoredAssignment("assignment-1", "attempt-2", "succeeded");
		deepStrictEqual(settled.attempts, ["attempt-1", "attempt-2"]);
		strictEqual(settled.terminalRunId, "attempt-2");
		strictEqual(settled.status, "succeeded");
		strictEqual(settled.processOwner, undefined);
		await cancelStoredAssignment("assignment-1");
		strictEqual(getStoredAssignment("assignment-1")?.status, "succeeded", "terminal state cannot regress");

		await registerAssignment("assignment-cancel");
		strictEqual((await cancelStoredAssignment("assignment-cancel")).status, "canceled");
		await registerAssignment("assignment-fail");
		strictEqual((await failQueuedAssignment("assignment-fail")).status, "failed");
		strictEqual((await cancelStoredAssignment("assignment-fail")).status, "failed");
	});

	it("settles the stored assignment when a launch fails between admission and the ledger", async () => {
		scratch = await newScratchPancodeHome("pancode-dispatch-lifecycle-");
		const released: string[] = [];
		const launchFor = async (assignmentId: string, signal?: AbortSignal, throwOnRelease = false) => {
			await registerAssignment(assignmentId);
			return acquireLaunch({
				admit: async () => ({ leaseId: `lease-${assignmentId}`, assignmentId }) as CapacityLease,
				controller: {
					release: (leaseId) => {
						released.push(leaseId);
						if (throwOnRelease) throw new Error("capacity lock busy");
						return true;
					},
					releaseAssignment: () => false,
				},
				requireLedger: () => {
					throw new Error("ledger unavailable");
				},
				ownsAssignment: true,
				signal,
			});
		};
		await rejects(launchFor("no-ledger"), /ledger unavailable/);
		strictEqual(getStoredAssignment("no-ledger")?.status, "failed");
		await rejects(launchFor("release-throws", undefined, true), /ledger unavailable/);
		strictEqual(getStoredAssignment("release-throws")?.status, "failed");
		const aborted = new AbortController();
		aborted.abort();
		await rejects(launchFor("aborted", aborted.signal));
		strictEqual(getStoredAssignment("aborted")?.status, "canceled");
		deepStrictEqual(released, ["lease-no-ledger", "lease-release-throws", "lease-aborted"]);

		await registerAssignment("adopted-run");
		const releasedAssignments: string[] = [];
		const adopted = await acquireLaunch({
			admit: async () => ({ leaseId: "lease-adopted", assignmentId: "pending-adopted" }) as CapacityLease,
			controller: {
				release: () => {
					throw new Error("slot guard should be owned after adopt");
				},
				releaseAssignment: (assignmentId) => {
					releasedAssignments.push(assignmentId);
					throw new Error("capacity lock busy");
				},
			},
			requireLedger: () => ({}) as never,
			ownsAssignment: true,
		});
		adopted.adopt("adopted-run");
		await adopted.fail(new Error("envelope failed"));
		await adopted.fail(new Error("duplicate fail"));
		strictEqual(getStoredAssignment("adopted-run")?.status, "failed");
		deepStrictEqual(releasedAssignments, ["adopted-run"]);
	});

	it("recovers an orphan from durable attempts and fails one without evidence", async () => {
		const settled: Array<[string, string, string]> = [];
		const summary = await reconcileOrphanAssignments({
			listRunning: () => [
				{ assignmentId: "recover", attempts: ["failed", "green"], terminalRunId: null, status: "running" },
				{ assignmentId: "abandoned", attempts: [], terminalRunId: null, status: "running" },
			],
			ownerAlive: () => false,
			lookupAttempt: (runId) => ({ runId, terminal: true, succeeded: runId === "green" }),
			settle: async (assignmentId, runId, status) => {
				settled.push([assignmentId, runId, status]);
			},
		});
		deepStrictEqual(settled, [
			["recover", "green", "succeeded"],
			["abandoned", "abandoned", "failed"],
		]);
		deepStrictEqual(summary, { recovered: 1, abandoned: 1 });
	});
});
