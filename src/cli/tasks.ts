// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { acceptanceFromTaskFlags } from "../domains/dispatch/task-acceptance.js";
import { formatUserTaskHandoff } from "../domains/user-tasks/handoff.js";
import { createUserTasksStore, type UserTask } from "../domains/user-tasks/store.js";
import { jsonDocument, writeCliFailure } from "./lib/json-out.js";
import type { ErrorSlug } from "./lib/slugs.js";

const USAGE = `Usage:
  pancode tasks [list] [--json]
  pancode tasks add [--expect <path>] [--verify <checkId>[:timeoutMs]] [--json] <text>
  pancode tasks hand|done|drop <uN> [--json]
`;

const HELP = `${USAGE}
--expect and --verify are repeatable. Check ids must be declared in package.json or .pancode/verifiers.yaml.
Every verb prints lines for a person by default. With --json, list prints the task array, hand, done and drop
print the task record, and add prints {"version":1,"task":{...}}.`;

/** One task as `pancode tasks` lists it: id, state, title, and what it is linked to. */
function taskLine(task: UserTask): string {
	const links = [
		...(task.boardTaskId !== undefined ? [`board ${task.boardTaskId}`] : []),
		...(task.handedSessionId !== undefined ? [`session ${task.handedSessionId}`] : []),
	];
	return `${task.id}  ${task.status}  ${task.title}${links.length > 0 ? `  (${links.join(", ")})` : ""}`;
}

const VERBS = new Set(["add", "list", "hand", "done", "drop"]);

class TasksUsageError extends Error {
	constructor(
		message: string,
		readonly slug: ErrorSlug = "usage",
	) {
		super(message);
	}
}

function unexpected(arg: string): TasksUsageError {
	return arg.startsWith("-")
		? new TasksUsageError(`unknown flag: ${arg}`, "unknown_flag")
		: new TasksUsageError(`unexpected argument: ${arg}`);
}

export function runTasksCommand(argv: string[]): number {
	// `--json` is a flag of every leaf, not task text, unless it follows "--".
	const end = argv.indexOf("--");
	const options = end === -1 ? argv : argv.slice(0, end);
	const json = options.includes("--json");
	const args = json ? [...options.filter((arg) => arg !== "--json"), ...(end === -1 ? [] : argv.slice(end))] : argv;
	const path = ["tasks", ...(VERBS.has(args[0] ?? "list") ? [args[0] ?? "list"] : [])];
	try {
		if (options.includes("--help") || options.includes("-h")) {
			console.log(HELP);
			return 0;
		}
		const store = createUserTasksStore({ cwd: process.cwd() });
		const [action = "list", ...rest] = args;
		if (action === "add") {
			const expected: string[] = [],
				verify: string[] = [],
				title: string[] = [];
			for (let index = 0; index < rest.length; index++) {
				const token = rest[index] ?? "";
				if (token === "--") {
					title.push(...rest.slice(index + 1));
					break;
				}
				if (token === "--expect" || token === "--verify") {
					const value = rest[++index];
					if (!value || value.startsWith("--")) throw new TasksUsageError(`${token} requires a value`);
					(token === "--expect" ? expected : verify).push(value);
				} else if (token.startsWith("--")) throw unexpected(token);
				else title.push(token);
			}
			if (title.join(" ").trim().length === 0) throw new TasksUsageError("tasks add requires the task text");
			const task = store.add(title.join(" "), undefined, acceptanceFromTaskFlags(process.cwd(), expected, verify));
			if (json) console.log(JSON.stringify(jsonDocument({ task })));
			else console.log(`logged operator task ${task.id}: ${task.title}`);
		} else if (action === "list") {
			if (rest[0] !== undefined) throw unexpected(rest[0]);
			const tasks = store.snapshot();
			if (json) console.log(JSON.stringify(tasks, null, 2));
			else if (tasks.length === 0) console.log("no operator tasks in this project; add one: pancode tasks add <text>");
			else for (const task of tasks) console.log(taskLine(task));
		} else if (action === "hand" || action === "done" || action === "drop") {
			const [id, extra] = rest;
			if (id === undefined) throw new TasksUsageError(`tasks ${action} requires a task id (uN)`);
			if (id.startsWith("-")) throw unexpected(id);
			if (extra !== undefined) throw unexpected(extra);
			let task: ReturnType<(typeof store)[typeof action]>;
			try {
				task = store[action](id);
			} catch (error) {
				writeCliFailure({ path, slug: "not_found", message: error instanceof Error ? error.message : String(error), json });
				return 1;
			}
			console.log(json ? JSON.stringify(task, null, 2) : taskLine(task));
			if (action === "hand") {
				console.error(
					"CLI hand records the inbox state only; it does not start a session or submit the interactive /tasks hand turn. " +
						"Pass this pickup prompt to pancode run in the same project:\n" +
						formatUserTaskHandoff(task),
				);
			}
		} else
			throw action.startsWith("-")
				? new TasksUsageError(`unknown flag: ${action}`, "unknown_flag")
				: new TasksUsageError(`unknown tasks command: ${action}`, "unknown_command");
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof TasksUsageError) {
			writeCliFailure({ path, slug: error.slug, message, json });
			return 2;
		}
		writeCliFailure({ path, slug: "io", message, json });
		return 1;
	}
}
