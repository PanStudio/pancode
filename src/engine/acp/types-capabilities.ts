// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Capability negotiation: each `agentCapabilities._meta` extension PanCode
 * announces at `initialize`, and what a client may announce back.
 */
import type { Static } from "typebox";
import { Type } from "typebox";
import type { ACP_CEILING_FIELDS, ACP_SESSION_TRUST_METHOD, AcpWire } from "./types.js";
import {
	ACP_AGENT_META_KEY,
	ACP_ARTIFACTS_META_KEY,
	ACP_ASIDE_META_KEY,
	ACP_BOARD_META_KEY,
	ACP_BRANCHES_META_KEY,
	ACP_BUDGET_META_KEY,
	ACP_CEILING_META_KEY,
	ACP_COMMANDS_META_KEY,
	ACP_CONTEXT_META_KEY,
	ACP_DECISION_META_KEY,
	ACP_ELICITATION_CANCEL_METHOD,
	ACP_ELICITATION_META_KEY,
	ACP_ELICITATION_REQUEST_METHOD,
	ACP_EVENTS_META_KEY,
	ACP_EXTENSIONS_META_KEY,
	ACP_FLEET_META_KEY,
	ACP_HANDOFF_META_KEY,
	ACP_HUB_META_KEY,
	ACP_INTERVIEW_CANCEL_METHOD,
	ACP_INTERVIEW_REQUEST_METHOD,
	ACP_INTERVIEWS_META_KEY,
	ACP_JOBS_META_KEY,
	ACP_MAX_NEGOTIATED_TIMEOUT_MS,
	ACP_PERMISSION_WITHDRAW_METHOD,
	ACP_QUEUE_META_KEY,
	ACP_SESSION_META_KEY,
	ACP_SETTINGS_META_KEY,
	ACP_SHELL_META_KEY,
	ACP_SNAPSHOTS_META_KEY,
	ACP_STEERING_META_KEY,
	ACP_TARGETS_META_KEY,
	ACP_TOOL_PROGRESS_META_KEY,
	ACP_TOOLS_META_KEY,
	ACP_TRUST_META_KEY,
	ACP_WORKER_PERMISSIONS_META_KEY,
	ACP_WORKSPACE_META_KEY,
	closed,
	wireMethod,
} from "./types.js";
import type { AcpReadoutsCapability } from "./types-readouts.js";
import { ACP_READOUTS_META_KEY } from "./types-readouts.js";

