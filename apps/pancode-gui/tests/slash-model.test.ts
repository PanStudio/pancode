// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { slashNotice } from "../client/chat/composer-model.js";
import {
	aliasEntries,
	argumentHint,
	exactEntry,
	extensionEntries,
	filterSlashEntries,
	parseSlashLine,
	promptEntries,
	resolveAlias,
	SLASH_ALIASES,
	type SlashFacts,
	slashEntries,
} from "../client/chat/slash-model.js";
import { descriptionParts, visualActions } from "../client/chat/visual-actions-model.js";

const command = (name: string, extra: Record<string, unknown> = {}) =>
	({ name, summary: `${name} summary`, usage: `/${name}`, group: "Work", args: {}, ...extra }) as never;

const catalog = {
	version: 1 as const,
	commands: [
		command("context", {
			requiresSubcommand: true,
			args: {
				subcommands: {
					compact: { positionals: [{ name: "instructions", required: false, rest: true }] },
					init: {},
				},
			},
		}),
		command("doctor"),
		command("status"),
	],
	prompts: [{ name: "review-pr", description: "Review a pull request" }],
};

const facts = (over: Partial<SlashFacts> = {}): SlashFacts => ({
	capabilities: { commands: true, telemetry: true, branches: { fork: true } } as never,
	catalog,
	paneAvailable: true,
	...over,
});

test("a terminal name resolves to the app's control for it, and the catalog's own names stay the catalog's", () => {
	const compact = resolveAlias("/compact keep the API notes", facts());
	assert.deepEqual(compact?.alias.target, {
		kind: "command",
		command: "context",
		subcommand: "compact",
		passRest: true,
	});
	assert.equal(compact?.rest, "keep the API notes");
	assert.deepEqual(resolveAlias("/model", facts())?.alias.target, { kind: "control", control: "model" });
	assert.deepEqual(resolveAlias("/rename  Release notes ", facts()), {
		alias: {
			name: "rename",
			summary: "Rename this task",
			target: { kind: "control", control: "rename" },
			needsText: true,
		},
		rest: "Release notes",
	});
	assert.equal(resolveAlias("/nope", facts()), null);
	assert.equal(resolveAlias("/status", facts()), null, "a name the catalog has is the catalog's");
	assert.equal(resolveAlias("/review-pr 42", facts()), null, "a prompt template is the agent's");
	assert.equal(resolveAlias("plain /model", facts()), null);
	const dev = resolveAlias("/extensions dev", facts());
	assert.equal(dev?.alias.name, "extensions dev");
	assert.equal(dev?.alias.target.kind, "notice");
});

test("a name this task cannot serve says so instead of reaching the agent", () => {
	const notice = (text: string, over: Partial<SlashFacts>) => {
		const target = resolveAlias(text, facts(over))?.alias.target;
		return target?.kind === "notice" ? target.message : null;
	};
	const noContext = { version: 1 as const, commands: [command("doctor")], prompts: [] };
	assert.equal(notice("/compact", { catalog: noContext }), "/compact is not available in this task.");
	assert.equal(notice("/init", { catalog: undefined }), "/init is not available in this task.");
	assert.equal(notice("/tree", { capabilities: { commands: true } as never }), "/tree is not available in this task.");
	assert.equal(notice("/usage", { paneAvailable: false }), "/usage is not available in this task.");
	assert.equal(notice("/quit", {}), "Close this task from the task menu, or close the window. PanCode keeps running.");
	assert.equal(notice("/music", {}), "/music is a terminal command and has no equivalent in PanCode on the desktop.");
});

test("the slash list offers what this task can serve under Also works, after everything it lists itself", () => {
	const listed = slashEntries(facts());
	const also = aliasEntries(facts(), listed);
	const names = also.map((entry) => entry.name);
	assert.ok(also.every((entry) => entry.group === "Also works"));
	for (const name of ["compact", "init", "model", "new", "help", "rename", "cost"])
		assert.ok(names.includes(name), name);
	assert.ok(!names.includes("status"), "the catalog's status is listed as the catalog's");
	assert.ok(!names.includes("quit") && !names.includes("music"), "a notice is not something to pick");
	assert.ok(!names.some((name) => listed.some((entry) => entry.name === name)), "no name is listed twice");
	const bare = aliasEntries(facts({ capabilities: { commands: true } as never, paneAvailable: false }), []).map(
		(entry) => entry.name,
	);
	assert.ok(!bare.includes("tree") && !bare.includes("usage"), "a capability the task lacks hides its names");
	assert.deepEqual(aliasEntries(facts({ capabilities: undefined }), []), []);
});

