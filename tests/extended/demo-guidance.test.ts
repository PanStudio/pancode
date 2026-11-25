// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, doesNotMatch, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { extractGlobalFlags } from "../../src/cli/argv.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { applyControlValue, SETTING_CONTROLS } from "../../src/core/settings-controls.js";
import { validateSettings } from "../../src/core/settings-validate.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import {
	renderCapabilityMap,
	selectContextualMoment,
	selectWhisperCue,
} from "../../src/interactive/footer/teaching.js";
import { footerState } from "../harness/footer-fixture.js";

test("demo ships enabled, supports validated settings and last-wins session flags", () => {
	strictEqual(DEFAULT_SETTINGS.interface.demo, true);
	const settings = structuredClone(DEFAULT_SETTINGS);
	applyControlValue(settings, "interface.demo", "false");
	strictEqual(settings.interface.demo, false);
	strictEqual(SETTING_CONTROLS.find((c) => c.path === "interface.demo")?.label, "Demo presentation and guidance");
	strictEqual(
		validateSettings({ ...settings, interface: { ...settings.interface, demo: "yes" } }).issues.some(
			(issue) => issue.path === "interface.demo",
		),
		true,
	);
	strictEqual(extractGlobalFlags([]).demo, undefined);
	strictEqual(extractGlobalFlags(["--demo", "--no-demo"]).demo, false);
	strictEqual(extractGlobalFlags(["--no-demo", "--demo"]).demo, true);
	deepStrictEqual(extractGlobalFlags(["run", "--demo"]).rest, ["run", "--demo"]);
});

test("only an explicit interactive prompt input adds guidance; disabling restores identical prompt", () => {
	const table = loadFragments();
	const base = {
		identity: "identity.pancode",
		operatingContract: "operating.contract",
		safety: "safety.default",
		sessionInputs: { coordinatorCapabilities: [] },
	};
	const normal = compile(table, base);
	const demo = compile(table, { ...base, sessionInputs: { ...base.sessionInputs, demo: true } });
	// Which input renders the guidance is pinned in tests/contracts/prompt-section-matrix.test.ts.
	notStrictEqual(demo.systemPrompt, normal.systemPrompt);
	strictEqual(
		compile(table, { ...base, sessionInputs: { ...base.sessionInputs, demo: false } }).systemPrompt,
		normal.systemPrompt,
	);
	deepStrictEqual(
		demo.sections.map((s) => s.id),
		normal.sections.map((s) => s.id),
	);
});

const learnedOf = (revision: number, keys: readonly string[]) => ({
	hydrated: true,
	revision,
	features: Object.fromEntries(keys.map((k) => [k, { count: 1, firstUsedAt: null, lastUsedAt: null }])),
});

test("whisper cues guard on hydration, rotate by turn seed, step down by width, and quiet as capabilities are learned", () => {
	const state = footerState();
	state.demo = true;
	state.outputStyle = "standard";
	state.learned = { hydrated: false, revision: 0, features: {} };
	strictEqual(selectWhisperCue(state, 96, 0), null, "unhydrated profile suppresses whisper cue");

	state.learned = learnedOf(1, []);
	strictEqual(selectWhisperCue(state, 96, 0), "Try /run to dispatch parallel workers");
	strictEqual(selectWhisperCue(state, 80, 0), "Try /run for parallel workers");
	strictEqual(selectWhisperCue(state, 60, 0), "Try /run workers");
	strictEqual(selectWhisperCue(state, 96, 1), "Try /loop to schedule recurring checks");

	// Learning /run removes Fleet from the whisper rotation immediately
	state.learned = learnedOf(2, ["/run"]);
	strictEqual(selectWhisperCue(state, 96, 0), "Try /loop to schedule recurring checks");

	// Compact tier, deck open, busy state, and demo=false suppress whispers
	state.outputStyle = "compact";
	strictEqual(selectWhisperCue(state, 96, 0), null);
	state.outputStyle = "standard";
	state.deckOpen = true;
	strictEqual(selectWhisperCue(state, 96, 0), null);
	state.deckOpen = false;
	state.demo = false;
	strictEqual(selectWhisperCue(state, 96, 0), null);
	state.demo = true;

	// Seasoned user who has used all 10 capabilities gets complete silence
	state.learned = learnedOf(3, [
		"/run",
		"/loop",
		"/tasks",
		"/memory",
		"/context",
		"/thinking",
		"/model",
		"key:pancode.output.cycle",
		"/usage",
		"@",
	]);
	strictEqual(selectWhisperCue(state, 96, 0), null);
});

