// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The slash palette's grammar words and match ladder, said once for the terminal composer and the GUI composer: how a
 * command's arguments read after its name, which rows a typed `/query` finds and in what order, and which prompt
 * templates a palette lists. Browser-safe: type-only imports, no Node builtins.
 */

/** The grammar shape both the command registry and the ACP command catalog carry. */
interface SlashFlagShape {
	readonly name: string;
	readonly takesValue?: boolean;
	readonly values?: readonly string[];
	readonly valueName?: string;
}
interface SlashPositionalShape {
	readonly name: string;
	readonly required?: boolean;
}
interface SlashArgsShape {
	readonly flags?: readonly SlashFlagShape[];
	readonly positionals?: readonly SlashPositionalShape[];
}

/** What a value-taking flag's placeholder reads: its value name, its closed values, or the flag's own name. */
export function flagValuePlaceholder(flag: SlashFlagShape): string {
	if (flag.valueName) return flag.valueName;
	if (flag.values && flag.values.length > 0) return flag.values.join("|");
	return flag.name.replace(/^--/, "");
}

/** The grammar after a name in usage notation: `[--connection <target>] <agent> [task]`. */
export function renderArgsSpec(spec: SlashArgsShape): string {
	const parts: string[] = [];
	for (const flag of spec.flags ?? [])
		parts.push(flag.takesValue ? `[${flag.name} <${flagValuePlaceholder(flag)}>]` : `[${flag.name}]`);
	for (const positional of spec.positionals ?? [])
		parts.push(positional.required ? `<${positional.name}>` : `[${positional.name}]`);
	return parts.join(" ");
}

/** Every letter of the query appears in the name, in order: `ctx` finds `context`. */
export function lettersInOrder(query: string, name: string): boolean {
	let at = 0;
	for (const letter of name) if (letter === query[at]) at++;
	return at === query.length;
}

/** Shortest query that matches by letters in order, and by a word of the description. */
export const SLASH_LETTERS_MIN = 2;
export const SLASH_DESCRIPTION_MIN = 3;

/** Match classes, best first. `word` is a later word of the name: a verb, or the part after a pack's `:`. */
export type SlashMatchClass = "exact" | "name" | "word" | "letters" | "description";

export const SLASH_MATCH_ORDER: readonly SlashMatchClass[] = ["exact", "name", "word", "letters", "description"];

/** A description word that starts with the query, so `/compa` finds the command that compacts context. */
export function describedBy(query: string, description: string): boolean {
	return description
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.some((word) => word.startsWith(query));
}

/**
 * How a lower-cased `/query` finds one row: exact name, name prefix, a later word of the name, letters in order within
 * the name (two or more letters), then a description word (three or more). Null when it does not.
 */
export function slashMatchClass(query: string, name: string, description = ""): SlashMatchClass | null {
	const lowered = name.toLowerCase();
	if (lowered === query) return "exact";
	if (lowered.startsWith(query)) return "name";
	if (
		lowered
			.split(/[\s:]+/u)
			.slice(1)
			.some((word) => word.startsWith(query))
	)
		return "word";
	if (query.length >= SLASH_LETTERS_MIN && lettersInOrder(query, lowered)) return "letters";
	if (query.length >= SLASH_DESCRIPTION_MIN && describedBy(query, description)) return "description";
	return null;
}

/** A prompt template as a palette reads it: the terminal's loaded template, or the ACP catalog's row for one. */
interface SlashPromptShape {
	readonly description: string;
	readonly argumentHint?: string | undefined;
	/** Why the template cannot expand; its row refuses a pick. */
	readonly unavailable?: string | undefined;
	/** A reference card shown to the operator; nothing is sent to the model. */
	readonly displayOnly?: boolean | undefined;
}

/** The marker a display-only template carries in a palette, beside its description. */
export const REFERENCE_TEMPLATE_MARKER = "reference";

/**
 * What a prompt template's palette row says beside its name: what it does (or why it cannot run, or that it is a
 * reference card), what that is without the marks, and the arguments it takes after it.
 */
export function promptRowWords(
	prompt: SlashPromptShape,
	separator = "·",
): { summary: string; does: string; hint: string } {
	const does = prompt.description.trim();
	const summary = prompt.unavailable
		? `unavailable: ${prompt.unavailable}`
		: prompt.displayOnly
			? `${REFERENCE_TEMPLATE_MARKER} ${separator} ${does}`
			: does;
	return { summary, does, hint: prompt.argumentHint?.trim() ?? "" };
}

/**
 * The prompt templates a palette lists for a typed prefix, sorted by name so a pack's prompts (`wtfp:help`,
 * `wtfp:map`) sit together. A name a built-in command already owns, or the exact name typed (which runs), is left out.
 */
export function listedPrompts<T extends { name: string }>(
	prompts: readonly T[],
	prefix: string,
	taken: ReadonlySet<string>,
): T[] {
	const lowered = prefix.toLowerCase();
	const seen = new Set<string>();
	const listed: T[] = [];
	for (const prompt of [...prompts].sort((a, b) => a.name.localeCompare(b.name))) {
		const name = prompt.name;
		if (!name || taken.has(name.toLowerCase()) || seen.has(name)) continue;
		if (!name.toLowerCase().startsWith(lowered) || name === prefix) continue;
		seen.add(name);
		listed.push(prompt);
	}
	return listed;
}
