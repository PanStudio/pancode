// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Pure PanHub tab metadata; keep this outside the render graph. */

import type { HubCategory } from "../../domains/resources/index.js";

/** PanHub categories in keyboard traversal order. */
export const HUB_TABS: ReadonlyArray<{ id: HubCategory; label: string }> = [
	{ id: "skill", label: "Skills" },
	{ id: "agent", label: "Agents" },
	{ id: "prompt", label: "Prompts" },
	{ id: "playbook", label: "Playbooks" },
	{ id: "plugin", label: "Plugins" },
	{ id: "extension", label: "Extensions" },
];

export function isHubTab(value: string): value is HubCategory {
	return HUB_TABS.some((tab) => tab.id === value);
}
