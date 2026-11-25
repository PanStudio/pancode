// SPDX-License-Identifier: LicenseRef-PanCode-1.0 AND MIT
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Split from slash-commands.ts, which adapts pi-coding-agent's BUILTIN_SLASH_COMMANDS registry.
import {
	applyInitImplications,
	CONTEXT_INIT_FLAG_TABLE,
	type ContextInitOptions,
	validateInitOptions,
} from "../../domains/context/init-options.js";
import { type BuiltinSlashCommand, USAGE_TAB_NAMES, type UsageTab } from "../slash-command-types.js";
import type { CommandPositionalSpec } from "../slash-spec.js";

/** Both compact spellings keep a free-form optional instruction tail. */
export const COMPACT_POSITIONALS: ReadonlyArray<CommandPositionalSpec> = [
	{ name: "instructions", required: false, rest: true },
];

/**
 * `/context recall <ref>` takes exactly one ref, not a rest tail: a ref is a
 * single turnId, and a second token is a mistake worth reporting rather than
 * text to fold into the first.
 */
const RECALL_POSITIONALS: ReadonlyArray<CommandPositionalSpec> = [{ name: "ref", required: true }];

export const CONTEXT_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "usage",
		rank: 1,
		aliases: [{ name: "cost" }, { name: "status" }],
		acp: false,
		description: "Show quota, credits, session tokens and cost, workers, and health",
		group: "Model and context",
		kinds: ["usage"],
		args: { positionals: [{ name: "tab", required: false, values: [...USAGE_TAB_NAMES] }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "usage", reason: parsed.error };
			const tab = parsed.positionals[0];
			if (tab === undefined) return { kind: "usage" };
			if (!(USAGE_TAB_NAMES as ReadonlyArray<string>).includes(tab))
				return { kind: "usage-error", command: "usage", reason: `Choose ${USAGE_TAB_NAMES.join(", ")}` };
			return { kind: "usage", tab: tab as UsageTab };
		},
		handle(command, ctx) {
			if (command.kind !== "usage") return;
			ctx.openUsage?.(command.tab);
		},
	},
	{
		name: "context",
		rank: 1,
		aliases: [{ name: "init", args: "init" }],
		acp: {
			subcommands: ["compact", "recall", "init", "refresh", "reset", "recover"],
			promptTurnSubcommands: ["recover"],
			// Reset deletes project context files, so a ceiling refuses it.
			sessionOnly: ["compact", "recall"],
		},
		description: "Show the context window, or manage session and project context",
		group: "Model and context",
		kinds: ["context-view", "compact", "context-recover", "context-recall", "init", "context-clear", "context-refresh"],
		subcommandDescriptions: {
			compact: "Shrink the session context to free room",
			recover: "Resume a paused handoff by reducing or delivering it",
			recall: "Bring back a result evicted from context",
			init: "Initialize project context",
			refresh: "Refresh project context",
			reset: "Reset project context",
		},
		args: {
			subcommands: {
				compact: { positionals: [...COMPACT_POSITIONALS] },
				recover: {
					positionals: [
						{ name: "handoffId", required: true },
						{ name: "action", required: true, values: ["reduce", "deliver"] },
					],
				},
				recall: { positionals: [...RECALL_POSITIONALS] },
				init: {
					flags: [
						...CONTEXT_INIT_FLAG_TABLE.flatMap(({ flag, aliases = [] }) => [flag, ...aliases].map((name) => ({ name }))),
						{ name: "--depth", takesValue: true, values: ["quick", "standard", "deep"] },
					],
					positionals: [{ name: "proposal", required: false }],
				},
				refresh: {},
				// The terminal confirms a reset in its own chooser. A host with no chooser
				// takes the confirmation as flags, and refuses a reset that carries none.
				reset: { flags: [{ name: "--yes" }, { name: "--all" }] },
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "context", reason: parsed.error };
			switch (parsed.subcommand) {
				case "compact":
					return { kind: "compact", instructions: parsed.rest };
				case "recover": {
					const [handoffId, action] = parsed.positionals;
					return handoffId && (action === "reduce" || action === "deliver")
						? { kind: "context-recover", handoffId, action }
						: { kind: "usage-error", command: "context", reason: "Use /context recover <handoffId> <reduce|deliver>" };
				}
				case "recall":
					return { kind: "context-recall", ref: parsed.positionals[0] ?? "" };
				case "init": {
					const options: ContextInitOptions = {};
					const depth = parsed.flags.get("--depth");
					if (depth === "quick" || depth === "standard" || depth === "deep") options.depth = depth;
					if (parsed.positionals[0]) options.acceptRef = parsed.positionals[0];
					for (const { flag, aliases = [], field } of CONTEXT_INIT_FLAG_TABLE) {
						if ([flag, ...aliases].some((name) => parsed.flags.has(name))) options[field] = true;
					}
					const reason = validateInitOptions(options);
					return reason
						? { kind: "usage-error", command: "context", reason }
						: { kind: "init", options: applyInitImplications(options) };
				}
				case "refresh":
					return { kind: "context-refresh" };
				case "reset": {
					const confirmed = parsed.flags.has("--yes");
					const all = parsed.flags.has("--all");
					return {
						kind: "context-clear",
						options: {
							...(all ? { all: true } : {}),
							...(confirmed ? { confirmed: true } : {}),
							...(all && confirmed ? { confirmedAll: true } : {}),
						},
					};
				}
				default:
					return { kind: "context-view" };
			}
		},
		handle(command, ctx) {
			switch (command.kind) {
				case "context-view":
					ctx.openContextView?.();
					return;
				case "compact":
					ctx.runCompact(command.instructions);
					return;
				case "context-recover":
					if (ctx.runHandoffRecovery) ctx.runHandoffRecovery(command.handoffId, command.action);
					else ctx.notice("error", "native handoff recovery is unavailable");
					return;
				case "context-recall":
					if (ctx.runContextRecall) {
						ctx.runContextRecall(command.ref);
					} else {
						ctx.notice("error", "context recall is not wired; no session is bound to this process");
					}
					return;
				case "init":
					ctx.runInit(command.options);
					return;
				case "context-clear":
					ctx.runContextClear(command.options);
					return;
				case "context-refresh":
					if (ctx.runContextRefresh) {
						ctx.runContextRefresh();
					} else {
						ctx.notice("error", "context refresh is not wired in this session");
					}
					return;
				default:
					return;
			}
		},
	},
];
