// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The ACP server's operator shell method: one shell line run in a session's workspace and recorded in its ledger. */

import { randomUUID } from "node:crypto";
import type { BashCommandProgress } from "../core/bash-exec.js";
import { combineLiveBashOutput } from "../core/bash-exec.js";
import { ToolNames } from "../core/tool-names.js";
import { turnAllowsTool } from "../core/turn-constraints.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { runOperatorShellLine } from "../domains/session/operator-shell.js";
import {
	redactFinalUrlCredentials,
	redactStreamingUrlCredentials,
	redactUrlCredentials,
} from "../lib/secrets/redaction.js";
import { AcpRequestError, acpErrorMessage } from "./errors.js";
import { boundString } from "./server-bounds.js";
import { assertParamKeys } from "./server-guards.js";
import { branchesWired } from "./server-options.js";
import type { AcpServerScope } from "./server-scope.js";
import { requireShellCommand, shellOutputTail } from "./server-session-input.js";
import { ACP_MAX_TOOL_TITLE_BYTES, toolCallContent } from "./server-tool-updates.js";
import type { AcpToolCallStatus, AcpToolKind } from "./types.js";
import {
	ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL,
	ACP_MIN_TOOL_PROGRESS_INTERVAL_MS,
	ACP_SESSION_SHELL_METHOD,
	ACP_SHELL_META_KEY,
} from "./types.js";
import type { AcpShellResult } from "./types-session.js";

