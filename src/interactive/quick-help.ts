// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { tierPolicy, tierRevision } from "../core/presentation-tier.js";
import { asciiOnly } from "../core/terminal-preferences.js";
import { PANCODE_APP_KEYBINDING_IDS, type PancodeKeybinding } from "../domains/config/keybindings.js";
import { type Component, type Keybinding, type OverlayHandle, type TUI, visibleWidth } from "../engine/tui.js";
import { formatKeyLabel } from "./keybinding-manager.js";
import { fitRow, showPancodeOverlayFrame } from "./overlay-frame.js";
import { fitUnits, GLYPH, keyName, padAnsi, pancodeTheme } from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";

/**
 * `?` on an empty composer: the keys an operator reaches for, on one card.
 *
 * The full `/help` lists every binding, pi's editor primitives included, which
 * is the wrong answer to "what can I press right now". This card is curated:
 * the composer prefixes and the empty-composer keys on the left, PanCode's own
 * actions on the right, each spelled the one way the footer and welcome spell
 * it (`Alt+M`, or `Ctrl+G Y` for an action with no direct key), read live from
 * the keybinding manager. The header states the rule that makes the right
 * column memorable: every letter there also works after the action menu key.
 * The card is not modal: the next key closes it, the way a glance ends. At
 * compact the card is the two lists alone; standard and detailed add the rule.
 */

export interface QuickHelpKeys {
	readonly generation?: number;
	getKeys?(id: Keybinding): ReadonlyArray<string>;
	getDescription?(id: Keybinding): string;
	getLabel?(id: Keybinding): string;
	/** The one spelling hints use; absent, the card spells the first direct key. */
	actionLabel?(id: Keybinding): string;
	leaderTargets?(): ReadonlyArray<{ id?: Keybinding | undefined }>;
}

interface QuickHelpRow {
	key: string;
	verb: string;
}

/** Not lessons: the menu key heads the card, and exit and suspend are terminal habits. */
const OFF_CARD: ReadonlySet<PancodeKeybinding> = new Set([
	"pancode.leader",
	"pancode.exit",
	"pancode.suspend",
	"pancode.message.dequeue",
	"pancode.model.cycleForward",
	"pancode.model.cycleBackward",
]);

function composerRows(menuKey: string | null, wide: boolean): QuickHelpRow[] {
	return [
		{ key: "/", verb: "commands" },
		{ key: "!", verb: "shared shell" },
		{ key: "!!", verb: wide ? "private shell (hidden)" : "private shell" },
		{ key: "@", verb: "attach a file" },
		{ key: asciiOnly() ? keyName("left") : GLYPH.left, verb: "workers" },
		{ key: asciiOnly() ? keyName("down") : GLYPH.down, verb: "tasks" },
		...(menuKey ? [{ key: menuKey, verb: wide ? "actions menu by letter" : "actions menu" }] : []),
		{ key: "Esc", verb: "stop a run" },
		{ key: `${keyName("ctrl+c")} ${GLYPH.times}2`, verb: "exit" },
	];
}

function powerColumns(wide: boolean, detailed: boolean): { left: QuickHelpRow[]; right: QuickHelpRow[] } {
	const left: QuickHelpRow[] = [
		{ key: "/run", verb: wide ? "dispatch parallel workers" : "parallel workers" },
		{ key: "/loop", verb: wide ? "schedule recurring checks" : "recurring checks" },
		{ key: "/tasks", verb: wide ? "agent & operator boards" : "task boards" },
		...(detailed ? [{ key: "/view", verb: "inspect tool calls" }] : []),
	];
	const right: QuickHelpRow[] = [
		{ key: "/memory", verb: wide ? "project notes & lessons" : "project notes" },
		{ key: "/context", verb: wide ? "inspect or compact window" : "inspect window" },
		{ key: "/usage", verb: wide ? "spend, quotas & health" : "spend & quotas" },
		...(detailed ? [{ key: "/settings", verb: "routes & safety" }] : []),
	];
	return { left, right };
}

