// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Value } from "typebox/value";
import { ConfigGraph, SettingsReport } from "../../contracts/settings.js";
import { SettingsControls, type SettingWrite, SettingWritten } from "../../contracts/settings-controls.js";
import type { WorkerHost } from "../worker/host.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

/** The setting that bounds how many turns the app runs at once; the supervisor reads it. */
const TURN_CAPACITY_SETTING = "interface.guiTurnCapacity";
/** The effective turn limit in a controls projection, or undefined when the projection does not carry it. */
export function turnCapacitySetting(controls: SettingsControls): number | undefined {
	const control = controls.controls.find((entry) => entry.path === TURN_CAPACITY_SETTING);
	return control ? Number(control.value) : undefined;
}

export class SettingsService {
	constructor(
		private readonly reads: WorkerHost,
		private readonly workspaces: WorkspaceService,
		private readonly ops?: WorkerHost,
		/** Told when a write changes the turn limit; the write is acknowledged only after it settles. */
		private readonly turnCapacityChanged?: () => Promise<void>,
	) {}
	/** Controls as they resolve for `cwd`, which the app server uses for its own settings at startup. */
	async controlsAt(cwd: string) {
		return this.readControls({ cwd });
	}
	/** The workspace's layered controls, or the user layer alone when none is named. */
	async controls(workspaceId?: string) {
		return this.readControls(await this.scope(workspaceId));
	}
	private async readControls(scope: { cwd?: string }) {
		const report = await this.reads.call("settings.controls", scope);
		if (!Value.Check(SettingsControls, report))
			throw new AppProblem("unavailable", "Settings controls returned an invalid projection.");
		return report;
	}
	/** No workspace means no project layers: the read and the write see the user layer alone. */
	private async scope(workspaceId?: string): Promise<{ cwd?: string }> {
		return workspaceId === undefined ? {} : { cwd: (await this.workspaces.get(workspaceId)).path };
	}
	/** Writes are serial in the ops lane and land in the user layer only. */
	async write(workspaceId: string | undefined, write: SettingWrite) {
		if (!this.ops) throw new AppProblem("unsupported", "This server was started without a settings writer.");
		const result = await this.ops.call("settings.write", { ...(await this.scope(workspaceId)), write });
		if (!Value.Check(SettingWritten, result))
			throw new AppProblem("unavailable", "Settings write returned an invalid projection.");
		// The next turn after a 200 must already see the new limit, so the supervisor is updated first.
		if (result.changed.some((row) => row.path === TURN_CAPACITY_SETTING)) await this.turnCapacityChanged?.();
		return result;
	}
	async settings(workspaceId?: string) {
		const report = await this.reads.call("settings.read", await this.scope(workspaceId));
		if (!Value.Check(SettingsReport, report))
			throw new AppProblem("unavailable", "Settings returned an invalid projection.");
		return report;
	}
	/** `null` reads the graph where no project layer applies. */
	async graph(workspaceId: string | null) {
		const cwd =
			workspaceId === null ? await this.workspaces.installationPath() : (await this.workspaces.get(workspaceId)).path;
		const report = await this.reads.call("config.graph", { cwd }, { deadlineMs: 15_000 });
		if (!Value.Check(ConfigGraph, report))
			throw new AppProblem("unavailable", "Configuration inspection returned an invalid projection.");
		return workspaceId === null ? withoutProjectLayers(report) : report;
	}
}

/**
 * With no workspace open the graph is read at the installation's own directory, which is not a project, so the
 * project-scoped roots it finds there are dropped rather than counted as a project's (gui-verify 8).
 */
function withoutProjectLayers(graph: ConfigGraph): ConfigGraph {
	const entries = graph.entries.filter((entry) => !entry.scope.startsWith("project"));
	return { ...graph, categories: [...new Set(entries.map((entry) => entry.category))].sort(), entries };
}
