// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The launch record of a host launcher (P8): one `details.sandbox` record and one `sandbox.launched` journal entry per
 * launch, the planner's facts when a sandbox planner decided it, else the label's own. An unconfined or host launch
 * has no backend and an open, unobserved network.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { sandboxAvailability } from "./availability.js";
import type { HostLaunchLabel } from "./host-launch.js";
import {
	labelLaunch,
	launchTelemetryContext,
	recordSandboxLaunch,
	type SandboxLaunchFacts,
	type SandboxLaunchLabel,
	type SandboxLaunchRecord,
	type SandboxPlanFacts,
	sandboxLaunchRecord,
} from "./launch-record.js";
import type { EgressMode, SandboxLaunchOutcome } from "./types.js";
import { workerSandboxConfigured } from "./worker-process.js";

/**
 * The facts of a launch: the planner's under the label's launcher and integration, or the label's own. A sandboxed
 * label with no plan at hand (a pane the terminal starts) names the host's backend and its policy's network.
 */
export function hostLaunchFacts(
	label: HostLaunchLabel,
	plan?: SandboxPlanFacts,
	sandboxedNetwork: EgressMode = "off",
): SandboxLaunchFacts {
	if (plan !== undefined) return labelLaunch({ ...plan, launcher: label.launcher }, label);
	const sandboxed = label.confinement === "sandboxed";
	return {
		caller: workerSandboxConfigured() ? "worker" : "main",
		launcher: label.launcher,
		...(label.integration !== undefined ? { integration: label.integration } : {}),
		confinement: label.confinement,
		why: label.why,
		backend: sandboxed ? sandboxAvailability().backend : null,
		network: sandboxed ? sandboxedNetwork : "open",
	};
}

/** The launch label an exec seam takes for this host launch: its launcher, integration and confining policy. */
export function seamLaunchLabel(label: HostLaunchLabel): SandboxLaunchLabel {
	return {
		launcher: label.launcher,
		...(label.integration !== undefined ? { integration: label.integration } : {}),
		why: label.why,
	};
}

const collected = new AsyncLocalStorage<SandboxLaunchRecord[]>();

/**
 * Runs `run` and returns the host launches settled inside it, for a tool whose reader sits behind an interface that
 * carries no record (the data tool's SQLite reader).
 */
export async function collectHostLaunches<T>(
	run: () => Promise<T>,
): Promise<{ value: T; launches: SandboxLaunchRecord[] }> {
	const launches: SandboxLaunchRecord[] = [];
	const value = await collected.run(launches, run);
	return { value, launches };
}

/** Builds and journals one settled host launch; the result's `details.sandbox` carries the same record. */
export function settleHostLaunch(
	label: HostLaunchLabel,
	settled: { outcome: SandboxLaunchOutcome; exitCode?: number | null },
	plan?: SandboxPlanFacts,
): SandboxLaunchRecord {
	const record = sandboxLaunchRecord(hostLaunchFacts(label, plan), settled);
	recordSandboxLaunch(record, launchTelemetryContext());
	collected.getStore()?.push(record);
	return record;
}

/** An exec seam's own record when it planned the launch, else this label's, journaled once either way. */
export function seamOrHostLaunch(
	seam: SandboxLaunchRecord | undefined,
	label: HostLaunchLabel,
	settled: { launched?: boolean; exitCode?: number | null },
): SandboxLaunchRecord {
	if (seam !== undefined) {
		collected.getStore()?.push(seam);
		return seam;
	}
	return settleHostLaunch(label, {
		outcome: settled.launched === false ? "launch-failed" : "ran",
		...(settled.exitCode !== undefined ? { exitCode: settled.exitCode } : {}),
	});
}