test("every terminal command a browser can serve lands on a control, and the rest say why", () => {
	const full = facts({
		capabilities: {
			commands: true,
			telemetry: true,
			branches: { fork: true },
			aside: { ask: true, draft: true },
			extensions: true,
			fleet: true,
			board: true,
			context: true,
		} as never,
		catalog: {
			...catalog,
			commands: [
				...catalog.commands,
				command("fleet", { requiresSubcommand: true, args: { subcommands: { share: {} } } }),
				command("memory", { requiresSubcommand: true, args: { subcommands: { seed: {} } } }),
			],
		},
	});
	const target = (text: string) => resolveAlias(text, full)?.alias.target;
	// The terminal's own names (src/session-control/slash-commands.ts) that are not catalog commands here.
	assert.deepEqual(target("/btw what does the retry loop do"), { kind: "action", action: "btw" });
	assert.equal(resolveAlias("/btw what does the retry loop do", full)?.rest, "what does the retry loop do");
	assert.deepEqual(target("/draft split the parser"), { kind: "action", action: "draft" });
	assert.deepEqual(target("/reload"), { kind: "action", action: "extensions" });
	assert.deepEqual(target("/view"), { kind: "pane", view: "artifacts" });
	assert.deepEqual(target("/files"), { kind: "control", control: "mention" });
	assert.deepEqual(target("/trust"), { kind: "pane", view: "session" });
	// A bare hub the catalog refuses opens what the terminal opens; its verbs stay the catalog's.
	const entries = slashEntries(full);
	const pane = (text: string) => {
		const entry = exactEntry(entries, text);
		return entry?.kind === "pane" ? entry.view : null;
	};
	assert.equal(pane("/fleet"), "agents");
	assert.deepEqual(pane("/memory"), { view: "board", section: "memory" });
	assert.equal(exactEntry(entries, "/memory seed note"), null);
	// Without the capability, the name says so rather than reaching the agent as a prompt.
	const bare = facts({ capabilities: { commands: true } as never, paneAvailable: false });
	for (const name of ["btw", "draft", "reload", "view", "trust"])
		assert.equal(resolveAlias(`/${name}`, bare)?.alias.target.kind, "notice", name);
	// Every terminal-only name is a notice, never a prompt.
	for (const name of ["restart", "upgrade", "panes", "music"])
		assert.equal(resolveAlias(`/${name}`, full)?.alias.target.kind, "notice", name);
	assert.ok(!SLASH_ALIASES.some((spec) => spec.names.includes("files") && spec.target.kind === "notice"));
});

test("the palette lists the agent's prompt templates last and finds rows by the terminal's ladder", () => {
	// Live (gui-r3 #1): `/wtfp` listed nothing though the session announced 37 wtfp:* templates.
	const prompt = (name: string, description: string, hint?: string) => ({
		name,
		description,
		...(hint ? { input: { hint } } : {}),
	});
	const withPack = {
		...catalog,
		prompts: [
			prompt("wtfp:map", "Map the paper", "[arguments]"),
			prompt("wtfp:help", "Show the WTF-P guide"),
			prompt("doctor", "Shadowed by the command"),
			prompt("review-pr", "Review a pull request", "<pr>"),
		],
	};
	const listed = slashEntries(facts({ catalog: withPack }));
	const typed = [...listed, ...promptEntries(facts({ catalog: withPack }), listed)];
	const names = (query: string) => filterSlashEntries(typed, query).map((entry) => entry.name);
	assert.deepEqual(names("wtfp"), ["wtfp:help", "wtfp:map"]);
	assert.deepEqual(
		promptEntries(facts({ catalog: withPack }), listed).map((entry) => entry.name),
		["review-pr", "wtfp:help", "wtfp:map"],
		"a template named like a command is the command's",
	);
	// Live (gui-fix4): every row said "Prompt template"; it says what the terminal's palette says.
	assert.deepEqual(
		promptEntries(facts({ catalog: withPack }), listed).map(({ name, summary, hint }) => [name, summary, hint]),
		[
			["review-pr", "Review a pull request", "<pr>"],
			["wtfp:help", "Show the WTF-P guide", ""],
			["wtfp:map", "Map the paper", "[arguments]"],
		],
	);
	assert.equal(filterSlashEntries(typed, "wtfp:map ").length, 0, "a template name and a space is its arguments");
	// Live (gui-fix5): `/wtf ` still listed wtfp:* while the composer judged `/wtf` a finished, unknown name.
	assert.deepEqual(names("wtf "), [], "a name and a space is finished, as the composer judges it");
	assert.equal(exactEntry(typed, "/wtfp:map"), null, "a typed template goes to the agent");
	assert.equal(names("ctx")[0], "context compact", "letters in order find a name");
	assert.deepEqual(names("comp").slice(0, 1), ["context compact"], "a later word of the name ranks before letters");
	assert.equal(
		argumentHint({
			flags: [{ name: "--target", takesValue: true, valueName: "target" }],
			positionals: [{ name: "task", required: true, rest: true }],
		} as never),
		"[--target <target>] <task>",
	);
});

