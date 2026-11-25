// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { doesNotMatch, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, type Terminal, TuiMainScreen, visibleWidth } from "../../src/engine/tui.js";
import { dispatchWaitRuns } from "../../src/interactive/dispatch-board-store.js";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-row-model.js";
import { dockMount, dockUnmount } from "../../src/interactive/dock.js";
import { parseEditorBashCommand } from "../../src/interactive/editor-bash.js";
import { renderEditorRail } from "../../src/interactive/editor-rails.js";
import { contextRailGroup, contextRailUnit, thinkingRailUnit } from "../../src/interactive/footer/context-rail.js";
import { PancodeEditor } from "../../src/interactive/pancode-editor.js";
import { createPancodeTheme } from "../../src/interactive/theme/index.js";

const theme = createPancodeTheme({ color: true, truecolor: true });
test("rails preserve width and decision labels across animated and static phases", () => {
	for (const width of [0, 1, 12, 40, 80, 160]) {
		for (const phase of ["idle", "working", "attention"] as const) {
			const row = renderEditorRail(
				theme,
				width,
				{ left: "CONFIRM", right: "Enter allow" },
				{ phase, yolo: true, animate: true, now: 1700 },
			);
			strictEqual(visibleWidth(row), width);
			if (width >= 40) match(stripTerminalSequences(row), /CONFIRM.*Enter allow/);
		}
	}
});
test("working rails are static, and only the permission rail carries motion", () => {
	const render = (now: number, animate: boolean) =>
		renderEditorRail(theme, 80, {}, { phase: "working", yolo: true, animate, now });
	strictEqual(render(400, true), render(1500, true));
	strictEqual(render(400, false), render(1500, false));
	const attention = (now: number) =>
		renderEditorRail(theme, 80, {}, { phase: "attention", yolo: false, animate: true, now });
	notStrictEqual(attention(400), attention(1500));
	strictEqual(stripTerminalSequences(attention(400)), stripTerminalSequences(attention(1500)));
});
test("composer rails stay clean of harness facts and carry only input-owned facts (FW c1-o1)", () => {
	let autonomy = "default";
	let queued = 0;
	let streaming = false;
	const editor = new PancodeEditor(new TuiMainScreen({ columns: 80, rows: 24, write() {} } as unknown as Terminal), {
		getAutonomy: () => autonomy,
		isStreaming: () => streaming,
		getQueuedFollowUpCount: () => queued,
		getQueueReviewKeyLabel: () => "Alt+Q",
	});
	const top = () => stripTerminalSequences(editor.render(80)[0] ?? "");
	const bottom = () => stripTerminalSequences(editor.render(80).at(-1) ?? "");
	strictEqual(top(), "━".repeat(80));
	strictEqual(bottom(), "━".repeat(80));
	autonomy = "yolo";
	doesNotMatch(top(), /YOLO/u);
	doesNotMatch(bottom(), /think|ctx|▰/u);
	queued = 2;
	match(top(), /2 queued · Alt\+Q review/u);
	streaming = true;
	editor.setText("Steer this run");
	match(top(), /^━ STEER ━+ › 2 queued · Alt\+Q review ━$/u);
});
test("permission rail carries a moving attention spectrum", () => {
	const paint = (now: number, animate: boolean) =>
		renderEditorRail(theme, 80, { left: "CONFIRM" }, { phase: "attention", yolo: false, animate, now });
	notStrictEqual(paint(400, true), paint(1500, true));
	strictEqual(stripTerminalSequences(paint(400, true)), stripTerminalSequences(paint(1500, true)));
	strictEqual(paint(400, false), paint(1500, false));
	ok(paint(1500, true).includes(theme.style("attentionRail", "━", { bold: true }).split("━")[0] ?? ""));
});
test("composer holds input-owned rails steady around an existing draft while streaming", () => {
	let now = 400;
	const editor = new PancodeEditor(new TuiMainScreen({ columns: 80, rows: 24, write() {} } as unknown as Terminal), {
		isStreaming: () => true,
		getAnimationTime: () => now,
	});
	strictEqual(stripTerminalSequences(editor.render(80)[0] ?? ""), "━".repeat(80));
	editor.setText("Do not change this draft");
	const before = editor.render(80)[0];
	now = 2200;
	strictEqual(editor.render(80)[0], before);
	strictEqual(editor.getText(), "Do not change this draft");
});
test("approval rail animates its attention pulse when motion is enabled and stays static otherwise", () => {
	let now = 400;
	const make = (awaitingApproval: boolean, motion: boolean) =>
		new PancodeEditor(new TuiMainScreen({ columns: 80, rows: 24, write() {} } as unknown as Terminal), {
			isStreaming: () => true,
			isAwaitingApproval: () => awaitingApproval,
			getMotionEnabled: () => motion,
			getAnimationTime: () => now,
		});
	const animatedApproval = make(true, true);
	const staticApproval = make(true, false);
	const firstAnimated = animatedApproval.render(80)[0];
	const firstStatic = staticApproval.render(80)[0];
	now = 1_700;
	notStrictEqual(animatedApproval.render(80)[0], firstAnimated);
	strictEqual(stripTerminalSequences(animatedApproval.render(80)[0] ?? ""), stripTerminalSequences(firstAnimated ?? ""));
	strictEqual(staticApproval.render(80)[0], firstStatic);
});
test("rail content: the context and thinking group keeps ctx last and drops units in the 4.1 order (W1-2)", () => {
	const thinking = { label: "low", hasLevels: true, supportedLevels: ["off", "low", "medium", "high"] };
	const live = (used: number, inputSource: "anchored-plus-estimated-tail" | "historical" | "estimated") => ({
		budget: { revision: "r1", historical: inputSource === "historical", inputSource },
		used,
		contextWindow: 272_000,
		toolSchemaTokens: 4_000,
		breakdown: { systemPromptTokens: 3_000, toolSchemaTokens: 4_000, messageTokens: used - 7_000, pendingUserTokens: 0 },
	});
	const room = (width: number) => Math.max(1, width - Math.min(16, Math.floor(width / 3)) - 3);
	const group = (context: Parameters<typeof contextRailGroup>[1]["context"], width: number) => {
		const row = contextRailGroup(theme, { context, thinking }, room(width), width);
		ok(visibleWidth(row) <= room(width), `${width}: ${row}`);
		return stripTerminalSequences(row);
	};
	strictEqual(group(live(16_800, "anchored-plus-estimated-tail"), 80), "ctx ▰▱▱▱▱▱ 6% · low ● ○ ○ ○");
	strictEqual(group(live(16_800, "anchored-plus-estimated-tail"), 120), "ctx ▰▱▱▱▱▱▱▱▱▱ 16.8k/272k 6% · low ● ○ ○ ○");
	strictEqual(group(live(10_900, "anchored-plus-estimated-tail"), 33), "ctx 4% · think low");
	strictEqual(group(live(223_000, "anchored-plus-estimated-tail"), 80), "ctx ▰▰▰▰▰▱ 82% high · low ● ○ ○ ○");
	strictEqual(group(live(261_200, "anchored-plus-estimated-tail"), 80), "ctx ▰▰▰▰▰▰ 96% full · low ● ○ ○ ○");
	strictEqual(group(live(223_000, "historical"), 80), "ctx ▰▰▰▰▰▱ saved 82% high · low ● ○ ○ ○");
	strictEqual(group(live(16_800, "historical"), 120), "ctx ▰▱▱▱▱▱▱▱▱▱ saved 16.8k/272k 6% · low ● ○ ○ ○");
	strictEqual(group(live(16_800, "estimated"), 120), "ctx ▰▱▱▱▱▱▱▱▱▱ ≈16.8k/272k 6% · low ● ○ ○ ○");
	const fresh = {
		budget: { revision: "r1", historical: false, inputSource: "unknown" as const },
		used: null,
		contextWindow: 272_000,
		toolSchemaTokens: null,
	};
	strictEqual(group(fresh, 80), "ctx 272k · low ● ○ ○ ○");
	// Narrowing drops the marks (the word stays), then the bar, then the word; `ctx N%` stands last.
	const context = live(16_800, "anchored-plus-estimated-tail");
	const fitted = (cells: number) => stripTerminalSequences(contextRailGroup(theme, { context, thinking }, cells, 80));
	strictEqual(fitted(20), "ctx ▰▱▱▱▱▱ 6% · low");
	strictEqual(fitted(18), "ctx 6% · think low");
	strictEqual(fitted(8), "ctx 6%");
	strictEqual(stripTerminalSequences(contextRailUnit(context, theme, { bar: 0, pair: true })), "ctx 16.8k/272k 6%");
	strictEqual(stripTerminalSequences(thinkingRailUnit(theme, thinking, "labelled") ?? ""), "think low");
});
test("dispatchWaitRuns counts active shadow scouts dispatched by the main turn (FX-7b)", () => {
	// Two shadow scouts the turn dispatched are the workers it waits on; the rail read `a worker` over them (FX-7b).
	const scout = (
		runId: string,
		status: DispatchBoardRow["status"],
		requestOrigin: NonNullable<DispatchBoardRow["requestOrigin"]>,
	): DispatchBoardRow => ({
		runId,
		agentId: "scout",
		agentAudience: "shadow",
		requestOrigin,
		runtimeKind: "http",
		runtimeId: "native",
		targetId: "copilot",
		wireModelId: "gpt-6-luna",
		status,
		elapsedMs: 2_500,
		usage: { kind: "pending" },
		lastContextTokens: null,
		ttft: null,
	});
	const awaited = dispatchWaitRuns([
		scout("a", "running", "agent"),
		scout("b", "enqueued", "agent"),
		scout("c", "completed", "agent"),
		scout("d", "running", "internal"),
	]).length;
	strictEqual(awaited, 2);
});
test("overlay rule: a docked overlay carries only its own title and pending state, never beside-card phase or model (FW f2)", () => {
	for (const width of [80, 60, 48, 33]) {
		const tui = new TuiMainScreen({ columns: width, rows: 24, write() {} } as unknown as Terminal);
		const editor = new PancodeEditor(tui, {
			isStreaming: () => true,
		});
		const entry = dockMount(
			tui,
			{
				renderDockBody: (cells: number, rows: number) => Array.from({ length: Math.min(rows, 3) }, () => " ".repeat(cells)),
				dockTitle: () => "Models",
				dockHint: () => "[type] filter · [Enter] use · [Esc] close",
				dockTone: () => undefined,
				invalidate() {},
			},
			false,
		);
		const top = stripTerminalSequences(editor.render(width)[0] ?? "");
		match(top, /^━ Models ━+$/u, `${width}: ${top}`);
		doesNotMatch(top, /stopping|workers|GPT-6-luna|4s/u, `${width}: ${top}`);
		strictEqual(visibleWidth(top), width);
		dockUnmount(tui, entry);
	}
	// A docked surface waiting on the operator keeps its own pending state on the right end.
	const tui = new TuiMainScreen({ columns: 80, rows: 24, write() {} } as unknown as Terminal);
	const editor = new PancodeEditor(tui, {
		isStreaming: () => true,
	});
	const waiting = dockMount(
		tui,
		{
			renderDockBody: (cells: number, rows: number) => Array.from({ length: Math.min(rows, 3) }, () => " ".repeat(cells)),
			dockTitle: () => "Question",
			dockHint: () => "Enter answer · Esc cancel",
			dockTone: () => undefined,
			dockAwaitingInput: () => true,
			invalidate() {},
		},
		false,
	);
	const waitingTop = stripTerminalSequences(editor.render(80)[0] ?? "");
	match(waitingTop, /^━ Question ━+ ‖ waiting for you ━$/u);
	doesNotMatch(waitingTop, /stopping|GPT-6-luna/u);
	strictEqual(visibleWidth(waitingTop), 80);
	dockUnmount(tui, waiting);
});
test("rail content: a multi-line `!` draft is a prompt, so its bottom rail has no shell unit (W1-10, FX-11)", () => {
	// The composer's own reading: Enter runs a `!` draft as shell only while it is one line (editor-bash.ts).
	const editor = new PancodeEditor(new TuiMainScreen({ columns: 80, rows: 24, write() {} } as unknown as Terminal), {
		getDraftOperator: (text) => (parseEditorBashCommand(text) ? "shell" : null),
	});
	const bottom = (draft: string): string => {
		editor.setText(draft);
		const rows = editor.render(80);
		ok(rows.every((row) => visibleWidth(row) <= 80));
		return stripTerminalSequences(rows.at(-1) ?? "");
	};
	match(bottom("!echo 1"), /^━ \$ shared shell · Enter runs/u);
	match(bottom("!!echo 1"), /^━ \$ private shell · Enter runs/u);
	const more = Array.from({ length: 30 }, (_, index) => `line ${index + 2}`).join("\n");
	for (const lead of ["!echo 1", "!!echo 1"]) {
		doesNotMatch(bottom(`${lead}\nline 2`), /\$/u);
		const tall = bottom(`${lead}\n${more}`);
		match(tall, /^━ 31 lines ━/u);
		doesNotMatch(tall, /\$|shell/u);
	}
	// A paste reads as Enter reads it: the expanded draft, with a `!` that came in the paste kept literal (FX-11b).
	const keyed = (keys: readonly string[], width: number): string => {
		editor.setText("");
		for (const key of keys) editor.handleInput(key);
		const rows = editor.render(width);
		ok(rows.every((row) => visibleWidth(row) <= width));
		return stripTerminalSequences(rows.at(-1) ?? "");
	};
	for (const width of [80, 48, 33]) {
		for (const lead of ["!echo 1", "!!echo 1"]) {
			const pasted = keyed([lead, `\x1b[200~\n${more}\x1b[201~`], width);
			match(pasted, /^━ 31 lines ━/u);
			doesNotMatch(pasted, /\$|shell/u);
		}
		match(keyed(["!", "\x1b[200~echo 1\x1b[201~"], width), /^━ \$ shared/u);
		match(keyed(["!!", "\x1b[200~echo 1\x1b[201~"], width), /^━ \$ private/u);
		doesNotMatch(keyed(["\x1b[200~!echo 1\x1b[201~"], width), /\$|shell/u);
	}
	match(keyed(["!", "\x1b[200~echo 1\x1b[201~"], 80), /^━ \$ shared shell · Enter runs/u);
});

