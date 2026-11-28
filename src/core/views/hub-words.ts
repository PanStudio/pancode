// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * PanHub's status words, said once for the terminal hub and the GUI catalog: what an installed copy's state means to
 * the operator, and where a pack's bytes came from. Browser-safe: no imports at all.
 */

/** The four component kinds a plugin carries. A plugin owns components; it is never a fifth invocable kind. */
export const HUB_COMPONENT_KINDS = ["skill", "agent", "prompt", "playbook"] as const;
export type HubComponentKind = (typeof HUB_COMPONENT_KINDS)[number];

/** A copy state in words: "loadable" was the loader's term, not what the operator sees happen. */
export function hubCopyStateWords(state: string): string {
	switch (state) {
		case "loadable":
			return "active";
		case "shadowed":
			return "overridden";
		case "incompatible":
			return "needs another PanCode version";
		case "untrusted":
			return "not trusted";
		default:
			return state;
	}
}

/** The origin facts a label needs; the terminal's `HubOrigin` and the catalog's wire record both carry them. */
export interface HubOriginShape {
	readonly kind?: string;
	readonly agent?: string;
}

/**
 * Where the bytes came from, in words. Origin is evidence about location and adoption; format, trust, scope and
 * availability are other facts, which is why none of them is folded into this string.
 */
export function hubOriginLabel(origin: HubOriginShape): string {
	switch (origin.kind) {
		case "bundled":
			return "Bundled with PanCode";
		case "remote":
			return "Remote";
		case "local":
			return "Local";
		case "imported":
			return `Imported from ${origin.agent ?? "another agent"}`;
		case "core":
			return "Core";
		default:
			return "Unknown origin";
	}
}
