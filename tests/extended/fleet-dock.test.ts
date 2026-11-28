// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { JobRecord } from "../../src/core/job-types.js";
import { setPresentationTier } from "../../src/core/presentation-tier.js";
import { settledRunCaveat } from "../../src/domains/dispatch/failure-headline.js";
import type { CanonicalTrustStatus } from "../../src/domains/evidence/index.js";
import type { Component, OverlayOptions, Terminal } from "../../src/engine/tui.js";
import { stripTerminalSequences, TuiAltScreen, visibleWidth } from "../../src/engine/tui.js";
import { fitRegionRows } from "../../src/interactive/bottom-region.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";
import { createFleetBand } from "../../src/interactive/footer/fleet-band.js";
import { renderCompactDashboard } from "../../src/interactive/footer/pages.js";
import { createInteractiveTickers } from "../../src/interactive/interactive-tickers.js";
import { buildLayout } from "../../src/interactive/layout.js";
import { footerState } from "../harness/footer-fixture.js";
import { runUsageOf } from "../harness/telemetry-view.js";

class CapturedFullscreen extends TuiAltScreen {
	frame: string[] = [];
	protected override applyLineResets(lines: string[]): string[] {
		this.frame = [...lines];
		return super.applyLineResets(lines);
	}
}

function fullscreenFrame(root: Component, width: number, rows = 35): string[] {
	const terminal = {
		columns: width,
		rows,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		async drainInput() {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
	} as unknown as Terminal;
	const tui = new CapturedFullscreen(terminal);
	tui.setLayoutRoot(root);
	tui.start();
	try {
		tui.renderNow(true);
		return tui.frame;
	} finally {
		tui.stop();
	}
}

test("transient Fleet band sits below composer in footer stack, folds when idle, and preserves transcript (BT-007)", () => {
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	let live = true;
	const getRows = () => (live ? [{ ...fixture, agentAudience: "base" as const }] : []);
	const fleet = createFleetBand({ getRows });
	const text = (line: string): Component => ({ render: () => [line], invalidate() {} });
	setPresentationTier("detailed");
	try {
		for (const mode of ["regular", "fullscreen"] as const) {
			for (const width of [40, 60, 80, 120, 144, 200]) {
				const transcript = "A transcript sentence whose words must stay intact".slice(0, width - 1).trimEnd();
				const root = buildLayout(
					{
						banner: text("header"),
						chat: text(transcript),
						editor: text("composer"),
						footer: [fleet, text("footer")],
					},
					{ mode },
				);
				const rows = (mode === "fullscreen" ? fullscreenFrame(root, width) : root.render(width)).map((line) =>
					stripTerminalSequences(line).trimEnd(),
				);
				ok(rows.includes(transcript), `${mode} preserves the transcript sentence: ${JSON.stringify(rows)}`);
				const start = rows.findIndex((row) => row.startsWith("Fleet "));
				ok(start > rows.indexOf("composer"), "Fleet band renders below composer");
				ok(start < rows.indexOf("footer"), "Fleet band renders above status line");
				for (const row of rows) ok(visibleWidth(row) <= width, row);
				live = false;
				deepStrictEqual(fleet.render(width), []);
				strictEqual(fleet.isVisible(), false);
				strictEqual(
					(mode === "fullscreen" ? fullscreenFrame(root, width) : root.render(width))
						.map((line) => stripTerminalSequences(line).trimEnd())
						.includes(transcript),
					true,
				);
				live = true;
			}
		}
		match(fleet.render(96).map(stripTerminalSequences).join("\n"), /^Fleet ─+ ● 1 running · Alt\+W detail ─/u);
	} finally {
		setPresentationTier("standard");
	}
});

test("a Fleet row's token count says what it counts and is left out while nothing was counted", () => {
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	const row = (input: number) => ({
		...fixture,
		usage: runUsageOf("scout-run", [{ usage: { input, output: 0 }, usd: null }]),
	});
	const line = (input: number): string => {
		const band = createFleetBand({ getRows: () => [row(input)], now: () => 20_000 });
		return band.render(120).map(stripTerminalSequences).join("\n");
	};
	match(line(70_000), /70\.0k tok$/mu);
	doesNotMatch(line(0), / 0$|0 tok/mu);
});

test("transient Fleet band handles 4-worker overflow, watch-pane collapse, loops, and suppresses Row 1 worker count", () => {
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	const rows = [
		{ ...fixture, runId: "r1", agentId: "worker-1", elapsedMs: 12_000 },
		{ ...fixture, runId: "r2", agentId: "worker-2", elapsedMs: 9_000 },
		{ ...fixture, runId: "r3", agentId: "worker-3", elapsedMs: 5_000 },
		{ ...fixture, runId: "r4", agentId: "worker-4", elapsedMs: 2_000 },
	];
	const sampleLoop: JobRecord = {
		id: "job-1",
		kind: "shell",
		state: "active",
		createdAt: 1000,
		updatedAt: 1000,
		settled: 3,
		nextDueAt: 42_000,
		active: null,
		cancelRequested: false,
		persistenceError: null,
		delivery: null,
		lastRun: null,
		spec: { intervalMs: 60_000, count: 10, command: "echo ok" },
	} as unknown as JobRecord;
	let watchOpen = false;
	let deckOpen = false;
	let dockOpen = false;
	let currentRows = rows;
	const band = createFleetBand({
		getRows: () => currentRows,
		getLoops: () => [sampleLoop],
		isWatchPaneVisible: () => watchOpen,
		isDeckOpen: () => deckOpen,
		isDockOpen: () => dockOpen,
		now: () => 20_000,
	});
	setPresentationTier("standard");
	try {
		const rendered = band.render(96).map(stripTerminalSequences);
		strictEqual(rendered.length, 5);
		match(rendered[0] ?? "", /^Fleet ─+ ● 4 running · Loop 3\/10 .* Alt\+W detail ─$/u);
		// Item 22: worker rows at >= 80 cols append `· <task brief>` when >= 16 cols remain after phase.
		match(rendered[1] ?? "", /· /u);
		match(rendered[4] ?? "", /^\s+\+1 more running · worker-4/u);
		for (const line of rendered) ok(visibleWidth(line) <= 96);

		// Any docked overlay owns the surface and folds the fleet band to 0 rows.
		dockOpen = true;
		strictEqual(band.isVisible(), false);
		strictEqual(band.render(96).length, 0);
		dockOpen = false;

		// Alert row sits above fleet band, context progress sits between fleet band and deck/status bar.
		const contextProgressStub: Component = {
			render: () => ["Context refresh ━━━"],
			invalidate() {},
		};
		const footer = buildFooterDashboard({
			providers: { list: () => [] } as never,
			resolveCurrentBranch: async () => null,
			getTerminalColumns: () => 96,
			getTerminalRows: () => 40,
			fleetBand: band,
			contextProgress: contextProgressStub,
			now: () => 20_000,
			getNotifications: () => [
				{
					id: "alert-1",
					key: "quota:warn",
					level: "warning",
					text: "Quota threshold reached",
					addedAt: 19_000,
					expiresAt: null,
				},
			],
		});
		const stackLines = footer.view.render(96).map(stripTerminalSequences);
		const alertIdx = stackLines.findIndex((line) => /Quota threshold reached/u.test(line));
		const fleetIdx = stackLines.findIndex((line) => /^Fleet ─+/u.test(line));
		const ctxIdx = stackLines.findIndex((line) => /Context refresh/u.test(line));
		const barIdx = stackLines.findIndex((line) => /▐∀▌/u.test(line));
		ok(
			alertIdx === 0 && fleetIdx > alertIdx && ctxIdx > fleetIdx && barIdx > ctxIdx,
			`expected alert < fleet < contextProgress < bar, got ${JSON.stringify(stackLines)}`,
		);
		footer.dispose();

		// Watch pane visible collapses to 1 quiet rule with `hide dock` and no Loop echo.
		watchOpen = true;
		const collapsed = band.render(96).map(stripTerminalSequences);
		strictEqual(collapsed.length, 1);
		match(collapsed[0] ?? "", /^Fleet ─+ ● 4 running · Alt\+W hide dock ─$/u);
		watchOpen = false;

		// Detailed deck open omits Loop from Fleet header because Work island owns it.
		setPresentationTier("detailed");
		deckOpen = true;
		const detailedOpen = band.render(96).map(stripTerminalSequences);
		doesNotMatch(detailedOpen[0] ?? "", /Loop 3\/10/u);

		// Loop-only band renders 1 row at standard, folds when detailed deck is open.
		currentRows = [];
		strictEqual(band.render(96).length, 0);
		deckOpen = false;
		setPresentationTier("standard");
		const loopOnly = band.render(96).map(stripTerminalSequences);
		strictEqual(loopOnly.length, 1);
		match(loopOnly[0] ?? "", /^Loop waiting .* · 3\/10 · next in 22s$/u);

		// Row 1 keeps the band's live count beside ready whether the band shows or not, and a plan with a step running is
		// one run there, as the band counts it: `✓ ready` alone beside a band reading `● 1 running` hid the plan.
		const snapshot = footerState();
		snapshot.fleetBandVisible = true;
		const step = snapshot.dispatchRows[0];
		ok(step);
		snapshot.dispatchRows = [
			{
				...step,
				runId: "fleet-root",
				agentId: "plan",
				plan: {
					rootId: "fleet-root",
					name: "build-review",
					startedAtMs: 0,
					finishedAtMs: null,
					state: "running",
					requiredStepCount: 2,
					succeededStepCount: 0,
					costText: null,
					steps: [
						{ stepId: "build", kind: "agent", label: "build", state: "running" },
						{ stepId: "review", kind: "agent", label: "review", state: "pending" },
					],
				},
			},
			{ ...step, phase: { wave: 0, stepId: "build" } },
		];
		const statusRow = stripTerminalSequences(renderCompactDashboard(snapshot, 96)[0] ?? "");
		match(statusRow, /✓ ready · ● 1 running/u);
		doesNotMatch(statusRow, /worker/u);
	} finally {
		setPresentationTier("standard");
	}
});

test("the rails keep the transcript's budget across regular and fullscreen layouts (TUI-13)", () => {
	const block = (name: string, count: number): Component => ({
		render: () => Array.from({ length: count }, (_, index) => `${name} ${index + 1}`),
		invalidate() {},
	});
	for (const mode of ["regular", "fullscreen"] as const) {
		for (const terminalRows of [18, 24, 40]) {
			const root = buildLayout(
				{
					banner: block("header", 1),
					chat: block("transcript", 1),
					pending: block("queued", 15),
					editor: block("composer", 4),
					footer: block("footer", 2),
				},
				{ mode, getTerminalRows: () => terminalRows },
			);
			const frame = (mode === "fullscreen" ? fullscreenFrame(root, 80, terminalRows) : root.render(80)).map((line) =>
				stripTerminalSequences(line).trim(),
			);
			const label = `${mode} at ${terminalRows} rows: ${JSON.stringify(frame)}`;
			const rails = frame.filter((row) => /^queued \d+$|more rows?$/u.test(row));
			const floor = terminalRows < 30 ? Math.min(6, Math.ceil(terminalRows / 4)) : Math.ceil(terminalRows / 3);
			ok(rails.length + 4 + 2 <= terminalRows - floor, label);
			ok(frame.includes("composer 4") && frame.includes("footer 2"), label);
			if (terminalRows < 30)
				ok(
					frame.some((row) => /… \d+ more rows/u.test(row)),
					label,
				);
			else ok(frame.includes("queued 15"), label);
		}
	}
	// A rail of whole variants is granted the first that fits, never a cut one (6.4).
	const variants = [["dock 1", "dock 2", "dock 3"], ["dock summary"], []];
	deepStrictEqual(fitRegionRows([{ lines: variants[0] ?? [], variants, priority: 2 }], 2, true, 80), [["dock summary"]]);
	deepStrictEqual(fitRegionRows([{ lines: variants[0] ?? [], variants, priority: 2 }], 0, true, 80), [[]]);
});

test("a live run is never drawn by a transcript-covering ticker overlay (BT-007)", () => {
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	const overlays: Component[] = [];
	const ticker = createInteractiveTickers({
		tui: {
			terminal: { columns: 144, rows: 35 },
			requestRender() {},
			showOverlay(component: Component, _options?: OverlayOptions) {
				overlays.push(component);
				return { setHidden() {}, hide() {} } as never;
			},
		},
		dispatchBoardStore: { activeRows: () => [{ ...fixture, agentAudience: "base" }], reconcile() {} },
		contextActivityStore: { active: () => false, current: () => null },
		getOverlayState: () => "closed",
		isFooterExpanded: () => false,
		scheduleInterval: () => ({}),
		clearScheduledInterval() {},
	});
	try {
		ticker.renderTaskIsland();
		for (const overlay of overlays)
			ok(!overlay.render(144).some((line) => stripTerminalSequences(line).includes("Fleet Runs")));
	} finally {
		ticker.dispose();
	}
});

test("a review that found issues settles done, and a failure the workers dock showed stops pinning the band (R2-F6)", () => {
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	const failedVerdict = {
		...fixture.trust,
		verdict: "compromised",
		axes: { artifactIntegrity: "verified", validationGrounding: "failed" },
	} as unknown as NonNullable<typeof fixture.trust>;
	const review = {
		...fixture,
		runId: "review-1",
		agentId: "reviewer",
		status: "completed" as const,
		trust: failedVerdict,
		reviewFindings: 2,
	};
	const crashed = { ...fixture, runId: "coder-1", agentId: "coder", status: "failed" as const };
	let watchOpen = false;
	const band = createFleetBand({
		getRows: () => [],
		getSettledRows: () => [review, crashed],
		isWatchPaneVisible: () => watchOpen,
		now: () => 20_000,
	});
	const pinned = band.render(120).map(stripTerminalSequences).join("\n");
	match(pinned, /1 failed/u);
	match(pinned, /coder/u);
	doesNotMatch(pinned, /reviewer/u);
	watchOpen = true;
	band.render(120);
	watchOpen = false;
	deepStrictEqual(band.render(120), []);
	strictEqual(band.isVisible(), false);

	const trust = {
		validationGrounding: { state: "failed", authority: { kind: "validator", id: "result-quality" } },
		artifactIntegrity: { state: "verified" },
	} as unknown as CanonicalTrustStatus;
	strictEqual(settledRunCaveat({ outcome: "succeeded", trust, reviewFindings: 2 }), null);
	strictEqual(settledRunCaveat({ outcome: "succeeded", trust })?.kind, "against");
});
