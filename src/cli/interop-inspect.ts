// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readSettings } from "../core/config.js";
import {
	detectInteropAgents,
	INTEROP_AGENT_KINDS,
	type InteropAdoptionPlan,
	type InteropAgentId,
	type InteropPresence,
	interopAgentKind,
	isAdoptableKind,
	type PeerModeCapability,
	peerModeCapabilities,
	planInteropAdoption,
} from "../domains/interop/index.js";

export type InteropDecisionState = "accepted" | "declined";

export interface InteropInspectAgent {
	readonly inventory: {
		status: string;
		diagnosticCount: number;
		listing: "unknown";
		counts: Record<string, number>;
		items: ReadonlyArray<{
			kind: string;
			name: string;
			scope: string;
			version?: string;
			marketplace?: string;
			installation?: string;
			enabled?: boolean;
			adoption: string;
		}>;
	} | null;
	readonly id: InteropAgentId;
	readonly label: string;
	readonly presence: InteropPresence;
	/** The bounded version probe result, or last observed version. */
	readonly version: string | null;
	/** Whether the agent owns a directory under the operator's home. The path stays host-side. */
	readonly hasUserDirectory: boolean;
	/** Whether PanCode has a built-in ACP recipe or an operator-configured ACP connection. */
	readonly acp: boolean;
	/** PanCode-owned headless runtime and the two local facts required to launch it. */
	readonly headless: { runtimeId: string; configured: boolean; binaryPresent: boolean } | null;
	/** The kind has a pane mode and its CLI is installed, read from `modes`; a host with no pane mode is never eligible. */
	readonly paneEligible: boolean;
	/** Launch choices with a status, precise limitation, and next setup action. */
	readonly modes: ReadonlyArray<PeerModeCapability>;
	/** Whether the ACP adapter can start without a network install; null for a kind with no recipe. */
	readonly adapter: InteropPresence | null;
	/** Whether a `delegation.agents` entry already names this agent. */
	readonly configured: boolean;
	/** The operator's standing answer, or null when they have not been asked. */
	readonly decision: InteropDecisionState | null;
	readonly decidedAt: string | null;
	/**
	 * True when the facts moved since the decision was taken.
	 *
	 * A standing answer suppresses re-proposal only while the facts it was made
	 * against still hold, so this is what says PanCode will ask again.
	 */
	readonly decisionStale: boolean;
	/** True when PanCode would offer to wire this agent on the next review. */
	readonly proposed: boolean;
	/** True when wiring it would fetch the adapter from the network on first use. */
	readonly needsNetworkInstall: boolean;
}

export interface InteropInspectSnapshot {
	readonly version: 1;
	readonly generatedAt: string;
	readonly detectedAt: string;
	/**
	 * How many agent kinds the registry knows, so an empty list reads as "none
	 * detected" rather than "nothing to detect". Explicit inspection includes all five inventory-enabled hosts, including absent
	 * binaries; lightweight bootstrap detection still drops empty kinds.
	 */
	readonly knownKinds: number;
	readonly agents: readonly InteropInspectAgent[];
}

/**
 * Each inventory item's adoption state as the adoption plan reads it, so inspect and `interop adopt --dry-run` agree: an
 * item PanCode already holds reads `adopted`, one the plan would install `review required`, and one it cannot port
 * `not adoptable`. An item the plan skips for another reason keeps `review required`.
 */
function adoptionStates(
	host: InteropAgentId,
	inventory: Parameters<typeof planInteropAdoption>[0]["inventory"] | undefined,
): Map<unknown, string> {
	const states = new Map<unknown, string>();
	if (inventory === undefined || inventory.items.length === 0) return states;
	let plan: InteropAdoptionPlan;
	try {
		plan = planInteropAdoption({ host, inventory });
	} catch {
		return states;
	}
	for (const entry of plan.entries) {
		if (!isAdoptableKind(entry.item.kind)) states.set(entry.item, "not adoptable");
		else if (entry.installed === true) states.set(entry.item, "adopted");
	}
	return states;
}

