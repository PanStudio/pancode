// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The ACP server's branch methods: the session tree, workspace snapshots, turn switching, and forks. */

import type { TurnConstraints } from "../core/turn-constraints.js";
import { narrowTurnConstraints, snapshotTurnConstraints } from "../core/turn-constraints.js";
import type { SessionContract, SessionMeta } from "../domains/session/contract.js";
import { replayCurrentSession } from "../session-control/index.js";
import type { McpClientServerSpec } from "../tools/gateway/mcp-capability-types.js";
import { AcpRequestError, acpErrorMessage } from "./errors.js";
import { requireBoundedClientString, safeStoredIdentifier } from "./server-bounds.js";
import { checkpointBeforeClose } from "./server-catalog.js";
import { ACP_MAX_SESSION_ID_BYTES, assertCeilingEnforceable, assertParamKeys } from "./server-guards.js";
import { assertNoAdditionalDirectories, parseClientMcpServers } from "./server-handshake.js";
import { modelsResultMeta, sessionConfig } from "./server-models.js";
import type { PreparedRestore } from "./server-open.js";
import { attachClientMcpServers } from "./server-open.js";
import type { PancodeAcpServerOptions } from "./server-options.js";
import { branchesWired } from "./server-options.js";
import { requestCeiling } from "./server-prompt-input.js";
import type { PreparedAcpReplay } from "./server-replay.js";
import { prepareAcpReplay, sessionResultMeta } from "./server-replay.js";
import type { AcpServerScope } from "./server-scope.js";
import {
	clipSnapshotText,
	snapshotFailure,
	snapshotKept,
	snapshotN,
	snapshotPaths,
	snapshotRefs,
	snapshotStore,
} from "./server-snapshots.js";
import type { AcpServerSession } from "./server-tool-updates.js";
import {
	ACP_SESSION_FORK_METHOD,
	ACP_SESSION_SWITCH_TURN_METHOD,
	ACP_SESSION_TREE_METHOD,
	isSelectableTreeNode,
	projectSessionTree,
} from "./session-tree.js";
import {
	ACP_NOTICE_META_KEY,
	ACP_SESSION_META_KEY,
	ACP_SNAPSHOT_PREVIEW_METHOD,
	ACP_SNAPSHOT_RESTORE_METHOD,
	ACP_SNAPSHOTS_LIST_METHOD,
} from "./types.js";
import type { AcpSnapshotList, AcpSnapshotOutcome, AcpSnapshotPlan } from "./types-session.js";
import { ACP_SNAPSHOT_LIST_MAX } from "./types-session.js";

/**
 * A successor's ceiling: the source session's narrowed by the one sent with
 * the request, so a fork or handoff can tighten what it inherits and never
 * loosen it (Z1).
 */
export function successorCeiling(
	options: PancodeAcpServerOptions,
	source: AcpServerSession,
	params: unknown,
): TurnConstraints | undefined {
	const requested = requestCeiling(params);
	assertCeilingEnforceable(options, requested);
	return snapshotTurnConstraints(narrowTurnConstraints(source.ceiling, requested));
}

export function requireBranches(options: PancodeAcpServerOptions) {
	const session = options.session;
	const resetForSession = options.chat.resetForSession;
	const readEntries = options.readSessionEntries;
	const buildMessages = options.buildReplayMessages;
	if (
		!branchesWired(options) ||
		session === undefined ||
		resetForSession === undefined ||
		readEntries === undefined ||
		buildMessages === undefined
	) {
		throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
	}
	return { session, resetForSession: resetForSession.bind(options.chat), readEntries, buildMessages };
}

function selectableTurn(contract: SessionContract, sessionId: string, value: unknown): string {
	const turnId = requireBoundedClientString(value, "turnId", ACP_MAX_SESSION_ID_BYTES);
	let kind: string | undefined;
	try {
		kind = contract.tree(sessionId).nodesById[turnId]?.kind;
	} catch {
		throw new AcpRequestError(-32603, "session tree could not be read", { code: "internal_error" });
	}
	if (kind === undefined || !isSelectableTreeNode(kind)) {
		throw new AcpRequestError(-32602, "turn is not in this session", { code: "turn_unknown" });
	}
	return turnId;
}

