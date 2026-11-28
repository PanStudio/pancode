// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The ACP server's session catalog methods: list, label, delete, and close. */

import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isRecord } from "../core/type-guards.js";
import { AcpRequestError } from "./errors.js";
import {
	requireBoundedClientString,
	safeConfiguredIdentifier,
	safeIso,
	safeStoredString,
	utf8Bytes,
} from "./server-bounds.js";
import { safeCount } from "./server-event-frames.js";
import { assertParamKeys, sessionIdOf } from "./server-guards.js";
import { ACP_MAX_SESSION_LIST_RESULT_BYTES } from "./server-models.js";
import type { PancodeAcpServerOptions } from "./server-options.js";
import type { AcpServerScope } from "./server-scope.js";
import type { AcpEmptyResult } from "./types.js";
import {
	ACP_MAX_MODEL_ID_BYTES,
	ACP_MAX_TARGET_ID_BYTES,
	ACP_SESSION_LABEL_METHOD,
	ACP_SESSION_LIST_METHOD,
	ACP_SESSION_META_KEY,
} from "./types.js";
import type { AcpSessionList, AcpSessionListRow } from "./types-session.js";

const ACP_MAX_LABEL_BYTES = 256;

/** How long teardown waits for accepted work to finish after cancellation. */
const ACP_PROMPT_SETTLE_BOUND_MS = 5000;

