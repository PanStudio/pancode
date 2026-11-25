// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterEach, test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { asciiOnly, colorDisabled, motionEnabled, nerdFontEnabled } from "../../src/core/terminal-preferences.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { thinkingRailUnit } from "../../src/interactive/footer/context-rail.js";
import { createPancodeTheme } from "../../src/interactive/theme/index.js";
import {
	buildWelcomeDashboardLines,
	createBootWelcome,
	createWelcomeDashboard,
} from "../../src/interactive/welcome-dashboard.js";

const originalEnv = { ...process.env };
afterEach(() => {
	for (const key of ["TERM", "PANCODE_ASCII", "PANCODE_SCREEN_READER", "PANCODE_NERD_FONT", "NO_COLOR"]) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
});

test("ASCII glyph selection is startup-wide and keeps decision marks, frames, and rails readable", () => {
	const probe = `
		import { GLYPH, pancodeTheme, frame } from "./src/interactive/theme/index.ts";
		import { renderEditorRail } from "./src/interactive/editor-rails.ts";
		import { PancodeOverlayFrame } from "./src/interactive/overlay-frame.ts";
		import { cardHead, cardRows } from "./src/interactive/card.ts";
		import { renderCapabilityMap, selectWhisperCue } from "./src/interactive/footer/teaching.ts";
		import { DEFAULT_SETTINGS } from "./src/core/defaults.ts";
		import { createBootWelcome } from "./src/interactive/welcome-dashboard.ts";
		import { createMermaidMarkdownTransform } from "./src/interactive/renderers/mermaid.ts";
		const theme = pancodeTheme();
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.chat.target = "local";
		settings.chat.model = "test-model";
		settings.interface.outputDetail = "detailed";
		const lines = frame(theme, "Approval", ["target /work/example", "[Enter] allow [Esc] deny"], 40);
		const rail = renderEditorRail(theme, 40, {}, { phase: "working", yolo: false, animate: true, now: 0 });
		const overlay = new PancodeOverlayFrame({ render: () => ["target /work/example"], invalidate() {} }, "Approval", "[Enter] allow / [Esc] deny").render(40);
		const card = [...cardHead(GLYPH.toolHeader + " read /work/example", " " + GLYPH.ok, 40), ...cardRows("target /work/example", 40, true)];
		const welcome = createBootWelcome(settings).render(80);
		const teachingState = {
			demo: true,
			deckOpen: false,
			outputStyle: "standard",
			learned: { hydrated: true, revision: 1, features: {} },
			status: { phase: "idle", since: 0, lastMeaningfulAt: 0, watchdogTier: 0, watchdogPeak: 0, localRuntime: false },
		};
		const tip = selectWhisperCue(teachingState, 96, 0) ?? "";
		const capMap = renderCapabilityMap(teachingState, 96).lines;
		const mermaid = createMermaidMarkdownTransform(theme)("\`\`\`mermaid\\ngraph TD\\nA[Start] --> B[End]\\n\`\`\`\\n", 80);
		delete process.env.PANCODE_ASCII;
		process.env.TERM = "xterm-256color";
		console.log(JSON.stringify({ glyphs: GLYPH, lines, overlay, card, rail, welcome, tip, capMap, mermaid }));
	`;
	for (const fallback of [{ PANCODE_ASCII: "1", TERM: "xterm-256color" }, { TERM: "dumb" }, { TERM: "unknown" }]) {
		const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
			env: { ...process.env, NO_COLOR: "1", ...fallback },
			encoding: "utf8",
			timeout: 20_000,
		});
		strictEqual(result.status, 0, result.stderr);
		const output = JSON.parse(result.stdout) as {
			glyphs: Record<string, string>;
			lines: string[];
			overlay: string[];
			card: string[];
			rail: string;
			welcome: string[];
			tip: string;
			capMap: string[];
			mermaid: string;
		};
		ok(Object.values(output.glyphs).every((glyph) => /^[\x20-\x7e]*$/u.test(glyph)));
		strictEqual(new Set([output.glyphs.ok, output.glyphs.error, output.glyphs.cancelled]).size, 3);
		ok(output.lines.every((line) => visibleWidth(line) === 40));
		ok(output.lines.map(stripTerminalSequences).every((line) => /^[\x20-\x7e]+$/u.test(line)));
		ok(output.overlay.every((line) => visibleWidth(line) === 40));
		ok(output.overlay.map(stripTerminalSequences).every((line) => /^[\x20-\x7e]+$/u.test(line)));
		match(stripTerminalSequences(output.overlay[0] ?? ""), /^\+- Approval /u);
		ok(output.card.map(stripTerminalSequences).every((line) => /^[\x20-\x7e]+$/u.test(line)));
		match(stripTerminalSequences(output.card[1] ?? ""), /^ {2}\| target/u);
		match(stripTerminalSequences(output.rail), /^-+$/u);
		strictEqual(output.glyphs.rail, "|");
		strictEqual(output.welcome.length, 1);
		match(stripTerminalSequences(output.welcome[0] ?? ""), /^\[P\] PanCode \d/u);
		match(output.tip, /^Try \/run to dispatch parallel workers$/u);
		ok(output.capMap.length === 5);
		ok(output.capMap.map(stripTerminalSequences).every((line) => /^[\x20-\x7e]+$/u.test(line)));
		match(stripTerminalSequences(output.capMap[1] ?? ""), /\/run, Alt\+W/u);
		ok(/^[\x20-\x7e\n]+$/u.test(stripTerminalSequences(output.mermaid)), output.mermaid);
		match(output.mermaid, /\+-+\+/u);
		match(output.mermaid, /\bv\b/u);
	}
	const env = { TERM: "xterm-256color", PANCODE_ASCII: "1", PANCODE_NERD_FONT: "1" };
	strictEqual(asciiOnly(env), true);
	strictEqual(motionEnabled(env), false);
	strictEqual(nerdFontEnabled(env), false);
	strictEqual(asciiOnly({ TERM: "xterm-256color", NO_COLOR: "1" }), false);
});

