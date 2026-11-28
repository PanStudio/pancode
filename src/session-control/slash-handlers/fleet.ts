// SPDX-License-Identifier: LicenseRef-PanCode-1.0 AND MIT
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Split from slash-commands.ts, which adapts pi-coding-agent's BUILTIN_SLASH_COMMANDS registry.
import { bindPlaybookTask } from "../../domains/agents/playbook-task.js";
import { acceptanceFromTaskFlags } from "../../domains/dispatch/task-acceptance.js";
import { formatUserTaskHandoff } from "../../domains/user-tasks/handoff.js";
import type { BuiltinSlashCommand } from "../slash-command-types.js";
import { shareWorkerRun } from "./run.js";
import { usageError } from "./usage-error.js";

export const FLEET_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "fleet",
		rank: 2,
		// Only `share` crosses ACP; bare /fleet and /fleet run stay TUI-only.
		acp: { subcommands: ["share"], injectsUserTurn: true },
		description: "Show live fleet runs, share a worker result, or preview and run a playbook",
		group: "Work",
		kinds: ["fleet", "fleet-run", "share"],
		subcommandDescriptions: {
			run: "Preview and run a repo-owned playbook",
			share: "Share a finished worker result with the main agent",
		},
		args: {
			subcommands: {
				share: { positionals: [{ name: "run-id", required: false }] },
				run: {
					flags: [
						{ name: "--var", takesValue: true, repeatable: true, valueName: "key=value" },
						{ name: "--resume", takesValue: true, valueName: "runId" },
					],
					// Words after the playbook name are its task, as `pancode fleet run <name> "<task>"` takes one.
					positionals: [
						{ name: "playbook", required: true },
						{ name: "task", required: false, rest: true },
					],
					parseFlagsInRest: true,
				},
			},
		},
		fromArgs(parsed) {
			if (parsed.subcommand === "share") {
				if (parsed.error) return { kind: "usage-error", command: "fleet", reason: parsed.error };
				return { kind: "share", ...(parsed.positionals[0] ? { runId: parsed.positionals[0] } : {}) };
			}
			if (parsed.subcommand !== "run") {
				return parsed.error ? { kind: "usage-error", command: "fleet", reason: parsed.error } : { kind: "fleet" };
			}
			if (parsed.error) return usageError("fleet", parsed.error, "run");
			const name = parsed.positionals[0] ?? "";
			if (name.length === 0) return usageError("fleet", "Missing required argument: playbook", "run");
			const vars: Record<string, string> = {};
			for (const pair of parsed.flagValues.get("--var") ?? []) {
				const eq = pair.indexOf("=");
				const key = eq < 0 ? "" : pair.slice(0, eq).trim();
				if (key.length === 0) return usageError("fleet", "--var requires key=value", "run");
				vars[key] = pair.slice(eq + 1);
			}
			const task = parsed.positionals[1];
			const bound = bindPlaybookTask(vars, task);
			if ("error" in bound) return usageError("fleet", bound.error, "run");
			const resume = parsed.flagValues.get("--resume")?.[0];
			if (resume !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(resume)) {
				return usageError("fleet", "--resume requires a fleet run id", "run");
			}
			return {
				kind: "fleet-run",
				name,
				vars: bound.vars,
				...(task !== undefined ? { task } : {}),
				...(resume !== undefined ? { resume } : {}),
			};
		},
		handle(command, ctx) {
			if (command.kind === "share") {
				shareWorkerRun(command.runId, ctx);
				return;
			}
			if (command.kind === "fleet") {
				if (ctx.openFleetRuns) ctx.openFleetRuns();
				else ctx.notice("error", "Fleet Runs is not wired in this session");
				return;
			}
			if (command.kind !== "fleet-run") return;
			if (!ctx.startFleetRun) {
				ctx.notice("error", "/fleet run is not wired in this session");
				return;
			}
			ctx.startFleetRun(command.name, command.vars, {
				...(command.resume !== undefined ? { resume: command.resume } : {}),
				...(command.task !== undefined ? { task: command.task } : {}),
			});
		},
	},
	{
		name: "decisions",
		rank: 3,
		acp: false,
		description: "Show settled interview decisions and operator revisions",
		group: "Work",
		kinds: ["decisions"],
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "decisions", reason: parsed.error };
			return { kind: "decisions" };
		},
		handle(_command, ctx) {
			ctx.openDecisions?.();
		},
	},
	{
		name: "tasks",
		rank: 1,
		acp: {
			subcommands: ["add", "hand", "done", "remove"],
			injectsUserTurn: true,
			readOnlyRefuses: ["add", "hand", "done", "remove"],
		},
		description: "Show the session task board, or manage project tasks",
		group: "Work",
		kinds: ["tasks", "tasks-add", "tasks-hand", "tasks-done", "tasks-remove"],
		subcommandDescriptions: {
			add: "Log a project task without notifying the agent",
			hand: "Hand an operator task to the agent",
			done: "Mark an operator task done",
			remove: "Remove an operator task",
		},
		args: {
			subcommands: {
				add: {
					parseFlagsInRest: true,
					flags: [
						{ name: "--expect", takesValue: true, repeatable: true, valueName: "path" },
						{ name: "--verify", takesValue: true, repeatable: true, valueName: "checkId[:<duration>]" },
					],
					positionals: [{ name: "text", required: true, rest: true }],
				},
				hand: { positionals: [{ name: "id", required: true }] },
				done: { positionals: [{ name: "id", required: true }] },
				remove: { positionals: [{ name: "id", required: true }] },
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "tasks", reason: parsed.error };
			switch (parsed.subcommand) {
				case "add":
					return parsed.rest
						? {
								kind: "tasks-add",
								text: parsed.rest,
								...(parsed.flagValues.has("--expect") ? { expectedOutputs: parsed.flagValues.get("--expect") ?? [] } : {}),
								...(parsed.flagValues.has("--verify") ? { verification: parsed.flagValues.get("--verify") ?? [] } : {}),
							}
						: { kind: "usage-error", command: "tasks", reason: "add requires task text" };
				case "hand":
				case "done":
				case "remove": {
					const id = parsed.positionals[0];
					if (!id || !/^u[1-9]\d*$/.test(id)) {
						return { kind: "usage-error", command: "tasks", reason: `${parsed.subcommand} requires a uN id` };
					}
					if (parsed.subcommand === "hand") return { kind: "tasks-hand", id };
					if (parsed.subcommand === "done") return { kind: "tasks-done", id };
					return { kind: "tasks-remove", id };
				}
				default:
					return { kind: "tasks" };
			}
		},
		handle(command, ctx) {
			if (command.kind === "tasks") {
				ctx.openTasks?.();
				return;
			}
			if (!ctx.userTasks) {
				ctx.notice("error", "operator task inbox is not wired in this session");
				return;
			}
			try {
				if (command.kind === "tasks-add") {
					const task = ctx.userTasks.add(
						command.text,
						acceptanceFromTaskFlags(process.cwd(), command.expectedOutputs ?? [], command.verification ?? []),
					);
					ctx.notice("success", `logged operator task ${task.id}: ${task.title}`);
					return;
				}
				if (command.kind === "tasks-hand") {
					const task = ctx.userTasks.hand(command.id);
					ctx.submitChat(formatUserTaskHandoff(task));
					return;
				}
				if (command.kind === "tasks-done") {
					const task = ctx.userTasks.done(command.id);
					ctx.notice("success", `marked operator task ${task.id} done`);
					return;
				}
				if (command.kind === "tasks-remove") {
					const task = ctx.userTasks.drop(command.id);
					ctx.notice("success", `dropped operator task ${task.id}`);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.notice("error", message);
			}
		},
	},
];
