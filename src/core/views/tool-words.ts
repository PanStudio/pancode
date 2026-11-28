// SPDX-License-Identifier: LicenseRef-PanCode-1.0 AND MIT
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// formatSize derived from pi-coding-agent packages/coding-agent/src/core/tools/truncate.ts at v1.0.0 (MIT license).
/**
 * What a tool call is about, in words, for the terminal's action row and the
 * browser's tool card alike: the subject a call's arguments name, the size
 * words a row states, and the byte cap on a call's title.
 *
 * Browser-safe: no imports beyond types, no Node builtins.
 */

import type { BuiltinToolName } from "../tool-names.js";
import { countNoun } from "./count-words.js";

/** UTF-8 bytes a tool call's title may carry on the ACP wire and in the GUI card headline. */
export const TOOL_TITLE_MAX_BYTES = 512;

/** `512B`, `1.4KB`, `2.0MB`. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** A call's arguments as a subject rule reads them: always an object. */
type SubjectArgs = Readonly<Record<string, unknown>>;

/** What the surface knows beyond the arguments. */
export interface SubjectContext {
	/** A path as the surface states it; "" for the workspace itself. */
	place(path: string): string;
	/** A worker card under the call already states the task. */
	cardAttached?: boolean;
}

/** A trimmed, non-empty string field, or null. */
export function argText(args: SubjectArgs, key: string): string | null {
	const value = args[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** A plain object field, or null. Views may not import `core/type-guards`, so the guard is local. */
function argRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** The present parts joined by a space, or null when none is. */
export function joinDefined(...parts: ReadonlyArray<string | null | undefined>): string | null {
	const kept = parts.filter((part): part is string => typeof part === "string" && part.length > 0);
	return kept.length > 0 ? kept.join(" ") : null;
}

export const quoted = (value: string | null): string | null => (value === null ? null : `\`${value}\``);

function words(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((part): part is string => typeof part === "string") : [];
}

/** A path argument as placed; the workspace itself reads `root`. */
function pathArg(args: SubjectArgs, key: string, context: SubjectContext, root: string | null): string | null {
	const value = argText(args, key);
	if (value === null) return null;
	const placed = context.place(value);
	return placed === "" ? root : placed;
}

/** A script's command line as it ran: interpreter, its flags, the script, its arguments. */
function scriptCommand(args: SubjectArgs): string | null {
	const script = argText(args, "script");
	if (script === null) return null;
	const interpreter = argText(args, "interpreter");
	return [...(interpreter === null ? [] : [interpreter]), ...words(args.interpreter_args), script, ...words(args.args)]
		.map((part) => (/[\s"'`$]/u.test(part) ? JSON.stringify(part) : part))
		.join(" ");
}

function askedQuestions(args: SubjectArgs): string | null {
	if (args.action === "complete") return "the interview";
	const questions = Array.isArray(args.questions) ? args.questions : [];
	if (questions.length > 1) return `${questions.length} questions`;
	// The raw args, before prepareArguments turns a bare string into { question }.
	if (typeof questions[0] === "string") return questions[0].trim() || null;
	const first = argRecord(questions[0]);
	return first === null ? null : argText(first, "question");
}

/**
 * What a dispatch call hands off. A single task reads `to <agent>: <task>`; a
 * card under the call states the task, so the subject keeps only the agent. A
 * council names its roster, a compete its candidates, a batch its size.
 */
function dispatchSubject(args: SubjectArgs, context: SubjectContext): string | null {
	if (args.list === true) return "fleet agents";
	const winner = argRecord(args.apply_winner);
	if (winner !== null) return joinDefined("winner", argText(winner, "branch"));
	const land = argText(args, "land");
	if (land !== null) return joinDefined("task branch", land);
	const scout = argRecord(args.from_scout);
	if (scout !== null) return joinDefined("from scout run", argText(scout, "run_id"));
	const tasks = Array.isArray(args.tasks) ? args.tasks : null;
	const mode = argText(args, "mode");
	const first = tasks?.[0];
	const firstRecord = argRecord(first);
	const agent = (firstRecord === null ? null : argText(firstRecord, "agent")) ?? argText(args, "agent");
	const task =
		typeof first === "string"
			? first.trim() || null
			: ((firstRecord === null ? null : argText(firstRecord, "task")) ?? argText(args, "task"));
	const withTask = (lead: string) => (task === null || context.cardAttached === true ? lead : `${lead}: ${task}`);
	if (mode === "council") {
		const members = Array.isArray(args.members) ? args.members.length : 0;
		const who = argText(args, "roster") ?? (members > 0 ? `${members} members` : null);
		return withTask(who === null ? "a council" : `a council of ${who}`);
	}
	if (mode === "compete") {
		const candidates = Array.isArray(args.candidates)
			? args.candidates.length
			: typeof args.candidates === "number"
				? args.candidates
				: 2;
		return withTask(countNoun(candidates, `competing ${agent ?? "coder"}`));
	}
	if (tasks !== null && tasks.length > 1) {
		return `${countNoun(tasks.length, "task")}${mode === "pipeline" ? " as a pipeline" : mode === "sequential" ? " in sequence" : ""}`;
	}
	if (agent === null && task === null) return null;
	return withTask(`to ${agent ?? "coder"}`);
}

type SubjectRule = (args: SubjectArgs, context: SubjectContext) => string | null;

/**
 * The subject of a call, per tool, from its arguments. Tools whose subject is a
 * plain path, a pattern, a command or a URL are absent: each surface lays those
 * out its own way.
 */
export const TOOL_SUBJECTS = {
	store: (args) => {
		const tag = argText(args, "tag");
		const blob = argText(args, "blob");
		return tag === null ? argText(args, "ref") : blob === null ? tag : `${tag}:${blob}`;
	},
	memory_recall: (args) => argText(args, "query"),
	memory_note: (args) => argText(args, "note"),
	credential_present: (args) => joinDefined("credential", argText(args, "name")),
	code_nav: (args) => joinDefined(argText(args, "mode"), quoted(argText(args, "query"))),
	context: (args) => {
		const scope = argText(args, "scope");
		const query = quoted(argText(args, "query"));
		const name = argText(args, "name");
		if (scope === "skills") return name === null ? joinDefined("skills", query) : `skill ${name}`;
		if (scope === "recall") return joinDefined("recall", argText(args, "ref") ?? query);
		return joinDefined(scope, query);
	},
	pancode_docs: (args) => joinDefined("PanCode docs", quoted(argText(args, "query"))),
	pancode_hub: (args) => joinDefined("hub", argText(args, "ref") ?? quoted(argText(args, "query"))),
	evidence: (args) => joinDefined("evidence", argText(args, "mode"), argText(args, "runId")),
	ledger: (args, context) => {
		const path = pathArg(args, "path", context, null);
		const line = typeof args.line === "number" ? args.line : null;
		const subject =
			argText(args, "target") ?? argText(args, "ref") ?? (path === null || line === null ? path : `${path}:${line}`);
		return joinDefined("ledger", argText(args, "action"), argText(args, "kind"), subject);
	},
	artifact: (args, context) => {
		const title = argText(args, "title");
		const path = pathArg(args, "path", context, null);
		return joinDefined(
			argText(args, "kind") ?? "artifact",
			title === null ? null : `"${title}"`,
			path === null ? null : title === null ? path : `to ${path}`,
		);
	},
	run_script: scriptCommand,
	browser: (args) =>
		joinDefined(
			`browser ${argText(args, "op") ?? ""}`.trim(),
			argText(args, "url") ??
				argText(args, "endpoint") ??
				argText(args, "command") ??
				argText(args, "target") ??
				argText(args, "page"),
		),
	verify: (args, context) => {
		const check = argText(args, "check");
		return check === null ? "checks" : joinDefined(check, pathArg(args, "path", context, null));
	},
	git: (args, context) =>
		joinDefined("git", argText(args, "op"), argText(args, "rev"), pathArg(args, "path", context, null)),
	panes: (args) => joinDefined("panes", argText(args, "action"), argText(args, "target") ?? argText(args, "preset")),
	dispatch: dispatchSubject,
	monitor: (args) => {
		const run = argText(args, "run_id");
		const batch = argText(args, "batch_id");
		const runs = words(args.run_ids).length;
		return run !== null ? `run ${run}` : batch !== null ? `batch ${batch}` : runs > 0 ? countNoun(runs, "run") : "runs";
	},
	steer: (args) => {
		const run = argText(args, "run_id");
		return run === null ? "a run" : `run ${run}`;
	},
	// One task reads as `task t1`, a whole board as `task board "title"`, so a row never says `started tasks t1`.
	tasks: (args) => {
		const title = argText(args, "title");
		if (title !== null) return `task board "${title}"`;
		const id = argText(args, "id");
		return id === null ? "task board" : `task ${id}`;
	},
	consult: (args) => {
		const filter = argRecord(args.filter);
		if (typeof filter?.source === "string") return `an advisor · filter ${filter.source}`;
		const count = Array.isArray(args.questions) ? args.questions.length : 0;
		return count === 0 ? "an advisor" : `an advisor · ${countNoun(count, "question")}`;
	},
	vision: (args) => joinDefined("image", argText(args, "path")),
	ask_user: askedQuestions,
	report: (args) => joinDefined("report", argText(args, "title")),
	decide: (args) => {
		const subject = argText(args, "label") ?? argText(args, "key");
		const value = argText(args, "value");
		return subject === null ? value : value === null ? subject : `${subject} → ${value}`;
	},
	limitation: (args) => joinDefined("limitation:", argText(args, "scope")),
	finish: (args) => joinDefined("completion", argText(args, "state")),
	configure_pancode: (args) => joinDefined("setting", argText(args, "path")),
	restart_session: (args) => argText(args, "continuation") ?? "session",
} as const satisfies Partial<Record<BuiltinToolName, SubjectRule>>;

export type SubjectToolName = keyof typeof TOOL_SUBJECTS;

/** The subject of a call by tool name, or null when the tool has no shared rule or its arguments name nothing. */
export function toolSubject(name: string, args: SubjectArgs, context: SubjectContext): string | null {
	const rule = (TOOL_SUBJECTS as Readonly<Record<string, SubjectRule>>)[name];
	return rule === undefined ? null : rule(args, context);
}