/** `agentCapabilities._meta["pancode/settings"]`. */
export const AcpSettingsCapability = Type.Object({ get_safe: Type.Boolean(), patch_safe: Type.Boolean() }, closed);
export type AcpSettingsCapability = Static<typeof AcpSettingsCapability>;
/** `agentCapabilities._meta["pancode/targets"]`. */
export const AcpTargetsCapability = Type.Object({ list: Type.Boolean(), probe: Type.Boolean() }, closed);
export type AcpTargetsCapability = Static<typeof AcpTargetsCapability>;
export const AcpSteeringCapability = Type.Object(
	{
		version: Type.Literal(1),
		main: Type.Boolean(),
		dispatch: Type.Boolean(),
		modes: Type.Array(Type.String({ maxLength: 32 }), { maxItems: 8 }),
		interrupt: Type.Boolean(),
		methods: Type.Object(
			{ steer: wireMethod, queue: wireMethod, clear: wireMethod, interrupt: wireMethod, dispatch: wireMethod },
			closed,
		),
	},
	closed,
);
export type AcpSteeringCapability = Static<typeof AcpSteeringCapability>;
export const AcpCommandsCapability = Type.Object(
	{
		version: Type.Literal(1),
		list: wireMethod,
		invoke: wireMethod,
		count: Type.Optional(Type.Integer({ minimum: 0 })),
		promptTurns: Type.Optional(Type.Boolean()),
	},
	closed,
);
export type AcpCommandsCapability = Static<typeof AcpCommandsCapability>;
export const AcpToolProgressCapability = Type.Object(
	{
		version: Type.Literal(1),
		minIntervalMs: Type.Integer({ minimum: 0 }),
		maxFramesPerCall: Type.Integer({ minimum: 0 }),
		maxContentBytes: Type.Integer({ minimum: 0 }),
	},
	closed,
);
export type AcpToolProgressCapability = Static<typeof AcpToolProgressCapability>;
/** Per-entry queue operations and the notification that pushes the queue after every change. */
export const AcpQueueCapability = Type.Object(
	{
		version: Type.Literal(1),
		edit: wireMethod,
		ops: Type.Array(Type.String({ maxLength: 32 }), { maxItems: 16 }),
		notification: wireMethod,
	},
	closed,
);
export type AcpQueueCapability = Static<typeof AcpQueueCapability>;
/** The operator's `!` line. `timeoutMs` is how long the engine lets one line run. */
export const AcpShellCapability = Type.Object(
	{ version: Type.Literal(1), run: wireMethod, timeoutMs: Type.Integer({ minimum: 1 }) },
	closed,
);
export type AcpShellCapability = Static<typeof AcpShellCapability>;
export const AcpDecisionCapability = Type.Object(
	{
		version: Type.Literal(1),
		meta: Type.String({ maxLength: 64 }),
		options: Type.Array(Type.String({ maxLength: 128 }), { maxItems: 8 }),
	},
	closed,
);
export type AcpDecisionCapability = Static<typeof AcpDecisionCapability>;
export const AcpEventsCapability = Type.Object(
	{
		version: Type.Literal(1),
		notification: Type.String({ maxLength: 64 }),
		kinds: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 }),
		workspaceInstanceId: Type.String({ maxLength: 128 }),
	},
	closed,
);
export type AcpEventsCapability = Static<typeof AcpEventsCapability>;
export const AcpBoardCapability = Type.Object(
	{
		version: Type.Literal(1),
		method: wireMethod,
		/** Present when the agent accepts the board's two writes. */
		supersede: Type.Optional(wireMethod),
		proposeMemory: Type.Optional(wireMethod),
	},
	closed,
);
export type AcpBoardCapability = Static<typeof AcpBoardCapability>;
export const AcpBranchesCapability = Type.Object(
	{ version: Type.Literal(1), tree: wireMethod, switchTurn: wireMethod, fork: wireMethod },
	closed,
);
export type AcpBranchesCapability = Static<typeof AcpBranchesCapability>;
export const AcpSnapshotsCapability = Type.Object(
	{ version: Type.Literal(1), list: wireMethod, preview: wireMethod, restore: wireMethod },
	closed,
);
export type AcpSnapshotsCapability = Static<typeof AcpSnapshotsCapability>;
export const AcpHandoffCapability = Type.Object(
	{ version: Type.Literal(1), prepare: wireMethod, commit: wireMethod, cancel: wireMethod },
	closed,
);
export type AcpHandoffCapability = Static<typeof AcpHandoffCapability>;
export const AcpFleetCapability = Type.Object(
	{
		version: Type.Literal(1),
		preview: wireMethod,
		run: wireMethod,
		/** Terminal dispatch frames carry `_meta["pancode/run-result"]`. */
		runResultFacts: Type.Optional(Type.Boolean()),
		/** `preview` and `run` accept `resume`, a prior root whose successful prefix the run replays. */
		resume: Type.Optional(Type.Literal(true)),
	},
	closed,
);
export type AcpFleetCapability = Static<typeof AcpFleetCapability>;
/**
 * The session's recurring jobs: `list` answers the current set, and `job.changed`
 * under `pancode/events` carries each later change. Neither replaces the other:
 * a client lists after it binds or resumes, then folds the events.
 */
export const AcpJobsCapability = Type.Object(
	{ version: Type.Literal(1), list: wireMethod, event: Type.Literal("job.changed") },
	closed,
);
export type AcpJobsCapability = Static<typeof AcpJobsCapability>;

