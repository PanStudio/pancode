// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The model picker's detail for the selected row: its status row, its key facts and the full pane, as deep as the
 * presentation tier asks.
 */

import { relative } from "../../core/format-time.js";
import type { PickerDetail } from "../../core/presentation-tier.js";
import type { CapabilityFlags } from "../../domains/providers/index.js";
import { acceptsImageInput } from "../../domains/providers/index.js";
import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { diagnosticSeverityToken } from "../overlay-frame.js";
import type { Fact, SideUnit, StatusKind } from "../theme/index.js";
import { chip, closeWithEllipsis, factRows, fitSides, GLYPH, pancodeTheme } from "../theme/index.js";
import type { ModelRow, ModelSource } from "./model-selector-model.js";
import { modelRefWords, modelResidencySentence, RESIDENCY_TONES } from "./model-selector-model.js";

function capabilityNames(caps: CapabilityFlags): string {
	const names: string[] = [];
	if (caps.tools) names.push("tools");
	if (caps.reasoning) names.push("reasoning");
	if (caps.vision) names.push("vision");
	if (caps.embeddings) names.push("embeddings");
	if (caps.rerank) names.push("rerank");
	if (caps.fim) names.push("fim");
	return names.length > 0 ? names.join(", ") : "none";
}

function healthStatus(row: ModelRow): StatusKind {
	switch (row.healthToken) {
		case "success":
			return "ok";
		case "warning":
			return "warning";
		case "error":
			return "error";
		default:
			return "info";
	}
}

function statusGlyph(status: StatusKind): string {
	switch (status) {
		case "ok":
			return GLYPH.ok;
		case "error":
			return GLYPH.error;
		case "warning":
			return GLYPH.warn;
		default:
			return GLYPH.info;
	}
}

/** What the selected model is to the operator, in words: in use, a default, in the cycle, or none of those. */
function selectionStateWords(row: ModelRow): string {
	const tags: string[] = [];
	if (row.active) tags.push("in use");
	if (row.defaultModel) tags.push("its connection's default");
	if (row.scoped) tags.push("in the model cycle");
	if (row.favorite) tags.push("favorite");
	if (row.recent) tags.push("used recently");
	return tags.length > 0 ? tags.join(", ") : row.selectable ? "not in use" : "cannot be picked";
}

/**
 * The selection's status row: the health glyph, the route whole, then its health, what it is to you and its sign-in.
 * Those three give way whole from the right (a health that is not healthy keeps its word), and the route never does:
 * the picker is where the operator reads the full target and model, so when the row cannot hold it the route wraps
 * onto as many rows as it takes instead of being cut.
 */
function selectionStatusRows(row: ModelRow, width: number): string[] {
	const theme = pancodeTheme();
	const status = healthStatus(row);
	const glyph = statusGlyph(status);
	const route = modelRefWords(row.target, row.model);
	const availability = row.available ? row.healthText : `${row.healthText}; ${row.reason || "unavailable"}`;
	const healthWord = row.healthText.split(/[:\s]/u)[0] ?? row.healthText;
	const healthy = status === "ok" && row.available;
	if (visibleWidth(`${glyph} ${route}`) > width) {
		const lines = wrapTextWithAnsi(
			`${theme.fg(row.healthToken, glyph)} ${theme.fg("activeModelIdentity", route)}`,
			width,
		);
		return healthy ? lines : [...lines, ...wrapTextWithAnsi(theme.fg(row.healthToken, healthWord), width)];
	}
	const units: SideUnit[] = [
		{ text: glyph, lead: true, paint: (text) => theme.fg(row.healthToken, text) },
		{ text: route, paint: (text) => theme.fg("activeModelIdentity", text) },
		{
			text: availability,
			paint: (text) => theme.fg(row.healthToken, text),
			...(availability !== healthWord ? { shorter: [{ text: healthWord, rank: 2 }] } : {}),
			// A healthy route's word is the reassuring fact, so it gives way before what the model is to you.
			...(healthy ? { drop: 2.5 } : {}),
		},
		{ text: selectionStateWords(row), drop: 3, paint: (text) => theme.fg("annotation", text) },
		{ text: authWords(row.authText), drop: 1, paint: (text) => chip(theme, text, "muted") },
	];
	return [fitSides(theme, units, [], width).trimEnd()];
}

