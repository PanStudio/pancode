// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Typed tool presentation policy. Answers, per tool, what the transcript's
 * Standard view needs to know: does the block open folded
 * or expanded, does the folded row keep a mutation diff visible, and does a
 * failed folded row carry an output excerpt.
 *
 * The panel must not decide any of that by tool name. It asks this module,
 * which resolves the answer from two inputs: the registered presentation
 * metadata for the tool (declared once here and attached to `ToolMetadata` by
 * the builtin catalog) and the argument-sensitive resource-read rule. The
 * lookup is a plain object read, so it stays cheap enough to call on every
 * frame, and it needs no registry instance: the live chat panel has none.
 *
 * Pure module: no I/O, no registry construction, no UI imports.
 */

import os from "node:os";
import path from "node:path";
import { normalizeGatewayArguments } from "../core/gateway-envelope.js";
import { relativePathEscapes } from "../core/path-containment.js";
import { ToolNames } from "../core/tool-names.js";
import { isRecord } from "../core/type-guards.js";
import {
	argText,
	joinDefined,
	quoted,
	type SubjectContext,
	type SubjectToolName,
	TOOL_SUBJECTS,
} from "../core/views/tool-words.js";

export type ToolFoldDefault = "expanded" | "folded";

export interface ToolPresentationPolicy {
	/** How a fresh block for this call renders before the operator touches it. */
	foldDefault: ToolFoldDefault;
	/**
	 * Keep the mutation diff under the folded row. A folded `edit` that hides
	 * what it changed tells the operator nothing they could act on; the diff is
	 * the row's whole point and stays visible, bounded, until the body is opened.
	 */
	showDiffWhenFolded: boolean;
	/**
	 * Carry the last non-empty output line on a failed folded row. Bash pioneered
	 * this so a failed command stays diagnosable without opening its body; every
	 * tool that fails with text gets the same courtesy.
	 */
	failureExcerpt: boolean;
}

const FOLDED: ToolPresentationPolicy = { foldDefault: "folded", showDiffWhenFolded: false, failureExcerpt: true };
const FOLDED_WITH_DIFF: ToolPresentationPolicy = {
	foldDefault: "folded",
	showDiffWhenFolded: true,
	failureExcerpt: true,
};

/**
 * Per-tool presentation declarations. Every builtin folds by default: a
 * routine turn of six reads used to open six bodies, and the one-line row
 * already carries the call, its outcome facts, size, and settlement. Mutations
 * keep their diff under the folded row. Everything unlisted, including dynamic
 * tools, folds the same way.
 */
const TOOL_PRESENTATION: Readonly<Record<string, ToolPresentationPolicy>> = {
	[ToolNames.Evidence]: FOLDED,
	[ToolNames.Read]: FOLDED,
	[ToolNames.Grep]: FOLDED,
	[ToolNames.Find]: FOLDED,
	[ToolNames.Ls]: FOLDED,
	[ToolNames.Count]: FOLDED,
	[ToolNames.CodeNav]: FOLDED,
	[ToolNames.Context]: FOLDED,
	[ToolNames.CredentialPresent]: FOLDED,
	[ToolNames.PancodeDocs]: FOLDED,
	[ToolNames.PancodeHub]: FOLDED,
	[ToolNames.Data]: FOLDED,
	[ToolNames.Store]: FOLDED,
	[ToolNames.MemoryRecall]: FOLDED,
	[ToolNames.MemoryNote]: FOLDED,
	[ToolNames.Write]: FOLDED_WITH_DIFF,
	[ToolNames.Edit]: FOLDED_WITH_DIFF,
	[ToolNames.Bash]: FOLDED,
	[ToolNames.Git]: FOLDED,
	[ToolNames.Verify]: FOLDED,
	[ToolNames.RunScript]: FOLDED,
	[ToolNames.Browser]: FOLDED,
	[ToolNames.Dispatch]: FOLDED,
	[ToolNames.Monitor]: FOLDED,
	[ToolNames.Steer]: FOLDED,
	[ToolNames.Tasks]: FOLDED,
	[ToolNames.Ledger]: FOLDED,
	[ToolNames.Panes]: FOLDED,
	[ToolNames.Limitation]: FOLDED,
	[ToolNames.Finish]: FOLDED,
	[ToolNames.Decide]: FOLDED,
	[ToolNames.Consult]: FOLDED,
	[ToolNames.Vision]: FOLDED,
	[ToolNames.WebRead]: FOLDED,
	[ToolNames.WebFetch]: FOLDED,
	[ToolNames.AskUser]: FOLDED,
	[ToolNames.Artifact]: FOLDED,
	[ToolNames.Gateway]: FOLDED,
};

