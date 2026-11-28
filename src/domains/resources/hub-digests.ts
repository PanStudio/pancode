// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The two review digests an index row carries besides its tree digest: the
 * extension's capability envelope and the pack's MCP declarations. `hub:pin`
 * writes them, `planHubInstall` recomputes them from the fetched tree, and the
 * hub review job compares them across a change, so all three read one function.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "../../core/hash.js";
import { isRecord } from "../../core/type-guards.js";
import { reviewExtensionEnvelope } from "../extensions/envelope-review.js";
import { mcpServerDigest } from "../gateway/mcp/config.js";
import type { McpTrustActionClass } from "../gateway/mcp/trust.js";

/** The pack's capability envelope digest, or undefined when it declares no runtime. */
export function hubEnvelopeDigest(root: string): string | undefined {
	return reviewExtensionEnvelope(root)?.digest;
}

/**
 * SHA-256 of the sorted `<id>:<declaration digest>` lines for the stdio servers in the pack's `mcp.json`, each
 * digest bound to the pack's tree digest as the MCP trust record binds it. Undefined when the pack has no
 * `mcp.json`; throws when the file cannot be read as an `mcpServers` mapping.
 */
export function hubMcpDigest(root: string, treeSha256: string): string | undefined {
	const file = path.join(root, "mcp.json");
	if (!existsSync(file)) return undefined;
	const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
	if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) throw new Error(`${file} has no mcpServers mapping`);
	const lines: string[] = [];
	for (const [id, value] of Object.entries(parsed.mcpServers)) {
		if (!isRecord(value)) throw new Error(`${file}: mcpServers.${id} must be an object`);
		if (value.type !== undefined && value.type !== "stdio") continue;
		if (typeof value.command !== "string") throw new Error(`${file}: mcpServers.${id}.command must be a string`);
		const digest = mcpServerDigest({
			id,
			command: value.command,
			args: Array.isArray(value.args) ? value.args.map(String) : [],
			cwd: typeof value.cwd === "string" ? value.cwd : null,
			env: isRecord(value.env) ? (value.env as Record<string, string>) : {},
			envVars: Array.isArray(value.envVars) ? value.envVars.map(String) : [],
			timeoutMs: typeof value.timeoutMs === "number" ? value.timeoutMs : null,
			toolActionClasses: isRecord(value.toolActionClasses)
				? (value.toolActionClasses as Record<string, McpTrustActionClass>)
				: {},
			toolPathArguments: isRecord(value.toolPathArguments)
				? (value.toolPathArguments as Record<string, Record<string, "read" | "write">>)
				: {},
			pluginContentDigest: treeSha256,
		});
		lines.push(`${id}:${digest}`);
	}
	return sha256Hex(lines.sort().join("\n"));
}