function actionRows(bindings: QuickHelpKeys, omit: (id: PancodeKeybinding) => boolean): QuickHelpRow[] {
	const menu = new Set((bindings.leaderTargets?.() ?? []).map((target) => target.id));
	return PANCODE_APP_KEYBINDING_IDS.flatMap((id) => {
		if (OFF_CARD.has(id) || omit(id)) return [];
		const keys = bindings.getKeys?.(id) ?? [];
		if (keys.length === 0 && !menu.has(id)) return [];
		const verb = bindings.getLabel?.(id) ?? bindings.getDescription?.(id) ?? "";
		const key = bindings.actionLabel?.(id) ?? formatKeyLabel(keys[0], "");
		return verb.length > 0 && key.length > 0 ? [{ key, verb }] : [];
	});
}

function ruleHeader(menuKey: string, width: number): string {
	const text =
		width >= 84
			? `Alt+letter runs an action ${GLYPH.sep} ${menuKey} then the same letter works anywhere`
			: width >= 68
				? `Alt+letter runs an action ${GLYPH.sep} ${menuKey} then letter works anywhere`
				: `Alt+letter or ${menuKey} then letter runs an action`;
	return fitRow(pancodeTheme().fg("annotation", text), width);
}

/** Minimum rows reserved for the key list before the Powers band collapses to its single-line variant. */
const MIN_KEY_ROWS = 6;

function collapsedPowersRow(
	theme: ReturnType<typeof pancodeTheme>,
	powers: ReadonlyArray<QuickHelpRow>,
	width: number,
): string {
	const lead = `${theme.style("sectionHeading", "Powers", { bold: true })}${theme.fg("separator", ` ${GLYPH.sep} `)}`;
	const tail = `${theme.fg("separator", ` ${GLYPH.sep} `)}${theme.fg("annotation", "/help")}`;
	const room = width - visibleWidth(lead) - visibleWidth(tail);
	if (room < 8) {
		return fitRow(`${lead}${theme.fg("annotation", "/help")}`, width);
	}
	const names = powers.map((entry) => theme.fg("commandHint", entry.key));
	const shown: string[] = [];
	let used = 0;
	for (const name of names) {
		const w = visibleWidth(name);
		const add = shown.length === 0 ? w : w + 1;
		if (used + add > room) break;
		shown.push(name);
		used += add;
	}
	if (shown.length === 0) return fitRow(`${lead}${theme.fg("annotation", "/help")}`, width);
	return fitRow(`${lead}${shown.join(" ")}${tail}`, width);
}

/**
 * Trim the key list to `budget` rows, ending with a single `… N more in /help` line when rows are held back.
 * In two-column layout, the 9 composer prefixes stay whole and only trailing right-column actions trim;
 * in one-column layout, both prefixes and top actions keep room so primary keys (`Alt+U Details`, `Alt+M`) stay visible.
 */
function fitKeySection(
	theme: ReturnType<typeof pancodeTheme>,
	leftLines: ReadonlyArray<string>,
	rightLines: ReadonlyArray<string>,
	width: number,
	wide: boolean,
	leftWidth: number,
	rightWidth: number,
	gap: number,
	budget: number,
): string[] {
	if (wide) {
		const total = Math.max(leftLines.length, rightLines.length);
		const pad = " ".repeat(gap);
		if (budget <= 0 || total <= budget) {
			return Array.from(
				{ length: total },
				(_, index) => `${padAnsi(leftLines[index] ?? "", leftWidth)}${pad}${rightLines[index] ?? ""}`,
			);
		}
		const kept = Math.max(1, budget - 1);
		const hiddenLeft = Math.max(0, leftLines.length - kept);
		const hiddenRight = Math.max(0, rightLines.length - kept);
		const hidden = hiddenLeft + hiddenRight;
		const more = fitRow(theme.fg("annotation", `${GLYPH.ellipsis} ${hidden} more in /help`), rightWidth);
		const rows = Array.from(
			{ length: kept },
			(_, index) => `${padAnsi(leftLines[index] ?? "", leftWidth)}${pad}${rightLines[index] ?? ""}`,
		);
		const lastLeft = hiddenLeft > 0 ? "" : (leftLines[kept] ?? "");
		rows.push(`${padAnsi(lastLeft, leftWidth)}${pad}${more}`);
		return rows;
	}
	const full = [...leftLines, ...(leftLines.length > 0 && rightLines.length > 0 ? [""] : []), ...rightLines];
	if (budget <= 0 || full.length <= budget) return full;
	if (budget <= 1) {
		return [
			fitRow(theme.fg("annotation", `${GLYPH.ellipsis} ${leftLines.length + rightLines.length} more in /help`), width),
		];
	}
	const slots = budget - 1;
	// Reserve up to 5 slots for primary actions (so Alt+O, Shift+Tab, Alt+M, Alt+L, Alt+U Deck stay visible at 60x39).
	const rightSlots = Math.min(rightLines.length, Math.max(1, Math.min(5, Math.ceil(slots / 2))));
	const leftSlots = Math.min(leftLines.length, Math.max(0, slots - rightSlots));
	const keptRight = Math.min(rightLines.length, slots - leftSlots);
	const hidden = leftLines.length - leftSlots + (rightLines.length - keptRight);
	return [
		...leftLines.slice(0, leftSlots),
		...rightLines.slice(0, keptRight),
		fitRow(theme.fg("annotation", `${GLYPH.ellipsis} ${hidden} more in /help`), width),
	];
}

