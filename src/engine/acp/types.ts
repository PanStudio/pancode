// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import type { Static } from "typebox";
import { Type } from "typebox";
import { PricedByCountsSchema, QuantitySchema, TurnQuantitiesSchema } from "../../core/telemetry/dto.js";
import { MAX_TIMER_DELAY_MS } from "../../core/timers.js";
import type { ACP_V1_TOOL_CALL_STATUSES } from "./upstream-schema.js";

/**
 * ACP extensibility reserves `_meta` for non-spec data. PanCode namespaces its
 * extensions so a strict client (Zed/serde) never sees an unknown top-level
 * field on a standard response.
 */
export const ACP_USAGE_META_KEY = "pancode/usage";
export const ACP_SESSION_META_KEY = "pancode/session";
/**
 * Per-frame agent attribution on `session/update`. It names which agent
 * produced the frame so a client can label a message, reasoning item, or tool
 * call instead of attributing every frame to the product. Purely additive: a
 * client that does not read it sees exactly the frames it saw before.
 */
export const ACP_AGENT_META_KEY = "pancode/agent";
/**
 * Opt-in key for non-terminal `tool_call_update` frames carrying a running
 * tool's cumulative output. It is an opt-in and not a default because a client
 * that renders every frame it receives without collapsing repeated updates for
 * one call would redraw the whole tool segment several times a second.
 */
export const ACP_TOOL_PROGRESS_META_KEY = "pancode/toolProgress";
/**
 * Decision facts attached to `session/request_permission`. The server already
 * classifies the ask to pick the option labels; without this the tier, the
 * consequence, and the reversibility it computed are discarded and a client is
 * left re-deriving them from a tool name.
 */
export const ACP_DECISION_META_KEY = "pancode/decision";
/**
 * Operator-command catalog and invocation. The names live here, in the leaf
 * that holds every other wire constant, rather than beside the projection in
 * `./commands.js`: that module value-imports the whole slash registry, and the
 * ACP server may not drag the registry's closure into the Stage 0 chunk budget
 * just to know what a method is called (rule6, tests/boundaries).
 */
export const ACP_COMMANDS_META_KEY = "pancode/commands";
export const ACP_COMMANDS_LIST_METHOD = "_pancode/commands/list";
export const ACP_COMMANDS_INVOKE_METHOD = "_pancode/commands/invoke";
/** `_meta["pancode/prompt"]` on a prompt template's command row: the marks the terminal's palette shows on it. */
export const ACP_PROMPT_META_KEY = "pancode/prompt";
/**
 * Attended-surface opt-ins. A client that advertises one at initialize says a
 * person is there to answer, which is the only thing that makes the runtime
 * ask. A client that advertises neither keeps the unattended behavior: no
 * `ask_user` tool, no merge card, worker permission asks denied at once.
 * The interview names live in this leaf for the reason the commands names do.
 */
export const ACP_INTERVIEWS_META_KEY = "pancode/interviews";
export const ACP_INTERVIEW_REQUEST_METHOD = "_pancode/interview/request";
export const ACP_INTERVIEW_CANCEL_METHOD = "_pancode/interview/cancel";
/**
 * MCP elicitation for a client that opted in with `pancode/elicitation`: an
 * MCP server's form or link, put to the person at the client. The interviews
 * opt-in alone does not carry it, because what is typed here goes to a server
 * and not to PanCode.
 */
export const ACP_ELICITATION_META_KEY = "pancode/elicitation";
export const ACP_ELICITATION_REQUEST_METHOD = "_pancode/elicitation/request";
export const ACP_ELICITATION_CANCEL_METHOD = "_pancode/elicitation/cancel";
/**
 * `_meta` of every interview request: `{version: 1, operatorOnly, recommended?}`. An
 * `operator_only` round is the operator's own choice, which no agent or policy
 * may answer for them and which closes unanswered when its window passes, so a
 * client labels that card the way the TUI does. `recommended` has one entry per
 * wire question: the index into that question's `options` the host recommends
 * (the harness's preselected option, else the one an absent operator gets), or
 * null for a question without options. It rides in `_meta` and not on the
 * option because a client that validates the question shape closed would refuse
 * an unknown option field.
 */