test("a template row carries the terminal's marks and runs bare without an argument hint", () => {
	// Live (gui-fix5): picking /wtfp:contribute waited for arguments it does not take, and an unavailable or
	// reference template read like any other row.
	const withMarks = {
		...catalog,
		prompts: [
			{ name: "wtfp:contribute", description: "Contribute upstream" },
			{ name: "wtfp:map", description: "Map the paper", input: { hint: "[arguments]" } },
			{ name: "wtfp:card", description: "Keys", _meta: { "pancode/prompt": { displayOnly: true as const } } },
			{
				name: "wtfp:gone",
				description: "Prompt template (unavailable)",
				_meta: { "pancode/prompt": { unavailable: "package wtfp is not installed" } },
			},
		],
	};
	const listed = slashEntries(facts({ catalog: withMarks }));
	assert.deepEqual(
		promptEntries(facts({ catalog: withMarks }), listed).map((entry) =>
			entry.kind === "prompt" ? [entry.name, entry.summary, entry.runsBare, entry.unavailable] : null,
		),
		[
			["wtfp:card", "reference · Keys", true, null],
			["wtfp:contribute", "Contribute upstream", true, null],
			["wtfp:gone", "unavailable: package wtfp is not installed", true, "package wtfp is not installed"],
			["wtfp:map", "Map the paper", false, null],
		],
	);
});

test("the palette lists the loaded extensions' commands after the templates, a takeover in its template's place", () => {
	// Live (gui-r4 #2): `/ext:wtfp:*` was missing from the palette, and typing one was refused as not available.
	const withDesk = {
		...catalog,
		prompts: [
			{ name: "wtfp:progress", description: "Template the takeover replaces" },
			{ name: "wtfp:map", description: "Map the paper" },
		],
		extensionCommands: [
			{ name: "ext:wtfp:desk", description: "Enter the WTF-P writing desk." },
			{ name: "wtfp:progress", description: "Paper progress, computed locally." },
		],
	};
	const listed = slashEntries(facts({ catalog: withDesk }));
	const typed = [
		...listed,
		...promptEntries(facts({ catalog: withDesk }), listed),
		...extensionEntries(facts({ catalog: withDesk }), listed),
	];
	const rows = (query: string) => filterSlashEntries(typed, query).map((entry) => [entry.name, entry.group]);
	assert.deepEqual(rows("wtfp"), [
		["wtfp:map", "Prompt templates"],
		["wtfp:progress", "Extension commands"],
	]);
	assert.deepEqual(rows("ext:"), [["ext:wtfp:desk", "Extension commands"]]);
	assert.equal(exactEntry(typed, "/ext:wtfp:desk"), null, "a typed extension command goes to the agent");
	assert.equal(slashNotice("/ext:wtfp:desk", withDesk, "submit"), null);
	assert.equal(resolveAlias("/ext:wtfp:desk", facts({ catalog: withDesk })), null);
});

