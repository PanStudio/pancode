// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Static } from "typebox";
import type { TelemetryContext } from "../telemetry/context.js";
import { telemetryContext } from "../telemetry/context-store.js";
import { telemetryHub } from "../telemetry/hub.js";
import type { SandboxDestinationSchema, SandboxLaunchedSchema } from "../telemetry/tool-schemas.js";
import type { EgressReport } from "./egress/bridge.js";
import type { EgressReceipt } from "./egress/proxy.js";
import {
	type EgressMode,
	SANDBOX_RECORD_MAX_DESTINATIONS,
	SANDBOX_RECORD_MAX_LISTENING_PORTS,
	type SandboxBackend,
	type SandboxCaller,
	type SandboxConfinement,
	type SandboxLauncher,
	type SandboxLaunchHint,
	type SandboxLaunchOutcome,
	type SandboxLaunchWhy,
	type SandboxMode,
} from "./types.js";

/**
 * One launch a sandbox policy decided, as it settled (sandbox P6): the tool result's `details.sandbox` and the
 * journal's `sandbox.launched` are this one record. Origins are bounded and clipped; no path, query, header, payload
 * or upstream proxy reaches it.
 */
export type SandboxLaunchRecord = Static<typeof SandboxLaunchedSchema>;
export type SandboxDestination = Static<typeof SandboxDestinationSchema>;

/** What a planner decided about one launch, before it runs. */
export interface SandboxLaunchFacts {
	caller: SandboxCaller;
	launcher: SandboxLauncher;
	integration?: string;
	confinement: SandboxConfinement;
	why: SandboxLaunchWhy;
	backend: SandboxBackend | null;
	/** The network the launch gets: `proxied` only when PanCode's proxy serves it. */
	network: EgressMode;
}

/** What a sandbox planner decides about a launch; the exec seam that runs it names the launcher. */
export type SandboxPlanFacts = Omit<SandboxLaunchFacts, "launcher" | "integration">;

/** The launcher label an integration's caller puts on the exec seams' launch facts; the seam keeps the rest. */
export interface SandboxLaunchLabel {
	launcher: SandboxLauncher;
	integration?: string;
}

/** A plan's facts under the seam's own launcher, or the label its caller passed. */
export function launchFacts(
	plan: SandboxPlanFacts,
	launcher: SandboxLauncher,
	label: SandboxLaunchLabel | undefined,
): SandboxLaunchFacts {
	return labelLaunch({ ...plan, launcher }, label);
}

export function labelLaunch(facts: SandboxLaunchFacts, label: SandboxLaunchLabel | undefined): SandboxLaunchFacts {
	if (label === undefined) return facts;
	const { integration: _integration, ...rest } = facts;
	return {
		...rest,
		launcher: label.launcher,
		...(label.integration !== undefined ? { integration: label.integration } : {}),
	};
}

const MAX_HOST_LABELS = 3;
const MAX_LABEL_CHARS = 32;
const MAX_CLIPPED_HOST_CHARS = 64;

/**
 * A name the operator never granted keeps only its rightmost labels, each bounded, so a long or many-labelled name
 * built to carry data does not reach the journal whole. An address literal is already bounded.
 */
export function clipEgressHost(host: string): { host: string; clipped: boolean } {
	if (/^[0-9.]+$/u.test(host) || host.includes(":")) return { host, clipped: false };
	const labels = host.split(".");
	const kept = labels.slice(-MAX_HOST_LABELS).map((label) => label.slice(0, MAX_LABEL_CHARS));
	let clipped = kept.join(".");
	if (clipped.length > MAX_CLIPPED_HOST_CHARS) clipped = clipped.slice(clipped.length - MAX_CLIPPED_HOST_CHARS);
	return clipped === host ? { host, clipped: false } : { host: clipped, clipped: true };
}

function destination(receipt: EgressReceipt): SandboxDestination {
	// A granted origin equals an operator's entry, so it stays whole; any other name is clipped.
	const granted = receipt.source === "grant" || receipt.source === "session";
	const { host, clipped } = granted ? { host: receipt.host, clipped: false } : clipEgressHost(receipt.host);
	return {
		host,
		port: receipt.port,
		decision: receipt.decision,
		...(receipt.code !== undefined ? { reason: receipt.code } : {}),
		...(receipt.source !== undefined ? { source: receipt.source } : {}),
		...(receipt.viaUpstream === true ? { viaUpstream: true as const } : {}),
		count: receipt.count,
		...(clipped ? { hostClipped: true as const } : {}),
	};
}

/**
 * A run's launches as its records tell them. `allowed`, `denied` and `failed` count connection attempts the proxy
 * observed; `unobserved` counts launches that ran with an open network no proxy watched.
 */
export interface SandboxLaunchTally {
	launches: number;
	refused: number;
	launchFailed: number;
	allowed: number;
	denied: number;
	failed: number;
	/** Connection attempts the records counted but did not list or read: past a bound, or shed. */
	dropped: number;
	unobserved: number;
}

export function emptySandboxLaunchTally(): SandboxLaunchTally {
	return { launches: 0, refused: 0, launchFailed: 0, allowed: 0, denied: 0, failed: 0, dropped: 0, unobserved: 0 };
}

