// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { PancodeSettings } from "../../core/config.js";
import type { DomainContractMap } from "../../core/domain-contracts.js";
import type { LoadResult } from "../../core/domain-loader.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import type { AgentsContract } from "../../domains/agents/contract.js";
import type { DispatchContract } from "../../domains/dispatch/contract.js";
import { agentRoleFactsResolver } from "../../domains/dispatch/execution-role.js";
import { createFleetRunLauncher, type FleetRunLauncher } from "../../domains/dispatch/fleet-run-launcher.js";
import {
	compileFleetRunPreview,
	type FleetRunPreviewResult,
	fleetRouteResolver,
} from "../../domains/dispatch/index.js";
import type { SessionContract } from "../../domains/session/contract.js";
import type { DecisionBoardStore } from "../../domains/session/decision-board.js";
import type { DispatchPlaybookPort } from "../../tools/dispatch-playbook.js";

export interface SessionFleetRunsInput {
	agents: AgentsContract | undefined;
	decisionBoard: DecisionBoardStore;
	dispatch: DispatchContract;
	getCurrentSettings: () => PancodeSettings;
	result: LoadResult<DomainContractMap>;
	session: SessionContract | undefined;
	/** The main agent's standing tool limits, which route each step as the run will. Read at compile time. */
	toolLimits: () => TurnConstraints | undefined;
	/** False when the process ends with the turn (headless), so a model-started run stays attached. */
	detachable: boolean;
}

export interface SessionFleetRuns {
	/** The one launcher every surface and the main agent start this session's runs through. */
	readonly launcher: FleetRunLauncher;
	/** Compile a playbook as this session's `/fleet run` does; `resume` continues a stopped root. */
	readonly preview: (name: string, vars: Readonly<Record<string, string>>, resume?: string) => FleetRunPreviewResult;
	readonly playbooks: DispatchPlaybookPort;
}

/**
 * The session a launch binds. A terminal session opens on its first entry, so a `/fleet run` typed before any turn
 * opens it here, as that entry would, instead of running unbound.
 */
export function launchSessionId(session: SessionContract | undefined, settings: PancodeSettings): string | null {
	if (!session) return null;
	const current = session.current();
	if (current) return current.id;
	const { connection, model } = settings.chat;
	return session.create({
		cwd: process.cwd(),
		...(connection ? { target: connection } : {}),
		...(model ? { model } : {}),
	}).id;
}

/**
 * The session's fleet runs: one launcher holds the single-run guard, the durable root and the sealed result for the
 * operator's `/fleet run` on any surface and the main agent's `dispatch(playbook=...)`. Absent without agents.
 */
export function createSessionFleetRuns(input: SessionFleetRunsInput): SessionFleetRuns | null {
	const { agents, decisionBoard, dispatch, getCurrentSettings, result, session } = input;
	if (!agents) return null;
	const workspaceRoot = (): string => session?.current()?.cwd ?? process.cwd();
	const launcher = createFleetRunLauncher({
		dispatch,
		agents: { getSpec: (agentId) => agents.getSpec(agentId) },
		workspaceRoot,
		getSettings: getCurrentSettings,
		getDecisionBoard: () => decisionBoard.snapshot(),
		sessionId: () => launchSessionId(session, getCurrentSettings()),
	});
	const preview = (name: string, vars: Readonly<Record<string, string>>, resume?: string): FleetRunPreviewResult => {
		const roleFacts = agentRoleFactsResolver((id: string) => agents.getSpec(id));
		const budget = result.getContract("scheduling")?.preflight();
		return compileFleetRunPreview({
			workspaceRoot: workspaceRoot(),
			name,
			vars,
			getAgentSpec: (agentId) => agents.getSpec(agentId),
			roleFacts,
			...(budget ? { budget } : {}),
			...(resume !== undefined ? { resume } : {}),
			resolveRoute: fleetRouteResolver(dispatch.preview, roleFacts, undefined, input.toolLimits()),
		});
	};
	return {
		launcher,
		preview,
		playbooks: { launcher, workspaceRoot, preview: (name, vars) => preview(name, vars), detachable: input.detachable },
	};
}
