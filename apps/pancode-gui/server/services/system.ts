// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { Interop, InteropDecided, SystemReport } from "../../contracts/system.js";
import type { WorkerHost } from "../worker/host.js";
import { projected } from "./problem.js";
import type { WorkspaceService } from "./workspaces.js";

export class SystemService {
	constructor(
		private readonly reads: WorkerHost,
		private readonly workspaces: WorkspaceService,
		private readonly ops: WorkerHost,
	) {}
	async decideInterop(workspaceId: string | null, kind: string, decision: "accept" | "decline") {
		const cwd = await this.workspaces.cwd(workspaceId);
		return projected(
			InteropDecided,
			await this.ops.call("interop.decide", { cwd, kind, decision }, { deadlineMs: 25_000 }),
			"unavailable",
			"The interop decision returned an invalid projection.",
		);
	}
	async report() {
		return projected(
			SystemReport,
			await this.reads.call("system.read", {}),
			"unavailable",
			"System inspection returned an invalid projection.",
		);
	}
	async interop(workspaceId: string | null, probe = false) {
		const cwd = await this.workspaces.cwd(workspaceId);
		return projected(
			Interop,
			await this.reads.call("interop.read", { cwd, probe }, { deadlineMs: 25_000 }),
			"unavailable",
			"External agent inspection returned an invalid projection.",
		);
	}
}