export async function settleAcpWork(pending: readonly Promise<unknown>[]): Promise<void> {
	if (pending.length === 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled(pending),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, ACP_PROMPT_SETTLE_BOUND_MS);
				timer.unref?.();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * A path that stops hosting a live, loaded session checkpoints it first, so meta.json records why its ledger
 * closed, as shutdown records its own. A failed checkpoint is reported and the close goes on.
 */
export async function checkpointBeforeClose(
	options: PancodeAcpServerOptions,
	sessionId: string,
	reason: "close" | "fork" | "handoff",
): Promise<void> {
	const durable = options.session;
	if (durable?.current()?.id !== sessionId) return;
	await durable.checkpoint(reason).catch((err: unknown) => {
		process.stderr.write(
			`[pancode:acp] ${reason} checkpoint failed: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	});
}

export function registerAcpServerCatalog(scope: AcpServerScope): void {
	const { options } = scope;
	options.transport.onRequest(ACP_SESSION_LIST_METHOD, (params): AcpSessionList => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["cwd", "cursor"]));
		if (options.session === undefined)
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		if (request.cwd !== undefined && request.cwd !== null) {
			if (typeof request.cwd !== "string" || !isAbsolute(request.cwd))
				throw new AcpRequestError(-32602, "cwd must be an absolute path", { code: "invalid_params" });
			let filterCwd: string;
			try {
				filterCwd = realpathSync(request.cwd);
			} catch {
				return { sessions: [] };
			}
			if (filterCwd !== scope.canonicalCwd) return { sessions: [] };
		}
		let start = 0;
		if (request.cursor !== undefined && request.cursor !== null) {
			if (typeof request.cursor !== "string" || request.cursor.length > 512)
				throw new AcpRequestError(-32602, "invalid session cursor", { code: "invalid_params" });
			let decoded: unknown;
			try {
				decoded = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8"));
			} catch {
				throw new AcpRequestError(-32602, "invalid session cursor", { code: "invalid_params" });
			}
			if (
				!isRecord(decoded) ||
				decoded.workspace !== scope.workspaceInstanceId ||
				!Number.isSafeInteger(decoded.start) ||
				(decoded.start as number) < 0 ||
				Buffer.from(JSON.stringify(decoded)).toString("base64url") !== request.cursor
			) {
				throw new AcpRequestError(-32602, "invalid session cursor", { code: "invalid_params" });
			}
			start = decoded.start as number;
		}
		const history = scope.guards.workspaceHistory().filter((meta) => meta.hasModelTurn !== false);
		const projected: AcpSessionListRow[] = [];
		let budgetBytes = utf8Bytes(JSON.stringify({ sessions: [] }));
		for (const meta of history.slice(start, start + 50)) {
			const label = safeStoredString(meta.name, ACP_MAX_LABEL_BYTES).trim();
			const messageCount = safeCount(meta.messageCount);
			const item = {
				sessionId: meta.id,
				cwd: scope.canonicalCwd,
				...(label.length > 0 ? { title: label } : {}),
				updatedAt: safeIso(meta.lastActivityAt ?? meta.endedAt ?? meta.createdAt),
				_meta: {
					[ACP_SESSION_META_KEY]: {
						createdAt: safeIso(meta.createdAt),
						endedAt: meta.endedAt === null ? null : safeIso(meta.endedAt),
						target: safeConfiguredIdentifier(meta.currentTarget ?? meta.target, ACP_MAX_TARGET_ID_BYTES),
						model: safeConfiguredIdentifier(meta.currentModel ?? meta.model, ACP_MAX_MODEL_ID_BYTES),
						...(meta.firstMessagePreview !== undefined
							? { firstMessagePreview: safeStoredString(meta.firstMessagePreview, ACP_MAX_LABEL_BYTES) }
							: {}),
						...(messageCount !== null ? { messageCount } : {}),
						...(meta.hasModelTurn !== undefined ? { hasModelTurn: meta.hasModelTurn } : {}),
						...(meta.lastActivityAt !== undefined ? { lastActivityAt: safeIso(meta.lastActivityAt) } : {}),
					},
				},
			};
			const itemBytes = utf8Bytes(JSON.stringify(item));
			const separatorBytes = projected.length > 0 ? 1 : 0;
			if (budgetBytes + separatorBytes + itemBytes > ACP_MAX_SESSION_LIST_RESULT_BYTES) {
				break;
			}
			projected.push(item);
			budgetBytes += separatorBytes + itemBytes;
		}
		return {
			sessions: projected,
			...(start + projected.length < history.length
				? {
						nextCursor: Buffer.from(
							JSON.stringify({ workspace: scope.workspaceInstanceId, start: start + projected.length }),
						).toString("base64url"),
					}
				: {}),
		};
	});

	options.transport.onRequest(ACP_SESSION_LABEL_METHOD, (params): AcpEmptyResult => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "label"]));
		const id = sessionIdOf(request);
		scope.guards.workspaceMeta(id);
		const label = requireBoundedClientString(request.label, "label", ACP_MAX_LABEL_BYTES, { allowEmpty: true });
		if (options.session === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		try {
			options.session.setName(label, id);
		} catch {
			throw new AcpRequestError(-32603, "session label could not be saved", { code: "internal_error" });
		}
		if (scope.sessions.has(id)) {
			options.transport.notify("session/update", {
				sessionId: id,
				update: { sessionUpdate: "session_info_update", title: label.length > 0 ? label : null },
			});
		}
		return {};
	});

	options.transport.onRequest("session/delete", (params): AcpEmptyResult => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		const id = sessionIdOf(request);
		const meta = scope.guards.workspaceMeta(id);
		// Delete never closes a session for the client: the refusal names the step that comes first (bt-12).
		const stillOpen =
			"session is still open; close it first (session/close, or the close action in the client that has it open), then delete it";
		if (scope.sessions.has(id) || meta.endedAt === null) {
			throw new AcpRequestError(-32602, stillOpen, { code: "session_open" });
		}
		if (options.session === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		try {
			options.session.deleteSession(id);
		} catch (error) {
			// The delete re-checks under the claim lock; a resume that won the race reopened it.
			if (error instanceof Error && error.message.includes("may still be open")) {
				throw new AcpRequestError(-32602, stillOpen, { code: "session_open" });
			}
			throw new AcpRequestError(-32603, "session could not be deleted", { code: "internal_error" });
		}
		return {};
	});

	options.transport.onRequest("session/close", (params) => {
		scope.guards.requireInitialized();
		const id = sessionIdOf(params);
		// Idempotent: a client tearing down cannot always know whether the server
		// already dropped the session, and a second close is not an error.
		if (!scope.sessions.has(id) && scope.closedSessionIds.has(id)) return {};
		const inFlightClose = scope.closingSessions.get(id);
		if (inFlightClose) return inFlightClose;
		const session = scope.guards.getSession(params);
		const close = (async (): Promise<Record<string, never>> => {
			const aside = scope.asideRound?.sessionId === session.id ? scope.asideRound : null;
			aside?.abort.abort();
			// The prompt writer must settle before the durable session is closed.
			scope.control.cancelSession(session, "session closed");
			if (session.activePrompt) {
				if (scope.promptSettled) await scope.promptSettled;
			}
			if (scope.contextCommandInFlight !== null && session.id === scope.boundSessionId)
				await scope.contextCommandInFlight.catch(() => undefined);
			// The aborted line still appends its entry; the ledger must outlive that write.
			if (scope.activeShell?.sessionId === session.id) await scope.activeShell.settled;
			if (aside !== null) await settleAcpWork([aside.settled]);
			if (options.session?.current()?.id === session.id) {
				await checkpointBeforeClose(options, session.id, "close");
				await options.session.close();
			}
			await options.mcpCapabilities?.detachClientServers();
			scope.sessions.delete(session.id);
			if (scope.boundSessionId === session.id) scope.boundSessionId = null;
			scope.sessionCreated = false;
			scope.closedSessionIds.add(session.id);
			// A reopened fork parent closes as itself, so a later request is no longer told a fork replaced it.
			scope.replacedSessions.delete(session.id);
			return {};
		})();
		scope.closingSessions.set(id, close);
		void close.then(
			() => scope.closingSessions.delete(id),
			() => scope.closingSessions.delete(id),
		);
		return close;
	});
}
