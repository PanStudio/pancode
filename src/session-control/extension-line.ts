// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { relativePathEscapes } from "../core/path-containment.js";
import { isExtensionCommandToken, type PromptRef, promptRefs } from "../domains/extensions/operator-commands.js";
import type { OperatorExtensions } from "../domains/extensions/operator-extensions.js";
import { extensionOwnerLabel } from "../domains/extensions/owner-label.js";

/**
 * What a typed `/token` line is to the extension runtimes: a command to run
 * locally, a refusal, or (null) nothing of theirs, so template expansion and
 * the model own it. The terminal, `pancode run` and ACP all ask this one
 * question, so `/ext:<id>:<cmd>` and a `replaces: prompt` takeover answer the
 * same way on every surface (WTF-P F04).
 */
export type ExtensionLine =
	| { kind: "run"; token: string; args: string; extensionId: string; takeover: boolean }
	| { kind: "refuse"; message: string; settling: boolean };

export function resolveExtensionLine(
	text: string,
	token: string,
	runtime: OperatorExtensions | undefined,
	prompts: ReadonlyArray<PromptRef>,
): ExtensionLine | null {
	const rows = runtime?.commands(prompts) ?? [];
	const args = text
		.trim()
		.slice(token.length + 1)
		.trim();
	const takeovers = rows.filter((row) => row.invocation === token && row.replaces === "prompt");
	const replacement = takeovers.find((row) => row.available);
	if (replacement) return { kind: "run", token, args, extensionId: replacement.extensionId, takeover: true };
	// A takeover whose runtime is only restarting is not an absent extension: handing its prompt
	// to the model would answer with a model turn the operator did not ask for.
	const settling = takeovers.find((row) => row.transient === true);
	if (settling)
		return {
			kind: "refuse",
			settling: true,
			message: `/${token}: ${settling.reason ?? "extension runtime is restarting"}; send it again in a moment`,
		};
	// A loaded prompt of the same name keeps it; expansion answers that line.
	if (!isExtensionCommandToken(token) || prompts.some((ref) => ref.name === token)) return null;
	const row = rows.find((candidate) => candidate.invocation === token);
	if (!row?.available)
		return { kind: "refuse", settling: false, message: row?.reason ?? `/${token} is not an available extension command` };
	return { kind: "run", token, args, extensionId: row.extensionId, takeover: false };
}

/** The operator's words for a command that threw: what failed, whether the extension survived it, and the next step. */
export function extensionFailureMessage(
	token: string,
	extensionId: string,
	error: unknown,
	runtime: OperatorExtensions,
): string {
	// A runtime that rethrows keeps its own "Error:" prefix; one is enough.
	const raw = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/u, "");
	const reason = raw.startsWith(`/${token} is not an available`)
		? "it is not available now"
		: plainExtensionError(raw, extensionOwnerLabel(extensionId));
	const state = runtime.entries().find((entry) => entry.id === extensionId)?.state;
	const next =
		state === "ready"
			? "It is still running; correct the command and run it again."
			: state === "failed" || state === undefined
				? "It stopped; /extensions shows why, and r there restarts it."
				: `It is ${state}; /extensions shows its state, and r there restarts it.`;
	return `/${token} failed: ${sentence(reason)} ${next}`;
}

/**
 * Runs a resolved line for a surface that shows text only (`pancode run`, ACP).
 * A result drawn only as a band, card or panel still owes the operator a line.
 */
async function runExtensionLineText(
	line: Extract<ExtensionLine, { kind: "run" }>,
	runtime: OperatorExtensions,
	prompts: ReadonlyArray<PromptRef>,
	signal?: AbortSignal,
): Promise<ExtensionLineAnswer> {
	try {
		const output = await runtime.invoke(line.token, line.args, prompts, signal);
		return {
			ok: true,
			text: output.text.trim().length > 0 ? output.text : `/${line.token} ran and returned no text to show here.`,
		};
	} catch (error) {
		return { ok: false, message: extensionFailureMessage(line.token, line.extensionId, error, runtime) };
	}
}

/** A loaded prompt as these functions read it. */
type PromptItem = {
	name: string;
	description?: string;
	argumentHint?: string;
	unavailable?: string;
	displayOnly?: boolean;
	sourceInfo: { source?: string };
};

