// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Skills served over MCP, as the skill registry lists them.
 *
 * A listing never launches a server and never reads a skill file: it reads the
 * skills catalog the last live `skills/list` of each trusted server recorded,
 * and the approvals `mcp-trust.json` holds for them. Activation is the context
 * tool's, which launches the server, fetches the skill and verifies it.
 */
import type { McpServerScope } from "../../mcp/config.js";
import { mcpCatalogDigest } from "../../mcp/remote-credentials.js";
import { type McpAttestedSkill, type McpRecordedSkill, readMcpSkillCatalog } from "../../mcp/skill-catalog.js";
import { mcpSkillDisplayNames } from "../../mcp/skills.js";
import {
	canonicalProjectRoot,
	judgeMcpSkillApproval,
	mcpSkillApprovalsFor,
	resolveMcpServers,
} from "../../mcp/trust.js";
import type { ResourceDiagnostic } from "../collision.js";

export type { McpAttestedSkill };

export interface McpSkillSourceInput {
	/**
	 * Exactly these versions, as a dispatched worker's admission attested
	 * them; nothing is read from a catalog or mcp-trust.json. Absent lists
	 * every skill a trusted server recorded, judged against its approval.
	 */
	attested?: ReadonlyArray<McpAttestedSkill>;
}

export interface McpServedSkill {
	serverId: string;
	serverScope: McpServerScope;
	/** `<server id>:<name>`, disambiguated within the server when two skills share a name. */
	displayName: string;
	skill: McpRecordedSkill;
	approval: { status: "approved" | "unapproved" } | { status: "changed"; reason: string };
	/** When the server last listed it. */
	observedAt: string;
}

export function servedMcpSkills(
	cwd: string,
	configDir: string | undefined,
	input: McpSkillSourceInput,
): { skills: McpServedSkill[]; diagnostics: ResourceDiagnostic[] } {
	if (input.attested !== undefined) {
		return {
			skills: input.attested.map(({ serverId, serverScope, digest: _digest, displayName, observedAt, ...skill }) => ({
				serverId,
				serverScope,
				displayName,
				skill,
				approval: { status: "approved" as const },
				observedAt,
			})),
			diagnostics: [],
		};
	}
	const trustOptions = { cwd, ...(configDir !== undefined ? { configDir } : {}) };
	const resolved = resolveMcpServers(trustOptions);
	const projectRoot = canonicalProjectRoot(cwd);
	const skills: McpServedSkill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	for (const server of resolved.servers) {
		if (server.trust.status !== "trusted") continue;
		const catalog = readMcpSkillCatalog({
			projectRoot,
			scope: server.scope,
			declarationPath: server.path,
			serverId: server.id,
			digest: mcpCatalogDigest(server),
			cwd: server.cwd,
		});
		if (catalog === null) continue;
		const approvals = mcpSkillApprovalsFor(server, trustOptions);
		const names = mcpSkillDisplayNames(server.id, catalog.skills);
		for (const skill of catalog.skills) {
			skills.push({
				serverId: server.id,
				serverScope: server.scope,
				displayName: names.get(skill.uri) ?? `${server.id}:${skill.name}`,
				skill,
				approval: judgeMcpSkillApproval(
					approvals.find((entry) => entry.uri === skill.uri),
					server,
					skill,
				),
				observedAt: catalog.observedAt,
			});
		}
		for (const refusal of catalog.refused) {
			diagnostics.push({
				type: "warning",
				message: `mcp server ${server.id} serves skill ${refusal.name ?? refusal.uri ?? "(unnamed)"} that PanCode does not load (${refusal.kind}): ${refusal.reason}`,
				...(refusal.uri !== null ? { path: refusal.uri } : {}),
			});
		}
		if (catalog.truncated) {
			diagnostics.push({
				type: "warning",
				message: `mcp server ${server.id} serves more skills than PanCode lists from one server; only ${catalog.skills.length + catalog.refused.length} were read`,
			});
		}
	}
	return { skills, diagnostics };
}