/**
 * The two-column body with the Powers band, or one column below 84 cells, the documented stacking width.
 * Budget-aware: never orphans a Powers heading without its rows. When height is bounded, trims trailing key rows
 * first so the full Powers band renders whole; if still too tight, collapses Powers to one inline `/help` row.
 */
function quickHelpRows(
	width: number,
	bodyRows: number,
	bindings: QuickHelpKeys,
	omit: (id: PancodeKeybinding) => boolean,
): string[] {
	const theme = pancodeTheme();
	const policy = tierPolicy();
	const wide = width >= 84;
	const leader = bindings.getKeys?.("pancode.leader")[0];
	const menuKey = leader ? formatKeyLabel(leader) : null;
	// The rule that makes the right column memorable is the card's one description row.
	const header = menuKey && policy.listDescriptions === "all" ? ruleHeader(menuKey, width) : null;
	const left = composerRows(menuKey, wide);
	const right = actionRows(bindings, omit);
	const powers = powerColumns(wide, policy.provenance);
	const allPowers = [...powers.left, ...powers.right];
	const column = (rows: ReadonlyArray<QuickHelpRow>, cells: number): string[] => {
		const keyWidth = Math.min(16, Math.max(0, ...rows.map((row) => row.key.length)));
		return rows.map((row) =>
			fitUnits(theme, `${theme.style("guidance", padAnsi(row.key, keyWidth), { bold: true })}  `, [row.verb], cells),
		);
	};
	const powerColumn = (rows: ReadonlyArray<QuickHelpRow>, cells: number): string[] => {
		const keyWidth = Math.min(16, Math.max(0, ...rows.map((row) => row.key.length)));
		return rows.map((row) =>
			fitUnits(theme, `${theme.fg("commandHint", padAnsi(row.key, keyWidth))}  `, [row.verb], cells),
		);
	};
	const powersHeading = fitRow(theme.style("sectionHeading", "Powers", { bold: true }), width);
	const gap = 3;
	const leftWidth = wide ? Math.floor((width - gap) * 0.42) : width;
	const rightWidth = wide ? width - gap - leftWidth : width;
	const leftLines = column(left, leftWidth);
	const rightLines = column(right, rightWidth);

	const fullLead = header ? [header, ""] : [];
	const tightLead = header ? [header] : [];

	if (wide) {
		// Place Powers directly below the 9 Composer prefix rows inside the left column so 96x39 holds
		// every prefix, every action, and every power cleanly without `… more in /help` overflow.
		const basePowers = [...powers.left.slice(0, 3), ...powers.right.slice(0, 3)];
		const extraPowers = [...powers.left.slice(3), ...powers.right.slice(3)];
		const leftHeading = fitRow(theme.style("sectionHeading", "Powers", { bold: true }), leftWidth);
		const leftAllPowers = [...leftLines, "", leftHeading, ...powerColumn(allPowers, leftWidth)];
		const leftBasePowers = [...leftLines, "", leftHeading, ...powerColumn(basePowers, leftWidth)];
		const rightWithExtras =
			extraPowers.length > 0 ? [...rightLines, "", ...powerColumn(extraPowers, rightWidth)] : rightLines;
		const zipCols = (l: ReadonlyArray<string>, r: ReadonlyArray<string>): string[] => {
			const total = Math.max(l.length, r.length);
			const pad = " ".repeat(gap);
			return Array.from({ length: total }, (_, index) => `${padAnsi(l[index] ?? "", leftWidth)}${pad}${r[index] ?? ""}`);
		};

		const natural = [...fullLead, ...zipCols(leftAllPowers, rightLines)];
		if (bodyRows <= 0 || natural.length <= bodyRows) return natural;

		const tightNatural = [...tightLead, ...zipCols(leftAllPowers, rightLines)];
		if (tightNatural.length <= bodyRows) return tightNatural;

		// At detailed 96x39 (19 rows), place /view & /settings below the shorter right Actions column so all 8 fit whole.
		if (extraPowers.length > 0) {
			const balancedFull = [...fullLead, ...zipCols(leftBasePowers, rightWithExtras)];
			if (balancedFull.length <= bodyRows) return balancedFull;
			const balancedTight = [...tightLead, ...zipCols(leftBasePowers, rightWithExtras)];
			if (balancedTight.length <= bodyRows) return balancedTight;
		}

		// Shorter wide terminals (e.g. 96x24): keep Powers intact as a 2-col footer band and trim trailing right actions.
		const powerLeftWidth = Math.floor((width - gap) / 2);
		const powerRightWidth = width - gap - powerLeftWidth;
		const powerLeftLines = powerColumn(powers.left, powerLeftWidth);
		const powerRightLines = powerColumn(powers.right, powerRightWidth);
		const powerBand = [
			powersHeading,
			...Array.from(
				{ length: Math.max(powerLeftLines.length, powerRightLines.length) },
				(_, index) =>
					`${padAnsi(powerLeftLines[index] ?? "", powerLeftWidth)}${" ".repeat(gap)}${powerRightLines[index] ?? ""}`,
			),
		];
		const collapsedLine = collapsedPowersRow(theme, allPowers, width);
		const candidates: ReadonlyArray<{ lead: readonly string[]; powers: readonly string[]; minKeys: number }> = [
			{ lead: tightLead, powers: ["", ...powerBand], minKeys: MIN_KEY_ROWS },
			{ lead: tightLead, powers: powerBand, minKeys: MIN_KEY_ROWS },
			{ lead: tightLead, powers: ["", collapsedLine], minKeys: MIN_KEY_ROWS },
			{ lead: tightLead, powers: [collapsedLine], minKeys: 2 },
			{ lead: [], powers: [collapsedLine], minKeys: 1 },
			{ lead: [], powers: [], minKeys: 1 },
		];
		for (const candidate of candidates) {
			const keyBudget = bodyRows - candidate.lead.length - candidate.powers.length;
			if (keyBudget < candidate.minKeys) continue;
			const keys = fitKeySection(theme, leftLines, rightLines, width, true, leftWidth, rightWidth, gap, keyBudget);
			return [...candidate.lead, ...keys, ...candidate.powers];
		}
		return fitKeySection(theme, leftLines, rightLines, width, true, leftWidth, rightWidth, gap, bodyRows);
	}

	// Below 84 cols (60x39 stacked layout): order Composer -> Powers -> Actions so Powers stays visible without scrolling.
	const fullPowerRows = [powersHeading, ...powerColumn(allPowers, width)];
	const fullStacked = [...fullLead, ...leftLines, "", ...fullPowerRows, "", ...rightLines];
	if (bodyRows <= 0 || fullStacked.length <= bodyRows) return fullStacked;

	const collapsedLine = collapsedPowersRow(theme, allPowers, width);
	const fitStacked = (lead: readonly string[], powersBlock: readonly string[], budget: number): string[] | null => {
		const keyBudget = budget - lead.length - powersBlock.length;
		if (keyBudget < 1) return null;
		if (keyBudget <= 1) {
			return [
				...lead,
				...powersBlock,
				fitRow(theme.fg("annotation", `${GLYPH.ellipsis} ${leftLines.length + rightLines.length} more in /help`), width),
			];
		}
		const slots = keyBudget - 1;
		const rightSlots = Math.min(rightLines.length, Math.max(1, Math.min(5, Math.ceil(slots / 2))));
		const leftSlots = Math.min(leftLines.length, Math.max(0, slots - rightSlots));
		const keptRight = Math.min(rightLines.length, slots - leftSlots);
		const hidden = leftLines.length - leftSlots + (rightLines.length - keptRight);
		return [
			...lead,
			...leftLines.slice(0, leftSlots),
			...powersBlock,
			...rightLines.slice(0, keptRight),
			fitRow(theme.fg("annotation", `${GLYPH.ellipsis} ${hidden} more in /help`), width),
		];
	};
	const candidates: ReadonlyArray<{ lead: readonly string[]; powers: readonly string[]; minKeys: number }> = [
		{ lead: fullLead, powers: ["", ...fullPowerRows, ""], minKeys: Math.max(MIN_KEY_ROWS, leftLines.length) },
		{ lead: tightLead, powers: ["", ...fullPowerRows, ""], minKeys: MIN_KEY_ROWS },
		{ lead: tightLead, powers: ["", ...fullPowerRows], minKeys: MIN_KEY_ROWS },
		{ lead: tightLead, powers: fullPowerRows, minKeys: MIN_KEY_ROWS },
		{ lead: tightLead, powers: ["", collapsedLine, ""], minKeys: MIN_KEY_ROWS },
		{ lead: tightLead, powers: [collapsedLine], minKeys: 2 },
		{ lead: [], powers: [collapsedLine], minKeys: 1 },
		{ lead: [], powers: [], minKeys: 1 },
	];
	for (const candidate of candidates) {
		const keyBudget = bodyRows - candidate.lead.length - candidate.powers.length;
		if (keyBudget < candidate.minKeys) continue;
		const built = fitStacked(candidate.lead, candidate.powers, bodyRows);
		if (built !== null) return built;
	}
	return fitKeySection(theme, leftLines, rightLines, width, false, width, width, gap, bodyRows);
}

