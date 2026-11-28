// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The tool surface an MCP server serves, as the operator approves it. Launch
 * trust says a declaration may run; it says nothing about the tools the process
 * then offers, and a server upgrade can add a tool or widen a schema without
 * touching the declaration. The surface digest is the second approval: a
 * launch-trusted server's tools are callable only while the surface it serves
 * hashes to the digest the operator approved.
 */

import { canonicalJson } from "../../core/canonical-json.js";
import { sha256Hex } from "../../core/hash.js";
import type { McpToolDescriptor } from "./tool-results.js";

/** The fields of one served tool that its approval covers. */
export type McpSurfaceTool = Pick<McpToolDescriptor, "name" | "inputSchema"> & {
	annotations?: Record<string, unknown> | null;
	/** Accepted and left out of the digest. */
	title?: string | null;
	/** Accepted and left out of the digest. */
	description?: string;
};

/** A served surface: its digest, and each tool's own digest so a change can be named tool by tool. */
export interface McpSurface {
	digest: string;
	/**
	 * Tool name to the first 16 hex characters of that tool's SHA-256. Only the
	 * surface digest decides approval; these exist to say what changed.
	 */
	tools: Record<string, string>;
}

/** How a launch-trusted server's surface stands against the operator's approval. */
export interface McpSurfaceStatus {
	status: "approved" | "unapproved" | "changed";
	/** The digest of the surface the server serves, or null when it was not listed. */
	digest: string | null;
	/** The approved digest, or null when none is recorded. */
	approvedDigest: string | null;
	/** Why calls are refused, for every status but approved. */
	reason?: string;
}

function canonicalTool(tool: McpSurfaceTool): string {
	return canonicalJson({ name: tool.name, inputSchema: tool.inputSchema, annotations: tool.annotations ?? null });
}

/**
 * The digest of a served tool surface: SHA-256 over the canonical JSON of the
 * tools sorted by name, each as its name, input schema and annotations (object
 * keys sorted, an absent annotations object as null). Descriptions and titles
 * are left out on purpose, so a wording change does not withdraw the operator's
 * approval; what a tool accepts and what it says about its own effects do.
 */
export function mcpSurfaceDigest(tools: ReadonlyArray<McpSurfaceTool>): string {
	const sorted = [...tools].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	return sha256Hex(`[${sorted.map(canonicalTool).join(",")}]`);
}

/** The surface of one listing: its digest and each tool's short digest. */
export function mcpSurface(tools: ReadonlyArray<McpSurfaceTool>): McpSurface {
	return {
		digest: mcpSurfaceDigest(tools),
		tools: Object.fromEntries(tools.map((tool) => [tool.name, sha256Hex(canonicalTool(tool)).slice(0, 16)])),
	};
}

/** The command that approves a launch-trusted server's surface. */
export function mcpSurfaceRemedy(id: string): string {
	return `pancode mcp trust ${id} --surface`;
}

function named(names: string[], what: string): string[] {
	if (names.length === 0) return [];
	const shown = names.slice(0, 5).join(", ");
	return [`${what}: ${shown}${names.length > 5 ? ` and ${names.length - 5} more` : ""}`];
}

/** What changed between an approved surface and a served one, as tools added, removed and changed. */
function surfaceChange(approved: Readonly<Record<string, string>>, served: Readonly<Record<string, string>>): string {
	const added = Object.keys(served)
		.filter((name) => !Object.hasOwn(approved, name))
		.sort();
	const removed = Object.keys(approved)
		.filter((name) => !Object.hasOwn(served, name))
		.sort();
	const changed = Object.keys(served)
		.filter((name) => Object.hasOwn(approved, name) && approved[name] !== served[name])
		.sort();
	const parts = [
		...named(added, "tools added"),
		...named(removed, "tools removed"),
		...named(changed, "schema or annotations changed"),
	];
	return parts.length > 0 ? parts.join("; ") : "the served surface no longer hashes to the approved digest";
}

/**
 * Judge a launch-trusted server's surface. `approved` is what the trust state
 * records for it; `served` is the surface it serves now, or null when it has not
 * been listed, in which case only a missing approval can be judged.
 */
export function judgeMcpSurface(
	server: { id: string; scope: string; plugin?: { core?: true } },
	approved: McpSurface | undefined,
	served: McpSurface | null,
): McpSurfaceStatus {
	const remedy = mcpSurfaceRemedy(server.id);
	if (approved === undefined) {
		return {
			status: "unapproved",
			digest: served?.digest ?? null,
			approvedDigest: null,
			reason:
				server.scope === "user"
					? `the tool surface of user-scope server '${server.id}' is not recorded; an attended session records it on its first listing, or review it and run ${remedy}`
					: server.plugin?.core === true
						? `the tool surface of core plugin server '${server.id}' is not recorded yet; the first session or pancode mcp test that lists its tools records it`
						: `the tool surface of '${server.id}' is not approved; launch trust lets it start so its tools can be listed, and no tool runs until the operator reviews them and runs ${remedy}`,
		};
	}
	if (served === null || served.digest === approved.digest) {
		return { status: "approved", digest: served?.digest ?? null, approvedDigest: approved.digest };
	}
	return {
		status: "changed",
		digest: served.digest,
		approvedDigest: approved.digest,
		reason: `the tool surface of '${server.id}' changed since it was approved (${surfaceChange(approved.tools, served.tools)}); launch trust stands, and no tool runs until the operator reviews the surface and runs ${remedy}`,
	};
}
