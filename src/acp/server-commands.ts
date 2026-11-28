// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The ACP server's slash-command catalog, its announcements, and the extension/hub reload and command methods. */

import type { AcpCommandCatalog } from "./commands.js";
import { AcpRequestError, acpErrorMessage } from "./errors.js";
import {
	ACP_EXTENSIONS_LIST_METHOD,
	ACP_EXTENSIONS_RELOAD_METHOD,
	ACP_HUB_RELOAD_METHOD,
	projectExtensionReload,
	projectExtensions,
} from "./extensions.js";
import { boundString } from "./server-bounds.js";
import { assertParamKeys } from "./server-guards.js";
import type { AcpServerScope } from "./server-scope.js";
import { reportConsentAsk } from "./server-tool-updates.js";
import { ACP_COMMANDS_INVOKE_METHOD, ACP_COMMANDS_LIST_METHOD } from "./types.js";

export function createAcpServerCommands(scope: AcpServerScope) {
	const { options } = scope;
	// The catalog is rebuilt from `commandReference()` on every call and a
	// palette legitimately re-reads it after a reload, so it is memoized against
	// a client that polls and against every prompt that checks for a typed
	// command. Availability is fixed by the host callbacks wired when this server
	// is created; session/route changes do not alter that wiring.
	let commandCatalog: AcpCommandCatalog | null = null;
	const catalog = () => {
		if (options.commands === undefined) return undefined;
		commandCatalog ??= options.commands.catalog();
		return commandCatalog;
	};
	const availableCommands = () =>
		catalog()
			?.commands.filter(
				(command) =>
					(command.injectsUserTurn !== true || options.chat.whenSettled !== undefined) &&
					(command.streams === undefined || command.injectsUserTurn === true || command.promptTurn === true),
			)
			.map((command) => ({
				name: command.name,
				description: command.summary,
				input: { hint: command.usage },
			})) ?? [];
	// The announcement also names the prompts and extension commands a line may
	// type, so a client's palette offers what the terminal's does (WTF-P F05).
	// They are screened as typed lines, never invoked as built-in commands.
	const announceCommands = (sessionId: string) => {
		if (options.commands === undefined) return;
		const builtIn = availableCommands();
		const typed = (options.commands.typedCommands?.() ?? []).filter(
			(entry) => !builtIn.some((command) => command.name === entry.name),
		);
		options.transport.notify("session/update", {
			sessionId,
			update: { sessionUpdate: "available_commands_update", availableCommands: [...builtIn, ...typed] },
		});
	};

	// The /extensions view: what this session loaded, never paths or provenance.
	options.transport.onRequest(ACP_EXTENSIONS_LIST_METHOD, (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.extensions === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		scope.guards.getSession(request);
		return projectExtensions(options.extensions.list());
	});

	// /reload extensions. Hooks and extension resources change together, so a
	// reload waits for a running turn rather than swapping them under it.
	options.transport.onRequest(ACP_EXTENSIONS_RELOAD_METHOD, (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.extensions === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const session = scope.guards.getSession(request);
		scope.guards.requireIdle(session, "reload extensions");
		const outcome = projectExtensionReload(options.extensions.reload());
		announceCommands(session.id);
		return outcome;
	});

	// /reload hub, so a hub change made outside this session reaches it.
	// A failed reload is reported as failed; the previous resources stay live.
	options.transport.onRequest(ACP_HUB_RELOAD_METHOD, (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId"]));
		if (options.hubReload === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const session = scope.guards.getSession(request);
		scope.guards.requireIdle(session, "reload the hub");
		try {
			const refreshed = { status: "refreshed" as const, ...options.hubReload() };
			announceCommands(session.id);
			return refreshed;
		} catch (error) {
			options.diagnostics?.(`hub reload failed: ${acpErrorMessage(error)}`);
			return { status: "failed" as const, error: boundString(acpErrorMessage(error), 1024) };
		}
	});

	options.transport.onRequest(ACP_COMMANDS_LIST_METHOD, (params) => {
		scope.guards.requireInitialized();
		assertParamKeys(params, new Set());
		const listed = catalog();
		if (listed === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		const prompts = options.commands?.prompts?.();
		const extensionCommands = options.commands?.extensionCommands?.();
		return {
			...listed,
			...(prompts !== undefined ? { prompts } : {}),
			...(extensionCommands !== undefined ? { extensionCommands } : {}),
		};
	});

	options.transport.onRequest(ACP_COMMANDS_INVOKE_METHOD, (params) => {
		scope.guards.requireInitialized();
		const request = assertParamKeys(params, new Set(["sessionId", "command", "argv"]));
		const session = scope.guards.getSession(request);
		if (request.command === "context" || request.command === "compact")
			scope.guards.requireIdle(session, "run a context operation");
		if (options.commands === undefined) {
			throw new AcpRequestError(-32601, "method not found", { code: "method_not_found" });
		}
		// Jobs belong to the one session this process hosts. The generic path forwards only command and
		// argv, so the requested identity is checked here, before anything is created, listed or stopped.
		if (request.command === "loop" && session.id !== scope.boundSessionId) {
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		}
		// Four of the thirteen put a user turn into the session. Doing that while
		// a prompt is in flight is the steering path, not the submit path: the
		// turn already running owns the stopReason, and a second unrequested
		// submission folds content into it that the client never asked for. Those
		// four are refused here and the client is told to use
		// `_pancode/session/steer` instead; the other nine are unaffected.
		if (session.activePrompt !== null && options.commands.injectsUserTurn(request.command, request.argv)) {
			throw new AcpRequestError(-32602, "this command submits a user turn and a prompt is active", {
				code: "prompt_active",
				reason: "steer-instead",
			});
		}
		if (scope.activeShell !== null && options.commands.injectsUserTurn(request.command, request.argv)) {
			throw new AcpRequestError(-32602, "this command submits a user turn and a shell line is running", {
				code: "shell_active",
			});
		}
		// A prompt-turn command asks for approvals that bind to a call on the
		// wire, and outside a prompt there is no turn to put that call in. It is
		// refused here with the path that works, rather than admitted and denied.
		if (options.commands.promptTurn?.(request.command, request.argv) === true) {
			throw new AcpRequestError(-32602, "this command runs as a conversation turn; send it as a prompt", {
				code: "prompt_turn_required",
			});
		}
		scope.guards.assertCommandWithinCeiling(options.commands, request.command, request.argv);
		if (request.command !== "context" && request.command !== "compact")
			return options.commands.invoke({
				command: request.command,
				argv: request.argv,
				askConsent: reportConsentAsk(options.transport, session.id),
			});
		if (session.id !== scope.boundSessionId)
			throw new AcpRequestError(-32002, "session is not the bound session", { code: "session_not_bound" });
		if (scope.activeShell !== null)
			throw new AcpRequestError(-32602, "a shell line is running", { code: "shell_active" });
		const command = Promise.resolve().then(() =>
			options.commands?.invoke({ command: request.command, argv: request.argv }),
		);
		scope.contextCommandInFlight = command;
		return command.finally(() => {
			if (scope.contextCommandInFlight === command) scope.contextCommandInFlight = null;
		});
	});
	return { announceCommands, availableCommands };
}

export type AcpServerCommands = ReturnType<typeof createAcpServerCommands>;
