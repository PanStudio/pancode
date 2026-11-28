// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createWorkerProgressFold } from "../../src/domains/telemetry/worker-progress.js";
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import type { FooterDashboardRenderState } from "../../src/interactive/footer/dashboard.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";
import { footerKeyHint } from "../../src/interactive/footer/key-hints.js";
import { dashboardPageViewport, renderCompactDashboard } from "../../src/interactive/footer/pages.js";
import { createKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import { renderToolExecution, renderToolPreview } from "../../src/interactive/renderers/tool-execution.js";
import { renderToolSubline } from "../../src/interactive/renderers/tool-subline.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";
import { footerState as state } from "../harness/footer-fixture.js";

const plain = (rows: string[]) => rows.map(stripTerminalSequences).join("\n");
/** The dashboard is one fixed glance panel; it never scrolls, so one render holds every row it shows. */
function page(snapshot: FooterDashboardRenderState, width: number, rows: number): string[] {
	return dashboardPageViewport(snapshot, width, rows, "Alt+U");
}

test("the deck drawer renders boxed Route, Work, and Context islands and auto-folds under W1", () => {
	for (const width of [40, 80, 120, 172]) {
		const rows = page(state(), width, 40);
		ok(
			rows.every((line) => visibleWidth(line) <= width),
			`${width}`,
		);
		strictEqual(rows.length, width < 44 ? 0 : 4, `${width}: standard deck is 4 boxed rows or auto-folded under W1`);
		doesNotMatch(plain(rows), /Alt\+PgUp|of \d+ rows/);
	}
	const glance = plain(page(state(), 172, 120));
	match(glance, /Route.*Work.*Context/u);
	doesNotMatch(glance, /context 17k/);
	match(glance, /68\.5k \/ 262k/);
	match(glance, /26%/);
	doesNotMatch(glance, /Connections ─|Machine ─|Composition|Fleet idle|Notices none/);
});

test("the resolved dashboard shortcut opens the deck and closes it again without capturing text", () => {
	const previous = getKeybindings();
	createKeybindingManager({
		...DEFAULT_SETTINGS,
		interface: { ...DEFAULT_SETTINGS.interface, keybindings: { "pancode.status.toggle": "ctrl+u" } },
	});
	const footer = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getTerminalColumns: () => 120,
		getTerminalRows: () => 40,
	});
	try {
		const modes = [footer.toggleExpanded()];
		const text = plain(footer.view.render(120));
		match(text, /Route.*Work.*Context/u);
		match(text, /Ctrl\+U fold/);
		modes.push(footer.toggleExpanded());
		deepStrictEqual(modes, ["open", "closed"]);
		strictEqual(footer.isExpanded(), false);
	} finally {
		footer.dispose();
		setKeybindings(previous);
	}
});

test("the footer composes at the width a frame renders it, so a resize never stacks rows fitted to the old width", () => {
	let columns = 120;
	const footer = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getTerminalColumns: () => columns,
		getTerminalRows: () => 40,
	});
	try {
		strictEqual(footer.view.render(120).length, 2);
		// The first frame after a resize renders before the footer's next refresh.
		columns = 40;
		const narrow = footer.view.render(40);
		strictEqual(narrow.length, 1, plain(narrow));
		for (const row of narrow) ok(visibleWidth(row) <= 40, row);
		deepStrictEqual(footer.view.render(40), narrow, "a repeat frame at the same width reuses the rows");
	} finally {
		footer.dispose();
	}
});

test("invocation previews omit redundant short primary values, retain options and preserve full inspection", () => {
	for (const style of ["compact", "standard", "detailed"] as const) {
		const call = {
			toolName: "read",
			toolCallId: "read",
			args: { path: "README.md", offset: 40, limit: 80 },
			result: "contents",
			isError: false,
		};
		const text = plain(renderToolPreview(call, 100, transcriptDetail(style)));
		strictEqual(text.split("README.md").length - 1, 1);
		// Arguments the row does not consume leave the header; detailed states them as the card's `args` row.
		(style === "detailed" ? match : doesNotMatch)(text, /offset.*40/);
		(style === "detailed" ? match : doesNotMatch)(text, /limit.*80/);
		match(plain(renderToolExecution(call, 100)), /path.*README.md/);
		const long = { ...call, args: { path: `${"directory/".repeat(12)}final.ts` } };
		// Compact is the action row alone, so a cut path keeps its tail there and
		// the full path stays in inspection; the other styles add a `path ›` row.
		match(
			plain(renderToolPreview(long, 100, transcriptDetail(style))),
			style === "compact" ? /▸ read …\/(?:directory\/)+final\.ts ✓/ : /path/,
		);
	}
	doesNotMatch(plain(renderToolSubline({ toolName: "ls", toolCallId: "ls", args: {} }, 100)), /tool action/);
});

