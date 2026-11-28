// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * MCP elicitation, read and judged without any surface: a server's
 * `elicitation/create` params (MCP 2026-07-28 client/elicitation, and the
 * 2025-11-25 request a legacy server sends) become a typed form or URL
 * request, or the reason PanCode declines it on the operator's behalf. A
 * form's flat schema becomes fields a surface can render, and what the
 * operator submitted is checked against it before it is sent.
 */

import { domainToUnicode } from "node:url";
import { isRecord } from "../../core/type-guards.js";
import {
	elicitationContentErrors,
	elicitationValueError,
	type McpFieldBase,
	type McpFieldOption,
	type McpFormField,
} from "../../core/views/elicitation-values.js";
import { isSecretArgKey } from "../../lib/secrets/redaction.js";

export type McpElicitAction = "accept" | "decline" | "cancel";
export type McpElicitValue = string | number | boolean | string[];

/** The ElicitResult a client answers with; URL mode never carries content. */
export interface McpElicitResult {
	action: McpElicitAction;
	content?: Record<string, McpElicitValue>;
}

export interface McpFormElicitation {
	mode: "form";
	message: string;
	fields: McpFormField[];
}

export interface McpUrlElicitation {
	mode: "url";
	message: string;
	/** The parsed URL exactly as it would be opened. */
	url: string;
	/** The host as it would be shown in a browser, Unicode labels decoded. */
	host: string;
	/** The registrable part of the host, the one a spoofer cannot fake. */
	domain: string;
	/** Reasons to look twice: punycode, mixed scripts, plain http. */
	warnings: string[];
	/** Legacy (2025-11-25) only: the id `notifications/elicitation/complete` names. */
	elicitationId?: string;
}

export type McpElicitationRequest = McpFormElicitation | McpUrlElicitation;

/** What a surface is told besides the request itself. */
export interface McpElicitationContext {
	/** Aborts when the asking call ends or the server withdraws the request; the surface closes its prompt. */
	signal: AbortSignal;
	/**
	 * URL mode: once the browser opens, wait for the operator's Retry before
	 * answering accept (an input_required round, or a -32042 error to retry).
	 * Otherwise consent alone is accept (a legacy elicitation/create).
	 */
	awaitCompletion: boolean;
	/** URL mode: the operator consented to this same URL earlier in the call, so only the waiting card is shown. */
	consented: boolean;
	/** URL mode: aborts when the server reports the interaction finished, which counts as Retry. */
	completed?: AbortSignal;
}

/** A surface that asks the operator on a named server's behalf: the TUI, or an ACP client that opted in. */
export type McpElicitationHost = (
	serverId: string,
	request: McpElicitationRequest,
	context: McpElicitationContext,
) => Promise<McpElicitResult>;

/**
 * `invalid` breaks the request contract (the server is at fault, and a legacy
 * request gets -32602); `declined` is well formed but PanCode will not put it
 * in front of the operator, and answers decline with the reason.
 */
export type McpElicitationParse =
	| { kind: "ok"; request: McpElicitationRequest }
	| { kind: "invalid"; reason: string }
	| { kind: "declined"; mode: "form" | "url"; reason: string };

/** Characters of server text one request may show. */
const MESSAGE_CHARS = 2000;
const LABEL_CHARS = 200;
const KEY_CHARS = 128;
const DESCRIPTION_CHARS = 500;
const OPTION_CHARS = 200;
const OPTION_VALUE_CHARS = 1024;
const URL_CHARS = 2048;
const WARNING_CHARS = 512;
const DEFAULT_STRING_CHARS = 65536;
const MAX_FIELDS = 24;
const MAX_OPTIONS = 64;

/**
 * Server text a surface shows: escape and control sequences dropped, format
 * controls (bidi overrides, zero-width marks) removed so text cannot read as
 * something else, and cut to a bound.
 */
function elicitationText(value: string, max: number, keepLines = false): string {
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		if (/[\p{Cf}]/u.test(ch) || (code >= 0x80 && code <= 0x9f)) continue;
		if (code < 0x20 || code === 0x7f) out += keepLines && ch === "\n" ? "\n" : " ";
		else out += ch;
	}
	const text = keepLines ? out.replace(/[ \t]+\n/g, "\n").trim() : out.replace(/\s+/g, " ").trim();
	const chars = Array.from(text);
	return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** True when a server default string has bidi/format marks or control characters other than newline and tab. */
function hasUnsafeControl(value: string): boolean {
	for (const ch of value) {
		if (ch === "\n" || ch === "\t") continue;
		if (/[\p{Cc}\p{Cf}]/u.test(ch)) return true;
	}
	return false;
}