async function interopInspectSnapshot(now: () => number = Date.now): Promise<InteropInspectSnapshot> {
	const report = await detectInteropAgents({ cwd: process.cwd(), probeVersion: true, inventory: true });
	const settings = readSettings();
	const configured = new Set(settings.integrations.externalAgents.entries.map((agent) => agent.id));
	const configuredRuntimes = new Set(settings.targets.map((target) => target.runtime));
	const agents: InteropInspectAgent[] = [];
	for (const record of report.agents) {
		const kind = interopAgentKind(record.kind);
		if (kind === undefined) continue;
		const isConfigured = configured.has(kind.id);
		const acp = kind.acp !== undefined || isConfigured;
		const decision = record.decision === "accepted" || record.decision === "declined" ? record.decision : null;
		const decisionStale = decision !== null && record.decidedFingerprint !== record.fingerprint;
		const modes = peerModeCapabilities(kind, record, {
			configuredAcp: isConfigured,
			configuredTargets: settings.targets,
			paneAvailable: null,
		});
		const adoption = adoptionStates(kind.id, record.inventory);
		agents.push({
			inventory: record.inventory
				? {
						status: record.inventory.status,
						diagnosticCount: record.inventory.diagnostics.length,
						listing: record.inventory.listing,
						counts: record.inventory.items.reduce<Record<string, number>>((counts, item) => {
							counts[item.kind] = (counts[item.kind] ?? 0) + 1;
							return counts;
						}, {}),
						items: record.inventory.items.map((item) => {
							const { kind, name, scope, version, marketplace, installation, enabled } = item;
							return {
								kind,
								name,
								scope,
								...(version ? { version } : {}),
								...(marketplace ? { marketplace } : {}),
								...(installation ? { installation } : {}),
								...(enabled !== undefined ? { enabled } : {}),
								adoption: adoption.get(item) ?? (isAdoptableKind(kind) ? "review required" : "not adoptable"),
							};
						}),
					}
				: null,
			id: kind.id,
			label: kind.label,
			presence: record.presence,
			version: typeof record.version === "string" && record.version.length > 0 ? record.version : null,
			hasUserDirectory: record.installDir !== undefined,
			acp,
			headless: kind.headlessRuntimeId
				? {
						runtimeId: kind.headlessRuntimeId,
						configured: configuredRuntimes.has(kind.headlessRuntimeId),
						binaryPresent: record.binary !== undefined,
					}
				: null,
			paneEligible: modes.some((mode) => mode.mode === "pane" && mode.status !== "unavailable"),
			modes,
			adapter: kind.acp ? (record.adapter ?? "unknown") : isConfigured ? "unknown" : null,
			configured: isConfigured,
			decision,
			decidedAt: decision === null ? null : (record.decidedAt ?? null),
			decisionStale,
			// The same rule `interopProposals` applies, restated over the projected
			// fields so the flag cannot drift from what the review would offer.
			proposed:
				kind.acp !== undefined && record.presence === "present" && !isConfigured && (decision === null || decisionStale),
			needsNetworkInstall: kind.acp !== undefined && record.adapter !== "present",
		});
	}
	return {
		version: 1,
		generatedAt: new Date(now()).toISOString(),
		detectedAt: report.detectedAt,
		knownKinds: INTEROP_AGENT_KINDS.length,
		agents,
	};
}

export async function runInteropInspect(args: ReadonlyArray<string>): Promise<number> {
	if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
		process.stderr.write("pancode interop inspect: usage: pancode interop inspect [--json]\n");
		return 2;
	}
	const snapshot = await interopInspectSnapshot();
	if (args[0] === "--json") process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
	else
		for (const agent of snapshot.agents) {
			process.stdout.write(
				`${agent.label}: ${agent.presence}; version ${agent.version ?? "unknown"}; ACP ${agent.acp ? (agent.configured ? "configured" : "not configured") : "unsupported"}; adapter ${agent.adapter ?? "unsupported"}; headless ${agent.headless ? `${agent.headless.runtimeId} (${agent.headless.binaryPresent ? "binary installed" : "install CLI"}, ${agent.headless.configured ? "connection configured" : "connection needed"})` : "unsupported"}; pane ${agent.paneEligible ? "CLI installed" : agent.modes.some((mode) => mode.mode === "pane") ? "unavailable" : "unsupported"}\n`,
			);
			for (const mode of agent.modes) {
				process.stdout.write(`  ${mode.mode}: ${mode.status}; ${mode.reason}. Next: ${mode.setupAction}\n`);
			}
			process.stdout.write(
				`  Inventory ${agent.inventory?.status ?? "unknown"}: ${
					Object.entries(agent.inventory?.counts ?? {})
						.map(([kind, count]) => `${count} ${kind}`)
						.join(", ") || "none found"
				}\n`,
			);
			for (const item of agent.inventory?.items ?? [])
				process.stdout.write(
					`  ${item.scope} ${item.kind} ${item.name}${item.version ? ` @ ${item.version}` : ""}${item.marketplace ? ` (${item.marketplace})` : ""}; ${item.adoption}\n`,
				);
		}
	return 0;
}