/** The target's last health check: its answer, its latency or error, and how long ago it ran. */
function healthHistoryWords(row: ModelRow): string {
	const checked = row.healthCheckedAt ? `checked ${relative(row.healthCheckedAt)}` : "not checked yet";
	return `${row.healthText} ${GLYPH.sep} ${checked}`;
}

/** The credential in words, with the source it was read from when the words do not already say it. */
function signInWords(authText: string): string {
	const words = authWords(authText);
	return words === authText || authText === "unknown" || authText === "disconnected" || authText === "not required"
		? words
		: `${words} ${GLYPH.sep} ${authText}`;
}

/**
 * The selected row, explained, as deep as the tier's `pickerDetail` reaches. Every tier leads with the status row
 * (health, the route whole, what it is to you, sign-in), then what blocks it: an unreachable route's next step and
 * any warning or error the resolution raised, which no tier hides. Standard adds the facts a switch is decided on
 * (residency, what the switch costs the cache, context and thinking); detailed adds the full pane (capabilities,
 * replies, load state, runtime, the health check's history and the sign-in source). `maxRows` is what the body can
 * spare; the facts give way first and say where they were cut.
 */
export function formatModelDetail(
	row: ModelRow,
	width: number,
	maxRows: number,
	switchCost: string | null | undefined,
	detail: PickerDetail,
): string[] {
	const theme = pancodeTheme();
	const status = selectionStatusRows(row, width);
	const withFacts = detail !== "status";
	const residency = modelResidencySentence(row.residency ?? null, row.model, row.target);
	// Residency reads as its own line in its own tone, above the facts that give way first.
	const residencyLines =
		withFacts && residency && row.residency
			? wrapTextWithAnsi(
					theme.fg(RESIDENCY_TONES[row.residency], `${residency}${row.loadStateDetail ? ` (${row.loadStateDetail})` : ""}`),
					width,
				).slice(0, 2)
			: [];
	const costLines =
		withFacts && switchCost ? wrapTextWithAnsi(theme.fg("annotation", switchCost), width).slice(0, 2) : [];
	// Severity colors the way the targets hub colors it, through the shared mapping. The thinking
	// fact already says what runs and why, and from standard up an unknown context window is the
	// context fact's own value, so neither repeats as a diagnostic there; at compact, where there is
	// no context fact, the warning stands on its own row.
	const shown = (row.diagnostics ?? []).filter((entry) => entry.severity !== "info");
	const contextNote = shown.find((entry) => entry.code === CONTEXT_UNVERIFIED_CODE);
	const diagnostics = shown
		.filter((entry) => (withFacts ? entry !== contextNote : true) && !entry.code.startsWith("thinking-"))
		.slice(0, 2)
		.flatMap((entry) => {
			const token = diagnosticSeverityToken(entry.severity);
			return capWrapped(
				wrapTextWithAnsi(theme.fg(token, `${token === "error" ? GLYPH.error : GLYPH.warn} ${entry.message}`), width),
				2,
				width,
			);
		});
	const known = (value: string): boolean => value !== "?" && value !== "-" && value.length > 0;
	const context = row.context.replace(/ctx$/u, "");
	// In the order a switch is decided on: how much the model holds, how it thinks, what it can do.
	const keyFacts: Fact[] = withFacts
		? [
				known(context)
					? { label: "context", value: `${context} tokens` }
					: {
							label: "context",
							// The diagnostic's own sentence took three rows at 60 columns and pushed thinking off the card.
							value: contextNote
								? "unknown, so PanCode compacts at its token budget; pancode configure can set it"
								: "unknown",
							tone: contextNote ? "warning" : "muted",
						},
				{
					label: "thinking",
					value: `${row.thinking ?? "not reported"}${row.thinkingNote ? `; ${row.thinkingNote}, your setting is kept` : ""}`,
				},
			]
		: [];
	const paneFacts: Fact[] =
		detail === "pane"
			? [
					// Health history and sign-in lead the pane: they are what detailed adds, so a short body cuts runtime first.
					{ label: "health", value: healthHistoryWords(row) },
					{ label: "sign-in", value: signInWords(row.authText) },
					{ label: "can use", value: capabilityNames(row.caps) },
					{
						label: "replies",
						value: [
							known(row.maxTokens) ? `up to ${row.maxTokens} tokens` : "no reported length limit",
							row.streaming === false ? "whole, not streamed" : "streamed",
							acceptsImageInput({ vision: row.caps.vision }) ? "takes images" : "text only",
						].join(` ${GLYPH.sep} `),
					},
					...(residency === null && row.loadState
						? [{ label: "state", value: `${row.loadState}${row.loadStateDetail ? ` (${row.loadStateDetail})` : ""}` }]
						: []),
					{ label: "runtime", value: `${row.runtimeName} ${GLYPH.sep} ${row.sourceNote ?? modelListWords(row.source)}` },
				]
			: [];
	const factLines = factRows(
		theme,
		[...keyFacts, ...paneFacts].map((fact) => ({ ...fact, tone: fact.tone ?? "muted" })),
		width,
	);
	// A route that cannot answer says what to do about it before any fact about the route.
	const unreachable = !row.available || healthStatus(row) === "error";
	const next = unreachable
		? wrapTextWithAnsi(
				theme.fg(
					"warning",
					`next: pick a healthy route, or r to recheck this one. Using it fails every turn until it answers. Fix it with pancode configure --id ${row.target}`,
				),
				width,
			)
		: [];
	const factBudget = Math.max(
		factLines.length === 0 ? 0 : 1,
		Math.min(
			factLines.length,
			maxRows - status.length - next.length - residencyLines.length - costLines.length - diagnostics.length,
		),
	);
	const body = [...next, ...residencyLines, ...costLines, ...capWrapped(factLines, factBudget, width), ...diagnostics];
	// The status row carries the route whole and is never cut; what follows it gives way to the room and says so.
	const room = maxRows - status.length;
	return room <= 0 ? status : [...status, ...capWrapped(body, room, width)];
}

