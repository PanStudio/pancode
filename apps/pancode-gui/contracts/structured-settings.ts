// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Presentation metadata only. PanCode's settings parser remains the authority for every write. */
import { RUN_ROLES } from "../../../src/core/views/run-roles.js";
import { THINKING_LEVELS } from "../../../src/core/views/thinking-levels.js";

export type StructuredField = { key: string; label: string; kind?: "number" | "list"; choices?: readonly string[] };
export type StructuredSettingEditor = {
	kind: "map" | "values" | "list" | "rosters";
	name: string;
	fields: readonly StructuredField[];
};
export const STRUCTURED_SETTINGS: Readonly<Record<string, StructuredSettingEditor>> = {
	"fleet.profiles": {
		kind: "map",
		name: "Profile",
		fields: [
			{ key: "target", label: "Connection" },
			{ key: "model", label: "Model" },
			{ key: "thinkingLevel", label: "Thinking", choices: THINKING_LEVELS },
			{ key: "node", label: "Worker node" },
		],
	},
	"fleet.agentProfiles": {
		kind: "values",
		name: "Agent assignment",
		fields: [{ key: "value", label: "Worker profile" }],
	},
	"fleet.rosters": {
		kind: "rosters",
		name: "Roster",
		fields: [
			{ key: "label", label: "Member label" },
			{ key: "target", label: "Connection" },
			{ key: "model", label: "Model" },
			{ key: "thinkingLevel", label: "Thinking", choices: THINKING_LEVELS },
			{ key: "color", label: "Member color" },
		],
	},
	"fleet.nodes": {
		kind: "list",
		name: "Worker node",
		fields: [
			{ key: "id", label: "Node ID" },
			{ key: "host", label: "SSH host" },
			{ key: "user", label: "SSH user" },
			{ key: "port", label: "SSH port", kind: "number" },
			{ key: "identityFile", label: "Identity file path" },
			{ key: "pancodeEntry", label: "PanCode executable path" },
			{ key: "labels", label: "Node labels", kind: "list" },
			{ key: "maxWorkers", label: "Worker slots", kind: "number" },
			{ key: "residency", label: "Residency", choices: ["observe", "manage"] },
		],
	},
	"fleet.adaptiveRouting.agentRoles": {
		kind: "list",
		name: "Agent role",
		fields: [
			{ key: "agentId", label: "Agent ID" },
			{
				key: "executionRole",
				label: "Execution role",
				choices: RUN_ROLES,
			},
		],
	},
};
