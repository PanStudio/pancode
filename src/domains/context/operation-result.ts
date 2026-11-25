// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ContextOperationFact } from "../../core/context-operation.js";
import type { RunBootstrapResult } from "./bootstrap-types.js";
import type { RunContextClearResult } from "./clear.js";
import type { RunContextRefreshResult } from "./refresh.js";

export function bootstrapOperationFacts(result: RunBootstrapResult): ContextOperationFact[] {
	const { summary } = result;
	const read = [...new Set([...summary.contextFileNames, ...summary.evidenceFileNames])];
	const facts: ContextOperationFact[] =
		read.length > 0 ? [{ kind: "read", unit: "paths", count: read.length, paths: read }] : [];
	if (Number.isSafeInteger(summary.codewikiEntries) && summary.codewikiEntries >= 0)
		facts.push({ kind: "indexed", unit: "source-files", count: summary.codewikiEntries });
	if (summary.action === "previewed") return facts;
	facts.push({
		kind:
			summary.action === "wrote" || summary.action === "proposed"
				? "created"
				: summary.action === "refreshed"
					? "updated"
					: "preserved",
		unit: "paths",
		count: 1,
		paths: [summary.proposalPath ?? "PANCODE.md"],
	});
	if (summary.action === "proposed") facts.push({ kind: "preserved", unit: "paths", count: 1, paths: ["PANCODE.md"] });
	if (summary.adoption.mode === "adopt")
		facts.push({ kind: "ingested", unit: "rules", count: summary.adoption.importedRuleCount });
	if (summary.adoption.rejectedCount)
		facts.push({ kind: "omitted", unit: "paths", count: summary.adoption.rejectedCount });
	return facts;
}
export function refreshOperationFacts(result: RunContextRefreshResult): ContextOperationFact[] {
	return [
		{ kind: "indexed", unit: "source-files", count: result.codewikiEntries },
		...(result.pancodeMd === "unchanged"
			? [{ kind: "preserved" as const, unit: "paths" as const, count: 1, paths: ["PANCODE.md"] }]
			: []),
	];
}
export function clearOperationFacts(result: RunContextClearResult): ContextOperationFact[] {
	return [
		{ kind: "removed", unit: "paths", count: result.removed.length, paths: result.removed },
		...(result.preservedExisting
			? [
					{
						kind: "preserved" as const,
						unit: "paths" as const,
						count: result.preservedExisting.length,
						paths: result.preservedExisting,
					},
				]
			: []),
	];
}

/** Cancellation can stop a later phase after an earlier transaction committed. */
export class ContextOperationAbortError extends Error {
	override readonly name = "AbortError";
	constructor(
		message: string,
		readonly facts: readonly ContextOperationFact[],
	) {
		super(message);
	}
}