export const ACP_INTERVIEW_META_KEY = "pancode/interview";
/**
 * The longest request window a client may negotiate with `timeoutMs` in the
 * `pancode/interviews` or `pancode/workerPermissions` opt-in: Node's
 * timer ceiling, the same bound `pancode acp --permission-timeout` takes.
 */
export const ACP_MAX_NEGOTIATED_TIMEOUT_MS = MAX_TIMER_DELAY_MS;
/**
 * `pancode/workerPermissions` asks the host to forward a dispatched worker's
 * permission ask as `session/request_permission`. The client must also name the
 * notification it takes a withdrawn ask on, because the wire has no way to cancel
 * one request: an ask the worker already gave up on would otherwise sit on the
 * client and refuse the next real approval.
 */
export const ACP_WORKER_PERMISSIONS_META_KEY = "pancode/workerPermissions";
export const ACP_PERMISSION_WITHDRAW_METHOD = "_pancode/permission/withdraw";
/** Provenance a forwarded worker ask carries beside the decision facts. */
export const ACP_WORKER_ASK_META_KEY = "pancode/workerAsk";
/**
 * `{version: 1, requestId}` on a main-session `session/request_permission`,
 * sent only to a client that opted into `pancode/workerPermissions`. The
 * withdraw notification names this `requestId` when the host abandons the ask
 * (its window closed, the prompt was cancelled, or the call was settled
 * elsewhere), so the client can close the card it still shows.
 */
export const ACP_PERMISSION_ASK_META_KEY = "pancode/permissionAsk";

/**
 * Every other `_pancode/*` method, notification and `_meta` key. The feature
 * modules re-export the names they own, so a client in another process (the GUI
 * server and its browser bundle) can import this leaf alone and never spell a
 * wire name of its own.
 */
export const ACP_ERROR_META_KEY = "pancode/error";
export const ACP_REPLAY_META_KEY = "pancode/replay";
export const ACP_NOTICE_META_KEY = "pancode/notice";
export const ACP_EGGS_META_KEY = "pancode/eggs";
/** `{ state }` of the always-on memory guardian, pushed on `session_info_update` when it changes. */
export const ACP_MEMORY_META_KEY = "pancode/memory";
/**
 * Beside `_meta["pancode/notice"]` on the chunk that reports an operator
 * memory capture ("remember that ...", `# ...`, `/remember`):
 * `{ version: 1, captureId, action: "remembered" | "forgot" | "undone" | "refused", scope?: "session" | "project" | "global", kind?, text }`.
 * A client draws the chip from it; its actions are `remember scope <scope> <captureId>` and `remember undo <captureId>`
 * through `_pancode/commands/invoke`.
 */
export const ACP_MEMORY_CAPTURE_META_KEY = "pancode/memory-capture";
export const ACP_TURN_META_KEY = "pancode/turn";
/**
 * `{ durationMs }` on a terminal `tool_call_update`: the engine's own span for
 * the call, admission wait excluded, live and on replay when the ledger
 * recorded it. Purely additive: a client that does not read it sees exactly
 * the frames it saw before.
 */
export const ACP_TOOL_TIMING_META_KEY = "pancode/toolTiming";
export const ACP_TRUNCATED_META_KEY = "pancode/truncated";
export const ACP_TOOLS_META_KEY = "pancode/tools";
export const ACP_RUN_RESULT_META_KEY = "pancode/run-result";
export const ACP_DISPATCH_PLAN_META_KEY = "pancode/dispatchPlan";
export const ACP_WORKSPACE_META_KEY = "pancode/workspace";
export const ACP_PLAN_META_KEY = "pancode/plan";
export const ACP_TRUST_META_KEY = "pancode/trust";
/**
 * A session cost ceiling stop. It rides on the `agent_message_chunk` that
 * carries the stop's notice text, live while the prompt waits and again on
 * replay, so a client can offer the raise instead of showing a silent turn (#424).
 */
export const ACP_BUDGET_META_KEY = "pancode/budget";
/**
 * A client's enforced capability ceiling: `params._meta` on `session/new` (the
 * whole session) and `session/prompt` (that prompt), echoed as applied on both
 * responses. It only narrows the limits the operator started `acp` with.
 */
