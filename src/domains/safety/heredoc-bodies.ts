// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { basenameToken, commandTokenIndex } from "./command-token.js";
import { gitCommitReadsStdinAsMessage } from "./heredoc-data.js";
import type { ShellToken } from "./shell-scan.js";
import {
	COMMAND_SEPARATORS,
	heredocFeedsShell,
	heredocSubstitutions,
	MAX_HEREDOCS,
	SHELL_WRITE_REDIRECTIONS,
	scanShellLike,
	shellCommandArguments,
} from "./shell-scan.js";
import { pathArgs } from "./validation-check-match.js";

/** Commands that copy a here-document to their output as text and run none of it. */
const HEREDOC_DATA_CONSUMERS: ReadonlySet<string> = new Set(["cat", "tee"]);

const HEREDOC_NON_READERS: ReadonlySet<string> = new Set([":", "true", "false", "echo", "printf", "pwd"]);

export type HeredocDataMode = "all" | "stdin-only";

/** Who reads a here-document: the safety rails, or a reader that keeps b1c4855bf's reading (row 261). */
export type HeredocReader = "rails" | "base";

/** XR-43: only direct commands with known stdin semantics can make a body inert without copying it. */
function isHeredocStdinData(head: ReadonlyArray<ShellToken>): boolean {
	if (head.some((token) => token.operator || token.hiddenContent || (token.substitutions?.length ?? 0) > 0))
		return false;
	if (HEREDOC_NON_READERS.has(head[0]?.value ?? "")) return true;
	if (head[0]?.value !== "git" || head[1]?.value !== "commit") return false;
	return gitCommitReadsStdinAsMessage(head.slice(2).map((token) => token.value));
}

/**
 * The files a quoted here-document's command copies it into, or null unless
 * the command copies data to a file or is a known stdin sink.
 */
export function heredocDataOutputs(
	tokens: ReadonlyArray<ShellToken>,
	operatorIndex: number,
	dataMode?: HeredocDataMode,
): string[] | null {
	const separator = (token: ShellToken | undefined): boolean =>
		token?.operator === true && COMMAND_SEPARATORS.has(token.value);
	let start = operatorIndex;
	while (start > 0 && !separator(tokens[start - 1])) start -= 1;
	let end = operatorIndex;
	while (end < tokens.length && !separator(tokens[end])) end += 1;
	const segment = tokens.slice(start, end);
	if (segment.some((token) => (token.substitutions?.length ?? 0) > 0)) return null;
	if (
		isHeredocStdinData(tokens.slice(start, operatorIndex)) &&
		!segment.slice(operatorIndex - start + 1).some((token) => token.operator) &&
		tokens[end]?.value !== "|" &&
		tokens[start - 1]?.value !== "|" &&
		!heredocFeedsShell(tokens, operatorIndex)
	)
		return [];
	if (dataMode === "stdin-only") return null;
	const argv = shellCommandArguments(segment);
	const commandIndex = commandTokenIndex(argv);
	if (commandIndex === null || !HEREDOC_DATA_CONSUMERS.has(basenameToken(argv[commandIndex]))) return null;
	let stdout: string | null = null;
	for (let index = 0; index < segment.length - 1; index += 1) {
		const operator = segment[index];
		const target = segment[index + 1];
		if (operator === undefined || target === undefined || !operator.operator || target.operator) continue;
		const previous = segment[index - 1];
		const fd =
			previous !== undefined &&
			!previous.operator &&
			!previous.quoted &&
			previous.end === operator.start &&
			/^\d+$/u.test(previous.value)
				? previous.value
				: null;
		if (operator.value === "<&") {
			if (fd === "1") stdout = null;
			continue;
		}
		if (!SHELL_WRITE_REDIRECTIONS.has(operator.value)) continue;
		const both = operator.value === "&>" || operator.value === "&>>";
		if (!both && (fd ?? (operator.value === "<>" ? "0" : "1")) !== "1") continue;
		stdout = operator.value === ">&" && /^(?:\d+-?|-)$/u.test(target.value) ? null : target.value;
	}
	if (stdout === null || (stdout.startsWith("/dev/") && stdout !== "/dev/null")) return null;
	const outputs = basenameToken(argv[commandIndex]) === "tee" ? pathArgs(argv, commandIndex) : [];
	return [stdout, ...outputs].filter((output) => output !== "/dev/null");
}

