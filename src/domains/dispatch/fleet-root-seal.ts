// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * A fleet root's seal and outcome, read once for every surface that names a root: `fleet list`, `fleet verify`,
 * `evidence list`, `evidence inspect` and the TUI's plan history.
 *
 * A root is not a single run. Its own truth is the root record (`fleet-runs/<id>.json`), its hash-chained event
 * journal beside it, and the telemetry scope that holds its code steps' records. It never settles a `run.settled`
 * of its own, so a single-run reader sees it as unsettled; this reader judges it by what it does write.
 */

import { existsSync, readFileSync } from "node:fs";
import { sha256Hex } from "../../core/hash.js";
import { pancodeStateDir } from "../../core/xdg.js";
import { readRunRecord, telemetryRunDirectory } from "../telemetry/index.js";
import { readFleetEventJournal } from "./fleet-event-journal.js";
import { isFleetRootId } from "./fleet-root-record.js";
import { fleetRunPath, readFleetRun } from "./state.js";

/**
 * `verified`: the journal chain is intact and ends in `fleet_sealed`, the record on disk is the bytes that line names,
 * and the root's telemetry scope seal, when it has one, verifies. `failed`: one of those checks did not hold.
 * `pending`: the root has not ended. `unsealed`: it ended without a seal (its journal was off or the owner died).
 */
export type FleetRootSealState = "verified" | "failed" | "pending" | "unsealed";

export interface FleetRootStep {
	stepId: string;
	/** Null when the journal holds no settle line for the step. */
	kind: "agent" | "code" | null;
	/** The run the step settled; a code step's id names its record in the root's own scope. */
	runId: string;
	succeeded: boolean;
	failureReason: string | null;
}

export interface FleetRootSeal {
	rootId: string;
	playbook: string;
	startedAt: string;
	endedAt: string | null;
	state: FleetRootSealState;
	/** What failed, in `fleet verify`'s reason vocabulary; null when verified or pending. */
	reason: "chain-mismatch" | `${"manifest" | "segment" | "object" | "seal"}-mismatch` | "unsealed" | null;
	/** One sentence naming the failed check; null when verified or pending. */
	detail: string | null;
	/** The run's own verdict from `fleet_sealed`, as the journal states it; null until the root seals. */
	outcome: "succeeded" | "failed" | "aborted" | null;
	plannedStepCount: number;
	steps: FleetRootStep[];
}

/** Null when the id is not a root id or no root record by it exists. Any other read failure throws. */
export function inspectFleetRootSeal(rootId: string): FleetRootSeal | null {
	if (!isFleetRootId(rootId)) return null;
	const record = readFleetRun(rootId);
	if (record === null) return null;
	const journal = readFleetEventJournal(rootId);
	let sealLine: { outcome: FleetRootSeal["outcome"]; manifestDigest: string } | null = null;
	const kinds = new Map<string, "agent" | "code">();
	for (const line of journal?.lines ?? []) {
		if (line.type === "fleet_sealed") sealLine = line;
		else if (line.type === "step_settled") kinds.set(line.stepId, line.kind);
	}
	const steps = (record.steps ?? []).map((entry) => ({
		stepId: entry.stepId,
		kind: kinds.get(entry.stepId) ?? null,
		runId: entry.result.terminalRunId,
		succeeded: entry.result.succeeded === true,
		failureReason: typeof entry.result.failureReason === "string" ? entry.result.failureReason : null,
	}));
	const base = {
		rootId,
		playbook: record.fleet,
		startedAt: record.startedAt,
		endedAt: record.endedAt,
		outcome: sealLine?.outcome ?? null,
		plannedStepCount: record.stepIds.length,
		steps,
	};
	const verdict = (
		state: FleetRootSealState,
		reason: FleetRootSeal["reason"] = null,
		detail: string | null = null,
	): FleetRootSeal => ({ ...base, state, reason, detail });
	if (journal?.broken != null) return verdict("failed", "chain-mismatch", `event journal ${journal.broken}`);
	if (sealLine === null) {
		return record.endedAt === null
			? verdict("pending")
			: verdict("unsealed", "unsealed", "the root ended without a fleet_sealed journal line");
	}
	if (sha256Hex(readFileSync(fleetRunPath(rootId))) !== sealLine.manifestDigest)
		return verdict(
			"failed",
			"manifest-mismatch",
			"the root record on disk is not the record fleet_sealed names (manifestDigest differs)",
		);
	const scopeSeal = readRunRecord(pancodeStateDir(), rootId)?.seal ?? null;
	if (scopeSeal?.status === "failed")
		return verdict(
			"failed",
			`${scopeSeal.mismatch.kind}-mismatch`,
			`the root's telemetry scope seal: ${scopeSeal.mismatch.detail}`,
		);
	return verdict("verified");
}

/**
 * The step runs a root's spend and telemetry roll up: each settled step's run that has a run scope of its own. A code
 * step's record sits in the root's scope, so it adds none. Null when no root record by that id exists.
 */
export function fleetRootStepRunIds(rootId: string, stateDir: string = pancodeStateDir()): string[] | null {
	if (!isFleetRootId(rootId)) return null;
	const record = readFleetRun(rootId);
	if (record === null) return null;
	const ids = new Set((record.steps ?? []).map((entry) => entry.result.terminalRunId));
	ids.delete(rootId);
	return [...ids].filter((id) => typeof id === "string" && existsSync(telemetryRunDirectory(stateDir, id)));
}