test("deck drawer stays bounded while live workers stream and leaves live worker output to /fleet", () => {
	const snapshot = state();
	const progress = createWorkerProgressFold();
	const render = () => {
		snapshot.dispatchRows = snapshot.dispatchRows.map((row) => ({ ...row, progress: progress.snapshot() }));
		const rows = page(snapshot, 160, 120);
		strictEqual(rows.length, 4);
		return plain(rows);
	};
	progress.observe({
		type: "pancode_tool_start",
		payload: {
			tool: "read",
			toolCallId: "read1",
			action: { verb: "reading", object: "src/interactive/overlays/ask-user.ts" },
		},
	});
	match(render(), /Route.*Work.*Context/u);
	progress.observe({ type: "pancode_tool_finish", payload: { tool: "read", toolCallId: "read1" } });
	progress.observe({
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning must never render" },
	});
	doesNotMatch(render(), /private reasoning/);
	progress.observe({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "Found the question navigation handlers." },
	});
	doesNotMatch(render(), /Found the question navigation handlers|Live response/);
});

test("the footer exposes workspace, model identity and worker count in bounded rows of the tier's height", () => {
	for (const width of [40, 80, 160]) {
		const rows = renderCompactDashboard(state(), width);
		// Standard is the status line and the hint row; a W1 width keeps the status line alone.
		strictEqual(rows.length, width < 44 ? 1 : 2);
		ok(rows.every((row) => visibleWidth(row) <= width));
	}
	const idle = state();
	idle.dispatchRows = [];
	strictEqual(renderCompactDashboard(idle, 40).length, 1, "a narrow idle footer is one row");
	const text = plain(renderCompactDashboard(state(), 160));
	match(text, /✓ ready · ● 1 running/);
	match(text, /^\s*▐∀▌ /);
	match(text, /ctx /);
	match(text, /pancode.*v050/);
	doesNotMatch(text, /autonomy|yolo|70k processed|standard|exploring/);
});

test("many worker runs never grow the deck drawer height and never leak raw worker output", () => {
	const snapshot = state();
	const row = snapshot.dispatchRows[0];
	ok(row);
	snapshot.dispatchRows = [
		{ ...row, status: "retrying", runId: "retry", taskSummary: "Active retry task" },
		...Array.from({ length: 8 }, (_, index) => ({
			...row,
			status: "completed" as const,
			runId: `done-${index}`,
			taskSummary: "Historical verbose task must not render",
		})),
	];
	const rows = page(snapshot, 160, 120);
	strictEqual(rows.length, 4, "nine runs never grow the deck");
	const text = plain(rows);
	doesNotMatch(text, /Historical verbose task|AGENT ACTIVITY|Worker output|Budget /);
});

test("the deck drawer keeps fixed tier height and auto-folds under H1/W1 across widths and lifecycle changes", () => {
	for (const width of [40, 86, 160])
		for (const height of [12, 15, 24, 40, 75, 93]) {
			const snapshot = state();
			const expected = width < 44 || height < 20 ? 0 : 4;
			const rows = page(snapshot, width, height);
			strictEqual(rows.length, expected);
			ok(rows.every((row) => visibleWidth(row) <= width));
			snapshot.dispatchRows = [];
			strictEqual(page(snapshot, width, height).length, expected);
		}
});

