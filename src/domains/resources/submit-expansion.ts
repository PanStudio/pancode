// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Operator syntax in a submitted request, expanded the same way on every surface that submits one:
 * `/skill` requests become pending skill loads, a prompt template's name becomes its body, and
 * `@path` references inline the file, or attach it when it is an image. With an MCP reader,
 * `/<id>:<prompt>` becomes the server's prompt and `@<id>:<uri>` inlines the server's resource.
 * The terminal and the ACP server both call this, so a request typed in the graphical app means
 * what it means in the TUI.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { PLUGIN_RESOURCE_USE, recordPackageActivity } from "../../core/package-activity.js";
import { relativePathEscapes } from "../../core/path-containment.js";
import type { PendingSkillRequest } from "../../core/skill-activation.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import { templateTurnConstraints } from "../../core/turn-constraints.js";
import type { ImageContent } from "../../engine/types.js";
import { expandInlineFileReferencesAsync } from "../../tools/file-references.js";
import type { ResourcesContract } from "./contract.js";
import { pluginResourceComponents } from "./package-references.js";

export interface SubmitExpansion {
	text: string;
	images: ImageContent[];
	workingContextPaths: string[];
	pendingSkillRequests: PendingSkillRequest[];
	/**
	 * What the transcript paints as the operator's turn when `text` is a prompt
	 * template's body: the line they typed, and a note naming the template. The
	 * model still receives `text`; a `/wtfp:new-paper` body is several hundred
	 * lines the operator never wrote, and painting it as their message buried
	 * the command under it. An `@path` reference gets the same treatment: the
	 * injected `<file name="/home/...">` block is the model's copy, and the
	 * note names the attached files by their short paths.
	 */
	display?: { text: string; note?: string };
	/** An expanded template's `allowed-tools`, `delegated-tools`, `budget` and `turnPolicy`, submitted as the turn's constraint. */
	constraints?: TurnConstraints;
	/** The prompt template `text` expanded from, when one did. */
	template?: string;
	/** The MCP prompt `text` expanded from, as `<id>:<name>`, when one did. */
	mcpPrompt?: string;
	/**
	 * Why a `/name` line that names a template did not expand, such as a plugin
	 * changed on disk under the session. `text` is then the literal line, which
	 * a caller that bypasses slash dispatch must not send to the model.
	 */
	promptRefusal?: string;
}

const ATTACHMENT_NOTE_LIMIT = 3;

/** Workspace-relative when inside the cwd, `~/` when inside the home, otherwise absolute. */
function shortAttachmentPath(filePath: string, cwd: string): string {
	for (const [root, prefix] of [
		[path.resolve(cwd), ""],
		[path.resolve(homedir()), "~/"],
	] as const) {
		const rel = path.relative(root, filePath);
		if (rel.length > 0 && !relativePathEscapes(rel)) return `${prefix}${rel.split(path.sep).join("/")}`;
	}
	return filePath;
}

/**
 * What the transcript says about the files a request named. A file whose bytes
 * went to the model is "attached"; a large or binary one went by name only,
 * and calling that attached let the operator believe the model had read it.
 * A file that could not be read is said too, since nothing else would say it.
 */
