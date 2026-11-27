// SPDX-License-Identifier: LicenseRef-PanCode-1.0 AND MIT
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Split from slash-commands.ts, which adapts pi-coding-agent's BUILTIN_SLASH_COMMANDS registry.
import { mcpCommandOutput } from "../../cli/mcp.js";
import { isHubKind } from "../../domains/resources/hub-types.js";
import { type HubEntryKind, parseSkillCommand, SKILL_SURFACE_CLEAR_ARG } from "../../domains/resources/index.js";
import type {
	BuiltinSlashCommand,
	HubBrowseIntent,
	SlashCommand,
	SlashCommandContext,
} from "../slash-command-types.js";
import { fromArgsOrUsage, usageError } from "./usage-error.js";

/** `/hub <kind>` completes the plurals and also accepts the singular tab ids. */
const HUB_KIND_PLURALS = ["skills", "agents", "prompts", "playbooks", "plugins", "extensions", "servers"] as const;
const HUB_KIND_WORDS = new Map<string, HubEntryKind>(
	HUB_KIND_PLURALS.flatMap((plural) => {
		const kind = plural.slice(0, -1) as HubEntryKind;
		return [
			[plural, kind],
			[kind, kind],
		];
	}),
);

export const HARNESS_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "eggs",
		rank: 3,
		acp: { reads: ["", "status"], sessionOnly: ["off"] },
		description: "Show active conversation eggs or turn them off",
		group: "PanCode",
		hidden: true,
		kinds: ["eggs"],
		args: { subcommands: { status: {}, off: { positionals: [{ name: "id", required: false }] } } },
		fromArgs(parsed) {
			const id = parsed.positionals[0];
			if (
				parsed.error ||
				(parsed.subcommand === undefined && id !== undefined) ||
				(id !== undefined && !/^[a-z][a-z0-9_-]*$/u.test(id))
			)
				return usageError("eggs", parsed.error ?? "Use /eggs [status] or /eggs off [id]");
			return { kind: "eggs", action: parsed.subcommand === "off" ? "off" : "status", ...(id ? { id } : {}) };
		},
		handle(command, ctx) {
			if (command.kind === "eggs") ctx.notice("info", ctx.eggsCommand?.(command.action, command.id) ?? "No active eggs.");
		},
	},
	{
		name: "reload",
		rank: 3,
		acp: false,
		description: "Reload settings, PanHub packs and extension runtimes with one report",
		group: "PanCode",
		kinds: ["reload"],
		args: {
			positionals: [{ name: "target", required: false, values: ["settings", "hub", "extensions", "prompts", "all"] }],
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "reload", reason: parsed.error };
			const target = parsed.positionals[0] ?? "all";
			if (target !== "settings" && target !== "hub" && target !== "extensions" && target !== "prompts" && target !== "all")
				return { kind: "usage-error", command: "reload", reason: "Choose settings, hub, extensions, prompts or all" };
			return { kind: "reload", target };
		},
		handle(command, ctx) {
			if (!ctx.reloadClasses) {
				ctx.notice("warn", "/reload is available only in an interactive terminal.");
				return;
			}
			if (command.kind === "reload") ctx.reloadClasses(command.target);
		},
	},
	{
		name: "restart",
		rank: 3,
		acp: false,
		description: "Save and restart into this session and workspace; text after /restart becomes its next message",
		group: "PanCode",
		kinds: ["restart"],
		args: { positionals: [{ name: "task", required: false, rest: true }] },
		fromArgs(parsed) {
			const continuation = parsed.rest?.trim();
			return continuation ? { kind: "restart", continuation } : { kind: "restart" };
		},
		handle(command, ctx) {
			if (!ctx.restart) {
				ctx.notice("warn", "/restart is available only in an interactive terminal.");
				return;
			}
			ctx.restart(command.kind === "restart" ? command.continuation : undefined);
		},
	},
	{
		name: "trust",
		rank: 3,
		acp: false,
		description: "Review this repository's own configuration and trust it, then restart to apply it",
		group: "PanCode",
		kinds: ["trust"],
		args: {},
		fromArgs: fromArgsOrUsage("trust", { kind: "trust" }),
		handle(_command, ctx) {
			if (!ctx.openProjectTrust) {
				ctx.notice("warn", "/trust is available only in an interactive terminal; use pancode config trust.");
				return;
			}
			ctx.openProjectTrust();
		},
	},
	{
		name: "quit",
		rank: 1,
		aliases: [{ name: "exit" }],
		acp: false,
		description: "Exit PanCode",
		group: "Session",
		kinds: ["quit"],
		args: {},
		fromArgs: fromArgsOrUsage("quit", { kind: "quit" }),
		handle(_command, ctx) {
			ctx.shutdown?.();
		},
	},
	{
		name: "help",
		rank: 1,
		acp: false,
		description: "Open the help center for commands and keys",
		group: "PanCode",
		kinds: ["help"],
		args: {
			positionals: [{ name: "query", required: false, rest: true }],
		},
		fromArgs(parsed) {
			return { kind: "help", ...(parsed.rest ? { query: parsed.rest } : {}) };
		},
		handle(command, ctx) {
			ctx.openHelp?.(command.kind === "help" ? command.query : undefined);
		},
	},
	{
		name: "skill",
		rank: 2,
		acp: { injectsUserTurn: true },
		description: "Invoke a skill, or use `off` to clear active skill tools",
		group: "Work",
		kinds: ["skill-invocation", "skill-surface-clear"],
		args: {
			positionals: [
				{ name: "name", required: true },
				{ name: "task", required: false, rest: true },
			],
		},
		fromArgs(parsed, trimmed) {
			if (trimmed === "/skill") return { kind: "resources", tab: "skill" };
			const command = parseSkillCommand(trimmed);
			if (!command) return usageError("skill", parsed.error);
			// `off` is the one reserved name: an installed skill called `off`
			// would still be reachable from the hub, and clearing the armed
			// surface has to stay typeable without a second command.
			if (command.name === SKILL_SURFACE_CLEAR_ARG && command.args.length === 0) {
				return { kind: "skill-surface-clear" };
			}
			return { kind: "skill-invocation", text: trimmed };
		},
		handle(command, ctx) {
			if (command.kind === "skill-invocation") {
				ctx.submitChat(command.text);
			} else if (command.kind === "skill-surface-clear") {
				const cleared = ctx.clearSkillSurface?.() ?? [];
				if (cleared.length === 0) ctx.notice("info", "No skill tool surface is active.");
				else if (ctx.statesSkillSurface !== true) ctx.notice("info", `Skill tool surface cleared: ${cleared.join(", ")}.`);
			}
		},
	},
	{
		name: "hub",
		rank: 2,
		acp: false,
		description:
			"Browse skills, agents, prompts, playbooks, plugins, extensions and servers, or review an install or removal",
		group: "PanCode",
		kinds: ["resources", "agents"],
		// The same verbs as `pancode hub`; each opens the review that command would apply.
		subcommandDescriptions: {
			inspect: "Open PanHub on one package or component",
			install: "Review installing one package, then apply it",
			update: "Review updating one installed package, then apply it",
			enable: "Review enabling one installed package, then apply it",
			disable: "Review disabling one installed package, then apply it",
			remove: "Review removing one package, then apply it",
			import: "Review a plugin source from a path or URL",
			interop: "Inspect local coding agents and adopt safe resources",
		},
		args: {
			positionals: [{ name: "kind", required: false, values: [...HUB_KIND_PLURALS] }],
			subcommands: {
				inspect: {
					positionals: [{ name: "ref", required: true }],
					flags: [{ name: "--user" }, { name: "--project" }],
				},
				install: {
					positionals: [{ name: "ref", required: true }],
					flags: [{ name: "--user" }, { name: "--project" }],
				},
				update: {
					positionals: [{ name: "ref", required: true }],
					flags: [{ name: "--user" }, { name: "--project" }],
				},
				enable: {
					positionals: [{ name: "ref", required: true }],
					flags: [{ name: "--user" }, { name: "--project" }],
				},
				disable: {
					positionals: [{ name: "ref", required: true }],
					flags: [{ name: "--user" }, { name: "--project" }],
				},
				remove: {
					positionals: [{ name: "ref", required: true }],
					flags: [{ name: "--user" }, { name: "--project" }],
				},
				import: {
					positionals: [{ name: "path-or-url", required: true }],
					flags: [{ name: "--user" }, { name: "--project" }],
				},
				interop: {},
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "hub", reason: parsed.error };
			if (parsed.flags.has("--user") && parsed.flags.has("--project"))
				return { kind: "usage-error", command: "hub", reason: "Choose one destination: --user or --project" };
			const scope = parsed.flags.has("--project")
				? ("project" as const)
				: parsed.flags.has("--user")
					? ("user" as const)
					: undefined;
			const subcommand = parsed.subcommand;
			if (subcommand === "interop") return { kind: "agents", connect: true };
			if (subcommand === "import") {
				const source = parsed.rest ?? parsed.positionals[0];
				if (!source)
					return {
						kind: "usage-error",
						command: "hub",
						reason: "/hub import needs a directory path or a source URL to review",
					};
				return { kind: "resources", tab: "plugin", importSource: source, ...(scope ? { scope } : {}) };
			}
			if (
				subcommand === "inspect" ||
				subcommand === "install" ||
				subcommand === "update" ||
				subcommand === "enable" ||
				subcommand === "disable" ||
				subcommand === "remove"
			) {
				const ref = parsed.positionals[0];
				if (!ref)
					return {
						kind: "usage-error",
						command: "hub",
						reason: `/hub ${subcommand} needs a kind:name reference, such as plugin:hpc, or a component name`,
					};
				const prefix = ref.split(":", 1)[0] ?? "";
				return {
					kind: "resources",
					tab: isHubKind(prefix) && ref.includes(":") ? prefix : "plugin",
					focus: ref,
					...(subcommand === "inspect" ? {} : { intent: subcommand as HubBrowseIntent }),
					...(scope ? { scope } : {}),
				};
			}
			const [word, extra] = parsed.positionals;
			const tab = word === undefined ? "plugin" : HUB_KIND_WORDS.get(word);
			if (!tab || extra !== undefined)
				return {
					kind: "usage-error",
					command: "hub",
					reason:
						"Use /hub [skills|agents|prompts|playbooks|plugins|extensions|servers] to browse, /hub inspect|install|update|enable|disable|remove <ref>, /hub import <path-or-url>, or /hub interop",
				};
			return { kind: "resources", tab };
		},
		handle(command, ctx) {
			if (command.kind === "agents") {
				ctx.openInterop?.();
				return;
			}
			if (command.kind !== "resources") return;
			if (command.family === "extensions") {
				extensionsCommand(command, ctx);
				return;
			}
			ctx.openSkillsHub?.({
				...(command.tab ? { tab: command.tab } : {}),
				...(command.focus ? { focus: command.focus } : {}),
				...(command.intent ? { intent: command.intent } : {}),
				...(command.importSource ? { importSource: command.importSource } : {}),
				...(command.scope ? { scope: command.scope } : {}),
			});
		},
	},
	{
		name: "mcp",
		rank: 3,
		acp: { reads: ["", "list"] },
		description: "List MCP servers, trust or untrust one by id, or log one out",
		group: "PanCode",
		kinds: ["mcp"],
		args: {
			subcommands: {
				list: {},
				trust: {
					positionals: [
						{ name: "id", required: true },
						{ name: "class", required: false },
					],
				},
				untrust: { positionals: [{ name: "id", required: true }] },
				logout: { positionals: [{ name: "id", required: true }] },
			},
		},
		subcommandDescriptions: {
			list: "List MCP servers (the bare command does the same)",
			trust: "Trust a server, optionally for one action class",
			untrust: "Withdraw trust from a server",
			logout: "Remove the header credentials a remote server is sent",
		},
		fromArgs(parsed) {
			if (parsed.error) return usageError("mcp", parsed.error, parsed.subcommand);
			if (parsed.subcommand === undefined && parsed.positionals.length > 0)
				return usageError("mcp", `Unexpected argument: ${parsed.positionals[0]}`);
			const action = parsed.subcommand ?? "list";
			const [id, actionClass] = parsed.positionals;
			return { kind: "mcp", argv: [action, ...(id ? [id] : []), ...(actionClass ? ["--action-class", actionClass] : [])] };
		},
		handle(command, ctx) {
			if (command.kind !== "mcp") return;
			const result = mcpCommandOutput(
				command.argv,
				undefined,
				undefined,
				command.argv[0] === "list" ? ctx.mcpStatuses?.() : undefined,
			);
			ctx.notice(result.code ? "error" : "info", result.text);
		},
	},
	{
		name: "doctor",
		rank: 3,
		acp: { reads: [""] },
		description: "Check this install; `--deep` adds live tool probes and a contract dry run",
		group: "PanCode",
		kinds: ["doctor"],
		args: { flags: [{ name: "--deep" }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "doctor", reason: parsed.error };
			return { kind: "doctor", deep: parsed.flags.has("--deep") };
		},
		handle(command, ctx) {
			if (command.kind !== "doctor") return;
			const runDoctor = ctx.runDoctor;
			if (!runDoctor) {
				ctx.notice("error", "doctor is not wired in this session; run pancode doctor from a shell");
				return;
			}
			ctx.notice(
				"info",
				command.deep
					? "doctor: running deep checks; the tool probe can load a cold local model and releases only that one"
					: "doctor: running checks",
			);
			void (async () => {
				try {
					const report = await runDoctor({ deep: command.deep });
					if (ctx.showDoctor && report.findings) ctx.showDoctor(report.findings);
					else ctx.notice(report.level, report.text);
				} catch (error) {
					ctx.notice("error", `doctor failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				ctx.render?.();
			})();
		},
	},
	{
		name: "upgrade",
		rank: 3,
		acp: false,
		description: "Review and approve a PanCode update, then restart when it succeeds",
		group: "PanCode",
		kinds: ["upgrade"],
		args: {},
		fromArgs: fromArgsOrUsage("upgrade", { kind: "upgrade" }),
		handle(_command, ctx) {
			if (!ctx.startUpgrade) {
				ctx.notice("error", "in-session upgrade is unavailable; run pancode upgrade from a shell");
				return "rejected";
			}
			ctx.startUpgrade();
		},
	},
	{
		name: "extensions",
		rank: 3,
		acp: false,
		description:
			"Inspect extensions, manage dev and muted ones for this session, leave a workspace or read a cut card whole",
		group: "PanCode",
		// Harness navigation uses the shared overlay dispatcher, independently of component reload.
		kinds: [],
		args: {
			subcommands: {
				dev: { positionals: [{ name: "target", required: false, rest: true }] },
				mute: { positionals: [{ name: "target", required: false, rest: true }] },
				unmute: { positionals: [{ name: "target", required: false, rest: true }] },
				leave: {},
				card: { positionals: [{ name: "number", required: false }] },
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "extensions", reason: parsed.error };
			const action = parsed.subcommand;
			const target = (parsed.rest ?? parsed.positionals[0])?.trim();
			if (action === undefined) {
				if (parsed.positionals.length > 0)
					return {
						kind: "usage-error",
						command: "extensions",
						reason: "extensions accepts dev, mute, unmute, leave or card",
					};
				return { kind: "resources", family: "extensions" };
			}
			if (action !== "dev" && action !== "mute" && action !== "unmute" && action !== "leave" && action !== "card")
				return {
					kind: "usage-error",
					command: "extensions",
					reason: "extensions accepts dev, mute, unmute, leave or card",
				};
			if (action === "leave" && (target || parsed.positionals.length > 0))
				return { kind: "usage-error", command: "extensions", reason: "extensions leave takes no argument" };
			if (action === "card" && target !== undefined && !/^[1-9]\d*$/u.test(target))
				return { kind: "usage-error", command: "extensions", reason: "extensions card takes a card number" };
			return { kind: "resources", family: "extensions", action, ...(target ? { target } : {}) };
		},
		handle(command, ctx) {
			if (command.kind === "resources" && command.family === "extensions") extensionsCommand(command, ctx);
		},
	},
	{
		name: "archive",
		rank: 3,
		acp: {},
		description: "Export or import a full PanCode archive",
		group: "Session",
		hidden: true,
		kinds: ["archive-export", "archive-import"],
		subcommandDescriptions: { export: "Export a full PanCode archive", import: "Import a full PanCode archive" },
		args: {
			subcommands: {
				export: {
					positionals: [{ name: "path", required: true }],
				},
				import: {
					flags: [{ name: "--dry-run" }, { name: "--force" }],
					positionals: [{ name: "path", required: true }],
				},
			},
		},
		fromArgs(parsed) {
			const subcommand = parsed.subcommand === "export" || parsed.subcommand === "import" ? parsed.subcommand : undefined;
			if (parsed.error) {
				return usageError("archive", parsed.error, subcommand);
			}
			const path = parsed.positionals[0];
			if (subcommand === "export" && path !== undefined) return { kind: "archive-export", path };
			if (subcommand === "import" && path !== undefined) {
				return {
					kind: "archive-import",
					path,
					dryRun: parsed.flags.has("--dry-run"),
					force: parsed.flags.has("--force"),
				};
			}
			return usageError("archive", subcommand === undefined ? "Choose export or import" : undefined, subcommand);
		},
		handle(command, ctx) {
			if (command.kind === "archive-export") {
				if (!ctx.exportShareArchive) {
					ctx.notice("error", "archive export is not wired");
					return;
				}
				const result = ctx.exportShareArchive(command.path);
				ctx.notice("success", `exported ${result.fileCount} item(s) to ${result.path}`);
				return;
			}
			if (command.kind === "archive-import") {
				if (!ctx.importShareArchive) {
					ctx.notice("error", "archive import is not wired");
					return;
				}
				const plan = ctx.importShareArchive(command.path, { dryRun: command.dryRun, force: command.force });
				for (const diag of plan.diagnostics) {
					const detail = diag.path ? `${diag.message}: ${diag.path}` : diag.message;
					ctx.notice("warn", `${diag.type}: ${detail}`);
				}
				const write = plan.actions.filter((action) => action.action === "write").length;
				const overwrite = plan.actions.filter((action) => action.action === "overwrite").length;
				const skip = plan.actions.filter((action) => action.action === "skip").length;
				ctx.notice(
					command.dryRun ? "info" : "success",
					`${command.dryRun ? "dry-run" : "import"} write=${write} overwrite=${overwrite} skip=${skip} settings=${plan.actions.filter((action) => action.action === "settings").length}`,
				);
			}
		},
	},
];

function extensionsCommand(command: Extract<SlashCommand, { kind: "resources" }>, ctx: SlashCommandContext): void {
	if (command.action === "leave") {
		if (!ctx.operatorExtensions?.leaveWorkspace()) ctx.notice("info", "No extension workspace is active");
		ctx.render?.();
	} else if (command.action === "card") {
		// WTF-P F07/F13: a transcript card cut to its row cap names this command, which opens it whole.
		const card = command.target === undefined ? undefined : Number(command.target);
		const shown = ctx.showExtensionCard?.(card);
		if (shown === undefined) ctx.notice("warn", "extensions: cards open whole in the terminal only");
		else if (shown === "busy") ctx.notice("info", "Close the open panel first; the card opens over the composer.");
		else if (shown === "missing")
			ctx.notice(
				"info",
				card === undefined
					? "No extension card was cut this session"
					: `Extension card ${card} is not among the recent cards`,
			);
	} else if (command.action !== undefined) {
		if (ctx.extensionDev) ctx.extensionDev(command.action, command.target);
		else ctx.notice("warn", "extensions: dev and mute are available in the terminal only");
	} else ctx.openExtensions?.();
}
