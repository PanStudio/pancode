// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { presentationTier, setPresentationTier } from "../../src/core/presentation-tier.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";
import { renderDeckDrawer } from "../../src/interactive/footer/deck-drawer.js";
import { createNotificationCenter } from "../../src/interactive/footer/notifications.js";
import { dashboardPageViewport, machineBlock, renderCompactDashboard } from "../../src/interactive/footer/pages.js";
import { renderStatusLine } from "../../src/interactive/footer/status-line.js";
import { createPancodeTheme, paletteRgb } from "../../src/interactive/theme/index.js";
import { footerState } from "../harness/footer-fixture.js";

test("the narrow footer leads with the mark, keeps the model id at the right edge, and carries context on Row 1", () => {
	const state = footerState();
	state.agent.statusText = "Ready";
	state.dispatchRows = [];
	state.session.targetId = "blade";
	state.session.modelId = "dynamo/qwopus3.8-27b-flash@q4_k_m";
	state.context = { ...state.context, ledger: null, used: null };
	for (const width of [40, 59, 60, 61, 80, 120]) {
		const rows = renderCompactDashboard(state, width).map(stripTerminalSequences);
		// Standard is two rows; a W1 width keeps the status bar alone.
		strictEqual(rows.length, width < 44 ? 1 : 2);
		for (const row of rows) ok(visibleWidth(row) <= width);
		match(rows[0] ?? "", /^\s*▐∀▌ /);
		match(rows[0] ?? "", /q4_k_m\s*$/);
		if (width >= 80) match(rows[0] ?? "", /v050/);
		strictEqual(visibleWidth(rows[0] ?? ""), width);
	}
});

test("the status line owns context occupancy across measurement states and stays bounded", () => {
	const state = footerState();
	state.context.budget = { revision: "1", historical: false, inputSource: "estimated" };
	state.context.used = 50_000;
	state.context.contextWindow = 100_000;
	const rowAt = (width: number): string => {
		const row = stripTerminalSequences(renderCompactDashboard(state, width)[0] ?? "");
		ok(visibleWidth(row) <= width);
		return row;
	};
	match(rowAt(60), /ctx ≈50%/);
	doesNotMatch(rowAt(40), /▰|▱/);
	state.context.budget = { revision: "2", historical: true, inputSource: "historical" };
	match(rowAt(80), /ctx .*saved 50%/);
	state.context.used = null;
	state.context.budget = { revision: "3", historical: false, inputSource: "unknown" };
	match(rowAt(80), /ctx 100k/);
	state.context.used = 0;
	state.context.budget = { revision: "4", historical: false, inputSource: "estimated" };
	match(rowAt(80), /ctx .*≈0%/);
});

test("the detailed dashboard keeps the estimate marker and omits unavailable rates", () => {
	const state = footerState();
	state.context.used = null;
	state.outputStyle = "standard";
	state.throughput = { tokensPerSecond: 12.3, outputTokens: 123, durationMs: 10000, estimated: true };
	// Unlearned idle Row 2 keeps keys rather than rate telemetry.
	doesNotMatch(renderCompactDashboard(state, 120).map(stripTerminalSequences).join("\n"), /tok\/s/);
	state.outputStyle = "detailed";
	state.throughput = { tokensPerSecond: 12.3, outputTokens: 123, durationMs: 10000, estimated: true };
	const plain = () => dashboardPageViewport(state, 120, 60, "Alt+U").map(stripTerminalSequences).join("\n");
	match(plain(), /≈12\s*tok\/s/);
	state.throughput.estimated = false;
	match(plain(), /12\s*tok\/s/);
	doesNotMatch(plain(), /≈12/);
	for (const rate of [0, NaN, Infinity]) {
		state.throughput.tokensPerSecond = rate;
		doesNotMatch(plain(), /tok\/s/);
	}
});

