// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The `--scope` glob matcher: minimatch's syntax with dot files matched, no `!` negation, no `#` comments and `\` read
 * as a path separator. Braces expand first, then each pattern matches segment by segment: `**` alone spans any number
 * of segments (at least one when it ends the pattern), and the path is read with `.` and `..` segments folded.
 */

/** Split `{a,b}` alternatives at the top level of a brace body; null when the body has no top-level comma. */
function alternatives(body: string): string[] | null {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < body.length; index++) {
		const char = body[index];
		if (char === "{") depth += 1;
		else if (char === "}") depth -= 1;
		else if (char === "," && depth === 0) {
			parts.push(body.slice(start, index));
			start = index + 1;
		}
	}
	if (parts.length === 0) return null;
	parts.push(body.slice(start));
	return parts;
}

/** `{1..3}` and `{a..c}` sequences, as brace expansion writes them. */
function sequence(body: string): string[] | null {
	const numeric = /^(-?\d+)\.\.(-?\d+)$/u.exec(body);
	if (numeric !== null) {
		const from = Number(numeric[1]);
		const to = Number(numeric[2]);
		const step = from <= to ? 1 : -1;
		const out: string[] = [];
		for (let value = from; step > 0 ? value <= to : value >= to; value += step) out.push(String(value));
		return out.length <= 1000 ? out : null;
	}
	const alpha = /^([a-zA-Z])\.\.([a-zA-Z])$/u.exec(body);
	if (alpha !== null) {
		const from = (alpha[1] as string).charCodeAt(0);
		const to = (alpha[2] as string).charCodeAt(0);
		const step = from <= to ? 1 : -1;
		const out: string[] = [];
		for (let code = from; step > 0 ? code <= to : code >= to; code += step) out.push(String.fromCharCode(code));
		return out;
	}
	return null;
}