export const AcpContextCapability = Type.Object({ version: Type.Literal(1), ledger: wireMethod }, closed);
export type AcpContextCapability = Static<typeof AcpContextCapability>;
export const AcpArtifactsCapability = Type.Object(
	{
		version: Type.Literal(1),
		list: Type.String({ maxLength: 8192 }),
		read: Type.String({ maxLength: 8192 }),
		categories: Type.Array(Type.String({ maxLength: 8192 }), { maxItems: 32 }),
		perCategory: Type.Integer({ minimum: 0 }),
	},
	closed,
);
export type AcpArtifactsCapability = Static<typeof AcpArtifactsCapability>;
export const AcpExtensionsCapability = Type.Object(
	{ version: Type.Literal(1), list: wireMethod, reload: wireMethod },
	closed,
);
export type AcpExtensionsCapability = Static<typeof AcpExtensionsCapability>;
export const AcpHubCapability = Type.Object({ version: Type.Literal(1), reload: wireMethod }, closed);
export type AcpHubCapability = Static<typeof AcpHubCapability>;
const draftCount = Type.Integer({ minimum: 1, maximum: 4 });
export const AcpAsideCapability = Type.Object(
	{
		version: Type.Literal(1),
		ask: wireMethod,
		draft: wireMethod,
		cancel: wireMethod,
		draftCounts: Type.Object({ min: draftCount, max: draftCount, default: draftCount }, closed),
	},
	closed,
);
export type AcpAsideCapability = Static<typeof AcpAsideCapability>;
/** Additive bridge: the runtime announces it only to a client that opted in at initialize. */
const negotiatedTimeoutMs = Type.Integer({ minimum: 1, maximum: ACP_MAX_NEGOTIATED_TIMEOUT_MS });
export const AcpInterviewsCapability = Type.Object(
	{
		version: Type.Literal(1),
		request: Type.Literal(ACP_INTERVIEW_REQUEST_METHOD),
		cancel: Type.Optional(Type.Literal(ACP_INTERVIEW_CANCEL_METHOD)),
		/** The applied interview window, echoed only when the client asked for one. */
		timeoutMs: Type.Optional(negotiatedTimeoutMs),
	},
	closed,
);
export type AcpInterviewsCapability = Static<typeof AcpInterviewsCapability>;
/** Echoed only to a client that opted in to MCP elicitation; `timeoutMs` only when it asked for one. */
export const AcpElicitationCapability = Type.Object(
	{
		version: Type.Literal(1),
		request: Type.Literal(ACP_ELICITATION_REQUEST_METHOD),
		cancel: Type.Optional(Type.Literal(ACP_ELICITATION_CANCEL_METHOD)),
		timeoutMs: Type.Optional(negotiatedTimeoutMs),
	},
	closed,
);
export type AcpElicitationCapability = Static<typeof AcpElicitationCapability>;
/** Echoed only to a client that opted in; `timeoutMs` only when it asked for one. */
export const AcpWorkerPermissionsCapability = Type.Object(
	{
		version: Type.Literal(1),
		withdraw: Type.Literal(ACP_PERMISSION_WITHDRAW_METHOD),
		/** The applied window for every `session/request_permission`, main-session and worker asks alike. */
		timeoutMs: Type.Optional(negotiatedTimeoutMs),
	},
	closed,
);
export type AcpWorkerPermissionsCapability = Static<typeof AcpWorkerPermissionsCapability>;

/** `_meta["pancode/budget"]` beside `_meta["pancode/notice"]` on the chunk that reports a ceiling stop. */
export interface AcpBudgetBlock {
	version: 1;
	currentDisplay?: string;
	ceilingDisplay?: string;
	raiseDisplay?: string;
	/** `over` once spend has passed the ceiling, `at` when it reached it exactly. */
	level: "at" | "over";
	currentUsd: number;
	ceilingUsd: number;
	/** Estimated input tokens of the parked request, or null when unknown. */
	contextTokens: number | null;
	/** The value that admits the parked request again. */
	raiseToUsd: number;
	/** The settings path to raise; the same value every surface names. */
	setting: string;
}

/** The ceiling stop's capability entry: where the block lands and which setting lifts it. */
export interface AcpBudgetCapability {
	version: 1;
	meta: typeof ACP_BUDGET_META_KEY;
	update: "agent_message_chunk";
	setting: string;
	replay: true;
}

/** The trust report's capability entry. `surfaces` are `ProjectTrustSurface` names. */
export interface AcpTrustCapability {
	version: 1;
	meta: typeof ACP_TRUST_META_KEY;
	surfaces: ReadonlyArray<string>;
	refresh: typeof ACP_SESSION_TRUST_METHOD;
	results: ReadonlyArray<string>;
}