test("W0-3 glyph table: ASCII values are ASCII bytes, blocked differs from warning, operator paths stay byte for byte", () => {
	const path = "src/日本語/é≥.py";
	const probe = `
		import { GLYPH } from "./src/core/glyphs.ts";
		import { visibleWidth } from "./src/engine/tui.ts";
		import { renderToolPreview } from "./src/interactive/renderers/tool-execution.ts";
		import { transcriptDetail } from "./src/interactive/transcript-detail.ts";
		const call = { toolName: "read", toolCallId: "r1", args: { path: ${JSON.stringify(path)} }, result: "contents", isError: false };
		const rows = [];
		for (const tier of ["compact", "standard", "detailed"]) {
			for (const width of [33, 48, 65, 80]) {
				const lines = renderToolPreview(call, width, transcriptDetail(tier));
				rows.push({ width, lines, widest: Math.max(...lines.map((line) => visibleWidth(line))) });
			}
		}
		console.log(JSON.stringify({ glyphs: GLYPH, rows }));
	`;
	for (const ascii of [true, false]) {
		const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
			env: { ...process.env, TERM: "xterm-256color", PANCODE_ASCII: ascii ? "1" : "0" },
			encoding: "utf8",
			timeout: 20_000,
		});
		strictEqual(result.status, 0, result.stderr);
		const output = JSON.parse(result.stdout) as {
			glyphs: Record<string, string>;
			rows: { width: number; lines: string[]; widest: number }[];
		};
		if (ascii) {
			ok(Object.values(output.glyphs).every((glyph) => /^[\x20-\x7e]*$/u.test(glyph)));
			strictEqual(output.glyphs.phaseBlocked, "=");
			strictEqual(output.glyphs.warn, "!");
		}
		for (const row of output.rows) {
			ok(
				row.lines.map(stripTerminalSequences).some((line) => line.includes(path)),
				`${row.width}: ${row.lines}`,
			);
			ok(row.widest <= row.width, `${row.width}: ${row.widest}`);
		}
	}
});

