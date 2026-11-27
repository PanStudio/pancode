// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Operator runtime API v2. Import these types only; PanCode injects the API.
 *
 * The shape is event in, data out. A tick, a file change, a press and an
 * interview answer all arrive as events, and every handler returns what the
 * host should show. Nothing is pushed, so a reload is a process swap and a
 * handler can be tested by calling it.
 */

import type { ExtensionClaims, ExtensionRuns, ExtensionVerify, ExtensionWorktrees } from "./services-v2.js";
import type { View, ViewTone } from "./view.js";
import type { EmbeddingInput, EmbeddingResponse, EmbeddingTask, FactSum, ModelRunInfo, TurnOrigin } from "./wire.js";

export type ExtensionTone = "neutral" | "positive" | "warning" | "error";

export interface ExtensionStatus {
	text: string;
	tone?: ExtensionTone;
}

export interface ExtensionRuntimeSnapshot {
	workspace: string;
	sessionId: string | null;
	generation: number;
	/** The surface hosting the session: the terminal, a headless `run` (or the one-shot `extensions run`), or an ACP client such as the GUI. */
	mode: "interactive" | "headless" | "acp";
}

export type ExtensionObservationEventV2 =
	| "session_open"
	| "session_close"
	| "turn_start"
	| "turn_end"
	| "tool_end"
	| "permission_requested"
	| "permission_resolved"
	| "dispatch_started"
	| "dispatch_completed"
	| "dispatch_failed"
	| "compaction_end"
	| "budget_alert"
	| "safety_blocked"
	| "fs_changed"
	| "workspace_enter"
	| "workspace_leave"
	| "pane_changed"
	| "tick";

export type ExtensionHookPoint = "prompt_submit" | "before_tool" | "after_tool" | "turn_start" | "turn_end";

/** Content families that cross the boundary only when the manifest declares them. */
export type ExtensionContentAccess = "prompt" | "tool-args" | "tool-results" | "assistant-text";

export type WorkspaceRegion = "header" | "board" | "rail" | "footer";

export interface ExtensionRuntimeSnapshotV2 extends ExtensionRuntimeSnapshot {
	/** Served plugin in effect in this workspace; prompt names use `<plugin>:<name>`. */
	plugin: { id: string; prompts: readonly string[] } | null;
	/** Id of this extension's workspace that holds the screen, or null. `workspace` stays the project directory. */
	activeWorkspace: string | null;
}

/**
 * Token and cost sums over the calls of a turn or run, each a fact sum (#434): a call that reported nothing is
 * counted as unknown, never as zero, and an estimate keeps its estimated coverage. Cost is null when nothing priced it.
 */
export interface ExtensionUsage {
	inputTokens: FactSum;
	outputTokens: FactSum;
	cacheReadTokens: FactSum;
	cacheWriteTokens: FactSum;
	costUsd: FactSum | null;
	model: string | null;
	target: string | null;
}

/**
 * Fields marked with an access class are present only when the manifest
 * declares that class. Everything else is metadata every extension may see.
 */
export type ExtensionObservationV2 =
	| { event: "session_open"; reason: "startup" | "reload" | "session-change" }
	| { event: "session_close"; reason: "exit" | "reload" | "session-change" }
	| {
			event: "turn_start";
			turnId: string;
			/** access: prompt */
			text?: string;
	  }
	| {
			event: "turn_end";
			turnId: string;
			outcome: "completed" | "aborted" | "error";
			usage: ExtensionUsage | null;
			/** access: assistant-text */
			text?: string;
	  }
	| {
			event: "tool_end";
			turnId: string | null;
			tool: string;
			outcome: "ok" | "error" | "blocked";
			durationMs: number;
	  }
	| { event: "permission_requested"; tool: string }
	| { event: "permission_resolved"; tool: string; decision: "allowed" | "denied" }
	| { event: "dispatch_started"; runId: string; agentId: string }
	| { event: "dispatch_completed"; runId: string; agentId: string; durationMs: number; usage: ExtensionUsage | null }
	| { event: "dispatch_failed"; runId: string; agentId: string; reason: string }
	| {
			event: "compaction_end";
			/** What started it: `step` is the checkpoint a `turnPolicy: step` turn starts from (WTF-P 0.8.3 C5). */
			trigger: "auto" | "force" | "overflow" | "step" | "unknown";
			outcome: "ok" | "failed" | "unknown";
	  }
	| { event: "budget_alert"; costUsd: number | null }
	| { event: "safety_blocked"; tool: string }
	| { event: "fs_changed"; paths: string[] }
	| { event: "workspace_enter"; workspace: string }
	| { event: "workspace_leave"; workspace: string }
	| { event: "pane_changed"; state: ExtensionPaneState; reason: ExtensionPaneChangeReason }
	| { event: "tick"; intervalMs: number };

