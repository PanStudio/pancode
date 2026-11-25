// SPDX-License-Identifier: LicenseRef-PanCode-1.0 AND MIT
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Split from slash-commands.ts, which adapts pi-coding-agent's BUILTIN_SLASH_COMMANDS registry.

import type { SlashCommand } from "../slash-command-types.js";
import type { ParsedArgs } from "../slash-spec.js";

/**
 * A registered command whose arguments do not parse is a mistake to report,
 * not a chat message to send. Falling through to `unknown` submitted the raw
 * text to the model, which then answered it conversationally while the
 * operator believed a setting had changed and nothing had. `unknown` stays
 * reserved for input that matched no command at all, so pasted text beginning
 * with a slash still reaches the model.
 */
export function fromArgsOrUsage(name: string, command: SlashCommand): (parsed: ParsedArgs) => SlashCommand {
	return (parsed) => (parsed.error ? { kind: "usage-error", command: name, reason: parsed.error } : command);
}

/** A usage answer for `command`, with the reason the line did not parse and the verb whose usage applies. */
export function usageError(command: string, reason?: string, subcommand?: string): SlashCommand {
	return {
		kind: "usage-error",
		command,
		...(reason !== undefined && reason.length > 0 ? { reason } : {}),
		...(subcommand !== undefined ? { subcommand } : {}),
	};
}
