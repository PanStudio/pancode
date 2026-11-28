// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Re-authenticate one run's sealed run scope, right now (#434).
 *
 * This command reads the run's journal and objects off disk and verifies its seal again, which is the only way to
 * learn that a run trusted an hour ago no longer verifies.
 *
 * Like `evidence inspect --json` it takes an identifier, because an operator names the run. The identifier is
 * validated for shape here; a GUI host that echoes operator-supplied ids owes its own served-id window on top of that,
 * because shape alone does not prove the id was ever served.
 */

import { pancodeStateDir } from "../core/xdg.js";
import { type FleetRootSeal, inspectFleetRootSeal } from "../domains/dispatch/fleet-root-seal.js";
import { openLedger } from "../domains/dispatch/state.js";
import { inspectRunTrustStatus, TRUST_STATUS_AXES, type TrustStatusAxis } from "../domains/evidence/index.js";
import { readRunRecord } from "../domains/telemetry/index.js";
import { EXIT_CODES } from "./kit/exit-codes.js";
import { parseCommandFlags } from "./kit/flags.js";
import { writeCliFailure } from "./kit/json-out.js";

/** A run's trust as of this check: still pending, verified, failed, or unavailable. */
export type FleetVerifyState = "pending" | "verified" | "failed" | "unavailable";

/** Why a run did not authenticate, as a closed set: the part of its sealed scope that did not verify, or why none did. */
const FLEET_VERIFY_REASONS = [
	"manifest-mismatch",
	"segment-mismatch",
	"object-mismatch",
	"chain-mismatch",
	"seal-mismatch",
	"unsealed",
	"run-unreadable",
] as const;
export type FleetVerifyReason = (typeof FLEET_VERIFY_REASONS)[number];

export interface FleetVerifySnapshot {
	readonly version: 1;
	readonly verifiedAt: string;
	readonly runId: string;
	readonly state: FleetVerifyState;
	/** Null whenever the run authenticated or has not settled yet. */
	readonly reason: FleetVerifyReason | null;
	readonly axes: Readonly<Record<TrustStatusAxis, string>>;
}

/**
 * A fleet root's verdict: its own seal (`inspectFleetRootSeal`) folded with each agent step run's snapshot. A code
 * step's record sits in the root's own scope, so the root seal covers it. The worst state wins: failed, then pending,
 * then unavailable.
 */
export interface FleetRootVerifySnapshot {
	readonly version: 1;
	readonly kind: "fleet-root";
	readonly verifiedAt: string;
	readonly runId: string;
	readonly playbook: string;
	readonly state: FleetVerifyState;
	readonly reason: FleetVerifyReason | null;
	readonly detail: string | null;
	/** The root's own verdict from `fleet_sealed`; null until it seals. */
	readonly outcome: FleetRootSeal["outcome"];
	readonly steps: ReadonlyArray<{
		readonly stepId: string;
		readonly runId: string;
		readonly succeeded: boolean;
		readonly failureReason: string | null;
		/** The step run's own snapshot state; null for a code step, which the root seal covers. */
		readonly state: FleetVerifyState | null;
		readonly reason: FleetVerifyReason | null;
	}>;
}

const STATE_RANK: Record<FleetVerifyState, number> = { verified: 0, unavailable: 1, pending: 2, failed: 3 };

function rootVerifySnapshot(seal: FleetRootSeal, now: () => number = Date.now): FleetRootVerifySnapshot {
	const verifiedAt = new Date(now()).toISOString();
	const ledger = openLedger();
	const steps = seal.steps.map((step) => {
		const run = ledger.get(step.runId) === null ? null : fleetVerifySnapshot(step.runId, now);
		return { ...step, state: run?.state ?? null, reason: run?.reason ?? null };
	});
	let state: FleetVerifyState =
		seal.state === "unsealed" ? "unavailable" : seal.state === "failed" ? "failed" : seal.state;
	let reason: FleetVerifyReason | null = seal.reason;
	let detail = seal.detail;
	for (const step of steps) {
		if (step.state === null || STATE_RANK[step.state] <= STATE_RANK[state]) continue;
		state = step.state;
		reason = step.reason;
		detail = `step ${step.stepId} run ${step.runId} is ${step.state}${step.reason !== null ? ` (${step.reason})` : ""}`;
	}
	return {
		version: 1,
		kind: "fleet-root",
		verifiedAt,
		runId: seal.rootId,
		playbook: seal.playbook,
		state,
		reason,
		detail,
		outcome: seal.outcome,
		steps,
	};
}

class FleetVerifyUnknownRunError extends Error {
	override readonly name = "FleetVerifyUnknownRunError";
}

