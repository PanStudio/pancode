// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The ACP server's handoff methods: prepare a successor document, commit it, or cancel it. */

import { randomUUID } from "node:crypto";
import { AcpRequestError, acpErrorMessage } from "./errors.js";
import { boundString, requireBoundedClientString, safeStoredIdentifier, utf8Bytes } from "./server-bounds.js";
import { requireBranches, successorCeiling } from "./server-branches.js";
import { checkpointBeforeClose } from "./server-catalog.js";
import { ACP_MAX_SESSION_ID_BYTES, assertParamKeys } from "./server-guards.js";
import { modelsResultMeta, sessionConfig } from "./server-models.js";
import type { AcpHandoffControl, PancodeAcpServerOptions } from "./server-options.js";
import type { PreparedAcpReplay } from "./server-replay.js";
import { sessionResultMeta } from "./server-replay.js";
import type { AcpServerScope } from "./server-scope.js";
import type { AcpServerSession } from "./server-tool-updates.js";
import {
	ACP_HANDOFF_CANCEL_METHOD,
	ACP_HANDOFF_COMMIT_METHOD,
	ACP_HANDOFF_PREPARE_METHOD,
	ACP_SESSION_META_KEY,
} from "./types.js";
import type { AcpHandoffCancelResult, AcpHandoffCommitResult, AcpHandoffPrepareResult } from "./types-session.js";

const ACP_MAX_HANDOFF_GOAL_BYTES = 2048;

/** A rendered handoff is bounded list by list; this is the ceiling on a reviewed edit of it. */
const ACP_MAX_HANDOFF_DOCUMENT_BYTES = 128 * 1024;

const ACP_MAX_HANDOFF_REASON_BYTES = 2048;

function handoffRefusal(level: "warn" | "error", code: string, reason: string) {
	return {
		status: "refused" as const,
		level,
		code,
		reason: boundString(reason, ACP_MAX_HANDOFF_REASON_BYTES),
	};
}

function requireHandoff(options: PancodeAcpServerOptions) {
	const control = options.handoff;
	const branches = requireBranches(options);
	if (control === undefined) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
	return { control, ...branches };
}

/** Reviewed text keeps its line structure; any other control character is refused. */
function handoffDocument(value: unknown): string {
	if (typeof value !== "string" || utf8Bytes(value) > ACP_MAX_HANDOFF_DOCUMENT_BYTES) {
		throw new AcpRequestError(-32602, "document is invalid", { code: "invalid_params" });
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character other than a line break is the refusal.
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
		throw new AcpRequestError(-32602, "document is invalid", { code: "invalid_params" });
	}
	return value;
}