/** A field that asks for a secret: MCP forms must not collect one (client/elicitation, Form Mode Security). */
function secretField(key: string, title: string | undefined): boolean {
	return isSecretArgKey(key) || (title !== undefined && isSecretArgKey(title.replace(/\s+/g, "_")));
}

const nonNegativeInt = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
const finite = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

function optionList(values: unknown, labels?: unknown): McpFieldOption[] | null {
	if (!Array.isArray(values) || values.length === 0 || values.length > MAX_OPTIONS) return null;
	if (values.some((value) => typeof value !== "string" || value.length > OPTION_VALUE_CHARS)) return null;
	if (new Set(values).size !== values.length) return null;
	const names = Array.isArray(labels) && labels.length === values.length ? labels : null;
	return (values as string[]).map((value, index) => {
		const name = names?.[index];
		return {
			value,
			label: elicitationText(typeof name === "string" ? name : value, OPTION_CHARS) || `Option ${index + 1}`,
		};
	});
}

function titledOptions(entries: unknown): McpFieldOption[] | null {
	if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_OPTIONS) return null;
	const options: McpFieldOption[] = [];
	for (const [index, entry] of entries.entries()) {
		if (!isRecord(entry) || typeof entry.const !== "string" || entry.const.length > OPTION_VALUE_CHARS) return null;
		const label = typeof entry.title === "string" ? elicitationText(entry.title, OPTION_CHARS) : "";
		options.push({
			value: entry.const,
			label: label || elicitationText(entry.const, OPTION_CHARS) || `Option ${index + 1}`,
		});
	}
	return new Set(options.map((option) => option.value)).size === options.length ? options : null;
}

/** One property of a requested schema as a field, or why PanCode cannot render it. */
function readField(key: string, schema: unknown, required: boolean): McpFormField | string {
	// The key is sent back as is and shown when there is no title, so it must read as itself.
	if (key.length === 0 || key.length > KEY_CHARS || /[\p{Cc}\p{Cf}]/u.test(key))
		return "a field name is empty, too long, or carries control characters";
	if (!isRecord(schema)) return `field '${key}' has no schema object`;
	const title = typeof schema.title === "string" ? schema.title : undefined;
	if (secretField(key, title)) return `field '${key}' asks for a secret, which an MCP form must not collect`;
	const base: McpFieldBase = {
		key,
		label: (title === undefined ? "" : elicitationText(title, LABEL_CHARS)) || key,
		required,
		...(typeof schema.description === "string" && schema.description.trim().length > 0
			? { description: elicitationText(schema.description, DESCRIPTION_CHARS, true) }
			: {}),
	};
	switch (schema.type) {
		case "string": {
			if (schema.enum !== undefined || schema.oneOf !== undefined) {
				const options =
					schema.oneOf !== undefined ? titledOptions(schema.oneOf) : optionList(schema.enum, schema.enumNames);
				if (options === null) return `field '${key}' has an option list PanCode cannot read`;
				const fallback = typeof schema.default === "string" ? schema.default : undefined;
				return {
					...base,
					kind: "choice",
					options,
					...(fallback !== undefined && options.some((option) => option.value === fallback) ? { default: fallback } : {}),
				};
			}
			const format = schema.format;
			if (format !== undefined && format !== "email" && format !== "uri" && format !== "date" && format !== "date-time")
				return `field '${key}' uses string format ${JSON.stringify(format)}, which MCP forms do not define`;
			const minLength = nonNegativeInt(schema.minLength);
			const maxLength = nonNegativeInt(schema.maxLength);
			if (minLength !== undefined && maxLength !== undefined && minLength > maxLength)
				return `field '${key}' has minLength greater than maxLength`;
			const field: Extract<McpFormField, { kind: "string" }> = {
				...base,
				kind: "string",
				...(minLength !== undefined ? { minLength } : {}),
				...(maxLength !== undefined ? { maxLength } : {}),
				...(format !== undefined ? { format } : {}),
			};
			if (
				typeof schema.default === "string" &&
				schema.default.length <= DEFAULT_STRING_CHARS &&
				!hasUnsafeControl(schema.default) &&
				elicitationValueError(field, schema.default) === null
			) {
				field.default = schema.default;
			}
			return field;
		}
		case "number":
		case "integer": {
			const minimum = finite(schema.minimum);
			const maximum = finite(schema.maximum);
			if (minimum !== undefined && maximum !== undefined && minimum > maximum)
				return `field '${key}' has minimum greater than maximum`;
			if (
				schema.type === "integer" &&
				minimum !== undefined &&
				maximum !== undefined &&
				Math.ceil(minimum) > Math.floor(maximum)
			)
				return `field '${key}' has no whole number between minimum and maximum`;
			const fallback = finite(schema.default);
			const field: Extract<McpFormField, { kind: "number" }> = {
				...base,
				kind: "number",
				integer: schema.type === "integer",
				...(minimum !== undefined ? { minimum } : {}),
				...(maximum !== undefined ? { maximum } : {}),
			};
			if (fallback !== undefined && elicitationValueError(field, fallback) === null) field.default = fallback;
			return field;
		}
		case "boolean":
			return { ...base, kind: "boolean", ...(typeof schema.default === "boolean" ? { default: schema.default } : {}) };
		case "array": {
			const items = schema.items;
			if (!isRecord(items)) return `field '${key}' is an array without an item schema`;
			const options = items.anyOf !== undefined ? titledOptions(items.anyOf) : optionList(items.enum);
			if (options === null) return `field '${key}' is an array that is not a multi-select of listed options`;
			const minItems = nonNegativeInt(schema.minItems);
			const maxItems = nonNegativeInt(schema.maxItems);
			if (minItems !== undefined && maxItems !== undefined && minItems > maxItems)
				return `field '${key}' has minItems greater than maxItems`;
			if (minItems !== undefined && minItems > options.length)
				return `field '${key}' requires more selections than it offers`;
			const fallback =
				Array.isArray(schema.default) && schema.default.every((value) => options.some((option) => option.value === value))
					? [...new Set(schema.default as string[])]
					: undefined;
			const field: Extract<McpFormField, { kind: "multi" }> = {
				...base,
				kind: "multi",
				options,
				...(minItems !== undefined ? { minItems } : {}),
				...(maxItems !== undefined ? { maxItems } : {}),
			};
			if (fallback !== undefined && elicitationValueError(field, fallback) === null) field.default = fallback;
			return field;
		}
		default:
			return `field '${key}' has type ${JSON.stringify(schema.type)}, which a flat MCP form does not allow`;
	}
}