test("a narrow alert row sits above the status bar and preserves urgent chords and errors", () => {
	const state = footerState();
	state.agent.statusText = "Ready";
	state.notices = [
		{ id: "error", level: "error", text: "Provider unavailable", key: null, addedAt: 1, expiresAt: null },
		{ id: "info", level: "info", text: "Saved", key: null, addedAt: 2, expiresAt: null },
	];
	for (const width of [40, 60]) {
		const rows = renderCompactDashboard(state, width).map(stripTerminalSequences);
		// A W1 width keeps the alert and status bar; standard at 60 adds its key row.
		strictEqual(rows.length, width < 44 ? 2 : 3);
		match(rows[0] ?? "", /✗ Provider unavailab(?:le|…)/);
		match(rows[1] ?? "", /^\s*▐∀▌ /);
		doesNotMatch(rows.join("\n"), /Saved/);
		for (const row of rows) ok(visibleWidth(row) <= width);
		state.session.shutdownArmed = true;
		match(stripTerminalSequences(renderCompactDashboard(state, width)[0] ?? ""), /Ctrl\+C again to quit/);
		state.session.shutdownArmed = false;
	}
	state.notices = [];
	strictEqual(renderCompactDashboard(state, 60).length, 2);
	state.session.leaderArmed = true;
	match(stripTerminalSequences(renderCompactDashboard(state, 60)[0] ?? ""), /choose key/i);
});

test("the machine block splits its meters only when wide and names its sampling", () => {
	const resource = {
		cpuPercent: 12,
		hostTotalBytes: 16 * 1024 ** 3,
		hostFreeBytes: 8 * 1024 ** 3,
		processRssBytes: 200 * 1024 ** 2,
		sampledAt: 1000,
		scope: "local OS",
		network: null,
		disk: null,
		gpu: null,
	};
	for (const width of [60, 80, 83, 84, 120, 200]) {
		const lines = machineBlock(resource, 3000, width).map(stripTerminalSequences);
		for (const row of lines) ok(stripTerminalSequences(row).length <= width);
		const cpu = lines.find((line) => line.includes("CPU")) ?? "";
		ok(width < 84 ? !cpu.includes("RAM") : cpu.includes("RAM"), "machine meters split only when wide");
		for (const label of ["Machine ─", "PanCode RSS", "Sampling", "Scope"]) match(lines.join("\n"), new RegExp(label));
	}
});

test("small terminals auto-fold the deck drawer under H1/W1 and never scroll", () => {
	const state = footerState();
	for (const width of [24, 40, 60, 120]) {
		for (const height of [12, 18, 24, 30, 40]) {
			const rows = dashboardPageViewport(state, width, height, "Alt+U");
			const expected = width < 44 || height < 20 ? 0 : 4;
			strictEqual(rows.length, expected, `width=${width} height=${height}`);
			for (const row of rows) ok(visibleWidth(row) <= width);
			doesNotMatch(rows.map(stripTerminalSequences).join("\n"), /of \d+ rows|Alt\+PgUp/u);
		}
	}
});

test("notification store drops TUI-side Tip info notices while keeping warnings and real info", () => {
	const store = createNotificationCenter({ now: () => 1000 });
	store.add({ level: "info", text: "Tip: press Alt+M to switch model" });
	store.add({ level: "info", text: "  tip: something else" });
	strictEqual(store.list(1000).length, 0);
	store.add({ level: "warning", text: "Tip: permission needed" });
	store.add({ level: "info", text: "Saved session" });
	strictEqual(store.list(1000).length, 2);
});