test("a compact notice takes its own row above the status bar, then leaves when it expires", () => {
	const snapshot = state();
	snapshot.notices = [{ id: "n", text: "Worker finished", level: "info", key: null, addedAt: 11000, expiresAt: 13000 }];
	const before = renderCompactDashboard(snapshot, 100);
	strictEqual(before.length, 3);
	match(stripTerminalSequences(before[0] ?? ""), /Worker finished/);
	match(stripTerminalSequences(before[2] ?? ""), /\? keys|deck/i);
	snapshot.now = 14000;
	const after = renderCompactDashboard(snapshot, 100);
	strictEqual(after.length, 2);
	doesNotMatch(plain(after), /Worker finished/);
	match(plain(after), /\? keys|deck/i);
});

test("rotating Tip banners are retired and operational notices render on the alert row", () => {
	const input = state();
	input.notices = [];
	input.demoHint = "Explore /help · guidance in /settings";
	const rows = renderCompactDashboard(input, 80).map(stripTerminalSequences);
	strictEqual(rows.length, 2);
	doesNotMatch(rows.join("\n"), /Tip/u);
	input.notices = [
		{ id: "demo-priority", text: "Permission needed", level: "warning", key: null, addedAt: input.now, expiresAt: null },
	];
	match(plain(renderCompactDashboard(input, 80)), /Permission needed/);
	doesNotMatch(plain(renderCompactDashboard(input, 80)), /Tip/);
	input.notices = [];
	input.demoHint = null;
	doesNotMatch(renderCompactDashboard(input, 80).map(stripTerminalSequences).join("\n"), /Tip/);
});

test("turning demo guidance off drops the learning hints from the hint slot", () => {
	const input = state();
	input.notices = [];
	input.demoHint = null;
	input.demo = false;
	const hint = renderCompactDashboard(input, 100).map(stripTerminalSequences)[1] ?? "";
	doesNotMatch(hint, /\? Keys|newline|send|Dashboard/i);
});

test("footer hints resolve remapped bindings and omit unbound actions", () => {
	const previous = getKeybindings();
	createKeybindingManager({
		...DEFAULT_SETTINGS,
		interface: {
			...DEFAULT_SETTINGS.interface,
			keybindings: {
				"pancode.model.select": "ctrl+m",
				"pancode.hub.toggle": [],
			},
		},
	});
	try {
		const hints = Array.from({ length: 40 }, (_, i) =>
			footerKeyHint(i * 60000, false, Number.POSITIVE_INFINITY, "idle"),
		).join("\n");
		match(hints, /Ctrl\+M model(?! picker)/);
		doesNotMatch(hints, /Alt\+M|Alt\+L|the hub/);
		match(hints, /\? keys · \/ commands/);
		const runHints = Array.from({ length: 40 }, (_, i) =>
			footerKeyHint(i * 60000, false, Number.POSITIVE_INFINITY, "steer"),
		).join("\n");
		match(runHints, /send now/);
	} finally {
		setKeybindings(previous);
	}
});

test("idle keeps its pinned keys while a key the operator already pressed leaves the run's learning rotation", () => {
	const previous = getKeybindings();
	createKeybindingManager(DEFAULT_SETTINGS);
	try {
		const rotation = (context: "idle" | "steer", learned: (feature: string) => boolean) =>
			Array.from({ length: 40 }, (_, i) =>
				footerKeyHint(i * 60000, false, Number.POSITIVE_INFINITY, context, { learned }),
			).join("\n");
		const fresh = rotation("idle", () => false);
		match(fresh, /\? keys · \/ commands · Alt\+M model/);
		// Idle is the same three keys whatever the operator learned; the row teaches nothing more there.
		const learned = rotation("idle", (feature) => feature === "?" || feature === "key:pancode.thinking.cycle");
		match(learned, /\? keys · \/ commands · Alt\+M model/);
		doesNotMatch(learned, /thinking/i);
		match(
			rotation("steer", () => false),
			/send now/,
		);
		doesNotMatch(
			rotation("steer", (feature) => feature === "key:pancode.message.interrupt"),
			/send now/,
		);
	} finally {
		setKeybindings(previous);
	}
});

