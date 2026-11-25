// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { terminalBackground } from "../../src/core/terminal-background.js";
import type { PaletteColor } from "../../src/core/theme-token-hex.js";
import { paletteProjection, TERMINAL_PALETTE } from "../../src/core/theme-token-hex.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { type CouncilGroupView, councilGroupBody } from "../../src/interactive/council-grid.js";
import { createDispatchBoardView } from "../../src/interactive/dispatch-board.js";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-row-model.js";
import { frame, GLYPH, pancodeTheme } from "../../src/interactive/theme/index.js";
import { buildWelcomeDashboardLines, type WelcomeDashboardStats } from "../../src/interactive/welcome-dashboard.js";

const WIDTHS = [60, 80, 120, 200] as const;
const ESC = String.fromCharCode(27);

// Semantic roles resolve to the authoritative terminal palette, including colors
// that no legacy compatibility token names.
const PALETTE_HEX: ReadonlySet<string> = new Set(
	(Object.keys(TERMINAL_PALETTE) as PaletteColor[]).map((color) => paletteProjection(color, terminalBackground())[0]),
);

const hex = (channels: readonly (string | number)[]): string =>
	`#${channels.map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`;

/** The welcome wordmark's one ramp: an RGB mix from the brand green to the secondary azure, within one step of rounding. */
function onWordmarkRamp(value: string): boolean {
	const rgb = (color: string): number[] => [1, 3, 5].map((at) => Number.parseInt(color.slice(at, at + 2), 16));
	const from = rgb(paletteProjection("cyanFocal", terminalBackground())[0]);
	const to = rgb(paletteProjection("orangeFocal", terminalBackground())[0]);
	const span = to.map((channel, index) => channel - (from[index] ?? 0));
	const offset = rgb(value).map((channel, index) => channel - (from[index] ?? 0));
	const length = span.reduce((sum, channel) => sum + channel * channel, 0);
	const t = offset.reduce((sum, channel, index) => sum + channel * (span[index] ?? 0), 0) / length;
	return t >= 0 && t <= 1 && offset.every((channel, index) => Math.abs(channel - (span[index] ?? 0) * t) <= 1);
}

/**
 * Every escape is an SGR, and every truecolor SGR paints a palette token, or a step of the wordmark ramp where the
 * caller draws the welcome art. A 256-color or NO_COLOR run carries no truecolor codes, so it passes on shape.
 */