test("compact tier stays at most 2 rows even when busy with alerts, and ASCII identity uses parens", () => {
	const state = footerState();
	state.status = {
		phase: "writing",
		since: 1000,
		lastMeaningfulAt: 4000,
		watchdogTier: 0,
		watchdogPeak: 0,
		localRuntime: false,
	};
	state.notices = [{ id: "e1", level: "error", text: "Provider offline", key: null, addedAt: 1000, expiresAt: null }];
	const prevTier = presentationTier();
	setPresentationTier("compact");
	try {
		const rows = renderCompactDashboard(state, 96);
		strictEqual(rows.length, 2);
		match(stripTerminalSequences(rows[0] ?? ""), /Provider offline/);
		match(stripTerminalSequences(rows[1] ?? ""), /writing/);
		state.notices = [];
		const busyRows = renderCompactDashboard(state, 96);
		strictEqual(busyRows.length, 2);
		match(stripTerminalSequences(busyRows[0] ?? ""), /Esc stops/);
		match(stripTerminalSequences(busyRows[1] ?? ""), /▐∀▌/);
	} finally {
		setPresentationTier(prevTier);
	}

	const prevAscii = process.env.PANCODE_ASCII;
	process.env.PANCODE_ASCII = "1";
	try {
		const asciiState = footerState();
		asciiState.workspace.dirty = true;
		asciiState.session.modelId = "qwopus";
		const row0 = stripTerminalSequences(renderCompactDashboard(asciiState, 96)[0] ?? "");
		match(row0, /▐∀▌ default {2}pancode \(v050\*\)/);
	} finally {
		if (prevAscii === undefined) delete process.env.PANCODE_ASCII;
		else process.env.PANCODE_ASCII = prevAscii;
	}
});

test("light theme lifts separator and divider contrast over raisedSurface", () => {
	const state = footerState();
	const lightTheme = createPancodeTheme({ depth: "truecolor", background: "light" });
	const row = renderStatusLine(state, 100, 40, lightTheme)[0] ?? "";
	const surface = paletteRgb("surface", "light").join(";");
	const rawDivider = paletteRgb("divider", "light").join(";");
	const rawTrack = paletteRgb("meterTrack", "light").join(";");
	const lifted = paletteRgb("neutralSubdued", "light").join(";");
	ok(row.includes(`48;2;${surface}`), "row paints raisedSurface background");
	ok(row.includes(`38;2;${lifted}`), "receding tokens lifted to neutralSubdued over raisedSurface");
	ok(!row.includes(`38;2;${rawDivider}`), "divider not left unlifted on light raisedSurface");
	ok(!row.includes(`38;2;${rawTrack}`), "meterTrack not left unlifted on light raisedSurface");
});

test("shell draft omits duplicate Enter runs on status row 2 and dispatching states live worker count", () => {
	const shellState = footerState();
	shellState.keyContext = "send-shell";
	const shellRows = renderCompactDashboard(shellState, 96).map(stripTerminalSequences);
	strictEqual(shellRows.length, 2);
	doesNotMatch(shellRows[1] ?? "", /Enter runs/u);

	const dispatchState = footerState();
	// A short route leaves room for the full phase wording at 120; a longer route keeps the count via shortSubject.
	dispatchState.session.targetId = "copilot";
	dispatchState.session.modelId = "gpt-6-luna";
	dispatchState.status = {
		phase: "dispatching",
		since: 1000,
		lastMeaningfulAt: 1000,
		watchdogTier: 0,
		watchdogPeak: 0,
		localRuntime: false,
	};
	dispatchState.now = 10_000;
	const row96 = stripTerminalSequences(renderCompactDashboard(dispatchState, 96)[0] ?? "");
	match(row96, /1 worker · 9s/u);
	const row120 = stripTerminalSequences(renderCompactDashboard(dispatchState, 120)[0] ?? "");
	match(row120, /waiting for 1 worker · 9s/u);
});

