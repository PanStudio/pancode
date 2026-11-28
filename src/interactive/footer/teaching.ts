// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Hybrid B->A three-mechanism teaching system (zero inline keycap badges beside facts).
 *
 * 1. Whisper Cue: one quiet hint on idle Row 2 (`standard`/`detailed` when deck closed),
 *    rotating calmly across sessions and completed turns (never on a timer), completely silent
 *    once every capability is learned or when `interface.demo === false`.
 * 2. Capability Map: boxed `Capabilities` island inside the open idle deck listing unlearned
 *    core domains (fleet, loops, tasks, memory, context, modes), shrinking domain by domain
 *    until vanishing completely once all 6 have been used.
 * 3. Contextual Moments: one-time Row 2 guidance triggered the first time a real situation
 *    makes a capability useful (`moment:context-40`, `moment:first-stream`, `moment:first-workers`,
 *    `moment:first-tools`), recorded in `harness-profile.json` so it never repeats.
 *
 * Pure and zero-I/O on the render path; every mechanism guards on `learned.hydrated === true`
 * so seasoned users never experience a frame-1 flash or spurious profile write.
 */

import type { HarnessProfileLesson } from "../../core/harness-profile.js";
import { presentationTier, tierPolicy } from "../../core/presentation-tier.js";
import { asciiOnly } from "../../core/terminal-preferences.js";
import { getKeybindings, truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { ACTIVE_DISPATCH_STATUSES } from "../footer-panel.js";
import type { HarnessLearnedFacts } from "../harness-facts.js";
import { actionKeyLabel } from "../keybinding-manager.js";
import { boxIsland, GLYPH, onRaisedTheme, type PancodeTheme, padAnsi, pancodeTheme } from "../theme/index.js";
import type { FooterDashboardRenderState } from "./dashboard.js";
import { isMainBusy } from "./status-line.js";

/** Sessions before the compact minimal `?` door retires on its own if never pressed. */
export const COMPACT_KEYS_DOOR_LIFETIME = 3;

const CONTEXT_MOMENT_THRESHOLD_PCT = 40;
const TOOLS_MOMENT_MIN_CALLS = 3;

function hasLearned(learned: HarnessLearnedFacts | undefined, keys: readonly string[]): boolean {
	if (!learned) return false;
	return keys.some((key) => (learned.features[key]?.count ?? 0) > 0);
}

const DEFAULT_KEY_LABELS: Readonly<Record<string, string>> = {
	"pancode.thinking.cycle": "Shift+Tab",
	"pancode.model.select": "Alt+M",
	"pancode.autonomy.toggle": "Ctrl+G Y",
	"pancode.output.cycle": "Alt+O",
	"pancode.dispatchBoard.toggle": "Alt+W",
	"pancode.queue.open": "Alt+Q",
};

function liveKey(id: Parameters<typeof actionKeyLabel>[0]): string | null {
	const label = actionKeyLabel(id);
	if (label && !label.startsWith("unbound")) return label;
	// If PanCode's keybinding manager is installed, `null` means the operator explicitly unbound this action.
	if (getKeybindings().getKeys("pancode.leader").length > 0) return null;
	return DEFAULT_KEY_LABELS[id] ?? null;
}

interface WhisperEntry {
	readonly id: string;
	readonly learnedKeys: readonly string[];
	readonly text: (width: number) => string | null;
}

const WHISPER_CATALOG: readonly WhisperEntry[] = [
	{
		id: "fleet",
		learnedKeys: ["/run", "/delegate", "/fleet", "key:pancode.dispatchBoard.toggle"],
		text: (w) =>
			w >= 96 ? "Try /run to dispatch parallel workers" : w >= 80 ? "Try /run for parallel workers" : "Try /run workers",
	},
	{
		id: "loops",
		learnedKeys: ["/loop"],
		text: (w) =>
			w >= 96 ? "Try /loop to schedule recurring checks" : w >= 80 ? "Try /loop for recurring checks" : "Try /loop checks",
	},
	{
		id: "tasks",
		learnedKeys: ["/tasks", "key:pancode.tasks.open"],
		text: (w) =>
			w >= 96 ? "Try /tasks for agent and operator boards" : w >= 80 ? "Try /tasks for task boards" : "Try /tasks boards",
	},
	{
		id: "memory",
		learnedKeys: ["/memory", "/remember"],
		text: (w) =>
			w >= 96 ? "Try /memory to inspect project notes" : w >= 80 ? "Try /memory for project notes" : "Try /memory notes",
	},
	{
		id: "context",
		learnedKeys: ["/context", "/context init"],
		text: (w) =>
			w >= 96
				? "Try /context to see what fills the window"
				: w >= 80
					? "Try /context for window fill"
					: "Try /context fill",
	},
	{
		id: "thinking",
		learnedKeys: ["key:pancode.thinking.cycle", "/thinking"],
		text: (w) => {
			const key = liveKey("pancode.thinking.cycle");
			if (!key) return w >= 96 ? "Try /thinking to cycle thinking effort" : "Try /thinking";
			return w >= 96 ? `Press ${key} to cycle thinking effort` : w >= 80 ? `${key} cycles thinking` : `${key} think`;
		},
	},
	{
		id: "model",
		learnedKeys: ["key:pancode.model.select", "/model"],
		text: (w) => {
			const key = liveKey("pancode.model.select");
			if (!key) return w >= 96 ? "Try /model to switch models" : "Try /model";
			return w >= 96 ? `Press ${key} to switch models` : w >= 80 ? `${key} switches models` : `${key} model`;
		},
	},
	{
		id: "modes",
		learnedKeys: ["key:pancode.autonomy.toggle", "key:pancode.output.cycle"],
		text: (w) => {
			const autoKey = liveKey("pancode.autonomy.toggle");
			const outKey = liveKey("pancode.output.cycle");
			if (w < 80) return outKey ? `${outKey} detail` : autoKey ? `${autoKey} yolo` : null;
			const parts = [
				...(autoKey ? [w >= 96 ? `${autoKey} toggles yolo` : `${autoKey} yolo`] : []),
				...(outKey ? [w >= 96 ? `${outKey} cycles detail` : `${outKey} detail`] : []),
			];
			return parts.length > 0 ? parts.join(` ${GLYPH.sep} `) : null;
		},
	},
	{
		id: "usage",
		learnedKeys: ["/usage"],
		text: (w) =>
			w >= 96
				? "Try /usage for spend, quotas, and health"
				: w >= 80
					? "Try /usage for spend and quotas"
					: "Try /usage spend",
	},
	{
		id: "mentions",
		learnedKeys: ["@"],
		text: (w) =>
			w >= 96 ? "Prefix paths with @ to attach files" : w >= 80 ? "Use @path to attach files" : "@path attaches",
	},
];

/**
 * Mechanism 1: Select one quiet whisper cue for idle Row 2 (`standard` / `detailed` when deck closed).
 * Rotates calmly by `turnSeed` (session start + completed turns), never on a timer; returns null when
 * disabled, unhydrated, busy, deck open, or all 10 capabilities have been used.
 */
export function selectWhisperCue(
	state: Pick<FooterDashboardRenderState, "demo" | "learned" | "status" | "deckOpen" | "outputStyle">,
	width: number,
	turnSeed = 0,
): string | null {
	if (state.demo === false || state.learned?.hydrated !== true) return null;
	if (state.deckOpen === true || isMainBusy(state.status)) return null;
	const policy = tierPolicy(state.outputStyle ?? presentationTier());
	if (!policy.hintRow) return null;

	const eligible: string[] = [];
	for (const entry of WHISPER_CATALOG) {
		if (hasLearned(state.learned, entry.learnedKeys)) continue;
		const text = entry.text(width);
		if (text) eligible.push(text);
	}
	if (eligible.length === 0) return null;
	const index = Math.abs(Math.floor(turnSeed)) % eligible.length;
	return eligible[index] ?? null;
}

interface CapabilityDomainEntry {
	readonly id: string;
	readonly learnedKeys: readonly string[];
	readonly command: (ascii: boolean) => string;
	readonly description: (width: number) => string;
}

const CAPABILITY_DOMAINS: readonly CapabilityDomainEntry[] = [
	{
		id: "fleet",
		learnedKeys: ["/run", "/fleet", "key:pancode.dispatchBoard.toggle"],
		command: (ascii) => {
			const key = liveKey("pancode.dispatchBoard.toggle");
			if (!key) return "/run";
			return ascii ? `/run, ${key}` : `/run ${GLYPH.sep} ${key}`;
		},
		description: (w) => (w >= 96 || w < 80 ? "dispatch parallel workers" : "parallel workers"),
	},
	{
		id: "loops",
		learnedKeys: ["/loop"],
		command: () => "/loop",
		description: (w) => (w >= 96 || w < 80 ? "schedule recurring checks" : "recurring checks"),
	},
	{
		id: "tasks",
		learnedKeys: ["/tasks", "key:pancode.tasks.open"],
		command: () => "/tasks",
		description: (w) => (w >= 96 || w < 80 ? "agent & operator boards" : "task boards"),
	},
	{
		id: "memory",
		learnedKeys: ["/memory", "/remember"],
		command: () => "/memory",
		description: (w) => (w >= 96 || w < 80 ? "project notes & lessons" : "project notes"),
	},
	{
		id: "context",
		learnedKeys: ["/context", "/context init"],
		command: () => "/context",
		description: (w) => (w >= 96 || w < 80 ? "inspect or compact window" : "inspect window"),
	},
	{
		id: "modes",
		learnedKeys: ["key:pancode.autonomy.toggle", "key:pancode.output.cycle"],
		command: (ascii) => {
			const autoKey = liveKey("pancode.autonomy.toggle");
			const outKey = liveKey("pancode.output.cycle");
			const parts = [autoKey, outKey].filter((item): item is string => item !== null);
			if (parts.length === 0) return "/settings";
			return ascii ? parts.join(", ") : parts.join(` ${GLYPH.sep} `);
		},
		description: (w) => (w >= 96 || w < 80 ? `YOLO mode ${GLYPH.sep} detail tier` : `YOLO ${GLYPH.sep} detail tier`),
	},
];

export interface CapabilityMapResult {
	readonly lines: string[];
	readonly key: string;
}

/**
 * Mechanism 2: Render the idle deck `Capabilities` boxed island directly beneath the 3 deck islands.
 * Two columns at `>= 80` cols (`│` in Unicode, 3 spaces in ASCII), 1 column at `60..79` cols.
 * Shrinks cleanly as domains are learned and returns empty once all 6 domains are used.
 */
export function renderCapabilityMap(
	state: Pick<FooterDashboardRenderState, "demo" | "learned" | "status" | "outputStyle">,
	width: number,
	themeOverride?: PancodeTheme,
): CapabilityMapResult {
	const w = Math.max(1, Math.floor(width));
	const policy = tierPolicy(state.outputStyle ?? presentationTier());
	if (
		!policy.hintRow ||
		w < 60 ||
		state.demo === false ||
		state.learned?.hydrated !== true ||
		isMainBusy(state.status)
	) {
		return { lines: [], key: "" };
	}

	const ascii = asciiOnly();
	const items = CAPABILITY_DOMAINS.filter((domain) => !hasLearned(state.learned, domain.learnedKeys)).map((domain) => ({
		id: domain.id,
		cmd: domain.command(ascii),
		desc: domain.description(w),
	}));
	if (items.length === 0) return { lines: [], key: "" };

	const baseTheme = themeOverride ?? pancodeTheme();
	const theme = onRaisedTheme(baseTheme);
	const innerWidth = Math.max(1, w - 4);
	const bodyLines: string[] = [];

	const renderCell = (item: { cmd: string; desc: string } | undefined, cellWidth: number, cmdCol: number): string => {
		if (!item) return "";
		const cmdText = padAnsi(theme.fg("commandHint", item.cmd), cmdCol, GLYPH.ellipsis);
		const descRoom = Math.max(1, cellWidth - cmdCol - 2);
		const descText = theme.fg("annotation", truncateToWidth(item.desc, descRoom, GLYPH.ellipsis, false));
		return truncateToWidth(`${cmdText}  ${descText}`, cellWidth, GLYPH.ellipsis, false);
	};

	if (w >= 80) {
		const gutter = ascii ? "   " : ` ${theme.fg("divider", GLYPH.rail)} `;
		const gutterWidth = 3;
		const leftWidth = Math.floor((innerWidth - gutterWidth) / 2);
		const rightWidth = innerWidth - gutterWidth - leftWidth;
		const rowCount = Math.ceil(items.length / 2);
		const leftItems = items.slice(0, rowCount);
		const rightItems = items.slice(rowCount);
		const leftCmdCol = Math.min(
			Math.max(8, ...leftItems.map((item) => visibleWidth(item.cmd))),
			Math.max(8, Math.floor(leftWidth * 0.48)),
		);
		const rightCmdCol = Math.min(
			Math.max(8, ...rightItems.map((item) => visibleWidth(item.cmd))),
			Math.max(8, Math.floor(rightWidth * 0.48)),
		);
		for (let row = 0; row < rowCount; row += 1) {
			const left = padAnsi(renderCell(leftItems[row], leftWidth, leftCmdCol), leftWidth, GLYPH.ellipsis);
			const right = renderCell(rightItems[row], rightWidth, rightCmdCol);
			bodyLines.push(`${left}${gutter}${right}`);
		}
	} else {
		const cmdCol = Math.min(
			Math.max(8, ...items.map((item) => visibleWidth(item.cmd))),
			Math.max(8, Math.floor(innerWidth * 0.42)),
		);
		for (const item of items) {
			bodyLines.push(renderCell(item, innerWidth, cmdCol));
		}
	}

	const meta = theme.fg("metadata", w >= 80 ? "quiets as you use each" : "quiets on use");
	const lines = boxIsland(baseTheme, {
		title: "Capabilities",
		rightMeta: meta,
		rightMetaRaw: true,
		lines: bodyLines,
		width: w,
	});
	return { lines, key: `${w}:${ascii ? 1 : 0}:${items.map((item) => `${item.id}=${item.cmd}`).join(",")}` };
}

export interface ContextualMomentMatch {
	readonly id: string;
	readonly text: string;
}

/**
 * Mechanism 3: Select a one-time contextual moment when a real situation makes a capability useful.
 * Takes precedence over whisper cues on Row 2, yields to alerts and setting feedback, and never repeats
 * once recorded in `harness-profile.json` (`lessons["moment:<id>"]`).
 */
export function selectContextualMoment(
	state: Pick<
		FooterDashboardRenderState,
		"demo" | "learned" | "status" | "outputStyle" | "dispatchRows" | "context" | "agent"
	>,
	width: number,
	lessons: Readonly<Record<string, HarnessProfileLesson>>,
	activeMomentId: string | null = null,
): ContextualMomentMatch | null {
	if (state.demo === false || state.learned?.hydrated !== true) return null;
	const policy = tierPolicy(state.outputStyle ?? presentationTier());
	if (!policy.hintRow) return null;

	const eligible = (id: string, suppressKeys: readonly string[]): boolean => {
		if (hasLearned(state.learned, suppressKeys)) return false;
		if (id === activeMomentId) return true;
		return (lessons[id]?.shown ?? 0) === 0;
	};

	// 1. First live workers dispatched
	const liveWorkers = state.dispatchRows.filter(
		(row) => row.plan === undefined && ACTIVE_DISPATCH_STATUSES.has(row.status),
	).length;
	if (liveWorkers > 0 && eligible("moment:first-workers", ["key:pancode.dispatchBoard.toggle", "/fleet"])) {
		const key = liveKey("pancode.dispatchBoard.toggle") ?? "/fleet";
		const text =
			width >= 96
				? `Workers running ${GLYPH.sep} ${key} opens live fleet detail and steering`
				: width >= 80
					? `Workers running ${GLYPH.sep} ${key} opens fleet detail`
					: `Workers live ${GLYPH.sep} ${key} detail`;
		return { id: "moment:first-workers", text };
	}

	// 2. First active streaming turn
	const streaming =
		state.status.phase === "waiting_model" || state.status.phase === "thinking" || state.status.phase === "writing";
	if (streaming && eligible("moment:first-stream", ["steer"])) {
		const queueKey = liveKey("pancode.queue.open");
		const queueSuffix = queueKey
			? width >= 96
				? ` ${GLYPH.sep} ${queueKey} manages queue`
				: ` ${GLYPH.sep} ${queueKey} queue`
			: "";
		const lead =
			width >= 96
				? "Type while running to steer at the next step"
				: width >= 80
					? "Type to steer at the next step"
					: "Type to steer";
		return { id: "moment:first-stream", text: `${lead}${queueSuffix}` };
	}

	if (!isMainBusy(state.status)) {
		// 3. First idle turn where context occupancy >= 40%
		const used = state.context.budget ? state.context.used : (state.context.ledger?.usedTokens ?? state.context.used);
		const win = state.context.budget
			? state.context.contextWindow
			: (state.context.ledger?.contextWindow ?? state.context.contextWindow);
		if (used !== null && win !== null && win > 0) {
			const pct = Math.round((used / win) * 100);
			if (pct >= CONTEXT_MOMENT_THRESHOLD_PCT && eligible("moment:context-40", ["/context", "/compact"])) {
				const text =
					width >= 96
						? `${pct}% context used ${GLYPH.sep} /context shows what fills it ${GLYPH.sep} /compact trims history`
						: width >= 80
							? `${pct}% context ${GLYPH.sep} /context inspects ${GLYPH.sep} /compact trims`
							: `${pct}% context ${GLYPH.sep} /context ${GLYPH.sep} /compact`;
				return { id: "moment:context-40", text };
			}
		}

		// 4. First settled turn with >= 3 tool calls
		const last = state.agent.lastTurn;
		if (last !== null && last.toolCount >= TOOLS_MOMENT_MIN_CALLS && eligible("moment:first-tools", ["/view"])) {
			const text =
				width >= 96
					? "/view inspects recorded tool calls and full outputs"
					: width >= 80
						? "/view inspects tool calls and outputs"
						: "/view inspects tool calls";
			return { id: "moment:first-tools", text };
		}
	}

	return null;
}