test("ASCII ellipsis is three dots, and every cut that carries it stays inside its width", () => {
	const probe = `
		import { GLYPH, closeWithEllipsis, fitIdentityLabel, fitPathLabel } from "./src/interactive/theme/index.ts";
		import { elideModelId, renderStatusLine } from "./src/interactive/footer/status-line.ts";
		import { footerState } from "./tests/harness/footer-fixture.ts";
		const state = footerState();
		state.workspace.cwd = "~/projects/clients/tui-fix/repo";
		const status = [40, 60, 80, 100, 120, 160].map((width) => ({ width, lines: renderStatusLine(state, width, 40) }));
		const fits = [];
		for (let width = 0; width <= 14; width += 1) {
			fits.push({ width, text: fitIdentityLabel("qwopus3.6-27b-dense-q4km", width) });
			fits.push({ width, text: fitPathLabel("~/projects/clients/tui-fix/repo", width) });
			fits.push({ width, text: closeWithEllipsis("a row that fills the width", width) });
		}
		for (const width of [12, 16, 20]) fits.push({ width, text: elideModelId("vendor/claude-sonnet-5.5-20261101-preview", width) });
		console.log(JSON.stringify({ ellipsis: GLYPH.ellipsis, status, fits }));
	`;
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
		env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1", PANCODE_ASCII: "1" },
		encoding: "utf8",
		timeout: 20_000,
	});
	strictEqual(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout) as {
		ellipsis: string;
		status: { width: number; lines: string[] }[];
		fits: { width: number; text: string }[];
	};
	strictEqual(output.ellipsis, "...");
	const statusText = output.status.flatMap((entry) => entry.lines.map(stripTerminalSequences));
	ok(
		statusText.some((line) => line.includes("~/.../tui-fix/repo")),
		statusText.join("\n"),
	);
	ok(statusText.every((line) => !line.includes("~/~/")));
	for (const entry of output.status) {
		for (const line of entry.lines) ok(visibleWidth(line) <= entry.width, `${entry.width}: ${line}`);
	}
	for (const fit of output.fits) ok(visibleWidth(fit.text) <= fit.width, `${fit.width}: ${fit.text}`);
	ok(output.fits.some((fit) => fit.text.includes("...")));
});

test("FX-19 ASCII mode: tool cards and the Fleet Runs board draw only ASCII chrome at 80 columns", () => {
	const probe = `
		import { stripTerminalSequences } from "./src/engine/tui.ts";
		import { createDispatchBoardView } from "./src/interactive/dispatch-board.ts";
		import { renderToolPreview } from "./src/interactive/renderers/tool-execution.ts";
		import { transcriptDetail } from "./src/interactive/transcript-detail.ts";
		import { footerState } from "./tests/harness/footer-fixture.ts";
		const output = Array.from({ length: 60 }, (_, i) => "line " + i).join("\\n");
		const calls = [
			{ toolName: "read", toolCallId: "r1", args: { path: "src/a.ts" }, result: output, isError: false, durationMs: 1200 },
			{ toolName: "bash", toolCallId: "b1", args: { command: "pnpm test" }, result: output, isError: false, durationMs: 4200, exitCode: 0 },
			{ toolName: "find", toolCallId: "f1", args: { pattern: "**/*.ts", limit: 20 }, result: output, isError: true },
			{ toolName: "dispatch", toolCallId: "d1", args: { agent: "coder", task: "x", intent: { write_roots: ["src", "tests"] } }, result: "done", isError: false },
		];
		const lines = [];
		for (const tier of ["standard", "detailed"]) {
			for (const call of calls) lines.push(...renderToolPreview(call, 80, transcriptDetail(tier)));
		}
		const base = footerState().dispatchRows[0];
		const board = createDispatchBoardView(
			() => [{ ...base, runId: "r-1", status: "running" }, { ...base, runId: "r-2", status: "enqueued" }],
			() => undefined,
		);
		lines.push(...board.render(80));
		board.toggleDetail();
		lines.push(...board.render(80));
		console.log(JSON.stringify(lines.map(stripTerminalSequences)));
	`;
	const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
		env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1", PANCODE_ASCII: "1" },
		encoding: "utf8",
		timeout: 20_000,
	});
	strictEqual(result.status, 0, result.stderr);
	const lines = JSON.parse(result.stdout) as string[];
	// The args row, the earlier-lines hint and the receipt are each drawn, so the check covers them.
	ok(lines.some((line) => /limit > 20/u.test(line)));
	ok(lines.some((line) => /\.\.\. \d+ earlier lines \| \/view/u.test(line)));
	ok(lines.some((line) => /\| 1\.2s$/u.test(line.trimEnd())));
	const unicode = lines.filter((line) => /[^\x20-\x7e]/u.test(line));
	deepStrictEqual(unicode, []);
});