export const ACP_CEILING_META_KEY = "pancode/ceiling";
/** Every field a client ceiling may carry; any other key refuses the request. */
export const ACP_CEILING_FIELDS = ["allowedTools", "delegatedTools", "delegation", "readOnly"] as const;
export const ACP_SESSION_TRUST_METHOD = "_pancode/session/trust";
export const ACP_SESSION_LABEL_METHOD = "_pancode/session/label";
export const ACP_SESSION_LIST_METHOD = "session/list";
export const ACP_SETTINGS_META_KEY = "pancode/settings";
export const ACP_SETTINGS_GET_SAFE_METHOD = "_pancode/settings/get_safe";
export const ACP_SETTINGS_PATCH_SAFE_METHOD = "_pancode/settings/patch_safe";
export const ACP_TARGETS_META_KEY = "pancode/targets";
export const ACP_TARGETS_LIST_METHOD = "_pancode/targets/list";
export const ACP_TARGETS_PROBE_METHOD = "_pancode/targets/probe";
export const ACP_STEERING_META_KEY = "pancode/steering";
export const ACP_SESSION_STEER_METHOD = "_pancode/session/steer";
export const ACP_SESSION_QUEUE_METHOD = "_pancode/session/queue";
export const ACP_SESSION_QUEUE_CLEAR_METHOD = "_pancode/session/queue_clear";
export const ACP_SESSION_INTERRUPT_METHOD = "_pancode/session/interrupt";
export const ACP_DISPATCH_STEER_METHOD = "_pancode/dispatch/steer";
export const ACP_QUEUE_META_KEY = "pancode/queue";
export const ACP_QUEUE_EDIT_METHOD = "_pancode/session/queue_edit";
export const ACP_QUEUE_CHANGED_NOTIFICATION = "_pancode/session/queue_changed";
export const ACP_SHELL_META_KEY = "pancode/shell";
export const ACP_SESSION_SHELL_METHOD = "_pancode/session/shell";
export const ACP_EVENTS_META_KEY = "pancode/events";
export const ACP_EVENT_NOTIFICATION = "_pancode/event";
export const ACP_BOARD_META_KEY = "pancode/board";
export const ACP_BOARD_METHOD = "_pancode/session/board";
export const ACP_DECISION_SUPERSEDE_METHOD = "_pancode/decisions/supersede";
export const ACP_MEMORY_PROPOSE_METHOD = "_pancode/memory/propose";
export const ACP_BRANCHES_META_KEY = "pancode/branches";
export const ACP_SESSION_TREE_METHOD = "_pancode/session/tree";
export const ACP_SESSION_SWITCH_TURN_METHOD = "_pancode/session/switch_turn";
export const ACP_SESSION_FORK_METHOD = "_pancode/session/fork";
/** The session's model choices, for a client that picks the model through {@link ACP_SESSION_SET_MODEL_METHOD}. */
export const ACP_MODELS_META_KEY = "pancode/models";
export const ACP_SESSION_SET_MODEL_METHOD = "_pancode/session/set_model";
/** The supported model's thinking levels on a `model` config option value. */
export const ACP_THINKING_LEVELS_META_KEY = "pancode/thinkingLevels";
/** `session/cancel` as a request, for a client that waits for the stop to be acknowledged. */
export const ACP_SESSION_CANCEL_METHOD = "_pancode/session/cancel";
export const ACP_SNAPSHOTS_META_KEY = "pancode/snapshots";
export const ACP_SNAPSHOTS_LIST_METHOD = "_pancode/session/snapshots";
export const ACP_SNAPSHOT_PREVIEW_METHOD = "_pancode/session/snapshot_preview";
export const ACP_SNAPSHOT_RESTORE_METHOD = "_pancode/session/snapshot_restore";
export const ACP_HANDOFF_META_KEY = "pancode/handoff";
export const ACP_HANDOFF_PREPARE_METHOD = "_pancode/session/handoff/prepare";
export const ACP_HANDOFF_COMMIT_METHOD = "_pancode/session/handoff/commit";
export const ACP_HANDOFF_CANCEL_METHOD = "_pancode/session/handoff/cancel";
export const ACP_JOBS_META_KEY = "pancode/jobs";
export const ACP_JOBS_LIST_METHOD = "_pancode/jobs/list";
export const ACP_FLEET_META_KEY = "pancode/fleet";
export const ACP_FLEET_PREVIEW_METHOD = "_pancode/fleet/preview";
export const ACP_FLEET_RUN_METHOD = "_pancode/fleet/run";
export const ACP_CONTEXT_META_KEY = "pancode/context";
export const ACP_CONTEXT_LEDGER_METHOD = "_pancode/context/ledger";
export const ACP_ARTIFACTS_META_KEY = "pancode/artifacts";
export const ACP_ARTIFACTS_LIST_METHOD = "_pancode/artifacts/list";
export const ACP_ARTIFACTS_READ_METHOD = "_pancode/artifacts/read";
export const ACP_EXTENSIONS_META_KEY = "pancode/extensions";
export const ACP_EXTENSIONS_LIST_METHOD = "_pancode/extensions/list";
export const ACP_EXTENSIONS_RELOAD_METHOD = "_pancode/extensions/reload";
export const ACP_HUB_META_KEY = "pancode/hub";
export const ACP_HUB_RELOAD_METHOD = "_pancode/hub/reload";
export const ACP_ASIDE_META_KEY = "pancode/aside";
export const ACP_ASIDE_ASK_METHOD = "_pancode/aside/ask";
export const ACP_ASIDE_DRAFT_METHOD = "_pancode/aside/draft";
export const ACP_ASIDE_CANCEL_METHOD = "_pancode/aside/cancel";
/** `_pancode/telemetry/*`: the telemetry read model's DTOs, every quantity `{fact, display, ref}` (#434 §11.3). */
export const ACP_TELEMETRY_META_KEY = "pancode/telemetry";
export const ACP_TELEMETRY_METHODS = {
	session: "_pancode/telemetry/session",
	calls: "_pancode/telemetry/calls",
	cost: "_pancode/telemetry/cost",
	cache: "_pancode/telemetry/cache",
	timeline: "_pancode/telemetry/timeline",
	run: "_pancode/telemetry/run",
	runs: "_pancode/telemetry/runs",
	quota: "_pancode/telemetry/quota",
	health: "_pancode/telemetry/health",
	whyStopped: "_pancode/telemetry/why_stopped",
	explain: "_pancode/telemetry/explain",
} as const;
/** A coalesced `telemetry_update` notice, at most 10 Hz and never per token; a client re-reads the topics it shows. */
export const ACP_TELEMETRY_UPDATE_NOTIFICATION = "_pancode/telemetry/update";