export function tallySandboxLaunch(tally: SandboxLaunchTally, record: SandboxLaunchRecord): void {
	tally.launches += 1;
	if (record.outcome === "refused") tally.refused += 1;
	else if (record.outcome === "launch-failed") tally.launchFailed += 1;
	else if (record.network.mode === "open") tally.unobserved += 1;
	for (const destination of record.destinations ?? []) tally[destination.decision] += destination.count;
	tally.dropped += (record.dropped ?? 0) + (record.shed ?? 0);
}

/** The record of one settled launch. A proxied launch that ran lists its origins; any other network was not observed. */
export function sandboxLaunchRecord(
	facts: SandboxLaunchFacts,
	settled: {
		outcome: SandboxLaunchOutcome;
		exitCode?: number | null;
		egress?: EgressReport;
		hint?: SandboxLaunchHint | null;
	},
): SandboxLaunchRecord {
	const egress = settled.egress;
	const outcome: SandboxLaunchOutcome = egress?.setupFailed === true ? "launch-failed" : settled.outcome;
	const observed = facts.network === "proxied" && facts.confinement === "sandboxed" && outcome === "ran";
	const receipts = observed ? (egress?.receipts ?? []) : [];
	const listed = receipts.slice(0, SANDBOX_RECORD_MAX_DESTINATIONS);
	const unlisted = receipts.slice(SANDBOX_RECORD_MAX_DESTINATIONS).reduce((sum, receipt) => sum + receipt.count, 0);
	const dropped = (observed ? (egress?.dropped ?? 0) : 0) + unlisted;
	const shed = observed ? (egress?.shed ?? 0) : 0;
	const ports = observed ? (egress?.listeningPorts ?? []).slice(0, SANDBOX_RECORD_MAX_LISTENING_PORTS) : [];
	return {
		caller: facts.caller,
		launcher: facts.launcher,
		...(facts.integration !== undefined ? { integration: facts.integration } : {}),
		confinement: facts.confinement,
		why: facts.why,
		backend: facts.backend,
		outcome,
		...(typeof settled.exitCode === "number" && outcome === "ran" ? { exitCode: settled.exitCode } : {}),
		network: { mode: facts.network, observed },
		...(observed ? { destinations: listed.map(destination) } : {}),
		...(dropped > 0 ? { dropped } : {}),
		...(shed > 0 ? { shed } : {}),
		...(ports.length > 0 ? { listeningPorts: ports } : {}),
		...(settled.hint != null && outcome === "ran" ? { hint: settled.hint } : {}),
	};
}

/**
 * Journals one settled launch under the context its call ran in. The record is the tool result's own, so the
 * journal and the result never disagree. The call journal batches the write off this stack.
 */
export function recordSandboxLaunch(record: SandboxLaunchRecord, ctx: TelemetryContext | undefined): void {
	telemetryHub().emit("sandbox.launched", record, ctx);
}

/**
 * One exec seam's launch, from plan to settle: the record is built once, journaled under the context captured at plan
 * time, and returned for the result. Absent facts (no policy decided the launch) record nothing.
 */
export function sandboxLaunch(facts: SandboxLaunchFacts | undefined): {
	settle(settled: Parameters<typeof sandboxLaunchRecord>[1]): SandboxLaunchRecord | undefined;
} {
	const ctx = facts === undefined ? undefined : telemetryContext();
	let record: SandboxLaunchRecord | undefined;
	return {
		settle: (settled) => {
			if (facts === undefined) return undefined;
			if (record === undefined) {
				record = sandboxLaunchRecord(facts, settled);
				recordSandboxLaunch(record, ctx);
			}
			return record;
		},
	};
}

/** A contained launch that exited nonzero with output reading like a refused write: a heuristic hint, never proof. */
export function writeDeniedHint(
	facts: SandboxLaunchFacts | undefined,
	exitCode: number | null,
	output: () => string,
	refused: (output: string) => boolean,
): SandboxLaunchHint | null {
	if (facts?.confinement !== "sandboxed" || exitCode === 0 || exitCode === null) return null;
	return refused(output()) ? "write-denied" : null;
}

/** The launch's telemetry context, captured when it is planned so a late settle still names its call. */
export function launchTelemetryContext(): TelemetryContext | undefined {
	return telemetryContext();
}

const uncontainedRecorded = new Set<string>();

/**
 * Journals once per session and reason that the session's shell ran a command without the OS sandbox, so no record of
 * the session reads as contained by omission. A launch outside any session names no scope and is not recorded.
 */
export function recordUncontainedShell(
	state: { caller: SandboxCaller; why: SandboxLaunchWhy; mode: SandboxMode; backend: SandboxBackend | null },
	ctx: TelemetryContext | undefined = telemetryContext(),
): void {
	const owner = ctx?.runId ?? ctx?.sessionId;
	if (ctx === undefined || owner === undefined || owner === null) return;
	const key = `${owner}\u0000${state.caller}\u0000${state.why}`;
	if (uncontainedRecorded.has(key)) return;
	if (telemetryHub().emit("sandbox.uncontained", { ...state }, ctx)) uncontainedRecorded.add(key);
}