test("FX-19b ASCII mode: the framed Fleet Runs board keeps its rail, counts, fact rows and bounds ASCII", () => {
	const probe = `
		import { setPresentationTier } from "./src/core/presentation-tier.ts";
		import { stripTerminalSequences } from "./src/engine/tui.ts";
		import { createDispatchBoardView, dispatchBoardEscapeEntry, dispatchBoardHintEntries } from "./src/interactive/dispatch-board.ts";
		import { buildResponsiveHint, PancodeOverlayFrame } from "./src/interactive/overlay-frame.ts";
		import { footerState } from "./tests/harness/footer-fixture.ts";
		import { runUsageOf } from "./tests/harness/telemetry-view.ts";
		const base = footerState().dispatchRows[0];
		// One call reported nothing, so every token figure is a lower bound.
		const usage = runUsageOf("r-1", [{ usage: { input: 10000, output: 150 }, usd: null }, { usage: { input: null, output: null }, usd: null }]);
		const task = Array.from({ length: 30 }, (_, i) => "step " + i + " reads the files and reports").join(" ");
		const lines = [];
		for (const tier of ["compact", "detailed"]) {
			setPresentationTier(tier);
			for (const status of ["running", "completed"]) {
				const rows = [
					{ ...base, runId: "r-1", status, usage, ttft: "3.83s", taskSummary: task, endpoint: { label: "copilot", limit: 4 } },
					...Array.from({ length: 16 }, (_, i) => ({ ...base, runId: "r-" + (i + 2), status: i % 2 === 0 ? "completed" : "enqueued" })),
				];
				const board = createDispatchBoardView(() => rows, () => undefined);
				const hint = (inner) => buildResponsiveHint(dispatchBoardHintEntries(board), dispatchBoardEscapeEntry(board))(inner);
				const frame = new PancodeOverlayFrame(board, "Fleet Runs", hint, 76);
				frame.setRowBudget(23);
				lines.push(...frame.render(80));
				board.toggleDetail();
				for (let page = 0; page < 3; page += 1) {
					frame.invalidate();
					lines.push(...frame.render(80));
					board.scrollDetail(1);
				}
			}
		}
		console.log(JSON.stringify(lines.map(stripTerminalSequences)));
	`;
	const draw = (env: Record<string, string>): string[] => {
		const inherited = { ...process.env };
		delete inherited.PANCODE_ASCII;
		delete inherited.NO_COLOR;
		const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", probe], {
			env: { ...inherited, TERM: "xterm-256color", ...env },
			encoding: "utf8",
			timeout: 20_000,
		});
		strictEqual(result.status, 0, result.stderr);
		return JSON.parse(result.stdout) as string[];
	};
	const ascii = draw({ NO_COLOR: "1", PANCODE_ASCII: "1" });
	// Each chrome source is drawn, so the check covers it: the key rail, a position row, the overflowing status row
	// closing on its cut mark, and the read model's lower bound in the table and the detail.
	ok(ascii.some((line) => line.includes("[^v] select | [Enter] detail | [m] steer | [x] cancel | [Esc] close")));
	ok(ascii.some((line) => /\| 1-9 of 17 runs +\|/u.test(line)));
	ok(ascii.some((line) => line.includes("1 of 17 runs | 16 hidden while the detail is open")));
	ok(ascii.some((line) => /status +@ running \| slots 1\/4 copilot \| first output after 3\.83s \.\.\./u.test(line)));
	ok(ascii.some((line) => /\d-\d+ of \d+ detail rows/u.test(line)));
	ok(ascii.some((line) => / >=10\.0k +>=150 /u.test(line)));
	ok(ascii.some((line) => line.includes("prompt >=10,000 | out >=150")));
	deepStrictEqual(
		ascii.filter((line) => /[^\x20-\x7e]/u.test(line)),
		[],
	);
	// The Unicode board keeps every spelling it had.
	const unicode = draw({});
	ok(unicode.some((line) => line.includes("[↑↓] select · [Enter] detail · [m] steer · [x] cancel · [Esc] close")));
	ok(unicode.some((line) => line.includes("1–9 of 17 runs")));
	ok(unicode.some((line) => line.includes("1 of 17 runs · 16 hidden while the detail is open")));
	ok(unicode.some((line) => /status +● running · slots 1\/4 copilot · first output after 3\.83s …/u.test(line)));
	ok(unicode.some((line) => / ≥10\.0k +≥150 /u.test(line)));
	ok(unicode.some((line) => line.includes("prompt ≥10,000 · out ≥150")));
});