test("worker cards and Status distinguish shared account limits from recorded session usage", () => {
	const snapshot = state();
	snapshot.quota = [
		{
			provider: "claude-code",
			credentials: ["claude-code"],
			displayName: "claude-code",
			status: "ok",
			plan: null,
			credits: null,
			message: null,
			retryAfter: null,
			pool: null,
			access: "unknown",
			overage: "unknown",
			resetsAt: null,
			validUntil: null,
			source: "poll",
			stale: false,
			windows: [
				{
					key: "weekly",
					scope: null,
					label: "Weekly",
					usedPct: { fact: { kind: "measured", value: 91, source: "provider" }, display: "91%" },
					resetsAt: null,
					unit: null,
					durationSeconds: null,
					access: "unknown",
				},
			],
			observedAt: null,
		},
	];
	snapshot.dispatchRows = snapshot.dispatchRows.map((row) => ({
		...row,
		runtimeId: "claude-code",
		runtimeKind: "subprocess",
	}));
	// A worker's shared account is a run fact for Fleet Runs; the deck keeps the session's own context and spend.
	const glance = plain(page(snapshot, 160, 120));
	match(glance, /Context/);
	doesNotMatch(glance, /Shared claude-code/);
});

test("compact quota stays beside the selected model while workspace and rotating hints remain visible", () => {
	const snapshot = state();
	snapshot.workspace.dirty = true;
	snapshot.quotaRoute = { runtimeId: "claude-code", wireModelId: "claude-opus" };
	snapshot.session.target = "Claude · claude-opus";
	snapshot.quota = [
		{
			provider: "claude-code",
			credentials: ["claude-code"],
			displayName: "claude-code",
			status: "ok",
			plan: null,
			credits: null,
			message: null,
			retryAfter: null,
			pool: null,
			access: "unknown",
			overage: "unknown",
			resetsAt: null,
			validUntil: null,
			source: "poll",
			stale: false,
			observedAt: null,
			windows: [
				{
					key: "session",
					scope: null,
					label: "5h",
					usedPct: { fact: { kind: "measured", value: 7, source: "provider" }, display: "7%" },
					resetsAt: null,
					unit: null,
					durationSeconds: null,
					access: "unknown",
				},
				{
					key: "weekly",
					scope: null,
					label: "Weekly",
					usedPct: { fact: { kind: "measured", value: 9, source: "provider" }, display: "9%" },
					resetsAt: null,
					unit: null,
					durationSeconds: null,
					access: "unknown",
				},
			],
		},
		{
			provider: "codex",
			credentials: ["codex"],
			displayName: "codex",
			status: "ok",
			plan: null,
			credits: null,
			message: null,
			retryAfter: null,
			pool: null,
			access: "unknown",
			overage: "unknown",
			resetsAt: null,
			validUntil: null,
			source: "poll",
			stale: false,
			observedAt: null,
			windows: [
				{
					key: "weekly",
					scope: null,
					label: "Weekly",
					usedPct: { fact: { kind: "measured", value: 77, source: "provider" }, display: "77%" },
					resetsAt: null,
					unit: null,
					durationSeconds: null,
					access: "unknown",
				},
			],
		},
	];
	for (const width of [80, 120, 160]) {
		const rows = renderCompactDashboard(snapshot, width).map(stripTerminalSequences);
		doesNotMatch(rows.join("\n"), /Codex|5h/);
		match(rows[0] ?? "", /pancode.*v050\*/);
		doesNotMatch(rows[1] ?? "", /weekly|Claude|Codex/);
		ok(rows.every((line) => visibleWidth(line) <= width));
	}
	for (let page = 0; page < 40; page++) {
		snapshot.now = page * 12000;
		match(stripTerminalSequences(renderCompactDashboard(snapshot, 160)[0] ?? ""), /pancode.*v050\*/);
		ok(footerKeyHint(snapshot.now));
	}
	snapshot.session.shutdownArmed = true;
	match(plain(renderCompactDashboard(snapshot, 100)), /Ctrl\+C again[\s\S]*pancode.*v050\*/);
	match(plain(renderCompactDashboard(snapshot, 40)), /Ctrl\+C again to quit/u);
	snapshot.quotaRoute = { runtimeId: "litellm", wireModelId: "claude-opus" };
	doesNotMatch(plain(renderCompactDashboard(snapshot, 160)), /weekly/);
});

