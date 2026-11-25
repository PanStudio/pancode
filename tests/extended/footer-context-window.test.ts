// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { match, ok } from "node:assert/strict";
import { it } from "node:test";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { dashboardPageViewport } from "../../src/interactive/footer/pages.js";
import { footerState } from "../harness/footer-fixture.js";

it("live deck Route island retains the distinguishing model suffix", () => {
	const state = footerState();
	state.session.target = `blade · dynamo/${"long-model-".repeat(10)}FINAL_MODEL`;
	for (const width of [80, 120, 200]) {
		const rows = dashboardPageViewport(state, width, 40, "Alt+U");
		match(stripTerminalSequences(rows[1] ?? ""), /FINAL_MODEL/);
		ok(rows.every((row) => visibleWidth(row) <= width));
	}
});
