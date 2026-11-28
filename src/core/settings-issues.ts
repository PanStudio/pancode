// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Settings issues: the collector the validators fill, its scalar checks and repairs, and the text an operator reads. */

import { join } from "node:path";
import type { SettingsFieldName } from "./settings-fields.js";
import { isRecord } from "./type-guards.js";
import { resolvePancodeDirs } from "./xdg.js";

/**
 * What kind of failure produced a {@link SettingsIssue}. `"schema"` (the
 * default when the field is absent) means a key violates the one schema, so
 * the issue path names the key at fault. `"unreadable"` and `"syntax"` are
 * whole-file failures where no key is at fault and remedies that talk about
 * keys do not apply; they are kept apart because a permission error announced
 * as invalid YAML sends the operator after the wrong problem.
 */
type SettingsIssueKind = "unreadable" | "syntax" | "schema";

export interface SettingsIssue {
	/** Dotted key path, e.g. `chat.connection` or `connections[2].runtime`. */
	path: string;
	message: string;
	kind?: SettingsIssueKind;
}

/**
 * The failure kind of an issue list. Only the first issue can be a file-level
 * failure: a read or a parse that fails returns exactly one issue and never
 * reaches the schema walk, so a mixed list is always schema issues.
 */
export function issuesKind(issues: ReadonlyArray<SettingsIssue>): SettingsIssueKind {
	return issues[0]?.kind ?? "schema";
}

/**
 * Syntax and access failures need an operator edit before scalar repairs can
 * inspect the document safely.
 */
function settingsRemedy(kind: SettingsIssueKind, path: string): string {
	if (kind === "unreadable") return `Restore read access to ${path}, then run \`pancode doctor\` to re-check.`;
	if (kind === "syntax") return `Fix the YAML in ${path}, then run \`pancode doctor\` to re-check.`;
	return `Fix the keys above in ${path}, then run \`pancode doctor\` to re-check.`;
}

/** The same repair as {@link settingsRemedy}, phrased to sit inside one line's parentheses. */
function settingsRemedyInline(kind: SettingsIssueKind, path: string): string {
	if (kind === "unreadable") return `restore read access to ${path}`;
	if (kind === "syntax") return `fix the YAML in ${path}`;
	return `edit the named keys in ${path}`;
}

export class SettingsValidationError extends Error {
	readonly issues: ReadonlyArray<SettingsIssue>;

	/**
	 * The headline and the remedy both follow the failure kind. A file that
	 * cannot be read has no key at fault, so telling its reader to "fix the keys
	 * above" named a repair that does not exist for the problem they have.
	 */
	constructor(issues: ReadonlyArray<SettingsIssue>) {
		const path = join(resolvePancodeDirs().config, "settings.yaml");
		const kind = issuesKind(issues);
		// File-level issues all carry the same `(root)` path, which says nothing;
		// their message already names what failed.
		const lines =
			kind === "schema"
				? issues.map((issue) => `  ${issue.path}: ${issue.message}`)
				: issues.map((issue) => `  ${issue.message}`);
		const headline = kind === "schema" ? "settings.yaml failed validation:" : "settings.yaml cannot be loaded:";
		super(
			`${headline}\n${lines.join("\n")}\n\n` +
				`${settingsRemedy(kind, path)}\n` +
				"Run `pancode doctor --fix` to repair YAML 1.1 on/off booleans, directories, and credential permissions without discarding your configuration.",
		);
		this.name = "SettingsValidationError";
		this.issues = issues;
	}
}