/**
 * A client ceiling as `session/new`, `session/load`, `session/resume`,
 * `session/prompt`, fork and handoff commit take it under
 * {@link ACP_CEILING_META_KEY}, and as each of their responses echoes the
 * applied one. An echoed `{}` means no limit applies.
 */
export interface AcpCeiling {
	allowedTools?: ReadonlyArray<string>;
	delegatedTools?: ReadonlyArray<string>;
	delegation?: "allowed" | "forbidden";
	readOnly?: true;
}

/**
 * Announced only by a server that enforces a ceiling; any other server refuses
 * one with `ceiling_unsupported`. Enforcement covers tool calls, the dispatches
 * they start, and slash commands, which run only as reads or bounded turns.
 */
export interface AcpCeilingCapability {
	version: 1;
	meta: typeof ACP_CEILING_META_KEY;
	fields: ReadonlyArray<(typeof ACP_CEILING_FIELDS)[number]>;
}

/**
 * `agentCapabilities._meta` as `initialize` answers it. The server's literal
 * `satisfies` this, so an extension it announces under a key or in a shape this
 * interface does not name fails the build instead of reaching a client.
 */
export interface AcpAgentCapabilitiesMeta {
	[ACP_SESSION_META_KEY]: { close: boolean; label: boolean };
	[ACP_SETTINGS_META_KEY]: AcpSettingsCapability;
	[ACP_TARGETS_META_KEY]: AcpTargetsCapability;
	[ACP_TRUST_META_KEY]: AcpTrustCapability;
	[ACP_BUDGET_META_KEY]: AcpBudgetCapability;
	[ACP_CEILING_META_KEY]?: AcpCeilingCapability;
	[ACP_COMMANDS_META_KEY]?: AcpCommandsCapability;
	[ACP_STEERING_META_KEY]: AcpWire<AcpSteeringCapability>;
	[ACP_AGENT_META_KEY]: { version: 1; meta: typeof ACP_AGENT_META_KEY };
	[ACP_TOOL_PROGRESS_META_KEY]: AcpToolProgressCapability;
	[ACP_DECISION_META_KEY]?: AcpWire<AcpDecisionCapability>;
	[ACP_EVENTS_META_KEY]?: AcpWire<AcpEventsCapability>;
	[ACP_TOOLS_META_KEY]?: "mediated";
	[ACP_BOARD_META_KEY]?: AcpBoardCapability;
	[ACP_BRANCHES_META_KEY]?: AcpBranchesCapability;
	[ACP_SNAPSHOTS_META_KEY]?: AcpSnapshotsCapability;
	[ACP_EXTENSIONS_META_KEY]?: AcpExtensionsCapability;
	[ACP_HUB_META_KEY]?: AcpHubCapability;
	[ACP_WORKSPACE_META_KEY]?: { version: 1; update: "session_info_update" };
	[ACP_ASIDE_META_KEY]?: AcpAsideCapability;
	[ACP_INTERVIEWS_META_KEY]?: AcpInterviewsCapability;
	[ACP_ELICITATION_META_KEY]?: AcpElicitationCapability;
	[ACP_WORKER_PERMISSIONS_META_KEY]?: AcpWorkerPermissionsCapability;
	[ACP_CONTEXT_META_KEY]?: AcpContextCapability;
	[ACP_ARTIFACTS_META_KEY]?: AcpWire<AcpArtifactsCapability>;
	[ACP_FLEET_META_KEY]?: AcpFleetCapability;
	[ACP_JOBS_META_KEY]?: AcpJobsCapability;
	[ACP_HANDOFF_META_KEY]?: AcpHandoffCapability;
	[ACP_SHELL_META_KEY]?: AcpShellCapability;
	[ACP_QUEUE_META_KEY]?: AcpWire<AcpQueueCapability>;
	[ACP_READOUTS_META_KEY]: AcpReadoutsCapability;
}

/** Preserve the announcement's inferred shape while checking every extension against its wire contract. */
export function checkAcpAgentCapabilitiesMeta<T extends AcpAgentCapabilitiesMeta>(meta: T): T {
	return meta;
}