export interface QuickHelp {
	isOpen(): boolean;
	open(): void;
	close(): void;
}

/** `omit` drops actions this session cannot use. */
export function createQuickHelp(
	tui: TUI,
	bindings: QuickHelpKeys,
	omit: (id: PancodeKeybinding) => boolean = () => false,
): QuickHelp {
	let handle: OverlayHandle | null = null;
	let cached: {
		width: number;
		bodyRows: number;
		generation: number | undefined;
		tier: number;
		skin: number;
		lines: string[];
	} | null = null;
	let bodyRows = 0;
	const component: Component & { setBodyRows(rows: number): void } = {
		setBodyRows(rows: number) {
			bodyRows = Math.max(0, Math.floor(rows));
		},
		render(width) {
			if (
				cached?.width !== width ||
				cached.bodyRows !== bodyRows ||
				cached.generation !== bindings.generation ||
				cached.tier !== tierRevision() ||
				cached.skin !== skinEpoch()
			)
				cached = {
					width,
					bodyRows,
					generation: bindings.generation,
					tier: tierRevision(),
					skin: skinEpoch(),
					lines: quickHelpRows(width, bodyRows, bindings, omit),
				};
			return cached.lines;
		},
		invalidate() {
			cached = null;
		},
	};
	return {
		isOpen: () => handle !== null,
		open() {
			if (handle !== null) return;
			cached = null;
			handle = showPancodeOverlayFrame(tui, component, {
				title: "Keys",
				markerId: "quick-help",
				nonCapturing: true,
				adaptiveHeight: true,
				footerHint: "any key closes",
			});
			tui.requestRender();
		},
		close() {
			handle?.hide();
			handle = null;
			tui.requestRender();
		},
	};
}