export function registerAcpServerBranches(scope: AcpServerScope): void {
	const { options } = scope;
	options.transport.onRequest(ACP_SESSION_TREE_METHOD, (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const { session } = requireBranches(options);
		const bound = scope.guards.getSession(request);
		try {
			return projectSessionTree(session.tree(bound.id));
		} catch {
			throw new AcpRequestError(-32603, "session tree could not be read", { code: "internal_error" });
		}
	});

	options.transport.onRequest(ACP_SNAPSHOTS_LIST_METHOD, async (params): Promise<AcpSnapshotList> => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const bound = scope.guards.getSession(request);
		try {
			const store = snapshotStore(options, bound);
			const records = store.list();
			const differences = records.length > 0 ? await store.differences() : null;
			const counts = differences?.kind === "counts" ? differences.counts : null;
			return {
				snapshots: records.slice(0, ACP_SNAPSHOT_LIST_MAX).map((record) => ({
					n: record.n,
					at: clipSnapshotText(record.at, 64),
					reason: clipSnapshotText(record.reason, 512),
					...(record.tool !== undefined ? { tool: clipSnapshotText(record.tool, 128) } : {}),
					...(record.turnId !== undefined && record.turnId.length > 0 && record.turnId.length <= 128
						? { turnId: record.turnId }
						: {}),
					differs: counts?.get(record.n) ?? null,
					skipped: record.skipped.length,
				})),
				truncated: records.length > ACP_SNAPSHOT_LIST_MAX,
			};
		} catch (error) {
			return snapshotFailure(error);
		}
	});

	options.transport.onRequest(ACP_SNAPSHOT_PREVIEW_METHOD, async (params): Promise<AcpSnapshotPlan> => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "n"]));
		const bound = scope.guards.getSession(request);
		const n = snapshotN(request.n);
		try {
			const preview = await snapshotStore(options, bound).preview(n);
			if (preview.kind === "unavailable") return { kind: "unavailable", reason: clipSnapshotText(preview.reason, 512) };
			const restore = snapshotPaths(preview.plan.restore);
			const remove = snapshotPaths(preview.plan.remove);
			const kept = snapshotKept(preview.plan.kept);
			return {
				kind: "plan",
				n: preview.plan.n,
				restore: restore.rows,
				remove: remove.rows,
				kept: kept.rows,
				refs: snapshotRefs(preview.plan.refs),
				truncated: restore.cut || remove.cut || kept.cut,
			};
		} catch (error) {
			return snapshotFailure(error);
		}
	});

	options.transport.onRequest(ACP_SNAPSHOT_RESTORE_METHOD, async (params): Promise<AcpSnapshotOutcome> => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "n"]));
		const bound = scope.guards.getSession(request);
		const n = snapshotN(request.n);
		scope.guards.requireIdle(bound, "rewind");
		try {
			const outcome = await snapshotStore(options, bound).restore(n);
			if (outcome.kind === "unavailable") return { kind: "unavailable", reason: clipSnapshotText(outcome.reason, 512) };
			if (outcome.kind === "failed")
				return { kind: "failed", reason: clipSnapshotText(outcome.reason, 512), undo: outcome.preRewind.n };
			const restored = snapshotPaths(outcome.restored);
			const removed = snapshotPaths(outcome.removed);
			const kept = snapshotKept(outcome.kept);
			const failed = snapshotKept(outcome.failed);
			return {
				kind: "restored",
				n: outcome.n,
				undo: outcome.preRewind.n,
				restored: restored.rows,
				removed: removed.rows,
				kept: kept.rows,
				failed: failed.rows,
				refs: snapshotRefs(outcome.refs),
				truncated: restored.cut || removed.cut || kept.cut || failed.cut,
			};
		} catch (error) {
			return snapshotFailure(error);
		}
	});

	// Enter in /tree: the next request appends under the chosen turn, and the
	// conversation is replayed as that branch. Sibling branches stay on disk.
	options.transport.onRequest(ACP_SESSION_SWITCH_TURN_METHOD, (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "turnId"]));
		const { session, resetForSession } = requireBranches(options);
		const bound = scope.guards.getSession(request);
		scope.guards.requireIdle(bound, "switch branches");
		const turnId = selectableTurn(session, bound.id, request.turnId);
		let restore: PreparedRestore;
		try {
			restore = scope.open.prepareRestore(bound.id, turnId, "upto", true);
		} catch {
			throw new AcpRequestError(-32603, "branch could not be read", { code: "internal_error" });
		}
		try {
			session.switchTurn(turnId);
		} catch (error) {
			options.diagnostics?.(`branch switch failed: ${acpErrorMessage(error)}`);
			throw new AcpRequestError(-32603, "branch switch failed", { code: "internal_error" });
		}
		resetForSession(turnId, restore.replayMessages);
		scope.open.bindRestored(bound, restore.replay);
		const replay = restore.replay;
		return {
			sessionId: bound.id,
			leafId: turnId,
			_meta: {
				[ACP_SESSION_META_KEY]: sessionResultMeta(
					bound,
					true,
					replay === undefined ? undefined : { turns: replay.turns, truncated: replay.truncated },
				),
			},
		};
	});

	// /fork: a new session carrying the branch up to the chosen turn. The
	// process follows the new session, as the terminal does, and the parent is
	// closed on disk. Workspace files are never rewound. One process hosts one
	// session, so the replacement is stated, never silent: the result carries
	// `parentClosed`, the parent gets a notice, and a later request naming it is
	// refused `session_replaced` with the child's id rather than `session_unknown`.
	/**
	 * Forks the bound session at `turnId` and hosts the child in its place. The extension method replays the child's
	 * branch to the client; standard session/fork does not, since the client already holds that conversation.
	 */
	const forkBoundSession = async (
		request: Record<string, unknown>,
		chooseTurn: "request" | "leaf",
		replayToClient: boolean,
		clientMcpServers?: ReadonlyArray<McpClientServerSpec>,
	) => {
		const { session, resetForSession, readEntries, buildMessages } = requireBranches(options);
		const bound = scope.guards.getSession(request);
		scope.guards.requireIdle(bound, "fork");
		const ceiling = successorCeiling(options, bound, request);
		const requested = chooseTurn === "request" ? request.turnId : session.leafId(bound.id);
		if (requested === null)
			throw new AcpRequestError(-32602, "the session has no turn to fork from", { code: "turn_unknown" });
		const turnId = selectableTurn(session, bound.id, requested);
		// The fork closes the parent's ledger.
		await checkpointBeforeClose(options, bound.id, "fork");
		scope.guards.requireStillIdle(bound, "fork");
		if (clientMcpServers !== undefined) {
			// Standard fork names the child's client servers, so the parent's go first; a launch failure refuses the fork
			// before the session changes, as on an opener.
			await options.mcpCapabilities?.detachClientServers();
			await attachClientMcpServers(options, clientMcpServers, ceiling);
			scope.guards.requireStillIdle(bound, "fork");
		}
		let meta: SessionMeta;
		try {
			meta = session.fork(turnId);
		} catch (error) {
			// The session domain keeps the parent current when a fork throws.
			options.diagnostics?.(`fork failed: ${acpErrorMessage(error)}`);
			if (clientMcpServers !== undefined) await options.mcpCapabilities?.detachClientServers();
			throw new AcpRequestError(-32603, "fork failed", { code: "internal_error" });
		}
		if (
			meta.id === bound.id ||
			session.current()?.id !== meta.id ||
			safeStoredIdentifier(meta.id, ACP_MAX_SESSION_ID_BYTES) === null
		) {
			throw new AcpRequestError(-32603, "fork failed", { code: "internal_error" });
		}
		// Route, autonomy and thinking are this process's, not the ledger's, so
		// the child keeps what the parent's conversation was using.
		const forked: AcpServerSession = {
			...bound,
			id: meta.id,
			createdAt: meta.createdAt,
			activePrompt: null,
			...(ceiling !== undefined ? { ceiling } : {}),
		};
		scope.sessions.delete(bound.id);
		scope.closedSessionIds.add(bound.id);
		scope.replacedSessions.delete(meta.id);
		scope.replacedSessions.set(bound.id, meta.id);
		options.transport.notify("session/update", {
			sessionId: bound.id,
			update: {
				sessionUpdate: "session_info_update",
				_meta: {
					[ACP_NOTICE_META_KEY]: {
						level: "info",
						text: `This session is closed: its fork ${meta.id} now holds this process, which hosts one session at a time. Close ${meta.id}, then load or resume this session to continue it.`,
					},
				},
			},
		});
		let replay: PreparedAcpReplay | undefined;
		let replayFailed = false;
		let forkLeaf: string | null = turnId;
		try {
			const restored = replayCurrentSession(
				{
					session,
					chat: { resetForSession },
					readEntries,
					buildMessages,
				},
				meta.id,
				"leaf",
				undefined,
				turnId,
			);
			forkLeaf = restored.leafTurnId;
			if (replayToClient)
				replay = prepareAcpReplay(restored.entries, restored.leafTurnId, meta.id, scope.canonicalCwd, meta.target);
		} catch (error) {
			options.diagnostics?.(`fork replay failed: ${acpErrorMessage(error)}`);
			resetForSession(forkLeaf, []);
			replayFailed = true;
		}
		const ceilingEcho = scope.guards.applySessionCeiling(forked);
		scope.open.bindRestored(forked, replay);
		const parent = { parentSessionId: bound.id, parentTurnId: turnId };
		// Standard session/fork answers with exactly the unstable ForkSessionResponse fields, so its parent travels in
		// `_meta`; the extension method keeps it beside the session id.
		return {
			sessionId: forked.id,
			...(replayToClient ? parent : {}),
			...sessionConfig(options, scope.listingFallbacks, forked),
			_meta: {
				...ceilingEcho,
				...modelsResultMeta(options, forked),
				[ACP_SESSION_META_KEY]: {
					...sessionResultMeta(
						forked,
						true,
						replay === undefined ? undefined : { turns: replay.turns, truncated: replay.truncated },
					),
					...(replayToClient ? {} : parent),
					parentClosed: true,
					...(replayFailed ? { replayFailed: true } : {}),
				},
			},
		};
	};
	options.transport.onRequest(ACP_SESSION_FORK_METHOD, (params) => {
		scope.guards.requireInitialized();
		return forkBoundSession(assertParamKeys(params, new Set(["sessionId", "turnId"])), "request", true);
	});
	// Standard ACP fork: the whole active branch, at its leaf, with the client MCP servers the request names in place of
	// the parent's.
	options.transport.onRequest("session/fork", (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "cwd", "mcpServers", "additionalDirectories"]));
		assertNoAdditionalDirectories(request.additionalDirectories);
		scope.guards.canonicalSessionCwd(request.cwd);
		const clientMcpServers = parseClientMcpServers(request.mcpServers, false);
		return forkBoundSession(request, "leaf", false, clientMcpServers);
	});
}