/** Every thinking level a safe-settings patch or the `thinkingLevel` config option may name, weakest first. */
export const ACP_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AcpThinkingLevel = (typeof ACP_THINKING_LEVELS)[number];

/** Wire bounds on `_pancode/targets/list`: targets per response and model ids per target. */
export const ACP_MAX_TARGETS = 64;
export const ACP_TARGET_MODEL_LIMIT = 64;
export const ACP_MAX_TARGET_ID_BYTES = 128;
export const ACP_MAX_MODEL_ID_BYTES = 256;

/**
 * Wire bounds for one prompt turn (CONTRACT C001 §3). A client renders every
 * frame it receives, so an unbounded one is a denial-of-service on the client
 * and a disclosure surface on the server: `rawInput` for a `write` carries the
 * whole file body and for `bash` the whole command line.
 *
 * Every cap is UTF-8 bytes, which is what the peer's read buffer and any
 * intermediary actually spend. `String.length` counts UTF-16 code units, so
 * measuring with it let a chunk of CJK text reach three times its stated bound
 * and a chunk of emoji twice.
 */
export const ACP_MAX_STRING_BYTES = 4096;
export const ACP_MAX_RAW_RECORD_BYTES = 32768;
export const ACP_MAX_CHUNK_BYTES = 16384;

/**
 * The one raw-record string the generic 4 KiB cap actively harmed. `edit` and
 * `write` put a rendered unified diff on `details.diff`, already capped by the
 * engine's own `MAX_DIFF_BYTES` (32 KiB, `src/tools/edit-diff.ts`). At four
 * context lines and roughly 60 bytes a line, 4 KiB is about 65 diff lines, so a
 * multi-hunk refactor arrived cut mid-hunk and a client could not tell a
 * truncated hunk from a hunk that ended there.
 *
 * It sits below {@link ACP_MAX_RAW_RECORD_BYTES} rather than at it because the
 * record cap elides the WHOLE record when it trips: a diff sized at exactly the
 * record bound would serialize past it once JSON escaping and the rest of the
 * result are counted, and the client would have received `{truncated:true}`
 * instead of the 4 KiB it used to get. The reserve is one
 * {@link ACP_MAX_STRING_BYTES} budget for everything else in the record.
 */
