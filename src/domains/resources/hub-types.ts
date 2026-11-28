// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { HUB_COMPONENT_KINDS, type HubComponentKind } from "../../core/views/hub-words.js";

/** The hub distributes packs; kind describes the pack's public contents. */
export type HubEntryKind = "skill" | "plugin" | "extension";
export type HubRequirementRef = `${HubEntryKind}:${string}`;

/** Plugin-backed package formats: they install through the plugin writer. A standalone extension has its own manifest and writer. */
export const HUB_KINDS: readonly Exclude<HubEntryKind, "extension">[] = ["plugin", "skill"];

export function isHubKind(value: unknown): value is HubEntryKind {
	return (
		value === "extension" ||
		(typeof value === "string" && HUB_KINDS.includes(value as Exclude<HubEntryKind, "extension">))
	);
}

export { HUB_COMPONENT_KINDS, type HubComponentKind };

export function isHubComponentKind(value: unknown): value is HubComponentKind {
	return typeof value === "string" && (HUB_COMPONENT_KINDS as readonly string[]).includes(value);
}

/** A package's published audit verdict. */
export const HUB_AUDIT_STATES = ["pass", "warn", "fail", "unknown"] as const;
export type HubAuditState = (typeof HUB_AUDIT_STATES)[number];

export function isHubAuditState(value: unknown): value is HubAuditState {
	return typeof value === "string" && (HUB_AUDIT_STATES as readonly string[]).includes(value);
}

/** What the hub browses and filters by: a pack kind or a component kind. */
export type HubCategory = HubEntryKind | HubComponentKind;

/**
 * Bounded, body-free hint carried by a catalog row. Generated for curated
 * packages from actual parsed runtime names; optional in external indexes. A
 * hint supports discovery only: it never proves the package installs or loads.
 */
export interface HubProvidedResource {
	kind: HubComponentKind | "extension";
	name: string;
	description?: string;
}

export const HUB_PROVIDES_LIMITS = { entries: 256, name: 128, description: 256 } as const;

/**
 * Shorten to at most `limit` characters at the last word boundary, ending in an
 * ellipsis, so a clipped description never stops mid-word or reads as whole.
 * This is stored data (the pinned index, inventory JSON), so it carries the
 * Unicode ellipsis byte for byte whatever terminal pinned or read it; the CLI
 * text view draws that mark with `GLYPH.ellipsis`.
 */
export function clipAtWord(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const room = limit - 1;
	if (room <= 0) return "…".slice(0, limit);
	// One character past the room tells whether the word at the edge ends there.
	const head = text.slice(0, room + 1);
	const space = head.search(/\s\S*$/u);
	const body = space > 0 ? head.slice(0, space) : text.slice(0, room);
	return `${body.replace(/[\s,;:]+$/u, "")}…`;
}

export const HUB_TIERS = ["core", "verified", "listed"] as const;
/** core: first-party; verified: reviewed against the checklist; listed: indexed, installed foreign. */
export type HubTier = (typeof HUB_TIERS)[number];

/** A community row's source: one repository, one exact commit, one package directory inside it. */
export interface HubRowSource {
	repo: string;
	commit: string;
	subdir: string;
}

/** The same record is used in bundled, user, and project hub indexes. */
export interface HubPackageEntry {
	kind: HubEntryKind;
	name: string;
	description: string;
	sourceUrl: string;
	version?: string;
	sha256?: string;
	origin: "catalog" | "index" | "installed";
	requires?: HubRequirementRef[];
	/** Extension rows only: the one plugin this extension serves, so a plugin and its extension pair without reading package trees. */
	plugin?: string;
	/** Extension rows only: the `pancode <verb>` names it declares, so a verb typed before an install names its pack. */
	verbs?: string[];
	category?: string;
	audit?: HubAuditState;
	triggers?: string[];
	/** Absent means the package contents are unknown until explicit inspection. */
	provides?: HubProvidedResource[];
	/** A community row's exact source; `sourceUrl` then shows it as a tree URL at the commit. */
	source?: HubRowSource;
	/** Lowercase GitHub owner, or pancode for first-party packs. */
	publisher?: string;
	/** SPDX expression. */
	license?: string;
	/** Honoured only for rows from the bundled or the verified remote index. */
	tier?: HubTier;
	/** Extension rows: digest of the capability envelope the row was reviewed with. */
	envelopeDigest?: string;
	/** Packs with an mcp.json: digest of their MCP declarations. */
	mcpDigest?: string;
	/** Bundled first-party rows only: `upgrade --post-install` installs the pack once into the user scope. */
	default?: true;
	/** Absolute path of the index file that produced this row. Discovery evidence; never written back. */
	index?: string;
}
