// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Host-launched tools (P8, D11): every agent-reachable launcher PanCode starts
 * outside a shell call says where it ran. `safety.confine` names the
 * integrations the operator runs in PanCode's sandbox; any other runs on the
 * host as before and is labelled `unconfined`, never shown as inside the
 * requesting process. Pure, so settings validation and doctor can load it.
 */

import { CONFINE_CLASSES, type ConfineClass, type HostLauncher, type SandboxConfinement } from "./types.js";

/** One `safety.confine` entry: a class, or `mcp:<server id>` and `extension:<extension id>`. */
export type ConfineEntry = ConfineClass | `mcp:${string}` | `extension:${string}`;

const NAMED_ENTRY = /^(mcp|extension):([a-z0-9][a-z0-9._-]*)$/u;

/** Why one `safety.confine` entry cannot be read, or null. */
export function confineEntryProblem(entry: string): string | null {
	if ((CONFINE_CLASSES as ReadonlyArray<string>).includes(entry)) return null;
	if (NAMED_ENTRY.test(entry)) return null;
	return `expected one of ${CONFINE_CLASSES.join(", ")}, mcp:<server id> or extension:<extension id>`;
}

/** The label fields a host launch adds to `details.sandbox`. */
export interface HostLaunchLabel {
	launcher: HostLauncher;
	/** The `safety.confine` entry that names this integration, when one can. */
	integration?: ConfineEntry;
	confinement: SandboxConfinement;
	why: string;
}

/** True when `safety.confine` names this integration. */
export function confines(list: ReadonlyArray<string> | undefined, integration: ConfineEntry): boolean {
	return list?.includes(integration) === true;
}

/** The label of an opt-in integration `safety.confine` does not name: today's host launch. */
export function notConfinedLabel(launcher: HostLauncher, integration: ConfineEntry): HostLaunchLabel {
	return {
		launcher,
		integration,
		confinement: "unconfined",
		why: `${integration} is not in safety.confine`,
	};
}

/** The label of a launch PanCode's sandbox held; `why` says which policy. */
export function sandboxedLabel(launcher: HostLauncher, why: string, integration?: ConfineEntry): HostLaunchLabel {
	return { launcher, ...(integration !== undefined ? { integration } : {}), confinement: "sandboxed", why };
}

/** The label of a launch that would be sandboxed but ran on the host because no sandbox could hold it. */
export function uncontainedLabel(launcher: HostLauncher, why: string, integration?: ConfineEntry): HostLaunchLabel {
	return { launcher, ...(integration !== undefined ? { integration } : {}), confinement: "unconfined", why };
}

/** The label of the operator's own host work: user hooks, `run --verify`, a fleet plan's action and commit steps. */
export function hostAuthorityLabel(launcher: HostLauncher, why = "operator authority"): HostLaunchLabel {
	return { launcher, confinement: "host", why };
}

/** One short phrase for a label, as a tool description and an approval card show it. */
export function hostLaunchPhrase(label: HostLaunchLabel): string {
	if (label.confinement === "sandboxed") return `runs in PanCode's sandbox (${label.why})`;
	if (label.confinement === "host") return `runs on the host (${label.why})`;
	return `runs UNCONFINED on the host (${label.why})`;
}