test("demo-off skips welcome-only readers and live toggles restore the full welcome", () => {
	process.env.TERM = "xterm-256color";
	delete process.env.PANCODE_SCREEN_READER;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.interface.demo = false;
	settings.interface.outputDetail = "detailed";
	settings.chat.target = "local";
	settings.chat.model = "test-model";
	const reads = { context: 0, quota: 0, recipes: 0, keys: 0 };
	const header = createWelcomeDashboard({
		providers: { list: () => [] },
		getSettings: () => settings,
		getContextState: () => {
			reads.context++;
			return { pancodeMd: "none" } as never;
		},
		getQuotaSummary: () => {
			reads.quota++;
			return "quota";
		},
		getAgentCount: () => {
			reads.recipes++;
			return 3;
		},
		getKeyLabel: () => {
			reads.keys++;
			return "Ctrl+J";
		},
		scheduleRefresh: (run) => run(),
	});
	try {
		for (const width of [8, 40, 80, 120, 180]) {
			const lines = header.render(width);
			strictEqual(lines.length, 1);
			ok(lines.every((line) => visibleWidth(line) <= width));
		}
		deepStrictEqual(reads, { context: 0, quota: 0, recipes: 0, keys: 0 });
		match(stripTerminalSequences(header.render(180)[0] ?? ""), /^▐P▌ PanCode \d/u);
		settings.interface.demo = true;
		ok(header.render(180).length > 1);
		ok(reads.context > 0 && reads.quota > 0);
		strictEqual(reads.keys, 0);
		strictEqual(reads.recipes, 0);
		strictEqual(header.isLaunchpadVisible(), true);
		header.collapseToSessionHeader();
		settings.interface.demo = false;
		header.resetToLaunchpad();
		strictEqual(header.render(180).length, 1);
		settings.interface.demo = true;
		ok(header.render(180).length > 1);
	} finally {
		header.dispose();
	}
});

test("instant welcome caches stable frames, fits resizing, and honors demo-off", () => {
	process.env.TERM = "xterm-256color";
	delete process.env.PANCODE_SCREEN_READER;
	const settings = structuredClone(DEFAULT_SETTINGS);
	const full = createBootWelcome(settings, "Enter");
	const frame = full.render(180);
	strictEqual(full.render(180), frame);
	ok(frame.length > 1);
	const resized = full.render(80);
	ok(resized.every((line) => visibleWidth(line) <= 80));
	full.invalidate();
	ok(full.render(80) !== resized);
	settings.interface.demo = false;
	strictEqual(createBootWelcome(settings, "Enter").render(180).length, 1);
});

test("limited terminal and screen-reader welcome avoids the artwork even with demo on", () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	for (const term of ["dumb", "unknown"]) {
		process.env.TERM = term;
		strictEqual(createBootWelcome(settings, "Enter").render(180).length, 1);
	}
	process.env.TERM = "xterm-256color";
	process.env.PANCODE_SCREEN_READER = "1";
	strictEqual(createBootWelcome(settings, "Enter").render(180).length, 1);
});

test("thinking unit uses ordinary marks unless Nerd Font coverage is explicitly declared", () => {
	process.env.TERM = "xterm-256color";
	delete process.env.NO_COLOR;
	delete process.env.PANCODE_NERD_FONT;
	delete process.env.PANCODE_SCREEN_READER;
	const theme = createPancodeTheme({ color: true, truecolor: true });
	const unit = () =>
		stripTerminalSequences(
			thinkingRailUnit(
				theme,
				{ label: "high", hasLevels: true, supportedLevels: ["off", "low", "medium", "high"] },
				"marks",
			) ?? "",
		);
	match(unit(), /● ● ● ○/u);
	ok(!unit().includes("\uEE9C"));
	process.env.PANCODE_NERD_FONT = "1";
	ok(unit().includes("\uEE9C"));
	process.env.PANCODE_SCREEN_READER = "1";
	match(unit(), /think high/u);
	strictEqual(nerdFontEnabled(), false);
});