/** Where a path-taking tool (`read`, `ls`, `grep`, `find`, `write`, `edit`, `artifact`) lands its `path`. */
export interface ExtensionToolTarget {
	arg: "path";
	/**
	 * The absolute path the tool opens, resolved by the tool's own resolver: a
	 * leading `@` dropped, Unicode spaces made plain, `~` expanded and every
	 * link followed, a `..` after a link stepping up from the link's target.
	 */
	path: string;
	/** False when the walk could not finish (a link loop, a component PanCode cannot inspect); the tool then fails. */
	resolved: boolean;
	/** `path` relative to the workspace with `/` separators, `.` for the workspace itself, or null outside it. */
	workspacePath: string | null;
}

/** One worker a dispatch call starts, as dispatch admission parsed it. */
export interface ExtensionDispatchTask {
	/**
	 * `task` in an ordinary fan-out; `builder` and `reviewer` in a review
	 * loop; `candidate` and `judge` in compete; `member` and `synthesis` in
	 * council. Gate roles (`reviewer`, `judge`, `member`, `synthesis`) run
	 * read-only with no write roots.
	 */
	role: "task" | "builder" | "reviewer" | "candidate" | "judge" | "member" | "synthesis";
	/** The recipe the worker runs, with `auto` and an omitted agent already resolved. */
	agent: string;
	/**
	 * The absolute, link-resolved directory the task names in the source
	 * checkout; its write roots resolve against it. With `worktree`, the
	 * worker runs at the same path relative to the checkout root inside the
	 * task worktree the host creates at run time.
	 */
	cwd: string;
	/** The write roots as parsed, relative to `cwd`; empty when the task declares none. */
	writeRoots: string[];
	/**
	 * Where those roots land in the source checkout, absolute and
	 * link-resolved. Without `worktree` this is the boundary the worker is
	 * held to; with it, the worker is held to the same roots moved into its
	 * task worktree, and they reach this checkout only when the worktree merges.
	 */
	writeBoundaries: string[];
	/** The worker runs in a task worktree the host creates at run time, so its writes land there first. */
	worktree: boolean;
	readOnly: boolean;
}

export type ExtensionDispatchCall =
	| {
			kind: "tasks";
			mode: string;
			/** Every role the plan starts, once each; a council lists each member. */
			tasks: ExtensionDispatchTask[];
			/** Present in compete: how many times the `candidate` runs, each in its own worktree. */
			candidates?: number;
	  }
	| { kind: "list" }
	| { kind: "apply-winner"; branch: string; cwd: string }
	/** A kept task branch, by run id or branch name, that the operator lands from a Land card. */
	| { kind: "land"; ref: string; cwd: string };

/**
 * Facts PanCode resolves for a tool hook, present with `args` (access: tool-args)
 * on PanCode 0.6.3 and later. Earlier hosts send `args` alone, so a hook that
 * needs a fact checks for it and falls back or refuses.
 */
export interface ExtensionToolHookLanding {
	/** Present for a path-taking tool. */
	target?: ExtensionToolTarget;
	/** Present for `dispatch`, once admission parsed the call. */
	dispatch?: ExtensionDispatchCall;
}

