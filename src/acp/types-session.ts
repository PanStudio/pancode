// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Session control: the session list, the params and results of the session
 * methods (steer, queue, shell, interrupt, label, handoff, decisions, memory),
 * the workspace view, and the branch, snapshot and handoff schemas.
 */
import type { Static } from "typebox";
import { Type } from "typebox";
import type { ProjectTrustSurface, WorkspaceTrustVerdict } from "../core/workspace-trust.js";
import type { AcpSessionResultMeta } from "./types.js";
import {
	ACP_MAX_MODEL_ID_BYTES,
	ACP_MAX_TARGET_ID_BYTES,
	ACP_SESSION_META_KEY,
	closed,
	queuedKind,
	sessionId,
	sessionParams,
} from "./types.js";

/**
 * `_meta["pancode/session"]` on each `session/list` row: the ledger facts a
 * history view shows that the stable `SessionInfo` has no field for.
 */
export const AcpSessionListMeta = Type.Object(
	{
		createdAt: Type.String({ maxLength: 64 }),
		endedAt: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
		connection: Type.Union([Type.String({ maxLength: ACP_MAX_TARGET_ID_BYTES }), Type.Null()]),
		model: Type.Union([Type.String({ maxLength: ACP_MAX_MODEL_ID_BYTES }), Type.Null()]),
		firstMessagePreview: Type.Optional(Type.String({ maxLength: 1024 })),
		messageCount: Type.Optional(Type.Integer({ minimum: 0 })),
		hasModelTurn: Type.Optional(Type.Boolean()),
		lastActivityAt: Type.Optional(Type.String({ maxLength: 64 })),
	},
	closed,
);
/** One `session/list` row as a client reads it. */
export const AcpSessionListRow = Type.Object(
	{
		sessionId: Type.String({ minLength: 1, maxLength: 128 }),
		cwd: Type.String({ maxLength: 4096 }),
		title: Type.Optional(Type.String({ maxLength: 256 })),
		updatedAt: Type.String({ maxLength: 64 }),
		_meta: Type.Optional(Type.Object({ [ACP_SESSION_META_KEY]: AcpSessionListMeta }, closed)),
	},
	closed,
);
export type AcpSessionListRow = Static<typeof AcpSessionListRow>;
/** The result of `session/list`: one page of workspace history, newest first. */
export const AcpSessionList = Type.Object(
	{
		sessions: Type.Array(AcpSessionListRow, { maxItems: 50 }),
		nextCursor: Type.Optional(Type.String({ maxLength: 512 })),
	},
	closed,
);
export type AcpSessionList = Static<typeof AcpSessionList>;

