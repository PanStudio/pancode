// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// The hub's components, in the operator's words: what an agent may spend and where it
// stops, and whether the model can ever reach a skill. The agent's `configuration` is an open record
// on the wire, so every key is read defensively. Pure, so the order and the sentences are testable
// without a browser.

import type { Static } from "typebox";
import type { HubAgents, HubComponent, HubExtensions, HubVerifiers } from "../../contracts/hub.js";
import { finite } from "../api/narrow.js";
import { humanizeKey } from "../design/facts-model.js";
import { inspectionTabIndex } from "../design/run-inspection-model.js";

export type Agent = Static<typeof HubAgents>["agents"][number];
export type Resource = Static<typeof HubComponent>;
type Extension = Static<typeof HubExtensions>["extensions"][number];
type Check = Static<typeof HubVerifiers>["checks"][number];

export interface CardFact {
	label: string;
	value: string;
	absent?: true;
}

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const word = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const fact = (label: string, value: string | null): CardFact =>
	value === null ? { label, value: "Not declared", absent: true } : { label, value };

/** `32–150` when the agent declares a ceiling above its default, or the bare default when it does not. */
export function budgetRange(min: number | null, max: number | null): string | null {
	if (min === null) return null;
	const low = min.toLocaleString("en-US");
	return max !== null && max > min ? `${low}–${max.toLocaleString("en-US")}` : low;
}

export interface AgentCard {
	/** Capability, project context tier, tool-call budget, read reserve. Always these four, in this order. */
	facts: CardFact[];
	skills: string[];
	tools: string[];
	/** Result contract, then what happens when the budget runs out. */
	footer: string[];
}

export function agentCard(agent: Agent): AgentCard {
	const budget = record(agent.configuration.budget);
	const maximum = record(budget.maximum);
	const contract = word(record(agent.configuration.resultContract).kind);
	const capability = word(agent.configuration.capabilityClass);
	const tier = word(agent.configuration.projectContextTier);
	const footer = [contract === null ? "No result contract declared" : `${humanizeKey(contract)} result contract`];
	if (typeof budget.synthesis === "boolean")
		footer.push(budget.synthesis ? "Text synthesis at boundary" : "Stops at boundary");
	return {
		facts: [
			fact("Capability", capability === null ? null : humanizeKey(capability)),
			fact("Project context", tier === null ? null : humanizeKey(tier)),
			fact("Tool-call budget", budgetRange(finite(budget.toolCalls), finite(maximum.toolCalls))),
		],
		skills: agent.skills,
		tools: agent.tools,
		footer,
	};
}

/**
 * Whether the model can ever reach this skill, in one sentence. It leads the card because every
 * other fact about a skill is secondary to it.
 */
export function reachSentence(skill: Pick<Resource, "availability" | "trusted" | "modelInvocable">): string {
	if (skill.availability === "invalid") return "It did not load, so nothing can use it";
	if (skill.availability === "shadowed") return "Another skill of the same name outranks it, so this copy never loads";
	if (skill.availability === "unavailable") return "PanCode reports it as unavailable";
	if (!skill.trusted) return "Its root is not trusted, so the model never sees it";
	if (skill.modelInvocable === false) return "Its frontmatter reserves it for you";
	return "The model can load this by name";
}

const SOURCE_CLASS: Record<string, string> = {
	core: "PanCode core",
	package: "An installed pack",
	user: "Your user root",
	project: "This project's root",
	compat: "Another agent's folder",
};

export interface SkillCard {
	reach: string;
	reachable: boolean;
	/** The reach in two words, for the status mark. The sentence carries the reason. */
	mark: string;
	/** Precedence, root trust, model invocation. Always these three, in this order. */
	facts: CardFact[];
	footer: string[];
}

export function skillCard(skill: Resource): SkillCard {
	const reachable = skill.availability === "available" && skill.trusted && skill.modelInvocable !== false;
	const issues = skill.diagnostics.length;
	const footer = [issues === 0 ? "No issues" : `${issues.toLocaleString("en-US")} ${issues === 1 ? "issue" : "issues"}`];
	if (record(skill.origin).kind === "remote") footer.push("Has an upstream");
	return {
		reach: `${reachSentence(skill)}.`,
		reachable,
		mark: reachable
			? "Model reachable"
			: skill.trusted && skill.availability === "available"
				? "Operator only"
				: "Out of reach",
		facts: [
			{ label: "Precedence", value: SOURCE_CLASS[skill.source.class] ?? humanizeKey(skill.source.class) },
			{ label: "Root trust", value: skill.trusted ? "Trusted" : "Not trusted" },
			{
				label: "Model invocation",
				value: reachable ? "By name" : skill.modelInvocable === false && skill.trusted ? "Reserved for you" : "Never",
			},
		],
		footer,
	};
}