export function registerAcpServerShell(scope: AcpServerScope): void {
	const { options } = scope;
	options.transport.onRequest(ACP_SESSION_SHELL_METHOD, async (params): Promise<AcpShellResult> => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "command", "excludeFromContext"]));
		const session = scope.guards.getSession(request);
		const label = options.labelOperatorCommand;
		const durable = options.session;
		const resetForSession = options.chat.resetForSession;
		if (label === undefined || durable === undefined || resetForSession === undefined || !branchesWired(options)) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const command = requireShellCommand(request.command);
		if (request.excludeFromContext !== undefined && typeof request.excludeFromContext !== "boolean") {
			throw new AcpRequestError(-32602, "excludeFromContext must be a boolean", { code: "invalid_params" });
		}
		const excludeFromContext = request.excludeFromContext === true;
		// The line runs outside any tool call, so the session's limits screen it
		// as they screen the model's own bash.
		if (scope.standingLimits?.readOnly === true || !turnAllowsTool(scope.standingLimits, ToolNames.Bash)) {
			throw new AcpRequestError(
				-32602,
				scope.standingLimits?.readOnly === true
					? "a shell line can write and the ceiling is read-only. Nothing ran"
					: "a shell line runs bash and the ceiling withholds it. Nothing ran",
				{ code: "ceiling_refused" },
			);
		}
		if (scope.closingSessions.has(session.id)) {
			throw new AcpRequestError(-32002, "unknown ACP session", { code: "session_unknown" });
		}
		// The terminal's two admission guards. A turn's context would change
		// underneath it when the line's entry lands, and one line runs at a time.
		if (session.activePrompt !== null || options.chat.isStreaming()) {
			throw new AcpRequestError(-32602, "a turn is running; cancel it before running a shell line", {
				code: "prompt_active",
			});
		}
		if (scope.contextCommandInFlight !== null || scope.activeShell !== null) {
			throw new AcpRequestError(-32602, "a shell line is already running; cancel it first", { code: "shell_active" });
		}
		if (durable.current()?.id !== session.id) durable.resume(session.id);
		const abort = new AbortController();
		let settle: () => void = () => {};
		const settled = new Promise<void>((resolveSettled) => {
			settle = resolveSettled;
		});
		scope.activeShell = { sessionId: session.id, abort, settled };
		// The line is the operator's, not the agent's: its frames carry this key
		// instead of agent attribution, and the same call shape a `bash` row has.
		const meta = { [ACP_SHELL_META_KEY]: { version: 1, excludeFromContext } };
		const toolCallId = `shell_${randomUUID()}`;
		const shownCommand = redactUrlCredentials(command);
		const title = boundString(shownCommand, ACP_MAX_TOOL_TITLE_BYTES);
		const notify = (update: Record<string, unknown>): void => {
			try {
				options.transport.notify("session/update", { sessionId: session.id, update, _meta: meta });
			} catch {
				options.diagnostics?.("failed to send a shell line update");
			}
		};
		// The tool-progress opt-in and its bounds, applied to the line's cumulative output tail.
		let frames = 0;
		let lastSentAt = Number.NEGATIVE_INFINITY;
		let lastText = "";
		const onUpdate = (progress: BashCommandProgress): void => {
			const text = shellOutputTail(redactStreamingUrlCredentials(combineLiveBashOutput(progress)));
			const sentAt = scope.now();
			if (
				text.length === 0 ||
				text === lastText ||
				frames >= ACP_MAX_TOOL_PROGRESS_FRAMES_PER_CALL ||
				sentAt - lastSentAt < ACP_MIN_TOOL_PROGRESS_INTERVAL_MS
			) {
				return;
			}
			frames += 1;
			lastSentAt = sentAt;
			lastText = text;
			notify({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", content: toolCallContent(text) });
		};
		try {
			const parentTurnId = durable.leafId() ?? null;
			notify({
				sessionUpdate: "tool_call",
				toolCallId,
				name: "shell",
				title,
				kind: "execute" satisfies AcpToolKind,
				status: "in_progress" satisfies AcpToolCallStatus,
				rawInput: { command: shownCommand, excludeFromContext },
			});
			let entry: SessionEntry;
			let run: Awaited<ReturnType<typeof runOperatorShellLine>>;
			try {
				run = await runOperatorShellLine({
					command,
					cwd: session.cwd,
					excludeFromContext,
					parentTurnId,
					signal: abort.signal,
					label,
					...(scope.handshake.toolProgressEnabled ? { onUpdate } : {}),
				});
				if (run.unlabeled !== null) options.diagnostics?.(`shell output kept out of context: ${run.unlabeled}`);
				options.beforeShellEntryRecorded?.();
				entry = durable.appendEntry(run.entry);
				// As in the terminal: the entry stays anchored where the line started,
				// and the context is rebuilt from the leaf the session has now.
				const leafTurnId = durable.leafId() ?? parentTurnId;
				resetForSession.call(
					options.chat,
					leafTurnId,
					scope.open.prepareRestore(session.id, leafTurnId, "leaf", false).replayMessages,
				);
			} catch (err) {
				options.diagnostics?.(`shell line failed: ${acpErrorMessage(err instanceof Error ? err.message : String(err))}`);
				notify({ sessionUpdate: "tool_call_update", toolCallId, title, kind: "execute", status: "failed" });
				throw new AcpRequestError(-32603, "the shell line could not be run or recorded", { code: "shell_failed" });
			}
			const { result } = run;
			const output = shellOutputTail(
				redactFinalUrlCredentials(
					entry.kind === "bashExecution" ? entry.output : run.entry.output,
					!result.aborted && !result.timedOut,
				),
			);
			const settledResult = {
				exitCode: result.exitCode,
				cancelled: result.aborted,
				timedOut: result.timedOut,
				truncated: run.entry.truncated,
				excludedFromContext: run.entry.excludeFromContext === true,
				...(run.unlabeled !== null ? { unlabeled: true } : {}),
			};
			notify({
				sessionUpdate: "tool_call_update",
				toolCallId,
				title,
				kind: "execute",
				status: (result.exitCode === 0 && !result.aborted && !result.timedOut
					? "completed"
					: "failed") satisfies AcpToolCallStatus,
				...(output.length > 0 ? { content: toolCallContent(output) } : {}),
				rawOutput: settledResult,
			});
			return { turnId: entry.turnId, ...settledResult, output, outputBytes: result.outputBytes };
		} finally {
			if (scope.activeShell?.abort === abort) scope.activeShell = null;
			settle();
		}
	});
}
