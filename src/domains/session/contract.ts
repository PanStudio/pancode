// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { SkillActivation } from "../../core/skill-activation.js";
import type { PancodeSessionMeta, PancodeTurnRecord } from "../../engine/session.js";
import type { SessionEntry } from "./entries.js";
import type { TreeSnapshot } from "./tree/navigator.js";
import type { WorkspaceSnapshot } from "./workspace/index.js";

/**
 * Domain-level session metadata. Extends the engine's on-disk meta with
 * optional fork pointers and checkpoint bookkeeping. The extra fields live
 * alongside the engine's keys in the same meta.json; readers that only know
 * about PancodeSessionMeta ignore them.
 */
export type PancodeSessionMetaExtension = {
	parentSessionId?: string | null;
	parentTurnId?: string | null;
	lastCheckpointAt?: string | null;
	lastCheckpointReason?: string | null;
	/** Latest display name discovered from sessionInfo entries. */
	name?: string;
	/** Latest non-empty turn labels discovered from sessionInfo entries. */
	labels?: string[];
	/**
	 * First user-message text in current.jsonl, whitespace-collapsed; the
	 * /resume picker names the row by it rather than by a uuid prefix.
	 */
	firstMessagePreview?: string;
	/** Count of user-role message entries; tool calls and bookkeeping entries do not count. */
	messageCount?: number;
	hasModelTurn?: boolean;
	/**
	 * The route the session runs on now, from its newest `modelChange` entry,
	 * discovered at listing like `name`. Absent when it never switched; `target`
	 * and `model` stay the session-start route the ledger's switches fold onto.
	 */
	currentTarget?: string;
	currentModel?: string;
	/**
	 * Latest entry timestamp in current.jsonl, falling back to the file's
	 * mtime; the picker ranks by it rather than by creation time.
	 */
	lastActivityAt?: string;
	/**
	 * Workspace snapshot captured at session bind. Populated by probeWorkspace
	 * during create(); read-only thereafter. Omitted on resumed sessions that
	 * pre-date this field; context(scope="workspace") lazy-fills then.
	 */
	workspace?: WorkspaceSnapshot;
	/** Ordered record of skills activated in this session. */
	skillActivations?: SkillActivation[];
	/**
	 * The turn `/tree` last switched the append point to, persisted so it
	 * survives quit + resume. `resume()`/`switchBranch()` prefer this over
	 * inferring the leaf from timestamps (`computeLeafId`) when it still
	 * names a real turn; a plain append clears it, since once the tree grows
	 * past it the inferred newest-node leaf is correct again.
	 */
	pinnedLeafTurnId?: string | null;
};

export type SessionMeta = PancodeSessionMeta & PancodeSessionMetaExtension;

export type TurnInput = Omit<PancodeTurnRecord, "id" | "at"> & { id?: string; at?: string };

/**
 * Rich entry input: caller may omit turnId and timestamp so the manager can
 * fill them with a uuid v7 + now(). parentTurnId still has to be supplied
 * (or null for the first entry in a branch). Distributes across the union
 * so every kind keeps its discriminant + kind-specific fields.
 */
export type SessionEntryInput = SessionEntry extends infer T
	? T extends SessionEntry
		? Omit<T, "turnId" | "timestamp"> & { turnId?: string; timestamp?: string }
		: never
	: never;

export interface DeleteSessionOptions {
	/**
	 * When true, retain current.jsonl + tree.json on disk and only tombstone
	 * the meta.json (renamed to meta.deleted.json) so `history()` drops the
	 * session from listings without destroying the transcript. Default false
	 * wipes the entire session directory.
	 */
	keepFiles?: boolean;
}

