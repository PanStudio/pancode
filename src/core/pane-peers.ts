// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** Fixed interactive coding peers. The pane tool never accepts an executable name. */
export const PANE_PEER_IDS = ["pancode", "claude-code", "codex", "opencode", "antigravity", "pi"] as const;
export type PanePeerId = (typeof PANE_PEER_IDS)[number];