/**
 * Who started the turn a prompt_submit, turn_start or turn_end hook sees.
 * `operator` is a prompt the operator submitted; `continuation` is PanCode
 * continuing a turn that stopped (loop guard, tool budget, a failure) under
 * yolo, with `continuation.index` of `continuation.cap`; `job` is a scheduled
 * job's turn; `peer` is a message another agent sent into the session.
 * `template` names the prompt template whose tool scope bounds the turn, and
 * a continuation keeps it.
 */
export type ExtensionTurnOrigin = Omit<TurnOrigin, "lastToolCall">;

/**
 * The last tool call the stopped turn made, on a continuation's prompt_submit
 * (PanCode 0.8.4 and later). `tool` is the tool as before_tool names it,
 * `outcome` how it settled (`unfinished` when the turn stopped before it
 * returned). `args` are redacted and clipped (long strings and arrays cut, with
 * a note of what was), and cross only with `access: tool-args`.
 */
export interface ExtensionContinuationToolCall {
	tool: string;
	/** access: tool-args */
	args?: Record<string, unknown>;
	outcome: "ok" | "error" | "unfinished";
}

/**
 * The model a hook's call or turn runs on, present on every hook event from
 * PanCode 0.8.4: `id` (wire model id), `target`, `contextWindow` (effective
 * tokens, null when unknown), `thinkingLevel` (what requests carry),
 * `promptCaching` (false only when the route turns caching off) and `tier`
 * (`small`, `standard` or `frontier`; the operator's `models.<id>.tier` or
 * PanCode's heuristic). A dispatched worker's tool calls carry the worker's own
 * model. Earlier hosts omit it, so read it as optional.
 */
export type ExtensionModel = Readonly<ModelRunInfo>;

/** Present on every hook event when the host knows the model; see {@link ExtensionModel}. */
export interface ExtensionHookModel {
	model?: ExtensionModel;
}

export type ExtensionHookEvent = (
	| ({
			point: "prompt_submit";
			/** access: prompt */
			text?: string;
			/** Present on a continuation whose stopped turn made a tool call; never on an operator prompt. */
			lastToolCall?: ExtensionContinuationToolCall;
	  } & ExtensionTurnOrigin)
	| ({
			point: "before_tool";
			tool: string;
			turnId: string | null;
			/** access: tool-args */
			args?: unknown;
	  } & ExtensionToolHookLanding)
	| ({
			point: "after_tool";
			tool: string;
			turnId: string | null;
			outcome: "ok" | "error";
			durationMs: number;
			/** access: tool-args */
			args?: unknown;
			/** access: tool-results */
			result?: string;
	  } & ExtensionToolHookLanding)
	| ({
			point: "turn_start";
			/** The user turn's id, which this turn's before_tool, after_tool and turn_end carry too. */
			turnId: string;
			/** access: prompt */
			text?: string;
	  } & Partial<ExtensionTurnOrigin>)
	| ({
			point: "turn_end";
			/** The id the same turn's turn_start carried. */
			turnId: string;
			outcome: "completed" | "aborted" | "error";
			/** access: assistant-text */
			text?: string;
	  } & Partial<ExtensionTurnOrigin>)
) &
	ExtensionHookModel;

/**
 * Effects an awaited hook may return. Each applies only at the points the
 * middleware table allows; one returned elsewhere is refused at load. A
 * rewritten input is validated against the tool schema and classified again,
 * so an effect can narrow or redirect a call and never widen its authority.
 */