/**
 * The command with each top-level here-document body removed and its `<<WORD`
 * blanked, so what is left reads as the commands bash runs. A body starts on
 * the line after its operator and ends at the line that is exactly its word
 * (tabs stripped first for `<<-`), or at the end of the command, as in bash.
 * Several here-documents on one line take their bodies in order.
 */
export function withoutHeredocBodies(command: string, keepSubstitutions = false): string {
	return removeHeredocBodies(command, keepSubstitutions).text;
}

/**
 * {@link withoutHeredocBodies}, with the files its here-documents are copied
 * into as data ({@link heredocDataOutputs}), or null when any one is not.
 */
export function removeHeredocBodies(
	command: string,
	keepSubstitutions: boolean,
	dataMode?: HeredocDataMode,
): { text: string; dataOutputs: string[] | null } {
	let text = command;
	let dataOutputs: string[] | null = [];
	for (let pass = 0; pass < MAX_HEREDOCS; pass += 1) {
		const tokens = scanShellLike(text);
		const first = tokens.findIndex((token) => token.operator && token.value === "<<");
		if (first === -1) return { text, dataOutputs };
		const lineEnd = tokens.findIndex(
			(token, index) => index > first && token.operator && token.value === ";" && text[token.start] === "\n",
		);
		const docs: Array<{ start: number; end: number; word: string; stripTabs: boolean; quoted: boolean }> = [];
		for (let index = first; index < (lineEnd === -1 ? tokens.length : lineEnd); index += 1) {
			const operator = tokens[index];
			if (operator === undefined || !operator.operator || operator.value !== "<<") continue;
			let word = tokens[index + 1];
			let stripTabs = false;
			if (word !== undefined && !word.operator && word.start === operator.end && text[word.start] === "-") {
				stripTabs = true;
				if (word.value === "-") word = tokens[index + 2];
			}
			// `<<` with no word is a syntax error: bash runs nothing, so leave it as written.
			if (word === undefined || word.operator) return { text, dataOutputs: null };
			const outputs = word.quoted ? heredocDataOutputs(tokens, index, dataMode) : null;
			// One physical line can introduce several bodies. If one is unknown,
			// none of that line's bodies may be dropped from the data projection.
			if (dataMode !== undefined && outputs === null) return { text, dataOutputs: null };
			dataOutputs = outputs === null || dataOutputs === null ? null : [...dataOutputs, ...outputs];
			const delimiter = stripTabs && text[word.start] === "-" ? word.value.slice(1) : word.value;
			docs.push({ start: operator.start, end: word.end, word: delimiter, stripTabs, quoted: word.quoted });
		}
		let head = text;
		for (const doc of [...docs].reverse()) {
			head = `${head.slice(0, doc.start)}${" ".repeat(doc.end - doc.start)}${head.slice(doc.end)}`;
		}
		if (lineEnd === -1) {
			text = head;
			continue;
		}
		const bodyStart = (tokens[lineEnd]?.start ?? text.length) + 1;
		let cursor = bodyStart;
		const substitutions: string[] = [];
		for (const doc of docs) {
			const start = cursor;
			let bodyEnd = cursor;
			while (cursor < text.length) {
				bodyEnd = cursor;
				const newline = text.indexOf("\n", cursor);
				const line = text.slice(cursor, newline === -1 ? text.length : newline);
				cursor = newline === -1 ? text.length : newline + 1;
				if ((doc.stripTabs ? line.replace(/^\t+/u, "") : line) === doc.word) break;
				bodyEnd = cursor;
			}
			if (keepSubstitutions && !doc.quoted)
				substitutions.push(...heredocSubstitutions(text.slice(start, bodyEnd)).map((found) => found.text));
		}
		text = `${head.slice(0, bodyStart)}${substitutions.length > 0 ? `${substitutions.join("\n")}\n` : ""}${text.slice(cursor)}`;
	}
	return { text, dataOutputs: null };
}