test("busy row 1 keeps elapsed clock from 0s, matches width step-downs, and places setting feedback below/inline", () => {
	const state = footerState();
	state.session.targetId = "copilot";
	state.session.modelId = "gpt-6-luna";
	state.thinking = {
		label: "low",
		hasLevels: true,
		supportedLevels: ["off", "low", "medium", "high"],
		quiet: false,
	};
	state.dispatchRows = [];
	state.status = {
		phase: "waiting_model",
		since: 10_000,
		phaseSince: 10_000,
		lastMeaningfulAt: 10_000,
		watchdogTier: 0,
		watchdogPeak: 0,
		localRuntime: false,
	};
	state.now = 10_200; // < 1s into phase: must still render `· 0s`

	// 120 busy with long 42-char cwd: picks `~/…/<parent>/<dir>` BEFORE dropping `copilot` target
	state.workspace.cwd = "~/experiments/scratch/fw-v090/verify/project-dir";
	const busy120Long = stripTerminalSequences(renderCompactDashboard(state, 120)[0] ?? "");
	match(busy120Long, /~\/…\/verify\/project-dir/u);
	match(busy120Long, /waiting for model · 0s/u);
	match(busy120Long, /copilot · gpt-6-luna/u);
	doesNotMatch(busy120Long, /low ●/u);
	state.workspace.cwd = "/workspace/pancode";

	// 120 busy: target kept, thinking omitted, clock from 0s
	const busy120 = stripTerminalSequences(renderCompactDashboard(state, 120)[0] ?? "");
	match(busy120, /waiting for model · 0s/u);
	match(busy120, /copilot · gpt-6-luna/u);
	doesNotMatch(busy120, /low ●/u);

	// 96 busy: basename `<dir>`, clock from 0s
	const busy96 = stripTerminalSequences(renderCompactDashboard(state, 96)[0] ?? "");
	match(busy96, /▐∀▌ default · pancode · v050/u);
	match(busy96, /waiting for model · 0s/u);

	// 60 busy: drops `<dir>` and `ctx `, keeps `<branch>`, clock, and `<%>`
	const busy60 = stripTerminalSequences(renderCompactDashboard(state, 60)[0] ?? "");
	doesNotMatch(busy60, /pancode/u);
	doesNotMatch(busy60, /\bctx\b/u);
	match(busy60, /▐∀▌ v050/u);
	match(busy60, /waiting · 0s/u);
	match(busy60, /26% │ gpt-6-luna/u);

	// Busy Row 2 omits duplicate Alt+Q queue (>= 60) and Alt+W fleet (when fleetBandVisible)
	state.keyHintFacts = { queued: 1, workers: 2 };
	state.fleetBandVisible = true;
	const busyRow2 = stripTerminalSequences(renderCompactDashboard(state, 96)[1] ?? "");
	doesNotMatch(busyRow2, /Alt\+Q|queue/u);
	doesNotMatch(busyRow2, /Alt\+W|fleet/u);

	// 80 idle: drops `default`, thinking is word-only (no dots)
	state.status = { ...state.status, phase: "idle" };
	const idle80 = stripTerminalSequences(renderCompactDashboard(state, 80)[0] ?? "");
	doesNotMatch(idle80, /\bdefault\b/u);
	match(idle80, /▐∀▌ pancode · v050/u);
	match(idle80, /│ low │ gpt-6-luna/u);

	// Compact busy Row 2 keeps `<level>` at 96 cols; compact idle setting feedback renders BELOW status bar
	const prevTier = presentationTier();
	setPresentationTier("compact");
	try {
		state.outputStyle = "compact";
		state.status = { ...state.status, phase: "waiting_model" };
		const compactBusy = renderCompactDashboard(state, 96).map(stripTerminalSequences);
		strictEqual(compactBusy.length, 2);
		match(compactBusy[1] ?? "", /26% · low · gpt-6-luna/u);

		// Compact busy setting feedback renders inline in Row 2 (<= 2 rows)
		state.notices = [
			{
				id: "fb-1",
				level: "info",
				text: "Output detail: compact",
				key: "settings:feedback",
				presentation: "setting",
				addedAt: 10_000,
				expiresAt: 13_000,
			},
		];
		const compactBusyFb = renderCompactDashboard(state, 96).map(stripTerminalSequences);
		strictEqual(compactBusyFb.length, 2);
		match(compactBusyFb[1] ?? "", /Output detail: compact/u);

		// Compact idle setting feedback renders BELOW status bar (never above)
		state.status = { ...state.status, phase: "idle" };
		const compactIdleFb = renderCompactDashboard(state, 96).map(stripTerminalSequences);
		strictEqual(compactIdleFb.length, 2);
		match(compactIdleFb[0] ?? "", /^ ▐∀▌/u);
		match(compactIdleFb[1] ?? "", /Output detail: compact/u);
	} finally {
		setPresentationTier(prevTier);
	}
});