function assertTokensOnly(
	lines: readonly string[],
	allowedColors: ReadonlySet<string> = PALETTE_HEX,
	wordmarkRamp = false,
): void {
	for (const line of lines) {
		for (const sequence of line.split(ESC).slice(1)) {
			match(sequence, /^\[[0-9;]*m/u, `non-SGR escape ${JSON.stringify(sequence)}`);
			for (const color of sequence.matchAll(/[34]8;2;(\d+);(\d+);(\d+)/gu)) {
				const value = hex(color.slice(1, 4));
				ok(
					allowedColors.has(value) || (wordmarkRamp && onWordmarkRamp(value)),
					`color ${value} is not in the theme palette`,
				);
			}
		}
	}
}

function assertFits(lines: readonly string[], width: number): void {
	for (const line of lines) {
		ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${stripTerminalSequences(line)}`);
	}
}

/** The one island recipe from theme/rules.ts: square corners, side rails, exact width. */
function assertIsland(
	lines: readonly string[],
	width: number,
	title: string | null,
	allowedColors: ReadonlySet<string> = PALETTE_HEX,
): void {
	const plain = lines.map(stripTerminalSequences);
	ok(plain.length >= 3);
	match(
		plain[0] ?? "",
		title === null ? /^┌─+┐$/u : new RegExp(`^┌─ ${title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} ─+.*┐$`, "u"),
	);
	match(plain.at(-1) ?? "", /^└─+┘$/u);
	for (const row of plain.slice(1, -1)) match(row, /^│ .* │$/u);
	for (const row of plain) strictEqual(visibleWidth(row), width, row);
	assertTokensOnly(lines, allowedColors);
}

const stats: WelcomeDashboardStats = {
	outputStyle: "detailed",
	cwd: "/work/pancode",
	workspace: null,
	targetLabel: "blade",
	modelLabel: "dynamo/qwopus3.8-27b-flash@q5_k_m",
	route: "ready",
	routeReason: null,
	projectContext: "ok",
	submitKeyLabel: "Enter",
	autonomy: "default",
	targets: "2 configured · 2 ready · blade, mini-vision",
	fleet: "8 agent recipes · 2 profiles",
	quota: "Claude 5h 23% used · Codex wk 21% used",
};

test("the detailed launchpad is open: no frame, the version on its header row, non-duplicated orientation facts", () => {
	for (const width of WIDTHS) {
		const lines = buildWelcomeDashboardLines(stats, "0.5.6", width, "launchpad");
		assertFits(lines, width);
		assertTokensOnly(lines, PALETTE_HEX, true);
		const plain = lines.map(stripTerminalSequences);
		ok(!plain.some((row) => /[┌┐└┘│╭╮╰╯├┤]/u.test(row)), "no frame at any width");
		ok(
			plain.some((row) => row.includes("▐P▌ PanCode 0.5.6")),
			plain.join("\n"),
		);
		const joined = plain.join("\n");
		match(joined, /health {5}✓ ready/u);
		match(joined, /sandbox {4}/u);
		match(joined, /awareness {2}/u);
		match(joined, /last here {2}/u);
		ok(!joined.includes("? keys"), "launchpad must not duplicate Status Line Row 2 keys");
	}
});

test("the collapsed session header is one row that never exceeds the width", () => {
	for (const width of WIDTHS) {
		const lines = buildWelcomeDashboardLines(stats, "0.5.6", width, "session");
		strictEqual(lines.length, 1);
		assertFits(lines, width);
		assertTokensOnly(lines);
	}
});

const member = (runId: string, label: string) => ({
	runId,
	label,
	round: 2,
	route: "local/example-model",
	status: { glyph: GLYPH.running, label: "running", token: "action" as const },
	tailText: "weighing the render budget against the prefix cache",
	droppedLines: 0,
});

const council: CouncilGroupView = {
	group: "c1",
	members: [member("r1", "fable"), member("r2", "astra"), member("r3", "sol")],
	synthesis: null,
	status: { glyph: GLYPH.running, label: "running", token: "action" },
	round: 2,
	elapsed: "1m 04s",
};

test("the council card frames its grid or stack inside the width at every width", () => {
	for (const width of WIDTHS) {
		const lines = frame(pancodeTheme(), "council c1", councilGroupBody(pancodeTheme(), council, width - 4), width, {
			rightMeta: council.elapsed,
		});
		assertIsland(lines, width, "council c1");
	}
});

const run: DispatchBoardRow = {
	runId: "run-1",
	agentId: "scout",
	agentAudience: "base",
	origin: "agent",
	runtimeId: "native",
	endpointId: "blade",
	wireModelId: "dynamo/qwopus3.8-27b-flash@q5_k_m",
	status: "running",
	elapsed: "12s",
	elapsedMs: 12_000,
	startedAtMs: 0,
	usage: { kind: "pending" },
	task: "map the render path of the fleet island",
} as unknown as DispatchBoardRow;

test("a dispatch card spends the hollow diamond on origin only, never on a trust verdict", () => {
	for (const verdict of ["grounded", "unverified"] as const) {
		const row = {
			...run,
			origin: "operator",
			status: "completed",
			trust: { version: 1, verdict, text: `${verdict} by worker prose`, axes: {}, claimant: "worker" },
		} as unknown as DispatchBoardRow;
		for (const width of WIDTHS) {
			const lines = createDispatchBoardView(
				() => [row],
				() => undefined,
			).render(width);
			assertFits(lines, width);
			assertTokensOnly(lines);
			const plain = lines.map(stripTerminalSequences).join("\n");
			match(
				plain,
				new RegExp(`(?<!${GLYPH.workerHuman} )${verdict} by worker prose`, "u"),
				`${width}: ${verdict} has no glyph`,
			);
		}
	}
});

test("a title or meta wider than the island is clipped so the top border keeps the island width", () => {
	for (const width of WIDTHS) {
		const lines = frame(pancodeTheme(), "council ".repeat(32), ["body"], width, { rightMeta: "12m 04s" });
		for (const row of lines) strictEqual(visibleWidth(row), width, stripTerminalSequences(row));
		match(stripTerminalSequences(lines[0] ?? ""), /^┌─ council .*…┐$/u);
	}
});