export type ExtensionEffect =
	| { kind: "block_tool"; reason: string }
	| { kind: "annotate_tool_result"; message: string; severity?: "info" | "warn" }
	| { kind: "inject_reminder"; message: string; severity?: "info" | "advisory" | "warn"; audience?: "model" }
	/**
	 * `toolName` is the name the model calls. For this package's own tool that
	 * is `extension_<id>__<name>`, and the manifest must list the tool under
	 * `runtime.promote`: only a schema attached to the request can be the
	 * provider's tool choice.
	 */
	| { kind: "require_tool"; toolName: string }
	| { kind: "lock_tools" }
	| { kind: "notify_operator"; message: string; key: string }
	| { kind: "protect_path"; path: string; reason: string }
	| { kind: "request_continuation"; message: string; note?: string }
	| { kind: "rewrite_tool_input"; args: Record<string, unknown>; reason: string }
	| { kind: "rewrite_prompt"; text: string; reason: string }
	| { kind: "block_prompt"; reason: string }
	/**
	 * The extension's one pinned context block for the session, at most 8 KB
	 * of UTF-8: durable state the model keeps in view through compaction. A
	 * new value replaces the old one; empty text clears it. Workers never
	 * receive it.
	 */
	| { kind: "pin_context"; text: string };

export type ExtensionEffectKind = ExtensionEffect["kind"];

export interface ExtensionToast {
	text: string;
	tone?: ExtensionTone;
}

export interface ExtensionPanelV2 {
	title: string;
	meta?: string;
	view: View;
}

/** A floating framed card. `key` is stable across updates so the host can keep its place. */
export interface ExtensionIsland {
	key: string;
	title: string;
	meta?: string;
	tone?: ViewTone;
	view: View;
}

/**
 * `initial` is a draft the operator still has to submit; it never answers a
 * question by itself. Option values and labels are unique within a question,
 * because the overlay reports a selection by its label.
 */
export interface InterviewQuestion {
	id: string;
	label: string;
	help?: string;
	kind: "single" | "multi" | "text";
	options?: Array<{ value: string; label: string; detail?: string }>;
	initial?: string | string[];
	/**
	 * The checkpoint this question settles, in the extension's own id. A
	 * headless `pancode run --answers` file answers the question by it
	 * (`id: <checkpoint>`); the operator never sees it.
	 */
	checkpoint?: string;
}

export interface InterviewStep {
	key: string;
	title?: string;
	/** Context shown above the questions. Display only: its actions are not pressable here. */
	intro?: View;
	questions: InterviewQuestion[];
}

/** `id` names the registered interview handler that receives each step's answers. */
export interface Interview {
	id: string;
	title: string;
	/** Step count for the position strip, when known ahead. */
	total?: number;
	step: InterviewStep;
}

/**
 * `answers` maps each question id to its value: the chosen option `value`
 * (`string[]` for `multi`), or the typed text for a `text` question. When the
 * operator typed text beside chosen options, the option value stays in
 * `answers` and the text arrives in `notes` under the same id. When the
 * operator typed free text instead of choosing ("Other"), `answers` carries
 * that text and `other` marks the id.
 */
export interface InterviewAnswer {
	id: string;
	step: string;
	answers: Record<string, string | string[]>;
	/** Text the operator attached to chosen options, by question id. */
	notes?: Record<string, string>;
	/** Question ids answered with free text that names no offered option. */
	other?: Record<string, true>;
	/** `back` is reserved: the overlay cannot return to a resolved step yet, so the host never sends it. */
	nav: "next" | "back" | "cancel";
	/**
	 * Set with `nav: "cancel"` when no operator could answer. `unscripted` is a
	 * headless run whose `--answers` file has no entry for a question of this
	 * step; that run ends without answering it.
	 */
	reason?: "operator" | "headless" | "preempted" | "unscripted";
	/**
	 * Set with `nav: "next"` when the operator's answers to this step were
	 * written ahead in a `pancode run --answers` file: the file, and by
	 * question id the entry of it that matched. Absent on a live answer.
	 */
	scripted?: { file: string; rules: Record<string, string> };
}

/**
 * A tool's interview ends with `done`. `pipelineDone: true` there marks the
 * last step of a step pipeline, as a tool result's `pipelineDone` does, so a
 * step gated by an approval interview can still end the chain.
 */
export type InterviewNext =
	| { step: InterviewStep; total?: number }
	| ({ done: true; pipelineDone?: boolean } & ExtensionOutputV2);