test("the wide detailed welcome aligns its orientation fact values without duplicating status-line facts", () => {
	const stats = {
		outputStyle: "detailed" as const,
		cwd: "/tmp/welcome-test",
		workspace: null,
		targetLabel: "local",
		modelLabel: "test-model",
		route: "ready" as const,
		routeReason: null,
		projectContext: "ok" as const,
		submitKeyLabel: "Enter",
		autonomy: "default",
		targets: "3 configured",
		fleet: "12 agent recipes",
		quota: "Claude 5h 7% used/wk 100% used · Codex wk 26% used · Local $0.00",
	};
	for (const width of [200, 240]) {
		const lines = buildWelcomeDashboardLines(stats, "0.5.7", width, "launchpad").map(stripTerminalSequences);
		ok(lines.every((line) => visibleWidth(line) <= width));
		const column = (text: string) => {
			const row = lines.find((line) => line.includes(text));
			ok(row, `missing ${text} at ${width} columns`);
			return row.indexOf(text);
		};
		strictEqual(column("✓ ready"), column("up to date"));
		strictEqual(column("auto edits"), column("up to date"));
		const text = lines.join("\n");
		ok(!text.includes("/tmp/welcome-test"), "cwd stays on the status line");
		ok(!text.includes("test-model"), "raw model id stays on the status line");
	}
});

test("terminals declaring no capabilities disable color independently of font opt-in", () => {
	for (const term of ["dumb", "unknown"]) {
		strictEqual(colorDisabled({ TERM: term }), true);
		strictEqual(nerdFontEnabled({ TERM: term, PANCODE_NERD_FONT: "1" }), false);
	}
	strictEqual(colorDisabled({ TERM: "xterm-256color", NO_COLOR: "" }), false);
	strictEqual(colorDisabled({ TERM: "xterm-256color", NO_COLOR: "1" }), true);
});

test("welcome stays bounded from Stage 0 through quota hydration and omits usage when unconnected", () => {
	process.env.TERM = "xterm-256color";
	delete process.env.PANCODE_SCREEN_READER;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.interface.outputDetail = "detailed";
	const boot = createBootWelcome(settings, "Enter");
	let quota: string | null = null;
	const hydrated = createWelcomeDashboard({
		providers: { list: () => [] },
		getSettings: () => settings,
		getQuotaSummary: () => quota,
		getKeyLabel: () => "Ctrl+J",
	});
	try {
		for (const width of [8, 20, 40, 60, 76, 80, 100, 160, 200, 240]) {
			const initial = boot.render(width);
			ok(initial.length <= 24, "artwork remains bounded on narrow terminals");
			for (const reading of [
				null,
				"Local $0.00",
				"Claude 5h 7% used/wk 100% used · Codex wk 26% used · Local $0.00",
				"Account quota summary ".repeat(100),
			]) {
				quota = reading;
				const lines = hydrated.render(width);
				ok(lines.every((line) => visibleWidth(line) <= width));
			}
		}
		const overflow = hydrated.render(200).map(stripTerminalSequences).join("\n");
		match(overflow, /Account quota summary.*…/u);
		quota = null;
		const cleared = hydrated.render(200).map(stripTerminalSequences).join("\n");
		ok(!cleared.includes("Account quota"));
		ok(!cleared.includes("usage      "), "absent quota renders silently");
		settings.interface.demo = false;
		quota = "Account quota summary ".repeat(100);
		strictEqual(hydrated.render(200).length, 1);
	} finally {
		hydrated.dispose();
	}
});

