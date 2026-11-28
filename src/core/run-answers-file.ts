// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `pancode run --answers` file format, parsed from text: `src/cli/run-answers.ts` loads one for a run, and the
 * runs service checks one an extension passes (`runs.refusal({ answers })`) with the same rules and wording.
 */
import { parse as parseYaml } from "yaml";

const RULE_KINDS = ["id", "header", "match"] as const;
type RuleKind = (typeof RULE_KINDS)[number];
const ENTRY_KEYS = new Set<string>([...RULE_KINDS, "choice", "note"]);

export interface AnswerRule {
	kind: RuleKind;
	value: string;
	pattern?: RegExp;
	choice?: string[];
	note?: string;
	/** How the journal names this rule: `answers[2] header "Which config?"`. */
	label: string;
}

/** A file that is not a valid answers file; the message names the offending entry. */
export class RunAnswersFileError extends Error {}

function fail(where: string, reason: string): never {
	throw new RunAnswersFileError(`${where}: ${reason}`);
}

function nonEmptyString(value: unknown, where: string): string {
	if (typeof value !== "string" || value.trim().length === 0) fail(where, "expected a non-empty string");
	return value;
}

function parseEntry(raw: unknown, index: number): AnswerRule {
	const where = `answers[${index}]`;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(where, "expected a mapping");
	const entry = raw as Record<string, unknown>;
	for (const key of Object.keys(entry)) {
		if (!ENTRY_KEYS.has(key))
			fail(
				`${where}.${key}`,
				"unknown key; an entry takes one of id, header or match to name an author question, then choice and note",
			);
	}
	const kinds = RULE_KINDS.filter((kind) => Object.hasOwn(entry, kind));
	const kind = kinds[0];
	if (kinds.length !== 1 || kind === undefined) fail(where, "needs exactly one of id, header or match");
	const value = nonEmptyString(entry[kind], `${where}.${kind}`).trim();
	let pattern: RegExp | undefined;
	if (kind === "match") {
		try {
			pattern = new RegExp(value, "u");
		} catch (error) {
			fail(`${where}.match`, `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	let choice: string[] | undefined;
	if (Object.hasOwn(entry, "choice")) {
		const given = entry.choice;
		const labels = Array.isArray(given) ? given : [given];
		if (labels.length === 0) fail(`${where}.choice`, "expected an option label or a non-empty list of labels");
		choice = labels.map((label, at) =>
			nonEmptyString(label, Array.isArray(given) ? `${where}.choice[${at}]` : `${where}.choice`).trim(),
		);
		if (new Set(choice).size !== choice.length) fail(`${where}.choice`, "lists a label twice");
	}
	let note: string | undefined;
	if (Object.hasOwn(entry, "note")) note = nonEmptyString(entry.note, `${where}.note`);
	if (choice === undefined && note === undefined) fail(where, "needs a choice, a note, or both");
	return {
		kind,
		value,
		...(pattern ? { pattern } : {}),
		...(choice ? { choice } : {}),
		...(note !== undefined ? { note } : {}),
		label: `${where} ${kind} ${JSON.stringify(value)}`,
	};
}

/** Parse the text of an answers file; a bad one throws RunAnswersFileError naming the offending entry. */
export function parseRunAnswersFile(text: string): AnswerRule[] {
	let document: unknown;
	try {
		document = parseYaml(text);
	} catch (error) {
		fail("file", `not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (document === null || typeof document !== "object" || Array.isArray(document))
		fail("file", "expected a mapping with an answers list");
	const top = document as Record<string, unknown>;
	for (const key of Object.keys(top)) if (key !== "answers") fail(key, "unknown key; the file takes only answers");
	// An empty list scripts nothing: every author question goes unscripted, so a run over a fixture that asks none needs no dummy rule.
	if (!Array.isArray(top.answers)) fail("answers", "expected a list");
	return top.answers.map((entry, index) => parseEntry(entry, index));
}

/** Why `text` is not a valid answers file, without the file name a caller adds; null when it is one. */
export function runAnswersRefusal(text: string): string | null {
	try {
		parseRunAnswersFile(text);
		return null;
	} catch (error) {
		if (error instanceof RunAnswersFileError) return error.message;
		throw error;
	}
}
