// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The ACP server's context methods: the telemetry read model, asides, context status and ledger, and artifacts. */

import type { ContextOperationStatus } from "../core/context-operation.js";
import {
	ACP_CONTEXT_STATUS_METHOD,
	CONTEXT_OPERATION_CUSTOM_TYPE,
	readContextOperation,
} from "../core/context-operation.js";
import {
	ACP_ARTIFACTS_LIST_METHOD,
	ACP_ARTIFACTS_READ_METHOD,
	listAcpArtifacts,
	parseArtifactCategories,
	parseArtifactReadRequest,
	readAcpArtifact,
} from "./artifacts.js";
import {
	ACP_ASIDE_ASK_METHOD,
	ACP_ASIDE_CANCEL_METHOD,
	ACP_ASIDE_DRAFT_COUNTS,
	ACP_ASIDE_DRAFT_METHOD,
	ACP_ASIDE_QUESTION_MAX_CHARS,
	projectAsideAnswer,
	projectDraftOutcome,
} from "./aside.js";
import { ACP_CONTEXT_LEDGER_METHOD, projectContextLedger } from "./context-ledger.js";
import { AcpRequestError, acpErrorMessage } from "./errors.js";
import { assertParamKeys } from "./server-guards.js";
import type { PancodeAcpServerOptions } from "./server-options.js";
import type { AcpServerScope } from "./server-scope.js";
import { telemetryRequestHandlers } from "./telemetry-methods.js";

function requireAside(options: PancodeAcpServerOptions) {
	if (options.aside === undefined) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
	return options.aside;
}

function asideText(value: unknown, field: string) {
	const text = typeof value === "string" ? value.trim() : "";
	if (text.length === 0 || text.length > ACP_ASIDE_QUESTION_MAX_CHARS)
		throw new AcpRequestError(-32602, `${field} must be 1 to ${ACP_ASIDE_QUESTION_MAX_CHARS} characters`, {
			code: "invalid_params",
		});
	return text;
}

function artifactFailure(options: PancodeAcpServerOptions, what: string, error: unknown): never {
	if (error instanceof AcpRequestError) throw error;
	options.diagnostics?.(`artifact ${what} failed: ${acpErrorMessage(error)}`);
	throw new AcpRequestError(-32603, `artifacts could not be ${what === "list" ? "listed" : "read"}`, {
		code: "internal_error",
	});
}