export const ACP_MAX_RAW_DIFF_BYTES = ACP_MAX_RAW_RECORD_BYTES - ACP_MAX_STRING_BYTES;

/**
 * Per-call ceiling on non-terminal tool-progress frames. The tool's own
 * throttle bounds the rate, not the total: a build that prints for ten minutes
 * is a bounded stream of unbounded length, and a client holding per-call state
 * has to be told where the stream stops.
 */
export const ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL = 64;

/**
 * Floor between two progress frames for one call, on top of the 100 ms throttle
 * `src/core/bash-exec.ts` already applies upstream. The upstream throttle is a
 * rendering budget for a terminal that redraws in place; a JSON-RPC peer pays
 * serialization and a full segment re-render per frame, so the wire gets its
 * own, slower floor.
 */
export const ACP_MIN_TOOL_PROGRESS_INTERVAL_MS = 250;

/**
 * Upper bound on a `toolCallId` this server puts on the wire, in UTF-8 bytes
 * (CONTRACT C001 §3). Identity is one call per id in both directions: an engine
 * id over this bound, missing, or already claimed by another call this turn
 * travels under a `pancode-tool-<n>` alias, and an engine id starting a second call
 * mints a fresh alias rather than reusing the first call's wire id. A permission
 * request binds only to an id the client already received a `tool_call` for and
 * has not yet seen finish; nothing is minted on that path.
 */
export const ACP_MAX_TOOL_CALL_ID_BYTES = 128;

/** ACP v1 `ToolKind` closed enum (schema v1.23.0). */
export type AcpToolKind =
	| "read"
	| "edit"
	| "delete"
	| "move"
	| "search"
	| "execute"
	| "think"
	| "fetch"
	| "switch_mode"
	| "other";

/** ACP v1 `ToolCallStatus` closed enum (schema v1.23.0). */
/**
 * A tool call status PanCode sends, held to the pinned upstream v1 list: v1 has no `cancelled`, so a cancelled call
 * goes out as `failed` with the reason in its content.
 */
export type AcpToolCallStatus = (typeof ACP_V1_TOOL_CALL_STATUSES)[number];

export interface AcpJsonRpcRequest {
	jsonrpc: "2.0";
	id: string | number;
	method: string;
	params?: unknown;
}

export interface AcpJsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface AcpJsonRpcSuccess {
	jsonrpc: "2.0";
	id: string | number;
	result: unknown;
}

export interface AcpJsonRpcFailure {
	jsonrpc: "2.0";
	id: string | number | null;
	error: {
		code: number;
		message: string;
		data?: unknown;
	};
}

export type AcpJsonRpcMessage = AcpJsonRpcRequest | AcpJsonRpcNotification | AcpJsonRpcSuccess | AcpJsonRpcFailure;

export interface AcpImplementationInfo {
	name?: string;
	title?: string;
	version?: string;
}

export interface AcpAuthMethod {
	id: string;
	name: string;
	description?: string;
	type: "agent" | "terminal";
	args?: string[];
	env?: Record<string, string>;
}

export interface AcpInitializeResponse {
	protocolVersion: number;
	agentCapabilities?: Record<string, unknown>;
	agentInfo?: AcpImplementationInfo;
	authMethods?: AcpAuthMethod[];
}

export interface AcpSessionInfo {
	sessionId: string;
	cwd: string;
	title?: string;
	updatedAt?: string;
	_meta?: Record<string, unknown>;
}

export interface AcpContentText {
	type: "text";
	text: string;
}

export interface AcpContentResourceLink {
	type: "resource_link";
	uri: string;
	name: string;
	mimeType?: string;
}

export type AcpContentBlock = AcpContentText | AcpContentResourceLink | Record<string, unknown>;

