// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The composer's MCP rows: a trusted server's prompts as `/<id>:<prompt>`
 * beside the templates, its resources after `@<id>:`, and prompt argument
 * values from servers that offer completion.
 */

import { type McpSubmitReader, mcpPromptSlashRows } from "../domains/resources/submit-expansion.js";
import { parseCommandArgs } from "../engine/prompt-templates.js";
import type { FileReferenceCompletionSource, FileReferenceCompletionValue } from "./file-reference-completion.js";
import type { PromptArgumentSource, PromptCommandTemplate } from "./slash-autocomplete.js";

const MENTION_ROWS = 50;
const MENTION_QUERY = /^([a-z0-9][a-z0-9_-]*):(.*)$/su;

/** MCP prompts as slash rows; a template of the same name keeps its row. */
export function mcpPromptTemplates(
	reader: McpSubmitReader,
	templates: ReadonlyArray<{ name: string }>,
): PromptCommandTemplate[] {
	return mcpPromptSlashRows(reader, templates);
}

function mentionValue(serverId: string, uri: string, label: string, description: string): FileReferenceCompletionValue {
	return {
		id: `mcp:${serverId}:${uri}`,
		value: `@${serverId}:${uri}`,
		path: `${serverId}:${uri}`,
		label: uri,
		description: [label !== uri ? label : "", description].filter(Boolean).join("; ") || `resource of ${serverId}`,
		isDirectory: false,
		tracked: false,
	};
}

/** A completed variable goes into the mention as typed, so one that would end it is dropped. */
const MENTION_SAFE_VALUE = /^[^\s\p{Cc}"'\\]{1,200}$/u;

/** The template variable the typed uri ends inside, with the variables already filled before it. */
function templateCursor(
	template: string,
	typed: string,
): { name: string; value: string; start: number; context: Record<string, string> } | null {
	const parts = template.split(/(\{[^}]*\})/u);
	const context: Record<string, string> = {};
	let position = 0;
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index] ?? "";
		const rest = typed.slice(position);
		if (index % 2 === 0) {
			if (!rest.startsWith(part)) return null;
			position += part.length;
			continue;
		}
		const name = /^\{[+#./;?&]?([A-Za-z0-9_.%]+)/u.exec(part)?.[1];
		if (name === undefined) return null;
		const next = parts[index + 1] ?? "";
		const end = next.length > 0 ? rest.indexOf(next) : -1;
		if (end < 0) return { name, value: rest, start: position, context };
		context[name] = rest.slice(0, end);
		position += end;
	}
	return null;
}

/**
 * `@` completion with MCP resources: `@<id>:` lists that server's resources
 * and templates, a uri typed into a template completes the variable under
 * the cursor when the server offers completion, and a server id is offered
 * beside the workspace files. Only trusted servers that declare resources
 * appear.
 */
export function mcpReferenceSource(
	reader: McpSubmitReader,
	files: FileReferenceCompletionSource,
): FileReferenceCompletionSource {
	return async (request) => {
		const servers = [...reader.mentionServers()].sort();
		const mention = MENTION_QUERY.exec(request.query);
		if (mention !== null && servers.includes(mention[1] ?? "")) {
			const [, serverId = "", typed = ""] = mention;
			const wanted = typed.toLowerCase();
			const candidates = await reader.resourceCandidates(serverId, request.signal).catch(() => []);
			if (request.signal.aborted) return [];
			const filled: FileReferenceCompletionValue[] = [];
			for (const entry of candidates) {
				if (!entry.template) continue;
				const cursor = templateCursor(entry.uri, typed);
				if (cursor === null) continue;
				const values = await reader
					.completeTemplate(serverId, entry.uri, { name: cursor.name, value: cursor.value }, cursor.context, request.signal)
					.catch(() => []);
				if (request.signal.aborted) return [];
				for (const value of values) {
					if (!MENTION_SAFE_VALUE.test(value)) continue;
					const uri = `${typed.slice(0, cursor.start)}${value}`;
					filled.push(mentionValue(serverId, uri, uri, `${cursor.name} for ${entry.uri}`));
				}
			}
			const listed = candidates
				.filter((entry) => entry.uri.toLowerCase().includes(wanted) || entry.label.toLowerCase().includes(wanted))
				.map((entry) => mentionValue(serverId, entry.uri, entry.label, entry.description));
			return [...filled, ...listed].slice(0, MENTION_ROWS);
		}
		const values = await files(request);
		if (request.query.includes("/") || request.query.includes(":")) return values;
		const rows = servers
			.filter((id) => id.startsWith(request.query))
			.map(
				(id): FileReferenceCompletionValue => ({
					id: `mcp-server:${id}`,
					value: `@${id}:`,
					path: `${id}:`,
					label: `${id}:`,
					description: `resources of MCP server ${id}`,
					isDirectory: true,
					tracked: false,
				}),
			);
		return request.query.length > 0 ? [...rows, ...values] : [...values, ...rows];
	};
}

