// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomBytes } from "node:crypto";
import type { AcpFleetControl } from "../../acp/fleet-run.js";
import { agentRoleFactsResolver } from "../../domains/dispatch/execution-role.js";
import {
	compileFleetRunPreview,
	executeFleetRun,
	fleetAdmissionRefusal,
	fleetRouteResolver,
} from "../../domains/dispatch/index.js";
import type { BootSurfaceInput } from "./surface.js";

/** What acpFleetControl reads from runAcpSurface. */
export type AcpFleetControlInput = Pick<
	BootSurfaceInput,
	"chat" | "decisionBoard" | "dispatch" | "getCurrentSettings" | "result"
> & {
	agents: NonNullable<BootSurfaceInput["agents"]>;
};

/** The let runAcpSurface still owns, read and written live. */
export interface AcpFleetCell {
	acpFleetInFlight: { name: string; fleetRootId: string } | null;
}

/**
 * An ACP session's `/fleet run` approval, split across preview and run, compiled through the dispatch domain as the
 * terminal overlay compiles it. `cell.acpFleetInFlight` is the single-run guard runAcpSurface owns.
 */
export function acpFleetControl(input: AcpFleetControlInput, cell: AcpFleetCell): AcpFleetControl {
	const { agents, chat, decisionBoard, dispatch, getCurrentSettings, result } = input;
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
		run: (preview, turnConstraints) =>
			new Promise((resolve) => {
				if (cell.acpFleetInFlight !== null) {
					// No root is minted for a run that never starts; the running
					// root is named in the reason, not reported as this run's id.
					resolve({
						status: "refused",
						reason: `fleet ${cell.acpFleetInFlight.name} (root=${cell.acpFleetInFlight.fleetRootId}) is still running; a new fleet run is refused until it settles. Nothing was dispatched`,
					});
					return;
				}
				const admissionRefusal = fleetAdmissionRefusal();
				if (admissionRefusal !== null) {
					resolve({ status: "refused", reason: `${admissionRefusal}. Nothing was dispatched` });
					return;
				}
				const fleetRootId = `fleet-${randomBytes(6).toString("hex")}`;
				// Read before the single-run guard is taken: a throw here would
				// otherwise leave it set and refuse every later fleet run.
				const fleetSettings = getCurrentSettings();
				const attributionEnabled = fleetSettings.integrations.git.commitAttribution;
				cell.acpFleetInFlight = { name: preview.name, fleetRootId };
				let admitted = false;
				let started = false;
				let admissionCap: ReturnType<typeof setTimeout> | undefined;
				const admit = () => {
					if (admitted) return;
					admitted = true;
					clearTimeout(admissionCap);
					resolve({ status: "started", fleetRootId });
				};
				// A first step that waits on proposals or endpoint capacity is running, not
				// failed; the answer stops waiting before a client's own deadline does. The
				// cap starts with the run, so a slow workspace lock never reads as started.
				const onStarted = () => {
					started = true;
					admissionCap = setTimeout(admit, 30_000);
					admissionCap.unref?.();
				};
				const refuse = (reason: string) => {
					if (admitted) return false;
					admitted = true;
					clearTimeout(admissionCap);
					resolve({ status: "failed", fleetRootId, reason });
					return true;
				};
				// Progress reaches the client as dispatch events; a run that ends before its
				// first step answers the request with why, as the terminal's notice does.
				void executeFleetRun({
					plan: preview.plan,
					playbookName: preview.name,
					commands: preview.commands,
					workspaceRoot: process.cwd(),
					fleetRootId,
					dispatch,
					agents: { getSpec: (agentId) => agents.getSpec(agentId) },
					getDecisionBoard: () => decisionBoard.snapshot(),
					attributionEnabled,
					settings: fleetSettings,
					vars: preview.vars,
					...(preview.resume !== undefined
						? { resume: { record: preview.resume.record, replayed: preview.resume.replayed } }
						: {}),
					...(turnConstraints !== undefined ? { turnConstraints } : {}),
					onStarted,
					onStepDispatched: admit,
					onNotice: (text) => process.stderr.write(`[pancode:acp] fleet ${preview.name}: ${text}\n`),
				})
					.then(
						(outcome) => {
							refuse(
								`the run ended before dispatching a step: ${outcome.succeededStepCount}/${outcome.requiredStepCount} steps succeeded`,
							);
						},
						(error: unknown) => {
							const message = error instanceof Error ? error.message : String(error);
							// The run never started: another process's fleet holds this
							// workspace, the lock timed out, the birth token was missing, or
							// admission refused its reservation. The minted id is not reported.
							if (!started && !admitted) {
								admitted = true;
								clearTimeout(admissionCap);
								resolve({ status: "refused", reason: message });
								return;
							}
							if (!refuse(message)) process.stderr.write(`[pancode:acp] fleet ${preview.name} failed: ${message}\n`);
						},
					)
					.finally(() => {
						cell.acpFleetInFlight = null;
					});
			}),
	};
}