export function registerAcpServerHandoff(scope: AcpServerScope): void {
	const { options } = scope;
	// /handoff, first half: extract with one repair and render the document a
	// person reviews. Nothing is written; the draft waits here under an id.
	options.transport.onRequest(ACP_HANDOFF_PREPARE_METHOD, async (params): Promise<AcpHandoffPrepareResult> => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "goal"]));
		const { control } = requireHandoff(options);
		const bound = scope.guards.getSession(request);
		scope.guards.requireIdle(bound, "hand off");
		const goal = requireBoundedClientString(request.goal, "goal", ACP_MAX_HANDOFF_GOAL_BYTES, { allowEmpty: true });
		if (scope.handoffPreparing) return handoffRefusal("warn", "busy", "a handoff document is already being drawn up");
		scope.handoffPreparing = true;
		const serial = scope.promptSerial;
		let outcome: Awaited<ReturnType<AcpHandoffControl["prepare"]>>;
		try {
			outcome = await control.prepare(goal);
		} catch (error) {
			options.diagnostics?.(`handoff extraction failed: ${acpErrorMessage(error)}`);
			return handoffRefusal("error", "extraction", "the extraction round failed");
		} finally {
			scope.handoffPreparing = false;
		}
		if (!outcome.ok) {
			// A failed round carries the provider's own words; those stay on the stderr tail.
			if (outcome.code === "provider") {
				options.diagnostics?.(`handoff extraction failed: ${acpErrorMessage(outcome.reason)}`);
				return handoffRefusal(
					outcome.level,
					outcome.code,
					"the model round failed; the agent's diagnostics carry the provider's answer",
				);
			}
			return handoffRefusal(outcome.level, outcome.code, outcome.reason);
		}
		if (serial !== scope.promptSerial || scope.sessions.get(bound.id) !== bound) {
			return handoffRefusal("warn", "stale", "the conversation moved while the document was drawn; nothing was written");
		}
		if (utf8Bytes(outcome.draft.document) > ACP_MAX_HANDOFF_DOCUMENT_BYTES) {
			return handoffRefusal("error", "too_large", "the handoff document is larger than a client can review");
		}
		const handoffId = randomUUID();
		scope.pendingHandoff = { handoffId, sessionId: bound.id, draft: outcome.draft };
		return {
			status: "ready" as const,
			handoffId,
			goal: outcome.draft.goal,
			fromSessionId: outcome.draft.fromSessionId,
			document: outcome.draft.document,
		};
	});

	// /handoff, second half: seed the successor with the reviewed document and
	// move the process binding to it, the same way a fork does.
	options.transport.onRequest(ACP_HANDOFF_COMMIT_METHOD, async (params): Promise<AcpHandoffCommitResult> => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "handoffId", "document"]));
		const { control, session, resetForSession } = requireHandoff(options);
		const bound = scope.guards.getSession(request);
		scope.guards.requireIdle(bound, "hand off");
		const ceiling = successorCeiling(options, bound, request);
		const handoffId = requireBoundedClientString(request.handoffId, "handoffId", ACP_MAX_SESSION_ID_BYTES);
		const document = handoffDocument(request.document);
		const pending = scope.pendingHandoff;
		if (pending === null || pending.handoffId !== handoffId || pending.sessionId !== bound.id) {
			return handoffRefusal(
				"warn",
				"stale",
				"this document no longer describes the conversation; draw it up again. Nothing was written",
			);
		}
		// The successor replaces the bound session, whose ledger closes. An empty review changes nothing.
		if (document.trim().length > 0) {
			await checkpointBeforeClose(options, bound.id, "handoff");
			scope.guards.requireStillIdle(bound, "hand off");
		}
		if (scope.pendingHandoff !== pending) {
			return handoffRefusal(
				"warn",
				"stale",
				"this document no longer describes the conversation; draw it up again. Nothing was written",
			);
		}
		const outcome = control.commit(pending.draft, document);
		if (!outcome.ok) {
			// An empty review is the reviewer's to fix; every other refusal ends the draft.
			if (outcome.code !== "empty") scope.pendingHandoff = null;
			return handoffRefusal(outcome.level, outcome.code, outcome.reason);
		}
		scope.pendingHandoff = null;
		const toSessionId = outcome.toSessionId;
		const current = session.current();
		if (current?.id !== toSessionId || safeStoredIdentifier(toSessionId, ACP_MAX_SESSION_ID_BYTES) === null) {
			throw new AcpRequestError(-32603, "handoff failed", { code: "internal_error" });
		}
		const successor: AcpServerSession = {
			...bound,
			id: toSessionId,
			createdAt: current.createdAt,
			activePrompt: null,
			...(ceiling !== undefined ? { ceiling } : {}),
		};
		scope.sessions.delete(bound.id);
		let replay: PreparedAcpReplay | undefined;
		try {
			const restore = scope.open.prepareRestore(toSessionId, null, "leaf", true);
			resetForSession(null, restore.replayMessages);
			replay = restore.replay;
		} catch (error) {
			options.diagnostics?.(`handoff replay failed: ${acpErrorMessage(error)}`);
			resetForSession(null);
		}
		for (const warning of outcome.warnings) options.diagnostics?.(`handoff: ${warning}`);
		const ceilingEcho = scope.guards.applySessionCeiling(successor);
		scope.open.bindRestored(successor, replay);
		return {
			status: "committed" as const,
			sessionId: toSessionId,
			fromSessionId: bound.id,
			warnings: outcome.warnings.slice(0, 8).map((warning) => boundString(warning, ACP_MAX_HANDOFF_REASON_BYTES)),
			...sessionConfig(options, scope.listingFallbacks, successor),
			_meta: {
				...ceilingEcho,
				...modelsResultMeta(options, successor),
				[ACP_SESSION_META_KEY]: sessionResultMeta(successor, false),
			},
		};
	});

	options.transport.onRequest(ACP_HANDOFF_CANCEL_METHOD, (params): AcpHandoffCancelResult => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "handoffId"]));
		requireHandoff(options);
		const bound = scope.guards.getSession(request);
		const handoffId = requireBoundedClientString(request.handoffId, "handoffId", ACP_MAX_SESSION_ID_BYTES);
		const cancelled = scope.pendingHandoff?.handoffId === handoffId && scope.pendingHandoff.sessionId === bound.id;
		if (cancelled) scope.pendingHandoff = null;
		return { cancelled };
	});
}