/** The diagnostic an unknown context window raises; the detail's context fact carries its sentence instead. */
const CONTEXT_UNVERIFIED_CODE = "context-window-unverified";

/** At most `max` rows, the last closing on an ellipsis when rows were cut. */
function capWrapped(rows: ReadonlyArray<string>, max: number, width: number): string[] {
	if (rows.length <= max) return [...rows];
	const kept = rows.slice(0, Math.max(1, max));
	const last = kept.at(-1);
	if (last !== undefined && !stripTerminalSequences(last).trimEnd().endsWith(GLYPH.ellipsis))
		kept[kept.length - 1] = closeWithEllipsis(last, width);
	return kept;
}

/** Where the picker's list of this connection's models came from, in words. */
function modelListWords(source: ModelSource): string {
	switch (source) {
		case "configured":
			return "models listed in settings";
		case "live":
			return "models listed by the server just now";
		case "cache":
			return "models from a cached list";
		case "catalog":
			return "models from PanCode's catalog";
		case "default":
			return "only the connection's default model";
		default:
			return "no model ids";
	}
}

/** The credential a connection uses, in words. */
function authWords(authText: string): string {
	const [source = "", detail] = authText.split(":");
	switch (source) {
		case "not required":
		case "not-required":
		case "none":
			return "no sign-in needed";
		case "disconnected":
			return "not signed in";
		case "unknown":
			return "sign-in unknown";
		case "env":
		case "environment":
			return detail ? `key from ${detail}` : "key from the environment";
		case "stored-api-key":
			return "saved API key";
		case "stored-oauth":
			return "signed in through the browser";
		case "runtime-override":
			return "key set for this run";
		case "fallback":
			return "fallback credential";
		default:
			return detail ? `${source} (${detail})` : source;
	}
}