export interface SessionContract {
	current(): SessionMeta | null;
	/** Immutable entries from the current ledger, reconciled with external writes. */
	readEntries(): ReadonlyArray<SessionEntry>;
	create(input?: { cwd?: string; model?: string; target?: string }): SessionMeta;
	append(turn: TurnInput): PancodeTurnRecord;
	/**
	 * Append a structured entry (compactionSummary, branchSummary,
	 * modelChange and the like) to the current session.
	 */
	appendEntry(entry: SessionEntryInput): SessionEntry;
	/**
	 * Atomically replace the current session's rich entry list. Used by
	 * observation masking to rewrite persisted payload bodies without
	 * changing turn ids or tree shape.
	 */
	replaceEntries(entries: ReadonlyArray<SessionEntry>): void;
	/** Append a skill activation ledger entry and mirror it into meta.json. */
	recordSkillActivation(activation: SkillActivation): SkillActivation;
	/** Write atomic checkpoint (current.jsonl flush, tree.json persist, meta update). */
	checkpoint(reason?: string): Promise<void>;
	/** Synchronously make current.jsonl appends durable; used by write-ahead safety journals. */
	flushAppends?(): void;
	/** Load an existing session and make it current. */
	resume(sessionId: string): SessionMeta;
	/** Fork from a parent turn, producing a new session with parentId pointer. */
	fork(parentTurnId: string, input?: { cwd?: string }): SessionMeta;
	/**
	 * Fork `sessionId` from its file and make the child current, never writing the parent, which may be open in
	 * another process (SPEC L3). The fork point is `atTurnId` or the parent's last committed turn; `name` is part of
	 * the child's creation.
	 */
	forkFrom(sessionId: string, input?: { atTurnId?: string; name?: string }): SessionMeta;
	/**
	 * Name the current session; with none current, the name waits for the next `create()`, `resume()` or
	 * `forkFrom()`, which writes it as part of opening that session (`run --name`).
	 */
	nameSession(name: string): void;
	/**
	 * Return a serializable snapshot of the tree for a given session (defaults
	 * to the current session). Built from `tree.json` + resolved labels via
	 * `tree/navigator.ts`; the underlying on-disk artifacts stay engine-owned.
	 */
	tree(sessionId?: string): TreeSnapshot;
	/**
	 * The session's current leaf (next append point), equal to
	 * `tree(sessionId).leafId`. The current session answers from memory with
	 * no file read; another session falls back to its tree snapshot.
	 */
	leafId(sessionId?: string): string | null;
	/** Make `sessionId` current as `resume` does; the /tree overlay switches branches with it. */
	switchBranch(sessionId: string): SessionMeta;
	/**
	 * Move the current session's active append point to a turn in its tree.
	 * The interactive chat loop uses this id as the next parent while the
	 * on-disk tree keeps all sibling branches intact.
	 */
	switchTurn(turnId: string): SessionMeta;
	/**
	 * Persist a display-only label for `turnId`. The marker is a
	 * SessionInfoEntry with `targetTurnId` + `label` written to the target
	 * session's current.jsonl. Empty `label` clears the marker. If the target
	 * session is the current one, writes flow through the live writer;
	 * otherwise the helper appends directly to that session's transcript.
	 */
	editLabel(turnId: string, label: string, sessionId?: string): void;
	/**
	 * Persist the session's display name as a session-wide SessionInfoEntry.
	 * Empty or whitespace-only names clear the name when history is rebuilt.
	 * If the target session is current, writes flow through the live writer;
	 * otherwise the entry is durably appended directly to its transcript.
	 */
	setName(name: string, sessionId?: string): void;
	/** Refuses the session that is open; `close()` it first. */
	deleteSession(id: string, opts?: DeleteSessionOptions): void;
	/** List sessions for current cwd (most-recent first). */
	history(): ReadonlyArray<SessionMeta>;
	/**
	 * Resolve a session id or unique id prefix for the current cwd from session metadata alone. An exact id wins,
	 * no match returns the input, and an ambiguous prefix returns its matches most-recent first.
	 */
	resolveId(idOrPrefix: string): string | { ambiguous: string[] };
	close(): Promise<void>;
}