test("idle deck Capability Map shrinks domain by domain and vanishes once all 6 core domains are learned", () => {
	const state = footerState();
	state.demo = true;
	state.outputStyle = "standard";
	state.learned = learnedOf(1, []);

	const full96 = renderCapabilityMap(state, 96);
	strictEqual(full96.lines.length, 5, "3 body rows + top/bottom border for 6 domains in 2 columns");
	for (const line of full96.lines) strictEqual(visibleWidth(line), 96);
	const plain96 = full96.lines.map(stripTerminalSequences).join("\n");
	match(plain96, /Capabilities.*quiets as you use each/u);
	match(plain96, /\/run · Alt\+W/u);
	match(plain96, /\/loop/u);

	// 60-col floor stacks to 1 column
	const narrow60 = renderCapabilityMap(state, 60);
	strictEqual(narrow60.lines.length, 8, "6 single-column rows + top/bottom border");
	for (const line of narrow60.lines) strictEqual(visibleWidth(line), 60);

	// Learning 2 domains shrinks 3 rows -> 2 rows; learning all 6 vanishes completely
	state.learned = learnedOf(2, ["/run", "/loop"]);
	strictEqual(renderCapabilityMap(state, 96).lines.length, 4);
	state.learned = learnedOf(3, ["/run", "/loop", "/tasks", "/memory", "/context", "key:pancode.output.cycle"]);
	strictEqual(renderCapabilityMap(state, 96).lines.length, 0);

	// Compact tier never shows Capability Map
	state.outputStyle = "compact";
	state.learned = learnedOf(4, []);
	strictEqual(renderCapabilityMap(state, 96).lines.length, 0);
});

test("contextual moments trigger once per situation, respect learned suppression, and never repeat", () => {
	const state = footerState();
	state.demo = true;
	state.outputStyle = "standard";
	state.dispatchRows = [];
	state.learned = learnedOf(1, []);

	// context-40 triggers at >= 40% fill when /context and /compact are unlearned
	state.context = { ...state.context, ledger: null, used: 120_000, contextWindow: 200_000 };
	const ctxMoment = selectContextualMoment(state, 96, {});
	strictEqual(ctxMoment?.id, "moment:context-40");
	match(ctxMoment?.text ?? "", /60% context used · \/context shows what fills it · \/compact trims history/u);
	// Never repeats once recorded in lessons
	strictEqual(
		selectContextualMoment(state, 96, { "moment:context-40": { shown: 1, lastShownAt: "2026-11-24T00:00:00Z" } }),
		null,
	);
	// Suppressed once /context is learned
	state.learned = learnedOf(2, ["/context"]);
	strictEqual(selectContextualMoment(state, 96, {}), null);

	// first-tools triggers after a settled turn with >= 3 tool calls
	state.learned = learnedOf(3, ["/context"]);
	state.agent.lastTurn = {
		elapsedMs: 4000,
		toolCount: 4,
		toolErrorCount: 0,
		stopReason: "stop",
	} as never;
	const toolsMoment = selectContextualMoment(state, 96, {});
	strictEqual(toolsMoment?.id, "moment:first-tools");
	match(toolsMoment?.text ?? "", /\/view inspects recorded tool calls and full outputs/u);

	// first-stream triggers during streaming while steer is unlearned
	state.status = {
		phase: "writing",
		since: 1000,
		lastMeaningfulAt: 1000,
		watchdogTier: 0,
		watchdogPeak: 0,
		localRuntime: false,
	};
	const streamMoment = selectContextualMoment(state, 96, {});
	strictEqual(streamMoment?.id, "moment:first-stream");
	match(streamMoment?.text ?? "", /Type while running to steer at the next step/u);
	doesNotMatch(streamMoment?.text ?? "", /\[Alt\+Q\]/u);
	ok(selectContextualMoment({ ...state, demo: false }, 96, {}) === null);
});
