// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { sandboxAvailability, sandboxNetworkIsolation, sandboxUsable, wslKind } from "./availability.js";
import type { EgressMode, SandboxAvailability, SandboxBackend, SandboxMode, UnixSocketMode } from "./types.js";

/**
 * What the host's OS sandbox is, apart from what the setting asks of it.
 * `available`: a full sandbox. `partial`: the backend runs but its seccomp
 * baseline does not load. `lost`: a backend binary is here and cannot build a
 * sandbox (a kernel or container forbids its namespaces). `missing`: no
 * trusted backend binary, or a platform with none. `off`: the setting.
 */
export type SandboxOutcome = "available" | "partial" | "lost" | "missing" | "off";

/**
 * One host's sandbox state, the single answer `pancode version --sandbox`,
 * doctor, the welcome and worker diagnostics read. The first four keys are
 * the line a fleet node has always printed; the rest were added after it.
 */
export interface SandboxStatus {
	available: boolean;
	backend: SandboxBackend | null;
	reason: string | null;
	/** Null when bubblewrap can also isolate the network, which a network-off command needs; else why not. */
	network: string | null;
	setting: SandboxMode;
	outcome: SandboxOutcome;
	/** The backend binary in use, or the one that was found and failed. */
	executable: string | null;
	/** Bubblewrap's seccomp baseline: loaded, degraded (with `degraded` saying why), or none without bubblewrap. */
	seccomp: "loaded" | "degraded" | "none";
	degraded: string | null;
	unixSockets: UnixSocketMode;
	wsl: "wsl1" | "wsl2" | null;
	/** Default-autonomy shell commands of the main session: in the sandbox, on the approval rails only, or setting off. */
	main: "contained" | "rails" | "off";
	/** A native worker dispatched to this host: in the sandbox, refused at admission, allowed to run unconfined, or off. */
	localWorker: "contained" | "refused" | "unconfined" | "off";
}

export interface SandboxStatusInput {
	setting: SandboxMode;
	availability: SandboxAvailability;
	networkIsolation: string | null;
	unixSockets: UnixSocketMode;
	wsl: "wsl1" | "wsl2" | null;
	unconfinedLocalWorkers: boolean;
	/** Worker commands keep the open host network (`safety.egress.workers.mode: open`), so they need no network isolation. */
	workerNetwork: boolean;
}

/** Pure: the outcome for this setting and probe. */
export function sandboxOutcome(setting: SandboxMode, availability: SandboxAvailability): SandboxOutcome {
	if (setting === "off") return "off";
	if (availability.available) return availability.degraded !== undefined ? "partial" : "available";
	return availability.found !== undefined ? "lost" : "missing";
}

/** Pure: the status the inputs describe. */
export function sandboxStatus(input: SandboxStatusInput): SandboxStatus {
	const { availability, setting } = input;
	const outcome = sandboxOutcome(setting, availability);
	const usable = sandboxUsable(setting, availability);
	const workerUsable = usable && (input.workerNetwork || input.networkIsolation === null);
	return {
		available: availability.available,
		backend: availability.backend,
		reason: availability.reason,
		network: input.networkIsolation,
		setting,
		outcome,
		executable: availability.executable ?? availability.found ?? null,
		seccomp:
			availability.backend !== "bwrap" || !availability.available
				? "none"
				: availability.degraded !== undefined
					? "degraded"
					: "loaded",
		degraded: availability.degraded ?? null,
		unixSockets: input.unixSockets,
		wsl: input.wsl,
		main: setting === "off" ? "off" : usable ? "contained" : "rails",
		localWorker:
			setting === "off"
				? "off"
				: workerUsable
					? "contained"
					: setting === "auto" && input.unconfinedLocalWorkers
						? "unconfined"
						: "refused",
	};
}

/** Impure: this host's status under the operator's safety settings; probes the backend once per process. */
export function hostSandboxStatus(safety: {
	sandbox: SandboxMode;
	sandboxUnixSockets: UnixSocketMode;
	sandboxUnconfinedLocalWorkers: boolean;
	egress: { workers: { mode: EgressMode } };
}): SandboxStatus {
	const availability = sandboxAvailability();
	return sandboxStatus({
		setting: safety.sandbox,
		availability,
		networkIsolation: sandboxNetworkIsolation(availability),
		unixSockets: safety.sandboxUnixSockets,
		wsl: process.platform === "linux" ? wslKind() : null,
		unconfinedLocalWorkers: safety.sandboxUnconfinedLocalWorkers,
		workerNetwork: safety.egress.workers.mode === "open",
	});
}

/** One line for doctor and diagnostics: each fact on its own, in the order of the status object. */
export function sandboxStatusLine(status: SandboxStatus): string {
	const backend =
		status.outcome === "available" || status.outcome === "partial"
			? `${status.backend}${status.executable !== null ? ` (${status.executable})` : ""}`
			: status.outcome === "lost"
				? `lost: ${status.executable ?? "the backend"} cannot build a sandbox here (${status.reason ?? "no reason given"})`
				: `missing (${status.reason ?? "no backend"})`;
	const parts = [`setting ${status.setting}`, `backend ${backend}`];
	if (status.seccomp === "loaded") parts.push("seccomp baseline loaded");
	else if (status.seccomp === "degraded") parts.push(`partial: seccomp baseline not loaded (${status.degraded})`);
	if (status.available && status.network !== null) parts.push(`no network isolation (${status.network})`);
	if (status.wsl !== null) parts.push(status.wsl === "wsl2" ? "WSL2" : "WSL1 (unsupported)");
	parts.push(
		status.main === "contained"
			? "main shell contained"
			: status.main === "rails"
				? "main shell not sandboxed (approval rails only)"
				: "main shell not sandboxed (safety.sandbox off)",
	);
	parts.push(
		status.localWorker === "contained"
			? "local workers contained"
			: status.localWorker === "unconfined"
				? "local workers run unconfined (safety.sandboxUnconfinedLocalWorkers)"
				: status.localWorker === "refused"
					? "local native workers refused"
					: "local workers not sandboxed (safety.sandbox off)",
	);
	return parts.join("; ");
}
