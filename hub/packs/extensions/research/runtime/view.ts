// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `/research` panel: the project's campaigns, and per campaign the same timeline `pancode research status`
 * prints. It reads; starting a campaign stays on the command, since a campaign runs agents for hours.
 */
import type { ExtensionOutputV2, View } from "pancode/sdk/extension";
import { campaignStatusLines } from "./format.ts";
import { listCampaigns, type ResearchCampaignView, summarizeCampaign } from "./report.ts";

export const OPEN_ACTION = "open";
export const LIST_ACTION = "list";
export const REFRESH_ACTION = "refresh";

/** The view vocabulary's bounds this panel stays inside. */
const LIST_ITEMS = 100;
const LABEL_CHARS = 120;
const DETAIL_LINES = 300;

type Entry = ResearchCampaignView | { id: string; error: string };

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function entryRow(entry: Entry): { key: string; label: string; detail: string; tone?: "error" | "accent" } {
	if ("error" in entry)
		return { key: entry.id, label: entry.id, detail: clip(`unreadable: ${entry.error}`, LABEL_CHARS), tone: "error" };
	const objective = entry.campaign.objective;
	const state = entry.state === "stopped" ? (entry.stop?.reason ?? "stopped") : "running";
	return {
		key: entry.campaign.id,
		label: entry.campaign.id,
		detail: clip(
			`${state}  ${objective.direction} ${objective.metric} (${objective.check})  ${entry.iterations.length}/${entry.campaign.budget.maxIterations} it, ${entry.ratchets} kept`,
			LABEL_CHARS,
		),
		...(entry.state === "stopped" ? {} : { tone: "accent" as const }),
	};
}

const START_HINT =
	"Start one with pancode research start --check <id> --metric <key> --direction min|max --max-iterations <N>.";

/** The campaign list, newest last; the oldest drop off past the list's bound. */
export function listPanel(root: string): ExtensionOutputV2 {
	const entries = listCampaigns(root);
	const shown = entries.slice(-LIST_ITEMS);
	const children: View[] =
		entries.length === 0
			? [
					{ t: "text", text: "No research campaigns in this project yet.", tone: "muted" },
					{ t: "text", text: START_HINT, tone: "muted" },
				]
			: [
					{ t: "list", items: shown.map(entryRow), action: OPEN_ACTION },
					...(entries.length > shown.length
						? [
								{
									t: "text" as const,
									text: `${entries.length - shown.length} older campaign(s) not shown; pancode research list names them all`,
									tone: "muted" as const,
								},
							]
						: []),
				];
	children.push({ t: "actions", items: [{ id: REFRESH_ACTION, label: "Refresh", hotkey: "r", primary: true }] });
	return {
		text:
			entries.length === 0
				? "No research campaigns in this project yet."
				: `${entries.length} research campaign(s); pancode research list names them.`,
		panel: { title: "Campaigns", meta: `${entries.length} campaign(s)`, view: { t: "box", dir: "col", children } },
	};
}

/** One campaign's timeline, as `pancode research status <id>` prints it. */
export function detailPanel(root: string, id: string): ExtensionOutputV2 {
	let lines: string[];
	try {
		lines = campaignStatusLines(summarizeCampaign(root, id));
	} catch (error) {
		lines = [`${id} cannot be read: ${error instanceof Error ? error.message : String(error)}`];
	}
	const shown = lines.slice(0, DETAIL_LINES);
	const children: View[] = shown.map((line) => ({ t: "text", text: line.length === 0 ? " " : clip(line, 2000) }));
	if (lines.length > shown.length)
		children.push({
			t: "text",
			text: `${lines.length - shown.length} more line(s); pancode research status ${id} prints them all`,
			tone: "muted",
		});
	children.push({
		t: "actions",
		items: [
			{ id: LIST_ACTION, label: "Back", hotkey: "b", primary: true },
			{ id: REFRESH_ACTION, label: "Refresh", hotkey: "r" },
		],
	});
	return {
		text: lines.join("\n"),
		panel: { title: id, view: { t: "box", dir: "col", children } },
	};
}