/** A `/name` row a client's palette lists, with the marks the terminal's palette shows on a prompt template. */
type TypedLine = {
	name: string;
	description: string;
	argumentHint?: string;
	unavailable?: string;
	displayOnly?: boolean;
};

/** An extension line's outcome on a surface that shows text only. */
export type ExtensionLineAnswer = { ok: true; text: string } | { ok: false; message: string };

/**
 * A text-only surface's screen of a typed `/token` line: the refusal, the
 * command to run, or null when the line is not the runtimes' to answer.
 */
export function screenExtensionLine(
	text: string,
	token: string,
	runtime: OperatorExtensions | undefined,
	prompts: ReadonlyArray<PromptItem>,
):
	| { kind: "refuse"; message: string }
	| { kind: "run"; run(signal?: AbortSignal): Promise<ExtensionLineAnswer> }
	| null {
	const refs = promptRefs(prompts);
	const line = resolveExtensionLine(text, token, runtime, refs);
	if (line === null) return null;
	if (line.kind === "refuse" || runtime === undefined)
		return { kind: "refuse", message: line.kind === "refuse" ? line.message : `/${token} is not available` };
	return { kind: "run", run: (signal) => runExtensionLineText(line, runtime, refs, signal) };
}

/** `screenExtensionLine` run to its answer, for a caller that has nothing to do in between. */
export async function answerExtensionLine(
	text: string,
	token: string,
	runtime: OperatorExtensions | undefined,
	prompts: ReadonlyArray<PromptItem>,
	signal?: AbortSignal,
): Promise<ExtensionLineAnswer | null> {
	const screened = screenExtensionLine(text, token, runtime, prompts);
	if (screened === null) return null;
	return screened.kind === "refuse" ? { ok: false, message: screened.message } : screened.run(signal);
}

/**
 * The extension commands a client may type as `/name`, a takeover under its prompt's name. A command whose
 * runtime is restarting is listed; it answers once it is up (WTF-P F05).
 */
export function extensionLineCommands(
	runtime: OperatorExtensions | undefined,
	prompts: ReadonlyArray<PromptItem>,
): TypedLine[] {
	return (runtime?.commands(promptRefs(prompts)) ?? [])
		.filter((row) => row.available || row.transient === true)
		.map((row) => ({ name: row.invocation, description: row.description }));
}

/**
 * The `/name` lines a client may type besides the built-in commands: every loaded prompt with its argument hint
 * and marks, then every extension command, which wins a name it shares with a prompt.
 */
export function typedLineCommands(
	runtime: OperatorExtensions | undefined,
	prompts: ReadonlyArray<PromptItem>,
): TypedLine[] {
	const listed = new Map<string, TypedLine>();
	for (const { name, description = "", argumentHint, unavailable, displayOnly } of prompts)
		listed.set(name, {
			name,
			description,
			...(argumentHint !== undefined ? { argumentHint } : {}),
			...(unavailable ? { unavailable } : {}),
			...(displayOnly ? { displayOnly } : {}),
		});
	for (const line of extensionLineCommands(runtime, prompts)) listed.set(line.name, line);
	return [...listed.values()];
}

/** A reason as one sentence: capitalised, with closing punctuation. */
function sentence(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length === 0) return "";
	const head = trimmed[0]?.toUpperCase() + trimmed.slice(1);
	return /[.!?]$/u.test(head) ? head : `${head}.`;
}

/**
 * A Node file error from an extension, in words. "ENOENT: no such file or
 * directory, open '/abs/project/missing.json'" names the code and an absolute
 * path; the operator needs which file and what went wrong with it.
 */
function plainExtensionError(raw: string, owner: string, cwd: string = process.cwd()): string {
	const match = /^(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR): [^,]*, \w+ '([^']+)'$/u.exec(raw.trim());
	if (!match) return raw;
	const [, code, target = ""] = match;
	const relative = path.isAbsolute(target) ? path.relative(cwd, target) : target;
	const shown = relative && !relativePathEscapes(relative) ? relative : target;
	switch (code) {
		case "ENOENT":
			return `${owner} could not find ${shown}`;
		case "EISDIR":
			return `${owner} expected a file but ${shown} is a folder`;
		case "ENOTDIR":
			return `${owner} expected a folder on the way to ${shown}`;
		default:
			return `${owner} is not allowed to read or write ${shown}`;
	}
}