export const AcpSteerParams = Type.Object(
	{
		...sessionParams,
		text: Type.String(),
		mode: Type.Optional(Type.Union([Type.Literal("next-slot"), Type.Literal("end-of-turn")])),
	},
	closed,
);
export const AcpSteerResult = Type.Object(
	{ accepted: Type.Boolean(), queue: queuedKind, refusal: Type.Optional(Type.String()) },
	closed,
);
export type AcpSteerResult = Static<typeof AcpSteerResult>;
export const AcpQueueEntry = Type.Object(
	{ id: Type.String(), kind: queuedKind, text: Type.String(), enqueuedAt: Type.Number(), pinned: Type.Boolean() },
	closed,
);
export type AcpQueueEntry = Static<typeof AcpQueueEntry>;
export const AcpQueueResult = Type.Object(
	{
		steer: Type.Array(Type.String()),
		followUp: Type.Array(Type.String()),
		entries: Type.Optional(Type.Array(AcpQueueEntry)),
	},
	closed,
);
export type AcpQueueResult = Static<typeof AcpQueueResult>;
export const AcpQueueClearResult = Type.Object({ restored: Type.Array(Type.String()) }, closed);
export type AcpQueueClearResult = Static<typeof AcpQueueClearResult>;
export const AcpQueueEditParams = Type.Union([
	Type.Object(
		{
			...sessionParams,
			id: Type.String(),
			op: Type.Union([Type.Literal("remove"), Type.Literal("restore"), Type.Literal("send_now")]),
		},
		closed,
	),
	Type.Object(
		{
			...sessionParams,
			id: Type.String(),
			op: Type.Literal("move"),
			delta: Type.Union([Type.Literal(-1), Type.Literal(1)]),
		},
		closed,
	),
	Type.Object({ ...sessionParams, id: Type.String(), op: Type.Literal("set_kind"), kind: queuedKind }, closed),
]);
export const AcpQueueEditResult = Type.Object(
	{
		applied: Type.Boolean(),
		entries: Type.Array(AcpQueueEntry),
		reason: Type.Optional(Type.String()),
		text: Type.Optional(Type.String()),
		delivery: Type.Optional(Type.Union([Type.Literal("interrupt"), Type.Literal("next-slot")])),
		refusal: Type.Optional(Type.String()),
	},
	closed,
);
export type AcpQueueEditResult = Static<typeof AcpQueueEditResult>;
export const AcpQueueChangedParams = Type.Object({ ...sessionParams, entries: Type.Array(AcpQueueEntry) }, closed);
export const AcpShellParams = Type.Object(
	{ ...sessionParams, command: Type.String(), excludeFromContext: Type.Optional(Type.Boolean()) },
	closed,
);
export const AcpShellResult = Type.Object(
	{
		turnId: Type.String(),
		exitCode: Type.Union([Type.Integer(), Type.Null()]),
		cancelled: Type.Boolean(),
		timedOut: Type.Boolean(),
		truncated: Type.Boolean(),
		excludedFromContext: Type.Boolean(),
		unlabeled: Type.Optional(Type.Boolean()),
		output: Type.String(),
		outputBytes: Type.Number(),
	},
	closed,
);
export type AcpShellResult = Static<typeof AcpShellResult>;
export const AcpInterruptParams = Type.Object({ ...sessionParams, reason: Type.Optional(Type.String()) }, closed);
export const AcpInterruptResult = Type.Object(
	{ cancelled: Type.Boolean(), refusal: Type.Optional(Type.String()) },
	closed,
);
export type AcpInterruptResult = Static<typeof AcpInterruptResult>;
export const AcpLabelParams = Type.Object({ ...sessionParams, label: Type.String() }, closed);

export const AcpHandoffPrepareParams = Type.Object({ ...sessionParams, goal: Type.String() }, closed);
export const AcpHandoffCommitParams = Type.Object(
	{ ...sessionParams, handoffId: Type.String(), document: Type.String() },
	closed,
);
export const AcpHandoffCancelParams = Type.Object({ ...sessionParams, handoffId: Type.String() }, closed);
interface AcpHandoffRefusal {
	status: "refused";
	level: "warn" | "error";
	code: string;
	reason: string;
}
interface AcpHandoffPrepared {
	status: "ready";
	handoffId: string;
	goal: string;
	fromSessionId: string;
	document: string;
}
export type AcpHandoffPrepareResult = AcpHandoffPrepared | AcpHandoffRefusal;
export interface AcpHandoffCancelResult {
	cancelled: boolean;
}
export const AcpDecisionSupersedeParams = Type.Object(
	{ ...sessionParams, interviewId: Type.String(), key: Type.String(), correction: Type.Optional(Type.String()) },
	closed,
);
export interface AcpDecisionSupersedeResult {
	status: string;
	correctionTurn?: string;
	reason?: string;
}
export const AcpMemoryProposeParams = Type.Object(
	{
		...sessionParams,
		entryId: Type.String(),
		scope: Type.Union([Type.Literal("repo"), Type.Literal("global")]),
		acknowledgeGlobal: Type.Optional(Type.Boolean()),
	},
	closed,
);
export interface AcpMemoryProposeResult {
	status: "needs_acknowledgement" | "proposed" | "existing" | "refused";
	reason?: string;
	recordId?: string;
}

export interface AcpWorkspaceView {
	version: 1;
	cwd: string;
	isGit: boolean;
	branch: string | null;
	dirty: boolean | null;
	ahead: number | null;
	behind: number | null;
	remoteUrl: string | null;
	projectType: string;
	capturedAt: string;
}

