// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { resolveSettingsArea, SETTINGS_AREAS, settingsPlacementForRow } from "../../src/core/settings-areas.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { SETTINGS_LABELS_BY_ID, SettingsCenter } from "../../src/interactive/overlays/settings.js";
import { SETTINGS_SECTION_ROWS } from "../../src/interactive/overlays/settings-center-model.js";
import { buildSettingItems } from "../../src/interactive/overlays/settings-items.js";
import { formatSettingsValue } from "../../src/interactive/overlays/settings-presentation.js";
import { buildSettingsSections } from "../../src/interactive/overlays/settings-sections.js";
import { parseSlashCommand } from "../../src/session-control/slash-commands.js";

function fixture() {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.connections = [{ id: "local", runtime: "openai-compat", defaultModel: "coder" }];
	settings.fleet.profiles.reviewer = { connection: "local", model: "coder", thinkingLevel: "low" };
	settings.fleet.agentProfiles.reviewer = "reviewer";
	return buildSettingItems(settings);
}

test("fleet setup actions provide filter metadata without catalog entries", () => {
	const items = buildSettingItems(structuredClone(DEFAULT_SETTINGS), { onFleetSettingsChanged: () => {} });
	for (const id of ["fleet.nodes.add", "fleet.nodes.discover"] as const) {
		const row = items.find((item) => item.id === id);
		ok(row);
		strictEqual(row.configPath, id);
		ok(row.label.length > 0);
		ok(row.description.length > 0);
	}
});

test("every existing settings control has exactly one home and canonical persisted paths determine it", () => {
	const items = fixture();
	const controls = items.filter((item) => item.presentationKind !== "group-header");
	const sections = buildSettingsSections(items);
	deepStrictEqual(
		sections.map((section) => [section.id, section.label]),
		SETTINGS_AREAS.map((area) => [area.id, area.label]),
	);
	deepStrictEqual(Object.values(SETTINGS_SECTION_ROWS).flat().sort(), Object.keys(SETTINGS_LABELS_BY_ID).sort());
	// Recent & Pinned only repeats rows that live elsewhere, so it is never a home.
	const homeSections = sections.filter((section) => section.id !== "recent");
	for (const row of controls) {
		const homes = homeSections.filter((section) => section.items.some((item) => item.id === row.id));
		strictEqual(homes.length, 1, row.id);
		const placement = settingsPlacementForRow(row.id, row.configPath);
		strictEqual(homes[0]?.id, placement.area, row.id);
		notStrictEqual(placement.group, "Other", `${row.id} fell into Advanced without an explicit home`);
	}
	const byId = new Map(items.map((item) => [item.id, item]));
	for (const [id, home] of [
		["fleet.concurrency", "workers"],
		["fleet.limits.toolCallsPerRun", "workers"],
		["fleet.limits.internalRunTimeoutMs", "advanced"],
		["fleet.history.journal", "workers"],
		["interface.smoothStreaming", "chat"],
		["integrations.git.commitAttribution", "workspace"],
		["integrations.hub.trustProjectImports", "workspace"],
		["fleet.permissions.mode", "safety"],
		["integrations.externalAgents.defaults.toolGovernance", "safety"],
		["safety.review.enabled", "safety"],
		["context.compaction.model", "context"],
		["context.memory.connection", "context"],
		["chat.maxOutputTokens", "models"],
	] as const)
		strictEqual(byId.get(id)?.section, home, id);
});

test("slash links use the same canonical areas configure and the GUI use, and no other word", () => {
	for (const area of SETTINGS_AREAS) {
		strictEqual(resolveSettingsArea(area.id), area.id, area.id);
		deepStrictEqual(parseSlashCommand(`/settings ${area.id}`), { kind: "settings", area: area.id });
	}
	for (const name of [
		"",
		"permanent",
		"models,chat",
		"diagnostics-extra",
		"targets",
		"fleet",
		"interface",
		"integrations",
		"connections",
		"orchestrator",
		"model",
		"thinking",
		"retry",
		"agents",
		"panes",
		"skills",
		"permissions",
		"diagnostics",
		"pinned",
	]) {
		strictEqual(resolveSettingsArea(name), undefined, name);
		if (name) strictEqual(parseSlashCommand(`/settings ${name}`).kind, "usage-error", name);
	}
	deepStrictEqual(parseSlashCommand("/login"), { kind: "settings", area: "models" });
	strictEqual(parseSlashCommand("/settings chat model-picker").kind, "usage-error");
});