/**
 * What a handler returns. `text` is always the headless fallback. The fields
 * in the last group are honored only from a command or an action (and
 * `interview` also from a tool): a background handler cannot open a panel,
 * take the screen, start an interview or touch the prompt.
 */
export interface ExtensionOutputV2 {
	text: string;
	status?: ExtensionStatus | null;
	band?: View | null;
	card?: View;
	toast?: ExtensionToast;
	/** Updates an open panel from any handler; opens one only from a command or an action. */
	panel?: ExtensionPanelV2;
	dock?: View | null;
	/** Drawn only while one of this extension's workspaces is active. */
	regions?: Partial<Record<WorkspaceRegion, View | null>>;
	islands?: ExtensionIsland[] | null;

	workspace?: { enter: string } | { leave: true };
	interview?: Interview;
	prompt?: { fill: string } | { submit: string };
	/** A command's exit status, 0-125, used as the process exit code when the command runs as a `pancode <verb>`. */
	exitCode?: number;
}

export interface ExtensionHookResult {
	effects?: ExtensionEffect[];
	ui?: Omit<ExtensionOutputV2, "text" | "workspace" | "interview" | "prompt">;
}

/** A tool that returns `interview` parks until the operator finishes it; the answers become the result. */
export interface ExtensionToolResult {
	text: string;
	/**
	 * A short form the model sees in place of `text` and `data`, at most 2048 bytes. The host stores the full result
	 * for the session and gives the model a `detail_ref` it fetches with `ledger(action="detail", ref=...)`.
	 */
	summary?: string;
	data?: unknown;
	isError?: boolean;
	/**
	 * A `turnPolicy: step` template's step tool says its pipeline has no step left, so a yolo turn that ran this
	 * step does not continue into another step turn. Honored only on a result that is not an error.
	 */
	pipelineDone?: boolean;
	card?: View;
	interview?: Interview;
}

export interface ExtensionUiAction {
	id: string;
	/** Row, card or node key when the press came from a table, list, board or tree. */
	key?: string;
	source: "band" | "card" | "panel" | "dock" | "header" | "board" | "island" | "footer" | "leader" | "key";
}

export interface ExtensionKeyValue {
	get<T = unknown>(key: string): Promise<{ value: T | undefined; version: number }>;
	/** With `ifVersion`, the write lands only when the stored version still matches. */
	set(key: string, value: unknown, options?: { ifVersion?: number }): Promise<{ ok: boolean; version: number }>;
	delete(key: string): Promise<void>;
	keys(): Promise<string[]>;
}

export interface ExtensionEmbeddingRequest {
	inputs: readonly EmbeddingInput[];
	task: EmbeddingTask;
	/** Reject if the live profile differs from the one used for saved vectors. */
	expectedProfileIdentity?: string;
}

/** Text only: no tools, images, streaming or thinking. */
export interface ExtensionCompletionRequest {
	system?: string;
	/** Oldest first; the last one is normally the user's. */
	messages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
	/** At most the manifest's `maxOutputTokens`, which is also the default. */
	maxOutputTokens?: number;
	/** 0 to 2. APIs that cannot apply it ignore it. */
	temperature?: number;
}

export interface ExtensionCompletion {
	text: string;
	stopReason: "stop" | "length";
	/** What the provider reported; zero when it reported nothing, and the reservation was spent instead. */
	usage: { inputTokens: number; outputTokens: number };
}

export interface ExtensionBlobInfo {
	bytes: number;
	modifiedMs: number;
}