/** ACP v1 `ToolCallLocation` (schema v1.23.0). */
export interface AcpToolCallLocation {
	/** The file path being accessed or modified. */
	path: string;
	/** Optional zero-based line number within the file. */
	line?: number | null;
	/** ACP extension point. */
	_meta?: unknown;
}

export interface AcpToolCallUpdate {
	sessionUpdate?: "tool_call" | "tool_call_update";
	toolCallId?: string;
	title?: string;
	kind?: string;
	status?: "pending" | "in_progress" | "completed" | "failed" | "cancelled" | string;
	content?: unknown;
	locations?: AcpToolCallLocation[] | null;
	rawInput?: Record<string, unknown>;
	rawOutput?: Record<string, unknown>;
}

export interface AcpSessionUpdateParams {
	sessionId?: string;
	update?: Record<string, unknown>;
	/** Namespaced extension slot; carries replay and agent-attribution metadata. */
	_meta?: Record<string, unknown>;
}

export type AcpPermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;

export interface AcpPermissionOption {
	optionId: string;
	name?: string;
	kind: AcpPermissionOptionKind;
}

export interface AcpRequestPermissionParams {
	sessionId?: string;
	toolCall?: AcpToolCallUpdate;
	options?: AcpPermissionOption[];
}

export type AcpPermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

export interface AcpRequestPermissionResponse {
	outcome: AcpPermissionOutcome;
}

export interface AcpPromptResponse {
	stopReason?: string;
	usage?: unknown;
	tokenUsage?: unknown;
	_meta?: unknown;
}

/* -------------------------------------------------------------------------- */
/* Extension wire shapes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Shapes a client in another process validates at runtime are TypeBox schemas,
 * declared here once with their static type. The server builds its payloads
 * against the static type and the client checks the same schema, so the two
 * sides cannot drift. Every schema is closed: a client that runs `Value.Clean`
 * first reads a newer engine's extra fields as absent instead of invalid.
 */
export const closed = { additionalProperties: false };
export const wireMethod = Type.String({ maxLength: 128 });

/** A wire value as the server holds it: its constant tables are readonly and serialize the same. */
export type AcpWire<T> =
	T extends ReadonlyArray<infer E>
		? ReadonlyArray<AcpWire<E>>
		: T extends object
			? { readonly [K in keyof T]: AcpWire<T[K]> }
			: T;

export const noControls = "^[^\\u0000-\\u001f\\u007f]+$";

/** A separately installed runtime component, named by its `pancode tools install` id. */
export const AcpRuntimeComponent = Type.Union([Type.Literal("copilot-sdk"), Type.Literal("claude-sdk")]);

/** `_meta["pancode/session"]` on a `session/new`, `session/load`, `session/resume`, fork or handoff result. */
export interface AcpSessionResultMeta {
	sessionId: string;
	target: string | null;
	model: string | null;
	autonomy: string;
	createdAt: string;
	resumed: boolean;
	replayed?: { turns: number; truncated: boolean };
}
/** `_meta["pancode/turn"]` on a `session/prompt` result. */
export interface AcpTurnMeta {
	model?: string;
	target?: string;
	ttftMs?: number;
	outputTokensPerSecond?: number;
}
/** `_meta["pancode/toolTiming"]` on a terminal `tool_call_update`. */
export interface AcpToolTimingMeta {
	durationMs: number;
}
/** `_meta["pancode/replay"]` on a replayed `session/update` frame. */
export interface AcpReplayMeta {
	turn?: number;
	run?: boolean;
	stopReason?: string;
	/** The ledger's time for the request that opened a replayed turn, and for its newest entry. */
	startedAt?: string;
	finishedAt?: string;
}

export const sessionId = Type.String({ minLength: 1, maxLength: 128 });
export const sessionParams = { sessionId };
export const queuedKind = Type.Union([Type.Literal("steer"), Type.Literal("follow-up")]);
export const AcpSessionParams = Type.Object(sessionParams, closed);
export type AcpSessionParams = Static<typeof AcpSessionParams>;

export const AcpEmptyResult = Type.Object({}, closed);
export type AcpEmptyResult = Static<typeof AcpEmptyResult>;

