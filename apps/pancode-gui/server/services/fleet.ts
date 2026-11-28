// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Static, TSchema } from "typebox";
import type { FleetRequest } from "../../contracts/fleet.js";
import type { WorkerHost } from "../worker/host.js";
import { projected } from "./problem.js";

export class FleetService {
	constructor(private readonly reads: WorkerHost) {}
	async read<S extends TSchema>(input: FleetRequest, schema: S): Promise<Static<S>> {
		const raw = await this.reads.call("fleet.read", input);
		return projected(schema, raw, "unavailable", "Fleet storage returned an invalid projection.");
	}
}