export function expandBraces(pattern: string): string[] {
	for (let open = 0; open < pattern.length; open++) {
		if (pattern[open] !== "{") continue;
		let depth = 0;
		for (let close = open; close < pattern.length; close++) {
			if (pattern[close] === "{") depth += 1;
			else if (pattern[close] === "}") {
				depth -= 1;
				if (depth !== 0) continue;
				const body = pattern.slice(open + 1, close);
				const options = alternatives(body) ?? sequence(body);
				if (options === null) break;
				const head = pattern.slice(0, open);
				const tail = pattern.slice(close + 1);
				return options.flatMap((option) => expandBraces(`${head}${option}${tail}`));
			}
		}
	}
	return [pattern];
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");

/** A bracket class at `start` (the `[`), as a regex class and where it ends, or null when it never closes. */
function bracket(segment: string, start: number): { source: string; end: number } | null {
	let index = start + 1;
	let negate = false;
	if (segment[index] === "!" || segment[index] === "^") {
		negate = true;
		index += 1;
	}
	let body = "";
	let first = true;
	for (; index < segment.length; index++) {
		const char = segment[index] as string;
		if (char === "]" && !first) return { source: `[${negate ? "^" : ""}${body}]`, end: index };
		first = false;
		if (char === "[" && segment[index + 1] === ":") {
			const close = segment.indexOf(":]", index + 2);
			if (close !== -1) {
				const name = segment.slice(index + 2, close);
				const posix: Record<string, string> = {
					alnum: "a-zA-Z0-9",
					alpha: "a-zA-Z",
					digit: "0-9",
					lower: "a-z",
					upper: "A-Z",
					space: "\\s",
					xdigit: "0-9a-fA-F",
					punct: "!-\\/:-@\\[-`{-~",
					word: "\\w",
				};
				const range = posix[name];
				if (range !== undefined) {
					body += range;
					index = close + 1;
					continue;
				}
			}
		}
		body += char === "\\" || char === "]" || char === "^" ? `\\${char}` : char;
	}
	return null;
}

/** The regex body of one pattern segment, or null for a segment with no magic (compared literally). */
function segmentSource(segment: string): string {
	let out = "";
	let index = 0;
	const close = (from: number): number => {
		let depth = 0;
		for (let at = from; at < segment.length; at++) {
			if (segment[at] === "(") depth += 1;
			else if (segment[at] === ")") {
				depth -= 1;
				if (depth === 0) return at;
			}
		}
		return -1;
	};
	while (index < segment.length) {
		const char = segment[index] as string;
		if ("!@+*?".includes(char) && segment[index + 1] === "(") {
			const end = close(index + 1);
			if (end !== -1) {
				const inner = splitTop(segment.slice(index + 2, end))
					.map(segmentSource)
					.join("|");
				const rest = segment.slice(end + 1);
				if (char === "!") out += rest.length === 0 ? `(?:(?!(?:${inner})$)[^/]*?)` : `(?:(?!(?:${inner}))[^/]*?)`;
				else if (char === "@") out += `(?:${inner})`;
				else if (char === "+") out += `(?:${inner})+`;
				else if (char === "*") out += `(?:${inner})*`;
				else out += `(?:${inner})?`;
				index = end + 1;
				continue;
			}
		}
		if (char === "*") {
			while (segment[index + 1] === "*") index += 1;
			out += "[^/]*?";
		} else if (char === "?") out += "[^/]";
		else if (char === "[") {
			const klass = bracket(segment, index);
			if (klass === null) out += "\\[";
			else {
				out += klass.source;
				index = klass.end;
			}
		} else out += escapeRegex(char);
		index += 1;
	}
	return out;
}

/** Split extglob alternatives on top-level `|`. */
function splitTop(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < body.length; index++) {
		const char = body[index];
		if (char === "(") depth += 1;
		else if (char === ")") depth -= 1;
		else if (char === "|" && depth === 0) {
			parts.push(body.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(body.slice(start));
	return parts;
}

type Part = { globstar: true } | { globstar: false; literal: string; regex: RegExp | null };

function compile(pattern: string): Part[] {
	return pattern.split("/").map((segment): Part => {
		if (segment === "**") return { globstar: true };
		const magic = /[*?[]|[!@+*?]\(/u.test(segment);
		return { globstar: false, literal: segment, regex: magic ? new RegExp(`^${segmentSource(segment)}$`, "u") : null };
	});
}

/** A segment a wildcard may match: never `.` or `..`. */
const wild = (segment: string): boolean => segment !== "." && segment !== "..";

function matchParts(parts: ReadonlyArray<Part>, segments: ReadonlyArray<string>, p = 0, s = 0): boolean {
	for (; p < parts.length; p++, s++) {
		const part = parts[p] as Part;
		if (part.globstar) {
			// A trailing `**` takes the rest, at least one segment.
			if (p === parts.length - 1) return s < segments.length && segments.slice(s).every(wild);
			for (let at = s; at <= segments.length; at++) {
				if (matchParts(parts, segments, p + 1, at)) return true;
				const next = segments[at];
				if (next === undefined || !wild(next)) return false;
			}
			return false;
		}
		const segment = segments[s];
		if (segment === undefined) return false;
		if (part.regex === null) {
			if (segment !== part.literal) return false;
			continue;
		}
		if (segment === "" || !wild(segment) || !part.regex.test(segment)) return false;
	}
	return s === segments.length || (s === segments.length - 1 && segments[s] === "");
}

/** The path's segments as minimatch reads them: `.` dropped and `..` folding its parent. */
function pathSegments(path: string): string[] {
	const segments: string[] = [];
	const parts = path.split("/");
	parts.forEach((part) => {
		if (part === ".") return;
		if (part === ".." && segments.length > 0 && segments.at(-1) !== "..") segments.pop();
		else segments.push(part);
	});
	return segments;
}

export function globMatch(path: string, pattern: string): boolean {
	const segments = pathSegments(path);
	return expandBraces(pattern.replaceAll("\\", "/")).some((expanded) => matchParts(compile(expanded), segments));
}

export function inScope(path: string, scope: ReadonlyArray<string>): boolean {
	return scope.length === 0 || scope.some((pattern) => path === pattern || globMatch(path, pattern));
}
