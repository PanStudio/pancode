// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { createSlashCommandAutocompleteProvider } from "../../src/interactive/slash-autocomplete.js";
import type { SlashCommandContext } from "../../src/session-control/slash-command-types.js";
import { parseSlashCommand } from "../../src/session-control/slash-commands.js";
import { dispatchSlashCommand } from "../../src/session-control/slash-dispatch.js";
import { commandReference } from "../../src/session-control/slash-reference.js";

it("canonical category commands open the shared PanHub without submitting a turn", () => {
	const opened: unknown[] = [];
	const ctx = {
		openSkillsHub: (tab: unknown) => opened.push(tab),
		submitChat: () => {
			throw new Error("browser submitted a model turn");
		},
	} as unknown as SlashCommandContext;
	for (const [command, tab] of [
		["hub", "plugin"],
		["hub skills", "skill"],
		["hub agent", "agent"],
		["hub prompts", "prompt"],
		["skill", "skill"],
	]) {
		deepStrictEqual(parseSlashCommand(`/${command}`), { kind: "resources", tab });
		strictEqual(dispatchSlashCommand(parseSlashCommand(`/${command}`), ctx), "accepted");
	}
	deepStrictEqual(
		opened,
		["plugin", "skill", "agent", "prompt", "skill"].map((tab) => ({ tab })),
	);
});

it("retired browser spellings refuse before prompt expansion or model submission", () => {
	const notices: string[] = [];
	const ctx = {
		notice: (_level: string, message: string) => notices.push(message),
		render: () => {},
		expandPromptTemplate: () => {
			throw new Error("retired command reached prompt expansion");
		},
		submitChat: () => {
			throw new Error("retired command reached model submission");
		},
	} as unknown as SlashCommandContext;
	for (const input of ["/hub extensions reload", "/hub fleet", "/hub fleets"]) {
		strictEqual(parseSlashCommand(input).kind, "usage-error", input);
		strictEqual(dispatchSlashCommand(parseSlashCommand(input), ctx), "rejected", input);
	}
	deepStrictEqual(parseSlashCommand("/skill off"), { kind: "skill-surface-clear" });
	deepStrictEqual(parseSlashCommand("/skill review src"), { kind: "skill-invocation", text: "/skill review src" });
});

it("help and completions expose only the canonical browsing routes", async () => {
	const names = commandReference().map((entry) => entry.name);
	for (const name of ["hub", "extensions"]) strictEqual(names.includes(name), true);
	for (const name of ["plugins", "resources", "skills", "agents", "prompts", "interop", "workspace"])
		strictEqual(names.includes(name), false);
	const provider = createSlashCommandAutocompleteProvider({ fdPath: null });
	for (const line of ["/agents ", "/hub extensions ", "/skills install "]) {
		const result = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
		strictEqual(result, null, line);
	}
});

it("routes typed package operations to their category and preserves an explicit scope", () => {
	for (const tab of ["skill", "agent", "prompt", "playbook", "plugin"]) {
		for (const operation of ["inspect", "install", "remove"]) {
			const request = {
				tab,
				focus: `${tab}:fixture`,
				...(operation === "inspect" ? {} : { intent: operation }),
				scope: "project",
			};
			const command = parseSlashCommand(`/hub ${operation} ${tab}:fixture --project`);
			deepStrictEqual(command, { kind: "resources", ...request });
			const opened: unknown[] = [];
			const context = { openSkillsHub: (value: unknown) => opened.push(value) } as unknown as SlashCommandContext;
			strictEqual(dispatchSlashCommand(command, context), "accepted");
			deepStrictEqual(opened, [request]);
		}
	}
});

it("preserves a quoted import source and scope, and refuses malformed or conflicting requests", () => {
	deepStrictEqual(parseSlashCommand('/hub import "/tmp/lab plugin" --project'), {
		kind: "resources",
		tab: "plugin",
		importSource: "/tmp/lab plugin",
		scope: "project",
	});
	deepStrictEqual(parseSlashCommand("/hub import https://github.com/vendor/recipes/tree/main/plugin --user"), {
		kind: "resources",
		tab: "plugin",
		importSource: "https://github.com/vendor/recipes/tree/main/plugin",
		scope: "user",
	});
	for (const input of [
		"/hub install",
		"/hub remove",
		"/hub inspect",
		"/hub import",
		"/hub install skill:tdd --unknown",
		"/hub inspect skill:tdd extra",
		"/hub remove plugin:demo-pack --user --project",
		"/hub import /tmp/recipe --user --project",
	])
		strictEqual(parseSlashCommand(input).kind, "usage-error", input);
});