function fleetVerifySnapshot(runId: string, now: () => number = Date.now): FleetVerifySnapshot {
	const envelope = openLedger().get(runId);
	if (envelope === null) throw new FleetVerifyUnknownRunError(`unknown run '${runId}'`);
	const verifiedAt = new Date(now()).toISOString();
	const record = readRunRecord(pancodeStateDir(), envelope.id);
	const inspection = inspectRunTrustStatus(record);
	const axes = Object.fromEntries(TRUST_STATUS_AXES.map((axis) => [axis, inspection.status[axis].state])) as Record<
		TrustStatusAxis,
		string
	>;
	const snapshot = (state: FleetVerifyState, reason: FleetVerifyReason | null): FleetVerifySnapshot => ({
		version: 1,
		verifiedAt,
		runId: envelope.id,
		state,
		reason,
		axes,
	});
	// The seal is checked before the settlement: a changed journal can hide its run.settled, and that run failed its
	// seal rather than being unreadable.
	const seal = record?.seal ?? null;
	if (seal?.status === "failed") return snapshot("failed", `${seal.mismatch.kind}-mismatch`);
	// A run that has not settled has nothing to authenticate yet, which is a different answer from one that failed to.
	if (record?.settled == null)
		return envelope.endedAt === null ? snapshot("pending", null) : snapshot("unavailable", "run-unreadable");
	if (seal === null) return snapshot("unavailable", "run-unreadable");
	if (seal.status === "verified") return snapshot("verified", null);
	return snapshot("unavailable", "unsealed");
}

/**
 * The verdict as an exit code under `--exit-code` (C19): verified 0, failed or unavailable 1, and pending 75 because
 * the run is still live and a later check can answer. Without the flag every answered state exits 0.
 */
function verdictExitCode(state: FleetVerifyState): number {
	if (state === "verified") return EXIT_CODES.success;
	if (state === "pending") return EXIT_CODES.notReady;
	return EXIT_CODES.failed;
}

const VERIFY_PATH = ["fleet", "verify"] as const;
const VERIFY_USAGE = "usage: pancode fleet verify <runId|fleetRootId> [--json] [--exit-code]";

export function runFleetVerify(args: ReadonlyArray<string>): number {
	const parsed = parseCommandFlags(args, { json: { kind: "boolean" }, "exit-code": { kind: "boolean" } });
	const json = parsed.ok ? parsed.flags.json === true : args.includes("--json");
	if (!parsed.ok) {
		writeCliFailure({ path: VERIFY_PATH, slug: parsed.slug, message: parsed.message, json });
		return EXIT_CODES.notStarted;
	}
	const runId = parsed.positional[0];
	if (parsed.positional.length !== 1 || runId === undefined) {
		writeCliFailure({ path: VERIFY_PATH, slug: "usage", message: VERIFY_USAGE, json });
		return EXIT_CODES.notStarted;
	}
	const rootSeal = inspectFleetRootSeal(runId);
	if (rootSeal !== null) {
		const root = rootVerifySnapshot(rootSeal);
		if (json) process.stdout.write(`${JSON.stringify(root, null, 2)}\n`);
		else {
			process.stdout.write(
				`fleet root ${root.runId} (${root.playbook}): ${root.state}${root.reason !== null ? ` (${root.reason})` : ""} at ${root.verifiedAt}\n`,
			);
			if (root.detail !== null) process.stdout.write(`  ${root.detail}\n`);
			process.stdout.write(`  outcome: ${root.outcome ?? "not sealed"}\n`);
			for (const step of root.steps)
				process.stdout.write(
					`  step ${step.stepId}: ${step.succeeded ? "succeeded" : "failed"} run ${step.runId} ${step.state === null ? "(in the root's scope)" : step.state}${step.reason !== null ? ` (${step.reason})` : ""}\n`,
				);
		}
		return parsed.flags["exit-code"] === true ? verdictExitCode(root.state) : EXIT_CODES.success;
	}
	let snapshot: FleetVerifySnapshot;
	try {
		snapshot = fleetVerifySnapshot(runId);
	} catch (error) {
		if (!(error instanceof FleetVerifyUnknownRunError)) throw error;
		writeCliFailure({ path: VERIFY_PATH, slug: "not_found", message: error.message, json });
		return EXIT_CODES.failed;
	}
	if (json) process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
	else {
		process.stdout.write(
			`run ${snapshot.runId}: ${snapshot.state}${snapshot.reason !== null ? ` (${snapshot.reason})` : ""} at ${snapshot.verifiedAt}\n`,
		);
		for (const [axis, state] of Object.entries(snapshot.axes)) process.stdout.write(`  ${axis}: ${state}\n`);
	}
	return parsed.flags["exit-code"] === true ? verdictExitCode(snapshot.state) : EXIT_CODES.success;
}