function attachmentNote(
	paths: ReadonlyArray<string>,
	diagnostics: ReadonlyArray<{ type: string; message: string; path?: string }>,
	cwd: string,
): string | undefined {
	const named = new Map(
		diagnostics.flatMap((item) => (item.type === "warning" && item.path ? [[item.path, item.message] as const] : [])),
	);
	const partial = new Map(
		diagnostics.flatMap((item) => (item.type === "info" && item.path ? [[item.path, item.message] as const] : [])),
	);
	const inlined = paths.filter((filePath) => !named.has(filePath) && !partial.has(filePath));
	const byName = paths.filter((filePath) => named.has(filePath));
	const unreadable = diagnostics.filter((item) => item.type === "error" && item.path);
	const parts: string[] = [];
	if (inlined.length > 0) {
		const shown = inlined.slice(0, ATTACHMENT_NOTE_LIMIT).map((filePath) => shortAttachmentPath(filePath, cwd));
		const more = inlined.length - shown.length;
		parts.push(`attached ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`);
	}
	for (const [filePath, pages] of [...partial].slice(0, ATTACHMENT_NOTE_LIMIT))
		parts.push(
			`attached ${pages} of ${shortAttachmentPath(filePath, cwd)}, which is all that fits; PanCode reads the rest with its tools`,
		);
	for (const filePath of byName.slice(0, ATTACHMENT_NOTE_LIMIT))
		parts.push(
			`sent ${shortAttachmentPath(filePath, cwd)} by name only: ${named.get(filePath)}, so PanCode reads it in parts with its tools`,
		);
	if (byName.length > ATTACHMENT_NOTE_LIMIT) parts.push(`${byName.length - ATTACHMENT_NOTE_LIMIT} more by name only`);
	for (const item of unreadable.slice(0, ATTACHMENT_NOTE_LIMIT))
		parts.push(`could not attach ${shortAttachmentPath(item.path ?? "", cwd)}: ${item.message}`);
	if (parts.length === 0) return undefined;
	const note = parts.join("; ");
	return `${note[0]?.toUpperCase() ?? ""}${note.slice(1)}.`;
}

/**
 * The operator's turn as the transcript paints it and as prompt_submit hooks judge it: the line they typed
 * whenever a template or `@path` changed what the model receives. Headless `run` shares it with the terminal
 * and ACP; without it a hook there saw the expanded body as typed and refused `/name` scoped actions.
 */
export function submitDisplay(input: {
	typed: string;
	/** The typed line with `/skill` requests taken out. */
	parsedText: string;
	template?: { name: string; text: string };
	referencedPaths: ReadonlyArray<string>;
	diagnostics: ReadonlyArray<{ type: string; message: string; path?: string }>;
	cwd: string;
	/** What MCP prompt or mention expansion did, one clause each. */
	mcpNotes?: ReadonlyArray<string>;
}): { text: string; note?: string } | undefined {
	const files = attachmentNote(input.referencedPaths, input.diagnostics, input.cwd);
	const clauses = [
		...(input.mcpNotes ?? []),
		...(files ? [files.replace(/\.$/u, "").replace(/^./u, (first) => first.toLowerCase())] : []),
	];
	const attached =
		clauses.length === 0
			? undefined
			: input.mcpNotes?.length
				? `${clauses.join("; ").replace(/^./u, (first) => first.toUpperCase())}.`
				: files;
	if (input.template)
		return {
			text: input.parsedText.trim(),
			note: [
				`expanded prompt template ${input.template.name} (${input.template.text.split("\n").length} lines)`,
				...(attached ? [attached] : []),
			].join("; "),
		};
	return attached ? { text: input.typed.trim(), note: attached } : undefined;
}

/** Server text as one origin-tagged turn part; the reader renders it, this module never reads it for syntax. */
export type McpSubmitAnswer =
	| { ok: true; text: string; images: ImageContent[]; note: string }
	| { ok: false; error: string };

/** An MCP prompt as a slash command `/<serverId>:<name>`; its text is the server's, neutralized and bounded. */
export interface McpPromptCommandRow {
	serverId: string;
	name: string;
	title: string | null;
	description: string;
	arguments: ReadonlyArray<{ name: string; description: string; required: boolean }>;
	/** The recorded list outlived the server's freshness hint; shown, but it may have changed. */
	stale?: true;
}

/** A resource or template a `@<id>:` completion offers. */
export interface McpResourceCandidate {
	/** A uri, or a uri template whose `{variables}` the operator fills. */
	uri: string;
	template: boolean;
	label: string;
	description: string;
}

/**
 * MCP prompts and resources as operator syntax, injected by the composition
 * root so this domain never reaches the gateway. Server text it returns is
 * never searched for `@path`, mentions or slash commands.
 */