test("Alt+U boxed island deck matches geometry, detailed default/welcome auto-fold, dock auto-hide, and light overOwned", () => {
	const state = footerState();
	state.session.targetId = "copilot";
	state.session.modelId = "gpt-6-luna";
	state.thinking = {
		label: "low",
		hasLevels: true,
		supportedLevels: ["off", "low", "medium", "high"],
		quiet: false,
	};

	// Exact 3-island geometry at 96 (`27+1+40+1+27`), 80 (`24+1+31+1+23`), 120 (`35+1+49+1+34`), 2-island at 60, 1-box at 50
	for (const width of [50, 60, 80, 96, 120]) {
		const rows = renderDeckDrawer(state, width, 40).map(stripTerminalSequences);
		strictEqual(rows.length, width < 60 ? 5 : 4, `standard deck row count at ${width}`);
		for (const row of rows) strictEqual(visibleWidth(row), width, `exact width ${width}: ${row}`);
	}
	const top96 = stripTerminalSequences(renderDeckDrawer(state, 96, 40)[0] ?? "");
	const segments96 = top96.split(" ┐".replace(" ", "")).length;
	ok(segments96 === 4, `three boxed islands at 96 cols: ${top96}`);
	match(top96, /Route.*Work.*Context/u);
	const top60 = stripTerminalSequences(renderDeckDrawer(state, 60, 40)[0] ?? "");
	match(top60, /Route & Context.*Work/u);

	// Light theme overOwned lifts border & meterFree over raisedSurface inside boxIsland
	const lightTheme = createPancodeTheme({ depth: "truecolor", background: "light" });
	const lightRows = renderDeckDrawer(state, 96, 40, { themeOverride: lightTheme });
	const surface = paletteRgb("surface", "light").join(";");
	const rawBorder = paletteRgb("border", "light").join(";");
	const lifted = paletteRgb("neutralSubdued", "light").join(";");
	ok((lightRows[0] ?? "").includes(`48;2;${surface}`), "deck paints raisedSurface background");
	ok((lightRows[0] ?? "").includes(`38;2;${lifted}`), "deck border lifts to neutralSubdued on light raisedSurface");
	ok(!(lightRows[0] ?? "").includes(`38;2;${rawBorder}`), "deck border not left unlifted on light raisedSurface");

	// Detailed opens deck by default (5 rows), auto-folds while welcomeVisible, opens when welcome hides, folds for dock/fleet
	const prevTier = presentationTier();
	let welcome = true;
	let keyContext: "idle" | "surface" = "idle";
	let fleetOpen = false;
	setPresentationTier("detailed");
	const footer = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getTerminalColumns: () => 96,
		getTerminalRows: () => 40,
		getWelcomeVisible: () => welcome,
		getKeyContext: () => keyContext,
		isFleetBoardOpen: () => fleetOpen,
		getDispatchRows: () => state.dispatchRows,
	});
	try {
		strictEqual(footer.isExpanded(), false, "detailed auto-folds while welcome launchpad is visible");
		strictEqual(footer.view.render(96).length, 2);

		welcome = false;
		strictEqual(footer.isExpanded(), true, "detailed opens deck automatically when welcome hides");
		const openLines = footer.view.render(96).map(stripTerminalSequences);
		strictEqual(openLines.length, 6, "5-row detailed deck + 1 slimmed anchor bar");
		match(openLines[0] ?? "", /Route.*Work.*Context/u);
		match(openLines[5] ?? "", /Alt\+U fold/u);

		// Any docked overlay auto-hides deck and reduces status line to Row 1
		keyContext = "surface";
		strictEqual(footer.isExpanded(), false, "deck auto-hides while a dock owns the surface");
		strictEqual(footer.view.render(96).length, 1);

		// /fleet hides deck and suppresses Row 1 worker count
		fleetOpen = true;
		const fleetLines = footer.view.render(96).map(stripTerminalSequences);
		strictEqual(fleetLines.length, 1);
		doesNotMatch(fleetLines[0] ?? "", /1 worker/u);
		fleetOpen = false;
		keyContext = "idle";

		// Explicit Alt+U toggle folds detailed deck; switching tier resets to new tier's default
		strictEqual(footer.toggleExpanded(), "closed");
		strictEqual(footer.isExpanded(), false);
		setPresentationTier("standard");
		strictEqual(footer.isExpanded(), false);
		setPresentationTier("detailed");
		strictEqual(footer.isExpanded(), true);
	} finally {
		footer.dispose();
		setPresentationTier(prevTier);
	}

	// Standard busy with Alt+U deck open omits duplicate Loop when Fleet band owns Loop (item 19)
	const busyLoopState = footerState();
	busyLoopState.outputStyle = "standard";
	busyLoopState.fleetBandVisible = true;
	busyLoopState.status = {
		phase: "writing",
		since: 1000,
		lastMeaningfulAt: 1000,
		watchdogTier: 0,
		watchdogPeak: 0,
		localRuntime: false,
	};
	busyLoopState.loops = [
		{
			id: "loop-1",
			state: "active",
			settled: 2,
			nextDueAt: 30_000,
			active: null,
			cancelRequested: false,
			persistenceError: null,
			delivery: null,
			lastRun: null,
			spec: { intervalMs: 60_000, count: 5, command: "echo hi" },
		} as never,
	];
	const busyDeckText = renderDeckDrawer(busyLoopState, 96, 40).map(stripTerminalSequences).join("\n");
	doesNotMatch(busyDeckText, /\bLoop\b/u);

	// Item 16: extensionFacts render in detailed Route row 3 and standard Row 2 right slot; workspaceLine slots into slimmed anchor bar with 0 extra rows
	const extState = footerState();
	extState.outputStyle = "detailed";
	extState.extensionFacts = ["ext: ready"];
	const detailedExtDeck = renderDeckDrawer(extState, 96, 40).map(stripTerminalSequences).join("\n");
	match(detailedExtDeck, /ext: ready/u);

	extState.outputStyle = "standard";
	const stdExtRows = renderCompactDashboard(extState, 96).map(stripTerminalSequences);
	strictEqual(stdExtRows.length, 2);
	match(stdExtRows[1] ?? "", /ext: ready/u);
	doesNotMatch(stdExtRows[0] ?? "", /ext: ready/u);

	extState.deckOpen = true;
	extState.workspaceLine = "ws: Ctrl+G L leave";
	const anchorWithWs = renderCompactDashboard(extState, 96).map(stripTerminalSequences);
	strictEqual(anchorWithWs.length, 1);
	match(anchorWithWs[0] ?? "", /ws: Ctrl\+G L leave/u);
	match(anchorWithWs[0] ?? "", /Alt\+U fold/u);

	// Items 24 & 25: YOLO cap in 96-col Route island steps down thinking instead of clipping `tu…`; slimmed anchor omits duplicate YOLO
	const yoloState = footerState();
	yoloState.session.autonomy = "yolo";
	yoloState.session.modelId = "gpt-6-luna";
	yoloState.thinking = {
		label: "low",
		hasLevels: true,
		supportedLevels: ["off", "low", "medium", "high"],
		quiet: false,
	};
	yoloState.session.autonomyWindow = {
		caps: { turns: 100, minutes: 120, tokens: 0, usd: 0 },
		usage: { turns: 0, activeMs: 0, tokens: 0, usd: 0 },
		osSandbox: true,
		paused: false,
	} as never;
	const yoloDeck96 = renderDeckDrawer(yoloState, 96, 40).map(stripTerminalSequences).join("\n");
	doesNotMatch(yoloDeck96, /tu…/u);
	match(yoloDeck96, /YOLO/u);
	yoloState.deckOpen = true;
	const yoloAnchor = stripTerminalSequences(renderCompactDashboard(yoloState, 96)[0] ?? "");
	doesNotMatch(yoloAnchor, /\bYOLO\b/u);
	// At 60 cols, merged Route island retains YOLO safety badge alongside occupancy %
	const yoloDeck60 = renderDeckDrawer(yoloState, 60, 40).map(stripTerminalSequences);
	match(yoloDeck60[0] ?? "", /YOLO.*26%/u);
	strictEqual(visibleWidth(yoloDeck60[0] ?? ""), 60);

	// c1-o5 §6: Alt+U deck stays right-anchored across idle, busy, and setting feedback Row 2 states
	const anchorState = footerState();
	anchorState.whisper = "Try /run to dispatch parallel workers";
	const idleRow2 = stripTerminalSequences(renderCompactDashboard(anchorState, 96)[1] ?? "");
	match(idleRow2, /Try \/run to dispatch parallel workers │ Alt\+U details$/u);
	anchorState.status = {
		phase: "writing",
		since: 1000,
		lastMeaningfulAt: 1000,
		watchdogTier: 0,
		watchdogPeak: 0,
		localRuntime: false,
	};
	const busyRow2 = stripTerminalSequences(renderCompactDashboard(anchorState, 96)[1] ?? "");
	match(busyRow2, /Alt\+U details$/u);
	anchorState.notices = [
		{
			id: "fb-2",
			key: "settings:feedback",
			level: "info",
			presentation: "setting",
			text: "Thinking set to medium",
			addedAt: 10_000,
			expiresAt: 13_000,
		},
	];
	const fbRow2 = stripTerminalSequences(renderCompactDashboard(anchorState, 96)[1] ?? "");
	match(fbRow2, /Thinking set to medium.*Alt\+U details$/u);

	// P1 & P2: 120-col slimmed anchor bar elides deep cwd to ~/…/<parent>/<dir> and renders inline setting feedback calmly
	const anchorP2 = footerState();
	anchorP2.deckOpen = true;
	anchorP2.workspace.cwd = "~/experiments/scratch/fw-v090/verify/project-dir";
	anchorP2.notices = [
		{
			id: "fb-anchor",
			key: "settings:feedback",
			level: "info",
			presentation: "setting",
			text: "Autonomy set to YOLO",
			addedAt: 10_000,
			expiresAt: 13_000,
		},
	];
	const darkTheme = createPancodeTheme({ depth: "truecolor", background: "dark" });
	const anchorP2Raw = renderStatusLine(anchorP2, 120, 40, darkTheme)[0] ?? "";
	const anchorP2Plain = stripTerminalSequences(anchorP2Raw);
	match(anchorP2Plain, /~\/…\/verify\/project-dir/u);
	match(anchorP2Plain, /Autonomy set to YOLO │ Alt\+U fold/u);
	ok(
		anchorP2Raw.includes(darkTheme.paint("Autonomy set to YOLO", { fg: "body", bg: "raisedSurface" })),
		"setting feedback uses reading ink on the deck anchor",
	);

	// c2-o5: cold-cache info notices are dropped from Alert row at every tier; ended alerts surface in detailed Work row 3
	const coldState = footerState();
	coldState.notices = [
		{
			id: "cold-1",
			key: "context.cache.cold",
			level: "info",
			text: "next reply may be slower: the whole prompt is read again after a prompt rebuild",
			addedAt: 10_000,
			expiresAt: null,
		},
		{
			id: "cold-2",
			key: null,
			level: "info",
			text: "next reply may be slower: cache expired",
			addedAt: 10_000,
			expiresAt: null,
		},
	];
	for (const tier of ["compact", "standard", "detailed"] as const) {
		coldState.outputStyle = tier;
		const rendered = renderCompactDashboard(coldState, 96).map(stripTerminalSequences).join("\n");
		doesNotMatch(rendered, /next reply may be slower/u);
	}
	// Alert right suffix omitted at 60 cols, kept when >= 36 cols remain at 96 cols
	coldState.outputStyle = "standard";
	coldState.dismissKeyLabel = "Ctrl+G X";
	coldState.notices = [
		{ id: "w1", key: null, level: "warning", text: "Rate limit approaching", addedAt: 10_000, expiresAt: null },
		{ id: "w2", key: null, level: "warning", text: "Second warning", addedAt: 9_000, expiresAt: null },
	];
	const alert96 = stripTerminalSequences(renderCompactDashboard(coldState, 96)[0] ?? "");
	match(alert96, /Alt\+U \+1 more · Ctrl\+G X dismiss$/u);
	const alert60 = stripTerminalSequences(renderCompactDashboard(coldState, 60)[0] ?? "");
	doesNotMatch(alert60, /Ctrl\+G X|\+1 Alt\+U/u);

	// Detailed Work island row 3 surfaces ended alerts only when > 0 (never `Notices none`)
	const endedState = footerState();
	endedState.outputStyle = "detailed";
	endedState.endedNotices = [];
	const noEnded = renderDeckDrawer(endedState, 96, 40).map(stripTerminalSequences).join("\n");
	doesNotMatch(noEnded, /earlier alert|Notices none/u);
	endedState.endedNotices = [
		{ id: "e1", key: null, level: "warning", text: "Expired warn", addedAt: 1000, expiresAt: null },
		{ id: "e2", key: null, level: "error", text: "Expired err", addedAt: 2000, expiresAt: null },
	];
	const withEnded = renderDeckDrawer(endedState, 96, 40).map(stripTerminalSequences).join("\n");
	match(withEnded, /! 2 earlier alerts · \/usage/u);

	// P3: fresh Context island omits duplicate `272k` from header when row 1 shows `window 272k`;
	// detailed Work row 2 drops redundant `1 call` when row 1 already reports calls.
	const p3State = footerState();
	p3State.outputStyle = "detailed";
	p3State.context = { ...p3State.context, ledger: null, used: null, contextWindow: 272_000 };
	p3State.agent.lastTurn = { elapsedMs: 11_000, toolCount: 1, toolErrorCount: 0, stopReason: "stop" } as never;
	p3State.toolCounts = { tools: { bash: 1 }, errors: 0 };
	// The card counts the turn's model calls as the receipt does, from telemetry, not the tool tally.
	p3State.telemetry = {
		...p3State.telemetry,
		turn: { input: null, prompt: null, output: null, cacheRead: null, cacheWrite: null, calls: 1 },
	} as never;
	const p3Lines = renderDeckDrawer(p3State, 96, 40).map(stripTerminalSequences);
	doesNotMatch(p3Lines[0] ?? "", /272k/u);
	match(p3Lines[1] ?? "", /window 272k/u);
	match(p3Lines[1] ?? "", /1 call/u);
	match(p3Lines[2] ?? "", /Tools {2}bash 1/u);
	doesNotMatch(p3Lines[2] ?? "", /Tools 1 call/u);

	// P5: extension status lines fold into detailed Route row 3 (zero unboxed `Extensions:` row),
	// and compact status bar slots workspaceLine inline without exceeding 1-2 rows.
	const prevTierP5 = presentationTier();
	setPresentationTier("detailed");
	const extFooter = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getTerminalColumns: () => 96,
		getTerminalRows: () => 40,
		getExtensionStatus: () => ["lsp ready"],
	});
	try {
		const extLines = extFooter.view.render(96).map(stripTerminalSequences);
		strictEqual(extLines.length, 6, "5-row detailed deck + 1 anchor bar, no unboxed Extensions row");
		doesNotMatch(extLines.join("\n"), /^Extensions:/mu);
		match(extLines.join("\n"), /lsp ready/u);
	} finally {
		extFooter.dispose();
		setPresentationTier(prevTierP5);
	}

	const compactWs = footerState();
	compactWs.outputStyle = "compact";
	compactWs.workspaceLine = "ws: Ctrl+G L leave";
	const compactWsRows = renderCompactDashboard(compactWs, 96).map(stripTerminalSequences);
	strictEqual(compactWsRows.length, 1);
	match(compactWsRows[0] ?? "", /ws: Ctrl\+G L leave/u);
});
