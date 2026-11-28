// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { setTimeout as sleep } from "node:timers/promises";
import { fleetEndLines } from "../domains/dispatch/fleet-end-document.js";
import {
	type FleetRootRecord,
	fleetRootState,
	readFleetResult,
	readFleetRootRecord,
} from "../domains/dispatch/fleet-root-record.js";
import type { DispatchOwnership } from "../domains/dispatch/ownership.js";
import { readFleetRun } from "../domains/dispatch/state.js";
import type { ToolResult } from "./tool-spec.js";
import { truncateUtf8 } from "./truncate-utf8.js";

/**
 * monitor on a fleet root (`fleet-…`): a playbook run, from any surface or process, answered from its durable root
 * record, its plan record and its sealed fleet_end document. status reports where it stands, wait and collect block
 * until it seals, record returns the document itself. A root's steps are ordinary runs, so peek and tools observe
 * those by the run ids status names.
 */

const POLL_MS = 250;
const DOCUMENT_MAX_BYTES = 14 * 1024;

export type FleetRootMonitorMode = "status" | "peek" | "record" | "answer" | "wait" | "collect" | "tools";

interface FleetRootView {
	record: FleetRootRecord;
	state: "running" | "sealed" | "orphaned";
	document: Record<string, unknown> | null;
}

function readView(rootId: string): FleetRootView | null {
	const record = readFleetRootRecord(rootId);
	if (record === null) return null;
	const document = readFleetResult(rootId);
	return { record, state: fleetRootState(record, document !== null), document };
}

function runningLines(view: FleetRootView): string[] {
	const { record } = view;
	const plan = readFleetRun(record.rootId);
	const settled = plan?.steps ?? [];
	const lines = [
		`fleet ${record.playbook} root=${record.rootId}: ${view.state === "orphaned" ? `orphaned: its owner (pid ${record.pid} on ${record.host}) is gone and the root never sealed` : "running"}${plan !== null ? `, ${settled.length} of ${plan.stepIds.length} steps settled` : ""}`,
	];
	for (const { stepId, result } of settled) {
		lines.push(`- ${stepId} ${result.succeeded ? "succeeded" : "failed"} run=${result.terminalRunId}`);
	}
	const settledIds = new Set(settled.map((step) => step.stepId));
	const pending = plan?.stepIds.filter((stepId) => !settledIds.has(stepId)) ?? [];
	if (pending.length > 0) lines.push(`not settled: ${pending.join(", ")}`);
	return lines;
}

function viewDetails(view: FleetRootView): Record<string, unknown> {
	return {
		runId: view.record.rootId,
		fleetRoot: true,
		playbook: view.record.playbook,
		state: view.state,
		...(view.document !== null ? { fleetEnd: view.document } : {}),
	};
}

function viewLines(view: FleetRootView): string[] {
	if (view.document !== null) return fleetEndLines(view.document);
	if (view.state === "sealed") {
		return [`fleet ${view.record.playbook} root=${view.record.rootId}: sealed without a readable fleet result`];
	}
	return runningLines(view);
}

async function waitForSeal(
	rootId: string,
	view: FleetRootView,
	mode: "wait" | "collect",
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const startedAt = performance.now();
	let current = view;
	while (current.state === "running") {
		const elapsed = Math.round(performance.now() - startedAt);
		if (elapsed >= timeoutMs) {
			return {
				kind: "ok",
				output: [
					...runningLines(current),
					`${mode} waited ${elapsed}ms: fleet root ${rootId} keeps running normally. Wait again or collect later.`,
				].join("\n"),
				details: { ...viewDetails(current), mode, timedOut: true, complete: false, waitedMs: elapsed },
			};
		}
		try {
			await sleep(Math.min(POLL_MS, timeoutMs - elapsed), undefined, signal ? { signal } : undefined);
		} catch {
			return { kind: "error", message: `monitor: ${mode} aborted` };
		}
		current = readView(rootId) ?? current;
	}
	const waitedMs = Math.round(performance.now() - startedAt);
	return {
		kind: "ok",
		output: [`${mode} complete after ${waitedMs}ms:`, ...viewLines(current)].join("\n"),
		details: { ...viewDetails(current), mode, timedOut: false, complete: true, waitedMs },
	};
}

/** Answer monitor for one fleet root id, or refuse it by name when it is unknown here or another project's. */
export async function monitorFleetRoot(input: {
	rootId: string;
	mode: FleetRootMonitorMode;
	timeoutMs: number;
	signal: AbortSignal | undefined;
	ownership: DispatchOwnership;
	/** A wait or collect returned the sealed result, so the root no longer waits to be collected. */
	onCollected?: (rootId: string) => void;
}): Promise<ToolResult> {
	const { rootId, mode } = input;
	const view = readView(rootId);
	if (view === null) return { kind: "error", message: `monitor: unknown fleet root '${rootId}'` };
	if (!input.ownership.inProject(view.record.cwd)) {
		return {
			kind: "error",
			message: `monitor: fleet root '${rootId}' belongs to another project; only sessions in that project can inspect it`,
		};
	}
	if (mode === "peek" || mode === "tools") {
		return {
			kind: "error",
			message: `monitor: fleet root '${rootId}' is a playbook run, not one worker run; mode=status names its step run ids, which mode=${mode} observes`,
		};
	}
	if (mode === "wait" || mode === "collect") {
		const result = await waitForSeal(rootId, view, mode, input.timeoutMs, input.signal);
		if (result.kind === "ok" && result.details?.complete === true && result.details.fleetEnd !== undefined)
			input.onCollected?.(rootId);
		return result;
	}
	if (mode === "status") {
		return { kind: "ok", output: viewLines(view).join("\n"), details: { ...viewDetails(view), mode } };
	}
	if (view.document === null) {
		return {
			kind: "error",
			message: `monitor: fleet root '${rootId}' has not sealed (state=${view.state}); try mode="status" or mode="wait"`,
		};
	}
	return { kind: "ok", output: fleetEndAnswer(view.document), details: { ...viewDetails(view), mode } };
}

/** A sealed root's answer to the model: the fleet_end summary lines, then the document itself, bounded. */
export function fleetEndAnswer(document: Readonly<Record<string, unknown>>): string {
	const json = truncateUtf8(JSON.stringify(document, null, 2), DOCUMENT_MAX_BYTES, "\n[fleet_end document truncated]");
	return [...fleetEndLines(document), "", json].join("\n");
}