export interface McpSubmitReader {
	/** The prompts of trusted servers, live once listed, else as recorded; never launches a server. */
	promptCommands(): ReadonlyArray<McpPromptCommandRow>;
	/** A server's resources and templates for `@<id>:` completion; may start a trusted server. */
	resourceCandidates(serverId: string, signal?: AbortSignal): Promise<ReadonlyArray<McpResourceCandidate>>;
	/** Values for one prompt argument from a connected server that offers completion; empty otherwise. */
	completeArgument(
		serverId: string,
		prompt: string,
		argument: { name: string; value: string },
		context: Readonly<Record<string, string>>,
		signal?: AbortSignal,
	): Promise<ReadonlyArray<string>>;
	/** Values for one variable of a resource template, the same way. */
	completeTemplate(
		serverId: string,
		template: string,
		variable: { name: string; value: string },
		context: Readonly<Record<string, string>>,
		signal?: AbortSignal,
	): Promise<ReadonlyArray<string>>;
	/** The expansion of a `/<id>:<prompt> args` request; null when it names no MCP prompt. */
	expandPrompt(text: string, signal?: AbortSignal): Promise<McpSubmitAnswer | null>;
	/** Ids of the servers a `@<id>:<uri>` mention may read. */
	mentionServers(): ReadonlySet<string>;
	/** One mentioned resource. */
	readMention(serverId: string, uri: string, signal?: AbortSignal): Promise<McpSubmitAnswer>;
}

export interface SubmitExpansionOptions {
	/** Aborts a slow attachment read; the expansion then rejects with the signal's reason. */
	signal?: AbortSignal;
	/** Names an attachment, by its short path, as its slow extraction starts. */
	onExtract?: (shortPath: string) => void;
	mcp?: McpSubmitReader;
}

/**
 * MCP prompts as the rows a command palette lists, after the templates: a
 * template of the same name keeps its row and wins on submit.
 */
export function mcpPromptSlashRows(
	reader: Pick<McpSubmitReader, "promptCommands">,
	templates: ReadonlyArray<{ name: string }>,
): Array<{ name: string; description: string; argumentHint?: string; mcpServer: string }> {
	const taken = new Set(templates.map((template) => template.name.toLowerCase()));
	return reader.promptCommands().flatMap((row) => {
		const name = `${row.serverId}:${row.name}`;
		if (taken.has(name.toLowerCase())) return [];
		const hint = row.arguments.map((entry) => (entry.required ? `<${entry.name}>` : `[${entry.name}]`)).join(" ");
		const about = [row.title, row.description].filter((text) => text !== null && text.length > 0).join(": ");
		return [
			{
				name,
				description: `MCP ${row.serverId}: ${about || `prompt ${row.name}`}${row.stale ? " (recorded list, may be out of date)" : ""}`,
				...(hint ? { argumentHint: hint } : {}),
				mcpServer: row.serverId,
			},
		];
	});
}

/** A request reads at most this many distinct resources; further mentions stay as typed. */
const MCP_MENTION_LIMIT = 8;

/**
 * `@<id>:<uri>` where the uri carries its own scheme, so `@notes:todo` or an
 * email address is never read as a mention. Ids are the declaration charset.
 */
const MCP_MENTION = /(^|\s)@([a-z0-9][a-z0-9_-]*):([A-Za-z][A-Za-z0-9+.-]*:\S+)/gu;

interface McpMention {
	start: number;
	end: number;
	serverId: string;
	uri: string;
}

