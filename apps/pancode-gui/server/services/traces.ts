// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Static, TSchema } from "typebox";
import type { TraceRequest } from "../../contracts/traces.js";
import type { WorkerHost } from "../worker/host.js";
import { projected } from "./problem.js";

export class TraceService {
	constructor(private readonly reads: WorkerHost) {}
	async read<S extends TSchema>(input: TraceRequest, schema: S): Promise<Static<S>> {
		const raw = await this.reads.call("traces.read", input);
		// Explicit closed schemas are the public projection: unknown ledger or record fields cannot escape.
		const value = projected(schema, raw, "unavailable", "Trace storage returned an invalid record.");
		// The saved document leaves only when asked for; by default the record is its evidence alone.
		if (input.kind === "run-record" && !input.full && value && typeof value === "object" && "record" in value)
			Reflect.set(value, "record", null);
		return value;
	}
}