function readStringField(args: unknown, key: string): string | null {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Compact resource-read classification. Reads of skill/handbook/agent
 * instruction files and docs pages collapse to one labeled line and never
 * auto-expand; their bodies are reference material, not task output.
 */
export function classifyResourceRead(toolName: string, args: unknown): string | null {
	if (toolName !== ToolNames.Read) return null;
	const path = readStringField(args, "path");
	if (path === null) return null;
	const normalized = path.replace(/\\/g, "/");
	const base = normalized.split("/").pop() ?? "";
	if (base === "SKILL.md") return "skill";
	if (base === "PANCODE.md") return "handbook";
	if (base === "AGENTS.md") return "agents";
	if (/(^|\/)docs\//.test(normalized)) return "docs";
	return null;
}

/**
 * Resolve the presentation policy for one call. Argument-sensitive rules win
 * over the per-tool declaration because a resource read is a property of the
 * path, not of the `read` tool.
 */
export function toolPresentationPolicy(toolName: string, args: unknown): ToolPresentationPolicy {
	if (classifyResourceRead(toolName, args) !== null) return FOLDED;
	return TOOL_PRESENTATION[toolName] ?? FOLDED;
}

/**
 * What kind of act a call is, as the transcript shows it. Each class owns a
 * gutter mark, a pair of verbs and the facts its row states, so a read, a
 * write, a command, a fetch, a delegation, a question to the operator and a
 * call outside PanCode each look different at a glance, with or without color.
 */
export type ToolClass =
	| "observe"
	| "search"
	| "knowledge"
	| "mutate"
	| "execute"
	| "network"
	| "delegate"
	| "interaction"
	| "external";

/** A call's arguments as the row composer sees them: always an object. */
export type ToolRowArgs = Readonly<Record<string, unknown>>;

/**
 * How one tool's action row reads. The renderer composes every row from this
 * and from the call's structured result; it never branches on a tool name.
 */
export interface ToolRowSpec {
	class: ToolClass;
	/** Progressive and past tense of the action, for a running and a settled row. */
	verbs: readonly [running: string, settled: string];
	/**
	 * Verbs that depend on the call's arguments: a steer that cancels, a fetch
	 * that posts, a monitor call that waits. `details` is the settled result's,
	 * null while the call runs. Null keeps `verbs`.
	 */
	verbsFor?: (
		args: ToolRowArgs,
		details: Readonly<Record<string, unknown>> | null,
	) => readonly [running: string, settled: string] | null;
	/**
	 * The row's object, from the arguments: a path, a command, a pattern, a
	 * host and path. `code` renders in backticks; `url` is shortened to its host
	 * and path tail, never the whole URL; a `path` that must be cut keeps its
	 * tail, where the file name is.
	 */
	object?: (args: ToolRowArgs, context: ToolRowContext) => { text: string; style?: "code" | "url" | "path" } | null;
	/** A qualifier after the object: a search's scope (`in src`). */
	scope?: (args: ToolRowArgs, context: ToolRowContext) => string | null;
	/** Argument fields the row states, so they are never repeated inline or as `key ›` rows. */
	consumes: readonly string[];
	/**
	 * True when a field outside `consumes` is a model mistake the row never
	 * restates, inline or as a `key ›` row. The tool's own error names what was
	 * wrong; echoing the stray blob only prints it (p9/D1).
	 */
	dropsUnknownArgs?: true;
	/**
	 * Arguments the settled result adds to the row. A call that names its target
	 * only in an earlier call (an apply by proposal id) reads its target back
	 * from the structured result.
	 */
	settledArgs?: (args: ToolRowArgs, details: Readonly<Record<string, unknown>>) => ToolRowArgs;
	/**
	 * False when a settled observation's size is not a fact worth stating. A
	 * listing counts its entries; the bytes of the listing text say nothing.
	 */
	statesSize?: false;
	/** What a folded Compact row counts this call as; the class supplies it when absent. */
	nouns?: readonly [singular: string, plural: string];
	/**
	 * The question and answer pairs a settled call resolved, from its arguments
	 * and structured result: an interview round's answers, or the decisions an
	 * interview closed with.
	 */
	pairs?: (args: ToolRowArgs, details: Readonly<Record<string, unknown>> | null) => ReadonlyArray<ToolRowPair>;
}

/** What the transcript knows about a call beyond its arguments. */
export interface ToolRowContext {
	/** A worker card sits under this call and states the run's task and outcome. */
	cardAttached?: boolean;
	/**
	 * The session workspace. A command already runs there, so a leading `cd`
	 * into it is dropped from the row and a `cd` into a subdirectory becomes the
	 * row's scope; a path inside it reads relative to it.
	 */
	cwd?: string;
}

/** One question the operator answered, or one decision recorded, as a row states it. */
export interface ToolRowPair {
	question: string;
	answer: string;
}

/** What a folded Compact row counts a call as, by class. */
export const CLASS_NOUNS: Readonly<Record<ToolClass, readonly [string, string]>> = {
	observe: ["file", "files"],
	search: ["search", "searches"],
	knowledge: ["source", "sources"],
	mutate: ["file", "files"],
	execute: ["command", "commands"],
	network: ["page", "pages"],
	delegate: ["run", "runs"],
	interaction: ["question", "questions"],
	external: ["call", "calls"],
};

const CLASS_VERBS: Readonly<Record<ToolClass, readonly [string, string]>> = {
	observe: ["reading", "read"],
	search: ["searching", "searched"],
	knowledge: ["consulting", "consulted"],
	mutate: ["editing", "edited"],
	execute: ["running", "ran"],
	network: ["fetching", "fetched"],
	delegate: ["delegating", "delegated"],
	interaction: ["asking", "asked"],
	external: ["calling", "called"],
};

/**
 * A path as a row states it: relative to the workspace when it lies inside it,
 * `root` for the workspace itself, and as written anywhere else. A model that
 * sends absolute paths would otherwise start every row with the same long
 * prefix and cut the part that tells two files apart.
 */
function workspacePath(value: string | null, context: ToolRowContext, root: string | null): string | null {
	if (value === null) return null;
	const relative = workspaceRelative(value, context.cwd);
	if (relative === null) return value;
	return relative === "" ? root : relative;
}

/**
 * A path argument as a row states it. The workspace itself reads `workspace`
 * where the path is the object, and says nothing where it only narrows a
 * subject (`git status`, not `git status workspace`).
 */
function pathArg(
	args: ToolRowArgs,
	key: string,
	context: ToolRowContext,
	root: string | null = "workspace",
): string | null {
	return workspacePath(argText(args, key), context, root);
}

/** The workspace root is the default scope and stays implicit. */
function searchScope(args: ToolRowArgs, context: ToolRowContext): string | null {
	const scope = argText(args, "path");
	if (scope === null || scope === "." || scope === "./") return null;
	const relative = workspaceRelative(scope, context.cwd);
	return relative === "" ? null : (relative ?? scope);
}

/** The shared subject rule as this row's object; `code` renders in backticks. */
function shared(name: SubjectToolName, style?: "code"): NonNullable<ToolRowSpec["object"]> {
	const rule: (args: ToolRowArgs, context: SubjectContext) => string | null = TOOL_SUBJECTS[name];
	return (args, context) => {
		const subject = rule(args, {
			place: (value) => workspaceRelative(value, context.cwd) ?? value,
			cardAttached: context.cardAttached === true,
		});
		if (subject === null) return null;
		return style === undefined ? { text: subject } : { text: subject, style };
	};
}

const plain = (value: string | null) => (value === null ? null : { text: value });
const code = (value: string | null) => (value === null ? null : { text: value, style: "code" as const });
const pathObject = (value: string | null) => (value === null ? null : { text: value, style: "path" as const });

/**
 * An interview round's answers (`details.answers[{question, answer}]`), or,
 * for `action=complete`, the decisions it recorded (`details.decisions[{key,
 * value, label?}]`), which read label first.
 */
function interviewPairs(args: ToolRowArgs, details: Readonly<Record<string, unknown>> | null): ToolRowPair[] {
	const complete = args.action === "complete";
	const list = details?.[complete ? "decisions" : "answers"];
	if (!Array.isArray(list)) return [];
	const pairs: ToolRowPair[] = [];
	for (const entry of list) {
		if (!isRecord(entry)) continue;
		const fields = entry;
		const question = complete ? (argText(fields, "label") ?? argText(fields, "key")) : argText(fields, "question");
		const answer = argText(fields, complete ? "value" : "answer");
		// An answer PanCode chose because nobody answered in time says so on the row (#421).
		const auto = !complete && fields.auto === true;
		if (question !== null && answer !== null)
			pairs.push({ question, answer: auto ? `${answer} (chosen by PanCode)` : answer });
	}
	return pairs;
}

/**
 * A plain leading `cd <dir> &&` (or `cd <dir>;`) and the command after it.
 * Anything fancier (a subshell, `pushd`, a `cd` mid-pipeline) is left alone.
 */
const LEADING_CD = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)\s*([\s\S]+)$/u;

/** `dir` relative to the workspace: "" for the workspace itself, null outside it or when unknown. */
export function workspaceRelative(dir: string, cwd: string | undefined): string | null {
	if (cwd === undefined || cwd.length === 0) return null;
	const expanded = dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir;
	const relative = path.relative(cwd, path.resolve(cwd, expanded));
	if (relativePathEscapes(relative)) return null;
	return relative;
}

/**
 * The command a bash row states and where it ran. Bash already runs at the
 * workspace root, so a model's `cd /abs/workspace && npm test` reads `npm test`
 * rather than a row that shows the path and cuts the command; a `cd` into a
 * subdirectory, or an explicit `cwd` argument, reads as ` in <dir>`. A `cd`
 * anywhere else stays in the command, where it is a fact worth seeing.
 */
function commandPlacement(
	args: ToolRowArgs,
	context: ToolRowContext,
): { command: string | null; scope: string | null } {
	const command = argText(args, "command");
	const cwdArg = argText(args, "cwd");
	const explicit = cwdArg === null ? null : (workspaceRelative(cwdArg, context.cwd) ?? cwdArg);
	const match = command === null ? null : LEADING_CD.exec(command);
	const dir = match === null ? undefined : (match[1] ?? match[2] ?? match[3]);
	const rest = match?.[4]?.trim();
	if (dir === undefined || rest === undefined || rest.length === 0 || cwdArg !== null) {
		return { command, scope: explicit === "" ? null : explicit };
	}
	const relative = workspaceRelative(dir, context.cwd);
	if (relative === null) return { command, scope: null };
	return { command: rest, scope: relative === "" ? null : relative };
}

const TASK_VERBS: Readonly<Record<string, readonly [string, string]>> = {
	plan: ["planning", "planned"],
	add: ["adding", "added"],
	start: ["starting", "started"],
	done: ["completing", "completed"],
	block: ["blocking", "blocked"],
	list: ["listing", "listed"],
	pick: ["picking", "picked"],
	drop: ["dropping", "dropped"],
};

const DATA_VERBS: Readonly<Record<string, readonly [string, string]>> = {
	inspect: ["inspecting", "inspected"],
	select: ["selecting from", "selected from"],
	validate: ["validating", "validated"],
	stats: ["summarizing", "summarized"],
};

const STORE_VERBS: Readonly<Record<string, readonly [string, string]>> = {
	tags: ["listing tags", "listed tags"],
	create: ["creating", "created"],
	list: ["listing", "listed"],
	stat: ["checking", "checked"],
	get: ["getting", "got"],
	put: ["putting", "put"],
	note: ["noting", "noted"],
	remove: ["removing", "removed"],
};

const MONITOR_VERBS: Readonly<Record<string, readonly [string, string]>> = {
	status: ["checking", "checked"],
	peek: ["peeking at", "peeked at"],
	record: ["reading the run record of", "read the run record of"],
	tools: ["listing the tools of", "listed the tools of"],
	list: ["listing", "listed"],
	wait: ["waiting on", "waited on"],
	collect: ["collecting", "collected"],
};

const url = (args: ToolRowArgs) => {
	const value = argText(args, "url");
	return value === null ? null : { text: value, style: "url" as const };
};

/**
 * The builtin table. Every builtin has exactly one row here; the class
 * decides its mark and the facts its row may state.
 */
const TOOL_ROWS: Readonly<Record<string, ToolRowSpec>> = {
	[ToolNames.Read]: {
		class: "observe",
		verbs: CLASS_VERBS.observe,
		object: (args, context) => pathObject(pathArg(args, "path", context)),
		consumes: ["path"],
	},
	[ToolNames.Ls]: {
		class: "observe",
		verbs: ["listing", "listed"],
		nouns: ["directory", "directories"],
		object: (args, context) => pathObject(pathArg(args, "path", context) ?? "workspace"),
		consumes: ["path"],
		statesSize: false,
	},
	[ToolNames.Count]: {
		class: "observe",
		verbs: ["counting", "counted"],
		nouns: ["file", "files"],
		object: (args, context) => pathObject(pathArg(args, "path", context)),
		consumes: ["path"],
		statesSize: false,
	},
	[ToolNames.Data]: {
		class: "observe",
		verbs: ["inspecting", "inspected"],
		verbsFor: (args) => DATA_VERBS[argText(args, "op") ?? ""] ?? null,
		object: (args, context) => pathObject(pathArg(args, "path", context)),
		consumes: ["op", "path"],
	},
	[ToolNames.Store]: {
		class: "observe",
		verbs: ["using store", "used store"],
		verbsFor: (args) => STORE_VERBS[argText(args, "op") ?? ""] ?? null,
		object: shared(ToolNames.Store, "code"),
		consumes: ["op", "tag", "blob", "ref"],
	},
	[ToolNames.MemoryRecall]: {
		class: "search",
		verbs: ["recalling", "recalled"],
		object: shared(ToolNames.MemoryRecall),
		consumes: ["query", "limit"],
	},
	[ToolNames.MemoryNote]: {
		class: "observe",
		verbs: ["noting", "noted"],
		object: shared(ToolNames.MemoryNote),
		consumes: ["note", "command", "path", "applies_when"],
	},
	[ToolNames.CredentialPresent]: {
		class: "observe",
		verbs: ["checking", "checked"],
		nouns: ["credential", "credentials"],
		object: shared(ToolNames.CredentialPresent),
		consumes: ["name"],
	},
	[ToolNames.Grep]: {
		class: "search",
		verbs: ["searching for", "searched for"],
		object: (args) => code(argText(args, "pattern")),
		scope: searchScope,
		consumes: ["pattern", "path"],
	},
	[ToolNames.Find]: {
		class: "search",
		verbs: ["finding", "found"],
		object: (args) => code(argText(args, "pattern")),
		scope: searchScope,
		consumes: ["pattern", "path"],
	},
	[ToolNames.CodeNav]: {
		class: "search",
		verbs: ["navigating", "navigated"],
		object: shared(ToolNames.CodeNav),
		consumes: ["mode", "query"],
	},
	[ToolNames.Context]: {
		class: "knowledge",
		verbs: CLASS_VERBS.knowledge,
		verbsFor: (args) => (args.scope === "skills" && argText(args, "name") !== null ? ["loading", "loaded"] : null),
		object: shared(ToolNames.Context),
		consumes: ["scope", "query", "name", "ref"],
	},
	[ToolNames.PancodeDocs]: {
		class: "knowledge",
		verbs: CLASS_VERBS.knowledge,
		object: shared(ToolNames.PancodeDocs),
		consumes: ["query"],
	},
	[ToolNames.PancodeHub]: {
		class: "knowledge",
		verbs: CLASS_VERBS.knowledge,
		object: shared(ToolNames.PancodeHub),
		consumes: ["query", "ref"],
	},
	[ToolNames.Evidence]: {
		class: "knowledge",
		verbs: CLASS_VERBS.knowledge,
		object: shared(ToolNames.Evidence),
		consumes: ["mode", "runId"],
	},
	[ToolNames.Ledger]: {
		class: "knowledge",
		verbs: CLASS_VERBS.knowledge,
		object: shared(ToolNames.Ledger),
		consumes: ["action", "kind", "target", "ref", "path", "line"],
	},
	[ToolNames.SelfCompact]: {
		class: "knowledge",
		verbs: ["compacting", "compacted"],
		object: () => plain("context"),
		// The note is the model's own reminder; /view keeps it.
		consumes: ["note_to_self"],
	},
	[ToolNames.Edit]: {
		class: "mutate",
		verbs: ["editing", "edited"],
		object: (args, context) => pathObject(pathArg(args, "path", context)),
		consumes: ["path"],
	},
	[ToolNames.Write]: {
		class: "mutate",
		verbs: ["writing", "wrote"],
		object: (args, context) => pathObject(pathArg(args, "path", context)),
		consumes: ["path"],
	},
	[ToolNames.Artifact]: {
		class: "mutate",
		verbs: ["writing", "wrote"],
		object: shared(ToolNames.Artifact),
		consumes: ["kind", "title", "path"],
	},
	[ToolNames.Bash]: {
		class: "execute",
		verbs: CLASS_VERBS.execute,
		object: (args, context) => code(commandPlacement(args, context).command),
		scope: (args, context) => commandPlacement(args, context).scope,
		// A timeout is stated only when the command hit it (`timed out after 30s`).
		consumes: ["command", "cwd", "timeout_ms"],
	},
	[ToolNames.RunScript]: {
		class: "execute",
		verbs: CLASS_VERBS.execute,
		object: shared(ToolNames.RunScript, "code"),
		consumes: ["interpreter", "interpreter_args", "script", "args"],
	},
	[ToolNames.Browser]: {
		class: "execute",
		verbs: CLASS_VERBS.execute,
		object: shared(ToolNames.Browser),
		consumes: ["op", "url", "endpoint", "page", "target", "script", "file", "command"],
	},
	[ToolNames.Verify]: {
		class: "execute",
		verbs: ["checking", "checked"],
		verbsFor: (args) => (argText(args, "check") === null ? ["listing", "listed"] : null),
		object: shared(ToolNames.Verify),
		consumes: ["check", "path"],
	},
	[ToolNames.Git]: {
		class: "execute",
		verbs: CLASS_VERBS.execute,
		object: shared(ToolNames.Git),
		consumes: ["op", "rev", "path"],
	},
	[ToolNames.Panes]: {
		class: "execute",
		verbs: CLASS_VERBS.execute,
		object: shared(ToolNames.Panes),
		consumes: ["action", "target", "preset"],
	},
	[ToolNames.WebFetch]: {
		class: "network",
		verbs: CLASS_VERBS.network,
		// A request that writes is sent, not fetched; its method rides the row.
		verbsFor: (args) => {
			const method = argText(args, "method")?.toUpperCase();
			return method === undefined || method === "GET" || method === "HEAD" ? null : ["sending", "sent"];
		},
		object: url,
		consumes: ["url"],
	},
	[ToolNames.WebRead]: {
		class: "network",
		verbs: ["reading", "read"],
		object: url,
		consumes: ["url"],
	},
	[ToolNames.Dispatch]: {
		class: "delegate",
		verbs: CLASS_VERBS.delegate,
		verbsFor: (args, details) =>
			args.list === true
				? ["listing", "listed"]
				: isRecord(args.apply_winner)
					? ["applying", "applied"]
					: typeof args.land === "string"
						? // Only a Land the operator accepted lands; a kept or refused branch stays where it was.
							["landing", details?.outcome === "landed" ? "landed" : "kept"]
						: isRecord(args.from_scout)
							? ["planning", "planned"]
							: null,
		object: shared(ToolNames.Dispatch),
		consumes: [
			"agent",
			"task",
			"tasks",
			"list",
			"mode",
			"roster",
			"members",
			"candidates",
			"from_scout",
			"apply_winner",
			"land",
		],
	},
	[ToolNames.Monitor]: {
		class: "delegate",
		verbs: ["checking", "checked"],
		verbsFor: (args) => MONITOR_VERBS[argText(args, "mode") ?? ""] ?? null,
		object: shared(ToolNames.Monitor),
		consumes: ["run_id", "mode", "batch_id", "run_ids"],
	},
	[ToolNames.Steer]: {
		class: "delegate",
		verbs: ["steering", "steered"],
		verbsFor: (args) => (args.action === "cancel" ? ["cancelling", "cancelled"] : null),
		object: shared(ToolNames.Steer),
		consumes: ["run_id", "action"],
	},
	[ToolNames.Tasks]: {
		class: "delegate",
		verbs: ["updating", "updated"],
		verbsFor: (args) => TASK_VERBS[argText(args, "action") ?? ""] ?? null,
		// One task reads as `task t1`, a whole board as `task board "title"`, so a row never says `started tasks t1`.
		object: shared(ToolNames.Tasks),
		consumes: ["action", "title", "id"],
	},
	[ToolNames.Consult]: {
		class: "delegate",
		verbs: CLASS_VERBS.knowledge,
		object: shared(ToolNames.Consult),
		consumes: ["questions", "filter"],
	},
	[ToolNames.Vision]: {
		class: "knowledge",
		verbs: ["processing", "processed"],
		object: shared(ToolNames.Vision),
		consumes: ["path", "question"],
	},
	[ToolNames.AskUser]: {
		class: "interaction",
		verbs: CLASS_VERBS.interaction,
		verbsFor: (args) => (args.action === "complete" ? ["completing", "completed"] : null),
		object: shared(ToolNames.AskUser),
		consumes: ["action", "mode", "questions", "max_rounds", "decisions", "summary"],
		pairs: interviewPairs,
	},
	[ToolNames.Report]: {
		class: "interaction",
		verbs: ["drafting", "drafted"],
		verbsFor: (args) => (args.action === "offer" ? ["offering", "offered"] : null),
		object: shared(ToolNames.Report),
		consumes: ["action", "kind", "title", "happened", "operator_words", "expected", "reproduce", "not_known", "area"],
		dropsUnknownArgs: true,
	},
	[ToolNames.Decide]: {
		class: "interaction",
		verbs: ["deciding", "decided"],
		object: shared(ToolNames.Decide),
		consumes: ["key", "label", "value"],
	},
	[ToolNames.Limitation]: {
		class: "interaction",
		verbs: ["noting", "noted"],
		object: shared(ToolNames.Limitation),
		consumes: ["scope"],
	},
	[ToolNames.Finish]: {
		class: "interaction",
		verbs: ["declaring", "declared"],
		object: shared(ToolNames.Finish),
		consumes: ["state"],
	},
	// The proposed value is a JSON blob the model composed; the settled result
	// states the same change as bounded `path: old → new` lines, so the row names
	// the setting and leaves the blob out (p6/R4).
	[ToolNames.ConfigurePancode]: {
		class: "mutate",
		verbs: ["configuring", "configured"],
		verbsFor: (args) => (args.action === "preview" ? ["previewing", "previewed"] : null),
		object: shared(ToolNames.ConfigurePancode),
		consumes: ["action", "path", "value", "proposalId"],
		dropsUnknownArgs: true,
		// An apply carries only the proposal id; the saved path rides the result.
		settledArgs: (args, details) =>
			typeof args.path === "string" || typeof details.path !== "string" ? args : { ...args, path: details.path },
		nouns: ["setting", "settings"],
	},
	[ToolNames.RestartSession]: {
		class: "mutate",
		verbs: ["restarting", "restart requested"],
		object: shared(ToolNames.RestartSession),
		consumes: ["continuation", "reason"],
		dropsUnknownArgs: true,
		nouns: ["restart", "restarts"],
	},
	[ToolNames.Gateway]: {
		class: "external",
		verbs: CLASS_VERBS.external,
		object: (args) => {
			const query = argText(args, "query");
			const server = argText(args, "server");
			if (args.op === "find") {
				return plain(
					joinDefined(
						"capabilities",
						server === null ? null : `on ${server}`,
						quoted(query) === null ? null : `for ${quoted(query)}`,
					),
				);
			}
			return plain(argText(args, "capability"));
		},
		consumes: ["op", "query", "server", "capability", "args"],
	},
};

/** `mcp_github__search_issues` as `github › search_issues`; extensions the same way. */
function externalToolLabel(name: string): string | null {
	const match = /^(?:mcp|extension)_([a-z0-9][a-z0-9_-]*)__(.+)$/u.exec(name);
	return match?.[1] !== undefined && match[2] !== undefined ? `${match[1]} › ${match[2]}` : null;
}

const EXTERNAL_ROW: ToolRowSpec = {
	class: "external",
	verbs: CLASS_VERBS.external,
	consumes: [],
};

const ACTION_CLASS_FALLBACK: Readonly<Record<string, ToolClass>> = {
	read: "observe",
	write: "mutate",
	execute: "execute",
	system_modify: "execute",
	git_destructive: "execute",
	destructive: "execute",
	dispatch: "delegate",
};

export interface ResolvedToolRow {
	spec: ToolRowSpec;
	/** The capability the row is about: the gateway call's inner tool, or the tool itself. */
	toolName: string;
	/** Arguments of that capability. */
	args: ToolRowArgs;
	/** A builtin or an external capability reached through `gateway`. */
	viaGateway: boolean;
	/** `server › tool` for an MCP or extension capability. */
	externalLabel: string | null;
	/** What the transcript knows about the call beyond its arguments. */
	context: ToolRowContext;
}

function rowArgs(value: unknown): ToolRowArgs {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ToolRowArgs) : {};
}