/** Sentence punctuation after a mention is not part of its uri; a `)` is only when unbalanced. */
function trimMentionUri(uri: string): string {
	let trimmed = uri.replace(/[.,;!?'"]+$/u, "");
	while (trimmed.endsWith(")") && (trimmed.match(/\(/gu)?.length ?? 0) < (trimmed.match(/\)/gu)?.length ?? 0))
		trimmed = trimmed.slice(0, -1).replace(/[.,;!?'"]+$/u, "");
	return trimmed;
}

function mcpMentions(text: string, servers: ReadonlySet<string>): McpMention[] {
	if (servers.size === 0 || !text.includes("@")) return [];
	const mentions: McpMention[] = [];
	for (const match of text.matchAll(MCP_MENTION)) {
		const [, lead = "", serverId = "", raw = ""] = match;
		if (!servers.has(serverId)) continue;
		const uri = trimMentionUri(raw);
		const start = (match.index ?? 0) + lead.length;
		mentions.push({ start, end: start + 1 + serverId.length + 1 + uri.length, serverId, uri });
	}
	return mentions;
}

/**
 * File references expand over the operator's text only: each mention stands
 * as a placeholder the file pass cannot match, and the resource is put in
 * after, so a server's text never names a file PanCode then reads.
 */
async function expandMcpMentions(
	text: string,
	reader: McpSubmitReader | undefined,
	signal: AbortSignal | undefined,
	expandFiles: (text: string) => Promise<FileExpansion>,
): Promise<FileExpansion & { notes: string[] }> {
	const mentions = reader === undefined ? [] : mcpMentions(text, reader.mentionServers());
	if (reader === undefined || mentions.length === 0) return { ...(await expandFiles(text)), notes: [] };
	const nonce = randomUUID();
	const placeholder = (index: number): string => `\u0000mcp-mention-${nonce}-${index}\u0000`;
	const duplicatePlaceholder = (index: number): string => `\u0000mcp-mention-dup-${nonce}-${index}\u0000`;
	const reads = new Map<string, { index: number; answer: Promise<McpSubmitAnswer> | null }>();
	const duplicates: Array<{ token: string; raw: string }> = [];
	let masked = "";
	let last = 0;
	for (const mention of mentions) {
		const key = `${mention.serverId}\u0000${mention.uri}`;
		masked += text.slice(last, mention.start);
		last = mention.end;
		if (reads.has(key)) {
			// Mask repeated mentions during file expansion so `@id:uri` is never read as `@path`.
			const token = duplicatePlaceholder(duplicates.length);
			duplicates.push({ token, raw: text.slice(mention.start, mention.end) });
			masked += token;
			continue;
		}
		const index = reads.size;
		reads.set(key, {
			index,
			answer:
				index < MCP_MENTION_LIMIT
					? reader.readMention(mention.serverId, mention.uri, signal).catch((error: unknown) => ({
							ok: false as const,
							error: error instanceof Error ? error.message : String(error),
						}))
					: null,
		});
		masked += placeholder(index);
	}
	masked += text.slice(last);
	const files = await expandFiles(masked);
	await Promise.all([...reads.values()].map((read) => read.answer));
	signal?.throwIfAborted();
	const notes: string[] = [];
	const images: ImageContent[] = [...files.images];
	let expanded = files.text;
	let skipped = 0;
	for (const [key, read] of reads) {
		const [serverId = "", uri = ""] = key.split("\u0000");
		const typed = `@${serverId}:${uri}`;
		let replacement = typed;
		if (read.answer === null) skipped += 1;
		else {
			const answer = await read.answer;
			if (answer.ok) {
				replacement = answer.text;
				images.push(...answer.images);
				notes.push(answer.note);
			} else notes.push(`could not read ${typed}: ${answer.error}`);
		}
		expanded = expanded.split(placeholder(read.index)).join(replacement);
	}
	for (const duplicate of duplicates) {
		expanded = expanded.split(duplicate.token).join(duplicate.raw);
	}
	if (skipped > 0) notes.push(`left ${skipped} more MCP mentions unread; a request reads at most ${MCP_MENTION_LIMIT}`);
	return { ...files, text: expanded, images, notes };
}

type FileExpansion = Awaited<ReturnType<typeof expandInlineFileReferencesAsync>>;

/**
 * A plugin template's turn names the resources its plugin declares, so the
 * model reads a schema by path instead of finding it with bash (WTF-P
 * campaign: find, read and grep over the plugin tree before every record).
 */
function withPluginResources(text: string, template: { name: string; packageRoot?: string }): string {
	if (template.packageRoot === undefined) return text;
	const resources = pluginResourceComponents(template.packageRoot);
	if (resources.length === 0) return text;
	return [
		text,
		"",
		`[Plugin resources] ${template.name} runs with these files its plugin declares; read them by path when the workflow needs them instead of searching for them:`,
		...resources.map((resource) => `- ${resource.id}: ${resource.path}`),
	].join("\n");
}

/** `@path` references and `@<id>:<uri>` mentions in operator text; headless `run` calls it after its own template step. */
export function expandSubmitReferences(
	text: string,
	cwd: string,
	options: SubmitExpansionOptions = {},
): Promise<FileExpansion & { notes: string[] }> {
	const { signal, onExtract, mcp } = options;
	return expandMcpMentions(text, mcp, signal, (masked) =>
		expandInlineFileReferencesAsync(masked, {
			cwd,
			includeImages: true,
			missing: "leave",
			...(signal ? { signal } : {}),
			...(onExtract ? { onExtract: (filePath: string) => onExtract(shortAttachmentPath(filePath, cwd)) } : {}),
		}),
	);
}

export async function expandSubmitText(
	text: string,
	resources: ResourcesContract | undefined,
	cwd = process.cwd(),
	options: SubmitExpansionOptions = {},
): Promise<SubmitExpansion> {
	const { signal, mcp } = options;
	const parsed = resources?.parsePendingSkillRequests(text, cwd) ?? {
		text,
		pendingSkillRequests: [],
	};
	const promptExpansion = resources?.expandPromptTemplate(parsed.text, cwd);
	// A template of the same name wins; an MCP prompt's text is the server's, so nothing below reads it for syntax.
	const mcpPrompt = promptExpansion?.expanded || mcp === undefined ? null : await mcp.expandPrompt(parsed.text, signal);
	if (mcpPrompt !== null) {
		signal?.throwIfAborted();
		return {
			text: mcpPrompt.ok ? mcpPrompt.text : parsed.text,
			images: mcpPrompt.ok ? mcpPrompt.images : [],
			workingContextPaths: [],
			pendingSkillRequests: parsed.pendingSkillRequests,
			...(mcpPrompt.ok
				? {
						display: submitDisplay({
							typed: text,
							parsedText: parsed.text,
							referencedPaths: [],
							diagnostics: [],
							cwd,
							mcpNotes: [mcpPrompt.note],
						}) ?? { text: text.trim() },
						mcpPrompt: parsed.text.trim().split(/\s/u)[0]?.slice(1) ?? "",
					}
				: { promptRefusal: mcpPrompt.error }),
		};
	}
	const promptOwner = promptExpansion?.expanded ? promptExpansion.template.sourceInfo?.owner : undefined;
	if (promptExpansion?.expanded && promptOwner)
		recordPackageActivity({
			type: PLUGIN_RESOURCE_USE,
			kind: "prompt",
			owner: promptOwner,
			outcome: "expanded",
			details: { name: promptExpansion.template.name },
		});
	const promptText = promptExpansion?.expanded
		? withPluginResources(promptExpansion.text, promptExpansion.template)
		: parsed.text;
	const constraints = promptExpansion?.expanded ? templateTurnConstraints(promptExpansion.template) : undefined;
	const fileExpansion = await expandSubmitReferences(promptText, cwd, options);
	const display = submitDisplay({
		typed: text,
		parsedText: parsed.text,
		...(promptExpansion?.expanded
			? { template: { name: promptExpansion.template.name, text: promptExpansion.text } }
			: {}),
		referencedPaths: fileExpansion.referencedPaths,
		diagnostics: fileExpansion.diagnostics,
		cwd,
		mcpNotes: fileExpansion.notes,
	});
	return {
		text: fileExpansion.text,
		images: fileExpansion.images,
		workingContextPaths: fileExpansion.referencedPaths,
		pendingSkillRequests: parsed.pendingSkillRequests,
		...(display ? { display } : {}),
		...(promptExpansion?.expanded ? { template: promptExpansion.template.name } : {}),
		...(promptExpansion?.expanded === false && promptExpansion.refusal
			? { promptRefusal: promptExpansion.refusal.message }
			: {}),
		...(constraints ? { constraints } : {}),
	};
}