test("editor rails and steady streaming surface reuse cached references and invalidate on input changes", () => {
	let streaming = false;
	let queued = 0;
	const tui = new TuiMainScreen({ columns: 96, rows: 39, write() {} } as unknown as Terminal);
	const editor = new PancodeEditor(tui, {
		isStreaming: () => streaming,
		getQueuedFollowUpCount: () => queued,
		getQueueReviewKeyLabel: () => "Alt+Q",
		getDraftOperator: (text) => (parseEditorBashCommand(text) ? "shell" : null),
	});
	editor.handleInput("a");
	const firstKey = editor.render(96);
	editor.handleInput("b");
	const secondKey = editor.render(96);
	strictEqual(secondKey[0], firstKey[0], "plain keystrokes reuse identical top rail");
	strictEqual(secondKey.at(-1), firstKey.at(-1), "plain keystrokes reuse identical bottom rail");
	ok(secondKey[1] !== firstKey[1], "input line still updates on keystroke");

	streaming = true;
	editor.setText("");
	const stream1 = editor.render(96);
	const stream2 = editor.render(96);
	strictEqual(stream2, stream1, "unchanged streaming deltas reuse cached composer lines");

	queued = 2;
	const withQueue = editor.render(96);
	ok(withQueue !== stream2);
	match(stripTerminalSequences(withQueue[0] ?? ""), /2 queued/u);
});
