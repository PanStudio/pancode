// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { IconName } from "../design/icons.js";
import { matchesText } from "../design/text-match.js";
import { SETTINGS_SECTIONS } from "./shell-model.js";

const GROUPS = [
	{ label: "Workbench", detail: "Sessions and research machines", sections: ["sessions", "machines"] },
	{ label: "Capabilities", detail: "What PanCode can use", sections: ["hub", "skills", "toolchain", "interop"] },
	{
		label: "Research activity",
		detail: "Work, results and recorded evidence",
		sections: ["fleet", "traces", "evidence", "research", "arena", "usage"],
	},
	{
		label: "Settings",
		detail: "Make PanCode work for you",
		sections: ["general", "models", "safety", "context", "all", "system"],
	},
];
const EXTRA = [
	{ id: "skills", label: "Skills", path: "/skills", icon: "skills" },
	{ id: "interop", label: "Other coding agents", path: "/system/interop", icon: "system" },
] as const;
const KEYWORDS: Readonly<Record<string, string>> = {
	machines: "ssh remote lab workstation server",
	usage: "cost costs spending tokens calls models",
	toolchain: "tools executables install setup",
	traces: "replay timeline execution events",
	evidence: "reports records findings provenance checks",
	research: "hill climb optimize metric benchmark campaign ratchet",
	arena: "compare models vote blind side by side",
	fleet: "agents delegation workers teamwork",
	hub: "recipes plugins extensions verifiers",
	safety: "permissions approvals spending limits",
	context: "memory compaction continuity",
	system: "health diagnostics status folders",
	interop: "codex claude external agents",
};
export type ExploreSection = { id: string; label: string; path: string; icon: IconName };

export function exploreGroups(query: string) {
	const sections: readonly ExploreSection[] = [...SETTINGS_SECTIONS, ...EXTRA];
	return GROUPS.map((group) => ({
		...group,
		sections: group.sections.flatMap((id) => {
			const section = sections.find((item) => item.id === id);
			if (!section) return [];
			return matchesText(query, [section.label, group.label, group.detail, KEYWORDS[id]]) ? [section] : [];
		}),
	})).filter((group) => group.sections.length > 0);
}
