// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readFileSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "../../core/hash.js";
import { ToolNames } from "../../core/tool-names.js";
import type { Classification, ClassifierCall } from "./action-classifier.js";
import type { DamageControlRule } from "./damage-control.js";
import { normalizedGitCommands } from "./git-command-normalization.js";
import { scanShellLike } from "./shell-scan.js";
import { inlineShellScript } from "./shell-segments.js";
import { yoloFloorTrustGrant } from "./yolo-floor.js";

/**
 * Tools whose arguments carry file contents or task prose, not command lines.
 * Their damage-control scan is the destination path alone, when present.
 */
const CONTENT_BEARING_TOOLS: ReadonlySet<string> = new Set([
	ToolNames.Write,
	ToolNames.Edit,
	ToolNames.Artifact,
	ToolNames.Dispatch,
	ToolNames.Tasks,
]);

/**
 * The text damage-control rules are matched against.
 *
 * Every rule in the pack is a command pattern: shell (`rm -rf /`, `chmod -R
 * 777`), cloud CLI (`aws s3 rm --recursive`), or SQL (`DROP TABLE`). Matching
 * them against a file's contents asks whether the file *mentions* a dangerous
 * command, which is a different question from whether the call *runs* one, and
 * the two are indistinguishable once the text is in the haystack.
 *
 * That cost a real feature. `pancode context wiki` could not write its own
 * `domains/safety.md`: the page documents what the classifier blocks, so it
 * quotes `rm -rf /`, and the write was refused as `system_modify` with reason
 * `damage-control:rm-rf-root`. The same defect blocks writing a SQL migration
 * containing `DROP TABLE` or a test fixture for the classifier itself.
 *
 * Writing a file is not executing it. A script written with a destructive body
 * still has to be run, and that run is an execute-class call scanned here in
 * full. Only the destination path is scanned for a mutation tool, which keeps
 * any path-shaped rule working; where the file may land is the write tool's own
 * gate in `writePathClass`.
 * Dispatch and task-board prose likewise does not execute; worker commands
 * are scanned when the worker calls an execute-class tool.
 */
export function decodedAnsiCCommand(command: string): string | null {
	let decoded = "";
	let copied = 0;
	for (const token of scanShellLike(command)) {
		if (!token.ansiCQuoted || token.hiddenContent) continue;
		const literal = /^[\w./~+-]+$/u.test(token.value) ? token.value : `'${token.value.replaceAll("'", "'\\''")}'`;
		decoded += command.slice(copied, token.start) + literal;
		copied = token.end;
	}
	if (copied === 0) return null;
	// Preserve quoted operators as literal words while giving path rules their decoded operands.
	return decoded + command.slice(copied);
}

/**
 * Strings a damage-control rule is tested against. Joining every argument into
 * one blob put the command in the middle of it, so a rule anchored with `$`
 * stopped matching the moment the model also supplied `cwd` or `timeout_ms`:
 * `git restore .` ran at both levels and the authored `git checkout -- .`
 * confirm rail fell through to the classifier's unconditional git_destructive
 * block. The command is offered on its own as well. The blob stays a
 * candidate so no rule that matched before stops matching now.
 */

export function damageControlScans(call: ClassifierCall, classification: Classification): string[] {
	if (CONTENT_BEARING_TOOLS.has(call.tool)) {
		const pathArg = call.args?.path;
		return typeof pathArg === "string" ? [pathArg] : [];
	}
	// Read payloads describe data, not executable commands.
	// Gateway capabilities and trusted argv projections receive their own admission.
	if (classification.actionClass === "read") return [];
	// `bash` is the only tool with a `command` argument, and its others (`cwd`,
	// `timeout_ms`, `output_policy`) are not commands. Scanning the blob as well
	// would let a bare `cwd: "."` complete a pathspec the command did not write,
	// so a call that carries a command is scanned as a command. `cwd` keeps its
	// own path policy.
	const command = call.args?.command;
	if (typeof command === "string") {
		const decoded = decodedAnsiCCommand(command);
		return [
			command,
			...(decoded === null ? [] : [decoded]),
			...shellCommandSegments(command),
			...normalizedGitCommands(command),
		];
	}
	return [serializeArgs(call.args)];
}

/**
 * Source text of each command a shell string would actually execute, including
 * the ones inside a `$(...)` substitution or an `sh -c` script.
 *
 * A damage-control pattern anchored with `$` matches only at the end of the
 * string it is tested against, so `git restore . && echo RESTORED` hid its
 * destructive segment and ran at yolo with no card, discarding a dirty tracked
 * file. Every operator opened the same hole, and the audit blamed
 * `bash-shell-operators` because no rule had matched.
 *
 * Segments are sliced out of the original text rather than rebuilt from tokens,
 * so quoting survives and a rule cannot fire on a word that merely spells a
 * command inside a quoted argument.
 */