test("welcome renders orientation guidance without configuration inventory or duplicated route facts", () => {
	const stats = {
		outputStyle: "detailed" as const,
		cwd: "/tmp/project",
		workspace: null,
		targetLabel: "local",
		modelLabel: "model",
		route: "ready" as const,
		routeReason: null,
		projectContext: "none" as const,
		submitKeyLabel: "Enter",
		autonomy: "yolo",
		targets: "9 configured",
		fleet: "28 recipes",
		quota: null,
	};
	for (const width of [80, 120, 180, 240]) {
		const rows = buildWelcomeDashboardLines(stats, "0.5.7", width, "launchpad").map(stripTerminalSequences);
		const artRows = rows.flatMap((line, index) => (line.includes("██") ? [index] : []));
		ok(artRows.length > 0);
		const text = rows.join("\n");
		ok(!/describe a task|Permissions|configured|recipes|Systems engineering/u.test(text));
		match(text, /✓ ready · local target healthy/u);
		match(text, /contained · OS sandbox active/u);
		match(text, /not indexed yet · \/context init/u);
		const stale = buildWelcomeDashboardLines({ ...stats, projectContext: "stale" }, "0.5.7", width, "launchpad")
			.map(stripTerminalSequences)
			.join("\n");
		match(stale, /out of date · \/context refresh/u);
		ok(!stale.includes("/context init"));
	}
});

test("the detailed banner claims only automatic edits on a host whose shell runs without an OS sandbox (bt-11 #6)", () => {
	process.env.TERM = "xterm-256color";
	delete process.env.PANCODE_SCREEN_READER;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = "local";
	settings.chat.model = "test-model";
	settings.interface.demo = true;
	settings.interface.outputDetail = "detailed";
	let contained: boolean | null = false;
	const live = createWelcomeDashboard({
		providers: { list: () => [] },
		getSettings: () => settings,
		getTerminalRows: () => 40,
		getShellContained: () => contained,
	});
	try {
		for (const width of [80, 120, 200]) {
			const lines = live.render(width);
			ok(lines.every((line) => visibleWidth(line) <= width));
			const text = lines.map(stripTerminalSequences).join("\n");
			match(text, /auto edits · no OS sandbox/u);
			ok(!text.includes("auto in workspace"), text);
		}
		contained = null;
		const unchecked = live.render(120).map(stripTerminalSequences).join("\n");
		match(unchecked, /sandbox {4}auto edits$/mu);
		ok(!unchecked.includes("auto in workspace") && !unchecked.includes("no OS sandbox"), unchecked);
		contained = true;
		match(live.render(120).map(stripTerminalSequences).join("\n"), /auto in workspace · OS sandbox active/u);
	} finally {
		live.dispose();
	}
});

test("startup and live tier changes share one bounded welcome policy", () => {
	process.env.TERM = "xterm-256color";
	delete process.env.PANCODE_SCREEN_READER;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.target = "local";
	settings.chat.model = "test-model";
	const live = createWelcomeDashboard({
		providers: { list: () => [] },
		getSettings: () => settings,
		getTerminalRows: () => 40,
	});
	try {
		for (const demo of [true, false]) {
			settings.interface.demo = demo;
			for (const style of ["compact", "standard", "detailed"] as const) {
				settings.interface.outputDetail = style;
				const boot = createBootWelcome(settings, "Enter");
				for (const width of [80, 120, 200]) {
					for (const header of [boot, live]) {
						const lines = header.render(width);
						const text = lines.map(stripTerminalSequences).join("\n");
						ok(lines.every((line) => visibleWidth(line) <= width));
						match(text, /▐P▌ PanCode/u);
						if (!demo) {
							strictEqual(lines.length, 1);
							ok(!/██|\/help|awareness/u.test(text));
						} else if (style === "compact") {
							// The header, the blocker it cannot hide, and the tagline.
							const facts = lines.map(stripTerminalSequences).filter((line) => !line.includes("██"));
							strictEqual(facts.length, 3, text);
							ok(facts[1]?.startsWith("‖ /config"), text);
							ok(!/\/help|awareness/u.test(text));
						} else if (style === "standard") {
							ok(lines.length <= 11);
							ok(text.includes("awareness"), text);
							ok(!text.includes("sandbox"), text);
						} else
							ok(text.includes("██") && text.includes("health") && text.includes("sandbox") && text.includes("awareness"));
					}
				}
			}
		}
		settings.interface.demo = true;
		settings.interface.outputDetail = "detailed";
		const before = live.render(120);
		settings.safety.autonomy = "yolo";
		const after = live.render(120);
		ok(after !== before, "autonomy invalidates the welcome cache");
		match(after.map(stripTerminalSequences).join("\n"), /contained · OS sandbox active/u);
	} finally {
		live.dispose();
	}
});