/** Every string a record carries, at any depth, case-folded for the free-text filter. */
function searchText(value: unknown, depth = 0): string {
	if (typeof value === "string") return value.toLocaleLowerCase("en-US");
	if (!value || typeof value !== "object" || depth > 4) return "";
	return Object.values(value)
		.map((item) => searchText(item, depth + 1))
		.filter(Boolean)
		.join(" ");
}
export const matchesQuery = (value: unknown, query: string): boolean => {
	const needle = query.trim().toLocaleLowerCase("en-US");
	return !needle || searchText(value).includes(needle);
};

/**
 * Where an arrow key moves a tab selection. Left and right wrap, Home and End jump, and every other
 * key returns null so the caller leaves the event alone.
 */
export function tabAfterKey<T>(tabs: readonly T[], current: T, key: string): T | null {
	const index = tabs.indexOf(current);
	if (index < 0) return null;
	return tabs[inspectionTabIndex(key, index, tabs.length)] ?? null;
}

/**
 * A collection tab's label. With no workspace open nothing is read, so the tab shows its name alone rather than a
 * count that never arrives; while a read runs it shows an ellipsis.
 */
/** `read` is false when the collection has no source yet: still resolving, or Verifiers with no workspace. */
export function collectionTabLabel(
	name: string,
	read: { read: boolean; count: number | undefined; failed: boolean },
): string {
	if (!read.read) return name;
	if (read.count !== undefined) return `${name} · ${read.count}`;
	return `${name} · ${read.failed ? "Unavailable" : "…"}`;
}

export const HUB_COLLECTIONS = [
	"Catalog",
	"Agents",
	"Skills",
	"Prompts",
	"Playbooks",
	"Extensions",
	"Verifiers",
] as const;
export type HubCollection = (typeof HUB_COLLECTIONS)[number];
export type HubEntry = {
	id: string;
	name: string;
	description: string;
	state: string;
	detail: unknown;
	agent?: Agent;
	skill?: Resource;
};
export type HubEntries = Record<Exclude<HubCollection, "Catalog">, HubEntry[]>;

/** The read each collection's rows come from. Skills, prompts, playbooks and the catalog share the inventory. */
export type HubSource = "inventory" | "agents" | "extensions" | "verifiers";
export const hubSource = (name: HubCollection): HubSource =>
	name === "Agents" ? "agents" : name === "Extensions" ? "extensions" : name === "Verifiers" ? "verifiers" : "inventory";

/** Verifiers are one project's checks, so they are read only with a workspace; the rest once the scope is resolved. */
export const hubCollectionRead = (name: HubCollection, workspace: boolean, resolved: boolean): boolean =>
	name === "Verifiers" ? workspace : resolved;

/** Every collection's rows, from whichever reads have answered; an unanswered read gives no rows. */
export function hubEntries(read: {
	resources?: readonly Resource[] | undefined;
	agents?: readonly Agent[] | undefined;
	extensions?: readonly Extension[] | undefined;
	checks?: readonly Check[] | undefined;
}): HubEntries {
	const resourceEntries = (kind: "skill" | "prompt" | "playbook"): HubEntry[] =>
		(read.resources ?? [])
			.filter((row) => row.kind === kind)
			.map((row) => ({
				id: row.key,
				name: row.name,
				description: row.description,
				state: `${row.availability} · ${row.source.class}`,
				detail: row,
				...(kind === "skill" ? { skill: row } : {}),
			}));
	return {
		Agents: (read.agents ?? []).map((row) => ({
			id: row.id,
			name: row.name,
			description: row.description,
			state: `${row.category} · ${row.source}`,
			detail: row,
			agent: row,
		})),
		Skills: resourceEntries("skill"),
		Prompts: resourceEntries("prompt"),
		Playbooks: resourceEntries("playbook"),
		Extensions: (read.extensions ?? []).map((row) => ({
			id: `${row.id}:${row.scope}`,
			name: row.name,
			description: row.description,
			state: extensionState(row),
			detail: row,
		})),
		Verifiers: (read.checks ?? []).map((row) => ({
			id: row.id,
			name: row.id,
			description: row.description,
			state: `${row.origin} · ${row.runner}`,
			detail: row,
		})),
	};
}

/** The active collection's rows the filter keeps. Free text runs across every string field a row carries, not only its name. */
export const hubVisible = (active: HubCollection, entries: HubEntries, filter: string): HubEntry[] =>
	(active === "Catalog" ? [] : entries[active]).filter((row) => matchesQuery(row.detail, filter));

/** A collection tab's label from its read: the catalog counts packages, every other tab its rows. */
export function hubTabLabel(
	name: HubCollection,
	read: { loaded: boolean; failed: boolean; packages: number | undefined; entries: HubEntries },
	scope: { workspace: boolean; resolved: boolean },
): string {
	const count = !read.loaded ? undefined : name === "Catalog" ? read.packages : read.entries[name].length;
	return collectionTabLabel(name, {
		read: hubCollectionRead(name, scope.workspace, scope.resolved),
		count,
		failed: read.failed,
	});
}

