// SPDX-License-Identifier: LicenseRef-PanCode-1.0 AND MIT
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Split from slash-commands.ts, which adapts pi-coding-agent's BUILTIN_SLASH_COMMANDS registry.
import { bundleRequest } from "../../cli/report-bundle.js";
import type { ReportTextHost } from "../../domains/report/text-flow.js";
import type { BuiltinSlashCommand, SlashReportKind } from "../slash-command-types.js";
import { fromArgsOrUsage, usageError } from "./usage-error.js";

export const SESSION_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{
		name: "resume",
		rank: 1,
		acp: false,
		description: "Resume by id, unique id prefix, or exact unique name",
		group: "Session",
		kinds: ["resume"],
		args: { positionals: [{ name: "id|prefix|name", required: false, rest: true }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "resume", reason: parsed.error };
			const target = sessionNameArgument(parsed.rest ?? "");
			return target ? { kind: "resume", target } : { kind: "resume" };
		},
		handle(command, ctx) {
			if (command.kind === "resume") ctx.openResume?.(command.target);
		},
	},
	{
		name: "rename",
		rank: 2,
		acp: false,
		description: "Name this session, or confirm a local suggestion from the conversation",
		group: "Session",
		kinds: ["rename"],
		args: { positionals: [{ name: "name", required: false, rest: true }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "rename", reason: parsed.error };
			if (parsed.rest === undefined) return { kind: "rename" };
			const name = sessionNameArgument(parsed.rest);
			return name
				? { kind: "rename", name }
				: { kind: "usage-error", command: "rename", reason: "Session name must not be empty or whitespace-only" };
		},
		handle(command, ctx) {
			if (command.kind !== "rename") return;
			if (ctx.renameSession) ctx.renameSession(command.name);
			else ctx.notice("error", "/rename needs an interactive session");
		},
	},
	{
		name: "new",
		rank: 1,
		aliases: [{ name: "clear" }],
		acp: false,
		description: "Start a fresh session",
		group: "Session",
		kinds: ["new"],
		args: {},
		fromArgs: fromArgsOrUsage("new", { kind: "new" }),
		handle(_command, ctx) {
			ctx.startNewSession?.();
		},
	},
	{
		name: "report",
		rank: 3,
		acp: {
			subcommands: ["bug", "feature", "question", "status", "send", "forget", "security"],
			reads: ["status", "security"],
			readOnlyRefuses: ["send", "forget"],
		},
		description: "Preview, then send a bug, feature request or question to PanCode's maintainers",
		group: "PanCode",
		kinds: ["report", "report-status", "report-send", "report-forget", "report-security"],
		subcommandDescriptions: {
			bug: "Report a bug; the summary becomes the title",
			feature: "Ask for a feature",
			question: "Ask the maintainers a question",
			security: "Report a security problem privately",
			status: "List your reports and saved drafts",
			send: "Review and send a saved draft",
			forget: "Delete a saved draft",
		},
		args: {
			subcommands: {
				bug: { positionals: [{ name: "summary", required: false, rest: true }] },
				feature: { positionals: [{ name: "summary", required: false, rest: true }] },
				question: { positionals: [{ name: "summary", required: false, rest: true }] },
				security: {},
				status: {},
				send: {
					positionals: [{ name: "draft", required: true }],
					flags: [{ name: "--comment", takesValue: true, valueName: "n" }, { name: "--new" }],
				},
				forget: { positionals: [{ name: "id", required: true }] },
			},
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "report", reason: parsed.error };
			const sub = parsed.subcommand;
			if (sub === "status") return { kind: "report-status" };
			if (sub === "security") return { kind: "report-security" };
			if (sub === "send") {
				const draftId = parsed.positionals[0] ?? "";
				const comment = parsed.flags.get("--comment");
				if (comment !== undefined && parsed.flags.has("--new"))
					return { kind: "usage-error", command: "report", reason: "--comment and --new are alternatives; pass one" };
				if (comment !== undefined) {
					if (typeof comment !== "string" || !/^[1-9]\d*$/u.test(comment))
						return { kind: "usage-error", command: "report", reason: "--comment takes an issue number" };
					return { kind: "report-send", draftId, duplicate: { comment: Number(comment) } };
				}
				return { kind: "report-send", draftId, ...(parsed.flags.has("--new") ? { duplicate: "new" as const } : {}) };
			}
			if (sub === "forget") return { kind: "report-forget", id: parsed.positionals[0] ?? "" };
			const report: SlashReportKind = sub === "feature" || sub === "question" ? sub : "bug";
			// `--bundle mechanics --consent debug|dataset [--transcript [N]]` ask for a diagnostic bundle; the rest is the summary.
			const words = (parsed.rest ?? "")
				.trim()
				.split(/\s+/u)
				.filter((word) => word.length > 0);
			const values = new Map<string, string>();
			const text: string[] = [];
			for (let i = 0; i < words.length; i++) {
				const word = words[i] ?? "";
				if (word === "--transcript") values.set(word, /^\d+$/u.test(words[i + 1] ?? "") ? (words[++i] ?? "") : "");
				else if (word === "--bundle" || word === "--consent") values.set(word, words[++i] ?? "");
				else text.push(word);
			}
			const bundle = bundleRequest({
				bundle: values.get("--bundle"),
				consent: values.get("--consent"),
				transcript: values.get("--transcript"),
				withToolOutput: false,
				anonymizeModels: false,
				requireConsent: values.has("--bundle"),
			});
			if (typeof bundle === "string") return { kind: "usage-error", command: "report", reason: bundle };
			const summary = values.size > 0 ? text.join(" ") : (parsed.rest?.trim() ?? "");
			return {
				kind: "report",
				report,
				...(summary.length > 0 ? { summary } : {}),
				...(bundle !== null ? { bundle } : {}),
			};
		},
		// Not refused during a turn: a hung turn is a reason to report, and the review never touches the turn.
		handle(command, ctx) {
			const unavailable = () => ctx.notice("info", "reporting is not available on this surface; run `pancode report`");
			const text = ctx.openReport ? undefined : ctx.reportHost;
			if (text) {
				let reply: ReturnType<ReportTextHost["status"]>;
				if (command.kind === "report-status") reply = text.status();
				else if (command.kind === "report-forget") reply = text.forget(command.id);
				else if (command.kind === "report-send")
					reply = text.send(command.draftId, command.duplicate !== undefined ? { duplicate: command.duplicate } : {});
				else if (command.kind === "report-security") reply = text.plan({ kind: "security" });
				else if (command.kind === "report")
					reply = text.plan({
						kind: command.report,
						...(command.summary !== undefined ? { summary: command.summary } : {}),
						...(command.bundle !== undefined ? { bundle: command.bundle } : {}),
					});
				else return;
				const shown = reply.then((answer) => ctx.notice(answer.level, answer.text));
				if (ctx.holdReplyFor) ctx.holdReplyFor(shown);
				else
					shown.catch((error: unknown) =>
						ctx.notice("error", `report failed: ${error instanceof Error ? error.message : String(error)}`),
					);
				return;
			}
			if (command.kind === "report-status") {
				if (ctx.showReportStatus) ctx.showReportStatus();
				else unavailable();
				return;
			}
			if (command.kind === "report-forget") {
				if (ctx.forgetReport) ctx.forgetReport(command.id);
				else unavailable();
				return;
			}
			if (!ctx.openReport) {
				unavailable();
				return;
			}
			if (command.kind === "report-send") {
				// The review asks about a matching open issue itself; the flags steer only the text surfaces.
				if (command.duplicate !== undefined)
					ctx.notice(
						"info",
						`${command.duplicate === "new" ? "--new" : "--comment"} is not used here: the review asks whether to comment on a matching issue`,
					);
				ctx.openReport({ kind: "draft", draftId: command.draftId });
			} else if (command.kind === "report-security") ctx.openReport({ kind: "security" });
			else if (command.kind === "report")
				ctx.openReport({ kind: command.report, ...(command.summary !== undefined ? { summary: command.summary } : {}) });
		},
	},
	{
		name: "handoff",
		rank: 2,
		acp: false,
		description: "Hand this session's working state to a fresh session for a stated goal",
		group: "Session",
		kinds: ["handoff"],
		args: {
			positionals: [{ name: "goal", required: true, rest: true }],
		},
		fromArgs(parsed) {
			const goal = parsed.rest?.trim() ?? "";
			if (parsed.error || goal.length === 0) return usageError("handoff", parsed.error);
			return { kind: "handoff", goal };
		},
		handle(command, ctx) {
			if (command.kind !== "handoff") return;
			ctx.startHandoff?.(command.goal);
		},
	},
	{
		name: "tree",
		rank: 2,
		acp: false,
		description: "Open session tree navigator",
		group: "Session",
		kinds: ["tree"],
		args: {},
		fromArgs: fromArgsOrUsage("tree", { kind: "tree" }),
		handle(_command, ctx) {
			ctx.openTree?.();
		},
	},
	{
		name: "rewind",
		rank: 1,
		aliases: [{ name: "undo" }],
		acp: false,
		description: "Restore workspace files from a snapshot taken before PanCode's changes; /tree rewinds the conversation",
		group: "Session",
		kinds: ["rewind"],
		args: {},
		fromArgs: fromArgsOrUsage("rewind", { kind: "rewind" }),
		handle(_command, ctx) {
			ctx.openRewind?.();
		},
	},
	{
		name: "fork",
		rank: 2,
		acp: false,
		description: "Fork from an assistant turn into a new session; optionally name it",
		group: "Session",
		kinds: ["fork"],
		args: { positionals: [{ name: "name", required: false, rest: true }] },
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "fork", reason: parsed.error };
			const name = sessionNameArgument(parsed.rest ?? "");
			return name ? { kind: "fork", name } : { kind: "fork" };
		},
		handle(command, ctx) {
			if (command.kind === "fork") ctx.openMessagePicker?.(command.name);
		},
	},
	{
		name: "export",
		rank: 2,
		acp: {},
		description: "Export the transcript as HTML, or as Markdown for a .md path",
		group: "Session",
		kinds: ["export"],
		args: {
			positionals: [{ name: "path", required: false }],
		},
		fromArgs(parsed) {
			if (parsed.error) return { kind: "usage-error", command: "export", reason: parsed.error };
			return { kind: "export", path: parsed.positionals[0] };
		},
		handle(command, ctx) {
			if (command.kind !== "export") return;
			ctx.exportTranscript(command.path);
		},
	},
];

function sessionNameArgument(raw: string): string {
	const text = raw.trim();
	return (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))
		? text.slice(1, -1).trim()
		: text;
}
