// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import {
	HubAgents,
	HubApplyResult,
	HubPlan,
	HubPlanReleased,
	type HubPlanRequest,
	HubVerifiers,
} from "../../contracts/hub.js";
import type { WorkerHost } from "../worker/host.js";
import type { CliRunner } from "./cli-runner.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

function checked<S extends TSchema>(schema: S, raw: unknown): Static<S> {
	const value = Value.Clean(schema, raw);
	if (!Value.Check(schema, value)) throw new AppProblem("unavailable", "The hub returned an invalid projection.");
	return value;
}
export class HubService {
	constructor(
		private readonly reads: WorkerHost,
		private readonly runner: CliRunner,
		private readonly workspaces: WorkspaceService,
		private readonly ops: WorkerHost,
	) {}
	/** Staging may clone a pinned GitHub tree, which the root transport bounds at 120 s. */
	/** With no workspace open (`null`) the hub reads from a neutral folder, so only user and built-in layers apply. */
	private async cwd(workspaceId: string | null) {
		return workspaceId === null ? this.workspaces.installationPath() : (await this.workspaces.get(workspaceId)).path;
	}
	async plan(workspaceId: string | null, request: Static<typeof HubPlanRequest>) {
		if (workspaceId === null && request.scope !== "user")
			throw new AppProblem("validation", "With no workspace open, the hub can change only your user copies.");
		const cwd = await this.cwd(workspaceId);
		return checked(HubPlan, await this.ops.call("hub.plan", { cwd, request }, { deadlineMs: 150_000 }));
	}
	async apply(workspaceId: string | null, planId: string) {
		const cwd = await this.cwd(workspaceId);
		return checked(HubApplyResult, await this.ops.call("hub.apply", { cwd, planId }, { deadlineMs: 60_000 }));
	}
	async release(workspaceId: string | null, planId: string) {
		const cwd = await this.cwd(workspaceId);
		return checked(HubPlanReleased, await this.ops.call("hub.release", { cwd, planId }));
	}
	async read<S extends TSchema>(workspaceId: string | null, kind: "inventory" | "extensions", schema: S) {
		const cwd = await this.cwd(workspaceId);
		return checked(schema, await this.reads.call("hub.read", { kind, cwd }, { deadlineMs: 20_000 }));
	}
	async agents(workspaceId: string | null) {
		const raw = await this.runner.run({ kind: "hub.agents" }, await this.cwd(workspaceId));
		if (!Array.isArray(raw) || raw.length > 2000)
			throw new AppProblem("unavailable", "Agent inventory is invalid or exceeds 2,000 rows.");
		const agents = (raw as unknown[]).map((value) => {
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw new AppProblem("unavailable", "Invalid agent row.");
			const { id, name, description, source, audience, category, skills, tools, ...configuration } = value as Record<
				string,
				unknown
			>;
			return { id, name, description, source, audience, category, skills, tools, configuration };
		});
		return checked(HubAgents, { agents });
	}
	async verifiers(workspaceId: string) {
		const workspace = await this.workspaces.get(workspaceId);
		return checked(HubVerifiers, await this.runner.run({ kind: "hub.verifiers" }, workspace.path));
	}
}
