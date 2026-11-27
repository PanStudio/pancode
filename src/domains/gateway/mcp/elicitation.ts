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
import { isRecord } from "../../../core/type-guards.js";
import { isSecretArgKey } from "../../safety/redaction.js";

export type McpElicitAction = "accept" | "decline" | "cancel";
export type McpElicitValue = string | number | boolean | string[];

/** The ElicitResult a client answers with; URL mode never carries content. */
export interface McpElicitResult {
	action: McpElicitAction;
	content?: Record<string, McpElicitValue>;
}

interface FieldBase {
	key: string;
	/** The schema's title, else the key. */
	label: string;
	description?: string;
	required: boolean;
}

export type McpStringFormat = "email" | "uri" | "date" | "date-time";

export type McpFormField =
	| (FieldBase & {
			kind: "string";
			minLength?: number;
			maxLength?: number;
			format?: McpStringFormat;
			default?: string;
	  })
	| (FieldBase & { kind: "number"; integer: boolean; minimum?: number; maximum?: number; default?: number })
	| (FieldBase & { kind: "boolean"; default?: boolean })
	| (FieldBase & { kind: "choice"; options: McpFieldOption[]; default?: string })
	| (FieldBase & {
			kind: "multi";
			options: McpFieldOption[];
			minItems?: number;
			maxItems?: number;
			default?: string[];
	  });

export interface McpFieldOption {
	value: string;
	label: string;
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
	const base: FieldBase = {
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
			return {
				...base,
				kind: "string",
				...(minLength !== undefined ? { minLength } : {}),
				...(maxLength !== undefined ? { maxLength } : {}),
				...(format !== undefined ? { format } : {}),
				...(typeof schema.default === "string" ? { default: schema.default } : {}),
			};
		}
		case "number":
		case "integer": {
			const minimum = finite(schema.minimum);
			const maximum = finite(schema.maximum);
			const fallback = finite(schema.default);
			return {
				...base,
				kind: "number",
				integer: schema.type === "integer",
				...(minimum !== undefined ? { minimum } : {}),
				...(maximum !== undefined ? { maximum } : {}),
				...(fallback !== undefined && (schema.type !== "integer" || Number.isInteger(fallback))
					? { default: fallback }
					: {}),
			};
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
			const fallback =
				Array.isArray(schema.default) && schema.default.every((value) => options.some((option) => option.value === value))
					? [...new Set(schema.default as string[])]
					: undefined;
			return {
				...base,
				kind: "multi",
				options,
				...(minItems !== undefined ? { minItems } : {}),
				...(maxItems !== undefined ? { maxItems } : {}),
				...(fallback !== undefined ? { default: fallback } : {}),
			};
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
	const loopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/u.test(parsed.hostname);
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
		return `PanCode opens only https: links (or http: on this machine), and this one is ${parsed.protocol}`;
	if (parsed.username !== "" || parsed.password !== "") return "the URL carries credentials before its host";
	const ascii = parsed.hostname;
	const host = domainToUnicode(ascii) || ascii;
	const warnings: string[] = [];
	if (ascii.split(".").some((label) => label.startsWith("xn--")))
		warnings.push(`the host is punycode (${ascii}) and displays as ${host}; check it is the site you expect`);
	const mixed = host.split(".").find((label) => labelScripts(label).size > 1);
	if (mixed !== undefined) warnings.push(`the host label '${mixed}' mixes letters from different scripts`);
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/u;

function validDate(text: string): boolean {
	const match = DATE.exec(text);
	if (match === null) return false;
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatError(format: McpStringFormat, text: string): string | null {
	switch (format) {
		case "email":
			return EMAIL.test(text) ? null : "is not an email address";
		case "uri":
			return /^[a-z][a-z0-9+.-]*:/iu.test(text) && URL.canParse(text) ? null : "is not an absolute URI";
		case "date":
			return validDate(text) ? null : "is not a date (YYYY-MM-DD)";
		case "date-time":
			return DATE_TIME.test(text) && validDate(text.slice(0, 10)) && !Number.isNaN(Date.parse(text))
				? null
				: "is not a date-time (YYYY-MM-DDThh:mm:ssZ)";
	}
}

/** Why one value does not fit its field, or null when it does. */
export function fieldValueError(field: McpFormField, value: unknown): string | null {
	switch (field.kind) {
		case "string": {
			if (typeof value !== "string") return "must be text";
			const length = Array.from(value).length;
			if (field.minLength !== undefined && length < field.minLength)
				return `must be at least ${field.minLength} characters`;
			if (field.maxLength !== undefined && length > field.maxLength)
				return `must be at most ${field.maxLength} characters`;
			return field.format === undefined ? null : formatError(field.format, value);
		}
		case "number": {
			if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
			if (field.integer && !Number.isInteger(value)) return "must be a whole number";
			if (field.minimum !== undefined && value < field.minimum) return `must be at least ${field.minimum}`;
			if (field.maximum !== undefined && value > field.maximum) return `must be at most ${field.maximum}`;
			return null;
		}
		case "boolean":
			return typeof value === "boolean" ? null : "must be true or false";
		case "choice":
			return typeof value === "string" && field.options.some((option) => option.value === value)
				? null
				: "must be one of the listed options";
		case "multi": {
			if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return "must be a list of options";
			if (new Set(value).size !== value.length) return "lists an option twice";
			if (value.some((item) => !field.options.some((option) => option.value === item)))
				return "names an option the form does not offer";
			if (field.minItems !== undefined && value.length < field.minItems)
				return `needs at least ${field.minItems} selected`;
			if (field.maxItems !== undefined && value.length > field.maxItems)
				return `allows at most ${field.maxItems} selected`;
			return null;
		}
	}
}

/**
 * Check submitted content against the form before it is sent (client/elicitation,
 * Form Mode Security: clients SHOULD validate responses). Returns one line per
 * problem, empty when the content fits.
 */
export function formContentErrors(form: McpFormElicitation, content: unknown): string[] {
	if (!isRecord(content)) return ["the answer is not an object"];
	const errors: string[] = [];
	for (const key of Object.keys(content))
		if (!form.fields.some((field) => field.key === key)) errors.push(`'${key}' is not a field of this form`);
	for (const field of form.fields) {
		if (!Object.hasOwn(content, field.key)) {
			if (field.required) errors.push(`${field.label} is required`);
			continue;
		}
		const error = fieldValueError(field, content[field.key]);
		if (error !== null) errors.push(`${field.label} ${error}`);
	}
	return errors;
}

/**
 * Read one typed answer into the field's JSON value: a number for a number
 * field, true or false for a boolean. Null with the reason when it does not
 * read; the value is then checked with `fieldValueError`.
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
