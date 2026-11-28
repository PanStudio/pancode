// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Live extension status facts as the footer shows them: owner-labelled on row 2,
 * and listed under their pack id in the Alt+U deck.
 */
import type { ExtensionStatus } from "@pancode/sdk/extension";
import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { sanitizeCallTargetText } from "../../lib/call-target/call-target.js";
import { boxIsland, GLYPH, onRaisedTheme, type PancodeTheme, padAnsi } from "../theme/index.js";
import type { SemanticRole } from "../theme/tokens.js";

/** One extension's current status line (a `ui: status` set or a long command's progress). */
export interface ExtensionFact {
	/** The pack id. */
	readonly id: string;
	/** The name the operator installed it under. */
	readonly owner: string;
	readonly text: string;
	readonly tone: NonNullable<ExtensionStatus["tone"]>;
}

const TONE_ROLES = {
	neutral: "counter",
	positive: "success",
	warning: "warning",
	error: "error",
} as const satisfies Record<ExtensionFact["tone"], SemanticRole>;

/** The deck lists at most this many facts; the island's header counts the rest. */
const DECK_FACT_ROWS = 4;
const OWNER_PREFIX_SEP = /^[\s:·-]+/u;

function cleanFactText(value: string): string {
	return sanitizeCallTargetText(value).trim();
}

export function extensionFactsKey(facts: ReadonlyArray<ExtensionFact> | undefined): string {
	if (!facts || facts.length === 0) return "";
	return facts.map((fact) => `${fact.id}\x1e${fact.owner}\x1e${fact.tone}\x1e${fact.text}`).join("\x1f");
}

/**
 * `Owner: words`. A status that already opens with its owner's name ("Local
 * status ready") drops the repeated prefix and keeps the host's owner casing,
 * so the footer reads "Local status: ready".
 */
function ownedStatus(owner: string, text: string): { owner: string; text: string } {
	const cleanOwner = cleanFactText(owner);
	const trimmed = cleanFactText(text);
	if (trimmed.length === 0) return { owner: "", text: "" };
	if (cleanOwner.length > 0 && trimmed.toLowerCase().startsWith(cleanOwner.toLowerCase())) {
		const after = trimmed.slice(cleanOwner.length);
		if (after.length === 0) return { owner: cleanOwner, text: "" };
		if (OWNER_PREFIX_SEP.test(after)) return { owner: cleanOwner, text: after.replace(OWNER_PREFIX_SEP, "") };
	}
	return { owner: cleanOwner, text: trimmed };
}

/** Row 2's form of a fact, clipped to `room` cells. */
export function extensionFactLine(theme: PancodeTheme, fact: ExtensionFact, room: number): string {
	const { owner, text } = ownedStatus(fact.owner, fact.text);
	if (owner.length === 0 && text.length === 0) return "";
	if (text.length === 0) return truncateToWidth(theme.fg(TONE_ROLES[fact.tone], owner), room, GLYPH.ellipsis, false);
	if (owner.length === 0) return truncateToWidth(theme.fg(TONE_ROLES[fact.tone], text), room, GLYPH.ellipsis, false);
	const label = `${owner}: `;
	const body = truncateToWidth(text, Math.max(4, room - visibleWidth(label)), GLYPH.ellipsis, false);
	return truncateToWidth(
		`${theme.fg("annotation", label)}${theme.fg(TONE_ROLES[fact.tone], body)}`,
		room,
		GLYPH.ellipsis,
		false,
	);
}

/** The deck's Extensions island: one row per fact, its pack id then its status. Empty without facts. */
export function renderExtensionsIsland(
	baseTheme: PancodeTheme,
	facts: ReadonlyArray<ExtensionFact> | undefined,
	width: number,
): string[] {
	const shown = (facts ?? [])
		.map((fact) => ({ id: cleanFactText(fact.id), text: cleanFactText(fact.text), tone: fact.tone }))
		.filter((fact) => fact.text.length > 0);
	if (shown.length === 0) return [];
	const theme = onRaisedTheme(baseTheme);
	const contentWidth = Math.max(1, width - 4);
	const listed = shown.slice(0, DECK_FACT_ROWS);
	const idCol = Math.min(Math.max(...listed.map((fact) => visibleWidth(fact.id))), Math.floor(contentWidth * 0.4));
	const lines = listed.map((fact) => {
		const id = padAnsi(theme.fg("fieldName", fact.id), idCol, GLYPH.ellipsis);
		const text = truncateToWidth(fact.text, Math.max(1, contentWidth - idCol - 2), GLYPH.ellipsis, false);
		return `${id}  ${theme.fg(TONE_ROLES[fact.tone], text)}`;
	});
	const more = shown.length - listed.length;
	return boxIsland(baseTheme, {
		title: "Extensions",
		...(more > 0 ? { rightMeta: theme.fg("metadata", `+${more} more`), rightMetaRaw: true } : {}),
		lines,
		width,
	});
}