/**
 * Resolve the row for one call. A gateway `call` reads as the capability it
 * reached: a builtin keeps its own class and gains `via gateway`, an MCP or
 * extension capability is external. Names in the MCP and extension namespaces
 * are external wherever they appear. An unknown dynamic tool falls back by the
 * action class admission gave it, and to external when it has none.
 */
export function resolveToolRow(
	toolName: string,
	args: unknown,
	details?: unknown,
	actionClass?: string,
	context: ToolRowContext = {},
): ResolvedToolRow {
	const record = rowArgs(args);
	if (toolName === ToolNames.Gateway) {
		const envelope = normalizeGatewayArguments(record);
		const op = envelope.op;
		const fromDetails =
			details !== null &&
			typeof details === "object" &&
			typeof (details as { capability?: unknown }).capability === "string"
				? (details as { capability: string }).capability
				: null;
		const capability = (
			fromDetails ?? (op === "call" && typeof envelope.capability === "string" ? envelope.capability : "")
		).trim();
		if (capability.length > 0 && capability !== ToolNames.Gateway && op !== "describe" && op !== "find") {
			const inner = rowArgs(envelope.args);
			const resolved = resolveToolRow(capability, inner, details, actionClass, context);
			return { ...resolved, viaGateway: true };
		}
		const spec = TOOL_ROWS[ToolNames.Gateway] as ToolRowSpec;
		if (op === "describe") {
			const described = typeof envelope.capability === "string" ? envelope.capability : "";
			return {
				spec: { ...spec, verbs: ["describing", "described"] },
				toolName,
				args: record,
				viaGateway: false,
				externalLabel: externalToolLabel(described),
				context,
			};
		}
		if (op === "find") {
			return {
				spec: { ...spec, verbs: ["searching", "searched"] },
				toolName,
				args: record,
				viaGateway: false,
				externalLabel: null,
				context,
			};
		}
		return { spec, toolName, args: record, viaGateway: false, externalLabel: null, context };
	}
	const builtin = TOOL_ROWS[toolName];
	if (builtin !== undefined) {
		const settledDetails =
			details !== null && typeof details === "object" ? (details as Readonly<Record<string, unknown>>) : null;
		const verbs = builtin.verbsFor?.(record, settledDetails) ?? builtin.verbs;
		const settled =
			builtin.settledArgs !== undefined && settledDetails !== null ? builtin.settledArgs(record, settledDetails) : record;
		return {
			spec: verbs === builtin.verbs ? builtin : { ...builtin, verbs },
			toolName,
			args: settled,
			viaGateway: false,
			externalLabel: null,
			context,
		};
	}
	const label = externalToolLabel(toolName);
	if (label !== null)
		return { spec: EXTERNAL_ROW, toolName, args: record, viaGateway: false, externalLabel: label, context };
	const fallback = actionClass === undefined ? undefined : ACTION_CLASS_FALLBACK[actionClass];
	if (fallback === undefined)
		return { spec: EXTERNAL_ROW, toolName, args: record, viaGateway: false, externalLabel: null, context };
	return {
		spec: { class: fallback, verbs: CLASS_VERBS[fallback], consumes: [] },
		toolName,
		args: record,
		viaGateway: false,
		externalLabel: null,
		context,
	};
}