test("commands the app serves elsewhere are not listed, and still run when typed", () => {
	const withHostWriters = {
		...catalog,
		commands: [
			...catalog.commands,
			command("export"),
			command("archive"),
			command("eggs"),
			command("report", { requiresSubcommand: true, args: { subcommands: { bug: {}, status: {} } } }),
		],
	};
	const listed = slashEntries(facts({ catalog: withHostWriters })).map((entry) => entry.name);
	for (const name of ["export", "eggs", "report bug", "report status"])
		assert.ok(!listed.includes(name), `${name} is listed`);
	assert.ok(listed.includes("doctor"));
	assert.ok(listed.includes("archive"), "no other control exports or imports a session");
	assert.ok(listed.includes("report"), "the Report a problem dialog keeps the name");
	assert.equal(parseSlashLine("/export", withHostWriters)?.kind, "command");
	assert.equal(parseSlashLine("/report status", withHostWriters)?.kind, "command");
});

test("the Task actions menu opens forms only for commands the harness admits over ACP", async () => {
	const { readdir, readFile } = await import("node:fs/promises");
	const { MENU_FORMS, UNLISTED_COMMANDS } = await import("../client/chat/slash-actions.js");
	const handlers = new URL("../../../src/session-control/slash-handlers/", import.meta.url);
	const registry = [new URL("../../../src/session-control/slash-commands.ts", import.meta.url)];
	for (const name of (await readdir(handlers)).filter((file) => file.endsWith(".ts")).sort())
		registry.push(new URL(name, handlers));
	const source = (await Promise.all(registry.map((file) => readFile(file, "utf8")))).join("\n");
	for (const form of MENU_FORMS) {
		const at = source.indexOf(`\t\tname: "${form.name}",`);
		assert.ok(at >= 0, `${form.name} is not a harness command`);
		const admission = /\n\t\tacp: ([^\n]+)/u.exec(source.slice(at))?.[1];
		assert.ok(admission !== undefined && !admission.startsWith("false"), `${form.name} is refused over ACP`);
		assert.ok(!UNLISTED_COMMANDS.has(form.name));
	}
});

test("every engine command in the Actions menu reads as a written title, and reset names what it resets", () => {
	// Live: the menu listed "Mcp", "Oracle", "Poll", and titled /context reset, which can delete PanCode.md,
	// "Reset conversation memory".
	const engine = {
		version: 1 as const,
		commands: [
			command("context", {
				requiresSubcommand: true,
				args: { subcommands: { reset: {}, recover: {}, compact: {} } },
			}),
			command("mcp", { args: { subcommands: { list: {}, trust: {} } } }),
			command("oracle"),
			command("poll"),
			command("run"),
			command("loop"),
		],
		prompts: [],
	};
	const titles = new Map(
		visualActions(slashEntries(facts({ catalog: engine })), "").map((a) => [a.entry.name, a.title]),
	);
	assert.equal(titles.get("context reset"), "Reset project context");
	assert.equal(titles.get("context recover"), "Resume a paused handoff");
	assert.equal(titles.get("mcp"), "MCP servers");
	assert.equal(titles.get("mcp trust"), "Trust an MCP server");
	assert.equal(titles.get("oracle"), "Ask an advisor");
	assert.equal(titles.get("run"), "Run an agent");
	for (const bare of ["Mcp", "Mcp list", "Mcp trust", "Oracle", "Poll", "Run", "Loop"])
		assert.equal([...titles.values()].includes(bare), false, bare);
});

test("an action's description shows its backtick spans as code", () => {
	assert.deepEqual(descriptionParts("Invoke a skill, or use `off` to clear active skill tools"), [
		{ code: false, text: "Invoke a skill, or use " },
		{ code: true, text: "off" },
		{ code: false, text: " to clear active skill tools" },
	]);
	assert.deepEqual(descriptionParts("an odd ` mark"), [{ code: false, text: "an odd ` mark" }]);
});

test("the Actions list is one column on a phone", () => {
	// Live at 400 px: two columns left each title three words wide and every description five lines tall.
	const css = readFileSync(new URL("../client/chat/visual-actions.css", import.meta.url), "utf8");
	assert.match(
		css,
		/@media \(max-width: 560px\) \{\s*\.visual-actions__rows \{\s*grid-template-columns: minmax\(0, 1fr\);/,
	);
});
