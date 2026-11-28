// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { IconName } from "../design/icons.js";
import type { SlashEntry } from "./slash-model.js";

export const ACTION_GROUPS = ["Conversation", "Session details", "More actions"] as const;
export type ActionGroup = (typeof ACTION_GROUPS)[number];
export interface VisualAction {
	readonly entry: SlashEntry;
	readonly title: string;
	readonly description: string;
	readonly icon: IconName;
	readonly group: ActionGroup;
}

export function actionLabel(name: string): string {
	const words = name.replace(/^--/u, "").replace(/[-_:]/gu, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

const PANE_COPY: Readonly<Record<string, { title: string; icon: IconName }>> = {
	context: { title: "Context window", icon: "layers" },
	usage: { title: "Usage and quota", icon: "usage" },
	tasks: { title: "Tasks and decisions", icon: "listChecks" },
	decisions: { title: "Decisions", icon: "evidence" },
	fleet: { title: "Fleet workers", icon: "fleet" },
	memory: { title: "Memory", icon: "archive" },
};
const ACTION_COPY: Readonly<Record<string, { title: string; description: string }>> = {
	tree: { title: "Session tree", description: "Return to an earlier point or fork into a new session" },
	fork: { title: "Fork session", description: "Start a new session from an earlier reply" },
	handoff: {
		title: "Hand off to a new session",
		description: "Review a summary and carry your work into a fresh session",
	},
	btw: { title: "Side question", description: "Ask a quick question without interrupting the main session" },
	draft: { title: "Drafts", description: "Draft answers in parallel and compare them" },
	extensions: { title: "Extensions", description: "Inspect and reload this session's extensions" },
	"fleet-run": { title: "Run a playbook", description: "Choose a saved playbook and review it before starting" },
};
// Every command the engine offers gets a written title; a bare command name ("Mcp", "Oracle") reads as jargon.
const COMMAND_TITLES: Readonly<Record<string, string>> = {
	doctor: "Check PanCode",
	"context compact": "Compact session context",
	// Reset clears the project's context files (it can delete PanCode.md), not this conversation.
	"context reset": "Reset project context",
	"context recover": "Resume a paused handoff",
	"context recall": "Bring back an evicted result",
	"context init": "Set up project context",
	"context refresh": "Refresh project context",
	council: "Ask a team",
	oracle: "Ask an advisor",
	run: "Run an agent",
	poll: "Poll agents",
	loop: "Start a loop",
	"loop status": "Loop status",
	"loop pause": "Pause a loop",
	"loop resume": "Resume a loop",
	"loop stop": "Stop a loop",
	mcp: "MCP servers",
	"mcp list": "List MCP servers",
	"mcp trust": "Trust an MCP server",
	"mcp untrust": "Withdraw MCP trust",
	archive: "Archive",
	"archive export": "Export an archive",
	"archive import": "Import an archive",
	"fleet share": "Share a worker result",
	"memory seed": "Seed task memory",
	skill: "Invoke a skill",
	"tasks add": "Add a task",
	"tasks hand": "Hand a task",
	"tasks done": "Mark a task done",
	"tasks remove": "Drop a task",
};
const ACTION_ICONS: Readonly<Record<string, IconName>> = {
	tree: "branch",
	fork: "branch",
	handoff: "external",
	btw: "sessions",
	draft: "compose",
	extensions: "toolchain",
	"fleet-run": "play",
};

/** An engine summary split at its backtick spans, so `off` and `--deep` read as code rather than as stray marks. */
export function descriptionParts(text: string): ReadonlyArray<{ readonly code: boolean; readonly text: string }> {
	const parts = text.split("`");
	// An unmatched backtick is ordinary text.
	if (parts.length % 2 === 0) return [{ code: false, text }];
	return parts.map((part, index) => ({ code: index % 2 === 1, text: part })).filter((part) => part.text !== "");
}

export function visualActions(entries: readonly SlashEntry[], query: string): readonly VisualAction[] {
	const words = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
	return entries
		.map((entry): VisualAction => {
			const pane = entry.kind === "pane" ? PANE_COPY[entry.name] : undefined;
			const action = entry.kind === "action" ? ACTION_COPY[entry.action] : undefined;
			return {
				entry,
				title: action?.title ?? pane?.title ?? COMMAND_TITLES[entry.name] ?? actionLabel(entry.name),
				description: action?.description ?? entry.summary,
				icon: entry.kind === "action" ? (ACTION_ICONS[entry.action] ?? "overview") : (pane?.icon ?? "bolt"),
				group: entry.kind === "action" ? "Conversation" : entry.kind === "pane" ? "Session details" : "More actions",
			};
		})
		.filter((item) =>
			words.every((word) =>
				`${item.title} ${item.description} ${item.entry.name} ${item.entry.summary}`.toLowerCase().includes(word),
			),
		);
}

/** The file-review view is a local pane, so it is discoverable without an engine command. */
export function matchesChanges(query: string): boolean {
	return query
		.toLowerCase()
		.trim()
		.split(/\s+/u)
		.filter(Boolean)
		.every((word) => "changes files review edited touched paths".includes(word));
}

export function actionCategoryRows(
	items: readonly VisualAction[],
	category: ActionGroup | "All actions",
): readonly VisualAction[] {
	return category === "All actions" ? items : items.filter((item) => item.group === category);
}

/** A command that takes the next prompt slot must wait for the active turn to settle. */
export function actionWaitsForTurn(entry: SlashEntry, running: boolean): boolean {
	if (!running || entry.kind !== "command") return false;
	return (
		entry.command.promptTurn === true ||
		(!!entry.subcommand && entry.command.promptTurnSubcommands?.includes(entry.subcommand) === true)
	);
}
