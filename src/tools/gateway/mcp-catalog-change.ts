// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { McpServerCatalog, McpToolListing } from "../../domains/gateway/mcp/index.js";
import type { ToolResult } from "../tool-spec.js";
import type { ServerState } from "./mcp-capability-types.js";

const CATALOG_HINT_KEYS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** A tool in the shape a recorded catalog keeps, so a live and a cached descriptor compare like for like. */
function recordedShape(tool: { description: string; annotations?: Record<string, unknown> | null }): string {
	const hints = CATALOG_HINT_KEYS.flatMap((key) =>
		typeof tool.annotations?.[key] === "boolean" ? [[key, tool.annotations[key]]] : [],
	);
	return JSON.stringify([tool.description, hints]);
}

/**
 * One line naming what a server's live listing changed since the catalog it
 * recorded, or null when nothing did. The recorded catalog is keyed on the
 * declaration, which a server upgrade leaves unchanged (K9), so a find or
 * describe earlier in the session may have shown the model the old schema.
 */
export function catalogChangeLine(id: string, recorded: McpServerCatalog, live: McpToolListing): string | null {
	const before = new Map(recorded.tools.map((tool) => [tool.name, tool]));
	const after = new Map(live.tools.map((tool) => [tool.name, tool]));
	const schema: string[] = [];
	const other: string[] = [];
	const added: string[] = [];
	for (const [name, tool] of after) {
		const old = before.get(name);
		if (old === undefined) {
			// A partial recording cannot say a tool beyond its cut is new.
			if (!recorded.truncated) added.push(name);
		} else if (JSON.stringify(old.inputSchema) !== JSON.stringify(tool.inputSchema)) schema.push(name);
		else if (recordedShape(old) !== recordedShape(tool)) other.push(name);
	}
	const removed = live.truncated ? [] : [...before.keys()].filter((name) => !after.has(name));
	const named = (names: string[], what: string): string[] => {
		if (names.length === 0) return [];
		const shown = names.slice(0, 3).join(", ");
		return [`${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ""} ${what}`];
	};
	const parts = [
		...named(schema, "schema changed"),
		...named(other, "changed"),
		...named(added, "added"),
		...named(removed, "removed"),
	];
	if (parts.length === 0) return null;
	const describable = schema.length + other.length + added.length;
	const again = describable === 0 ? "" : `; describe ${describable === 1 ? "it" : "them"} again`;
	return `${id} catalog changed since recorded: ${parts.join("; ")}${again}`;
}

/**
 * Put a pending catalog change line ahead of an error message, where a bounded
 * result never cuts it. A successful output stays the server's bytes, because a
 * chain binds it as data; the line waits for the call that a stale schema fails.
 */
export function withCatalogChange(state: ServerState, result: ToolResult): ToolResult {
	const line = state.catalogChange;
	if (line === undefined || result.kind !== "error") return result;
	delete state.catalogChange;
	return { ...result, message: `${line}\n${result.message}` };
}

/** The one call that fills a missing catalog, named so the model does not guess at a broader one. */
export function catalogRemedy(id: string): string {
	return `gateway(op="find", server="${id}", refresh=true)`;
}
