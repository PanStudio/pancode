// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Where a stdio MCP server's process runs (P8, D11). In a worker it runs
 * under the worker's sandbox when one applies. In the orchestrator it runs
 * on the host, labelled so, unless the operator names `mcp:<id>` in
 * `safety.confine`; then it runs in the main-session sandbox with the
 * session's tree, its plugin data, and only the network its trust granted.
 */

import { hostLaunchPhrase, sandboxedLabel, uncontainedLabel } from "../../core/sandbox/host-launch.js";
import type { SandboxLaunchRecord } from "../../core/sandbox/launch-record.js";
import {
	confinedIntegrationPolicy,
	type MainSandboxPolicy,
	type OptInLaunch,
	optInLaunch,
} from "../../core/sandbox/main-session.js";
import { workerSandboxApplies } from "../../core/sandbox/worker-process.js";
import { layeredConfineList, layeredMainHomeReads } from "../../core/settings-layers.js";
import { type McpClientOptions, McpError } from "../../domains/gateway/mcp/index.js";
import { effectiveScratchRoots } from "../../lib/scratch-roots/scratch-roots.js";
import type { GatewayMcpServer, McpCapabilitySourceOptions, ServerState } from "./mcp-capability-types.js";

/** Where one stdio server's process runs, or why it may not start at all. */
export type McpLaunchDecision = OptInLaunch;

export interface McpLaunchPlanner {
	/** The decision for a local stdio server; null for a remote one, which PanCode does not launch. */
	decide(declaration: GatewayMcpServer): McpLaunchDecision | null;
	/** What the approval card says about where the server runs, or null when PanCode does not launch it. */
	cardNote(declaration: GatewayMcpServer, state: ServerState): string | null;
	/** The client options that place a server about to start, recording its label and settled launch on `state`. */
	clientLaunch(declaration: GatewayMcpServer, state: ServerState): Partial<McpClientOptions>;
}

/** Discovery's words for where a launched server runs. */
export function launchConfinement(decision: McpLaunchDecision | null): string {
	if (decision === null) return "PanCode does not launch it";
	return "refused" in decision ? `it does not start: ${decision.refused}` : `it ${hostLaunchPhrase(decision.label)}`;
}

export function createMcpLaunchPlanner(
	options: Pick<McpCapabilitySourceOptions, "admitted" | "confine" | "cwd" | "launchRoot">,
): McpLaunchPlanner {
	// Without a session accessor (`pancode mcp`) the layered settings are read once; unreadable ones confine nothing.
	let settingsConfine: ReadonlyArray<string> | undefined;
	const confineList = (): ReadonlyArray<string> => {
		if (options.admitted !== undefined) return [];
		if (options.confine !== undefined) return options.confine();
		settingsConfine ??= layeredConfineList(options.cwd);
		return settingsConfine;
	};
	const decide = (declaration: GatewayMcpServer): McpLaunchDecision | null => {
		if (declaration.url !== undefined) return null;
		const integration = `mcp:${declaration.id}` as const;
		if (options.admitted !== undefined) {
			return workerSandboxApplies()
				? { label: sandboxedLabel("mcp-stdio", "worker-policy", integration), confined: false }
				: { label: uncontainedLabel("mcp-stdio", "unconfined-opt-in", integration), confined: false };
		}
		return optInLaunch("mcp-stdio", integration, confineList());
	};
	const confinedPolicy = (declaration: GatewayMcpServer): MainSandboxPolicy => {
		const trust = declaration.trust.status === "trusted" ? declaration.trust : undefined;
		const allow = trust?.allow ?? [];
		const workspace = options.launchRoot ?? options.cwd;
		return confinedIntegrationPolicy({
			workspace,
			scratchRoots: effectiveScratchRoots([], workspace),
			stateDirs: declaration.plugin !== undefined ? [declaration.plugin.dataDir] : [],
			network:
				allow.length > 0
					? {
							allow,
							denyHint: `the operator grants it with pancode mcp trust ${declaration.id} --allow <host:port>`,
						}
					: trust?.network === true
						? "open"
						: "off",
			homeReads: layeredMainHomeReads(workspace),
		});
	};
	return {
		decide,
		cardNote(declaration, state) {
			const decision = state.launchLabel !== undefined ? { label: state.launchLabel } : decide(declaration);
			if (decision === null) return null;
			return `mcp server ${declaration.id} ${"refused" in decision ? `does not start: ${decision.refused}` : hostLaunchPhrase(decision.label)}`;
		},
		clientLaunch(declaration, state) {
			const decision = decide(declaration);
			if (decision === null) return {};
			if ("refused" in decision) {
				throw new McpError("spawn", `mcp server ${declaration.id} failed to start: ${decision.refused}`);
			}
			state.launchLabel = decision.label;
			return {
				...(decision.confined ? { hostSandbox: confinedPolicy(declaration) } : {}),
				launch: {
					label: decision.label,
					onSettled: (record: SandboxLaunchRecord) => {
						state.launchRecord = record;
					},
				},
			};
		},
	};
}
