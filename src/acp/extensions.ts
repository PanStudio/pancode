// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { boundedText } from "./server-bounds.js";
import type { AcpExtensionReloadOutcome, AcpInstalledExtension } from "./types-views.js";

export {
	ACP_EXTENSIONS_LIST_METHOD,
	ACP_EXTENSIONS_META_KEY,
	ACP_EXTENSIONS_RELOAD_METHOD,
	ACP_HUB_META_KEY,
	ACP_HUB_RELOAD_METHOD,
} from "./types.js";
export type { AcpExtensionReloadOutcome, AcpInstalledExtension } from "./types-views.js";

/**
 * `_pancode/extensions/list`, `_pancode/extensions/reload` and
 * `_pancode/hub/reload`: what the terminal's /extensions view shows,
 * and the two reloads /reload extensions and /reload hub run.
 *
 * The list is the running session's own view of its extensions: which are
 * eligible, disabled, invalid, incompatible or shadowed, and how many problems
 * each has. Manifest paths, roots, digests and provenance records stay
 * host-side. A reload reports the generation it committed, or why it was
 * rejected and which generation stays active; it never reports success for a
 * reload that did not happen.
 */

const MAX_EXTENSIONS = 64;
const MAX_LINES = 40;
const MAX_TEXT_BYTES = 512;
const MAX_DIAGNOSTICS = 3;

/** The installed-extension fields the list reads; the extensions domain's InstalledExtension, structurally. */

/** The reload coordinator's outcome, structurally. */

export interface AcpExtensionsControl {
	list(): ReadonlyArray<AcpInstalledExtension>;
	reload(): AcpExtensionReloadOutcome;
}

/** Plugin resources reloaded, as the PluginsReloaded event reports them. Throws when the reload fails. */
export type AcpHubReload = () => { generation: number; previousGeneration: number; changed: boolean };

export function projectExtensions(list: ReadonlyArray<AcpInstalledExtension>) {
	return {
		version: 1 as const,
		extensions: list.slice(0, MAX_EXTENSIONS).map((extension) => ({
			id: boundedText(extension.id, MAX_TEXT_BYTES),
			name: boundedText(extension.name, MAX_TEXT_BYTES),
			version: boundedText(extension.version, MAX_TEXT_BYTES),
			description: boundedText(extension.description, MAX_TEXT_BYTES),
			scope: boundedText(extension.scope, MAX_TEXT_BYTES),
			// The overlay's one state word, in the same precedence.
			state: !extension.valid
				? ("invalid" as const)
				: !extension.compatible
					? ("incompatible" as const)
					: !extension.enabled
						? ("disabled" as const)
						: extension.loadable
							? ("eligible" as const)
							: ("shadowed" as const),
			...(extension.overriddenBy !== undefined
				? { overriddenBy: boundedText(extension.overriddenBy, MAX_TEXT_BYTES) }
				: {}),
			runtime: extension.runtimeV2 !== undefined,
			problems: extension.diagnostics.length,
			diagnostics: extension.diagnostics
				.slice(0, MAX_DIAGNOSTICS)
				.map((entry) => boundedText(entry.message, MAX_TEXT_BYTES)),
		})),
		truncated: list.length > MAX_EXTENSIONS,
	};
}

export function projectExtensionReload(outcome: AcpExtensionReloadOutcome) {
	const lines = outcome.lines.slice(0, MAX_LINES).map((text) => boundedText(text, MAX_TEXT_BYTES));
	if (outcome.status !== "committed") {
		return {
			status: "rejected" as const,
			reason: boundedText(outcome.reason, MAX_TEXT_BYTES),
			generation: outcome.generation,
			lines,
		};
	}
	return {
		status: "committed" as const,
		generation: outcome.generation,
		changed: outcome.changed,
		added: outcome.added.length,
		removed: outcome.removed.length,
		modified: outcome.modified.length,
		hooks: {
			registered: outcome.hooks.registered,
			dropped: outcome.hooks.dropped,
			issues: outcome.hooks.fileIssues + outcome.hooks.issues,
			overridden: outcome.hooks.overridden,
		},
		lines,
	};
}
