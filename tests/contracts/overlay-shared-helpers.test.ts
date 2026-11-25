// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Component, stripTerminalSequences, type TUI, visibleWidth } from "../../src/engine/tui.js";
import { dockTop } from "../../src/interactive/dock.js";
import { createLeaderMenu } from "../../src/interactive/leader-menu.js";
import { centeredWindow, fitRow, fitRows } from "../../src/interactive/overlay-frame.js";
import { GLYPH } from "../../src/interactive/theme/index.js";

const WIDTHS = [60, 80, 120, 200] as const;

/**
 * Six overlays carried a private fit helper, two a `fixedLines`, and settings
 * and the leader menu each a centered scroll window. One copy of each now
 * lives beside the frame, and the overlays are checked for regrowth.
 */
test("fitRow leaves a fitting row alone and cuts a long one on the ellipsis", () => {
	for (const width of WIDTHS) {
		const short = "x".repeat(width - 1);
		strictEqual(fitRow(short, width), short);
		const long = fitRow("y".repeat(width + 20), width);
		strictEqual(visibleWidth(long), width);
		ok(stripTerminalSequences(long).endsWith(GLYPH.ellipsis));
	}
});

test("fitRows returns exactly the height asked for at every width", () => {
	for (const width of WIDTHS) {
		const rows = fitRows(["a", "b".repeat(width + 5)], width, 4);
		strictEqual(rows.length, 4);
		for (const row of rows) strictEqual(visibleWidth(row), width);
		const cut = fitRows(["a", "b", "c"], width, 2);
		strictEqual(cut.length, 2);
	}
});

test("centeredWindow keeps the selection centered and pins at both ends", () => {
	deepStrictEqual(centeredWindow(3, 1, 10), [0, 3]);
	deepStrictEqual(centeredWindow(20, 0, 5), [0, 5]);
	deepStrictEqual(centeredWindow(20, 10, 5), [8, 13]);
	deepStrictEqual(centeredWindow(20, 19, 5), [15, 20]);
	deepStrictEqual(centeredWindow(20, 5, 0), [0, 20]);
});

test("overlay modules no longer carry their own copies", () => {
	const root = fileURLToPath(new URL("../../src/interactive/", import.meta.url));
	for (const file of [
		"overlays/auth-dialog.ts",
		"overlays/decisions.ts",
		"overlays/keybinding-detail.ts",
		"overlays/ask-user.ts",
		"overlays/settings.ts",
		"view/view-overlay.ts",
		"tasks-overlay.ts",
		"leader-menu.ts",
	]) {
		doesNotMatch(
			readFileSync(`${root}${file}`, "utf8"),
			/function (fitLine|fitCell|fitContentLine|fixedLines|scrollWindow)\(/u,
			file,
		);
	}
});

test("leader menu shows the leader chord for actions without a direct shortcut", () => {
	const tui = {
		terminal: { rows: 39, columns: 96 },
		showOverlay(_component: Component) {
			return { hide() {}, setHidden() {}, isHidden: () => false };
		},
		requestRender() {},
	} as unknown as TUI;
	const update = createLeaderMenu(
		tui,
		() => "Composer",
		(id) => (id === "pancode.leader" ? "Ctrl+G" : id === "pancode.model.select" ? "Alt+M" : ""),
	);
	update({ status: "pending", selected: 0 }, [
		{ key: "m", id: "pancode.model.select", label: "Model" },
		{ key: "y", id: "pancode.autonomy.toggle", label: "Autonomy" },
		{ key: "x", id: "pancode.notifications.dismiss", label: "Dismiss notice" },
	]);
	const entry = dockTop(tui);
	ok(entry !== null);
	const rendered = entry.frame.renderDockBody(72, 12).map(stripTerminalSequences).join("\n");
	match(rendered, /Model\s+Alt\+M/u);
	match(rendered, /Autonomy\s+Ctrl\+G Y/u);
	match(rendered, /Dismiss notice\s+Ctrl\+G X/u);
	update({ status: "idle" }, []);
});
