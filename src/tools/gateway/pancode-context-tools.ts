// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { ToolNames } from "../../core/tool-names.js";
import type { LoadSkillsInput } from "../../domains/resources/index.js";
import { runDocsScope } from "../context/index.js";
import {
	commitObservationReservation,
	OBSERVE_SELF_CAPS,
	observationBudgetExhausted,
	releaseObservation,
	reserveObservation,
} from "../observation.js";
import type { ToolResult, ToolSpec } from "../tool-spec.js";
import { pancodeDocsToolSurface, pancodeHubToolSurface } from "./pancode-context-surface.js";

export { pancodeDocsToolSurface, pancodeHubToolSurface } from "./pancode-context-surface.js";

/**
 * The two PanCode-internal reads that left the permanent `context` schema:
 * `pancode_docs` (bundled documentation) and `pancode_hub` (the recipe catalog).
 * Each is the former context scope under its own name, reusing the scope
 * function unchanged, so what the gateway returns is exactly what
 * context(scope="docs"|"hub") returned.
 */

export function createPancodeDocsTool(): ToolSpec {
	return {
		...pancodeDocsToolSurface,
		async run(args, options): Promise<ToolResult> {
			const reservation = reserveObservation(OBSERVE_SELF_CAPS.contextDocs, options);
			if (reservation.exhausted) {
				return observationBudgetExhausted({
					tool: ToolNames.PancodeDocs,
					unit: "sections",
					reservation,
					subject: typeof args.query === "string" && args.query.length > 0 ? `query=${args.query}` : "corpus",
					hint: "Continue in a follow-up turn.",
				});
			}
			return runDocsScope(args, reservation, options, ToolNames.PancodeDocs);
		},
	};
}

export interface PancodeHubToolDeps {
	getCwd?: () => string;
	/** False on every worker registry: the read refuses there, as the context scope did. */
	skillMarketplace?: boolean;
	getSkillLoaderOptions?: () => Pick<
		LoadSkillsInput,
		"trustProjectCompatRoots" | "disableDiscovery" | "explicitSkillPaths"
	>;
}

export function createPancodeHubTool(deps: PancodeHubToolDeps = {}): ToolSpec {
	return {
		...pancodeHubToolSurface,
		async run(args, options): Promise<ToolResult> {
			// Reserved before the inventory is walked, so an exhausted pool answers
			// with the notice and no catalog read happens for nothing.
			const reservation = reserveObservation(OBSERVE_SELF_CAPS.contextHub, options);
			if (reservation.exhausted) {
				return observationBudgetExhausted({
					tool: ToolNames.PancodeHub,
					unit: "entries",
					reservation,
					subject: "catalog",
					hint: "Continue in a follow-up turn.",
				});
			}
			// The import and the inventory walk await, so parallel siblings must see this
			// spend now; finalize reconciles it and the finally block refunds an early exit.
			commitObservationReservation(reservation);
			try {
				const { runHubScope } = await import("../context/hub.js");
				return await runHubScope(
					{
						getCwd: () => deps.getCwd?.() ?? process.cwd(),
						...(deps.skillMarketplace !== undefined ? { skillMarketplace: deps.skillMarketplace } : {}),
						...(deps.getSkillLoaderOptions ? { skillLoaderOptions: deps.getSkillLoaderOptions() } : {}),
					},
					args,
					reservation,
					options,
					ToolNames.PancodeHub,
				);
			} finally {
				releaseObservation(reservation);
			}
		},
	};
}