type AcpTreeNodeKind =
	| "user"
	| "assistant"
	| "tool_call"
	| "tool_result"
	| "system"
	| "checkpoint"
	| "compaction"
	| "branch";

export interface AcpSessionTree {
	version: 1;
	sessionId: string;
	/** The turn the next request appends under; null for an empty session. */
	leafId: string | null;
	/** Where this session was forked from, when it was. */
	parentSessionId: string | null;
	parentTurnId: string | null;
	/** Oldest first, so a parent always precedes its children. */
	nodes: Array<{
		id: string;
		parentId: string | null;
		kind: AcpTreeNodeKind;
		at: string;
		label: string | null;
		preview: string | null;
		/** On the path from the root to {@link AcpSessionTree.leafId}. */
		active: boolean;
		/** Structural rows (a compaction, a returned-from branch) are not a place to continue from. */
		selectable: boolean;
	}>;
	/** True when nodes were cut at {@link ACP_SESSION_TREE_MAX_NODES}. */
	truncated: boolean;
}

export interface AcpIgnoredProjectSurface {
	surface: ProjectTrustSurface;
	file: string;
	verdict: Exclude<WorkspaceTrustVerdict, "trusted">;
	fix: string;
}

export const AcpDecisionSupersededSchema = Type.Union([
	Type.Object(
		{
			status: Type.Union([Type.Literal("superseded"), Type.Literal("already_superseded")]),
			/** The operator turn the terminal sends with a correction, for the client to send as a request. */
			correctionTurn: Type.Optional(Type.String({ maxLength: 4200 })),
		},
		closed,
	),
	Type.Object({ status: Type.Literal("refused"), reason: Type.String({ maxLength: 1100 }) }, closed),
]);

export const AcpMemoryProposedSchema = Type.Union([
	Type.Object(
		{
			status: Type.Union([Type.Literal("proposed"), Type.Literal("existing")]),
			recordId: Type.String({ maxLength: 256 }),
		},
		closed,
	),
	Type.Object(
		{
			status: Type.Union([Type.Literal("needs_acknowledgement"), Type.Literal("refused")]),
			reason: Type.String({ maxLength: 1100 }),
		},
		closed,
	),
]);

const wireBranchesTurnId = Type.String({ minLength: 1, maxLength: 128 });

const wireBranchesTreeNodeKind = Type.Union([
	Type.Literal("user"),
	Type.Literal("assistant"),
	Type.Literal("tool_call"),
	Type.Literal("tool_result"),
	Type.Literal("system"),
	Type.Literal("checkpoint"),
	Type.Literal("compaction"),
	Type.Literal("branch"),
]);

