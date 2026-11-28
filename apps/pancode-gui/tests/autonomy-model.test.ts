// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { test } from "node:test";
import { autonomyMenu, currentAutonomy } from "../client/chat/autonomy-model.js";

const DEFAULT =
	"Edits and commands inside this workspace go ahead. Commands run in a sandbox that limits what they can change. Riskier calls go to an automatic safety check, which runs them, refuses them or asks you. Decisions only you can make ask you directly.";
const YOLO =
	"No approval card waits for you. Commands run in a sandbox that limits what they can change. The automatic safety check works as it does in default, and anything that would ask you is refused back to PanCode instead. PanCode's built-in blocks, your own safety rules and the run's limits still apply, and questions PanCode asks still reach you.";
const modes = [
	{ id: "default", name: "default", description: DEFAULT },
	{ id: "yolo", name: "yolo", description: YOLO },
];

test("the autonomy menu repeats the engine's mode descriptions verbatim", () => {
	const menu = autonomyMenu({ level: "default", source: "settings", modes });
	assert.deepEqual(
		menu.rows.map((row) => [row.level, row.description, row.current, row.disabled]),
		[
			["default", DEFAULT, true, false],
			["yolo", YOLO, false, false],
		],
	);
	assert.ok(menu.confirmation.includes(YOLO));
	assert.ok(menu.confirmation.startsWith("Switch this session to YOLO? "));
	assert.ok(menu.confirmation.endsWith(" It lasts until the session closes."));
	assert.equal(menu.unrecognized, undefined);
});

test("an engine that describes no modes gets a plain statement, not invented semantics", () => {
	const menu = autonomyMenu({ level: "yolo", source: "session" });
	const undescribed = "PanCode did not describe this mode.";
	assert.deepEqual(
		menu.rows.map((row) => row.description),
		[undescribed, undescribed],
	);
});

test("an unknown current mode disables both rows and is preferred from the newer push", () => {
	const read = { level: "default" as const, source: "session", modes };
	const pushed = { ...read, unrecognized: "plan" };
	const menu = autonomyMenu(currentAutonomy(read, pushed));
	assert.equal(menu.unrecognized, "plan");
	assert.ok(menu.rows.every((row) => row.disabled && !row.current));
	assert.equal(currentAutonomy(read, { ...pushed, level: "yolo" }), read);
});