export interface AcpErrorDetail {
	code: string;
	reason?: string;
	/** With reason `component-missing`: the `pancode tools install` id the turn's runtime needs. */
	component?: Static<typeof AcpRuntimeComponent>;
	supported?: number[];
	modelSelection?: {
		code: "model_not_declared";
		targetId: string | null;
		requestedModel: string | null;
		availableModels: string[];
		remedy: string;
	};
}

/**
 * `_meta["pancode/usage"]`: the prompt's operator turns, their workers included, and the session's whole spend, as
 * read-model quantities: each a fact or fact sum beside its canonical display and ref (#434). No plain number stands
 * in for a quantity, so an unknown or partial count never reaches a client as a zero.
 */
const SessionUsageQuantitiesSchema = Type.Object(
	{
		input: QuantitySchema,
		output: QuantitySchema,
		cacheRead: QuantitySchema,
		cacheWrite: QuantitySchema,
		reasoning: QuantitySchema,
		total: QuantitySchema,
		usd: QuantitySchema,
		calls: QuantitySchema,
	},
	closed,
);
export const AcpUsageMetaSchema = Type.Object(
	{
		quantities: Type.Optional(TurnQuantitiesSchema),
		session: Type.Optional(
			Type.Object({ quantities: SessionUsageQuantitiesSchema, pricedBy: PricedByCountsSchema }, closed),
		),
	},
	closed,
);
export type AcpUsageMeta = Static<typeof AcpUsageMetaSchema>;
/** One display string per quantity an object schema names, in its order. */
function displaysOf(schema: { properties: Record<string, unknown> }) {
	return Type.Object(Object.fromEntries(Object.keys(schema.properties).map((key) => [key, Type.String()])), closed);
}
export const TurnUsageDisplaysSchema = displaysOf(TurnQuantitiesSchema);
export const SessionUsageDisplaysSchema = displaysOf(SessionUsageQuantitiesSchema);
/**
 * `_meta["pancode/usage"]` unless the client asked for the full form: each quantity as the read model's display of
 * it, which words an unknown or partial count, so it still never reads as zero. A client that sends
 * `clientCapabilities._meta[ACP_USAGE_META_KEY] = {version: 1}` receives {@link AcpUsageMetaSchema} instead.
 */
export const AcpCompactUsageMetaSchema = Type.Object(
	{
		quantities: Type.Optional(TurnUsageDisplaysSchema),
		session: Type.Optional(Type.Object({ quantities: SessionUsageDisplaysSchema }, closed)),
	},
	closed,
);
export type AcpCompactUsageMeta = Static<typeof AcpCompactUsageMetaSchema>;
export const AcpTurnMetaSchema = Type.Object(
	{
		model: Type.Optional(Type.String({ maxLength: ACP_MAX_MODEL_ID_BYTES })),
		target: Type.Optional(Type.String({ maxLength: ACP_MAX_TARGET_ID_BYTES })),
		ttftMs: Type.Optional(Type.Number({ minimum: 0 })),
		outputTokensPerSecond: Type.Optional(Type.Number({ minimum: 0 })),
	},
	closed,
);
export const AcpToolTimingMetaSchema = Type.Object({ durationMs: Type.Integer({ minimum: 0 }) }, closed);
export const AcpInitializeResultSchema = Type.Object(
	{ protocolVersion: Type.Literal(1) },
	{ additionalProperties: true },
);
export type AcpInitializeResult = Static<typeof AcpInitializeResultSchema>;
export const AcpSessionIdentitySchema = Type.Object({ sessionId }, { additionalProperties: true });
export type AcpSessionIdentity = Static<typeof AcpSessionIdentitySchema>;
export const AcpPromptResultSchema = Type.Object(
	{
		stopReason: Type.Union([
			Type.Literal("end_turn"),
			Type.Literal("cancelled"),
			Type.Literal("max_tokens"),
			Type.Literal("max_turn_requests"),
			Type.Literal("refusal"),
		]),
		_meta: Type.Object(
			{
				[ACP_USAGE_META_KEY]: Type.Union([AcpUsageMetaSchema, AcpCompactUsageMetaSchema]),
				[ACP_TURN_META_KEY]: Type.Optional(AcpTurnMetaSchema),
			},
			{ additionalProperties: true },
		),
	},
	{ additionalProperties: true },
);
export type AcpPromptResult = Static<typeof AcpPromptResultSchema>;