export const AcpSessionTreeSchema = Type.Object(
	{
		version: Type.Literal(1),
		sessionId: sessionId,
		leafId: Type.Union([wireBranchesTurnId, Type.Null()]),
		parentSessionId: Type.Union([sessionId, Type.Null()]),
		parentTurnId: Type.Union([wireBranchesTurnId, Type.Null()]),
		nodes: Type.Array(
			Type.Object(
				{
					id: wireBranchesTurnId,
					parentId: Type.Union([wireBranchesTurnId, Type.Null()]),
					kind: wireBranchesTreeNodeKind,
					at: Type.String({ maxLength: 64 }),
					label: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
					preview: Type.Union([Type.String({ maxLength: 300 }), Type.Null()]),
					active: Type.Boolean(),
					selectable: Type.Boolean(),
				},
				closed,
			),
			{ maxItems: 400 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);

/** Snapshot path lists are capped per list; `truncated` says one was cut. */
export const ACP_SNAPSHOT_PATH_LIST_MAX = 500;
/** The snapshot list carries the newest rows only. */
export const ACP_SNAPSHOT_LIST_MAX = 100;

const wireSnapshotN = Type.Integer({ minimum: 1 });
const wireSnapshotPath = Type.String({ maxLength: 4096 });
const wireSnapshotReason = Type.String({ maxLength: 512 });
const wireSnapshotPaths = Type.Array(wireSnapshotPath, { maxItems: ACP_SNAPSHOT_PATH_LIST_MAX });
const wireSnapshotKept = Type.Array(Type.Object({ path: wireSnapshotPath, why: wireSnapshotReason }, closed), {
	maxItems: ACP_SNAPSHOT_PATH_LIST_MAX,
});
const wireSnapshotRefs = Type.Array(
	Type.Object(
		{
			kind: Type.Union([Type.Literal("head"), Type.Literal("stash"), Type.Literal("branch")]),
			label: Type.String({ maxLength: 512 }),
			state: Type.Union([Type.Literal("in-place"), Type.Literal("moved"), Type.Literal("gone"), Type.Literal("unknown")]),
			recover: Type.Union([Type.String({ maxLength: 1024 }), Type.Null()]),
		},
		closed,
	),
	{ maxItems: 64 },
);

export const AcpSnapshotListSchema = Type.Object(
	{
		snapshots: Type.Array(
			Type.Object(
				{
					n: wireSnapshotN,
					at: Type.String({ maxLength: 64 }),
					reason: wireSnapshotReason,
					tool: Type.Optional(Type.String({ maxLength: 128 })),
					turnId: Type.Optional(wireBranchesTurnId),
					/** Files differing from the current workspace; null when the store cannot tell. */
					differs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
					skipped: Type.Integer({ minimum: 0 }),
				},
				closed,
			),
			{ maxItems: ACP_SNAPSHOT_LIST_MAX },
		),
		truncated: Type.Boolean(),
	},
	closed,
);
export type AcpSnapshotList = Static<typeof AcpSnapshotListSchema>;

export const AcpSnapshotPlanSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("plan"),
			n: wireSnapshotN,
			restore: wireSnapshotPaths,
			remove: wireSnapshotPaths,
			kept: wireSnapshotKept,
			refs: wireSnapshotRefs,
			truncated: Type.Boolean(),
		},
		closed,
	),
	Type.Object({ kind: Type.Literal("unavailable"), reason: wireSnapshotReason }, closed),
]);
export type AcpSnapshotPlan = Static<typeof AcpSnapshotPlanSchema>;

export const AcpSnapshotOutcomeSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("restored"),
			n: wireSnapshotN,
			/** The snapshot taken of the files just before this restore, so it can be undone. */
			undo: wireSnapshotN,
			restored: wireSnapshotPaths,
			removed: wireSnapshotPaths,
			kept: wireSnapshotKept,
			failed: wireSnapshotKept,
			refs: wireSnapshotRefs,
			truncated: Type.Boolean(),
		},
		closed,
	),
	Type.Object({ kind: Type.Literal("unavailable"), reason: wireSnapshotReason }, closed),
	Type.Object({ kind: Type.Literal("failed"), reason: wireSnapshotReason, undo: wireSnapshotN }, closed),
]);
export type AcpSnapshotOutcome = Static<typeof AcpSnapshotOutcomeSchema>;

export const AcpBranchSwitchedSchema = Type.Object(
	{ leafId: wireBranchesTurnId, replayedTurns: Type.Integer({ minimum: 0 }) },
	closed,
);

export const AcpForkedSchema = Type.Object(
	{
		sessionId: sessionId,
		parentSessionId: sessionId,
		parentTurnId: wireBranchesTurnId,
		/** False when the fork exists but its transcript could not be replayed; it starts empty. */
		replayed: Type.Boolean(),
	},
	closed,
);

export const wireSteeringName = Type.String({ maxLength: 64 });

export const wireSteeringCopy = Type.String({ maxLength: 512 });

const wireHandoffHandoffId = Type.String({ minLength: 1, maxLength: 128 });

const wireHandoffDocument = Type.String({ maxLength: 131072 });

const wireHandoffHandoffRefused = Type.Object(
	{
		status: Type.Literal("refused"),
		level: Type.Union([Type.Literal("warn"), Type.Literal("error")]),
		code: Type.String({ maxLength: 64 }),
		reason: Type.String({ maxLength: 2100 }),
	},
	closed,
);

export const AcpHandoffDraftSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("ready"),
			handoffId: wireHandoffHandoffId,
			goal: Type.String({ maxLength: 2048 }),
			fromSessionId: sessionId,
			document: wireHandoffDocument,
		},
		closed,
	),
	wireHandoffHandoffRefused,
]);

