// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { AcpFleetControl } from "../../acp/fleet-run.js";
import { agentRoleFactsResolver } from "../../domains/dispatch/execution-role.js";
import type { FleetRunLauncher } from "../../domains/dispatch/fleet-run-launcher.js";
import { compileFleetRunPreview, fleetRouteResolver } from "../../domains/dispatch/index.js";
import type { BootSurfaceInput } from "./surface.js";

/** What acpFleetControl reads from runAcpSurface. */
export type AcpFleetControlInput = Pick<BootSurfaceInput, "chat" | "dispatch" | "result"> & {
	agents: NonNullable<BootSurfaceInput["agents"]>;
	/** The session's fleet runs: its single-run guard, root record and sealed result. */
	launcher: FleetRunLauncher;
};

const log = (text: string): void => {
	process.stderr.write(`[pancode:acp] ${text}\n`);
};

/**
 * An ACP session's `/fleet run` approval, split across preview and run, compiled through the dispatch domain as the
 * terminal overlay compiles it and started through the session's fleet launcher.
 */
export function acpFleetControl(input: AcpFleetControlInput): AcpFleetControl {
	const { agents, chat, dispatch, launcher, result } = input;
	return {
		preview: (name: string, vars: Readonly<Record<string, string>>, resume?: string) => {
			const roleFacts = agentRoleFactsResolver((id: string) => agents.getSpec(id));
			const budget = result.getContract("scheduling")?.preflight();
			return compileFleetRunPreview({
				workspaceRoot: process.cwd(),
				name,
				vars,
				getAgentSpec: (agentId) => agents.getSpec(agentId),
				roleFacts,
				...(budget ? { budget } : {}),
				...(resume !== undefined ? { resume } : {}),
				resolveRoute: fleetRouteResolver(dispatch.preview, roleFacts, undefined, chat.toolLimits?.()),
			});
		},
		run: async (preview, turnConstraints) => {
			// Progress reaches the client as dispatch events; stderr keeps the operator's trace.
			const launch = launcher.launch({
				preview,
				origin: "operator",
				...(turnConstraints !== undefined ? { turnConstraints } : {}),
				observer: {
					stepSettled: (_rootId, step) =>
						log(
							`fleet ${preview.name}: step ${step.stepId} ${step.succeeded ? "succeeded" : "failed"}${step.failureReason !== undefined ? ` reason=${step.failureReason}` : ""}`,
						),
					notice: (text) => log(`fleet ${preview.name}: ${text}`),
				},
			});
			if (launch.status === "refused") return { status: "refused", reason: launch.reason };
			// A run that ends before its first step answers the request with why, as the terminal's notice does.
			const admission = await launch.admitted;
			if (admission.status === "refused") return { status: "refused", reason: admission.reason };
			if (admission.status === "failed") return { status: "failed", fleetRootId: launch.rootId, reason: admission.reason };
			void launch.settled.then((settled) => {
				if (!settled.ok) {
					log(
						`fleet ${preview.name} failed: ${settled.error instanceof Error ? settled.error.message : String(settled.error)}`,
					);
				}
			});
			return { status: "started", fleetRootId: launch.rootId };
		},
	};
}
