// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The request guards and session lookups every ACP server method shares. */

import { realpathSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { TurnConstraints } from "../core/turn-constraints.js";
import { isRecord } from "../core/type-guards.js";
import type { SessionMeta } from "../domains/session/contract.js";
import type { TelemetryView } from "../domains/telemetry/contract.js";
import type { AcpCommandControl } from "./commands.js";
import { ACP_SESSION_LIMIT_CODE, AcpRequestError } from "./errors.js";
import { ACP_WORKSPACE_META_KEY } from "./live-telemetry.js";
import { requireBoundedClientString, safeStoredIdentifier } from "./server-bounds.js";
import type { PancodeAcpServerOptions } from "./server-options.js";
import { ceilingBinds, ceilingMeta } from "./server-prompt-input.js";
import type { AcpServerScope } from "./server-scope.js";
import type { AcpServerSession } from "./server-tool-updates.js";
import { ACP_CEILING_META_KEY } from "./types.js";

export function assertParamKeys(params: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
	if (params === undefined) return {};
	if (!isRecord(params) || Object.keys(params).some((key) => key !== "_meta" && !allowed.has(key))) {
		throw new AcpRequestError(-32602, "invalid method parameters", { code: "invalid_params" });
	}
	return params;
}

export function assertCeilingEnforceable(options: PancodeAcpServerOptions, ceiling: TurnConstraints | undefined): void {
	if (ceiling !== undefined && options.chat.setToolCeiling === undefined) {
		throw new AcpRequestError(-32602, `this agent cannot enforce ${ACP_CEILING_META_KEY}`, {
			code: "ceiling_unsupported",
		});
	}
}

export const ACP_MAX_SESSION_ID_BYTES = 128;

export function sessionIdOf(params: unknown): string {
	return requireBoundedClientString(
		isRecord(params) ? params.sessionId : undefined,
		"sessionId",
		ACP_MAX_SESSION_ID_BYTES,
	);
}

export function createAcpServerGuards(scope: AcpServerScope) {
	const { options } = scope;
	/** The read model's live view of the bound session; null while it holds another session or is still seeding. */
	const liveSessionView = (): TelemetryView | null => {
		const view = options.telemetryReadModel?.live() ?? null;
		return view !== null && !view.seeding && view.sessionId === scope.boundSessionId ? view : null;
	};
	let sessionSlotReserved = false;
	const withSessionSlot = async <T>(bind: () => Promise<T>): Promise<T> => {
		// A close in flight frees the slot when it settles, and a client may send its next open without awaiting it.
		if (scope.closingSessions.size > 0) await Promise.allSettled([...scope.closingSessions.values()]);
		if (scope.sessionCreated || sessionSlotReserved) {
			const hosted = scope.boundSessionId === null ? "" : `; close ${scope.boundSessionId} first`;
			throw new AcpRequestError(ACP_SESSION_LIMIT_CODE, `this server hosts one session per process${hosted}`, {
				code: "session_limit",
			});
		}
		sessionSlotReserved = true;
		try {
			return await bind();
		} finally {
			sessionSlotReserved = false;
		}
	};
	const workspaceResultMeta = async (): Promise<Record<string, unknown>> => {
		const view = await scope.telemetry.workspace();
		return view === null ? {} : { [ACP_WORKSPACE_META_KEY]: view };
	};

	const requireInitialized = (): void => {
		if (!scope.handshake.initialized)
			throw new AcpRequestError(-32600, "initialize must be called first", { code: "not_initialized" });
	};

	const canonicalSessionCwd = (requested: unknown): string => {
		const mismatch = (): AcpRequestError =>
			new AcpRequestError(-32602, `session cwd does not match bound workspace root ${scope.canonicalCwd}`, {
				code: "session_cwd_mismatch",
			});
		if (typeof requested !== "string" || requested.trim().length === 0 || !isAbsolute(requested)) throw mismatch();
		let sessionCwd: string;
		try {
			sessionCwd = realpathSync(resolvePath(requested));
		} catch {
			throw mismatch();
		}
		if (sessionCwd !== scope.canonicalCwd) throw mismatch();
		return sessionCwd;
	};

	const workspaceHistory = (): SessionMeta[] => {
		const history = options.session?.history() ?? [];
		return history.filter((meta) => {
			if (safeStoredIdentifier(meta.id, ACP_MAX_SESSION_ID_BYTES) === null) return false;
			try {
				return realpathSync(resolvePath(meta.cwd)) === scope.canonicalCwd;
			} catch {
				return false;
			}
		});
	};

	const workspaceMeta = (sessionId: string): SessionMeta => {
		const meta = workspaceHistory().find((candidate) => candidate.id === sessionId);
		if (!meta) throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
		return meta;
	};

	const applyCeilings = (
		ceilings: ReadonlyArray<TurnConstraints | undefined>,
		lifetime: "session" | "prompt" = "session",
	): TurnConstraints | undefined => {
		scope.standingLimits = options.chat.setToolCeiling?.(ceilings, lifetime);
		return scope.standingLimits;
	};
	const assertCommandWithinCeiling = (control: AcpCommandControl, command: unknown, argv: unknown): void => {
		if (!ceilingBinds(scope.standingLimits)) return;
		const refusal =
			control.ceilingRefusal === undefined
				? "this agent cannot screen commands against a ceiling"
				: control.ceilingRefusal(command, argv, scope.standingLimits);
		if (refusal !== null) throw new AcpRequestError(-32602, refusal, { code: "ceiling_refused" });
	};
	/**
	 * Apply the bound session's ceiling as the chat's standing limits and return
	 * the echo for its response. Every way a session becomes bound goes through
	 * here, so a fork, a handoff or a load never runs under limits it did not echo.
	 */
	const applySessionCeiling = (session: AcpServerSession): Record<string, unknown> =>
		options.chat.setToolCeiling !== undefined ? ceilingMeta(applyCeilings([session.ceiling])) : {};
	const getSession = (params: unknown): AcpServerSession => {
		const id = sessionIdOf(params);
		const session = scope.sessions.get(id);
		if (session) return session;
		const child = scope.replacedSessions.get(id);
		if (child !== undefined)
			throw new AcpRequestError(-32002, `session ${id} was closed when its fork ${child} took this process`, {
				code: "session_replaced",
			});
		throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
	};

	/** A branch change rewrites the context a running turn is reading, so it waits for the turn. */
	const requireIdle = (session: AcpServerSession, action: string): void => {
		if (scope.activeShell !== null)
			throw new AcpRequestError(-32602, `cannot ${action} while a shell line is running`, { code: "shell_active" });
		if (
			scope.contextCommandInFlight !== null ||
			session.activePrompt !== null ||
			scope.activePromptState !== null ||
			options.chat.isStreaming()
		) {
			throw new AcpRequestError(-32602, `cannot ${action} during an active prompt`, { code: "prompt_active" });
		}
	};
	/** The checkpoint yields, so a request that arrived meanwhile may have closed or started work on the session. */
	const requireStillIdle = (session: AcpServerSession, action: string): void => {
		if (scope.sessions.get(session.id) !== session || scope.closingSessions.has(session.id)) {
			throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
		}
		requireIdle(session, action);
	};
	return {
		applyCeilings,
		applySessionCeiling,
		assertCommandWithinCeiling,
		canonicalSessionCwd,
		getSession,
		liveSessionView,
		requireIdle,
		requireInitialized,
		requireStillIdle,
		withSessionSlot,
		workspaceHistory,
		workspaceMeta,
		workspaceResultMeta,
	};
}

export type AcpServerGuards = ReturnType<typeof createAcpServerGuards>;