export function registerAcpServerContext(scope: AcpServerScope): void {
	const { options } = scope;
	if (options.telemetryReadModel) {
		const handlers = telemetryRequestHandlers({
			model: options.telemetryReadModel,
			...(options.refreshQuota ? { refreshQuota: options.refreshQuota } : {}),
			params: assertParamKeys,
			session: scope.guards.getSession,
		});
		for (const [method, handler] of Object.entries(handlers))
			options.transport.onRequest(method, (params) => {
				scope.guards.requireInitialized();
				return handler(params);
			});
	}

	// /btw and /draft: one round beside the session at a time, cancellable, and
	// never a turn. The chat loop answers beside a turn in flight over a snapshot
	// of its history (#415); a refusal it reports is an outcome, not a protocol
	// error.
	const runAside = async <T>(sessionId: string, round: (signal: AbortSignal) => Promise<T>): Promise<T> => {
		if (scope.closingSessions.has(sessionId) || options.transport.closed)
			throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
		if (scope.asideRound !== null)
			throw new AcpRequestError(-32602, "a side question or draft is already running", { code: "aside_active" });
		const controller = new AbortController();
		let settle: () => void = () => {};
		const active = {
			sessionId,
			abort: controller,
			settled: new Promise<void>((resolve) => {
				settle = resolve;
			}),
		};
		scope.asideRound = active;
		try {
			return await round(controller.signal);
		} finally {
			if (scope.asideRound === active) scope.asideRound = null;
			settle();
		}
	};
	options.transport.onRequest(ACP_ASIDE_ASK_METHOD, async (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "question"]));
		const aside = requireAside(options);
		const session = scope.guards.getSession(request);
		const question = asideText(request.question, "question");
		return projectAsideAnswer(await runAside(session.id, (signal) => aside.ask(question, signal)), options.diagnostics);
	});
	options.transport.onRequest(ACP_ASIDE_DRAFT_METHOD, async (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "request", "count"]));
		const aside = requireAside(options);
		const session = scope.guards.getSession(request);
		const text = asideText(request.request, "request");
		const count = request.count ?? ACP_ASIDE_DRAFT_COUNTS.default;
		if (
			typeof count !== "number" ||
			!Number.isInteger(count) ||
			count < ACP_ASIDE_DRAFT_COUNTS.min ||
			count > ACP_ASIDE_DRAFT_COUNTS.max
		)
			throw new AcpRequestError(-32602, `count must be ${ACP_ASIDE_DRAFT_COUNTS.min} to ${ACP_ASIDE_DRAFT_COUNTS.max}`, {
				code: "invalid_params",
			});
		return projectDraftOutcome(
			await runAside(session.id, (signal) => aside.draft(text, count, signal)),
			options.diagnostics,
		);
	});
	options.transport.onRequest(ACP_ASIDE_CANCEL_METHOD, (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		requireAside(options);
		scope.guards.getSession(request);
		const round = scope.asideRound;
		round?.abort.abort();
		return { cancelled: round !== null };
	});

	options.transport.onRequest(ACP_CONTEXT_STATUS_METHOD, (params): ContextOperationStatus => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (!options.contextLedger) throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		const session = scope.guards.getSession(request);
		if (session.id !== scope.boundSessionId)
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		const current =
			scope.contextActivity?.operation?.sessionId === session.id &&
			scope.contextActivity.operation.cwd === scope.canonicalCwd
				? scope.contextActivity
				: null;
		const recorded = [...(options.readSessionEntries?.(session.id) ?? [])].reverse().flatMap((entry) => {
			if (entry.kind !== "custom" || entry.customType !== CONTEXT_OPERATION_CUSTOM_TYPE) return [];
			const operation = readContextOperation(entry.data);
			return operation?.outcome && operation.sessionId === session.id && operation.cwd === scope.canonicalCwd
				? [operation]
				: [];
		});
		return {
			version: 1,
			active: current && !current.operation?.outcome ? current : null,
			latest: current?.operation?.outcome ? current.operation : (recorded[0] ?? null),
		};
	});

	// The terminal's /context window view, read and never recomputed.
	options.transport.onRequest(ACP_CONTEXT_LEDGER_METHOD, (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.contextLedger === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		scope.guards.getSession(request);
		try {
			return projectContextLedger(options.contextLedger());
		} catch (error) {
			options.diagnostics?.(`context ledger failed: ${acpErrorMessage(error)}`);
			throw new AcpRequestError(-32603, "context ledger could not be read", { code: "internal_error" });
		}
	});

	// The terminal's /view artifacts, from the overlay's own providers.
	const artifactDeps = (request: Record<string, unknown>) => {
		scope.guards.requireInitialized();
		if (options.artifacts === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const session = scope.guards.getSession(request);
		const deps = options.artifacts.deps(session.id);
		if (deps === null) {
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		}
		return deps;
	};
	options.transport.onRequest(ACP_ARTIFACTS_LIST_METHOD, async (params) => {
		const request = assertParamKeys(params, new Set(["sessionId", "categories"]));
		const deps = artifactDeps(request);
		const categories = parseArtifactCategories(request.categories);
		try {
			return await listAcpArtifacts(deps, categories);
		} catch (error) {
			return artifactFailure(options, "list", error);
		}
	});
	options.transport.onRequest(ACP_ARTIFACTS_READ_METHOD, async (params) => {
		const request = assertParamKeys(params, new Set(["sessionId", "id", "offset", "limit", "details"]));
		const deps = artifactDeps(request);
		const read = parseArtifactReadRequest(request);
		try {
			return await readAcpArtifact(deps, read);
		} catch (error) {
			return artifactFailure(options, "read", error);
		}
	});
}
