// SPDX-License-Identifier: LicenseRef-PanCode-1.0 AND MIT
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Split from slash-commands.ts, which adapts pi-coding-agent's BUILTIN_SLASH_COMMANDS registry.

import { describedBy, lettersInOrder, SLASH_DESCRIPTION_MIN, SLASH_LETTERS_MIN } from "../core/views/slash-words.js";
import type { CommandAlias, CommandRank, SlashCommandGroup } from "./slash-command-types.js";
import { BUILTIN_SLASH_COMMANDS, parseSlashCommand } from "./slash-commands.js";
import { type CommandArgsSpec, usageLine } from "./slash-spec.js";

interface CommandReferenceEntry {
	name: string;
	usage: string;
	description: string;
	group: SlashCommandGroup;
	rank: CommandRank;
	aliases?: ReadonlyArray<CommandAlias>;
	/** The command's args grammar, carried through for argument autocomplete. */
	args?: CommandArgsSpec;
	/** Stable copy shown beside first-token subcommand completions. */
	subcommandDescriptions?: Readonly<Record<string, string>>;
	/** The bare command does something on its own; false means it only answers with its usage. */
	runsBare: boolean;
}

/** Whether `line` does something on its own, judged by the real parser. */
export function lineRunsBare(line: string): boolean {
	const kind = parseSlashCommand(line).kind;
	return kind !== "usage-error" && kind !== "unknown" && kind !== "unknown-command";
}

const RUNS_BARE = new Map<string, boolean>();
function commandRunsBare(name: string): boolean {
	let known = RUNS_BARE.get(name);
	if (known === undefined) {
		known = lineRunsBare(`/${name}`);
		RUNS_BARE.set(name, known);
	}
	return known;
}

/** `includeHidden` is for ACP, which still admits hidden commands such as `/archive` and `/eggs`. */
export function commandReference(options: { includeHidden?: boolean } = {}): ReadonlyArray<CommandReferenceEntry> {
	return BUILTIN_SLASH_COMMANDS.filter((entry) => options.includeHidden === true || entry.hidden !== true)
		.slice()
		.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
		.map((entry) => {
			const usage = usageLine(entry)
				.replace(/^\nusage:\s*/, "")
				.replace(/\n$/, "");
			return {
				name: entry.name,
				usage,
				description: entry.description,
				group: entry.group,
				rank: entry.rank,
				...(entry.aliases?.length ? { aliases: entry.aliases } : {}),
				...(entry.args ? { args: entry.args } : {}),
				...(entry.subcommandDescriptions ? { subcommandDescriptions: entry.subcommandDescriptions } : {}),
				runsBare: commandRunsBare(entry.name),
			};
		});
}

/** Match classes, best first. */
type CommandMatchClass = "exact" | "name" | "alias" | "verb" | "letters" | "description";

export interface CommandMatch {
	ref: CommandReferenceEntry;
	class: CommandMatchClass;
	/** Set for an alias row: the alias the query matched. */
	alias?: CommandAlias;
	/** Set for a verb row: the subcommand the query matched. */
	verb?: string;
}

/**
 * Commands for a typed `/query`, best class first and within a class by rank
 * then name: exact name, name prefix, alias prefix, verb prefix, letters in
 * order within the name (two or more letters), then a description word that
 * starts with the query (three or more letters). A command appears once, in its
 * best class, except that several of its verbs may match.
 */
export function matchCommandReference(
	query: string,
	reference: ReadonlyArray<CommandReferenceEntry> = commandReference(),
): CommandMatch[] {
	const q = query.toLowerCase();
	if (q.length === 0) return reference.map((ref) => ({ ref, class: "name" }));
	const out: CommandMatch[] = [];
	const taken = new Set<string>();
	const pass = (test: (ref: CommandReferenceEntry) => Omit<CommandMatch, "ref"> | null): void => {
		for (const ref of reference) {
			if (taken.has(ref.name)) continue;
			const hit = test(ref);
			if (!hit) continue;
			out.push({ ref, ...hit });
			taken.add(ref.name);
		}
	};
	pass((ref) => (ref.name === q ? { class: "exact" } : null));
	pass((ref) => (ref.name.startsWith(q) ? { class: "name" } : null));
	pass((ref) => {
		const alias = ref.aliases?.find((candidate) => candidate.name.startsWith(q));
		return alias ? { class: "alias", alias } : null;
	});
	for (const ref of reference) {
		if (taken.has(ref.name)) continue;
		for (const verb of Object.keys(ref.args?.subcommands ?? {})) {
			if (verb.startsWith(q)) out.push({ ref, class: "verb", verb });
		}
	}
	for (const match of out) taken.add(match.ref.name);
	if (q.length >= SLASH_LETTERS_MIN) pass((ref) => (lettersInOrder(q, ref.name) ? { class: "letters" } : null));
	if (q.length >= SLASH_DESCRIPTION_MIN)
		pass((ref) => (describedBy(q, ref.description) ? { class: "description" } : null));
	return out;
}

function editDistance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			current[j] = Math.min(
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1,
				(previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		previous = current;
	}
	return previous[b.length] ?? Number.POSITIVE_INFINITY;
}

/**
 * The spelling an unknown `/token` most likely meant, with what it runs when
 * that differs: the palette's best row, else the nearest name or alias within
 * two edits.
 */
export function closestCommand(token: string): { typed: string; runs?: string } | null {
	const reference = commandReference();
	const best = matchCommandReference(token, reference)[0];
	if (best?.alias) return { typed: best.alias.name, runs: aliasLine(best.ref.name, best.alias) };
	if (best?.verb) return { typed: `${best.ref.name} ${best.verb}` };
	if (best) return { typed: best.ref.name };
	const q = token.toLowerCase();
	let nearest: { typed: string; runs?: string; distance: number } | null = null;
	for (const ref of reference) {
		const candidates: Array<{ typed: string; runs?: string }> = [
			{ typed: ref.name },
			...(ref.aliases ?? []).map((alias) => ({ typed: alias.name, runs: aliasLine(ref.name, alias) })),
		];
		for (const candidate of candidates) {
			const distance = editDistance(q, candidate.typed);
			if (distance <= 2 && (nearest === null || distance < nearest.distance)) nearest = { ...candidate, distance };
		}
	}
	if (!nearest) return null;
	return nearest.runs ? { typed: nearest.typed, runs: nearest.runs } : { typed: nearest.typed };
}

function aliasLine(command: string, alias: CommandAlias): string {
	return alias.args ? `${command} ${alias.args}` : command;
}