export const AcpHandoffCommittedSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("committed"),
			sessionId: sessionId,
			fromSessionId: sessionId,
			warnings: Type.Array(Type.String({ maxLength: 2100 }), { maxItems: 8 }),
		},
		closed,
	),
	wireHandoffHandoffRefused,
]);

export const AcpHandoffCancelledSchema = Type.Object({ cancelled: Type.Boolean() }, closed);

const wireSteeringSTEER_TEXT_MAX_BYTES = 16384;

const wireSteeringQUEUE_MAX_ENTRIES = 64;

export const AcpSteerResultSchema = Type.Object(
	{
		accepted: Type.Boolean(),
		queue: Type.Union([Type.Literal("steer"), Type.Literal("follow-up")]),
		refusal: Type.Optional(wireSteeringCopy),
	},
	closed,
);

const wireSteeringQueueKind = Type.Union([Type.Literal("steer"), Type.Literal("follow-up")]);

export const AcpQueueEntrySchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 128 }),
		kind: wireSteeringQueueKind,
		text: Type.String({ maxLength: wireSteeringSTEER_TEXT_MAX_BYTES }),
		enqueuedAt: Type.Number(),
		pinned: Type.Boolean(),
	},
	closed,
);

const wireSteeringQueueEntries = Type.Array(AcpQueueEntrySchema, { maxItems: wireSteeringQUEUE_MAX_ENTRIES });

export const AcpQueueSnapshotSchema = Type.Object(
	{
		steer: Type.Array(Type.String({ maxLength: wireSteeringSTEER_TEXT_MAX_BYTES }), {
			maxItems: wireSteeringQUEUE_MAX_ENTRIES,
		}),
		followUp: Type.Array(Type.String({ maxLength: wireSteeringSTEER_TEXT_MAX_BYTES }), {
			maxItems: wireSteeringQUEUE_MAX_ENTRIES,
		}),
		entries: Type.Optional(wireSteeringQueueEntries),
	},
	closed,
);

export const AcpQueueChangedSchema = Type.Object(
	{ sessionId: Type.String({ maxLength: 128 }), entries: wireSteeringQueueEntries },
	closed,
);

export const AcpQueueEditResultSchema = Type.Object(
	{
		applied: Type.Boolean(),
		reason: Type.Optional(wireSteeringName),
		text: Type.Optional(Type.String({ maxLength: wireSteeringSTEER_TEXT_MAX_BYTES })),
		delivery: Type.Optional(Type.Union([Type.Literal("interrupt"), Type.Literal("next-slot")])),
		refusal: Type.Optional(wireSteeringCopy),
		entries: wireSteeringQueueEntries,
	},
	closed,
);

export const AcpShellOutcomeSchema = Type.Object(
	{
		cancelled: Type.Boolean(),
		timedOut: Type.Boolean(),
		excludedFromContext: Type.Boolean(),
		unlabeled: Type.Optional(Type.Boolean()),
	},
	closed,
);

export const AcpQueueClearedSchema = Type.Object(
	{
		restored: Type.Array(Type.String({ maxLength: wireSteeringSTEER_TEXT_MAX_BYTES }), {
			maxItems: 2 * wireSteeringQUEUE_MAX_ENTRIES,
		}),
	},
	closed,
);

export const AcpInterruptResultSchema = Type.Object(
	{ cancelled: Type.Boolean(), refusal: Type.Optional(wireSteeringCopy) },
	closed,
);

export const AcpDispatchSteerResultSchema = Type.Object(
	{ accepted: Type.Boolean(), reason: Type.Optional(wireSteeringName) },
	closed,
);

interface AcpSessionModes {
	currentModeId: string;
	availableModes: Array<{ id: string; name: string; description?: string }>;
}
interface AcpHandoffCommitted {
	status: "committed";
	sessionId: string;
	fromSessionId: string;
	warnings: string[];
	modes: AcpSessionModes;
	configOptions: Array<Record<string, unknown>>;
	_meta: { [ACP_SESSION_META_KEY]: AcpSessionResultMeta };
}
export type AcpHandoffCommitResult = AcpHandoffCommitted | AcpHandoffRefusal;