/** The PanCode store, limited to the tags the operator approved. A missing tag is never created. */
export interface ExtensionBlobs {
	/** Names sorted; `pattern` is a regular expression matched against the whole name. `limit` defaults to 100, at most 500. */
	list(
		tag: string,
		options?: { pattern?: string; prefix?: string; offset?: number; limit?: number },
	): Promise<{ names: string[]; hasMore: boolean }>;
	/** `null` when the blob does not exist. */
	stat(tag: string, blob: string): Promise<ExtensionBlobInfo | null>;
	/** The blob's bytes, at most 192 KiB; a larger blob is refused. `null` when the blob does not exist. */
	get(tag: string, blob: string): Promise<Uint8Array | null>;
	/**
	 * Copy a file into the store and record who put it. `sourcePath` must lie in a root the package may read.
	 * Refused in a read-only session and outside a run's granted tags.
	 */
	put(
		tag: string,
		blob: string,
		sourcePath: string,
		options?: { note?: string },
	): Promise<{ bytes: number; sha256: string }>;
}

/** `closed` once the program exits or the host closes it; `hidden` keeps the program running out of sight. */
export type ExtensionPaneState = "visible" | "hidden" | "closed";
/** `replaced`: another extension's pane or the View dock took the shared slot. */
export type ExtensionPaneChangeReason = "opened" | "hidden" | "revealed" | "closed" | "exited" | "replaced";

export interface ExtensionPaneOpenRequest {
	/** A binary from `runtime.binaries`. */
	binary: string;
	args?: string[];
	/** Only keys the binary declares in `env`. */
	env?: Record<string, string>;
	/** Plain text, at most 40 characters; the binary's name by default. */
	title?: string;
	/** Rows the pane keeps however small its share, 1 to 24. */
	rows?: number;
	/** Fraction of the window's height, above 0 and at most 0.5. */
	share?: number;
	/** Start parked out of sight, with the program running. */
	hidden?: boolean;
	/**
	 * A store-relative file the program appends a line to; each line presses `action`
	 * as `source: "dock"`, and a second line within 400 ms arrives as `key: "double"`.
	 */
	tap?: { file: string; action: string };
}

/** Colors for the background PanCode detected, as `#rrggbb`, so a pane program can match the theme. */
export interface ExtensionPanePalette {
	background: "dark" | "light" | null;
	accent: string;
	strong: string;
	text: string;
	low: string;
	mid: string;
	high: string;
}

/**
 * One terminal pane in the dock below PanCode, running a declared binary. It
 * shares its slot with the View dock and every other extension's pane, so
 * opening one closes the others. Each change arrives as `pane_changed`.
 */
export interface ExtensionPane {
	/** Opens the pane, or answers its state when it is already open. Throws the reason it cannot. */
	open(request: ExtensionPaneOpenRequest): Promise<ExtensionPaneState>;
	close(): Promise<ExtensionPaneState>;
	hide(): Promise<ExtensionPaneState>;
	reveal(): Promise<ExtensionPaneState>;
	state(): Promise<ExtensionPaneState>;
	palette(): Promise<ExtensionPanePalette>;
}

export interface ExtensionBinaryRunResult {
	/** Null when the program was stopped by a signal or the timeout. */
	exitCode: number | null;
	timedOut: boolean;
	/** At most 64 KiB each. */
	stdout: string;
	stderr: string;
}

/** The programs in `runtime.binaries`, run by the host outside the sandbox, in the store directory, with no shell. */
export interface ExtensionBinaries {
	run(
		name: string,
		args?: string[],
		options?: { env?: Record<string, string>; timeoutMs?: number },
	): Promise<ExtensionBinaryRunResult>;
}