test("the status line stays calm and reports live workers cleanly at every width", () => {
	const snapshot = state();
	snapshot.session.modelId = "qwopus";
	const facts = (width: number) => stripTerminalSequences(renderCompactDashboard(snapshot, width)[0] ?? "");
	for (const width of [60, 100, 200]) doesNotMatch(facts(width), /skill|§/u);
	snapshot.session.activeSkills = ["tdd", "perf-review"];
	for (const width of [40, 60, 100]) {
		const row = facts(width);
		if (width >= 60) match(row, /● 1 running/u);
		doesNotMatch(row, /……|skill/u);
		ok(visibleWidth(row) <= width, row);
	}
	snapshot.dispatchRows = [];
	match(facts(100), /qwopus\s*$/u);
});

test("the status line renders bounded context occupancy and never cuts a figure", () => {
	const snapshot = state();
	snapshot.session.modelId = "qwopus";
	const line = (width: number) => stripTerminalSequences(renderCompactDashboard(snapshot, width)[0] ?? "");
	snapshot.context = {
		...snapshot.context,
		ledger: undefined,
		budget: { inputSource: "estimated" },
		used: 33_900,
		contextWindow: 262_144,
		systemPromptTokens: 3_700,
		toolSchemaTokens: 8_200,
		messageTokens: 22_000,
	} as unknown as FooterDashboardRenderState["context"];
	for (const width of [40, 60, 100]) {
		const row = line(width);
		ok(visibleWidth(row) <= width, row);
		doesNotMatch(row, /\d…/u, row);
	}
	match(line(60), /ctx ≈13%/u);
	match(line(100), /ctx .*≈13%/u);
});

test("the status bar owns live activity and holds still within one animation step", () => {
	let now = 10_000;
	const footer = buildFooterDashboard({
		providers: { list: () => [] } as never,
		resolveCurrentBranch: async () => null,
		getTerminalColumns: () => 120,
		getTerminalRows: () => 40,
		now: () => now,
		getAgentStatus: () => ({
			phase: "writing",
			since: 8_000,
			lastMeaningfulAt: now,
			watchdogTier: 0,
			watchdogPeak: 0,
			localRuntime: false,
		}),
	});
	try {
		footer.refresh();
		const first = footer.view.render(120).join("\n");
		match(stripTerminalSequences(first), /writing · 2s/u);
		now = 10_050;
		footer.refresh();
		strictEqual(footer.view.render(120).join("\n"), first);
	} finally {
		footer.dispose();
	}
});

test("the compact footer shows the most severe live notice with its level glyph at every width", () => {
	for (const width of [60, 80, 120, 200]) {
		const snapshot = state();
		const rows = renderCompactDashboard(
			{
				...snapshot,
				notices: [
					{ id: "e", level: "error", text: "provider down", key: null, addedAt: snapshot.now - 5_000, expiresAt: null },
					{ id: "i", level: "info", text: "saved", key: null, addedAt: snapshot.now - 10, expiresAt: snapshot.now + 9_000 },
				],
			},
			width,
		);
		const text = plain(rows);
		match(text, /✗ provider/u, `${width}`);
		doesNotMatch(text, /saved|•/u, `${width}`);
		for (const row of rows) ok(visibleWidth(row) <= width, `${width}: ${stripTerminalSequences(row)}`);
	}
});

test("the footer preserves operational notices and omits retired Tip banners", () => {
	const input = state();
	input.welcomeVisible = true;
	input.demoHint = "Explore /help";
	const idle = renderCompactDashboard(input, 100).map(stripTerminalSequences)[1] ?? "";
	doesNotMatch(idle, /Tip|Explore/iu);
	input.notices = [
		{
			id: "welcome-priority",
			text: "Permission needed",
			level: "warning",
			key: null,
			addedAt: input.now,
			expiresAt: null,
		},
	];
	match(plain(renderCompactDashboard(input, 100)), /Permission needed/u);
	input.notices = [];
	input.welcomeVisible = false;
	input.demoHint = null;
	match(renderCompactDashboard(input, 100).map(stripTerminalSequences)[1] ?? "", /\? keys|deck/iu);
});