test("every area renders within narrow and wide terminals, and headings are skipped during navigation", () => {
	const items = fixture();
	let cancels = 0;
	const center = new SettingsCenter(items, {
		getBodyHeight: () => 22,
		prepareChange: () => null,
		onApply: () => {},
		onCancel: () => {
			cancels += 1;
		},
	});
	for (const section of buildSettingsSections(items)) {
		center.setSelection(section.id, 0);
		const selection = center.getSelection();
		strictEqual(selection.section, section.id);
		ok(section.items.find((item) => item.id === selection.rowId)?.presentationKind !== "group-header");
		for (const width of [32, 40, 72, 112, 160]) {
			const lines = center.render(width);
			strictEqual(lines.length, 22);
			ok(
				lines.every((line) => visibleWidth(line) <= width),
				`${section.id} overflows ${width} columns`,
			);
		}
	}
	center.setSelection("models", 0);
	strictEqual(center.getSelection().section, "models");
	center.setSelection("chat", 0);
	strictEqual(center.getSelection().section, "chat");
	// Settings opens on rows, so one Esc closes it; rows reached from the section list return there.
	center.handleInput("\x1b");
	strictEqual(cancels, 1);
	center.handleInput("\x1b[D");
	center.handleInput("\r");
	center.handleInput("\x1b");
	strictEqual(center.getSelection().depth, "sections");
	strictEqual(cancels, 1);
	center.handleInput("/");
	center.handleInput("interface.smoothStreaming");
	center.handleInput("\r");
	strictEqual(center.getSelection().section, "chat");
	center.handleInput("\r");
	strictEqual(center.getSelection().rowId, "interface.smoothStreaming");
	match(center.render(112).join("\n"), /Smooth streaming/);
});

test("settings groups collect related controls and preserve the target inventory column heading", () => {
	const sections = buildSettingsSections(fixture());
	strictEqual(sections.find((section) => section.id === "models")?.items[1]?.id, "connections");
	const context = sections.find((section) => section.id === "context");
	ok(context);
	let group = "";
	const memberships = new Map<string, string>();
	for (const item of context.items) {
		if (item.presentationKind === "group-header") group = item.label;
		else memberships.set(item.id, group);
	}
	strictEqual(memberships.get("context.compaction.auto"), "Compaction");
	strictEqual(memberships.get("context.compaction.model"), "Compaction");
	strictEqual(memberships.get("context.memory.connection"), "Proactive memory");
	strictEqual(memberships.get("context.memory.enabled"), "Proactive memory");
});

test("Space previews only rows a preview can show, and Means explains the previewed value", () => {
	const items = fixture();
	const center = new SettingsCenter(items, {
		getBodyHeight: () => 40,
		prepareChange: () => null,
		onApply: () => {},
		onCancel: () => {},
	});
	const sections = buildSettingsSections(items);
	const select = (id: string): void => {
		const section = sections.find((entry) => entry.items.some((item) => item.id === id) && entry.id !== "recent");
		ok(section, id);
		center.setSelection(
			section.id,
			section.items.findIndex((item) => item.id === id),
		);
		strictEqual(center.getSelection().rowId, id);
	};
	const screen = (): string => stripVTControlCharacters([...center.render(160), center.railHint(160)].join("\n"));
	const row = items.find((item) => item.id === "fleet.permissions.mode");
	const next = row?.values?.[row.values.indexOf(row.currentValue) + 1];
	const meaning = next === undefined ? undefined : row?.valueHelp?.[next];
	ok(meaning);

	select("fleet.permissions.mode");
	match(screen(), /\[Space\] preview/);
	center.handleInput(" ");
	const previewed = screen()
		.replace(/\s*│\s*/gu, " ")
		.replace(/\s+/gu, " ");
	match(previewed, /preview/);
	ok(previewed.includes(meaning.split(" ").slice(0, 4).join(" ")), "Means follows the previewed value");

	select("interface.mode");
	const before = screen();
	ok(!before.includes("[Space] preview"), "a restart-only row offers no preview");
	center.handleInput(" ");
	strictEqual(screen(), before);
});

test("settings presentation maps connection fallback sentinels to human labels", () => {
	strictEqual(formatSettingsValue("safety.review.connection", "(session connection)"), "Chat connection");
	strictEqual(formatSettingsValue("fleet.default.connection", "(orchestrator connection)"), "Chat model");
});