/** Public suffixes of two labels common enough that the label before them is the registrable one. */
const TWO_LABEL_SUFFIXES = new Set([
	"co.uk",
	"org.uk",
	"ac.uk",
	"gov.uk",
	"com.au",
	"net.au",
	"org.au",
	"co.jp",
	"co.nz",
	"co.za",
	"com.br",
	"com.cn",
	"com.mx",
	"co.in",
	"co.kr",
	"com.tr",
	"github.io",
	"pages.dev",
	"vercel.app",
	"netlify.app",
	"herokuapp.com",
]);

/**
 * The registrable domain of a host, the part a subdomain cannot spoof:
 * the last two labels, or three under a common two-label suffix. An IP
 * literal or a single label is its own domain. PanCode ships no public
 * suffix list, so a rarer multi-label suffix shows one label short.
 */
function registrableDomain(host: string): string {
	if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/u.test(host)) return host;
	const labels = host.replace(/\.$/u, "").split(".");
	if (labels.length <= 2) return labels.join(".");
	const lastTwo = labels.slice(-2).join(".");
	return labels.slice(TWO_LABEL_SUFFIXES.has(lastTwo) ? -3 : -2).join(".");
}

const SCRIPT_NAMES = [
	"Latin",
	"Cyrillic",
	"Greek",
	"Armenian",
	"Hebrew",
	"Arabic",
	"Han",
	"Hiragana",
	"Katakana",
	"Hangul",
	"Thai",
	"Devanagari",
	"Georgian",
	"Cherokee",
] as const;
const SCRIPTS = SCRIPT_NAMES.map((name) => ({ name, pattern: new RegExp(`\\p{Script=${name}}`, "u") }));

/** The scripts a label's letters come from; more than one in a label is the classic homograph. */
function labelScripts(label: string): Set<string> {
	const found = new Set<string>();
	for (const ch of label) {
		if (!/\p{L}/u.test(ch)) continue;
		found.add(SCRIPTS.find((script) => script.pattern.test(ch))?.name ?? "other");
	}
	return found;
}

/** The URL a URL-mode request names, as PanCode would show and open it, or why it will not. */
function readUrl(raw: string): Omit<McpUrlElicitation, "mode" | "message" | "elicitationId"> | string {
	if (raw.length > URL_CHARS) return `the URL is longer than ${URL_CHARS} characters`;
	if (/[\p{Cc}\p{Cf}\s]/u.test(raw)) return "the URL carries whitespace or invisible control characters";
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return "the URL does not parse";
	}
	if (parsed.href.length > URL_CHARS) return `the URL is longer than ${URL_CHARS} characters`;
	const loopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/u.test(parsed.hostname);
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
		return `PanCode opens only https: links (or http: on this machine), and this one is ${parsed.protocol}`;
	if (parsed.username !== "" || parsed.password !== "") return "the URL carries credentials before its host";
	const ascii = parsed.hostname;
	const host = domainToUnicode(ascii) || ascii;
	const warnings: string[] = [];
	if (ascii.split(".").some((label) => label.startsWith("xn--")))
		warnings.push(
			elicitationText(
				`the host is punycode (${ascii}) and displays as ${host}; check it is the site you expect`,
				WARNING_CHARS,
			),
		);
	const mixed = host.split(".").find((label) => labelScripts(label).size > 1);
	if (mixed !== undefined)
		warnings.push(elicitationText(`the host label '${mixed}' mixes letters from different scripts`, WARNING_CHARS));
	if (parsed.protocol === "http:") warnings.push("the link is plain http on this machine");
	return { url: parsed.href, host, domain: registrableDomain(host), warnings };
}