export interface ExtensionContextV2 {
	readonly snapshot: Readonly<ExtensionRuntimeSnapshotV2>;
	readonly requestId: string;
	readonly signal: AbortSignal;
	/** Values of the manifest's `config` fields, defaults filled in. */
	readonly options: Readonly<Record<string, string | number | boolean>>;
	/** This session. Survives a reload and a restart that resumes the session. */
	readonly state: ExtensionKeyValue;
	/** This extension, across sessions on this machine. */
	readonly store: ExtensionKeyValue;
	/** Present only when runtime.services.embedding is declared and approved. Uses PanCode's configured profile. */
	readonly embed?: (request: ExtensionEmbeddingRequest) => Promise<EmbeddingResponse>;
	/**
	 * Present only when runtime.services.model is declared and approved. Runs on the model the operator
	 * assigned with `pancode extensions services`, inside the declared session budget, and only while this
	 * request is live. Fleet worker hooks never receive it.
	 */
	readonly complete?: (request: ExtensionCompletionRequest) => Promise<ExtensionCompletion>;
	/** Present only when runtime.services.store is declared and approved. Fleet worker hooks never receive it. */
	readonly blobs?: ExtensionBlobs;
	/** Absolute path of the files directory `permissions.fs.write: [store]` opens; absent without it. */
	readonly storeDir?: string;
	/**
	 * Present when runtime.binaries is declared, in a host that runs them. Runs only from a command, an action or a
	 * tool call, never in a read-only turn; elsewhere a call throws the reason.
	 */
	readonly binaries?: ExtensionBinaries;
	/**
	 * Present when runtime.services.pane is declared, in a host with a pane dock: an interactive session inside herdr.
	 * Acts only from a command, an action or a tool call, never in a read-only turn; elsewhere a call throws the reason.
	 */
	readonly pane?: ExtensionPane;
	/** Present in a command or an action when runtime.services.runs is declared and approved. */
	readonly runs?: ExtensionRuns;
	/** Present in a command or an action when runtime.services.worktrees is declared and approved. */
	readonly worktrees?: ExtensionWorktrees;
	/** Present in a command or an action when runtime.services.verify is declared and approved. */
	readonly verify?: ExtensionVerify;
	/** Present in a command or an action when runtime.services.claims is declared and approved. */
	readonly claims?: ExtensionClaims;
	/**
	 * Present in a `long` command: one line of what it is doing, shown in place of the previous line (on stderr under
	 * `pancode <verb>`). At most 200 characters; lines closer together than a quarter second are coalesced.
	 */
	readonly progress?: (text: string) => void;
}

type MaybePromise<T> = T | Promise<T>;

export interface ExtensionApiV2 {
	readonly apiVersion: 2;
	/** A slash command: `/ext:<id>:<name>`, also `/<plugin>:<name>` with `replaces: prompt` while the served plugin is in effect. */
	handle(name: string, handler: (args: string, context: ExtensionContextV2) => MaybePromise<ExtensionOutputV2>): void;
	/** Passive observation. It cannot block or rewrite. */
	on(
		event: ExtensionObservationEventV2,
		handler: (event: ExtensionObservationV2, context: ExtensionContextV2) => MaybePromise<ExtensionOutputV2 | undefined>,
	): void;
	/** Awaited hook under the deadline and failure mode the manifest declares. */
	hook(
		point: ExtensionHookPoint,
		handler: (event: ExtensionHookEvent, context: ExtensionContextV2) => MaybePromise<ExtensionHookResult>,
	): void;
	/** A gateway tool this runtime serves, reached as `extension_<id>__<name>`. */
	tool(name: string, handler: (input: unknown, context: ExtensionContextV2) => MaybePromise<ExtensionToolResult>): void;
	/** A press on something the host drew for this extension. */
	action(
		id: string,
		handler: (event: ExtensionUiAction, context: ExtensionContextV2) => MaybePromise<ExtensionOutputV2>,
	): void;
	interview(
		id: string,
		handler: (event: InterviewAnswer, context: ExtensionContextV2) => MaybePromise<InterviewNext>,
	): void;
	onDispose(handler: (reason: string) => void | Promise<void>): void;
}

export type ExtensionFactoryV2 = (api: ExtensionApiV2) => void | Promise<void>;

/**
 * A workspace's skin file. Palette keys are PanCode palette color names; each
 * override gives the value for a dark and a light terminal background. The
 * host refuses overrides of the error, warning and approval colors and any
 * value below a 4.5 contrast ratio against its background.
 */
export interface ExtensionSkin {
	palette?: Record<string, { dark: string; light: string }>;
	glyphs?: { brand?: string };
	/** How this package's own agent recipes are named on its islands. */
	agents?: Record<string, { label?: string; glyph?: string }>;
}