/** With no workspace open the hub reads installation-wide: built-in and user layers, no project. */
export function hubContextCopy(workspace: boolean) {
	return workspace
		? {
				intro: "Explore the capabilities available to PanCode in this workspace, and see where they come from.",
				where: "for this workspace",
				inventory: "workspace inventory",
			}
		: {
				intro: "Explore the capabilities available to PanCode on this machine, and see where they come from.",
				where: "installed for you",
				inventory: "installation inventory",
			};
}

export const SKILL_ORIGINS: Readonly<Record<string, string>> = {
	core: "Built in",
	package: "Installed pack",
	user: "Yours",
	project: "This project",
	compat: "Another agent's folder",
};
export const SKILL_ACCESS = ["all", "available", "operator", "unavailable", "shadowed"] as const;
export type SkillAccess = (typeof SKILL_ACCESS)[number];
export const SKILL_ACCESS_LABELS: Record<SkillAccess, string> = {
	all: "All skills",
	available: "Model available",
	operator: "Operator only",
	unavailable: "Unavailable",
	shadowed: "Overridden copies",
};
function skillAccess(skill: Resource): Exclude<SkillAccess, "all"> {
	if (skill.availability === "shadowed") return "shadowed";
	if (skillCard(skill).reachable) return "available";
	if (skill.availability === "available" && skill.trusted && skill.modelInvocable === false) return "operator";
	return "unavailable";
}
export function discoverSkills(resources: readonly Resource[], query: string, access: SkillAccess, origin: string) {
	const skills = resources.filter((row) => row.kind === "skill").sort((a, b) => a.name.localeCompare(b.name));
	return {
		skills,
		origins: [...new Set(skills.map((skill) => skill.source.class))].sort(),
		shown: skills.filter(
			(skill) =>
				(access === "all" || skillAccess(skill) === access) &&
				(!origin || skill.source.class === origin) &&
				matchesQuery(skill, query),
		),
		counts: Object.fromEntries(
			SKILL_ACCESS.map((key) => [key, skills.filter((skill) => key === "all" || skillAccess(skill) === key).length]),
		) as Record<SkillAccess, number>,
	};
}

export function extensionState(value: unknown): string {
	const row = record(value);
	return row.loadable
		? "Ready to load"
		: !row.enabled
			? "Disabled"
			: !row.valid
				? "Invalid"
				: !row.compatible
					? "Incompatible"
					: !row.effective
						? "Overridden"
						: "Unavailable";
}

export function resourceDetails(
	collection: string,
	value: unknown,
): { explanation: string; facts: CardFact[]; notes: string[] } {
	const row = record(value);
	if (collection === "Extensions") {
		const capabilities = record(row.capabilities);
		return {
			explanation: row.loadable
				? "This extension passed admission and can be loaded. Its declared capabilities describe what it may add; they do not prove it is running."
				: `This extension is ${extensionState(value).toLowerCase()}. Review its admission diagnostics before changing it in the terminal.`,
			facts: [
				fact("Scope", word(row.scope)),
				fact("Version", word(row.version)),
				fact(
					"Declared capabilities",
					Object.keys(capabilities).length
						? Object.entries(capabilities)
								.filter(([, value]) => value !== false && value !== null)
								.map(([key]) => humanizeKey(key))
								.join(", ") || "None enabled"
						: null,
				),
			],
			notes: Array.isArray(row.diagnostics)
				? row.diagnostics.map((note) => word(record(note).message)).filter((note): note is string => note !== null)
				: [],
		};
	}
	if (collection === "Verifiers")
		return {
			explanation:
				"A discovered check describes how PanCode can verify work. Discovery does not mean this check has run or passed.",
			facts: [
				fact("Runner", word(row.runner)),
				fact("Evidence signal", word(row.signal)),
				fact("Authority", word(row.authority)),
				fact("Working directory", row.runsAtRepositoryRoot ? "Repository root" : "Defined by the check"),
				fact("Arguments", row.argvFixed ? "Fixed by the check" : "May be supplied at runtime"),
				fact("Time limit", finite(row.timeoutMs) === null ? null : `${Number(row.timeoutMs) / 1000} seconds`),
			],
			notes: [],
		};
	const source = record(row.source);
	return {
		explanation:
			row.availability === "available"
				? collection === "Prompts"
					? "A saved starting point you can invoke for a conversation or task."
					: "A saved playbook that coordinates steps and specialists. Inspect its source before running it."
				: `This copy is ${String(row.availability ?? "unavailable")}. ${word(row.reason) ?? "Review the source and discovery notes for the cause."}`,
		facts: [
			fact("Availability", word(row.availability)),
			fact("Invocation", word(row.invocation)),
			fact("Source", SOURCE_CLASS[String(source.class)] ?? word(source.class)),
			fact("Root trust", row.trusted === true ? "Trusted" : "Not trusted"),
		],
		notes: Array.isArray(row.diagnostics)
			? row.diagnostics.filter((note): note is string => typeof note === "string")
			: [],
	};
}