/**
 * Read `elicitation/create` params. `legacy` reads the 2025-11-25 shape,
 * whose URL mode carries an `elicitationId`.
 */
export function parseElicitationRequest(params: unknown, legacy: boolean): McpElicitationParse {
	if (!isRecord(params)) return { kind: "invalid", reason: "elicitation/create params are not an object" };
	const mode = params.mode ?? "form";
	if (mode !== "form" && mode !== "url")
		return { kind: "invalid", reason: `elicitation mode ${JSON.stringify(mode)} is not form or url` };
	if (typeof params.message !== "string") return { kind: "invalid", reason: "elicitation/create lacks a message" };
	const message = elicitationText(params.message, MESSAGE_CHARS, true);
	if (mode === "url") {
		if (typeof params.url !== "string") return { kind: "invalid", reason: "a URL elicitation lacks its url" };
		if (legacy && (typeof params.elicitationId !== "string" || params.elicitationId.length === 0))
			return { kind: "invalid", reason: "a URL elicitation lacks its elicitationId" };
		const url = readUrl(params.url);
		if (typeof url === "string") return { kind: "declined", mode, reason: url };
		return {
			kind: "ok",
			request: {
				mode,
				message,
				...url,
				...(legacy ? { elicitationId: params.elicitationId as string } : {}),
			},
		};
	}
	const schema = params.requestedSchema;
	if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties))
		return { kind: "invalid", reason: "a form elicitation's requestedSchema is not an object schema with properties" };
	const required = Array.isArray(schema.required)
		? schema.required.filter((key): key is string => typeof key === "string")
		: [];
	const entries = Object.entries(schema.properties);
	if (entries.length === 0) return { kind: "declined", mode, reason: "the form asks for no fields" };
	if (entries.length > MAX_FIELDS)
		return {
			kind: "declined",
			mode,
			reason: `the form has ${entries.length} fields; PanCode shows at most ${MAX_FIELDS}`,
		};
	const missing = required.find((key) => !Object.hasOwn(schema.properties as object, key));
	if (missing !== undefined) return { kind: "declined", mode, reason: `required field '${missing}' has no schema` };
	const fields: McpFormField[] = [];
	for (const [key, property] of entries) {
		const field = readField(key, property, required.includes(key));
		if (typeof field === "string") return { kind: "declined", mode, reason: elicitationText(field, MESSAGE_CHARS) };
		fields.push(field);
	}
	return { kind: "ok", request: { mode, message, fields } };
}

/** Check submitted content against the form before it is sent; empty when the content fits. */
export function formContentErrors(form: McpFormElicitation, content: unknown): string[] {
	return isRecord(content) ? elicitationContentErrors(form.fields, content) : ["the answer is not an object"];
}

/**
 * Read one typed answer into the field's JSON value: a number for a number
 * field, true or false for a boolean. Null with the reason when it does not
 * read; the value is then checked with `elicitationValueError`.
 */
export function readTypedValue(field: McpFormField, text: string): { value: McpElicitValue } | { error: string } {
	const trimmed = text.trim();
	switch (field.kind) {
		case "number": {
			if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/u.test(trimmed)) return { error: "must be a number" };
			return { value: Number(trimmed) };
		}
		case "boolean": {
			if (/^(true|yes|y)$/iu.test(trimmed)) return { value: true };
			if (/^(false|no|n)$/iu.test(trimmed)) return { value: false };
			return { error: "must be yes or no" };
		}
		default:
			return { value: text };
	}
}

/** A submitted value in one line, for the review step an operator confirms. */
export function describeValue(field: McpFormField, value: McpElicitValue): string {
	const label = (raw: string): string =>
		field.kind === "choice" || field.kind === "multi"
			? (field.options.find((option) => option.value === raw)?.label ?? raw)
			: raw;
	if (Array.isArray(value)) return value.length === 0 ? "(none)" : value.map(label).join(", ");
	if (typeof value === "boolean") return value ? "yes" : "no";
	return typeof value === "string" ? label(value) : String(value);
}
