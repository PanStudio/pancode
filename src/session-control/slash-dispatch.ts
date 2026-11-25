// SPDX-License-Identifier: LicenseRef-PanCode-1.0 AND MIT
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Split from slash-commands.ts, which adapts pi-coding-agent's BUILTIN_SLASH_COMMANDS registry.
import { promptRefs } from "../domains/extensions/operator-commands.js";
import { extensionFailureMessage, resolveExtensionLine } from "./extension-line.js";
import { promptSourceLabel } from "./prompt-source-label.js";
import type {
	PromptReferenceCard,
	SlashCommand,
	SlashCommandContext,
	SlashCommandDispatchResult,
} from "./slash-command-types.js";
import { answerUsage, HANDLER_BY_KIND } from "./slash-commands.js";
import { closestCommand } from "./slash-reference.js";

/**
 * Dispatches a parsed SlashCommand to its owning registry entry. `empty` is a
 * no-op and `unknown` falls through to chat submission; every other kind
 * resolves to exactly one registry entry at module load. The result tells the
 * editor whether dispatch accepted the line or left it as a correctable draft.
 */
export function dispatchSlashCommand(command: SlashCommand, ctx: SlashCommandContext): SlashCommandDispatchResult {
	if (command.kind === "empty") return "rejected";
	if (command.kind === "unknown") {
		ctx.submitChat(command.text);
		return "accepted";
	}
	if (command.kind === "unknown-command") {
		// The registry does not own the token, but a prompt template might. The
		// parser stays pure, so the lookup happens here, and only for a spelling
		// that matched no command: `/name` is how every other agent invokes the
		// commands sitting in the roots PanCode reads, and answering "not a command"
		// for one that is loaded made the whole foreign prompt surface unreachable.
		const runtime = ctx.operatorExtensions;
		// Only names decide a takeover, and this runs before a typo's notice can paint.
		const line = resolveExtensionLine(
			command.text,
			command.token,
			runtime,
			promptRefs((ctx.listPromptsForDisplay ?? ctx.listPrompts)?.().items ?? []),
		);
		if (line?.kind === "refuse") {
			ctx.notice(line.settling ? "warn" : "error", line.message);
			ctx.render?.();
			return "rejected";
		}
		if (line?.kind === "run" && runtime) {
			const runLocal = ctx.runLocalOperation ?? ((operation: () => Promise<void>) => void operation());
			runLocal(async () => {
				try {
					const output = await runtime.invoke(line.token, line.args, promptRefs(ctx.listPrompts?.().items ?? []));
					if (ctx.showExtensionOutput) ctx.showExtensionOutput(line.token, output, line.extensionId);
					else ctx.io.stdout(`${output.text}\n`);
				} catch (error) {
					// A deferred runtime can become unavailable while starting on first use.
					// Re-enter ordinary prompt dispatch only after the manager withdraws the alias.
					if (
						line.takeover &&
						!runtime
							.commands(promptRefs(ctx.listPrompts?.().items ?? []))
							.some((row) => row.invocation === line.token && row.available)
					) {
						dispatchSlashCommand(command, ctx);
						return;
					}
					ctx.notice("error", extensionFailureMessage(line.token, line.extensionId, error, runtime));
				}
			});
			return "accepted";
		}
		const expansion = ctx.expandPromptTemplate?.(command.text);
		if (expansion?.expanded === true) {
			ctx.submitChat(command.text);
			return "accepted";
		}
		// A display-only template is answered here, for the operator, and the
		// model is never told it was asked: no turn, no session entry, no tokens.
		if (expansion?.expanded === false && expansion.display) {
			const { template, text } = expansion.display;
			const card: PromptReferenceCard = {
				command: template.name,
				source: promptSourceLabel(template.sourceInfo),
				text,
			};
			if (ctx.showReference) ctx.showReference(card);
			else ctx.io.stdout(`/${card.command} (${card.source})\n${card.text}\n`);
			ctx.render?.();
			return "accepted";
		}
		// A template that exists and refused is not a typo. Its reason reaches the
		// operator and nothing reaches the model.
		const refusal = expansion?.expanded === false ? expansion.refusal : undefined;
		// A command that became a key is answered with that key, and the line is
		// spent like any command that ran: nothing in it is left to correct.
		const key =
			refusal || !Object.hasOwn(COMMANDS_NOW_KEYS, command.token) ? undefined : COMMANDS_NOW_KEYS[command.token];
		if (key !== undefined && command.text.trim() === `/${command.token}`) {
			ctx.notice("info", `/${command.token} is now a key: press ${key}.`);
			ctx.render?.();
			return "accepted";
		}
		const closest = refusal ? null : closestCommand(command.token);
		ctx.notice(
			"error",
			refusal
				? refusal.message
				: closest
					? `/${command.token} is not a command. Closest: /${closest.typed}${closest.runs ? ` (runs /${closest.runs})` : ""}. /help lists them all.`
					: `/${command.token} is not a command. Type /help for the list.`,
		);
		ctx.render?.();
		return "rejected";
	}
	if (command.kind === "usage-error") return answerUsage(command, ctx);
	const entry = HANDLER_BY_KIND.get(command.kind);
	if (!entry) return "rejected";
	return entry.handle(command, ctx) === "rejected" ? "rejected" : "accepted";
}

/** Commands that became keys, with the key that does the same thing now. */
const COMMANDS_NOW_KEYS: Readonly<Record<string, string>> = {
	interrupt: "Alt+S",
	editor: "Alt+G",
	background: "Ctrl+G d",
	notifications: "Ctrl+G x",
};