/** Quote a completed value the way the argument binder reads it back. */
function argumentText(value: string): string {
	if (value.length > 0 && !/[\s"']/u.test(value)) return value;
	return value.includes('"') ? `'${value}'` : `"${value}"`;
}

/**
 * Values for the argument under the cursor of `/<id>:<prompt> ...`: the
 * argument named by `name=`, else the next positional one. A prompt with one
 * argument takes the whole line, as the binder does.
 */
export function mcpPromptArgumentSource(reader: McpSubmitReader): PromptArgumentSource {
	return async ({ command, args, cursor, signal }) => {
		const row = reader.promptCommands().find((entry) => `${entry.serverId}:${entry.name}` === command);
		if (row === undefined || row.arguments.length === 0) return null;
		const before = args.slice(0, cursor);
		const only = row.arguments.length === 1 ? row.arguments[0] : undefined;
		let name: string;
		let value: string;
		let start: number;
		const context: Record<string, string> = {};
		const names: Array<{ id: string; value: string; label: string; description: string; appendSpace: boolean }> = [];
		if (only !== undefined && !before.trimStart().startsWith(`${only.name}=`)) {
			value = before.trimStart();
			start = before.length - value.length;
			name = only.name;
		} else {
			const tokenStart = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\t")) + 1;
			const token = before.slice(tokenStart);
			let positional = 0;
			for (const earlier of parseCommandArgs(before.slice(0, tokenStart))) {
				const named = /^([^=\s]+)=([\s\S]*)$/u.exec(earlier);
				if (named?.[1] !== undefined && row.arguments.some((entry) => entry.name === named[1]))
					context[named[1]] = named[2] ?? "";
				else positional += 1;
			}
			const equals = token.indexOf("=");
			const target = equals > 0 ? row.arguments.find((entry) => entry.name === token.slice(0, equals)) : undefined;
			if (target !== undefined) {
				name = target.name;
				value = token.slice(equals + 1);
				start = tokenStart + equals + 1;
			} else {
				const open = row.arguments.filter((entry) => !(entry.name in context));
				const next = open[positional];
				for (const entry of open)
					if (entry.name.startsWith(token))
						names.push({
							id: `mcp-arg-name:${entry.name}`,
							value: `${entry.name}=`,
							label: `${entry.name}=`,
							description: `${entry.required ? "required" : "optional"}${entry.description ? `; ${entry.description}` : ""}`,
							appendSpace: false,
						});
				if (next === undefined) return names.length > 0 ? { start: tokenStart, values: names } : null;
				name = next.name;
				value = token;
				start = tokenStart;
			}
		}
		const unquoted = value.replace(/^["']/u, "");
		const values = await reader.completeArgument(row.serverId, row.name, { name, value: unquoted }, context, signal);
		if (signal.aborted) return null;
		const completed = values.map((entry) => ({
			id: `mcp-arg:${name}:${entry}`,
			value: argumentText(entry),
			label: entry,
			description: `${name} for /${command}`,
			appendSpace: true,
		}));
		const rows = completed.length > 0 ? completed : value.length === 0 ? names : [];
		return rows.length > 0 ? { start, values: rows } : null;
	};
}