function foldToOneLine(text: string): string {
	return text.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * The summary line of a YAML parse error, without the source excerpt it carries.
 *
 * The `yaml` package formats an error as a summary, then a blank line, then the
 * offending source, then a caret diagram. Folding all of that into one line
 * dragged the raw fragment into the middle of the notice, so a settings file
 * containing `\t\t: : :` reported "at line 1, column 1: : : : ^^", where the
 * tail reads as corruption of the message rather than a quote of the file. The
 * summary already names the line and the column, which is what locates the
 * fault; the excerpt is the operator's own file and they are being sent to it.
 *
 * The summary ends on the colon that introduced the excerpt, so dropping the
 * excerpt leaves it dangling in front of whatever follows.
 */
export function yamlErrorSummary(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return (raw.split("\n")[0] ?? raw).trim().replace(/:$/u, "");
}

/** The failure in three words, for a line whose tail may not survive clamping. */
export function settingsFailureHeadline(kind: SettingsIssueKind): string {
	if (kind === "unreadable") return "settings.yaml cannot be read";
	if (kind === "syntax") return "settings.yaml is not valid YAML";
	return "settings.yaml failed validation";
}

/**
 * One operator-facing line for a settings file that will not load, carrying
 * the exact key paths for a schema failure and the remedy that fits whatever
 * actually failed. Doctor renders it as its settings row and the runtime
 * reload path renders it as a TUI notice, so both speak with one voice.
 *
 * Order: kind, then the failing keys and their cause, then the remedy, which
 * names the file once. The cause leads because it decides which remedy is
 * right: a remedy read before the key it applies to sent the operator to the
 * wrong one (M-30). A surface that clamps keeps the key through
 * {@link settingsReloadFailure}'s headline.
 */
export function formatSettingsIssues(issues: ReadonlyArray<SettingsIssue>): string {
	if (issues.length === 0) return "";
	const path = join(resolvePancodeDirs().config, "settings.yaml");
	const kind = issuesKind(issues);
	// A file-level issue message repeats the kind because the thrown multi-line
	// error has no headline of its own. Here the headline says it already.
	const detail =
		kind === "schema"
			? issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
			: issues.map((issue) => issue.message.replace(/^(?:invalid YAML|unreadable): /u, "")).join("; ");
	const remedy = settingsRemedyInline(kind, path);
	return foldToOneLine(
		`${settingsFailureHeadline(kind)}: ${detail.replace(/\.$/u, "")}. ${remedy.charAt(0).toUpperCase()}${remedy.slice(1)}. Run \`pancode doctor --fix\` for safe repairs.`,
	);
}

/**
 * {@link formatSettingsIssues} for a caught error, for callers that hold the
 * throw rather than the issue list.
 *
 * Live surfaces render this instead of the error object. Handing an error to
 * `console.error` inside a running TUI prints a `util.inspect` dump: the
 * `issues` array with its `\n` escapes, a stack trace naming a dist chunk, and
 * a YAML excerpt whose newlines walk straight over the live frame.
 */
export function formatSettingsFailure(error: unknown): string {
	if (error instanceof SettingsValidationError && error.issues.length > 0) return formatSettingsIssues(error.issues);
	return foldToOneLine(error instanceof Error ? error.message : String(error));
}

/** A scalar `doctor --fix` rewrites in place, supplied by the validator so the repair cannot drift from its advice. */
export interface SettingsScalarRepair {
	path: string;
	from: boolean | string;
	to: string;
}

/** YAML 1.1 boolean repairs remain separate because loading already accepts their on/off meaning. */
export interface SettingsCoercion extends SettingsScalarRepair {
	from: boolean;
	to: "on" | "off";
}

export class Issues {
	readonly list: SettingsIssue[] = [];
	readonly coercions: SettingsCoercion[] = [];

	add(path: string, message: string): void {
		this.list.push({ path, message });
	}

	coerced(coercion: SettingsCoercion): void {
		this.coercions.push(coercion);
	}

	unknownKeys(path: string, raw: Record<string, unknown>, known: ReadonlyArray<SettingsFieldName>): void {
		const knownSet = new Set<string>(known);
		for (const key of Object.keys(raw)) {
			if (!knownSet.has(key)) this.add(path ? `${path}.${key}` : key, "unknown key");
		}
	}
}

export function expectString(issues: Issues, path: string, value: unknown): string | undefined {
	if (typeof value !== "string") {
		issues.add(path, `expected a string, got ${describe(value)}`);
		return undefined;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		issues.add(path, "expected a non-empty string");
		return undefined;
	}
	return trimmed;
}

export function expectBoolean(issues: Issues, path: string, value: unknown): boolean | undefined {
	if (typeof value !== "boolean") {
		issues.add(path, `expected a boolean, got ${describe(value)}`);
		return undefined;
	}
	return value;
}

export function expectNumber(
	issues: Issues,
	path: string,
	value: unknown,
	opts?: { min?: number; max?: number },
): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		issues.add(path, `expected a number, got ${describe(value)}`);
		return undefined;
	}
	if (opts?.min !== undefined && value < opts.min) {
		issues.add(path, `expected a number >= ${opts.min}, got ${value}`);
		return undefined;
	}
	if (opts?.max !== undefined && value > opts.max) {
		issues.add(path, `expected a number <= ${opts.max}, got ${value}`);
		return undefined;
	}
	return value;
}

export function expectInteger(
	issues: Issues,
	path: string,
	value: unknown,
	opts?: { min?: number; max?: number },
): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		issues.add(path, `expected an integer, got ${describe(value)}`);
		return undefined;
	}
	if (opts?.min !== undefined && value < opts.min) {
		issues.add(path, `expected an integer >= ${opts.min}, got ${value}`);
		return undefined;
	}
	if (opts?.max !== undefined && value > opts.max) {
		issues.add(path, `expected an integer <= ${opts.max}, got ${value}`);
		return undefined;
	}
	return value;
}

export function expectEnum<T extends string>(
	issues: Issues,
	path: string,
	value: unknown,
	allowed: ReadonlyArray<T>,
): T | undefined {
	if (typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value)) return value as T;
	// PyYAML and other YAML 1.1 tools write a bare `off` or `on` as a boolean, and
	// hand edits often say `false`. This covers those two booleans only, and only
	// where the field really has that level, so `thinkingLevel: true` still fails.
	if (typeof value === "boolean") {
		const spelled = value ? "on" : "off";
		if ((allowed as ReadonlyArray<string>).includes(spelled)) {
			issues.coerced({ path, from: value, to: spelled });
			return spelled as T;
		}
	}
	issues.add(path, `expected one of ${allowed.join(" | ")}, got ${describe(value)}`);
	return undefined;
}

export function expectStringArray(issues: Issues, path: string, value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		issues.add(path, `expected a list of strings, got ${describe(value)}`);
		return undefined;
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (let i = 0; i < value.length; i += 1) {
		const entry = expectString(issues, `${path}[${i}]`, value[i]);
		if (entry === undefined) continue;
		if (seen.has(entry)) continue;
		seen.add(entry);
		out.push(entry);
	}
	return out;
}

export function expectStringRecord(issues: Issues, path: string, value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) {
		issues.add(path, `expected a string map, got ${describe(value)}`);
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		const entry = expectString(issues, `${path}.${key}`, raw);
		if (entry !== undefined) out[key] = entry;
	}
	return out;
}

export function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "a list";
	if (typeof value === "object") return "a map";
	if (typeof value === "string") return value.trim().length === 0 ? "an empty string" : JSON.stringify(value);
	return String(value);
}
