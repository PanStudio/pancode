// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { test } from "node:test";
import { revealScroll } from "../client/interaction/reveal-model.js";
import { rowAfterKey } from "../client/interaction/row-keys-model.js";

test("Up, Down, j and k step between rows without wrapping, and Home and End jump", () => {
	const on = (at: number) => ({ at, on: true });
	assert.equal(rowAfterKey("ArrowDown", on(0), 3), 1);
	assert.equal(rowAfterKey("j", on(1), 3), 2);
	assert.equal(rowAfterKey("ArrowDown", on(2), 3), 2, "the last row stays");
	assert.equal(rowAfterKey("k", on(2), 3), 1);
	assert.equal(rowAfterKey("ArrowUp", on(0), 3), 0, "the first row stays");
	assert.equal(rowAfterKey("Home", on(2), 3), 0);
	assert.equal(rowAfterKey("End", on(0), 3), 2);
	for (const key of ["ArrowRight", "J", "Enter", " "]) assert.equal(rowAfterKey(key, on(1), 3), -1, key);
	assert.equal(rowAfterKey("ArrowDown", on(0), 0), -1, "an empty list leaves the key alone");
});

test("from between rows (a group heading or button), Down takes the next row and Up the one before", () => {
	// Focus on the list itself, before any row.
	assert.equal(rowAfterKey("ArrowDown", { at: 0, on: false }, 4), 0);
	assert.equal(rowAfterKey("ArrowUp", { at: 0, on: false }, 4), 0);
	// Focus on a group's "New task" button after the first two rows.
	assert.equal(rowAfterKey("j", { at: 2, on: false }, 4), 2);
	assert.equal(rowAfterKey("k", { at: 2, on: false }, 4), 1);
	// Past the last row.
	assert.equal(rowAfterKey("ArrowDown", { at: 4, on: false }, 4), 3);
});

test("a scrolling tab bar moves only as far as it must to show its current tab (gui-verify 9)", () => {
	// A 390px bar at rest, its current tab at 472..586 as the audit measured.
	assert.equal(revealScroll(0, 358, 472, 114), 228, "a tab past the right edge scrolls in to the edge");
	assert.equal(revealScroll(300, 358, 100, 80), 100, "a tab past the left edge scrolls in to the edge");
	assert.equal(revealScroll(50, 358, 100, 80), 50, "a tab in view leaves the bar where it is");
	assert.equal(revealScroll(0, 100, 40, 200), 40, "a tab wider than the bar shows its start");
});