export function shellCommandSegments(command: string, depth = 0): string[] {
	const segments: string[] = [];
	let start: number | null = null;
	let end = 0;
	const flush = (): void => {
		if (start === null) return;
		const segment = command.slice(start, end).trim();
		if (segment !== "" && segment !== command) segments.push(segment);
		const decoded = decodedAnsiCCommand(segment);
		if (decoded !== null) segments.push(decoded);
		start = null;
	};
	for (const token of scanShellLike(command)) {
		if (token.operator) {
			flush();
			continue;
		}
		start ??= token.start;
		end = token.end;
		if (depth >= SEGMENT_MAX_DEPTH) continue;
		for (const script of token.substitutions ?? []) {
			segments.push(script.trim(), ...shellCommandSegments(script, depth + 1));
		}
	}
	flush();
	if (depth < SEGMENT_MAX_DEPTH) {
		for (const segment of [...segments]) {
			const inner = inlineShellScript(segment);
			if (inner === null || inner.trim() === "") continue;
			segments.push(inner.trim(), ...shellCommandSegments(inner, depth + 1));
		}
		const inner = inlineShellScript(command);
		if (inner !== null && inner.trim() !== "") {
			segments.push(inner.trim(), ...shellCommandSegments(inner, depth + 1));
		}
	}
	return segments.filter((segment) => segment !== "");
}

/** Matches the inner-shell depth the trust and write-target scanners already use. */
const SEGMENT_MAX_DEPTH = 3;

function serializeArgs(args?: Record<string, unknown>): string {
	if (!args) return "";
	const parts: string[] = [];
	for (const v of Object.values(args)) {
		if (v == null) continue;
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(String(v));
		else {
			try {
				parts.push(JSON.stringify(v));
			} catch {
				// ignore values that cannot be serialized
			}
		}
	}
	return parts.join(" ");
}

/** Hashes the `{ base: [...] }` payload persisted run records already carry, so the hash stays byte-identical. */
export function rulePackHash(rules: ReadonlyArray<DamageControlRule>): string {
	const base = rules.map((rule) => ({
		id: rule.id,
		description: rule.description,
		pattern: rule.pattern.source,
		class: rule.class,
		block: rule.block,
		...(rule.ask !== undefined ? { ask: rule.ask } : {}),
	}));
	return sha256Hex(JSON.stringify({ base }));
}

export function invokesTrustMutation(command: string, rawText = false): boolean {
	// Wrappers, package launchers, quoted argv and source-tree CLI invocations
	// must not turn an operator-only grant into model authority; a loop list,
	// a help request or quoted data is not a grant (CLI-P31).
	return yoloFloorTrustGrant(command, rawText);
}

export function projectScriptPreview(command: string, cwd: string): string {
	const match = /^npm\s+(?:run\s+)?([\w:-]+)/.exec(command);
	if (match) {
		try {
			const manifest = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")) as {
				scripts?: Record<string, unknown>;
			};
			const name = match[1] ?? "test";
			const scripts = [`pre${name}`, name, `post${name}`].flatMap((key) =>
				typeof manifest.scripts?.[key] === "string" ? [`${key}: ${manifest.scripts[key]}`] : [],
			);
			return `package.json scripts (repository data): ${scripts.join("; ") || "no script resolved"}`;
		} catch {
			return "package.json script body could not be resolved; repository code will execute.";
		}
	}
	return `Repository command: ${command}. Its test/build files and dependencies execute with the child process permissions.`;
}

export const OVERSIZED_PATH_RULE_ID = "oversized-path";

/**
 * Linux opens paths of at most 4096 bytes, so no real path has more segments
 * than this. The path walks cost grows with the segment count, so a longer
 * token is refused before any of them run.
 */
export const MAX_PATH_SEGMENTS = 4096;

const PATH_BEARING_ARGS = ["path", "paths", "cwd", "command", "argv", "file", "target", "root"] as const;

/** The first string argument holding a whitespace-free run with more than MAX_PATH_SEGMENTS separators. */
export function oversizedPathToken(args: Record<string, unknown> | undefined): string | null {
	if (args === undefined) return null;
	// Only path and command arguments are walked; file content (write, edit)
	// may hold any number of slashes and is never resolved as a path.
	for (const key of PATH_BEARING_ARGS) {
		const value = args[key];
		const strings = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
		for (const text of strings) {
			if (typeof text !== "string" || text.length <= MAX_PATH_SEGMENTS) continue;
			let separators = 0;
			for (let index = 0; index < text.length; index += 1) {
				const code = text.charCodeAt(index);
				if (code === 47 || code === 92) {
					separators += 1;
					if (separators > MAX_PATH_SEGMENTS) return text;
				} else if (code === 32 || code === 9 || code === 10 || code === 13) separators = 0;
			}
		}
	}
	return null;
}
