// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Value } from "typebox/value";
import type { MachineMutation } from "../../contracts/machines.js";
import { Machines } from "../../contracts/machines.js";
import type { WorkerHost } from "../worker/host.js";
import type { OperationRegistry } from "./operations.js";
import { fingerprint } from "./operations.js";
import { AppProblem } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

/** What a registry change tells the attach supervisor. */
export interface AttachmentRegistryListener {
	forget(id: string): void;
}

export class MachinesService {
	constructor(
		private readonly reads: WorkerHost,
		private readonly ops: WorkerHost,
		private readonly workspaces: WorkspaceService,
		private readonly operations: OperationRegistry,
		private readonly attachments?: AttachmentRegistryListener,
	) {}

	async list(workspaceId: string | null): Promise<Machines> {
		const workspace = workspaceId === null ? null : await this.workspaces.get(workspaceId);
		const cwd = workspace?.path ?? (await this.workspaces.installationPath());
		const machines = await this.reads.call("machines.list", { cwd }, { deadlineMs: 65_000 });
		const result = {
			workspaceId,
			projectRoot: workspace?.path ?? null,
			observedAt: new Date().toISOString(),
			// Readiness is recorded per project; with none open no record applies.
			nodes:
				workspace === null
					? machines.map((machine) => ({
							...machine,
							readiness: "not checked" as const,
							reason: null,
							checkedAt: null,
							ageMs: null,
							checks: null,
							localVersion: null,
							remoteVersion: null,
							note: null,
							project: null,
						}))
					: machines,
		};
		if (!Value.Check(Machines, result)) throw new AppProblem("unavailable", "Invalid node inventory.");
		return result;
	}

	async mutate(workspaceId: string | null, mutation: MachineMutation, key: string) {
		if (workspaceId === null && mutation.action === "check")
			throw new AppProblem("validation", "Readiness is checked for one project. Open a workspace to check this node.");
		const workspace = workspaceId === null ? null : await this.workspaces.get(workspaceId);
		const cwd = workspace?.path ?? (await this.workspaces.installationPath());
		return this.operations.create({
			kind: `nodes.${mutation.action}`,
			scope: workspaceId ?? "installation",
			key,
			fingerprint: fingerprint({ workspaceId, mutation }),
			run: async (progress) => {
				progress(
					mutation.action === "check"
						? `Checking and recording SSH readiness for ${cwd}.`
						: "Updating the user fleet-node registry.",
				);
				const result = await this.ops.call("machines.mutate", { cwd, mutation }, { progress });
				// A node that left the registry is no longer a place this app may reach.
				if (mutation.action === "remove") this.attachments?.forget(mutation.id);
				return result;
			},
		});
	}
}
